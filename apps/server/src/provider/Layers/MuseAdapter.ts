import {
  ApprovalRequestId,
  EventId,
  type MuseSettings,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type TurnCompletedPayload,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import {
  MUSE_ELICITATION_CANCEL_RESPONSE,
  MUSE_ELICITATION_CREATE_METHOD,
  MuseElicitationCreateParams,
  applyMuseAcpMode,
  applyMuseAcpModelSelection,
  currentMuseModelIdFromSessionSetup,
  currentMuseReasoningEffortFromSessionSetup,
  isMuseAuthRequiredError,
  makeMuseAcpRuntime,
  museElicitationContent,
  museElicitationQuestions,
  normalizeMuseReasoningEffort,
  resolveMuseAcpBaseModelId,
  resolveMuseSessionModeId,
  type MuseAcpRuntimeInput,
} from "../acp/MuseAcpSupport.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("muse");
const MUSE_RESUME_VERSION = 1 as const;
const COMPACT_SLASH_COMMAND = "/compact" as const;

const isAcpError = Schema.is(EffectAcpErrors.AcpError);

export interface MuseAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  /** Provider session environment; the device MCP variables are layered on top. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Runtime factory seam for tests; production uses `makeMuseAcpRuntime`. */
  readonly makeRuntime?: (
    input: MuseAcpRuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Scope.Scope
  >;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) => Effect.Effect<void>;
  readonly onAuthRequired?: Effect.Effect<void>;
}

interface PendingApproval {
  readonly request: EffectAcpSchema.RequestPermissionRequest;
  readonly response: Deferred.Deferred<{
    readonly decision: ProviderApprovalDecision;
    readonly result: EffectAcpSchema.RequestPermissionResponse;
  }>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly response: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
}

interface MuseSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  /**
   * Operations the user chose "always allow" for. The Muse host remembers
   * session-scoped approvals too, but identical requests can still arrive
   * without an allow_always option, so the adapter remembers them as well.
   */
  readonly sessionApprovedOperations: Set<string>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  generation: number;
  /** Bumped by interruptTurn so a steer still queued on promptLock is discarded. */
  stopEpoch: number;
  currentModelId: string | undefined;
  currentReasoningEffort: string | undefined;
  stopped: boolean;
  closed: boolean;
  /** Set when the bridge process died on its own; skips the cancel handshake. */
  disconnected: boolean;
}

type MuseAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

/**
 * Maps a T3 decision to the option id Muse advertised for it. Option ids are
 * opaque MSP choice ids, so the match is by kind and the advertised id is
 * sent back untouched. No match means the choice is rejected, never
 * redirected to an unrelated option.
 */
export function selectMusePermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kinds: ReadonlyArray<EffectAcpSchema.PermissionOption["kind"]> =
    decision === "accept"
      ? ["allow_once"]
      : decision === "acceptForSession" || decision === "acceptAlways"
        ? ["allow_always"]
        : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const option = request.options.find((entry) => entry.kind === kind && entry.optionId.trim());
    if (option) return option.optionId;
  }
  return undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectMusePermissionOptionId(request, "acceptForSession") ??
    selectMusePermissionOptionId(request, "accept")
  );
}

/** Only advertise decisions that the native request can honor. */
export function museApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const options: ProviderApprovalOption[] = [];
  const optionWithKind = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.find((entry) => entry.kind === kind && entry.optionId.trim());
  const once = optionWithKind("allow_once");
  if (once) {
    options.push({ decision: "accept", label: once.name.trim() || "Allow once" });
  }
  const always = optionWithKind("allow_always");
  if (always) {
    options.push({
      decision: "acceptForSession",
      label: always.name.trim() || "Allow for this thread",
    });
  }
  if (optionWithKind("reject_once") || optionWithKind("reject_always")) {
    options.push({ decision: "decline", label: "Deny" });
  }
  options.push({ decision: "cancel", label: "Cancel" });
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMuseResumeCursor(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  const sessionId = raw.sessionId;
  return typeof sessionId === "string" && sessionId.trim().length > 0
    ? { sessionId: sessionId.trim() }
    : undefined;
}

/** Keeps one `muse-acp-bridge` process per thread. */
export const makeMuseAdapter = Effect.fn("makeMuseAdapter")(function* (
  settings: MuseSettings,
  options: MuseAdapterOptions,
) {
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("muse");
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Effect.scope;
  const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();
  const sessions = new Map<ThreadId, MuseSessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create a Muse event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({
    eventId: Effect.map(randomId, EventId.make),
    createdAt: nowIso,
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
      );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const cancelRequests = Effect.fn("MuseAdapter.cancelRequests")(function* (
    context: MuseSessionContext,
  ) {
    for (const pending of context.pendingApprovals.values()) {
      yield* Deferred.succeed(pending.response, {
        decision: "cancel",
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    // An empty answer set maps to no usable content, which the elicitation
    // handler answers with `cancel` — the bridge then cancels the question.
    for (const pending of context.pendingUserInputs.values()) {
      yield* Deferred.succeed(pending.response, {});
    }
  });

  const stopContext = (context: MuseSessionContext) =>
    context.stopLock
      .withPermit(
        Effect.gen(function* () {
          if (context.closed) return;
          context.stopped = true;
          context.stopEpoch += 1;
          yield* Effect.gen(function* () {
            yield* cancelRequests(context);
            // A dead process cannot answer session/cancel — skip it.
            if (context.promptFiber && !context.disconnected) {
              yield* Effect.ignore(context.acp.cancel);
            }
          }).pipe(Effect.ensuring(Scope.close(context.scope, Exit.void)));
          context.closed = true;
          if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          yield* emit({
            type: "session.exited",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            payload: {
              exitKind: context.disconnected ? "error" : "graceful",
              ...(context.disconnected ? { reason: "Muse process stopped." } : {}),
            },
          });
        }),
      )
      .pipe(Effect.uninterruptible);

  const handlePermission = Effect.fn("MuseAdapter.handlePermission")(function* (
    context: MuseSessionContext,
    request: EffectAcpSchema.RequestPermissionRequest,
  ): Effect.fn.Return<EffectAcpSchema.RequestPermissionResponse, ProviderAdapterError> {
    if (context.stopped || request.sessionId !== context.acpSessionId) {
      return { outcome: { outcome: "cancelled" } };
    }

    const parsed = parsePermissionRequest(request);
    const { kind, title, rawInput, locations } = request.toolCall;
    const command = parsed.toolCall?.command;
    // Remember the operation, not the tool-call id, so a repeated identical
    // action is what "always allow" actually approves.
    const approvalKey =
      command || (isRecord(rawInput) && Object.keys(rawInput).length > 0)
        ? stableStringify({ kind, title, command, input: rawInput, locations })
        : undefined;

    if (
      context.session.runtimeMode === "full-access" ||
      (approvalKey !== undefined && context.sessionApprovedOperations.has(approvalKey))
    ) {
      const autoApprovedOptionId = selectAutoApprovedPermissionOption(request);
      if (autoApprovedOptionId !== undefined) {
        return {
          outcome: { outcome: "selected", optionId: autoApprovedOptionId },
        };
      }
    }

    const requestId = ApprovalRequestId.make(yield* randomId);
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const turnId = context.activeTurnId;
    const response = yield* Deferred.make<{
      decision: ProviderApprovalDecision;
      result: EffectAcpSchema.RequestPermissionResponse;
    }>();
    context.pendingApprovals.set(requestId, { request, response });
    const permissionRequest = {
      ...parsed,
      detail: parsed.detail ?? "Muse requests permission.",
    };
    return yield* Effect.gen(function* () {
      yield* emit(
        makeAcpRequestOpenedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          approvalOptions: museApprovalOptions(request),
          detail: permissionRequest.detail,
          args: request,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: request,
        }),
      );
      const resolved = yield* Deferred.await(response);
      yield* emit(
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          decision: resolved.decision,
        }),
      );
      return resolved.result;
    }).pipe(Effect.ensuring(Effect.sync(() => context.pendingApprovals.delete(requestId))));
  });

  /**
   * Bridges the bridge's `elicitation/create` form into a T3 user-input
   * request and back. The reply is fail-closed: only an `accept` with at
   * least one usable answer reaches the bridge; every other path (empty
   * answers, stop, interruption, session id mismatch, no questions) answers
   * `cancel`, which cancels the host-side question instead of guessing.
   */
  const handleElicitation = Effect.fn("MuseAdapter.handleElicitation")(function* (
    context: MuseSessionContext,
    params: MuseElicitationCreateParams,
  ): Effect.fn.Return<unknown, ProviderAdapterError> {
    if (context.stopped || params.sessionId !== context.acpSessionId) {
      return MUSE_ELICITATION_CANCEL_RESPONSE;
    }
    const questions = museElicitationQuestions(params);
    if (questions.length === 0) {
      return MUSE_ELICITATION_CANCEL_RESPONSE;
    }
    const requestId = ApprovalRequestId.make(yield* randomId);
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const turnId = context.activeTurnId;
    const response = yield* Deferred.make<ProviderUserInputAnswers>();
    context.pendingUserInputs.set(requestId, { questions, response });
    return yield* Effect.gen(function* () {
      yield* emit({
        type: "user-input.requested",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: context.threadId,
        turnId,
        requestId: runtimeRequestId,
        payload: { questions },
        raw: {
          source: "acp.muse.extension",
          method: MUSE_ELICITATION_CREATE_METHOD,
          payload: params,
        },
      });
      const answers = yield* Deferred.await(response);
      yield* emit({
        type: "user-input.resolved",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: context.threadId,
        turnId,
        requestId: runtimeRequestId,
        payload: { answers },
      });
      const content = museElicitationContent(questions, answers);
      return content !== undefined
        ? { action: "accept", content }
        : MUSE_ELICITATION_CANCEL_RESPONSE;
    }).pipe(Effect.ensuring(Effect.sync(() => context.pendingUserInputs.delete(requestId))));
  });

  const startSession: MuseAdapterShape["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }

        const cwd = path.resolve(input.cwd.trim());
        if (input.modelSelection && input.modelSelection.instanceId !== boundInstanceId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The selected model belongs to another provider instance.",
          });
        }
        const modelSelection = input.modelSelection;
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopContext(existing);
        }

        const sessionScope = yield* Scope.make("sequential");
        let context: MuseSessionContext | undefined;
        const resumeSessionId = parseMuseResumeCursor(input.resumeCursor)?.sessionId;

        return yield* Effect.gen(function* () {
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const makeRuntime = options.makeRuntime ?? makeMuseAcpRuntime;
          const acp = yield* makeRuntime({
            museSettings: settings,
            ...(options.environment || mcpSession?.agentDeviceEnvironment
              ? {
                  environment: McpProviderSession.withAgentDeviceEnvironment(
                    options.environment ?? process.env,
                    mcpSession,
                  ),
                }
              : {}),
            childProcessSpawner,
            cwd,
            // The attachments dir grant lets the agent read pasted files at the
            // paths ProviderService injects into the turn text.
            additionalDirectories: [serverConfig.attachmentsDir],
            ...(resumeSessionId ? { resumeSessionId, resumeMethod: "resume" as const } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...makeNativeLoggers({
              nativeEventLogger: options.nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          yield* acp.handleRequestPermission((request) =>
            context
              ? handlePermission(context, request).pipe(
                  Effect.mapError((cause) =>
                    EffectAcpErrors.AcpRequestError.internalError(
                      "Could not process a Muse permission request.",
                      undefined,
                      { cause },
                    ),
                  ),
                )
              : Effect.succeed({
                  outcome: { outcome: "cancelled" },
                } satisfies EffectAcpSchema.RequestPermissionResponse),
          );
          yield* acp.handleExtRequest(
            MUSE_ELICITATION_CREATE_METHOD,
            MuseElicitationCreateParams,
            (params) =>
              context
                ? handleElicitation(context, params).pipe(
                    Effect.mapError((cause) =>
                      EffectAcpErrors.AcpRequestError.internalError(
                        "Could not process a Muse elicitation request.",
                        undefined,
                        { cause },
                      ),
                    ),
                  )
                : Effect.succeed(MUSE_ELICITATION_CANCEL_RESPONSE),
          );
          // The bridge only emits these two client-bound requests today, but
          // unknown extensions must still fail closed instead of hanging: a
          // request gets method-not-found, a notification is dropped.
          yield* acp.handleUnknownExtRequest((method) =>
            Effect.fail(EffectAcpErrors.AcpRequestError.methodNotFound(method)),
          );
          yield* acp.handleUnknownExtNotification(() => Effect.void);
          const started = yield* acp.start();

          const requestedModelId = modelSelection?.model
            ? resolveMuseAcpBaseModelId(modelSelection.model)
            : undefined;
          const currentStartReasoningEffort = currentMuseReasoningEffortFromSessionSetup(
            started.sessionSetupResult,
          );
          const requestedStartReasoningEffort = getModelSelectionStringOptionValue(
            modelSelection,
            "reasoningEffort",
          );
          const currentModelId = yield* applyMuseAcpModelSelection({
            runtime: acp,
            currentModelId: currentMuseModelIdFromSessionSetup(started.sessionSetupResult),
            currentReasoningEffort: currentStartReasoningEffort,
            requestedModelId,
            requestedReasoningEffort: requestedStartReasoningEffort,
            mapError: (cause) => cause,
          });
          yield* applyMuseAcpMode({
            runtime: acp,
            modeId: resolveMuseSessionModeId({
              interactionMode: undefined,
              runtimeMode: input.runtimeMode,
              modeState: yield* acp.getModeState,
            }),
            mapError: (cause) => cause,
          });
          yield* options.onSessionStarted?.(started) ?? Effect.void;

          const createdAt = yield* nowIso;
          // The picker's slug (e.g. "default") stays on session.model so the
          // UI keeps showing the configured-model choice; the resolved native
          // id lives on context.currentModelId.
          const selectedModel = modelSelection?.model.trim();
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(selectedModel
              ? { model: selectedModel }
              : currentModelId
                ? { model: currentModelId }
                : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: MUSE_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt,
            updatedAt: createdAt,
          };
          context = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            scope: sessionScope,
            acp,
            promptLock: yield* Semaphore.make(1),
            stopLock: yield* Semaphore.make(1),
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            sessionApprovedOperations: new Set(),
            turns: [],
            session,
            activeTurnId: undefined,
            promptFiber: undefined,
            generation: 0,
            stopEpoch: 0,
            currentModelId,
            currentReasoningEffort:
              requestedStartReasoningEffort !== undefined
                ? normalizeMuseReasoningEffort(requestedStartReasoningEffort)
                : currentStartReasoningEffort,
            stopped: false,
            closed: false,
            disconnected: false,
          };

          yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (event._tag === "AvailableCommandsUpdated") {
                  yield* options.onAvailableCommands?.(event.availableCommands) ?? Effect.void;
                  return;
                }
                if (event._tag === "ModeChanged" || event._tag === "ConfigOptionsUpdated") {
                  return;
                }
                if (event._tag === "ConnectionTerminated") {
                  // The process is gone: no cancel can reach it and no more
                  // events arrive. Fork the stop into the adapter's owner
                  // scope so the scope close and session.exited emission
                  // survive this consumer fiber's own scope teardown.
                  if (context !== undefined && !context.closed) {
                    context.stopped = true;
                    context.disconnected = true;
                    yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
                  }
                  return;
                }
                const turnId = context?.activeTurnId;
                if (turnId === undefined || context === undefined) return;
                const eventStamp = yield* stamp;
                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* emit(
                      makeAcpAssistantItemEvent({
                        stamp: eventStamp,
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* emit(
                      makeAcpAssistantItemEvent({
                        stamp: eventStamp,
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* emit(
                      makeAcpPlanUpdatedEvent({
                        stamp: eventStamp,
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* emit(
                      makeAcpToolCallEvent({
                        stamp: eventStamp,
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* emit(
                      makeAcpContentDeltaEvent({
                        stamp: eventStamp,
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ThoughtDelta":
                    yield* emit(
                      makeAcpContentDeltaEvent({
                        stamp: eventStamp,
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        streamKind: "reasoning_text",
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catchCause(() => Effect.logError("Could not process a Muse runtime event.")),
            // The consumer must outlive startSession: fork into the session
            // scope, not the calling fiber.
            Effect.forkIn(context.scope),
          );

          sessions.set(input.threadId, context);
          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Muse ACP session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          yield* acp.drainEvents;
          if (context.stopped) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          return session;
        }).pipe(
          // The scope transfers to the context once startSession succeeds. Any
          // earlier failure must close it so the agent process is reaped.
          Effect.ensuring(
            Effect.suspend(() =>
              context === undefined ? Scope.close(sessionScope, Exit.void) : Effect.void,
            ),
          ),
        );
      }).pipe(
        Effect.tapError((cause) =>
          isMuseAuthRequiredError(cause) ? (options.onAuthRequired ?? Effect.void) : Effect.void,
        ),
        Effect.mapError((cause) =>
          isAcpError(cause)
            ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause)
            : cause,
        ),
        Effect.scoped,
      ),
    );

  const sendTurn: MuseAdapterShape["sendTurn"] = Effect.fn("MuseAdapter.sendTurn")(
    function* (input) {
      const context = yield* requireSession(input.threadId);
      if (input.modelSelection && input.modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "The selected model belongs to another provider instance.",
        });
      }

      const text = input.input?.trim();
      const imagePromptParts = yield* Effect.forEach(
        (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
        (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            return {
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            } satisfies EffectAcpSchema.ContentBlock;
          }),
      );
      const promptParts: Array<EffectAcpSchema.ContentBlock> = [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...imagePromptParts,
      ];
      if (promptParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or attachments.",
        });
      }

      let intent: TurnIntent | undefined;
      // The caller holds promptLock while it changes or settles the active turn.
      const finishTurn = (turn: TurnIntent, payload: TurnCompletedPayload) =>
        Effect.gen(function* () {
          if (turn.settled || context.stopped || context.generation !== turn.generation) return;
          turn.settled = true;
          context.activeTurnId = undefined;
          context.promptFiber = undefined;
          context.session = {
            ...context.session,
            status: payload.state === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            updatedAt: yield* nowIso,
            ...(payload.errorMessage
              ? { lastError: payload.errorMessage }
              : { lastError: undefined }),
          };
          yield* emit({
            type: "turn.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: turn.turnId,
            payload,
          });
        }).pipe(Effect.uninterruptible);

      const observedStopEpoch = context.stopEpoch;

      return yield* Effect.gen(function* () {
        const launch = yield* context.promptLock.withPermit(
          Effect.gen(function* () {
            yield* requireSession(input.threadId);
            // A steer queued behind a stop is dropped: the user pressed stop
            // after this sendTurn started waiting, so it must not open a new
            // turn behind the interrupt's back.
            if (context.stopEpoch !== observedStopEpoch) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: "Muse turn was superseded by a stop before it started.",
              });
            }
            const turnModelId = input.modelSelection?.model
              ? resolveMuseAcpBaseModelId(input.modelSelection.model)
              : undefined;
            const turnReasoningEffort = getModelSelectionStringOptionValue(
              input.modelSelection,
              "reasoningEffort",
            );
            const turnId = context.activeTurnId ?? TurnId.make(yield* randomId);
            const steering = context.activeTurnId !== undefined;
            const turn: TurnIntent = {
              turnId,
              generation: ++context.generation,
              settled: false,
            };
            intent = turn;
            context.activeTurnId = turnId;
            // Never let a prompt reach the bridge while a turn is active:
            // cancel and wait for the in-flight prompt to resolve first.
            if (context.promptFiber) {
              yield* cancelRequests(context);
              yield* context.acp.cancel;
              yield* Fiber.await(context.promptFiber);
            }
            const currentModelId = yield* applyMuseAcpModelSelection({
              runtime: context.acp,
              currentModelId: context.currentModelId,
              currentReasoningEffort: context.currentReasoningEffort,
              requestedModelId: turnModelId,
              requestedReasoningEffort: turnReasoningEffort,
              mapError: (cause) => cause,
            });
            context.currentModelId = currentModelId;
            if (turnReasoningEffort !== undefined) {
              context.currentReasoningEffort = normalizeMuseReasoningEffort(turnReasoningEffort);
            }
            if (!steering) {
              yield* emit({
                type: "turn.started",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                // The model actually running: a product slug like "default"
                // resolves to the configured native id by this point.
                payload: currentModelId !== undefined ? { model: currentModelId } : {},
              });
            }
            yield* applyMuseAcpMode({
              runtime: context.acp,
              modeId: resolveMuseSessionModeId({
                interactionMode: input.interactionMode,
                runtimeMode: context.session.runtimeMode,
                modeState: yield* context.acp.getModeState,
              }),
              mapError: (cause) => cause,
            });
            const selectedModel = input.modelSelection?.model.trim();
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              ...(selectedModel
                ? { model: selectedModel }
                : currentModelId
                  ? { model: currentModelId }
                  : {}),
              updatedAt: yield* nowIso,
            };
            const dispatched = yield* Deferred.make<void>();
            const fiber = yield* context.acp
              .prompt(
                {
                  prompt: [
                    ...promptParts,
                    {
                      type: "text",
                      text: buildRuntimeInstructions({
                        harness: "Muse",
                        model: currentModelId,
                      }),
                    },
                  ],
                },
                { dispatched },
              )
              .pipe(Effect.forkIn(context.scope));
            context.promptFiber = fiber;
            // Fiber.join can skip a scope-close waiter when the child is
            // interrupted. Unwrap the Exit after Fiber.await returns.
            yield* Effect.raceFirst(
              Deferred.await(dispatched),
              Fiber.await(fiber).pipe(
                Effect.flatMap((exit) => exit),
                Effect.asVoid,
              ),
            );
            return { turn, fiber };
          }),
        );
        const result = yield* Fiber.await(launch.fiber).pipe(Effect.flatMap((exit) => exit));
        yield* context.acp.drainEvents;
        if (context.stopped) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const record = context.turns.find((turn) => turn.id === launch.turn.turnId);
        if (record) record.items.push(result);
        else context.turns.push({ id: launch.turn.turnId, items: [result] });
        yield* context.promptLock.withPermit(
          finishTurn(launch.turn, {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason,
          }),
        );
        return {
          threadId: input.threadId,
          turnId: launch.turn.turnId,
          resumeCursor: context.session.resumeCursor,
        };
      }).pipe(
        Effect.tapError((cause) =>
          isMuseAuthRequiredError(cause) ? (options.onAuthRequired ?? Effect.void) : Effect.void,
        ),
        Effect.mapError((cause) =>
          isAcpError(cause)
            ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause)
            : cause,
        ),
        Effect.tapError((cause) =>
          Effect.suspend(() =>
            intent
              ? context.promptLock.withPermit(
                  finishTurn(intent, { state: "failed", errorMessage: cause.message }),
                )
              : Effect.void,
          ),
        ),
        Effect.onInterrupt(() =>
          context.promptLock.withPermit(
            Effect.gen(function* () {
              const turn = intent;
              if (
                !turn ||
                turn.settled ||
                context.stopped ||
                context.generation !== turn.generation
              )
                return;
              const promptFiber = context.promptFiber;
              yield* cancelRequests(context);
              yield* Effect.ignore(context.acp.cancel);
              if (promptFiber) yield* Fiber.interrupt(promptFiber);
              yield* finishTurn(turn, { state: "cancelled", stopReason: "cancelled" });
            }),
          ),
        ),
      );
    },
  );

  const interruptTurn: MuseAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      // A stale interrupt must not cancel the active turn behind its back.
      if (turnId !== undefined && context.activeTurnId !== turnId) return;
      context.stopEpoch += 1;
      yield* context.promptLock
        .withPermit(
          Effect.gen(function* () {
            yield* cancelRequests(context);
            yield* context.acp.cancel;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause),
          ),
        );
    });

  const respondToRequest: MuseAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "This approval request is no longer pending.",
        });
      }
      const optionId =
        decision === "cancel" ? undefined : selectMusePermissionOptionId(pending.request, decision);
      if (decision !== "cancel" && optionId === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: "Muse did not offer this permission choice. Select one of the available choices.",
        });
      }
      if (
        (decision === "acceptForSession" || decision === "acceptAlways") &&
        optionId !== undefined
      ) {
        const { kind, title, rawInput, locations } = pending.request.toolCall;
        const command = parsePermissionRequest(pending.request).toolCall?.command;
        const approvalKey =
          command || (isRecord(rawInput) && Object.keys(rawInput).length > 0)
            ? stableStringify({ kind, title, command, input: rawInput, locations })
            : undefined;
        if (approvalKey !== undefined) {
          context.sessionApprovedOperations.add(approvalKey);
        }
      }
      yield* Deferred.succeed(pending.response, {
        decision,
        result: {
          outcome:
            optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        },
      });
    });

  const respondToUserInput: MuseAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: MUSE_ELICITATION_CREATE_METHOD,
          detail: "This user-input request is no longer pending.",
        });
      }
      yield* Deferred.succeed(pending.response, answers);
    });

  const stopSession: MuseAdapterShape["stopSession"] = (threadId) =>
    withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
  const stopAll: MuseAdapterShape["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logError("Could not stop a Muse session."),
      ),
      Effect.ensuring(PubSub.shutdown(events)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: false,
    },
    compaction: { type: "slash-command", command: COMPACT_SLASH_COMMAND },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({
        threadId,
        turns: context.turns,
      })),
    rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Muse does not support conversation rewind over ACP. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies MuseAdapterShape;
});
