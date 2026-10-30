// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot } from "../shared/research-contracts";
import type { GraphBindings, GraphPlan, GraphRun, GraphStatus, GraphWorkflow } from "../shared/workflow-graph-contracts";
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
