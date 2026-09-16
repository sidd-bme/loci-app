// @vitest-environment node

import { describe, expect, it } from "vitest";

import { JOB_EVENT_SCHEMA, type JobEvent, type JobState } from "./foundation-contracts";
import {
  JobTransitionError,
  appendValidatedJobEvent,
  assertJobEventTransition,
  explainSchedulerState,
  isJobTransitionAllowed,
  isTerminalJobState,
  validateJobEventHistory,
} from "./job-transitions";

function event(sequence: number, state: JobState, overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    schemaVersion: JOB_EVENT_SCHEMA,
    jobId: "job-1",
    sequence,
    occurredAt: new Date(Date.UTC(2026, 7, 31, 0, sequence)).toISOString(),
    state,
    progress: state === "completed" ? 1 : sequence / 10,
    message: `Job is ${state}.`,
    reasonCode: null,
    schedulerState: null,
    ...overrides,
  };
}

describe("job state transitions", () => {
  it("supports the local verified-publication lifecycle", () => {
    const states: JobState[] = ["staging", "running", "verifying", "completed"];
    const history = states.reduce<JobEvent[]>(
      (events, state, sequence) => appendValidatedJobEvent(events, event(sequence, state)),
      [],
    );

    expect(history.map(({ state }) => state)).toEqual(states);
    expect(validateJobEventHistory(history)).toBe(history);
    expect(isTerminalJobState(history.at(-1)?.state as JobState)).toBe(true);
  });

  it("supports remote staging, queueing, execution, transfer, and verification", () => {
    const states: JobState[] = [
      "staging", "queued", "held", "queued", "running", "downloading", "verifying", "completed",
    ];

    expect(() => states.reduce<JobEvent[]>(
      (events, state, sequence) => appendValidatedJobEvent(events, event(sequence, state)),
      [],
    )).not.toThrow();
  });

  it("allows repeated non-terminal states for progress updates", () => {
    const previous = event(1, "running", { progress: 0.25 });
    const next = event(2, "running", { progress: 0.4 });

    expect(assertJobEventTransition(previous, next)).toBe(next);
    expect(isJobTransitionAllowed("running", "running")).toBe(true);
    expect(isJobTransitionAllowed("completed", "completed")).toBe(false);
  });

  it("rejects histories that do not begin in staging at sequence zero", () => {
    expect(() => appendValidatedJobEvent([], event(1, "queued"))).toThrowError(
      expect.objectContaining({ code: "invalid-initial-state" }),
    );
  });

  it("rejects skipped sequences, cross-job events, and timestamp regressions", () => {
    expect(() => assertJobEventTransition(event(0, "staging"), event(2, "queued"))).toThrowError(
      expect.objectContaining({ code: "invalid-sequence" }),
    );
    expect(() => assertJobEventTransition(
      event(0, "staging"),
      event(1, "queued", { jobId: "job-2" }),
    )).toThrowError(expect.objectContaining({ code: "wrong-job" }));
    expect(() => assertJobEventTransition(
      event(0, "staging", { occurredAt: "2026-08-31T01:00:00.000Z" }),
      event(1, "queued", { occurredAt: "2026-08-31T00:00:00.000Z" }),
    )).toThrowError(expect.objectContaining({ code: "timestamp-regression" }));
  });

  it("rejects invalid state jumps and events after terminal states", () => {
    expect(() => assertJobEventTransition(event(0, "staging"), event(1, "completed"))).toThrowError(
      expect.objectContaining({ code: "invalid-transition" }),
    );
    expect(() => assertJobEventTransition(event(1, "completed"), event(2, "running"))).toThrowError(
      expect.objectContaining({ code: "terminal-state" }),
    );
  });

  it("rejects progress regression within one phase", () => {
    expect(() => assertJobEventTransition(
      event(1, "running", { progress: 0.7 }),
      event(2, "running", { progress: 0.6 }),
    )).toThrowError(expect.objectContaining({ code: "progress-regression" }));
  });

  it("validates pre-existing histories before appending", () => {
    const corruptHistory = [event(0, "staging"), event(3, "queued")];

    expect(() => appendValidatedJobEvent(corruptHistory, event(4, "running"))).toThrow(JobTransitionError);
  });
});

describe("scheduler state explanations", () => {
  it("describes PBS queue and hold states without inventing a cause", () => {
    expect(explainSchedulerState("pbs", "Q")).toEqual({
      category: "queued",
      summary: "Waiting for the scheduler to allocate requested resources.",
    });
    expect(explainSchedulerState("pbs", "H")).toMatchObject({
      category: "held",
      summary: expect.stringContaining("exact cause"),
    });
  });

  it("describes Slurm terminal failures and preserves unknown states", () => {
    expect(explainSchedulerState("slurm", "OUT_OF_MEMORY").category).toBe("failed");
    expect(explainSchedulerState("slurm", "FUTURE_STATE")).toMatchObject({
      category: "unknown",
      summary: expect.stringContaining("raw scheduler details"),
    });
  });
});
