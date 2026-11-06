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
  it("verifies job evidence against its stable request hash while the job state changes", () => {
    const onOpenJob = vi.fn();
    const jobTarget: ResearchAgentTargetReference = { kind: "job", id: "job-1", sha256: snapshot.jobs[0].request_hash };
    const { rerender } = render(<AgentTargetLinks targets={[jobTarget]} snapshot={snapshot} navigation={{ onOpenJob }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open job job-1" }));
    expect(onOpenJob).toHaveBeenCalledWith(jobTarget);
    rerender(<AgentTargetLinks targets={[jobTarget]} snapshot={{ ...snapshot, jobs: [{ ...snapshot.jobs[0], state: "failed" }] }} navigation={{ onOpenJob }} />);
    expect(screen.getByRole("button", { name: "Open job job-1" })).toBeEnabled();
    rerender(<AgentTargetLinks targets={[{ ...jobTarget, sha256: "f".repeat(64) }]} snapshot={snapshot} navigation={{ onOpenJob }} />);
    expect(screen.getByRole("button", { name: "Open job job-1" })).toBeDisabled();
    expect(screen.getByText(/Stale ·/)).toBeVisible();
  });
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
  it("uses the initial detail preference but preserves manual collapse through refreshes", () => {
    const props = { events: [event()], approvals: [], snapshot };
    const view = render(<AgentActivityTimeline {...props} defaultExpanded />);
    const record = screen.getByText(/Recorded activity/).closest("details")!;
    expect(record.open).toBe(true);
    record.open = false; fireEvent(record, new Event("toggle"));
    view.rerender(<AgentActivityTimeline {...props} events={[event({ summary: "Refreshed event" }), event({ id: "new-event" })]} defaultExpanded />);
    const records = screen.getAllByText(/Recorded activity/).map(item => item.closest("details")!);
    expect(records[0].open).toBe(false); expect(records[1].open).toBe(true);
  });
  it("bounds events at 12 and preserves recorded actor, time and status without inferring success", () => {
    const events = Array.from({ length: 14 }, (_, index) => event({ id: String(index), summary: `Activity ${index}`, actor: index ? "agent" : "human", kind: "approval_denied" }));
    render(<AgentActivityTimeline events={events} approvals={[]} snapshot={snapshot} />);
    expect(screen.getByText("Showing the latest 12 of 14 recorded events.")).toBeVisible();
    expect(screen.queryByText("Activity 12")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByText(/Recorded activity/)[0]);
    expect(screen.getByText("human")).toBeVisible();
    expect(screen.getAllByText("approval denied")).toHaveLength(12);
    expect(document.querySelector("time")).toHaveAttribute("datetime", "2026-10-27T00:00:00Z");
  });

  it("keeps legacy targetless events and missing approval records inspectable", () => {
    render(<AgentActivityTimeline events={[event({ targets: undefined, approval_id: "removed-request", timestamp: "invalid" })]} approvals={[]} snapshot={snapshot} />);
    expect(screen.getByText("Exact source inspected")).toBeVisible();
    expect(screen.getByText("No target recorded.")).toBeVisible();
    expect(screen.getAllByText("Time unavailable")[0]).toBeVisible();
    expect(screen.getByText("Request details unavailable · removed-request")).toBeVisible();
  });

  it.each(["denied", "expired"] as const)("inspects %s requests with their exact identity and decision", (state) => {
    const approval = { ...wire.approvals[0], state, decision_reason: "The selected revision changed", decided_by: "human" };
    render(<AgentActivityTimeline events={[event({ approval_id: approval.id })]} approvals={[approval]} snapshot={snapshot} />);
    fireEvent.click(screen.getByText(`Inspect request · ${state}`));
    fireEvent.click(screen.getByText("Exact request and provenance"));
    expect(screen.getByText("The selected revision changed")).toBeVisible();
    fireEvent.click(screen.getByText("Request identity and parameters"));
    expect(screen.getByText(approval.request_hash)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });

  it("explains the single-request consequence and shows exact display revision and parameters", () => {
    const approval = { ...wire.approvals[0], display_revision: 7 };
    render(<AgentApprovalDetails approval={approval} snapshot={snapshot} />);
    expect(screen.getByText(/Approve once authorizes this exact request/)).toBeVisible();
    fireEvent.click(screen.getByText("Exact request and provenance"));
    fireEvent.click(screen.getByText("Request identity and parameters"));
    const details = screen.getByText("Request identity and parameters").parentElement!;
    expect(within(details).getByText("7")).toBeVisible();
    expect(within(details).getByText(approval.request_hash)).toBeVisible();
    expect(within(details).getByText(/"disposition": "reviewed"/)).toBeVisible();
  });

  it("distinguishes proposal, submission, approval and completion while preserving exact session records", () => {
    const events = [
      event({ id: "proposal", kind: "operation_proposed", operation: "submit_recipe", session_id: "session-a", summary: "Validated proposal for submit_recipe." }),
      event({ id: "submitted", kind: "operation_submitted", operation: "submit_recipe", session_id: "session-b", summary: "Submitted submit_recipe." }),
      event({ id: "approved", kind: "approval_approved", summary: "Approval recorded." }),
      event({ id: "call", kind: "operation_completed", operation: "review_result", summary: "Completed call to review_result." }),
      event({ id: "unknown", kind: "future_event", summary: "Original future summary" }),
    ];
    render(<AgentActivityTimeline events={events} approvals={[]} snapshot={snapshot} />);
    expect(screen.getByText("Proposal validated · analysis")).toBeVisible();
    expect(screen.getByText("Submitted · analysis")).toBeVisible();
    expect(screen.getByText("Approved once · awaiting execution")).toBeVisible();
    expect(screen.getByText("Completed call · result review")).toBeVisible();
    expect(screen.getByText("Original future summary")).toBeVisible();
    expect(document.querySelectorAll(".agent-activity-list > li")).toHaveLength(5);
    fireEvent.click(screen.getAllByText(/Recorded activity/)[0]);
    expect(screen.getByText("session-a")).toBeVisible();
    expect(screen.getByText("Validated proposal for submit_recipe.")).toBeVisible();
  });

  it("places the recorded result first and retains other targets and original provenance in disclosures", () => {
    const result: ResearchAgentTargetReference = { kind: "result", id: resultId, revision_hash: revision, source_id: sourceId, source_sha256: sourceHash };
    render(<AgentActivityTimeline events={[event({ kind: "operation_completed", operation: "review_result", targets: [sourceTarget, result] })]} approvals={[]} snapshot={snapshot}
      navigation={{ onOpenResult: vi.fn(), onOpenSource: vi.fn() }} />);
    expect(screen.getByRole("button", { name: `Open result ${resultId}` })).toBeVisible();
    expect(screen.getByRole("button", { name: `Open source ${sourceId}` })).not.toBeVisible();
    expect(screen.getByText(`Source · result ${resultId.slice(0, 8)} · rev ${revision.slice(0, 8)}`)).toBeVisible();
    fireEvent.click(screen.getByText(/Recorded activity/));
    expect(screen.getByRole("button", { name: `Open source ${sourceId}` })).toBeVisible();
  });

  it("opens the verified output of a completed job before its recorded input dependencies", () => {
    const jobId = "1".repeat(32), outputId = "2".repeat(32), outputRevision = "3".repeat(64);
    const input: ResearchAgentTargetReference = { kind: "result", id: resultId, revision_hash: revision, source_id: sourceId, source_sha256: sourceHash };
    const output: ResearchAgentTargetReference = { ...input, id: outputId, revision_hash: outputRevision };
    const job: ResearchAgentTargetReference = { kind: "job", id: jobId };
    const completed = event({ kind: "operation_completed", operation: "annotation_evaluation_run",
      summary: "Job 11111111 succeeded.", targets: [job, sourceTarget, input, output] });
    const live: ResearchSnapshot = { ...snapshot,
      results: [...snapshot.results, { ...snapshot.results[0], id: outputId, revision_hash: outputRevision, kind: "annotation-agreement" }],
      jobs: [{ ...snapshot.jobs[0], id: jobId, operation: "annotation_evaluation_run", result_ids: [outputId] }] };
    const onOpenResult = vi.fn();
    render(<AgentActivityTimeline events={[completed]} approvals={[]} snapshot={live} navigation={{ onOpenResult, onOpenJob: vi.fn() }} />);
    expect(screen.getByText("Completed · annotation agreement")).toBeVisible();
    expect(screen.getByRole("button", { name: `Open result ${input.id}` })).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: `Open result ${outputId}` }));
    expect(onOpenResult).toHaveBeenCalledWith(output);
    expect(screen.getByText(`Source · result ${outputId.slice(0, 8)} · rev ${outputRevision.slice(0, 8)}`)).toBeVisible();
    fireEvent.click(screen.getByText(/Recorded activity/));
    expect(screen.getByText(completed.summary)).toBeVisible();
    expect(screen.getByRole("button", { name: `Open result ${input.id}` })).toBeVisible();
  });

  it.each(["missing-job", "missing-output", "wrong-operation", "stale-output"])("does not substitute an input when a job output is %s", (mode) => {
    const jobId = "1".repeat(32), outputId = "2".repeat(32);
    const input: ResearchAgentTargetReference = { kind: "result", id: resultId, revision_hash: revision };
    const output: ResearchAgentTargetReference = { kind: "result", id: outputId, revision_hash: "3".repeat(64) };
    const job: ResearchAgentTargetReference = { kind: "job", id: jobId };
    const completed = event({ kind: "operation_completed", operation: "annotation_evaluation_run", summary: "Job 11111111 succeeded.",
      targets: [job, input, ...(mode === "missing-output" ? [] : [output])] });
    const live: ResearchSnapshot = { ...snapshot,
      results: [...snapshot.results, { ...snapshot.results[0], id: outputId }],
      jobs: mode === "missing-job" ? [] : [{ ...snapshot.jobs[0], id: jobId,
        operation: mode === "wrong-operation" ? "run_recipe" : "annotation_evaluation_run", result_ids: [outputId] }] };
    const onOpenResult = vi.fn();
    render(<AgentActivityTimeline events={[completed]} approvals={[]} snapshot={live} navigation={{ onOpenResult, onOpenJob: vi.fn() }} />);
    expect(screen.getByRole("button", { name: `Open result ${input.id}` })).not.toBeVisible();
    if (mode === "stale-output") {
      const button = screen.getByRole("button", { name: `Open result ${outputId}` });
      expect(button).toBeVisible(); expect(button).toBeDisabled(); fireEvent.click(button);
    } else expect(screen.getByRole("button", { name: `Open job ${jobId}` })).toBeVisible();
    expect(onOpenResult).not.toHaveBeenCalled();
  });

  it.each([
    ["annotation_evaluation_get", "annotation agreement"],
    ["method_query", "method measurements"],
    ["method_preflight", "method input check"],
  ])("names the actual %s action without claiming job completion", (operation, label) => {
    render(<AgentActivityTimeline events={[event({ kind: "operation_inspected", operation })]} approvals={[]} snapshot={snapshot} />);
    expect(screen.getByText(`Inspected · ${label}`)).toBeVisible();
    expect(screen.queryByText(/^Completed/)).not.toBeInTheDocument();
  });

});
