import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  MuseSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import type { AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import { MUSE_ELICITATION_CREATE_METHOD } from "../acp/MuseAcpSupport.ts";
import {
  makeMuseAdapter,
  museApprovalOptions,
  selectMusePermissionOptionId,
  type MuseAdapterOptions,
} from "./MuseAdapter.ts";

const instanceId = ProviderInstanceId.make("muse-test");
const threadId = ThreadId.make("muse-thread");
const nativeSessionId = "muse-session-1";
const nativeDefault = "muse-spark-1.3";
const nativeAlternative = "muse-spark-1.2";
const decodeSettings = Schema.decodeSync(MuseSettings);
// The log captures every incoming line — including the client's response to
// the bridge's `elicitation/create` request, which has no `method` key.
const decodeRequestLog = (lines: ReadonlyArray<string>) =>
  Effect.succeed(
    lines.flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
        const method = (parsed as { method?: unknown }).method;
        return typeof method === "string"
          ? [{ method, params: (parsed as { params?: unknown }).params }]
          : [];
      } catch {
        return [];
      }
    }),
  );

const nativeModes = [
  { id: "ask", name: "Ask" },
  { id: "auto", name: "Auto" },
  { id: "yolo", name: "Yolo" },
  { id: "deny", name: "Deny" },
];

const nativeConfigOptions = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "auto",
    options: nativeModes.map((mode) => ({ value: mode.id, name: mode.name })),
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: nativeDefault,
    options: [
      { value: "muse-spark-1.3", name: "Muse Spark 1.3" },
      { value: "muse-spark-1.2", name: "Muse Spark 1.2" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "ultra", name: "Ultra" },
    ],
  },
] satisfies ReadonlyArray<AcpSchema.SessionConfigOption>;

interface NativePrompt {
  readonly index: number;
  readonly content: ReadonlyArray<AcpSchema.ContentBlock>;
  readonly result: Deferred.Deferred<AcpSchema.PromptResponse, AcpErrors.AcpError>;
}

type Runtime = Effect.Success<ReturnType<NonNullable<MuseAdapterOptions["makeRuntime"]>>>;

type ElicitationHandler = (params: unknown) => Effect.Effect<unknown, AcpErrors.AcpError>;

const makeHarness = Effect.fn("makeMuseAdapterHarness")(function* (options?: {
  readonly enabled?: boolean;
  readonly holdCancel?: boolean;
  readonly onAuthRequired?: Effect.Effect<void>;
}) {
  const runtimeEvents = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
  const canonicalEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const prompts = yield* Queue.unbounded<NativePrompt>();
  const cancellations = yield* Queue.unbounded<number>();
  const cancelRelease = yield* Deferred.make<void>();
  const seen: ProviderRuntimeEvent[] = [];
  const calls: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const launches: Array<Parameters<NonNullable<MuseAdapterOptions["makeRuntime"]>>[0]> = [];
  const controls = {
    closed: 0,
    startError: undefined as AcpErrors.AcpError | undefined,
  };
  let promptIndex = 0;
  let active: NativePrompt | undefined;
  const modeState = yield* Ref.make({
    currentModeId: "auto",
    availableModes: nativeModes,
  });
  let permissionHandler:
    | ((
        request: AcpSchema.RequestPermissionRequest,
      ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpErrors.AcpError>)
    | undefined;
  let elicitationHandler: ElicitationHandler | undefined;

  const drainEvents = Effect.gen(function* () {
    const acknowledge = yield* Deferred.make<void>();
    yield* Queue.offer(runtimeEvents, { _tag: "EventStreamBarrier", acknowledge });
    yield* Deferred.await(acknowledge);
  });
  const emitNative = (event: AcpSessionRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

  const stubHandler = () => Effect.void;
  const runtime = {
    handleRequestPermission: (handler: typeof permissionHandler) =>
      Effect.sync(() => {
        permissionHandler = handler ?? undefined;
      }),
    handleElicitation: stubHandler,
    handleReadTextFile: stubHandler,
    handleWriteTextFile: stubHandler,
    handleCreateTerminal: stubHandler,
    handleTerminalOutput: stubHandler,
    handleTerminalWaitForExit: stubHandler,
    handleTerminalKill: stubHandler,
    handleTerminalRelease: stubHandler,
    handleSessionUpdate: stubHandler,
    handleElicitationComplete: stubHandler,
    handleUnknownExtRequest: stubHandler,
    handleUnknownExtNotification: stubHandler,
    handleExtRequest: (method: string, _schema: unknown, handler: ElicitationHandler) =>
      Effect.sync(() => {
        if (method === MUSE_ELICITATION_CREATE_METHOD) {
          elicitationHandler = handler;
        }
      }),
    handleExtNotification: stubHandler,
    initialize: () =>
      Effect.succeed({
        protocolVersion: 1,
        authMethods: [],
      } satisfies AcpSchema.InitializeResponse),
    start: () =>
      Effect.gen(function* () {
        calls.push("start");
        const startError = controls.startError;
        if (startError !== undefined) {
          controls.startError = undefined;
          return yield* startError;
        }
        yield* emitNative({
          _tag: "AvailableCommandsUpdated",
          availableCommands: [
            { name: "help", description: "Show help" },
            { name: "compact", description: "Compact the session" },
          ],
          rawPayload: {},
        });
        return {
          sessionId: nativeSessionId,
          initializeResult: {
            protocolVersion: 1,
            agentInfo: { name: "muse-acp-bridge", version: "0.1.0" },
            agentCapabilities: { sessionCapabilities: { resume: {} } },
            authMethods: [],
          } satisfies AcpSchema.InitializeResponse,
          sessionSetupResult: {
            sessionId: nativeSessionId,
            modes: { currentModeId: "auto", availableModes: nativeModes },
            configOptions: [...nativeConfigOptions],
          } satisfies AcpSchema.NewSessionResponse,
          modelConfigId: "model",
        };
      }),
    getEvents: () => Stream.fromQueue(runtimeEvents),
    drainEvents,
    getModeState: Ref.get(modeState).pipe(Effect.map((state) => state)),
    getConfigOptions: Effect.succeed([...nativeConfigOptions]),
    prompt: (
      payload: Omit<AcpSchema.PromptRequest, "sessionId">,
      promptOptions?: {
        readonly dispatched?: Deferred.Deferred<void>;
      },
    ) =>
      Effect.gen(function* () {
        const prompt: NativePrompt = {
          index: ++promptIndex,
          content: payload.prompt,
          result: yield* Deferred.make<AcpSchema.PromptResponse, AcpErrors.AcpError>(),
        };
        active = prompt;
        calls.push(`prompt:${prompt.index}`);
        if (promptOptions?.dispatched) yield* Deferred.succeed(promptOptions.dispatched, undefined);
        yield* Queue.offer(prompts, prompt);
        return yield* Deferred.await(prompt.result).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (active === prompt) active = undefined;
            }),
          ),
        );
      }),
    cancel: Effect.gen(function* () {
      const prompt = active;
      if (!prompt) return;
      calls.push(`cancel:${prompt.index}`);
      yield* Queue.offer(cancellations, prompt.index);
      if (options?.holdCancel) yield* Deferred.await(cancelRelease);
      yield* Deferred.succeed(prompt.result, { stopReason: "cancelled" });
      yield* Deferred.await(prompt.result);
      yield* drainEvents;
      calls.push(`drained:${prompt.index}`);
    }),
    setMode: (modeId: string) =>
      Effect.gen(function* () {
        calls.push(`mode:${modeId}`);
        yield* Ref.update(modeState, (state) => ({ ...state, currentModeId: modeId }));
        return {};
      }),
    setConfigOption: (configId: string, value: string | boolean) =>
      Effect.sync(() => {
        calls.push(`config:${configId}=${String(value)}`);
        return { configOptions: [] };
      }),
    setModel: (model: string) =>
      Effect.sync(() => {
        calls.push(`model:${model}`);
      }),
    setSessionModel: () => Effect.succeed({}),
    request: (method: string, params: unknown) =>
      Effect.sync(() => {
        requests.push({ method, params });
        return {};
      }),
    notify: () => Effect.void,
  } as unknown as Runtime;

  const adapter = yield* makeMuseAdapter(decodeSettings({ enabled: options?.enabled ?? true }), {
    instanceId,
    ...(options?.onAuthRequired ? { onAuthRequired: options.onAuthRequired } : {}),
    makeRuntime: (input) =>
      Effect.gen(function* () {
        launches.push(input);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            controls.closed += 1;
          }),
        );
        return runtime;
      }),
  });
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        seen.push(event);
      }).pipe(Effect.andThen(Queue.offer(canonicalEvents, event))),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(cancelRelease, undefined).pipe(Effect.asVoid));
  const waitForEvent = Effect.fn("MuseAdapterTest.waitForEvent")(function* <
    T extends ProviderRuntimeEvent,
  >(predicate: (event: ProviderRuntimeEvent) => event is T) {
    while (true) {
      const event = yield* Queue.take(canonicalEvents);
      if (predicate(event)) return event;
    }
  });
  const invokePermission = (request: AcpSchema.RequestPermissionRequest) =>
    Effect.suspend(() =>
      permissionHandler
        ? permissionHandler(request)
        : Effect.die("Missing native permission handler"),
    );
  const invokeElicitation = (params: unknown) =>
    Effect.suspend(() =>
      elicitationHandler
        ? elicitationHandler(params)
        : Effect.die("Missing Muse elicitation handler"),
    );
  return {
    adapter,
    calls,
    launches,
    requests,
    controls,
    seen,
    waitForEvent,
    emitNative,
    invokePermission,
    invokeElicitation,
    cancelRelease,
    nextPrompt: Queue.take(prompts),
    nextCancellation: Queue.take(cancellations),
    drainEvents,
    hasActivePrompt: () => active !== undefined,
  };
});

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-muse-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("MuseAdapter", (it) => {
  it.effect("starts a session, applies model and mode natively, and streams a turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const session = yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId, model: nativeAlternative },
      });
      expect(session.model).toBe(nativeAlternative);
      // Mode and model both flow through session/set_config_option-backed
      // runtime calls; the bridge has no session/set_mode or session/set_model.
      expect(h.calls).toEqual(["start", `model:${nativeAlternative}`, "mode:yolo"]);
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Say hi" })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      yield* h.emitNative({ _tag: "ContentDelta", text: "hi", rawPayload: {} });
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      const result = yield* Fiber.join(sending);
      const completed = yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(completed.turnId).toBe(result.turnId);
      expect(completed.payload.state).toBe("completed");
      const delta = h.seen.find((event) => event.type === "content.delta");
      expect(delta?.turnId).toBe(result.turnId);
      expect((yield* h.adapter.listSessions())[0]).toMatchObject({
        status: "ready",
        activeTurnId: undefined,
        model: nativeAlternative,
      });
    }),
  );

  it.effect("keeps the product slug on session.model and sends only native ids", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const session = yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
        modelSelection: { instanceId, model: "default" },
      });
      // The picker's slug stays on session.model; it never reaches the wire,
      // and mode auto is already active.
      expect(session.model).toBe("default");
      expect(h.calls).toEqual(["start"]);

      const native = yield* h.adapter.startSession({
        threadId: ThreadId.make("muse-thread-native"),
        cwd: process.cwd(),
        runtimeMode: "auto",
        modelSelection: { instanceId, model: nativeAlternative },
      });
      expect(native.model).toBe(nativeAlternative);
      expect(h.calls).toEqual(["start", "start", `model:${nativeAlternative}`]);
    }),
  );

  it.effect("applies reasoningEffort through the reasoning_effort config option", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
        modelSelection: {
          instanceId,
          model: nativeAlternative,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      expect(h.calls).toEqual([
        "start",
        `model:${nativeAlternative}`,
        "config:reasoning_effort=high",
      ]);

      const turn = yield* h.adapter
        .sendTurn({
          threadId,
          input: "Think harder",
          modelSelection: {
            instanceId,
            model: nativeAlternative,
            options: [{ id: "reasoningEffort", value: "ultra" }],
          },
        })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      // Same model, new effort: set_model is skipped, the effort write fires.
      expect(h.calls).toEqual([
        "start",
        `model:${nativeAlternative}`,
        "config:reasoning_effort=high",
        "config:reasoning_effort=ultra",
        "prompt:1",
      ]);
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      yield* Fiber.join(turn);
      expect((yield* h.adapter.listSessions())[0]?.model).toBe(nativeAlternative);
    }),
  );

  it.effect("drops an invalid reasoningEffort instead of forwarding it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
        modelSelection: {
          instanceId,
          model: nativeDefault,
          options: [{ id: "reasoningEffort", value: "bogus value!" }],
        },
      });
      expect(h.calls).toEqual(["start"]);
    }),
  );

  it.effect("resumes a native session through session/resume", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const first = yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
      });
      yield* h.adapter.stopSession(threadId);
      const resumed = yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
        resumeCursor: first.resumeCursor,
      });
      expect(resumed.resumeCursor).toMatchObject({ sessionId: nativeSessionId });
      expect(h.launches.at(-1)?.resumeSessionId).toBe(nativeSessionId);
      expect(h.launches.at(-1)?.resumeMethod).toBe("resume");
    }),
  );

  it.effect("reports auth-required failures through onAuthRequired", () =>
    Effect.gen(function* () {
      const authRequired = yield* Ref.make(false);
      const h = yield* makeHarness({ onAuthRequired: Ref.set(authRequired, true) });
      // The host surfaces missing `muse login` credentials as an internal
      // error whose message carries the authRequired kind.
      h.controls.startError = AcpErrors.AcpRequestError.internalError(
        "muse login required (serve reported authRequired)",
      );
      const started = yield* h.adapter
        .startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(started)).toBe(true);
      expect(yield* Ref.get(authRequired)).toBe(true);
    }),
  );

  it.effect("does not invoke onAuthRequired for a stale-resume failure", () =>
    Effect.gen(function* () {
      const authRequired = yield* Ref.make(false);
      const h = yield* makeHarness({ onAuthRequired: Ref.set(authRequired, true) });
      h.controls.startError = AcpErrors.AcpRequestError.resourceNotFound();
      const started = yield* h.adapter
        .startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "auto",
          resumeCursor: { schemaVersion: 1, sessionId: "stale-session" },
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(started)).toBe(true);
      expect(yield* Ref.get(authRequired)).toBe(false);
    }),
  );

  it.effect("settles a steered turn exactly once after native cancellation drains", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdCancel: true });
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* h.adapter
        .sendTurn({ threadId, input: "First prompt" })
        .pipe(Effect.forkChild);
      yield* h.nextPrompt;
      const marker = h.calls.length;
      const second = yield* h.adapter
        .sendTurn({
          threadId,
          input: "Steer the turn",
          modelSelection: { instanceId, model: nativeAlternative },
        })
        .pipe(Effect.forkChild);
      expect(yield* h.nextCancellation).toBe(1);
      expect(h.calls.slice(marker)).toEqual(["cancel:1"]);
      // The replacement prompt must not reach the bridge before the cancelled
      // prompt resolves.
      yield* Deferred.succeed(h.cancelRelease, undefined);
      const replacement = yield* h.nextPrompt;
      expect(h.calls.slice(marker)).toEqual([
        "cancel:1",
        "drained:1",
        `model:${nativeAlternative}`,
        "prompt:2",
      ]);
      yield* Deferred.succeed(replacement.result, { stopReason: "end_turn" });
      const [oldResult, newResult] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(oldResult.turnId).toBe(newResult.turnId);
      yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(h.seen.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect((yield* h.adapter.listSessions())[0]).toMatchObject({
        status: "ready",
        model: nativeAlternative,
      });
    }),
  );

  it.effect("settles a prompt failure and still allows a later turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter.sendTurn({ threadId, input: "Boom" }).pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      yield* Deferred.fail(prompt.result, AcpErrors.AcpRequestError.internalError("agent crashed"));
      const failed = yield* Fiber.join(sending).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      const ended = yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(ended.payload.state).toBe("failed");
      expect((yield* h.adapter.listSessions())[0]).toMatchObject({
        status: "error",
        activeTurnId: undefined,
      });
      const later = yield* h.adapter
        .sendTurn({ threadId, input: "Try again" })
        .pipe(Effect.forkChild);
      const next = yield* h.nextPrompt;
      yield* Deferred.succeed(next.result, { stopReason: "end_turn" });
      const recovered = yield* Fiber.join(later);
      expect(recovered.turnId).not.toBe(ended.turnId);
      expect((yield* h.adapter.listSessions())[0]?.status).toBe("ready");
    }),
  );

  it.effect("interrupt cancels the active prompt and settles the turn cancelled", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Keep working" })
        .pipe(Effect.forkChild);
      yield* h.nextPrompt;
      yield* h.adapter.interruptTurn(threadId);
      yield* Fiber.join(sending);
      const ended = yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(ended.payload.state).toBe("cancelled");
      expect(h.hasActivePrompt()).toBe(false);
    }),
  );

  it.effect("answers permission requests with the native option id", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Run it" })
        .pipe(Effect.forkChild);
      yield* h.nextPrompt;
      const permission = yield* h
        .invokePermission({
          sessionId: nativeSessionId,
          toolCall: { toolCallId: "call-1", kind: "execute", title: "Run ls" },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        })
        .pipe(Effect.forkChild);
      const opened = yield* h.waitForEvent((event) => event.type === "request.opened");
      expect(opened.payload.options).toEqual([
        { decision: "accept", label: "Allow once" },
        { decision: "acceptForSession", label: "Allow for session" },
        { decision: "decline", label: "Deny" },
        { decision: "cancel", label: "Cancel" },
      ]);
      yield* h.adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(opened.requestId!),
        "acceptForSession",
      );
      // The native option id goes back verbatim — MSP choice ids are opaque.
      expect(yield* Fiber.join(permission)).toEqual({
        outcome: { outcome: "selected", optionId: "allow_session" },
      });
      const resolved = h.seen.find((event) => event.type === "request.resolved");
      expect(resolved).toBeDefined();
      yield* Fiber.interrupt(sending);
    }),
  );

  it.effect("rejects decisions Muse did not offer", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const permission = yield* h
        .invokePermission({
          sessionId: nativeSessionId,
          toolCall: { toolCallId: "call-2", kind: "edit", title: "Edit file" },
          options: [
            { optionId: "approve", name: "Approve", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        })
        .pipe(Effect.forkChild);
      const opened = yield* h.waitForEvent((event) => event.type === "request.opened");
      const invalid = yield* h.adapter
        .respondToRequest(threadId, ApprovalRequestId.make(opened.requestId!), "acceptForSession")
        .pipe(Effect.exit);
      expect(Exit.isFailure(invalid)).toBe(true);
      expect(permission.pollUnsafe()).toBeUndefined();
      yield* h.adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(opened.requestId!),
        "accept",
      );
      expect(yield* Fiber.join(permission)).toEqual({
        outcome: { outcome: "selected", optionId: "approve" },
      });
    }),
  );

  it.effect("auto-approves in full-access using a native allow option", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const result = yield* h.invokePermission({
        sessionId: nativeSessionId,
        toolCall: { toolCallId: "call-3", kind: "execute", title: "Run ls" },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      expect(result).toEqual({
        outcome: { outcome: "selected", optionId: "allow_always" },
      });
      expect(h.seen.some((event) => event.type === "request.opened")).toBe(false);
    }),
  );

  it.effect("remembers acceptForSession for identical repeated operations", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const request: AcpSchema.RequestPermissionRequest = {
        sessionId: nativeSessionId,
        toolCall: {
          toolCallId: "call-4",
          kind: "execute",
          title: "Run ls",
          rawInput: { command: "ls" },
        },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      };
      const first = yield* h.invokePermission(request).pipe(Effect.forkChild);
      const opened = yield* h.waitForEvent((event) => event.type === "request.opened");
      yield* h.adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(opened.requestId!),
        "acceptForSession",
      );
      yield* Fiber.join(first);
      // The identical operation is now remembered — no request.opened again.
      const again = yield* h.invokePermission({
        ...request,
        toolCall: { ...request.toolCall, toolCallId: "call-5" },
      });
      expect(again).toEqual({
        outcome: { outcome: "selected", optionId: "allow_session" },
      });
    }),
  );

  it.effect("bridges elicitation/create into user-input and back", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Set things up" })
        .pipe(Effect.forkChild);
      yield* h.nextPrompt;
      const elicitation = yield* h
        .invokeElicitation({
          sessionId: nativeSessionId,
          mode: "form",
          message: "Scope: Which scope should Muse use?\nNotes: Anything Muse should keep in mind?",
          requestedSchema: {
            type: "object",
            properties: {
              q0: { type: "string", enum: ["Workspace", "Session"] },
              q1: { type: "string" },
            },
            required: ["q0"],
          },
        })
        .pipe(Effect.forkChild);
      const requested = yield* h.waitForEvent((event) => event.type === "user-input.requested");
      expect(requested.payload.questions).toEqual([
        {
          id: "q0",
          header: "Scope",
          question: "Which scope should Muse use?",
          options: [
            { label: "Workspace", description: "Workspace" },
            { label: "Session", description: "Session" },
          ],
          allowCustomAnswer: true,
        },
        {
          id: "q1",
          header: "Notes",
          question: "Anything Muse should keep in mind?",
          options: [],
          allowCustomAnswer: true,
        },
      ]);
      yield* h.adapter.respondToUserInput(threadId, ApprovalRequestId.make(requested.requestId!), {
        q0: "Workspace",
        q1: "remember the tests",
      });
      // Only accept + content reaches the bridge, keyed by schema property.
      expect(yield* Fiber.join(elicitation)).toEqual({
        action: "accept",
        content: { q0: "Workspace", q1: "remember the tests" },
      });
      const resolved = h.seen.find((event) => event.type === "user-input.resolved");
      expect(resolved).toBeDefined();
      yield* Fiber.interrupt(sending);
    }),
  );

  it.effect("answers cancel when user input resolves with no usable answers", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const elicitation = yield* h
        .invokeElicitation({
          sessionId: nativeSessionId,
          mode: "form",
          message: "Pick: Choose one",
          requestedSchema: {
            type: "object",
            properties: { q0: { type: "string", enum: ["A", "B"] } },
          },
        })
        .pipe(Effect.forkChild);
      const requested = yield* h.waitForEvent((event) => event.type === "user-input.requested");
      yield* h.adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(requested.requestId!),
        {},
      );
      // Fail closed: an empty accept would read as an answered form.
      expect(yield* Fiber.join(elicitation)).toEqual({ action: "cancel" });
      const resolved = h.seen.find((event) => event.type === "user-input.resolved");
      expect(resolved).toBeDefined();
    }),
  );

  it.effect("answers cancel for a foreign session id or an empty form", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const foreign = yield* h.invokeElicitation({
        sessionId: "someone-elses-session",
        mode: "form",
        message: "Pick: Choose one",
        requestedSchema: {
          type: "object",
          properties: { q0: { type: "string", enum: ["A", "B"] } },
        },
      });
      expect(foreign).toEqual({ action: "cancel" });
      const empty = yield* h.invokeElicitation({
        sessionId: nativeSessionId,
        mode: "form",
        message: "Nothing to ask",
        requestedSchema: { type: "object", properties: {} },
      });
      expect(empty).toEqual({ action: "cancel" });
      expect(h.seen.some((event) => event.type === "user-input.requested")).toBe(false);
    }),
  );

  it.effect("cancels a pending user-input request when the session is interrupted", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Set things up" })
        .pipe(Effect.forkChild);
      yield* h.nextPrompt;
      const elicitation = yield* h
        .invokeElicitation({
          sessionId: nativeSessionId,
          mode: "form",
          message: "Pick: Choose one",
          requestedSchema: {
            type: "object",
            properties: { q0: { type: "string", enum: ["A", "B"] } },
          },
        })
        .pipe(Effect.forkChild);
      yield* h.waitForEvent((event) => event.type === "user-input.requested");
      yield* h.adapter.interruptTurn(threadId);
      // Interrupt resolves the pending question empty, which fails closed.
      expect(yield* Fiber.join(elicitation)).toEqual({ action: "cancel" });
      yield* Fiber.join(sending);
      const ended = yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(ended.payload.state).toBe("cancelled");
    }),
  );

  it.effect("fails respondToUserInput for an unknown request id", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const responded = yield* h.adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("not-pending"), { q0: "A" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(responded)).toBe(true);
    }),
  );

  it.effect("declares rollback unsupported and fails rollback requests", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      expect(h.adapter.capabilities.supportsConversationRollback).toBe(false);
      const rollback = yield* h.adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
      expect(Exit.isFailure(rollback)).toBe(true);
    }),
  );

  it.effect("stops the session, closes the scope, and reports session.exited", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* h.adapter.stopSession(threadId);
      const exited = yield* h.waitForEvent((event) => event.type === "session.exited");
      expect(exited.payload.exitKind).toBe("graceful");
      expect(h.controls.closed).toBe(1);
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
      const send = yield* h.adapter.sendTurn({ threadId, input: "after stop" }).pipe(Effect.exit);
      expect(Exit.isFailure(send)).toBe(true);
    }),
  );

  it.effect("exits the session with an error when the Muse process terminates", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* h.emitNative({
        _tag: "ConnectionTerminated",
        error: new AcpErrors.AcpTransportError({ detail: "Process exited.", cause: undefined }),
      });
      const exited = yield* h.waitForEvent((event) => event.type === "session.exited");
      expect(exited.payload.exitKind).toBe("error");
      expect(exited.payload.reason).toBe("Muse process stopped.");
      expect(h.controls.closed).toBe(1);
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
      const send = yield* h.adapter.sendTurn({ threadId, input: "after exit" }).pipe(Effect.exit);
      expect(Exit.isFailure(send)).toBe(true);
    }),
  );

  it.effect(
    "runs config-option model/mode selection and elicitation over a real ACP transport",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-muse-transport-",
        });
        const requestLog = path.join(cwd, "requests.ndjson");
        const bridgePath = writeFakeCli({
          directory: path.join(cwd, "bin"),
          name: "muse-acp-bridge",
          source: `await import("${new URL("../../../scripts/acp-mock-agent.ts", import.meta.url).href}");`,
          env: {
            T3_ACP_MUSE: "1",
            T3_ACP_EMIT_MUSE_ELICITATION: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLog,
          },
        });
        const observed: ProviderRuntimeEvent[] = [];
        const asked = yield* Deferred.make<ApprovalRequestId>();
        const completed = yield* Deferred.make<void>();
        const adapter = yield* makeMuseAdapter(
          decodeSettings({ enabled: true, binaryPath: bridgePath }),
          { instanceId },
        );
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              observed.push(event);
              if (event.type === "user-input.requested") {
                yield* Deferred.succeed(asked, ApprovalRequestId.make(event.requestId!));
              }
              if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const session = yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId,
            model: "muse-spark-1.2",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        });
        expect(session.model).toBe("muse-spark-1.2");
        const sending = yield* adapter
          .sendTurn({ threadId, input: "Reply with one short line." })
          .pipe(Effect.forkChild);
        // The bridge's elicitation/create arrives as a T3 user-input request.
        const requestId = yield* Deferred.await(asked);
        const requested = observed.find((event) => event.type === "user-input.requested");
        expect(requested?.payload.questions.map((question) => question.id)).toEqual(["q0", "q1"]);
        yield* adapter.respondToUserInput(threadId, requestId, {
          q0: "Workspace",
          q1: "keep it short",
        });
        yield* Fiber.join(sending);
        yield* Deferred.await(completed);
        // The agent echoes the elicitation result it got back over the wire.
        const deltas = observed
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta)
          .join("");
        expect(deltas).toContain('"action":"accept"');
        expect(deltas).toContain('"q0":"Workspace"');
        expect(deltas).toContain('"q1":"keep it short"');
        const lines = (yield* fileSystem.readFileString(requestLog)).trim().split("\n");
        const requests = yield* decodeRequestLog(lines);
        // Everything lands on session/set_config_option: Muse has no
        // session/set_mode, session/set_model, or ACP authenticate.
        const configWrites = requests
          .filter((request) => request.method === "session/set_config_option")
          .map((request) => request.params);
        expect(configWrites).toContainEqual({
          sessionId: "mock-session-1",
          configId: "model",
          value: "muse-spark-1.2",
        });
        expect(configWrites).toContainEqual({
          sessionId: "mock-session-1",
          configId: "reasoning_effort",
          value: "high",
        });
        expect(configWrites).toContainEqual({
          sessionId: "mock-session-1",
          configId: "mode",
          value: "yolo",
        });
        expect(requests.some((request) => request.method === "session/set_mode")).toBe(false);
        expect(requests.some((request) => request.method === "session/set_model")).toBe(false);
        expect(requests.some((request) => request.method === "authenticate")).toBe(false);
        // Session resume carries the Muse session id back over the wire.
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "auto",
          resumeCursor: session.resumeCursor,
        });
        const laterLines = (yield* fileSystem.readFileString(requestLog)).trim().split("\n");
        const allRequests = yield* decodeRequestLog(laterLines);
        expect(allRequests.some((request) => request.method === "session/resume")).toBe(true);
      }),
  );
});

describe("selectMusePermissionOptionId", () => {
  const request = (
    options: ReadonlyArray<AcpSchema.PermissionOption>,
  ): AcpSchema.RequestPermissionRequest => ({
    sessionId: "s",
    toolCall: { toolCallId: "t", kind: "execute", title: "Run" },
    options,
  });

  it("prefers allow_always for session-level approvals and keeps the native id", () => {
    const req = request([
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_session", name: "Session", kind: "allow_always" },
      { optionId: "allow_always", name: "Always", kind: "allow_always" },
    ]);
    expect(selectMusePermissionOptionId(req, "accept")).toBe("allow_once");
    expect(selectMusePermissionOptionId(req, "acceptForSession")).toBe("allow_session");
    expect(selectMusePermissionOptionId(req, "acceptAlways")).toBe("allow_session");
  });

  it("does not narrow a session approval to allow_once when none was offered", () => {
    const req = request([
      { optionId: "approve", name: "Approve", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ]);
    expect(selectMusePermissionOptionId(req, "acceptForSession")).toBeUndefined();
    expect(selectMusePermissionOptionId(req, "decline")).toBe("deny");
  });

  it("returns undefined when the decision has no matching native option", () => {
    const req = request([{ optionId: "deny", name: "Deny", kind: "reject_once" }]);
    expect(selectMusePermissionOptionId(req, "accept")).toBeUndefined();
    expect(selectMusePermissionOptionId(req, "acceptForSession")).toBeUndefined();
  });
});

describe("museApprovalOptions", () => {
  it("only advertises decisions the native request can honor", () => {
    const full: AcpSchema.RequestPermissionRequest = {
      sessionId: "s",
      toolCall: { toolCallId: "t", kind: "execute", title: "Run" },
      options: [
        { optionId: "a", name: "Allow once", kind: "allow_once" },
        { optionId: "b", name: "Always", kind: "allow_always" },
        { optionId: "c", name: "Deny", kind: "reject_once" },
      ],
    };
    expect(museApprovalOptions(full)).toEqual([
      { decision: "accept", label: "Allow once" },
      { decision: "acceptForSession", label: "Always" },
      { decision: "decline", label: "Deny" },
      { decision: "cancel", label: "Cancel" },
    ]);

    const rejectOnly: AcpSchema.RequestPermissionRequest = {
      sessionId: "s",
      toolCall: { toolCallId: "t", kind: "execute", title: "Run" },
      options: [{ optionId: "c", name: "Deny", kind: "reject_always" }],
    };
    expect(museApprovalOptions(rejectOnly)).toEqual([
      { decision: "decline", label: "Deny" },
      { decision: "cancel", label: "Cancel" },
    ]);
  });
});
