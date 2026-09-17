import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyHermesAcpMode,
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  currentHermesModelIdFromSessionSetup,
  currentHermesReasoningEffortFromSessionSetup,
  HERMES_DEFAULT_MODEL_SLUG,
  HERMES_SETUP_AUTH_METHOD_ID,
  hermesPermissionMode,
  hermesSetupRequired,
  resolveHermesAcpBaseModelId,
  resolveHermesAuthMethodId,
} from "./HermesAcpSupport.ts";

const initializeWith = (
  authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod> | undefined,
): EffectAcpSchema.InitializeResponse => ({
  protocolVersion: 1,
  ...(authMethods !== undefined ? { authMethods } : {}),
});

const providerAuthMethod = (id: string): EffectAcpSchema.AuthMethod => ({
  id,
  name: id,
  description: null,
});

const terminalAuthMethod = (id: string): EffectAcpSchema.AuthMethod => ({
  type: "terminal",
  id,
  name: id,
  description: null,
});

describe("resolveHermesAuthMethodId", () => {
  it("picks the first agent-managed method Hermes advertises", () => {
    const initialize = initializeWith([
      providerAuthMethod("openrouter"),
      terminalAuthMethod(HERMES_SETUP_AUTH_METHOD_ID),
    ]);
    expect(resolveHermesAuthMethodId(initialize)).toBe("openrouter");
  });

  it("skips hermes-setup when it is listed before a provider method", () => {
    const initialize = initializeWith([
      terminalAuthMethod(HERMES_SETUP_AUTH_METHOD_ID),
      providerAuthMethod("xai-oauth"),
    ]);
    expect(resolveHermesAuthMethodId(initialize)).toBe("xai-oauth");
  });

  it("returns undefined when only terminal setup is advertised", () => {
    const initialize = initializeWith([terminalAuthMethod(HERMES_SETUP_AUTH_METHOD_ID)]);
    expect(resolveHermesAuthMethodId(initialize)).toBeUndefined();
    expect(hermesSetupRequired(initialize)).toBe(true);
  });

  it("returns undefined when no auth methods are advertised", () => {
    expect(resolveHermesAuthMethodId(initializeWith(undefined))).toBeUndefined();
    expect(hermesSetupRequired(initializeWith([]))).toBe(true);
  });
});

describe("buildHermesAcpSpawnInput", () => {
  it("runs `hermes acp` from the configured binary", () => {
    expect(buildHermesAcpSpawnInput({ binaryPath: "/opt/hermes" }, "/tmp/project")).toEqual({
      command: "/opt/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {},
    });
  });

  it("falls back to PATH and forwards the environment", () => {
    const spawn = buildHermesAcpSpawnInput(undefined, "/tmp/project", { PATH: "/bin" });
    expect(spawn.command).toBe("hermes");
    expect(spawn.env).toEqual({ PATH: "/bin" });
  });
});

describe("hermesPermissionMode", () => {
  it("maps T3 runtime modes onto Hermes session modes", () => {
    expect(hermesPermissionMode("full-access")).toBe("dont_ask");
    expect(hermesPermissionMode("auto-accept-edits")).toBe("accept_edits");
    expect(hermesPermissionMode("auto")).toBe("default");
    expect(hermesPermissionMode("approval-required")).toBe("default");
  });
});

describe("applyHermesAcpMode", () => {
  const makeRuntime = (
    modeState:
      | { currentModeId: string; availableModes: ReadonlyArray<{ id: string; name: string }> }
      | undefined,
  ) => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const runtime = {
      getModeState: Effect.sync(() => modeState),
      request: (method: string, params: unknown) =>
        Effect.sync(() => {
          requests.push({ method, params });
          return {};
        }),
    };
    return { runtime, requests };
  };

  const modes = ["default", "accept_edits", "dont_ask"].map((id) => ({ id, name: id }));

  it.effect("sends raw session/set_mode when the target mode differs", () =>
    Effect.gen(function* () {
      const { runtime, requests } = makeRuntime({
        currentModeId: "default",
        availableModes: modes,
      });
      yield* applyHermesAcpMode({
        runtime,
        sessionId: "s1",
        modeId: "dont_ask",
        mapError: (cause) => cause.message,
      });
      expect(requests).toEqual([
        { method: "session/set_mode", params: { sessionId: "s1", modeId: "dont_ask" } },
      ]);
    }),
  );

  it.effect("skips the request when the session is already in that mode", () =>
    Effect.gen(function* () {
      const { runtime, requests } = makeRuntime({
        currentModeId: "dont_ask",
        availableModes: modes,
      });
      yield* applyHermesAcpMode({
        runtime,
        sessionId: "s1",
        modeId: "dont_ask",
        mapError: (cause) => cause.message,
      });
      expect(requests).toEqual([]);
    }),
  );

  it.effect("skips modes Hermes did not advertise", () =>
    Effect.gen(function* () {
      const { runtime, requests } = makeRuntime({
        currentModeId: "default",
        availableModes: modes,
      });
      yield* applyHermesAcpMode({
        runtime,
        sessionId: "s1",
        modeId: "plan",
        mapError: (cause) => cause.message,
      });
      expect(requests).toEqual([]);
    }),
  );

  it.effect("propagates request failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("bad mode");
      const requests: Array<unknown> = [];
      const runtime = {
        getModeState: Effect.succeed(undefined),
        request: () => failure,
      };
      const error = yield* Effect.flip(
        applyHermesAcpMode({
          runtime,
          sessionId: "s1",
          modeId: "dont_ask",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
      expect(requests).toEqual([]);
    }),
  );
});

describe("resolveHermesAcpBaseModelId", () => {
  it("keeps provider-qualified native ids and defaults to the product slug", () => {
    expect(resolveHermesAcpBaseModelId(undefined)).toBe(HERMES_DEFAULT_MODEL_SLUG);
    expect(resolveHermesAcpBaseModelId("   ")).toBe(HERMES_DEFAULT_MODEL_SLUG);
    expect(resolveHermesAcpBaseModelId(" openrouter:anthropic/claude ")).toBe(
      "openrouter:anthropic/claude",
    );
  });
});

describe("currentHermesModelIdFromSessionSetup", () => {
  it("reads the session's current native model id", () => {
    expect(
      currentHermesModelIdFromSessionSetup({
        sessionId: "s1",
        models: {
          currentModelId: "openrouter:qwen",
          availableModels: [],
        },
      }),
    ).toBe("openrouter:qwen");
    expect(currentHermesModelIdFromSessionSetup({ sessionId: "s1" })).toBeUndefined();
  });
});

describe("currentHermesReasoningEffortFromSessionSetup", () => {
  const setupWithModels = (
    models: ReadonlyArray<EffectAcpSchema.ModelInfo>,
    currentModelId = "openrouter:a",
  ): EffectAcpSchema.NewSessionResponse => ({
    sessionId: "s1",
    models: { currentModelId, availableModels: models },
  });

  const modelWithMeta = (
    modelId: string,
    meta: Record<string, unknown> | undefined,
  ): EffectAcpSchema.ModelInfo => ({
    modelId,
    name: modelId,
    ...(meta !== undefined ? { _meta: meta } : {}),
  });

  it("reads the effort advertised on the current model", () => {
    expect(
      currentHermesReasoningEffortFromSessionSetup(
        setupWithModels([
          modelWithMeta("openrouter:a", { reasoningEffort: "high" }),
          modelWithMeta("openrouter:b", { reasoningEffort: "low" }),
        ]),
      ),
    ).toBe("high");
  });

  it("is undefined when the current model advertises no effort", () => {
    expect(
      currentHermesReasoningEffortFromSessionSetup(
        setupWithModels([modelWithMeta("openrouter:a", undefined)]),
      ),
    ).toBeUndefined();
    expect(currentHermesReasoningEffortFromSessionSetup({ sessionId: "s1" })).toBeUndefined();
  });

  it("normalizes and rejects malformed effort values", () => {
    expect(
      currentHermesReasoningEffortFromSessionSetup(
        setupWithModels([modelWithMeta("openrouter:a", { reasoningEffort: " HIGH " })]),
      ),
    ).toBe("high");
    expect(
      currentHermesReasoningEffortFromSessionSetup(
        setupWithModels([modelWithMeta("openrouter:a", { reasoningEffort: "bogus!" })]),
      ),
    ).toBeUndefined();
  });
});

describe("applyHermesAcpModelSelection", () => {
  const makeRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{ modelId: string; meta: unknown }> = [];
    const runtime = {
      setSessionModel: (modelId: string, meta?: EffectAcpSchema.SetSessionModelRequest["_meta"]) =>
        Effect.gen(function* () {
          modelCalls.push({ modelId, meta });
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model with the native model id", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:a",
        requestedModelId: "xai-oauth:grok-4",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "xai-oauth:grok-4", meta: undefined }]);
      expect(result).toBe("xai-oauth:grok-4");
    }),
  );

  it.effect("never sends the product slug over the wire", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:a",
        requestedModelId: HERMES_DEFAULT_MODEL_SLUG,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openrouter:a");
    }),
  );

  it.effect("skips set_model when the requested id is already active", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:a",
        requestedModelId: "openrouter:a",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openrouter:a");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown model");
      const { runtime } = makeRuntime(failure);
      const error = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openrouter:a",
          requestedModelId: "openrouter:b",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );

  it.effect("sends reasoningEffort meta when only the effort changes", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:a",
        currentReasoningEffort: "low",
        requestedModelId: undefined,
        requestedReasoningEffort: "high",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "openrouter:a", meta: { reasoningEffort: "high" } }]);
      expect(result).toBe("openrouter:a");
    }),
  );

  it.effect("sends reasoningEffort meta together with a model switch", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:a",
        currentReasoningEffort: "low",
        requestedModelId: "xai-oauth:grok-4",
        requestedReasoningEffort: "ultra",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([
        { modelId: "xai-oauth:grok-4", meta: { reasoningEffort: "ultra" } },
      ]);
      expect(result).toBe("xai-oauth:grok-4");
    }),
  );

  it.effect("skips set_model when neither model nor effort changed", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:a",
        currentReasoningEffort: "high",
        requestedModelId: "openrouter:a",
        requestedReasoningEffort: "high",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openrouter:a");
    }),
  );

  it.effect("drops an invalid effort token instead of forwarding it", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:a",
        currentReasoningEffort: "low",
        requestedModelId: "xai-oauth:grok-4",
        requestedReasoningEffort: "not an effort!",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "xai-oauth:grok-4", meta: undefined }]);
      expect(result).toBe("xai-oauth:grok-4");
    }),
  );

  it.effect("does not clear the session effort when none is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:a",
        currentReasoningEffort: "high",
        requestedModelId: "xai-oauth:grok-4",
        requestedReasoningEffort: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "xai-oauth:grok-4", meta: undefined }]);
      expect(result).toBe("xai-oauth:grok-4");
    }),
  );
});
