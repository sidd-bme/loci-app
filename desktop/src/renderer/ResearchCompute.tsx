import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchBatchTask, ResearchDesktopApi, ResearchSource } from "../shared/research-contracts";
import { sanitizeRendererError } from "./ContextHelp";
import { subscribeComputeTargetsChanged } from "./compute-target-events";
import "./ResearchCompute.css";

export type ComputeProfile = {
  alias: string; revision: number; runtime_ready: boolean; readiness_checked_at: string | null;
  resources: { cpus: number; memory_mb: number; wall_minutes: number; gpus: number };
  app_target?: { id: string; revision: number };
};
export type ComputeRun = {
  request_key: string; alias: string; state: string; remote_state: string | null;
  automatic: boolean; cancel_requested: boolean; updated_at: string;
  task_ids: string[]; source_ids: string[]; status_detail: string | null;
  attachment: { task_results: Array<{ local_result_id: string }> } | null;
};
export type RemoteAnalysisTarget = {
  alias: string; device: "cpu" | "cuda";
  start: (tasks: ResearchBatchTask[]) => Promise<void>;
};

function list<T>(value: unknown, key: string): T[] {
  const items = (value as Record<string, unknown>)?.[key];
  if (!Array.isArray(items)) throw new Error("The compute target response was incomplete.");
  return items as T[];
}
function errorMessage(error: unknown): string {
  return sanitizeRendererError(error instanceof Error ? error.message : "The connection is unavailable.");
}
export function activeComputeRun(run: ComputeRun): boolean {
  return !["attached", "cleaned", "cancelled"].includes(run.state)
    && (run.state !== "failed" || run.cancel_requested);
}
export function computeState(run: ComputeRun): string {
  if (run.state === "cancelled") return "Cancelled";
  if (run.cancel_requested) return "Cancellation requested";
  return ({ prepared: "Preparing transfer", staged: "Ready to submit", submitted: "Submitted",
    queued: "Waiting in queue", running: "Running", finished: "Retrieving results", retrieved: "Attaching results",
    attached: "Completed", cleaned: "Completed", failed: "Failed", unknown: "Status unavailable" } as Record<string, string>)[run.state] ?? run.state;
}

export function useResearchCompute({ api, projectId, scope, enabled, suspended, onAttached }: {
  api: ResearchDesktopApi; projectId?: string; scope: number; enabled: boolean; suspended: boolean;
  onAttached: () => Promise<void>;
}) {
  const [profiles, setProfiles] = useState<ComputeProfile[]>([]);
  const [runs, setRuns] = useState<ComputeRun[]>([]);
  const [alias, setAlias] = useState("");
  const [rights, setRights] = useState("noncommercial-research");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [preparation, setPreparation] = useState<{ alias: string; taskCount: number } | null>(null);
  const profileRequest = useRef(0);
  const attached = useRef(onAttached); attached.current = onAttached;
  const current = useRef({ projectId, scope, suspended }); current.current = { projectId, scope, suspended };
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const runRef = useRef(runs); runRef.current = runs;
  const valid = () => current.current.projectId === projectId && current.current.scope === scope && !current.current.suspended;
  const serial = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.catch(() => undefined).then(async () => {
      if (!valid()) throw new Error("The compute request belongs to a different study.");
      return work();
    });
    queue.current = next.catch(() => undefined);
    return next;
  };
  const refresh = useCallback(async () => {
    if (!enabled || !projectId || !valid()) return;
    const request = ++profileRequest.current;
    try {
      const [response, saved] = await Promise.all([
        api.execute("remote_profile_list", {}), api.computeTargets?.("list", {}),
      ]);
      const targets = saved ? list<ComputeProfile & { id: string }>(saved, "targets") : [];
      const globalProfiles = targets.map(item => ({ ...item, app_target: { id: item.id, revision: item.revision } }));
      const studyProfiles = list<ComputeProfile>(response, "profiles").filter(item => !targets.some(target => target.alias === item.alias));
      if (valid() && request === profileRequest.current) { setProfiles([...globalProfiles, ...studyProfiles]); setConnectionError(null); }
    } catch (error) { if (valid() && request === profileRequest.current) setConnectionError(errorMessage(error)); }
  }, [api, enabled, projectId, scope]);

  useEffect(() => subscribeComputeTargetsChanged(() => { void refresh(); }), [refresh]);

  useEffect(() => {
    setAlias(""); setProfiles([]); setRuns([]); setErrors({}); setConnectionError(null); setStarting(false); setPreparation(null);
    if (!enabled || !projectId || suspended) return;
    let cancelled = false;
    void refresh();
    void api.execute("remote_run_list", {}).then(response => {
      if (!cancelled && valid()) setRuns(list<ComputeRun>(response, "runs"));
    }).catch(error => { if (!cancelled && valid()) setConnectionError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [api, enabled, projectId, scope]);

  useEffect(() => {
    if (!enabled || !projectId || suspended) return;
    let cancelled = false, delay = 1500;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let failed = false;
      for (const run of runRef.current.filter(item => item.automatic && activeComputeRun(item))) {
        if (cancelled || !valid()) return;
        try {
          const response = await serial(() => api.execute("remote_analysis_advance", {
            project_id: projectId, alias: run.alias, request_key: run.request_key,
          })) as { run: ComputeRun };
          if (cancelled || !valid()) return;
          if (response.run?.request_key !== run.request_key || response.run.alias !== run.alias)
            throw new Error("The compute response does not match its saved run.");
          setRuns(old => old.map(item => item.request_key === run.request_key ? response.run : item));
          setErrors(old => { const next = { ...old }; delete next[run.request_key]; return next; });
          if (response.run.state === "attached" && run.state !== "attached") await attached.current();
        } catch (error) {
          failed = true;
          if (!cancelled && valid()) setErrors(old => ({ ...old, [run.request_key]: errorMessage(error) }));
        }
      }
      delay = failed ? Math.min(delay * 2, 60_000) : 10_000;
      if (!cancelled) timer = setTimeout(() => void tick(), delay);
    };
    timer = setTimeout(() => void tick(), delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, enabled, projectId, scope, suspended]);

  const start = async (tasks: ResearchBatchTask[]) => {
    const target = profiles.find(item => item.alias === alias);
    if (!target || !projectId || !valid()) throw new Error("Choose a saved compute target for this study.");
    const hasModel = tasks.some(task => task.operation === "cellpose_run");
    if (!hasModel && target.resources.gpus > 0)
      throw new Error("Choose CPU resources for a classical analysis.");
    const analysis = {
      project_id: projectId, alias, request_key: crypto.randomUUID().replaceAll("-", ""),
      tasks: structuredClone(tasks), device: hasModel && target.resources.gpus > 0 ? "cuda" : "cpu",
      allow_cpu_fallback: false, rights_basis: hasModel ? rights : null,
    };
    setPreparation({ alias, taskCount: tasks.length });
    setStarting(true);
    try {
      await serial(async () => {
        if (target.app_target) {
          if (!api.computeTargets) throw new Error("Application compute settings are unavailable.");
          await api.computeTargets("use", target.app_target);
          if (!valid()) throw new Error("The study changed before the compute target was selected.");
        }
        const { plan } = await api.execute("remote_analysis_plan", analysis) as { plan: { plan_sha256: string } };
        if (!valid()) throw new Error("The study changed before remote analysis started.");
        if (!plan || !/^[a-f0-9]{64}$/.test(plan.plan_sha256)) throw new Error("The compute plan is incomplete.");
        await api.execute("remote_analysis_start", { analysis, plan_sha256: plan.plan_sha256,
          transfer_authorized: true, retrieval_authorized: true, attachment_authorized: true });
      });
    } finally {
      if (valid()) {
        // A failed connection can still have left a prepared or submitted run.
        try { const response = await api.execute("remote_run_list", {}); if (valid()) setRuns(list<ComputeRun>(response, "runs")); }
        finally { if (valid()) { setStarting(false); setPreparation(null); } }
      }
    }
  };
  const cancel = async (run: ComputeRun) => {
    const response = await serial(() => api.execute("remote_analysis_cancel", {
      project_id: projectId, alias: run.alias, request_key: run.request_key,
    })) as { run: ComputeRun };
    if (valid()) setRuns(old => old.map(item => item.request_key === run.request_key ? response.run : item));
  };
  const selected = profiles.find(item => item.alias === alias);
  const target: RemoteAnalysisTarget | undefined = alias ? {
    alias, device: selected && selected.resources.gpus > 0 ? "cuda" : "cpu", start,
  } : undefined;
  return { profiles, runs, alias, setAlias, rights, setRights, selected, target, starting, preparation, refresh, cancel, errors, connectionError };
}

export type ResearchComputeController = ReturnType<typeof useResearchCompute>;

export function ResearchComputeControl({ compute, sources, learned, supported = true, busy, onSetup }: {
  compute: ResearchComputeController; sources: ResearchSource[]; learned: boolean; supported?: boolean; busy: boolean; onSetup: () => void;
}) {
  const total = sources.reduce((sum, source) => sum + (source.size_bytes ?? 0), 0);
  const allSizes = sources.every(source => Number.isSafeInteger(source.size_bytes));
  return <div className="research-compute" aria-label="Analysis compute target">
    <div className="research-compute__choice"><label>Run on<select aria-label="Run on" disabled={busy || !supported}
      value={supported ? compute.alias : ""} onFocus={() => void compute.refresh()} onChange={event => compute.setAlias(event.target.value)}>
      <option value="">This Mac</option>
      {compute.alias && !compute.selected && <option value={compute.alias} disabled>{compute.alias} · unavailable</option>}
      {compute.profiles.map(profile => <option key={profile.alias} value={profile.alias}
        disabled={!learned && profile.resources.gpus > 0}>{profile.alias} · {profile.resources.gpus ? `${profile.resources.gpus} GPU` : `${profile.resources.cpus} CPU`}</option>)}
    </select></label><button onClick={onSetup} disabled={busy}>Compute setup</button></div>
    {supported && compute.selected && <div className="research-compute__scope">
      <p>Run sends {sources.length === 1 ? sources[0].name : `${sources.length} source files`} in full{allSizes ? ` (${(total / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB)` : ""} to {compute.alias}, then retrieves and attaches the results. The analysis uses the selected region.</p>
      <p>{compute.selected.resources.memory_mb.toLocaleString()} MiB host RAM · {compute.selected.resources.wall_minutes} min limit{learned ? ` · ${compute.target?.device === "cuda" ? "CUDA required" : "CPU"}` : ""}</p>
      {learned && <label>Model use<select aria-label="Remote model rights basis" value={compute.rights} disabled={busy} onChange={event => compute.setRights(event.target.value)}>
        <option value="noncommercial-research">Noncommercial research</option><option value="written-commercial-clearance">Written commercial clearance</option>
      </select></label>}
    </div>}
    {compute.connectionError && <p role="status">{compute.connectionError}</p>}
  </div>;
}

export function ResearchComputeJobs({ compute, onResult, onError }: {
  compute: ResearchComputeController; onResult: (id: string) => Promise<void>; onError: (message: string) => void;
}) {
  if (!compute.runs.length && !compute.preparation) return null;
  return <ul className="workbench-jobs__list" aria-label="Remote analysis jobs">
    {compute.preparation && <li className="workbench-jobs__row workbench-jobs__row--remote">
      <div className="workbench-jobs__body"><div className="workbench-jobs__heading">
        <strong>{compute.preparation.alias} · {compute.preparation.taskCount} analysis {compute.preparation.taskCount === 1 ? "task" : "tasks"}</strong>
        <span className="workbench-jobs__state" role="status">Preparing remote run</span>
      </div></div>
    </li>}
    {[...compute.runs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(run =>
      <li key={run.request_key} className="workbench-jobs__row workbench-jobs__row--remote">
        <div className="workbench-jobs__body"><div className="workbench-jobs__heading"><strong>{run.alias} · {run.task_ids.length} analysis {run.task_ids.length === 1 ? "task" : "tasks"}</strong>
          <span className="workbench-jobs__state">{compute.errors[run.request_key] ? "Reconnect" : computeState(run)}</span></div>
          {compute.errors[run.request_key] && <p className="workbench-jobs__error">{compute.errors[run.request_key]} Progress remains saved; reconnection retries automatically.</p>}
          {run.state === "failed" && run.status_detail && <div className="recoverable-error">
            <details><summary>Failure details</summary>
              <pre tabIndex={0} aria-label="Full redacted failure status">{run.status_detail}</pre>
            </details>
          </div>}
          {!run.automatic && activeComputeRun(run) && <p>Continue this manually staged run in Remote compute.</p>}
          <div className="workbench-jobs__actions">{activeComputeRun(run) && !run.cancel_requested && <button onClick={() => void compute.cancel(run).catch(error => onError(errorMessage(error)))}>Cancel</button>}
            {run.attachment?.task_results.map(item => <button key={item.local_result_id} onClick={() => void onResult(item.local_result_id).catch(error => onError(errorMessage(error)))}>View result</button>)}</div>
        </div>
      </li>)}
  </ul>;
}
