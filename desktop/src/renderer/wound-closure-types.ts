/** Native wound report callback contracts. No filesystem authority crosses this boundary. */
export type WoundBinding = { result_id: string; revision_hash: string; source_id: string; source_sha256: string };
export type WoundMaskChoice = WoundBinding & {
  name: string; label_ids: number[];
  mask_semantics?: "filled-wound-area" | "boundary-only" | "skeleton";
};
export type WoundObserved = { frame_id: string; result_id: string; revision_hash: string;
  selected_labels: number[]; mask_semantics: "filled-wound-area" };
export type WoundMissing = { frame_id: string; missing_reason: string };
export type WoundRequest = {
  frames: Array<WoundObserved | WoundMissing>; time_s: number[]; time_unit: "s";
  time_declaration: string; specimen_id: string; sequence_id: string;
  area_declaration: string; grid_declaration: string; working_bytes: number;
};
export type WoundToken = { preview_id: string; preview_hash: string };
export type WoundTarget = WoundToken | { report_id: string };
export type WoundFrame = { frame_id: string; time_s: number; status: "observed" | "missing";
  missing_reason?: string; area: number | null; area_fraction: number | null;
  closure_fraction: number | null; selected_pixel_count: number | null;
  excluded_positive_pixel_count: number | null };
export type WoundInterval = { from_frame_id: string; to_frame_id: string; delta_time_s: number;
  status: "defined" | "missing_endpoint"; area_change_rate: number | null; closure_change_rate: number | null };
export type WoundInput = { frame_id: string; time_s: number; specimen_id: string; sequence_id: string;
  missing_reason?: string; result_id?: string; revision_hash?: string; source_id?: string;
  source_sha256?: string; result_record_sha256?: string; selected_label_count?: number;
  selected_labels_sha256?: string; mask_semantics?: "filled-wound-area";
  selection?: Record<string, number>; geometry?: { axes: string; affine: number[][]; unit: string; frame: string };
  labels?: { sha256: string; bytes: number; shape: number[]; dtype: string }; sample?: unknown };
export type WoundStatus = import("../shared/wound-closure-contracts").WoundClosureStatus;
export type WoundTable = "frames" | "intervals" | "inputs";
export type WoundRows = { frames: WoundFrame[]; intervals: WoundInterval[]; inputs: WoundInput[] };
export type WoundSummary = {
  schema: "loci.wound-closure-summary/v1"; report_schema: "loci.wound-closure-report/v1";
  report_hash: string; request_sha256: string; created_at: string; software: { engine: string };
  measurement: { specimen_id: string; sequence_id: string; time_unit: "s"; area_unit: string;
    baseline_frame_id: string; baseline_area: number; calibration_status: string;
    area_declaration: string; grid_declaration: string; rules: Record<string, string> };
  sample_identity: { study: string | null; biological_replicate: string | null;
    missing_sample_frames: number; unassigned_biological_replicate_frames: number; basis: string };
  totals: { scheduled_frames: number; observed_frames: number; missing_frames: number };
  tables: Record<WoundTable, { total: number; returned: number; has_more: boolean; next_offset: number | null }>;
  frames: WoundFrame[]; intervals: WoundInterval[]; inputs: WoundInput[];
};
export type WoundSaved = { report_id: string; summary: WoundSummary; status: WoundStatus; time_declaration: string };
export type WoundReportIndex = { id: string; created_at: string; specimen_id: string; sequence_id: string; status: WoundStatus };
export type WoundQuery = WoundTarget & { table: WoundTable; offset: number; limit: number };
export type WoundCallbacks = {
  onPreview: (request: WoundRequest) => Promise<unknown>;
  onSave: (token: WoundToken) => Promise<unknown>;
  onGet: (request: { report_id: string }) => Promise<unknown>;
  onQuery: (request: WoundQuery) => Promise<unknown>;
  onInspect: (binding: WoundBinding) => void;
  onInspectReviews: (identity: { report_id: string; report_hash: string }) => Promise<void>;
  onExport: (identity: { report_id: string; report_hash: string }) => Promise<void>;
  onSaved?: (saved: WoundSaved) => void;
};

export class WoundContractError extends Error {}
const fail = (): never => { throw new WoundContractError("The wound report response has an inconsistent identity or table. Reload the report."); };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const text = (v: unknown): string => typeof v === "string" && v.length > 0 ? v : fail();
const finite = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : fail();
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max ? Number(v) : fail();
const hash = (v: unknown, length = 64): string => typeof v === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(v) ? v : fail();
const bounded = (v: unknown, bytes = 64 * 1024) => { if (new TextEncoder().encode(JSON.stringify(v)).length > bytes) fail(); };
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : fail();
export function checkedWoundFrame(value: unknown): WoundFrame {
  const r = object(value); text(r.frame_id); finite(r.time_s);
  if (r.status !== "observed" && r.status !== "missing") fail();
  for (const key of ["area", "area_fraction", "closure_fraction", "selected_pixel_count", "excluded_positive_pixel_count"]) {
    if (r.status === "missing") { if (r[key] !== null) fail(); }
    else { finite(r[key]); if (key !== "closure_fraction" && Number(r[key]) < 0) fail(); }
  }
  if (r.status === "missing") text(r.missing_reason);
  else { integer(r.selected_pixel_count); integer(r.excluded_positive_pixel_count); }
  return r as WoundFrame;
}
export function checkedWoundInterval(value: unknown): WoundInterval {
  const r = object(value); text(r.from_frame_id); text(r.to_frame_id);
  if (finite(r.delta_time_s) <= 0 || !["defined", "missing_endpoint"].includes(String(r.status))) fail();
  for (const key of ["area_change_rate", "closure_change_rate"]) {
    if (r.status === "missing_endpoint") { if (r[key] !== null) fail(); } else finite(r[key]);
  }
  return r as WoundInterval;
}
export function checkedWoundInput(value: unknown): WoundInput {
  const r = object(value); text(r.frame_id); finite(r.time_s); text(r.specimen_id); text(r.sequence_id);
  if (r.result_id === undefined) { text(r.missing_reason); return r as WoundInput; }
  hash(r.result_id, 32); hash(r.revision_hash); hash(r.source_id, 32); hash(r.source_sha256);
  hash(r.result_record_sha256); hash(r.selected_labels_sha256); integer(r.selected_label_count, 0, 100000);
  if (r.mask_semantics !== "filled-wound-area") fail();
  const selection = object(r.selection);
  for (const key of ["x", "y", "width", "height", "t", "z", "c", "level"]) integer(selection[key], ["width", "height"].includes(key) ? 1 : 0);
  const geometry = object(r.geometry); if (geometry.axes !== "YX") fail();
  if (!["pixel", "nm", "um", "mm", "m"].includes(text(geometry.unit))) fail();
  if (!["image", "RAS", "LPS"].includes(text(geometry.frame))) fail();
  const affine = list(geometry.affine); if (affine.length !== 4) fail();
  for (const row of affine) { const values = list(row); if (values.length !== 4) fail(); values.forEach(finite); }
  const labels = object(r.labels); hash(labels.sha256); integer(labels.bytes, 1); text(labels.dtype);
  const shape = list(labels.shape); if (shape.length !== 2) fail(); shape.forEach((v) => integer(v, 1));
  return r as WoundInput;
}
const rowChecks = { frames: checkedWoundFrame, intervals: checkedWoundInterval, inputs: checkedWoundInput };
export function checkedWoundStatus(value: unknown): WoundStatus {
  const r = object(value); if (typeof r.current !== "boolean") fail();
  for (const change of list(r.changes)) { const c = object(change); hash(c.source_id, 32); text(c.reason); }
  if (r.current !== ((r.changes as unknown[]).length === 0)) fail();
  return { current: r.current as boolean, changes: r.changes as WoundStatus["changes"] };
}
export function checkedWoundSummary(value: unknown): WoundSummary {
  bounded(value); const r = object(value);
  if (r.schema !== "loci.wound-closure-summary/v1" || r.report_schema !== "loci.wound-closure-report/v1") fail();
  hash(r.report_hash); hash(r.request_sha256); text(r.created_at); text(object(r.software).engine);
  const m = object(r.measurement); text(m.specimen_id); text(m.sequence_id); text(m.baseline_frame_id);
  if (m.time_unit !== "s" || !/^(pixel|nm|um|mm|m)\^2$/u.test(text(m.area_unit)) || finite(m.baseline_area) <= 0) fail();
  text(m.area_declaration); text(m.grid_declaration); text(m.calibration_status);
  Object.values(object(m.rules)).forEach(text);
  const sample = object(r.sample_identity);
  if (sample.study !== null) text(sample.study); if (sample.biological_replicate !== null) text(sample.biological_replicate);
  integer(sample.missing_sample_frames); integer(sample.unassigned_biological_replicate_frames); text(sample.basis);
  const totals = object(r.totals), total = integer(totals.scheduled_frames, 2, 1000);
  if (integer(totals.observed_frames, 1, total) + integer(totals.missing_frames, 0, total) !== total) fail();
  const tables = object(r.tables);
  for (const table of ["frames", "intervals", "inputs"] as const) {
    const t = object(tables[table]), rows = list(r[table]);
    if (integer(t.total) !== total - (table === "intervals" ? 1 : 0) || integer(t.returned) !== rows.length || rows.length > Number(t.total)) fail();
    if (t.has_more !== (rows.length < Number(t.total)) || t.next_offset !== (t.has_more ? rows.length : null)) fail();
    rows.forEach(rowChecks[table]);
  }
  return r as WoundSummary;
}
export function checkedWoundPreview(value: unknown): WoundToken & { summary: WoundSummary } {
  const r = object(value); hash(r.preview_id, 32); hash(r.preview_hash);
  return { preview_id: String(r.preview_id), preview_hash: String(r.preview_hash), summary: checkedWoundSummary(r.summary) };
}
export function checkedWoundSaved(value: unknown): WoundSaved {
  const r = object(value), summary = checkedWoundSummary(r.summary);
  if (hash(r.report_id, 32) !== summary.report_hash.slice(0, 32)) fail();
  const report = object(r.report);
  if (report.schema !== summary.report_schema || report.report_hash !== summary.report_hash) fail();
  return { report_id: String(r.report_id), summary, status: checkedWoundStatus(r.status),
    time_declaration: text(object(report.request).time_declaration) };
}
export async function readWoundRows(callback: WoundCallbacks["onQuery"], target: WoundTarget,
  summary: WoundSummary, current: () => boolean): Promise<WoundRows | null> {
  const result: WoundRows = { frames: [], intervals: [], inputs: [] };
  for (const table of ["frames", "intervals", "inputs"] as const) {
    const all: unknown[] = [...summary[table]], total = summary.tables[table].total;
    while (all.length < total) {
      if (!current()) return null;
      const offset = all.length, limit = 100;
      const value = await callback({ ...target, table, offset, limit });
      if (!current()) return null;
      bounded(value); const page = object(value), rows = list(page.rows);
      if (page.schema !== "loci.wound-closure-page/v1" || page.report_hash !== summary.report_hash || page.table !== table ||
          page.offset !== offset || page.limit !== limit || page.total !== total || page.returned !== rows.length ||
          !rows.length || rows.length > limit || offset + rows.length > total ||
          page.next_offset !== (offset + rows.length < total ? offset + rows.length : null)) fail();
      rows.forEach(rowChecks[table]); all.push(...rows);
    }
    (result[table] as unknown[]) = all;
  }
  const ids = new Set<string>();
  result.frames.forEach((row, i) => {
    if (result.inputs[i].specimen_id !== summary.measurement.specimen_id || result.inputs[i].sequence_id !== summary.measurement.sequence_id || ids.has(row.frame_id) || row.time_s !== result.inputs[i].time_s || row.frame_id !== result.inputs[i].frame_id ||
        (i > 0 && result.frames[i - 1].time_s >= row.time_s) ||
        (row.status === "observed") !== Boolean(result.inputs[i].result_id)) fail();
    ids.add(row.frame_id);
  });
  if (result.frames.filter((r) => r.status === "observed").length !== summary.totals.observed_frames) fail();
  if (result.frames[0].status !== "observed" || result.frames[0].area !== summary.measurement.baseline_area ||
      result.frames[0].frame_id !== summary.measurement.baseline_frame_id) fail();
  result.intervals.forEach((row, i) => {
    const left = result.frames[i], right = result.frames[i + 1];
    if (row.from_frame_id !== left.frame_id || row.to_frame_id !== right.frame_id ||
        row.delta_time_s !== right.time_s - left.time_s ||
        (row.status === "defined") !== (left.status === "observed" && right.status === "observed")) fail();
  });
  return result;
}
export async function woundLabelHash(labels: number[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(labels)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function bindWoundPreview(request: WoundRequest, summary: WoundSummary, rows: WoundRows, choices: WoundMaskChoice[]): Promise<void> {
  const m = summary.measurement;
  if (m.specimen_id !== request.specimen_id || m.sequence_id !== request.sequence_id || m.area_declaration !== request.area_declaration ||
      m.grid_declaration !== request.grid_declaration || rows.frames.length !== request.frames.length) fail();
  for (let i = 0; i < request.frames.length; i++) {
    const wanted = request.frames[i], actual = rows.inputs[i];
    if (actual.frame_id !== wanted.frame_id || actual.time_s !== request.time_s[i]) fail();
    if ("result_id" in wanted) {
      const choice = choices.find((r) => r.result_id === wanted.result_id && r.revision_hash === wanted.revision_hash);
      if (!choice || actual.result_id !== wanted.result_id || actual.revision_hash !== wanted.revision_hash ||
          actual.source_id !== choice.source_id || actual.source_sha256 !== choice.source_sha256 ||
          actual.selected_label_count !== wanted.selected_labels.length ||
          actual.selected_labels_sha256 !== await woundLabelHash(wanted.selected_labels)) fail();
    } else if (actual.missing_reason !== wanted.missing_reason || actual.result_id) fail();
  }
}
