import { useEffect, useRef, useState, type RefObject } from "react";
import { ExternalLink, Eye, PanelsTopLeft, Pause, Play, X } from "lucide-react";
import type {
  ResearchAgentApprovalRecord, ResearchAgentControlRequest, ResearchAgentPermissionMode,
  ResearchAgentPolicyRecord, ResearchAgentSessionRecord, ResearchAgentSessionState,
  ResearchAgentSessionsSnapshot, ResearchSnapshot,
} from "../shared/research-contracts";
import { sourceLabelForId } from "./source-browser";
import { AgentActivityTimeline, AgentApprovalDetails, RecordedTime, type AgentActivityNavigation } from "./AgentActivityTimeline";
import { AgentTaskPanel } from "./AgentTaskPanel";
import type { AgentWorkspacePresentation } from "../shared/agent-workspace-api";
export type { AgentWorkspacePresentation } from "../shared/agent-workspace-api";
import "./AgentSessionIndicator.css";
import "./AgentWorkspaceSurface.css";

export const EMPTY_AGENT_PRESENTATION: AgentWorkspacePresentation = { selectedTaskId: null, section: "overview", draft: null };
const EMPTY_SESSIONS: ResearchAgentSessionsSnapshot = {
  schema: "loci.agent-sessions/v1", status: "none", connected_count: 0, pending_approval_count: 0,
  policies: [], sessions: [], approvals: [], events: [], tasks: [],
  capability_map: { schema: "loci.agent-capability-map/v1", entries: [], counts: { supported_via_mcp: 0, supported_with_grant: 0, gui_only_gap: 0, total: 0 } },
};
export type AgentWorkspaceSurfaceProps = AgentActivityNavigation & {
  snapshot: ResearchSnapshot;
  followAgent: boolean;
  onFollowAgentChange: (follow: boolean) => void;
  onControl?: (request: ResearchAgentControlRequest) => Promise<boolean>;
  onError: (message: string) => void;
  refreshError?: string | null;
  expandActivityDetails?: boolean;
  commandBusy?: boolean;
  host?: "docked" | "detached";
  presentation?: AgentWorkspacePresentation;
  onPresentationChange?: (next: AgentWorkspacePresentation) => void;
  feedback?: { kind: "status" | "error"; message: string } | null;
  onDetach?: () => void;
  onDock?: () => void;
  onClose?: () => void;
  onConfigureAccess?: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
};
const LIVE_SESSION_STATES = new Set<ResearchAgentSessionState>([
  "connected_idle",
  "executing",
  "awaiting_approval",
  "paused",
]);

export function stateTone(
  state: ResearchAgentSessionState | "none" | "revoked",
): "neutral" | "connected" | "processing" | "warning" | "danger" {
  switch (state) {
    case "connected_idle":
      return "connected";
    case "executing":
      return "processing";
    case "awaiting_approval":
    case "paused":
      return "warning";
    case "interrupted":
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function pillSummary(
  overallState: ResearchAgentSessionState | "none",
  pendingCount: number,
  activeOperation: string | null,
): string {
  switch (overallState) {
    case "configuration_ready":
      return "Agent bundle ready · Not connected";
    case "connected_idle":
      return "MCP connected · Idle";
    case "executing":
      return activeOperation
        ? `Agent executing · ${activeOperation}`
        : "Agent executing";
    case "awaiting_approval":
      return `Approval needed (${pendingCount})`;
    case "paused":
      return "Agent session paused";
    case "interrupted":
      return "Agent session interrupted";
    case "disconnected":
      return "MCP client disconnected";
    case "failed":
      return "Agent session failed";
    default:
      return "No active agent";
  }
}

function policyStateLabel(
  policy: ResearchAgentPolicyRecord,
  liveSessions: ResearchAgentSessionRecord[],
): string {
  if (policy.revoked) return "Revoked";
  if (liveSessions.length > 0) {
    const primary = liveSessions[0];
    if (primary.state === "executing") {
      return primary.current_operation
        ? `Executing ${primary.current_operation}`
        : "Executing";
    }
    if (primary.state === "awaiting_approval") return "Awaiting your approval";
    if (primary.state === "paused") return "Paused";
    return "Connected · Idle";
  }
  if (policy.state === "configuration_ready") {
    return "Bundle ready · Not connected";
  }
  if (policy.state === "interrupted") return "Session interrupted";
  if (policy.state === "failed") return "Session failed";
  if (policy.state === "disconnected") return "Disconnected";
  return policy.state;
}

export function AgentWorkspaceSurface({ snapshot, followAgent, onFollowAgentChange, onControl, onError,
  refreshError = null, expandActivityDetails = false, commandBusy = false, host = "docked",
  presentation, onPresentationChange, feedback, onDetach, onDock, onClose, onConfigureAccess, closeButtonRef,
  currentTargets, onOpenSource, onOpenResult, onReviewResult, onOpenJob, onOpenWorkflow, onInspectPreview, inspectablePreviewJobIds,
}: AgentWorkspaceSurfaceProps): React.JSX.Element {
  const [localPresentation, setLocalPresentation] = useState(EMPTY_AGENT_PRESENTATION);
  const currentPresentation = presentation ?? localPresentation;
  const changePresentation = (next: AgentWorkspacePresentation) => {
    if (!presentation) setLocalPresentation(next);
    onPresentationChange?.(next);
  };
  const [controlBusy, setControlBusy] = useState(false);
  const controlPending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const agentSessions = snapshot.agent_sessions ?? EMPTY_SESSIONS;

  const activePolicies = agentSessions.policies.filter(
    (policy) => !policy.revoked,
  );
  const overallState = agentSessions.status;
  const pendingApprovals = agentSessions.approvals.filter(
    (item) => item.state === "pending",
  );
  const liveSessions = agentSessions.sessions.filter((session) =>
    LIVE_SESSION_STATES.has(session.state),
  );
  const primarySession = liveSessions.length === 1 ? liveSessions[0] : null;
  const primaryPolicy = activePolicies.length === 1 ? activePolicies[0] : null;
  const activeOperation =
    liveSessions.find((session) => session.current_operation)?.current_operation ??
    null;
  const runningJobs = snapshot.jobs.filter(
    (job) => job.state === "running" || job.state === "queued",
  );
  const tone = refreshError ? "warning" : stateTone(overallState);
  const label = refreshError ? "Agent status unavailable" : pillSummary(
    overallState,
    pendingApprovals.length,
    activeOperation,
  );

  const dispatchControl = async (request: ResearchAgentControlRequest): Promise<boolean> => {
    if (!onControl || controlPending.current || refreshError || commandBusy) return false;
    controlPending.current = true;
    setControlBusy(true);
    try {
      return await onControl(request);
    } catch (caught) {
      if (mounted.current) onError(
        caught instanceof Error
          ? caught.message
          : "Could not update the agent session.",
      );
      return false;
    } finally {
      controlPending.current = false;
      if (mounted.current) setControlBusy(false);
    }
  };

  const locked = controlBusy || commandBusy || Boolean(refreshError);
  const navigation: AgentActivityNavigation = { currentTargets, onOpenSource, onOpenResult, onReviewResult, onOpenJob, onOpenWorkflow, onInspectPreview, inspectablePreviewJobIds };

  const renderApproval = (approval: ResearchAgentApprovalRecord) => {
    const sourceLabel = approval.source_id
      ? sourceLabelForId(snapshot.sources, approval.source_id)
      : null;
    return (
      <div
        key={approval.id}
        className={`agent-approval-card${approval.state === "pending" ? "" : " agent-approval-card--history"}`}
        aria-label={`${approval.state === "pending" ? "Pending approval" : "Approval record"} for ${approval.operation}`}
      >
        <div className="agent-approval-card__header">
          <strong>{approval.summary}</strong>
          <span className={`agent-session-badge${approval.state === "pending" ? " tone-warning" : ""}`}>
            {approval.state === "pending" ? "Single-use approval" : approval.state === "approved" ? "Awaiting execution" : approval.state}
          </span>
        </div>
        <dl className="agent-approval-meta">
          <dt>Operation</dt>
          <dd>
            {approval.action_name
              ? `${approval.operation} (${approval.action_name})`
              : approval.operation}
          </dd>
          {sourceLabel && (
            <>
              <dt>Source</dt>
              <dd>{sourceLabel}</dd>
            </>
          )}
          {approval.result_id && (
            <>
              <dt>Result revision</dt>
              <dd>
                {approval.result_id.slice(0, 8)} · rev{" "}
                {approval.revision_hash?.slice(0, 8) ?? "none"}
              </dd>
            </>
          )}
          {approval.source_id && <><dt>Source identity</dt><dd title={approval.source_sha256 ?? undefined}>
            {approval.source_id.slice(0, 8)}{approval.source_sha256 ? ` · SHA-256 ${approval.source_sha256.slice(0, 8)}` : " · fingerprint not recorded"}
          </dd></>}
          {approval.display_revision !== null && <><dt>Display revision</dt><dd>{approval.display_revision}</dd></>}
          {approval.destination_name && (
            <>
              <dt>Export target</dt>
              <dd>{approval.destination_name}</dd>
            </>
          )}
        </dl>
        <AgentApprovalDetails approval={approval} snapshot={snapshot} navigation={navigation} unavailable={Boolean(refreshError)}
          decisionControls={approval.state === "pending" && <div className="agent-session-actions">
          <button
            type="button"
            className="research-primary"
            disabled={locked || !onControl}
            aria-label={`Approve ${approval.operation}`}
            onClick={() =>
              void dispatchControl({
                action: "approve_request",
                approval_id: approval.id,
              })
            }
          >
            Approve once
          </button>
          <button
            type="button"
            disabled={locked || !onControl}
            aria-label={`Deny ${approval.operation}`}
            onClick={() =>
              void dispatchControl({
                action: "deny_request",
                approval_id: approval.id,
              })
            }
          >
            Deny
          </button>
        </div>} />
      </div>
    );
  };

  return <section className={`agent-workspace-surface agent-workspace-surface--${host}`} aria-label="Agent workspace">
          <header className="agent-session-drawer__header">
            <div>
              <h2>Agent workspace</h2>
              <p className="agent-workspace-study">{snapshot.project.title}</p>
              <p className={`agent-session-drawer__status tone-${tone}`}><span className="agent-session-pill__dot" aria-hidden="true" />{label}</p>
              <p className="agent-session-drawer__subtitle">
                {agentSessions.connected_count > 0
                  ? `${liveSessions.length} connected ${liveSessions.length === 1 ? "session" : "sessions"}`
                  : "No MCP client is currently connected."}
              </p>
            </div>
            <div className="agent-workspace-window-actions">
              {onDetach && <button type="button" disabled={controlBusy || commandBusy} onClick={onDetach} title="Open agent workspace in a separate window"><ExternalLink size={16} aria-hidden="true" />Pop out</button>}
              {onDock && <button type="button" disabled={controlBusy || commandBusy} onClick={onDock}><PanelsTopLeft size={16} aria-hidden="true" />Return to workspace</button>}
              {onClose && <button type="button" ref={closeButtonRef} className="workbench-jobs__close"
                aria-label="Close agent session drawer" onClick={onClose}><X size={16} aria-hidden="true" /></button>}
            </div>
          </header>
          <div className="agent-session-toolbar">
            <label className="agent-session-follow" title={followAgent
              ? "Inspected sources, planes, regions and completed results open while you are idle. Display colours stay yours; editing and drafts take priority."
              : "Your source, result, camera and drafts stay undisturbed."}>
              <Eye size={15} strokeWidth={1.5} aria-hidden="true" />
              <input type="checkbox" aria-label="Follow agent" checked={followAgent} disabled={locked}
                onChange={(event) => onFollowAgentChange(event.target.checked)} />
              Follow agent
            </label>
            {primaryPolicy && <button type="button" className="agent-session-pause"
              disabled={locked || !onControl}
              onClick={() => void dispatchControl({ action: primaryPolicy.paused ? "resume_session" : "pause_session", policy_sha256: primaryPolicy.policy_sha256 })}>
              {primaryPolicy.paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
              {primaryPolicy.paused ? "Resume access" : "Pause access"}
            </button>}
          </div>
          <p className="agent-session-follow-note">{followAgent ? "Following inspected views and completed results. Editing and drafts take priority." : "Your current view stays in place."}</p>
          <nav className="agent-workspace-sections" aria-label="Agent workspace sections">
            {(["overview", "plan", "activity", "approvals"] as const).map(section => <button key={section} type="button"
              aria-pressed={currentPresentation.section === section} onClick={() => changePresentation({ ...currentPresentation, section })}>
              {section === "overview" ? "Overview" : section === "plan" ? "Plan & evidence" : section === "activity" ? "Activity" : `Approvals${pendingApprovals.length ? ` (${pendingApprovals.length})` : ""}`}
            </button>)}
          </nav>
          <div className="agent-session-drawer__content agent-workspace-content">
            {feedback && <p className="agent-workspace-feedback" role={feedback.kind === "error" ? "alert" : "status"}>{feedback.message}</p>}
            {refreshError && <p className="agent-session-refresh-error" role="alert">
              {refreshError} The details below are the last received state.
            </p>}


            {pendingApprovals.length > 0 && (
              <section
                className="agent-session-section"
                aria-label="Pending agent approvals"
                hidden={!["overview", "approvals"].includes(currentPresentation.section)}
              >
                <h3>Pending approvals ({pendingApprovals.length})</h3>
                {pendingApprovals.map(renderApproval)}
              </section>
            )}

            {pendingApprovals.length === 0 && currentPresentation.section === "approvals" && <p className="agent-workspace-empty">No requests are awaiting approval.</p>}
            <div className="agent-workspace-columns">
              <div className="agent-workspace-plan" hidden={!["overview", "plan"].includes(currentPresentation.section)}>
                {(agentSessions.tasks?.length ?? 0) === 0 && <section className="agent-workspace-empty" aria-label="No agent plan">
                  <h3>No agent plan yet</h3><p>Plans and evidence from connected external agents will appear here.</p>
                  {onConfigureAccess && <button type="button" disabled={locked} onClick={onConfigureAccess}>Configure access in workspace</button>}
                </section>}
                <AgentTaskPanel tasks={agentSessions.tasks ?? []} sessionId={primarySession?.session_id}
                  snapshot={snapshot} navigation={navigation} unavailable={Boolean(refreshError)}
                  busy={controlBusy || commandBusy} canControl={Boolean(onControl)} onControl={dispatchControl}
                  presentation={currentPresentation} onPresentationChange={next => changePresentation({ ...currentPresentation, ...next })} />
              </div>
              <div className="agent-workspace-activity" hidden={!["overview", "activity"].includes(currentPresentation.section)}>
                <AgentActivityTimeline events={agentSessions.events} approvals={agentSessions.approvals}
                  snapshot={snapshot} navigation={navigation} unavailable={Boolean(refreshError)} defaultExpanded={expandActivityDetails} />
              </div>
            </div>

            <details className="agent-session-disclosure">
              <summary>Connection and permissions</summary>
              {onConfigureAccess && <button type="button" disabled={locked} onClick={onConfigureAccess}>Configure access in workspace</button>}
            <section
              className="agent-session-section"
              aria-label="Active agent sessions and policies"
            >
              <h3>
                Access bundles ({activePolicies.length || agentSessions.policies.length})
              </h3>
              {(activePolicies.length ? activePolicies : agentSessions.policies).map(
                (policy, index) => {
                  const policySessions = agentSessions.sessions.filter(
                    (session) => session.policy_sha256 === policy.policy_sha256,
                  );
                  const policyLiveSessions = policySessions.filter((session) =>
                    LIVE_SESSION_STATES.has(session.state),
                  );
                  const latestSession = policySessions[0] ?? null;
                  const statusText = policyStateLabel(policy, policyLiveSessions);
                  const clientDisplay =
                    latestSession?.client_id
                      ? `${latestSession.client_id}${latestSession.client_version ? ` ${latestSession.client_version}` : ""}`
                      : policy.client_id ?? "MCP client";
                  return (
                    <div
                      key={policy.policy_sha256}
                      className="agent-policy-card"
                      aria-label={`Agent policy ${policy.bundle_name ?? policy.policy_sha256.slice(0, 8)}`}
                    >
                      <div className="agent-policy-card__header">
                        <strong>
                          {policy.bundle_name ??
                            `Policy ${policy.policy_sha256.slice(0, 8)}`}
                        </strong>
                        <span
                          className={`agent-session-badge tone-${stateTone(policy.state)}`}
                        >
                          {statusText}
                        </span>
                      </div>
                      <dl className="agent-policy-meta">
                        <dt>Declared client</dt>
                        <dd>
                          {policyLiveSessions.length > 0
                            ? clientDisplay
                            : `${clientDisplay} (not connected)`}
                        </dd>
                        {latestSession?.last_error && (
                          <>
                            <dt>Last error</dt>
                            <dd>{latestSession.last_error}</dd>
                          </>
                        )}
                      </dl>
                      <details>
                        <summary>Connection details</summary>
                        <dl className="agent-policy-meta">
                          <dt>Policy SHA-256</dt><dd>{policy.policy_sha256}</dd>
                          {policyLiveSessions.map((session) => <div className="agent-session-technical" key={session.session_id}>
                            <dt>Session</dt><dd>{session.session_id}</dd>
                            <dt>Last activity</dt><dd><RecordedTime value={session.last_heartbeat_at} /></dd>
                          </div>)}
                        </dl>
                      </details>
                      {!policy.revoked && (
                        <>
                          <label className="agent-policy-mode-label">
                            Permission mode
                            <select
                              aria-label={
                                index === 0
                                  ? "Agent permission mode"
                                  : `Permission mode for ${policy.policy_sha256.slice(0, 8)}`
                              }
                              disabled={locked || !onControl}
                              value={policy.permission_mode}
                              onChange={(event) =>
                                void dispatchControl({
                                  action: "set_permission_mode",
                                  policy_sha256: policy.policy_sha256,
                                  permission_mode: event.target
                                    .value as ResearchAgentPermissionMode,
                                })
                              }
                            >
                              <option value="ask_approval">
                                Ask for approval (confirm mutating actions)
                              </option>
                              <option value="full_access">
                                Full access (within granted scope)
                              </option>
                              <option value="inspect_only">
                                Inspect only (read-only)
                              </option>
                            </select>
                          </label>
                          <div className="agent-session-actions">
                            {!primaryPolicy && <button
                              type="button"
                              disabled={locked || !onControl}
                              onClick={() => void dispatchControl({
                                action: policy.paused ? "resume_session" : "pause_session",
                                policy_sha256: policy.policy_sha256,
                              })}
                            >
                              {policy.paused ? "Resume access" : "Pause access"}
                            </button>}
                            {policyLiveSessions.map((session) => (
                              <span
                                key={session.session_id}
                                className="agent-session-actions"
                              >
                                {runningJobs.filter((job) => job.owner?.session_id === session.session_id &&
                                  job.owner.policy_sha256 === session.policy_sha256).map((job) => (
                                  <button
                                    key={job.id}
                                    type="button"
                                    disabled={locked || !onControl}
                                    onClick={() =>
                                      void dispatchControl({
                                        action: "stop_job",
                                        session_id: session.session_id,
                                        job_id: job.id,
                                      })
                                    }
                                  >
                                    Stop active job
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  disabled={locked || !onControl}
                                  onClick={() =>
                                    void dispatchControl({
                                      action: "disconnect_session",
                                      session_id: session.session_id,
                                    })
                                  }
                                >
                                  Disconnect client
                                </button>
                              </span>
                            ))}
                            <button
                              type="button"
                              disabled={locked || !onControl}
                              onClick={() =>
                                void dispatchControl({
                                  action: "revoke_policy",
                                  policy_sha256: policy.policy_sha256,
                                })
                              }
                            >
                              Revoke access
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                },
              )}
            </section>
            </details>

            {agentSessions.approvals.some((approval) => approval.state !== "pending") && <details>
              <summary>Past approval requests</summary>
              <div className="agent-session-section agent-approval-history">
                {agentSessions.approvals.filter((approval) => approval.state !== "pending").slice(0, 12).map(renderApproval)}
                {agentSessions.approvals.filter((approval) => approval.state !== "pending").length > 12 &&
                  <p className="agent-activity-note">Showing the latest 12 past requests.</p>}
              </div>
            </details>}

            {agentSessions.capability_map && (
              <details>
                <summary>
                  MCP capability coverage ({agentSessions.capability_map.counts.supported_via_mcp +
                    agentSessions.capability_map.counts.supported_with_grant} supported · {agentSessions.capability_map.counts.gui_only_gap} unavailable through MCP)
                </summary>
                <ul className="agent-capabilities-list">
                  {agentSessions.capability_map.entries.map((entry) => (
                    <li key={entry.operation}>
                      <strong>{entry.summary}</strong>
                      <p>{entry.status === "gui_only_gap" ? entry.reason : entry.grant_requirement}</p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
  </section>;
}
