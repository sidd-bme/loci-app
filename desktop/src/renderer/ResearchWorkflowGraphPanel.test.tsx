// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot } from "../shared/research-contracts";
import type { GraphBindings, GraphContinuation, GraphPreparedPreviewBinding, GraphPlan, GraphRun, GraphStatus, GraphWorkflow } from "../shared/workflow-graph-contracts";
import { ResearchWorkflowGraphPanel, type ResearchWorkflowGraphPanelProps } from "./ResearchWorkflowGraphPanel";

afterEach(cleanup);
const sid = "a".repeat(32), wid = "b".repeat(32), rid = "c".repeat(32), jid = "d".repeat(32), resultId = "e".repeat(32), hash = "1".repeat(64);
const selection = { x: 0, y: 0, width: 10, height: 8, t: 0, c: 0, z: 0, level: 0 };
const source = { id: sid, sha256: hash, name: "Technical field.tif", metadata: { dimensions: { x: 10, y: 8, t: 1, z: 1, c: 1 } } };
const workflow: GraphWorkflow = { id: wid, revision: 1, kind: "workflow", data: { schema: "loci.saved-workflow/v2", definition_sha256: hash, definition: { schema: "loci.workflow/v2", name: "Saved segmentation", inputs: { image: "source-selection" }, nodes: [{ id: "labels", operation: "run_recipe", contract_version: 1, inputs: { source: { input: "image" } }, settings: { recipe: { segmentation: { threshold: 50 }, measurement_channels: [0] } } }], outputs: { labels: { node: "labels", port: "result" } }, working_bytes: 16777216 } } };
const bindings: GraphBindings = { image: { source_id: sid, source_sha256: hash, selection } };
const plan: GraphPlan = { schema: "loci.workflow-plan/v2", definition: workflow.data.definition, definition_sha256: hash, bindings, bindings_sha256: hash, plan_sha256: hash, node_order: ["labels"], node_scopes: { labels: { source_id: sid, source_sha256: hash, selection, geometry: {}, shape: [8, 10] } }, runtime: {}, adapter_versions: { run_recipe: 1 } };
const result: ResearchResult = { id: resultId, revision_hash: hash, source_id: sid, source_sha256: hash, kind: "segmentation", object_count: 1, created_at: "2026-10-30", arrays: { labels: {} } };
const snapshot = { project: { project_id: "f".repeat(32), title: "Study" }, sources: [source], results: [result], jobs: [], samples: [], recipes: [], displays: [], selections: [], operations: {} } as ResearchSnapshot;
function run(state: GraphRun["data"]["state"] = "prepared", owner: GraphRun["data"]["owner"] = null): GraphRun {
  return { id: rid, kind: "workflow_run", revision: 1, data: { schema: "loci.workflow-run/v2", workflow_id: wid, workflow_revision: 1, definition_sha256: hash, project_id: snapshot.project.project_id!, plan, owner, state, cancel_requested: false, run_sha256: hash, outputs: {}, nodes: { labels: { state: state === "succeeded" ? "succeeded" : "pending", intent: state === "succeeded" ? { operation: "run_recipe", request: {}, request_sha256: hash, request_key: `graph-v2:${rid}:labels`, job_id: jid } : null, output: state === "succeeded" ? { result_id: resultId, revision_hash: hash } : null } } } };
}
function continuation(parent = run("failed")): GraphContinuation {
  return { schema: "loci.workflow-continuation/v1", run_id: parent.id, run_revision: parent.revision, run_sha256: parent.data.run_sha256,
    continuation_sha256: "2".repeat(64), owner: parent.data.owner, workflow_id: parent.data.workflow_id, workflow_revision: parent.data.workflow_revision,
    definition_sha256: parent.data.definition_sha256, plan_sha256: parent.data.plan.plan_sha256, request_key: "old-request", state: parent.data.state,
    completed_nodes: [], completed_outputs: {}, uncompleted_nodes: ["labels"], proposal: { definition: parent.data.plan.definition, definition_sha256: hash, bindings },
    can_start_fresh: true, unavailable_reason: null, required_fresh_previews: [], native_approval_required: true, authority: "Fresh native approval" };
}
const preparedPreview: GraphPreparedPreviewBinding = { preview_id: "7".repeat(32), preview_hash: "8".repeat(64),
  receipt: { schema: "loci.puma-tissue-preview/v1", request: { source_id: sid, source_sha256: hash, context_selection: selection, output_selection: selection } } };
const status = (value: GraphRun): GraphStatus => ({ run: value, state: value.data.state, partial_results: [] });
function mount(overrides: Partial<ResearchWorkflowGraphPanelProps> = {}, response?: (op: string, body: Record<string, unknown>) => unknown) {
  const execute = vi.fn(async (op: string, body: Record<string, unknown>) => {
    const custom = response?.(op, body); if (custom !== undefined) return custom;
    if (op === "workflow_graph_list") return { workflows: [workflow] };
    if (op === "workflow_graph_runs") return { runs: [] };
    if (op === "workflow_graph_preflight") return { workflow, plan: { ...plan, bindings: body.bindings } };
    if (op === "workflow_graph_start") return status(run());
    if (op === "workflow_graph_advance" || op === "workflow_graph_status") return status(run("succeeded"));
    if (op === "workflow_graph_cancel") return status(run("cancelled"));
    throw new Error(op);
  });
  const props = { api: { execute } as unknown as ResearchDesktopApi, snapshot, sourceId: sid, selection, active: true, busy: false, onBusyChange: vi.fn(), onOpenResult: vi.fn(), onRefresh: vi.fn(), ...overrides };
  return { ...render(<ResearchWorkflowGraphPanel {...props} />), props, execute };
}
async function choose() { await screen.findByRole("option", { name: "Saved segmentation · revision 1" }); fireEvent.change(screen.getByRole("combobox", { name: "Saved composed workflow" }), { target: { value: wid } }); fireEvent.change(screen.getByRole("combobox", { name: "Workflow input image" }), { target: { value: sid } }); }
async function preflight() { fireEvent.click(screen.getByRole("button", { name: "Check inputs" })); await screen.findByText("Inputs and native settings checked. Ready to run."); }

describe("Composed workflows", () => {
  it("inspects stopped work and explicitly prepares a fresh run without advancing it", async () => {
    const parent = run("failed", { policy_sha256: hash, session_id: sid });
    const receipt = continuation(parent);
    const app = mount({}, (op, body) => {
      if (op === "workflow_graph_runs") return { runs: [parent] };
      if (op === "workflow_graph_continuation") return { continuation: receipt };
      if (op === "workflow_graph_continue") { const fresh = run(); fresh.id = "9".repeat(32); fresh.data.workflow_id = body.workflow_id as string;
        fresh.data.continuation = receipt; return status(fresh); }
    });
    await screen.findByRole("option", { name: /failed · agent-owned/ });
    fireEvent.change(screen.getByLabelText("Saved composed run"), { target: { value: rid } });
    expect(screen.queryByRole("button", { name: "Prepare fresh run" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect continuation" }));
    await screen.findByText("0 completed steps retained · 1 remaining");
    expect(app.execute.mock.calls.some(([op]) => op === "workflow_graph_continue")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Prepare fresh run" }));
    await screen.findByText("Fresh continuation prepared. Advance workflow when you are ready; no step has started.");
    expect(screen.getByRole("heading", { name: "Inputs for a new run" })).toBeVisible();
    expect(screen.getByText("These choices do not change the saved run below.")).toBeVisible();
    expect(screen.getByText("Saved run input bindings")).toBeVisible();
    expect(app.execute).toHaveBeenCalledWith("workflow_graph_continue", expect.objectContaining({ run_id: rid, run_revision: 1,
      run_sha256: hash, continuation_sha256: receipt.continuation_sha256, workflow_id: expect.stringMatching(/^[a-f0-9]{32}$/), request_key: expect.any(String) }));
    expect(app.execute.mock.calls.some(([op]) => op === "workflow_graph_advance")).toBe(false);
    expect(screen.getByRole("button", { name: "Advance workflow" })).toBeEnabled();
  });
  it("rejects continuation receipts from a different saved revision", async () => {
    mount({}, op => op === "workflow_graph_runs" ? { runs: [run("failed")] }
      : op === "workflow_graph_continuation" ? { continuation: { ...continuation(), run_revision: 2 } } : undefined);
    await screen.findByRole("option", { name: `${rid.slice(0, 8)} · failed` });
    fireEvent.change(screen.getByLabelText("Saved composed run"), { target: { value: rid } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect continuation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("differs from this exact saved run");
    expect(screen.queryByRole("button", { name: "Prepare fresh run" })).not.toBeInTheDocument();
  });
  it("requires a fresh native preview for tissue continuation and never substitutes a label result", async () => {
    const receipt = continuation(); receipt.required_fresh_previews = ["tissue"];
    receipt.proposal!.definition = { ...workflow.data.definition, inputs: { tissue: "tissue-preview" } };
    const app = mount({}, op => op === "workflow_graph_runs" ? { runs: [run("failed")] }
      : op === "workflow_graph_continuation" ? { continuation: receipt }
        : op === "workflow_graph_prepared_previews" ? { previews: [], unavailable_count: 1 } : undefined);
    await screen.findByRole("option", { name: `${rid.slice(0, 8)} · failed` });
    fireEvent.change(screen.getByLabelText("Saved composed run"), { target: { value: rid } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect continuation" }));
    await screen.findByText("1 retained preview is unavailable or already used.");
    expect(screen.getByLabelText("Continuation preview tissue").querySelectorAll("option")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Prepare fresh run" })).toBeDisabled();
    expect(app.execute.mock.calls.some(([op]) => op === "workflow_graph_continue")).toBe(false);
  });
  it("binds a discovered preview with its exact receipt and rejects cross-source discovery", async () => {
    const tissueWorkflow = { ...workflow, data: { ...workflow.data, definition: { ...workflow.data.definition, inputs: { tissue: "tissue-preview" as const } } } };
    let wrong = false;
    const app = mount({}, (op, body) => {
      if (op === "workflow_graph_list") return { workflows: [tissueWorkflow] };
      if (op === "workflow_graph_prepared_previews") return { previews: [{ ...preparedPreview, receipt: { ...preparedPreview.receipt,
        request: { ...preparedPreview.receipt.request, source_sha256: wrong ? "9".repeat(64) : hash } } }], unavailable_count: 0 };
      if (op === "workflow_graph_preflight") return { plan: { ...plan, definition: tissueWorkflow.data.definition, bindings: body.bindings } };
    });
    await screen.findByRole("option", { name: "Saved segmentation · revision 1" });
    fireEvent.change(screen.getByLabelText("Saved composed workflow"), { target: { value: wid } });
    await screen.findByRole("option", { name: /preview 77777777/ });
    fireEvent.change(screen.getByLabelText("Workflow input tissue"), { target: { value: `${preparedPreview.preview_id}:${preparedPreview.preview_hash}` } });
    fireEvent.click(screen.getByRole("button", { name: "Check inputs" }));
    await screen.findByText("Inputs and native settings checked. Ready to run.");
    expect(app.execute).toHaveBeenCalledWith("workflow_graph_preflight", expect.objectContaining({ bindings: { tissue: preparedPreview } }));
    wrong = true; fireEvent.click(screen.getByRole("button", { name: "Refresh prepared previews" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("different source revision");
    expect(screen.getByRole("button", { name: "Check inputs" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run composed workflow" })).toBeDisabled();
  });
  it("saves only a successful exact run as a new reusable definition without executing it", async () => {
    const app = mount({}, (op, body) => {
      if (op === "workflow_graph_runs") return { runs: [run("succeeded")] };
      if (op === "workflow_graph_save_from_run") return { workflow: { ...workflow, id: body.workflow_id,
        data: { ...workflow.data, definition: { ...workflow.data.definition, name: body.name } } } };
    });
    await screen.findByRole("option", { name: `${rid.slice(0, 8)} · succeeded` });
    fireEvent.change(screen.getByLabelText("Saved composed run"), { target: { value: rid } });
    fireEvent.change(screen.getByLabelText("Reusable workflow name"), { target: { value: "Reviewed segmentation steps" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as workflow" }));
    await screen.findByText("Saved Reviewed segmentation steps. Choose its inputs before running it again.");
    expect(app.execute).toHaveBeenCalledWith("workflow_graph_save_from_run", { run_id: rid, run_revision: 1,
      run_sha256: hash, workflow_id: expect.stringMatching(/^[a-f0-9]{32}$/), expected_revision: 0, name: "Reviewed segmentation steps" });
    expect(app.execute.mock.calls.some(([op]) => ["workflow_graph_start", "workflow_graph_advance"].includes(op))).toBe(false);
    expect(screen.getByRole("option", { name: "Reviewed segmentation steps · revision 1" })).toBeInTheDocument();
  });
  it("rejects a saved definition that changes the successful run settings", async () => {
    mount({}, (op, body) => {
      if (op === "workflow_graph_runs") return { runs: [run("succeeded")] };
      if (op === "workflow_graph_save_from_run") return { workflow: { ...workflow, id: body.workflow_id,
        data: { ...workflow.data, definition: { ...workflow.data.definition, name: body.name, working_bytes: 1 } } } };
    });
    await screen.findByRole("option", { name: `${rid.slice(0, 8)} · succeeded` });
    fireEvent.change(screen.getByLabelText("Saved composed run"), { target: { value: rid } });
    fireEvent.click(screen.getByRole("button", { name: "Save as workflow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match the exact successful run");
    expect(screen.getByLabelText("Reusable workflow name")).toHaveValue("Saved segmentation copy");
  });
  it("never offers saving an incomplete run as a successful workflow", async () => {
    mount({}, op => op === "workflow_graph_runs" ? { runs: [run("running")] } : undefined);
    await screen.findByRole("option", { name: `${rid.slice(0, 8)} · running` });
    fireEvent.change(screen.getByLabelText("Saved composed run"), { target: { value: rid } });
    expect(screen.queryByRole("button", { name: "Save as workflow" })).not.toBeInTheDocument();
  });
  it("binds explicit source selection, runs through native advance and opens the exact result", async () => {
    const app = mount(); await choose();
    expect(screen.getByRole("button", { name: "Run composed workflow" })).toBeDisabled();
    await preflight(); fireEvent.click(screen.getByRole("button", { name: "Run composed workflow" }));
    await screen.findByText("Run complete");
    expect(app.execute).toHaveBeenCalledWith("workflow_graph_preflight", { workflow_id: wid, workflow_revision: 1, definition_sha256: hash, bindings });
    expect(app.execute).toHaveBeenCalledWith("workflow_graph_advance", { run_id: rid });
    fireEvent.click(screen.getByRole("button", { name: "Open result" }));
    expect(app.props.onOpenResult).toHaveBeenCalledWith(result);
  });
  it("invalidates checked plans when the region changes and rejects delayed preflight", async () => {
    let finish!: (value: unknown) => void;
    const app = mount({}, (op) => op === "workflow_graph_preflight" ? new Promise((resolve) => { finish = resolve; }) : undefined);
    await choose(); fireEvent.click(screen.getByRole("button", { name: "Check inputs" }));
    await waitFor(() => expect(finish).toBeDefined());
    app.rerender(<ResearchWorkflowGraphPanel {...app.props} selection={{ ...selection, x: 1, width: 9 }} />);
    await act(async () => finish({ plan }));
    expect(screen.getByRole("button", { name: "Run composed workflow" })).toBeDisabled();
    expect(screen.queryByText("Inputs and native settings checked. Ready to run.")).not.toBeInTheDocument();
  });
  it("restores agent-owned saved state without acquiring control or native job ownership", async () => {
    const agentRun = run("running", { policy_sha256: hash, session_id: sid });
    const app = mount({}, (op) => op === "workflow_graph_runs" ? { runs: [agentRun] } : undefined);
    await screen.findByRole("option", { name: /agent-owned/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Saved composed run" }), { target: { value: rid } });
    expect(screen.getByText(/Continue or cancel it through its authorized agent session/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Advance workflow" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel composed run" })).not.toBeInTheDocument();
    expect(app.execute.mock.calls.some(([op]) => op === "workflow_graph_advance")).toBe(false);
  });
  it("rejects late library responses from a different study", async () => {
    let finish!: (value: unknown) => void;
    const app = mount({}, (op) => op === "workflow_graph_list" ? new Promise((resolve) => { finish = resolve; }) : undefined);
    const oldFinish = finish;
    app.rerender(<ResearchWorkflowGraphPanel {...app.props} snapshot={{ ...snapshot, project: { title: "Other", project_id: "9".repeat(32) } }} />);
    await act(async () => oldFinish({ workflows: [workflow] }));
    expect(screen.queryByRole("option", { name: "Saved segmentation · revision 1" })).not.toBeInTheDocument();
  });
  it("refreshes saved definition revisions and invalidates an earlier preflight", async () => {
    let revision = 1;
    mount({}, (op) => op === "workflow_graph_list" ? { workflows: [{ ...workflow, revision }] } : undefined);
    await choose(); await preflight(); revision = 2;
    fireEvent.click(screen.getByRole("button", { name: "Refresh composed workflows" }));
    await screen.findByText("Saved workflows refreshed. Check inputs before running.");
    expect(screen.getByRole("option", { name: "Saved segmentation · revision 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run composed workflow" })).toBeDisabled();
  });
  it("allows cancellation while the exact native advance is pending", async () => {
    let finish!: (value: unknown) => void;
    const app = mount({}, (op) => op === "workflow_graph_advance" ? new Promise((resolve) => { finish = resolve; }) : undefined);
    await choose(); await preflight(); fireEvent.click(screen.getByRole("button", { name: "Run composed workflow" }));
    await waitFor(() => expect(finish).toBeDefined());
    const cancel = screen.getByRole("button", { name: "Cancel composed run" }); expect(cancel).toBeEnabled(); fireEvent.click(cancel);
    await waitFor(() => expect(app.execute).toHaveBeenCalledWith("workflow_graph_cancel", { run_id: rid }));
    await act(async () => finish(status(run("cancelled"))));
    expect(screen.getByText("Run cancelled")).toBeInTheDocument();
  });
  it("shows native errors and keeps Run disabled without an exact current plan", async () => {
    mount({}, (op) => { if (op === "workflow_graph_preflight") throw new Error("Source fingerprint changed"); });
    await choose(); fireEvent.click(screen.getByRole("button", { name: "Check inputs" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Source fingerprint changed");
    expect(screen.getByRole("button", { name: "Run composed workflow" })).toBeDisabled();
  });
});

describe("exact native agent composed workflow navigation", () => {
  const target = { kind: "workflow" as const, id: workflow.id, revision: workflow.revision, sha256: hash };
  it("renders the exact saved definition before acknowledging", async () => {
    const complete = vi.fn();
    mount({ agentNavigation: { requestId: "graph", target, version: 2, current: () => true }, onAgentNavigationComplete: complete },
      op => op === "workflow_graph_get" ? { workflow } : undefined);
    await waitFor(() => expect(complete).toHaveBeenCalledWith("graph"));
    expect(screen.getByRole("region", { name: "Composed workflows" })).toHaveAttribute("data-agent-workflow-id", workflow.id);
    expect(screen.getByRole("region", { name: "Composed workflows" })).toHaveAttribute("data-agent-workflow-sha256", hash);
  });
  it("preserves local input bindings instead of replacing them with an agent target", async () => {
    const complete = vi.fn(); const f = mount({ onAgentNavigationComplete: complete }); await choose();
    f.rerender(<ResearchWorkflowGraphPanel {...f.props} agentNavigation={{ requestId: "draft", target, version: 2, current: () => true }} />);
    await waitFor(() => expect(complete).toHaveBeenCalledWith("draft", expect.stringContaining("current composed-workflow inputs")));
    expect(screen.getByRole("combobox", { name: "Workflow input image" })).toHaveValue(sid);
    expect(f.execute).not.toHaveBeenCalledWith("workflow_graph_get", expect.anything());
  });
  it("rejects the same workflow ID with a different definition digest", async () => {
    const complete = vi.fn();
    mount({ agentNavigation: { requestId: "changed", target, version: 2, current: () => true }, onAgentNavigationComplete: complete },
      op => op === "workflow_graph_get" ? { workflow: { ...workflow, data: { ...workflow.data, definition_sha256: "9".repeat(64) } } } : undefined);
    await waitFor(() => expect(complete).toHaveBeenCalledWith("changed", expect.stringContaining("revision changed")));
    expect(screen.getByRole("region", { name: "Composed workflows" })).not.toHaveAttribute("data-agent-workflow-id");
  });
});
