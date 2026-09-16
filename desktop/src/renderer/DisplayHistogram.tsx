import { useState } from "react";
import type { ResearchSource } from "../shared/research-contracts";
import "./DisplayHistogram.css";

export type HistogramRecord = {
  component: number; label: string; units: string; dtype: string;
  sample_count: number; min: number; max: number; bin_range: [number, number];
  counts: number[]; percentile_1: number; percentile_99: number;
};
export type SourceHistogram = {
  source_id: string; source_sha256: string; sample_semantics: string;
  sample: { kind: string; level: number; t: number; z: number; shape: [number, number];
    sample_count_per_component: number; viewport_dependent: false };
  histograms: HistogramRecord[]; display_revision: string;
};

export function checkedHistogram(value: unknown, source: ResearchSource, t: number, z: number): SourceHistogram {
  const data = value as SourceHistogram | null;
  if (!data || data.source_id !== source.id || data.source_sha256 !== source.sha256 ||
    !data.sample || data.sample.viewport_dependent !== false || data.sample.t !== t || data.sample.z !== z ||
    !["deterministic-native-pyramid-level", "deterministic-nearest-whole-source"].includes(data.sample.kind) ||
    !Array.isArray(data.sample.shape) || data.sample.shape.length !== 2 ||
    !data.sample.shape.every((size) => Number.isSafeInteger(size) && size > 0) ||
    !Number.isSafeInteger(data.sample.sample_count_per_component) || data.sample.sample_count_per_component < 1 ||
    data.sample.sample_count_per_component > 4 * 1024 ** 2 ||
    data.sample.shape[0] * data.sample.shape[1] !== data.sample.sample_count_per_component ||
    !Number.isInteger(data.sample.level) || data.sample.level < 0 ||
    !Array.isArray(data.histograms) || !data.histograms.length || data.histograms.length > 16 ||
    new Set(data.histograms.map((item) => item?.component)).size !== data.histograms.length ||
    data.histograms.some((item) => !item || !Number.isInteger(item.component) || item.component < 0 ||
      typeof item.label !== "string" || typeof item.units !== "string" ||
      !Array.isArray(item.bin_range) || item.bin_range.length !== 2 || !item.bin_range.every(Number.isFinite) ||
      item.bin_range[0] >= item.bin_range[1] || !Number.isFinite(item.bin_range[1] - item.bin_range[0]) || ![item.min, item.max, item.percentile_1, item.percentile_99].every(Number.isFinite) ||
      item.min > item.max || item.percentile_1 < item.min || item.percentile_99 > item.max || item.percentile_1 > item.percentile_99 ||
      item.sample_count !== data.sample.sample_count_per_component ||
      !Number.isSafeInteger(item.sample_count) || item.sample_count < 1 || item.sample_count > 4 * 1024 ** 2 ||
      !Array.isArray(item.counts) || item.counts.length < 2 || item.counts.length > 256 ||
      item.counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      item.counts.reduce((total, count) => total + count, 0) !== item.sample_count)) {
    throw new Error("Histogram does not match the selected source plane.");
  }
  return data;
}

const numberLabel = (value: number) => value.toLocaleString(undefined, { maximumSignificantDigits: 5 });

/** Counts are native samples; the overlaid range changes display only. */
export function HistogramPlot({ records, low, high, colors = ["#91bdb5"], label, onRange }: {
  records: HistogramRecord[]; low: number; high: number; colors?: string[]; label: string;
  onRange: (low: number, high: number) => void;
}) {
  const [logCounts, setLogCounts] = useState(true);
  const start = Math.min(low, ...records.map((record) => record.bin_range[0]));
  const end = Math.max(high, ...records.map((record) => record.bin_range[1]));
  const extent = end - start;
  const x = (value: number) => 256 * (value - start) / extent;
  const scale = (count: number) => logCounts ? Math.log1p(count) : count;
  const peak = Math.max(1, ...records.flatMap((record) => record.counts.map(scale)));
  const percentileLow = Math.min(...records.map((record) => record.percentile_1));
  const percentileHigh = Math.max(...records.map((record) => record.percentile_99));
  const clipped = records.reduce((total, record) => total + record.counts.reduce((sum, count, index) => {
    const a = record.bin_range[0] + (record.bin_range[1] - record.bin_range[0]) * index / record.counts.length;
    const b = record.bin_range[0] + (record.bin_range[1] - record.bin_range[0]) * (index + 1) / record.counts.length;
    return sum + (b <= low || a >= high ? count : 0);
  }, 0), 0);
  const total = records.reduce((count, record) => count + record.sample_count, 0);
  return <div className="display-histogram">
    <svg viewBox="0 0 256 80" preserveAspectRatio="none" role="img" aria-label={`${label} histogram`}>
      <title>{label}: {total.toLocaleString()} sampled values, range {numberLabel(start)} to {numberLabel(end)}</title>
      <rect x={0} y={0} width={Math.max(0, x(low))} height={80} className="histogram-clipped" />
      <rect x={x(high)} y={0} width={Math.max(0, 256 - x(high))} height={80} className="histogram-clipped" />
      {records.map((record, recordIndex) => <path key={record.component} fill="none" stroke={colors[recordIndex % colors.length]} strokeWidth="1.2"
        d={record.counts.map((count, index) => `${index ? "L" : "M"}${x(record.bin_range[0] + (index + 0.5) / record.counts.length * (record.bin_range[1] - record.bin_range[0]))},${77 - scale(count) / peak * 72}`).join(" ")} />)}
      <line x1={x(low)} x2={x(low)} y1={0} y2={80} className="histogram-window" />
      <line x1={x(high)} x2={x(high)} y1={0} y2={80} className="histogram-window" />
    </svg>
    <div className="histogram-axis"><span>{numberLabel(start)}</span><span>{numberLabel(end)}</span></div>
    <label className="histogram-range">Black point<input aria-label={`${label} black point`} type="range" min={start} max={end} step="any" value={low}
      onChange={(event) => { const next = Number(event.target.value); if (next < high) onRange(next, high); }} /></label>
    <label className="histogram-range">White point<input aria-label={`${label} white point`} type="range" min={start} max={end} step="any" value={high}
      onChange={(event) => { const next = Number(event.target.value); if (next > low) onRange(low, next); }} /></label>
    <div className="histogram-actions"><button type="button" disabled={percentileHigh <= percentileLow}
      title="Set the display range to the sampled 1st–99th percentiles. Values outside it will clip in rendered figures."
      onClick={() => onRange(percentileLow, percentileHigh)}>Trim 1–99%</button>
      <label><input type="checkbox" checked={logCounts} onChange={(event) => setLogCounts(event.target.checked)} />Log counts</label></div>
    <small>{(100 * clipped / total).toFixed(1)}% in clipped sample bins · display only</small>
  </div>;
}
