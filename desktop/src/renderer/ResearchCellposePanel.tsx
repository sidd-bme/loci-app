import { useEffect, useRef, useState } from "react";
import type { CellposeProfileId, CellposeSettings, CellposeStatus, SegmentationProfile, SegmentationSettingDefinition } from "../shared/contracts";
import type { ResearchDesktopApi, ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { SegmentationAllowanceControl } from "./SegmentationAllowanceControl";
import type { RemoteAnalysisTarget } from "./ResearchCompute";

export interface ResearchCellposeBatchConfiguration {
  configuredSourceId: string;
  profileId: CellposeProfileId;
  settings: CellposeSettings;
  measurementChannels: number[];
  workingBytes: number;
}

export function Setting({ definition, value, onChange, onValidity, disabled }: {
  definition: SegmentationSettingDefinition; value: unknown; disabled: boolean;
  onChange: (value: number | string | boolean) => void; onValidity: (valid: boolean) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  const applied = useRef(value);
  useEffect(() => {
    // A first edit can arrive before passive effects. Only a changed external
    // value should replace a draft or clear its validation state.
    if (Object.is(value, applied.current)) return;
    applied.current = value;
    setDraft((old) => old.trim() && Number(old) === value ? old : String(value));
    setInvalid(false);
  }, [value]);
  if (definition.valueType === "boolean") return <label className="research-check" title={definition.help}>
    <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{definition.label}</label>;
  if (definition.valueType === "choice") return <label title={definition.help}>{definition.label}
    <select aria-label={definition.label} value={String(value)} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{definition.choices.map((item) => <option key={item}>{item}</option>)}</select></label>;
  const edit = (text: string) => {
    setDraft(text);
    const number = Number(text);
    const valid = Boolean(text.trim()) && Number.isFinite(number) &&
      (definition.valueType !== "integer" || Number.isInteger(number)) &&
      (definition.minimum === null || number >= definition.minimum) &&
      (definition.maximum === null || number <= definition.maximum);
    setInvalid(!valid); onValidity(valid);
    if (valid) onChange(number);
  };
  return <label title={definition.help}>{definition.label}<input aria-label={definition.label} aria-invalid={invalid}
    inputMode="decimal" value={draft} disabled={disabled} onChange={(event) => edit(event.target.value)}
    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

export function ResearchCellposePanel({ api, source, selection, profileId, busy, onBusy, onError, onResult, onBatchConfiguration, workingBytes, onWorkingBytesChange, remoteTarget }: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection; profileId: CellposeProfileId;
  busy: boolean; onBusy: (value: string | null) => void; onError: (value: string) => void;
  onResult: (result: ResearchResult) => Promise<void>;
  onBatchConfiguration?: (configuration: ResearchCellposeBatchConfiguration | null) => void;
  workingBytes?: number;
  onWorkingBytesChange?: (bytes: number) => void;
  remoteTarget?: RemoteAnalysisTarget;
}) {
  const [profile, setProfile] = useState<SegmentationProfile | null>(null);
  const [status, setStatus] = useState<CellposeStatus | null>(null);
  const [settings, setSettings] = useState<CellposeSettings | null>(null);
  const [measurement, setMeasurement] = useState(selection.c);
  const [importing, setImporting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState("");
  const setupEpoch = useRef(0);
  const [invalidSettings, setInvalidSettings] = useState<Record<string, boolean>>({});
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const [internalWorkingBytes, setInternalWorkingBytes] = useState(512 * 1024 ** 2);
  const currentWorkingBytes = workingBytes ?? internalWorkingBytes;
  const handleWorkingBytesChange = (bytes: number) => {
    setInternalWorkingBytes(bytes);
    onWorkingBytesChange?.(bytes);
  };
  const validity = (key: string, valid: boolean) => setInvalidSettings((old) => old[key] === !valid ? old : { ...old, [key]: !valid });
  const hasInvalidSettings = Object.values(invalidSettings).some(Boolean);
  const native = window.loci;
  const rgb = ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "");
  const channels = source.metadata.dimensions?.c ?? 1;
  useEffect(() => {
    setupEpoch.current += 1;
    let active = true; setProfile(null); setStatus(null); setSettings(null); setInvalidSettings({});
    setImporting(false); setDownloading(false); setDownloadStatus("");
    if (!native) return;
    void Promise.all([native.listProfiles(), native.getCellposeStatus(profileId)]).then(([profiles, state]) => {
      if (!active) return;
      const selected = profiles.find((item) => item.id === profileId);
      if (!selected) throw new Error("The selected Cellpose profile is unavailable in this build.");
      setProfile(selected); setSettings(selected.recommendedSettings as CellposeSettings); setStatus(state);
    }).catch((error) => { if (active) onError(error.message); });
    return () => { active = false; setupEpoch.current += 1; };
  }, [native, profileId, onError]);
  useEffect(() => { setMeasurement(selection.c); }, [source.id, selection.c]);
  useEffect(() => {
    if (!settings || (!status?.ready && !remoteTarget) || hasInvalidSettings || selection.z_stop !== undefined) {
      onBatchConfiguration?.(null);
      return;
    }
    onBatchConfiguration?.({
      configuredSourceId: source.id,
      profileId,
      settings: structuredClone(remoteTarget ? { ...settings, device: remoteTarget.device } : settings),
      measurementChannels: rgb ? [] : [measurement],
      workingBytes: currentWorkingBytes,
    });
  }, [currentWorkingBytes, hasInvalidSettings, measurement, onBatchConfiguration, profileId, rgb, selection.z_stop, settings, source.id, status?.ready, remoteTarget?.alias, remoteTarget?.device]);
  const run = async () => {
    if (!settings || (!status?.ready && !remoteTarget) || busy || hasInvalidSettings || selection.z_stop !== undefined) return;
    onBusy("Cellpose segmentation");
    try {
      const { z_stop: _depth, ...plane } = selection;
      if (remoteTarget) {
        await remoteTarget.start([{ operation: "cellpose_run", source: { id: source.id, sha256: source.sha256 },
          request: { source_id: source.id, selection: plane, profile_id: profileId, settings: { ...settings, device: remoteTarget.device },
            measurement_channels: rgb ? [] : [measurement], working_bytes: currentWorkingBytes } }]);
        return;
      }
      const output = await api.execute("cellpose_run", { source_id: source.id, selection: plane,
        profile_id: profileId, settings, measurement_channels: rgb ? [] : [measurement], working_bytes: currentWorkingBytes,
      }) as { result: ResearchResult };
      if (output.result?.source_id !== source.id) throw new Error("The Cellpose result does not match its source.");
      await onResult(output.result);
    } catch (error) { onError(error instanceof Error ? error.message : "Cellpose could not complete this image."); }
    finally { onBusy(null); }
  };
  const setupModel = async (download: boolean) => {
    if (!native || importing || downloading || busy) return;
    const epoch = setupEpoch.current;
    setImporting(!download); setDownloading(download); setDownloadStatus("");
    try {
      const next = await (download ? native.downloadCellposeModel(profileId) : native.importCellposeModel(profileId));
      if (epoch !== setupEpoch.current || !next) return;
      if (next.profileId !== profileId || next.model.artifactId !== (profileId === "cellpose-sam" ? "cpsam" : "cpsam_v2"))
        throw new Error("The installed checkpoint does not match the selected model. Check model setup again.");
      setStatus(next);
    } catch (error) {
      if (epoch === setupEpoch.current) onError(error instanceof Error ? error.message : "Model setup failed.");
    } finally {
      if (epoch === setupEpoch.current) { setImporting(false); setDownloading(false); }
    }
  };
  return <div className="research-panel cellpose-panel">
    {remoteTarget ? <p className="model-ready">{remoteTarget.alias} · {remoteTarget.device === "cuda" ? "CUDA required" : "CPU"}</p> : !status ? <p role="status">Checking local model…</p> : !status.ready ? <div className="model-availability">
      <p>{status.summary}</p>
      {!status.model.verified && <>
        <p>Download the official {profileId === "cellpose-sam" ? "Cellpose-SAM" : "Cellpose-SAM v2"} checkpoint from Hugging Face · {(status.model.expectedSizeBytes / 1e9).toFixed(2)} GB.</p>
        <button disabled={importing || downloading || busy} onClick={() => void setupModel(true)}>{downloading ? "Downloading and verifying…" : "Download verified checkpoint"}</button>
      </>}
      {downloading ? <button onClick={() => {
        const epoch = setupEpoch.current;
        void native?.cancelCellposeDownload(profileId).then((cancelled) => {
          if (epoch === setupEpoch.current) setDownloadStatus(cancelled ? "Cancelling download…" : "Verification is finishing.");
        }).catch((error) => { if (epoch === setupEpoch.current) onError(error.message); });
      }}>Cancel download</button> : <button disabled={importing || busy} onClick={() => void setupModel(false)}>{importing ? "Verifying model…" : "Import checkpoint…"}</button>}
      {downloadStatus && <p role="status">{downloadStatus}</p>}
    </div> : <p className="model-ready">Ready locally</p>}
    {profile && settings && <>
      <p>{rgb ? "Input: interleaved source RGB" : `Input: ${source.metadata.channel_names?.[selection.c] || `Channel ${selection.c + 1}`}`} · Z {selection.z + 1}, T {selection.t + 1}</p>
      {selection.z_stop !== undefined && <p className="research-derived-notice">Choose a single Z plane to run Cellpose.</p>}
      <div className="research-grid">{profile.settingsContract.filter((item) => ["diameter_px", "flow_threshold", "cellprob_threshold", "min_size_px"].includes(item.key)).map((definition) =>
        <Setting key={`${settingsEpoch}:${definition.key}`} definition={definition} onValidity={(valid) => validity(definition.key, valid)} value={settings[definition.key as keyof CellposeSettings]} disabled={busy}
          onChange={(value) => setSettings((old) => old ? { ...old, [definition.key]: value } : old)} />)}</div>
      {!rgb && <label>Measure raw channel<select aria-label="Cellpose measurement channel" value={measurement} onChange={(event) => setMeasurement(Number(event.target.value))}>
        {Array.from({ length: channels }, (_, index) => <option key={index} value={index}>{source.metadata.channel_names?.[index] || `Channel ${index + 1}`}</option>)}
      </select></label>}
      <SegmentationAllowanceControl
        api={api}
        workingBytes={currentWorkingBytes}
        onWorkingBytesChange={handleWorkingBytesChange}
        busy={busy}
        accessibleName="Cellpose memory allowance"
      />
      <details className="cellpose-advanced"><summary>Advanced settings</summary><div className="research-grid">{profile.settingsContract.filter((item) => !["diameter_px", "flow_threshold", "cellprob_threshold", "min_size_px", ...(remoteTarget ? ["device"] : [])].includes(item.key)).map((definition) =>
        <Setting key={`${settingsEpoch}:${definition.key}`} definition={definition} onValidity={(valid) => validity(definition.key, valid)} value={settings[definition.key as keyof CellposeSettings]} disabled={busy}
          onChange={(value) => setSettings((old) => old ? { ...old, [definition.key]: value } : old)} />)}</div>
        <button onClick={() => { setSettings(profile.recommendedSettings as CellposeSettings); setInvalidSettings({}); setSettingsEpoch((value) => value + 1); }}>Reset settings</button></details>
      <details className="cellpose-identity"><summary>Model, licence & validation</summary>
        <dl className="research-kv"><dt>Model</dt><dd>{profile.name} · {profile.version}</dd><dt>Checkpoint SHA-256</dt><dd>{profile.model.sha256}</dd>
          <dt>Code / model licence</dt><dd>{profile.rights.codeLicense} / {profile.rights.modelLicense}</dd>
          <dt>Commercial use</dt><dd>{profile.rights.commercialUse}</dd></dl>
        <p>{profile.validation.summary}</p>
        <p>{remoteTarget ? "The compute target must already have this exact checkpoint and runtime." : "Download or import the exact checkpoint for this profile. The compatible runtime is installed separately."} Model and runtime memory are additional to the working allowance; GPU batch size affects accelerator memory.</p></details>
      <p role="status" hidden={!hasInvalidSettings}>Correct the highlighted settings before running.</p>
      <button className="research-primary" disabled={busy || hasInvalidSettings || (!status?.ready && !remoteTarget) || selection.z_stop !== undefined} onClick={() => void run()}>{busy ? remoteTarget ? "Preparing remote run…" : "Running…" : remoteTarget ? `Segment on ${remoteTarget.alias}` : "Segment image"}</button>
    </>}
  </div>;
}
