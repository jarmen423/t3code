import { describe, expect, it } from "@effect/vitest";

import { HermesDelegationTracker } from "./HermesDelegationTasks.ts";

const delegateTool = (status: "pending" | "inProgress" | "completed" | "failed") => ({
  toolCallId: "delegate-1",
  title: "Ran command",
  status,
  data: {
    rawInput: {
      toolName: "delegate_task",
      tasks: [
        { goal: "Review cancellation", role: "reviewer" },
        { goal: "Check retries", model: "openai/gpt-5" },
      ],
    },
  },
});

const delegateProgress = (
  taskProgress: Record<string, unknown>,
  status: "inProgress" | "completed" | "failed" = "inProgress",
) => ({
  ...delegateTool(status),
  data: {
    ...delegateTool(status).data,
    rawOutput: { toolName: "delegate_task", taskProgress },
  },
});

const delegateDispatch = () => ({
  ...delegateTool("inProgress"),
  data: {
    ...delegateTool("inProgress").data,
    rawOutput: {
      toolName: "delegate_task",
      lifecycle: { status: "dispatched", mode: "background" },
    },
  },
});

describe("HermesDelegationTracker", () => {
  it("maps a Hermes delegate_task tool call to stable child task lifecycles", () => {
    const tracker = new HermesDelegationTracker();

    expect(tracker.update(delegateTool("pending"))).toEqual([
      {
        phase: "started",
        taskId: "hermes:delegate-1:0",
        description: "Review cancellation",
        role: "reviewer",
        taskType: "local_agent",
        toolUseId: "delegate-1",
      },
      {
        phase: "started",
        taskId: "hermes:delegate-1:1",
        description: "Check retries",
        model: "openai/gpt-5",
        taskType: "local_agent",
        toolUseId: "delegate-1",
      },
    ]);

    expect(tracker.update(delegateTool("inProgress"))).toEqual([]);
    const completed = tracker.update(delegateTool("completed"));
    expect(completed).toMatchObject([
      { phase: "completed", taskId: "hermes:delegate-1:0", status: "completed" },
      { phase: "completed", taskId: "hermes:delegate-1:1", status: "completed" },
    ]);
    expect(tracker.update(delegateTool("completed"))).toEqual([]);
  });

  it("emits repeated progress for one child and completes it independently", () => {
    const tracker = new HermesDelegationTracker();
    tracker.update(delegateTool("pending"));

    expect(tracker.update(delegateDispatch())).toEqual([]);

    expect(
      tracker.update(
        delegateProgress({
          sequence: 1,
          taskIndex: 1,
          type: "tool.started",
          status: "running",
          lastToolName: "search_files",
          summary: "Running search_files",
        }),
      ),
    ).toMatchObject([
      {
        phase: "progress",
        taskId: "hermes:delegate-1:1",
        summary: "Running search_files",
        lastToolName: "search_files",
      },
    ]);
    expect(
      tracker.update(
        delegateProgress({
          sequence: 2,
          taskIndex: 1,
          type: "thinking",
          status: "running",
          summary: "Thinking",
        }),
      ),
    ).toMatchObject([{ phase: "progress", taskId: "hermes:delegate-1:1", summary: "Thinking" }]);
    expect(
      tracker.update(
        delegateProgress({
          sequence: 2,
          taskIndex: 1,
          type: "thinking",
          status: "running",
          summary: "Thinking",
        }),
      ),
    ).toEqual([]);
    expect(
      tracker.update(
        delegateProgress({
          sequence: 3,
          taskIndex: 1,
          type: "completed",
          status: "completed",
          summary: "Retry behavior is correct",
        }),
      ),
    ).toMatchObject([
      {
        phase: "completed",
        taskId: "hermes:delegate-1:1",
        status: "completed",
        summary: "Retry behavior is correct",
      },
    ]);

    expect(
      tracker.update(
        delegateProgress(
          {
            sequence: 4,
            taskIndex: 0,
            type: "completed",
            status: "completed",
            summary: "Cancellation review is correct",
          },
          "completed",
        ),
      ),
    ).toMatchObject([
      {
        phase: "completed",
        taskId: "hermes:delegate-1:0",
        status: "completed",
        summary: "Cancellation review is correct",
      },
    ]);
    // Every child settled on its own completion: the terminal tool-call frame
    // has no unfinished children left to synthesize.
    expect(tracker.update(delegateTool("completed"))).toEqual([]);
  });

  it("ignores ordinary Hermes tool calls", () => {
    const tracker = new HermesDelegationTracker();
    expect(
      tracker.update({
        toolCallId: "terminal-1",
        title: "terminal: pnpm test",
        status: "completed",
        data: { rawInput: { command: "pnpm test" } },
      }),
    ).toEqual([]);
  });

  it("emits start and failure when only a terminal update is observed", () => {
    const tracker = new HermesDelegationTracker();
    const events = tracker.update({ ...delegateTool("failed"), toolCallId: "delegate-late" });

    expect(events.map((event) => event.phase)).toEqual([
      "started",
      "started",
      "completed",
      "completed",
    ]);
    expect(events.every((event) => event.phase !== "completed" || event.status === "failed")).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ status: "failed" });
  });

  it("never remaps live children when a later frame omits rawInput or carries a malformed task list", () => {
    const tracker = new HermesDelegationTracker();
    tracker.update(delegateTool("pending"), "turn-1");

    // Progress frames legitimately omit rawInput (tool_call_update deltas):
    // children stay frozen from the first frame, so indices still resolve.
    const progress = tracker.update(
      {
        toolCallId: "delegate-1",
        title: "Ran command",
        status: "inProgress",
        data: {
          rawOutput: {
            toolName: "delegate_task",
            taskProgress: {
              sequence: 1,
              taskIndex: 0,
              type: "thinking",
              status: "running",
              summary: "Reviewing",
            },
          },
        },
      },
      "turn-1",
    );
    expect(progress).toMatchObject([
      { phase: "progress", taskId: "hermes:delegate-1:0", summary: "Reviewing" },
    ]);

    // A malformed re-emission of rawInput (shuffled, invalid, fewer tasks)
    // must not remap taskIndex 1 onto a different child or crash the run.
    const malformed = tracker.update(
      {
        toolCallId: "delegate-1",
        title: "Ran command",
        status: "inProgress",
        data: {
          rawInput: { toolName: "delegate_task", tasks: [{ role: "reviewer" }, "not-an-object"] },
          rawOutput: {
            toolName: "delegate_task",
            taskProgress: {
              sequence: 2,
              taskIndex: 1,
              type: "tool.started",
              status: "running",
              lastToolName: "search_files",
              summary: "Running search_files",
            },
          },
        },
      },
      "turn-1",
    );
    expect(malformed).toMatchObject([
      { phase: "progress", taskId: "hermes:delegate-1:1", lastToolName: "search_files" },
    ]);

    // Out-of-range indices map to no child instead of a wrong one.
    expect(
      tracker.update(
        delegateProgress(
          { sequence: 3, taskIndex: 9, type: "completed", status: "completed", summary: "gone" },
          "completed",
        ),
      ),
    ).toEqual([]);
    // The children still settle truthfully on the parent's terminal frame.
    const settled = tracker.update(delegateTool("completed"), "turn-1");
    expect(settled.map((event) => event.taskId)).toEqual([
      "hermes:delegate-1:0",
      "hermes:delegate-1:1",
    ]);
  });

  it("keeps progress monotonic per tool call and idempotent across the run", () => {
    const tracker = new HermesDelegationTracker();
    tracker.update(delegateTool("pending"), "turn-1");
    tracker.update(
      delegateProgress({
        sequence: 5,
        taskIndex: 0,
        type: "thinking",
        status: "running",
        summary: "five",
      }),
      "turn-1",
    );
    // A regressed or replayed sequence is dropped.
    expect(
      tracker.update(
        delegateProgress({
          sequence: 4,
          taskIndex: 1,
          type: "thinking",
          status: "running",
          summary: "four",
        }),
        "turn-1",
      ),
    ).toEqual([]);
    // A higher sequence for an already-completed child is dropped too.
    tracker.update(
      delegateProgress({
        sequence: 6,
        taskIndex: 0,
        type: "completed",
        status: "completed",
        summary: "done-zero",
      }),
      "turn-1",
    );
    expect(
      tracker.update(
        delegateProgress({
          sequence: 7,
          taskIndex: 0,
          type: "thinking",
          status: "running",
          summary: "zombie",
        }),
        "turn-1",
      ),
    ).toEqual([]);
  });

  it("records the originating turn and never stamps a late completion onto a newer turn", () => {
    const tracker = new HermesDelegationTracker();
    tracker.update(delegateTool("pending"), "turn-1");
    tracker.update(
      delegateProgress({
        sequence: 1,
        taskIndex: 0,
        type: "completed",
        status: "completed",
        summary: "first child done",
      }),
      "turn-1",
    );

    // The steer opens turn-2; the stale delegate call replays there.
    expect(tracker.update(delegateTool("inProgress"), "turn-2")).toEqual([]);
    expect(
      tracker.update(
        delegateProgress({
          sequence: 2,
          taskIndex: 1,
          type: "completed",
          status: "completed",
          summary: "wrong turn",
        }),
        "turn-2",
      ),
    ).toEqual([]);
    // Terminal frames under the new turn cannot settle the old run either.
    expect(tracker.update(delegateTool("completed"), "turn-2")).toEqual([]);

    // Turn-1's own teardown still settles its remaining child truthfully.
    const parked = tracker.settleTurn("turn-1");
    expect(parked).toMatchObject([
      {
        phase: "completed",
        taskId: "hermes:delegate-1:1",
        status: "stopped",
        summary: "Ended when the parent turn ended.",
      },
    ]);
    expect(tracker.settleTurn("turn-1")).toEqual([]);
    expect(tracker.update(delegateTool("completed"), "turn-1")).toEqual([]);
  });

  it("settles unfinished children only at the owning turn's teardown", () => {
    const tracker = new HermesDelegationTracker();
    tracker.update(delegateTool("pending"), "turn-1");
    tracker.update(
      delegateProgress({
        sequence: 1,
        taskIndex: 1,
        type: "thinking",
        status: "running",
        summary: "working",
      }),
      "turn-1",
    );

    const settled = tracker.settleTurn("turn-1");
    expect(settled).toMatchObject([
      {
        phase: "completed",
        taskId: "hermes:delegate-1:0",
        status: "stopped",
        summary: "Ended when the parent turn ended.",
      },
      {
        phase: "completed",
        taskId: "hermes:delegate-1:1",
        status: "stopped",
        summary: "Ended when the parent turn ended.",
      },
    ]);
    // Children that never reported keep the park summary, even on the
    // terminal tool-call frame that arrives after teardown.
    expect(tracker.update(delegateTool("completed"), "turn-1")).toEqual([]);
    // Other turns are untouched.
    tracker.update({ ...delegateTool("pending"), toolCallId: "delegate-2" }, "turn-2");
    expect(tracker.settleTurn("turn-3")).toEqual([]);
    expect(tracker.settleTurn("turn-2").map((event) => event.taskId)).toEqual([
      "hermes:delegate-2:0",
      "hermes:delegate-2:1",
    ]);
  });

  it("allows frames without a turn id for an owned run but never re-anchors it", () => {
    const tracker = new HermesDelegationTracker();
    tracker.update(delegateTool("pending"), "turn-1");
    // A delta frame that lost its turn context still rides the owned run...
    expect(
      tracker.update(
        delegateProgress({
          sequence: 1,
          taskIndex: 0,
          type: "thinking",
          status: "running",
          summary: "riding",
        }),
      ),
    ).toMatchObject([{ phase: "progress", taskId: "hermes:delegate-1:0" }]);
    // ...but a new delegation with no turn context cannot attach to it:
    // delegate-9 was first observed under turn-1's rival run context, so its
    // own children start a separate run that no existing turn owns.
    tracker.update({ ...delegateTool("pending"), toolCallId: "delegate-9" });
    expect(
      tracker.update({
        ...delegateProgress({
          sequence: 2,
          taskIndex: 1,
          type: "thinking",
          status: "running",
          summary: "own",
        }),
        toolCallId: "delegate-9",
      }),
    ).toMatchObject([{ taskId: "hermes:delegate-9:1" }]);
    // The owned run is untouched by delegate-9's frames; both of its children
    // (child 0 never reported completion) park at teardown.
    expect(tracker.settleTurn("turn-1").map((event) => event.taskId)).toEqual([
      "hermes:delegate-1:0",
      "hermes:delegate-1:1",
    ]);
  });
});
