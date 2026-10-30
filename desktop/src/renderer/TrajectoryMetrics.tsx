import { useEffect, useState } from "react";
import type { ResearchDesktopApi, ResearchResult } from "../shared/research-contracts";
import type { TrackingGraph } from "./ResearchTemporalPanel";
import { sanitizeRendererError } from "./ContextHelp";
import "./TrajectoryMetrics.css";

type Summary = {
  schema: "loci.trajectory-summary/v1"; metrics_schema: "loci.trajectory-metrics/v1"; graph_sha256: string;
  units: { position: string; time: "s"; velocity: string; directionality: "dimensionless" };
  track_count: number; interval_count: number; observation_count: number;
  storage: "persisted" | "derived-from-legacy-graph"; rules: Record<string, string>; numerical_policy: string;
};
type Track = {
  track_key: string; start_frame_id: string; start_label: string; end_frame_id: string; end_label: string;
  observation_count: number; interval_count: number; elapsed_s: number; observed_path_length: number;
  net_displacement: number; net_displacement_xyz: number[]; mean_velocity_xyz: number[] | null;
  mean_speed: number | null; directionality_ratio: number | null; directionality_status: string;
  gap_frames: number; uncertain_edge_count: number; hypothesis_indices: number[];
};
type Interval = {
  track_key: string; source_frame_id: string; source_label: string; target_frame_id: string; target_label: string;
  elapsed_s: number; displacement_xyz: number[]; velocity_xyz: number[]; speed: number; chord_length: number;
  gap_frames: number; identity_uncertain: boolean; association_provenance: string;
};
type Page = { rows: Array<Track | Interval>; total: number; next_offset: number | null };
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const vector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(finite);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const positive = (v: unknown): v is number => finite(v) && v >= 0;
const format = (v: number | null) => v === null ? "—" : Number(v.toPrecision(6)).toString();
const xyz = (v: number[] | null) => v === null ? "—" : v.map(format).join(", ");

function checkSummary(value: unknown): Summary {
  const v = value as Summary | null;
  if (!v || v.schema !== "loci.trajectory-summary/v1" || v.metrics_schema !== "loci.trajectory-metrics/v1" ||
      !/^[a-f0-9]{64}$/u.test(v.graph_sha256) || !["pixel", "nm", "um", "mm", "m"].includes(v.units?.position) ||
      v.units.time !== "s" || v.units.velocity !== `${v.units.position}/s` || v.units.directionality !== "dimensionless" ||
      ![v.track_count, v.interval_count, v.observation_count].every(integer) || v.observation_count > 100_000 ||
      v.track_count + v.interval_count !== v.observation_count ||
      !["persisted", "derived-from-legacy-graph"].includes(v.storage) || !text(v.numerical_policy) ||
      !v.rules || Array.isArray(v.rules) || !Object.values(v.rules).every(text))
    throw new Error("Trajectory measurements have an inconsistent graph identity. Inspect the saved graph again.");
  return v;
}
function summaryKey(v: Summary) {
  return JSON.stringify([v.graph_sha256, v.units, v.track_count, v.interval_count, v.observation_count,
    v.storage, Object.entries(v.rules).sort(), v.numerical_policy]);
}
function checkPage(value: unknown, result: ResearchResult, summary: Summary, table: string, offset: number): Page {
  const v = value as Page & { schema: string; result_id: string; revision_hash: string; summary: unknown; table: string; offset: number; limit: number };
  if (!v || v.schema !== "loci.trajectory-page/v1" || v.result_id !== result.id || v.revision_hash !== result.revision_hash ||
      v.table !== table || v.offset !== offset || v.limit !== 12 || summaryKey(checkSummary(v.summary)) !== summaryKey(summary) ||
      v.total !== (table === "tracks" ? summary.track_count : summary.interval_count) || !Array.isArray(v.rows) || v.rows.length > 12 ||
      v.rows.length > Math.max(0, v.total - offset) ||
      (offset < v.total && v.rows.length === 0) ||
      v.next_offset !== (offset + v.rows.length < v.total ? offset + v.rows.length : null))
    throw new Error("Trajectory page does not match the exact saved graph. Inspect the graph again.");
  const keys = new Set<string>();
  for (const raw of v.rows) {
    let key: string;
    if (table === "tracks") {
      const row = raw as Track;
      key = row.track_key;
      if (![row.start_frame_id, row.start_label, row.end_frame_id, row.end_label].every(text) ||
          row.track_key !== JSON.stringify([row.start_frame_id, row.start_label]) ||
          ![row.observation_count, row.interval_count, row.gap_frames, row.uncertain_edge_count].every(integer) ||
          row.observation_count !== row.interval_count + 1 || ![row.elapsed_s, row.observed_path_length, row.net_displacement].every(positive) ||
          !vector(row.net_displacement_xyz) || (row.mean_velocity_xyz !== null && !vector(row.mean_velocity_xyz)) ||
          (row.mean_speed !== null && !positive(row.mean_speed)) ||
          (row.directionality_ratio !== null && (!positive(row.directionality_ratio) || row.directionality_ratio > 1)) ||
          !["defined", "stationary", "single-observation"].includes(row.directionality_status) ||
          (row.directionality_status === "defined") !== (row.directionality_ratio !== null) ||
          !Array.isArray(row.hypothesis_indices) || !row.hypothesis_indices.every(integer))
        throw new Error("A saved track contains invalid measurements. Reload its exact graph.");
    } else {
      const row = raw as Interval;
      key = JSON.stringify([row.source_frame_id, row.source_label, row.target_frame_id, row.target_label]);
      if (![row.track_key, row.source_frame_id, row.source_label, row.target_frame_id, row.target_label].every(text) ||
          !finite(row.elapsed_s) || row.elapsed_s <= 0 || !vector(row.displacement_xyz) || !vector(row.velocity_xyz) ||
          !positive(row.speed) || !positive(row.chord_length) || !integer(row.gap_frames) ||
          typeof row.identity_uncertain !== "boolean" || !["automatic", "manual"].includes(row.association_provenance))
        throw new Error("A saved interval contains invalid measurements. Reload its exact graph.");
    }
    if (keys.has(key)) throw new Error("Trajectory page repeats an observation identity.");
    keys.add(key);
  }
  return v;
}

export function TrajectoryMetrics(props: {
  api: ResearchDesktopApi; result: ResearchResult; summary: unknown; graph: TrackingGraph;
  busy: boolean; onOpenFrame: (frameId: string) => void;
}) {
  try {
    const summary = checkSummary(props.summary);
    return <TrajectoryPages key={`${props.result.id}:${props.result.revision_hash}:${summary.graph_sha256}`} {...props} summary={summary} />;
  } catch (e) { return <p role="alert">{sanitizeRendererError(e instanceof Error ? e.message : "Invalid trajectory measurements.")}</p>; }
}

function TrajectoryPages({ api, result, summary, graph, busy, onOpenFrame }: {
  api: ResearchDesktopApi; result: ResearchResult; summary: Summary; graph: TrackingGraph; busy: boolean; onOpenFrame: (frameId: string) => void;
}) {
  const [table, setTable] = useState<"tracks" | "intervals">("tracks");
  const [offsets, setOffsets] = useState([0]); const offset = offsets[offsets.length - 1];
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; page?: Page; error?: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const key = `${table}:${offset}:${retry}:${summaryKey(summary)}`;
  useEffect(() => {
    let live = true;
    void api.execute("tracking_result", { result_id: result.id, revision_hash: result.revision_hash, table, offset, limit: 12 })
      .then((value) => { const page = checkPage(value, result, summary, table, offset); if (live) setResponse({ key, page }); })
      .catch((e) => { if (live) setResponse({ key, error: sanitizeRendererError(e instanceof Error ? e.message : "Could not read trajectory measurements.") }); });
    return () => { live = false; };
  }, [api, result.id, result.revision_hash, key, table, offset]); // key binds the complete summary.
  const state = response?.key === key ? response : null;
  const page = state?.page;
  const trajectory = selected ? graph.trajectories.find((points) => points.length && JSON.stringify([points[0].frame_id, points[0].label]) === selected) : null;
  return <section className="trajectory-metrics" aria-label="Trajectory measurements">
    <h3>Migration measurements</h3>
    <p>{summary.track_count} tracks · {summary.interval_count} observed intervals · {summary.observation_count} observations</p>
    <p>Directionality is net displacement divided by observed path length. Mean speed uses elapsed time. Gaps are not interpolated; unresolved identities remain flagged.</p>
    {summary.units.position === "pixel" && <p role="note">Uncalibrated positions: distances use pixels and velocities use pixels per second.</p>}
    {summary.storage === "derived-from-legacy-graph" && <p>Calculated from the retained graph. The original saved result remains unchanged.</p>}
    <label>Measurement table<select aria-label="Trajectory measurement table" value={table} disabled={busy} onChange={(e) => { setTable(e.target.value as typeof table); setOffsets([0]); setSelected(null); }}>
      <option value="tracks">Track summaries</option><option value="intervals">Velocity between observations</option>
    </select></label>
    {!state && <p role="status">Loading exact trajectory measurements…</p>}
    {state?.error && <div role="alert">{state.error} <button disabled={busy} onClick={() => setRetry((v) => v + 1)}>Retry measurement page</button></div>}
    {page && <>
      <div className="trajectory-table-scroll" tabIndex={0} role="region" aria-label="Trajectory measurement rows">
        <table className="research-result-table"><thead><tr>{table === "tracks" ? <>
          <th>Track</th><th>Path ({summary.units.position})</th><th>Mean speed ({summary.units.velocity})</th><th>Directionality</th><th>Review flags</th>
        </> : <><th>Interval</th><th>Elapsed (s)</th><th>XYZ velocity ({summary.units.velocity})</th><th>Speed ({summary.units.velocity})</th><th>Review flags</th></>}</tr></thead><tbody>
          {page.rows.map((raw, index) => table === "tracks" ? (() => { const row = raw as Track; return <tr key={row.track_key}>
            <td><button disabled={busy} aria-pressed={selected === row.track_key} onClick={() => setSelected(row.track_key)}>Track {offset + index + 1}</button><small>{row.observation_count} observations</small></td>
            <td title={String(row.observed_path_length)}>{format(row.observed_path_length)}</td><td title={String(row.mean_speed)}>{format(row.mean_speed)}</td>
            <td>{row.directionality_ratio === null ? row.directionality_status.replaceAll("-", " ") : format(row.directionality_ratio)}</td>
            <td>{row.gap_frames} missing frames; {row.uncertain_edge_count} uncertain links; {row.hypothesis_indices.length} hypotheses</td>
          </tr>; })() : (() => { const row = raw as Interval; return <tr key={JSON.stringify([row.source_frame_id, row.source_label, row.target_frame_id, row.target_label])}>
            <td><button disabled={busy} onClick={() => onOpenFrame(row.target_frame_id)}>Open destination frame</button><small>Objects {row.source_label} → {row.target_label}</small></td>
            <td>{format(row.elapsed_s)}</td><td title={row.velocity_xyz.join(", ")}>{xyz(row.velocity_xyz)}</td><td>{format(row.speed)}</td>
            <td>{row.gap_frames} missing frames; {row.identity_uncertain ? "uncertain" : "no identity flag"}; {row.association_provenance}</td>
          </tr>; })())}
        </tbody></table>
      </div>
      {!page.total && <p>No observed {table} in this graph.</p>}
      <nav className="trajectory-pages" aria-label="Trajectory measurement pages">
        <button disabled={busy || offsets.length === 1} onClick={() => setOffsets((old) => old.slice(0, -1))}>Previous measurements</button>
        <span>{page.total ? `${offset + 1}–${offset + page.rows.length} of ${page.total}` : "0 rows"}</span>
        <button disabled={busy || page.next_offset === null} onClick={() => { if (page.next_offset !== null) setOffsets((old) => [...old, page.next_offset!]); }}>Next measurements</button>
      </nav>
    </>}
    {trajectory && trajectory.length <= 1000 && <TrajectoryPlot points={trajectory} unit={summary.units.position} busy={busy} onOpenFrame={onOpenFrame} />}
    <details><summary>Migration definitions</summary><dl>{Object.entries(summary.rules).map(([name, rule]) => <div key={name}><dt>{name.replaceAll("_", " ")}</dt><dd>{rule}</dd></div>)}</dl><p>{summary.numerical_policy}</p></details>
  </section>;
}

function TrajectoryPlot({ points, unit, busy, onOpenFrame }: { points: TrackingGraph["trajectories"][number]; unit: string; busy: boolean; onOpenFrame: (id: string) => void }) {
  if (!points.length || points.some((point) => !vector(point.centroid_world_xyz) || !finite(point.time_s))) return <p role="alert">The retained trajectory has invalid coordinates.</p>;
  const xs = points.map((p) => p.centroid_world_xyz[0]), ys = points.map((p) => p.centroid_world_xyz[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const scale = Math.min(300 / (x1 - x0 || 1), 180 / (y1 - y0 || 1));
  const xy = points.map((p) => [190 + (p.centroid_world_xyz[0] - (x0 + (x1 - x0) / 2)) * scale, 115 - (p.centroid_world_xyz[1] - (y0 + (y1 - y0) / 2)) * scale]);
  return <figure className="trajectory-plot"><figcaption>Selected track · world XY projection ({unit}), equal axis scale. Dashed segments span missing frames. Select an observation to open its source frame.</figcaption>
    <svg viewBox="0 0 380 230" role="group" aria-label="Selected trajectory in world XY coordinates">
      {xy.slice(1).map((p, index) => <line key={index} x1={xy[index][0]} y1={xy[index][1]} x2={p[0]} y2={p[1]} strokeDasharray={points[index + 1].gap_before ? "5 4" : undefined} />)}
      {xy.map((p, index) => <g key={index} className="trajectory-point" role="button" tabIndex={busy ? -1 : 0} aria-disabled={busy}
        aria-label={`Open frame at ${points[index].time_s} seconds, object ${points[index].label}`}
        onClick={() => { if (!busy) onOpenFrame(points[index].frame_id); }} onKeyDown={(e) => { if (!busy && ["Enter", " "].includes(e.key)) { e.preventDefault(); onOpenFrame(points[index].frame_id); } }}>
        <circle className="trajectory-hit" cx={p[0]} cy={p[1]} r={10} /><circle cx={p[0]} cy={p[1]} r={3} />
        <title>{`${points[index].time_s} s; XYZ ${points[index].centroid_world_xyz.join(", ")} ${unit}`}</title>
      </g>)}
      <text x="8" y="220">X {format(x0)} to {format(x1)} · Y {format(y0)} to {format(y1)}</text>
    </svg>
  </figure>;
}
