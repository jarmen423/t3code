import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  currentDevinModelIdFromConfigOptions,
  DEVIN_BROWSER_AUTH_METHOD_ID,
  DEVIN_DEFAULT_MODEL_SLUG,
  devinModelConfigOption,
  devinModelOptions,
  devinPermissionMode,
  probeDevinAuthStatus,
  resolveDevinAcpBaseModelId,
  resolveDevinAuthMethodId,
} from "./DevinAcpSupport.ts";

const initializeWith = (
  authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod> | undefined,
): EffectAcpSchema.InitializeResponse => ({
  protocolVersion: 1,
  ...(authMethods !== undefined ? { authMethods } : {}),
});

const modelConfigOption = (
  options:
    | ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption>
    | ReadonlyArray<EffectAcpSchema.SessionConfigSelectGroup>,
  currentValue = "swe-1.5",
): EffectAcpSchema.SessionConfigOption => ({
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue,
  options,
});

const modelOption = (value: string): EffectAcpSchema.SessionConfigSelectOption => ({
  name: value,
  value,
});

describe("resolveDevinAuthMethodId", () => {
  it("never picks devin-browser — T3 cannot drive a browser on the server host", () => {
    const initialize = initializeWith([
      { id: DEVIN_BROWSER_AUTH_METHOD_ID, name: "Browser sign-in", description: null },
    ]);
    expect(resolveDevinAuthMethodId(initialize)).toBeUndefined();
  });

  it("returns undefined when no auth methods are advertised", () => {
    expect(resolveDevinAuthMethodId(initializeWith(undefined))).toBeUndefined();
    expect(resolveDevinAuthMethodId(initializeWith([]))).toBeUndefined();
  });
});

describe("buildDevinAcpSpawnInput", () => {
  it("runs `devin acp` from the configured binary", () => {
    expect(buildDevinAcpSpawnInput({ binaryPath: "/opt/devin" }, "/tmp/project")).toEqual({
      command: "/opt/devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {},
    });
  });

  it("falls back to PATH and forwards the environment", () => {
    const spawn = buildDevinAcpSpawnInput(undefined, "/tmp/project", { PATH: "/bin" });
    expect(spawn.command).toBe("devin");
    expect(spawn.args).toEqual(["acp"]);
    expect(spawn.env).toEqual({ PATH: "/bin" });
  });
});

describe("devinPermissionMode", () => {
  it("maps T3 runtime modes onto Devin session modes", () => {
    expect(devinPermissionMode("full-access")).toBe("bypass");
    expect(devinPermissionMode("auto")).toBe("smart");
    expect(devinPermissionMode("auto-accept-edits")).toBe("accept-edits");
    expect(devinPermissionMode("approval-required")).toBe("accept-edits");
  });
});

describe("devinModelConfigOption", () => {
  it("picks the config option categorized as the model selector", () => {
    const modeOption: EffectAcpSchema.SessionConfigOption = {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "accept-edits",
      options: [modelOption("accept-edits")],
    };
    const model = modelConfigOption([modelOption("swe-1.5")]);
    expect(devinModelConfigOption([modeOption, model])).toBe(model);
    expect(devinModelConfigOption([modeOption])).toBeUndefined();
    expect(devinModelConfigOption(undefined)).toBeUndefined();
  });
});

describe("devinModelOptions", () => {
  it("flattens ungrouped select options", () => {
    const config = modelConfigOption([modelOption("swe-1.5"), modelOption("gpt-5.4-high")]);
    expect(devinModelOptions(config).map((option) => option.value)).toEqual([
      "swe-1.5",
      "gpt-5.4-high",
    ]);
  });

  it("flattens grouped select options in order", () => {
    const config = modelConfigOption([
      {
        group: "devin",
        name: "Devin",
        options: [modelOption("swe-1.5"), modelOption("fusion-sonnet")],
      },
      {
        group: "other",
        name: "Other",
        options: [modelOption("claude-opus-5-high")],
      },
    ]);
    expect(devinModelOptions(config).map((option) => option.value)).toEqual([
      "swe-1.5",
      "fusion-sonnet",
      "claude-opus-5-high",
    ]);
  });

  it("is empty for non-select options and missing configs", () => {
    const booleanOption: EffectAcpSchema.SessionConfigOption = {
      type: "boolean",
      id: "fast",
      name: "Fast",
      currentValue: true,
    };
    expect(devinModelOptions(booleanOption)).toEqual([]);
    expect(devinModelOptions(undefined)).toEqual([]);
  });
});

describe("currentDevinModelIdFromConfigOptions", () => {
  it("reads the select option's currentValue", () => {
    const config = modelConfigOption([modelOption("swe-1.5")], "claude-opus-5-high");
    expect(currentDevinModelIdFromConfigOptions([config])).toBe("claude-opus-5-high");
    expect(currentDevinModelIdFromConfigOptions(undefined)).toBeUndefined();
    expect(currentDevinModelIdFromConfigOptions([])).toBeUndefined();
  });
});

describe("resolveDevinAcpBaseModelId", () => {
  it("keeps native ids and defaults to the product slug", () => {
    expect(resolveDevinAcpBaseModelId(undefined)).toBe(DEVIN_DEFAULT_MODEL_SLUG);
    expect(resolveDevinAcpBaseModelId("   ")).toBe(DEVIN_DEFAULT_MODEL_SLUG);
    expect(resolveDevinAcpBaseModelId(" claude-opus-5-high ")).toBe("claude-opus-5-high");
  });
});

describe("applyDevinAcpModelSelection", () => {
  const config = modelConfigOption(
    [modelOption("swe-1.5"), modelOption("claude-opus-5-high")],
    "swe-1.5",
  );
  const makeRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const setModelCalls: Array<string> = [];
    const runtime = {
      getConfigOptions: Effect.succeed([config]),
      setModel: (model: string) =>
        Effect.gen(function* () {
          setModelCalls.push(model);
          if (failure) return yield* failure;
        }),
    };
    return { runtime, setModelCalls };
  };

  it.effect("sends the native model id through session/set_config_option", () =>
    Effect.gen(function* () {
      const { runtime, setModelCalls } = makeRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        model: "claude-opus-5-high",
        mapError: (cause) => cause.message,
      });
      expect(setModelCalls).toEqual(["claude-opus-5-high"]);
      expect(result).toBe("claude-opus-5-high");
    }),
  );

  it.effect("never sends the product slug over the wire", () =>
    Effect.gen(function* () {
      const { runtime, setModelCalls } = makeRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        model: DEVIN_DEFAULT_MODEL_SLUG,
        mapError: (cause) => cause.message,
      });
      expect(setModelCalls).toEqual([]);
      expect(result).toBe("swe-1.5");
    }),
  );

  it.effect("skips the request when the requested id is already active", () =>
    Effect.gen(function* () {
      const { runtime, setModelCalls } = makeRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        model: "swe-1.5",
        mapError: (cause) => cause.message,
      });
      expect(setModelCalls).toEqual([]);
      expect(result).toBe("swe-1.5");
    }),
  );

  it.effect("rejects ids Devin did not advertise", () =>
    Effect.gen(function* () {
      const { runtime, setModelCalls } = makeRuntime();
      const error = yield* Effect.flip(
        applyDevinAcpModelSelection({
          runtime,
          model: "not-a-real-model",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toContain("not-a-real-model");
      expect(setModelCalls).toEqual([]);
    }),
  );

  it.effect("propagates setModel failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown model");
      const { runtime } = makeRuntime(failure);
      const error = yield* Effect.flip(
        applyDevinAcpModelSelection({
          runtime,
          model: "claude-opus-5-high",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

it.layer(NodeServices.layer)("probeDevinAuthStatus", (it) => {
  const writeAuthStatusCli = (source: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-auth-" });
      return writeFakeCli({ directory: dir, name: "devin", source });
    });

  it.effect("reports authenticated when `devin auth status` says logged in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const devinPath = yield* writeAuthStatusCli(
          [
            'if (process.argv[2] === "auth" && process.argv[3] === "status") {',
            '  process.stdout.write("Logged in as user@example.com\\n");',
            "  process.exit(0);",
            "}",
            "process.exit(1);",
            "",
          ].join("\n"),
        );
        const status = yield* probeDevinAuthStatus({ binaryPath: devinPath });
        expect(status).toBe("authenticated");
      }),
    ),
  );

  it.effect("reports unauthenticated when `devin auth status` says not logged in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const devinPath = yield* writeAuthStatusCli(
          [
            'if (process.argv[2] === "auth" && process.argv[3] === "status") {',
            '  process.stdout.write("Not logged in.\\n");',
            "  process.exit(0);",
            "}",
            "process.exit(1);",
            "",
          ].join("\n"),
        );
        const status = yield* probeDevinAuthStatus({ binaryPath: devinPath });
        expect(status).toBe("unauthenticated");
      }),
    ),
  );

  it.effect("reports unknown when the probe fails or output is unrecognizable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const devinPath = yield* writeAuthStatusCli(["process.exit(2);", ""].join("\n"));
        expect(yield* probeDevinAuthStatus({ binaryPath: devinPath })).toBe("unknown");
        expect(yield* probeDevinAuthStatus({ binaryPath: "/definitely/missing/devin" })).toBe(
          "unknown",
        );
      }),
    ),
  );
});
