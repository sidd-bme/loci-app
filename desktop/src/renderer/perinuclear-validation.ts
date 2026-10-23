import { PERINUCLEAR_EXCLUSIONS, PERINUCLEAR_RULES, type ResearchPerinuclearRecord, type ResearchPerinuclearRequest, type ResearchPerinuclearResponse, type ResearchPerinuclearRow } from "../shared/perinuclear-contracts";
import type { ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { checkedPerinuclearSummary } from "./PerinuclearSummary";

const hash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const id = (value: unknown) => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
const close = (left: number, right: number) => Math.abs(left - right) <= 1e-12 * Math.max(1, Math.abs(left), Math.abs(right));
const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
};
export const perinuclearRevisionKey = (result: ResearchResult) => `${result.id}:${result.revision_hash}`;

export function perinuclearNuclei(result: ResearchResult, source: ResearchSource): boolean {
  const size = source.metadata.dimensions, selection = result.selection;
  const incompatible = ["perinuclear-enrichment", "nucleus-cell-association", "tracking", "temporal-tracking", "declared-stain-analysis", "registered-derived", "resampled-derived", "colocalisation", "field-assay"];
  return Boolean(size && result.schema === "loci.research-result/v1" && result.perinuclear_nuclei_eligible === true &&
    !result.perinuclear && !incompatible.includes(result.kind) && source.source_kind === "native" && source.locator_state !== "relink-required" &&
    !["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "") &&
    result.source_id === source.id && result.source_sha256 === source.sha256 && id(result.id) && hash(result.revision_hash) &&
    Number.isSafeInteger(result.object_count) && result.object_count >= 0 &&
    result.geometry?.axes === "YX" && result.arrays?.image && hash(result.arrays?.labels?.sha256) &&
    equal(result.arrays?.labels?.shape, [size.y, size.x]) &&
    selection && selection.level === 0 && selection.z_stop === undefined && selection.x === 0 && selection.y === 0 &&
    selection.width === size.x && selection.height === size.y &&
    Number.isSafeInteger(selection.z) && selection.z >= 0 && selection.z < size.z &&
    Number.isSafeInteger(selection.t) && selection.t >= 0 && selection.t < size.t);
}

export function checkedPerinuclearRecord(value: unknown, result: ResearchResult): ResearchPerinuclearRecord {
  const record = value as ResearchPerinuclearRecord;
  if (result.kind !== "perinuclear-enrichment" || !record || record.schema !== "loci.perinuclear-enrichment/v1" ||
      Object.entries(PERINUCLEAR_RULES).some(([key, rule]) => record[key as keyof typeof PERINUCLEAR_RULES] !== rule) ||
      !Number.isFinite(record.radius_px) || record.radius_px <= 0 || record.radius_px > 128 ||
      typeof record.control !== "string" || !record.control.trim() || record.control.length > 2048 ||
      !Number.isSafeInteger(record.signal_channel) || record.signal_channel < 0 || record.signal_channel > 255 || result.selection?.c !== record.signal_channel ||
      !id(record.nucleus_result?.result_id) || !hash(record.nucleus_result?.revision_hash) ||
      result.parent_id !== record.nucleus_result.result_id || !result.arrays?.ring_labels || !result.arrays.ring_ambiguous)
    throw new Error("The perinuclear result does not match its recorded nucleus revision and signal channel.");
  checkedPerinuclearSummary(record.summary, result.object_count);
  return record;
}

export function checkedPerinuclearResponse(value: unknown, parent: ResearchResult, request: ResearchPerinuclearRequest): ResearchPerinuclearResponse {
  const output = value as ResearchPerinuclearResponse, result = output?.result;
  const record = checkedPerinuclearRecord(output?.perinuclear, result ?? {} as ResearchResult);
  const selection = { ...parent.selection, c: request.signal_channel } as ResearchSelection;
  if (output.adopted !== true || !id(result.id) || !hash(result.revision_hash) ||
      result.source_id !== parent.source_id || result.source_sha256 !== parent.source_sha256 ||
      result.object_count !== parent.object_count || !equal(result.selection, selection) || !equal(result.geometry, parent.geometry) ||
      result.arrays?.labels?.sha256 !== parent.arrays?.labels?.sha256 ||
      !equal(result.arrays?.labels?.shape, parent.arrays?.labels?.shape) ||
      [result.arrays?.ring_labels, result.arrays?.ring_ambiguous].some((array) => !hash(array?.sha256) || !equal(array?.shape, parent.arrays?.labels?.shape)) ||
      record.nucleus_result.result_id !== request.result_id || record.nucleus_result.revision_hash !== request.revision_hash ||
      record.radius_px !== request.radius_px || record.signal_channel !== request.signal_channel || record.control !== request.control ||
      !equal(result.perinuclear, record) || !equal(output.summary, record.summary) ||
      output.total_measurements !== parent.object_count || !Array.isArray(output.measurements) ||
      output.measurements.length !== Math.min(output.total_measurements, 1000))
    throw new Error("The perinuclear response does not match the selected source, nucleus revision and settings.");
  const rows = checkedPerinuclearRows(output.measurements, request.signal_channel);
  if (rows.length === result.object_count && (rows.filter((row) => row.perinuclear_ring.exclusions.length === 0).length !== output.summary.eligible_count ||
      PERINUCLEAR_EXCLUSIONS.some((reason) => rows.filter((row) => row.perinuclear_ring.exclusions.includes(reason)).length !== output.summary.excluded_by_reason[reason])))
    throw new Error("Perinuclear eligibility counts disagree with the complete measurement rows.");
  return output;
}

export function checkedPerinuclearRows(value: unknown, signalChannel: number): ResearchPerinuclearRow[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid perinuclear measurement rows.");
  const rows = value as ResearchPerinuclearRow[];
  const labels = new Set<number>();
  for (const row of rows) {
    const ring = row?.perinuclear_ring, nuclear = row?.intensity?.[`source_channel_${signalChannel}`];
    if (!row || !Number.isSafeInteger(row.label) || row.label <= 0 || row.label > 0xFFFFFFFF || labels.has(row.label) ||
        !Number.isSafeInteger(row.voxel_count) || row.voxel_count < 1 ||
        !nuclear || Object.keys(row.intensity).length !== 1 || [nuclear.mean, nuclear.sum, nuclear.min, nuclear.max, nuclear.std_population].some((number) => !Number.isFinite(number) || number < 0) ||
        nuclear.std_population < 0 || (nuclear.min > nuclear.mean && !close(nuclear.min, nuclear.mean)) || (nuclear.mean > nuclear.max && !close(nuclear.mean, nuclear.max)) || !close(nuclear.sum / row.voxel_count, nuclear.mean) ||
        !ring || !Number.isSafeInteger(ring.count) || ring.count < 0 || !Number.isFinite(ring.sum) || ring.sum < 0 ||
        (ring.count === 0 ? ring.mean !== null || ring.sum !== 0 : typeof ring.mean !== "number" || !Number.isFinite(ring.mean) || ring.mean < 0 || !close(ring.sum / ring.count, ring.mean)) ||
        typeof row.touches_crop_border !== "boolean" ||
        !Array.isArray(ring.exclusions) || !equal(ring.exclusions, [
          ...(row.touches_crop_border ? ["boundary-touching-nucleus"] : []),
          ...(ring.count === 0 ? ["empty-ring"] : ring.mean === 0 ? ["zero-mean-ring"] : []),
        ]) ||
        (ring.exclusions.length ? ring.nuclear_to_ring_mean_ratio !== null :
          typeof ring.nuclear_to_ring_mean_ratio !== "number" || !Number.isFinite(ring.nuclear_to_ring_mean_ratio) || ring.nuclear_to_ring_mean_ratio < 0 ||
          typeof ring.mean !== "number" || ring.mean === 0 || !close(nuclear.mean / ring.mean, ring.nuclear_to_ring_mean_ratio)))
      throw new Error("The perinuclear object measurements contain inconsistent counts, signals or exclusions.");
    labels.add(row.label);
  }
  return rows;
}
