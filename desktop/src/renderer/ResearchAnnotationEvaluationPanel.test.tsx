// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { AnnotationAgreementSummary, ResearchAnnotationEvaluationPanel } from "./ResearchAnnotationEvaluationPanel";
afterEach(cleanup);
const source = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Generated annotation fixture", metadata: {} } as ResearchSource;
const selection = { x: 2, y: 3, width: 10, height: 8, c: 1, z: 0, t: 0, level: 0 };
const parent: ResearchResult = { schema: "loci.research-result/v1", id: "c".repeat(32), revision_hash: "d".repeat(64), source_id: source.id, source_sha256: source.sha256,
  kind: "segmentation", created_at: "2026-11-06", object_count: 2, selection, geometry: { axes: "YX", unit: "pixel", frame: "source", affine: [[1, 0, 2], [0, 1, 3], [0, 0, 1]] },
  arrays: { image: { sha256: "e".repeat(64), shape: [8, 10], dtype: "uint8" }, labels: { sha256: "f".repeat(64), shape: [8, 10], dtype: "uint32" } } };
const reference: ResearchResult = { ...parent, id: "1".repeat(32), revision_hash: "2".repeat(64), arrays: { ...parent.arrays, labels: { ...parent.arrays!.labels, sha256: "3".repeat(64) } } };
const declaration = "Manual reference covers the entire saved comparison crop.";
const request = { result_id: parent.id, revision_hash: parent.revision_hash, reference: { result_id: reference.id, revision_hash: reference.revision_hash }, semantics: "instances", iou_thresholds: [0.5], reference_declaration: declaration, working_bytes: 16 * 1024 ** 2 };
function agreement() { return { schema: "loci.annotation-agreement/v1", semantics: "instances", reference_declaration: declaration,
  inputs: { prediction: { result_id: parent.id, revision_hash: parent.revision_hash, labels_sha256: parent.arrays!.labels.sha256 }, reference: { result_id: reference.id, revision_hash: reference.revision_hash, labels_sha256: reference.arrays!.labels.sha256 } },
  metrics: { schema: "loci.annotation-agreement-kernel/v1", semantics: "instances", region: { prediction_pixels: 4, reference_pixels: 4, intersection_pixels: 4, union_pixels: 4, iou: 1 as number | null, dice: 1 as number | null, undefined_reasons: {} as Record<string, string> },
    instances: { prediction_count: 2, reference_count: 2, count_error_signed: 0, count_error_absolute: 0, count_error_relative: 0 as number | null, undefined_reasons: {} as Record<string, string>, split_reference_any_overlap: 0, merge_prediction_any_overlap: 0,
      scores: [{ iou_threshold: 0.5, true_positive: 2, false_positive: 0, false_negative: 0, precision: 1 as number | null, recall: 1 as number | null, f1: 1 as number | null, mean_matched_iou: 1 as number | null, undefined_reasons: {} as Record<string, string>, matches_count: 2, unmatched_reference_count: 0, unmatched_prediction_count: 0 }] } } }; }
function saved(record = agreement()): ResearchResult & { annotation_evaluation: ReturnType<typeof agreement> } { return { ...parent, id: "4".repeat(32), revision_hash: "5".repeat(64), parent_id: parent.id, kind: "annotation-agreement", arrays: { ...parent.arrays, reference_labels: reference.arrays!.labels }, annotation_evaluation: record }; }
function response() { const result = saved(); return { result, annotation_evaluation: result.annotation_evaluation,
  job: { id: "6".repeat(32), operation: "annotation_evaluation_run", state: "succeeded", request: { source_id: source.id, task_request: request }, result_ids: [result.id] } }; }
function setup() {
  const execute = vi.fn().mockResolvedValue(response());
  const props = { api: { execute } as unknown as ResearchDesktopApi, snapshot: { project: { project_id: "7".repeat(32) }, results: [parent, reference], sources: [source] } as ResearchSnapshot,
    source, selectedResult: null as ResearchResult | null, active: true, busy: false, workingBytes: 16 * 1024 ** 2,
    onBusyChange: vi.fn(), onPublished: vi.fn().mockResolvedValue(undefined), onInspect: vi.fn() };
  return { ...render(<ResearchAnnotationEvaluationPanel {...props} />), props, execute };
}
function choose() {
  fireEvent.change(screen.getByLabelText("Prediction mask"), { target: { value: `${parent.id}:${parent.revision_hash}` } });
  fireEvent.change(screen.getByLabelText("Saved reference mask"), { target: { value: `${reference.id}:${reference.revision_hash}` } });
  fireEvent.change(screen.getByLabelText("Reference and coverage declaration"), { target: { value: declaration } });
}
function discovery() { return { result_id: parent.id, revision_hash: parent.revision_hash, source_annotations_revision: 3, offset: 0, total: 1, candidates: [{ id: "8".repeat(32), kind: "polygon", z: 0, t: 0, point_count: 4 }] }; }
describe("Exact saved annotation comparison", () => {
  it("requires declarations and submits exact revisions and inclusive thresholds", async () => {
    const v = setup(), run = screen.getByRole("button", { name: "Compare saved annotations" }); expect(run).toBeDisabled(); choose(); fireEvent.click(run);
    await waitFor(() => expect(v.props.onPublished).toHaveBeenCalledWith(response().result)); expect(v.execute).toHaveBeenCalledExactlyOnceWith("annotation_evaluation_run", request); expect(v.props.onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
  it.each(["unfinished", "revision", "request", "source", "result list", "job source", "flat request", "missing source", "extra envelope key"])("refuses incorrect %s bindings", async (change) => {
    const v = setup(), value = response();
    if (change === "unfinished") value.job.state = "running";
    if (change === "revision") value.result.annotation_evaluation.inputs.reference.revision_hash = "9".repeat(64);
    if (change === "request") value.job.request.task_request = { ...request, working_bytes: 1024 ** 2 };
    if (change === "job source") value.job.request.source_id = "9".repeat(32);
    if (change === "flat request") Object.assign(value.job, { request });
    if (change === "missing source") Object.assign(value.job, { request: { task_request: request } });
    if (change === "extra envelope key") Object.assign(value.job.request, { unexpected: true });
    if (change === "source") value.result.source_id = "9".repeat(32);
    if (change === "result list") value.job.result_ids = [parent.id];
    v.execute.mockResolvedValueOnce(value); choose(); fireEvent.click(screen.getByRole("button", { name: "Compare saved annotations" })); expect(await screen.findByRole("alert")).toBeVisible(); expect(v.props.onPublished).not.toHaveBeenCalled();
  });
  it.each(["inactive", "study", "revision"])("ignores delayed completions after %s changes", async (change) => {
    const v = setup(); let settle!: (v: unknown) => void; v.execute.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; })); choose(); fireEvent.click(screen.getByRole("button", { name: "Compare saved annotations" }));
    v.rerender(<ResearchAnnotationEvaluationPanel {...v.props} active={change !== "inactive"} snapshot={change === "study" ? { ...v.props.snapshot, project: { ...v.props.snapshot.project, project_id: "9".repeat(32) } } : change === "revision" ? { ...v.props.snapshot, results: [{ ...parent, revision_hash: "9".repeat(64) }, reference] } : v.props.snapshot} />);
    await act(async () => { settle(response()); }); expect(v.props.onPublished).not.toHaveBeenCalled(); expect(v.props.onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it("blocks invalid threshold drafts, mismatched grids and tissue instance semantics", () => {
    const v = setup(); choose(); const run = screen.getByRole("button", { name: "Compare saved annotations" });
    fireEvent.change(screen.getByLabelText("Inclusive IoU thresholds"), { target: { value: "0.5, NaN" } }); expect(run).toBeDisabled(); expect(v.execute).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Inclusive IoU thresholds"), { target: { value: "0.5" } });
    v.rerender(<ResearchAnnotationEvaluationPanel {...v.props} snapshot={{ ...v.props.snapshot, results: [parent, { ...reference, selection: { ...selection, c: 0 } }] }} />); expect(run).toBeDisabled(); expect(screen.getByText(/different crop, channel/)).toBeVisible();
    v.rerender(<ResearchAnnotationEvaluationPanel {...v.props} snapshot={{ ...v.props.snapshot, results: [{ ...parent, kind: "tissue-model-regions" }, reference] }} />); expect(run).toBeDisabled(); expect(screen.getByText(/Tissue compartment regions require/)).toBeVisible();
  });
  it("retains actionable backend budget errors without publishing", async () => {
    const v = setup(); v.execute.mockRejectedValueOnce(new Error("Annotation operation exceeds aggregate working-memory budget before decode")); choose(); fireEvent.click(screen.getByRole("button", { name: "Compare saved annotations" })); expect(await screen.findByRole("alert")).toHaveTextContent("working-memory budget"); expect(v.props.onPublished).not.toHaveBeenCalled();
  });
  it.each(["exact", "wrong source", "tampered nested request", "flat request", "missing source", "extra envelope key"])("validates the %s job envelope when freezing explicit source annotations", async (change) => {
    const v = setup(); choose(); fireEvent.click(screen.getByText("Freeze source annotations as a reference")); v.execute.mockResolvedValueOnce(discovery()); fireEvent.click(screen.getByRole("button", { name: "Find eligible source annotations" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "polygon · 88888888" })); fireEvent.change(screen.getByLabelText("Frozen reference coverage"), { target: { value: declaration } });
    const req = { result_id: parent.id, revision_hash: parent.revision_hash, source_annotations_revision: 3, annotation_ids: ["8".repeat(32)], semantics: "instances", coverage_declaration: declaration, working_bytes: 16 * 1024 ** 2 };
    const record = { schema: "loci.annotation-reference/v1", semantics: "instances", source_annotations_revision: 3, coverage_declaration: declaration, labels_sha256: "9".repeat(64), snapshot_sha256: "0".repeat(64), annotation_count: 1 };
    const result = { ...parent, id: "0".repeat(32), revision_hash: "1".repeat(64), parent_id: parent.id, kind: "annotation-reference", arrays: { ...parent.arrays, labels: { ...parent.arrays!.labels, sha256: record.labels_sha256 } }, annotation_reference: record };
    const job = { id: "2".repeat(32), operation: "annotation_reference_run", state: "succeeded", request: { source_id: source.id, task_request: req }, result_ids: [result.id] };
    if (change === "wrong source") job.request.source_id = "9".repeat(32);
    if (change === "tampered nested request") job.request.task_request = { ...req, source_annotations_revision: 4 };
    if (change === "flat request") Object.assign(job, { request: req });
    if (change === "missing source") Object.assign(job, { request: { task_request: req } });
    if (change === "extra envelope key") Object.assign(job.request, { unexpected: true });
    v.execute.mockResolvedValueOnce({ result, annotation_reference: record, job }); fireEvent.click(screen.getByRole("button", { name: "Freeze selected reference" }));
    if (change === "exact") await waitFor(() => expect(v.props.onPublished).toHaveBeenCalledExactlyOnceWith(result));
    else {
      expect(await screen.findByRole("alert")).toHaveTextContent("exact completed job and input revision");
      expect(v.props.onPublished).not.toHaveBeenCalled();
    }
    expect(v.props.onBusyChange).toHaveBeenLastCalledWith(false);
    expect(v.execute).toHaveBeenNthCalledWith(1, "annotation_reference_candidates", { result_id: parent.id, revision_hash: parent.revision_hash, offset: 0, limit: 100 }); expect(v.execute).toHaveBeenNthCalledWith(2, "annotation_reference_run", req);
  });
  it("refuses unbound discovery and shows a useful empty source state", async () => {
    const v = setup(); choose(); fireEvent.click(screen.getByText("Freeze source annotations as a reference")); v.execute.mockResolvedValueOnce({ ...discovery(), revision_hash: "9".repeat(64) }); fireEvent.click(screen.getByRole("button", { name: "Find eligible source annotations" })); expect(await screen.findByRole("alert")).toHaveTextContent("does not match"); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    v.execute.mockResolvedValueOnce({ ...discovery(), total: 0, candidates: [] }); fireEvent.click(screen.getByRole("button", { name: "Find eligible source annotations" })); expect(await screen.findByText(/No closed annotations are available/)).toBeVisible();
  });
  it("uses an empty threshold list for foreground comparison without inferring instances", async () => {
    const v = setup(); choose(); fireEvent.change(screen.getByLabelText("Label meaning"), { target: { value: "foreground-region" } });
    v.execute.mockRejectedValueOnce(new Error("fixture stops after checking request")); fireEvent.click(screen.getByRole("button", { name: "Compare saved annotations" }));
    await screen.findByRole("alert"); expect(v.execute).toHaveBeenCalledWith("annotation_evaluation_run", { ...request, semantics: "foreground-region", iou_thresholds: [] });
    expect(screen.queryByLabelText("Inclusive IoU thresholds")).not.toBeInTheDocument();
  });
  it("retains explicit source-annotation selections across bound discovery pages", async () => {
    const v = setup(); choose(); fireEvent.click(screen.getByText("Freeze source annotations as a reference"));
    const candidates = Array.from({ length: 100 }, (_, i) => ({ ...discovery().candidates[0], id: (i + 100).toString(16).padStart(32, "0") }));
    v.execute.mockResolvedValueOnce({ ...discovery(), total: 101, candidates }); fireEvent.click(screen.getByRole("button", { name: "Find eligible source annotations" }));
    fireEvent.click((await screen.findAllByRole("checkbox"))[0]);
    v.execute.mockResolvedValueOnce({ ...discovery(), offset: 100, total: 101 }); fireEvent.click(screen.getByRole("button", { name: "Next annotations" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "polygon · 88888888" })); expect(screen.getByText("2 selected across annotation pages.")).toBeVisible();
    expect(v.execute).toHaveBeenLastCalledWith("annotation_reference_candidates", { result_id: parent.id, revision_hash: parent.revision_hash, offset: 100, limit: 100 });
  });

  it("offers controlled-method parents with additional retained arrays", () => {
    const v = setup(); v.rerender(<ResearchAnnotationEvaluationPanel {...v.props} snapshot={{ ...v.props.snapshot, results: [{ ...parent, kind: "controlled-method", arrays: { ...parent.arrays, method_values: { sha256: "9".repeat(64), shape: [2] } } }, reference] }} />);
    choose(); expect(screen.getByRole("button", { name: "Compare saved annotations" })).toBeEnabled();
  });

});
describe("Saved agreement inspection", () => {
  it("keeps empty metrics undefined with reasons and opens exact parent revisions", () => {
    const r = agreement(), instance = r.metrics.instances, score = instance.scores[0]; Object.assign(r.metrics.region, { prediction_pixels: 0, reference_pixels: 0, intersection_pixels: 0, union_pixels: 0, iou: null, dice: null, undefined_reasons: { iou: "empty-foreground-union", dice: "empty-foreground-union" } });
    Object.assign(instance, { prediction_count: 0, reference_count: 0, count_error_relative: null, undefined_reasons: { count_error_relative: "no-reference-instances" } }); Object.assign(score, { true_positive: 0, matches_count: 0, precision: null, recall: null, f1: null, mean_matched_iou: null, undefined_reasons: { precision: "no-predicted-instances", recall: "no-reference-instances", f1: "no-reference-or-predicted-instances", mean_matched_iou: "no-matches" } });
    const onInspect = vi.fn(); render(<AnnotationAgreementSummary result={saved(r)} onInspect={onInspect} />); expect(screen.getAllByText("empty foreground union")).toHaveLength(2); expect(screen.getByText("no matches")).toBeVisible(); expect(screen.getAllByText("Undefined")).toHaveLength(6); fireEvent.click(screen.getByRole("button", { name: "Inspect reference revision" })); expect(onInspect).toHaveBeenCalledExactlyOnceWith(reference.id, reference.revision_hash);
  });
  it("rejects missing undefined reasons instead of presenting perfect agreement", () => { const r = agreement(); r.metrics.region.iou = null; render(<AnnotationAgreementSummary result={saved(r)} />); expect(screen.getByRole("alert")).toHaveTextContent("inconsistent"); });
  it("loads retained original IDs and rejects mismatched paged report identity", async () => {
    const result = saved(), execute = vi.fn().mockResolvedValue({ result_id: result.id, revision_hash: result.revision_hash, table: "matches", iou_threshold: 0.5, offset: 0, total: 2, rows: [{ reference_label: 7, prediction_label: 42, intersection_pixels: 2, union_pixels: 2, iou: 1 }, { reference_label: 99, prediction_label: 100, intersection_pixels: 2, union_pixels: 2, iou: 1 }] });
    render(<AnnotationAgreementSummary result={result} api={{ execute } as unknown as ResearchDesktopApi} />); fireEvent.click(screen.getByText("Inspect matched and unmatched labels")); expect(await screen.findByRole("region", { name: "Saved annotation match rows" })).toBeVisible(); expect(execute).toHaveBeenCalledWith("annotation_evaluation_get", { result_id: result.id, revision_hash: result.revision_hash, table: "matches", threshold_index: 0, offset: 0, limit: 50 }); expect(within(screen.getByRole("table")).getByText("42")).toBeVisible();
    execute.mockResolvedValueOnce({ result_id: result.id, revision_hash: "9".repeat(64), table: "unmatched_reference", iou_threshold: 0.5, offset: 0, total: 0, rows: [] }); fireEvent.change(screen.getByLabelText("Rows"), { target: { value: "unmatched_reference" } }); expect(await screen.findByRole("alert")).toHaveTextContent("does not belong"); expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("loads the next saved match page without changing threshold or revision", async () => {
    const record = agreement(), instance = record.metrics.instances, score = instance.scores[0];
    Object.assign(record.metrics.region, { prediction_pixels: 52, reference_pixels: 52, intersection_pixels: 52, union_pixels: 52 });
    instance.prediction_count = instance.reference_count = score.true_positive = score.matches_count = 52;
    const result = saved(record), row = (id: number) => ({ reference_label: id, prediction_label: id + 100, intersection_pixels: 1, union_pixels: 1, iou: 1 });
    const execute = vi.fn().mockResolvedValueOnce({ result_id: result.id, revision_hash: result.revision_hash, table: "matches", iou_threshold: 0.5, offset: 0, total: 52, rows: Array.from({ length: 50 }, (_, i) => row(i + 1)) });
    render(<AnnotationAgreementSummary result={result} api={{ execute } as unknown as ResearchDesktopApi} />); fireEvent.click(screen.getByText("Inspect matched and unmatched labels")); await screen.findByText("1–50 of 52");
    execute.mockResolvedValueOnce({ result_id: result.id, revision_hash: result.revision_hash, table: "matches", iou_threshold: 0.5, offset: 50, total: 52, rows: [row(51), row(52)] });
    fireEvent.click(screen.getByRole("button", { name: "Next rows" })); expect(await screen.findByText("51–52 of 52")).toBeVisible(); expect(execute).toHaveBeenLastCalledWith("annotation_evaluation_get", { result_id: result.id, revision_hash: result.revision_hash, table: "matches", threshold_index: 0, offset: 50, limit: 50 }); expect(screen.getByRole("button", { name: "Next rows" })).toBeDisabled();
  });

});
