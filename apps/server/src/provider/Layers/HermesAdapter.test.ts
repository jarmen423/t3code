import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  HermesSettings,
  ProviderInstanceId,
  ThreadId,
  TurnId,
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
import {
  hermesApprovalOptions,
  makeHermesAdapter,
  selectHermesPermissionOptionId,
  type HermesAdapterOptions,
} from "./HermesAdapter.ts";

const instanceId = ProviderInstanceId.make("hermes-test");
const threadId = ThreadId.make("hermes-thread");
const nativeSessionId = "hermes-session-1";
const nativeDefault = "openrouter:model-a";
const nativeAlternative = "xai-oauth:grok-4";
const decodeSettings = Schema.decodeSync(HermesSettings);
const decodeRequestLog = Schema.decodeEffect(
  Schema.Array(
    Schema.fromJsonString(
      Schema.Struct({ method: Schema.String, params: Schema.optional(Schema.Unknown) }),
    ),
  ),
);

const nativeModes = [
  { id: "default", name: "Default" },
  { id: "accept_edits", name: "Accept edits" },
  { id: "dont_ask", name: "Don't ask" },
];

interface NativePrompt {
  readonly index: number;
  readonly content: ReadonlyArray<AcpSchema.ContentBlock>;
  readonly result: Deferred.Deferred<AcpSchema.PromptResponse, AcpErrors.AcpError>;
}

type Runtime = Effect.Success<ReturnType<NonNullable<HermesAdapterOptions["makeRuntime"]>>>;

const makeHarness = Effect.fn("makeHermesAdapterHarness")(function* (options?: {
  readonly enabled?: boolean;
  readonly holdCancel?: boolean;
  readonly authMethods?: ReadonlyArray<AcpSchema.AuthMethod>;
  readonly onAuthRequired?: Effect.Effect<void>;
}) {
  const runtimeEvents = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
  const canonicalEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const prompts = yield* Queue.unbounded<NativePrompt>();
  const cancellations = yield* Queue.unbounded<number>();
  const cancelRelease = yield* Deferred.make<void>();
  const seen: ProviderRuntimeEvent[] = [];
  const calls: string[] = [];
  const modelMetas: Array<AcpSchema.SetSessionModelRequest["_meta"] | undefined> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const launches: Array<Parameters<NonNullable<HermesAdapterOptions["makeRuntime"]>>[0]> = [];
  const controls = {
    failModel: false,
    closed: 0,
    startError: undefined as AcpErrors.AcpError | undefined,
  };
  let promptIndex = 0;
  let active: NativePrompt | undefined;
  const modeState = yield* Ref.make({
    currentModeId: "default",
    availableModes: nativeModes,
  });
  let permissionHandler:
    | ((
        request: AcpSchema.RequestPermissionRequest,
      ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpErrors.AcpError>)
    | undefined;

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
    handleExtRequest: stubHandler,
    handleExtNotification: stubHandler,
    initialize: () =>
      Effect.succeed({
        protocolVersion: 1,
        authMethods: options?.authMethods ?? [
          { id: "openrouter", name: "OpenRouter", description: null },
          { type: "terminal", id: "hermes-setup", name: "Hermes setup", description: null },
        ],
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
            { name: "compress", description: "Compact the conversation" },
          ],
          rawPayload: {},
        });
        return {
          sessionId: nativeSessionId,
          initializeResult: {
            protocolVersion: 1,
            agentInfo: { name: "hermes", version: "0.21.1" },
            agentCapabilities: { sessionCapabilities: { resume: {} } },
            authMethods: options?.authMethods ?? [
              { id: "openrouter", name: "OpenRouter", description: null },
              {
                type: "terminal",
                id: "hermes-setup",
                name: "Hermes setup",
                description: null,
              },
            ],
          } satisfies AcpSchema.InitializeResponse,
          sessionSetupResult: {
            sessionId: nativeSessionId,
            modes: { currentModeId: "default", availableModes: nativeModes },
            models: {
              currentModelId: nativeDefault,
              availableModels: [
                { modelId: nativeDefault, name: "Model A" },
                { modelId: nativeAlternative, name: "Grok 4" },
              ],
            },
          } satisfies AcpSchema.NewSessionResponse,
          modelConfigId: undefined,
        };
      }),
    getEvents: () => Stream.fromQueue(runtimeEvents),
    drainEvents,
    getModeState: Ref.get(modeState).pipe(Effect.map((state) => state)),
    getConfigOptions: Effect.succeed([]),
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
    setMode: () => Effect.succeed({}),
    setConfigOption: () => Effect.succeed({ configOptions: [] }),
    setModel: () => Effect.void,
    setSessionModel: (model: string, meta?: AcpSchema.SetSessionModelRequest["_meta"]) =>
      Effect.gen(function* () {
        calls.push(`model:${model}`);
        modelMetas.push(meta);
        if (controls.failModel) {
          controls.failModel = false;
          return yield* AcpErrors.AcpRequestError.invalidParams("Unknown model");
        }
        return {};
      }),
    request: (method: string, params: unknown) =>
      Effect.gen(function* () {
        requests.push({ method, params });
        if (method === "session/set_mode") {
          const modeId = (params as { modeId: string }).modeId;
          yield* Ref.update(modeState, (state) => ({ ...state, currentModeId: modeId }));
          calls.push(`mode:${modeId}`);
        }
        return {};
      }),
    notify: () => Effect.void,
  } as unknown as Runtime;

  const adapter = yield* makeHermesAdapter(decodeSettings({ enabled: options?.enabled ?? true }), {
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
  const waitForEvent = Effect.fn("HermesAdapterTest.waitForEvent")(function* <
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
  return {
    adapter,
    calls,
    modelMetas,
    launches,
    requests,
    controls,
    seen,
    waitForEvent,
    emitNative,
    invokePermission,
    cancelRelease,
    nextPrompt: Queue.take(prompts),
    nextCancellation: Queue.take(cancellations),
    drainEvents,
    hasActivePrompt: () => active !== undefined,
  };
});

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("HermesAdapter", (it) => {
  it.effect("starts a session, applies model and mode natively, and streams a turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const session = yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto-accept-edits",
        modelSelection: { instanceId, model: nativeAlternative },
      });
      expect(session.model).toBe(nativeAlternative);
      expect(h.calls).toEqual(["start", `model:${nativeAlternative}`, "mode:accept_edits"]);
      // Mode goes through raw session/set_mode, never set_config_option.
      expect(h.requests).toContainEqual({
        method: "session/set_mode",
        params: { sessionId: nativeSessionId, modeId: "accept_edits" },
      });
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

  it.effect("runs advertise-driven auth, native modes, and models over a real ACP transport", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-hermes-transport-",
      });
      const requestLog = path.join(cwd, "requests.ndjson");
      const hermesPath = writeFakeCli({
        directory: path.join(cwd, "bin"),
        name: "hermes",
        source: `await import("${new URL("../../../scripts/acp-mock-agent.ts", import.meta.url).href}");`,
        env: { T3_ACP_HERMES: "1", T3_ACP_REQUEST_LOG_PATH: requestLog },
      });
      const observed: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const adapter = yield* makeHermesAdapter(
        decodeSettings({ enabled: true, binaryPath: hermesPath }),
        { instanceId },
      );
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            observed.push(event);
            if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const session = yield* adapter.startSession({
        threadId,
        cwd,
        runtimeMode: "auto-accept-edits",
        modelSelection: { instanceId, model: "xai-oauth:mock-beta" },
      });
      expect(session.model).toBe("xai-oauth:mock-beta");
      yield* adapter.sendTurn({ threadId, input: "Reply with one short line." });
      yield* Deferred.await(completed);
      expect(
        observed
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta)
          .join(""),
      ).toBe("hello from mock");
      const lines = (yield* fileSystem.readFileString(requestLog)).trim().split("\n");
      const requests = yield* decodeRequestLog(lines);
      // The provider method resolved from initialize, never hermes-setup.
      expect(
        requests
          .filter((request) => request.method === "authenticate")
          .map((request) => request.params),
      ).toEqual([{ methodId: "openrouter" }]);
      // Native model + raw session/set_mode, never set_config_option.
      expect(
        requests
          .filter((request) => request.method === "session/set_model")
          .map((request) => request.params),
      ).toEqual([{ sessionId: "mock-session-1", modelId: "xai-oauth:mock-beta" }]);
      expect(
        requests
          .filter((request) => request.method === "session/set_mode")
          .map((request) => request.params),
      ).toContainEqual({ sessionId: "mock-session-1", modeId: "accept_edits" });
      expect(requests.some((request) => request.method === "session/set_config_option")).toBe(
        false,
      );
      // Session resume carries the Hermes session id back over the wire.
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

  it.effect("keeps the product slug on session.model and sends only native ids to set_model", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const session = yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "default" },
      });
      // The picker's slug stays on session.model; it never reaches the wire.
      expect(session.model).toBe("default");
      expect(h.calls).toEqual(["start"]);

      const native = yield* h.adapter.startSession({
        threadId: ThreadId.make("hermes-thread-native"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: nativeAlternative },
      });
      expect(native.model).toBe(nativeAlternative);
      expect(h.calls).toEqual(["start", "start", `model:${nativeAlternative}`]);
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
      expect(h.launches[1]?.resumeSessionId).toBe(nativeSessionId);
      expect(h.launches[1]?.resumeMethod).toBe("resume");
    }),
  );

  it.effect("invokes onAuthRequired when start fails with the -32000 auth code", () =>
    Effect.gen(function* () {
      const authRequired = yield* Ref.make(false);
      const h = yield* makeHarness({ onAuthRequired: Ref.set(authRequired, true) });
      h.controls.startError = AcpErrors.AcpRequestError.authRequired();
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

  it.effect("does not invoke onAuthRequired for a -32002 stale-resume failure", () =>
    Effect.gen(function* () {
      const authRequired = yield* Ref.make(false);
      const h = yield* makeHarness({ onAuthRequired: Ref.set(authRequired, true) });
      // session/resume answers -32002 for a stale session id; that is a dead
      // cursor, not missing credentials.
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
      // The replacement prompt must not reach Hermes before the cancelled
      // prompt resolves — Hermes would queue it beyond stop's reach.
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

  it.effect("sends reasoningEffort meta at start and on a mid-turn switch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto-accept-edits",
        modelSelection: {
          instanceId,
          model: nativeAlternative,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      expect(h.calls).toEqual(["start", `model:${nativeAlternative}`, "mode:accept_edits"]);
      expect(h.modelMetas).toEqual([{ reasoningEffort: "high" }]);

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
      // Same model, new effort: set_model still fires to carry the meta;
      // set_mode is skipped because the runtime mode is already applied.
      expect(h.calls.slice(0, 5)).toEqual([
        "start",
        `model:${nativeAlternative}`,
        "mode:accept_edits",
        `model:${nativeAlternative}`,
        "prompt:1",
      ]);
      expect(h.modelMetas).toEqual([{ reasoningEffort: "high" }, { reasoningEffort: "ultra" }]);
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      yield* Fiber.join(turn);
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

  it.effect("ignores an interrupt for a stale turn id and cancels the matching turn", () =>
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
      const started = yield* h.waitForEvent((event) => event.type === "turn.started");
      const activeTurnId = started.turnId;
      expect(activeTurnId).toBeDefined();
      // A stale turn id must not bump the stop epoch or send session/cancel.
      yield* h.adapter.interruptTurn(threadId, TurnId.make("some-other-turn"));
      expect(h.calls.some((call) => call.startsWith("cancel:"))).toBe(false);
      expect(h.hasActivePrompt()).toBe(true);
      yield* h.adapter.interruptTurn(threadId, activeTurnId);
      yield* Fiber.join(sending);
      const ended = yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(ended.turnId).toBe(activeTurnId);
      expect(ended.payload.state).toBe("cancelled");
      expect(h.calls).toContain("cancel:1");
    }),
  );

  it.effect("drops a steer that was still waiting on the prompt lock when stop hit", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdCancel: true });
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* h.adapter.sendTurn({ threadId, input: "First" }).pipe(Effect.forkChild);
      yield* h.nextPrompt;
      // steerA takes promptLock and parks inside the held cancel; steerB
      // queues on the lock; stop then lands between them.
      const steerA = yield* h.adapter
        .sendTurn({ threadId, input: "Steer A" })
        .pipe(Effect.forkChild);
      yield* h.nextCancellation;
      const steerB = yield* h.adapter
        .sendTurn({ threadId, input: "Steer B" })
        .pipe(Effect.forkChild);
      const interrupting = yield* h.adapter.interruptTurn(threadId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(h.cancelRelease, undefined);
      yield* Fiber.join(interrupting);
      // steerB saw the bumped stop epoch inside the lock and never prompted.
      expect(Exit.isFailure(yield* Fiber.join(steerB).pipe(Effect.exit))).toBe(true);
      // steerA's replacement prompt went out, then interrupt cancelled it.
      const replacement = yield* h.nextPrompt;
      yield* Deferred.await(replacement.result);
      yield* Fiber.join(steerA);
      yield* Fiber.join(first);
      expect(h.calls.filter((call) => call.startsWith("prompt:"))).toEqual([
        "prompt:1",
        "prompt:2",
      ]);
      yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(h.seen.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    }),
  );

  it.effect("cancels the native prompt if its send caller is interrupted", () =>
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
      yield* Fiber.interrupt(sending);
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
      // The native option id goes back verbatim — allow_session is not
      // collapsed onto allow_always.
      expect(yield* Fiber.join(permission)).toEqual({
        outcome: { outcome: "selected", optionId: "allow_session" },
      });
      const resolved = h.seen.find((event) => event.type === "request.resolved");
      expect(resolved).toBeDefined();
      yield* Fiber.interrupt(sending);
    }),
  );

  it.effect("rejects decisions Hermes did not offer", () =>
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

  it.effect("exits the session with an error when the Hermes process terminates", () =>
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
      expect(exited.payload.reason).toBe("Hermes process stopped.");
      expect(h.controls.closed).toBe(1);
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
      const send = yield* h.adapter.sendTurn({ threadId, input: "after exit" }).pipe(Effect.exit);
      expect(Exit.isFailure(send)).toBe(true);
    }),
  );
});

describe("selectHermesPermissionOptionId", () => {
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
    expect(selectHermesPermissionOptionId(req, "accept")).toBe("allow_once");
    expect(selectHermesPermissionOptionId(req, "acceptForSession")).toBe("allow_session");
    expect(selectHermesPermissionOptionId(req, "acceptAlways")).toBe("allow_session");
  });

  it("does not narrow a session approval to allow_once when none was offered", () => {
    const req = request([
      { optionId: "approve", name: "Approve", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ]);
    expect(selectHermesPermissionOptionId(req, "acceptForSession")).toBeUndefined();
    expect(selectHermesPermissionOptionId(req, "decline")).toBe("deny");
  });

  it("returns undefined when the decision maps to no advertised kind", () => {
    const req = request([{ optionId: "deny", name: "Deny", kind: "reject_once" }]);
    expect(selectHermesPermissionOptionId(req, "accept")).toBeUndefined();
  });
});

describe("hermesApprovalOptions", () => {
  it("exposes only the decisions the native request can honor", () => {
    const options = hermesApprovalOptions({
      sessionId: "s",
      toolCall: { toolCallId: "t", kind: "execute", title: "Run" },
      options: [
        { optionId: "allow_once", name: "Approve once", kind: "allow_once" },
        { optionId: "deny", name: "Nope", kind: "reject_once" },
      ],
    });
    expect(options.map((option) => option.decision)).toEqual(["accept", "decline", "cancel"]);
  });
});
