import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { resultTitle } from "./result-title";

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

export function SpatialSummary({ value }: { value: unknown }) {
  try {
    const record = spatialRecord(value);
    return <section aria-label="Saved tissue distance bands">
      <p>Distances to the declared boundary pixels. Area covers the sampled compartment only.</p>
      <div className="research-result-table" role="region" aria-label="Tissue distance table" tabIndex={0}>
        <table><thead><tr><th>Band ({record.distance_unit})</th><th>Objects</th><th>Area ({record.area_unit})</th><th>Objects / {record.area_unit}</th></tr></thead>
          <tbody>{record.bands.map((band) => <tr key={band.lower}><th scope="row">[{band.lower}, {band.upper})</th><td>{band.object_count}</td><td>{band.area}</td><td>{band.density === null ? "Undefined: no sampled area" : band.density.toPrecision(6)}</td></tr>)}</tbody>
        </table>
      </div><p>Use Statistics to plot distance and select individual objects. Correct the input masks, then rerun to create a new version.</p>
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
