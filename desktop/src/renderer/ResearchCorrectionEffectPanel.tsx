import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot } from "../shared/research-contracts";
import {
  assertCorrectionEffectScope, checkedCorrectionEffect, correctionEffectBindingsCurrent,
  correctionEffectSnapshotKey, ordinaryLabelResult,
  type CorrectionEffectMeans, type CorrectionEffectReceipt, type CorrectionEffectRequest,
} from "../shared/correction-effect-contracts";
import "./ResearchCorrectionEffectPanel.css";
import { resultTitle } from "./result-title";

export interface CorrectionEffectSeed { beforeId: string; afterId: string }
type Props = {
  api: ResearchDesktopApi;
  snapshot: ResearchSnapshot;
  seed: CorrectionEffectSeed | null;
  contextKey: string;
  busy: boolean;
  adopt: (snapshot: ResearchSnapshot | null) => void;
  onOpenResult: (id: string) => Promise<void>;
};
const exact = (value: number | null) => value === null ? "undefined" : Object.is(value, -0) ? "-0" : String(value);
/** Presentation only: receipts and exports retain their original engine numbers. */
export function formatCorrectionEffectValue(value: number | null, signed = false): string {
  if (value === null) return "—";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const rounded = Number(value.toPrecision(6));
  const magnitude = Math.abs(rounded);
  const [mantissa, exponent] = value.toExponential(5).split("e");
  const display = magnitude >= 1e6 || magnitude < 1e-4 ? `${Number(mantissa)}e${exponent}` : String(rounded);
  return signed && value > 0 ? `+${display}` : display;
}
const number = (value: number | null) => formatCorrectionEffectValue(value);
const signed = (value: number | null) => formatCorrectionEffectValue(value, true);
const signedCount = (value: number) => value > 0 ? `+${value}` : exact(value);
const name = (result: ResearchResult, snapshot?: ResearchSnapshot) => {
  const ordinal = snapshot ? snapshot.results.findIndex(item => item.id === result.id) + 1 : null;
  const source = snapshot?.sources.find(item => item.id === result.source_id)?.name;
  return `${source ? `${source} · ` : ""}${resultTitle(result)} · ${result.object_count} ${result.object_count === 1 ? "object" : "objects"}${ordinal ? ` · Run ${ordinal}` : ""}`;
};
function RevisionDetail({ result, label, sourceName, id }: { result: ResearchResult; label: string; sourceName?: string; id?: string }) {
  const timestamp = typeof result.created_at === "string" ? new Date(result.created_at) : null;
  const created = timestamp && Number.isFinite(timestamp.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
    : null;
  return <><p id={id} className="correction-effect-revision-detail" aria-label={label}>
    {sourceName && <span>{sourceName}</span>}
    <span>{name(result)} · {result.review?.disposition ?? "pending review"}</span>
    <span>Created {created ? <time dateTime={result.created_at}>{created}</time> : "Unknown time"}</span>
  </p><details aria-label={`Technical record for ${label}`}><summary>Technical record</summary>
    <p>Result <code>{result.id}</code><br />Revision <code>{result.revision_hash}</code><br />Created <code>{result.created_at}</code></p>
  </details></>;
}
function failure(error: unknown): string {
  return (error instanceof Error ? error.message : "Could not calculate the experiment effect.")
    .replace(/\/?(?:Users|Volumes)\/[^\s]+/gu, "selected source").slice(0, 1000);
}
function savedReports(snapshot: ResearchSnapshot): Array<{ id: string; revision: number; receipt: CorrectionEffectReceipt }> {
  return [...(snapshot.comparisons ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).flatMap(document => {
    try { return [{ id: document.id, revision: document.revision, receipt: checkedCorrectionEffect(document.data.receipt) }]; }
    catch { return []; }
  });
}
function MeanColumns({ row }: { row: CorrectionEffectMeans }) {
  return <><td data-effect-value="before_mean">{number(row.before_mean)}</td><td data-effect-value="after_mean">{number(row.after_mean)}</td><td data-effect-value="mean_difference">{signed(row.mean_difference)}</td></>;
}
function FullPrecision({ row, label, unit }: { row: CorrectionEffectMeans; label: string; unit: string }) {
  return <dl className="correction-effect-precision" aria-label={`Full precision for ${label}`}>
    <dt>{label}</dt><dd>Unit: {unit}</dd>
    <dt>Before</dt><dd data-effect-exact="before_mean">{exact(row.before_mean)}</dd>
    <dt>After</dt><dd data-effect-exact="after_mean">{exact(row.after_mean)}</dd>
    <dt>Change (after − before)</dt><dd data-effect-exact="mean_difference">{exact(row.mean_difference)}</dd>
  </dl>;
}
function EffectRows({ row, label, counts }: { row: CorrectionEffectMeans; label: string; counts: string }) {
  return <tbody aria-label={label}>
    <tr><th className="correction-effect-row-label" colSpan={3} scope="rowgroup"><span>{label}</span><span className="correction-effect-counts">{counts}</span></th></tr>
    <tr><th scope="col">Before</th><th scope="col">After</th><th scope="col">Change</th></tr>
    <tr data-effect-values><MeanColumns row={row} /></tr>
  </tbody>;
}

export function ResearchCorrectionEffectPanel({ api, snapshot, seed, contextKey, busy, adopt, onOpenResult }: Props) {
  const saved = savedReports(snapshot);
  const invalidSaved = (snapshot.comparisons ?? []).some(document =>
    (document.data.receipt as { schema?: unknown } | null)?.schema === "loci.study-correction-effect/v1" &&
    !saved.some(row => row.id === document.id));
  const initial = seed ? null : saved[0]?.receipt ?? null;
  const [childId, setChildId] = useState(seed?.afterId ?? initial?.images.find(row => row.correction)?.after_result_id ?? "");
  const [peers, setPeers] = useState<Record<string, string>>(() => Object.fromEntries(
    initial?.images.filter(row => !row.correction).map(row => [row.source_id, row.before_result_id]) ?? [],
  ));
  const [restoredRequest, setRestoredRequest] = useState<CorrectionEffectRequest | null>(() => initial ? {
    before_result_ids: initial.before_bindings.map(row => row.result_id), after_result_ids: initial.after_bindings.map(row => row.result_id), value: "measure",
  } : null);
  const [receipt, setReceipt] = useState<CorrectionEffectReceipt | null>(initial);
  const [historical, setHistorical] = useState(Boolean(initial));
  const [working, setWorking] = useState<"calculate" | "export" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const serial = useRef(0);
  const alive = useRef(true);
  const previousContext = useRef(contextKey);
  const snapshotKey = correctionEffectSnapshotKey(snapshot);
  const live = useRef({ snapshotKey, contextKey, snapshot, childId, peers });
  live.current = { snapshotKey, contextKey, snapshot, childId, peers };
  const child = snapshot.results.find(row => row.id === childId);
  const parent = snapshot.results.find(row => row.id === child?.parent_id);
  const corrections = snapshot.results.filter(row => row.kind === "corrected-labels" && ordinaryLabelResult(row));
  const validPair = child?.kind === "corrected-labels" && parent && ordinaryLabelResult(parent) &&
    parent.source_id === child.source_id && parent.source_sha256 === child.source_sha256;
  const selectedIds = validPair ? [parent.id, child.id, ...Object.values(peers).filter(Boolean)] : [];
  const missingSamples = [...new Set(selectedIds.map(id => snapshot.results.find(row => row.id === id)?.source_id))]
    .filter(id => id && !snapshot.samples.some(sample => sample.id === id));
  const pending = Boolean(receipt && (receipt.images.some(row => row.needs_review) ||
    [...receipt.before_bindings, ...receipt.after_bindings].some(binding =>
      !binding.review || !["reviewed", "excluded"].includes(binding.review.disposition))));
  const current = receipt ? correctionEffectBindingsCurrent(receipt, snapshot) : false;
  const exportReady = Boolean(receipt && !historical && current && !pending && api.exportCorrectionEffect);

  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current++; }; }, []);
  useEffect(() => {
    serial.current++;
    setWorking(null); setError(null); setNotice(null);
    // Metadata/review changes preserve an inspectable historical snapshot, while
    // invalidating export readiness and any response from the previous scope.
    if (receipt && !correctionEffectBindingsCurrent(receipt, snapshot)) setHistorical(true);
    if (previousContext.current !== contextKey) {
      previousContext.current = contextKey; setReceipt(null); setHistorical(false); setRestoredRequest(null);
    }
  }, [snapshotKey, contextKey]);
  useEffect(() => {
    if (!seed) return;
    serial.current++; setChildId(seed.afterId); setPeers({}); setReceipt(null); setHistorical(false);
    setRestoredRequest(null);
    setWorking(null); setError(null); setNotice(null);
  }, [seed?.beforeId, seed?.afterId]);

  const invalidateChoice = () => {
    serial.current++; setReceipt(null); setHistorical(false); setError(null); setNotice(null); setWorking(null);
    setRestoredRequest(null);
  };
  const calculate = async () => {
    if (!validPair || !parent || !child) return;
    const peerIds = Object.entries(peers).filter(([sourceId, id]) => sourceId !== child.source_id && Boolean(id)).map(([, id]) => id);
    const request: CorrectionEffectRequest = restoredRequest ?? { before_result_ids: [parent.id, ...peerIds], after_result_ids: [child.id, ...peerIds], value: "measure" };
    const captured = live.current;
    const token = ++serial.current;
    const isCurrent = () => alive.current && token === serial.current && captured.snapshotKey === live.current.snapshotKey && captured.contextKey === live.current.contextKey;
    setReceipt(null); setHistorical(false); setError(null); setNotice(null); setWorking("calculate");
    try {
      const output = checkedCorrectionEffect(await api.execute("study_correction_effect", { ...request }));
      if (!isCurrent()) return;
      assertCorrectionEffectScope(output, request, captured.snapshot);
      const refreshed = await api.getSnapshot();
      if (!isCurrent()) return;
      if (!refreshed) throw new Error("The study is no longer open. Reopen it before calculating.");
      assertCorrectionEffectScope(output, request, refreshed);
      setReceipt(output); adopt(refreshed);
    } catch (error) { if (isCurrent()) setError(failure(error)); }
    finally { if (isCurrent()) setWorking(null); }
  };
  const exportReport = async () => {
    if (!receipt || !exportReady || !api.exportCorrectionEffect) return;
    const token = ++serial.current;
    const captured = live.current;
    const isCurrent = () => alive.current && token === serial.current && captured.snapshotKey === live.current.snapshotKey && captured.contextKey === live.current.contextKey;
    setWorking("export"); setError(null); setNotice(null);
    try {
      const output = await api.exportCorrectionEffect(receipt.receipt_sha256);
      if (!isCurrent()) return;
      if (output && output.receipt_sha256 !== receipt.receipt_sha256) throw new Error("The exported report does not match this receipt.");
      setNotice(output ? "Reviewed report exported." : "Report export cancelled.");
    } catch (error) { if (isCurrent()) { setError(failure(error)); setHistorical(true); } }
    finally { if (isCurrent()) setWorking(null); }
  };
  const restore = (id: string) => {
    const document = saved.find(row => row.id === id);
    if (!document) return;
    invalidateChoice();
    const corrected = document.receipt.images.find(row => row.correction);
    setChildId(corrected?.after_result_id ?? "");
    setPeers(Object.fromEntries(document.receipt.images.filter(row => !row.correction).map(row => [row.source_id, row.before_result_id])));
    setReceipt(document.receipt); setHistorical(true);
    setRestoredRequest({ before_result_ids: document.receipt.before_bindings.map(row => row.result_id),
      after_result_ids: document.receipt.after_bindings.map(row => row.result_id), value: "measure" });
  };
  return <section className="research-panel correction-effect-panel" aria-label="Experiment effect">
    <h2>Experiment effect</h2>
    <p>Compare a correction with its direct parent. Choose exact unchanged image revisions to supply the experiment context.</p>
    {invalidSaved && <p role="alert">A saved experiment effect failed schema checks. Recalculate from exact revisions.</p>}
    {!corrections.length && <p>No corrected label revision yet. Correct an object, then choose Show experiment effect.</p>}
    <label>After correction
      <select aria-label="After correction revision" aria-describedby={child ? "correction-effect-selected-revision" : undefined} value={childId} disabled={busy} onChange={event => {
        invalidateChoice(); setChildId(event.target.value); setPeers({});
      }}>
        <option value="">Choose a corrected revision</option>
        {corrections.map(result => <option key={result.id} value={result.id}>
          {name(result, snapshot)}
        </option>)}
      </select>
    </label>
    {child && <RevisionDetail result={child} id="correction-effect-selected-revision" label="Selected correction revision details"
      sourceName={snapshot.sources.find(source => source.id === child.source_id)?.name ?? "Source"} />}
    {child && <div className="correction-effect-pair" aria-label="Exact correction pair">
      <strong>Before · direct parent</strong>
      {parent ? <RevisionDetail result={parent} label="Direct parent revision details" /> : <p>Direct parent unavailable</p>}
      {!validPair && <p role="alert">Choose a corrected revision whose exact ordinary-label parent is available.</p>}
    </div>}
    {validPair && <details>
      <summary>Unchanged context images</summary>
      {snapshot.sources.filter(source => source.id !== child?.source_id).map(source => {
        const options = snapshot.results.filter(result => result.source_id === source.id && ordinaryLabelResult(result));
        const selected = options.find(result => result.id === peers[source.id]);
        const detailId = `correction-effect-context-${source.id}`;
        return <div className="correction-effect-context" key={source.id}><label>{source.name}
          <select aria-label={`Context revision for ${source.name}`} disabled={busy} value={peers[source.id] ?? ""}
            aria-describedby={selected ? detailId : undefined}
            onChange={event => { invalidateChoice(); setPeers(previous => ({ ...previous, [source.id]: event.target.value })); }}>
            <option value="">Not included — choose an exact revision</option>
            {options.map(result => <option key={result.id} value={result.id}>{name(result, snapshot)}</option>)}
          </select>
          {!options.length && <span>No ordinary label result available.</span>}
        </label>
        {selected && <div id={detailId}><RevisionDetail result={selected} label={`Selected context revision details for ${source.name}`} /></div>}
        </div>;
      })}
    </details>}
    {missingSamples.length > 0 && <p role="status">Assign study sample metadata below for every selected source before calculating.</p>}
    <div className="correction-effect-actions">
      <button className="research-primary" disabled={busy || working !== null || !validPair || missingSamples.length > 0}
        onClick={() => void calculate()}>{working === "calculate" ? "Calculating…" : receipt || historical ? "Recalculate experiment effect" : "Calculate experiment effect"}</button>
      {receipt && <button disabled={busy || working !== null || !exportReady} onClick={() => void exportReport()}>
        {working === "export" ? "Exporting…" : "Export reviewed effect report"}
      </button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {saved.length > 0 && <details><summary>Saved experiment effects</summary>
      {saved.map((document, index) => <button key={document.id} disabled={busy || working !== null}
        data-report-id={document.id} aria-label={`Restore ${document.receipt.study} report ${index + 1}`} onClick={() => restore(document.id)}>
        {document.receipt.study} · Report {index + 1}
      </button>)}
    </details>}
    {receipt && <section aria-label="Experiment effect receipt" data-receipt-sha256={receipt.receipt_sha256}>
      {historical && <p role="status">Historical snapshot — captured grouping and reviews. Recalculate before export.</p>}
      {pending && <p role="status">Pending review — review each non-excluded before and after revision in its image context, then recalculate. This inspection does not approve results.</p>}
      {!pending && !historical && current && <p role="status">Bound revisions reviewed or excluded. Report ready for reviewed export.</p>}
      <p>Object size · {receipt.unit}. Equal image weight within a biological replicate; equal replicate weight within a condition. Paired estimates omit an image from both sides if either side is empty or excluded.</p>
      <p>Display: 6 significant digits. Full precision values below; exact receipt and export values are unchanged.</p>
      <div className="correction-effect-table" role="region" aria-label="Condition effect table" tabIndex={0}>
        <table aria-label="Condition experiment effect">{receipt.conditions.map(row => <EffectRows key={`${row.study}:${row.condition}`}
          row={row} label={row.condition} counts={`Biological n: ${row.biological_n} · Image pairs: ${row.image_pair_count} · Omitted: ${row.omitted_image_pair_count}`} />)}</table>
      </div>
      <details><summary>Full precision condition values</summary>{receipt.conditions.map(row =>
        <FullPrecision key={`${row.study}:${row.condition}`} row={row} label={`condition ${row.condition}`} unit={receipt.unit} />)}</details>
      <details><summary>Biological replicate contributions</summary>
        <div className="correction-effect-table" role="region" aria-label="Replicate effect table" tabIndex={0}>
          <table aria-label="Biological replicate experiment effect">{receipt.replicates.map(row => <EffectRows key={`${row.study}:${row.condition}:${row.biological_replicate}`}
            row={row} label={`${row.biological_replicate} · ${row.condition}`} counts={`Image pairs: ${row.image_pair_count} · Omitted: ${row.omitted_image_pair_count}`} />)}</table>
        </div>
        <details><summary>Full precision biological replicate values</summary>{receipt.replicates.map(row =>
          <FullPrecision key={`${row.study}:${row.condition}:${row.biological_replicate}`} row={row} label={`replicate ${row.biological_replicate} · ${row.condition}`} unit={receipt.unit} />)}</details>
        {!receipt.replicates.length && <p>No eligible declared biological replicates.</p>}
      </details>
      <details><summary>Image contributions and correction details</summary>
        {receipt.images.map(row => <div className="correction-effect-image" key={row.source_id}>
          <h3>{snapshot.sources.find(source => source.id === row.source_id)?.name ?? row.metadata.sample}</h3>
          <p>{row.metadata.condition} · replicate {row.metadata.biological_replicate ?? "unassigned"} · {row.eligible ? "included pair" : `omitted: ${row.omission_reasons.join(", ")}`}{row.needs_review ? " · pending review" : ""}</p>
          <p>Objects: {row.before_count} → {row.after_count} ({signedCount(row.count_difference)}). Image mean: {number(row.before_mean)} → {number(row.after_mean)} {receipt.unit} ({signed(row.mean_difference)}).</p>
          <details><summary>Full precision image values for {row.metadata.sample}</summary>
            <FullPrecision row={row} label={`image ${row.metadata.sample}`} unit={receipt.unit} />
          </details>
          <div className="correction-effect-actions"><button disabled={busy || working !== null} data-result-id={row.before_result_id} aria-label={`Inspect before ${snapshot.sources.find(source => source.id === row.source_id)?.name ?? row.metadata.sample}`} onClick={() => void onOpenResult(row.before_result_id)}>Inspect before</button>
            <button disabled={busy || working !== null} data-result-id={row.after_result_id} aria-label={`Inspect after ${snapshot.sources.find(source => source.id === row.source_id)?.name ?? row.metadata.sample}`} onClick={() => void onOpenResult(row.after_result_id)}>Inspect after</button></div>
          {row.correction ? <details><summary>Correction audit for {row.metadata.sample}</summary>
            <p>Changed voxels: {row.correction.changed_voxel_count}. Added IDs: {row.correction.added_label_ids.join(", ") || "none"}. Removed IDs: {row.correction.removed_label_ids.join(", ") || "none"}. Changed retained IDs: {row.correction.changed_retained_label_ids.join(", ") || "none"}.</p>
            <pre>{JSON.stringify(row.correction.operations, null, 2)}</pre><p>{row.correction.label_identity_interpretation}</p>
          </details> : <p>Unchanged exact revision on both sides.</p>}
        </div>)}
      </details>
      <details><summary>Technical record</summary><p>Receipt SHA-256: {receipt.receipt_sha256}</p>
        {[...receipt.before_bindings, ...receipt.after_bindings].map((binding, index) => <p key={`${index}:${binding.result_id}`}>
          {binding.result_id} · revision {binding.revision_hash} · source {binding.source_sha256} · sample revision {binding.sample_document.revision} · {binding.review?.disposition ?? "pending"}
        </p>)}<p>{receipt.interpretation}</p>
      </details>
    </section>}
  </section>;
}
