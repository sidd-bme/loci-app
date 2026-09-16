import { useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchSelection } from "../shared/research-contracts";

type Report = <T>(work: () => Promise<T>, fallback: string) => Promise<T | undefined>;
type Props = {
  api: ResearchDesktopApi;
  sourceId: string;
  selection: ResearchSelection;
  busy: boolean;
  report: Report;
  onBusyChange: (value: string | null) => void;
  onPreview: (image: string, measurements: Array<Record<string, unknown>>) => void;
  onResult: (result: ResearchResult, measurements: Array<Record<string, unknown>>) => Promise<void>;
};

export function ResearchHistologyPanel({ api, sourceId, selection, busy, report, onBusyChange, onPreview, onResult }: Props): React.JSX.Element {
  const [closing, setClosing] = useState("0");
  const [minimum, setMinimum] = useState("0");
  const [control, setControl] = useState("");
  const [summary, setSummary] = useState<{ key: string; count: number; fraction: number } | null>(null);
  const live = useRef("");
  const key = JSON.stringify({ sourceId, selection, closing, minimum, control });
  live.current = key;
  const current = summary?.key === key ? summary : null;
  const valid = /^\d+$/.test(closing) && Number(closing) <= 64 && /^\d+$/.test(minimum) && Number(minimum) <= 10_000_000 && control.trim().length > 0 && control.length <= 2000 && selection.z_stop === undefined;

  async function execute(preview: boolean): Promise<void> {
    if (!valid || busy) return;
    const captured = key;
    onBusyChange(preview ? "tissue mask preview" : "tissue mask run");
    try {
      await report(async () => {
        const response = await api.execute(preview ? "tissue_preview" : "tissue_run", {
          source_id: sourceId,
          selection,
          settings: { closing_radius_pixels: Number(closing), minimum_component_pixels: Number(minimum), control: control.trim() },
          working_bytes: 512 * 1024 ** 2,
        });
        if (live.current !== captured) return;
        if (!response || typeof response !== "object") throw new Error("Tissue masking returned no result.");
        const output = response as Record<string, unknown>;
        const measurements = Array.isArray(output.measurements) ? output.measurements as Array<Record<string, unknown>> : [];
        if (preview) {
          const mask = (output.provenance as { tissue_mask?: { initial_mask_fraction?: number } } | undefined)?.tissue_mask;
          if (output.adopted !== false || typeof output.image !== "string" || typeof output.region_count !== "number" || typeof mask?.initial_mask_fraction !== "number") throw new Error("Tissue preview returned incomplete source-bound measurements.");
          setSummary({ key: captured, count: output.region_count, fraction: mask.initial_mask_fraction });
          onPreview(output.image, measurements);
        } else {
          const result = output.result as ResearchResult | undefined;
          if (!result?.id || !result.revision_hash || result.source_id !== sourceId || result.kind !== "tissue-region-mask") throw new Error("Tissue masking returned an invalid immutable result.");
          await onResult(result, measurements);
        }
      }, "Tissue masking failed");
    } finally {
      onBusyChange(null);
    }
  }

  return <section className="research-panel" aria-label="Tissue regions">
    <h3>Tissue regions</h3>
    <p>Preview dark regions using an Otsu threshold on source RGB luminance. Connected regions describe the selected field; they are not cell counts or a validated tissue classifier.</p>
    <label>Mask closing radius (selected-level pixels)<input aria-label="Tissue closing radius" type="number" min="0" max="64" step="1" value={closing} onChange={(event) => setClosing(event.target.value)} /></label>
    <label>Minimum connected region (pixels)<input aria-label="Tissue minimum region" type="number" min="0" max="10000000" step="1" value={minimum} onChange={(event) => setMinimum(event.target.value)} /></label>
    <label>Control or visual-review criterion<textarea aria-label="Tissue control or review criterion" maxLength={2000} value={control} onChange={(event) => setControl(event.target.value)} placeholder="Describe the blank area, control section, or review criterion." /></label>
    {selection.z_stop !== undefined && <p role="status">Select one RGB plane before tissue masking.</p>}
    <div className="research-actions">
      <button disabled={busy || !valid} onClick={() => void execute(true)}>Preview tissue mask</button>
      <button className="research-primary" disabled={busy || !valid || !current} onClick={() => void execute(false)}>Adopt tissue mask</button>
    </div>
    {current && <p role="status">{current.count} connected regions · {(100 * current.fraction).toFixed(2)}% of this selected field. Adoption saves a new editable result for correction, ROI analysis, review and export.</p>}
  </section>;
}
