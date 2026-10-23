import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import type { DevinSettings } from "@t3tools/provider-devin/settings";
import type { HermesSettings } from "@t3tools/provider-hermes/settings";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/compat";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
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
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import {
  extractDevinSubagentUpdate,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
} from "@t3tools/provider-acp-registry/server/devinAcp";

type ForkProvider =
  | { readonly driver: "hermes"; readonly settings: HermesSettings }
  | { readonly driver: "devin"; readonly settings: DevinSettings };

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
      // Upstream's flavor hook surfaces ONE subagent update per call and has
      // no settle hook: a delegate_task's projected children queue here and
      // drain one per call for the same tool call (the tracker itself stays
      // turn-agnostic — id freezing, sequence monotonicity, and settle-on-
      // terminal live there; turn teardown is the adapter's job via
      // subagentsIdleOnTurnCompletion above).
      const pendingByToolCall = new Map<string, Array<ReturnType<typeof projectChild>>>();
      const extractSubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
        tool,
      ) => {
        const events = tracker.update(tool);
        if (events.length > 0) {
          const queue = pendingByToolCall.get(tool.toolCallId) ?? [];
          queue.push(...events.map(projectChild));
          pendingByToolCall.set(tool.toolCallId, queue);
        }
        const queue = pendingByToolCall.get(tool.toolCallId);
        if (queue === undefined || queue.length === 0) return undefined;
        const next = queue.shift()!;
        if (queue.length === 0) pendingByToolCall.delete(tool.toolCallId);
        return next;
      };
      return {
        ...common,
        preferResumeSession: true,
        sessionModeForPolicy: (policy) => hermesPermissionMode(policy.runtimeMode),
        extractSubagentUpdate,
        applyModelSelection: Effect.fn("ForkAcpAdapterV2.applyHermesModelSelection")(function* ({
          runtime,
          startResult,
          modelSelection,
        }) {
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
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const selfInvocation = yield* resolveSelfInvocation();
  const loggers = yield* ProviderEventLoggers;
  const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
  const driver = ProviderDriverKind.make(provider.driver);
  const makeRuntime = Effect.fn("ForkAcpAdapterV2.makeRuntime")(function* (
    input: AcpAdapterV2RuntimeInput,
  ) {
    const common = {
      ...input,
      environment: { ...callbacks.environment, ...input.processEnvironment },
      childProcessSpawner: spawner,
    };
    const runtime = yield* provider.driver === "hermes"
      ? makeHermesAcpRuntime({ ...common, hermesSettings: provider.settings })
      : makeDevinAcpRuntime({ ...common, devinSettings: provider.settings });
    const onAuthError = (cause: AcpErrors.AcpError) =>
      cause._tag === "AcpRequestError" && cause.code === -32000
        ? callbacks.onAuthRequired
        : Effect.void;
    return {
      ...runtime,
      start: () =>
        runtime.start().pipe(Effect.tap(callbacks.onSessionStarted), Effect.tapError(onAuthError)),
      prompt: (...args: Parameters<typeof runtime.prompt>) =>
        runtime.prompt(...args).pipe(Effect.tapError(onAuthError)),
      setMode: Effect.fn("ForkAcpAdapterV2.setMode")(function* (modeId: string) {
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
        return yield* runtime.setMode(modeId);
      }),
    };
  });
  // Upstream's adapter takes one flavor per adapter instance (no per-session
  // flavor factory); the flavor's per-session state is keyed by session/turn id.
  const flavor = {
    ...makeForkAcpFlavor(provider, makeRuntime),
    onAvailableCommandsUpdate: callbacks.onAvailableCommands,
  };
  return yield* makeAcpAdapterV2({
    instanceId: callbacks.instanceId,
    flavor,
    selfInvocation,
    ...(provider.driver === "devin"
      ? {
          clientTerminals: {
            environment: callbacks.environment ?? {},
            shellCommands: true,
          },
        }
      : {}),
    nativeLogging: (threadId) =>
      makeNativeLogger({ nativeEventLogger: loggers.native, provider: driver, threadId }),
  });
});
