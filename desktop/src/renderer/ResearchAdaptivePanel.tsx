import { useEffect, useState } from "react";
import type { SegmentationProfile, SegmentationSettings } from "../shared/contracts";
import type { ResearchDesktopApi, ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { Setting } from "./ResearchCellposePanel";

export interface ResearchAdaptiveBatchConfiguration {
  configuredSourceId: string; profileId: "loci-classical"; settings: SegmentationSettings;
  measurementChannels: number[]; workingBytes: number;
}
export function ResearchAdaptivePanel({ api, source, selection, busy, onBusy, onError, onResult, onBatchConfiguration }: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection; busy: boolean;
  onBusy: (message: string | null) => void; onError: (message: string) => void;
  onResult: (result: ResearchResult) => Promise<void>;
  onBatchConfiguration?: (configuration: ResearchAdaptiveBatchConfiguration | null) => void;
}) {
  const [profile, setProfile] = useState<SegmentationProfile | null>(null);
  const [settings, setSettings] = useState<SegmentationSettings | null>(null);
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [epoch, setEpoch] = useState(0);
  const rgb = ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "");
  const bad = Object.values(invalid).some(Boolean);
  const configuration = settings && !bad && selection.z_stop === undefined ? {
    configuredSourceId: source.id, profileId: "loci-classical" as const, settings,
    measurementChannels: rgb ? [] : [selection.c], workingBytes: 512 * 1024 ** 2,
  } : null;
  useEffect(() => {
    let active = true;
    void window.loci?.listProfiles().then((profiles) => {
      if (!active) return;
      const next = profiles.find((item) => item.id === "loci-classical" && item.backendKind === "classical");
      if (!next) throw new Error("The built-in adaptive profile is unavailable in this build.");
      setProfile(next); setSettings(next.recommendedSettings as SegmentationSettings);
    }).catch((error) => { if (active) onError(error.message); });
    return () => { active = false; };
  }, [onError]);
  useEffect(() => {
    onBatchConfiguration?.(configuration);
  }, [settings, bad, source.id, rgb, selection.c, selection.z_stop, onBatchConfiguration]);
  const run = async () => {
    if (!configuration || busy) return;
    onBusy("Adaptive segmentation");
    try {
      const { z_stop: _depth, ...plane } = selection;
      const output = await api.execute("classical_run", { source_id: source.id, selection: plane,
        profile_id: configuration.profileId, settings: configuration.settings,
        measurement_channels: configuration.measurementChannels, working_bytes: configuration.workingBytes }) as { result: ResearchResult };
      if (output.result?.source_id !== source.id) throw new Error("The adaptive result does not match its source.");
      await onResult(output.result);
    } catch (error) { onError(error instanceof Error ? error.message : "Could not segment this image."); }
    finally { onBusy(null); }
  };
  return <div className="research-panel adaptive-panel">
    <p>{rgb ? "Input: RGB-derived grayscale" : `Input: Channel ${selection.c + 1}`} · Z {selection.z + 1}, T {selection.t + 1}</p>
    {selection.z_stop !== undefined && <p>Adaptive Watershed works on one 2D plane. Choose Classical methods for volumetric segmentation.</p>}
    {profile && settings ? <>
      <div className="research-grid">{profile.settingsContract.map((definition) => <Setting key={`${epoch}:${definition.key}`}
        definition={definition} value={settings[definition.key as keyof SegmentationSettings]} disabled={busy}
        onValidity={(valid) => setInvalid((old) => old[definition.key] === !valid ? old : { ...old, [definition.key]: !valid })}
        onChange={(value) => setSettings((old) => old ? { ...old, [definition.key]: value } : old)} />)}</div>
      <button disabled={busy} onClick={() => { setSettings(profile.recommendedSettings as SegmentationSettings); setInvalid({}); setEpoch((value) => value + 1); }}>Reset settings</button>
      <details><summary>Method & validation</summary><p>{profile.validation.summary}</p><p>Normalizes the selected input plane at the 1st and 99th percentiles. Measurements use original scalar intensities; the display settings do not alter the method.</p></details>
      {bad && <p role="status">Correct the highlighted settings before running.</p>}
      <button className="research-primary" disabled={busy || !configuration} onClick={() => void run()}>{busy ? "Running…" : "Segment image"}</button>
    </> : <p role="status">Loading built-in method…</p>}
  </div>;
}
