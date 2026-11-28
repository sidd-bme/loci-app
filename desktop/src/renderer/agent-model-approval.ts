import type { ResearchAgentApprovalRecord, ResearchAgentTargetReference, ResearchSnapshot } from "../shared/research-contracts";

export function previewForAdoption(action: unknown): string | undefined {
  if (action === "model_run") return "model_preview";
  if (action === "cellpose_adopt") return "cellpose_preview";
}

export function isModelPreview(operation: string): boolean {
  return operation === "model_preview" || operation === "cellpose_preview";
}

export function requiresModelInspection(approval: ResearchAgentApprovalRecord): boolean {
  return Boolean(previewForAdoption(approval.action_name) || previewForAdoption(approval.operation)) ||
    approval.parameters_summary.review_requirement === "visual-preview-inspection-required";
}

export function modelApprovalTarget(approval: ResearchAgentApprovalRecord, snapshot: ResearchSnapshot): ResearchAgentTargetReference | null {
  const summary = approval.parameters_summary;
  const operation = previewForAdoption(approval.action_name);
  if (!operation || approval.operation !== "submit_action" || approval.state !== "pending" ||
    summary.review_requirement !== "visual-preview-inspection-required" || typeof summary.preview_id !== "string" ||
    !summary.preview_id || typeof summary.preview_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(summary.preview_sha256) ||
    approval.project_id !== snapshot.project.project_id || !(Date.parse(approval.expires_at) > Date.now())) return null;
  const job = snapshot.jobs.find(j => j.id === summary.preview_job_id && j.operation === operation && j.state === "succeeded");
  const source = snapshot.sources.find(s => s.id === approval.source_id && s.sha256 === approval.source_sha256 && s.locator_state !== "relink-required");
  const sessions = snapshot.agent_sessions;
  if (!job || !source || job.request.source_id !== source.id ||
    !sessions?.policies.some(p => p.policy_sha256 === approval.policy_sha256 && !p.revoked && !p.paused && p.permission_mode !== "inspect_only" && p.project_id === approval.project_id) ||
    !sessions.sessions.some(s => s.session_id === approval.session_id && s.policy_sha256 === approval.policy_sha256 &&
      s.project_id === approval.project_id && ["awaiting_approval", "connected_idle", "executing"].includes(s.state))) return null;
  return { kind: "job", id: job.id, sha256: job.request_hash, source_id: source.id, source_sha256: source.sha256 };
}
