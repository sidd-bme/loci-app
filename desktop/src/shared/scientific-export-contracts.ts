/** Exact identities and compact previews; canonical plan text stays opaque. */
export interface ScientificExportBinding {
  source_id: string;
  source_sha256: string;
  result_id: string;
  revision_hash: string;
  subset: "all" | "groups";
  group_ids: string[];
}
export interface ScientificExportRequest {
  purpose: "reviewed" | "provisional";
  bindings: ScientificExportBinding[];
}
export interface ScientificExportPlan {
  schema: string;
  purpose: "reviewed" | "provisional";
  plan_sha256: string;
  request: ScientificExportRequest;
  source_count: number;
  result_count: number;
  total_count: number;
  selected_count: number;
  measurement_count: number;
  group_count: number;
  membership_count: number;
  declared_replicate_count: number;
  unassigned_source_count: number;
  mixed_units: boolean;
  units: unknown[];
  results: Array<{
    result_id: string;
    revision_hash: string;
    source_id: string;
    name: string;
    review_status: string;
    total_count: number;
    selected_count: number;
    measurement_count: number;
    group_count: number;
    preview: Array<Record<string, string>>;
  }>;
}
export interface ScientificExportPreview {
  plan: ScientificExportPlan;
  plan_json: string;
}
export interface ScientificExportReceipt {
  schema: string;
  basename: string;
  purpose: "reviewed" | "provisional";
  manifest_sha256: string;
  result_count: number;
  source_count: number;
  selected_count: number;
}
