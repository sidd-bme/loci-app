import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronUp,
  Clock3,
  FolderOpen,
  Laptop,
  LoaderCircle,
  RefreshCcw,
  Server,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type { JobSummary } from "../shared/contracts";

import "./JobCenter.css";

const MAX_VISIBLE_CURRENT_JOBS = 64;
const DEFAULT_RECENT_JOB_LIMIT = 12;

const currentStates = new Set<JobSummary["state"]>([
  "staging",
  "queued",
  "held",
  "running",
  "downloading",
  "verifying",
  "needs-attention",
  "disconnected",
]);

const currentStatePriority: Record<JobSummary["state"], number> = {
  "needs-attention": 0,
  held: 1,
  disconnected: 2,
  running: 3,
  downloading: 4,
  verifying: 5,
  queued: 6,
  staging: 7,
  failed: 8,
  cancelled: 9,
  completed: 10,
};

export type JobCenterAction = (jobId: string) => void | Promise<void>;

export interface JobCenterProps {
  jobs: readonly JobSummary[];
  onCancel?: JobCenterAction;
  onRetry?: JobCenterAction;
  onOpenResult?: JobCenterAction;
  /** When supplied, retry controls are shown only for these durable jobs. */
  retryableJobIds?: readonly string[];
  /** Bounded because the durable store may retain thousands of historical jobs. */
  recentJobLimit?: number;
}

export interface JobCenterGroups {
  current: JobSummary[];
  recent: JobSummary[];
}

export interface JobStatePresentation {
  label: string;
  explanation: string;
  tone: "neutral" | "processing" | "warning" | "danger" | "success";
}

interface PendingAction {
  jobId: string;
  kind: "cancel" | "retry" | "open";
}

function compareUpdatedDescending(left: JobSummary, right: JobSummary): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.jobId.localeCompare(right.jobId);
}

/** Stable grouping for renderer snapshots; it never mutates the persisted order. */
export function groupJobSummaries(
  jobs: readonly JobSummary[],
  recentJobLimit = DEFAULT_RECENT_JOB_LIMIT,
): JobCenterGroups {
  const boundedRecentLimit = Number.isSafeInteger(recentJobLimit)
    ? Math.max(1, Math.min(50, recentJobLimit))
    : DEFAULT_RECENT_JOB_LIMIT;
  const current = jobs
    .filter((job) => currentStates.has(job.state))
    .sort((left, right) => currentStatePriority[left.state] - currentStatePriority[right.state]
      || compareUpdatedDescending(left, right));
  const recent = jobs
    .filter((job) => !currentStates.has(job.state))
    .sort(compareUpdatedDescending)
    .slice(0, boundedRecentLimit);
  return { current, recent };
}

function computeTargetLabel(job: JobSummary): string {
  if (job.target.kind === "local") return "Local";
  if (job.target.label) return job.target.label;
  if (job.target.scheduler) return job.target.scheduler.toUpperCase();
  return "Remote";
}

export function describeJobState(job: JobSummary): JobStatePresentation {
  const publicMessage = job.publicMessage.trim();
  switch (job.state) {
    case "staging":
      return {
        label: "Preparing",
        explanation: publicMessage || "Checking inputs and preparing the job.",
        tone: "processing",
      };
    case "queued":
      return {
        label: "Waiting to start",
        explanation: job.target.kind === "remote"
          ? `Waiting for ${computeTargetLabel(job)} to assign compute resources.`
          : "Waiting for the current local job to finish.",
        tone: "neutral",
      };
    case "held":
      return {
        label: job.target.kind === "remote" ? "Paused by scheduler" : "Paused",
        explanation: job.target.kind === "remote"
          ? "The scheduler paused this job. Review its account, dependency, or resource request."
          : "This job is paused and needs review before it can continue.",
        tone: "warning",
      };
    case "running":
      return {
        label: "Running",
        explanation: publicMessage || "Processing the requested work.",
        tone: "processing",
      };
    case "downloading":
      return {
        label: "Downloading",
        explanation: publicMessage || "Copying result files back to this computer.",
        tone: "processing",
      };
    case "verifying":
      return {
        label: "Verifying",
        explanation: publicMessage || "Checking result integrity before publication.",
        tone: "processing",
      };
    case "needs-attention":
      return {
        label: "Review required",
        explanation: publicMessage || "Loci cannot safely continue this job without review.",
        tone: "warning",
      };
    case "disconnected":
      return {
        label: "Connection interrupted",
        explanation: publicMessage || "Reconnect to the compute target to refresh this job.",
        tone: "warning",
      };
    case "completed":
      return {
        label: "Completed",
        explanation: publicMessage || "The verified result is ready.",
        tone: "success",
      };
    case "failed":
      return {
        label: "Couldn’t finish",
        explanation: publicMessage || "The job stopped before producing a verified result.",
        tone: "danger",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        explanation: publicMessage || "The job was stopped before completion.",
        tone: "neutral",
      };
  }
}

function JobStateIcon({ job, size = 14 }: { job: JobSummary; size?: number }): React.JSX.Element {
  const common = { size, "aria-hidden": true as const };
  switch (job.state) {
    case "running":
    case "staging":
    case "downloading":
    case "verifying":
      return <LoaderCircle {...common} className="loci-job-center__spinner" />;
    case "queued":
      return <Clock3 {...common} />;
    case "held":
    case "needs-attention":
      return <AlertTriangle {...common} />;
    case "disconnected":
      return <WifiOff {...common} />;
    case "completed":
      return <CheckCircle2 {...common} />;
    case "failed":
      return <XCircle {...common} />;
    case "cancelled":
      return <Ban {...common} />;
  }
}

function formattedTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function actionLabel(kind: PendingAction["kind"]): string {
  switch (kind) {
    case "cancel": return "Cancelling…";
    case "retry": return "Retrying…";
    case "open": return "Opening…";
  }
}

function displaysProgress(state: JobSummary["state"]): boolean {
  return currentStates.has(state)
    && state !== "queued"
    && state !== "held"
    && state !== "needs-attention"
    && state !== "disconnected";
}

function JobProgress({ job, compact = false }: { job: JobSummary; compact?: boolean }): React.JSX.Element | null {
  if (!displaysProgress(job.state)) return null;
  const progress = job.progress === null ? null : Math.max(0, Math.min(1, job.progress));
  const percentage = progress === null ? null : Math.round(progress * 100);
  const style = progress === null
    ? undefined
    : ({ "--loci-job-progress": progress } as CSSProperties);
  return (
    <span
      className={`loci-job-progress ${progress === null ? "is-indeterminate" : ""} ${compact ? "is-compact" : ""}`}
      role="progressbar"
      aria-label={percentage === null ? "Progress unavailable" : `${percentage} percent`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentage ?? undefined}
    >
      <span style={style} />
    </span>
  );
}

interface JobRowProps {
  job: JobSummary;
  pendingAction: PendingAction | null;
  actionError: { jobId: string; message: string } | null;
  onAction: (job: JobSummary, kind: PendingAction["kind"], callback: JobCenterAction) => void;
  onCancel?: JobCenterAction;
  onRetry?: JobCenterAction;
  onOpenResult?: JobCenterAction;
  retryAllowed: boolean;
}

function JobRow({
  job,
  pendingAction,
  actionError,
  onAction,
  onCancel,
  onRetry,
  onOpenResult,
  retryAllowed,
}: JobRowProps): React.JSX.Element {
  const presentation = describeJobState(job);
  const isPending = pendingAction?.jobId === job.jobId;
  const canCancel = currentStates.has(job.state) && !job.cancellationRequested && Boolean(onCancel);
  const canRetry = retryAllowed && ["failed", "cancelled", "needs-attention"].includes(job.state) && Boolean(onRetry);
  const canOpen = job.state === "completed" && Boolean(onOpenResult);
  const updatedAt = job.finishedAt ?? job.updatedAt;
  const targetLabel = computeTargetLabel(job);
  const TargetIcon = job.target.kind === "local" ? Laptop : Server;

  return (
    <li className={`loci-job-row tone-${presentation.tone}`} data-job-state={job.state}>
      <span className="loci-job-row__icon"><JobStateIcon job={job} size={16} /></span>
      <div className="loci-job-row__body">
        <div className="loci-job-row__heading">
          <strong title={job.title}>{job.title}</strong>
          <span className={`loci-job-state tone-${presentation.tone}`}>{presentation.label}</span>
        </div>
        <p>{presentation.explanation}</p>
        <div className="loci-job-row__meta">
          <span><TargetIcon size={11} aria-hidden="true" />{targetLabel}</span>
          <time dateTime={updatedAt}>{formattedTimestamp(updatedAt)}</time>
          {job.cancellationRequested && <span className="loci-job-row__cancelling">Cancellation requested</span>}
        </div>
        <div className="loci-job-row__progress">
          <JobProgress job={job} />
          {job.progress !== null && displaysProgress(job.state) && (
            <span>{Math.round(Math.max(0, Math.min(1, job.progress)) * 100)}%</span>
          )}
        </div>
        {actionError?.jobId === job.jobId && (
          <p className="loci-job-row__action-error" role="alert">{actionError.message}</p>
        )}
      </div>
      {(canCancel || canRetry || canOpen || isPending) && (
        <div className="loci-job-row__actions" aria-label={`Actions for ${job.title}`}>
          {isPending && pendingAction ? (
            <button type="button" disabled aria-label={actionLabel(pendingAction.kind)}>
              <LoaderCircle className="loci-job-center__spinner" size={13} aria-hidden="true" />
              {actionLabel(pendingAction.kind)}
            </button>
          ) : (
            <>
              {canOpen && onOpenResult && (
                <button type="button" disabled={Boolean(pendingAction)} onClick={() => onAction(job, "open", onOpenResult)}>
                  <FolderOpen size={13} aria-hidden="true" />Open result
                </button>
              )}
              {canRetry && onRetry && (
                <button type="button" disabled={Boolean(pendingAction)} onClick={() => onAction(job, "retry", onRetry)}>
                  <RefreshCcw size={13} aria-hidden="true" />Retry
                </button>
              )}
              {canCancel && onCancel && (
                <button
                  type="button"
                  className="is-danger"
                  disabled={Boolean(pendingAction)}
                  onClick={() => onAction(job, "cancel", onCancel)}
                >
                  <X size={13} aria-hidden="true" />Cancel
                </button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

export default function JobCenter({
  jobs,
  onCancel,
  onRetry,
  onOpenResult,
  retryableJobIds,
  recentJobLimit = DEFAULT_RECENT_JOB_LIMIT,
}: JobCenterProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<{ jobId: string; message: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const panelId = `job-center-${useId().replace(/:/g, "")}`;
  const currentHeadingId = `${panelId}-current`;
  const recentHeadingId = `${panelId}-recent`;
  const groups = useMemo(
    () => groupJobSummaries(jobs, recentJobLimit),
    [jobs, recentJobLimit],
  );
  const retryableJobs = useMemo(
    () => retryableJobIds ? new Set(retryableJobIds) : null,
    [retryableJobIds],
  );
  const visibleCurrent = groups.current.slice(0, MAX_VISIBLE_CURRENT_JOBS);
  const primary = groups.current[0] ?? groups.recent[0];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  if (!primary) return null;
  const primaryPresentation = describeJobState(primary);
  const currentJobLabel = `${groups.current.length.toLocaleString()} current ${groups.current.length === 1 ? "job" : "jobs"}`;
  const primaryStateLabel = `${primary.title}: ${primaryPresentation.label}`;
  const hiddenCurrentCount = Math.max(0, groups.current.length - visibleCurrent.length);
  const omittedRecentCount = Math.max(
    0,
    jobs.filter((job) => !currentStates.has(job.state)).length - groups.recent.length,
  );

  const runAction = (job: JobSummary, kind: PendingAction["kind"], callback: JobCenterAction) => {
    if (pendingAction) return;
    setActionError(null);
    setPendingAction({ jobId: job.jobId, kind });
    void Promise.resolve()
      .then(() => callback(job.jobId))
      .catch(() => {
        if (!mountedRef.current) return;
        const verb = kind === "cancel" ? "cancel" : kind === "retry" ? "retry" : "open";
        setActionError({ jobId: job.jobId, message: `Could not ${verb} this job. Try again.` });
      })
      .finally(() => {
        if (mountedRef.current) setPendingAction(null);
      });
  };

  return (
    <div
      className="loci-job-center"
      role="status"
      aria-label="Background job status"
      aria-live="polite"
      aria-atomic="true"
    >
      <button
        ref={triggerRef}
        className={`loci-job-center__trigger tone-${primaryPresentation.tone}`}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${open ? "Close" : "Open"} Job Center \u2014 ${primaryStateLabel}, ${currentJobLabel}`}
        title={`${open ? "Close" : "Open"} Job Center`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="loci-job-center__trigger-icon"><JobStateIcon job={primary} size={13} /></span>
        <span className="loci-job-center__trigger-title">{primary.title}</span>
        <span className="loci-job-center__trigger-state">{primaryPresentation.label}</span>
        <JobProgress job={primary} compact />
        {groups.current.length > 1 && (
          <span className="loci-job-center__trigger-count">+{(groups.current.length - 1).toLocaleString()}</span>
        )}
        <ChevronUp className="loci-job-center__chevron" size={13} aria-hidden="true" />
      </button>

      <section
        id={panelId}
        className={`loci-job-drawer ${open ? "is-open" : ""}`}
        aria-label="Job Center"
        aria-hidden={!open}
        aria-live="off"
        inert={!open}
      >
        {open && <>
        <header className="loci-job-drawer__header">
          <div>
            <span className="loci-job-drawer__eyebrow"><Activity size={13} aria-hidden="true" />Jobs</span>
            <h2>Job Center</h2>
            <p>
              {groups.current.length.toLocaleString()} current · {groups.recent.length.toLocaleString()} recent
            </p>
          </div>
          <button
            type="button"
            className="loci-job-drawer__close"
            aria-label="Close Job Center"
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="loci-job-drawer__content">
          <section aria-labelledby={currentHeadingId}>
            <div className="loci-job-drawer__section-heading">
              <h3 id={currentHeadingId}>Current</h3>
              <span>{groups.current.length.toLocaleString()}</span>
            </div>
            {visibleCurrent.length ? (
              <ol className="loci-job-list">
                {visibleCurrent.map((job) => (
                  <JobRow
                    key={job.jobId}
                    job={job}
                    pendingAction={pendingAction}
                    actionError={actionError}
                    onAction={runAction}
                    onCancel={onCancel}
                    onRetry={onRetry}
                    onOpenResult={onOpenResult}
                    retryAllowed={!retryableJobs || retryableJobs.has(job.jobId)}
                  />
                ))}
              </ol>
            ) : (
              <p className="loci-job-drawer__empty">No jobs are running or waiting.</p>
            )}
            {hiddenCurrentCount > 0 && (
              <p className="loci-job-drawer__limit-note">
                Showing the first {visibleCurrent.length.toLocaleString()} of {groups.current.length.toLocaleString()} current jobs.
              </p>
            )}
          </section>

          <section aria-labelledby={recentHeadingId}>
            <div className="loci-job-drawer__section-heading">
              <h3 id={recentHeadingId}>Recent</h3>
              <span>{groups.recent.length.toLocaleString()}</span>
            </div>
            {groups.recent.length ? (
              <ol className="loci-job-list">
                {groups.recent.map((job) => (
                  <JobRow
                    key={job.jobId}
                    job={job}
                    pendingAction={pendingAction}
                    actionError={actionError}
                    onAction={runAction}
                    onCancel={onCancel}
                    onRetry={onRetry}
                    onOpenResult={onOpenResult}
                    retryAllowed={!retryableJobs || retryableJobs.has(job.jobId)}
                  />
                ))}
              </ol>
            ) : (
              <p className="loci-job-drawer__empty">Completed, failed, and cancelled jobs appear here.</p>
            )}
            {omittedRecentCount > 0 && (
              <p className="loci-job-drawer__limit-note">
                Showing the latest {groups.recent.length.toLocaleString()} of {(groups.recent.length + omittedRecentCount).toLocaleString()} recent jobs.
              </p>
            )}
          </section>
        </div>
        </>}
      </section>
    </div>
  );
}
