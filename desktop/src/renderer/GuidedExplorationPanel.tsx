import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchRecipe, ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { ValidatedNumberInput } from "./ValidatedNumberInput";
import PopulationChartDialog from "./PopulationChartDialog";
import "./GuidedExplorationPanel.css";

type Configuration = { threshold: number; min_size: number };
type SizeSummary = { count: number; measure_kind: string; measure_unit: string; total: number; mean: number | null; median: number | null; min: number | null; max: number | null; border_object_count: number };
export type ExplorationReceipt = { schema: "loci.exploration-preview/v1"; source_id: string; source_sha256: string; selection: ResearchSelection; effective_recipe: ResearchRecipe; object_count: number; receipt_sha256: string; size_summary: SizeSummary; [key: string]: unknown };
export type ExplorationCell = { image: string; label_image: string; object_count: number; size_summary: SizeSummary; receipt: ExplorationReceipt; receipt_json: string; region_index?: number; configuration_index?: number };
type Props = { api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection; busy: boolean;
  onBusy: (message: string | null) => void; onResult: (result: ResearchResult, rows: Record<string, unknown>[]) => Promise<void>;
  onUse: (recipe: ResearchRecipe, selection: ResearchSelection) => void; onSelection?: (selection: ResearchSelection) => void; onDrawRegion?: () => void };
const exact = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const number = (value: number | null) => value === null ? "—" : value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
export function checkedExplorationCell(value: unknown, source: ResearchSource, selection: ResearchSelection, configuration?: Configuration): ExplorationCell {
  const cell = value as ExplorationCell;
  const receipt = cell?.receipt;
  if (!cell || !receipt || receipt.schema !== "loci.exploration-preview/v1" || receipt.source_id !== source.id || receipt.source_sha256 !== source.sha256 ||
    exact(receipt.selection) !== exact(selection) || !/^[a-f0-9]{64}$/.test(receipt.receipt_sha256) ||
    !Number.isSafeInteger(cell.object_count) || cell.object_count < 0 || receipt.object_count !== cell.object_count ||
    !cell.image?.startsWith("data:image/png;base64,") || !cell.label_image?.startsWith("data:image/png;base64,") ||
    !cell.size_summary || cell.size_summary.count !== cell.object_count || exact(cell.size_summary) !== exact(receipt.size_summary))
    throw new Error("The preview does not match the exact source, region and measurements. Preview again.");
  const segmentation = receipt.effective_recipe?.segmentation;
  if (configuration && (!segmentation || segmentation.method !== "components" || segmentation.threshold !== configuration.threshold || segmentation.min_size !== configuration.min_size))
    throw new Error("The preview parameters do not match the requested configuration. Preview again.");
  const geometry = receipt.geometry as { axes?: string; unit?: string; affine?: unknown } | undefined;
  const summary = cell.size_summary;
  if (!geometry || geometry.axes !== "YX" || !Array.isArray(geometry.affine) || geometry.affine.length !== 4 ||
    geometry.affine.some((row) => !Array.isArray(row) || row.length !== 4 || row.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) ||
    summary.measure_kind !== "area" || summary.measure_unit !== `${geometry.unit}^2` || !Number.isFinite(summary.total) || summary.total < 0 ||
    !Number.isSafeInteger(summary.border_object_count) || summary.border_object_count < 0 || summary.border_object_count > summary.count ||
    (summary.count === 0 ? summary.total !== 0 || [summary.mean, summary.median, summary.min, summary.max].some((value) => value !== null) :
      [summary.mean, summary.median, summary.min, summary.max].some((value) => value === null || !Number.isFinite(value) || value < 0) || summary.min! > summary.max!))
    throw new Error("The preview geometry or size summary is inconsistent. Preview again.");
  if (typeof cell.receipt_json !== "string" || exact(JSON.parse(cell.receipt_json)) !== exact(receipt))
    throw new Error("The exact receipt encoding does not match the preview. Preview again.");
  return cell;
}
export function GuidedExplorationPanel(props: Props) {
  return <Exploration key={`${props.source.id}:${props.source.sha256}`} {...props} />;
}
function Exploration({ api, source, selection, busy, onBusy, onResult, onUse, onSelection, onDrawRegion }: Props) {
  const initialThreshold = source.metadata.channel_dtypes?.[selection.c] === "uint16" ? 1000 : 64;
  const [configurations, setConfigurations] = useState<Configuration[]>([{ threshold: initialThreshold, min_size: 4 }, { threshold: initialThreshold * 2, min_size: 4 }, { threshold: initialThreshold * 3, min_size: 4 }]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedComparisons, setSavedComparisons] = useState<Array<{ id: string; updated_at: string; region_count: number; configuration_count: number }>>([]);
  const [regions, setRegions] = useState<ResearchSelection[]>([]);
  const [cells, setCells] = useState<ExplorationCell[]>([]);
  const [receipt, setReceipt] = useState<unknown>(null);
  const [receiptJson, setReceiptJson] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [outputScope, setOutputScope] = useState("");
  const mounted = useRef(true), generation = useRef(0), lock = useRef(false);
  const submitted = useRef<{ operation: string; request: Record<string, unknown>; key: string } | null>(null);
  const execute = (operation: string, request: Record<string, unknown>) => {
    const key = `exploration:${crypto.randomUUID()}`;
    submitted.current = { operation, request: structuredClone(request), key };
    return api.execute(operation, request, { request_key: key });
  };
  const cancelTask = async (captured: NonNullable<typeof submitted.current>) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!lock.current) return;
      const snapshot = await api.getSnapshot();
      const job = snapshot?.jobs.find((item) => item.request_key === captured.key && item.operation === captured.operation &&
        item.request.source_id === source.id && exact(item.request.task_request) === exact(captured.request));
      if (job) { if (["running", "queued"].includes(job.state)) await api.cancelJob(job.id); return; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const scope = exact({ source: [source.id, source.sha256], selection, configurations, regions, drafts });
  const liveScope = useRef(scope);
  if (liveScope.current !== scope) { liveScope.current = scope; generation.current++; }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => () => {
    const captured = submitted.current;
    if (lock.current && captured) void cancelTask(captured).catch(() => {});
  }, [scope]);
  const rgb = ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "");
  const supported = source.source_kind === "native" && !rgb && selection.z_stop === undefined;
  const regionValid = selection.width <= 512 && selection.height <= 512 && selection.width > 0 && selection.height > 0;
  const invalid = Object.keys(drafts).length > 0;
  const outdated = outputScope !== scope;
  const perform = async (label: string, work: (current: () => boolean) => Promise<void>) => {
    if (lock.current || busy) return;
    lock.current = true; const token = ++generation.current, captured = liveScope.current;
    const current = () => mounted.current && token === generation.current && captured === liveScope.current;
    setPending(label); setError(""); setNotice(""); onBusy(label);
    try { await work(current); } catch (caught) { if (current()) setError(caught instanceof Error ? caught.message : "Exploration stopped. Check the region and preview again."); }
    finally { lock.current = false; if (mounted.current) setPending(""); onBusy(null); }
  };
  const preview = () => perform("Previewing region", async (current) => {
    const value = await execute("exploration_preview", { source_id: source.id, source_sha256: source.sha256, selection: structuredClone(selection), ...configurations[0] });
    const cell = checkedExplorationCell(value, source, selection, configurations[0]);
    if (!current()) return;
    setCells([cell]); setReceipt(cell.receipt); setReceiptJson(cell.receipt_json); setOutputScope(liveScope.current); setNotice(`${cell.object_count} objects in draft preview. No result has been adopted.`);
  });
  const compare = () => perform("Comparing regions", async (current) => {
    const output = await execute("exploration_compare", { source_id: source.id, source_sha256: source.sha256, regions: structuredClone(regions), configurations }) as { cells: ExplorationCell[]; receipt: Record<string, unknown>; receipt_json: string };
    if (!Array.isArray(output.cells) || output.cells.length !== regions.length * configurations.length || output.receipt?.source_id !== source.id || output.receipt.source_sha256 !== source.sha256)
      throw new Error("The comparison is incomplete or belongs to a different source. Compare again.");
    if (exact(output.receipt.regions) !== exact(regions) || exact(output.receipt.configurations) !== exact(configurations))
      throw new Error("The comparison receipt does not match the requested regions and settings.");
    const checked = output.cells.map((cell, index) => {
      const regionIndex = Math.floor(index / configurations.length), configIndex = index % configurations.length;
      if (cell.region_index !== regionIndex || cell.configuration_index !== configIndex) throw new Error("Comparison region/configuration order is invalid.");
      return checkedExplorationCell(cell, source, regions[regionIndex], configurations[configIndex]);
    });
    if (!current()) return;
    if (typeof output.receipt_json !== "string" || exact(JSON.parse(output.receipt_json)) !== exact(output.receipt)) throw new Error("The comparison encoding does not match its record.");
    setCells(checked); setReceipt(output.receipt); setReceiptJson(output.receipt_json); setOutputScope(liveScope.current); setNotice("Comparison saved in this study. Choose a configuration and region to adopt.");
  });
  const adopt = (cell: ExplorationCell) => perform("Adopting exact configuration", async (current) => {
    const output = await execute("exploration_run", { receipt_json: cell.receipt_json }) as { result: ResearchResult; measurements: Record<string, unknown>[] };
    if (!output.result || output.result.source_id !== source.id || output.result.source_sha256 !== source.sha256 || exact(output.result.selection) !== exact(cell.receipt.selection))
      throw new Error("The adopted result does not match the preview region. Refresh the study to inspect saved results.");
    if (!current()) return;
    await onResult(output.result, output.measurements); if (current()) setNotice("Exact configuration adopted as an unreviewed result.");
  });
  const cancel = async () => {
    generation.current++; setNotice("Discarding this pending preview. Saved comparisons remain in the study.");
    const captured = submitted.current;
    if (!captured) return;
    await cancelTask(captured);
  };
  const loadComparisons = async () => {
    try {
      const output = await api.execute("exploration_list", { source_id: source.id, source_sha256: source.sha256 }) as { comparisons: typeof savedComparisons };
      if (!Array.isArray(output.comparisons)) throw new Error("Could not read saved comparisons.");
      if (mounted.current) setSavedComparisons(output.comparisons);
    } catch (caught) { if (mounted.current) setError(String(caught)); }
  };
  const openComparison = async (id: string) => {
    try {
      const output = await api.execute("exploration_get", { source_id: source.id, source_sha256: source.sha256, comparison_id: id }) as { comparison: { id: string; data: Record<string, unknown> }; comparison_json: string };
      const value = output.comparison?.data;
      if (!value || output.comparison.id !== id || typeof output.comparison_json !== "string" || value.source_id !== source.id || value.source_sha256 !== source.sha256) throw new Error("The saved comparison does not match this source.");
      const encoded = JSON.parse(output.comparison_json);
      if (encoded.id !== id || exact(encoded.data) !== exact(value)) throw new Error("The saved comparison encoding is inconsistent.");
      if (mounted.current) { setReceipt(value); setReceiptJson(output.comparison_json); setNotice("Saved comparison record opened. Download its exact source, regions, settings and descriptive summaries below."); }
    } catch (caught) { if (mounted.current) setError(String(caught)); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([receiptJson], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "loci-exploration.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const contactSheet = () => <div className="exploration-contact-sheet">{cells.map((cell, index) => <article key={index} aria-label={`Comparison region ${(cell.region_index ?? 0) + 1} setting ${(cell.configuration_index ?? 0) + 1}`}>
    <h4>Region {(cell.region_index ?? 0) + 1} · Setting {(cell.configuration_index ?? 0) + 1}</h4>
    <p>Threshold {String(cell.receipt.effective_recipe.segmentation?.threshold)} · minimum area {String(cell.receipt.effective_recipe.segmentation?.min_size)} {cell.size_summary.measure_unit}</p>
    <div className="exploration-images"><img src={cell.image} alt="Processed raw-channel preview" /><img src={cell.label_image} alt="Draft object labels over image" /></div>
    <p>{cell.object_count} objects · mean {number(cell.size_summary.mean)} {cell.size_summary.measure_unit} · {cell.size_summary.border_object_count} touch the edge</p>
    <div className="exploration-actions"><button type="button" disabled={busy || outdated} onClick={() => { setExpanded(false); void adopt(cell); }}>Adopt this region</button>
      <button type="button" disabled={busy || outdated} onClick={() => { setExpanded(false); onUse(cell.receipt.effective_recipe, cell.receipt.selection); }}>Use settings in Analyze</button></div>
  </article>)}</div>;
  return <section className="guided-exploration" aria-label="Guided segmentation exploration">
    <h3>Try settings on regions</h3>
    <p>Connected components · bright objects · raw channel {selection.c + 1} · T {selection.t + 1} · Z {selection.z + 1}</p>
    {!supported ? <p>Choose a native scalar image and a single plane for guided exploration. Other supported methods remain below.</p> : <>
      <p className="exploration-scope">Current ROI: X {selection.x}, Y {selection.y}, {selection.width} × {selection.height} pixels · level {selection.level}</p>
      {onSelection && <details className="exploration-region-editor"><summary>Region &amp; plane</summary><p>Coordinates and C/Z/T indices are zero-based; crop ends are exclusive.</p>
        <div className="exploration-configurations">{(["x", "y", "width", "height", "c", "z", "t"] as const).map((field) => {
          const dimensions = source.metadata.dimensions;
          const size = field === "x" || field === "width" ? dimensions?.x ?? 1 : field === "y" || field === "height" ? dimensions?.y ?? 1 : dimensions?.[field] ?? 1;
          const maximum = field === "x" ? size - selection.width : field === "y" ? size - selection.height : field === "width" ? Math.min(512, size - selection.x) : field === "height" ? Math.min(512, size - selection.y) : size - 1;
          return <label key={field}>{field.toUpperCase()}<ValidatedNumberInput label={`Exploration ROI ${field}`} value={selection[field]} integer minimum={field === "width" || field === "height" ? 1 : 0} maximum={maximum} disabled={Boolean(pending)} onValue={(value) => { onSelection({ ...selection, [field]: value }); return true; }} /></label>;
        })}</div>
      </details>}
      {onDrawRegion && <button type="button" disabled={Boolean(pending)} onClick={onDrawRegion}>Draw preview region</button>}
      {!regionValid && <p role="status">Draw or set a region no larger than 512 × 512 pixels.</p>}
      <div className="exploration-configurations" aria-label="Comparison configurations">
        {configurations.map((configuration, index) => <fieldset key={index}><legend>Setting {index + 1}</legend>
          {(["threshold", "min_size"] as const).map((field) => {
            const key = `${index}:${field}`;
            return <label key={field}>{field === "threshold" ? "Threshold (raw units)" : `Minimum area (${source.metadata.physical_calibration?.unit ?? source.metadata.levels?.find((level) => level.index === selection.level)?.calibration?.unit ?? "pixel"}²)`}<input aria-label={`Setting ${index + 1} ${field === "threshold" ? "threshold" : "minimum area"}`} inputMode="decimal"
              value={drafts[key] ?? String(configuration[field])} aria-invalid={key in drafts} disabled={Boolean(pending)}
              onChange={(event) => {
                const text = event.target.value, value = Number(text);
                if (text.trim() && Number.isFinite(value) && (field !== "min_size" || value > 0)) {
                  setConfigurations((old) => old.map((item, i) => i === index ? { ...item, [field]: value } : item));
                  setDrafts((old) => { const next = { ...old }; delete next[key]; return next; });
                } else setDrafts((old) => ({ ...old, [key]: text }));
              }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setDrafts((old) => { const next = { ...old }; delete next[key]; return next; }); } }} /></label>;
          })}
        </fieldset>)}
      </div>
      {invalid && <p role="alert">Enter finite thresholds and positive areas. Escape restores the applied value.</p>}
      <div className="exploration-actions"><button type="button" disabled={busy || invalid || !regionValid} onClick={() => void preview()}>Preview setting 1</button>
        <button type="button" disabled={busy || !regionValid || regions.length >= 3 || regions.some((region) => exact(region) === exact(selection)) || regions.some((region) => ["c", "t", "z", "level"].some((key) => region[key as keyof ResearchSelection] !== selection[key as keyof ResearchSelection]))}
          onClick={() => setRegions((old) => [...old, structuredClone(selection)])}>Add current ROI ({regions.length}/3)</button></div>
      {regions.length > 0 && <ol className="exploration-regions">{regions.map((region, index) => <li key={index}>Region {index + 1}: X {region.x}, Y {region.y}, {region.width} × {region.height} · C {region.c + 1}/Z {region.z + 1}/T {region.t + 1}
        <button type="button" aria-label={`Remove comparison region ${index + 1}`} disabled={Boolean(pending)} onClick={() => setRegions((old) => old.filter((_, i) => i !== index))}>Remove</button></li>)}</ol>}
      <button type="button" disabled={busy || invalid || !regions.length} onClick={() => void compare()}>Compare {regions.length || "selected"} regions × 3 settings</button>
    </>}
    <details className="exploration-saved" onToggle={(event) => { if (event.currentTarget.open) void loadComparisons(); }}><summary>Saved comparisons</summary>
      {!savedComparisons.length && <p>No comparison records loaded for this source. Run a comparison to save one.</p>}
      {savedComparisons.map((item) => <p key={item.id}>{item.region_count} regions × {item.configuration_count} settings · {item.updated_at.slice(0, 16)} <button type="button" disabled={busy} onClick={() => void openComparison(item.id)}>Open comparison record</button></p>)}
      {receipt !== null && <button type="button" onClick={download}>Download saved record</button>}
    </details>
    {pending && <p role="status">{pending}… <button type="button" onClick={() => void cancel().catch((caught) => setError(String(caught)))}>Cancel exploration</button></p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {cells.length > 0 && <><p>{outdated ? "Previous preview: source, plane, region or settings changed. Preview again before adoption." : "Draft comparison · crop-local execution, zero halo. Border objects are retained and measured as clipped."}</p>
      {cells.length > 1 && <button type="button" onClick={() => setExpanded(true)}>Enlarge parameter comparison</button>}
      {contactSheet()}
      <button type="button" onClick={download}>Download comparison record</button>
      <p className="exploration-note">Counts and sizes describe these crops. Crop context can change segmentation; this sample does not measure accuracy. Save chosen settings with the existing recipe controls below.</p>
    </>}
    {expanded && <PopulationChartDialog title="Parameter comparison" closeLabel="Close parameter comparison" onClose={() => setExpanded(false)}>
      <div className="exploration-expanded">{outdated && <p role="status">The source plane, ROI or settings changed. Close and compare again before adoption.</p>}<p>{source.name} · C {(cells[0]?.receipt.selection.c ?? 0) + 1} / Z {(cells[0]?.receipt.selection.z ?? 0) + 1} / T {(cells[0]?.receipt.selection.t ?? 0) + 1}. Left: image; right: draft labels. Each column is one setting; each row is one ROI.</p>{contactSheet()}
        <p>Crop-local connected components, zero halo. Border objects retained. Counts and sizes describe these regions.</p></div>
    </PopulationChartDialog>}
  </section>;
}
