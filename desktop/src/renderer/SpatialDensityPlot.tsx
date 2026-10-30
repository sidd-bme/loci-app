import { useId, useLayoutEffect, useRef, useState } from "react";
import type { SpatialDensityAggregation, SpatialDensityInput } from "../shared/spatial-density-contracts";
import { populationDisplayUnit } from "./PopulationChart";
import { populationNumber } from "./population-chart-view";
import { ScientificNumber } from "./ScientificNumber";
import { densityPlotData, type DensityPlotMode } from "./spatial-density-plot";
import "./SpatialDensityPlot.css";

export function SpatialDensityPlot({ aggregation, reportHash, onInspect, disabled = false }: {
  aggregation: SpatialDensityAggregation; reportHash: string;
  onInspect: (field: SpatialDensityInput) => void; disabled?: boolean;
}) {
  const studies = [...new Set(aggregation.donor_rows.map((r) => r.study))].sort();
  const [studyChoice, setStudy] = useState(studies[0] ?? ""), [band, setBand] = useState(0);
  const [mode, setMode] = useState<DensityPlotMode>("density"), [selectedKey, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(420), host = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const study = studies.includes(studyChoice) ? studyChoice : studies[0] ?? "";
  const areaUnit = populationDisplayUnit(aggregation.contract.area_unit), distanceUnit = populationDisplayUnit(aggregation.contract.distance_unit);
  const unit = `objects/${areaUnit}`;
  useLayoutEffect(() => {
    const measure = () => { const value = host.current?.getBoundingClientRect().width; if (value && value >= 220) setWidth(value); };
    measure();
    if (!host.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(host.current); return () => observer.disconnect();
  }, []);
  let data;
  try { data = densityPlotData(aggregation, study, band, mode); }
  catch (error) { return <p role="alert">{error instanceof Error ? error.message : "The donor plot could not be read. Reopen the saved report."}</p>; }
  const selected = data.points.find((p) => p.key === selectedKey), rowHeight = 78;
  const tickCount = width < 360 ? 3 : 5;
  const height = Math.max(180, data.groups.length * rowHeight + 78), left = Math.min(106, width * 0.31), right = width - 20, top = 28, bottom = height - 54;
  const x = (value: number) => left + (value - data.domain[0]) / (data.domain[1] - data.domain[0]) * (right - left);
  const y = (group: string) => top + (data.groups.indexOf(group) + 0.5) * (bottom - top) / Math.max(1, data.groups.length);
  const pointY = new Map(data.points.map((p) => {
    const group = data!.points.filter((r) => r.condition === p.condition), index = group.findIndex((r) => r.key === p.key);
    // Deterministic displacement keeps equal values visible without changing their numeric axis.
    const offset = group.length <= 1 ? 0 : ((index % 7) - Math.min(6, group.length - 1) / 2) * 7;
    return [p.key, y(p.condition) + offset];
  }));
  const select = (key: string) => { if (!disabled) setSelected(key); };
  const switchScope = (update: () => void) => { update(); setSelected(null); };
  return <section className="density-plot-section" aria-label="Donor density plot" data-report-hash={reportHash}>
    <h4>Donor comparisons</h4>
    <div className="density-plot-controls">
      <label>Study<select aria-label="Donor plot study" disabled={disabled || studies.length < 2} value={study} onChange={(e) => switchScope(() => setStudy(e.target.value))}>
        {studies.map((s) => <option key={s} value={s}>{s}</option>)}
      </select></label>
      <label>Distance band<select aria-label="Donor plot distance band" disabled={disabled} value={band} onChange={(e) => switchScope(() => setBand(Number(e.target.value)))}>
        {aggregation.contract.band_edges.slice(0, -1).map((lower, index) => <option key={index} value={index}>[{lower}, {aggregation.contract.band_edges[index + 1]}) {distanceUnit}</option>)}
      </select></label>
      <label>Plot<select aria-label="Donor plot measure" disabled={disabled} value={mode} onChange={(e) => switchScope(() => setMode(e.target.value as DensityPlotMode))}>
        <option value="density">Donor densities</option><option value="paired-difference" disabled={!aggregation.condition_pair}>Paired differences</option>
      </select></label>
    </div>
    <p id={helpId}>Each point is one declared donor{mode === "density" ? " within a condition" : " with a defined pair"}. Select a point to inspect its contributing fields. Bars show saved equal-donor means{data.connections.length ? "; lines connect declared pairs" : ""}.</p>
    <div ref={host} className="density-plot-host">
      {data.points.length ? <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${data.axisLabel} in ${study}`} aria-describedby={helpId} data-domain={data.domain.join(",")}>
        {Array.from({ length: tickCount }, (_, i) => data!.domain[0] + i * (data!.domain[1] - data!.domain[0]) / (tickCount - 1)).map((tick) => <g key={tick}>
          <line className="density-plot-grid" x1={x(tick)} x2={x(tick)} y1={top} y2={bottom} />
          <text x={x(tick)} y={bottom + 20} textAnchor="middle">{populationNumber(tick)}</text>
        </g>)}
        {data.domain[0] < 0 && <line className="density-plot-zero" x1={x(0)} x2={x(0)} y1={top} y2={bottom} />}
        {data.groups.map((group) => <text key={group} x={left - 10} y={y(group) + 4} textAnchor="end"><title>{group}</title>{group.length > 13 ? group.slice(0, 12) + "…" : group}</text>)}
        {data.connections.map((pair) => {
          const from = data!.points.find((p) => p.key === pair.from)!, to = data!.points.find((p) => p.key === pair.to)!;
          return <line key={JSON.stringify(pair)} className="density-plot-pair" x1={x(from.value)} x2={x(to.value)} y1={pointY.get(from.key)} y2={pointY.get(to.key)} data-donor={pair.donor} />;
        })}
        {data.means.map((mean) => <line key={mean.group} className="density-plot-mean" x1={x(mean.value)} x2={x(mean.value)} y1={y(mean.group) - 27} y2={y(mean.group) + 27}
          data-mean={mean.value}><title>{mean.group}: mean {populationNumber(mean.value)} {unit}; {mean.n} donors</title></line>)}
        {data.points.map((point) => <g key={point.key} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-pressed={selected?.key === point.key}
          aria-label={`Inspect donor ${point.donor}, ${point.condition}: ${populationNumber(point.value)} ${unit}`} className={`density-plot-point${selected?.key === point.key ? " is-selected" : ""}`}
          transform={`translate(${x(point.value)} ${pointY.get(point.key)})`} data-value={point.value} data-donor={point.donor}
          onClick={() => select(point.key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(point.key); } }}>
          <circle className="density-plot-hit" r={12} /><circle r={4.5} /><title>{point.donor} · {point.condition} · {populationNumber(point.value)} {unit}</title>
        </g>)}
        <text x={(left + right) / 2} y={height - 9} textAnchor="middle">{unit}</text>
      </svg> : <p>No defined donor values in this study and distance band.</p>}
    </div>
    {data.undefinedDonors.length > 0 && <p>{data.undefinedDonors.length} donor {data.undefinedDonors.length === 1 ? "value is" : "values are"} undefined because sampled area is zero; omitted from the plot, retained in the tables.</p>}
    <label>Inspect a plotted donor<select aria-label="Inspect plotted donor" disabled={disabled || !data.points.length} value={selected?.key ?? ""} onChange={(e) => setSelected(e.target.value || null)}>
      <option value="">Choose a donor…</option>{data.points.map((point) => <option value={point.key} key={point.key}>{point.donor} · {point.condition} · {populationNumber(point.value)} {unit}</option>)}
    </select></label>
    {selected && <div className="density-donor-selection" role="region" aria-label={`Fields for donor ${selected.donor}`}>
      <p><strong>{selected.donor}</strong> · {selected.condition} · <ScientificNumber value={selected.value} /> {unit}</p>
      <p>{selected.fields.length} contributing fields in this saved endpoint.</p>
      <ul>{selected.fields.map((field) => <li key={field.result.id}><span>{field.sample?.data.sample ?? "Saved field"} · {field.sample?.data.condition}<small>Time {field.result.selection.t + 1}, plane {field.result.selection.z + 1}</small></span>
        <button type="button" disabled={disabled} onClick={() => onInspect(field)} aria-label={`Inspect donor field ${field.result.id}`}>Inspect field</button></li>)}</ul>
    </div>}
  </section>;
}
