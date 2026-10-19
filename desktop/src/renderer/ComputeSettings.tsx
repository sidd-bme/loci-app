import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi } from "../shared/research-contracts";
import { sanitizeRendererError } from "./ContextHelp";
import { notifyComputeTargetsChanged } from "./compute-target-events";
import "./ComputeSettings.css";

type Resources = { cpus: number; memory_mb: number; wall_minutes: number; gpus: number };
type Target = {
  id: string; alias: string; revision: number; scheduler: string; resources: Resources;
  runtime_ready: boolean; readiness_checked_at: string | null;
};
type Draft = { id: string; revision: number; alias: string; host_key_sha256: string };
const CPU: Resources = { cpus: 2, memory_mb: 4096, wall_minutes: 30, gpus: 0 };
const GPU: Resources = { cpus: 4, memory_mb: 16384, wall_minutes: 30, gpus: 1 };

function ResourceFields({ value, onChange }: { value: Resources; onChange: (value: Resources) => void }) {
  return <>
    <label>Resource preset<select aria-label="Resource preset" value={value.gpus ? "gpu" : "cpu"}
      onChange={event => onChange({ ...(event.target.value === "gpu" ? GPU : CPU) })}>
      <option value="cpu">CPU</option><option value="gpu">Single GPU</option></select></label>
    <div className="compute-settings__resources">
      <label>CPU cores<input aria-label="CPU cores" type="number" min="1" step="1" value={value.cpus}
        onChange={event => onChange({ ...value, cpus: Number(event.target.value) })} /></label>
      <label>Host RAM (GiB)<input aria-label="Host RAM (GiB)" type="number" min="1" step="1" value={value.memory_mb / 1024}
        onChange={event => onChange({ ...value, memory_mb: Number(event.target.value) * 1024 })} /></label>
      <label>Time limit (min)<input aria-label="Time limit (min)" type="number" min="1" step="1" value={value.wall_minutes}
        onChange={event => onChange({ ...value, wall_minutes: Number(event.target.value) })} /></label>
    </div>
  </>;
}

export default function ComputeSettings({ api }: { api?: ResearchDesktopApi }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [studyProfiles, setStudyProfiles] = useState<Target[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [runtime, setRuntime] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [outputRoot, setOutputRoot] = useState("");
  const [scheduler, setScheduler] = useState("pbspro");
  const [schedulerBin, setSchedulerBin] = useState("");
  const [queue, setQueue] = useState("");
  const [account, setAccount] = useState("");
  const [resources, setResources] = useState<Resources>({ ...CPU });
  const [editing, setEditing] = useState<Target | null>(null);
  const mounted = useRef(false);
  const service = api?.computeTargets;
  const updateTarget = async (
    operation: "save" | "test" | "resources" | "remember" | "forget",
    request: Record<string, unknown>,
  ) => {
    if (!service) throw new Error("Application compute settings are unavailable.");
    const response = await service(operation, request);
    notifyComputeTargetsChanged();
    return response;
  };
  const refresh = async () => {
    if (!service) return;
    const result = await service("list", {}) as { targets: Target[]; study_profiles: Target[] };
    if (!Array.isArray(result.targets) || !Array.isArray(result.study_profiles)) throw new Error("Compute settings could not be read.");
    if (mounted.current) { setTargets(result.targets); setStudyProfiles(result.study_profiles); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(value => { if (mounted.current) setError(sanitizeRendererError(String(value))); });
    return () => { mounted.current = false; };
  }, [service]);
  const perform = async (label: string, action: () => Promise<void>) => {
    if (!service || busy) return;
    setBusy(label); setError(null); setMessage("");
    try { await action(); await refresh(); }
    catch (value) { if (mounted.current) setError(sanitizeRendererError(value instanceof Error ? value.message : String(value))); }
    finally { if (mounted.current) setBusy(null); }
  };
  const studyOnly = studyProfiles.filter(profile => !targets.some(target => target.alias === profile.alias));
  return <div className="compute-settings">
    <p>Save a cluster once, then choose it under Run on in any study.</p>
    {!service ? <p>Compute settings require the desktop app.</p> : <>
      <ul className="compute-settings__targets" aria-label="Saved compute targets">
        {targets.map(target => <li key={target.id} data-target-id={target.id}>
          <div className="compute-settings__target-heading"><strong>{target.alias}</strong><span>
            {target.runtime_ready ? "Runtime checked" : "Not checked"}</span></div>
          <p>{target.scheduler.toUpperCase()} · {target.resources.cpus} CPU · {target.resources.memory_mb / 1024} GiB
            {target.resources.gpus > 0 && ` · ${target.resources.gpus} GPU`} · {target.resources.wall_minutes} min</p>
          {target.readiness_checked_at && <small>Last check: {new Date(target.readiness_checked_at).toLocaleString()}</small>}
          <div className="compute-settings__actions">
            <button disabled={busy !== null} onClick={() => void perform(`Checking ${target.alias}…`, async () => {
              await updateTarget("test", { id: target.id, revision: target.revision });
              if (mounted.current) setMessage(`${target.alias}: connection, scheduler and worker checked.`);
            })}>Check runtime</button>
            <button disabled={busy !== null} onClick={() => { setEditing(target); setResources({ ...target.resources }); setAdding(false); }}>Resources</button>
            <button disabled={busy !== null} onClick={() => void perform("Removing saved target…", async () => {
              await updateTarget("forget", { id: target.id, revision: target.revision });
              if (mounted.current) { setEditing(null); setMessage("Removed from Settings. Existing study runs remain saved."); }
            })}>Forget target</button>
          </div>
        </li>)}
      </ul>
      {editing && <form onSubmit={event => { event.preventDefault(); void perform("Saving resources…", async () => {
        await updateTarget("resources", { id: editing.id, revision: editing.revision, resources });
        if (mounted.current) { setEditing(null); setMessage("Resources saved for future runs."); }
      }); }}><fieldset disabled={busy !== null}><legend>{editing.alias} resources</legend>
        <ResourceFields value={resources} onChange={setResources} />
        <div className="compute-settings__actions"><button type="submit">Save resources</button>
          <button type="button" onClick={() => setEditing(null)}>Cancel</button></div>
      </fieldset></form>}
      {studyOnly.length > 0 && <div className="compute-settings__study"><h4>From this study</h4>
        {studyOnly.map(target => <div key={target.id}><span>{target.alias}</span><button disabled={busy !== null}
          onClick={() => void perform("Saving target for other studies…", async () => {
            await updateTarget("remember", { alias: target.alias, expected_revision: 0 });
            if (mounted.current) setMessage(`${target.alias} is now available in every study.`);
          })}>Save for all studies</button></div>)}
      </div>}
      {!adding && <button disabled={busy !== null} onClick={() => {
        setAdding(true); setEditing(null); setDraft(null); setAlias(""); setResources({ ...CPU });
        setRuntime(""); setProjectRoot(""); setOutputRoot(""); setScheduler("pbspro");
        setSchedulerBin(""); setQueue(""); setAccount("");
      }}>Add target</button>}
      {adding && <form onSubmit={event => { event.preventDefault(); if (!draft) return;
        void perform("Saving compute target…", async () => {
          await updateTarget("save", { draft_id: draft.id, draft_revision: draft.revision,
            expected_revision: targets.find(target => target.alias === draft.alias)?.revision ?? 0,
            runtime_python: runtime.trim(), remote_project_root: projectRoot.trim(), remote_output_root: outputRoot.trim(),
            scheduler, scheduler_bin_dir: schedulerBin.trim() || null, queue: queue.trim() || null,
            account: account.trim() || null, resources });
          if (mounted.current) { setAdding(false); setDraft(null); setMessage("Target saved. Check its runtime before the first run."); }
        });
      }}><fieldset disabled={busy !== null}><legend>Add compute target</legend>
        <label>SSH alias<input aria-label="SSH alias" value={alias} placeholder="Your saved SSH alias" autoComplete="off"
          onChange={event => { setAlias(event.target.value); setDraft(null); }} /></label>
        <button type="button" disabled={!alias.trim()} onClick={() => void perform("Importing SSH alias…", async () => {
          const response = await service("import_ssh", { alias: alias.trim() }) as { draft: Draft };
          if (mounted.current) setDraft(response.draft);
        })}>Import alias</button>
        {!draft && <small>Uses your OpenSSH configuration and a host key already trusted on this Mac. Key or agent authentication is required.</small>}
        {draft && <>
          <details><summary>Trusted host identity</summary><code>{draft.host_key_sha256}</code></details>
          <label>Scheduler<select aria-label="Scheduler" value={scheduler} onChange={event => setScheduler(event.target.value)}>
            <option value="pbspro">PBS Pro</option><option value="pbs">PBS</option><option value="slurm">Slurm</option>
          </select></label>
          <label>Loci runtime executable<input aria-label="Loci runtime executable" value={runtime} required
            placeholder="/path/to/runtime/bin/python" onChange={event => setRuntime(event.target.value)} /></label>
          <small>Use a prepared Linux Loci runtime. Models must be installed there before running a learned method.</small>
          <label>Input workspace<input aria-label="Input workspace" value={projectRoot} required
            placeholder="Existing remote directory" onChange={event => setProjectRoot(event.target.value)} /></label>
          <label>Result workspace<input aria-label="Result workspace" value={outputRoot} required
            placeholder="Separate existing remote directory" onChange={event => setOutputRoot(event.target.value)} /></label>
          <div className="compute-settings__resources">
            <label>Queue<input aria-label="Queue" value={queue} onChange={event => setQueue(event.target.value)} /></label>
            <label>Account (optional)<input aria-label="Scheduler account" value={account} onChange={event => setAccount(event.target.value)} /></label>
          </div>
          <details><summary>Scheduler location</summary><label>Executable directory (optional)
            <input aria-label="Scheduler executable directory" value={schedulerBin} placeholder="Use the remote PATH"
              onChange={event => setSchedulerBin(event.target.value)} /></label></details>
          <ResourceFields value={resources} onChange={setResources} />
        </>}
        <div className="compute-settings__actions">{draft && <button type="submit">Save target</button>}
          <button type="button" onClick={() => { setAdding(false); setDraft(null); }}>Cancel</button></div>
      </fieldset></form>}
      {busy && <p role="status">{busy}</p>}{message && <p role="status">{message}</p>}
      {error && <p className="settings-field-error" role="alert">{error}</p>}
    </>}
  </div>;
}
