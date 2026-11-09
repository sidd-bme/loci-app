// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchAgentTaskRecord, ResearchAgentTargetReference, ResearchSnapshot } from "../shared/research-contracts";
import { AgentTaskPanel } from "./AgentTaskPanel";

afterEach(cleanup);
const sourceId = "a".repeat(32), sourceHash = "b".repeat(64), resultId = "c".repeat(32), revision = "d".repeat(64);
const target: ResearchAgentTargetReference = { kind: "result", id: resultId, revision_hash: revision, source_id: sourceId, source_sha256: sourceHash };
const snapshot: ResearchSnapshot = { project: { title: "Synthetic study" }, sources: [{ id: sourceId, name: "Generated nuclei", sha256: sourceHash, metadata: {} }],
  results: [{ id: resultId, revision_hash: revision, source_id: sourceId, source_sha256: sourceHash, kind: "labels", created_at: "2026-11-06T00:00:00Z", object_count: 2 }],
  jobs: [], samples: [], recipes: [], displays: [], selections: [], operations: {} };
function task(overrides: Partial<ResearchAgentTaskRecord> = {}): ResearchAgentTaskRecord {
  return { id: "task-1", revision: 3, policy_sha256: "e".repeat(64), session_id: "session-1", client_id: "Codex",
    created_at: "2026-11-06T00:00:00Z", updated_at: "2026-11-06T00:01:00Z", updated_by: "agent", goal: "Inspect generated nuclei",
    state: "awaiting_review", stale: false, targets: [{ kind: "source", id: sourceId, sha256: sourceHash }],
    steps: [{ id: "inspect", title: "Inspect exact source", state: "complete", note: "Two candidate regions", targets: [] },
      { id: "review", title: "Assess the candidate masks", state: "in_progress", note: "", targets: [target] }],
    assessments: [{ id: "assessment-1", summary: "Two candidates are visible.", observations: ["One candidate touches the image edge."],
      limitations: ["Generated fixture; no biological accuracy claim."], targets: [target], created_at: "2026-11-06T00:01:00Z",
      session_id: "session-1", client_id: "Codex", stale: false }], ...overrides };
}
function setup(record = task(), control = vi.fn().mockResolvedValue(true)) {
  const navigation = { onOpenResult: vi.fn(), onReviewResult: vi.fn(), onOpenSource: vi.fn() };
  const props = { tasks: [record], snapshot, navigation, canControl: true, onControl: control };
  return { ...render(<AgentTaskPanel {...props} />), props, control, navigation };
}

describe("External agent task presentation", () => {
  it("restores a transferred draft and refuses to apply it to a newer task revision", () => {
    const record = task({ revision: 4 });
    const onChange = vi.fn(), control = vi.fn();
    render(<AgentTaskPanel tasks={[record]} snapshot={snapshot} canControl onControl={control}
      presentation={{ selectedTaskId: record.id, draft: { taskId: record.id, baseRevision: 3, goal: "Transferred human draft",
        steps: [{ id: "inspect", title: "My unfinished inspection" }] } }} onPresentationChange={onChange} />);
    expect(screen.getByLabelText("Goal")).toHaveValue("Transferred human draft");
    expect(screen.getByRole("button", { name: "Save plan" })).toBeDisabled();
    expect(screen.getByText(/task changed while you were editing/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
    expect(onChange).toHaveBeenCalledWith({ selectedTaskId: record.id, draft: null });
    expect(control).not.toHaveBeenCalled();
  });
  it("does not substitute a different task when the transferred draft target disappears", () => {
    render(<AgentTaskPanel tasks={[task({ id: "different-task" })]} snapshot={snapshot} canControl onControl={vi.fn()}
      presentation={{ selectedTaskId: "missing", draft: { taskId: "missing", baseRevision: 1, goal: "Unsaved original",
        steps: [{ id: "a", title: "Inspect original" }] } }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("cannot be applied to another task");
    expect(screen.queryByRole("button", { name: "Save plan" })).not.toBeInTheDocument();
  });
  it("keeps save and cancel before a long plan and cancels editing without changing the task", () => {
    const steps = Array.from({ length: 20 }, (_, index) => ({ id: `step-${index}`, title: `Inspect region ${index + 1}`, state: "planned" as const, note: "", targets: [] }));
    const { control } = setup(task({ steps }));
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    const actions = screen.getByRole("group", { name: "Plan editing actions" });
    expect(within(actions).getByRole("button", { name: "Save plan" })).toBeEnabled();
    const goal = screen.getByRole("textbox", { name: "Goal" });
    expect(actions.compareDocumentPosition(goal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(goal, { target: { value: "Unsaved replacement" } });
    fireEvent.click(within(actions).getByRole("button", { name: "Cancel editing" }));
    expect(screen.getByText("Inspect generated nuclei")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit plan" })).toHaveFocus();
    expect(control).not.toHaveBeenCalled();
  });
  it("offers stopping only an evidence-linked job with the exact task owner", async () => {
    const record = task();
    record.targets.push({ kind: "job", id: "job-1", sha256: "f".repeat(64) });
    const { props, rerender, control } = setup(record);
    const job = { id: "job-1", state: "running" as const, operation: "run_recipe", request: {}, request_key: "key", request_hash: "f".repeat(64),
      owner: { policy_sha256: record.policy_sha256, session_id: record.session_id }, created_at: "2026-11-06", updated_at: "2026-11-06",
      progress: 0, cancel_requested: false, result_ids: [], error: null };
    rerender(<AgentTaskPanel {...props} snapshot={{ ...snapshot, jobs: [job] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop job job-1" }));
    expect(control).toHaveBeenCalledWith({ action: "stop_job", job_id: "job-1", session_id: record.session_id });
    rerender(<AgentTaskPanel {...props} snapshot={{ ...snapshot, jobs: [{ ...job, owner: { ...job.owner, session_id: "other-session" } }] }} />);
    expect(screen.queryByRole("button", { name: "Stop job job-1" })).not.toBeInTheDocument();
    rerender(<AgentTaskPanel {...props} snapshot={{ ...snapshot, jobs: [{ ...job, request_hash: "0".repeat(64) }] }} />);
    expect(screen.queryByRole("button", { name: "Stop job job-1" })).not.toBeInTheDocument();
  });
  it("keeps agent-reported completion separate from execution and human result review", () => {
    const { navigation, control } = setup(task({ state: "complete" }));
    expect(screen.getAllByText("Reported complete")).toHaveLength(2);
    expect(screen.getByText(/Agent-reported plan/)).toBeVisible();
    expect(screen.getByText("Generated fixture; no biological accuracy claim.")).toBeVisible();
    expect(screen.getByText(/Scientific review is recorded on the result/)).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `Review result ${resultId}` }));
    expect(navigation.onReviewResult).toHaveBeenCalledWith(target);
    expect(control).not.toHaveBeenCalled();
  });
  it("edits and reorders titles using only the pinned task revision", async () => {
    const { control } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Inspect both regions" } });
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Check source borders" } });
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ action: "edit_task", task_id: "task-1", expected_revision: 3,
      goal: "Inspect both regions", steps: [{ id: "review", title: "Assess the candidate masks" }, { id: "inspect", title: "Check source borders" }] }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit agent plan" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Edit plan" })).toHaveFocus();
  });
  it("preserves a rejected draft and blocks overwriting a newer task revision", async () => {
    const { props, rerender, control } = setup(task(), vi.fn().mockResolvedValue(false));
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "My unsaved goal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await screen.findByText(/The plan was not saved/);
    expect(screen.getByLabelText("Goal")).toHaveValue("My unsaved goal");
    rerender(<AgentTaskPanel {...props} tasks={[task({ revision: 4, goal: "New agent goal" })]} />);
    expect(screen.getByText(/task changed while you were editing/)).toBeVisible();
    expect(screen.getByLabelText("Goal")).toHaveValue("My unsaved goal");
    expect(screen.getByRole("button", { name: "Save plan" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect(control).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
    expect(screen.getByText("New agent goal")).toBeVisible();
  });
  it("cancels only the exact plan and describes retained disconnected work without resuming it", () => {
    const { control } = setup();
    expect(screen.getByText(/Continuing requires an explicit resume/)).toBeVisible();
    expect(screen.getByText(/Cancelling this plan leaves running jobs active/)).toBeVisible();
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel plan" }));
    expect(control).toHaveBeenCalledExactlyOnceWith({ action: "cancel_task", task_id: "task-1", expected_revision: 3 });
  });
  it("blocks stale or unavailable evidence and never reviews a substituted current result", () => {
    const record = task({ stale: true });
    record.assessments[0].stale = true;
    record.assessments[0].targets = [{ ...target, revision_hash: "f".repeat(64) }];
    const { navigation, rerender, props } = setup(record);
    expect(screen.getByRole("button", { name: "Edit plan" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel plan" })).toBeEnabled();
    expect(screen.getByText(/Some evidence has changed/)).toBeVisible();
    expect(screen.getByRole("button", { name: `Review result ${resultId}` })).toBeDisabled();
    expect(navigation.onReviewResult).not.toHaveBeenCalled();
    rerender(<AgentTaskPanel {...props} tasks={[task()]} unavailable />);
    expect(screen.getByRole("button", { name: `Review result ${resultId}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel plan" })).toBeDisabled();
  });
  it("keeps history readable and pins the selected task while editing", () => {
    const { props, rerender } = setup();
    const newer = task({ id: "task-2", session_id: "session-2", goal: "Another task", updated_at: "2026-11-06T00:02:00Z" });
    rerender(<AgentTaskPanel {...props} tasks={[props.tasks[0], newer]} sessionId="session-1" />);
    expect(screen.getByLabelText("Task")).toHaveValue("task-1");
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    expect(screen.getByLabelText("Task")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "task-2" } });
    expect(screen.getByText("Another task")).toBeVisible();
  });
  it("bounds step editing and preserves IDs when removing a step", async () => {
    const { control } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    expect(screen.getByLabelText("Goal")).toHaveAttribute("maxlength", "2000");
    expect(screen.getByLabelText("Step 1")).toHaveAttribute("maxlength", "240");
    fireEvent.click(screen.getByRole("button", { name: "Remove step 1" }));
    expect(screen.getByRole("button", { name: "Remove step 1" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith(expect.objectContaining({ steps: [{ id: "review", title: "Assess the candidate masks" }] })));
  });
  it("shows no task surface when no external agent has authored a task", () => {
    const { container } = render(<AgentTaskPanel tasks={[]} snapshot={snapshot} canControl onControl={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
