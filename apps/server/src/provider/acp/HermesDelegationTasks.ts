import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

interface DelegatedChild {
  readonly taskId: string;
  readonly description: string;
  readonly role?: string;
  readonly model?: string;
  readonly taskType: "local_agent";
  readonly toolUseId: string;
}

export type HermesDelegationLifecycle = DelegatedChild &
  (
    | { readonly phase: "started" }
    | { readonly phase: "progress"; readonly summary?: string; readonly lastToolName?: string }
    | {
        readonly phase: "completed";
        readonly status: "completed" | "failed" | "stopped";
        readonly summary?: string;
      }
  );

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseChildren(toolCall: AcpToolCallState): ReadonlyArray<DelegatedChild> {
  const rawInput = asRecord(toolCall.data.rawInput);
  if (rawInput?.toolName !== "delegate_task") return [];
  const candidates = Array.isArray(rawInput.tasks)
    ? rawInput.tasks
    : nonEmptyString(rawInput.goal)
      ? [rawInput]
      : [];

  return candidates.flatMap((candidate, index) => {
    const task = asRecord(candidate);
    const description = nonEmptyString(task?.goal);
    if (!description) return [];
    const role = nonEmptyString(task?.role);
    const model = nonEmptyString(task?.model);
    return [
      {
        taskId: `hermes:${toolCall.toolCallId}:${index}`,
        description,
        ...(role ? { role } : {}),
        ...(model ? { model } : {}),
        taskType: "local_agent" as const,
        toolUseId: toolCall.toolCallId,
      },
    ];
  });
}

type ChildProgress =
  | {
      readonly sequence: number;
      readonly taskIndex: number;
      readonly type: "tool.started" | "tool.completed";
      readonly summary: string;
      readonly lastToolName: string;
    }
  | {
      readonly sequence: number;
      readonly taskIndex: number;
      readonly type: "thinking";
      readonly summary: string;
    }
  | {
      readonly sequence: number;
      readonly taskIndex: number;
      readonly type: "completed";
      readonly summary: string;
      readonly status: "completed" | "failed" | "stopped";
    };

function parseTaskProgress(toolCall: AcpToolCallState): ChildProgress | undefined {
  const rawOutput = asRecord(toolCall.data.rawOutput);
  if (rawOutput?.toolName !== "delegate_task") return undefined;
  const progress = asRecord(rawOutput.taskProgress);
  const sequence = progress?.sequence;
  const taskIndex = progress?.taskIndex;
  const type = nonEmptyString(progress?.type);
  const summary = nonEmptyString(progress?.summary)?.slice(0, 1_000);
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    typeof taskIndex !== "number" ||
    !Number.isSafeInteger(taskIndex) ||
    taskIndex < 0 ||
    !summary
  ) {
    return undefined;
  }

  if (type === "tool.started" || type === "tool.completed") {
    const lastToolName = nonEmptyString(progress?.lastToolName)?.slice(0, 120);
    return lastToolName ? { sequence, taskIndex, type, summary, lastToolName } : undefined;
  }
  if (type === "thinking") return { sequence, taskIndex, type, summary };
  if (type !== "completed") return undefined;
  const status = progress?.status;
  return status === "completed" || status === "failed" || status === "stopped"
    ? { sequence, taskIndex, type, summary, status }
    : undefined;
}

interface DelegationRun {
  /** Children derived from the first frame that carried rawInput. */
  children: ReadonlyArray<DelegatedChild>;
  /** Turn the delegate_task was first observed under; children settle with it. */
  turnId: string | undefined;
  /** Highest accepted taskProgress sequence; rejects replayed/regressed frames. */
  lastSequence: number;
  /** Children that already reported their own completion. */
  readonly completedTasks: Set<string>;
}

/**
 * Keeps Hermes' single delegate_task tool call aligned with child task rows.
 *
 * A delegate_task dispatches its tasks in the background and reports each
 * child's progress inside later `tool_call_update` rawOutputs of the SAME tool
 * call. The tracker derives one child row per requested goal and owns the
 * index→taskId mapping (children are frozen from the first rawInput frame), so
 * a malformed or re-ordered task list can never remap a live child onto a
 * different id mid-flight: frames without rawInput reuse the frozen children,
 * and only parse into rows with valid indices.
 *
 * Turn ownership: a delegate_task observed under turn A must never stamp its
 * late completion onto turn B. A run is recorded under the turn that first
 * saw it; frames for any other turn are ignored, and turn teardown settles or
 * parks every child that has not reported its own completion.
 */
export class HermesDelegationTracker {
  readonly #runsByToolCall = new Map<string, DelegationRun>();
  readonly #settledToolCalls = new Set<string>();

  /**
   * Terminalizes unfinished children at turn teardown (interrupt, session
   * stop, process death). Children that reported a completion keep it;
   * the rest report "stopped" so no row outlives its turn as forever-running.
   */
  settleTurn(turnId: string): ReadonlyArray<HermesDelegationLifecycle> {
    const events: Array<HermesDelegationLifecycle> = [];
    for (const [toolCallId, run] of this.#runsByToolCall) {
      if (run.turnId !== turnId) continue;
      events.push(...this.#settleRun(toolCallId, run, "stopped"));
    }
    return events;
  }

  #settleRun(
    toolCallId: string,
    run: DelegationRun,
    fallbackStatus: "completed" | "failed" | "stopped",
  ): ReadonlyArray<HermesDelegationLifecycle> {
    this.#runsByToolCall.delete(toolCallId);
    this.#settledToolCalls.add(toolCallId);
    return run.children.flatMap((child) => {
      if (run.completedTasks.has(child.taskId)) return [];
      const event: HermesDelegationLifecycle = {
        ...child,
        phase: "completed",
        status: fallbackStatus,
      };
      if (fallbackStatus === "stopped") {
        return [{ ...event, summary: "Ended when the parent turn ended." }];
      }
      return [event];
    });
  }

  update(toolCall: AcpToolCallState, turnId?: string): ReadonlyArray<HermesDelegationLifecycle> {
    if (this.#settledToolCalls.has(toolCall.toolCallId)) return [];
    const run = this.#runsByToolCall.get(toolCall.toolCallId);
    if (run && turnId !== undefined && run.turnId !== turnId) return [];
    const children = run?.children ?? parseChildren(toolCall);
    if (children.length === 0) return [];

    const terminal = toolCall.status === "completed" || toolCall.status === "failed";
    const events: HermesDelegationLifecycle[] = [];
    if (!run) {
      this.#runsByToolCall.set(toolCall.toolCallId, {
        children,
        turnId,
        lastSequence: -1,
        completedTasks: new Set<string>(),
      });
      events.push(...children.map((child) => ({ ...child, phase: "started" as const })));
    }

    const progress = parseTaskProgress(toolCall);
    if (progress) {
      const current = this.#runsByToolCall.get(toolCall.toolCallId)!;
      // Duplicate/regressed frames (Hermes replays tool calls on resume) are
      // ignored: sequences within one run are monotonic.
      if (progress.sequence <= current.lastSequence) return events;
      current.lastSequence = progress.sequence;
      // taskIndex is bounds-checked against the frozen children, so a
      // malformed frame maps to no row rather than to the wrong child.
      const child = children[progress.taskIndex];
      if (!child || current.completedTasks.has(child.taskId)) return events;
      if (progress.type === "completed") {
        current.completedTasks.add(child.taskId);
        events.push({
          ...child,
          phase: "completed",
          status: progress.status,
          summary: progress.summary,
        });
        if (current.completedTasks.size === children.length) {
          this.#settleRun(toolCall.toolCallId, current, "completed");
        }
      } else {
        events.push({
          ...child,
          phase: "progress",
          summary: progress.summary,
          ...(progress.type === "tool.started" || progress.type === "tool.completed"
            ? { lastToolName: progress.lastToolName }
            : {}),
        });
      }
      return events;
    }

    if (terminal) {
      const current = this.#runsByToolCall.get(toolCall.toolCallId)!;
      const fallbackStatus = toolCall.status === "failed" ? "failed" : "completed";
      events.push(...this.#settleRun(toolCall.toolCallId, current, fallbackStatus));
    }
    return events;
  }
}
