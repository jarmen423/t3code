import {
  ProviderDriverKind,
  type DevinSettings,
  type HermesSettings,
  type MuseSettings,
  type ProviderInstanceId,
  type ProviderUsageLimitsUpdate,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/compat";
import { ServerConfig } from "../../config.ts";
import { ProviderEventLoggers } from "../../provider/Layers/ProviderEventLoggers.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  applyDevinAcpModelSelection,
  devinPermissionMode,
  makeDevinAcpRuntime,
} from "../../provider/acp/DevinAcpSupport.ts";
import {
  applyHermesAcpMode,
  applyHermesAcpModelSelection,
  currentHermesModelIdFromSessionSetup,
  currentHermesReasoningEffortFromSessionSetup,
  hermesPermissionMode,
  normalizeHermesReasoningEffort,
  makeHermesAcpRuntime,
} from "../../provider/acp/HermesAcpSupport.ts";
import {
  HermesDelegationTracker,
  type HermesDelegationLifecycle,
} from "../../provider/acp/HermesDelegationTasks.ts";
import {
  applyMuseAcpModelSelection,
  currentMuseModelIdFromSessionSetup,
  currentMuseReasoningEffortFromSessionSetup,
  isMuseAuthRequiredError,
  isMuseRateLimitedError,
  isMuseUsageExhaustedError,
  makeMuseAcpRuntime,
  museFailedStopError,
  musePermissionMode,
  museSubscriptionUsageUpdate,
  resolveMuseSessionModeId,
} from "../../provider/acp/MuseAcpSupport.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";
import {
  extractDevinSubagentUpdate,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
} from "./DevinAcp.ts";

type ForkProvider =
  | { readonly driver: "hermes"; readonly settings: HermesSettings }
  | { readonly driver: "devin"; readonly settings: DevinSettings }
  | { readonly driver: "muse"; readonly settings: MuseSettings };

interface ForkAcpCallbacks {
  readonly instanceId: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onSessionStarted: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands: (
    commands: ReadonlyArray<AcpSchema.AvailableCommand>,
  ) => Effect.Effect<void>;
  readonly onAuthRequired: Effect.Effect<void>;
  /**
   * Runtime subscription-usage updates (Muse only today). Sparse: windows
   * merge by id onto the published snapshot; unset when the driver has
   * no usage-limits surface.
   */
  readonly onUsageLimits?: (
    update: ProviderUsageLimitsUpdate & { readonly checkedAt: string },
  ) => Effect.Effect<void>;
}

export function makeForkAcpFlavor(
  provider: ForkProvider,
  makeRuntime: AcpAdapterV2Flavor["makeRuntime"],
): AcpAdapterV2Flavor {
  const common = {
    driver: ProviderDriverKind.make(provider.driver),
    runtimeHarness: provider.driver,
    makeRuntime,
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      sessions: {
        ...AcpProviderCapabilitiesV2.sessions,
        supportsModelSwitchInSession: true,
        supportsRuntimeModeSwitchInSession: true,
      },
      subagents: { ...AcpProviderCapabilitiesV2.subagents, supportsSubagents: true },
    },
    supportsImagePrompts: true,
    subagentsIdleOnTurnCompletion: true,
  } satisfies AcpAdapterV2Flavor;
  switch (provider.driver) {
    case "devin":
      return {
        ...common,
        clientCapabilitiesMeta: {
          "cognition.ai/subagentSupport": true,
          "cognition.ai/messageGrouping": true,
        },
        normalizeSessionUpdate: normalizeDevinSessionUpdate,
        normalizeToolCall: normalizeDevinToolCall,
        extractSubagentUpdate: extractDevinSubagentUpdate,
        sessionModeForPolicy: (policy) =>
          policy.interactionMode === "plan" ? "plan" : devinPermissionMode(policy.runtimeMode),
        applyModelSelection: ({ runtime, modelSelection }) =>
          applyDevinAcpModelSelection({
            runtime,
            model: modelSelection.model,
            mapError: (cause) => cause,
          }),
      };
    case "muse":
      return {
        ...common,
        // Quota and rate pressure surface as `usage_limit` (warning
        // styling) instead of a generic provider error; the bridge's
        // own failure text rides along, redacted and bounded.
        promptFailure: (cause) =>
          makeProviderFailure({
            cause,
            ...(isMuseUsageExhaustedError(cause)
              ? {
                  class: "usage_limit" as const,
                  code: "muse_usage_exhausted",
                  retryable: false,
                  ...(cause instanceof Error
                    ? { message: `Muse usage exhausted: ${cause.message}` }
                    : {}),
                }
              : isMuseRateLimitedError(cause)
                ? { class: "usage_limit" as const, code: "muse_rate_limited", retryable: true }
                : { class: "provider_error" as const }),
          }),
        sessionModeForPolicy: (policy) =>
          policy.interactionMode === "plan" ? "ask" : musePermissionMode(policy.runtimeMode),
        applyModelSelection: ({ runtime, modelSelection }) =>
          Effect.gen(function* () {
            const setup = { configOptions: yield* runtime.getConfigOptions };
            return yield* applyMuseAcpModelSelection({
              runtime,
              currentModelId: currentMuseModelIdFromSessionSetup(setup),
              currentReasoningEffort: currentMuseReasoningEffortFromSessionSetup(setup),
              requestedModelId: modelSelection.model,
              requestedReasoningEffort: getModelSelectionStringOptionValue(
                modelSelection,
                "reasoningEffort",
              ),
              mapError: (cause) => cause,
            });
          }),
      };
    case "hermes": {
      const tracker = new HermesDelegationTracker();
      const reasoningEfforts = new Map<string, string | undefined>();
      const projectChild = (child: HermesDelegationLifecycle) => ({
        nativeTaskId: child.taskId,
        prompt: child.description,
        title: child.description,
        model: child.model ?? null,
        childSessionId: null,
        status:
          child.phase !== "completed"
            ? ("running" as const)
            : child.status === "stopped"
              ? ("interrupted" as const)
              : child.status,
        result: child.phase === "started" ? null : (child.summary ?? null),
      });
      return {
        ...common,
        preferResumeSession: true,
        sessionModeForPolicy: (policy) => hermesPermissionMode(policy.runtimeMode),
        extractSubagentUpdates: (tool, nativeTurnId) =>
          tracker.update(tool, nativeTurnId).map(projectChild),
        settleSubagents: (nativeTurnId) => tracker.settleTurn(nativeTurnId).map(projectChild),
        applyModelSelection: ({ runtime, startResult, modelSelection }) =>
          Effect.gen(function* () {
            const requestedReasoningEffort = getModelSelectionStringOptionValue(
              modelSelection,
              "reasoningEffort",
            );
            const sessionId = startResult.sessionId;
            const appliedModel = yield* applyHermesAcpModelSelection({
              runtime,
              currentModelId: currentHermesModelIdFromSessionSetup(startResult.sessionSetupResult),
              currentReasoningEffort: reasoningEfforts.has(sessionId)
                ? reasoningEfforts.get(sessionId)
                : currentHermesReasoningEffortFromSessionSetup(startResult.sessionSetupResult),
              requestedModelId: modelSelection.model,
              requestedReasoningEffort,
              mapError: (cause) => cause,
            });
            const effort = normalizeHermesReasoningEffort(requestedReasoningEffort);
            if (effort !== undefined && appliedModel !== undefined) {
              reasoningEfforts.set(sessionId, effort);
            }
            return appliedModel;
          }),
      };
    }
  }
}

export const makeForkAcpAdapterV2 = Effect.fn("makeForkAcpAdapterV2")(function* (
  provider: ForkProvider,
  callbacks: ForkAcpCallbacks,
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const selfInvocation = yield* resolveSelfInvocation();
  const loggers = yield* ProviderEventLoggers;
  const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
  const driver = ProviderDriverKind.make(provider.driver);
  const makeRuntime = (input: AcpAdapterV2RuntimeInput) =>
    Effect.gen(function* () {
      const common = {
        ...input,
        environment: { ...callbacks.environment, ...input.processEnvironment },
        childProcessSpawner: spawner,
      };
      const runtime = yield* provider.driver === "hermes"
        ? makeHermesAcpRuntime({ ...common, hermesSettings: provider.settings })
        : provider.driver === "devin"
          ? makeDevinAcpRuntime({ ...common, devinSettings: provider.settings })
          : makeMuseAcpRuntime({ ...common, museSettings: provider.settings });
      const onAuthError = (cause: AcpErrors.AcpError) =>
        (cause._tag === "AcpRequestError" && cause.code === -32000) ||
        isMuseAuthRequiredError(cause)
          ? callbacks.onAuthRequired
          : Effect.void;
      const promptBase = (...args: Parameters<typeof runtime.prompt>) => runtime.prompt(...args);
      return {
        ...runtime,
        start: () =>
          runtime
            .start()
            .pipe(Effect.tap(callbacks.onSessionStarted), Effect.tapError(onAuthError)),
        // Muse acks v2 prompts `{}` up front and reports mid-turn
        // failures as `idle/_failed`; convert those into the typed
        // error the v1 path would have carried so failure
        // classification (and the auth tap) sees them.
        prompt: (...args: Parameters<typeof runtime.prompt>) =>
          provider.driver === "muse"
            ? promptBase(...args).pipe(
                Effect.flatMap((result) => {
                  const failure = museFailedStopError(result);
                  return failure === undefined ? Effect.succeed(result) : Effect.fail(failure);
                }),
                Effect.tapError(onAuthError),
              )
            : promptBase(...args).pipe(Effect.tapError(onAuthError)),
        setMode: (modeId: string) =>
          Effect.gen(function* () {
            if (provider.driver === "hermes") {
              const started = yield* runtime.start();
              yield* applyHermesAcpMode({
                runtime,
                sessionId: started.sessionId,
                modeId,
                mapError: (cause) => cause,
              });
              return {};
            }
            if (provider.driver === "muse") {
              const resolved = resolveMuseSessionModeId({
                runtimeMode: modeId === "auto" ? "full-access" : "approval-required",
                interactionMode: "default",
                modeState: yield* runtime.getModeState,
              });
              if (resolved === undefined)
                return yield* AcpErrors.AcpRequestError.invalidParams(
                  "Muse has no advertised mode that can enforce this runtime policy.",
                );
              return yield* runtime.setMode(resolved);
            }
            return yield* runtime.setMode(modeId);
          }),
      };
    });
  // The bridge forwards MSP `usage/changed` under
  // `_meta.muse.subscription` on session meta updates; fold each
  // observation into the published usage bars (Muse only).
  const onUsageLimits = provider.driver === "muse" ? callbacks.onUsageLimits : undefined;
  const createSessionFlavor = () => ({
    ...makeForkAcpFlavor(provider, makeRuntime),
    onAvailableCommandsUpdate: callbacks.onAvailableCommands,
    ...(onUsageLimits !== undefined
      ? {
          onSessionEvent: (event: AcpSessionRuntime.AcpSessionRuntimeEvent) =>
            Effect.gen(function* () {
              if (event._tag !== "UsageUpdated" && event._tag !== "SessionInfoUpdated") {
                return;
              }
              const update = museSubscriptionUsageUpdate(event.rawPayload);
              if (update === undefined) {
                return;
              }
              const checkedAt = DateTime.formatIso(yield* DateTime.now);
              yield* onUsageLimits({ ...update, checkedAt });
            }),
        }
      : {}),
  });
  return makeAcpAdapterV2({
    instanceId: callbacks.instanceId,
    flavor: createSessionFlavor(),
    createSessionFlavor,
    crypto,
    fileSystem,
    idAllocator,
    serverConfig,
    selfInvocation,
    ...(provider.driver === "devin"
      ? {
          clientTerminals: {
            childProcessSpawner: spawner,
            environment: callbacks.environment ?? {},
            shellCommands: true,
          },
        }
      : {}),
    nativeLogging: (threadId) =>
      makeNativeLogger({ nativeEventLogger: loggers.native, provider: driver, threadId }),
  });
});
