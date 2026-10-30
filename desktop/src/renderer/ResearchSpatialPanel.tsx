import { useEffect, useId, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { populationDisplayUnit } from "./PopulationChart";
import PopulationChartDialog from "./PopulationChartDialog";
import { resultTitle } from "./result-title";
import "./ResearchSpatialPanel.css";

export type SpatialRecord = {
  schema: "loci.spatial-distance-bands/v1";
  distance_unit: string; area_unit: string;
  inputs: Record<"objects" | "compartment" | "boundary", { result_id: string; revision_hash: string; labels_sha256: string }>;
  bands: Array<{ lower: number; upper: number; pixel_count: number; area: number; object_count: number; density: number | null }>;
};

export function spatialRecord(value: unknown): SpatialRecord {
  const record = value as SpatialRecord;
  if (!record || record.schema !== "loci.spatial-distance-bands/v1" ||
      !["um", "mm", "nm", "m"].includes(record.distance_unit) || record.area_unit !== `${record.distance_unit}^2` ||
      !Array.isArray(record.bands) || !record.bands.length || record.bands.length > 32)
    throw new Error("The saved spatial measurement contract is invalid.");
  for (const [index, band] of record.bands.entries()) {
    if (![band.lower, band.upper, band.area].every((v) => Number.isFinite(v) && v >= 0) ||
        band.upper <= band.lower || (index > 0 && band.lower !== record.bands[index - 1].upper) ||
        !Number.isSafeInteger(band.pixel_count) || band.pixel_count < 0 ||
        !Number.isSafeInteger(band.object_count) || band.object_count < 0 ||
        (band.area === 0 ? band.density !== null : !Number.isFinite(band.density) || band.density !== band.object_count / band.area))
      throw new Error("The saved spatial counts, areas or density are inconsistent.");
  }
  for (const role of ["objects", "compartment", "boundary"] as const) {
    const input = record.inputs?.[role];
    if (!input || !/^[a-f0-9]{32}$/.test(input.result_id) || !/^[a-f0-9]{64}$/.test(input.revision_hash) || !/^[a-f0-9]{64}$/.test(input.labels_sha256))
      throw new Error("The saved spatial input identities are invalid.");
  }
  return record;
}

const SPATIAL_VIEWS = {
  objects: { label: "Objects (including excluded)", array: "labels", basis: "Retained object labels, including excluded objects" },
  compartment: { label: "Tissue compartment", array: "compartment_labels", basis: "Declared analyzable tissue compartment" },
  boundary: { label: "Reference boundary", array: "boundary_labels", basis: "Declared boundary pixel centers" },
  bands: { label: "Distance bands", array: "distance_bands", basis: "Sampled compartment distance bands; zero outside supplied bands" },
} as const;
type SpatialViewField = keyof typeof SPATIAL_VIEWS;
type SpatialView = {
  result_id: string; revision_hash: string; axis: string; index: number;
  label_field: SpatialViewField; label_field_basis: string; shape: number[];
  geometry: ResearchResult["geometry"]; image: string; label_image: string;
};

function SpatialMaskInspection({ api, result }: { api: ResearchDesktopApi; result: ResearchResult }) {
  const viewerLane = `spatial-qc-${useId().replace(/[^a-z0-9_-]/giu, "").toLowerCase()}`;
  const [field, setField] = useState<SpatialViewField>("objects");
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; view?: SpatialView; error?: string } | null>(null);
  const key = `${result.id}:${result.revision_hash}:${field}:${attempt}`;
  const expectedShape = JSON.stringify(result.arrays?.[SPATIAL_VIEWS[field].array]?.shape);
  const expectedGeometry = JSON.stringify(result.geometry);
  useEffect(() => {
    let current = true;
    // Keep this inspection pane independent of the main result viewer. Each
    // response must still match the selected immutable revision and mask field.
    void api.execute("result_view", { result_id: result.id, axis: "z", index: 0, labels: true, label_field: field }, { viewer_lane: viewerLane }).then((value) => {
      const view = value as SpatialView;
      const geometry = JSON.parse(expectedGeometry ?? "null") as ResearchResult["geometry"];
      if (!view || view.result_id !== result.id || view.revision_hash !== result.revision_hash ||
          view.axis !== "z" || view.index !== 0 || view.label_field !== field || view.label_field_basis !== SPATIAL_VIEWS[field].basis ||
          !Array.isArray(view.shape) || view.shape.length !== 2 || view.shape.some((size) => !Number.isSafeInteger(size) || size <= 0) ||
          JSON.stringify(view.shape) !== expectedShape ||
          !view.geometry || view.geometry.axes !== "YX" || view.geometry.unit !== geometry?.unit ||
          view.geometry.frame !== geometry?.frame || JSON.stringify(view.geometry.affine) !== JSON.stringify(geometry?.affine) ||
          typeof view.image !== "string" || !view.image.startsWith("data:image/png;base64,") ||
          typeof view.label_image !== "string" || !view.label_image.startsWith("data:image/png;base64,"))
        throw new Error("The mask preview does not match this saved revision and label field.");
      if (current) setResponse({ key, view });
    }).catch((caught) => {
      if (current) setResponse({ key, error: caught instanceof Error ? caught.message : "Could not load the saved mask preview." });
    });
    return () => { current = false; };
  }, [api, key, result.id, result.revision_hash, field, viewerLane, expectedShape, expectedGeometry]);
  const current = response?.key === key ? response : null;
  const name = SPATIAL_VIEWS[field].label;
  const preview = current?.view ? <figure className="spatial-qc-image">
    <img src={current.view.image} alt={`${name} — saved spatial result`} onError={() => setResponse({ key, error: "Could not display the saved mask image. Retry the preview." })} />
    <figcaption>{current.view.label_field_basis}{field === "bands" && ". Band labels follow the table row order, starting at 1."}</figcaption>
  </figure> : current?.error ? <p role="alert">{current.error}</p> : <p role="status">Loading saved mask…</p>;
  return <section className="spatial-qc" aria-label="Inspect saved spatial masks">
    <label>Inspect saved masks<select aria-label="Spatial mask" value={field} onChange={(event) => {
      if (Object.hasOwn(SPATIAL_VIEWS, event.target.value)) setField(event.target.value as SpatialViewField);
    }}>
      {(Object.keys(SPATIAL_VIEWS) as SpatialViewField[]).map((value) => <option key={value} value={value}>{SPATIAL_VIEWS[value].label}</option>)}
    </select></label>
    {preview}
    {current?.error && <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry mask preview</button>}
    {current?.view && <button type="button" onClick={() => setExpanded(true)}>Enlarge mask inspection</button>}
    {expanded && <PopulationChartDialog title="Spatial mask inspection" closeLabel="Close spatial mask inspection" onClose={() => setExpanded(false)}>
      <p>{name}</p>{preview}
    </PopulationChartDialog>}
  </section>;
}

export function SpatialSummary({ value, api, result }: { value: unknown; api?: ResearchDesktopApi; result?: ResearchResult }) {
  try {
    const record = spatialRecord(value);
    const counted = record.bands.reduce((sum, band) => sum + band.object_count, 0);
    if (!Number.isSafeInteger(counted) || (result && (!Number.isSafeInteger(result.object_count) || result.object_count < counted)))
      throw new Error("The saved band counts exceed the retained object count or are invalid.");
    const distanceUnit = populationDisplayUnit(record.distance_unit);
    const areaUnit = populationDisplayUnit(record.area_unit).replace("^2", "²");
    return <section className="spatial-summary" aria-label="Saved tissue distance bands">
      <p className="spatial-counts"><strong>{counted} counted in bands</strong>{result && <> of {result.object_count} retained objects<br /><span>{result.object_count - counted} excluded from bands</span></>}</p>
      <p>Distances to the declared boundary pixels. Area covers the sampled compartment only.</p>
      <div className="research-result-table spatial-table" role="region" aria-label="Tissue distance table" tabIndex={0}>
        <table><thead><tr><th scope="col">Band <span>({distanceUnit})</span></th><th scope="col">Count</th><th scope="col">Area <span>({areaUnit})</span></th><th scope="col">Density <span>(objects/{areaUnit})</span></th></tr></thead>
          <tbody>{record.bands.map((band) => <tr key={band.lower}><th scope="row">[{band.lower}, {band.upper})</th><td>{band.object_count}</td><td>{band.area}</td><td title={band.density === null ? undefined : String(band.density)}>{band.density === null ? <span className="spatial-undefined">Undefined: no sampled area</span> : band.density.toPrecision(6)}</td></tr>)}</tbody>
        </table>
      </div>
      {api && result && <SpatialMaskInspection key={`${result.id}:${result.revision_hash}`} api={api} result={result} />}
      <p>Use Statistics to plot distance and select individual objects. Correct the input masks, then rerun to create a new version.</p>
    </section>;
  } catch (error) { return <p role="alert">{(error as Error).message}</p>; }
}

export function ResearchSpatialPanel({ api, snapshot, source, busy, active, workingBytes, onBusyChange, onPublished }: {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; source: ResearchSource; busy: boolean; active: boolean;
  workingBytes: number; onBusyChange: (value: boolean) => void; onPublished: (result: ResearchResult) => Promise<void>;
}) {
  const candidates = snapshot.results.filter((r) => r.source_id === source.id && r.arrays?.labels && r.geometry?.axes === "YX" && r.geometry.unit !== "pixel" && r.kind !== "spatial-distance-bands");
  const [objects, setObjects] = useState(""); const [compartment, setCompartment] = useState(""); const [boundary, setBoundary] = useState("");
  const [edges, setEdges] = useState(""); const [control, setControl] = useState(""); const [coverage, setCoverage] = useState("");
  const [exclude, setExclude] = useState(true); const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const submitting = useRef(false); const live = useRef(active); live.current = active;
  useEffect(() => () => { live.current = false; }, []);
  const selected = [objects, compartment, boundary].map((id) => candidates.find((r) => `${r.id}:${r.revision_hash}` === id));
  const parts = edges.split(",").map((s) => s.trim()); const values = parts.map(Number);
  const valid = parts.length >= 2 && parts.length <= 33 && parts.every(Boolean) && values.every((v, i) => Number.isFinite(v) && v >= 0 && v <= 1e12 && (i === 0 || v > values[i - 1]));
  const ready = selected.every(Boolean) && valid && control.trim() && coverage.trim();
  async function run() {
    if (!ready || submitting.current || busy) return;
    submitting.current = true; setPending(true); setError(""); onBusyChange(true);
    const [o, c, b] = selected as ResearchResult[];
    const bind = (r: ResearchResult) => ({ result_id: r.id, revision_hash: r.revision_hash });
    try {
      const response = await api.execute("spatial_distance_run", { ...bind(o), compartment: bind(c), boundary: bind(b), band_edges: values,
        exclude_crop_border: exclude, control: control.trim(), boundary_coverage: coverage.trim(), working_bytes: workingBytes }) as { result: ResearchResult; spatial: unknown };
      const record = spatialRecord(response.spatial);
      if (response.result?.source_id !== source.id || response.result.kind !== "spatial-distance-bands" ||
          [o, c, b].some((r, i) => { const input = record.inputs[(["objects", "compartment", "boundary"] as const)[i]]; return input.result_id !== r.id || input.revision_hash !== r.revision_hash; }))
        throw new Error("Spatial results did not match the selected input revisions.");
      if (live.current) await onPublished(response.result);
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Spatial measurements failed."); }
    finally { submitting.current = false; setPending(false); onBusyChange(false); }
  }
  return <section className="research-perinuclear" aria-label="Tissue distance measurement">
    <h2>Tissue distance bands</h2><p>Choose object labels, an analyzable tissue compartment and a reference boundary on the same calibrated plane.</p>
    {!candidates.length && <p>Import or create calibrated 2D masks before measuring tissue distances.</p>}
    {([ ["Objects", objects, setObjects], ["Compartment", compartment, setCompartment], ["Boundary", boundary, setBoundary] ] as const).map(([label, value, setter]) =>
      <label key={label}>{label}<select aria-label={`Spatial ${label.toLowerCase()}`} value={value} disabled={busy || pending} onChange={(e) => setter(e.target.value)}>
        <option value="">Choose a saved mask…</option>{candidates.map((r, index) => <option key={r.id} value={`${r.id}:${r.revision_hash}`}>{resultTitle(r)} · Run {index + 1} · {r.revision_hash.slice(0, 8)}</option>)}
      </select></label>)}
    <label>Band edges ({selected[0]?.geometry?.unit ?? "physical units"})<input aria-label="Spatial band edges" value={edges} disabled={busy || pending} placeholder="0, 100, 300" onChange={(e) => setEdges(e.target.value)} /></label>
    {edges && !valid && <p role="alert">Enter increasing, nonnegative numbers separated by commas.</p>}
    <label>Boundary definition and controls<textarea aria-label="Spatial controls" maxLength={2048} value={control} disabled={busy || pending} onChange={(e) => setControl(e.target.value)} /></label>
    <label>Boundary coverage and exclusions<textarea aria-label="Spatial boundary coverage" maxLength={2048} value={coverage} disabled={busy || pending} onChange={(e) => setCoverage(e.target.value)} /></label>
    <label className="research-check"><input type="checkbox" checked={exclude} disabled={busy || pending} onChange={(e) => setExclude(e.target.checked)} />Exclude objects touching the crop border</label>
    <p>Distances use boundary pixel centers and half-open bands. A cropped or incomplete boundary can change distances. This measurement does not infer epidermis or tissue thickness.</p>
    <button className="research-primary" disabled={!ready || busy || pending} onClick={() => void run()}>{pending ? "Measuring…" : "Measure tissue distances"}</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
