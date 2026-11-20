import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { ImageConversionReceipt, ImageFormat } from "../shared/image-conversion";
import type { ResearchSource } from "../shared/research-contracts";
import { ResearchVendorPanel } from "./ResearchVendorPanel";
import "./ImageConversionPanel.css";

type Props = ComponentProps<typeof ResearchVendorPanel> & { source: ResearchSource | null };

export function ImageConversionPanel({ source, ...props }: Props) {
  const [mode, setMode] = useState<"study" | "vendor">(source ? "study" : "vendor");
  return <div className="image-conversion">
    <div className="image-conversion__modes" role="group" aria-label="Conversion input">
      <button type="button" aria-pressed={mode === "study"} disabled={props.busy}
        onClick={() => setMode("study")}>Study image</button>
      <button type="button" aria-pressed={mode === "vendor"} disabled={props.busy}
        onClick={() => setMode("vendor")}>Vendor file</button>
    </div>
    {mode === "study" ? <StudyConversion key={source ? source.id + source.sha256 : "empty"}
      source={source} {...props} /> : <ResearchVendorPanel {...props} />}
  </div>;
}

function StudyConversion({ source, api, busy, onBusyChange, report }: Props) {
  const [format, setFormat] = useState<ImageFormat>("ome-tiff");
  const [receipt, setReceipt] = useState<ImageConversionReceipt | null>(null);
  const [running, setRunning] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dims = source?.metadata.dimensions;
  const supported = source && !source.locator_state && source.source_kind !== "medical" &&
    source.source_kind !== "whole_slide" && source.metadata.sample_semantics === "none" &&
    !source.metadata.palette && dims && (dims.s ?? 1) === 1;
  const shape = dims && [dims.t, dims.c, dims.z, dims.y, dims.x];
  const types = [...new Set(source?.metadata.channel_dtypes ?? [])];
  const dtype = types.length === 1 ? types[0] : null;
  const canRepresent = !!dtype && (format === "ome-zarr" || /^(u?int(8|16|32)|float(32|64))$/.test(dtype));
  const convert = async () => {
    if (!api.convertStudyImage || !supported || !canRepresent || running || busy) return;
    setRunning(true);
    setReceipt(null);
    onBusyChange(true);
    try {
      const result = await report(() => api.convertStudyImage!({
        source_id: source.id, source_sha256: source.sha256, format,
      }), "Could not convert this study image.");
      if (mounted.current && result) setReceipt(result);
    } finally {
      if (mounted.current) setRunning(false);
      onBusyChange(false);
    }
  };
  return <section className="research-panel image-conversion__study">
    <h2>Convert image format</h2>
    {!source ? <p>Select an image in the study, or choose a vendor file.</p> : !supported ?
      <p>This conversion needs a linked scalar image. RGB, palettes, whole slides and medical series have separate export workflows.</p> :
      <>
        <p className="image-conversion__source">{source.name}</p>
        <dl className="image-conversion__dimensions">
          {shape?.map((n, i) => <div key={i}><dt>{["T", "C", "Z", "Y", "X"][i]}</dt><dd>{n}</dd></div>)}
        </dl>
        <p>Full resolution · {dtype ?? "Mixed channel types"} · All channels, planes and time points</p>
        <label>Output format<select value={format} disabled={busy || running}
          onChange={e => { setReceipt(null); setFormat(e.target.value as ImageFormat); }}>
          <option value="ome-tiff">OME-TIFF</option><option value="ome-zarr">OME-Zarr</option>
        </select></label>
        <p>{format === "ome-tiff" ? "One tiled image for tools such as Fiji. Large images use BigTIFF." :
          "A chunked local store for region reads. Uses OME-NGFF 0.4 and Zarr v2."}</p>
        <details><summary>What the copy includes</summary>
          <p>Native pixel values and channel labels at the original grid spacing. The conversion receipt records recognized timing, stage positions and grid transforms. Display edits, study results, lower-resolution levels and proprietary metadata stay with the original.</p>
        </details>
        {!canRepresent && <p role="status">This format cannot preserve the channel types in one image.</p>}
        <button className="research-primary" disabled={!api.convertStudyImage || busy || running || !canRepresent}
          onClick={() => void convert()}>{running ? "Converting and verifying…" : "Convert image…"}</button>
        {receipt && <div role="status" className="image-conversion__receipt"><strong>Conversion verified</strong>
          <p>{receipt.artifact} and conversion.json were saved in the folder you chose.</p></div>}
      </>}
  </section>;
}
