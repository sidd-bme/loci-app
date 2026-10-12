import type { ResearchResult, ResearchSampleData, ResearchSnapshot } from "./research-contracts";

export interface CorrectionEffectRequest {
  before_result_ids: string[];
  after_result_ids: string[];
  value: "measure";
}
export interface CorrectionEffectBinding {
  result_id: string;
  revision_hash: string;
  source_id: string;
  source_sha256: string;
  arrays: Record<string, { sha256: string; bytes: number; shape: number[]; dtype: string }>;
  review: ({ disposition: string } & Record<string, unknown>) | null;
  sample_document: { revision: number; data: ResearchSampleData };
  scope: { selection: unknown; geometry: unknown; measurement_basis: unknown; method: string };
}
export interface CorrectionEffectAudit {
  operations: Record<string, unknown>[];
  changed_voxel_count: number;
  added_label_ids: number[];
  removed_label_ids: number[];
  changed_retained_label_ids: number[];
  label_identity_interpretation: string;
}
export interface CorrectionEffectMeans {
  before_mean: number | null;
  after_mean: number | null;
  mean_difference: number | null;
}
export interface CorrectionEffectImage extends CorrectionEffectMeans {
  source_id: string;
  before_result_id: string;
  after_result_id: string;
  metadata: ResearchSampleData;
  before_count: number;
  after_count: number;
  count_difference: number;
  eligible: boolean;
  omission_reasons: string[];
  needs_review: boolean;
  correction: CorrectionEffectAudit | null;
}
export interface CorrectionEffectReplicate extends CorrectionEffectMeans {
  study: string;
  condition: string;
  biological_replicate: string;
  image_pair_count: number;
  omitted_image_pair_count: number;
}
export interface CorrectionEffectCondition extends CorrectionEffectMeans {
  study: string;
  condition: string;
  biological_n: number;
  image_pair_count: number;
  omitted_image_pair_count: number;
}
export interface CorrectionEffectReceipt {
  schema: "loci.study-correction-effect/v1";
  value: "measure";
  unit: string;
  study: string;
  independent_n_basis: "declared biological replicate";
  weighting: "equal images within biological replicate; equal biological replicates within condition";
  before_bindings: CorrectionEffectBinding[];
  after_bindings: CorrectionEffectBinding[];
  images: CorrectionEffectImage[];
  replicates: CorrectionEffectReplicate[];
  conditions: CorrectionEffectCondition[];
  p_values: null;
  interpretation: string;
  runtime: Record<string, unknown>;
  receipt_sha256: string;
  comparison_document?: { id: string; revision: number };
}
export interface CorrectionEffectExport {
  receipt_sha256: string;
  files: string[];
  manifest_sha256: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const finite = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));
const list = (value: unknown): value is unknown[] => Array.isArray(value) && value.length <= 10_000;
const metadata = (value: unknown) => object(value) && ["study", "sample", "condition"].every(key => text(value[key])) &&
  ["biological_replicate", "plate", "well"].every(key => value[key] == null || text(value[key]));
const means = (value: Record<string, unknown>) =>
  ["before_mean", "after_mean", "mean_difference"].every(key => finite(value[key]));

/** Renderer structural checks; the engine independently verifies arithmetic and canonical hashes on import/export. */
export function checkedCorrectionEffect(value: unknown): CorrectionEffectReceipt {
  const invalid = () => { throw new Error("Invalid correction-effect receipt. Recalculate the exact revisions."); };
  if (!object(value) || value.schema !== "loci.study-correction-effect/v1" || value.value !== "measure" ||
      !hash(value.receipt_sha256) || !text(value.unit) || !text(value.study) ||
      value.independent_n_basis !== "declared biological replicate" ||
      value.weighting !== "equal images within biological replicate; equal biological replicates within condition" ||
      value.p_values !== null || !text(value.interpretation) || !object(value.runtime)) return invalid();
  for (const side of ["before_bindings", "after_bindings"]) {
    const bindings = value[side];
    if (!list(bindings) || !bindings.length) return invalid();
    const results = new Set(), sources = new Set();
    for (const binding of bindings) {
      if (!object(binding) || !text(binding.result_id) || !hash(binding.revision_hash) ||
          !text(binding.source_id) || !hash(binding.source_sha256) || !object(binding.arrays) ||
          !object(binding.sample_document) || !count(binding.sample_document.revision) || binding.sample_document.revision < 1 ||
          !metadata(binding.sample_document.data) || !object(binding.scope) || !text(binding.scope.method) ||
          (binding.review !== null && (!object(binding.review) || !text(binding.review.disposition))) ||
          results.has(binding.result_id) || sources.has(binding.source_id)) return invalid();
      results.add(binding.result_id); sources.add(binding.source_id);
      if (!Object.keys(binding.arrays).length || Object.keys(binding.arrays).length > 64) return invalid();
      for (const array of Object.values(binding.arrays)) {
        if (!object(array) || !hash(array.sha256) || !count(array.bytes) || !text(array.dtype) ||
            !Array.isArray(array.shape) || !array.shape.length || array.shape.length > 8 || !array.shape.every(count)) return invalid();
      }
    }
  }
  if (!list(value.images) || !value.images.length || !list(value.replicates) || !list(value.conditions)) return invalid();
  for (const row of value.images) {
    if (!object(row) || !text(row.source_id) || !text(row.before_result_id) || !text(row.after_result_id) ||
        !metadata(row.metadata) || !means(row) || !count(row.before_count) || !count(row.after_count) ||
        !Number.isSafeInteger(row.count_difference) || typeof row.eligible !== "boolean" || typeof row.needs_review !== "boolean" ||
        !list(row.omission_reasons) || !row.omission_reasons.every(text)) return invalid();
    if (row.correction !== null) {
      const audit = row.correction;
      if (!object(audit) || !count(audit.changed_voxel_count) || !list(audit.operations) || !audit.operations.every(object) ||
          !text(audit.label_identity_interpretation) || !["added_label_ids", "removed_label_ids", "changed_retained_label_ids"].every(key =>
            Array.isArray(audit[key]) && (audit[key] as unknown[]).length <= 100_000 &&
              (audit[key] as unknown[]).every(id => count(id) && id > 0 && id <= 0xffffffff))) return invalid();
    }
  }
  for (const [key, rows] of [["replicates", value.replicates], ["conditions", value.conditions]] as const) {
    for (const row of rows) {
      if (!object(row) || !text(row.study) || !text(row.condition) || !means(row) ||
          !count(row.image_pair_count) || !count(row.omitted_image_pair_count) ||
          (key === "replicates" ? !text(row.biological_replicate) : !count(row.biological_n))) return invalid();
    }
  }
  const receipt = value as unknown as CorrectionEffectReceipt;
  if (receipt.before_bindings.length !== receipt.after_bindings.length || receipt.images.length !== receipt.before_bindings.length ||
      new Set(receipt.images.map(row => row.source_id)).size !== receipt.images.length) return invalid();
  for (const before of receipt.before_bindings) {
    const after = receipt.after_bindings.find(row => row.source_id === before.source_id);
    const image = receipt.images.find(row => row.source_id === before.source_id);
    if (!after || after.source_sha256 !== before.source_sha256 || !image ||
        image.before_result_id !== before.result_id || image.after_result_id !== after.result_id) return invalid();
  }
  return receipt;
}

function sameMetadata(left: ResearchSampleData, right: ResearchSampleData): boolean {
  return (["study", "sample", "condition", "biological_replicate", "plate", "well"] as const)
    .every(key => (left[key] ?? null) === (right[key] ?? null));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function correctionEffectBindingsCurrent(receipt: CorrectionEffectReceipt, snapshot: ResearchSnapshot): boolean {
  return [...receipt.before_bindings, ...receipt.after_bindings].every(binding => {
    const result = snapshot.results.find(row => row.id === binding.result_id);
    const source = snapshot.sources.find(row => row.id === binding.source_id);
    const sample = snapshot.samples.find(row => row.id === binding.source_id);
    return result?.revision_hash === binding.revision_hash && result.source_id === binding.source_id &&
      result.source_sha256 === binding.source_sha256 && source?.sha256 === binding.source_sha256 &&
      canonical(result.review ?? null) === canonical(binding.review) &&
      sample?.revision === binding.sample_document.revision && sameMetadata(sample.data, binding.sample_document.data) &&
      canonical(result.geometry ?? null) === canonical(binding.scope.geometry) &&
      canonical(result.selection ?? null) === canonical(binding.scope.selection) &&
      canonical(result.arrays) === canonical(binding.arrays);
  });
}
export function assertCorrectionEffectScope(receipt: CorrectionEffectReceipt, request: CorrectionEffectRequest, snapshot: ResearchSnapshot): void {
  const exactIds = (bindings: CorrectionEffectBinding[], ids: string[]) => bindings.length === ids.length &&
    bindings.every(binding => ids.includes(binding.result_id));
  if (!exactIds(receipt.before_bindings, request.before_result_ids) || !exactIds(receipt.after_bindings, request.after_result_ids) ||
      !correctionEffectBindingsCurrent(receipt, snapshot) || receipt.images.some(row => {
        const after = snapshot.results.find(result => result.id === row.after_result_id);
        return row.before_result_id !== row.after_result_id && (after?.kind !== "corrected-labels" || after.parent_id !== row.before_result_id);
      }))
    throw new Error("The correction-effect response does not match the selected revisions and metadata. Recalculate.");
}
export function correctionEffectSnapshotKey(snapshot: ResearchSnapshot): string {
  return JSON.stringify({ project: snapshot.project, sources: snapshot.sources.map(row => [row.id, row.sha256]),
    results: snapshot.results.map(row => [row.id, row.source_id, row.source_sha256, row.revision_hash, row.arrays, row.review]), samples: snapshot.samples });
}
export function ordinaryLabelResult(result: ResearchResult): boolean {
  return result.schema !== "loci.research-result/v2" && Boolean(result.arrays?.labels) && !result.kind.startsWith("large-");
}
