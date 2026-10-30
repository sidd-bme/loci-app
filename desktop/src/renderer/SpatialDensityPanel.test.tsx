// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot } from "../shared/research-contracts";
import { checkedSpatialDensityPage, checkedSpatialDensityReport, spatialDensityRequestHash, spatialDensityTables, type SpatialDensityReport, type SpatialDensityRequest, type SpatialDensityTable, type SpatialDensityViewSummary } from "../shared/spatial-density-contracts";
import { SpatialDensityPanel } from "./SpatialDensityPanel";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const hash = "8".repeat(64), reportId = hash.slice(0, 32), groupId = "7".repeat(32), groupHash = "7".repeat(64);
const sources = ["a", "b"].map((s, index) => ({ id: s.repeat(32), sha256: s.repeat(64), name: `Field ${index + 1}.tif`, metadata: {} }));
const results: ResearchResult[] = ["c", "d"].map((s, i) => ({ id: s.repeat(32), revision_hash: s.repeat(64), source_id: sources[i].id, source_sha256: sources[i].sha256,
  kind: "spatial-distance-bands", schema: "loci.research-result/v1", object_count: 3, created_at: "2026-10-30", selection: { t: 0, z: 0, c: 0, x: 0, y: 0, width: 10, height: 10, level: 0 },
  spatial: { distance_unit: "um", area_unit: "um^2", inputs: { objects: { result_id: "e".repeat(32), revision_hash: "e".repeat(64) } } } }));
const samples = sources.map((s, i) => ({ id: s.id, revision: 1, data: { study: "Study A", sample: `Sample ${i + 1}`, condition: i ? "Treated" : "Baseline", biological_replicate: "Donor 1" } }));
const snapshot = { project: { project_id: "f".repeat(32), title: "Test study" }, sources, results, samples, jobs: [], recipes: [], displays: [], selections: [], operations: {} } as ResearchSnapshot;
const request: SpatialDensityRequest = { fields: results.map((r) => ({ result_id: r.id, revision_hash: r.revision_hash })), stratum: { t: 0, z: 0 } };
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
};
const requestHash = (req: SpatialDensityRequest) => createHash("sha256").update(canonical(req)).digest("hex");
function reportFor(req = request): SpatialDensityReport {
  const selected = req.fields.map((binding) => {
    const r = results.find((r) => r.id === binding.result_id)!;
    return { result: { projection_schema: "loci.spatial-density-field/v2" as const, id: r.id, revision_hash: r.revision_hash, source_id: r.source_id, source_sha256: r.source_sha256!,
      record_sha256: hash, selection: { t: 0, z: 0 }, geometry: { axes: "YX" }, bands: [], object_exclusions: { crop_border: 1 },
      contract: { distance_unit: "um", area_unit: "um^2", band_edges: [0, 100], rules: {}, exclude_crop_border: true } },
      sample: structuredClone(samples.find((s) => s.id === r.source_id)!),
      phenotype: binding.phenotype_group_id ? { id: binding.phenotype_group_id, name: "CD3 positive", record_sha256: binding.phenotype_record_sha256!,
        snapshot_sha256: groupHash, result_id: r.id, revision_hash: r.revision_hash, source_id: r.source_id, source_sha256: r.source_sha256!,
        membership_sha256: groupHash, population_sha256: groupHash } : null };
  });
  return { schema: "loci.spatial-density-report/v2", created_at: "2026-10-30T12:00:00Z",
    report_hash: canonical(req) === canonical(request) ? hash : requestHash(req), request: structuredClone(req),
    software: { engine: "test-engine", aggregation_sha256: hash, dispatcher_sha256: hash },
    aggregation: { schema: "loci.spatial-density-aggregation/v2", rules: { donor: "Pool counts and areas within donor" },
      contract: { distance_unit: "um", area_unit: "um^2", band_edges: [0, 100], rules: {}, exclude_crop_border: true },
      stratum: req.stratum ?? { t: 0, z: 0 }, phenotype_name: req.phenotype_name ?? null, condition_pair: req.condition_pair ?? null,
      input_snapshots: selected,
      field_rows: selected.map((f) => ({ result_id: f.result.id, revision_hash: f.result.revision_hash, source_id: f.result.source_id, source_sha256: f.result.source_sha256, metadata: f.sample.data,
        selection: { t: 0, z: 0 }, included_in_donor_pool: true, band_index: 0, lower: 0, upper: 100, object_count: 2, eligible_object_count: 3, sampled_area: 100, sampled_pixel_count: 100, density: 0.02, density_status: "defined" })),
      donor_rows: selected.map((f) => ({ study: "Study A", condition: f.sample.data.condition, biological_replicate: "Donor 1", band_index: 0, object_count: 2, sampled_area: 100, density: 0.02, density_status: "defined", field_result_ids: [f.result.id], n_fields: 1 })),
      condition_rows: selected.map((f) => ({ study: "Study A", condition: f.sample.data.condition, band_index: 0, n: 1, mean: 0.02, median: 0.02, sd: null, n_donors_total: 1, n_undefined_zero_area: 0 })),
      paired_rows: req.condition_pair ? [{ study: "Study A", biological_replicate: "Donor 1", left_condition: req.condition_pair[0], right_condition: req.condition_pair[1], band_index: 0, left_density: 0.02, right_density: 0.02, difference: 0, status: "defined" }] : [],
      paired_summary: req.condition_pair ? [{ study: "Study A", left_condition: req.condition_pair[0], right_condition: req.condition_pair[1], band_index: 0, n: 1, mean: 0, sd: null, median: 0 }] : [], unmatched_donors: [],
      exclusion_audit: selected.map((f) => ({ result_id: f.result.id, revision_hash: f.result.revision_hash, reasons: [], object_exclusions: { crop_border: 1 } })),
    } };
}
function summaryFor(report: SpatialDensityReport, shown = 5): SpatialDensityViewSummary {
  const aggregation = { ...report.aggregation }, tables: SpatialDensityViewSummary["tables"] = {} as SpatialDensityViewSummary["tables"];
  for (const name of spatialDensityTables) {
    const values = report.aggregation[name], total = values.length, returned = Math.min(shown, total);
    (aggregation[name] as unknown[]) = values.slice(0, returned);
    tables[name] = { total, returned, has_more: returned < total, next_offset: returned < total ? returned : null };
  }
  return { schema: "loci.spatial-density-summary/v1", report_schema: report.schema, report_hash: report.report_hash, created_at: report.created_at, software: report.software,
    request_sha256: requestHash(report.request), aggregation, tables,
    totals: { selected_fields: report.aggregation.input_snapshots.length, excluded_fields: report.aggregation.exclusion_audit.filter((r) => r.reasons.length > 0).length,
      donor_rows: tables.donor_rows.total, condition_rows: tables.condition_rows.total, paired_rows: tables.paired_rows.total } };
}
function savedFor(report: SpatialDensityReport, status = { current: true, changes: [] as Array<{ result_id: string; reason: string }> }) {
  return { report, report_id: report.report_hash.slice(0, 32), summary: summaryFor(report), status };
}
function previewFor(report: SpatialDensityReport) { return { preview_id: report.report_hash.slice(0, 32), preview_hash: report.report_hash, summary: summaryFor(report) }; }
function pageFor(report: SpatialDensityReport, args: Record<string, unknown>, cappedAt?: number) {
  const table = args.table as SpatialDensityTable, offset = Number(args.offset), limit = Number(args.limit), values = report.aggregation[table];
  const rows = values.slice(offset, offset + Math.min(limit, cappedAt ?? limit)), next = offset + rows.length;
  return { schema: "loci.spatial-density-page/v1", report_hash: report.report_hash, table, offset, limit, total: values.length, returned: rows.length, rows, next_offset: next < values.length ? next : null };
}
const group = { id: groupId, record_sha256: groupHash, name: "CD3 positive", result_id: results[0].id, revision_hash: results[0].revision_hash,
  source_id: results[0].source_id, source_sha256: results[0].source_sha256!, included_count: 2, source_available: true };
function mount({ saved = false, response, snapshot: currentSnapshot = snapshot }: { saved?: boolean; response?: (operation: string, args: Record<string, unknown>) => unknown; snapshot?: ResearchSnapshot } = {}) {
  let stored = saved ? reportFor() : null;
  let retained: SpatialDensityReport | null = null;
  const execute = vi.fn(async (operation: string, args: Record<string, unknown>) => {
    const override = response?.(operation, args); if (override !== undefined) return override;
    if (operation === "population_group_list") return { schema: "loci.population-group-list/v1", groups: [group] };
    if (operation === "spatial_density_list") return { reports: stored ? [{ id: reportId, created_at: stored.created_at, phenotype_name: stored.aggregation.phenotype_name, stratum: stored.aggregation.stratum, status: { current: true, changes: [] } }] : [] };
    if (operation === "spatial_density_preview") { retained = reportFor(args as unknown as SpatialDensityRequest); return previewFor(retained); }
    if (operation === "spatial_density_save") { expect(args).toEqual({ preview_id: retained!.report_hash.slice(0, 32), preview_hash: retained!.report_hash }); stored = retained; return savedFor(stored!); }
    if (operation === "spatial_density_get") return savedFor(stored!);
    if (operation === "spatial_density_query") return pageFor(("report_id" in args ? stored : retained)!, args);
    throw new Error(`Unexpected ${operation}`);
  });
  const planSpatialDensityExport = vi.fn().mockResolvedValue({ schema: "loci.spatial-density-export-plan/v1", report_id: reportId, report_hash: hash, plan_hash: "9".repeat(64), status: { current: true, changes: [] } });
  const exportSpatialDensityReport = vi.fn().mockResolvedValue({ schema: "loci.spatial-density-export-receipt/v1", report_hash: hash, basename: "Density report", manifest_sha256: "9".repeat(64) });
  const cancelDataExport = vi.fn().mockResolvedValue({ cancelled: true });
  const api = { execute, planSpatialDensityExport, exportSpatialDensityReport, cancelDataExport, getSnapshot: vi.fn().mockResolvedValue(currentSnapshot) } as unknown as ResearchDesktopApi;
  const props = { api, snapshot: currentSnapshot, onInspect: vi.fn(), onSnapshot: vi.fn() };
  return { ...render(<SpatialDensityPanel {...props} />), props, execute, planSpatialDensityExport, exportSpatialDensityReport, cancelDataExport };
}
function selectFields(n = 2) {
  for (let i = 1; i <= n; i++) fireEvent.click(screen.getByRole("checkbox", { name: `Density field: Field ${i}.tif · distance bands 1` }));
  fireEvent.change(screen.getByRole("combobox", { name: "Density time and plane" }), { target: { value: "0:0" } });
}
async function preview() { fireEvent.click(screen.getByRole("button", { name: "Preview donor density" })); await screen.findByRole("region", { name: "Density preview" }); }
async function openSaved() {
  await screen.findByRole("button", { name: `Open density report ${reportId}`, hidden: true });
  fireEvent.click(screen.getByText("Saved density reports (1)"));
  fireEvent.click(screen.getByRole("button", { name: `Open density report ${reportId}` }));
  await screen.findByRole("region", { name: "Saved density report" });
}

describe("Spatial donor density", () => {
  it("previews exact selected revisions, displays donor endpoints and saves only the retained identity", async () => {
    const app = mount(); selectFields(); await preview();
    expect(app.execute).toHaveBeenCalledWith("spatial_density_preview", request);
    expect(screen.getByRole("columnheader", { name: "Mean (objects/µm²)" })).toBeVisible();
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Condition density summaries" })).getAllByText("1 / 1")).toHaveLength(2));
    fireEvent.click(screen.getByText("Donor counts, sampled areas and densities (2)"));
    expect(await screen.findByRole("region", { name: "Donor density endpoints" })).toBeVisible();
    fireEvent.click(screen.getByText("Field counts and exact result links (2)"));
    const fields = await screen.findByRole("region", { name: "Field density measurements" });
    fireEvent.click((await within(fields).findAllByRole("button", { name: "Inspect exact result" }))[0]);
    expect(app.props.onInspect).toHaveBeenCalledWith(results[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save density report" }));
    expect(await screen.findByRole("region", { name: "Saved density report" })).toBeVisible();
    expect(app.execute).toHaveBeenCalledWith("spatial_density_save", { preview_id: reportId, preview_hash: hash });
    await screen.findByText("Current sample metadata matches this saved report.");
  });

  it("binds an exact phenotype group and an explicit directional condition pair", async () => {
    const app = mount(); selectFields(1);
    await waitFor(() => expect(screen.getByText("Saved density reports (0)")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "Count a saved phenotype" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Density phenotype name" }), { target: { value: "T cells" } });
    await screen.findByRole("option", { name: "CD3 positive · 2 members" });
    fireEvent.change(screen.getByRole("combobox", { name: /Phenotype group for Field 1/ }), { target: { value: `${groupId}:${groupHash}` } });
    await preview();
    expect(app.execute).toHaveBeenCalledWith("spatial_density_preview", { fields: [{ ...request.fields[0], phenotype_group_id: groupId, phenotype_record_sha256: groupHash }], stratum: { t: 0, z: 0 }, phenotype_name: "T cells" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Count a saved phenotype" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Density field: Field 2.tif · distance bands 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare paired conditions" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Density left condition" }), { target: { value: "Baseline" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Density right condition" }), { target: { value: "Treated" } });
    await preview();
    expect(app.execute).toHaveBeenCalledWith("spatial_density_preview", { ...request, condition_pair: ["Baseline", "Treated"] });
    expect(screen.getByText("Paired donors: Treated minus Baseline")).toBeVisible();
    expect(screen.getByRole("region", { name: "Paired density summaries" })).toBeVisible();
  });
  it("discards an in-flight preview when settings change and hides a stale preview after metadata changes", async () => {
    let finish!: (value: unknown) => void;
    let deferred = true;
    const app = mount({ response: (op) => op === "spatial_density_preview" && deferred ? new Promise((resolve) => { finish = resolve; }) : undefined });
    selectFields(); fireEvent.click(screen.getByRole("button", { name: "Preview donor density" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare paired conditions" }));
    await act(async () => finish(previewFor(reportFor())));
    expect(screen.queryByRole("region", { name: "Density preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save density report" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare paired conditions" })); deferred = false; await preview();
    app.rerender(<SpatialDensityPanel {...app.props} snapshot={{ ...snapshot, samples: samples.map((s) => ({ ...s, revision: 2 })) }} />);
    expect(screen.getByText(/Settings or source metadata changed/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Density preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save density report" })).toBeDisabled();
  });

  it("retains historical saved values while checking changed metadata", async () => {
    let changed = false;
    const original = reportFor();
    const app = mount({ saved: true, response: (op) => op === "spatial_density_get" ? savedFor(original, changed ? { current: false, changes: [{ result_id: results[0].id, reason: "sample_metadata_changed" }] } : { current: true, changes: [] }) : undefined });
    await openSaved(); await screen.findByText("Current sample metadata matches this saved report.");
    changed = true;
    app.rerender(<SpatialDensityPanel {...app.props} snapshot={{ ...snapshot, samples: samples.map((s) => ({ ...s, revision: 2 })) }} />);
    await screen.findByText("Sample metadata has changed. Historical report values remain unchanged.");
    expect(screen.getByRole("region", { name: "Condition density summaries" })).toHaveTextContent("Baseline");
    expect(app.execute).not.toHaveBeenCalledWith("spatial_density_preview", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Reuse settings for new preview" }));
    expect(await screen.findByRole("button", { name: "Save density report" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Density time and plane" })).toHaveValue("0:0");
  });

  it("shows audited missing donors without silently entering them in donor pools", async () => {
    const report = reportFor();
    report.aggregation.input_snapshots[0].sample!.data = { ...samples[0].data, biological_replicate: null };
    report.aggregation.field_rows[0].metadata = report.aggregation.input_snapshots[0].sample!.data;
    report.aggregation.field_rows[0].included_in_donor_pool = false;
    report.aggregation.exclusion_audit[0].reasons = ["missing_biological_replicate"];
    report.aggregation.donor_rows = report.aggregation.donor_rows.slice(1);
    report.aggregation.condition_rows[0] = { ...report.aggregation.condition_rows[0], n: 0, n_donors_total: 0, mean: null, sd: null, median: null };
    mount({ saved: true, response: (op, args) => op === "spatial_density_get" ? savedFor(report) : op === "spatial_density_query" ? pageFor(report, args) : undefined });
    await openSaved();
    await waitFor(() => expect(screen.getByRole("region", { name: "Density exclusion audit" })).toHaveTextContent("Donor not declared"));
    expect(screen.getByText("2 selected fields · 1 excluded from donor pools.")).toBeVisible();
  });

  it("uses a fresh native export plan, handles picker cancellation, and requests cooperative cancellation", async () => {
    const app = mount({ saved: true }); await openSaved();
    app.exportSpatialDensityReport.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Export density report…" }));
    await screen.findByText("Destination selection cancelled. The saved report is unchanged.");
    expect(app.planSpatialDensityExport).toHaveBeenCalledWith(reportId, expect.stringMatching(/^scientific-export:/));
    let finish!: (value: unknown) => void;
    app.exportSpatialDensityReport.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Export density report…" }));
    await waitFor(() => expect(app.exportSpatialDensityReport).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Cancel density export" }));
    await screen.findByText(/Cancellation requested/);
    expect(app.cancelDataExport).toHaveBeenCalledWith(app.planSpatialDensityExport.mock.calls[1][1]);
    await act(async () => finish({ schema: "loci.spatial-density-export-receipt/v1", report_hash: hash, basename: "Late report", manifest_sha256: hash }));
    expect(screen.queryByText(/Saved Late report/)).not.toBeInTheDocument();
  });

  it("rejects an export plan for a different saved report before opening its picker", async () => {
    const app = mount({ saved: true }); await openSaved();
    app.planSpatialDensityExport.mockResolvedValueOnce({ schema: "loci.spatial-density-export-plan/v1", report_id: reportId, report_hash: "1".repeat(64), plan_hash: hash, status: { current: true, changes: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Export density report…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match this saved density report");
    expect(app.exportSpatialDensityReport).not.toHaveBeenCalled();
  });
});

describe("Density report boundary validation", () => {
  it("accepts the engine's explicit null optional metadata while retaining the original sample document", () => {
    const report = reportFor();
    report.aggregation.field_rows[0].metadata = { ...samples[0].data, plate: null, well: null };
    expect(checkedSpatialDensityReport(report, request, snapshot)).toBe(report);
    expect(report.aggregation.input_snapshots[0].sample!.data).not.toHaveProperty("plate");
  });
  it.each([
    (r: SpatialDensityReport) => { r.aggregation.contract.area_unit = "mm^2"; },
    (r: SpatialDensityReport) => { r.aggregation.input_snapshots[0].result.revision_hash = "0".repeat(64); },
    (r: SpatialDensityReport) => { r.aggregation.field_rows[0].source_sha256 = "0".repeat(64); },
    (r: SpatialDensityReport) => { r.aggregation.field_rows[0].density = NaN; },
    (r: SpatialDensityReport) => { r.aggregation.donor_rows[0].sampled_area = Infinity; },
    (r: SpatialDensityReport) => { r.aggregation.condition_rows[0].mean = Infinity; },
    (r: SpatialDensityReport) => { r.aggregation.condition_rows[0].sd = 0; },
    (r: SpatialDensityReport) => { r.aggregation.stratum.z = 1; },
    (r: SpatialDensityReport) => { r.aggregation.condition_pair = ["Treated", "Baseline"]; },
  ])("rejects malformed numerical or exact-binding state", (mutate) => {
    const report = structuredClone(reportFor()); mutate(report);
    expect(() => checkedSpatialDensityReport(report, request, snapshot)).toThrow(/invalid|exact selected/);
  });
  it("accepts undefined zero-area density without converting it into zero", () => {
    const report = reportFor();
    report.aggregation.field_rows[0] = { ...report.aggregation.field_rows[0], sampled_area: 0, sampled_pixel_count: 0, object_count: 0, density: null, density_status: "undefined_zero_area" };
    expect(checkedSpatialDensityReport(report, request, snapshot).aggregation.field_rows[0].density).toBeNull();
  });
});

function manyFields(count: number) {
  const report = reportFor(), a = report.aggregation, first = structuredClone(a.input_snapshots[0]);
  const fullSnapshot = structuredClone(snapshot);
  fullSnapshot.sources = []; fullSnapshot.results = []; fullSnapshot.samples = [];
  a.input_snapshots = []; a.field_rows = []; a.donor_rows = []; a.exclusion_audit = [];
  for (let index = 0; index < count; index++) {
    const field = structuredClone(first), resultId = (index + 1).toString(16).padStart(32, "0"), sourceId = (index + 1000).toString(16).padStart(32, "0");
    const revision = createHash("sha256").update(resultId).digest("hex"), sourceHash = createHash("sha256").update(sourceId).digest("hex");
    field.result = { ...field.result, id: resultId, revision_hash: revision, source_id: sourceId, source_sha256: sourceHash };
    field.sample = { id: sourceId, revision: 1, data: { study: "Study A", sample: "Field " + (index + 1), condition: "Baseline", biological_replicate: "Donor " + (index + 1) } };
    a.input_snapshots.push(field);
    a.field_rows.push({ ...reportFor().aggregation.field_rows[0], result_id: resultId, revision_hash: revision, source_id: sourceId, source_sha256: sourceHash, metadata: field.sample.data });
    a.donor_rows.push({ ...reportFor().aggregation.donor_rows[0], biological_replicate: field.sample.data.biological_replicate!, field_result_ids: [resultId] });
    a.exclusion_audit.push({ result_id: resultId, revision_hash: revision, reasons: [], object_exclusions: { crop_border: 1 } });
    fullSnapshot.sources.push({ ...snapshot.sources[0], id: sourceId, sha256: sourceHash, name: "Field " + (index + 1) + ".tif" });
    fullSnapshot.results.push({ ...results[0], id: resultId, revision_hash: revision, source_id: sourceId, source_sha256: sourceHash });
    fullSnapshot.samples.push(field.sample);
  }
  a.condition_rows = [{ ...reportFor().aggregation.condition_rows[0], n: count, n_donors_total: count, sd: count > 1 ? 0 : null }];
  report.request = { fields: a.input_snapshots.map((f) => ({ result_id: f.result.id, revision_hash: f.result.revision_hash })), stratum: { t: 0, z: 0 } };
  return { report, snapshot: fullSnapshot };
}

describe("Bounded density browsing and retained identities", () => {
  it("keeps condition and donor cursors independent and queries unopened tables lazily", async () => {
    const report = reportFor();
    report.aggregation.condition_rows = Array.from({ length: 61 }, (_, i) => ({ ...reportFor().aggregation.condition_rows[0], condition: "Condition " + (i + 1) }));
    report.aggregation.donor_rows = Array.from({ length: 111 }, (_, i) => ({ ...reportFor().aggregation.donor_rows[0], biological_replicate: "Donor " + (i + 1) }));
    const app = mount({ saved: true, response: (op, args) => op === "spatial_density_get" ? savedFor(report) : op === "spatial_density_query" ? pageFor(report, args) : undefined });
    await openSaved();
    const conditionPages = screen.getByRole("group", { name: "Condition density summaries pages" });
    await within(conditionPages).findByText("Rows 1–50 of 61");
    expect(app.execute.mock.calls.some(([op, args]) => op === "spatial_density_query" && args.table === "donor_rows")).toBe(false);
    fireEvent.click(within(conditionPages).getByRole("button", { name: "Next" }));
    await within(conditionPages).findByText("Rows 51–61 of 61");
    fireEvent.click(screen.getByText("Donor counts, sampled areas and densities (111)"));
    const donorPages = await screen.findByRole("group", { name: "Donor density endpoints pages" });
    await within(donorPages).findByText("Rows 1–50 of 111");
    fireEvent.click(within(donorPages).getByRole("button", { name: "Next" }));
    await within(donorPages).findByText("Rows 51–100 of 111");
    expect(conditionPages).toHaveTextContent("Rows 51–61 of 61");
    fireEvent.click(within(donorPages).getByRole("button", { name: "Previous" }));
    await within(donorPages).findByText("Rows 1–50 of 111");
    expect(conditionPages).toHaveTextContent("Rows 51–61 of 61");
  });

  it("uses the engine's returned cursor when the byte cap shortens a page", async () => {
    const report = reportFor();
    report.aggregation.condition_rows = Array.from({ length: 7 }, (_, i) => ({ ...reportFor().aggregation.condition_rows[0], condition: "Condition " + (i + 1) }));
    const app = mount({ saved: true, response: (op, args) => op === "spatial_density_get" ? savedFor(report) : op === "spatial_density_query" ? pageFor(report, args, 2) : undefined });
    await openSaved();
    const pages = screen.getByRole("group", { name: "Condition density summaries pages" });
    await within(pages).findByText("Rows 1–2 of 7");
    fireEvent.click(within(pages).getByRole("button", { name: "Next" }));
    await within(pages).findByText("Rows 3–4 of 7");
    expect(app.execute).toHaveBeenCalledWith("spatial_density_query", { report_id: reportId, table: "condition_rows", offset: 2, limit: 50 });
    fireEvent.click(within(pages).getByRole("button", { name: "Previous" }));
    await within(pages).findByText("Rows 1–2 of 7");
  });

  it("discards a late page from the previous report and starts the new report at its first page", async () => {
    const first = reportFor(), second = reportFor(), secondId = "9".repeat(32);
    first.aggregation.condition_rows = Array.from({ length: 60 }, (_, i) => ({ ...reportFor().aggregation.condition_rows[0], condition: "Old condition " + (i + 1) }));
    second.report_hash = "9".repeat(64); second.aggregation.condition_rows[0].condition = "New report condition";
    let finish!: (value: unknown) => void;
    const app = mount({ saved: true, response: (op, args) => {
      if (op === "spatial_density_list") return { reports: [first, second].map((r) => ({ id: r.report_hash.slice(0, 32), created_at: r.created_at, phenotype_name: null, stratum: { t: 0, z: 0 }, status: { current: true, changes: [] } })) };
      if (op === "spatial_density_get") return savedFor(args.report_id === secondId ? second : first);
      if (op === "spatial_density_query") {
        if (args.report_id === reportId && args.offset === 50) return new Promise((resolve) => { finish = resolve; });
        return pageFor(args.report_id === secondId ? second : first, args);
      }
    } });
    await screen.findByText("Saved density reports (2)");
    fireEvent.click(screen.getByText("Saved density reports (2)"));
    fireEvent.click(screen.getByRole("button", { name: "Open density report " + reportId }));
    await screen.findByText("Rows 1–50 of 60");
    fireEvent.click(within(screen.getByRole("group", { name: "Condition density summaries pages" })).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "Open density report " + secondId }));
    await screen.findByRole("rowheader", { name: /New report condition/u });
    await act(async () => finish(pageFor(first, { table: "condition_rows", offset: 50, limit: 50 })));
    expect(screen.queryByRole("rowheader", { name: /Old condition 51/u })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Condition density summaries pages" })).toHaveTextContent("Rows 1–2 of 2");
    expect(app.execute).toHaveBeenCalledWith("spatial_density_query", { report_id: secondId, table: "condition_rows", offset: 0, limit: 50 });
  });

  it("reuses all 40 exact field bindings only after every bounded page arrives", async () => {
    const fixture = manyFields(40);
    let finish!: (value: unknown) => void;
    const app = mount({ saved: true, snapshot: fixture.snapshot, response: (op, args) => {
      if (op === "spatial_density_get") return savedFor(fixture.report);
      if (op === "spatial_density_query") {
        if (args.table === "input_snapshots" && args.offset === 39) return new Promise((resolve) => { finish = resolve; });
        return pageFor(fixture.report, args, args.table === "input_snapshots" ? 13 : undefined);
      }
    } });
    await openSaved();
    fireEvent.click(screen.getByRole("button", { name: "Reuse settings for new preview" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(screen.getByRole("region", { name: "Saved density report" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save density report" })).not.toBeInTheDocument();
    await act(async () => finish(pageFor(fixture.report, { table: "input_snapshots", offset: 39, limit: 100 }, 13)));
    expect(await screen.findByRole("button", { name: "Save density report" })).toBeDisabled();
    expect(screen.getAllByRole("checkbox", { name: /^Density field:/u })).toHaveLength(40);
    for (const checkbox of screen.getAllByRole("checkbox", { name: /^Density field:/u })) expect(checkbox).toBeChecked();
    expect(app.execute.mock.calls.filter(([op, args]) => op === "spatial_density_query" && args.table === "input_snapshots").map(([, args]) => args.offset)).toEqual([0, 13, 26, 39]);
    expect(app.execute).not.toHaveBeenCalledWith("spatial_density_preview", expect.anything());
  });

  it("does not partially restore settings when a later exact-binding page has the wrong identity", async () => {
    const fixture = manyFields(7);
    mount({ saved: true, snapshot: fixture.snapshot, response: (op, args) => {
      if (op === "spatial_density_get") return savedFor(fixture.report);
      if (op === "spatial_density_query") {
        const page = pageFor(fixture.report, args, 3);
        return args.table === "input_snapshots" && args.offset === 3 ? { ...page, report_hash: "0".repeat(64) } : page;
      }
    } });
    await openSaved();
    fireEvent.click(screen.getByRole("button", { name: "Reuse settings for new preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match the exact selected inputs");
    expect(screen.getByRole("region", { name: "Saved density report" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save density report" })).not.toBeInTheDocument();
  });

  it("refuses a retained preview whose request hash belongs to different selected fields", async () => {
    const retained = previewFor(reportFor()); retained.summary.request_sha256 = "0".repeat(64);
    const app = mount({ response: (op) => op === "spatial_density_preview" ? retained : undefined });
    selectFields(); fireEvent.click(screen.getByRole("button", { name: "Preview donor density" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match the exact selected inputs");
    expect(screen.getByRole("button", { name: "Save density report" })).toBeDisabled();
    expect(app.execute).not.toHaveBeenCalledWith("spatial_density_save", expect.anything());
  });

  it("opens, exports and reuses validated projected bindings from a historical v1 report", async () => {
    const report = reportFor(), saved = savedFor(report);
    const legacy = { ...saved, report: { ...report, schema: "loci.spatial-density-report/v1" },
      summary: { ...saved.summary, report_schema: "loci.spatial-density-report/v1", request_sha256: createHash("sha256").update("null").digest("hex") } };
    const app = mount({ saved: true, response: (op, args) => op === "spatial_density_get" ? legacy : op === "spatial_density_query" ? pageFor(report, args) : undefined });
    await openSaved();
    expect(screen.getByText(/Historical report format/)).toBeVisible();
    await screen.findByText("Rows 1–2 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Export density report…" }));
    await screen.findByText("Saved Density report. Exact report values and provenance were exported.");
    fireEvent.click(screen.getByRole("button", { name: "Reuse settings for new preview" }));
    expect(await screen.findByRole("button", { name: "Save density report" })).toBeDisabled();
    for (const checkbox of screen.getAllByRole("checkbox", { name: /^Density field:/u })) expect(checkbox).toBeChecked();
    expect(app.execute).not.toHaveBeenCalledWith("spatial_density_save", expect.anything());
  });

  it("matches a Python canonical request hash including CJK, astral and escaped characters", async () => {
    // Independent hashlib/json.dumps(sort_keys=True,separators=(",",":"),ensure_ascii=True) oracle.
    const req = { fields: [request.fields[0]], stratum: { t: 0, z: 0 }, phenotype_name: "T细胞 🧬 café\u007f" };
    expect(await spatialDensityRequestHash(req)).toBe("d715ee6351becf58b93b764a5ebe2e87101fc50e028ae1416556d67de3307487");
  });

  it.each([
    { report_hash: "0".repeat(64) }, { table: "donor_rows" }, { offset: 1 }, { limit: 100 },
    { total: 3 }, { returned: 0 }, { next_offset: 0 },
  ])("rejects mismatched or nonprogressing page metadata %o", (change) => {
    const report = reportFor(), page = pageFor(report, { table: "condition_rows", offset: 0, limit: 50 });
    expect(() => checkedSpatialDensityPage({ ...page, ...change }, summaryFor(report), "condition_rows", 0, 50)).toThrow(/invalid|exact selected/);
  });
});
