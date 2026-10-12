import { useEffect, useId, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import type { ViewerChannel } from "./ImageViewport";

const PHYSICAL_UNITS = new Set(["nm", "um", "µm", "μm", "mm", "m"]);
const GEOMETRY_PHYSICAL_UNITS = new Set(["nm", "um", "mm", "m"]);

function defaultChannelLabel(source: ResearchSource, channel: number): string {
  return source.metadata.channel_names?.[channel]?.trim() || `Channel ${channel + 1}`;
}

function hasValidPhysicalGeometry(source: ResearchSource): boolean {
  const geometry = source.metadata.geometry;
  if (!geometry) return false;
  const affine = geometry.affine;
  if (!GEOMETRY_PHYSICAL_UNITS.has(geometry.unit ?? "") ||
      !["YX", "ZYX"].includes(geometry.axes ?? "") ||
      !Array.isArray(affine) || affine.length !== 4 ||
      affine.some((row) => !Array.isArray(row) || row.length !== 4 ||
        row.some((value) => !Number.isFinite(value))) ||
      affine[3].some((value, index) => value !== (index === 3 ? 1 : 0))) return false;
  const determinant =
    affine[0][0] * (affine[1][1] * affine[2][2] - affine[1][2] * affine[2][1]) -
    affine[0][1] * (affine[1][0] * affine[2][2] - affine[1][2] * affine[2][0]) +
    affine[0][2] * (affine[1][0] * affine[2][1] - affine[1][1] * affine[2][0]);
  const spacingX = Math.hypot(affine[0][0], affine[1][0], affine[2][0]);
  return Number.isFinite(determinant) && Math.abs(determinant) >= 1e-15 &&
    Number.isFinite(spacingX) && spacingX > 0;
}

export function SourceExportPanel({ api, source, selection, channels, projection, onError,
  defaultDpi = 300 }: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection;
  channels: ViewerChannel[]; projection: "plane" | "max" | "mean"; onError: (message: string) => void;
  defaultDpi?: number;
}) {
  const [format, setFormat] = useState<"png" | "tiff">("png");
  const [scope, setScope] = useState<"overview" | "whole" | "region">("overview");
  const [dpiDraft, setDpiDraft] = useState(String(defaultDpi));
  const lastValidDpi = useRef(defaultDpi);
  const dpi = Number(dpiDraft);
  const dpiValid = Boolean(dpiDraft.trim()) && Number.isInteger(dpi) && dpi >= 72 && dpi <= 1200;
  const [scaleBar, setScaleBar] = useState(false);
  const [channelLegend, setChannelLegend] = useState(false);
  const [channelLabels, setChannelLabels] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false), [receipt, setReceipt] = useState("");
  const generation = useRef(0);
  const scaleReasonId = useId();
  useEffect(() => {
    generation.current++; setReceipt(""); setBusy(false); setScaleBar(false); setChannelLegend(false);
    setChannelLabels({});
  }, [source.id, source.sha256]);
  const calibration = source.metadata.physical_calibration;
  const hasPhysicalScale = source.metadata.sample_semantics !== "RGBA" &&
    (source.metadata.geometry ? hasValidPhysicalGeometry(source) : Boolean(
      calibration?.unit && PHYSICAL_UNITS.has(calibration.unit) &&
      calibration.spacing && calibration.spacing.length >= 2 &&
      calibration.spacing.every((value) => Number.isFinite(value) && value > 0)));
  const visibleChannels = channels.filter((entry) => entry.visible && (entry.opacity ?? 1) > 0);
  const canLegend = source.metadata.sample_semantics === "none" && visibleChannels.length > 0;
  const resolvedChannelLabel = (channel: number) =>
    channelLabels[channel] ?? defaultChannelLabel(source, channel);
  const tooLarge = format === "png" && scope === "region" &&
    (selection.width > 2048 || selection.height > 2048);
  const exportView = async () => {
    if (!api.exportSourceView || busy || tooLarge || !dpiValid) return;
    const token = generation.current; setBusy(true); setReceipt("");
    try {
      const { z_stop, ...plane } = selection;
      const dimensions = source.metadata.dimensions ?? { x: source.metadata.shape?.at(-1) ?? 1,
        y: source.metadata.shape?.at(-2) ?? 1 };
      const fullPlane = { ...plane, x: 0, y: 0, width: dimensions.x, height: dimensions.y, level: 0 };
      const view = format === "png" && scope === "overview" ?
        { source_id: source.id, overview: true, max_edge: 1024,
          t: selection.t, z: selection.z, c: selection.c, channels,
          ...(projection === "plane" ? {} : { projection, z_stop }),
          figure: {
            dpi, scale_bar: scaleBar, channel_legend: channelLegend,
            channel_labels: channelLegend ? visibleChannels.map((entry) => ({
              channel: entry.channel,
              name: resolvedChannelLabel(entry.channel),
              color: entry.color,
            })) : [],
          } } :
        { source_id: source.id,
          selection: projection === "plane" ? (scope === "whole" ? fullPlane : plane) :
            { ...(scope === "whole" ? fullPlane : selection), z_stop },
          channels, ...(projection === "plane" ? {} : { projection }),
          figure: {
            dpi, scale_bar: scaleBar, channel_legend: channelLegend,
            channel_labels: channelLegend ? visibleChannels.map((entry) => ({
              channel: entry.channel,
              name: resolvedChannelLabel(entry.channel),
              color: entry.color,
            })) : [],
          } };
      const result = await api.exportSourceView({
        source_id: source.id, source_sha256: source.sha256, format, view,
      });
      if (result && token === generation.current) setReceipt(`Saved ${result.width} × ${result.height} · ${result.basename}`);
    } catch (error) { if (token === generation.current) onError(error instanceof Error ? error.message : "Could not export this view."); }
    finally { if (token === generation.current) setBusy(false); }
  };
  return <details className="source-export research-panel"><summary>Export rendered image</summary>
    <label>Format<select aria-label="Rendered export format" value={format} onChange={(event) => {
      const next = event.target.value as "png" | "tiff"; setFormat(next);
      setScope(next === "png" ? "overview" : "whole"); setReceipt("");
    }}><option value="png">PNG · 8-bit display</option><option value="tiff">TIFF · 16-bit display</option></select></label>
    <label>Extent<select aria-label="Rendered export extent" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
      {format === "png" ? <option value="overview">Whole image · up to 1024 px</option> :
        <option value="whole">Whole selected plane · full resolution</option>}
      <option value="region">Analysis region · source pixels</option>
    </select></label>
    <label>Resolution (DPI)<input aria-label="Rendered export DPI" inputMode="numeric"
      aria-invalid={!dpiValid} value={dpiDraft} onChange={(event) => {
        const text = event.target.value, next = Number(text);
        setDpiDraft(text);
        if (text.trim() && Number.isInteger(next) && next >= 72 && next <= 1200) lastValidDpi.current = next;
      }} onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); setDpiDraft(String(lastValidDpi.current));
        }
      }} /></label>
    {!dpiValid && <p role="alert">Enter a whole number from 72 to 1200 DPI.</p>}
    <label><span><input aria-label="Include calibrated scale bar" type="checkbox" checked={scaleBar}
      disabled={!hasPhysicalScale} aria-describedby={!hasPhysicalScale ? scaleReasonId : undefined} onChange={(event) => setScaleBar(event.target.checked)} /> Include calibrated scale bar</span></label>
    {!hasPhysicalScale && <p id={scaleReasonId} className="research-derived-notice">
      {source.metadata.sample_semantics === "RGBA" ? "Scale bar unavailable for RGBA sources." :
        "Scale bar unavailable: no supported physical calibration."}
    </p>}
    <label><span><input aria-label="Include channel legend" type="checkbox" checked={channelLegend}
      disabled={!canLegend && !channelLegend}
      onChange={(event) => setChannelLegend(event.target.checked)} /> Include channel legend</span></label>
    {channelLegend && visibleChannels.map((entry) => <label key={entry.channel}>
      Channel {entry.channel + 1} label
      <input aria-label={`Channel ${entry.channel + 1} legend label`} maxLength={80}
        value={resolvedChannelLabel(entry.channel)}
        onChange={(event) => setChannelLabels((old) => ({ ...old, [entry.channel]: event.target.value }))} />
    </label>)}
    <p>{format === "png" ? "8-bit display RGB with rendering provenance." :
      "16-bit display RGB with rendering provenance."} Uses display settings; excludes raw values and annotations.</p>
    {tooLarge && <p className="research-derived-notice">Draw a region no larger than 2048 × 2048 pixels for a source-resolution PNG.</p>}
    <button type="button" disabled={busy || tooLarge || !channels.length || !api.exportSourceView ||
      !dpiValid ||
      (channelLegend && (!canLegend || visibleChannels.some((entry) =>
        !resolvedChannelLabel(entry.channel).trim())))}
      onClick={() => void exportView()}>{busy ? "Rendering…" : format === "png" ? "Export PNG…" : "Export TIFF16…"}</button>
    {receipt && <p role="status">{receipt}</p>}
  </details>;
}
