import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyMuseAcpMode,
  applyMuseAcpModelSelection,
  buildMuseAcpSpawnInput,
  currentMuseModelIdFromSessionSetup,
  currentMuseReasoningEffortFromSessionSetup,
  isMuseAuthRequiredError,
  MUSE_DEFAULT_MODEL_SLUG,
  MUSE_ELICITATION_CANCEL_RESPONSE,
  MUSE_REASONING_EFFORT_CONFIG_ID,
  MuseElicitationCreateParams,
  museElicitationContent,
  museElicitationQuestions,
  musePermissionMode,
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
  it("maps T3 runtime modes onto Muse session modes", () => {
    expect(musePermissionMode("full-access")).toBe("yolo");
    expect(musePermissionMode("auto-accept-edits")).toBe("auto");
    expect(musePermissionMode("auto")).toBe("auto");
    expect(musePermissionMode("approval-required")).toBe("ask");
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
    ).toBe("yolo");
    expect(
      resolveMuseSessionModeId({
        interactionMode: "default",
        runtimeMode: "approval-required",
        modeState: advertised(["ask", "auto"]),
      }),
    ).toBe("ask");
  });

  it("falls back to the most capable mode that is not more permissive", () => {
    // A bridge without yolo should not get full-access silently downgraded to deny.
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
