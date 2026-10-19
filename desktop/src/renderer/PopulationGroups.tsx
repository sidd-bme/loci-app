import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchResult } from "../shared/research-contracts";
import PopulationChart, { populationMetricName } from "./PopulationChart";
import type { PopulationResponse } from "./ResearchPopulationExplorer";
import { fullChartView, type ChartView } from "./population-chart-view";
import "./PopulationGroups.css";

export type PopulationHighlight = { result_id: string; revision_hash: string; source_id: string; source_sha256: string; labels: number[]; centroids: Array<{ label: number; centroid_index: number[]; index_axes: string }> };
type Membership = PopulationHighlight & { schema: string; total_count: number; included_count: number; membership_sha256: string; accounting: { excluded_missing_or_nonfinite_count: number; excluded_nonpositive_log_count: number; excluded_outside_count: number }; gate?: Gate };
type Gate = { kind: "rectangle" | "polygon"; x_metric: string; y_metric: string; x_transform: "linear" | "log10"; y_transform: "linear" | "log10"; bounds?: number[]; vertices?: Array<[number, number]> };
type GroupSummary = { id: string; name: string; definition_kind: string; result_id: string; revision_hash: string; source_id: string; source_sha256: string; included_count: number; source_available?: boolean };
export function checkedMembership(value: unknown, result: ResearchResult): Membership {
  const receipt = value as Membership;
  if (!receipt || receipt.result_id !== result.id || receipt.revision_hash !== result.revision_hash || receipt.source_id !== result.source_id || receipt.source_sha256 !== result.source_sha256 ||
    !Number.isSafeInteger(receipt.total_count) || receipt.total_count < 0 || receipt.total_count > 100000 || !Number.isSafeInteger(receipt.included_count) || receipt.included_count < 0 ||
    receipt.included_count > receipt.total_count || !Array.isArray(receipt.labels) || receipt.labels.length !== receipt.included_count ||
    receipt.labels.some((label, index) => !Number.isSafeInteger(label) || label < 1 || label > 0xffffffff || index > 0 && label <= receipt.labels[index - 1]) ||
    !/^[a-f0-9]{64}$/.test(receipt.membership_sha256) || !Array.isArray(receipt.centroids) || receipt.centroids.length !== receipt.labels.length ||
    receipt.centroids.some((row, index) => row.label !== receipt.labels[index] || !["YX", "ZYX"].includes(row.index_axes) || row.centroid_index.length !== row.index_axes.length || row.centroid_index.some((coordinate) => !Number.isFinite(coordinate))))
    throw new Error("Group membership does not match the exact result revision. Reevaluate the gate.");
  return receipt;
}
function parsePoints(text: string): Array<[number, number]> {
  if (!text.trim()) return [];
  const lines = text.trim().split(/\n/);
  if (lines.length > 64) throw new Error("Use at most 64 polygon vertices.");
  return lines.map((line) => {
    const pair = line.trim().split(/[\s,]+/);
    if (pair.length !== 2 || pair.some((value) => !value.trim() || !Number.isFinite(Number(value)))) throw new Error("Enter one finite X, Y pair per line.");
    return [Number(pair[0]), Number(pair[1])];
  });
}
const textPoints = (points: Array<[number, number]>) => points.map((point) => point.join(", ")).join("\n");
export function PopulationGroups({ api, result, data, disabled, selectedLabel, onSelect, onBinChoose, onHighlight, onEnlarge, view, onViewChange }: {
  api: ResearchDesktopApi; result: ResearchResult; data: PopulationResponse; disabled: boolean; selectedLabel: number | null;
  view: ChartView; onViewChange: (view: ChartView) => void;
  onEnlarge?: () => void;
  onSelect: (label: number) => void; onBinChoose: (bin: number) => void; onHighlight?: (membership: PopulationHighlight | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<"inspect" | "rectangle" | "polygon">("inspect");
  const [transforms, setTransforms] = useState<{ x: "linear" | "log10"; y: "linear" | "log10" }>({ x: "linear", y: "linear" });
  const [bounds, setBounds] = useState(["", "", "", ""]), [polygon, setPolygon] = useState("");
  const [logView, setLogView] = useState<ChartView>(fullChartView);
  const logAxes = transforms.x !== "linear" || transforms.y !== "linear";
  const setView = (next: ChartView) => { if (logAxes) setLogView(next); else onViewChange(next); };
  const [evaluated, setEvaluated] = useState<Membership | null>(null), [groups, setGroups] = useState<GroupSummary[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]), [name, setName] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [record, setRecord] = useState<unknown>(null);
  const generation = useRef(0), mounted = useRef(true);
  const scope = JSON.stringify([result.id, result.revision_hash, result.source_id, result.source_sha256, data.query.x_metric, data.query.y_metric, tool, transforms, bounds, polygon]);
  const liveScope = useRef(scope); if (liveScope.current !== scope) { liveScope.current = scope; generation.current++; }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const highlightRef = useRef(onHighlight); highlightRef.current = onHighlight;
  useEffect(() => { setEvaluated(null); highlightRef.current?.(null); }, [scope]);
  useEffect(() => { setBounds(["", "", "", ""]); setPolygon(""); setTool("inspect"); setTransforms({ x: "linear", y: "linear" }); }, [data.query.x_metric, data.query.y_metric]);
  useEffect(() => { setSelectedGroups([]); setName(""); setRecord(null); }, [result.id, result.revision_hash, result.source_id, result.source_sha256]);
  const refresh = async () => {
    const output = await api.execute("population_group_list", {}) as { groups: GroupSummary[] };
    if (!Array.isArray(output.groups) || output.groups.some((group) => typeof group.id !== "string" || typeof group.name !== "string")) throw new Error("Could not read saved groups. Reopen this panel to retry.");
    if (mounted.current) setGroups(output.groups);
  };
  useEffect(() => { if (open) void refresh().catch((caught) => { if (mounted.current) setError(String(caught.message ?? caught)); }); }, [api, open]);
  const getGate = (): Gate => {
    if (!data.query.x_metric || !data.query.y_metric || tool === "inspect") throw new Error("Choose a rectangle or polygon gate first.");
    const gate: Gate = { kind: tool, x_metric: data.query.x_metric, y_metric: data.query.y_metric, x_transform: transforms.x, y_transform: transforms.y };
    if (tool === "rectangle") {
      if (bounds.some((value) => !value.trim() || !Number.isFinite(Number(value)))) throw new Error("Enter four finite rectangle bounds or drag a rectangle.");
      gate.bounds = bounds.map(Number);
      if (gate.bounds[0] > gate.bounds[1] || gate.bounds[2] > gate.bounds[3]) throw new Error("Minimum bounds must not exceed maxima.");
    } else { gate.vertices = parsePoints(polygon); if (gate.vertices.length < 3) throw new Error("Use at least three polygon vertices."); }
    return gate;
  };
  const operate = async (work: (current: () => boolean) => Promise<void>) => {
    if (pending || disabled) return;
    const token = ++generation.current, captured = scope; setPending(true); setError("");
    const current = () => mounted.current && token === generation.current && captured === liveScope.current;
    try { await work(current); } catch (caught) { if (current()) setError(caught instanceof Error ? caught.message : "Group operation failed. Retry the gate."); }
    finally { if (mounted.current) setPending(false); }
  };
  const binding = { result_id: result.id, revision_hash: result.revision_hash };
  const show = (membership: unknown) => { const checked = checkedMembership(membership, result); setEvaluated(checked); highlightRef.current?.(checked); return checked; };
  const evaluate = () => operate(async (current) => { const value = await api.execute("population_gate_evaluate", { ...binding, gate: getGate(), include_centroids: true }); if (current()) { show(value); setRecord(value); } });
  const load = (groupId: string) => operate(async (current) => {
    const value = await api.execute("population_group_get", { ...binding, group_id: groupId, include_centroids: true }) as { group: unknown; membership: unknown };
    if (current()) { show(value.membership); setRecord(value.group); }
  });
  const save = () => operate(async (current) => {
    if (!evaluated || !name.trim()) throw new Error("Evaluate a gate and enter a group name before saving.");
    const value = await api.execute("population_group_save", { ...binding, name: name.trim(), gate: getGate(), membership_sha256: evaluated.membership_sha256 });
    if (current()) { setRecord(value); await refresh(); }
  });
  const apply = (group: GroupSummary) => operate(async (current) => {
    if (!name.trim()) throw new Error("Enter a name for the newly evaluated group.");
    const value = await api.execute("population_gate_apply", { ...binding, group_id: group.id, name: name.trim() });
    if (current()) { setRecord(value); await refresh(); }
  });
  const combine = (mode: "union" | "intersection" | "unclassified") => operate(async (current) => {
    if (!name.trim()) throw new Error("Enter a name for this fixed combined group.");
    const value = await api.execute("population_group_combine", { ...binding, group_ids: selectedGroups, name: name.trim(), mode });
    if (current()) { setRecord(value); await refresh(); }
  });
  const xMetric = data.metrics.find((metric) => metric.id === data.query.x_metric), yMetric = data.metrics.find((metric) => metric.id === data.query.y_metric);
  const transformed = (value: number, axis: "x" | "y") => transforms[axis] === "log10" ? value > 0 ? Math.log10(value) : NaN : value;
  const points = data.scatter.points.map((point) => ({ ...point, x: transformed(point.x, "x"), y: transformed(point.y, "y") })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const domain = (axis: "x" | "y"): [number, number] => {
    const summary = data.summaries[axis];
    if (transforms[axis] === "linear") return [summary.min ?? 0, summary.max ?? 0];
    const values = points.map((point) => point[axis]);
    return [summary.min !== null && summary.min > 0 ? Math.log10(summary.min) : Math.min(...values, Infinity) === Infinity ? 0 : Math.min(...values), summary.max !== null && summary.max > 0 ? Math.log10(summary.max) : 0];
  };
  const dx = domain("x"), dy = domain("y");
  const chartData: PopulationResponse = { ...data, scatter: { ...data.scatter, points }, summaries: { x: { ...data.summaries.x, min: dx[0], max: dx[1] }, y: { ...data.summaries.y, min: dy[0], max: dy[1] } } };
  let vertices: Array<[number, number]> = [];
  try { vertices = tool === "polygon" ? parsePoints(polygon) : bounds.every((value) => value.trim() && Number.isFinite(Number(value))) ? [[Number(bounds[0]), Number(bounds[2])], [Number(bounds[1]), Number(bounds[3])]] : []; } catch { /* Numeric draft stays visible until explicitly evaluated. */ }
  const download = () => operate(async (current) => {
    const id = (record as { id?: string } | null)?.id;
    const output = await api.execute(id ? "population_group_export" : "population_gate_export", id
      ? { ...binding, group_id: id } : { ...binding, gate: getGate(), membership_sha256: evaluated?.membership_sha256 }) as { json: string };
    if (typeof output.json !== "string") throw new Error("The exact export record is missing. Retry the export.");
    const parsed = JSON.parse(output.json), receipt = id ? parsed.data?.receipt : parsed;
    if (receipt?.result_id !== result.id || receipt.revision_hash !== result.revision_hash || receipt.source_id !== result.source_id || receipt.source_sha256 !== result.source_sha256 || (id ? parsed.id !== id : receipt.membership_sha256 !== evaluated?.membership_sha256))
      throw new Error("The export record belongs to another result revision.");
    if (!current()) return;
    const url = URL.createObjectURL(new Blob([output.json], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "loci-population-group.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  const ownGroups = groups.filter((group) => group.result_id === result.id && group.revision_hash === result.revision_hash && group.source_sha256 === result.source_sha256);
  return <div className="population-groups">
    <button type="button" className="population-groups-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Gates &amp; named groups</button>
    {open && <div className="population-gate-toolbar">
      <label>Interaction<select aria-label="Population gate tool" value={tool} onChange={(event) => setTool(event.target.value as typeof tool)} disabled={pending}><option value="inspect">Select objects</option><option value="rectangle">Rectangle gate</option><option value="polygon">Polygon gate</option></select></label>
      {(["x", "y"] as const).map((axis) => <label key={axis}>{axis.toUpperCase()} axis<select aria-label={`Gate ${axis.toUpperCase()} transform`} value={transforms[axis]} disabled={pending} onChange={(event) => { setTransforms((old) => ({ ...old, [axis]: event.target.value as "linear" | "log10" })); setBounds(["", "", "", ""]); setPolygon(""); setLogView(fullChartView()); onViewChange(fullChartView()); }}><option value="linear">Linear</option><option value="log10">log10</option></select></label>)}
    </div>}
    <PopulationChart kind="scatter" data={chartData} view={logAxes ? logView : view} onViewChange={setView} selectedLabel={selectedLabel} onSelect={onSelect} onBinChoose={onBinChoose} axisLabels={{ x: `${transforms.x === "log10" ? "log10 · " : ""}${populationMetricName(xMetric)}`, y: `${transforms.y === "log10" ? "log10 · " : ""}${populationMetricName(yMetric)}` }} disabled={disabled || pending}
      onEnlarge={transforms.x === "linear" && transforms.y === "linear" && tool === "inspect" ? onEnlarge : undefined}
      highlightedLabels={evaluated ? new Set(evaluated.labels) : undefined}
      gateDrawing={open && tool !== "inspect" ? { kind: tool, vertices, onVertices: (next) => { if (tool === "polygon") setPolygon(textPoints(next)); else if (!next.length) setBounds(["", "", "", ""]); else if (next.length === 2) setBounds([Math.min(next[0][0], next[1][0]), Math.max(next[0][0], next[1][0]), Math.min(next[0][1], next[1][1]), Math.max(next[0][1], next[1][1])].map(String)); } } : null} />
    {open && <section aria-label="Population gates and groups" className="population-group-editor" aria-busy={pending}>
      <p className="population-note">{populationMetricName(xMetric)} × {populationMetricName(yMetric)} · X {transforms.x}, Y {transforms.y}. Gates use every eligible row in this revision, independently of the display sample and numeric filters above.</p>
      {logAxes && <p className="population-note">Nonpositive values cannot appear on log axes. If the population includes them, the visible lower domain uses the plotted positive sample. Figure export below uses the raw linear axes.</p>}
      {tool === "rectangle" && <div className="population-gate-bounds">{["X minimum", "X maximum", "Y minimum", "Y maximum"].map((label, index) => <label key={label}>{label}<input aria-label={`Gate ${label}`} inputMode="decimal" value={bounds[index]} disabled={pending} onChange={(event) => setBounds((old) => old.map((value, i) => i === index ? event.target.value : value))} /></label>)}</div>}
      {tool === "polygon" && <label>Polygon vertices (transformed X, Y; one pair per line)<textarea aria-label="Gate polygon vertices" value={polygon} rows={5} disabled={pending} onChange={(event) => setPolygon(event.target.value)} /></label>}
      {tool !== "inspect" && <div className="population-actions"><button type="button" disabled={disabled || pending} onClick={() => void evaluate()}>Evaluate gate on all objects</button><button type="button" disabled={pending} onClick={() => { setBounds(["", "", "", ""]); setPolygon(""); }}>Clear gate draft</button></div>}
      {pending && <p role="status">Evaluating exact population…</p>}{error && <p role="alert">{error}</p>}
      {evaluated && <p role="status" className="population-gate-count">{evaluated.included_count.toLocaleString()} of {evaluated.total_count.toLocaleString()} objects in highlighted membership.
        <button type="button" onClick={() => { setEvaluated(null); onHighlight?.(null); }}>Clear highlight</button></p>}
      {evaluated?.accounting && <p className="population-note">{evaluated.accounting.excluded_missing_or_nonfinite_count} missing/non-finite · {evaluated.accounting.excluded_nonpositive_log_count} nonpositive log values · {evaluated.accounting.excluded_outside_count} outside. Edges included.</p>}
      <label>Group name<input aria-label="Population group name" value={name} maxLength={128} onChange={(event) => setName(event.target.value)} /></label>
      <button type="button" disabled={disabled || pending || !evaluated || !name.trim() || tool === "inspect"} onClick={() => void save()}>Save fixed group &amp; gate</button>
      <p className="population-note">Groups may overlap. Saved members stay bound to their exact result; corrections create a new revision with no inherited membership. Reapplying a saved gate creates a new group. Selection does not change labels.</p>
      <ul className="population-group-list">{ownGroups.map((group) => <li key={group.id}><label><input type="checkbox" aria-label={`Combine group ${group.name}`} checked={selectedGroups.includes(group.id)} disabled={disabled || pending || group.source_available === false} onChange={(event) => setSelectedGroups((old) => event.target.checked ? [...old, group.id] : old.filter((id) => id !== group.id))} />{group.name} · {group.included_count.toLocaleString()}{group.source_available === false ? " (source unavailable)" : ""}</label><button type="button" disabled={disabled || pending || group.source_available === false} onClick={() => void load(group.id)}>Highlight {group.name}</button></li>)}</ul>
      {!ownGroups.length && <p className="population-note">No named groups on this revision yet.</p>}
      <div className="population-actions">{(["union", "intersection", "unclassified"] as const).map((mode) => <button type="button" key={mode} disabled={disabled || pending || !selectedGroups.length || !name.trim()} onClick={() => void combine(mode)}>Save {mode}</button>)}</div>
      <p className="population-note">Union includes any selected group; intersection includes all. Unclassified means every object outside the union of selected groups. These are fixed memberships on this revision.</p>
      {groups.some((group) => group.result_id !== result.id && group.definition_kind === "gate") && <details><summary>Apply a saved gate to this result</summary>{groups.filter((group) => group.result_id !== result.id && group.definition_kind === "gate").map((group) => <button type="button" key={group.id} disabled={pending || disabled || !name.trim()} onClick={() => void apply(group)}>Apply {group.name} as new group</button>)}</details>}
      {record !== null && <button type="button" disabled={disabled || pending} onClick={() => void download()}>Download exact membership record</button>}
    </section>}
  </div>;
}
