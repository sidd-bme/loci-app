import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Hand, Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { PopulationMetric, PopulationResponse } from "./ResearchPopulationExplorer";
import { chartTicks, displayedFraction, fullChartView, isFullChartView, panChartView, populationNumber, viewedDomain, zoomChartView, type ChartView } from "./population-chart-view";

export const populationDisplayUnit = (unit: string): string => ({ "um": "µm", "um^2": "µm²", "um^3": "µm³", "pixel^2": "pixel²", "pixel^3": "pixel³" }[unit] ?? unit);
export const populationMetricName = (metric: PopulationMetric | undefined): string =>
  metric ? `${metric.label}${metric.unit ? ` (${populationDisplayUnit(metric.unit)})` : ""}` : "No metric";

export function populationChartDomains(data: PopulationResponse, histogram: boolean): ChartView {
  return {
    x: [data.summaries.x.min ?? 0, data.summaries.x.max ?? 0],
    y: histogram ? [0, Math.max(0, ...data.histogram.counts)] : [data.summaries.y.min ?? 0, data.summaries.y.max ?? 0],
  };
}

export type PopulationChartProps = {
  kind: "histogram" | "scatter";
  data: PopulationResponse;
  view: ChartView;
  onViewChange: (view: ChartView) => void;
  selectedLabel: number | null;
  onSelect: (label: number) => void;
  onBinChoose: (index: number) => void;
  disabled?: boolean;
  expanded?: boolean;
  onEnlarge?: () => void;
};

export default function PopulationChart({ kind, data, view, onViewChange, selectedLabel, onSelect, onBinChoose,
  disabled = false, expanded = false, onEnlarge }: PopulationChartProps) {
  const histogram = kind === "histogram";
  const xMetric = data.metrics.find((metric) => metric.id === data.query.x_metric);
  const yMetric = data.metrics.find((metric) => metric.id === data.query.y_metric);
  const domains = populationChartDomains(data, histogram);
  const hasValues = histogram ? data.histogram.finite_count > 0 : data.scatter.points.length > 0;
  const title = histogram ? "Distribution" : "Relationship";
  const chartName = histogram ? `Histogram of ${populationMetricName(xMetric)}` : `${populationMetricName(yMetric)} versus ${populationMetricName(xMetric)}`;
  const xLabel = populationMetricName(xMetric);
  const yLabel = histogram ? "Object count" : populationMetricName(yMetric);
  const [panning, setPanning] = useState(false);
  const [keyboardLabel, setKeyboardLabel] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<string | null>(null);
  const [width, setWidth] = useState(expanded ? 900 : 500);
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; view: ChartView; width: number; height: number; moved: boolean } | null>(null);
  const clip = useId().replace(/:/g, "");
  const helpId = `${clip}-help`;
  const height = expanded ? Math.max(320, Math.min(520, width * 0.57)) : 260;
  const box = { left: 76, top: 16, right: width - 20, bottom: height - 62 };
  const plotWidth = Math.max(40, box.right - box.left), plotHeight = box.bottom - box.top;
  const xPosition = (value: number) => box.left + displayedFraction(value, domains.x, view.x) * plotWidth;
  const yPosition = (value: number) => box.bottom - displayedFraction(value, domains.y, view.y) * plotHeight;
  const xTicks = chartTicks(domains.x, view.x, width < 420 ? 2 : 4);
  const yTicks = chartTicks(domains.y, view.y, 4, histogram);
  const constantX = domains.x[0] === domains.x[1];
  const canZoom = hasValues && (!constantX || (!histogram && domains.y[0] !== domains.y[1]));
  const full = isFullChartView(view);
  const pan = (dx: number, dy: number) => onViewChange(panChartView(view, dx, dy, domains, histogram));
  const zoom = (factor: number) => onViewChange(zoomChartView(view, factor, domains, histogram));
  const visiblePoints = data.scatter.points.filter((point) => {
    const x = displayedFraction(point.x, domains.x, view.x), y = displayedFraction(point.y, domains.y, view.y);
    return x >= -1e-9 && x <= 1 + 1e-9 && y >= -1e-9 && y <= 1 + 1e-9;
  });
  const focusLabel = visiblePoints.some((point) => point.label === keyboardLabel) ? keyboardLabel
    : visiblePoints.some((point) => point.label === selectedLabel) ? selectedLabel : visiblePoints[0]?.label;
  useLayoutEffect(() => {
    const measure = () => { const next = host.current?.getBoundingClientRect().width; if (next && next > 120) setWidth(next); };
    measure();
    if (typeof ResizeObserver === "undefined" || !host.current) return;
    const observer = new ResizeObserver(measure); observer.observe(host.current);
    return () => observer.disconnect();
  }, [expanded]);

  const chartKey = (event: React.KeyboardEvent) => {
    if (disabled || !hasValues || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(0.7); }
    else if (event.key === "-") { event.preventDefault(); zoom(1 / 0.7); }
    else if (event.key === "Home") { event.preventDefault(); onViewChange(fullChartView()); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); pan(-0.2, 0); }
    else if (event.key === "ArrowRight") { event.preventDefault(); pan(0.2, 0); }
    else if (event.key === "ArrowUp" && !histogram) { event.preventDefault(); pan(0, 0.2); }
    else if (event.key === "ArrowDown" && !histogram) { event.preventDefault(); pan(0, -0.2); }
  };
  const shortAxis = (label: string, pixels: number) => {
    const capacity = Math.max(12, Math.floor(pixels / 6.5));
    return label.length > capacity ? `${label.slice(0, capacity - 1)}…` : label;
  };

  return <section className={`population-plot-section ${expanded ? "is-expanded" : ""}`} aria-label={`${title} chart`}>
    <div className="population-section-heading"><h3>{title}</h3>
      {onEnlarge && <button type="button" className="population-enlarge" onClick={onEnlarge} disabled={!hasValues || disabled}
        aria-label={`Enlarge ${title.toLowerCase()} chart`}><Maximize2 size={15} />Enlarge</button>}
    </div>
    <div className="population-chart-controls" role="group" aria-label={`${title} view controls`}>
      <div className="population-control-group">
        <button type="button" aria-label={`Zoom in ${title.toLowerCase()}`} title="Zoom in (+)" disabled={disabled || !canZoom} onClick={() => zoom(0.7)}><Plus /></button>
        <button type="button" aria-label={`Zoom out ${title.toLowerCase()}`} title="Zoom out (−)" disabled={disabled || full} onClick={() => zoom(1 / 0.7)}><Minus /></button>
        <button type="button" title="Reset display domain (Home)" disabled={disabled || full} onClick={() => onViewChange(fullChartView())}
          aria-label={`Reset ${title.toLowerCase()} view`}><RotateCcw /><span>Reset view</span></button>
      </div>
      <div className="population-control-group">
        <button type="button" aria-label={`Pan ${title.toLowerCase()} chart`} title="Drag the chart to pan" aria-pressed={panning}
          disabled={disabled || !canZoom} onClick={() => { setPanning((value) => !value); setTooltip(null); }}><Hand /><span>Pan</span></button>
        {!full && <>
          <button type="button" aria-label={`Pan ${title.toLowerCase()} left`} disabled={disabled || view.x[0] === 0} onClick={() => pan(-0.2, 0)}><ArrowLeft /></button>
          <button type="button" aria-label={`Pan ${title.toLowerCase()} right`} disabled={disabled || view.x[1] === 1} onClick={() => pan(0.2, 0)}><ArrowRight /></button>
          {!histogram && <><button type="button" aria-label="Pan relationship up" disabled={disabled || view.y[1] === 1} onClick={() => pan(0, 0.2)}><ArrowUp /></button>
            <button type="button" aria-label="Pan relationship down" disabled={disabled || view.y[0] === 0} onClick={() => pan(0, -0.2)}><ArrowDown /></button></>}
        </>}
      </div>
    </div>
    <div ref={host} className="population-chart-host">
      {hasValues ? <svg ref={plot} className={`population-chart population-${kind}${panning ? " is-panning" : ""}`}
        viewBox={`0 0 ${width} ${height}`} role="group" aria-label={chartName} tabIndex={disabled ? -1 : 0} aria-describedby={helpId}
        data-view-x={viewedDomain(domains.x, view.x).join(",")} data-view-y={viewedDomain(domains.y, view.y).join(",")}
        onKeyDown={chartKey}
        onPointerDown={(event) => {
          if (!panning || disabled || event.button !== 0) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          drag.current = { x: event.clientX, y: event.clientY, view, width: bounds.width * plotWidth / width,
            height: bounds.height * plotHeight / height, moved: false };
          event.currentTarget.setPointerCapture?.(event.pointerId); event.preventDefault(); event.currentTarget.focus();
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || !start.width || !start.height) return;
          start.moved = start.moved || Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 3;
          onViewChange(panChartView(start.view, (start.x - event.clientX) / start.width, (event.clientY - start.y) / start.height, domains, histogram));
        }}
        onPointerUp={(event) => { drag.current = null; if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; }} onPointerLeave={() => { if (!drag.current) setTooltip(null); }}>
        <defs><clipPath id={clip}><rect x={box.left - 5} y={box.top - 5} width={plotWidth + 10} height={plotHeight + 10} /></clipPath></defs>
        {yTicks.map(({ value, position }) => <g key={value} className="population-tick">
          <line className="population-grid-line" x1={box.left} x2={box.right} y1={box.bottom - position * plotHeight} y2={box.bottom - position * plotHeight} />
          <text x={box.left - 9} y={box.bottom - position * plotHeight + 4} textAnchor="end">{populationNumber(value)}</text>
        </g>)}
        <path className="population-axis" d={`M${box.left} ${box.top}V${box.bottom}H${box.right}`} />
        {xTicks.map(({ value, position }) => <g key={value} className="population-tick">
          <line className="population-axis" x1={box.left + position * plotWidth} x2={box.left + position * plotWidth} y1={box.bottom} y2={box.bottom + 4} />
          <text x={box.left + position * plotWidth} y={box.bottom + 21} textAnchor={position === 0 ? "start" : position === 1 ? "end" : "middle"}>{populationNumber(value)}</text>
        </g>)}
        <g clipPath={`url(#${clip})`}>
          {histogram ? data.histogram.counts.map((count, index) => {
            const low = data.histogram.edges[index], high = data.histogram.edges[index + 1];
            const left = constantX ? box.left + plotWidth * 0.4 : Math.max(box.left, xPosition(low));
            const right = constantX ? box.left + plotWidth * 0.6 : Math.min(box.right, xPosition(high));
            if (right <= left) return null;
            const label = `${populationNumber(low)} to ${populationNumber(high)}: ${count} objects. Filter to this bin`;
            const allowed = count > 0 && !disabled && !panning;
            return <g key={index} role="button" tabIndex={allowed ? 0 : -1} aria-disabled={!allowed} aria-label={label}
              onClick={() => { if (allowed) onBinChoose(index); }} onFocus={() => setTooltip(label)}
              onPointerEnter={() => { if (!panning) setTooltip(label); }}
              onKeyDown={(event) => { if (allowed && ["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onBinChoose(index); } }}>
              <rect className="population-bin-hit" x={left} y={box.top} width={right - left} height={plotHeight} />
              <rect className="population-bin" x={left + Math.min(1, (right - left) / 4)} y={yPosition(count)}
                width={Math.max(0.25, right - left - Math.min(2, (right - left) / 2))} height={box.bottom - yPosition(count)} />
              <title>{label}</title>
            </g>;
          }) : visiblePoints.map((point, index) => <circle key={point.label} role="button"
            tabIndex={!disabled && !panning && point.label === focusLabel ? 0 : -1} data-point-label={point.label}
            aria-label={`Object ${point.label}: ${populationNumber(point.x)}, ${populationNumber(point.y)}`}
            aria-pressed={point.label === selectedLabel} aria-disabled={disabled || panning}
            className={point.label === selectedLabel ? "population-point selected" : "population-point"}
            cx={xPosition(point.x)} cy={yPosition(point.y)} r={point.label === selectedLabel ? 5 : 3.5}
            onPointerEnter={() => { if (!panning) setTooltip(`Object #${point.label} · ${xLabel}: ${populationNumber(point.x)} · ${yLabel}: ${populationNumber(point.y)}`); }}
            onFocus={() => { setKeyboardLabel(point.label); setTooltip(`Object #${point.label} · ${populationNumber(point.x)}, ${populationNumber(point.y)}`); }}
            onClick={() => { if (!disabled && !panning) onSelect(point.label); }}
            onKeyDown={(event) => {
              if (disabled || panning) return;
              if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onSelect(point.label); }
              else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                const next = visiblePoints[(index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? visiblePoints.length - 1 : 1)) % visiblePoints.length];
                plot.current?.querySelector<SVGCircleElement>(`[data-point-label="${next.label}"]`)?.focus();
              }
            }} />)}
        </g>
        <text className="population-axis-title" x={(box.left + box.right) / 2} y={height - 8} textAnchor="middle"><title>{xLabel}</title>{shortAxis(xLabel, plotWidth)}</text>
        <text className="population-axis-title" transform={`translate(14 ${(box.top + box.bottom) / 2}) rotate(-90)`} textAnchor="middle"><title>{yLabel}</title>{shortAxis(yLabel, plotHeight)}</text>
      </svg> : <p className="population-chart-empty">{histogram ? `No finite ${xMetric?.label ?? "measurement"} values match these ranges.` : "No objects have finite values for both axes."}</p>}
    </div>
    <p className="population-chart-readout" aria-live="polite">{tooltip || (full ? "Full data view" : "Zoomed view · filters unchanged")}</p>
    <p className="population-note" id={helpId}>{panning ? "Drag to pan. Turn Pan off to select objects or filter a bar." : histogram
      ? "Choose a bar to filter its exact range. Zoom changes the view only."
      : "Choose a point to select an object. Arrow keys move between points; Enter selects."} <span className="population-chart-keyboard">Focus the chart: +/− zoom, arrows pan, Home resets.</span></p>
    <p className="population-note population-chart-accounting">{histogram ? `${data.histogram.finite_count} finite values · ${data.histogram.missing_count} missing. Counts use all matching objects.`
      : `${data.accounting.scatter_missing_count} objects missing an axis value. ${data.scatter.sampled
        ? `Display sample: ${data.scatter.displayed_count} of ${data.scatter.total_count} valid pairs, evenly spaced in label order. Counts and distribution use the full filtered population.`
        : "All finite pairs are shown."}`}</p>
  </section>;
}
