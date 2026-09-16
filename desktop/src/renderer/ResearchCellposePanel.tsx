import { useEffect, useState } from "react";
import type { CellposeProfileId, CellposeSettings, CellposeStatus, SegmentationProfile, SegmentationSettingDefinition } from "../shared/contracts";
import type { ResearchDesktopApi, ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";

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
  useEffect(() => { setDraft((old) => old.trim() && Number(old) === value ? old : String(value)); setInvalid(false); }, [value]);
  if (definition.valueType === "boolean") return <label className="research-check" title={definition.help}>
    <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{definition.label}</label>;
  if (definition.valueType === "choice") return <label title={definition.help}>{definition.label}
    <select value={String(value)} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{definition.choices.map((item) => <option key={item}>{item}</option>)}</select></label>;
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

export function ResearchCellposePanel({ api, source, selection, profileId, busy, onBusy, onError, onResult, onBatchConfiguration }: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection; profileId: CellposeProfileId;
  busy: boolean; onBusy: (value: string | null) => void; onError: (value: string) => void;
  onResult: (result: ResearchResult) => Promise<void>;
  onBatchConfiguration?: (configuration: ResearchCellposeBatchConfiguration | null) => void;
}) {
  const [profile, setProfile] = useState<SegmentationProfile | null>(null);
  const [status, setStatus] = useState<CellposeStatus | null>(null);
  const [settings, setSettings] = useState<CellposeSettings | null>(null);
  const [measurement, setMeasurement] = useState(selection.c);
  const [importing, setImporting] = useState(false);
  const [invalidSettings, setInvalidSettings] = useState<Record<string, boolean>>({});
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const validity = (key: string, valid: boolean) => setInvalidSettings((old) => old[key] === !valid ? old : { ...old, [key]: !valid });
  const hasInvalidSettings = Object.values(invalidSettings).some(Boolean);
  const native = window.loci;
  const rgb = ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "");
  const channels = source.metadata.dimensions?.c ?? 1;
  useEffect(() => {
    let active = true; setProfile(null); setStatus(null); setSettings(null); setInvalidSettings({});
    if (!native) return;
    void Promise.all([native.listProfiles(), native.getCellposeStatus(profileId)]).then(([profiles, state]) => {
      if (!active) return;
      const selected = profiles.find((item) => item.id === profileId);
      if (!selected) throw new Error("The selected Cellpose profile is unavailable in this build.");
      setProfile(selected); setSettings(selected.recommendedSettings as CellposeSettings); setStatus(state);
    }).catch((error) => { if (active) onError(error.message); });
    return () => { active = false; };
  }, [native, profileId, onError]);
  useEffect(() => { setMeasurement(selection.c); }, [source.id, selection.c]);
  useEffect(() => {
    if (!settings || !status?.ready || hasInvalidSettings || selection.z_stop !== undefined) {
      onBatchConfiguration?.(null);
      return;
    }
    onBatchConfiguration?.({
      configuredSourceId: source.id,
      profileId,
      settings: structuredClone(settings),
      measurementChannels: rgb ? [] : [measurement],
      workingBytes: 512 * 1024 ** 2,
    });
  }, [hasInvalidSettings, measurement, onBatchConfiguration, profileId, rgb, selection.z_stop, settings, source.id, status?.ready]);
  const run = async () => {
    if (!settings || !status?.ready || busy || hasInvalidSettings || selection.z_stop !== undefined) return;
    onBusy("Cellpose segmentation");
    try {
      const { z_stop: _depth, ...plane } = selection;
      const output = await api.execute("cellpose_run", { source_id: source.id, selection: plane,
        profile_id: profileId, settings, measurement_channels: rgb ? [] : [measurement], working_bytes: 512 * 1024 ** 2,
      }) as { result: ResearchResult };
      if (output.result?.source_id !== source.id) throw new Error("The Cellpose result does not match its source.");
      await onResult(output.result);
    } catch (error) { onError(error instanceof Error ? error.message : "Cellpose could not complete this image."); }
    finally { onBusy(null); }
  };
  return <div className="research-panel cellpose-panel">
    {!status ? <p role="status">Checking local model…</p> : !status.ready ? <div className="model-availability">
      <p>{status.summary}</p><button disabled={importing || busy} onClick={() => {
        if (!native) return; setImporting(true);
        void native.importCellposeModel(profileId).then((next) => { if (next) setStatus(next); })
          .catch((error) => onError(error.message)).finally(() => setImporting(false));
      }}>{importing ? "Verifying model…" : "Import checkpoint…"}</button>
      <small>A local checkpoint is verified against this profile. Opening an image never downloads a model.</small>
    </div> : <p className="model-ready">Ready locally</p>}
    {profile && settings && <>
      <p>{rgb ? "Input: interleaved source RGB" : `Input: ${source.metadata.channel_names?.[selection.c] || `Channel ${selection.c + 1}`}`} · Z {selection.z + 1}, T {selection.t + 1}</p>
      {selection.z_stop !== undefined && <p className="research-derived-notice">Cellpose runs on the selected 2D plane. Choose a single plane to run; volumetric classical segmentation is available separately.</p>}
      <div className="research-grid">{profile.settingsContract.filter((item) => ["diameter_px", "flow_threshold", "cellprob_threshold", "min_size_px"].includes(item.key)).map((definition) =>
        <Setting key={`${settingsEpoch}:${definition.key}`} definition={definition} onValidity={(valid) => validity(definition.key, valid)} value={settings[definition.key as keyof CellposeSettings]} disabled={busy}
          onChange={(value) => setSettings((old) => old ? { ...old, [definition.key]: value } : old)} />)}</div>
      {!rgb && <label>Measure raw channel<select aria-label="Cellpose measurement channel" value={measurement} onChange={(event) => setMeasurement(Number(event.target.value))}>
        {Array.from({ length: channels }, (_, index) => <option key={index} value={index}>{source.metadata.channel_names?.[index] || `Channel ${index + 1}`}</option>)}
      </select></label>}
      <details className="cellpose-advanced"><summary>Advanced settings</summary><div className="research-grid">{profile.settingsContract.filter((item) => !["diameter_px", "flow_threshold", "cellprob_threshold", "min_size_px"].includes(item.key)).map((definition) =>
        <Setting key={`${settingsEpoch}:${definition.key}`} definition={definition} onValidity={(valid) => validity(definition.key, valid)} value={settings[definition.key as keyof CellposeSettings]} disabled={busy}
          onChange={(value) => setSettings((old) => old ? { ...old, [definition.key]: value } : old)} />)}</div>
        <button onClick={() => { setSettings(profile.recommendedSettings as CellposeSettings); setInvalidSettings({}); setSettingsEpoch((value) => value + 1); }}>Reset settings</button></details>
      <details className="cellpose-identity"><summary>Model, licence & validation</summary>
        <dl className="research-kv"><dt>Model</dt><dd>{profile.name} · {profile.version}</dd><dt>Checkpoint SHA-256</dt><dd>{profile.model.sha256}</dd>
          <dt>Code / model licence</dt><dd>{profile.rights.codeLicense} / {profile.rights.modelLicense}</dd>
          <dt>Commercial use</dt><dd>{profile.rights.commercialUse}</dd></dl>
        <p>{profile.validation.summary}</p></details>
      <p className="research-derived-notice">Research segmentation. Review and correct labels before using counts or measurements.</p>
      <p role="status" hidden={!hasInvalidSettings}>Correct the highlighted settings before running.</p>
      <button className="research-primary" disabled={busy || hasInvalidSettings || !status?.ready || selection.z_stop !== undefined} onClick={() => void run()}>{busy ? "Running…" : "Segment image"}</button>
    </>}
  </div>;
}
