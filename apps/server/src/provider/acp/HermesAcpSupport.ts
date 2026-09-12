import { type HermesSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Product slug for "keep the model Hermes is configured with". It is not a
 * native ACP model id and must never reach `session/set_model`.
 */
export const HERMES_DEFAULT_MODEL_SLUG = "default";

/**
 * Hermes' terminal auth method: it asks the client to open `hermes --setup` in
 * a TUI. T3 cannot drive a terminal, so it is surfaced as a setup requirement,
 * never sent to `authenticate`.
 */
export const HERMES_SETUP_AUTH_METHOD_ID = "hermes-setup";

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    env: { ...environment },
  };
}

const isTerminalAuthMethod = (method: EffectAcpSchema.AuthMethod): boolean =>
  "type" in method && method.type === "terminal";

/**
 * The first agent-managed auth method Hermes advertises — a provider id such as
 * `openrouter` or `xai-oauth`, present only when Hermes resolves credentials.
 * Terminal setup methods are excluded: they describe an interactive flow T3
 * cannot run, and `authenticate("hermes-setup")` answers `null` when Hermes is
 * unconfigured, which the client cannot decode into a response.
 */
export function resolveHermesAuthMethodId(
  initialize: EffectAcpSchema.InitializeResponse,
): string | undefined {
  return (initialize.authMethods ?? []).find((method) => !isTerminalAuthMethod(method))?.id;
}

/** True when `initialize` advertised no agent-managed auth method. */
export function hermesSetupRequired(initialize: EffectAcpSchema.InitializeResponse): boolean {
  return resolveHermesAuthMethodId(initialize) === undefined;
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: resolveHermesAuthMethodId,
        // Hermes does not drain queued prompts on cancel — they run after the
        // interrupted turn finishes. Waiting for the prompt response keeps a
        // steered replacement from ever landing in that queue.
        cancelBehavior: "wait-for-prompt",
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

/** Hermes' advertised modes are a fixed set: `default`, `accept_edits`, `dont_ask`. */
export function hermesPermissionMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "dont_ask";
    case "auto-accept-edits":
      return "accept_edits";
    case "auto":
    case "approval-required":
      return "default";
  }
}

/**
 * Sends `session/set_mode` directly: `runtime.setMode` goes through
 * `session/set_config_option`, which Hermes accepts but ignores for "mode".
 */
export function applyHermesAcpMode<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "request" | "getModeState"
  >;
  readonly sessionId: string;
  readonly modeId: string;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const modeState = yield* input.runtime.getModeState;
    if (modeState?.currentModeId === input.modeId) return;
    if (
      modeState !== undefined &&
      !modeState.availableModes.some((mode) => mode.id === input.modeId)
    ) {
      return;
    }
    yield* input.runtime
      .request("session/set_mode", {
        sessionId: input.sessionId,
        modeId: input.modeId,
      })
      .pipe(Effect.mapError(input.mapError));
  });
}

export function resolveHermesAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : HERMES_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, HERMES_DRIVER_KIND) ?? HERMES_DEFAULT_MODEL_SLUG;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  // The product slug is never sent over the wire; it keeps the session's model.
  const requestedModelId =
    input.requestedModelId === HERMES_DEFAULT_MODEL_SLUG ? undefined : input.requestedModelId;
  if (requestedModelId === undefined || requestedModelId === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}
