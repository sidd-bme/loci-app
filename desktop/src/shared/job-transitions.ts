import type { JobEvent, JobState } from "./foundation-contracts";
import { validateJobEvent } from "./foundation-validation";

const TERMINAL_STATES = new Set<JobState>(["completed", "failed", "cancelled"]);

const ALLOWED_TRANSITIONS: Readonly<Record<JobState, ReadonlySet<JobState>>> = {
  staging: new Set(["queued", "running", "failed", "cancelled", "disconnected", "needs-attention"]),
  queued: new Set(["held", "running", "failed", "cancelled", "disconnected", "needs-attention"]),
  held: new Set(["queued", "failed", "cancelled", "disconnected", "needs-attention"]),
  running: new Set(["downloading", "verifying", "completed", "failed", "cancelled", "disconnected", "needs-attention"]),
  downloading: new Set(["verifying", "failed", "cancelled", "disconnected", "needs-attention"]),
  verifying: new Set(["completed", "failed", "cancelled", "disconnected", "needs-attention"]),
  disconnected: new Set(["staging", "queued", "held", "running", "downloading", "verifying", "failed", "cancelled", "needs-attention"]),
  "needs-attention": new Set(["staging", "queued", "held", "running", "downloading", "verifying", "failed", "cancelled", "disconnected"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export type JobTransitionErrorCode =
  | "invalid-event"
  | "wrong-job"
  | "invalid-sequence"
  | "timestamp-regression"
  | "invalid-initial-state"
  | "terminal-state"
  | "invalid-transition"
  | "progress-regression";

export class JobTransitionError extends Error {
  constructor(
    public readonly code: JobTransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JobTransitionError";
  }
}

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Repeated non-terminal states are allowed for progress and scheduler updates. */
export function isJobTransitionAllowed(from: JobState, to: JobState): boolean {
  if (from === to) return !isTerminalJobState(from);
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function assertJobEventTransition(previous: JobEvent, next: JobEvent): JobEvent {
  try {
    validateJobEvent(previous);
    validateJobEvent(next);
  } catch (error) {
    throw new JobTransitionError(
      "invalid-event",
      error instanceof Error ? error.message : "A job event is invalid.",
    );
  }
  if (previous.jobId !== next.jobId) {
    throw new JobTransitionError("wrong-job", "A job event cannot be appended to another job.");
  }
  if (next.sequence !== previous.sequence + 1) {
    throw new JobTransitionError("invalid-sequence", "Job-event sequences must be contiguous.");
  }
  if (Date.parse(next.occurredAt) < Date.parse(previous.occurredAt)) {
    throw new JobTransitionError("timestamp-regression", "A job event cannot precede the previous event.");
  }
  if (isTerminalJobState(previous.state)) {
    throw new JobTransitionError("terminal-state", `No event may follow terminal state ${previous.state}.`);
  }
  if (!isJobTransitionAllowed(previous.state, next.state)) {
    throw new JobTransitionError(
      "invalid-transition",
      `Job state cannot move from ${previous.state} to ${next.state}.`,
    );
  }
  if (
    previous.state === next.state &&
    previous.progress !== null &&
    next.progress !== null &&
    next.progress < previous.progress
  ) {
    throw new JobTransitionError("progress-regression", "Progress cannot decrease within one job state.");
  }
  return next;
}

/** Validate the complete existing history and return a new array without mutating it. */
export function appendValidatedJobEvent(
  history: readonly JobEvent[],
  candidate: JobEvent,
): JobEvent[] {
  try {
    validateJobEvent(candidate);
  } catch (error) {
    throw new JobTransitionError(
      "invalid-event",
      error instanceof Error ? error.message : "The job event is invalid.",
    );
  }
  if (history.length === 0) {
    if (candidate.sequence !== 0 || candidate.state !== "staging") {
      throw new JobTransitionError(
        "invalid-initial-state",
        "A job history must begin with sequence 0 in staging state.",
      );
    }
    return [candidate];
  }
  for (let index = 1; index < history.length; index += 1) {
    assertJobEventTransition(history[index - 1], history[index]);
  }
  assertJobEventTransition(history.at(-1) as JobEvent, candidate);
  return [...history, candidate];
}

export function validateJobEventHistory(history: readonly JobEvent[]): readonly JobEvent[] {
  if (history.length === 0) return history;
  const first = history[0];
  try {
    validateJobEvent(first);
  } catch (error) {
    throw new JobTransitionError(
      "invalid-event",
      error instanceof Error ? error.message : "The initial job event is invalid.",
    );
  }
  if (first.sequence !== 0 || first.state !== "staging") {
    throw new JobTransitionError(
      "invalid-initial-state",
      "A job history must begin with sequence 0 in staging state.",
    );
  }
  for (let index = 1; index < history.length; index += 1) {
    assertJobEventTransition(history[index - 1], history[index]);
  }
  return history;
}

export interface SchedulerStateExplanation {
  category: "queued" | "held" | "running" | "completed" | "failed" | "unknown";
  summary: string;
}

/** Translate scheduler codes without claiming a cause the scheduler did not expose. */
export function explainSchedulerState(
  scheduler: "pbs" | "slurm",
  rawState: string,
): SchedulerStateExplanation {
  const state = rawState.trim().toUpperCase();
  if (scheduler === "pbs") {
    if (["Q", "W", "T"].includes(state)) return { category: "queued", summary: "Waiting for the scheduler to allocate requested resources." };
    if (["H", "S"].includes(state)) return { category: "held", summary: "Held or suspended; inspect the scheduler reason for the exact cause." };
    if (["R", "E", "B"].includes(state)) return { category: "running", summary: "Running or completing on the remote system." };
    if (["F", "X"].includes(state)) return { category: "completed", summary: "The scheduler reports that execution has finished." };
  } else {
    if (["PENDING", "CONFIGURING", "REQUEUED"].includes(state)) return { category: "queued", summary: "Waiting for the scheduler to allocate requested resources." };
    if (["SUSPENDED", "STOPPED", "SPECIAL_EXIT"].includes(state)) return { category: "held", summary: "Held or suspended; inspect the scheduler reason for the exact cause." };
    if (["RUNNING", "COMPLETING", "STAGE_OUT"].includes(state)) return { category: "running", summary: "Running or completing on the remote system." };
    if (state === "COMPLETED") return { category: "completed", summary: "The scheduler reports successful completion." };
    if (["FAILED", "CANCELLED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "BOOT_FAIL", "DEADLINE"].includes(state)) {
      return { category: "failed", summary: "The scheduler reports an unsuccessful terminal state." };
    }
  }
  return { category: "unknown", summary: "Scheduler state is not recognized; inspect the raw scheduler details." };
}
