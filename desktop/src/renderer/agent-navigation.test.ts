import { expect, it } from "vitest";
import type { ResearchAgentEventRecord, ResearchAgentSessionsSnapshot, ResearchAgentTargetReference, ResearchSnapshot } from "../shared/research-contracts";
import { AgentSourceActivityTracker, agentResultTarget, agentSourceTarget, agentSourceView } from "./agent-navigation";

const source = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Synthetic", metadata: {
  dimensions: { x: 100, y: 80, z: 5, t: 2, c: 2 },
  levels: [{ index: 0, dimensions: { x: 100, y: 80, z: 5, t: 2, c: 2 } },
    { index: 1, dimensions: { x: 50, y: 40, z: 5, t: 2, c: 2 } }],
} };
const result = { id: "c".repeat(32), revision_hash: "d".repeat(64), source_id: source.id,
  source_sha256: source.sha256, kind: "segmentation", object_count: 2, created_at: "now" };
const snapshot = { project: {}, sources: [source], results: [result], jobs: [] } as unknown as ResearchSnapshot;
const target: ResearchAgentTargetReference = { kind: "source", id: source.id, sha256: source.sha256,
  selection: { x: 10, y: 5, width: 20, height: 10, z: 3, t: 1, c: 1, level: 1 } };

it("rejects absent, unbound, changed and relink-required source references", () => {
  expect(agentSourceTarget(snapshot, target)).toBe(source);
  for (const invalid of [{ ...target, id: "absent" }, { ...target, sha256: undefined }, { ...target, sha256: "wrong" }])
    expect(() => agentSourceTarget(snapshot, invalid)).toThrow(/fingerprint/);
  expect(() => agentSourceTarget({ ...snapshot, sources: [{ ...source, locator_state: "relink-required" }] }, target)).toThrow();
});

it("resolves an exact result only while both revision and source identity agree", () => {
  const bound: ResearchAgentTargetReference = { kind: "result", id: result.id, revision_hash: result.revision_hash,
    source_id: source.id, source_sha256: source.sha256 };
  expect(agentResultTarget(snapshot, bound)).toBe(result);
  expect(() => agentResultTarget(snapshot, { ...bound, revision_hash: "stale" })).toThrow(/revision/);
  expect(() => agentResultTarget({ ...snapshot, sources: [{ ...source, sha256: "changed" }] }, bound)).toThrow(/fingerprint/);
});

it("maps a coarse region to a native camera without changing the analysis ROI", () => {
  const view = agentSourceView(snapshot, target, { width: 400, height: 200 })!;
  expect(view.selection).toEqual({ t: 1, c: 1, z: 3 });
  expect(view.camera).toEqual({ x: 40, y: 20, scale: 9.6 });
  expect(view.selection).not.toHaveProperty("width");
  for (const invalid of [{ x: -1 }, { x: 40 }, { z: 5 }, { level: 4 }, { width: NaN }, { z_stop: 2 }])
    expect(() => agentSourceView(snapshot, { ...target, selection: { ...target.selection!, ...invalid } }, { width: 400, height: 200 })).toThrow(/grid/);
});

it("consumes successful source views once and never follows old, failed or stale activity", () => {
  const tracker = new AgentSourceActivityTracker();
  const event = (id: string, kind = "operation_inspected", ref = target): ResearchAgentEventRecord => ({
    id, kind, operation: "source_image", targets: [ref], actor: "agent", timestamp: id,
    session_id: "session", policy_sha256: "policy", approval_id: null, summary: "Untrusted summary",
  });
  const next = (events: ResearchAgentEventRecord[]) => ({ ...snapshot,
    agent_sessions: { events } as ResearchAgentSessionsSnapshot });
  expect(tracker.observe(next([event("1")]), "study:1")).toBeNull();
  expect(tracker.observe(next([event("2"), event("1")]), "study:1")).toEqual(target);
  // The caller can decline navigation during editing; this event is not queued.
  expect(tracker.observe(next([event("2"), event("1")]), "study:1")).toBeNull();
  expect(tracker.observe(next([event("3", "operation_failed")]), "study:1")).toBeNull();
  expect(tracker.observe(next([event("4", "operation_inspected", { ...target, sha256: "changed" })]), "study:1")).toBeNull();
  expect(tracker.observe(next([event("5")]), "study:2")).toBeNull();
});
