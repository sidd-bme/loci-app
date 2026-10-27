import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type {
  ResearchAgentApprovalRecord,
  ResearchAgentControlRequest,
  ResearchAgentPermissionMode,
  ResearchAgentPolicyRecord,
  ResearchAgentSessionRecord,
  ResearchAgentSessionState,
  ResearchDesktopApi,
  ResearchSnapshot,
} from "../shared/research-contracts";
import { sourceLabelForId } from "./source-browser";
import "./AgentSessionIndicator.css";

const LIVE_SESSION_STATES = new Set<ResearchAgentSessionState>([
  "connected_idle",
  "executing",
  "awaiting_approval",
  "paused",
]);

function stateTone(
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

function pillSummary(
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

export function AgentSessionIndicator({
  api,
  snapshot,
  followAgent,
  onFollowAgentChange,
  onSnapshot,
  onError,
  refreshError = null,
}: {
  api: ResearchDesktopApi;
  snapshot: ResearchSnapshot;
  followAgent: boolean;
  onFollowAgentChange: (follow: boolean) => void;
  onSnapshot: (next: ResearchSnapshot) => void;
  onError: (message: string) => void;
  refreshError?: string | null;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const controlPending = useRef(false);
  const mounted = useRef(true);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const drawerId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!container.current?.contains(document.activeElement)) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);

  const agentSessions = snapshot.agent_sessions;
  if (!agentSessions) return null;

  const activePolicies = agentSessions.policies.filter(
    (policy) => !policy.revoked,
  );
  const hasHistory =
    agentSessions.policies.length > 0 ||
    agentSessions.sessions.length > 0 ||
    agentSessions.approvals.length > 0;
  if (!hasHistory && agentSessions.status === "none") return null;

  const overallState = agentSessions.status;
  const pendingApprovals = agentSessions.approvals.filter(
    (item) => item.state === "pending",
  );
  const liveSessions = agentSessions.sessions.filter((session) =>
    LIVE_SESSION_STATES.has(session.state),
  );
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

  const dispatchControl = async (request: ResearchAgentControlRequest) => {
    if (!api.controlAgentSession || controlPending.current) return;
    controlPending.current = true;
    setControlBusy(true);
    try {
      const next = await api.controlAgentSession(request);
      if (next && mounted.current) onSnapshot(next);
    } catch (caught) {
      if (mounted.current) onError(
        caught instanceof Error
          ? caught.message
          : "Could not update the agent session.",
      );
    } finally {
      controlPending.current = false;
      if (mounted.current) setControlBusy(false);
    }
  };

  const renderApproval = (approval: ResearchAgentApprovalRecord) => {
    const sourceLabel = approval.source_id
      ? sourceLabelForId(snapshot.sources, approval.source_id)
      : null;
    return (
      <div
        key={approval.id}
        className="agent-approval-card"
        aria-label={`Pending approval for ${approval.operation}`}
      >
        <div className="agent-approval-card__header">
          <strong>{approval.summary}</strong>
          <span className="agent-session-badge tone-warning">
            Single-use approval
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
          {approval.destination_name && (
            <>
              <dt>Export target</dt>
              <dd>{approval.destination_name}</dd>
            </>
          )}
        </dl>
        <details>
          <summary>Request parameters</summary>
          <pre>{JSON.stringify(approval.parameters_summary, null, 2)}</pre>
        </details>
        <div className="agent-session-actions">
          <button
            type="button"
            className="research-primary"
            disabled={controlBusy || !api.controlAgentSession}
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
            disabled={controlBusy || !api.controlAgentSession}
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
        </div>
      </div>
    );
  };

  return (
    <div className="agent-session-indicator" ref={container}>
      <button
        ref={trigger}
        type="button"
        className={`agent-session-pill tone-${tone}`}
        aria-label="Agent session status"
        aria-expanded={open}
        aria-controls={open ? drawerId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="agent-session-pill__dot" aria-hidden="true" />
        <span className="agent-session-pill__label" role="status">{label}</span>
        {pendingApprovals.length > 0 && (
          <span className="agent-session-pill__badge">
            {pendingApprovals.length}
          </span>
        )}
      </button>
      {open && (
        <section
          id={drawerId}
          className="agent-session-drawer"
          aria-label="Agent session and approvals"
        >
          <header className="agent-session-drawer__header">
            <div>
              <h2>{label}</h2>
              <p className="agent-session-drawer__subtitle">
                {agentSessions.connected_count > 0
                  ? `${liveSessions.length} connected ${liveSessions.length === 1 ? "session" : "sessions"}`
                  : "No MCP client is currently connected."}
              </p>
            </div>
            <button
              type="button"
              ref={closeButton}
              className="workbench-jobs__close"
              aria-label="Close agent session drawer"
              onClick={close}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <div className="agent-session-drawer__content">
            {refreshError && <p className="agent-session-refresh-error" role="alert">
              {refreshError} The details below are the last received state.
            </p>}
            <div className="agent-session-follow">
              <label>
                <input
                  type="checkbox"
                  aria-label="Follow agent"
                  checked={followAgent}
                  onChange={(event) => onFollowAgentChange(event.target.checked)}
                />
                Follow new agent results
              </label>
              <small>
                {followAgent
                  ? "Completed agent job results open while you are idle in Display, Results or Agent. Editing and unfinished drafts take priority."
                  : "Your current source, result, viewport camera and drafts stay undisturbed while the agent works."}
              </small>
            </div>

            {pendingApprovals.length > 0 && (
              <section
                className="agent-session-section"
                aria-label="Pending agent approvals"
              >
                <h3>Pending approvals ({pendingApprovals.length})</h3>
                {pendingApprovals.map(renderApproval)}
              </section>
            )}

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
                        <dt>Client</dt>
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
                            <dt>Last activity</dt><dd>{new Date(session.last_heartbeat_at).toLocaleString()}</dd>
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
                              disabled={controlBusy || !api.controlAgentSession}
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
                            <button
                              type="button"
                              disabled={controlBusy || !api.controlAgentSession}
                              onClick={() => void dispatchControl({
                                action: policy.paused ? "resume_session" : "pause_session",
                                policy_sha256: policy.policy_sha256,
                              })}
                            >
                              {policy.paused ? "Resume access" : "Pause access"}
                            </button>
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
                                    disabled={controlBusy || !api.controlAgentSession}
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
                                  disabled={controlBusy || !api.controlAgentSession}
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
                              disabled={controlBusy || !api.controlAgentSession}
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

            {agentSessions.events.length > 0 && (
              <details>
                <summary>
                  Recent MCP activity ({agentSessions.events.length})
                </summary>
                <ul className="agent-events-list">
                  {agentSessions.events.slice(0, 12).map((event) => (
                    <li key={event.id}>
                      <strong>{event.summary}</strong>
                      {event.operation ? ` · ${event.operation}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {agentSessions.capability_map && (
              <details>
                <summary>
                  MCP capability coverage ({agentSessions.capability_map.counts.supported_via_mcp +
                    agentSessions.capability_map.counts.supported_with_grant} supported · {agentSessions.capability_map.counts.gui_only_gap} GUI-only)
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
        </section>
      )}
    </div>
  );
}
