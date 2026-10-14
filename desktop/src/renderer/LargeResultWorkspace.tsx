import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { ResearchDesktopApi, ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import "./LargeResultWorkspace.css";
import { resultTitle } from "./result-title";

type Row = Record<string, unknown>;
type Region = { x: number; y: number; width: number; height: number };
type LargeView = { result_id: string; revision_hash: string; image: string; region: Region; shape: number[]; image_shape: number[]; step: number };
const bytes = (value: number) => `${(value / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
const message = (error: unknown) => error instanceof Error ? error.message : "The operation failed.";
export const isLargeResult = (result: ResearchResult | null | undefined) => result?.schema === "loci.research-result/v2";

export function LargeAnalysisPanel({ api, source, selection, busy, onBusy, onError, onRunStart, onResult }: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection; busy: boolean;
  onBusy: (value: string | null) => void; onError: (value: string) => void;
  onRunStart: () => number; onResult: (result: ResearchResult, intent: number) => Promise<void>;
}) {
  const [threshold, setThreshold] = useState("100");
  const [minimum, setMinimum] = useState("0");
  const [polarity, setPolarity] = useState("bright");
  const [border, setBorder] = useState(false);
  const [plan, setPlan] = useState<{ decoded_labels_bytes: number; disk_required_bytes: number } | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const request = useMemo(() => ({ source_id: source.id, selection,
    segmentation: { method: "components", threshold: Number(threshold), polarity, min_size: Number(minimum), exclude_border: border }, working_bytes: 256 * 1024 ** 2 }), [source.id, selection, threshold, polarity, minimum, border]);
  const requestKey = JSON.stringify(request);
  const [approvedKey, setApprovedKey] = useState("");
  useEffect(() => {
    let current = true;
    setApprovedKey(""); setPlan(null); setIssue(null);
    if (!threshold.trim() || !minimum.trim() || !Number.isFinite(Number(threshold)) || !Number.isFinite(Number(minimum)) || Number(minimum) < 0) {
      setIssue("Enter a finite threshold and non-negative minimum area.");
      return;
    }
    const timer = setTimeout(() => {
      void api.execute("large_components_preflight", request).then((value) => {
        if (current) { setPlan(value as typeof plan); setApprovedKey(requestKey); }
      }).catch((error) => { if (current) setIssue(message(error)); });
    }, 180);
    return () => { current = false; clearTimeout(timer); };
    // The canonical request key avoids rechecking identical parent selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, requestKey]);
  const run = async () => {
    if (busy || approvedKey !== requestKey) return;
    const intent = onRunStart();
    onBusy("Large image segmentation");
    try {
      const output = await api.execute("large_components_run", request) as { result: ResearchResult };
      if (!isLargeResult(output.result) || output.result.source_id !== source.id) throw new Error("The returned result does not match this source.");
      await onResult(output.result, intent);
    } catch (error) { onError(message(error)); }
    finally { onBusy(null); }
  };
  const importRemote = async () => {
    if (busy || !api.importLargeResult) return;
    const intent = onRunStart();
    onBusy("Importing remote result");
    try {
      const outcome = await api.importLargeResult(source.id);
      if (!outcome) return;
      if (!isLargeResult(outcome.result) || outcome.result.source_id !== source.id) {
        throw new Error("The returned result does not match this source.");
      }
      await onResult(outcome.result, intent);
    } catch (error) { onError(message(error)); }
    finally { onBusy(null); }
  };
  return <section className="research-panel large-analysis" aria-label="Large image analysis">
    <h3>Threshold segmentation</h3>
    <p>Native channel {selection.c + 1} · Z {selection.z + 1} · T {selection.t + 1}. Four-connected objects across the entire selected region.</p>
    <label>Threshold in raw source values<input aria-label="Large image threshold" type="number" value={threshold} disabled={busy} onChange={(event) => setThreshold(event.target.value)} /></label>
    <div className="research-grid">
      <label>Foreground<select aria-label="Large foreground" value={polarity} disabled={busy} onChange={(event) => setPolarity(event.target.value)}><option value="bright">Above threshold</option><option value="dark">Below threshold</option></select></label>
      <label>Minimum area ({source.metadata.physical_calibration?.unit || "physical unit"}²)<input aria-label="Large minimum area" type="number" min="0" value={minimum} disabled={busy} onChange={(event) => setMinimum(event.target.value)} /></label>
    </div>
    <label className="large-check"><input type="checkbox" checked={border} disabled={busy} onChange={(event) => setBorder(event.target.checked)} />Exclude objects touching the selected region’s border</label>
    <p className="large-method-note">Raw uint8/uint16 tiled OME-TIFF with physical calibration. One plane and channel; display colours and contrast do not alter analysis.</p>
    {plan && <dl className="large-facts"><dt>Working allowance</dt><dd>256 MiB</dd><dt>Decoded labels</dt><dd>{bytes(plan.decoded_labels_bytes)}</dd><dt>Required disk headroom</dt><dd>{bytes(plan.disk_required_bytes)}</dd></dl>}
    <p role="status">{issue ?? (!plan ? "Checking source and resources…" : "Objects are reconciled across all tile boundaries before filtering and measurement.")}</p>
    <div className="large-actions">
      <button className="research-primary" disabled={busy || approvedKey !== requestKey} onClick={() => void run()}>{busy ? "Running…" : "Segment large image"}</button>
      {Boolean(api.importLargeResult) && (
        <button type="button" className="research-secondary" disabled={busy} onClick={() => void importRemote()}>
          Import remote result…
        </button>
      )}
    </div>
  </section>;
}

export function clampLargeRegion(region: Region, width: number, height: number): Region {
  const w = Math.max(1, Math.min(width, Math.round(region.width)));
  const h = Math.max(1, Math.min(height, Math.round(region.height)));
  return { x: Math.max(0, Math.min(width - w, Math.round(region.x))), y: Math.max(0, Math.min(height - h, Math.round(region.y))), width: w, height: h };
}
export function largeDisplayPixel(view: LargeView, x: number, y: number): { u: number; v: number } | null {
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return null;
  return { u: view.region.x + Math.floor(x * view.image_shape[1]) * view.step,
    v: view.region.y + Math.floor(y * view.image_shape[0]) * view.step };
}
export function fittedLargeImageSize(imageShape: number[], stageWidth: number, stageHeight: number): { width: number; height: number } | null {
  const [height, width] = imageShape;
  if (![height, width, stageWidth, stageHeight].every((value) => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.min(stageWidth / width, stageHeight / height);
  return { width: width * scale, height: height * scale };
}

export function LargeResultViewport({ api, result, focus, onPickStart, onPick }: {
  api: ResearchDesktopApi; result: ResearchResult; focus: { point_index: number[] } | null;
  onPickStart: () => number; onPick: (row: Row | null, intent: number) => void;
}) {
  const [height, width] = result.arrays!.image.shape!;
  const [region, setRegion] = useState<Region>({ x: 0, y: 0, width, height });
  const [labels, setLabels] = useState(true);
  const [view, setView] = useState<LargeView | null>(null);
  const [decodedKey, setDecodedKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify({ id: result.id, revision: result.revision_hash, region, labels, retry });
  const [paintedKey, setPaintedKey] = useState("");
  const ready = decodedKey === key && paintedKey === key && view?.revision_hash === result.revision_hash;
  const imageSize = view ? fittedLargeImageSize(view.image_shape, stageSize.width, stageSize.height) : null;
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      setStageSize({ width: bounds.width, height: bounds.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const zoom = (factor: number, center?: number[]) => setRegion((current) => clampLargeRegion({
    width: current.width * factor, height: current.height * factor,
    x: (center?.[1] ?? current.x + current.width / 2) - current.width * factor / 2,
    y: (center?.[0] ?? current.y + current.height / 2) - current.height * factor / 2 }, width, height));
  useEffect(() => {
    if (Array.isArray(focus?.point_index)) {
      const [y, x] = focus.point_index;
      setRegion(clampLargeRegion({ x: x - 256, y: y - 256, width: 512, height: 512 }, width, height));
    }
  }, [focus, width, height]);
  useEffect(() => {
    const sequence = ++token.current;
    setDecodedKey(""); setError(null);
    void api.execute("large_result_view", { result_id: result.id, revision_hash: result.revision_hash, region, labels, max_edge: 1024 }).then((value) => {
      const reply = value as LargeView;
      if (sequence !== token.current) return;
      if (reply.result_id !== result.id || reply.revision_hash !== result.revision_hash || JSON.stringify(reply.region) !== JSON.stringify(region) || reply.shape?.[0] !== height || reply.shape?.[1] !== width || !Number.isInteger(reply.step) || reply.step < 1 || reply.image_shape?.[0] !== Math.ceil(region.height / reply.step) || reply.image_shape?.[1] !== Math.ceil(region.width / reply.step) || !reply.image.startsWith("data:image/png;base64,")) throw new Error("The viewport response does not match its exact result and region.");
      setView(reply); setPaintedKey(key);
    }).catch((caught) => { if (sequence === token.current) { setView(null); setError(message(caught)); } });
    return () => { token.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  const pan = (dx: number, dy: number) => setRegion((current) => clampLargeRegion({ ...current, x: current.x + dx * current.width, y: current.y + dy * current.height }, width, height));
  return <section className="large-result-viewport" aria-label="Large quantitative result" data-ready={ready}>
    <div className="large-result-toolbar">
      <button onClick={() => setRegion({ x: 0, y: 0, width, height })}>Fit result</button>
      <button aria-label="Zoom into large result" onClick={() => zoom(.5)}><Plus size={16} aria-hidden="true" /></button><button aria-label="Zoom out of large result" onClick={() => zoom(2)}><Minus size={16} aria-hidden="true" /></button>
      <label className="large-check"><input type="checkbox" checked={labels} onChange={(event) => setLabels(event.target.checked)} />Objects</label>
      <span role="status">{error ? "View unavailable" : !ready ? "Loading exact revision…" : view.step === 1 ? "Native pixels" : `Sampled overview · 1:${view.step} · display only`}</span>
    </div>
    <div ref={stage} className="large-result-stage" tabIndex={0} aria-label="Result navigation: drag to pan, arrows to move, plus or minus to zoom" onKeyDown={(event) => {
      const moves: Record<string, [number, number]> = { ArrowLeft: [-.25, 0], ArrowRight: [.25, 0], ArrowUp: [0, -.25], ArrowDown: [0, .25] };
      if (moves[event.key]) { event.preventDefault(); pan(...moves[event.key]); }
      if (["+", "=", "-"].includes(event.key)) { event.preventDefault(); zoom(event.key === "-" ? 2 : .5); }
    }}>
      {view && <img key={paintedKey} src={view.image} alt="Selected quantitative result region" draggable={false}
        className={view.step === 1 ? "large-result-native-pixels" : undefined}
        style={imageSize ?? undefined}
        onLoad={() => setDecodedKey(paintedKey)}
        onError={() => { setDecodedKey(""); setError("Could not decode the result view."); }}
        onPointerDown={(event) => { if (ready && event.button === 0) { drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); } }}
        onPointerCancel={() => { drag.current = null; }}
        onPointerUp={(event) => {
          const start = drag.current; drag.current = null;
          if (!ready || !start) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const dx = event.clientX - start.x, dy = event.clientY - start.y;
          if (Math.hypot(dx, dy) > 4) { pan(-dx / bounds.width, -dy / bounds.height); return; }
          const point = largeDisplayPixel(view, (event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
          if (!point) return;
          const expected = token.current;
          const intent = onPickStart();
          void api.execute("large_result_pick", { result_id: result.id, revision_hash: result.revision_hash, ...point }).then((value) => {
            if (expected !== token.current) return;
            const picked = value as { result_id: string; revision_hash: string; measurement: Row | null };
            if (picked.result_id !== result.id || picked.revision_hash !== result.revision_hash) throw new Error("Object selection returned a stale revision.");
            onPick(picked.measurement, intent);
          }).catch((caught) => { if (expected === token.current) setError(message(caught)); });
        }} />}
      {error && <div className="large-result-error" role="alert"><p>{error}</p><button onClick={() => setRetry((value) => value + 1)}>Retry view</button></div>}
    </div>
    <div className="large-result-caption">Result coordinates · X {region.x}–{region.x + region.width - 1}, Y {region.y}–{region.y + region.height - 1} · {result.object_count.toLocaleString()} objects</div>
  </section>;
}

export function LargeResultInspector({ api, result, selected, onSelect, onLocate, busy, onBusy, onError, onActionStart, onResult, onRefresh, onUndo, onRedo, canRedo }: {
  api: ResearchDesktopApi; result: ResearchResult; selected: Row | null; onSelect: (row: Row | null) => void; onLocate: (row: Row) => Promise<void>;
  busy: boolean; onBusy: (value: string | null) => void; onError: (value: string) => void;
  onActionStart: () => number; onResult: (result: ResearchResult, intent: number) => Promise<void>; onRefresh: () => Promise<void>;
  onUndo: () => void; onRedo: () => void; canRedo: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageRetry, setPageRetry] = useState(0);
  const pageGeneration = useRef(0);
  useEffect(() => {
    let active = true; const generation = pageGeneration.current;
    setLoading(true); setRows([]); setPageError(null);
    void api.execute("result", { result_id: result.id, offset, limit: 200 }).then((value) => {
      if (!active || generation !== pageGeneration.current) return;
      const page = value as { result: ResearchResult; measurements: Row[] };
      if (page.result.id !== result.id || page.result.revision_hash !== result.revision_hash) throw new Error("Object page returned a stale revision.");
      setRows(page.measurements); setLoading(false);
    }).catch((error) => { if (active && generation === pageGeneration.current) { setPageError(message(error)); setLoading(false); } });
    return () => { active = false; };
  }, [api, result.id, result.revision_hash, offset, pageRetry]);
  const action = async (name: string, run: () => Promise<void>) => {
    if (busy) return; onBusy(name);
    try { await run(); } catch (error) { onError(message(error)); } finally { onBusy(null); }
  };
  const movePage = (next: number) => {
    pageGeneration.current++;
    setRows([]); setLoading(true); setPageError(null); setOffset(next);
  };
  return <section className="research-panel large-object-inspector" aria-label="Large result objects">
    <h2>Objects & measurements</h2><p>{resultTitle(result)} · {result.object_count.toLocaleString()} objects</p>
    <p className="large-method-note">Select an object on the image or in the list.</p>
    <div className="large-object-page"><button disabled={loading || offset === 0} onClick={() => movePage(Math.max(0, offset - 200))}>Previous</button><span role="status">{loading ? "Loading objects…" : result.object_count ? `${offset + 1}–${Math.min(offset + rows.length, result.object_count)}` : "No objects"}</span><button disabled={loading || offset + 200 >= result.object_count} onClick={() => movePage(offset + 200)}>Next</button></div>
    {pageError && <p role="alert">{pageError} <button onClick={() => { pageGeneration.current++; setRows([]); setLoading(true); setPageError(null); setPageRetry((value) => value + 1); }}>Retry objects</button></p>}
    <div className="large-object-list"><table><thead><tr><th>Object</th><th>Area ({result.geometry?.unit}²)</th><th>Pixels</th></tr></thead><tbody>{rows.map((row) => <tr key={String(row.label)} aria-selected={row.label === selected?.label}><td><button onClick={() => onSelect(row)}>#{String(row.label)}</button></td><td>{Number(row.measure).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td><td>{Number(row.voxel_count).toLocaleString()}</td></tr>)}</tbody></table></div>
    {selected && <section aria-label="Selected quantitative object"><h3>Object #{String(selected.label)}</h3><dl className="large-facts"><dt>Area</dt><dd>{String(selected.measure)} {String(selected.measure_unit)}</dd><dt>Centroid (Y, X)</dt><dd>{(selected.centroid_index as number[]).map((v) => v.toFixed(3)).join(", ")}</dd><dt>Nearest centroid</dt><dd>{selected.nearest_centroid_distance === null ? "No other object" : `${Number(selected.nearest_centroid_distance).toFixed(3)} ${selected.distance_unit}`}</dd></dl>
      {Object.entries(selected.intensity as Record<string, Record<string, number>>).map(([name, values]) => <p key={name}>{name} · raw mean {values.mean.toFixed(4)} · sum {values.sum.toLocaleString()}</p>)}
      <button disabled={busy} onClick={() => void onLocate(selected)}>Inspect object pixels</button>
      <button disabled={busy} onClick={() => { const intent = onActionStart(); void action("Removing object", async () => {
        const output = await api.execute("large_result_delete", { result_id: result.id, revision_hash: result.revision_hash, label: selected.label }) as { result: ResearchResult };
        if (output.result.parent_id !== result.id || !isLargeResult(output.result)) throw new Error("The correction does not belong to this result.");
        await onResult(output.result, intent);
      }); }}>Remove object in new revision</button>
    </section>}
    <div className="large-object-page"><button disabled={busy || !result.parent_id} onClick={onUndo}>Undo removal</button><button disabled={busy || !canRedo} onClick={onRedo}>Redo removal</button></div>
    <hr /><p>{result.review?.disposition === "reviewed" ? "Reviewed revision" : "Mark this result reviewed before export."}</p>
    <button disabled={busy || result.review?.disposition === "reviewed"} onClick={() => void action("Review", async () => { await api.reviewResult(result.id, result.revision_hash, "reviewed"); await onRefresh(); })}>Mark reviewed</button>
    <button disabled={busy || result.review?.disposition !== "reviewed"} onClick={() => void action("Export", async () => { await api.exportResult(result.id, result.revision_hash); })}>Export result</button>
    <details><summary>Export contents</summary><p className="large-method-note">Includes image/label OME-TIFF, all object measurements and provenance. Save the study to retain correction history.</p></details>
    <details><summary>Technical record</summary><p className="large-method-note">Result <code style={{ overflowWrap: "anywhere" }}>{result.id}</code><br />Revision <code style={{ overflowWrap: "anywhere" }}>{result.revision_hash}</code></p><p className="large-method-note">Labels identify objects. Sampled overviews support navigation; measurements use stored source pixels. Correction supports whole-object removal.</p></details>
  </section>;
}
