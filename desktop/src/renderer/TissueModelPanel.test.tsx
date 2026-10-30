// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource, ResearchTissueProfiles } from "../shared/research-contracts";
import { TissueModelPanel } from "./TissueModelPanel";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const hash = "a".repeat(64), model = "puma-tissue-cpu", image = "data:image/png;base64,AAAA";
const source: ResearchSource = { id: "b".repeat(32), sha256: hash, name: "Generated RGB", source_kind: "native",
  metadata: { selected_series: 0, dimensions: { x: 12, y: 10, c: 1, s: 3, z: 1, t: 1 }, sample_semantics: "RGB", channel_dtypes: ["uint8"] } };
const selection = { x: 2, y: 1, width: 6, height: 5, c: 0, z: 0, t: 0, level: 0 };
function catalogue() { return { profiles: [{ profile: { schema: "loci.tissue-model-profile/v1", id: model, contract_sha256: hash,
  model: { sha256: hash, bytes: 123, conversion_receipt_sha256: hash }, input: { rgb_policy: "puma-first-three-samples", maximum_context_edge: 1024 },
  runtime: { device: "cpu" }, resources: { minimum_working_bytes: 2 * 1024 ** 3, maximum_working_bytes: 8 * 1024 ** 3 }, selected_compartment: { class_id: 4, name: "epidermis" } },
  store: { schema: "loci.puma-store-status/v1", profile_id: model, profile_contract_sha256: hash, weights_sha256: hash, weights_bytes: 123,
    conversion_receipt_sha256: hash, state: "verified", provisioned: true, files_verified: true, runtime_compatibility: "not-established",
    scientific_qualification: "not-established", model_execution_performed: false, execution_authority: false },
  runtime: { status: "metadata-matches-unverified", runtime_import_verified: false, technical_compatibility_verified: false, missing: [], mismatched: [], expected: { torch: "fixture" } } }] }; }
function job(operation: string, request: unknown, resultIds: string[] = []) { return { id: "c".repeat(32), operation, state: "succeeded",
  cancel_requested: false, result_ids: resultIds, request: { source_id: source.id, task_request: request } }; }
function preview(request: Record<string, unknown>) { return { preview_id: "d".repeat(32), preview_hash: hash, adopted: false, region_count: 2,
  selected_class: 4, entity_type: "tissue-region", scientific_review: "pending", overlay_png: image,
  context_selection: request.context_selection, output_selection: request.output_selection, job: job("tissue_model_preview", request) }; }
const token = { preview_id: "d".repeat(32), preview_hash: hash };
function result(): ResearchResult { return { id: "e".repeat(32), revision_hash: hash, source_id: source.id, source_sha256: hash,
  kind: "tissue-model-regions", created_at: "2026-10-30", object_count: 2, selection,
  tissue_model: { schema: "loci.puma-tissue-result/v1", label_semantics: "original_selected_compartment", preview: token },
  arrays: { image: { dtype: "float32", shape: [5, 6], sha256: hash }, labels: { dtype: "uint32", shape: [5, 6], sha256: hash },
    class_labels: { dtype: "uint8", shape: [5, 6], sha256: hash }, probabilities: { dtype: "float32", shape: [6, 5, 6], sha256: hash } } }; }
function setup() {
  const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
    if (operation === "tissue_model_profiles") return catalogue();
    if (operation === "tissue_model_preview") return preview(request);
    if (operation === "tissue_model_run") return { adopted: true, result: result(), region_count: 2, job: job(operation, request, [result().id]) };
    return { result_id: result().id, revision_hash: hash, axis: "z", index: 0, image, shape: [5, 6], label_field: request.label_field, label_field_basis: "original-model" };
  });
  const props = { api: { execute, importTissueModel: vi.fn(), cancelTissueModelImport: vi.fn() } as unknown as ResearchDesktopApi,
    snapshot: { project: { project_id: "f".repeat(32) } } as ResearchSnapshot, source, selection, selectedResult: null as ResearchResult | null,
    active: true, busy: false, onBusyChange: vi.fn(), onPublished: vi.fn().mockResolvedValue(undefined), onInspect: vi.fn(), onCorrect: vi.fn(), onReview: vi.fn() };
  return { ...render(<TissueModelPanel {...props} />), props, execute };
}
async function declare() {
  await screen.findByText("Exact file identities verified");
  fireEvent.change(screen.getByLabelText("Tissue preparation"), { target: { value: "hematoxylin-eosin" } });
}
async function makePreview() { await declare(); fireEvent.click(screen.getByRole("button", { name: "Preview candidate mask" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create result from preview" })).toBeEnabled()); }

describe("PUMA tissue candidate workflow", () => {
  it("requires declared preparation and keeps the full normalization context separate from output", async () => {
    const view = setup(); await screen.findByText("Exact file identities verified");
    expect(screen.getByRole("button", { name: "Preview candidate mask" })).toBeDisabled();
    await makePreview();
    expect(view.execute).toHaveBeenCalledWith("tissue_model_preview", expect.objectContaining({ declared_stain: "hematoxylin-eosin", output_selection: selection,
      context_selection: { ...selection, x: 0, y: 0, width: 12, height: 10 }, working_bytes: 2 * 1024 ** 3, runtime_contract_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    fireEvent.click(screen.getByRole("button", { name: "Create result from preview" }));
    await waitFor(() => expect(view.props.onPublished).toHaveBeenCalledWith(result()));
    expect(view.execute).toHaveBeenCalledWith("tissue_model_run", token);
  });
  it.each(["scalar", "palette", "oversize"])("rejects unsupported %s source before execution", async (reason) => {
    const view = setup(); const next = structuredClone(source);
    if (reason === "scalar") next.metadata.sample_semantics = "scalar";
    if (reason === "palette") next.metadata.sample_semantics = "palette";
    if (reason === "oversize") next.metadata.dimensions!.x = 2048;
    view.rerender(<TissueModelPanel {...view.props} source={next} />); await declare();
    expect(screen.getByRole("button", { name: "Preview candidate mask" })).toBeDisabled();
    expect(view.execute.mock.calls.every(([operation]) => operation === "tissue_model_profiles")).toBe(true);
  });
  it("invalidates a preview when the output region changes", async () => {
    const view = setup(); await makePreview();
    view.rerender(<TissueModelPanel {...view.props} selection={{ ...selection, x: 3 }} />);
    expect(screen.getByRole("button", { name: "Create result from preview" })).toBeDisabled();
    expect(screen.queryByAltText(/Exact source-region preview/)).not.toBeInTheDocument();
  });
  it("does not adopt a delayed preview after leaving the tool", async () => {
    const view = setup(); await declare(); let finish!: (value: unknown) => void; let request!: Record<string, unknown>;
    view.execute.mockImplementationOnce(async (_operation, value) => { request = value; return await new Promise<unknown>(resolve => { finish = resolve; }) as never; });
    fireEvent.click(screen.getByRole("button", { name: "Preview candidate mask" }));
    view.rerender(<TissueModelPanel {...view.props} active={false} />);
    await act(async () => { finish(preview(request)); });
    expect(screen.queryByAltText(/Exact source-region preview/)).not.toBeInTheDocument();
    expect(view.props.onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it("rejects a completed preview whose native job request does not match", async () => {
    const view = setup(); await declare();
    view.execute.mockImplementationOnce(async (_operation, request) => ({ ...preview(request), job: job("tissue_model_preview", {}) }) as never);
    fireEvent.click(screen.getByRole("button", { name: "Preview candidate mask" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("exact completed native job");
    expect(screen.getByRole("button", { name: "Create result from preview" })).toBeDisabled();
  });
  it("rejects adoption when retained array shape differs from the exact preview", async () => {
    const view = setup(); await makePreview(); const wrong = result(); wrong.arrays!.probabilities.shape = [5, 5, 6];
    view.execute.mockResolvedValueOnce({ adopted: true, result: wrong, region_count: 2, job: job("tissue_model_run", token, [wrong.id]) } as never);
    fireEvent.click(screen.getByRole("button", { name: "Create result from preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match the exact preview");
    expect(view.props.onPublished).not.toHaveBeenCalled();
  });
  it("separates original classes, scores and edited regions in exact revision inspection", async () => {
    const view = setup(); const edited = result(); edited.tissue_model!.label_semantics = "edited_selected_compartment";
    view.rerender(<TissueModelPanel {...view.props} selectedResult={edited} />); await screen.findByText("Exact file identities verified");
    fireEvent.change(screen.getByLabelText("Tissue result field"), { target: { value: "tissue_classes" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect saved field" })); await screen.findByAltText("Original tissue classes");
    expect(view.execute).toHaveBeenLastCalledWith("result_view", { result_id: edited.id, axis: "z", index: 0, labels: true, label_field: "tissue_classes" });
    fireEvent.change(screen.getByLabelText("Tissue result field"), { target: { value: "score" } });
    expect(screen.queryByAltText("Original tissue classes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect saved field" })); await screen.findByAltText("Original epidermis score");
    expect(view.execute).toHaveBeenLastCalledWith("result_view", { result_id: edited.id, axis: "z", index: 0, labels: false, label_field: "compartments" });
    fireEvent.click(screen.getByRole("button", { name: "Correct compartment regions" })); expect(view.props.onCorrect).toHaveBeenCalledWith(edited);
  });
  it("cancels a pending native selection when leaving and ignores its late response", async () => {
    const view = setup(); await declare(); let finish!: (value: unknown) => void;
    vi.mocked(view.props.api.importTissueModel!).mockImplementation(() => new Promise(resolve => { finish = value => resolve(value as ResearchTissueProfiles); }));
    vi.mocked(view.props.api.cancelTissueModelImport!).mockResolvedValue({ cancelled: true, phase: "choosing-weights" });
    fireEvent.click(screen.getByRole("button", { name: "Import weights & receipt…" }));
    view.rerender(<TissueModelPanel {...view.props} active={false} />);
    expect(view.props.api.cancelTissueModelImport).toHaveBeenCalledWith(model);
    await act(async () => { finish(catalogue()); });
    expect(view.props.onBusyChange).toHaveBeenLastCalledWith(false);
  });
});
