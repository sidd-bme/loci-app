import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi } from "../shared/research-contracts";
import { statisticsFigurePixels, type StatisticsFigureExportReceipt, type StatisticsFigureExportRequest } from "../shared/statistics-figure-contracts";
import type { PopulationResponse } from "./ResearchPopulationExplorer";
import { populationChartDomains } from "./PopulationChart";
import { viewedDomain, type ChartView } from "./population-chart-view";

export default function PopulationFigureExport({ api, data, histogramView, scatterView, disabled }: {
  api: ResearchDesktopApi; data: PopulationResponse; histogramView: ChartView; scatterView: ChartView; disabled: boolean;
}) {
  const [chart, setChart] = useState<"histogram" | "scatter">("histogram");
  const [domainMode, setDomainMode] = useState<"full" | "current">("full");
  const [size, setSize] = useState("single");
  const [width, setWidth] = useState("85");
  const [height, setHeight] = useState("65");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<StatisticsFigureExportReceipt | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const binding = `${data.result_id}:${data.revision_hash}:${data.source_sha256}:${data.query_sha256}`;
  const scope = useRef(binding); scope.current = binding;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setReceipt(null); setCancelled(false); setError(null); }, [binding, chart, domainMode, width, height]);
  let pixels: [number, number] | null = null;
  let dimensionError: string | null = null;
  try { pixels = statisticsFigurePixels(width.trim() ? Number(width) : NaN, height.trim() ? Number(height) : NaN); }
  catch (caught) { dimensionError = caught instanceof Error ? caught.message : "Choose valid figure dimensions."; }
  const hasValues = chart === "histogram" ? data.histogram.finite_count > 0 : data.scatter.displayed_count > 0;
  const exportFigure = async (event: React.FormEvent) => {
    event.preventDefault();
    if (dimensionError) { setError(dimensionError); return; }
    if (disabled || busy || !api.exportStatisticsFigure || !pixels || !hasValues) return;
    setBusy(true); setError(null); setReceipt(null); setCancelled(false);
    const originalScope = binding;
    const full = populationChartDomains(data, chart === "histogram");
    const view = chart === "histogram" ? histogramView : scatterView;
    const request: StatisticsFigureExportRequest = {
      schema_version: "loci.statistics-figure-request/v1", source_id: data.source_id, source_sha256: data.source_sha256,
      result_id: data.result_id, revision_hash: data.revision_hash, query: { ...data.query, sort: data.query.sort ?? null },
      query_sha256: data.query_sha256, membership_sha256: data.membership_sha256, chart,
      domain: domainMode === "full" ? { mode: "full" } : { mode: "current", x: viewedDomain(full.x, view.x), y: viewedDomain(full.y, view.y) },
      width_mm: Number(width), height_mm: Number(height), preset: "publication-monochrome",
    };
    try {
      const result = await api.exportStatisticsFigure(request);
      if (!mounted.current || scope.current !== originalScope) return;
      if (result === null) { setCancelled(true); return; }
      const hash = /^[a-f0-9]{64}$/;
      if (result.schema_version !== "loci.statistics-figure-receipt/v1" || result.result_id !== request.result_id ||
        result.revision_hash !== request.revision_hash || result.source_id !== request.source_id || result.source_sha256 !== request.source_sha256 ||
        result.query_sha256 !== request.query_sha256 || result.membership_sha256 !== request.membership_sha256 ||
        result.width_mm !== request.width_mm || result.height_mm !== request.height_mm || result.width_px !== pixels[0] || result.height_px !== pixels[1] || result.dpi !== 600 ||
        typeof result.basename !== "string" || !result.basename || /[/\\\u0000-\u001f]/.test(result.basename) ||
        !result.artifacts || Object.keys(result.artifacts).sort().join(",") !== "figure.png,figure.svg,manifest.json" ||
        Object.values(result.artifacts).some((artifact) => !artifact || !hash.test(artifact.sha256) || !Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes <= 0))
        throw new Error("The figure receipt does not match this query and output size. Check the saved bundle before using it.");
      setReceipt(result);
    } catch (caught) { if (mounted.current && scope.current === originalScope) setError(caught instanceof Error ? caught.message : "Could not export this figure. Try again."); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <details className="population-figure-export">
    <summary><Download size={15} />Export a publication figure</summary>
    <form onSubmit={(event) => void exportFigure(event)} aria-label="Statistics figure export">
      <p className="population-note">A monochrome SVG and 600-DPI PNG, with axis labels and units. Source and query provenance are saved alongside the figure.</p>
      <div className="population-export-fields">
        <label>Chart<select aria-label="Figure chart" value={chart} disabled={busy} onChange={(event) => { setChart(event.target.value as typeof chart); setReceipt(null); }}>
          <option value="histogram">Distribution</option><option value="scatter">Relationship</option></select></label>
        <label>Display domain<select aria-label="Figure display domain" value={domainMode} disabled={busy} onChange={(event) => setDomainMode(event.target.value as typeof domainMode)}>
          <option value="full">Full data range</option><option value="current">Current chart view</option></select></label>
        <label className="population-export-size">Size<select aria-label="Figure size preset" value={size} disabled={busy} onChange={(event) => {
          const next = event.target.value; setSize(next); setError(null);
          if (next === "single") { setWidth("85"); setHeight("65"); }
          if (next === "double") { setWidth("180"); setHeight("110"); }
        }}><option value="single">Single column · 85 × 65 mm</option><option value="double">Double column · 180 × 110 mm</option><option value="custom">Custom size</option></select></label>
        <label>Width (mm)<input aria-label="Figure width in millimetres" inputMode="decimal" value={width} disabled={busy}
          onChange={(event) => { setWidth(event.target.value); setSize("custom"); setError(null); }} /></label>
        <label>Height (mm)<input aria-label="Figure height in millimetres" inputMode="decimal" value={height} disabled={busy}
          onChange={(event) => { setHeight(event.target.value); setSize("custom"); setError(null); }} /></label>
      </div>
      <p className="population-note">{pixels ? `${pixels[0].toLocaleString()} × ${pixels[1].toLocaleString()} px · No title or caption` : dimensionError}</p>
      {domainMode === "current" && <p className="population-note">Uses the visible axes without changing filters or recomputing histogram bins. The full query remains in the provenance.</p>}
      {chart === "scatter" && data.scatter.sampled && <p className="population-note">Exports the same {data.scatter.displayed_count.toLocaleString()}-point display sample; full counts are recorded in the provenance.</p>}
      {!hasValues && <p className="population-note">There are no finite values to export for this chart. Change the metrics or ranges.</p>}
      {!api.exportStatisticsFigure && <p className="population-note">Figure export is unavailable in this session.</p>}
      <button type="submit" className="btn-primary" disabled={disabled || busy || !hasValues || !api.exportStatisticsFigure}>
        <Download size={15} />{busy ? "Exporting figure…" : "Export SVG + PNG…"}</button>
      {busy && <p role="status">Verifying the query and preparing your figure…</p>}
      {cancelled && <p role="status">Export cancelled.</p>}
      {error && <p role="alert">{error}</p>}
      {receipt && <p role="status">Saved {receipt.basename} · SVG, {receipt.width_px.toLocaleString()} × {receipt.height_px.toLocaleString()} PNG and provenance.</p>}
    </form>
  </details>;
}
