import { useEffect, useState } from "react";
import { PERINUCLEAR_VIEWS, type ResearchPerinuclearView, type ResearchPerinuclearViewField } from "../shared/perinuclear-contracts";
import type { ResearchDesktopApi, ResearchResult } from "../shared/research-contracts";
import PopulationChartDialog from "./PopulationChartDialog";

export function PerinuclearQC({ api, result }: { api: ResearchDesktopApi; result: ResearchResult }) {
  const [field, setField] = useState<ResearchPerinuclearViewField>("nuclei");
  const [expanded, setExpanded] = useState(false);
  const [response, setResponse] = useState<{ key: string; view?: ResearchPerinuclearView; error?: string } | null>(null);
  const key = `${result.id}:${result.revision_hash}:${field}`;
  useEffect(() => {
    let current = true;
    void api.execute("result_view", { result_id: result.id, axis: "z", index: 0, labels: true, label_field: field }).then((value) => {
      const view = value as ResearchPerinuclearView;
      if (!view || view.result_id !== result.id || view.revision_hash !== result.revision_hash ||
          view.axis !== "z" || view.index !== 0 || view.label_field !== field || view.label_field_basis !== PERINUCLEAR_VIEWS[field].basis ||
          !Array.isArray(view.shape) || view.shape.length !== 2 || view.shape.some((size, axis) => !Number.isSafeInteger(size) || size <= 0 || size !== result.arrays?.labels?.shape?.[axis]) ||
          !view.geometry || view.geometry.axes !== "YX" || view.geometry.unit !== result.geometry?.unit ||
          view.geometry.frame !== result.geometry?.frame || JSON.stringify(view.geometry.affine) !== JSON.stringify(result.geometry?.affine) ||
          typeof view.image !== "string" || !view.image.startsWith("data:image/png;base64,") ||
          typeof view.label_image !== "string" || !view.label_image.startsWith("data:image/png;base64,"))
        throw new Error("The perinuclear overlay does not match this saved revision and label field.");
      if (current) setResponse({ key, view });
    }).catch((caught) => {
      if (current) setResponse({ key, error: caught instanceof Error ? caught.message : "Could not show the saved perinuclear labels." });
    });
    return () => { current = false; };
  }, [api, key, result.id, result.revision_hash, field]);
  const current = response?.key === key ? response : null;
  const name = PERINUCLEAR_VIEWS[field].label;
  const image = current?.view ? <figure className="perinuclear-qc-image"><img src={current.view.image} alt={`${name} over the saved raw signal channel`} /><figcaption>{current.view.label_field_basis}</figcaption></figure> : null;
  return <section className="perinuclear-qc" aria-label="Inspect perinuclear labels">
    <label>Inspect saved labels<select aria-label="Perinuclear overlay" value={field} onChange={(event) => { if (Object.hasOwn(PERINUCLEAR_VIEWS, event.target.value)) setField(event.target.value as ResearchPerinuclearViewField); }}>
      {(Object.keys(PERINUCLEAR_VIEWS) as ResearchPerinuclearViewField[]).map((value) => <option key={value} value={value}>{PERINUCLEAR_VIEWS[value].label}</option>)}
    </select></label>
    {!current && <p role="status">Loading saved labels…</p>}
    {current?.error && <p role="alert">{current.error}</p>}
    {image}
    {image && <button type="button" onClick={() => setExpanded(true)}>Enlarge label inspection</button>}
    {expanded && <PopulationChartDialog title="Perinuclear label inspection" closeLabel="Close perinuclear label inspection" onClose={() => setExpanded(false)}>
      <p>{name}</p>{image ?? <p role="status">Loading saved labels…</p>}
    </PopulationChartDialog>}
  </section>;
}
