// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchWorkflowPanel, type ResearchWorkflowPanelProps } from "./ResearchWorkflowPanel";
import { workflowFromRecipe, type WorkflowDefinition, type WorkflowRecord } from "./workflow-editor";
import type { ResearchBatchTask, ResearchDesktopApi, ResearchJob, ResearchRecipe, ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";
const source: ResearchSource = { id: "1".repeat(32), sha256: "a".repeat(64), name: "Research field.tif", metadata: { dimensions: { x: 32, y: 32, c: 1, z: 1, t: 1 }, axes: "YX" } };
const selection: ResearchSelection = { x: 0, y: 0, width: 32, height: 32, c: 0, z: 0, t: 0, level: 0 };
const recipe: ResearchRecipe = { steps: [{ op: "gaussian", sigma: .5 }], segmentation: { method: "components", threshold: 100, min_size: 2, polarity: "bright", exclude_border: false }, measurement_channels: [0], gates: [], working_bytes: 512 * 1024 ** 2 };
const result: ResearchResult = { id: "2".repeat(32), source_id: source.id, source_sha256: source.sha256, revision_hash: "b".repeat(64), object_count: 12, kind: "segmentation", created_at: "2026-10-03", selection };
const hash = "c".repeat(64), runId = "3".repeat(32);
function setup(overrides: Partial<ResearchWorkflowPanelProps> = {}, custom?: (operation: string, request: Record<string, unknown>, normal: () => unknown) => unknown) {
  let record: WorkflowRecord | null = null, state = "waiting_review";
  const receipt = () => ({ id: runId, data: { result_id: result.id, revision_hash: result.revision_hash, workflow_id: record!.id, workflow_revision: record!.revision, definition_sha256: hash, source_id: source.id, source_sha256: source.sha256, selection, population: null } });
  const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
    const normal = () => {
      if (operation === "workflow_list") return { workflows: record ? [record] : [] };
      if (operation === "workflow_validate") return { definition: request.definition, definition_sha256: hash };
      if (operation === "workflow_save") { record = { id: String(request.workflow_id), revision: Number(request.expected_revision) + 1, data: { definition: request.definition as WorkflowDefinition, definition_sha256: hash } }; return { workflow: record }; }
      if (operation === "workflow_get") return { workflow: record };
      if (operation === "workflow_preflight") return { ...request, metrics: [{ id: "measure", unit: "pixel^2" }, { id: "voxel_count", unit: "pixel" }] };
      if (operation === "workflow_preview") return { workflow: { id: record!.id, revision: record!.revision, definition_sha256: hash }, target_node_id: request.target_node_id, image: "data:image/png;base64,cHJldmlldw==", object_count: 12 };
      if (operation === "workflow_run") return { result, run: receipt() };
      if (operation === "workflow_status") return { run: receipt(), state, workflow_outdated: false };
      throw new Error("Unexpected operation " + operation);
    };
    return custom ? custom(operation, request, normal) : normal();
  });
  const desktopApi = { execute, reviewResult: vi.fn(async () => { state = "reviewed"; }), getSnapshot: vi.fn(async () => ({ results: [result] })), cancelJob: vi.fn(async () => undefined) } as unknown as ResearchDesktopApi;
  const props: ResearchWorkflowPanelProps = { api: desktopApi, source, sources: [source], selection, recipe, active: true, jobs: [], busy: false, displayedResult: null,
    onBusyChange: vi.fn(), onPreview: vi.fn(), onResult: vi.fn(), onReview: vi.fn(), onExport: vi.fn(), onRefresh: vi.fn(), ...overrides };
  const view = render(<ResearchWorkflowPanel {...props} />);
  return { ...view, props, execute, desktopApi, getRecord: () => record, receipt, setRecord: (value: WorkflowRecord) => { record = value; } };
}
async function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  await screen.findByText("Saved revision 1.");
  await waitFor(() => expect(screen.getByRole("button", { name: "Run workflow" })).toBeEnabled());
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("Visual workflow interaction and bindings", () => {
  it("saves exact graph identity and previews only the selected prefix", async () => {
    const { execute, props } = setup(); await save();
    fireEvent.click(screen.getByRole("button", { name: "Select gaussian" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview through this step" }));
    await waitFor(() => expect(props.onPreview).toHaveBeenCalledWith("data:image/png;base64,cHJldmlldw=="));
    expect(execute).toHaveBeenCalledWith("workflow_preview", expect.objectContaining({ source_id: source.id, source_sha256: source.sha256, selection, target_node_id: "process-0", workflow_revision: 1, definition_sha256: hash }));
    fireEvent.change(screen.getByLabelText("Workflow sigma"), { target: { value: "2" } });
    expect(screen.getByText(/Previous preview is outdated/)).toBeInTheDocument();
  });
  it("retains invalid numeric text across node/source changes and restores with Escape", async () => {
    const { rerender, props, execute } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Select gaussian" }));
    fireEvent.change(screen.getByLabelText("Workflow sigma"), { target: { value: "Infinity" } });
    expect(screen.getByRole("button", { name: "Save workflow" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Select Source image" }));
    rerender(<ResearchWorkflowPanel {...props} source={{ ...source, id: "4".repeat(32), name: "Another field.tif" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Select gaussian" }));
    expect(screen.getByLabelText("Workflow sigma")).toHaveValue("Infinity");
    expect(execute).not.toHaveBeenCalledWith("workflow_save", expect.anything());
    fireEvent.keyDown(screen.getByLabelText("Workflow sigma"), { key: "Escape" });
    expect(screen.getByLabelText("Workflow sigma")).toHaveValue("0.5");
    expect(screen.getByRole("button", { name: "Save workflow" })).toBeEnabled();
  });
  it("requires exact displayed result for manual review and invalidates previous executions on edit", async () => {
    const { props, rerender, desktopApi } = setup(); await save();
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await screen.findByText("12 objects · waiting review");
    expect(desktopApi.reviewResult).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export reviewed result" })).toBeDisabled();
    rerender(<ResearchWorkflowPanel {...props} displayedResult={result} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(desktopApi.reviewResult).toHaveBeenCalledWith(result.id, result.revision_hash, "reviewed"));
    await screen.findByText("12 objects · reviewed");
    fireEvent.click(screen.getByRole("button", { name: "Export reviewed result" }));
    await waitFor(() => expect(props.onExport).toHaveBeenCalledWith(result, runId));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Changed chain" } });
    expect(screen.getByText(/Outdated execution/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export reviewed result" })).toBeDisabled();
  });
  it("ignores a delayed preview after the exact source scope changes", async () => {
    let complete: ((value: unknown) => void) | undefined;
    const { props, rerender } = setup({}, (op, _request, normal) => op === "workflow_preview" ? new Promise((resolve) => { complete = resolve; }) : normal()); await save();
    fireEvent.click(screen.getByRole("button", { name: "Preview through this step" }));
    await waitFor(() => expect(complete).toBeDefined());
    rerender(<ResearchWorkflowPanel {...props} selection={{ ...selection, x: 1, width: 31 }} />);
    complete!({ workflow: { id: "5".repeat(32), revision: 1, definition_sha256: hash }, target_node_id: "source", image: "stale" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
    expect(props.onPreview).not.toHaveBeenCalled();
  });
  it("surfaces revision conflicts and mismatched preview identities without claiming success", async () => {
    const { execute } = setup({}, (op, _request, normal) => {
      if (op === "workflow_save") throw new Error("Workflow revision conflict; reload before saving."); return normal();
    });
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    await screen.findByText(/Workflow revision conflict/);
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeDisabled();
    expect(execute).toHaveBeenCalledWith("workflow_save", expect.objectContaining({ expected_revision: 0 }));
  });
  it("reconnects process nodes and explains incompatible link types", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Add workflow processing"), { target: { value: "median" } });
    fireEvent.change(screen.getByLabelText("Connect processing input after"), { target: { value: "measure" } });
    await screen.findByText(/Measurements and review cannot feed an image input/);
    fireEvent.change(screen.getByLabelText("Connect processing input after"), { target: { value: "source" } });
    const labels = [...screen.getByRole("list", { name: "Connected workflow nodes" }).querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
    expect(labels.slice(0, 3)).toEqual(["Select Source image", "Select median", "Select gaussian"]);
  });
  it("resolves filter units from preflight and preserves inverted drafts until both bounds are valid", async () => {
    const { execute } = setup(); await save();
    fireEvent.click(screen.getByRole("button", { name: "Population filter" }));
    await screen.findByText("Exact unit: pixel^2");
    fireEvent.click(screen.getByRole("button", { name: "Add range" }));
    fireEvent.change(screen.getByLabelText("Workflow population maximum 1"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Workflow population minimum 1"), { target: { value: "20" } });
    expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Workflow population maximum 1"), { target: { value: "30" } });
    expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));
    await screen.findByText("Saved revision 2.");
    const last = execute.mock.calls.filter(([op]) => op === "workflow_save").at(-1)![1].definition as WorkflowDefinition;
    expect(last.nodes.find((node) => node.type === "population")?.settings.filters).toEqual([{ metric: "measure", unit: "pixel^2", min: 20, max: 30 }]);
  });
  it("rejects reference-bound recipes visibly and names segmentation defaults", async () => {
    const { props, rerender } = setup({ recipe: { ...recipe, references: { flatfield: { source_id: source.id, selection } } } });
    expect(screen.getByRole("button", { name: "Save workflow" })).toBeDisabled();
    expect(screen.getByText(/uses reference images/)).toBeInTheDocument();
    rerender(<ResearchWorkflowPanel {...props} recipe={{ ...recipe, segmentation: null }} />);
    expect(screen.getByRole("button", { name: "Start object workflow" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start object workflow" }));
    expect(screen.getByText(/Otsu threshold/)).toBeInTheDocument();
  });
  it("restores an exact durable execution using the real nested task request shape", async () => {
    const { props, rerender, getRecord, receipt } = setup(); await save();
    const record = getRecord()!;
    const job: ResearchJob = { id: runId, operation: "workflow_run", request: { source_id: source.id, task_request: { source_id: source.id, source_sha256: source.sha256, selection, workflow_id: record.id, workflow_revision: record.revision, definition_sha256: hash }, workflow_context: receipt().data },
      request_key: "loci-batch:" + "d".repeat(32) + ":initial:" + "e".repeat(8), request_hash: hash, state: "succeeded", created_at: "", updated_at: "", progress: 1, cancel_requested: false, result_ids: [result.id], error: null };
    rerender(<ResearchWorkflowPanel {...props} jobs={[job]} />);
    await screen.findByText("12 objects · waiting review");
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeDisabled();
  });
  it("accepts fractional calibrated minimum area without integer coercion", async () => {
    const { execute } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Select Segment objects" }));
    fireEvent.change(screen.getByLabelText("Workflow min size"), { target: { value: "0.5" } });
    await save();
    const definition = execute.mock.calls.find(([op]) => op === "workflow_save")![1].definition as WorkflowDefinition;
    expect(definition.nodes.find((node) => node.type === "segment")?.settings.min_size).toBe(.5);
  });
  it("accepts canonical multi-filter ordering while preserving exact metric values", async () => {
    const { execute } = setup({}, (op, request, normal) => {
      if (op === "workflow_validate") {
        const definition = structuredClone(request.definition as WorkflowDefinition);
        const population = definition.nodes.find((node) => node.type === "population");
        if (population) (population.settings.filters as Array<{ metric: string }>).sort((a, b) => a.metric.localeCompare(b.metric));
        return { definition, definition_sha256: hash };
      }
      return normal();
    }); await save();
    fireEvent.click(screen.getByRole("button", { name: "Population filter" }));
    await screen.findByText("Exact unit: pixel^2");
    fireEvent.change(screen.getByLabelText("Workflow population metric"), { target: { value: "voxel_count" } });
    fireEvent.click(screen.getByRole("button", { name: "Add range" }));
    fireEvent.change(screen.getByLabelText("Workflow population metric"), { target: { value: "measure" } });
    fireEvent.click(screen.getByRole("button", { name: "Add range" }));
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));
    await screen.findByText("Saved revision 2.");
    const definition = execute.mock.calls.filter(([op]) => op === "workflow_save").at(-1)![1].definition as WorkflowDefinition;
    expect(definition.nodes.find((node) => node.type === "population")?.settings.filters).toEqual([{ metric: "measure", unit: "pixel^2", min: 0 }, { metric: "voxel_count", unit: "pixel", min: 0 }]);
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeEnabled();
  });
  it("preflights every exact batch source before submitting any job", async () => {
    const other = { ...source, id: "4".repeat(32), sha256: "d".repeat(64), name: "Another field.tif" };
    const { desktopApi, props, rerender, execute } = setup({ sources: [source, other] }, (op, request, normal) => {
      if (op === "workflow_preflight" && request.source_id === other.id) throw new Error("Selected crop exceeds this source dimensions.");
      return normal();
    });
    desktopApi.submitBatch = vi.fn(async () => { throw new Error("Must not submit"); });
    desktopApi.runBatchJob = vi.fn();
    rerender(<ResearchWorkflowPanel {...props} />);
    await save();
    fireEvent.click(screen.getByLabelText("Another field.tif"));
    fireEvent.click(screen.getByRole("button", { name: "Check and run batch" }));
    await screen.findByText("Selected crop exceeds this source dimensions.");
    expect(execute).toHaveBeenCalledWith("workflow_preflight", expect.objectContaining({ source_id: other.id, source_sha256: other.sha256, selection }));
    expect(desktopApi.submitBatch).not.toHaveBeenCalled();
    expect(desktopApi.runBatchJob).not.toHaveBeenCalled();
  });
  it("runs submitted batch jobs from the real nested task request and retains failure state", async () => {
    const { desktopApi, props, rerender, receipt, getRecord } = setup();
    const batchId = "d".repeat(32);
    desktopApi.submitBatch = vi.fn(async (tasks: ResearchBatchTask[]) => ({ batch_id: batchId, jobs: tasks.map((task): ResearchJob => ({ id: runId, operation: task.operation, request: { source_id: task.source.id, task_request: task.request, workflow_context: receipt().data }, request_key: "loci-batch:" + batchId + ":initial:abcdef", request_hash: hash, state: "queued", created_at: "", updated_at: "", progress: 0, cancel_requested: false, result_ids: [], error: null })) }));
    desktopApi.runBatchJob = vi.fn(async () => ({ result, run: receipt() }));
    rerender(<ResearchWorkflowPanel {...props} />);
    await save();
    fireEvent.click(screen.getByRole("button", { name: "Check and run batch" }));
    await screen.findByText("12 objects · waiting review");
    expect(desktopApi.runBatchJob).toHaveBeenCalledWith(batchId, runId);
    expect(desktopApi.submitBatch).toHaveBeenCalledWith([{ operation: "workflow_run", source: { id: source.id, sha256: source.sha256 }, request: { workflow_id: getRecord()!.id, workflow_revision: 1, definition_sha256: hash, source_id: source.id, source_sha256: source.sha256, selection } }]);
    expect(desktopApi.reviewResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "From current recipe" }));
    expect(screen.queryByRole("button", { name: "Resume batch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry failed batch" })).not.toBeInTheDocument();
  });
  it("cancels only the selected durable batch, preserving other batches and individual runs", async () => {
    const { props, rerender, getRecord, desktopApi, receipt } = setup();
    desktopApi.submitBatch = vi.fn();
    await save();
    const record = getRecord()!;
    const previousBatch = "d".repeat(32), selectedBatch = "e".repeat(32);
    const job = (id: string, requestKey: string, state: "queued" | "running"): ResearchJob => ({
      id, operation: "workflow_run", request: { source_id: source.id, task_request: {
        source_id: source.id, source_sha256: source.sha256, selection, workflow_id: record.id,
        workflow_revision: record.revision, definition_sha256: hash,
      }, workflow_context: receipt().data }, request_key: requestKey, request_hash: hash, state,
      created_at: "", updated_at: "", progress: 0, cancel_requested: false, result_ids: [], error: null,
    });
    const unrelated = job("4".repeat(32), "loci-batch:" + previousBatch + ":initial:00001", "queued");
    const selected = job("5".repeat(32), "loci-batch:" + selectedBatch + ":initial:00002", "running");
    const individual = job("6".repeat(32), "individual-run", "queued");
    const malformed = job("7".repeat(32), "loci-batch:" + selectedBatch + ":initial:bad", "queued");
    const unknownPhase = job("8".repeat(32), "loci-batch:" + selectedBatch + ":other:00003", "queued");
    rerender(<ResearchWorkflowPanel {...props} jobs={[unrelated, selected, individual, malformed, unknownPhase]} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel batch" }));
    await waitFor(() => expect(desktopApi.cancelJob).toHaveBeenCalledWith(selected.id));
    expect(desktopApi.cancelJob).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Resume batch" })).toBeInTheDocument();
    rerender(<ResearchWorkflowPanel {...props} jobs={[individual, malformed, unknownPhase]} />);
    expect(screen.getByRole("button", { name: "Cancel batch" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Resume batch" })).not.toBeInTheDocument();
  });
  it("opens another workflow without recovering the previous local batch", async () => {
    const other: WorkflowRecord = { id: "f".repeat(32), revision: 1, data: { definition: { ...workflowFromRecipe(recipe), name: "Other workflow" }, definition_sha256: hash } };
    const { props, rerender, desktopApi, receipt, getRecord } = setup({}, (op, request, normal) =>
      op === "workflow_list" ? { workflows: [other] } : op === "workflow_get" && request.workflow_id === other.id ? { workflow: other } : normal());
    const previousBatch = "d".repeat(32), nextBatch = "e".repeat(32);
    desktopApi.submitBatch = vi.fn(async (tasks: ResearchBatchTask[]) => ({ batch_id: previousBatch, jobs: tasks.map((task): ResearchJob => ({
      id: runId, operation: task.operation, request: { source_id: source.id, task_request: task.request }, request_key: "loci-batch:" + previousBatch + ":initial:00000",
      request_hash: hash, state: "queued", created_at: "", updated_at: "", progress: 0, cancel_requested: false, result_ids: [], error: null,
    })) }));
    desktopApi.runBatchJob = vi.fn(async () => ({ result, run: receipt() }));
    desktopApi.resumeBatch = vi.fn(async () => ({ batch_id: nextBatch, jobs: [] }));
    desktopApi.retryBatch = vi.fn(async () => ({ batch_id: nextBatch, jobs: [] }));
    await save();
    const previous = getRecord()!;
    fireEvent.click(screen.getByRole("button", { name: "Check and run batch" }));
    await screen.findByText("Batch requests retained. Follow Jobs for exact status and recovery.");
    const job = (record: WorkflowRecord, batchId: string): ResearchJob => ({
      id: record.id, operation: "workflow_run", request: { source_id: source.id, task_request: { workflow_id: record.id } },
      request_key: "loci-batch:" + batchId + ":initial:00000", request_hash: hash, state: "interrupted", created_at: "", updated_at: "", progress: 0, cancel_requested: false, result_ids: [], error: null,
    });
    rerender(<ResearchWorkflowPanel {...props} jobs={[job(previous, previousBatch), job(other, nextBatch)]} />);
    fireEvent.change(screen.getByLabelText("Saved workflow"), { target: { value: other.id } });
    fireEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    await screen.findByText("Opened revision 1.");
    fireEvent.click(screen.getByRole("button", { name: "Resume batch" }));
    await waitFor(() => expect(desktopApi.resumeBatch).toHaveBeenCalledWith(nextBatch));
    expect(desktopApi.resumeBatch).not.toHaveBeenCalledWith(previousBatch);
  });

  it("does not adopt a late preview after hiding and reopening the same workflow", async () => {
    let complete: ((value: unknown) => void) | undefined;
    const { props, rerender, getRecord } = setup({}, (op, _request, normal) => op === "workflow_preview" ? new Promise((resolve) => { complete = resolve; }) : normal()); await save();
    fireEvent.click(screen.getByRole("button", { name: "Preview through this step" }));
    await waitFor(() => expect(complete).toBeDefined());
    rerender(<ResearchWorkflowPanel {...props} active={false} />);
    rerender(<ResearchWorkflowPanel {...props} active />);
    complete!({ workflow: { id: getRecord()!.id, revision: 1, definition_sha256: hash }, target_node_id: "source", image: "stale" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
    expect(props.onPreview).not.toHaveBeenCalled();
  });

});

it("retains exact population counts and keeps the full membership fingerprint in a closed record", async () => {
  const membership = "d".repeat(64);
  setup({}, (operation, _request, normal) => {
    const output = normal();
    if (operation !== "workflow_run") return output;
    const run = output as { result: ResearchResult; run: { data: Record<string, unknown> } };
    return { ...run, run: { ...run.run, data: { ...run.run.data, population: {
      filtered_count: 3, total_count: 12, membership_sha256: membership, query_sha256: "e".repeat(64),
    } } } };
  });
  fireEvent.click(screen.getByText("Save workflow"));
  await waitFor(() => expect(screen.getByText("Run workflow")).toBeEnabled());
  fireEvent.click(screen.getByText("Run workflow"));
  expect(await screen.findByText("3 of 12 objects match.")).toBeVisible();
  const fingerprint = screen.getByText(membership);
  expect(fingerprint).not.toBeVisible();
  fireEvent.click(screen.getByText("Technical record"));
  expect(fingerprint).toBeVisible();
});
