// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResearchAgentSessionsSnapshot, ResearchResult, ResearchSnapshot } from "../shared/research-contracts";
import { AgentResultTracker, useWorkspaceSnapshotPolling } from "./agent-session-refresh";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

function study(projectId = "a".repeat(32)): ResearchSnapshot {
  return { project: { project_id: projectId, title: "Synthetic study" },
    sources: [{ id: "source", sha256: "b".repeat(64), name: "Synthetic", metadata: {} }],
    samples: [], recipes: [], displays: [], selections: [], results: [], jobs: [], operations: {} };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(getSnapshot: () => Promise<ResearchSnapshot | null>, initial = study()) {
  const onError = vi.fn();
  const hook = renderHook(({ scope, suspended }) => {
    const [snapshot, setSnapshot] = useState<ResearchSnapshot | null>(initial);
    useWorkspaceSnapshotPolling({ snapshot, setSnapshot, scope, suspended, enabled: true,
      interval: 1000, getSnapshot, onError });
    return { snapshot, setSnapshot };
  }, { initialProps: { scope: "study:1", suspended: false } });
  return { ...hook, onError };
}
const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it("keeps a single request in flight and preserves a newer command snapshot", async () => {
  const pending = deferred<ResearchSnapshot>();
  const getSnapshot = vi.fn(() => pending.promise);
  const hook = setup(getSnapshot);
  await tick(5000);
  expect(getSnapshot).toHaveBeenCalledTimes(1);
  const newer = { ...study(), project: { ...study().project, title: "Newer command state" } };
  act(() => hook.result.current.setSnapshot(newer));
  await act(async () => pending.resolve(study()));
  expect(hook.result.current.snapshot).toBe(newer);
});

it("rejects an old response after reopening even the same project ID", async () => {
  const pending = deferred<ResearchSnapshot>();
  const hook = setup(() => pending.promise);
  await tick();
  hook.rerender({ scope: "study:2", suspended: false });
  const reopened = hook.result.current.snapshot;
  await act(async () => pending.resolve({ ...study(), results: [{ id: "old" } as ResearchResult] }));
  expect(hook.result.current.snapshot).toBe(reopened);
});

it("does not adopt another project's state or poll during document switching", async () => {
  const getSnapshot = vi.fn(async () => study("c".repeat(32)));
  const hook = setup(getSnapshot);
  const initial = hook.result.current.snapshot;
  await tick();
  expect(hook.result.current.snapshot).toBe(initial);
  hook.rerender({ scope: "study:1", suspended: true });
  await tick(3000);
  expect(getSnapshot).toHaveBeenCalledTimes(1);
});

it("reports refresh failure and recovers on the next successful poll", async () => {
  const failure = new Error("worker disconnected");
  const next = study();
  const getSnapshot = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(next);
  const hook = setup(getSnapshot);
  await tick();
  expect(hook.onError).toHaveBeenLastCalledWith(failure);
  await tick();
  expect(hook.result.current.snapshot).toBe(next);
  expect(hook.onError).toHaveBeenLastCalledWith(null);
});

function result(id: string): ResearchResult {
  return { id, source_id: "source", source_sha256: "b".repeat(64) } as ResearchResult;
}
function attributed(snapshot: ResearchSnapshot, ids: string[]): ResearchSnapshot {
  return { ...snapshot, agent_sessions: { sessions: [{ recent_result_ids: ids }] } as ResearchAgentSessionsSnapshot };
}

it("follows only new agent-owned results, including delayed publication attribution", () => {
  const tracker = new AgentResultTracker();
  const initial = { ...study(), results: [result("existing")] };
  expect(tracker.observe(initial, "study:1")).toBeNull();
  const human = { ...initial, results: [...initial.results, result("human")] };
  expect(tracker.observe(human, "study:1")).toBeNull();
  const produced = { ...human, results: [...human.results, result("agent")] };
  expect(tracker.observe(produced, "study:1")).toBeNull();
  const published = attributed(produced, ["agent"]);
  expect(tracker.observe(published, "study:1")?.id).toBe("agent");
  expect(tracker.observe(published, "study:1")).toBeNull();
  expect(tracker.observe(attributed(published, ["existing", "agent"]), "study:1")).toBeNull();
  expect(tracker.observe(published, "study:2")).toBeNull();
});

it("never navigates a result whose registered source identity does not match", () => {
  const tracker = new AgentResultTracker();
  tracker.observe(study(), "study:1");
  const next = attributed({ ...study(), results: [{ ...result("agent"), source_sha256: "changed" }] }, ["agent"]);
  expect(tracker.observe(next, "study:1")).toBeNull();
});
