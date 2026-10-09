import { HostProcessPlatform, HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DevinSettings,
  HermesSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { layerTest } from "../../config.ts";
import {
  ProviderEventLoggers,
  NoOpProviderEventLoggers,
} from "../../provider/ProviderEventLoggers.ts";
import { layer as idAllocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { makeForkAcpAdapterV2, makeForkAcpFlavor } from "./ForkAcpAdapterV2.ts";
import { MessageId, NodeId, ProjectId, RunAttemptId, RunId } from "@t3tools/contracts";

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly instanceId: ProviderInstanceId;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
  readonly ordinal?: number;
  readonly modelSelection?: ModelSelection;
  /** agent+provider marks a post-settle continuation attach (drains wakeBuffer). */
  readonly messageCreatedBy?: "user" | "agent";
  readonly messageCreationSource?: "web" | "mobile" | "mcp" | "provider" | "server";
  readonly messageText?: string;
}): ProviderAdapterV2TurnInput {
  const ordinal = input.ordinal ?? 1;
  const suffix = `${input.threadId}:${ordinal}`;
  const modelSelection =
    input.modelSelection ?? ({ instanceId: input.instanceId, model: "default" } as const);
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "ACP adapter test",
      providerInstanceId: input.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: input.messageText ?? "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
}

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  layerTest(process.cwd(), { prefix: "t3-fork-acp-v2-" }).pipe(Layer.provide(NodeServices.layer)),
  Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
);
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      params: Schema.optionalKey(
        Schema.Struct({
          configId: Schema.optionalKey(Schema.String),
          value: Schema.optionalKey(Schema.Union([Schema.String, Schema.Boolean])),
        }),
      ),
    }),
  ),
);
const decodeHermesSettings = Schema.decodeSync(HermesSettings);
const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const settingsFor = (driver: "hermes" | "devin", binaryPath = "") => {
  switch (driver) {
    case "hermes":
      return { driver, settings: decodeHermesSettings({ binaryPath }) };
    case "devin":
      return { driver, settings: decodeDevinSettings({ binaryPath }) };
  }
};

describe("fork ACP providers on orchestration v2", () => {
  it("keeps Hermes child outcomes and ownership isolated between sessions", () => {
    const flavor = () => makeForkAcpFlavor(settingsFor("hermes"), () => Effect.die("unused"));
    const first = flavor();
    const second = flavor();
    const tool = {
      toolCallId: "delegate-1",
      status: "pending" as const,
      data: {
        rawInput: { toolName: "delegate_task", tasks: [{ goal: "Review" }, { goal: "Test" }] },
      },
    };
    expect(first.extractSubagentUpdates?.(tool, "turn-1")).toHaveLength(2);
    expect(second.extractSubagentUpdates?.(tool, "turn-1")).toHaveLength(2);
    expect(
      first.extractSubagentUpdates?.(
        {
          ...tool,
          status: "inProgress",
          data: {
            ...tool.data,
            rawOutput: {
              toolName: "delegate_task",
              taskProgress: {
                sequence: 1,
                taskIndex: 1,
                type: "completed",
                status: "completed",
                summary: "Tests passed",
              },
            },
          },
        },
        "turn-1",
      ),
    ).toMatchObject([
      { nativeTaskId: "hermes:delegate-1:1", status: "completed", result: "Tests passed" },
    ]);
    expect(first.settleSubagents?.("turn-1")).toMatchObject([
      { nativeTaskId: "hermes:delegate-1:0", status: "interrupted" },
    ]);
    expect(first.extractSubagentUpdates?.(tool, "turn-2")).toEqual([]);
    expect(second.settleSubagents?.("turn-1")).toHaveLength(2);
  });
});

describe("fork ACP transports", () => {
  it.live.each(["hermes", "devin"] as const)(
    "%s completes a real ACP turn through the shared adapter",
    (driver) =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
        const executable = yield* HostProcessExecutablePath;
        const fs = yield* FileSystem.FileSystem;
        const workspace = yield* fs.makeTempDirectoryScoped();
        const script = `${workspace}/mock-agent`;
        const mockPath = new URL("../../../scripts/acp-mock-agent.ts", import.meta.url).pathname;
        yield* fs.writeFileString(script, `#!/bin/sh\nexec '${executable}' '${mockPath}'\n`);
        yield* fs.chmod(script, 0o755);
        const requestLog = `${workspace}/requests.ndjson`;
        const instanceId = ProviderInstanceId.make(`fork-${driver}`);
        let started = 0;
        const adapter = yield* makeForkAcpAdapterV2(settingsFor(driver, script), {
          instanceId,
          environment: {
            [`T3_ACP_${driver.toUpperCase()}`]: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLog,
            ...(driver === "hermes" ? { T3_ACP_EMIT_HERMES_DELEGATE_TASK: "1" } : {}),
          },
          onSessionStarted: () =>
            Effect.sync(() => {
              started += 1;
            }),
          onAvailableCommands: () => Effect.void,
          onAuthRequired: Effect.die("authenticated fixture must not request login"),
        });
        const threadId = ThreadId.make(`thread-${driver}`);
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const modelSelection = { instanceId, model: "default" };
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session-${driver}`),
          modelSelection,
          runtimePolicy,
        });
        const events: ProviderAdapterV2Event[] = [];
        const collector = yield* session.events.pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Stream.takeUntil(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        );
        yield* Fiber.join(collector);
        expect(started).toBeGreaterThan(0);
        expect(
          events.some((event) => event.type === "message.updated" && event.message.text.length > 0),
        ).toBe(true);
        if (driver === "hermes") {
          const children = new Map(
            events.flatMap((event) =>
              event.type === "subagent.updated"
                ? [[event.subagent.id, event.subagent] as const]
                : [],
            ),
          );
          expect(children.size).toBe(2);
          expect([...children.values()].map((child) => child.status)).toEqual([
            "completed",
            "completed",
          ]);
        }
        const requests = yield* Effect.forEach(
          (yield* fs.readFileString(requestLog)).trim().split("\n"),
          (line) => decodeRequest(line),
        );
        const methods = requests.map((request) => request.method);
        expect(methods).toContain("initialize");
        expect(methods).toContain("session/new");
        expect(methods.some((method) => method.includes("prompt"))).toBe(true);
        const authMethods = methods.filter(
          (method) => method === "authenticate" || method === "auth/login",
        );
        expect(authMethods.length).toBe(driver === "hermes" ? 1 : 0);
      }).pipe(Effect.provide(testLayer)),
  );
});
