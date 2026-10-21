import type { ResearchSampleData } from "./research-contracts";

export type IntensityCompartment = "object" | "cell" | "nuclear" | "cytoplasm";
export interface IntensityEndpoint {
  schema: "loci.intensity-endpoint/v1"; kind: "raw-channel-intensity";
  statistic: "mean"; unit: "source-intensity"; compartment: IntensityCompartment;
}
export interface IntensityDeclaration { channel: string; acquisition_context: string; rationale: string }
export interface IntensityDescriptor {
  id: string; label: string; kind: "intensity"; statistic: "mean";
  unit: "source-intensity"; channel: string; compartment?: "cell" | "nuclear" | "cytoplasm";
}
export interface IntensityCatalog {
  schema: "loci.experiment-intensity-catalog/v1";
  results: Array<{ result_id: string; revision_hash: string; source_id: string; name: string;
    review_status: string; descriptors: IntensityDescriptor[]; binding: Record<string, unknown> }>;
}
export interface IntensityRequest {
  result_ids: string[]; endpoint: IntensityEndpoint; metric_ids: Record<string, string>;
  declaration: IntensityDeclaration;
}
export interface IntensityImage extends ResearchSampleData {
  result_id: string; source_id: string; revision_hash: string;
  object_count: number; valid_object_count: number; null_object_count: number;
  missing_object_count: number; mean: number | null; included: boolean; reason: string;
}
export interface IntensityReplicate {
  condition: string; biological_replicate: string; mean: number | null;
  object_count: number; valid_object_count: number; image_count: number; valid_image_count: number;
}
export interface IntensityCondition {
  condition: string; mean: number | null; sd: number | null;
  object_count: number; valid_object_count: number; image_count: number; valid_image_count: number;
  declared_replicate_count: number; valid_replicate_count: number; unassigned_image_count: number;
}
export interface IntensityReport extends Omit<IntensityRequest, "metric_ids"> {
  schema: "loci.experiment-intensity-report/v1"; created_at: string;
  software: { engine: string; implementation: { kind: string; sha256: string } };
  bindings: Array<Record<string, unknown> & { result_id: string; source_id: string; revision_hash: string; source_sha256: string }>;
  observations: Array<{ result_id: string; label: number; value: number | null; status: "value" | "null" | "missing" }>;
  images: IntensityImage[]; replicates: IntensityReplicate[]; conditions: IntensityCondition[];
  audit: Array<Record<string, unknown>>; aggregation: Record<string, unknown>; report_hash: string;
}
export interface IntensityStatus { current: boolean; changes: Array<{ result_id: string; reason: string }> }
export interface IntensitySaved { report_id: string; report: IntensityReport; status: IntensityStatus }
export interface IntensityExportPlan {
  schema: "loci.intensity-export-plan/v1"; report_id: string; report_hash: string;
  plan_hash: string; status: IntensityStatus;
}
export interface IntensityExportReceipt {
  schema: "loci.intensity-export-receipt/v1"; basename: string; report_hash: string; manifest_sha256: string;
}
export interface SampleSheetPreview {
  schema: "loci.sample-sheet-preview/v1"; study_id: string; csv_text: string;
  rows: Array<{ row_number: number; source_id: string; before: ResearchSampleData | null;
    after: ResearchSampleData | null; match: string; issues: string[] }>;
  errors: string[]; bindings: Record<string, unknown>; can_apply: boolean; preview_sha256: string;
}

/** Renderer boundary check; engine verifies exact fields, arithmetic, retained rows and hashes. */
export function checkedIntensityReport(value: unknown): IntensityReport {
  if (!value || typeof value !== "object") throw new Error("Invalid intensity comparison");
  const row = value as Partial<IntensityReport>;
  if (row.schema !== "loci.experiment-intensity-report/v1" ||
      typeof row.report_hash !== "string" || !/^[a-f0-9]{64}$/u.test(row.report_hash) ||
      row.endpoint?.kind !== "raw-channel-intensity" || row.endpoint.statistic !== "mean" ||
      row.endpoint.unit !== "source-intensity" ||
      !["object", "cell", "nuclear", "cytoplasm"].includes(row.endpoint.compartment) ||
      !row.declaration || !Array.isArray(row.bindings) || row.bindings.length > 100 ||
      !Array.isArray(row.images) || !Array.isArray(row.replicates) || !Array.isArray(row.conditions) ||
      !Array.isArray(row.observations) || row.observations.length > 50_000)
    throw new Error("Invalid intensity comparison; reopen its saved report");
  for (const record of [...row.images, ...row.replicates, ...row.conditions]) {
    if (record.mean !== null && (typeof record.mean !== "number" || !Number.isFinite(record.mean)))
      throw new Error("Invalid intensity mean");
  }
  return row as IntensityReport;
}
