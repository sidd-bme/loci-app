/** Renderer-safe native picker contracts; private export grants and paths stay in main. */
export interface WoundClosureStatus {
  current: boolean;
  changes: Array<{ source_id: string; reason: string }>;
}
export interface WoundClosureExportPlan {
  schema: "loci.wound-closure-export-plan/v1";
  report_id: string;
  report_hash: string;
  plan_hash: string;
  status: WoundClosureStatus;
}
export interface WoundClosureExportReceipt {
  schema: "loci.wound-closure-export-receipt/v1";
  basename: string;
  report_hash: string;
  manifest_sha256: string;
}
