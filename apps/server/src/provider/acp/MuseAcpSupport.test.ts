import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  applyMuseAcpMode,
  applyMuseAcpModelSelection,
  buildMuseAcpSpawnInput,
  currentMuseModelIdFromSessionSetup,
  currentMuseReasoningEffortFromSessionSetup,
  isMuseAuthRequiredError,
  isMuseRateLimitedError,
  isMuseUsageExhaustedError,
  MUSE_DEFAULT_MODEL_SLUG,
  MUSE_ELICITATION_CANCEL_RESPONSE,
  MUSE_REASONING_EFFORT_CONFIG_ID,
  MuseElicitationCreateParams,
  museElicitationContent,
  museElicitationQuestions,
  museFailedStopError,
  musePermissionMode,
  museSubscriptionUsageUpdate,
  normalizeMuseReasoningEffort,
  resolveMuseAcpBaseModelId,
  resolveMuseAuthMethodId,
  resolveMuseSessionModeId,
} from "./MuseAcpSupport.ts";

const decodeElicitationParams = Schema.decodeSync(MuseElicitationCreateParams);
const decodeUnknownElicitationParams = Schema.decodeUnknownSync(MuseElicitationCreateParams);

describe("resolveMuseAuthMethodId", () => {
  it("always declines: the bridge advertises no ACP auth methods", () => {
    const initialize = { protocolVersion: 1, authMethods: [] };
    expect(resolveMuseAuthMethodId(initialize)).toBeUndefined();
    expect(
      resolveMuseAuthMethodId({
        protocolVersion: 1,
        authMethods: [{ id: "muse-login", name: "Muse", description: null }],
      }),
    ).toBeUndefined();
  });
});

describe("buildMuseAcpSpawnInput", () => {
  it("runs the configured bridge binary with no arguments", () => {
    expect(buildMuseAcpSpawnInput({ binaryPath: "/opt/muse-acp-bridge" }, "/tmp/project")).toEqual({
      command: "/opt/muse-acp-bridge",
      args: [],
      cwd: "/tmp/project",
      env: {},
    });
  });

  it("falls back to PATH and forwards the environment", () => {
    const spawn = buildMuseAcpSpawnInput(undefined, "/tmp/project", { PATH: "/bin" });
    expect(spawn.command).toBe("muse-acp-bridge");
    expect(spawn.env).toEqual({ PATH: "/bin" });
  });
});

describe("musePermissionMode", () => {
  it("gates every mode except Full access behind native ask", () => {
    expect(musePermissionMode("approval-required")).toBe("ask");
    expect(musePermissionMode("auto-accept-edits")).toBe("ask");
    expect(musePermissionMode("auto")).toBe("ask");
  });

  it("maps Full access to native auto, which still allows questions", () => {
    expect(musePermissionMode("full-access")).toBe("auto");
  });
});

describe("resolveMuseSessionModeId", () => {
  const advertised = (ids: ReadonlyArray<string>) => ({
    currentModeId: ids[0] ?? "ask",
    availableModes: ids.map((id) => ({ id, name: id })),
  });

  it("maps plan interaction mode to ask", () => {
    expect(
      resolveMuseSessionModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: advertised(["ask", "auto", "yolo", "deny"]),
      }),
    ).toBe("ask");
  });

  it("returns the preferred mode when advertised", () => {
    expect(
      resolveMuseSessionModeId({
        interactionMode: undefined,
        runtimeMode: "full-access",
        modeState: advertised(["ask", "auto", "yolo"]),
      }),
    ).toBe("auto");
    expect(
      resolveMuseSessionModeId({
        interactionMode: "default",
        runtimeMode: "approval-required",
        modeState: advertised(["ask", "auto"]),
      }),
    ).toBe("ask");
  });

  it("falls back to the strongest advertised mode that is not more permissive", () => {
    // A bridge without yolo must not get full-access silently upgraded to it;
    // auto is the strongest mode that still keeps questions available.
    expect(
      resolveMuseSessionModeId({
        interactionMode: undefined,
        runtimeMode: "full-access",
        modeState: advertised(["deny", "ask", "auto"]),
      }),
    ).toBe("auto");
    expect(
      resolveMuseSessionModeId({
        interactionMode: undefined,
        runtimeMode: "auto",
        modeState: advertised(["deny", "ask"]),
      }),
    ).toBe("ask");
  });

  it("fails closed instead of upgrading when only more permissive modes are advertised", () => {
    const tooPermissive = (
      runtimeMode: Parameters<typeof resolveMuseSessionModeId>[0]["runtimeMode"],
    ) =>
      resolveMuseSessionModeId({
        interactionMode: undefined,
        runtimeMode,
        modeState: advertised(["auto", "yolo"]),
      });
    expect(tooPermissive("approval-required")).toBeUndefined();
    expect(tooPermissive("auto-accept-edits")).toBeUndefined();
    expect(tooPermissive("auto")).toBeUndefined();
    expect(
      resolveMuseSessionModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: advertised(["auto", "yolo"]),
      }),
    ).toBeUndefined();
  });

  it("fails closed when the bridge advertises only unknown mode ids", () => {
    const unknownOnly = (
      runtimeMode: Parameters<typeof resolveMuseSessionModeId>[0]["runtimeMode"],
    ) =>
      resolveMuseSessionModeId({
        interactionMode: undefined,
        runtimeMode,
        modeState: advertised(["turbo"]),
      });
    expect(unknownOnly("approval-required")).toBeUndefined();
    expect(unknownOnly("auto-accept-edits")).toBeUndefined();
    expect(unknownOnly("auto")).toBeUndefined();
    expect(unknownOnly("full-access")).toBeUndefined();
    // Plan resolves to ask, but ask was never advertised either: an unreadable
    // mode list must not resurrect the preferred mode out of thin air.
    expect(
      resolveMuseSessionModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: advertised(["turbo"]),
      }),
    ).toBeUndefined();
  });

  it("never invents modes when none are advertised", () => {
    expect(
      resolveMuseSessionModeId({
        interactionMode: undefined,
        runtimeMode: "approval-required",
        modeState: advertised([]),
      }),
    ).toBe("ask");
    expect(
      resolveMuseSessionModeId({
        interactionMode: undefined,
        runtimeMode: "approval-required",
        modeState: undefined,
      }),
    ).toBe("ask");
  });
});

describe("applyMuseAcpMode", () => {
  const makeRuntime = (
    modeState:
      | { currentModeId: string; availableModes: ReadonlyArray<{ id: string; name: string }> }
      | undefined,
  ) => {
    const calls: Array<string> = [];
    const runtime = {
      getModeState: Effect.sync(() => modeState),
      setMode: (modeId: string) =>
        Effect.sync(() => {
          calls.push(modeId);
          return {};
        }),
    };
    return { runtime, calls };
  };

  const modes = ["deny", "ask", "auto", "yolo"].map((id) => ({ id, name: id }));

  it.effect("sends the native mode id when it differs", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime({
        currentModeId: "ask",
        availableModes: modes,
      });
      yield* applyMuseAcpMode({
        runtime,
        modeId: "yolo",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual(["yolo"]);
    }),
  );

  it.effect("skips the request when the session is already in that mode", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime({
        currentModeId: "auto",
        availableModes: modes,
      });
      yield* applyMuseAcpMode({
        runtime,
        modeId: "auto",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("skips modes the bridge did not advertise", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime({
        currentModeId: "ask",
        availableModes: modes,
      });
      yield* applyMuseAcpMode({
        runtime,
        modeId: "plan",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("propagates failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("bad mode");
      const noModeState = undefined;
      const runtime = {
        getModeState: Effect.succeed(noModeState),
        setMode: () => failure,
      };
      const error = yield* Effect.flip(
        applyMuseAcpMode({
          runtime,
          modeId: "ask",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("resolveMuseAcpBaseModelId", () => {
  it("keeps native ids and defaults to the product slug", () => {
    expect(resolveMuseAcpBaseModelId(undefined)).toBe(MUSE_DEFAULT_MODEL_SLUG);
    expect(resolveMuseAcpBaseModelId("   ")).toBe(MUSE_DEFAULT_MODEL_SLUG);
    expect(resolveMuseAcpBaseModelId(" muse-spark-1.3 ")).toBe("muse-spark-1.3");
  });
});

const setupWithConfigOptions = (
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.NewSessionResponse => ({
  sessionId: "s1",
  configOptions: [...configOptions],
});

const selectOption = (
  id: string,
  category: string,
  currentValue: string,
  values: ReadonlyArray<string>,
): EffectAcpSchema.SessionConfigOption => ({
  id,
  name: id,
  category,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

describe("currentMuseModelIdFromSessionSetup", () => {
  it("reads the model config option's current value", () => {
    expect(
      currentMuseModelIdFromSessionSetup(
        setupWithConfigOptions([
          selectOption("model", "model", "muse-spark-1.3", ["muse-spark-1.3"]),
        ]),
      ),
    ).toBe("muse-spark-1.3");
    expect(currentMuseModelIdFromSessionSetup({ sessionId: "s1" })).toBeUndefined();
  });
});

describe("currentMuseReasoningEffortFromSessionSetup", () => {
  it("reads and normalizes the reasoning_effort config option", () => {
    expect(
      currentMuseReasoningEffortFromSessionSetup(
        setupWithConfigOptions([
          selectOption(MUSE_REASONING_EFFORT_CONFIG_ID, "thought_level", " HIGH ", ["high"]),
        ]),
      ),
    ).toBe("high");
    expect(currentMuseReasoningEffortFromSessionSetup(setupWithConfigOptions([]))).toBeUndefined();
  });
});

describe("normalizeMuseReasoningEffort", () => {
  it("lowercases and validates effort tokens", () => {
    expect(normalizeMuseReasoningEffort(" HIGH ")).toBe("high");
    expect(normalizeMuseReasoningEffort("xhigh")).toBe("xhigh");
    expect(normalizeMuseReasoningEffort("bogus value!")).toBeUndefined();
    expect(normalizeMuseReasoningEffort(undefined)).toBeUndefined();
  });
});

describe("applyMuseAcpModelSelection", () => {
  const makeRuntime = () => {
    const calls: Array<{ method: string; value: string }> = [];
    const runtime = {
      setModel: (model: string) =>
        Effect.sync(() => {
          calls.push({ method: "setModel", value: model });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ method: configId, value: String(value) });
          return { configOptions: [] } satisfies EffectAcpSchema.SetSessionConfigOptionResponse;
        }),
    };
    return { runtime, calls };
  };

  it.effect("applies model and reasoning effort through config options", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const result = yield* applyMuseAcpModelSelection({
        runtime,
        currentModelId: "muse-spark-1.2",
        currentReasoningEffort: "medium",
        requestedModelId: "muse-spark-1.3",
        requestedReasoningEffort: "high",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([
        { method: "setModel", value: "muse-spark-1.3" },
        { method: MUSE_REASONING_EFFORT_CONFIG_ID, value: "high" },
      ]);
      expect(result).toBe("muse-spark-1.3");
    }),
  );

  it.effect("never sends the product slug over the wire", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const result = yield* applyMuseAcpModelSelection({
        runtime,
        currentModelId: "muse-spark-1.3",
        requestedModelId: MUSE_DEFAULT_MODEL_SLUG,
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([]);
      expect(result).toBe("muse-spark-1.3");
    }),
  );

  it.effect("drops invalid reasoning effort instead of forwarding it", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const result = yield* applyMuseAcpModelSelection({
        runtime,
        currentModelId: "muse-spark-1.3",
        currentReasoningEffort: "medium",
        requestedModelId: "muse-spark-1.3",
        requestedReasoningEffort: "bogus value!",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([]);
      expect(result).toBe("muse-spark-1.3");
    }),
  );

  it.effect("propagates failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown model");
      const runtime = {
        setModel: (): Effect.Effect<void, EffectAcpErrors.AcpError> => failure,
        setConfigOption: (): Effect.Effect<
          EffectAcpSchema.SetSessionConfigOptionResponse,
          EffectAcpErrors.AcpError
        > => failure,
      };
      const error = yield* Effect.flip(
        applyMuseAcpModelSelection({
          runtime,
          currentModelId: "muse-spark-1.2",
          requestedModelId: "muse-spark-1.3",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("isMuseAuthRequiredError", () => {
  it("matches the bridge's login-required message", () => {
    expect(
      isMuseAuthRequiredError(
        EffectAcpErrors.AcpRequestError.internalError(
          "muse login required (serve reported authRequired)",
        ),
      ),
    ).toBe(true);
  });

  it("matches the spec auth-required code", () => {
    expect(isMuseAuthRequiredError(EffectAcpErrors.AcpRequestError.authRequired("sign in"))).toBe(
      true,
    );
  });

  it("does not match unrelated errors", () => {
    expect(
      isMuseAuthRequiredError(EffectAcpErrors.AcpRequestError.invalidParams("bad input")),
    ).toBe(false);
    expect(isMuseAuthRequiredError(new Error("authRequired"))).toBe(false);
  });
});

describe("MuseElicitationCreateParams", () => {
  it("decodes the bridge's form payload and ignores unknown fields", () => {
    const decoded = decodeUnknownElicitationParams({
      sessionId: "s1",
      mode: "form",
      message: "Pick: Which one?",
      toolCallId: "tc-1",
      requestedSchema: {
        type: "object",
        properties: { q0: { type: "string", enum: ["A", "B"] } },
        required: ["q0"],
      },
      extra: { nested: true },
    });
    expect(decoded.sessionId).toBe("s1");
    expect(decoded.requestedSchema?.properties?.q0).toEqual({
      type: "string",
      enum: ["A", "B"],
    });
  });

  it("decodes minimal payloads", () => {
    expect(decodeElicitationParams({})).toEqual({});
  });
});

describe("museElicitationQuestions", () => {
  it("turns q{i} schema properties into questions with enum options", () => {
    const questions = museElicitationQuestions({
      message: "Scope: Which scope?\nNotes: Anything else?",
      requestedSchema: {
        properties: {
          q0: { type: "string", enum: ["Workspace", "Session"] },
          q1: { type: "string" },
        },
      },
    });
    expect(questions).toEqual([
      {
        id: "q0",
        header: "Scope",
        question: "Which scope?",
        options: [
          { label: "Workspace", description: "Workspace" },
          { label: "Session", description: "Session" },
        ],
        allowCustomAnswer: true,
      },
      {
        id: "q1",
        header: "Notes",
        question: "Anything else?",
        options: [],
        allowCustomAnswer: true,
      },
    ]);
  });

  it("orders q{i} numerically so q10 aligns with its message line", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 11; i += 1) {
      properties[`q${i}`] = { type: "string" };
    }
    // serde's BTreeMap serializes keys sorted: q0, q1, q10, q2, ...
    const scrambled: Record<string, unknown> = {};
    for (const key of Object.keys(properties).sort()) {
      scrambled[key] = properties[key];
    }
    const lines = Array.from({ length: 11 }, (_, i) => `H${i}: question ${i}`);
    const questions = museElicitationQuestions({
      message: lines.join("\n"),
      requestedSchema: { properties: scrambled },
    });
    expect(questions.map((question) => question.id)).toEqual(
      Array.from({ length: 11 }, (_, i) => `q${i}`),
    );
    expect(questions[10]?.question).toBe("question 10");
  });

  it("marks array schemas as multiSelect with item enum options", () => {
    const questions = museElicitationQuestions({
      message: "Pick: Choose any",
      requestedSchema: {
        properties: {
          choice: {
            type: "array",
            items: { type: "string", enum: ["One", "Two"] },
            minItems: 1,
          },
        },
      },
    });
    expect(questions).toEqual([
      {
        id: "choice",
        header: "Pick",
        question: "Choose any",
        options: [
          { label: "One", description: "One" },
          { label: "Two", description: "Two" },
        ],
        allowCustomAnswer: true,
        multiSelect: true,
      },
    ]);
  });

  it("returns no questions when the schema has no properties", () => {
    expect(museElicitationQuestions({ message: "hi" })).toEqual([]);
    expect(museElicitationQuestions({ requestedSchema: { properties: {} } })).toEqual([]);
  });
});

describe("museElicitationContent", () => {
  const questions = [
    { id: "q0", header: "H", question: "Q", options: [], allowCustomAnswer: true },
    {
      id: "q1",
      header: "H",
      question: "Q",
      options: [],
      allowCustomAnswer: true,
      multiSelect: true,
    },
  ];

  it("maps string and string-array answers keyed by property name", () => {
    expect(museElicitationContent(questions, { q0: "Workspace", q1: ["One", "Two"] })).toEqual({
      q0: "Workspace",
      q1: ["One", "Two"],
    });
  });

  it("returns undefined when no usable answers exist", () => {
    expect(museElicitationContent(questions, {})).toBeUndefined();
    expect(museElicitationContent(questions, { q0: "", q1: [] })).toBeUndefined();
    expect(museElicitationContent(questions, { q0: 42, unrelated: "x" })).toBeUndefined();
  });
});

describe("MUSE_ELICITATION_CANCEL_RESPONSE", () => {
  it("is the fail-closed action the bridge expects", () => {
    expect(MUSE_ELICITATION_CANCEL_RESPONSE).toEqual({ action: "cancel" });
  });
});

const subscriptionPayload = (subscription: unknown) => ({
  sessionId: "acp-1",
  update: {
    sessionUpdate: "session_info_update",
    _meta: { muse: { subscription } },
  },
});

const isoFixture = (epochMs: number): string => {
  const made = DateTime.make(epochMs);
  if (!Option.isSome(made)) {
    throw new Error(`bad fixture time: ${epochMs}`);
  }
  return DateTime.formatIso(made.value);
};

describe("museSubscriptionUsageUpdate", () => {
  it("decodes the live bridge observation into session and weekly windows", () => {
    const update = museSubscriptionUsageUpdate(
      subscriptionPayload({
        observedAtMs: 1791346730869,
        tier: "27681631238169137",
        weekly: { resetsAtMs: 1791763200000, usedPercent: 9 },
        window: { resetsAtMs: 1791364120000, usedPercent: 2, windowDurationMins: 300 },
      }),
    );
    expect(update).toEqual({
      windows: [
        {
          id: "window",
          kind: "session",
          label: "Session",
          usedPercent: 2,
          resetsAt: isoFixture(1791364120000),
          windowDurationMins: 300,
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 9,
          resetsAt: isoFixture(1791763200000),
        },
      ],
    });
  });

  it("clamps over-quota percents and drops invalid resets", () => {
    const update = museSubscriptionUsageUpdate(
      subscriptionPayload({
        observedAtMs: 1,
        tier: "t",
        weekly: { resetsAtMs: Number.NaN, usedPercent: 140 },
        window: { resetsAtMs: -5, usedPercent: 200, windowDurationMins: 1.5 },
      }),
    );
    expect(update?.windows).toEqual([
      {
        id: "window",
        kind: "session",
        label: "Session",
        usedPercent: 100,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
      },
    ]);
  });

  it("keeps the valid window when its sibling is malformed", () => {
    const update = museSubscriptionUsageUpdate(
      subscriptionPayload({
        observedAtMs: 1,
        tier: "t",
        weekly: { resetsAtMs: 1791763200000, usedPercent: 9 },
        window: { resetsAtMs: 1791364120000, usedPercent: "2" },
      }),
    );
    expect(update?.windows.map((window) => window.id)).toEqual(["weekly"]);
  });

  it("returns undefined without a subscription observation", () => {
    expect(museSubscriptionUsageUpdate(undefined)).toBeUndefined();
    expect(museSubscriptionUsageUpdate({ sessionId: "s", update: {} })).toBeUndefined();
    expect(
      museSubscriptionUsageUpdate(subscriptionPayload({ observedAtMs: 1, tier: "t" })),
    ).toBeUndefined();
    // Token-occupancy updates carry museCumulative, never a subscription.
    expect(
      museSubscriptionUsageUpdate({
        sessionId: "s",
        update: {
          sessionUpdate: "usage_update",
          used: 1,
          size: 2,
          _meta: { museCumulative: { totalTokens: 3 } },
        },
      }),
    ).toBeUndefined();
  });
});

describe("isMuseUsageExhaustedError", () => {
  it.each([
    "turn failed (modelError): model error: model failed after 3 attempts: provider returned 429 rate_limited",
    "turn failed (modelError): quota exceeded for the current window",
    "turn failed (modelError): insufficient_quota",
    "turn failed (modelError): usage limit reached, resets in 4h",
  ])("matches quota exhaustion: %s", (message) => {
    expect(isMuseUsageExhaustedError(EffectAcpErrors.AcpRequestError.internalError(message))).toBe(
      true,
    );
  });

  it("never matches the bridge's own restart exhaustion", () => {
    expect(
      isMuseUsageExhaustedError(
        EffectAcpErrors.AcpRequestError.internalError(
          "msp host unavailable (restarts exhausted); restart the bridge",
        ),
      ),
    ).toBe(false);
  });

  it("does not match unrelated errors", () => {
    expect(
      isMuseUsageExhaustedError(
        EffectAcpErrors.AcpRequestError.internalError(
          "muse login required (serve reported authRequired)",
        ),
      ),
    ).toBe(false);
    expect(isMuseUsageExhaustedError(new Error("boom"))).toBe(false);
    expect(isMuseUsageExhaustedError(undefined)).toBe(false);
  });
});

describe("isMuseRateLimitedError", () => {
  it("matches transient rate pressure", () => {
    expect(
      isMuseRateLimitedError(
        EffectAcpErrors.AcpRequestError.internalError(
          "host rate limited the request; retry the prompt: slow down",
        ),
      ),
    ).toBe(true);
  });

  it("defers to the exhaustion matcher", () => {
    expect(
      isMuseRateLimitedError(
        EffectAcpErrors.AcpRequestError.internalError("provider returned 429 rate_limited"),
      ),
    ).toBe(false);
  });
});

describe("museFailedStopError", () => {
  it("converts _failed with the bridge's turn detail", () => {
    const error = museFailedStopError({
      stopReason: "_failed",
      _meta: {
        muse: { turnFailed: { kind: "modelError", message: "model error: provider returned 429" } },
      },
    });
    expect(error).toBeDefined();
    expect(error?.code).toBe(-32603);
    expect(error?.message).toBe("turn failed (modelError): model error: provider returned 429");
    expect(isMuseUsageExhaustedError(error)).toBe(true);
  });

  it("falls back to the stop reason without detail", () => {
    expect(museFailedStopError({ stopReason: "_failed" })?.message).toBe("turn failed (_failed)");
    expect(museFailedStopError({ stopReason: "_failed", _meta: {} })?.message).toBe(
      "turn failed (_failed)",
    );
  });

  it("leaves success and cancellation results alone", () => {
    expect(museFailedStopError({ stopReason: "end_turn" })).toBeUndefined();
    expect(museFailedStopError({ stopReason: "cancelled" })).toBeUndefined();
    expect(museFailedStopError({ stopReason: "max_tokens" })).toBeUndefined();
    expect(museFailedStopError(undefined)).toBeUndefined();
    expect(museFailedStopError(null)).toBeUndefined();
  });
});
