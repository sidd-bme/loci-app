// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchAgentEventRecord, ResearchAgentSessionsSnapshot, ResearchAgentTargetReference, ResearchSnapshot } from "../shared/research-contracts";
import engineFixture from "./__fixtures__/agent-sessions-snapshot.json";
import { AgentActivityTimeline, AgentApprovalDetails, AgentTargetLinks } from "./AgentActivityTimeline";

afterEach(cleanup);
const wire = engineFixture as ResearchAgentSessionsSnapshot;
const sourceId = "a".repeat(32);
const sourceHash = "b".repeat(64);
const resultId = "c".repeat(32);
const revision = "d".repeat(64);
const sourceTarget: ResearchAgentTargetReference = { kind: "source", id: sourceId, sha256: sourceHash,
  selection: { x: 2, y: 3, width: 10, height: 12, c: 1, t: 0, z: 2, level: 0 } };
const snapshot: ResearchSnapshot = {
  project: { title: "Study" },
  sources: [{ id: sourceId, name: "Source", sha256: sourceHash, metadata: {} }],
  results: [{ id: resultId, revision_hash: revision, source_id: sourceId,
    source_sha256: sourceHash, kind: "labels", created_at: "2026-10-27T00:00:00Z", object_count: 2 }],
  jobs: [{ id: "job-1", operation: "workflow_preview", request: { source_id: sourceId, source_sha256: sourceHash },
    request_key: "key", request_hash: "e".repeat(64), state: "succeeded", created_at: "2026-10-27T00:00:00Z",
    updated_at: "2026-10-27T00:01:00Z", progress: 1, cancel_requested: false, result_ids: [], error: null }],
  samples: [], recipes: [], displays: [], selections: [], operations: {},
};

function event(overrides: Partial<ResearchAgentEventRecord> = {}): ResearchAgentEventRecord {
  return { ...wire.events[0], id: "event-1", summary: "Exact source inspected", actor: "agent",
    kind: "tool_completed", timestamp: "2026-10-27T00:00:00Z", approval_id: null, targets: [sourceTarget], ...overrides };
}

describe("Agent activity targets", () => {
  it("opens exact source, result revision and job references without substituting current selections", () => {
    const onOpenSource = vi.fn();
    const onOpenResult = vi.fn();
    const onOpenJob = vi.fn();
    const result: ResearchAgentTargetReference = { kind: "result", id: resultId, revision_hash: revision, source_id: sourceId, source_sha256: sourceHash };
    const job: ResearchAgentTargetReference = { kind: "job", id: "job-1" };
    render(<AgentTargetLinks targets={[sourceTarget, result, job]} snapshot={snapshot} navigation={{ onOpenSource, onOpenResult, onOpenJob }} />);
    const sourceButton = screen.getByRole("button", { name: `Open source ${sourceId}` });
    sourceButton.focus();
    expect(sourceButton).toHaveFocus();
    fireEvent.click(sourceButton);
    fireEvent.click(screen.getByRole("button", { name: `Open result ${resultId}` }));
    fireEvent.click(screen.getByRole("button", { name: "Open job job-1" }));
    expect(onOpenSource).toHaveBeenCalledWith(sourceTarget);
    expect(onOpenResult).toHaveBeenCalledWith(result);
    expect(onOpenJob).toHaveBeenCalledWith(job);
    fireEvent.click(screen.getByText("Exact source target"));
    expect(screen.getByText(/x 2, y 3, width 10, height 12/)).toBeVisible();
    expect(screen.getAllByText(sourceHash)[0]).toBeVisible();
  });

  it("disables stale, missing and unverified workflow references with visible reasons", () => {
    const callback = vi.fn();
    render(<AgentTargetLinks snapshot={snapshot} navigation={{ onOpenSource: callback, onOpenResult: callback, onOpenWorkflow: callback }} targets={[
      { ...sourceTarget, sha256: "f".repeat(64) },
      { kind: "result", id: resultId, revision_hash: "f".repeat(64) },
      { kind: "source", id: "missing" },
      { kind: "workflow", id: "historical-workflow", revision: 3 },
    ]} />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getAllByText(/Stale ·/)).toHaveLength(2);
    expect(screen.getAllByText(/Unavailable ·/)).toHaveLength(2);
    expect(callback).not.toHaveBeenCalled();
  });

  it("uses supplied workflow revision metadata and blocks stale snapshot navigation", () => {
    const target: ResearchAgentTargetReference = { kind: "workflow", id: "workflow", revision: 2 };
    const onOpenWorkflow = vi.fn();
    const { rerender } = render(<AgentTargetLinks snapshot={snapshot} targets={[target]} navigation={{ currentTargets: [target], onOpenWorkflow }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open workflow workflow" }));
    expect(onOpenWorkflow).toHaveBeenCalledWith(target);
    rerender(<AgentTargetLinks snapshot={snapshot} targets={[target]} navigation={{ currentTargets: [target], onOpenWorkflow }} unavailable />);
    expect(screen.getByRole("button", { name: "Open workflow workflow" })).toBeDisabled();
  });

  it("offers stored-preview inspection only for a confirmed succeeded preview job", () => {
    const onInspectPreview = vi.fn();
    const target: ResearchAgentTargetReference = { kind: "job", id: "job-1" };
    const navigation = { onInspectPreview, inspectablePreviewJobIds: [target.id] };
    const { rerender } = render(<AgentTargetLinks snapshot={snapshot} targets={[target]} navigation={navigation} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect preview job-1" }));
    expect(onInspectPreview).toHaveBeenCalledWith(target);
    rerender(<AgentTargetLinks snapshot={{ ...snapshot, jobs: [{ ...snapshot.jobs[0], state: "running" }] }} targets={[target]} navigation={navigation} />);
    expect(screen.queryByRole("button", { name: "Inspect preview job-1" })).not.toBeInTheDocument();
    rerender(<AgentTargetLinks snapshot={snapshot} targets={[target]} navigation={{ onInspectPreview }} />);
    expect(screen.queryByRole("button", { name: "Inspect preview job-1" })).not.toBeInTheDocument();
  });
});

describe("AgentActivityTimeline", () => {
  it("bounds events at 12 and preserves recorded actor, time and status without inferring success", () => {
    const events = Array.from({ length: 14 }, (_, index) => event({ id: String(index), summary: `Activity ${index}`, actor: index ? "agent" : "human", kind: "approval_denied" }));
    render(<AgentActivityTimeline events={events} approvals={[]} snapshot={snapshot} />);
    expect(screen.getByText("Showing the latest 12 of 14 recorded events.")).toBeVisible();
    expect(screen.queryByText("Activity 12")).not.toBeInTheDocument();
    expect(screen.getByText("human")).toBeVisible();
    expect(screen.getAllByText("approval denied")).toHaveLength(12);
    expect(document.querySelector("time")).toHaveAttribute("datetime", "2026-10-27T00:00:00Z");
  });

  it("keeps legacy targetless events and missing approval records inspectable", () => {
    render(<AgentActivityTimeline events={[event({ targets: undefined, approval_id: "removed-request", timestamp: "invalid" })]} approvals={[]} snapshot={snapshot} />);
    expect(screen.getByText("Exact source inspected")).toBeVisible();
    expect(screen.getByText("No target recorded.")).toBeVisible();
    expect(screen.getByText("Time unavailable")).toBeVisible();
    expect(screen.getByText("Request details unavailable · removed-request")).toBeVisible();
  });

  it.each(["denied", "expired"] as const)("inspects %s requests with their exact identity and decision", (state) => {
    const approval = { ...wire.approvals[0], state, decision_reason: "The selected revision changed", decided_by: "human" };
    render(<AgentActivityTimeline events={[event({ approval_id: approval.id })]} approvals={[approval]} snapshot={snapshot} />);
    fireEvent.click(screen.getByText(`Inspect request · ${state}`));
    expect(screen.getByText("The selected revision changed")).toBeVisible();
    fireEvent.click(screen.getByText("Request identity and parameters"));
    expect(screen.getByText(approval.request_hash)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });

  it("explains the single-request consequence and shows exact display revision and parameters", () => {
    const approval = { ...wire.approvals[0], display_revision: 7 };
    render(<AgentApprovalDetails approval={approval} snapshot={snapshot} />);
    expect(screen.getByText(/Approve once authorizes this exact request/)).toBeVisible();
    fireEvent.click(screen.getByText("Request identity and parameters"));
    const details = screen.getByText("Request identity and parameters").parentElement!;
    expect(within(details).getByText("7")).toBeVisible();
    expect(within(details).getByText(approval.request_hash)).toBeVisible();
    expect(within(details).getByText(/"disposition": "reviewed"/)).toBeVisible();
  });
});
