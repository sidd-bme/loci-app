import { useState, type ReactNode } from "react";
import { ArrowUpRight, Check, CircleAlert, Clock3 } from "lucide-react";
import type {
  ResearchAgentApprovalRecord,
  ResearchAgentEventRecord,
  ResearchAgentTargetReference,
  ResearchSnapshot,
} from "../shared/research-contracts";
import "./AgentActivityTimeline.css";
import { resultTitle } from "./result-title";

export interface AgentActivityNavigation {
  currentTargets?: ResearchAgentTargetReference[];
  onOpenSource?: (target: ResearchAgentTargetReference) => void;
  onOpenResult?: (target: ResearchAgentTargetReference) => void;
  onReviewResult?: (target: ResearchAgentTargetReference) => void;
  onOpenJob?: (target: ResearchAgentTargetReference) => void;
  onOpenWorkflow?: (target: ResearchAgentTargetReference) => void;
  onInspectPreview?: (target: ResearchAgentTargetReference, approvalId?: string) => void;
  /** Host-confirmed succeeded preview jobs; cache retrieval can still report eviction. */
  inspectablePreviewJobIds?: string[];
}

const EVENT_LIMIT = 12;
const targetName = (target: ResearchAgentTargetReference) => target.kind.replaceAll("_", " ");
const readable = (value: string) => value.replaceAll("_", " ");

export function RecordedTime({ value, compact = false }: { value: string; compact?: boolean }): React.JSX.Element {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? <time dateTime={value} title={value}>{date.toLocaleString(undefined, compact
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" } : undefined)}</time>
    : <span>Time unavailable</span>;
}

export function agentTargetState(target: ResearchAgentTargetReference, snapshot: ResearchSnapshot,
  currentTargets?: ResearchAgentTargetReference[]): "current" | "stale" | "unavailable" {
  let current: ResearchAgentTargetReference | undefined;
  if (target.kind === "source") {
    const source = snapshot.sources.find((item) => item.id === target.id);
    if (source?.locator_state === "relink-required") return "unavailable";
    if (source) current = { kind: "source", id: source.id, sha256: source.sha256 };
  } else if (target.kind === "result") {
    const result = snapshot.results.find((item) => item.id === target.id);
    if (result) current = { kind: "result", id: result.id, revision_hash: result.revision_hash,
      source_id: result.source_id, source_sha256: result.source_sha256 };
  } else if (target.kind === "job") {
    const job = snapshot.jobs.find((item) => item.id === target.id);
    if (job) current = { kind: "job", id: job.id, sha256: job.request_hash,
      source_id: typeof job.request.source_id === "string" ? job.request.source_id : undefined,
      source_sha256: typeof job.request.source_sha256 === "string" ? job.request.source_sha256 : undefined };
  } else {
    current = currentTargets?.find((item) => item.kind === target.kind && item.id === target.id);
  }
  if (!current) return "unavailable";
  for (const field of ["sha256", "revision_hash", "revision", "source_id", "source_sha256"] as const) {
    if (target[field] !== undefined && current[field] === undefined) return "unavailable";
    if (target[field] !== undefined && target[field] !== current[field]) return "stale";
  }
  if (target.source_id) {
    const source = snapshot.sources.find((item) => item.id === target.source_id);
    if (!source || source.locator_state === "relink-required") return "unavailable";
    if (target.source_sha256 && source.sha256 !== target.source_sha256) return "stale";
  }
  return "current";
}

function TargetIdentity({ target }: { target: ResearchAgentTargetReference }): React.JSX.Element {
  return <dl className="agent-approval-meta">
    <dt>ID</dt><dd><code>{target.id}</code></dd>
    {target.sha256 && <><dt>SHA-256</dt><dd><code>{target.sha256}</code></dd></>}
    {target.revision_hash && <><dt>Revision hash</dt><dd><code>{target.revision_hash}</code></dd></>}
    {target.revision !== undefined && <><dt>Revision</dt><dd>{target.revision}</dd></>}
    {target.source_id && <><dt>Source ID</dt><dd><code>{target.source_id}</code></dd></>}
    {target.source_sha256 && <><dt>Source SHA-256</dt><dd><code>{target.source_sha256}</code></dd></>}
    {target.selection && <><dt>Selection (pixels)</dt><dd>
      x {target.selection.x}, y {target.selection.y}, width {target.selection.width}, height {target.selection.height};
      {" "}T index {target.selection.t}, C index {target.selection.c}, Z index {target.selection.z}
      {target.selection.z_stop !== undefined ? ` to ${target.selection.z_stop} (exclusive)` : ""}; level {target.selection.level}
    </dd></>}
  </dl>;
}

export function AgentTargetLinks({ targets, snapshot, navigation = {}, unavailable = false, allowReview = false, compact = false }: {
  targets?: ResearchAgentTargetReference[];
  snapshot: ResearchSnapshot;
  navigation?: AgentActivityNavigation;
  unavailable?: boolean;
  allowReview?: boolean;
  compact?: boolean;
}): React.JSX.Element {
  if (!targets?.length) return <p className="agent-activity-note">No target recorded.</p>;
  return <ul className="agent-target-list" aria-label="Recorded targets">
    {targets.map((target, index) => {
      const state = unavailable ? "unavailable" : agentTargetState(target, snapshot, navigation.currentTargets);
      const callback = target.kind === "source" ? navigation.onOpenSource
        : target.kind === "result" ? navigation.onOpenResult
          : target.kind === "job" ? navigation.onOpenJob
            : target.kind === "workflow" ? navigation.onOpenWorkflow : undefined;
      const reason = state === "stale" ? "Stale · recorded identity differs from the current target"
        : state === "unavailable" ? "Unavailable · recorded target cannot be verified in the current study"
          : !callback ? "Navigation unavailable" : null;
      const label = `Open ${targetName(target)} ${target.id}`;
      const sourceName = state === "current" && target.kind === "source"
        ? snapshot.sources.find((item) => item.id === target.id)?.name : undefined;
      const result = state === "current" && target.kind === "result"
        ? snapshot.results.find((item) => item.id === target.id) : undefined;
      const job = target.kind === "job" ? snapshot.jobs.find((item) => item.id === target.id) : undefined;
      const previewAvailable = state === "current" && job?.state === "succeeded" &&
        ["model_preview", "cellpose_preview", "preview_recipe", "workflow_preview", "exploration_preview", "exploration_compare"].includes(job.operation) &&
        navigation.inspectablePreviewJobIds?.includes(target.id) && navigation.onInspectPreview;
      return <li key={`${target.kind}:${target.id}:${index}`}>
        <button type="button" className="agent-target-link" disabled={Boolean(reason)}
          aria-label={label} title={reason ?? label} onClick={() => callback?.(target)}>
          <span>{result ? `Open ${resultTitle(result)}` : <>Open {targetName(target)} {sourceName && !compact && `${sourceName} · `}<code>{target.id.slice(0, 8)}</code></>}</span>
          {!reason && <ArrowUpRight size={13} aria-hidden="true" />}
        </button>
        {reason && <span className="agent-target-reason">{reason}</span>}
        {state === "current" && job && (!compact || job.cancel_requested) && <span className="agent-activity-note">Recorded job state · {job.state}{job.cancel_requested ? " · stop requested" : ""}</span>}
        {allowReview && target.kind === "result" && navigation.onReviewResult && <button type="button" className="agent-target-link"
          disabled={state !== "current"} aria-label={`Review result ${target.id}`}
          title={state !== "current" ? reason ?? undefined : "Open human review for this exact result revision"}
          onClick={() => navigation.onReviewResult?.(target)}>Review result</button>}
        {previewAvailable && <button type="button" className="agent-target-link"
          aria-label={`Inspect preview ${target.id}`} onClick={() => navigation.onInspectPreview?.(target)}>Inspect preview</button>}
        {!compact && <details className="agent-target-identity">
          <summary>Exact {targetName(target)} target</summary>
          <TargetIdentity target={target} />
        </details>}
      </li>;
    })}
  </ul>;
}

function operationLabel(operation: string): string {
  const labels: Record<string, string> = {
    inspect_source: "source inspection", inspect_result: "result inspection",
    review_result: "result review", set_source_display: "display update",
    submit_recipe: "analysis", run_recipe: "analysis", preview_recipe: "analysis preview",
    workflow_preview: "workflow preview", export_result: "result export",
    annotation_evaluation_run: "annotation agreement", annotation_evaluation_get: "annotation agreement",
    annotation_reference_run: "freeze annotation reference", annotation_reference_candidates: "reference annotations",
    method_run: "reusable method", method_query: "method measurements", method_result: "method result",
    method_preflight: "method input check", method_list: "method library", method_get: "method package",
    method_runtime: "method runtime", result: "saved result",
  };
  return labels[operation] ?? readable(operation);
}

const EVENT_STATES: Record<string, string> = {
  operation_inspected: "Inspected",
  operation_proposed: "Proposal validated",
  operation_submitted: "Submitted",
  operation_started: "Started",
  operation_completed: "Completed call",
  operation_failed: "Failed",
  operation_blocked: "Blocked",
  approval_requested: "Decision requested",
  approval_approved: "Approved once · awaiting execution",
  approval_denied: "Request denied",
  approval_expired: "Request expired",
  approval_consumed: "Approval consumed",
  session_connected: "Client connected",
  session_disconnected: "Client disconnected",
  session_paused: "Access paused",
  session_resumed: "Access resumed",
  policy_revoked: "Access revoked",
  job_stopped: "Job stop requested",
};

const JOB_OUTCOMES = { succeeded: "Completed", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };

function jobOutcome(event: ResearchAgentEventRecord) {
  if (event.kind !== "operation_completed" && event.kind !== "operation_failed") return null;
  const match = /^Job ([a-f0-9]{8}) (succeeded|failed|cancelled|interrupted)\.$/.exec(event.summary);
  return match ? { prefix: match[1], state: match[2] as "succeeded" | "failed" | "cancelled" | "interrupted" } : null;
}

/** A durable job event also records input dependencies. Prefer its recorded
 * output only when the exact job confirms it; never substitute an input result. */
function primaryTarget(event: ResearchAgentEventRecord, snapshot: ResearchSnapshot) {
  const outcome = jobOutcome(event);
  if (outcome) {
    const jobs = event.targets?.filter((target) => target.kind === "job" && target.id.startsWith(outcome.prefix)) ?? [];
    if (jobs.length !== 1) return undefined;
    const recordedJob = jobs[0];
    const job = snapshot.jobs.find((item) => item.id === recordedJob.id && item.operation === event.operation && item.state === outcome.state);
    if (job && outcome.state === "succeeded") {
      const output = event.targets?.find((target) => target.kind === "result" && job.result_ids.includes(target.id));
      if (output) return output;
    }
    return recordedJob;
  }
  return event.targets?.find((target) => target.kind === "result") ??
    event.targets?.find((target) => target.kind === "job") ?? event.targets?.[0];
}

function targetContext(targets: ResearchAgentTargetReference[] | undefined, snapshot: ResearchSnapshot,
  primary?: ResearchAgentTargetReference): string | null {
  if (!targets?.length) return null;
  const source = targets.find((target) => target.kind === "source");
  const bound = primary?.source_id ? primary : targets.find((target) => target.source_id);
  const sourceId = bound?.source_id ?? source?.id;
  const sourceHash = bound?.source_sha256 ?? source?.sha256;
  const current = snapshot.sources.find((item) => item.id === sourceId && sourceHash === item.sha256);
  const result = primary?.kind === "result" ? primary : undefined;
  return [sourceId ? (current?.name ?? `Source ${sourceId.slice(0, 8)}`) : null,
    result ? `result ${result.id.slice(0, 8)}${result.revision_hash ? ` · rev ${result.revision_hash.slice(0, 8)}` : ""}` : null]
    .filter(Boolean).join(" · ") || null;
}

export function AgentApprovalDetails({ approval, snapshot, navigation, unavailable, decisionControls }: {
  approval: ResearchAgentApprovalRecord;
  snapshot: ResearchSnapshot;
  navigation?: AgentActivityNavigation;
  unavailable?: boolean;
  decisionControls?: ReactNode;
}): React.JSX.Element {
  // Older records still carry explicit source/result identity, even without targets.
  const targets = approval.targets ?? [
    ...(approval.source_id ? [{ kind: "source" as const, id: approval.source_id,
      ...(approval.source_sha256 ? { sha256: approval.source_sha256 } : {}) }] : []),
    ...(approval.result_id ? [{ kind: "result" as const, id: approval.result_id,
      ...(approval.revision_hash ? { revision_hash: approval.revision_hash } : {}),
      ...(approval.source_id ? { source_id: approval.source_id } : {}),
      ...(approval.source_sha256 ? { source_sha256: approval.source_sha256 } : {}) }] : []),
  ];
  const effect = approval.operation === "review_result"
    ? "Records an agent review decision for the recorded result revision."
    : approval.operation === "set_source_display"
      ? "Changes saved display settings at the recorded display revision."
      : approval.category === "export"
        ? "Writes an export to the granted destination."
        : approval.action_name === "large_result_delete"
          ? "Deletes the recorded derived result."
          : "Runs the recorded operation with the request parameters below.";
  return <div className="agent-approval-inspection">
    {approval.state === "pending" && <>
      <p className="agent-approval-consequence">{effect} Approve once authorizes this exact request, subject to scope and revision checks.</p>
      <p className="agent-approval-expiry"><Clock3 size={14} aria-hidden="true" /> Expires <RecordedTime value={approval.expires_at} /></p>
    </>}
    {approval.state === "approved" && <p className="agent-activity-note">Approval recorded; awaiting execution. Execution is not confirmed by approval alone.</p>}
    {decisionControls}
    <details className="agent-approval-provenance">
      <summary>Exact request and provenance</summary>
      <AgentTargetLinks targets={targets} snapshot={snapshot} navigation={navigation} unavailable={unavailable} />
      <dl className="agent-approval-meta">
        <dt>Requested by</dt><dd>{approval.client_id} (declared identity)</dd>
        <dt>State</dt><dd>{readable(approval.state)}</dd>
        <dt>Created</dt><dd><RecordedTime value={approval.created_at} /></dd>
        <dt>Expires</dt><dd><RecordedTime value={approval.expires_at} /></dd>
        {approval.decided_by && <><dt>Decided by</dt><dd>{approval.decided_by}</dd></>}
        {approval.decided_at && <><dt>Decision time</dt><dd><RecordedTime value={approval.decided_at} /></dd></>}
        {approval.decision_reason && <><dt>Decision reason</dt><dd>{approval.decision_reason}</dd></>}
        {approval.consumed_at && <><dt>Consumed</dt><dd><RecordedTime value={approval.consumed_at} /></dd></>}
      </dl>
      <details>
        <summary>Request identity and parameters</summary>
        <dl className="agent-approval-meta">
          <dt>Request ID</dt><dd><code>{approval.id}</code></dd>
          <dt>Request SHA-256</dt><dd><code>{approval.request_hash}</code></dd>
          <dt>Policy SHA-256</dt><dd><code>{approval.policy_sha256}</code></dd>
          {approval.session_id && <><dt>Session ID</dt><dd><code>{approval.session_id}</code></dd></>}
          <dt>Category</dt><dd>{approval.category}</dd>
          {approval.display_revision !== null && <><dt>Display revision</dt><dd>{approval.display_revision}</dd></>}
        </dl>
        <pre>{JSON.stringify(approval.parameters_summary, null, 2)}</pre>
      </details>
    </details>
  </div>;
}

function ActivityRecord({ defaultExpanded, children }: { defaultExpanded: boolean; children: ReactNode }): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return <details className="agent-activity-record" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>{children}</details>;
}

export function AgentActivityTimeline({ events, approvals, snapshot, navigation, unavailable = false, defaultExpanded = false }: {
  events: ResearchAgentEventRecord[];
  approvals: ResearchAgentApprovalRecord[];
  snapshot: ResearchSnapshot;
  navigation?: AgentActivityNavigation;
  unavailable?: boolean;
  defaultExpanded?: boolean;
}): React.JSX.Element {
  return <section className="agent-session-section agent-activity" aria-label="Agent activity timeline">
    <h3>Recent work</h3>
    {events.length > EVENT_LIMIT && <p className="agent-activity-note">Showing the latest {EVENT_LIMIT} of {events.length} recorded events.</p>}
    {!events.length && <p className="agent-activity-note">No agent activity recorded.</p>}
    <ol className="agent-activity-list">
      {events.slice(0, EVENT_LIMIT).map((event) => {
        const approval = event.approval_id ? approvals.find((item) => item.id === event.approval_id) : undefined;
        const primary = primaryTarget(event, snapshot);
        const otherTargets = event.targets?.filter((target) => target !== primary);
        const context = targetContext(event.targets, snapshot, primary);
        const primaryJob = !unavailable && primary?.kind === "job" && agentTargetState(primary, snapshot, navigation?.currentTargets) === "current"
          ? snapshot.jobs.find((job) => job.id === primary.id) : undefined;
        const outcome = jobOutcome(event);
        const status = outcome ? JOB_OUTCOMES[outcome.state] : EVENT_STATES[event.kind];
        const title = status && event.operation ? operationLabel(event.operation).replace(/^./, (letter) => letter.toUpperCase()) : status ?? event.summary;
        const tone = event.kind === "operation_failed" || outcome?.state === "interrupted" ? "danger"
          : event.kind === "operation_blocked" || event.kind === "approval_requested" || outcome?.state === "cancelled" ? "warning"
          : outcome?.state === "succeeded" ? "connected" : "neutral";
        const Icon = tone === "danger" || tone === "warning" ? CircleAlert
          : event.kind === "operation_completed" || event.kind === "operation_inspected" ? Check : ArrowUpRight;
        return <li className={`agent-activity-row tone-${tone}`} key={event.id}>
          <span className="agent-activity-mark"><Icon size={14} strokeWidth={1.6} aria-hidden="true" /></span>
          <div className="agent-activity-body">
            <div className="agent-activity-heading">
              <p className="agent-activity-summary">{title}</p>
              {status && title !== status && <span className={`agent-session-badge tone-${tone}`}>{status}</span>}
            </div>
            <div className="agent-activity-meta">
              {event.operation && <code>{event.operation}</code>}
              <RecordedTime value={event.timestamp} compact />
            </div>
            {context && <p className="agent-activity-context">{context}</p>}
            {primary && <AgentTargetLinks targets={[primary]} snapshot={snapshot} navigation={navigation} unavailable={unavailable} compact />}
            <ActivityRecord defaultExpanded={defaultExpanded}>
              <summary>Recorded activity</summary>
              {title !== event.summary && <p className="agent-activity-note">{event.summary}</p>}
              <dl className="agent-approval-meta">
                <dt>Actor</dt><dd>{event.actor}</dd>
                <dt>Event</dt><dd>{readable(event.kind)}</dd>
                <dt>Recorded</dt><dd><RecordedTime value={event.timestamp} /></dd>
                <dt>Event ID</dt><dd><code>{event.id}</code></dd>
                {event.session_id && <><dt>Session ID</dt><dd><code>{event.session_id}</code></dd></>}
                {event.policy_sha256 && <><dt>Policy SHA-256</dt><dd><code>{event.policy_sha256}</code></dd></>}
              </dl>
              {primary && <div className="agent-activity-target-record">
                <h4>Exact {targetName(primary)} target</h4><TargetIdentity target={primary} />
              </div>}
              {otherTargets?.length ? <AgentTargetLinks targets={otherTargets} snapshot={snapshot} navigation={navigation} unavailable={unavailable} />
                : !primary && <p className="agent-activity-note">No target recorded.</p>}
              {primaryJob && <p className="agent-activity-note">Current job state · {primaryJob.state}</p>}
            </ActivityRecord>
            {approval && <details className="agent-activity-request">
              <summary>Inspect request · {readable(approval.state)}</summary>
              <p className="agent-activity-summary">{approval.summary}</p>
              <AgentApprovalDetails approval={approval} snapshot={snapshot} navigation={navigation} unavailable={unavailable} />
            </details>}
            {event.approval_id && !approval && <p className="agent-activity-note">Request details unavailable · {event.approval_id}</p>}
          </div>
        </li>;
      })}
    </ol>
  </section>;
}
