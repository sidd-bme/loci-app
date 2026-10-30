import { useEffect, useMemo, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchJob, ResearchResult, ResearchReview, ResearchSnapshot } from "../shared/research-contracts";
import type { WoundClosureExportPlan, WoundClosureExportReceipt } from "../shared/wound-closure-contracts";
import { WoundClosurePanel } from "./WoundClosurePanel";
import { checkedWoundSaved, checkedWoundStatus, readWoundRows, WoundContractError,
  type WoundBinding, type WoundMaskChoice, type WoundReportIndex, type WoundToken } from "./wound-closure-types";

export type WoundClosureToolProps = {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; active?: boolean; busy?: boolean;
  onInspect: (binding: WoundBinding) => void;
  onRefresh?: (snapshot: ResearchSnapshot) => void | Promise<void>;
};
const id = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/u.test(v);
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const count = (v: unknown, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
function fail(message: string): never { throw new WoundContractError(message); }
const exactKey = (r: WoundBinding) => `${r.result_id}:${r.revision_hash}:${r.source_id}:${r.source_sha256}`;
const kinds = new Set(["segmentation", "cell-segmentation", "adaptive-segmentation", "cellpose-segmentation", "model-segmentation", "external-labels", "corrected-labels"]);
const binding = (r: ResearchResult): WoundBinding | null => id(r.id) && sha(r.revision_hash) && id(r.source_id) && sha(r.source_sha256)
  ? { result_id: r.id, revision_hash: r.revision_hash, source_id: r.source_id, source_sha256: r.source_sha256 } : null;
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
async function digest(v: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(v)));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
}
function message(error: unknown) {
  const value = error instanceof Error ? error.message : "The native wound operation failed. Retry after checking Jobs.";
  return value.replace(/^Error invoking remote method '[^']+':\s*/u, "").replace(/(?:[A-Za-z]:\\|\/)[^\s,;]+/gu, "[local path]");
}

/** Read actual unfiltered measured labels, never infer 1..object_count or use scatter sampling. */
export async function loadWoundMaskLabels(api: ResearchDesktopApi, exact: WoundBinding, current: () => boolean): Promise<number[] | null> {
  const labels: number[] = []; let total: number | null = null, membership = "";
  do {
    if (!current()) return null;
    const offset = labels.length;
    const value = record(await api.execute("population_query", { result_id: exact.result_id, revision_hash: exact.revision_hash,
      filters: [], sort: { metric: "label", direction: "asc" }, offset, limit: 200, plot_limit: 1, bins: 1 }));
    if (!current()) return null;
    const query = record(value.query), sort = record(query.sort);
    if (value.schema !== "loci.population/v1" || Object.entries(exact).some(([key, expected]) => value[key] !== expected) ||
        !count(value.total_count, 100000) || value.filtered_count !== value.total_count || !sha(value.membership_sha256) ||
        !Array.isArray(query.filters) || query.filters.length || sort.metric !== "label" || sort.direction !== "asc" ||
        query.offset !== offset || query.limit !== 200 || !Array.isArray(value.rows) || value.rows.length > 200) fail("The exact mask label page is inconsistent. Reload its saved revision.");
    if (total === null) { total = Number(value.total_count); membership = String(value.membership_sha256); }
    if (value.total_count !== total || value.membership_sha256 !== membership || offset + value.rows.length > total ||
        (!value.rows.length && offset < total)) fail("The mask population changed or ended before all label IDs were read.");
    for (const valueRow of value.rows) {
      const label = record(valueRow).label;
      if (!count(label, 0xffffffff) || Number(label) === 0 || (labels.length > 0 && Number(label) <= labels.at(-1)!)) fail("Mask label IDs must be unique positive labels in exact ascending order.");
      labels.push(Number(label));
    }
  } while (labels.length < total!);
  if (!current()) return null;
  if (await digest({ ...exact, filters: [], labels }) !== membership) fail("The complete mask label membership does not match its verified population receipt.");
  return current() ? labels : null;
}
function indexRows(value: unknown): WoundReportIndex[] {
  const rows = record(value).reports;
  if (!Array.isArray(rows)) return fail("The saved wound report list is invalid.");
  const seen = new Set<string>();
  return rows.map((valueRow) => {
    const row = record(valueRow);
    if (!id(row.id) || seen.has(row.id) || typeof row.created_at !== "string" || typeof row.specimen_id !== "string" || typeof row.sequence_id !== "string") fail("The saved wound report identity is invalid.");
    seen.add(row.id);
    return { id: row.id, created_at: row.created_at, specimen_id: row.specimen_id, sequence_id: row.sequence_id, status: checkedWoundStatus(row.status) };
  });
}
function checkedPlan(value: unknown, reportId: string, hash: string): WoundClosureExportPlan {
  const plan = record(value);
  if (plan.schema !== "loci.wound-closure-export-plan/v1" || plan.report_id !== reportId || plan.report_hash !== hash || !sha(plan.plan_hash)) fail("The native export plan does not match the saved wound report.");
  checkedWoundStatus(plan.status);
  return plan as unknown as WoundClosureExportPlan;
}
function checkedReceipt(value: unknown, hash: string): WoundClosureExportReceipt {
  const receipt = record(value);
  if (receipt.schema !== "loci.wound-closure-export-receipt/v1" || receipt.report_hash !== hash || !sha(receipt.manifest_sha256) || typeof receipt.basename !== "string" ||
      !receipt.basename || receipt.basename === "." || receipt.basename === ".." || /[/\\\u0000-\u001f]/u.test(receipt.basename)) fail("The native export receipt is inconsistent. Inspect Jobs before retrying publication.");
  return receipt as unknown as WoundClosureExportReceipt;
}
type ReviewView = { inputs: WoundBinding[]; selected: WoundBinding | null; offset: number;
  total: number; next: number | null; events: ResearchReview[]; loading: boolean };

export function WoundClosureTool({ api, snapshot, active = true, busy = false, onInspect, onRefresh }: WoundClosureToolProps) {
  const [masks, setMasks] = useState<WoundMaskChoice[]>([]), [selectedMask, setSelectedMask] = useState("");
  const [reports, setReports] = useState<WoundReportIndex[]>([]), [loading, setLoading] = useState(false), [catalogLoading, setCatalogLoading] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [reviews, setReviews] = useState<ReviewView | null>(null);
  const [tick, setTick] = useState(0), [exportKey, setExportKey] = useState<string | null>(null), [cancelPending, setCancelPending] = useState(false);
  const [exportSettled, setExportSettled] = useState(false), settledExport = useRef<string | null>(null);
  const mounted = useRef(true), epoch = useRef(0), labelEpoch = useRef(0), reviewEpoch = useRef(0), exportRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const refreshRef = useRef(onRefresh); refreshRef.current = onRefresh;
  const connection = useRef({ api, generation: 0 });
  if (connection.current.api !== api) connection.current = { api, generation: connection.current.generation + 1 };
  const connectionId = connection.current.generation;
  const studyKey = snapshot.project.project_id ?? "";
  const enabled = active && id(studyKey); activeRef.current = enabled;
  const evidence = useMemo(() => JSON.stringify([studyKey, connectionId, snapshot.samples, snapshot.sources.map((s) => [s.id, s.sha256, s.locator_state]),
    snapshot.results.map((r) => [r.id, r.revision_hash, r.source_id, r.source_sha256, r.schema, r.kind, r.arrays?.labels, r.selection, r.geometry])]), [studyKey, connectionId, snapshot.samples, snapshot.sources, snapshot.results]);
  const evidenceRef = useRef(evidence); evidenceRef.current = evidence;
  const candidates = snapshot.results.filter((r) => kinds.has(r.kind) && r.schema === "loci.research-result/v1" && r.arrays?.labels?.shape?.length === 2 &&
    binding(r) && snapshot.sources.some((s) => s.id === r.source_id && s.sha256 === r.source_sha256 && s.locator_state !== "relink-required"));
  const available = snapshot.results.flatMap((r) => {
    const b = binding(r); return b && snapshot.sources.some((s) => s.id === b.source_id && s.sha256 === b.source_sha256 && s.locator_state !== "relink-required") ? [b] : [];
  });
  const choiceName = (r: ResearchResult) => `${snapshot.sources.find((s) => s.id === r.source_id)?.name ?? "Bound source"} · ${r.method_label ?? r.kind} · ${r.revision_hash.slice(0, 10)}`;
  const isAvailable = (b: WoundBinding) => snapshotRef.current.results.some((r) => binding(r) && exactKey(binding(r)!) === exactKey(b)) &&
    snapshotRef.current.sources.some((s) => s.id === b.source_id && s.sha256 === b.source_sha256 && s.locator_state !== "relink-required");
  const guard = () => {
    const at = epoch.current, signature = evidence, atApi = api;
    return () => mounted.current && activeRef.current && connection.current.api === atApi && epoch.current === at && evidenceRef.current === signature;
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; labelEpoch.current++; reviewEpoch.current++;
    const key = exportRef.current; exportRef.current = null; if (key && settledExport.current !== key) void api.cancelDataExport?.(key).catch(() => {});
  }; }, [api]);
  const previousStudy = useRef(studyKey), previousApi = useRef(api);
  useEffect(() => {
    epoch.current++; labelEpoch.current++; reviewEpoch.current++; setLoading(false); setError(""); setNotice(""); setReviews(null);
    if (previousStudy.current !== studyKey || previousApi.current !== api) { previousStudy.current = studyKey; previousApi.current = api; setMasks([]); }
    else setMasks((old) => old.filter((mask) => candidates.some((r) => exactKey(binding(r)!) === exactKey(mask))));
    setSelectedMask("");
    const key = exportRef.current; exportRef.current = null; settledExport.current = null; setExportKey(null); setCancelPending(false); setExportSettled(false);
    if (key) void api.cancelDataExport?.(key).catch(() => {});
    // Exact input evidence, rather than job/list changes, invalidates preview authority.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evidence, active, api]);
  useEffect(() => {
    if (!active || !id(studyKey)) { setReports([]); setCatalogLoading(false); return; }
    const current = guard(); let live = true; setCatalogLoading(true);
    void api.execute("wound_closure_list", {}).then((value) => { if (live && current()) setReports(indexRows(value)); })
      .catch((caught) => { if (live && current()) { setReports([]); setError(message(caught)); } })
      .finally(() => { if (live && current()) setCatalogLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, evidence, active, tick, studyKey]);
  const loadMask = async () => {
    if (loading || busy || !enabled) return;
    const result = candidates.find((r) => `${r.id}:${r.revision_hash}` === selectedMask), exact = result && binding(result);
    if (!result || !exact) return;
    const scopeCurrent = guard(), own = ++labelEpoch.current, current = () => scopeCurrent() && labelEpoch.current === own;
    setLoading(true); setError("");
    try {
      const labels = await loadWoundMaskLabels(api, exact, current); if (!labels || !current()) return;
      const choice = { ...exact, name: choiceName(result), label_ids: labels };
      const next = [...masks.filter((m) => exactKey(m) !== exactKey(exact)), choice];
      if (new TextEncoder().encode(JSON.stringify(next)).length > 8 * 1024 ** 2) fail("Loaded mask choices exceed the 8 MiB metadata budget. Remove unused choices before adding this mask.");
      setMasks(next); setSelectedMask(""); setNotice(`Loaded all ${labels.length} positive measured label IDs for ${choice.name}.`);
    } catch (caught) { if (current()) setError(message(caught)); }
    finally { if (current()) setLoading(false); }
  };
  const nativeSave = async (token: WoundToken) => {
    const current = guard();
    // The native execute promise covers research_submit + research_run. Never
    // load a report while its owning save worker is still publishing it.
    const value = record(await api.execute("wound_closure_save", { ...token }));
    if (!current()) throw new Error("The study inputs changed while saving. Its durable job remains in Jobs.");
    const saved = checkedWoundSaved(value), job = record(value.job), request = record(job.request), task = record(request.task_request);
    if (!id(job.id) || job.operation !== "wound_closure_save" || job.state !== "succeeded" || job.owner || job.report_id !== saved.report_id ||
        task.preview_id !== token.preview_id || task.preview_hash !== token.preview_hash || Object.keys(task).length !== 2) fail("The native wound save did not return its exact terminal job. Inspect Jobs before retrying.");
    const next = await api.getSnapshot(); if (!current()) throw new Error("The wound save completed in a study that is no longer active.");
    if (!next || next.project.project_id !== studyKey) fail("The save job belongs to a different study.");
    const terminal = next.jobs.find((j) => j.id === job.id) as (ResearchJob & { report_id?: string }) | undefined;
    if (!terminal || terminal.request_hash !== job.request_hash || terminal.request_key !== job.request_key || terminal.state !== "succeeded" || terminal.operation !== "wound_closure_save" || terminal.owner || terminal.report_id !== saved.report_id) fail("The native save job has not reached its verified terminal state. Inspect Jobs.");
    const output = await api.execute("wound_closure_get", { report_id: saved.report_id }); if (!current()) throw new Error("The wound report study changed during reload.");
    const checked = checkedWoundSaved(output);
    if (checked.report_id !== saved.report_id || checked.summary.report_hash !== saved.summary.report_hash) fail("The saved wound report changed while being loaded.");
    setTick((n) => n + 1); await refreshRef.current?.(next); return output;
  };
  const inspect = (b: WoundBinding) => { if (!isAvailable(b)) { setError("This exact input revision is unavailable. Restore it before inspection."); return; } onInspect(b); };
  const inspectReviews = async (identity: { report_id: string; report_hash: string }) => {
    const scopeCurrent = guard(), own = ++reviewEpoch.current;
    const current = () => scopeCurrent() && reviewEpoch.current === own; setError("");
    const saved = checkedWoundSaved(await api.execute("wound_closure_get", { report_id: identity.report_id }));
    if (!current()) return;
    if (saved.report_id !== identity.report_id || saved.summary.report_hash !== identity.report_hash) fail("The input review target differs from the saved wound report.");
    const rows = await readWoundRows((request) => api.execute("wound_closure_query", { ...request }), { report_id: identity.report_id }, saved.summary, current);
    if (!rows || !current()) return;
    const inputs = rows.inputs.flatMap((f) => f.result_id ? [{ result_id: f.result_id, revision_hash: f.revision_hash!, source_id: f.source_id!, source_sha256: f.source_sha256! }] : []);
    setReviews({ inputs, selected: null, offset: 0, total: 0, next: null, events: [], loading: false });
  };
  const readReviews = async (b: WoundBinding, offset = 0) => {
    if (reviews?.loading || busy || !enabled) return;
    if (!isAvailable(b)) { setError("The exact input revision is unavailable; its current review history cannot substitute for the saved revision."); return; }
    const scopeCurrent = guard(), own = ++reviewEpoch.current;
    const current = () => scopeCurrent() && reviewEpoch.current === own;
    setError(""); setReviews((old) => old ? { ...old, selected: b, loading: true } : old);
    try {
      const value = record(await api.execute("review_history", { result_id: b.result_id, offset, limit: 100 }));
      if (!current()) return;
      if (value.result_id !== b.result_id || value.revision_hash !== b.revision_hash || !count(value.total_events, 10000) || !Array.isArray(value.events) ||
          value.events.length !== Math.min(100, Number(value.total_events) - offset) || value.next_offset !== (offset + 100 < Number(value.total_events) ? offset + 100 : null)) fail("The input review history does not match its exact revision and page.");
      const events: ResearchReview[] = value.events.map((entry) => {
        const event = record(entry);
        if (event.result_id !== b.result_id || !sha(event.revision_hash) || !["reviewed", "excluded", "pending"].includes(String(event.disposition)) ||
            !["human", "agent"].includes(String(event.actor)) || typeof event.reviewed_at !== "string") fail("An input review decision has an invalid revision binding.");
        return { result_id: b.result_id, revision_hash: event.revision_hash, disposition: String(event.disposition), actor: event.actor as "human" | "agent", reviewed_at: event.reviewed_at,
          ...(typeof event.actor_id === "string" ? { actor_id: event.actor_id } : {}), ...(typeof event.reason === "string" ? { reason: event.reason } : {}), ...(typeof event.coverage === "string" ? { coverage: event.coverage } : {}) };
      });
      setReviews((old) => old ? { ...old, selected: b, events, offset, total: Number(value.total_events), next: value.next_offset as number | null, loading: false } : old);
    } catch (caught) { if (current()) { setError(message(caught)); setReviews((old) => old ? { ...old, loading: false } : old); } }
  };
  const exportReport = async (identity: { report_id: string; report_hash: string }) => {
    if (!api.planWoundClosureExport || !api.exportWoundClosureReport || !api.cancelDataExport) throw new Error("Native wound export is unavailable in this app connection.");
    const current = guard(), key = `scientific-export:${crypto.randomUUID()}`;
    exportRef.current = key; settledExport.current = null; setExportSettled(false); setExportKey(key); setNotice("");
    try {
      const plan = checkedPlan(await api.planWoundClosureExport(identity.report_id, key), identity.report_id, identity.report_hash);
      if (!current() || exportRef.current !== key) return;
      const value = await api.exportWoundClosureReport(identity.report_id, plan.plan_hash, key);
      if (!current() || exportRef.current !== key) return;
      settledExport.current = key; setExportSettled(true);
      if (value === null) { setNotice("Destination selection cancelled. The saved wound report is unchanged."); return; }
      const receipt = checkedReceipt(value, identity.report_hash);
      setNotice(`Exported ${receipt.basename}. Exact endpoints, provenance and original masks were saved.`);
      try {
        const next = await api.getSnapshot();
        if (current()) {
          if (!next || next.project.project_id !== studyKey) throw new Error("The exported study is no longer active.");
          await refreshRef.current?.(next);
        }
      } catch {
        if (current()) setNotice(`Exported ${receipt.basename}. Study refresh failed; reload Jobs to update its status.`);
      }
    } catch (caught) { if (current()) setNotice(""); throw caught; }
    finally { if (exportRef.current === key) { exportRef.current = null; settledExport.current = null; setExportKey(null); setCancelPending(false); setExportSettled(false); } }
  };
  const cancelExport = async () => {
    const key = exportRef.current; if (!key || settledExport.current === key || cancelPending || !api.cancelDataExport) return;
    const current = guard(); setCancelPending(true); setNotice("Cancellation requested; waiting for the native export to settle.");
    try { await api.cancelDataExport(key); } catch (caught) { if (current() && exportRef.current === key) { setCancelPending(false); setError(message(caught)); } }
  };
  const unavailable = !api.planWoundClosureExport || !api.exportWoundClosureReport || !api.cancelDataExport;
  return <div className="wound-closure"><section className="research-panel" aria-label="Wound mask choices">
    <h3>Prepare exact mask choices</h3><p>Add only the mask revisions needed for this sequence. Each choice loads its complete measured label membership; source time indices are not converted to biological time.</p>
    <label>Saved label mask<select value={selectedMask} disabled={busy || loading || Boolean(exportKey) || !enabled} onChange={(e) => setSelectedMask(e.target.value)}><option value="">Choose an exact label result</option>
      {candidates.map((r) => <option key={`${r.id}:${r.revision_hash}`} value={`${r.id}:${r.revision_hash}`}>{choiceName(r)}</option>)}</select></label>
    <div className="wound-actions"><button type="button" disabled={!selectedMask || busy || loading || Boolean(exportKey) || !enabled} onClick={() => void loadMask()}>Load complete mask labels</button>
      {loading && <button type="button" onClick={() => { labelEpoch.current++; setLoading(false); }}>Stop loading mask labels</button>}</div>
    {loading && <p role="status">Reading complete exact label membership…</p>}
    {catalogLoading && <p role="status">Reading saved wound reports…</p>}
    {!id(studyKey) && <p>Open a study with a verified identity before preparing wound reports.</p>}
    {!candidates.length && <p>No compatible bounded YX label results are available in this study.</p>}
    {masks.length > 0 && <ul className="wound-saved-list">{masks.map((mask) => <li key={exactKey(mask)}><span>{mask.name}<small>{mask.label_ids.length} measured positive label IDs</small></span><button type="button" disabled={busy || loading || Boolean(exportKey) || !enabled} onClick={() => setMasks((old) => old.filter((m) => exactKey(m) !== exactKey(mask)))}>Remove mask choice</button></li>)}</ul>}
  </section>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <WoundClosurePanel studyKey={studyKey} inputVersion={evidence} masks={masks} inspectionBindings={available} exportAvailable={!unavailable} reports={reports} active={enabled} busy={busy || loading || Boolean(exportKey)}
      onPreview={(request) => api.execute("wound_closure_preview", { ...request })} onSave={nativeSave}
      onGet={(request) => api.execute("wound_closure_get", request)} onQuery={(request) => api.execute("wound_closure_query", { ...request })}
      onInspect={inspect} onInspectReviews={inspectReviews} onExport={exportReport} />
    {unavailable && <p>Native wound export is unavailable in this app connection.</p>}
    {exportKey && !exportSettled && <button type="button" disabled={cancelPending} onClick={() => void cancelExport()}>Cancel wound export</button>}
    {reviews && <section className="research-panel" aria-label="Wound input review histories"><h3>Input review histories</h3><p>These are existing decisions about exact input masks. They do not approve this wound report.</p>
      <ul className="wound-saved-list">{reviews.inputs.map((b) => <li key={exactKey(b)}><span>{snapshot.sources.find((s) => s.id === b.source_id)?.name ?? "Bound source"}<code>{b.result_id}<br />{b.revision_hash}</code></span>
        <button type="button" disabled={busy || Boolean(exportKey) || !active || reviews.loading || !isAvailable(b)} onClick={() => void readReviews(b)}>Read input review history</button><button type="button" disabled={busy || Boolean(exportKey) || !active || !isAvailable(b)} onClick={() => inspect(b)}>Inspect input mask</button></li>)}</ul>
      {reviews.loading && <p role="status">Reading exact input review history…</p>}
      {reviews.selected && !reviews.loading && <><p>{reviews.total} recorded review decisions for this input.</p><ol start={reviews.offset + 1}>{reviews.events.map((event, i) => <li key={reviews.offset + i}>{event.disposition} · {event.actor}{event.actor_id ? ` (${event.actor_id}, declared)` : ""} · {event.reviewed_at}
        <p>{event.revision_hash === reviews.selected!.revision_hash ? "Matches the report input revision" : "Decision on another revision"}</p>{event.reason && <p>{event.reason}</p>}{event.coverage && <p>Coverage: {event.coverage}</p>}</li>)}</ol>
        <div className="wound-pages"><button type="button" disabled={busy || !active || !reviews.offset} onClick={() => void readReviews(reviews.selected!, Math.max(0, reviews.offset - 100))}>Previous review page</button><button type="button" disabled={busy || !active || reviews.next === null} onClick={() => void readReviews(reviews.selected!, reviews.next!)}>Next review page</button></div></>}
    </section>}
  </div>;
}
