import { useEffect, useMemo, useState } from "react";
import { sanitizeRendererError } from "./ContextHelp";
import type {
  ResearchDesktopApi,
  ResearchRecipe,
  ResearchSelection,
  ResearchSource,
} from "../shared/research-contracts";
import "./ResearchRemotePanel.css";

type RemoteProfile = {
  alias: string;
  revision: number;
  scheduler: "direct" | "pbs" | "pbspro" | "slurm";
  allow_direct_compute: boolean;
  remote_input_root_count: number;
  runtime_ready: boolean;
  resources: { cpus: number; memory_mb: number; wall_minutes: number; gpus: number };
  connection: null | { host_key_sha256: string; runtime_version: string };
};
type RemoteRun = {
  request_key: string;
  request_sha256: string;
  alias: string;
  state: string;
  remote_state: string | null;
  remote_job_id: string | null;
  status_detail: string | null;
  resources?: { cpus: number; memory_mb: number; wall_minutes: number; gpus: number };
  outputs: Array<{ relative_path: string; sha256: string; size_bytes: number }> | null;
  attachment: {
    task_results?: Array<{ local_result_id?: string }>;
    [key: string]: unknown;
  } | null;
  remote_cleanup: Record<string, unknown> | null;
};
type RuntimeReceipt = {
  backend: string | null;
  requested_device: string | null;
  resolved_device: string | null;
  fallback_reason: string | null;
  fallback_recorded: boolean;
};
type PublicSource = ResearchSource & { size_bytes?: number };
type RemoteMapping = { enabled: boolean; rootIndex: string; relativePath: string };
type TaskMode = "recipe" | "cellpose";
type CellposeProfileId = "cellpose-sam-v2" | "cellpose-sam";

const CELLPOSE_PACKAGE_VERSION = "4.2.1.1";
const CELLPOSE_MODELS: Record<CellposeProfileId, { artifactId: string; sha256: string; sizeBytes: number }> = {
  "cellpose-sam-v2": {
    artifactId: "cpsam_v2",
    sha256: "0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667",
    sizeBytes: 1_233_586_851,
  },
  "cellpose-sam": {
    artifactId: "cpsam",
    sha256: "e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2",
    sizeBytes: 1_233_587_898,
  },
};

function randomKey(): string {
  const values = new Uint8Array(16);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function nullable(value: string): string | null {
  const clean = value.trim();
  return clean ? clean : null;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "The remote operation failed.";
  return sanitizeRendererError(message);
}

function readProfiles(value: unknown): RemoteProfile[] {
  const profiles = (value as { profiles?: unknown })?.profiles;
  if (!Array.isArray(profiles)) throw new Error("Remote profile list was invalid.");
  return profiles as RemoteProfile[];
}

function readRuns(value: unknown): RemoteRun[] {
  const runs = (value as { runs?: unknown })?.runs;
  if (!Array.isArray(runs)) throw new Error("Remote run list was invalid.");
  return runs as RemoteRun[];
}

function readRuntime(value: unknown): RuntimeReceipt | null {
  const runtime = (value as { provenance?: { runtime?: unknown } })?.provenance?.runtime;
  if (!runtime || typeof runtime !== "object") return null;
  const record = runtime as Record<string, unknown>;
  const cellpose = record.cellpose && typeof record.cellpose === "object"
    ? record.cellpose as Record<string, unknown>
    : null;
  if (cellpose) {
    const packageRecord = cellpose.package && typeof cellpose.package === "object"
      ? cellpose.package as Record<string, unknown>
      : null;
    const packageName = typeof packageRecord?.name === "string" ? packageRecord.name : null;
    const packageVersion = typeof packageRecord?.version === "string" ? packageRecord.version : null;
    const torchVersion = typeof record.torch_version === "string" ? record.torch_version : null;
    const packageIdentity = packageName
      ? `${packageName}${packageVersion ? ` ${packageVersion}` : ""}`
      : null;
    const backend = [packageIdentity, torchVersion ? `PyTorch ${torchVersion}` : null]
      .filter((item): item is string => item !== null)
      .join(" · ") || null;
    const requested = typeof cellpose.requested_device === "string"
      ? cellpose.requested_device
      : null;
    const resolved = typeof cellpose.resolved_device === "string"
      ? cellpose.resolved_device
      : null;
    const fallbackRecorded = Object.hasOwn(cellpose, "fallback_reason")
      && (cellpose.fallback_reason === null || typeof cellpose.fallback_reason === "string");
    if (backend || requested || resolved || fallbackRecorded) {
      return {
        backend,
        requested_device: requested,
        resolved_device: resolved,
        fallback_reason: fallbackRecorded ? cellpose.fallback_reason as string | null : null,
        fallback_recorded: fallbackRecorded,
      };
    }
  }
  const backend = typeof record.backend === "string" ? record.backend : null;
  const requested = typeof record.requested_device === "string" ? record.requested_device : null;
  const resolved = typeof record.resolved_device === "string" ? record.resolved_device : null;
  const fallbackRecorded = Object.hasOwn(record, "fallback_reason")
    && (record.fallback_reason === null || typeof record.fallback_reason === "string");
  if (!backend && !requested && !resolved && !fallbackRecorded) return null;
  return {
    backend,
    requested_device: requested,
    resolved_device: resolved,
    fallback_reason: fallbackRecorded ? record.fallback_reason as string | null : null,
    fallback_recorded: fallbackRecorded,
  };
}

export function ResearchRemotePanel({
  api,
  sources,
  selection,
  recipe,
  onResults,
  busy = false,
}: {
  api: ResearchDesktopApi;
  sources: ResearchSource[];
  selection: ResearchSelection;
  recipe: ResearchRecipe;
  onResults: (value: unknown) => void | Promise<void>;
  busy?: boolean;
}): React.JSX.Element {
  const [profiles, setProfiles] = useState<RemoteProfile[]>([]);
  const [runs, setRuns] = useState<RemoteRun[]>([]);
  const [localBusy, setLocalBusy] = useState(false);
  const [message, setMessage] = useState("Loading saved remote state…");
  const [error, setError] = useState<string | null>(null);
  const [alias, setAlias] = useState("vanda");
  const [knownHost, setKnownHost] = useState("");
  const [knownHostsFile, setKnownHostsFile] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [runtimePython, setRuntimePython] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [outputRoot, setOutputRoot] = useState("");
  const [inputRoots, setInputRoots] = useState("");
  const [scheduler, setScheduler] = useState<RemoteProfile["scheduler"]>("pbspro");
  const [schedulerBin, setSchedulerBin] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [queue, setQueue] = useState("");
  const [account, setAccount] = useState("");
  const [pbsGpuResource, setPbsGpuResource] = useState("");
  const [allowDirect, setAllowDirect] = useState(false);
  const [connectTimeout, setConnectTimeout] = useState("10");
  const [cpus, setCpus] = useState("2");
  const [memory, setMemory] = useState("4096");
  const [wallMinutes, setWallMinutes] = useState("30");
  const [gpus, setGpus] = useState("0");
  const [taskMode, setTaskMode] = useState<TaskMode>("recipe");
  const [cellposeProfile, setCellposeProfile] = useState<CellposeProfileId>("cellpose-sam-v2");
  const [cellposeDevice, setCellposeDevice] = useState<"cpu" | "cuda">("cuda");
  const [allowCpuFallback, setAllowCpuFallback] = useState(false);
  const [rightsBasis, setRightsBasis] = useState<"noncommercial-research" | "written-commercial-clearance">("noncommercial-research");
  const [maxEdge, setMaxEdge] = useState("1000");
  const [diameter, setDiameter] = useState("0");
  const [flowThreshold, setFlowThreshold] = useState("0.4");
  const [cellprobThreshold, setCellprobThreshold] = useState("0");
  const [minSize, setMinSize] = useState("15");
  const [batchSize, setBatchSize] = useState("8");
  const [selected, setSelected] = useState<string[]>(sources[0] ? [sources[0].id] : []);
  const [mappings, setMappings] = useState<Record<string, RemoteMapping>>({});
  const [transferApproved, setTransferApproved] = useState(false);
  const [retrievalApproved, setRetrievalApproved] = useState(false);
  const [cleanupApproved, setCleanupApproved] = useState(false);
  const [requestKey, setRequestKey] = useState(randomKey);
  const [activeKey, setActiveKey] = useState("");
  const [stderr, setStderr] = useState(false);
  const [logText, setLogText] = useState("");
  const [runtimeReceipt, setRuntimeReceipt] = useState<
    {
      state: "none" | "loading" | "loaded" | "unknown";
      resultId: string | null;
      value: RuntimeReceipt | null;
    }
  >({ state: "none", resultId: null, value: null });
  const [runtimeResultId, setRuntimeResultId] = useState("");

  const activeProfile = profiles.find((profile) => profile.alias === alias);
  const activeRun = runs.find((run) => run.request_key === activeKey);
  const selectedCellposeModel = CELLPOSE_MODELS[cellposeProfile];
  const disabled = busy || localBusy;
  const attachedResultIds = (activeRun?.attachment?.task_results ?? [])
    .map((item) => item.local_result_id)
    .filter((item): item is string => typeof item === "string" && item.length > 0);

  useEffect(() => {
    let current = true;
    Promise.all([api.execute("remote_profile_list", {}), api.execute("remote_run_list", {})])
      .then(([profileValue, runValue]) => {
        if (!current) return;
        const nextProfiles = readProfiles(profileValue);
        const nextRuns = readRuns(runValue);
        setProfiles(nextProfiles);
        setRuns(nextRuns);
        if (nextProfiles[0]) setAlias(nextProfiles[0].alias);
        if (nextRuns[0]) setActiveKey(nextRuns[0].request_key);
        setMessage("Saved remote state loaded.");
      })
      .catch((value) => current && setError(safeError(value)));
    return () => {
      current = false;
    };
  }, [api]);

  useEffect(() => {
    setRuntimeResultId(attachedResultIds[0] ?? "");
  }, [activeRun?.request_key, attachedResultIds.join("|")]);

  useEffect(() => {
    let current = true;
    if (!runtimeResultId) {
      setRuntimeReceipt({
        state: activeRun?.attachment ? "unknown" : "none", resultId: null, value: null,
      });
      return () => {
        current = false;
      };
    }
    setRuntimeReceipt({ state: "loading", resultId: runtimeResultId, value: null });
    void api.execute("result", { result_id: runtimeResultId, offset: 0, limit: 1 })
      .then((value) => {
        if (!current) return;
        const runtime = readRuntime(value);
        setRuntimeReceipt({
          state: runtime ? "loaded" : "unknown", resultId: runtimeResultId, value: runtime,
        });
      })
      .catch(() => {
        if (current) {
          setRuntimeReceipt({ state: "unknown", resultId: runtimeResultId, value: null });
        }
      });
    return () => {
      current = false;
    };
  }, [activeRun?.attachment, api, runtimeResultId]);

  useEffect(() => {
    setSelected((current) => current.filter((id) => sources.some((source) => source.id === id)));
  }, [sources]);

  const selectedSources = useMemo(
    () => selected.map((id) => sources.find((source) => source.id === id)).filter(Boolean) as PublicSource[],
    [selected, sources],
  );

  async function perform<T>(work: () => Promise<T>, success: string): Promise<T | undefined> {
    setLocalBusy(true);
    setError(null);
    try {
      const value = await work();
      setMessage(success);
      return value;
    } catch (value) {
      setError(safeError(value));
      return undefined;
    } finally {
      setLocalBusy(false);
    }
  }

  function mergeRun(value: unknown): RemoteRun {
    const run = (value as { run?: RemoteRun })?.run;
    if (!run?.request_key || !run.request_sha256) throw new Error("Remote run receipt was invalid.");
    setRuns((current) => [run, ...current.filter((item) => item.request_key !== run.request_key)]);
    setActiveKey(run.request_key);
    return run;
  }

  async function saveProfile(): Promise<void> {
    const revision = profiles.find((profile) => profile.alias === alias)?.revision ?? 0;
    const direct = scheduler === "direct";
    const value = await perform(
      () => api.execute("remote_profile_save", {
        alias: alias.trim(),
        known_host: knownHost.trim(),
        known_hosts_file: knownHostsFile.trim(),
        host_key_sha256: fingerprint.trim(),
        runtime_python: runtimePython.trim(),
        remote_project_root: projectRoot.trim(),
        remote_output_root: outputRoot.trim(),
        remote_input_roots: inputRoots.split("\n").map((item) => item.trim()).filter(Boolean),
        scheduler,
        scheduler_bin_dir: direct ? null : nullable(schedulerBin),
        identity_file: nullable(identityFile),
        queue: direct ? null : nullable(queue),
        account: direct ? null : nullable(account),
        pbs_gpu_resource: direct ? null : nullable(pbsGpuResource),
        allow_direct_compute: direct && allowDirect,
        connect_timeout_seconds: Number(connectTimeout),
        resources: { cpus: Number(cpus), memory_mb: Number(memory), wall_minutes: Number(wallMinutes), gpus: Number(gpus) },
        expected_revision: revision,
      }),
      "Remote profile saved.",
    );
    const profile = (value as { profile?: RemoteProfile } | undefined)?.profile;
    if (profile) setProfiles((current) => [profile, ...current.filter((item) => item.alias !== profile.alias)]);
  }

  async function profileOperation(operation: "profile_test" | "readiness"): Promise<void> {
    const value = await perform(
      () => api.execute(`remote_${operation}`, { alias }),
      operation === "readiness" ? "Runtime and roots are ready." : "Pinned connection verified.",
    );
    const profile = (value as { profile?: RemoteProfile } | undefined)?.profile;
    if (profile) setProfiles((current) => [profile, ...current.filter((item) => item.alias !== profile.alias)]);
  }

  function sourcePayload(source: PublicSource): Record<string, unknown> {
    const mapping = mappings[source.id];
    if (!mapping?.enabled) return { source_id: source.id };
    if (!Number.isSafeInteger(source.size_bytes)) throw new Error("Selected source has no exact byte size.");
    return {
      source_id: source.id,
      remote_input: {
        root_index: Number(mapping.rootIndex),
        relative_path: mapping.relativePath.trim(),
        source_sha256: source.sha256,
        size_bytes: source.size_bytes,
      },
    };
  }

  async function stage(): Promise<void> {
    if (!transferApproved) {
      setError("Approve the exact selected-source scope before staging.");
      return;
    }
    if (taskMode === "cellpose" && activeProfile && (
      (cellposeDevice === "cuda" && activeProfile.resources.gpus < 1)
      || (cellposeDevice === "cpu" && activeProfile.resources.gpus !== 0)
    )) {
      setError(cellposeDevice === "cuda"
        ? "CUDA Cellpose requires a saved profile with at least one GPU."
        : "CPU Cellpose requires a saved profile with zero GPUs.");
      return;
    }
    const model = selectedCellposeModel;
    const value = await perform(
      () => api.execute("remote_stage", {
        alias,
        request_key: requestKey,
        sources: selectedSources.map(sourcePayload),
        tasks: selectedSources.map((source, index) => taskMode === "recipe" ? ({
            task_id: `${requestKey.slice(0, 24)}${(index + 1).toString(16).padStart(8, "0")}`,
            source_id: source.id,
            selection,
            recipe,
          }) : ({
            task_id: `${requestKey.slice(0, 24)}${(index + 1).toString(16).padStart(8, "0")}`,
            source_id: source.id,
            operation: "run_cellpose",
            selection,
            cellpose: {
              profile_id: cellposeProfile,
              package_version: CELLPOSE_PACKAGE_VERSION,
              artifact_id: model.artifactId,
              model_sha256: model.sha256,
              model_size_bytes: model.sizeBytes,
              requested_device: cellposeDevice,
              allow_cpu_fallback: allowCpuFallback,
              rights_basis: rightsBasis,
              settings: {
                max_edge_px: Number(maxEdge), diameter_px: Number(diameter),
                flow_threshold: Number(flowThreshold), cellprob_threshold: Number(cellprobThreshold),
                min_size_px: Number(minSize), max_size_fraction: 0.4, niter: 250,
                batch_size: Number(batchSize), resample: true, augment: false,
                tile_overlap: 0.1, normalize: true, percentile_low: 1,
                percentile_high: 99, tile_norm_blocksize: 0, sharpen_radius: 0,
                smooth_radius: 0, invert: false, device: cellposeDevice,
              },
              measurement_channels: recipe.measurement_channels,
              gates: recipe.gates,
              working_bytes: recipe.working_bytes,
            },
          })),
        transfer_authority: {
          approved: true,
          scope: "remote-run-recipe",
          destination_alias: alias,
          source_ids: selectedSources.map((source) => source.id),
        },
      }),
      "Exact sources and request staged.",
    );
    if (value) mergeRun(value);
  }

  async function runOperation(operation: "submit" | "status" | "cancel" | "attach"): Promise<void> {
    if (!activeRun) return;
    const value = await perform(
      () => api.execute(`remote_${operation}`, { alias: activeRun.alias, request_key: activeRun.request_key }),
      `Remote ${operation} completed.`,
    );
    if (value) {
      mergeRun(value);
      if (operation === "attach") await onResults(value);
    }
  }

  async function retrieve(): Promise<void> {
    if (!activeRun || !retrievalApproved) {
      setError("Approve retrieval of this exact run before transfer.");
      return;
    }
    const value = await perform(
      () => api.execute("remote_retrieve", { alias: activeRun.alias, request_key: activeRun.request_key, transfer_authorized: true }),
      "Verified outputs retrieved.",
    );
    if (value) mergeRun(value);
  }

  async function readLog(): Promise<void> {
    if (!activeRun) return;
    const value = await perform(
      () => api.execute("remote_logs", { alias: activeRun.alias, request_key: activeRun.request_key, stderr, limit: 65536 }),
      "Bounded owned log loaded.",
    );
    const text = (value as { text?: unknown } | undefined)?.text;
    if (typeof text === "string") setLogText(text);
  }

  async function removeOwned(): Promise<void> {
    if (!activeRun || !cleanupApproved) {
      setError("Approve removal of this exact attached run before cleanup.");
      return;
    }
    const value = await perform(
      () => api.execute("remote_remove_owned", {
        alias: activeRun.alias,
        request_key: activeRun.request_key,
        request_sha256: activeRun.request_sha256,
        cleanup_authorized: true,
      }),
      "Two identity-bound owned run roots removed.",
    );
    if (value) mergeRun(value);
  }

  function mappingFor(id: string): RemoteMapping {
    return mappings[id] ?? { enabled: false, rootIndex: "0", relativePath: "" };
  }

  function updateMapping(id: string, change: Partial<RemoteMapping>): void {
    setMappings((current) => ({ ...current, [id]: { ...mappingFor(id), ...change } }));
  }

  return (
    <section className="research-remote" aria-label="Remote compute">
      <header><div><p className="eyebrow">Declared infrastructure</p><h3>Remote compute</h3></div><span className="research-remote-state">{message}</span></header>
      {error && <div className="research-remote-error" role="alert">{error}</div>}
      <details open>
        <summary>Connection profile and fixed resources</summary>
        <div className="research-remote-grid">
          <label>Profile alias<input aria-label="Remote profile alias" value={alias} onChange={(event) => setAlias(event.target.value)} /></label>
          <label>Known host lookup<input aria-label="Known host lookup" value={knownHost} onChange={(event) => setKnownHost(event.target.value)} /></label>
          <label>Known hosts file<input aria-label="Known hosts file" value={knownHostsFile} onChange={(event) => setKnownHostsFile(event.target.value)} /></label>
          <label>Host key SHA-256<input aria-label="Host key fingerprint" value={fingerprint} onChange={(event) => setFingerprint(event.target.value)} /></label>
          <label>Runtime Python<input aria-label="Remote runtime Python" value={runtimePython} onChange={(event) => setRuntimePython(event.target.value)} /></label>
          <label>Project root<input aria-label="Remote project root" value={projectRoot} onChange={(event) => setProjectRoot(event.target.value)} /></label>
          <label>Output root<input aria-label="Remote output root" value={outputRoot} onChange={(event) => setOutputRoot(event.target.value)} /></label>
          <label className="wide">Permitted input roots, one per line<textarea aria-label="Permitted remote input roots" value={inputRoots} onChange={(event) => setInputRoots(event.target.value)} /></label>
          <label>Scheduler<select aria-label="Remote scheduler" value={scheduler} onChange={(event) => setScheduler(event.target.value as RemoteProfile["scheduler"])}><option value="pbspro">PBS Pro</option><option value="pbs">PBS</option><option value="slurm">Slurm</option><option value="direct">Standalone direct</option></select></label>
          <label>Scheduler bin directory<input aria-label="Scheduler bin directory" disabled={scheduler === "direct"} value={schedulerBin} onChange={(event) => setSchedulerBin(event.target.value)} /></label>
          <label>Identity file<input aria-label="SSH identity file" value={identityFile} onChange={(event) => setIdentityFile(event.target.value)} /></label>
          <label>Queue<input aria-label="Scheduler queue" disabled={scheduler === "direct"} value={queue} onChange={(event) => setQueue(event.target.value)} /></label>
          <label>Account<input aria-label="Scheduler account" disabled={scheduler === "direct"} value={account} onChange={(event) => setAccount(event.target.value)} /></label>
          <label>PBS GPU key<input aria-label="PBS GPU resource" disabled={scheduler === "direct"} value={pbsGpuResource} onChange={(event) => setPbsGpuResource(event.target.value)} /></label>
          <label>Connect timeout<input aria-label="Connect timeout seconds" type="number" value={connectTimeout} onChange={(event) => setConnectTimeout(event.target.value)} /></label>
          <label>CPUs<input aria-label="Remote CPUs" type="number" value={cpus} onChange={(event) => setCpus(event.target.value)} /></label>
          <label>Memory MiB<input aria-label="Remote memory MiB" type="number" value={memory} onChange={(event) => setMemory(event.target.value)} /></label>
          <label>Wall minutes<input aria-label="Remote wall minutes" type="number" value={wallMinutes} onChange={(event) => setWallMinutes(event.target.value)} /></label>
          <label>GPUs<input aria-label="Remote GPUs" type="number" min="0" value={gpus} onChange={(event) => setGpus(event.target.value)} /></label>
        </div>
        {activeProfile && <div className="research-remote-receipt" aria-label="Saved remote profile receipt">
          <strong>{activeProfile.alias} revision {activeProfile.revision}</strong>
          <span>{activeProfile.scheduler} · {activeProfile.runtime_ready ? "readiness recorded" : "readiness unverified"}</span>
          <span className="wide">Saved requested resources: {activeProfile.resources.cpus} CPU · {activeProfile.resources.memory_mb} MiB · {activeProfile.resources.gpus} GPU · {activeProfile.resources.wall_minutes} min</span>
          <span className="wide">Pinned connection: {activeProfile.connection ? `${activeProfile.connection.runtime_version} · ${activeProfile.connection.host_key_sha256}` : "unknown"}</span>
        </div>}
        {scheduler === "direct" && <label className="research-remote-check"><input aria-label="Approve standalone direct compute host" type="checkbox" checked={allowDirect} onChange={(event) => setAllowDirect(event.target.checked)} />I confirm this alias is a standalone compute host approved for direct execution.</label>}
        <div className="research-remote-actions"><button disabled={disabled} onClick={() => void saveProfile()}>Save exact profile</button><button disabled={disabled || !activeProfile} onClick={() => void profileOperation("profile_test")}>Test pinned connection</button><button disabled={disabled || !activeProfile} onClick={() => void profileOperation("readiness")}>Check worker readiness</button></div>
      </details>

      <details open>
        <summary>Exact run scope</summary>
        <label>Request key<input aria-label="Remote request key" value={requestKey} onChange={(event) => setRequestKey(event.target.value)} /></label>
        <div className="research-remote-grid research-remote-task">
          <label>Task type<select aria-label="Remote task type" value={taskMode} onChange={(event) => setTaskMode(event.target.value as TaskMode)}><option value="recipe">Classical recipe</option><option value="cellpose">Cellpose learned segmentation</option></select></label>
          {taskMode === "cellpose" && <>
            <label>Cellpose profile<select aria-label="Remote Cellpose profile" value={cellposeProfile} onChange={(event) => setCellposeProfile(event.target.value as CellposeProfileId)}><option value="cellpose-sam-v2">Cellpose-SAM v2</option><option value="cellpose-sam">Website-compatible cpsam</option></select></label>
            <label>Requested device<select aria-label="Remote Cellpose device" value={cellposeDevice} onChange={(event) => setCellposeDevice(event.target.value as "cpu" | "cuda")}><option value="cuda">CUDA</option><option value="cpu">CPU</option></select></label>
            <label>Rights basis<select aria-label="Remote Cellpose rights basis" value={rightsBasis} onChange={(event) => setRightsBasis(event.target.value as typeof rightsBasis)}><option value="noncommercial-research">Noncommercial research</option><option value="written-commercial-clearance">Written commercial clearance</option></select></label>
            <label>Max edge px<input aria-label="Remote Cellpose max edge" type="number" value={maxEdge} onChange={(event) => setMaxEdge(event.target.value)} /></label>
            <label>Diameter px<input aria-label="Remote Cellpose diameter" type="number" value={diameter} onChange={(event) => setDiameter(event.target.value)} /></label>
            <label>Flow threshold<input aria-label="Remote Cellpose flow threshold" type="number" step="0.1" value={flowThreshold} onChange={(event) => setFlowThreshold(event.target.value)} /></label>
            <label>Cell probability threshold<input aria-label="Remote Cellpose probability threshold" type="number" step="0.1" value={cellprobThreshold} onChange={(event) => setCellprobThreshold(event.target.value)} /></label>
            <label>Minimum size px<input aria-label="Remote Cellpose minimum size" type="number" value={minSize} onChange={(event) => setMinSize(event.target.value)} /></label>
            <label>Batch size<input aria-label="Remote Cellpose batch size" type="number" value={batchSize} onChange={(event) => setBatchSize(event.target.value)} /></label>
            <label className="research-remote-check wide"><input aria-label="Allow Cellpose CPU fallback" type="checkbox" checked={allowCpuFallback} onChange={(event) => setAllowCpuFallback(event.target.checked)} />Allow a recorded CPU fallback if CUDA inference fails.</label>
            <div className="research-remote-model wide"><strong>Exact preprovisioned model</strong><span>{selectedCellposeModel.artifactId} · Cellpose {CELLPOSE_PACKAGE_VERSION} · {selectedCellposeModel.sizeBytes.toLocaleString()} bytes</span><code>{selectedCellposeModel.sha256}</code><p>The checkpoint must already exist in the remote managed model store and pass its exact hash. Loci does not transfer or download it. The selected rights basis is an operator declaration; attached results remain unreviewed.</p></div>
          </>}
        </div>
        <div className="research-remote-sources">
          {sources.map((source) => { const mapping = mappingFor(source.id); return <fieldset key={source.id}><legend><label><input aria-label={`Select ${source.name}`} type="checkbox" checked={selected.includes(source.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, source.id] : current.filter((id) => id !== source.id))} />{source.name}</label></legend><label className="research-remote-check"><input aria-label={`Use remote copy for ${source.name}`} type="checkbox" checked={mapping.enabled} onChange={(event) => updateMapping(source.id, { enabled: event.target.checked })} />Use an exact existing file under a permitted input root</label>{mapping.enabled && <div className="research-remote-map"><label>Root index<input aria-label={`Remote root index for ${source.name}`} type="number" min="0" value={mapping.rootIndex} onChange={(event) => updateMapping(source.id, { rootIndex: event.target.value })} /></label><label>Relative path<input aria-label={`Remote relative path for ${source.name}`} value={mapping.relativePath} onChange={(event) => updateMapping(source.id, { relativePath: event.target.value })} /></label><code>{source.sha256}</code></div>}</fieldset>; })}
        </div>
        <label className="research-remote-check"><input aria-label="Approve exact source scope" type="checkbox" checked={transferApproved} onChange={(event) => setTransferApproved(event.target.checked)} />Authorize this exact ordered source scope and current {taskMode === "recipe" ? "selection/recipe" : "selection, model identity, settings, device, and rights declaration"} for {alias}.</label>
        <div className="research-remote-actions"><button disabled={disabled || !activeProfile?.runtime_ready || !selectedSources.length} onClick={() => void stage()}>Stage exact request</button><button disabled={disabled} onClick={() => setRequestKey(randomKey())}>New request key</button></div>
      </details>

      <details open>
        <summary>Run, recover, and attach</summary>
        <label>Saved run<select aria-label="Saved remote run" value={activeKey} onChange={(event) => setActiveKey(event.target.value)}><option value="">Select a run</option>{runs.map((run) => <option key={run.request_key} value={run.request_key}>{run.request_key.slice(0, 8)} · {run.state}</option>)}</select></label>
        {activeRun && <div className="research-remote-receipt"><strong>{activeRun.state}</strong><span>job {activeRun.remote_job_id ?? "not submitted"}</span><code>{activeRun.request_sha256}</code>
          <span className="wide">Run requested resources: {activeRun.resources ? `${activeRun.resources.cpus} CPU · ${activeRun.resources.memory_mb} MiB · ${activeRun.resources.gpus} GPU · ${activeRun.resources.wall_minutes} min` : "unknown"}</span>
          {attachedResultIds.length > 1
            ? <label className="wide">Attached runtime result<select aria-label="Attached runtime result" value={runtimeResultId} onChange={(event) => setRuntimeResultId(event.target.value)}>{attachedResultIds.map((id) => <option key={id} value={id}>{id.slice(0, 8)}</option>)}</select></label>
            : runtimeResultId && <span className="wide">Exact attached result: {runtimeResultId.slice(0, 8)}</span>}
          {runtimeReceipt.state === "loaded" && runtimeReceipt.value
            && runtimeReceipt.resultId === runtimeResultId
            && attachedResultIds.includes(runtimeResultId)
            ? <dl className="research-remote-runtime" aria-label="Attached result runtime">
                <div><dt>Backend</dt><dd>{runtimeReceipt.value.backend ?? "unknown"}</dd></div>
                <div><dt>Requested device</dt><dd>{runtimeReceipt.value.requested_device ?? "unknown"}</dd></div>
                <div><dt>Resolved device</dt><dd>{runtimeReceipt.value.resolved_device ?? "unknown"}</dd></div>
                <div><dt>Fallback</dt><dd>{runtimeReceipt.value.fallback_recorded ? runtimeReceipt.value.fallback_reason ?? "none" : "unknown"}</dd></div>
              </dl>
            : <span className="wide">Attached result runtime: {runtimeReceipt.state === "loading" ? "loading exact result…" : "unknown"}</span>}
          {activeRun.status_detail && <p>{activeRun.status_detail}</p>}
        </div>}
        <div className="research-remote-actions"><button disabled={disabled || activeRun?.state !== "staged"} onClick={() => void runOperation("submit")}>Submit or recover</button><button disabled={disabled || !activeRun?.remote_job_id || activeRun.state === "cleaned"} onClick={() => void runOperation("status")}>Refresh status</button><button disabled={disabled || !activeRun?.remote_job_id || ["retrieved", "attached", "cleaned"].includes(activeRun.state)} onClick={() => void runOperation("cancel")}>Cancel exact job</button></div>
        <div className="research-remote-log"><label><input aria-label="Read stderr" type="checkbox" checked={stderr} onChange={(event) => setStderr(event.target.checked)} />stderr</label><button disabled={disabled || !activeRun?.remote_job_id || activeRun.state === "cleaned"} onClick={() => void readLog()}>Read bounded log</button><pre aria-label="Remote bounded log">{logText || "No log loaded."}</pre></div>
        <label className="research-remote-check"><input aria-label="Approve result retrieval" type="checkbox" checked={retrievalApproved} onChange={(event) => setRetrievalApproved(event.target.checked)} />Authorize retrieval into this study’s private result cache.</label>
        <div className="research-remote-actions"><button disabled={disabled || activeRun?.state !== "finished"} onClick={() => void retrieve()}>Retrieve verified outputs</button><button disabled={disabled || activeRun?.state !== "retrieved"} onClick={() => void runOperation("attach")}>Attach unreviewed results</button></div>
        <label className="research-remote-check danger"><input aria-label="Approve owned remote cleanup" type="checkbox" checked={cleanupApproved} onChange={(event) => setCleanupApproved(event.target.checked)} />After verified attachment, remove only the two run roots bound to this request hash and server job.</label>
        <button className="research-remote-remove" disabled={disabled || activeRun?.state !== "attached"} onClick={() => void removeOwned()}>Remove identity-bound owned data</button>
      </details>
    </section>
  );
}
