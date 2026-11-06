import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Layers, Snowflake } from "lucide-react";
import type { ResearchDesktopApi, ResearchJob, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { sanitizeRendererError } from "./ContextHelp";
import { ScientificNumber } from "./ScientificNumber";
import { resultTitle } from "./result-title";
import "./ResearchAnnotationEvaluationPanel.css";

type Binding = { result_id: string; revision_hash: string };
type Semantics = "instances" | "foreground-region";
type Metric = number | null;
type Score = { iou_threshold: number; true_positive: number; false_positive: number; false_negative: number;
  precision: Metric; recall: Metric; f1: Metric; mean_matched_iou: Metric; undefined_reasons: Record<string, string>;
  matches_count: number; unmatched_reference_count: number; unmatched_prediction_count: number };
type Agreement = { schema: string; semantics: Semantics; reference_declaration: string;
  inputs: { prediction: Binding & { labels_sha256: string }; reference: Binding & { labels_sha256: string } };
  metrics: { schema: string; semantics: Semantics; region: { reference_pixels: number; prediction_pixels: number; intersection_pixels: number; union_pixels: number;
    iou: Metric; dice: Metric; undefined_reasons: Record<string, string> };
    instances: null | { reference_count: number; prediction_count: number; count_error_signed: number; count_error_absolute: number;
      count_error_relative: Metric; undefined_reasons: Record<string, string>; split_reference_any_overlap: number; merge_prediction_any_overlap: number; scores: Score[] } } };
type ReferenceRecord = { schema: string; semantics: Semantics; source_annotations_revision: number; coverage_declaration: string; labels_sha256: string; snapshot_sha256: string };
type AnnotatedResult = ResearchResult & { annotation_evaluation?: unknown; annotation_reference?: unknown };
type Inspect = (resultId: string, revisionHash: string) => void;
const PARENTS = new Set(["segmentation", "cell-segmentation", "adaptive-segmentation", "cellpose-segmentation", "model-segmentation", "external-labels", "corrected-labels", "tissue-model-regions", "annotation-reference", "controlled-method"]);
const isId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/u.test(v);
const isSha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const binding = (v: Binding | undefined): v is Binding => Boolean(v && isId(v.result_id) && isSha(v.revision_hash));
const key = (r: ResearchResult) => `${r.id}:${r.revision_hash}`;
const failure = (e: unknown) => sanitizeRendererError(e instanceof Error ? e.message : "Annotation agreement failed. Reload the saved inputs before retrying.");
const reason = (text: string) => text.replaceAll("-", " ").replaceAll("_", " ");
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || !a || typeof b !== "object" || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a), right = Object.entries(b);
  return left.length === right.length && left.every(([k, v]) => Object.hasOwn(b, k) && same(v, (b as Record<string, unknown>)[k]));
};
function ratio(value: unknown, reasons: Record<string, string> | undefined, name: string): boolean {
  return value === null ? typeof reasons?.[name] === "string" && reasons[name].length > 0
    : typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 && reasons?.[name] === undefined;
}
function checkedAgreement(value: unknown, result: ResearchResult): Agreement {
  const r = value as Agreement | undefined, m = r?.metrics, region = m?.region, instances = m?.instances;
  if (result.kind !== "annotation-agreement" || !isId(result.id) || !isSha(result.revision_hash) || !isId(result.source_id) || !isSha(result.source_sha256) ||
      result.geometry?.axes !== "YX" || result.selection?.level !== 0 ||
      r?.schema !== "loci.annotation-agreement/v1" || !["instances", "foreground-region"].includes(r.semantics) ||
      typeof r.reference_declaration !== "string" || !r.reference_declaration.trim() ||
      !binding(r.inputs?.prediction) || !binding(r.inputs?.reference) || !isSha(r.inputs.prediction.labels_sha256) || !isSha(r.inputs.reference.labels_sha256) ||
      r.inputs.prediction.result_id !== result.parent_id || r.inputs.prediction.labels_sha256 !== result.arrays?.labels?.sha256 ||
      r.inputs.reference.labels_sha256 !== result.arrays?.reference_labels?.sha256 || m?.schema !== "loci.annotation-agreement-kernel/v1" || m.semantics !== r.semantics ||
      !region || ![region.reference_pixels, region.prediction_pixels, region.intersection_pixels, region.union_pixels].every(count) ||
      region.intersection_pixels > Math.min(region.reference_pixels, region.prediction_pixels) ||
      region.union_pixels !== region.reference_pixels + region.prediction_pixels - region.intersection_pixels ||
      !ratio(region.iou, region.undefined_reasons, "iou") || !ratio(region.dice, region.undefined_reasons, "dice") ||
      region.iou !== (region.union_pixels ? region.intersection_pixels / region.union_pixels : null) ||
      region.dice !== (region.union_pixels ? 2 * region.intersection_pixels / (region.reference_pixels + region.prediction_pixels) : null) ||
      (r.semantics === "foreground-region" ? instances !== null : !instances)) throw new Error("Saved annotation agreement has inconsistent identity or metrics. Reload this exact result revision.");
  if (instances) {
    if (![instances.reference_count, instances.prediction_count, instances.count_error_absolute, instances.split_reference_any_overlap, instances.merge_prediction_any_overlap].every(count) ||
        instances.reference_count > region.reference_pixels || instances.prediction_count > region.prediction_pixels ||
        instances.count_error_signed !== instances.prediction_count - instances.reference_count || instances.count_error_absolute !== Math.abs(instances.count_error_signed) ||
        !Array.isArray(instances.scores) || instances.scores.length < 1 || instances.scores.length > 8 ||
        !instances.scores.every((s, i) => typeof s.iou_threshold === "number" && s.iou_threshold > 0 && s.iou_threshold <= 1 &&
          (i === 0 || instances.scores[i - 1].iou_threshold < s.iou_threshold) &&
          [s.true_positive, s.false_positive, s.false_negative, s.matches_count, s.unmatched_reference_count, s.unmatched_prediction_count].every(count) &&
          s.true_positive + s.false_positive === instances.prediction_count && s.true_positive + s.false_negative === instances.reference_count &&
          s.matches_count === s.true_positive && s.unmatched_reference_count === s.false_negative && s.unmatched_prediction_count === s.false_positive &&
          s.precision === (instances.prediction_count ? s.true_positive / instances.prediction_count : null) &&
          s.recall === (instances.reference_count ? s.true_positive / instances.reference_count : null) &&
          s.f1 === (instances.prediction_count + instances.reference_count ? 2 * s.true_positive / (instances.prediction_count + instances.reference_count) : null) &&
          ["precision", "recall", "f1", "mean_matched_iou"].every((name) => ratio(s[name as keyof Score], s.undefined_reasons, name))))
      throw new Error("Saved instance agreement is inconsistent. Reload this exact result revision.");
  }
  return r;
}
function MetricValue({ label, value, reasons, name }: { label: string; value: Metric; reasons: Record<string, string>; name: string }) {
  return <div><dt>{label}</dt><dd>{value === null ? <>Undefined <span>{reason(reasons[name])}</span></> : <ScientificNumber value={value} />}</dd></div>;
}
function ExactLink({ role, target, onInspect }: { role: string; target: Binding; onInspect?: Inspect }) {
  return <div className="annotation-agreement-binding"><span>{role} · {target.result_id.slice(0, 8)} · rev {target.revision_hash.slice(0, 8)}</span>
    {onInspect && <button type="button" onClick={() => onInspect(target.result_id, target.revision_hash)} aria-label={`Inspect ${role.toLowerCase()} revision`}><ArrowUpRight size={14} aria-hidden="true" /> Inspect</button>}</div>;
}

type TableName = "matches" | "unmatched_reference" | "unmatched_prediction";
type Match = { reference_label: number; prediction_label: number; intersection_pixels: number; union_pixels: number; iou: number };
type Page = Binding & { table: TableName; iou_threshold: number; offset: number; total: number; rows: (Match | number)[] };
function AgreementTable({ api, result, record }: { api: ResearchDesktopApi; result: ResearchResult; record: Agreement }) {
  const [table, setTable] = useState<TableName>("matches"), [threshold, setThreshold] = useState(0), [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const scores = record.metrics.instances!.scores, score = scores[threshold];
  const identity = JSON.stringify([result.id, result.revision_hash, table, threshold, offset]);
  const current = useRef({ identity, api }); current.current = { identity, api };
  useEffect(() => {
    let alive = true; const used = api, started = identity;
    setPage(null); setPending(true); setError("");
    void used.execute("annotation_evaluation_get", { result_id: result.id, revision_hash: result.revision_hash, table, threshold_index: threshold, offset, limit: 50 }).then((response) => {
      if (!alive || current.current.api !== used || current.current.identity !== started) return;
      const p = response as Page;
      const total = score[`${table}_count` as "matches_count" | "unmatched_reference_count" | "unmatched_prediction_count"];
      if (!p || p.result_id !== result.id || p.revision_hash !== result.revision_hash || p.table !== table || p.iou_threshold !== score.iou_threshold ||
          p.offset !== offset || p.total !== total || !Array.isArray(p.rows) || p.rows.length !== Math.min(50, Math.max(0, total - offset)) ||
          !p.rows.every((row) => table === "matches" ? typeof row === "object" && row !== null &&
            count(row.reference_label) && row.reference_label > 0 && count(row.prediction_label) && row.prediction_label > 0 &&
            count(row.intersection_pixels) && count(row.union_pixels) && row.union_pixels > 0 && row.intersection_pixels <= row.union_pixels &&
            typeof row.iou === "number" && row.iou >= score.iou_threshold && row.iou <= 1 && row.iou === row.intersection_pixels / row.union_pixels
            : count(row) && row > 0)) throw new Error("The match table does not belong to this exact agreement and threshold. Reload the saved result.");
      setPage(p);
    }).catch((e) => { if (alive && current.current.identity === started && current.current.api === used) setError(failure(e)); })
      .finally(() => { if (alive && current.current.identity === started && current.current.api === used) setPending(false); });
    return () => { alive = false; };
  }, [identity, api]);
  return <div className="annotation-agreement-report">
    <div className="annotation-agreement-controls"><label>Match threshold<select value={threshold} onChange={(e) => { setThreshold(Number(e.target.value)); setOffset(0); }}>{scores.map((s, i) => <option key={s.iou_threshold} value={i}>IoU ≥ {s.iou_threshold}</option>)}</select></label>
      <label>Rows<select value={table} onChange={(e) => { setTable(e.target.value as TableName); setOffset(0); }}><option value="matches">Matched pairs</option><option value="unmatched_reference">Unmatched reference</option><option value="unmatched_prediction">Unmatched prediction</option></select></label></div>
    {pending && <p role="status">Loading saved rows…</p>}{error && <p role="alert">{error}</p>}
    {page && <><div className="annotation-agreement-table" role="region" aria-label="Saved annotation match rows" tabIndex={0}><table><caption>{table === "matches" ? "Matched original label IDs" : table === "unmatched_reference" ? "Unmatched reference label IDs" : "Unmatched prediction label IDs"}</caption>
      <thead><tr>{table === "matches" ? <><th scope="col">Reference</th><th scope="col">Prediction</th><th scope="col">IoU</th></> : <th scope="col">Label ID</th>}</tr></thead>
      <tbody>{page.rows.map((row, i) => <tr key={i}>{typeof row === "number" ? <td>{row}</td> : <><td>{row.reference_label}</td><td>{row.prediction_label}</td><td><ScientificNumber value={row.iou} /></td></>}</tr>)}</tbody></table></div>
      {!page.total && <p>No rows recorded for this table and threshold.</p>}
      <div className="annotation-agreement-actions"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous rows</button><span>{page.total ? `${offset + 1}–${offset + page.rows.length} of ${page.total}` : "0 rows"}</span><button type="button" disabled={offset + page.rows.length >= page.total} onClick={() => setOffset(offset + 50)}>Next rows</button></div></>}
  </div>;
}

export function AnnotationAgreementSummary({ result, api, onInspect }: { result: ResearchResult; api?: ResearchDesktopApi; onInspect?: Inspect }) {
  const [showRows, setShowRows] = useState(false);
  try {
    const r = checkedAgreement((result as AnnotatedResult).annotation_evaluation, result), region = r.metrics.region, instances = r.metrics.instances;
    return <section className="annotation-agreement-summary" aria-label="Saved annotation agreement">
      <h3>Saved annotation agreement</h3><p>{r.semantics === "instances" ? "Declared object instances" : "Foreground region"} · exact saved comparison</p>
      <ExactLink role="Prediction" target={r.inputs.prediction} onInspect={onInspect} /><ExactLink role="Reference" target={r.inputs.reference} onInspect={onInspect} />
      <p className="annotation-agreement-declaration">{r.reference_declaration}</p>
      <h4>Foreground overlap</h4><p>{region.prediction_pixels.toLocaleString()} prediction pixels · {region.reference_pixels.toLocaleString()} reference pixels · {region.intersection_pixels.toLocaleString()} shared</p>
      <dl className="annotation-agreement-metrics"><MetricValue label="IoU" value={region.iou} reasons={region.undefined_reasons} name="iou" /><MetricValue label="Dice" value={region.dice} reasons={region.undefined_reasons} name="dice" /></dl>
      {instances && <><h4>Instance agreement</h4><p>{instances.prediction_count.toLocaleString()} predicted · {instances.reference_count.toLocaleString()} reference · count difference {instances.count_error_signed > 0 ? "+" : ""}{instances.count_error_signed}</p>
        {instances.scores.map((s) => <div className="annotation-agreement-score" key={s.iou_threshold}><p>IoU ≥ {s.iou_threshold} · {s.true_positive} matched · {s.false_positive} unmatched prediction · {s.false_negative} unmatched reference</p>
          <dl className="annotation-agreement-metrics"><MetricValue label="Precision" value={s.precision} reasons={s.undefined_reasons} name="precision" /><MetricValue label="Recall" value={s.recall} reasons={s.undefined_reasons} name="recall" /><MetricValue label="F1" value={s.f1} reasons={s.undefined_reasons} name="f1" /><MetricValue label="Mean matched IoU" value={s.mean_matched_iou} reasons={s.undefined_reasons} name="mean_matched_iou" /></dl></div>)}
        <p>{instances.split_reference_any_overlap} reference IDs overlap multiple predictions · {instances.merge_prediction_any_overlap} prediction IDs overlap multiple references.</p>
        {api && <details onToggle={(e) => setShowRows(e.currentTarget.open)}><summary>Inspect matched and unmatched labels</summary>{showRows && <AgreementTable key={key(result)} api={api} result={result} record={r} />}</details>}</>}
      <p className="annotation-agreement-note">Agreement describes these declared annotations on the comparison crop. It does not establish biological ground truth or accuracy.</p>
    </section>;
  } catch (e) { return <p role="alert">{failure(e)}</p>; }
}

// Discovery is bound to an immutable prediction/grid; it never freezes the live canvas implicitly.
type Candidates = Binding & { source_annotations_revision: number; offset: number; total: number;
  candidates: { id: string; kind: "polygon" | "rectangle"; z: number; t: number; point_count: number }[] };
export function ResearchAnnotationEvaluationPanel({ api, snapshot, source, selectedResult, active, busy, workingBytes, onBusyChange, onPublished, onInspect }: {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; source: ResearchSource; selectedResult: ResearchResult | null; active: boolean; busy: boolean;
  workingBytes: number; onBusyChange: (value: boolean) => void; onPublished: (result: ResearchResult) => Promise<void>; onInspect?: Inspect;
}) {
  const candidates = snapshot.results.filter((r) => r.schema === "loci.research-result/v1" && r.source_id === source.id && r.source_sha256 === source.sha256 &&
    PARENTS.has(r.kind) && r.geometry?.axes === "YX" && r.selection?.level === 0 && isId(r.id) && isSha(r.revision_hash) &&
    isSha(r.arrays?.image?.sha256) && isSha(r.arrays?.labels?.sha256));
  const [predictionKey, setPrediction] = useState(""), [referenceKey, setReference] = useState("");
  const [semantics, setSemantics] = useState<Semantics>("instances"), [thresholdText, setThresholdText] = useState("0.5"), [declaration, setDeclaration] = useState("");
  const [discovery, setDiscovery] = useState<Candidates | null>(null), [annotationIds, setAnnotationIds] = useState<string[]>([]), [coverage, setCoverage] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const prediction = candidates.find((r) => key(r) === predictionKey), reference = candidates.find((r) => key(r) === referenceKey);
  const thresholds = thresholdText.split(",").map((s) => s.trim()).map((s) => /^[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$/iu.test(s) ? Number(s) : NaN);
  const validThresholds = thresholds.length > 0 && thresholds.length <= 8 && thresholds.every((v, i) => Number.isFinite(v) && v > 0 && v <= 1 && (!i || v > thresholds[i - 1]));
  const semanticsReason = (r: ResearchResult | undefined) => r && semantics === "instances" && (r.kind === "tissue-model-regions" || Boolean(r.tissue_model))
    ? "Tissue compartment regions require foreground-region semantics. Choose Foreground region or an object-instance label mask." :
    r?.kind === "annotation-reference" && (r as AnnotatedResult).annotation_reference && ((r as AnnotatedResult).annotation_reference as ReferenceRecord).semantics !== semantics
      ? "The frozen reference has different semantics. Match its declared semantics or save another reference." : "";
  const ineligible = semanticsReason(prediction) || semanticsReason(reference);
  const gridMismatch = prediction && reference && (!same(prediction.selection, reference.selection) || !same(prediction.geometry, reference.geometry) || !same(prediction.arrays?.labels?.shape, reference.arrays?.labels?.shape));
  const identity = JSON.stringify([snapshot.project.project_id, source.id, source.sha256, candidates.map((r) => [r.id, r.revision_hash, r.arrays, r.selection, r.geometry]), predictionKey, referenceKey, semantics, thresholdText, declaration, coverage, annotationIds, workingBytes]);
  const current = useRef({ identity, api, active }); current.current = { identity, api, active };
  const mounted = useRef(true), running = useRef(false);
  useEffect(() => { setPrediction(""); setReference(""); setDiscovery(null); setAnnotationIds([]); setDeclaration(""); setCoverage(""); setError(""); }, [snapshot.project.project_id, source.id, source.sha256]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const discoveryValid = discovery?.result_id === prediction?.id && discovery?.revision_hash === prediction?.revision_hash;
  async function perform(operation: "annotation_evaluation_run" | "annotation_reference_run" | "annotation_reference_candidates", discoveryOffset = 0) {
    if (!prediction || !active || busy || running.current) return;
    const started = identity, used = api, parent = prediction;
    const live = () => mounted.current && current.current.active && current.current.identity === started && current.current.api === used;
    const request = operation === "annotation_evaluation_run" ? { result_id: parent.id, revision_hash: parent.revision_hash,
      reference: { result_id: reference!.id, revision_hash: reference!.revision_hash }, semantics, iou_thresholds: semantics === "instances" ? thresholds : [], reference_declaration: declaration.trim(), working_bytes: workingBytes }
      : operation === "annotation_reference_run" ? { result_id: parent.id, revision_hash: parent.revision_hash, source_annotations_revision: discovery!.source_annotations_revision,
        annotation_ids: annotationIds, semantics, coverage_declaration: coverage.trim(), working_bytes: workingBytes }
        : { result_id: parent.id, revision_hash: parent.revision_hash, offset: discoveryOffset, limit: 100 };
    running.current = true; setPending(true); setError(""); onBusyChange(true);
    try {
      const response = await used.execute(operation, request);
      if (!live()) return;
      if (operation === "annotation_reference_candidates") {
        const d = response as Candidates;
        if (!d || d.result_id !== parent.id || d.revision_hash !== parent.revision_hash ||
            !count(d.source_annotations_revision) || d.source_annotations_revision < 1 || !count(d.offset) || d.offset !== discoveryOffset || !count(d.total) ||
            !Array.isArray(d.candidates) || d.candidates.length !== Math.min(100, Math.max(0, d.total - d.offset)) ||
            !d.candidates.every((a) => isId(a.id) && ["polygon", "rectangle"].includes(a.kind) && count(a.z) && count(a.t) && a.z === parent.selection?.z && a.t === parent.selection?.t && count(a.point_count) && a.point_count >= 3) ||
            new Set(d.candidates.map((a) => a.id)).size !== d.candidates.length ||
            (discoveryOffset > 0 && discovery?.source_annotations_revision !== d.source_annotations_revision)) throw new Error("Annotation discovery does not match this exact source and result revision. Reload the annotations.");
        setDiscovery(d); if (discovery?.source_annotations_revision !== d.source_annotations_revision) setAnnotationIds([]); return;
      }
      const responseRecord = response as { result: AnnotatedResult; job: ResearchJob; annotation_evaluation?: unknown; annotation_reference?: unknown };
      const r = responseRecord.result, job = responseRecord.job;
      if (!r || !isId(r.id) || !isSha(r.revision_hash) || r.id === parent.id || r.kind !== (operation === "annotation_evaluation_run" ? "annotation-agreement" : "annotation-reference") ||
          r.parent_id !== parent.id || r.source_id !== source.id || r.source_sha256 !== source.sha256 || !same(r.selection, parent.selection) || !same(r.geometry, parent.geometry) ||
          r.arrays?.image?.sha256 !== parent.arrays?.image?.sha256 || !job || !isId(job.id) || job.operation !== operation || job.state !== "succeeded" || job.owner ||
          !same(job.request, { source_id: source.id, task_request: request }) || !same(job.result_ids, [r.id])) throw new Error("The operation did not return the exact completed job and input revision. Inspect Jobs before retrying.");
      if (operation === "annotation_evaluation_run") {
        const summary = checkedAgreement(r.annotation_evaluation, r);
        if (!same(summary, responseRecord.annotation_evaluation) || summary.inputs.prediction.result_id !== parent.id || summary.inputs.prediction.revision_hash !== parent.revision_hash ||
            summary.inputs.reference.result_id !== reference!.id || summary.inputs.reference.revision_hash !== reference!.revision_hash || summary.inputs.reference.labels_sha256 !== reference!.arrays?.labels?.sha256 ||
            r.arrays?.labels?.sha256 !== parent.arrays?.labels?.sha256 || summary.semantics !== semantics || summary.reference_declaration !== declaration.trim() ||
            !same(summary.metrics.instances?.scores.map((s) => s.iou_threshold) ?? [], semantics === "instances" ? thresholds : [])) throw new Error("The saved agreement differs from the chosen inputs or settings. Reload the exact revisions.");
      } else {
        const record = r.annotation_reference as ReferenceRecord | undefined;
        if (!record || record.schema !== "loci.annotation-reference/v1" || record.semantics !== semantics || record.source_annotations_revision !== discovery!.source_annotations_revision ||
            record.coverage_declaration !== coverage.trim() || !isSha(record.labels_sha256) || !isSha(record.snapshot_sha256) || record.labels_sha256 !== r.arrays?.labels?.sha256 ||
            !same(record, responseRecord.annotation_reference)) throw new Error("The frozen reference differs from the selected annotation revision. Reload the source annotations.");
      }
      if (operation === "annotation_reference_run") setReference(key(r));
      await onPublished(r);
    } catch (e) { if (live()) { setError(failure(e)); if (operation === "annotation_reference_candidates") { setDiscovery(null); setAnnotationIds([]); } } }
    finally { running.current = false; if (mounted.current) setPending(false); onBusyChange(false); }
  }
  const disabled = busy || pending || !active;
  const saved = selectedResult?.kind === "annotation-agreement" && selectedResult.source_id === source.id && selectedResult.source_sha256 === source.sha256 ? selectedResult : null;
  const options = candidates.map((r) => <option key={key(r)} value={key(r)}>{resultTitle(r)} · {r.id.slice(0, 8)} · rev {r.revision_hash.slice(0, 8)}</option>);
  return <section className="research-panel research-annotation-evaluation" aria-label="Annotation agreement">
    <h2>Annotation agreement</h2><p>Compare two saved masks on the same source, crop and plane. Choose what the labels mean and declare the reference coverage.</p>
    <label>Prediction mask<select aria-label="Prediction mask" value={prediction ? predictionKey : ""} disabled={disabled} onChange={(e) => { setPrediction(e.target.value); setDiscovery(null); setAnnotationIds([]); setError(""); }}><option value="">Choose a saved prediction…</option>{options}</select></label>
    <label>Label meaning<select value={semantics} disabled={disabled} onChange={(e) => setSemantics(e.target.value as Semantics)}><option value="instances">Object instances</option><option value="foreground-region">Foreground region</option></select></label>
    <p className="annotation-agreement-note">{semantics === "instances" ? "Each positive label ID is one declared instance, including disconnected pixels. No biological identity is inferred." : "All positive labels form one foreground region. Instance identity is discarded for this comparison."}</p>
    {!candidates.length && <p>No eligible saved 2D masks on this source. Save or import a level-zero single-plane label result first; 3D and agreement derivatives cannot be compared here.</p>}
    <label>Saved reference mask<select aria-label="Saved reference mask" value={reference ? referenceKey : ""} disabled={disabled} onChange={(e) => { setReference(e.target.value); setError(""); }}><option value="">Choose a declared reference…</option>{options}</select></label>
    {prediction && <ExactLink role="Prediction" target={{ result_id: prediction.id, revision_hash: prediction.revision_hash }} onInspect={onInspect} />}
    {reference && <ExactLink role="Reference" target={{ result_id: reference.id, revision_hash: reference.revision_hash }} onInspect={onInspect} />}
    {semantics === "instances" && <label>Inclusive IoU thresholds<input aria-label="Inclusive IoU thresholds" value={thresholdText} disabled={disabled} onChange={(e) => setThresholdText(e.target.value)} aria-invalid={!validThresholds} /><small>1–8 increasing values in (0, 1], separated by commas. A pair at the threshold is eligible.</small></label>}
    {semantics === "instances" && !validThresholds && <p role="alert">Enter increasing IoU thresholds above 0 and at most 1, for example 0.5, 0.75.</p>}
    <label>Reference and coverage declaration<textarea maxLength={2048} value={declaration} disabled={disabled} onChange={(e) => setDeclaration(e.target.value)} placeholder="Who or what supplied the reference, and what does its coverage include within this crop?" /></label>
    {ineligible && <p role="alert">{ineligible}</p>}{gridMismatch && <p role="alert">These masks have different crop, channel, plane or calibrated geometry. Choose masks saved on the same exact grid; alignment is never inferred.</p>}
    <button type="button" className="primary" disabled={disabled || !prediction || !reference || Boolean(ineligible || gridMismatch) || !declaration.trim() || (semantics === "instances" && !validThresholds)} onClick={() => void perform("annotation_evaluation_run")}><Layers size={15} aria-hidden="true" />{pending ? "Working…" : "Compare saved annotations"}</button>
    <details className="annotation-reference-create"><summary>Freeze source annotations as a reference</summary><p>Save explicit closed polygons or rectangles on the prediction’s exact crop and Z/T plane. The saved reference retains this annotation revision and coverage declaration.</p>
      <button type="button" disabled={disabled || !prediction} onClick={() => void perform("annotation_reference_candidates")}>Find eligible source annotations</button>
      {discoveryValid && discovery && <><p>Source annotation revision {discovery.source_annotations_revision}</p>
        {!discovery.total && <p>No closed annotations are available on this comparison grid. Draw and save a polygon or rectangle within its crop, then refresh this list.</p>}
        <fieldset disabled={disabled}><legend>Annotations to freeze</legend>{discovery.candidates.map((a) => <label key={a.id}><input type="checkbox" checked={annotationIds.includes(a.id)}  onChange={(e) => setAnnotationIds((ids) => e.target.checked ? [...ids, a.id] : ids.filter((id) => id !== a.id))} />{a.kind} · {a.id.slice(0, 8)}</label>)}</fieldset>
        {discovery.total > 100 && <div className="annotation-agreement-actions"><button type="button" disabled={disabled || discovery.offset === 0} onClick={() => void perform("annotation_reference_candidates", Math.max(0, discovery.offset - 100))}>Previous annotations</button><span>{discovery.offset + 1}–{discovery.offset + discovery.candidates.length} of {discovery.total}</span><button type="button" disabled={disabled || discovery.offset + discovery.candidates.length >= discovery.total} onClick={() => void perform("annotation_reference_candidates", discovery.offset + 100)}>Next annotations</button></div>}
        <p>{annotationIds.length} selected across annotation pages.</p>
        <label>Frozen reference coverage<textarea maxLength={2048} value={coverage} onChange={(e) => setCoverage(e.target.value)} disabled={disabled} placeholder="Describe the selected annotations and the coverage they establish within this crop." /></label>
        <button type="button" disabled={disabled || !annotationIds.length || !coverage.trim()} onClick={() => void perform("annotation_reference_run")}><Snowflake size={15} aria-hidden="true" />Freeze selected reference</button></>}
    </details>
    <p className="annotation-agreement-note">Working memory limit: <ScientificNumber value={workingBytes / 1024 ** 2} /> MiB. Use a smaller comparison crop if this limit is exceeded.</p>
    {error && <p role="alert">{error}</p>}{saved && <AnnotationAgreementSummary key={`${snapshot.project.project_id}:${key(saved)}`} result={saved} api={api} onInspect={onInspect} />}
  </section>;
}
