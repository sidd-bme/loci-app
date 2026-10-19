import { PopulationGroups, type PopulationHighlight } from "./PopulationGroups";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Maximize2, SlidersHorizontal } from "lucide-react";
import type { ResearchDesktopApi, ResearchResult } from "../shared/research-contracts";
import PopulationChart, { populationMetricName, populationDisplayUnit } from "./PopulationChart";
import PopulationChartDialog from "./PopulationChartDialog";
import PopulationFigureExport from "./PopulationFigureExport";
import { fullChartView, populationNumber, type ChartView } from "./population-chart-view";
import "./ResearchPopulationExplorer.css";

export type PopulationMetric = { id: string; label: string; kind: string; unit: string; channel?: string; statistic?: string };
export type PopulationRow = Record<string, unknown> & { label: number; values: Record<string, number | null>; centroid_index: number[]; index_axes: string };
export type PopulationFilter = { metric: string; min?: number; max?: number };
type PopulationSummary = { metric: string | null; count: number; missing_count: number; min: number | null; max: number | null; mean: number | null; median: number | null };
type PopulationQuery = { x_metric?: string; y_metric?: string; filters: PopulationFilter[]; sort?: { metric: string; direction: "asc" | "desc" }; offset: number; bins: number };
export type PopulationResponse = {
  schema: "loci.population/v1"; result_id: string; revision_hash: string; source_id: string; source_sha256: string;
  metrics: PopulationMetric[]; query: { x_metric: string | null; y_metric: string | null; filters: PopulationFilter[]; sort: PopulationQuery["sort"] | null;
    offset: number; limit: number; bins: number; plot_limit: number; selected_label: number | null };
  total_count: number; filtered_count: number;
  accounting: { filter_excluded_count: number; filter_missing_count: number; scatter_missing_count: number; metric_missing_counts: Record<string, number> };
  rows: PopulationRow[]; selected: { row: PopulationRow; filtered_index: number | null } | null;
  scatter: { points: Array<{ label: number; x: number; y: number }>; total_count: number; displayed_count: number; sampled: boolean; sampling: string };
  histogram: { metric: string | null; edges: number[]; counts: number[]; finite_count: number; missing_count: number; endpoints: "left-closed-right-open-last-closed" };
  summaries: { x: PopulationSummary; y: PopulationSummary };
  membership_sha256: string; query_sha256: string;
};
export type ResearchPopulationExplorerProps = {
  api: ResearchDesktopApi; result: ResearchResult; selectedLabel: number | null;
  onSelect: (row: Record<string, unknown>) => void; onLocate: (row: Record<string, unknown>) => void;
  onEdit?: (target: { result_id: string; revision_hash: string; label: number }) => void;
  onMeasureCompartments?: () => void;
  onHighlight?: (membership: PopulationHighlight | null) => void;
  active?: boolean; focused?: boolean; onToggleFocus?: () => void;
};
type FilterDraft = { key: number; metric: string; min: string; max: string };
const PAGE_SIZE = 25;
const PLOT_LIMIT = 500;
const initialQuery = (): PopulationQuery => ({ filters: [], offset: 0, bins: 16 });
const number = populationNumber;
const metricName = populationMetricName;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function checkedRow(value: unknown): value is PopulationRow {
  if (!value || typeof value !== "object") return false;
  const row = value as PopulationRow;
  return Number.isSafeInteger(row.label) && row.label > 0 && Boolean(row.values) && typeof row.values === "object" && !Array.isArray(row.values) &&
    Object.values(row.values).every((entry) => entry === null || (typeof entry === "number" && Number.isFinite(entry))) &&
    Array.isArray(row.centroid_index) && [2, 3].includes(row.centroid_index.length) && row.centroid_index.every(Number.isFinite) &&
    row.index_axes === (row.centroid_index.length === 2 ? "YX" : "ZYX");
}
const normalizedFilters = (filters: PopulationFilter[]) => JSON.stringify(filters.map((filter) => [filter.metric, filter.min ?? null, filter.max ?? null]).sort());
function checkedResponse(value: unknown, result: ResearchResult, expected: PopulationQuery, selectedLabel: number | null): PopulationResponse {
  const data = value as PopulationResponse | null;
  if (!data || data.schema !== "loci.population/v1" || data.result_id !== result.id || data.revision_hash !== result.revision_hash ||
    data.source_id !== result.source_id || (result.source_sha256 !== undefined && data.source_sha256 !== result.source_sha256) ||
    !Array.isArray(data.metrics) || data.metrics.some((metric) => typeof metric.id !== "string" || typeof metric.label !== "string" || typeof metric.unit !== "string") ||
    new Set(data.metrics.map((metric) => metric.id)).size !== data.metrics.length ||
    !data.query || data.query.offset !== expected.offset || data.query.limit !== PAGE_SIZE || data.query.selected_label !== selectedLabel ||
    !isCount(data.total_count) || !isCount(data.filtered_count) || data.filtered_count > data.total_count ||
    !Array.isArray(data.rows) || data.rows.length > PAGE_SIZE || data.rows.some((row) => !checkedRow(row)) || new Set(data.rows.map((row) => row.label)).size !== data.rows.length ||
    !data.accounting || ![data.accounting.filter_excluded_count, data.accounting.filter_missing_count, data.accounting.scatter_missing_count].every(isCount) ||
    !data.scatter || !Array.isArray(data.scatter.points) || data.scatter.points.length > PLOT_LIMIT ||
    data.scatter.points.some((point) => !Number.isSafeInteger(point.label) || point.label < 1 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) ||
    !isCount(data.scatter.total_count) || data.scatter.displayed_count !== data.scatter.points.length || typeof data.scatter.sampled !== "boolean" ||
    !data.histogram || !Array.isArray(data.histogram.edges) || !Array.isArray(data.histogram.counts) || data.histogram.edges.some((edge) => !Number.isFinite(edge)) ||
    data.histogram.counts.some((count) => !isCount(count)) || (data.histogram.counts.length > 0 && data.histogram.edges.length !== data.histogram.counts.length + 1) ||
    !isCount(data.histogram.finite_count) || !isCount(data.histogram.missing_count) || data.histogram.endpoints !== "left-closed-right-open-last-closed" ||
    (data.selected !== null && (!data.selected || !checkedRow(data.selected.row) || data.selected.row.label !== selectedLabel ||
      (data.selected.filtered_index !== null && (!isCount(data.selected.filtered_index) || data.selected.filtered_index >= data.filtered_count)))) ||
    !/^[a-f0-9]{64}$/.test(data.membership_sha256) || !/^[a-f0-9]{64}$/.test(data.query_sha256)) {
    throw new Error("The population response does not match this exact result, page and selection. Retry the query.");
  }
  const metricIds = new Set(data.metrics.map((metric) => metric.id));
  const metricValid = (metric: string | null) => metric === null ? metricIds.size === 0 : metricIds.has(metric);
  const edges = data.histogram.edges;
  const constantBin = data.histogram.counts.length === 1 && edges[0] === edges[1];
  const summaryValid = (summary: PopulationSummary | undefined, metric: string | null) => Boolean(summary && summary.metric === metric &&
    isCount(summary.count) && isCount(summary.missing_count) && summary.count + summary.missing_count === data.filtered_count &&
    (summary.count === 0 ? summary.min === null && summary.max === null && summary.mean === null && summary.median === null :
      [summary.min, summary.max, summary.mean, summary.median].every((value) => typeof value === "number" && Number.isFinite(value)) && summary.min! <= summary.max!));
  if (!metricValid(data.query.x_metric) || !metricValid(data.query.y_metric) || data.histogram.metric !== data.query.x_metric ||
    (expected.x_metric !== undefined && data.query.x_metric !== expected.x_metric) || (expected.y_metric !== undefined && data.query.y_metric !== expected.y_metric) ||
    data.query.plot_limit !== PLOT_LIMIT || data.query.bins !== expected.bins || !Array.isArray(data.query.filters) ||
    normalizedFilters(data.query.filters) !== normalizedFilters(expected.filters) ||
    (data.query.sort?.metric ?? null) !== (expected.sort?.metric ?? null) || (data.query.sort?.direction ?? null) !== (expected.sort?.direction ?? null) ||
    data.filtered_count + data.accounting.filter_excluded_count !== data.total_count || data.accounting.filter_missing_count > data.accounting.filter_excluded_count ||
    data.scatter.total_count + data.accounting.scatter_missing_count !== data.filtered_count || data.scatter.displayed_count > data.scatter.total_count ||
    data.scatter.sampled !== (data.scatter.total_count > PLOT_LIMIT) || data.scatter.displayed_count !== Math.min(data.scatter.total_count, PLOT_LIMIT) ||
    new Set(data.scatter.points.map((point) => point.label)).size !== data.scatter.points.length ||
    data.histogram.counts.reduce((sum, count) => sum + count, 0) !== data.histogram.finite_count ||
    data.histogram.finite_count + data.histogram.missing_count !== data.filtered_count ||
    (data.histogram.counts.length === 0 && edges.length !== 0) || (!constantBin && edges.some((edge, index) => index > 0 && edge <= edges[index - 1])) ||
    !data.accounting.metric_missing_counts || [...metricIds].some((metric) => !isCount(data.accounting.metric_missing_counts[metric]) || data.accounting.metric_missing_counts[metric] > data.filtered_count) ||
    data.rows.length !== Math.min(PAGE_SIZE, Math.max(0, data.filtered_count - expected.offset)) ||
    data.rows.some((row) => [...metricIds].some((metric) => !(metric in row.values))) ||
    !summaryValid(data.summaries?.x, data.query.x_metric) || !summaryValid(data.summaries?.y, data.query.y_metric) ||
    data.summaries.x.count !== data.histogram.finite_count || data.summaries.x.missing_count !== data.histogram.missing_count ||
    data.scatter.points.some((point) => point.x < data.summaries.x.min! || point.x > data.summaries.x.max! || point.y < data.summaries.y.min! || point.y > data.summaries.y.max!))
    throw new Error("Population counts, metric units or query binding are inconsistent. Retry the query.");
  return data;
}

// Match a right-open histogram bin using an inclusive numeric filter without
// inadvertently including objects on the next bin's lower edge.
export function previousFloat(value: number): number {
  if (value === 0) return -Number.MIN_VALUE;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  bytes.setBigUint64(0, bytes.getBigUint64(0) + (value > 0 ? -1n : 1n));
  return bytes.getFloat64(0);
}

export function ResearchPopulationExplorer(props: ResearchPopulationExplorerProps) {
  // Keying the inner component makes revision/source invalidation synchronous,
  // including filter drafts and any old plot's event handlers.
  const { result } = props;
  return <PopulationExplorer key={`${result.id}:${result.revision_hash}:${result.source_id}:${result.source_sha256 ?? ""}`} {...props} />;
}

function PopulationExplorer({ api, result, selectedLabel, onSelect, onLocate, onEdit, onHighlight, onMeasureCompartments, active = true, focused = false, onToggleFocus }: ResearchPopulationExplorerProps) {
  const [query, setQuery] = useState<PopulationQuery>(initialQuery);
  const [data, setData] = useState<PopulationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectionPending, setSelectionPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const [drafts, setDrafts] = useState<FilterDraft[]>([]);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [histogramView, setHistogramView] = useState<ChartView>(fullChartView);
  const [scatterView, setScatterView] = useState<ChartView>(fullChartView);
  const [enlarged, setEnlarged] = useState<"histogram" | "scatter" | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const nextFilter = useRef(0);
  const table = useRef<HTMLDivElement>(null);
  const id = useId();
  const request = (label: number | null) => ({ result_id: result.id, revision_hash: result.revision_hash, ...query,
    limit: PAGE_SIZE, plot_limit: PLOT_LIMIT, selected_label: label });
  useEffect(() => {
    if (!active) { setEnlarged(null); return; }
    const token = ++generation.current;
    selectionGeneration.current++;
    setSelectionPending(false); setLoading(true); setError(null);
    void api.execute("population_query", request(selectedLabel)).then((value) => {
      if (token !== generation.current) return;
      setData(checkedResponse(value, result, query, selectedLabel)); setLoading(false);
    }).catch((caught) => {
      if (token !== generation.current) return;
      setData(null); setLoading(false); setError(caught instanceof Error ? caught.message : "Could not read this population. Retry the query.");
    });
    return () => { generation.current++; selectionGeneration.current++; };
    // request is derived solely from these scope fields and query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, result.id, result.revision_hash, result.source_id, result.source_sha256, query, selectedLabel, retry, active]);
  const selectLabel = async (label: number) => {
    if (loading || selectionPending || !data) return;
    const row = data.rows.find((item) => item.label === label) ?? (data.selected?.row.label === label ? data.selected.row : null);
    if (row) { onSelect(row); return; }
    const token = ++selectionGeneration.current;
    const scope = generation.current;
    setSelectionPending(true); setError(null);
    try {
      const value = await api.execute("population_query", request(label));
      if (token !== selectionGeneration.current || scope !== generation.current) return;
      const selected = checkedResponse(value, result, query, label).selected;
      if (!selected) throw new Error("This object is absent from the selected revision. Retry the query.");
      onSelect(selected.row);
    } catch (caught) {
      if (token === selectionGeneration.current && scope === generation.current)
        setError(caught instanceof Error ? caught.message : "Could not select this exact object.");
    } finally { if (token === selectionGeneration.current && scope === generation.current) setSelectionPending(false); }
  };
  const metrics = data?.metrics ?? [];
  const xMetric = metrics.find((metric) => metric.id === (query.x_metric ?? data?.query.x_metric));
  const yMetric = metrics.find((metric) => metric.id === (query.y_metric ?? data?.query.y_metric));
  const update = (patch: Partial<PopulationQuery>) => {
    setLoading(true);
    if (patch.x_metric !== undefined || patch.y_metric !== undefined || patch.filters !== undefined || patch.bins !== undefined) {
      setHistogramView(fullChartView()); setScatterView(fullChartView());
    }
    setQuery((current) => ({ ...current, ...patch, offset: patch.offset ?? 0 }));
  };
  const resetDrafts = () => { setDrafts(query.filters.map((filter) => ({ key: nextFilter.current++, metric: filter.metric,
    min: filter.min === undefined ? "" : String(filter.min), max: filter.max === undefined ? "" : String(filter.max) }))); setFilterError(null); };
  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const filters = drafts.map((draft): PopulationFilter => {
        const min = draft.min.trim() ? Number(draft.min) : undefined;
        const max = draft.max.trim() ? Number(draft.max) : undefined;
        if (!metrics.some((metric) => metric.id === draft.metric) || (min === undefined && max === undefined) ||
          (min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) ||
          (min !== undefined && max !== undefined && min > max)) throw new Error("Each range needs a finite bound and minimum ≤ maximum.");
        return { metric: draft.metric, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
      });
      setFilterError(null); update({ filters });
    } catch (caught) { setFilterError(caught instanceof Error ? caught.message : "Check the numeric ranges."); }
  };
  const binFilter = (index: number) => {
    if (!data || loading || !data.histogram.metric) return;
    const { edges, counts, metric } = data.histogram;
    const max = index === counts.length - 1 ? edges[index + 1] : previousFloat(edges[index + 1]);
    const prior = query.filters.filter((filter) => filter.metric === metric);
    const filter = { metric, min: Math.max(edges[index], ...prior.map((entry) => entry.min ?? -Infinity)),
      max: Math.min(max, ...prior.map((entry) => entry.max ?? Infinity)) };
    const filters = [...query.filters.filter((entry) => entry.metric !== metric), filter];
    if (filters.length > 8) { setFilterError("Remove a range before adding this histogram range; at most eight ranges can apply."); return; }
    setDrafts(filters.map((entry) => ({ key: nextFilter.current++, metric: entry.metric, min: entry.min === undefined ? "" : String(entry.min), max: entry.max === undefined ? "" : String(entry.max) })));
    setFiltersOpen(true);
    setFilterError(null); update({ filters });
  };
  const handleTableKey = (event: React.KeyboardEvent) => {
    if (!data || loading || selectionPending || (event.target as HTMLElement).tagName === "BUTTON") return;
    const index = data.rows.findIndex((row) => row.label === selectedLabel);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(data.rows.length - 1, index + 1);
    if (event.key === "ArrowUp") next = Math.max(0, index < 0 ? data.rows.length - 1 : index - 1);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = data.rows.length - 1;
    if (next !== null && data.rows[next]) { event.preventDefault(); onSelect(data.rows[next]); }
  };
  useEffect(() => { table.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [selectedLabel, data]);
  const ready = !loading && data !== null;
  const selected = ready ? data.selected : null;
  const count = data?.filtered_count ?? 0;
  const draftChanged = JSON.stringify(drafts.map(({ metric, min, max }) => ({ metric, min, max }))) !==
    JSON.stringify(query.filters.map(({ metric, min, max }) => ({ metric, min: min === undefined ? "" : String(min), max: max === undefined ? "" : String(max) })));
  const downloadReceipt = () => {
    if (!data || loading) return;
    const receipt = { schema: "loci.population-query-receipt/v1", result_id: data.result_id, revision_hash: data.revision_hash,
      source_id: data.source_id, source_sha256: data.source_sha256, source_selection: result.selection ?? null,
      query: data.query, metrics: data.metrics, total_count: data.total_count, filtered_count: data.filtered_count,
      accounting: data.accounting, scatter_sampling: { total_count: data.scatter.total_count, displayed_count: data.scatter.displayed_count,
        sampled: data.scatter.sampled, sampling: data.scatter.sampling }, membership_sha256: data.membership_sha256, query_sha256: data.query_sha256 };
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `loci-population-${data.revision_hash.slice(0, 12)}.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const chartProps = (kind: "histogram" | "scatter") => ({ kind, data: data!,
    view: kind === "histogram" ? histogramView : scatterView,
    onViewChange: kind === "histogram" ? setHistogramView : setScatterView,
    selectedLabel, onSelect: (label: number) => void selectLabel(label), onBinChoose: binFilter,
    disabled: !ready || selectionPending,
  });
  return <section className="research-panel population-explorer" aria-label="Object population explorer" aria-busy={loading || selectionPending}>
    <header className="population-heading"><div><h2>Statistics &amp; objects</h2>
      <p className="population-scope">{result.selection ? `T ${result.selection.t + 1} · Z ${result.selection.z + 1}${result.selection.z_stop === undefined ? "" : `–${result.selection.z_stop}`}` : "Source plane scope unavailable"} · {result.arrays?.labels?.shape?.length === 3 || result.arrays?.image?.shape?.length === 3 ? "3D objects" : "2D objects"}</p></div>
      {onToggleFocus && <button type="button" onClick={onToggleFocus} aria-pressed={focused}
        aria-label={focused ? "Return to image and statistics" : "Focus statistics workspace"}>
        {focused ? <ArrowLeft size={15} /> : <Maximize2 size={15} />}{focused ? "Show image" : "Focus statistics"}</button>}
    </header>
    {onMeasureCompartments && <details className="population-measurement-guide"><summary>Raw channels &amp; compartments</summary>
      <p className="population-note">Axes use the saved raw-channel measurements. Compartment results add whole-cell, nuclear-intersection and remaining-area measurements from declared compatible label revisions.</p>
      <button type="button" onClick={onMeasureCompartments}>Connect nucleus &amp; cell results</button>
    </details>}
    <div className="population-metrics">
      <label>X · Measurement<select aria-label="Population X metric" value={xMetric?.id ?? ""} disabled={!metrics.length || loading}
        onChange={(event) => update({ x_metric: event.target.value })}>{!metrics.length && <option value="">No numeric metrics</option>}{metrics.map((metric) => <option key={metric.id} value={metric.id}>{metricName(metric)}</option>)}</select></label>
      <label>Y · Compare with<select aria-label="Population Y metric" value={yMetric?.id ?? ""} disabled={!metrics.length || loading}
        onChange={(event) => update({ y_metric: event.target.value })}>{!metrics.length && <option value="">No numeric metrics</option>}{metrics.map((metric) => <option key={metric.id} value={metric.id}>{metricName(metric)}</option>)}</select></label>
    </div>
    <div className="population-filter-heading">
      <button type="button" aria-expanded={filtersOpen} aria-controls={`${id}-filters`} onClick={() => setFiltersOpen((value) => !value)}>
        <SlidersHorizontal size={15} />{query.filters.length ? `Filters (${query.filters.length})` : "Filter objects"}</button>
      <button type="button" disabled={loading || !metrics.length || drafts.length >= 8}
        onClick={() => { setFiltersOpen(true); setDrafts((current) => [...current, { key: nextFilter.current++, metric: xMetric?.id ?? metrics[0].id, min: "", max: "" }]); }}>Add range</button>
      {query.filters.length > 0 && <button type="button" disabled={loading} onClick={() => { setDrafts([]); setFilterError(null); setFiltersOpen(false); update({ filters: [] }); }}>Clear filters</button>}
    </div>
    <form id={`${id}-filters`} hidden={!filtersOpen} className="population-filters" onSubmit={applyFilters}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); resetDrafts(); } }} aria-label="Population numeric filters">
      {!drafts.length && <p className="population-note">Add a measurement range, or choose a histogram bar to explore that part of the population.</p>}
      {drafts.map((draft, index) => <div className="population-filter" key={draft.key}>
        <label>Metric<select aria-label={`Range ${index + 1} metric`} disabled={loading} value={draft.metric}
          onChange={(event) => setDrafts((current) => current.map((entry) => entry.key === draft.key ? { ...entry, metric: event.target.value } : entry))}>{metrics.map((metric) => <option key={metric.id} value={metric.id}>{metricName(metric)}</option>)}</select></label>
        <div className="population-range-inputs"><label>Minimum<input inputMode="decimal" aria-label={index === 0 ? "Population minimum" : `Range ${index + 1} minimum`} value={draft.min} disabled={loading}
          aria-invalid={Boolean(filterError)} aria-describedby={filterError ? `${id}-filter-error` : undefined}
          onChange={(event) => setDrafts((current) => current.map((entry) => entry.key === draft.key ? { ...entry, min: event.target.value } : entry))} /></label>
          <label>Maximum<input inputMode="decimal" aria-label={index === 0 ? "Population maximum" : `Range ${index + 1} maximum`} value={draft.max} disabled={loading}
            aria-invalid={Boolean(filterError)} aria-describedby={filterError ? `${id}-filter-error` : undefined}
            onChange={(event) => setDrafts((current) => current.map((entry) => entry.key === draft.key ? { ...entry, max: event.target.value } : entry))} /></label>
          <button type="button" aria-label={`Remove range ${index + 1}`} disabled={loading} onClick={() => setDrafts((current) => current.filter((entry) => entry.key !== draft.key))}>Remove</button></div>
      </div>)}
      {drafts.length > 0 && <p className="population-note">All ranges apply together. Bounds include their endpoints; missing values are excluded.</p>}
      {filterError && <p id={`${id}-filter-error`} role="alert">{filterError}</p>}
      {(drafts.length > 0 || query.filters.length > 0) && <div className="population-actions"><button type="submit" className="btn-primary" disabled={loading || !draftChanged}>Apply filter</button>
        <button type="button" disabled={!draftChanged || loading} onClick={resetDrafts}>Reset draft</button></div>}
    </form>
    {loading && <div className="population-loading" role="status"><p>Reading the complete population…</p><div className="population-skeleton" aria-hidden="true" /></div>}
    {selectionPending && <p role="status">Reading the selected object…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry population</button></p>}
    {data && <div hidden={!ready}>
      <p role="status" className="population-counts">{number(data.filtered_count)} of {number(data.total_count)} objects match{query.filters.length ? ` · ${number(data.accounting.filter_excluded_count)} excluded by ranges · ${number(data.accounting.filter_missing_count)} missing filter values` : ""}.</p>
      <p className="population-note population-unit-note">{xMetric?.unit.startsWith("pixel") ? "Pixel units: this size measurement is uncalibrated." : xMetric?.kind === "area" || xMetric?.kind === "volume" ? `Size uses recorded calibration (${populationDisplayUnit(xMetric.unit)}).` : "Units follow the recorded measurement basis."}</p>
      {data.summaries.x.count > 0 && <dl className="population-summary" aria-label={`${xMetric?.label ?? "Measurement"} summary`}>
        <div><dt>Mean</dt><dd>{number(data.summaries.x.mean!)}</dd></div>
        <div><dt>Median</dt><dd>{number(data.summaries.x.median!)}</dd></div>
        <div><dt>Range</dt><dd>{number(data.summaries.x.min!)}–{number(data.summaries.x.max!)}</dd></div>
      </dl>}
      {selected && <div className="population-selected" aria-label="Selected population object"><div className="population-selected-heading"><h3>Object #{selected.row.label}</h3>
        <button type="button" disabled={selectionPending} onClick={() => onLocate(selected.row)}>Locate selected object</button>
        {onEdit && <button type="button" disabled={selectionPending} onClick={() => onEdit({ result_id: result.id, revision_hash: result.revision_hash, label: selected.row.label })}>Edit selected object</button>}</div>
        {selected.filtered_index === null && <p role="status">This selected object is outside the current ranges.</p>}
        {selected.filtered_index !== null && Math.floor(selected.filtered_index / PAGE_SIZE) * PAGE_SIZE !== query.offset && <button type="button" disabled={selectionPending}
          onClick={() => update({ offset: Math.floor(selected.filtered_index! / PAGE_SIZE) * PAGE_SIZE })}>Show selected object's page</button>}
        <p className="population-note">{xMetric && selected.row.values[xMetric.id] != null ? `${xMetric.label}: ${number(selected.row.values[xMetric.id]!)} ${populationDisplayUnit(xMetric.unit)}` : "Measurement missing"}
          {yMetric && yMetric.id !== xMetric?.id && selected.row.values[yMetric.id] != null ? ` · ${yMetric.label}: ${number(selected.row.values[yMetric.id]!)} ${populationDisplayUnit(yMetric.unit)}` : ""}</p>
      </div>}
      {selectedLabel !== null && !selected && <p role="status">Object #{selectedLabel} is absent from this exact result revision.</p>}
      {!data.total_count ? <div className="population-empty"><h3>No measured objects</h3><p>This result contains no measured objects. Select a segmentation result with objects to explore.</p></div> : <>
        <div className="population-bin-setting"><label>Histogram bins<select aria-label="Histogram bins" value={query.bins} disabled={selectionPending}
          onChange={(event) => update({ bins: Number(event.target.value) })}>{[8, 16, 32, 64].map((bins) => <option key={bins} value={bins}>{bins}</option>)}</select></label></div>
        <div className="population-charts">
          <PopulationChart {...chartProps("histogram")} onEnlarge={() => setEnlarged("histogram")} />
          <PopulationGroups key={`${result.id}:${result.revision_hash}`} api={api} result={result} data={data} disabled={!ready || selectionPending}
            selectedLabel={selectedLabel} onSelect={(label) => void selectLabel(label)} onBinChoose={binFilter} onHighlight={onHighlight} view={scatterView} onViewChange={setScatterView} onEnlarge={() => setEnlarged("scatter")} />
        </div>
        <PopulationFigureExport api={api} data={data} histogramView={histogramView} scatterView={scatterView} disabled={!ready || selectionPending} />
        <div className="population-section-heading"><h3>Objects</h3><span>{count ? `${query.offset + 1}–${Math.min(query.offset + data.rows.length, count)} of ${number(count)}` : "No matches"}</span></div>
        <div className="population-sort"><label>Sort<select aria-label="Population sort metric" value={query.sort?.metric ?? "label"} disabled={selectionPending}
          onChange={(event) => update({ sort: { metric: event.target.value, direction: query.sort?.direction ?? "asc" } })}><option value="label">Object label</option>{metrics.map((metric) => <option key={metric.id} value={metric.id}>{metricName(metric)}</option>)}</select></label>
          <label>Order<select aria-label="Population sort direction" value={query.sort?.direction ?? "asc"} disabled={selectionPending}
            onChange={(event) => update({ sort: { metric: query.sort?.metric ?? "label", direction: event.target.value as "asc" | "desc" } })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label></div>
        <div ref={table} className="population-table" role="region" aria-label="Filtered object measurements" tabIndex={0} onKeyDown={handleTableKey}>
          <table aria-label="Population object table"><thead><tr><th scope="col">Object</th><th scope="col">{metricName(xMetric)}</th>{yMetric?.id !== xMetric?.id && <th scope="col">{metricName(yMetric)}</th>}</tr></thead>
            <tbody>{data.rows.map((row) => <tr key={row.label} data-label={row.label} aria-selected={row.label === selectedLabel}>
              <th scope="row"><button type="button" disabled={selectionPending} aria-pressed={row.label === selectedLabel} onClick={() => onSelect(row)}>#{row.label}</button></th>
              <td>{xMetric && row.values[xMetric.id] !== null && row.values[xMetric.id] !== undefined ? number(row.values[xMetric.id]!) : "Missing"}</td>
              {yMetric?.id !== xMetric?.id && <td>{yMetric && row.values[yMetric.id] !== null && row.values[yMetric.id] !== undefined ? number(row.values[yMetric.id]!) : "Missing"}</td>}
            </tr>)}</tbody></table>
          {!data.rows.length && <p>No objects match. Clear or widen the numeric ranges.</p>}
        </div>
        <div className="population-pagination"><button type="button" disabled={!query.offset || selectionPending} onClick={() => update({ offset: Math.max(0, query.offset - PAGE_SIZE) })}>Previous page</button>
          <button type="button" disabled={query.offset + PAGE_SIZE >= count || selectionPending} onClick={() => update({ offset: query.offset + PAGE_SIZE })}>Next page</button></div>
        <p className="population-note">Select a row or point; use arrow keys, Home or End in the table. Missing values sort last.</p>
      </>}
      <details className="population-receipt"><summary>Source &amp; query details</summary>
        <p>Objects are descriptive observations, not biological replicate counts.</p>
        <p>Revision {result.revision_hash.slice(0, 12)} · Source {result.source_id.slice(0, 12)}</p>
        {selected && <p>Selected centroid ({selected.row.index_axes.split("").join(", ")}) · {selected.row.centroid_index.map(number).join(", ")}</p>}
        <button type="button" onClick={downloadReceipt}>Download query receipt</button>
        <dl><dt>Membership SHA-256</dt><dd>{data.membership_sha256}</dd><dt>Query SHA-256</dt><dd>{data.query_sha256}</dd></dl>
      </details>
    </div>}
    {enlarged && data && <PopulationChartDialog title={enlarged === "histogram" ? "Distribution · enlarged chart" : "Relationship · enlarged chart"} onClose={() => setEnlarged(null)}>
      <PopulationChart {...chartProps(enlarged)} expanded />
      {selected && <div className="population-dialog-selection"><span>Selected object #{selected.row.label}</span>
        <button type="button" disabled={!ready || selectionPending} onClick={() => { setEnlarged(null); onLocate(selected.row); }}>Locate selected object</button></div>}
    </PopulationChartDialog>}
  </section>;
}
