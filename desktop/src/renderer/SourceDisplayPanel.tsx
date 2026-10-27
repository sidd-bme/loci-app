import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type {
  BatchChannelColorsResponse,
  ResearchDesktopApi,
  ResearchSelection,
  ResearchSource,
} from "../shared/research-contracts";
import type { ViewerChannel } from "./ImageViewport";
import { rawVolumeUnavailableReason } from "./raw-volume-eligibility";
import { checkedHistogram, HistogramPlot, type SourceHistogram } from "./DisplayHistogram";
import { BatchChannelColorsDialog } from "./BatchChannelColorsDialog";
import { ValidatedNumberInput as NumberSetting } from "./ValidatedNumberInput";

export type SourceInterpretation = "auto" | "generic" | "histology" | "fluorescence" | "volume" | "medical";

export function SourceDisplayPanel({ source, selection, onSelection, channels, onChannels,
  projection, onProjection, onAuto, onReset, onCompare, interpretation, onInterpretation,
  viewReady = false,
  rgbMapping = null, onRgbMapping, onTask, api,
  sources, selectedSourceIds, onBeforeBatch, onBatchApplied,
}: {
  source: ResearchSource; selection: ResearchSelection; onSelection: (value: ResearchSelection) => void;
  channels: ViewerChannel[]; onChannels: (channels: ViewerChannel[]) => void;
  projection: "plane" | "max" | "mean"; onProjection: (value: "plane" | "max" | "mean") => void;
  onAuto: (channel?: number) => void; onReset: () => void; onCompare: (active: boolean) => void;
  interpretation: SourceInterpretation; onInterpretation: (value: SourceInterpretation) => void;
  viewReady?: boolean;
  onTask?: (task: "Annotate" | "Analyze" | "Quantify" | "volume") => void;
  rgbMapping?: [number, number, number] | null; onRgbMapping?: (mapping: [number, number, number] | null) => void;
  api?: Pick<ResearchDesktopApi, "execute">;
  sources?: ResearchSource[];
  selectedSourceIds?: string[];
  onBeforeBatch?: () => Promise<void>;
  onBatchApplied?: (response: BatchChannelColorsResponse, activeChannels: ViewerChannel[] | null) => void;
}) {
  const dimensions = source.metadata.dimensions ?? { x: source.metadata.shape?.at(-1) ?? 1,
    y: source.metadata.shape?.at(-2) ?? 1, z: source.metadata.shape?.length === 3 ? source.metadata.shape[0] : 1, t: 1, c: 1 };
  const rgbMaximum = source.metadata.channel_dtypes?.[selection.c] === "uint16" ? 65535 : 255;
  const rgb = ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "");
  const volumeUnavailable = rawVolumeUnavailableReason(source);
  const volumeAction = interpretation === "volume" || interpretation === "medical" && dimensions.z > 1;
  const information = useRef<HTMLDetailsElement>(null);
  const closeInformation = () => {
    if (!information.current) return;
    information.current.open = false;
    information.current.querySelector("summary")?.focus();
  };
  useEffect(() => { if (information.current) information.current.open = false; }, [source.id]);
  const [playing, setPlaying] = useState(false);
  const [histogramRequested, setHistogramRequested] = useState(false);
  const [histogram, setHistogram] = useState<SourceHistogram | null>(null);
  const [histogramError, setHistogramError] = useState<string | null>(null);
  const histogramToken = useRef(0);
  useEffect(() => { setHistogramRequested(false); setHistogram(null); setHistogramError(null); }, [source.id, source.sha256]);
  useEffect(() => {
    const token = ++histogramToken.current;
    setHistogram(null); setHistogramError(null);
    if (!api || !histogramRequested || playing) return;
    void api.execute("viewer_histogram", { source_id: source.id, t: selection.t, z: selection.z,
      ...(rgb ? { c: selection.c } : {}), bins: 256 })
      .then((value) => {
        const output = checkedHistogram(value, source, selection.t, selection.z, selection.c);
        if (histogramToken.current === token) setHistogram(output);
      }).catch(() => { if (histogramToken.current === token) setHistogramError("The histogram is unavailable for this source plane."); });
    return () => { if (histogramToken.current === token) histogramToken.current++; };
  }, [api, source.id, source.sha256, selection.t, selection.z, selection.c, rgb, histogramRequested, playing]);
  const [mappingDraft, setMappingDraft] = useState<[number, number, number]>(rgbMapping ?? [0, 1, 2]);
  useEffect(() => { setMappingDraft(rgbMapping ?? [0, 1, 2]); }, [source.id, rgbMapping]);
  useEffect(() => { setPlaying(false); }, [source.id]);
  useEffect(() => {
    if (!playing || !viewReady || dimensions.t < 2) return;
    const timer = setTimeout(() => onSelection({ ...selection, t: (selection.t + 1) % dimensions.t }), 200);
    return () => clearTimeout(timer);
  }, [playing, viewReady, dimensions.t, selection, onSelection]);
  const update = (channel: number, changes: Partial<ViewerChannel>) => onChannels(channels.map((item) => item.channel === channel ? { ...item, ...changes } : item));
  const [batchColorsOpen, setBatchColorsOpen] = useState(false);
  const [batchOpening, setBatchOpening] = useState(false);
  const [batchUndo, setBatchUndo] = useState<{
    palettes: Record<string, Array<{ channel: number; color: string }>>;
    expectedRevisions: Record<string, number>;
  } | null>(null);
  const [undoStatus, setUndoStatus] = useState<string | null>(null);

  const undoBatchColors = async () => {
    if (!batchUndo || !api) return;
    try {
      await onBeforeBatch?.();
      const sourceIds = Object.keys(batchUndo.palettes);
      const expectedRevisions = Object.fromEntries(sourceIds.map((sourceId) => [
        sourceId,
        batchUndo.expectedRevisions[sourceId],
      ]));
      const preflight = (await api.execute("batch_channel_colors", {
        source_ids: sourceIds,
        preview_only: true,
        mapping_mode: "restore",
        restore_palettes: batchUndo.palettes,
        expected_revisions: expectedRevisions,
      })) as BatchChannelColorsResponse;
      const resp = (await api.execute("batch_channel_colors", {
        source_ids: sourceIds,
        preview_only: false,
        mapping_mode: "restore",
        restore_palettes: batchUndo.palettes,
        expected_revisions: preflight.new_revisions,
      })) as BatchChannelColorsResponse;

      const activeAffected = resp.affected_sources.find(
        (s) => s.source_id === source.id && s.status === "applied"
      );
      let updatedChannels: ViewerChannel[] | null = null;
      if (activeAffected) {
        const colorLookup = new Map(activeAffected.changes.map((c) => [c.channel, c.new_color]));
        updatedChannels = channels.map((ch) =>
          colorLookup.has(ch.channel) ? { ...ch, color: colorLookup.get(ch.channel)! } : ch
        );
      }
      if (onBatchApplied) onBatchApplied(resp, updatedChannels);
      else if (updatedChannels) onChannels(updatedChannels);
      setUndoStatus(`Restored previous colors for ${resp.applied_count} image(s).`);
      setBatchUndo(null);
    } catch (err) {
      setUndoStatus(err instanceof Error ? err.message : "Failed to restore colors");
    }
  };
  const histogramFor = (channel: ViewerChannel, globalRgb = false) => {
    if (!api) return null;
    const current = histogram?.source_id === source.id && histogram.source_sha256 === source.sha256 &&
      histogram.sample.t === selection.t && histogram.sample.z === selection.z &&
      (!rgb || histogram.sample.c === selection.c) ? histogram : null;
    const records = current?.histograms.filter((record) => globalRgb ? record.component < 3 : record.component === channel.channel) ?? [];
    const label = globalRgb ? "RGB tone" : `Channel ${channel.channel + 1}`;
    return <details className="source-histogram-disclosure" onToggle={(event) => { if (event.currentTarget.open) setHistogramRequested(true); }}>
      <summary>Histogram & levels</summary>
      {records.length ? <><HistogramPlot records={records} low={channel.low ?? 0} high={channel.high ?? 1} label={label}
        colors={globalRgb ? ["#f47d7d", "#84cf91", "#86b9ec"] : [channel.color]}
        onRange={(low, high) => {
          const nextLow = globalRgb ? Math.max(0, low) : low;
          const nextHigh = globalRgb ? Math.min(rgbMaximum, high) : high;
          if (nextHigh > nextLow) update(channel.channel, { low: nextLow, high: nextHigh });
        }} />
        <p className="source-histogram-basis">{globalRgb ? source.metadata.palette ? "Palette lookup RGB values" : "Stored RGB component values" : "Native scalar values"} · {current!.sample.sample_count_per_component.toLocaleString()} samples per component · {globalRgb && `C ${selection.c + 1}, `}Z {current!.sample.z + 1}, T {current!.sample.t + 1}, level {current!.sample.level}. Full-plane sample; unchanged by pan or zoom.{projection !== "plane" && " This histogram describes the selected plane, not the Z projection."}</p></>
        : <p className="source-histogram-basis" role="status">{playing ? "Pause playback to inspect this plane's histogram." : histogramError ?? "Reading a stable image sample…"}</p>}
    </details>;
  };
  return <div className="research-panel source-display">
    <div className="source-presentation"><span>{rgb ? "Colour image" : dimensions.z > 1 ? "Volume" : dimensions.c > 1 ? "Multichannel image" : "Scalar image"}</span>
      <details className="source-information" ref={information}
        onKeyDown={(event) => { if (event.key === "Escape" && information.current?.open) { event.preventDefault(); event.stopPropagation(); closeInformation(); } }}>
        <summary title="Image structure and reversible presentation choices">Image info</summary>
        <div className="source-information-content">
          <div className="source-information-heading"><strong>Image information</strong>
            <button aria-label="Close image information" onClick={closeInformation}><X /></button></div>
        <dl><dt>Dimensions</dt><dd>{dimensions.x.toLocaleString()} × {dimensions.y.toLocaleString()}</dd>
          <dt>Axes</dt><dd>{source.metadata.axes ?? "Source grid"}</dd>
          <dt>Channels / samples</dt><dd>{dimensions.c} {rgb ? `· ${source.metadata.sample_semantics} samples` : "scalar channels"}</dd>
          <dt>Depth / time</dt><dd>{dimensions.z} Z · {dimensions.t} T</dd>
          {source.metadata.palette && <><dt>Colour storage</dt><dd>{source.metadata.palette.stored_index_dtype} palette indices, expanded through the source lookup table to uint16 RGB. Scalar fluorescence measurements are unavailable for these colour values.</dd></>}
          <dt>Calibration</dt><dd>{source.metadata.physical_calibration?.spacing?.map((value) => value.toLocaleString(undefined, { maximumSignificantDigits: 6 })).join(" × ") ?? "Not recorded"} {source.metadata.physical_calibration?.unit ?? ""}</dd></dl>
        <label>Open as <select aria-label="Open as" value={interpretation} onChange={(event) => onInterpretation(event.target.value as SourceInterpretation)}>
          <option value="auto">Automatic</option><option value="generic">Generic image</option>
          <option value="histology">Histology</option><option value="fluorescence">Fluorescence</option>
          <option value="volume" disabled={volumeUnavailable !== null}>Volume</option><option value="medical">Medical research</option>
        </select></label><small>Presentation choice only. Source values and recorded axes stay intact.</small>
        {dimensions.z === 1
          ? <small>One Z plane · a 2D source. Volume rendering requires measured depth.</small>
          : volumeUnavailable && <small>{volumeUnavailable}</small>}
        {!rgb && dimensions.c >= 3 && onRgbMapping && <div className="rgb-plane-mapping">
          <h3>RGB plane mapping</h3><p>Declare which scalar planes supply display red, green and blue. Analysis retains the original scalar channels.</p>
          {(["Red", "Green", "Blue"] as const).map((name, index) => <label key={name}>{name}<select aria-label={`${name} plane`} value={mappingDraft[index]} onChange={(event) => setMappingDraft((old) => old.map((value, position) => position === index ? Number(event.target.value) : value) as typeof old)}>
            {channels.map((channel) => <option key={channel.channel} value={channel.channel}>{source.metadata.channel_names?.[channel.channel] || `Channel ${channel.channel + 1}`}</option>)}
          </select></label>)}
          <button disabled={new Set(mappingDraft).size !== 3} onClick={() => onRgbMapping(mappingDraft)}>Apply RGB mapping</button>
          {rgbMapping && <button onClick={() => onRgbMapping(null)}>Restore source composite</button>}
          {new Set(mappingDraft).size !== 3 && <small>Choose three distinct source planes.</small>}
        </div>}
      </div></details>
    </div>
    {onTask && interpretation !== "auto" && <div className="source-context-actions" aria-label="Actions for this presentation">
      <span>{({ generic: "Image", histology: "Histology", fluorescence: "Fluorescence", volume: "Volume", medical: "Medical research" } as const)[interpretation]}</span>
      <button onClick={() => onTask("Annotate")}>{interpretation === "histology" ? "Annotate tissue" : "Draw & measure"}</button>
      <button
        disabled={volumeAction && volumeUnavailable !== null}
        title={volumeAction ? volumeUnavailable ?? "Explore the complete raw volume" : undefined}
        onClick={() => onTask(volumeAction ? "volume" : interpretation === "fluorescence" && !rgb ? "Quantify" : "Analyze")}
      >{volumeAction ? "Explore in 3D" : interpretation === "fluorescence" && !rgb ? "Quantify channels" : "Choose analysis"}</button>
      {volumeAction && volumeUnavailable && <small>{volumeUnavailable}</small>}
      {interpretation === "medical" && <small>{source.metadata.geometry?.frame ? `${source.metadata.geometry.frame} · source world coordinates` : "No patient coordinate frame is recorded; research display uses source axes."}</small>}
    </div>}
    {(dimensions.z > 1 || dimensions.t > 1 || (rgb && dimensions.c > 1)) && <div className="source-axes">
      {rgb && dimensions.c > 1 && <label>Image channel<select aria-label="Image channel" value={selection.c}
        onChange={(event) => onSelection({ ...selection, c: Number(event.target.value) })}>
        {Array.from({ length: dimensions.c }, (_, c) => <option key={c} value={c}>{source.metadata.channel_names?.[c] || `Channel ${c + 1}`}</option>)}
      </select></label>}
      {dimensions.z > 1 && <label><span>Z <output>{selection.z + 1} / {dimensions.z}</output></span><input aria-label="Z plane" type="range" min={0} max={dimensions.z - 1} value={selection.z} onChange={(event) => onSelection({ ...selection, z: Number(event.target.value) })} /></label>}
      {dimensions.t > 1 && <label><span>Time <output>{selection.t + 1} / {dimensions.t}</output><button onClick={() => setPlaying((value) => !value)}>{playing ? "Pause" : "Play"}</button></span><input aria-label="Time frame" type="range" min={0} max={dimensions.t - 1} value={selection.t} onChange={(event) => { setPlaying(false); onSelection({ ...selection, t: Number(event.target.value) }); }} /></label>}
      {dimensions.z > 1 && <label>View <select aria-label="Display scope" value={projection} onChange={(event) => {
        const next = event.target.value as typeof projection; onProjection(next);
        const { z_stop: _stop, ...plane } = selection;
        onSelection(next === "plane" ? plane : { ...plane, z: 0, z_stop: dimensions.z });
      }}><option value="plane">Single plane</option><option value="max" disabled={rgb}>Maximum projection</option><option value="mean" disabled={rgb}>Mean projection</option></select></label>}
      {rgb && dimensions.z > 1 && <small>Colour images display one Z plane at a time.</small>}
      {projection !== "plane" && <small>Z {selection.z + 1}–{selection.z_stop} · display projection</small>}
    </div>}
    {rgb ? <><div className="source-channel-heading"><h2>Image tone</h2><div className="source-tone-actions"><button title="Automatically adjust tone for this histology or RGB image" onClick={() => onAuto()}>Auto</button><button title="Restore the source RGB display" onClick={onReset}>Reset</button></div></div>
      <p className="source-colour-policy">One tone curve for all RGB components. Embedded profiles are applied once.</p>
      {channels[0] && <div className="source-tone-settings">
        {histogramFor(channels[0], true)}
        <label>Black point<NumberSetting key={`${source.id}:${source.sha256}:${selection.c}`} label="RGB black point" minimum={0} maximum={rgbMaximum} rejectionHint="Black point must be below white point." value={channels[0].low ?? 0} onValue={(low) => {
          if (low >= (channels[0].high ?? rgbMaximum)) return false; update(channels[0].channel, { low }); return true;
        }} /></label><label>White point<NumberSetting key={`${source.id}:${source.sha256}:${selection.c}`} label="RGB white point" minimum={0} maximum={rgbMaximum} rejectionHint="White point must be above black point." value={channels[0].high ?? rgbMaximum} onValue={(high) => {
          if (high <= (channels[0].low ?? 0)) return false; update(channels[0].channel, { high }); return true;
        }} /></label><label>Gamma<NumberSetting key={`${source.id}:${source.sha256}:${selection.c}`} label="RGB gamma" value={channels[0].gamma} minimum={0.1} maximum={10}
          onValue={(gamma) => { update(channels[0].channel, { gamma }); return true; }} /></label>
        <label>Gamma slider<input aria-label="RGB gamma slider" type="range" min={0.1} max={5} step={0.05} value={Math.min(5, channels[0].gamma)} onChange={(event) => update(channels[0].channel, { gamma: Number(event.target.value) })} /></label>
      </div>}</> : <>
      <div className="source-channel-heading">
        <h2>{rgbMapping ? "Declared RGB planes" : "Channels"}</h2>
        {!rgb && sources && sources.length > 0 && (
          <button
            title="Apply channel colors to selected images"
            disabled={batchOpening}
            onClick={() => {
              setBatchOpening(true);
              setUndoStatus(null);
              void (onBeforeBatch?.() ?? Promise.resolve()).then(() => setBatchColorsOpen(true))
                .catch((error) => setUndoStatus(error instanceof Error ? error.message : "Could not prepare saved display settings"))
                .finally(() => setBatchOpening(false));
            }}
          >
            {selectedSourceIds && selectedSourceIds.length > 1
              ? `Apply colors (${selectedSourceIds.length})`
              : "Apply colors"}
          </button>
        )}
        {batchUndo && (
          <button
            title="Restore previous channel colors before the last batch application"
            onClick={() => void undoBatchColors()}
          >
            Undo colors
          </button>
        )}
        <button title="Set stable ranges from a full-image sample." onClick={() => onAuto()}>Auto</button>
        <button title="Restore acquisition display settings" onClick={onReset}>Reset</button>
      </div>
      {channels.map((channel) => <details className="source-channel" key={channel.channel}>
        <summary><input type="checkbox" aria-label={`Channel ${channel.channel + 1} visible`} checked={channel.visible} onClick={(event) => event.stopPropagation()} onChange={(event) => update(channel.channel, { visible: event.target.checked })} />
          <i style={{ background: channel.color }} /><span>{source.metadata.channel_names?.[channel.channel] || `Channel ${channel.channel + 1}`}</span></summary>
        <div className="source-channel-settings">{histogramFor(channel)}<label>Low <NumberSetting key={`${source.id}:${source.sha256}`} label={`Channel ${channel.channel + 1} low`} rejectionHint="Low must be below high." value={channel.low ?? 0} onValue={(low) => {
          if (low >= (channel.high ?? 1)) return false; update(channel.channel, { low }); return true;
        }} /></label><label>High <NumberSetting key={`${source.id}:${source.sha256}`} label={`Channel ${channel.channel + 1} high`} rejectionHint="High must be above low." value={channel.high ?? 1} onValue={(high) => {
          if (high <= (channel.low ?? 0)) return false; update(channel.channel, { high }); return true;
        }} /></label><label>Gamma <NumberSetting key={`${source.id}:${source.sha256}`} label={`Channel ${channel.channel + 1} gamma`} value={channel.gamma} minimum={0.1} maximum={10} onValue={(gamma) => { update(channel.channel, { gamma }); return true; }} /></label>
        {(source.source_kind === "medical" || interpretation === "medical") && <>
          <label>Window<NumberSetting key={`${source.id}:${source.sha256}`} label={`Channel ${channel.channel + 1} window`} value={(channel.high ?? 1) - (channel.low ?? 0)} minimum={Number.MIN_VALUE} onValue={(width) => {
            const level = ((channel.high ?? 1) + (channel.low ?? 0)) / 2;
            if (!Number.isFinite(level - width / 2) || !Number.isFinite(level + width / 2) || level - width / 2 >= level + width / 2) return false;
            update(channel.channel, { low: level - width / 2, high: level + width / 2 }); return true;
          }} /></label><label>Level<NumberSetting key={`${source.id}:${source.sha256}`} label={`Channel ${channel.channel + 1} level`} value={((channel.high ?? 1) + (channel.low ?? 0)) / 2} onValue={(level) => {
            const half = ((channel.high ?? 1) - (channel.low ?? 0)) / 2;
            if (!Number.isFinite(level - half) || !Number.isFinite(level + half) || level - half >= level + half) return false;
            update(channel.channel, { low: level - half, high: level + half }); return true;
          }} /></label>
        </>}
        <label>Colour <input aria-label={`Channel ${channel.channel + 1} color`} type="color" value={channel.color} onChange={(event) => update(channel.channel, { color: event.target.value })} /></label>
        <label className="source-opacity">Opacity <output aria-label={`Channel ${channel.channel + 1} opacity value`}>{channel.opacity ?? 1}</output><input aria-label={`Channel ${channel.channel + 1} opacity`} type="range" min={0} max={1} step={0.01} value={channel.opacity ?? 1} onChange={(event) => update(channel.channel, { opacity: Number(event.target.value) })} /></label>
        <button onClick={() => onAuto(channel.channel)} title="Set a stable full-image range for this channel.">Auto range</button></div>
      </details>)}
    </>}
      <button className="compare-source" title="Hold to compare with acquisition/default display settings" onPointerDown={() => onCompare(true)} onPointerUp={() => onCompare(false)} onPointerLeave={() => onCompare(false)} onBlur={() => onCompare(false)}
        onKeyDown={(event) => { if (event.key === " ") { event.preventDefault(); onCompare(true); } }} onKeyUp={(event) => { if (event.key === " ") onCompare(false); }}>Hold for source display</button>
    <details className="analysis-region-settings"><summary>Analysis region</summary><p>Used by analysis tools. Moving the camera does not change this region.</p><div className="research-grid">
      {(["x", "y", "width", "height", "c"] as const).map((key) => <label key={key}>{key === "c" ? "Analysis channel" : key}<NumberSetting
        key={`${source.id}:${source.sha256}`} integer label={key === "c" ? "C" : key[0].toUpperCase() + key.slice(1)} value={selection[key]}
        minimum={key === "width" || key === "height" ? 1 : 0}
        maximum={key === "c" ? dimensions.c - 1 : key === "x" ? dimensions.x - selection.width
          : key === "y" ? dimensions.y - selection.height : key === "width" ? dimensions.x - selection.x : dimensions.y - selection.y}
        onValue={(value) => { onSelection({ ...selection, [key]: value }); return true; }} /></label>)}
      {dimensions.z > 1 && <>
        <label>Start Z (0-based)<NumberSetting key={`${source.id}:${source.sha256}`} integer label="Z" value={selection.z} minimum={0}
          maximum={Math.min(dimensions.z - 1, (selection.z_stop ?? dimensions.z) - 1)} onValue={(z) => { onSelection({ ...selection, z }); return true; }} /></label>
        <label>Depth<select aria-label="Analysis depth" value={selection.z_stop === undefined ? "plane" : "volume"} onChange={(event) => {
          const { z_stop: _stop, ...plane } = selection;
          onSelection(event.target.value === "plane" ? plane : { ...plane, z_stop: dimensions.z });
        }}><option value="plane">One plane</option><option value="volume" disabled={rgb}>Z range</option></select></label>
        {selection.z_stop !== undefined && <label>Stop Z (exclusive)<NumberSetting key={`${source.id}:${source.sha256}`} integer label="Z stop" value={selection.z_stop}
          minimum={selection.z + 1} maximum={dimensions.z} onValue={(z_stop) => { onSelection({ ...selection, z_stop }); return true; }} /></label>}
      </>}
      {dimensions.t > 1 && <label>Time (0-based)<NumberSetting key={`${source.id}:${source.sha256}`} integer label="T" value={selection.t}
        minimum={0} maximum={dimensions.t - 1} onValue={(t) => { onSelection({ ...selection, t }); return true; }} /></label>}
    </div></details>
      {batchColorsOpen && sources && api && (
        <BatchChannelColorsDialog
          open={batchColorsOpen}
          onClose={() => setBatchColorsOpen(false)}
          api={api}
          activeSource={source}
          sources={sources}
          selectedSourceIds={selectedSourceIds ?? [source.id]}
          activeChannels={channels}
          onBeforeRequest={onBeforeBatch}
          onApplied={(response, updatedChannels) => {
            if (onBatchApplied) onBatchApplied(response, updatedChannels);
            else if (updatedChannels) onChannels(updatedChannels);
            setBatchUndo({
              palettes: response.previous_palettes,
              expectedRevisions: response.new_revisions,
            });
            setUndoStatus(null);
          }}
        />
      )}
      {undoStatus && <p role="status" style={{ fontSize: "0.85rem", color: "var(--muted, #888)", margin: "4px 0" }}>{undoStatus}</p>}
  </div>;
}
