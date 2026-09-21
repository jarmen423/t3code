import { type DevinSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { spawnAndCollect } from "../providerSnapshot.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Product slug for "keep the model Devin is configured with". It is not a
 * native model id and must never reach the `model` session config option.
 */
export const DEVIN_DEFAULT_MODEL_SLUG = "default";

/**
 * Devin's only advertised ACP auth method opens a browser on the server host.
 * T3 cannot drive that flow — sign-in belongs to `devin auth login` in a
 * terminal — so `authenticate` is never called.
 */
export const DEVIN_BROWSER_AUTH_METHOD_ID = "devin-browser";

/** Devin's plan-interaction mode id inside its `mode` config option. */
export const DEVIN_PLAN_MODE_ID = "plan";

const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");
const DEVIN_AUTH_STATUS_TIMEOUT = "15 seconds";

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp"],
    cwd,
    env: { ...environment },
  };
}

/**
 * Always `undefined`: `devin-browser` is Devin's only advertised method and it
 * launches a browser on the host T3 cannot interact with. Skipping
 * `authenticate` keeps headless servers safe; auth state is probed through
 * `devin auth status` instead.
 */
export function resolveDevinAuthMethodId(
  _initialize: EffectAcpSchema.InitializeResponse,
): string | undefined {
  return undefined;
}

export type DevinAuthStatus = "authenticated" | "unauthenticated" | "unknown";

/**
 * Runs `devin auth status` — cheap (~0.5s), exits 0 either way, and reports
 * login state on stdout. ACP cannot reveal it: `devin-browser` is advertised
 * even when signed in and `session/new` succeeds while logged out. Any spawn
 * or parse failure is "unknown", never a probe-breaking error.
 */
export const probeDevinAuthStatus = Effect.fn("probeDevinAuthStatus")(function* (
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<DevinAuthStatus, never, ChildProcessSpawner.ChildProcessSpawner> {
  const command = devinSettings?.binaryPath || "devin";
  const spawnCommand = yield* resolveSpawnCommand(command, ["auth", "status"], {
    env: environment,
  });
  const result = yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  ).pipe(
    Effect.timeoutOption(DEVIN_AUTH_STATUS_TIMEOUT),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(result)) {
    return "unknown";
  }
  const output = `${result.value.stdout}\n${result.value.stderr}`;
  // "Not logged in." must be checked before the affirmative patterns.
  if (/not logged in|unauthenticated|not authenticated|no credentials/i.test(output)) {
    return "unauthenticated";
  }
  if (/logged in|authenticated/i.test(output)) {
    return "authenticated";
  }
  return "unknown";
});

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        authMethodId: resolveDevinAuthMethodId,
        // Devin resolves a cancelled `session/prompt` promptly and runs the
        // next prompt normally — nothing queues behind the cancelled turn.
        cancelBehavior: "interrupt",
        // Devin edits files and runs commands through its own tools; it never
        // calls back into the client for fs or terminal access.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * T3's runtime modes map onto Devin's `mode` session config option:
 * `accept-edits` ("Code"), `smart`, `ask`, `plan`, `bypass`.
 */
export function devinPermissionMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "bypass";
    case "auto":
      return "smart";
    case "auto-accept-edits":
    case "approval-required":
      return "accept-edits";
  }
}

/** The select config option Devin uses for models — `category: "model"`. */
export function devinModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions?.find((option) => option.category === "model");
}

/** Flattens select entries and groups into one option list. */
export function devinModelOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> {
  if (configOption?.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

/**
 * The session's current native model id: Devin reports it on the model config
 * option's `currentValue` — there is no `models` field on session setup.
 */
export function currentDevinModelIdFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): string | undefined {
  const configOption = devinModelConfigOption(configOptions);
  if (configOption?.type !== "select") {
    return undefined;
  }
  return configOption.currentValue.trim() || undefined;
}

/**
 * Resolves the product slug to send over the wire. "default" resolves to the
 * slug itself — callers treat it as "keep Devin's configured model" and never
 * send it to the agent.
 */
export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEVIN_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? DEVIN_DEFAULT_MODEL_SLUG;
}

/**
 * Applies the product's model selection through the `model` config option
 * (`runtime.setModel` → `session/set_config_option`). Devin has no
 * `session/set_model` path and no effort picker — effort is embedded in the
 * model id itself (`-low`, `-high`, `-max`, …). The "default" slug keeps the
 * session's configured model and is never sent.
 */
export const applyDevinAcpModelSelection = Effect.fn("applyDevinAcpModelSelection")(function* <
  E,
>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setModel"
  >;
  /** Product slug; "default" means keep Devin's configured model. */
  readonly model: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.fn.Return<string | undefined, E> {
  const configOptions = yield* input.runtime.getConfigOptions;
  const modelConfig = devinModelConfigOption(configOptions);
  const current =
    modelConfig?.type === "select" ? modelConfig.currentValue.trim() || undefined : undefined;
  const requested = input.model?.trim();
  if (!requested || requested === DEVIN_DEFAULT_MODEL_SLUG || requested === current) {
    return current;
  }
  // Devin rejects ids it did not advertise, and the runtime validates against
  // the select options anyway — fail early with a clearer message.
  const advertised = devinModelOptions(modelConfig);
  if (advertised.length > 0 && !advertised.some((option) => option.value === requested)) {
    return yield* Effect.fail(
      input.mapError(
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Devin model '${requested}' is not available on this account. Pick an advertised model.`,
        ),
      ),
    );
  }
  yield* input.runtime.setModel(requested).pipe(Effect.mapError(input.mapError));
  return requested;
});
