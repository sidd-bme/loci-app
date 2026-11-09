import type { ResearchAgentControlRequest, ResearchAgentTargetReference } from "../shared/research-contracts";
import type { AgentWorkspaceBinding, AgentWorkspaceNavigationRequest, AgentWorkspacePresentation, AgentWorkspacePublishedState } from "../shared/agent-workspace-api";

const ID = /^[a-f0-9]{32}$/u, SHA = /^[a-f0-9]{64}$/u, TOKEN = /^[A-Za-z0-9_-]{1,64}$/u;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid agent workspace object.");
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) throw new Error("Unexpected or missing agent workspace fields.");
}
export function integer(value: unknown, low = 0, high = Number.MAX_SAFE_INTEGER): value is number { return Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high; }
function text(value: unknown, max: number, empty = false): value is string { return typeof value === "string" && value.length <= max && (empty || Boolean(value.trim())) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value); }
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function sha(value: unknown): value is string { return typeof value === "string" && SHA.test(value); }
export function boundedClone<T>(value: T, max: number): T {
  const encoded = JSON.stringify(value, (_key, item) => { if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite workspace state."); return item; });
  if (!encoded || Buffer.byteLength(encoded) > max) throw new Error("The agent workspace state exceeds its byte bound.");
  return JSON.parse(encoded) as T;
}
export function validateBinding(value: unknown): AgentWorkspaceBinding {
  const v = object(value); exact(v, ["projectId", "studyEpoch", "generation"]);
  if (!id(v.projectId) || !integer(v.studyEpoch) || !integer(v.generation)) throw new Error("Invalid native agent workspace binding.");
  return { projectId: v.projectId, studyEpoch: v.studyEpoch, generation: v.generation };
}
export function emptyPresentation(): AgentWorkspacePresentation { return { selectedTaskId: null, section: "overview", draft: null }; }
export function validatePresentation(value: unknown): AgentWorkspacePresentation {
  const v = object(boundedClone(value, 32 * 1024)); exact(v, ["selectedTaskId", "section", "draft"]);
  if ((v.selectedTaskId !== null && !id(v.selectedTaskId)) || !["overview", "plan", "activity", "approvals"].includes(v.section as string)) throw new Error("Invalid agent workspace presentation.");
  if (v.draft !== null) {
    const d = object(v.draft); exact(d, ["taskId", "baseRevision", "goal", "steps"]);
    if (!id(d.taskId) || !integer(d.baseRevision) || !text(d.goal, 2000, true) || !Array.isArray(d.steps) || d.steps.length > 20 || d.steps.length < 1) throw new Error("Invalid bounded agent plan draft.");
    const seen = new Set();
    for (const item of d.steps) { const step = object(item); exact(step, ["id", "title"]); if (typeof step.id !== "string" || !TOKEN.test(step.id) || seen.has(step.id) || !text(step.title, 240, true)) throw new Error("Invalid draft step."); seen.add(step.id); }
    if (v.selectedTaskId !== d.taskId) throw new Error("The draft must remain pinned to its selected task.");
  }
  return v as unknown as AgentWorkspacePresentation;
}
export function validateTarget(value: unknown): ResearchAgentTargetReference {
  const v = object(value); exact(v, ["kind", "id"], ["sha256", "revision_hash", "revision", "source_id", "source_sha256", "selection"]);
  if (!["source", "result", "job", "workflow", "population_group", "intensity_report", "exploration"].includes(v.kind as string) || !id(v.id)) throw new Error("Invalid recorded agent target.");
  for (const k of ["sha256", "revision_hash", "source_sha256"]) if (v[k] !== undefined && !sha(v[k])) throw new Error("Invalid recorded target fingerprint.");
  if ((v.source_id !== undefined && !id(v.source_id)) || (v.revision !== undefined && !integer(v.revision))) throw new Error("Invalid recorded target binding.");
  if (v.selection !== undefined) { const s = object(v.selection); exact(s, ["x", "y", "width", "height", "t", "c", "z", "level"], ["z_stop"]); if (Object.values(s).some(n => !integer(n)) || Number(s.width) < 1 || Number(s.height) < 1 || (s.z_stop !== undefined && Number(s.z_stop) <= Number(s.z))) throw new Error("Invalid target selection."); }
  return boundedClone(v, 8 * 1024) as unknown as ResearchAgentTargetReference;
}
export function validatePublished(value: unknown): AgentWorkspacePublishedState {
  const v = object(boundedClone(value, 8 * 1024 * 1024)); exact(v, ["snapshot", "follow", "refreshError", "currentTargets", "inspectablePreviewJobIds"], ["presentation"]);
  const snapshot = object(v.snapshot), project = object(snapshot.project);
  if (!id(project.project_id) || typeof v.follow !== "boolean" || (v.refreshError !== null && !text(v.refreshError, 1000)) || !Array.isArray(v.currentTargets) || v.currentTargets.length > 4096 || !Array.isArray(v.inspectablePreviewJobIds) || v.inspectablePreviewJobIds.length > 4096 || v.inspectablePreviewJobIds.some(n => !id(n))) throw new Error("Invalid published agent workspace state.");
  for (const name of ["sources", "results", "jobs"]) if (!Array.isArray(snapshot[name])) throw new Error("Incomplete workspace snapshot.");
  v.currentTargets = v.currentTargets.map(validateTarget);
  if (v.presentation !== undefined) v.presentation = validatePresentation(v.presentation);
  return v as unknown as AgentWorkspacePublishedState;
}
export function validateControl(value: unknown): ResearchAgentControlRequest {
  const v = object(boundedClone(value, 32 * 1024));
  const fields: Record<string, string[]> = { edit_task: ["task_id", "expected_revision", "goal", "steps"], cancel_task: ["task_id", "expected_revision"], approve_request: ["approval_id"], deny_request: ["approval_id"], set_permission_mode: ["policy_sha256", "permission_mode"], pause_session: ["policy_sha256"], resume_session: ["policy_sha256"], disconnect_session: ["session_id"], stop_job: ["job_id", "session_id"], revoke_policy: ["policy_sha256"] };
  if (typeof v.action !== "string" || !fields[v.action]) throw new Error("Unsupported agent workspace control.");
  exact(v, ["action", ...fields[v.action]], ["approve_request", "deny_request"].includes(v.action) ? ["reason"] : []);
  for (const k of ["task_id", "approval_id", "session_id", "job_id"]) if (v[k] !== undefined && !id(v[k])) throw new Error("Invalid agent control identity.");
  if ((v.policy_sha256 !== undefined && !sha(v.policy_sha256)) || (v.expected_revision !== undefined && !integer(v.expected_revision)) || (v.reason !== undefined && !text(v.reason, 512, true))) throw new Error("Invalid control binding.");
  if (v.action === "set_permission_mode" && !["inspect_only", "ask_approval", "full_access"].includes(v.permission_mode as string)) throw new Error("Invalid permission mode.");
  if (v.action === "edit_task") { const p = validatePresentation({ selectedTaskId: v.task_id, section: "plan", draft: { taskId: v.task_id, baseRevision: v.expected_revision, goal: v.goal, steps: v.steps } }); if (!p.draft!.goal.trim() || p.draft!.steps.some(s => !s.title.trim())) throw new Error("Finish the plan draft before saving."); }
  return v as unknown as ResearchAgentControlRequest;
}
export function validateNavigation(value: unknown): AgentWorkspaceNavigationRequest {
  const v = object(value); exact(v, ["requestId", "intent"], ["target"]);
  if (typeof v.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(v.requestId) || !["open-source", "open-result", "review-result", "open-job", "open-workflow", "inspect-preview", "configure-access"].includes(v.intent as string)) throw new Error("Invalid workspace navigation.");
  if (v.intent === "configure-access") { if (v.target !== undefined) throw new Error("Access configuration must use the main window's captured context."); }
  else {
    v.target = validateTarget(v.target); const t = v.target as ResearchAgentTargetReference;
    const kind = ["open-result", "review-result"].includes(v.intent as string) ? "result" : v.intent === "open-source" ? "source" : v.intent === "open-workflow" ? "workflow" : "job";
    if (t.kind !== kind || (kind === "source" && !t.sha256) || (kind === "result" && (!t.revision_hash || !t.source_id || !t.source_sha256)) || (kind === "job" && !t.sha256) || (kind === "workflow" && t.revision === undefined && !t.sha256)) throw new Error("Navigation requires its exact recorded target.");
  }
  return boundedClone(v, 16 * 1024) as unknown as AgentWorkspaceNavigationRequest;
}

/** Repeat in main immediately before navigation; this is the native preflight. */
export function assertNavigationCurrent(packet: AgentWorkspacePublishedState, request: AgentWorkspaceNavigationRequest): void {
  const target = request.target;
  if (!target) return;
  let current: ResearchAgentTargetReference | undefined;
  const snapshot = packet.snapshot;
  if (target.kind === 'source') {
    const source = snapshot.sources.find(s => s.id === target.id && s.locator_state !== 'relink-required');
    if (source) current = { kind: 'source', id: source.id, sha256: source.sha256 };
  } else if (target.kind === 'result') {
    const result = snapshot.results.find(r => r.id === target.id);
    if (result) current = { kind: 'result', id: result.id, revision_hash: result.revision_hash, source_id: result.source_id, source_sha256: result.source_sha256 };
  } else if (target.kind === 'job') {
    const job = snapshot.jobs.find(j => j.id === target.id);
    const sourceId = typeof job?.request.source_id === 'string' ? job.request.source_id : undefined;
    const source = snapshot.sources.find(s => s.id === sourceId);
    if (job) current = { kind: 'job', id: job.id, sha256: job.request_hash, source_id: sourceId, source_sha256: source?.sha256 };
    if (request.intent === 'inspect-preview' && (!job || job.state !== 'succeeded' || !packet.inspectablePreviewJobIds.includes(job.id))) throw new Error('The exact preview is no longer inspectable.');
  } else current = packet.currentTargets.find(t => t.kind === target.kind && t.id === target.id);
  if (!current || ['sha256', 'revision_hash', 'revision', 'source_id', 'source_sha256'].some(key => target[key as keyof ResearchAgentTargetReference] !== undefined && target[key as keyof ResearchAgentTargetReference] !== current![key as keyof ResearchAgentTargetReference])) throw new Error('The recorded agent target is unavailable or stale.');
  if (target.source_id && !snapshot.sources.some(s => s.id === target.source_id && s.sha256 === target.source_sha256 && s.locator_state !== 'relink-required')) throw new Error('The recorded source is unavailable or stale.');
}
