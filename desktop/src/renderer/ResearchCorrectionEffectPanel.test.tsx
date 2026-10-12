// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { assertCorrectionEffectScope, checkedCorrectionEffect, type CorrectionEffectBinding, type CorrectionEffectReceipt } from "../shared/correction-effect-contracts";
import { formatCorrectionEffectValue, ResearchCorrectionEffectPanel } from "./ResearchCorrectionEffectPanel";

afterEach(cleanup);
const sha = "a".repeat(64);
const source: ResearchSource = { id: "source-one", name: "Field one.tif", sha256: sha, metadata: {} };
const peerSource: ResearchSource = { ...source, id: "source-peer", name: "Field peer.tif" };
const metadata = { study: "Study", sample: "Field one", condition: "Control", biological_replicate: "R1", plate: null, well: null };
const parent: ResearchResult = { id: "parent", source_id: source.id, source_sha256: sha, kind: "segmentation", created_at: "before", revision_hash: "b".repeat(64), object_count: 2,
  geometry: {}, selection: null, arrays: { labels: { sha256: sha, bytes: 64, shape: [4, 4], dtype: "uint32" } }, review: { disposition: "reviewed" } };
const child: ResearchResult = { ...parent, id: "child", kind: "corrected-labels", parent_id: parent.id, revision_hash: "c".repeat(64), object_count: 1, created_at: "after" };
const peer: ResearchResult = { ...parent, id: "peer-old", source_id: peerSource.id };
const peerNew: ResearchResult = { ...peer, id: "peer-new", created_at: "later", revision_hash: "d".repeat(64) };
const binding = (result: ResearchResult): CorrectionEffectBinding => ({ result_id: result.id, revision_hash: result.revision_hash,
  source_id: result.source_id, source_sha256: sha, arrays: { labels: { sha256: sha, bytes: 64, shape: [4, 4], dtype: "uint32" } }, review: result.review ?? null,
  sample_document: { revision: 1, data: metadata }, scope: { selection: null, geometry: {}, measurement_basis: null, method: "components" } });
const report = (): CorrectionEffectReceipt => ({ schema: "loci.study-correction-effect/v1", value: "measure", unit: "pixel^2", study: "Study",
  independent_n_basis: "declared biological replicate", weighting: "equal images within biological replicate; equal biological replicates within condition",
  before_bindings: [binding(parent)], after_bindings: [binding(child)],
  images: [{ source_id: source.id, before_result_id: parent.id, after_result_id: child.id, metadata, before_count: 2, after_count: 1,
    count_difference: -1, before_mean: 4, after_mean: 6, mean_difference: 2, eligible: true, omission_reasons: [], needs_review: false,
    correction: { operations: [{ type: "delete", label: 1 }], changed_voxel_count: 2, added_label_ids: [], removed_label_ids: [1], changed_retained_label_ids: [], label_identity_interpretation: "Label identifiers do not prove biological correspondence." } }],
  replicates: [{ study: "Study", condition: "Control", biological_replicate: "R1", image_pair_count: 1, omitted_image_pair_count: 0, before_mean: 4, after_mean: 6, mean_difference: 2 }],
  conditions: [{ study: "Study", condition: "Control", biological_n: 1, image_pair_count: 1, omitted_image_pair_count: 0, before_mean: 4, after_mean: 6, mean_difference: 2 }],
  p_values: null, interpretation: "Descriptive paired comparison; no hypothesis tests.", runtime: {}, receipt_sha256: "e".repeat(64) });
function setup(initialReport = report()) {
  const snapshot: ResearchSnapshot = { project: { title: "Study" }, sources: [source, peerSource], results: [parent, child, peer, peerNew],
    samples: [source, peerSource].map(row => ({ id: row.id, revision: 1, data: metadata })), selections: [], comparisons: [], recipes: [], displays: [], jobs: [], operations: {} };
  const execute = vi.fn().mockResolvedValue(initialReport);
  const getSnapshot = vi.fn().mockResolvedValue(snapshot);
  const exportCorrectionEffect = vi.fn().mockResolvedValue({ receipt_sha256: initialReport.receipt_sha256, files: ["receipt.json"], manifest_sha256: sha });
  const props = { api: { execute, getSnapshot, exportCorrectionEffect } as unknown as ResearchDesktopApi, snapshot,
    seed: { beforeId: parent.id, afterId: child.id }, contextKey: "study-one:source-one:child", busy: false, adopt: vi.fn(), onOpenResult: vi.fn().mockResolvedValue(undefined) };
  return { props, execute, getSnapshot, exportCorrectionEffect };
}
const calculate = () => fireEvent.click(screen.getByRole("button", { name: "Calculate experiment effect" }));

describe("paired correction effect Study panel", () => {
  it.each([
    [8.583333333333332, false, "8.58333"], [8.916666666666666, false, "8.91667"],
    [1 / 3, true, "+0.333333"], [-1 / 3, true, "-0.333333"],
    [1.23456789e-12, true, "+1.23457e-12"], [-1.23456789e-12, true, "-1.23457e-12"],
    [1.23456789e22, false, "1.23457e+22"], [0, true, "0"], [-0, true, "-0"], [null, true, "—"],
  ] as const)("presents %s at six significant digits without erasing its sign or missingness", (value, signed, expected) => {
    expect(formatCorrectionEffectValue(value, signed)).toBe(expected);
  });
  it("shows three compact numeric columns with full wrapping labels, counts and keyboard-accessible exact values", async () => {
    const receipt = report(); const label = "Long condition description with an explicit experimental treatment and control assignment";
    receipt.conditions[0] = { ...receipt.conditions[0], condition: label, before_mean: 8.583333333333332, after_mean: 8.916666666666666,
      mean_difference: 1 / 3, biological_n: 2, image_pair_count: 5, omitted_image_pair_count: 1 };
    receipt.replicates[0] = { ...receipt.replicates[0], condition: label, biological_replicate: "A long declared biological replicate name",
      before_mean: 10.666666666666666, after_mean: 11.333333333333334, mean_difference: 2 / 3, image_pair_count: 3, omitted_image_pair_count: 1 };
    const { props } = setup(receipt); render(<ResearchCorrectionEffectPanel {...props} />); calculate();
    const table = await screen.findByRole("table", { name: "Condition experiment effect" });
    expect(within(table).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["8.58333", "8.91667", "+0.333333"]);
    expect(within(table).getByRole("rowgroup", { name: label })).toHaveTextContent("Biological n: 2 · Image pairs: 5 · Omitted: 1");
    fireEvent.click(screen.getByText("Full precision condition values", { exact: true }));
    const precision = screen.getByLabelText(`Full precision for condition ${label}`);
    expect(precision).toBeVisible(); expect(precision).toHaveTextContent("8.583333333333332");
    expect(precision).toHaveTextContent("8.916666666666666"); expect(precision).toHaveTextContent(String(1 / 3));
    expect(precision).toHaveTextContent("Unit: pixel^2");
    fireEvent.click(screen.getByText("Biological replicate contributions", { exact: true }));
    const replicates = screen.getByRole("table", { name: "Biological replicate experiment effect" });
    expect(within(replicates).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["10.6667", "11.3333", "+0.666667"]);
    expect(replicates).toHaveTextContent("Image pairs: 3 · Omitted: 1");
    fireEvent.click(screen.getByText("Full precision biological replicate values", { exact: true }));
    expect(screen.getByLabelText(`Full precision for replicate A long declared biological replicate name · ${label}`)).toHaveTextContent("11.333333333333334");
    expect(receipt.conditions[0].before_mean).toBe(8.583333333333332);
    expect(receipt.conditions[0].mean_difference).toBe(1 / 3);
  });
  it("keeps image counts exact and exposes full precision image means including tiny negative changes", async () => {
    const receipt = report(); receipt.images[0] = { ...receipt.images[0], before_count: 12345678, after_count: 0, count_difference: -12345678,
      before_mean: 1.23456789012345, after_mean: 1.23456789012344, mean_difference: -1.012345678901234e-14 };
    const { props } = setup(receipt); render(<ResearchCorrectionEffectPanel {...props} />); calculate();
    await screen.findByRole("table", { name: "Condition experiment effect" });
    expect(screen.getByText(/Objects: 12345678 → 0 \(-12345678\).*\(-1.01235e-14\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Image contributions and correction details", { exact: true }));
    fireEvent.click(screen.getByText("Full precision image values for Field one", { exact: true }));
    const values = screen.getByLabelText("Full precision for image Field one");
    expect(values).toBeVisible(); expect(values).toHaveTextContent("1.23456789012345"); expect(values).toHaveTextContent("-1.012345678901234e-14");
  });
  it("keeps selected timestamps and review states outside concise revision choices", () => {
    const { props } = setup(); props.snapshot.results = props.snapshot.results.map(row => row.id === child.id
      ? { ...row, created_at: "2026-10-10T01:48:47.240478+00:00", review: null }
      : row.id === peer.id ? { ...row, created_at: "2026-10-10T01:48:39.777150+00:00", review: { disposition: "excluded" } } : row);
    render(<ResearchCorrectionEffectPanel {...props} />);
    const after = screen.getByRole("combobox", { name: "After correction revision" });
    expect(within(after).getByRole("option", { name: "corrected-labels · child" })).toBeInTheDocument();
    expect(screen.getByLabelText("Selected correction revision details")).toHaveTextContent("pending review");
    expect(screen.getByLabelText("Selected correction revision details")).toHaveTextContent("2026-10-10T01:48:47.240478+00:00");
    fireEvent.click(screen.getByText("Unchanged context images", { exact: true }));
    const context = screen.getByLabelText("Context revision for Field peer.tif");
    fireEvent.change(context, { target: { value: peer.id } });
    const detail = screen.getByLabelText("Selected context revision details for Field peer.tif");
    expect(detail).toBeVisible(); expect(detail).toHaveTextContent("excluded"); expect(detail).toHaveTextContent("2026-10-10T01:48:39.777150+00:00");
    expect(context).toHaveAccessibleDescription(/excluded.*Created 2026-10-10T01:48:39.777150\+00:00/);
    fireEvent.change(context, { target: { value: peerNew.id } });
    expect(screen.getByLabelText("Selected context revision details for Field peer.tif")).toHaveTextContent("reviewed");
  });
  it("seeds only the exact direct parent/child, leaving every peer revision explicitly unselected", async () => {
    const { props, execute } = setup(); render(<ResearchCorrectionEffectPanel {...props} />);
    expect(screen.getByLabelText("Context revision for Field peer.tif")).toHaveValue("");
    calculate();
    expect(execute).toHaveBeenCalledWith("study_correction_effect", { before_result_ids: ["parent"], after_result_ids: ["child"], value: "measure" });
    expect(await screen.findByRole("table", { name: "Condition experiment effect" })).toHaveTextContent("+2");
    expect(props.adopt).toHaveBeenCalledWith(props.snapshot);
    expect(screen.getByText(/Objects: 2 → 1 \(-1\)/)).toBeInTheDocument();
  });
  it("uses an explicitly chosen earlier peer revision unchanged on both sides", async () => {
    const receipt = report(); receipt.before_bindings.push(binding(peer)); receipt.after_bindings.push(binding(peer));
    receipt.images.push({ ...receipt.images[0], source_id: peerSource.id, before_result_id: peer.id, after_result_id: peer.id, correction: null });
    const { props, execute } = setup(receipt); render(<ResearchCorrectionEffectPanel {...props} />);
    fireEvent.change(screen.getByLabelText("Context revision for Field peer.tif"), { target: { value: peer.id } }); calculate();
    await screen.findByRole("table", { name: "Condition experiment effect" });
    expect(execute).toHaveBeenCalledWith("study_correction_effect", { before_result_ids: [parent.id, peer.id], after_result_ids: [child.id, peer.id], value: "measure" });
  });
  it("shows pending review without approving any revision or enabling export", async () => {
    const receipt = report(); receipt.images[0].needs_review = true; receipt.after_bindings[0].review = null;
    const { props } = setup(receipt); props.snapshot.results = props.snapshot.results.map(row => row.id === child.id ? { ...row, review: null } : row);
    render(<ResearchCorrectionEffectPanel {...props} />); calculate();
    expect(await screen.findByText(/Pending review —/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Export reviewed effect report" })).toBeDisabled();
  });
  it("preserves undefined means, exclusions and unassigned biological replicate rows", async () => {
    const receipt = report(); receipt.images[0] = { ...receipt.images[0], before_count: 0, before_mean: null, mean_difference: null, eligible: false,
      omission_reasons: ["empty-before", "unassigned-biological-replicate"], metadata: { ...metadata, biological_replicate: null } };
    receipt.conditions[0] = { ...receipt.conditions[0], biological_n: 0, before_mean: null, after_mean: null, mean_difference: null }; receipt.replicates = [];
    const { props } = setup(receipt); render(<ResearchCorrectionEffectPanel {...props} />); calculate();
    const table = await screen.findByRole("table", { name: "Condition experiment effect" });
    expect(within(table).getAllByText("—")).toHaveLength(3);
    expect(screen.getByText(/replicate unassigned · omitted: empty-before/)).toBeInTheDocument();
  });
  it("blocks calculation for missing sample metadata and unavailable parents", () => {
    const { props, execute } = setup(); props.snapshot.samples = []; const view = render(<ResearchCorrectionEffectPanel {...props} />);
    expect(screen.getByRole("button", { name: "Calculate experiment effect" })).toBeDisabled();
    view.rerender(<ResearchCorrectionEffectPanel {...props} snapshot={{ ...props.snapshot, results: [child] }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("exact ordinary-label parent"); expect(execute).not.toHaveBeenCalled();
  });
  it("shows no-child and calculation failure states", async () => {
    const { props, execute } = setup(); const view = render(<ResearchCorrectionEffectPanel {...props} snapshot={{ ...props.snapshot, results: [parent] }} seed={null} />);
    expect(screen.getByText(/No corrected label revision yet/)).toBeVisible();
    view.rerender(<ResearchCorrectionEffectPanel {...props} />); execute.mockRejectedValueOnce(new Error("Incompatible units; select compatible peers.")); calculate();
    expect(await screen.findByRole("alert")).toHaveTextContent("Incompatible units");
  });
  it("rejects mismatched result bindings and nonfinite engine numbers", async () => {
    const receipt = report(); receipt.after_bindings[0].revision_hash = sha;
    const { props } = setup(receipt); render(<ResearchCorrectionEffectPanel {...props} />); calculate();
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match"); expect(props.adopt).not.toHaveBeenCalled();
    expect(() => checkedCorrectionEffect({ ...report(), conditions: [{ ...report().conditions[0], before_mean: Infinity }] })).toThrow(/Invalid/);
  });
  it.each(["array", "geometry", "selection", "review"])("rejects a response whose %s differs from its frozen scope", kind => {
    const receipt = report(); const { props } = setup();
    if (kind === "array") receipt.after_bindings[0].arrays.labels.shape = [8, 2];
    if (kind === "geometry") receipt.after_bindings[0].scope.geometry = { axes: "XY" };
    if (kind === "selection") receipt.after_bindings[0].scope.selection = { c: 1 };
    if (kind === "review") receipt.after_bindings[0].review = { disposition: "reviewed", reviewed_at: "another review" };
    expect(() => assertCorrectionEffectScope(receipt, { before_result_ids: [parent.id], after_result_ids: [child.id], value: "measure" }, props.snapshot)).toThrow(/does not match/);
  });
  it.each(["metadata", "review", "selection", "project"])("discards an in-flight response after %s changes", async kind => {
    let finish!: (value: unknown) => void; const { props, execute } = setup(); execute.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<ResearchCorrectionEffectPanel {...props} />); calculate();
    expect(screen.getByRole("button", { name: "Calculating…" })).toBeDisabled();
    const snapshot = kind === "metadata" ? { ...props.snapshot, samples: props.snapshot.samples.map(row => ({ ...row, revision: 2 })) }
      : kind === "review" ? { ...props.snapshot, results: props.snapshot.results.map(row => ({ ...row, review: { disposition: "excluded" } })) } : props.snapshot;
    view.rerender(<ResearchCorrectionEffectPanel {...props} snapshot={snapshot} contextKey={kind === "selection" || kind === "project" ? kind : props.contextKey} />);
    await act(async () => finish(report()));
    expect(screen.queryByRole("table", { name: "Condition experiment effect" })).toBeNull(); expect(props.adopt).not.toHaveBeenCalled();
  });
  it("invalidates a response while refreshing its persisted snapshot", async () => {
    let finish!: (value: ResearchSnapshot) => void; const { props, getSnapshot } = setup(); getSnapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<ResearchCorrectionEffectPanel {...props} />); calculate(); await waitFor(() => expect(getSnapshot).toHaveBeenCalled());
    view.rerender(<ResearchCorrectionEffectPanel {...props} contextKey="other selection" />); await act(async () => finish(props.snapshot));
    expect(screen.queryByRole("table", { name: "Condition experiment effect" })).toBeNull(); expect(props.adopt).not.toHaveBeenCalled();
  });
  it("restores exact historical receipts while keeping export closed until explicit recalculation", async () => {
    const { props, execute, exportCorrectionEffect } = setup(); props.snapshot.comparisons = [{ id: "saved", revision: 1, updated_at: "now", data: { receipt: report() } },
      { id: "forged", revision: 1, updated_at: "later", data: { receipt: { schema: "loci.study-correction-effect/v1", receipt_sha256: sha } } }];
    render(<ResearchCorrectionEffectPanel {...props} seed={null} />);
    expect(screen.getByText(/Historical snapshot —/)).toBeVisible(); expect(screen.queryByRole("button", { name: "Restore experiment effect forged" })).toBeNull();
    expect(screen.getByRole("button", { name: "Export reviewed effect report" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Recalculate experiment effect" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export reviewed effect report" })).toBeEnabled());
    expect(execute).toHaveBeenCalledWith("study_correction_effect", { before_result_ids: [parent.id], after_result_ids: [child.id], value: "measure" });
    fireEvent.click(screen.getByRole("button", { name: "Export reviewed effect report" }));
    await screen.findByText("Reviewed report exported."); expect(exportCorrectionEffect).toHaveBeenCalledWith(report().receipt_sha256);
  });
  it("keeps recalculation necessary after metadata-only edits and handles picker cancellation", async () => {
    const { props, exportCorrectionEffect } = setup(); exportCorrectionEffect.mockResolvedValueOnce(null);
    const view = render(<ResearchCorrectionEffectPanel {...props} />); calculate(); await screen.findByRole("table", { name: "Condition experiment effect" });
    fireEvent.click(screen.getByRole("button", { name: "Export reviewed effect report" })); await screen.findByText("Report export cancelled.");
    view.rerender(<ResearchCorrectionEffectPanel {...props} snapshot={{ ...props.snapshot, samples: props.snapshot.samples.map(row => ({ ...row, revision: 2 })) }} />);
    expect(screen.getByText(/Historical snapshot —/)).toBeVisible(); expect(screen.getByRole("button", { name: "Export reviewed effect report" })).toBeDisabled();
  });
  it("discards late export success after a metadata change and keeps the report historical", async () => {
    let finish!: (value: unknown) => void; const { props, exportCorrectionEffect } = setup();
    exportCorrectionEffect.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<ResearchCorrectionEffectPanel {...props} />); calculate(); await screen.findByRole("table", { name: "Condition experiment effect" });
    fireEvent.click(screen.getByRole("button", { name: "Export reviewed effect report" }));
    view.rerender(<ResearchCorrectionEffectPanel {...props} snapshot={{ ...props.snapshot, samples: props.snapshot.samples.map(row => ({ ...row, revision: 2 })) }} />);
    await act(async () => finish({ receipt_sha256: report().receipt_sha256, files: ["receipt.json"], manifest_sha256: sha }));
    expect(screen.queryByText("Reviewed report exported.")).toBeNull();
    expect(screen.getByText(/Historical snapshot —/)).toBeVisible(); expect(screen.getByRole("button", { name: "Export reviewed effect report" })).toBeDisabled();
  });
});
