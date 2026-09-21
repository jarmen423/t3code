import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  DevinSettings,
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
  devinApprovalOptions,
  makeDevinAdapter,
  selectDevinPermissionOptionId,
  type DevinAdapterOptions,
} from "./DevinAdapter.ts";

const instanceId = ProviderInstanceId.make("devin-test");
const threadId = ThreadId.make("devin-thread");
const nativeSessionId = "devin-session-1";
const nativeDefault = "swe-1.5";
const nativeAlternative = "claude-sonnet-4-6-high";
const decodeSettings = Schema.decodeSync(DevinSettings);
const decodeRequestLog = Schema.decodeEffect(
  Schema.Array(
    Schema.fromJsonString(
      Schema.Struct({ method: Schema.String, params: Schema.optional(Schema.Unknown) }),
    ),
  ),
);

const nativeModes = [
  { id: "accept-edits", name: "Code" },
  { id: "smart", name: "Smart" },
  { id: "ask", name: "Ask" },
  { id: "plan", name: "Plan" },
  { id: "bypass", name: "Bypass" },
];

const devinConfigOptions = (
  currentModelId: string,
  currentModeId = "accept-edits",
): ReadonlyArray<AcpSchema.SessionConfigOption> => [
  {
    type: "select",
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: currentModeId,
    options: nativeModes.map((mode) => ({ value: mode.id, name: mode.name })),
  },
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: currentModelId,
    options: [
      { name: "SWE 1.5", value: "swe-1.5" },
      { name: "SWE 1.5 High", value: "swe-1.5-high" },
      { name: "Claude Sonnet 4.6 High", value: "claude-sonnet-4-6-high" },
      { name: "GPT 5.4 High", value: "gpt-5.4-high" },
      { name: "Fusion Sonnet", value: "fusion-sonnet" },
    ],
  },
];

interface NativePrompt {
  readonly index: number;
  readonly content: ReadonlyArray<AcpSchema.ContentBlock>;
  readonly result: Deferred.Deferred<AcpSchema.PromptResponse, AcpErrors.AcpError>;
}

type Runtime = Effect.Success<ReturnType<NonNullable<DevinAdapterOptions["makeRuntime"]>>>;

const makeHarness = Effect.fn("makeDevinAdapterHarness")(function* (options?: {
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
  const launches: Array<Parameters<NonNullable<DevinAdapterOptions["makeRuntime"]>>[0]> = [];
  const controls = {
    closed: 0,
    startError: undefined as AcpErrors.AcpError | undefined,
    promptError: undefined as AcpErrors.AcpError | undefined,
  };
  let promptIndex = 0;
  let active: NativePrompt | undefined;
  // The stub mirrors the real runtime's dedup: setModel/setMode update the
  // tracked currentValue so repeat selections do not send again.
  const configOptionsRef = yield* Ref.make<ReadonlyArray<AcpSchema.SessionConfigOption>>(
    devinConfigOptions(nativeDefault),
  );
  const setCurrentValue = (configId: string, value: string) =>
    Ref.update(configOptionsRef, (options) =>
      options.map((option) =>
        option.id === configId && option.type === "select"
          ? { ...option, currentValue: value }
          : option,
      ),
    );
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
        authMethods: [{ id: "devin-browser", name: "Log in with browser", description: null }],
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
            { name: "plan", description: "Plan mode" },
            { name: "compact", description: "Compact the session" },
          ],
          rawPayload: {},
        });
        return {
          sessionId: nativeSessionId,
          initializeResult: {
            protocolVersion: 1,
            agentInfo: { name: "affogato", title: "Devin Agent", version: "0.0.0-dev" },
            agentCapabilities: { loadSession: true },
            authMethods: [{ id: "devin-browser", name: "Log in with browser", description: null }],
          } satisfies AcpSchema.InitializeResponse,
          sessionSetupResult: {
            sessionId: nativeSessionId,
            configOptions: yield* Ref.get(configOptionsRef),
          } satisfies AcpSchema.NewSessionResponse,
          modelConfigId: "model",
        };
      }),
    getEvents: () => Stream.fromQueue(runtimeEvents),
    drainEvents,
    getModeState: Effect.void,
    getConfigOptions: Ref.get(configOptionsRef).pipe(Effect.map((options) => options)),
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
        const options = yield* Ref.get(configOptionsRef);
        const current = options.find((option) => option.id === "mode");
        if (current?.type === "select" && current.currentValue === modeId) return {};
        calls.push(`mode:${modeId}`);
        yield* setCurrentValue("mode", modeId);
        return {};
      }),
    setConfigOption: (configId: string, value: string | boolean) =>
      Effect.gen(function* () {
        const options = yield* Ref.get(configOptionsRef);
        const current = options.find((option) => option.id === configId);
        if (current?.type === "select" && current.currentValue === value) {
          return { configOptions: options };
        }
        calls.push(`config:${configId}=${String(value)}`);
        if (typeof value === "string") yield* setCurrentValue(configId, value);
        return { configOptions: yield* Ref.get(configOptionsRef) };
      }),
    setModel: (model: string) =>
      Effect.gen(function* () {
        const options = yield* Ref.get(configOptionsRef);
        const current = options.find((option) => option.id === "model");
        if (current?.type === "select" && current.currentValue === model) return;
        calls.push(`model:${model}`);
        yield* setCurrentValue("model", model);
      }),
    setSessionModel: () => Effect.succeed({}),
    request: () => Effect.succeed({}),
    notify: () => Effect.void,
  } as unknown as Runtime;

  const adapter = yield* makeDevinAdapter(decodeSettings({ enabled: options?.enabled ?? true }), {
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
  const waitForEvent = Effect.fn("DevinAdapterTest.waitForEvent")(function* <
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
    launches,
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
  prefix: "t3-devin-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("DevinAdapter", (it) => {
  it.effect("starts a session, applies model and mode natively, and streams a turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const session = yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
        modelSelection: { instanceId, model: nativeAlternative },
      });
      expect(session.model).toBe(nativeAlternative);
      // Model goes through the `model` config option (setModel), mode through
      // the `mode` config option (setMode).
      expect(h.calls).toEqual(["start", `model:${nativeAlternative}`, "mode:smart"]);
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

  it.effect(
    "runs config-option model/mode changes and session/load resume over a real ACP transport",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-devin-transport-",
        });
        const requestLog = path.join(cwd, "requests.ndjson");
        const devinPath = writeFakeCli({
          directory: path.join(cwd, "bin"),
          name: "devin",
          source: `await import("${new URL("../../../scripts/acp-mock-agent.ts", import.meta.url).href}");`,
          env: { T3_ACP_DEVIN: "1", T3_ACP_REQUEST_LOG_PATH: requestLog },
        });
        const observed: ProviderRuntimeEvent[] = [];
        const completed = yield* Deferred.make<void>();
        const adapter = yield* makeDevinAdapter(
          decodeSettings({ enabled: true, binaryPath: devinPath }),
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
          runtimeMode: "auto",
          modelSelection: { instanceId, model: "claude-sonnet-4-6-high" },
        });
        expect(session.model).toBe("claude-sonnet-4-6-high");
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
        // T3 never drives the browser auth method.
        expect(requests.some((request) => request.method === "authenticate")).toBe(false);
        // Model and mode both go through session/set_config_option — Devin has
        // no session/set_model or session/set_mode path.
        const configRequests = requests
          .filter((request) => request.method === "session/set_config_option")
          .map((request) => request.params);
        expect(configRequests).toContainEqual({
          sessionId: "mock-session-1",
          configId: "model",
          value: "claude-sonnet-4-6-high",
        });
        expect(configRequests).toContainEqual({
          sessionId: "mock-session-1",
          configId: "mode",
          value: "smart",
        });
        expect(requests.some((request) => request.method === "session/set_model")).toBe(false);
        expect(requests.some((request) => request.method === "session/set_mode")).toBe(false);
        // Resume carries the Devin session id back through session/load.
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "auto",
          resumeCursor: session.resumeCursor,
        });
        const laterLines = (yield* fileSystem.readFileString(requestLog)).trim().split("\n");
        const allRequests = yield* decodeRequestLog(laterLines);
        expect(
          allRequests
            .filter((request) => request.method === "session/load")
            .map((request) => request.params),
        ).toContainEqual(
          expect.objectContaining({
            sessionId: "mock-session-1",
          }),
        );
      }),
  );

  it.effect("keeps the product slug on session.model and never sends it to Devin", () =>
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
        threadId: ThreadId.make("devin-thread-native"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: nativeAlternative },
      });
      expect(native.model).toBe(nativeAlternative);
      expect(h.calls).toEqual(["start", "start", `model:${nativeAlternative}`]);
    }),
  );

  it.effect("resumes a native session through session/load", () =>
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
      expect(h.launches[1]?.resumeMethod).toBe("load");
    }),
  );

  it.effect("invokes onAuthRequired when a prompt fails with the -32000 auth code", () =>
    Effect.gen(function* () {
      const authRequired = yield* Ref.make(false);
      const h = yield* makeHarness({ onAuthRequired: Ref.set(authRequired, true) });
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Do work" })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      // Devin answers session/prompt with -32000 "Please log in to use
      // Devin." when signed out — session/new itself succeeds logged out.
      yield* Deferred.fail(
        prompt.result,
        new AcpErrors.AcpRequestError({
          code: -32000,
          errorMessage: "Please log in to use Devin.",
        }),
      );
      const failed = yield* Fiber.join(sending).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* Ref.get(authRequired)).toBe(true);
    }),
  );

  it.effect("invokes onAuthRequired when start fails with an auth-coded error", () =>
    Effect.gen(function* () {
      const authRequired = yield* Ref.make(false);
      const h = yield* makeHarness({ onAuthRequired: Ref.set(authRequired, true) });
      h.controls.startError = new AcpErrors.AcpRequestError({
        code: -32000,
        errorMessage: "Please log in to use Devin.",
      });
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
      // session/load answers -32016/-32002 for a stale session id; that is a
      // dead cursor, not missing credentials.
      h.controls.startError = new AcpErrors.AcpRequestError({
        code: -32016,
        errorMessage: "Session not found.",
      });
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
      // The replacement prompt must not reach Devin before the cancelled
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

  it.effect("switches the session into plan mode for a plan interaction turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
      });
      // runtimeMode "auto" already applied "smart" at start.
      expect(h.calls).toEqual(["start", "mode:smart"]);
      const turn = yield* h.adapter
        .sendTurn({ threadId, input: "Sketch a plan", interactionMode: "plan" })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      expect(h.calls).toContain("mode:plan");
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      yield* Fiber.join(turn);
      // An explicit "default" restores the permission mode for the runtime mode.
      const restore = yield* h.adapter
        .sendTurn({ threadId, input: "Build it", interactionMode: "default" })
        .pipe(Effect.forkChild);
      const second = yield* h.nextPrompt;
      expect(h.calls.filter((call) => call === "mode:smart")).toHaveLength(2);
      yield* Deferred.succeed(second.result, { stopReason: "end_turn" });
      yield* Fiber.join(restore);
      // No interactionMode leaves the mode untouched.
      const plain = yield* h.adapter
        .sendTurn({ threadId, input: "Keep going" })
        .pipe(Effect.forkChild);
      const third = yield* h.nextPrompt;
      // Total stays at smart/plan/smart — no new mode request went out.
      expect(h.calls.filter((call) => call.startsWith("mode:"))).toHaveLength(3);
      yield* Deferred.succeed(third.result, { stopReason: "end_turn" });
      yield* Fiber.join(plain);
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
      const first = yield* h.adapter
        .sendTurn({ threadId, input: "First prompt" })
        .pipe(Effect.forkChild);
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

  it.effect("rejects decisions Devin did not offer", () =>
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

  it.effect("declares /compact compaction, unsupported rollback, and fails rollback", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      expect(h.adapter.compaction).toEqual({ type: "slash-command", command: "/compact" });
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

  it.effect("exits the session with an error when the Devin process terminates", () =>
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
      expect(exited.payload.reason).toBe("Devin process stopped.");
      expect(h.controls.closed).toBe(1);
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
      const send = yield* h.adapter.sendTurn({ threadId, input: "after exit" }).pipe(Effect.exit);
      expect(Exit.isFailure(send)).toBe(true);
    }),
  );
});

describe("selectDevinPermissionOptionId", () => {
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
    expect(selectDevinPermissionOptionId(req, "accept")).toBe("allow_once");
    expect(selectDevinPermissionOptionId(req, "acceptForSession")).toBe("allow_session");
    expect(selectDevinPermissionOptionId(req, "acceptAlways")).toBe("allow_session");
  });

  it("does not narrow a session approval to allow_once when none was offered", () => {
    const req = request([
      { optionId: "approve", name: "Approve", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ]);
    expect(selectDevinPermissionOptionId(req, "acceptForSession")).toBeUndefined();
    expect(selectDevinPermissionOptionId(req, "decline")).toBe("deny");
  });

  it("returns undefined when the decision was not offered", () => {
    const req = request([{ optionId: "deny", name: "Deny", kind: "reject_once" }]);
    expect(selectDevinPermissionOptionId(req, "accept")).toBeUndefined();
    expect(devinApprovalOptions(req).map((option) => option.decision)).toEqual([
      "decline",
      "cancel",
    ]);
  });
});
