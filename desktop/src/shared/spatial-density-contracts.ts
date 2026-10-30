import type { ResearchSampleData, ResearchSnapshot } from "./research-contracts";

export interface SpatialDensityRequest {
  fields: Array<{ result_id: string; revision_hash: string; phenotype_group_id?: string; phenotype_record_sha256?: string }>;
  phenotype_name?: string; stratum?: { t: number; z: number }; condition_pair?: [string, string];
}
export interface SpatialDensityStatus { current: boolean; changes: Array<{ result_id: string; reason: string }> }
export interface SpatialDensityGroup {
  id: string; name: string; result_id: string; revision_hash: string; source_id: string; source_sha256: string;
  record_sha256: string; included_count: number; source_available?: boolean;
}
export interface SpatialDensityContract {
  distance_unit: string; area_unit: string; band_edges: number[]; rules: Record<string, string>; exclude_crop_border: boolean;
}
export interface SpatialDensityInput {
  result: {
    projection_schema: "loci.spatial-density-field/v2"; id: string; revision_hash: string; source_id: string; source_sha256: string;
    record_sha256: string; selection: { t: number; z: number }; geometry: Record<string, unknown>;
    contract: SpatialDensityContract; bands: unknown[]; object_exclusions: Record<string, number>;
  };
  sample: { id: string; revision: number; data: ResearchSampleData } | null;
  phenotype: {
    id: string; name: string; record_sha256: string; snapshot_sha256: string; result_id: string; revision_hash: string;
    source_id: string; source_sha256: string; membership_sha256: string; population_sha256: string;
  } | null;
}
export interface SpatialDensityField {
  result_id: string; revision_hash: string; source_id: string; source_sha256: string;
  metadata: ResearchSampleData | null; selection: { t: number; z: number };
  included_in_donor_pool: boolean; band_index: number; lower: number; upper: number;
  object_count: number; eligible_object_count: number; sampled_area: number; sampled_pixel_count: number;
  density: number | null; density_status: "defined" | "undefined_zero_area";
}
export interface SpatialDensityDonor {
  study: string; condition: string; biological_replicate: string; band_index: number;
  object_count: number; sampled_area: number; density: number | null;
  density_status: "defined" | "undefined_zero_area"; field_result_ids: string[]; n_fields: number;
}
export interface SpatialDensityDescription { n: number; mean: number | null; sd: number | null; median: number | null }
export interface SpatialDensityCondition extends SpatialDensityDescription {
  study: string; condition: string; band_index: number; n_donors_total: number; n_undefined_zero_area: number;
}
export interface SpatialDensityPair {
  study: string; biological_replicate: string; left_condition: string; right_condition: string; band_index: number;
  left_density: number | null; right_density: number | null; difference: number | null; status: "defined" | "undefined_zero_area";
}
export interface SpatialDensityTables {
  input_snapshots: SpatialDensityInput[];
  field_rows: SpatialDensityField[];
  donor_rows: SpatialDensityDonor[];
  condition_rows: SpatialDensityCondition[];
  paired_rows: SpatialDensityPair[];
  paired_summary: Array<SpatialDensityDescription & { study: string; left_condition: string; right_condition: string; band_index: number }>;
  unmatched_donors: Array<{ study: string; condition: string; biological_replicate: string; reason: string }>;
  exclusion_audit: Array<{ result_id: string; revision_hash: string; reasons: string[]; object_exclusions: Record<string, number> }>;
}
export const spatialDensityTables = ["input_snapshots", "field_rows", "donor_rows", "condition_rows", "paired_rows", "paired_summary", "unmatched_donors", "exclusion_audit"] as const;
export type SpatialDensityTable = typeof spatialDensityTables[number];
export interface SpatialDensityAggregation extends SpatialDensityTables {
  schema: string; rules: Record<string, string>; contract: SpatialDensityContract;
  stratum: { t: number; z: number }; phenotype_name: string | null; condition_pair: [string, string] | null;
}
interface ReportIdentity {
  created_at: string; report_hash: string;
  software: { engine: string; aggregation_sha256: string; dispatcher_sha256: string };
}
export interface SpatialDensityReport extends ReportIdentity {
  schema: "loci.spatial-density-report/v2"; aggregation: SpatialDensityAggregation; request: SpatialDensityRequest;
}
export interface SpatialDensityViewSummary extends ReportIdentity {
  schema: "loci.spatial-density-summary/v1"; report_schema: "loci.spatial-density-report/v1" | "loci.spatial-density-report/v2"; request_sha256: string;
  aggregation: SpatialDensityAggregation;
  tables: Record<SpatialDensityTable, { total: number; returned: number; has_more: boolean; next_offset: number | null }>;
  totals: { selected_fields: number; excluded_fields: number; donor_rows: number; condition_rows: number; paired_rows: number };
}
export interface SpatialDensityPreview { preview_id: string; preview_hash: string; summary: SpatialDensityViewSummary }
export type SpatialDensityTarget = { preview_id: string; preview_hash: string } | { report_id: string };
export interface SpatialDensityPage<T extends SpatialDensityTable = SpatialDensityTable> {
  schema: "loci.spatial-density-page/v1"; report_hash: string; table: T;
  offset: number; limit: number; total: number; returned: number; rows: SpatialDensityTables[T]; next_offset: number | null;
}
export interface SpatialDensitySaved { report_id: string; report: ReportIdentity & { schema: SpatialDensityViewSummary["report_schema"] }; summary: SpatialDensityViewSummary; status: SpatialDensityStatus }
export interface SpatialDensitySummary {
  id: string; created_at: string; phenotype_name: string | null; stratum: { t: number; z: number }; status: SpatialDensityStatus;
}
export interface SpatialDensityExportPlan {
  schema: "loci.spatial-density-export-plan/v1"; report_id: string; report_hash: string; plan_hash: string; status: SpatialDensityStatus;
}
export interface SpatialDensityExportReceipt {
  schema: "loci.spatial-density-export-receipt/v1"; basename: string; report_hash: string; manifest_sha256: string;
}

const id = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/u.test(v);
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2048;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nullable = (v: unknown) => v === null || finite(v);
const stratum = (v: unknown): v is { t: number; z: number } => Boolean(v && typeof v === "object" && count((v as { t: number }).t) && count((v as { z: number }).z));
const tableLimits: Record<SpatialDensityTable, number> = { input_snapshots: 256, field_rows: 8192, donor_rows: 8192, condition_rows: 8192, paired_rows: 8192, paired_summary: 8192, unmatched_donors: 512, exclusion_audit: 256 };
function fail(): never { throw new Error("The density report is invalid or does not match the exact selected inputs. Preview again."); }
function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index] &&
    sameData((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
function sameSample(left: ResearchSampleData | null, right: ResearchSampleData | null): boolean {
  if (left === null || right === null) return left === right;
  return ["study", "sample", "condition", "biological_replicate", "plate", "well"].every((key) =>
    (left?.[key as keyof ResearchSampleData] ?? null) === (right?.[key as keyof ResearchSampleData] ?? null));
}
function sample(v: ResearchSampleData | null): boolean {
  return v === null || Boolean(v && text(v.study) && text(v.sample) && text(v.condition) &&
    (v.biological_replicate == null || text(v.biological_replicate)));
}
function contract(c: SpatialDensityContract): boolean {
  return Boolean(c && ["um", "mm", "nm", "m"].includes(c.distance_unit) && c.area_unit === c.distance_unit + "^2" &&
    Array.isArray(c.band_edges) && c.band_edges.length >= 2 && c.band_edges.length <= 33 &&
    c.band_edges.every((v, i) => finite(v) && v >= 0 && (i === 0 || v > c.band_edges[i - 1])) &&
    typeof c.exclude_crop_border === "boolean" && c.rules && typeof c.rules === "object");
}
function input(field: SpatialDensityInput): void {
  const r = field?.result;
  if (!r || r.projection_schema !== "loci.spatial-density-field/v2" || !id(r.id) || !sha(r.revision_hash) || !id(r.source_id) ||
      !sha(r.source_sha256) || !sha(r.record_sha256) || !stratum(r.selection) || !contract(r.contract) || !r.geometry ||
      !Array.isArray(r.bands) || r.bands.length > 32 || !r.object_exclusions ||
      Object.values(r.object_exclusions).some((n) => !count(n))) fail();
  if (field.sample !== null && (!field.sample || field.sample.id !== r.source_id || !count(field.sample.revision) || !sample(field.sample.data))) fail();
  const p = field.phenotype;
  if (p !== null && (!p || !id(p.id) || !text(p.name) || !sha(p.record_sha256) || !sha(p.snapshot_sha256) || !id(p.result_id) ||
      !sha(p.revision_hash) || p.source_id !== r.source_id || p.source_sha256 !== r.source_sha256 || !sha(p.membership_sha256) || !sha(p.population_sha256))) fail();
}
function header(report: ReportIdentity, a: SpatialDensityAggregation): void {
  if (!report || !sha(report.report_hash) || !text(report.created_at) || !report.software || !text(report.software.engine) ||
      !sha(report.software.aggregation_sha256) || !sha(report.software.dispatcher_sha256) || !a ||
      !["loci.spatial-density-aggregation/v1", "loci.spatial-density-aggregation/v2"].includes(a.schema) ||
      !stratum(a.stratum) || !contract(a.contract) || !a.rules || typeof a.rules !== "object" ||
      (a.phenotype_name !== null && !text(a.phenotype_name)) || (a.condition_pair !== null &&
       (!Array.isArray(a.condition_pair) || a.condition_pair.length !== 2 || a.condition_pair.some((v) => !text(v)) || a.condition_pair[0] === a.condition_pair[1]))) fail();
}
/** Validate visible rows without recalculating scientific endpoints. Hash/arithmetic authority remains in the engine. */
function rows<T extends SpatialDensityTable>(table: T, values: SpatialDensityTables[T], a: SpatialDensityAggregation): void {
  if (!Array.isArray(values) || values.length > tableLimits[table]) fail();
  const band = (v: unknown) => count(v) && v < a.contract.band_edges.length - 1;
  const density = (r: { density: number | null; sampled_area: number; density_status: string }) => finite(r.sampled_area) && r.sampled_area >= 0 &&
    (r.sampled_area === 0 ? r.density === null && r.density_status === "undefined_zero_area" : finite(r.density) && r.density >= 0 && r.density_status === "defined");
  const description = (r: SpatialDensityDescription) => count(r.n) && nullable(r.mean) && nullable(r.sd) && nullable(r.median) &&
    (r.n === 0 ? r.mean === null && r.median === null : r.mean !== null && r.median !== null) &&
    (r.n < 2 ? r.sd === null : finite(r.sd) && r.sd >= 0);
  // Each case narrows the indexed table schema. The wire value is checked before use.
  switch (table) {
    case "input_snapshots": {
      const v = values as SpatialDensityInput[]; v.forEach(input);
      if (new Set(v.map((r) => r.result.id)).size !== v.length) fail(); break;
    }
    case "field_rows":
      for (const r of values as SpatialDensityField[]) if (!r || !id(r.result_id) || !sha(r.revision_hash) || !id(r.source_id) ||
        !sha(r.source_sha256) || !count(r.band_index) || r.band_index >= 32 || !finite(r.lower) || !finite(r.upper) || r.lower < 0 || r.upper <= r.lower ||
        !count(r.object_count) || !count(r.eligible_object_count) || r.object_count > r.eligible_object_count || !count(r.sampled_pixel_count) ||
        typeof r.included_in_donor_pool !== "boolean" || !sample(r.metadata) || !stratum(r.selection) || !density(r) ||
        (r.included_in_donor_pool && (!band(r.band_index) || r.lower !== a.contract.band_edges[r.band_index] || r.upper !== a.contract.band_edges[r.band_index + 1]))) fail();
      break;
    case "donor_rows":
      for (const r of values as SpatialDensityDonor[]) if (!r || !text(r.study) || !text(r.condition) || !text(r.biological_replicate) || !band(r.band_index) ||
        !count(r.object_count) || !count(r.n_fields) || !Array.isArray(r.field_result_ids) || r.n_fields !== r.field_result_ids.length ||
        r.field_result_ids.some((value) => !id(value)) || !density(r)) fail();
      break;
    case "condition_rows":
      for (const r of values as SpatialDensityCondition[]) if (!r || !text(r.study) || !text(r.condition) || !band(r.band_index) || !description(r) ||
        !count(r.n_donors_total) || !count(r.n_undefined_zero_area) || r.n + r.n_undefined_zero_area !== r.n_donors_total ||
        r.mean !== null && r.mean < 0 || r.median !== null && r.median < 0) fail();
      break;
    case "paired_rows":
      for (const r of values as SpatialDensityPair[]) if (!r || !text(r.study) || !text(r.biological_replicate) || !band(r.band_index) ||
        !a.condition_pair || r.left_condition !== a.condition_pair[0] || r.right_condition !== a.condition_pair[1] ||
        !nullable(r.left_density) || !nullable(r.right_density) || !nullable(r.difference) ||
        r.left_density !== null && r.left_density < 0 || r.right_density !== null && r.right_density < 0 ||
        (r.left_density === null || r.right_density === null ? r.difference !== null || r.status !== "undefined_zero_area" : r.difference === null || r.status !== "defined")) fail();
      break;
    case "paired_summary":
      for (const r of values as SpatialDensityTables["paired_summary"]) if (!r || !text(r.study) || !band(r.band_index) || !description(r) ||
        !a.condition_pair || r.left_condition !== a.condition_pair[0] || r.right_condition !== a.condition_pair[1]) fail();
      break;
    case "unmatched_donors":
      for (const r of values as SpatialDensityTables["unmatched_donors"]) if (!r || !text(r.study) || !text(r.condition) ||
        !text(r.biological_replicate) || r.reason !== "missing_paired_condition") fail();
      break;
    case "exclusion_audit":
      for (const r of values as SpatialDensityTables["exclusion_audit"]) if (!r || !id(r.result_id) || !sha(r.revision_hash) ||
        !Array.isArray(r.reasons) || r.reasons.some((reason) => !["missing_sample_metadata", "missing_biological_replicate", "outside_explicit_stratum"].includes(reason)) ||
        !r.object_exclusions || Object.entries(r.object_exclusions).some(([reason, n]) => !["crop_border", "outside_compartment", "outside_bands"].includes(reason) || !count(n))) fail();
      break;
  }
}
function requestBinding(a: SpatialDensityAggregation, request: SpatialDensityRequest, snapshot?: ResearchSnapshot): void {
  if ((request.phenotype_name ?? null) !== a.phenotype_name || !sameData(request.condition_pair ?? null, a.condition_pair) ||
      request.stratum && !sameData(request.stratum, a.stratum)) fail();
  for (const f of a.input_snapshots) {
    const r = f.result, binding = request.fields.find((b) => b.result_id === r.id);
    if (!binding || r.revision_hash !== binding.revision_hash || (binding.phenotype_group_id ?? null) !== (f.phenotype?.id ?? null) ||
        (binding.phenotype_record_sha256 ?? null) !== (f.phenotype?.record_sha256 ?? null)) fail();
    if (snapshot) {
      const current = snapshot.results.find((v) => v.id === r.id && v.revision_hash === r.revision_hash);
      const currentSample = snapshot.samples.find((v) => v.id === r.source_id), source = snapshot.sources.find((v) => v.id === r.source_id);
      const spatial = current?.spatial as { distance_unit?: string; area_unit?: string } | undefined;
      if (!current || current.source_id !== r.source_id || current.source_sha256 !== r.source_sha256 || source?.sha256 !== r.source_sha256 ||
          spatial?.distance_unit !== r.contract.distance_unit || spatial?.area_unit !== r.contract.area_unit ||
          current.selection?.t !== r.selection.t || current.selection?.z !== r.selection.z ||
          (currentSample?.revision ?? null) !== (f.sample?.revision ?? null) || !sameData(currentSample?.data ?? null, f.sample?.data ?? null)) fail();
    }
  }
}
export function checkedSpatialDensityStatus(value: unknown): SpatialDensityStatus {
  const s = value as SpatialDensityStatus;
  if (!s || typeof s.current !== "boolean" || !Array.isArray(s.changes) || s.changes.length > 256 ||
      s.changes.some((r) => !r || !id(r.result_id) || !text(r.reason)) || s.current !== (s.changes.length === 0)) fail();
  return s;
}
export function checkedSpatialDensityViewSummary(value: unknown, request?: SpatialDensityRequest, snapshot?: ResearchSnapshot): SpatialDensityViewSummary {
  const s = value as SpatialDensityViewSummary;
  if (!s || s.schema !== "loci.spatial-density-summary/v1" || !["loci.spatial-density-report/v1", "loci.spatial-density-report/v2"].includes(s.report_schema) || !sha(s.request_sha256) ||
      new TextEncoder().encode(JSON.stringify(s)).length > 64 * 1024 || !s.tables || !s.totals) fail();
  header(s, s.aggregation);
  for (const table of spatialDensityTables) {
    const t = s.tables[table], v = s.aggregation[table];
    if (!t || !count(t.total) || t.total > tableLimits[table] || !count(t.returned) || t.returned > 5 ||
        !Array.isArray(v) || v.length !== t.returned || t.returned > t.total ||
        t.has_more !== (t.returned < t.total) || t.next_offset !== (t.has_more ? t.returned : null)) fail();
    rows(table, v, s.aggregation);
  }
  if (s.totals.selected_fields !== s.tables.input_snapshots.total || !s.totals.selected_fields ||
      !count(s.totals.excluded_fields) || s.totals.excluded_fields > s.totals.selected_fields ||
      s.tables.exclusion_audit.total !== s.totals.selected_fields ||
      s.totals.donor_rows !== s.tables.donor_rows.total || s.totals.condition_rows !== s.tables.condition_rows.total ||
      s.totals.paired_rows !== s.tables.paired_rows.total || request && request.fields.length !== s.totals.selected_fields) fail();
  if (request) requestBinding(s.aggregation, request, snapshot);
  return s;
}
/** Python canonical_json uses sorted ASCII keys, ensure_ascii=True and integer request numbers. */
export async function spatialDensityRequestHash(request: SpatialDensityRequest): Promise<string> {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => JSON.stringify(key) + ":" + canonical(v)).join(",") + "}";
    // Work on UTF-16 code units so astral characters use Python's surrogate-pair escapes.
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(request)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function checkedSpatialDensityPreview(value: unknown, request: SpatialDensityRequest, snapshot: ResearchSnapshot, requestHash: string): SpatialDensityPreview {
  const p = value as SpatialDensityPreview, summary = checkedSpatialDensityViewSummary(p?.summary, request, snapshot);
  if (summary.report_schema !== "loci.spatial-density-report/v2" || !id(p.preview_id) || !sha(p.preview_hash) || p.preview_hash !== summary.report_hash || p.preview_id !== p.preview_hash.slice(0, 32) ||
      summary.request_sha256 !== requestHash) fail();
  return p;
}
export function checkedSpatialDensityPage<T extends SpatialDensityTable>(value: unknown, summary: SpatialDensityViewSummary, table: T, offset: number, limit: number, inputs?: SpatialDensityInput[]): SpatialDensityPage<T> {
  const p = value as SpatialDensityPage<T>;
  if (!p || p.schema !== "loci.spatial-density-page/v1" || p.report_hash !== summary.report_hash || p.table !== table || p.offset !== offset || p.limit !== limit ||
      p.total !== summary.tables[table].total || !count(p.returned) || p.returned > limit || !Array.isArray(p.rows) || p.rows.length !== p.returned ||
      offset + p.returned > p.total || offset < p.total && p.returned === 0 ||
      p.next_offset !== (offset + p.returned < p.total ? offset + p.returned : null) ||
      new TextEncoder().encode(JSON.stringify(p)).length > 64 * 1024) fail();
  rows(table, p.rows, summary.aggregation);
  if (inputs && (table === "field_rows" || table === "exclusion_audit")) {
    for (const row of p.rows as SpatialDensityField[] | SpatialDensityTables["exclusion_audit"]) {
      const bound = inputs.find((f) => f.result.id === row.result_id);
      if (!bound || row.revision_hash !== bound.result.revision_hash) fail();
      if ("source_id" in row && (row.source_id !== bound.result.source_id || row.source_sha256 !== bound.result.source_sha256 ||
          !sameSample(row.metadata, bound.sample?.data ?? null) ||
          row.selection.t !== bound.result.selection.t || row.selection.z !== bound.result.selection.z)) fail();
    }
  }
  return p;
}
export function checkedSpatialDensityReport(value: unknown, request?: SpatialDensityRequest, snapshot?: ResearchSnapshot): SpatialDensityReport {
  const r = value as SpatialDensityReport;
  if (!r || r.schema !== "loci.spatial-density-report/v2") fail();
  header(r, r.aggregation);
  for (const table of spatialDensityTables) rows(table, r.aggregation[table], r.aggregation);
  const inputs = new Map(r.aggregation.input_snapshots.map((f) => [f.result.id, f]));
  if (!inputs.size || inputs.size !== r.aggregation.input_snapshots.length || r.aggregation.exclusion_audit.length !== inputs.size) fail();
  for (const f of r.aggregation.field_rows) {
    const bound = inputs.get(f.result_id);
    if (!bound || f.revision_hash !== bound.result.revision_hash || f.source_id !== bound.result.source_id || f.source_sha256 !== bound.result.source_sha256 ||
        !sameSample(f.metadata, bound.sample?.data ?? null) || !sameData(f.selection, { t: bound.result.selection.t, z: bound.result.selection.z })) fail();
  }
  if (request) { if (request.fields.length !== inputs.size) fail(); requestBinding(r.aggregation, request, snapshot); }
  return r;
}
export function checkedSpatialDensitySaved(value: unknown): SpatialDensitySaved {
  const s = value as SpatialDensitySaved, summary = checkedSpatialDensityViewSummary(s?.summary);
  if (!id(s.report_id) || s.report_id !== summary.report_hash.slice(0, 32) || s.report?.schema !== summary.report_schema || s.report.report_hash !== summary.report_hash) fail();
  checkedSpatialDensityStatus(s.status);
  return s;
}
export function checkedSpatialDensityGroups(value: unknown): SpatialDensityGroup[] {
  const response = value as { schema: string; groups: SpatialDensityGroup[] };
  if (!response || response.schema !== "loci.population-group-list/v1" || !Array.isArray(response.groups) || response.groups.length > 10000 ||
      response.groups.some((g) => !g || !id(g.id) || !text(g.name) || !id(g.result_id) || !sha(g.revision_hash) || !id(g.source_id) ||
        !sha(g.source_sha256) || !sha(g.record_sha256) || !count(g.included_count) || typeof g.source_available !== "boolean")) fail();
  return response.groups;
}
