import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ScientificNumber } from "./ScientificNumber";
import { bindWoundPreview, checkedWoundPreview, checkedWoundSaved, readWoundRows, WoundContractError,
  type WoundBinding, type WoundCallbacks, type WoundInput, type WoundMaskChoice, type WoundReportIndex,
  type WoundRequest, type WoundRows, type WoundSaved, type WoundStatus, type WoundSummary, type WoundToken } from "./wound-closure-types";
import "./WoundClosurePanel.css";

export type WoundClosurePanelProps = WoundCallbacks & {
  /** Change either key when the study or its authoritative input metadata changes. */
  studyKey: string; inputVersion: string; masks: WoundMaskChoice[]; reports: WoundReportIndex[];
  /** Exact available inputs for inspection; loading their label populations is only needed for authoring. */
  inspectionBindings?: WoundBinding[];
  exportAvailable?: boolean;
  active?: boolean; busy?: boolean;
};
type FrameDraft = { id: string; time: string; missing: boolean; reason: string; result: string; labels: string; zero: boolean };
type Draft = { specimen: string; sequence: string; timeDeclaration: string; areaDeclaration: string;
  gridDeclaration: string; filled: boolean; workingMiB: string; frames: FrameDraft[] };
type View = { summary: WoundSummary; rows: WoundRows; token: WoundToken | null;
  reportId: string | null; status: WoundStatus | null; timeDeclaration: string };
const newFrame = (n: number): FrameDraft => ({ id: `Frame ${n}`, time: "", missing: false, reason: "", result: "", labels: "", zero: false });
const fresh = (): Draft => ({ specimen: "", sequence: "", timeDeclaration: "", areaDeclaration: "", gridDeclaration: "", filled: false,
  workingMiB: "256", frames: [newFrame(1), newFrame(2)] });
const key = (r: Pick<WoundBinding, "result_id" | "revision_hash">) => `${r.result_id}:${r.revision_hash}`;
const unit = (s: string) => s.replace("um", "µm").replace("^2", "²");
const number = (value: number | null) => <ScientificNumber value={value} />;
function requestFor(draft: Draft, masks: WoundMaskChoice[]): WoundRequest {
  const requireText = (value: string, name: string, max: number) => {
    if (!value.trim() || value.length > max) throw new Error(`${name} is required (up to ${max} characters).`);
    return value.trim();
  };
  const specimen_id = requireText(draft.specimen, "Specimen identity", 240);
  const sequence_id = requireText(draft.sequence, "Sequence identity", 240);
  const time_declaration = requireText(draft.timeDeclaration, "Acquisition time basis", 2048);
  const area_declaration = requireText(draft.areaDeclaration, "Filled-area definition", 2048);
  const grid_declaration = requireText(draft.gridDeclaration, "Shared grid declaration", 2048);
  if (!draft.filled) throw new Error("Declare that the selected labels represent filled wound area.");
  const working_bytes = Number(draft.workingMiB) * 1024 ** 2;
  if (!draft.workingMiB.trim() || !Number.isSafeInteger(working_bytes) || working_bytes < 1024 ** 2 || working_bytes > 8 * 1024 ** 3) throw new Error("Working memory must be between 1 and 8192 MiB.");
  const used = new Set<string>(), ids = new Set<string>(), time_s: number[] = [];
  const frames = draft.frames.map((frame, i) => {
    const frame_id = requireText(frame.id, `Frame ${i + 1} identity`, 128);
    if (ids.has(frame_id)) throw new Error("Each frame slot needs a unique identity.");
    ids.add(frame_id);
    const seconds = Number(frame.time);
    if (!frame.time.trim() || !Number.isFinite(seconds) || Math.abs(seconds) > 1e15 || (i > 0 && seconds <= time_s[i - 1])) throw new Error("Enter actual seconds for every slot in strictly increasing order.");
    time_s.push(seconds);
    if (frame.missing) {
      if (!i) throw new Error("The first scheduled frame must be observed with positive baseline area.");
      return { frame_id, missing_reason: requireText(frame.reason, `Frame ${i + 1} missing reason`, 512) };
    }
    const mask = masks.find((r) => key(r) === frame.result);
    if (!mask) throw new Error(`Choose an available exact mask revision for frame ${i + 1}.`);
    if (mask.mask_semantics === "boundary-only" || mask.mask_semantics === "skeleton") throw new Error("Boundary and skeleton masks cannot represent filled wound area.");
    if (used.has(mask.result_id)) throw new Error("An exact mask result cannot represent two observations.");
    used.add(mask.result_id);
    let selected_labels: number[] = [];
    if (!frame.zero) {
      const parts = frame.labels.trim().split(/[\s,]+/u);
      if (!frame.labels.trim() || parts.some((part) => !/^\d+$/u.test(part))) throw new Error(`Enter positive filled-region label IDs for frame ${i + 1}, or explicitly choose observed zero area.`);
      selected_labels = parts.map(Number);
      if (selected_labels.length > 100000 || selected_labels.some((v) => !Number.isSafeInteger(v) || v < 1 || v > 0xffffffff) || new Set(selected_labels).size !== selected_labels.length) throw new Error("Label IDs must be unique positive integers, with at most 100,000 selected labels.");
      const available = new Set(mask.label_ids);
      if (selected_labels.some((v) => !available.has(v))) throw new Error("A selected label is unavailable in this exact mask revision.");
      selected_labels.sort((a, b) => a - b);
    }
    if (!i && !selected_labels.length) throw new Error("The baseline must select a positive filled wound area.");
    return { frame_id, result_id: mask.result_id, revision_hash: mask.revision_hash, selected_labels, mask_semantics: "filled-wound-area" as const };
  });
  const request = { frames, time_s, time_unit: "s" as const, time_declaration, specimen_id, sequence_id, area_declaration, grid_declaration, working_bytes };
  if (new TextEncoder().encode(JSON.stringify(request)).length > 1024 ** 2) throw new Error("The frame and label selections exceed the bounded request size. Reduce the selected scope.");
  return request;
}
function safeError(error: unknown, action: string): string {
  if (error instanceof WoundContractError) return error.message;
  const detail = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*/u, "") : "Check the inputs and retry.";
  return `${action} failed. ${detail.replace(/(?:[A-Za-z]:\\|\/)[^\s,;]+/gu, "[local path]")}`;
}

function ClosurePlot({ rows }: { rows: WoundRows }) {
  const observed = rows.frames.filter((r) => r.status === "observed");
  const scale = Math.max(...observed.map((r) => Math.abs(r.closure_fraction!)), 1);
  const low = Math.min(0, ...observed.map((r) => r.closure_fraction! / scale));
  const high = Math.max(1 / scale, ...observed.map((r) => r.closure_fraction! / scale));
  const first = rows.frames[0].time_s, last = rows.frames.at(-1)!.time_s;
  const x = (t: number) => 65 + 480 * (t - first) / (last - first);
  const y = (v: number) => 30 + 160 * (1 - (v / scale - low) / (high - low));
  const points = new Map(observed.map((r) => [r.frame_id, r]));
  return <figure className="wound-plot"><h4>Closure over observed time</h4><svg viewBox="0 0 580 245" role="img" aria-label="Closure fraction over actual seconds; missing frames remain gaps">
    <title>Closure over observed time</title>
    {[low, high].map((v, i) => <g key={i}><line x1={65} x2={545} y1={y(v * scale)} y2={y(v * scale)} stroke="currentColor" opacity="0.25" /><text x={55} y={y(v * scale) + 4} textAnchor="end">{Number((v * scale).toPrecision(4))}</text></g>)}
    <line x1={65} x2={545} y1={y(0)} y2={y(0)} stroke="currentColor" opacity="0.4" />
    {rows.intervals.filter((r) => r.status === "defined").map((r) => {
      const a = points.get(r.from_frame_id)!, b = points.get(r.to_frame_id)!;
      return <line key={r.from_frame_id} x1={x(a.time_s)} y1={y(a.closure_fraction!)} x2={x(b.time_s)} y2={y(b.closure_fraction!)} className="wound-plot-line" data-wound-interval={r.from_frame_id} />;
    })}
    {rows.frames.map((r) => r.status === "missing" ? <g key={r.frame_id}><path d={`M${x(r.time_s) - 4},210 l8,8 m-8,0 l8,-8`} stroke="currentColor" /><title>{r.frame_id}: missing at {r.time_s} s</title></g>
      : <circle key={r.frame_id} cx={x(r.time_s)} cy={y(r.closure_fraction!)} r="4" className="wound-plot-point"><title>{r.frame_id}: {r.closure_fraction} closure at {r.time_s} s</title></circle>)}
    <text x={65} y={235}>{first} s</text><text x={545} y={235} textAnchor="end">{last} s</text><text x={305} y={235} textAnchor="middle">Actual time (s)</text>
  </svg><figcaption>Closure fraction = 1 − area / baseline area. Negative values retain area growth. Lines join adjacent observed slots only; crosses mark missing slots.</figcaption></figure>;
}
function FrameTables({ view, masks, disabled, onInspect }: { view: View; masks: WoundBinding[]; disabled: boolean; onInspect: WoundCallbacks["onInspect"] }) {
  const [page, setPage] = useState(0), [intervalPage, setIntervalPage] = useState(0);
  const size = 25, { rows, summary } = view, area = unit(summary.measurement.area_unit);
  const inspect = (input: WoundInput) => {
    const exact = masks.find((r) => r.result_id === input.result_id && r.revision_hash === input.revision_hash && r.source_id === input.source_id && r.source_sha256 === input.source_sha256);
    return exact ? <button type="button" disabled={disabled} onClick={() => onInspect({ result_id: exact.result_id, revision_hash: exact.revision_hash, source_id: exact.source_id, source_sha256: exact.source_sha256 })}>Inspect exact mask</button> : <small>Exact mask revision unavailable</small>;
  };
  const pages = (name: string, current: number, total: number, change: (v: number) => void) => <div className="wound-pages" role="group" aria-label={`${name} pages`}>
    <button type="button" disabled={disabled || !current} onClick={() => change(current - 1)}>Previous</button>
    <span>{Math.min(current * size + 1, total)}–{Math.min((current + 1) * size, total)} of {total}</span>
    <button type="button" disabled={disabled || (current + 1) * size >= total} onClick={() => change(current + 1)}>Next</button>
  </div>;
  return <><ClosurePlot rows={rows} />
    <div className="wound-table" role="region" aria-label="Wound frame endpoints" tabIndex={0}><table><caption>Scheduled frames · area in {area} · closure is a fraction</caption>
      <thead><tr><th scope="col">Frame / seconds</th><th scope="col">Selected area ({area})</th><th scope="col">Area / baseline</th><th scope="col">Closure fraction</th><th scope="col">State / exact mask</th></tr></thead>
      <tbody>{rows.frames.slice(page * size, (page + 1) * size).map((r, i) => <tr key={r.frame_id}><th scope="row">{r.frame_id}<br />{" "}{number(r.time_s)} s</th>
        <td>{r.status === "missing" ? "Missing" : number(r.area)}</td><td>{r.status === "missing" ? "—" : number(r.area_fraction)}</td><td>{r.status === "missing" ? "—" : number(r.closure_fraction)}</td>
        <td>{r.status === "missing" ? <>Missing — {r.missing_reason}</> : <>{r.area === 0 ? "Observed zero area" : "Observed"}<br />{inspect(rows.inputs[page * size + i])}</>}</td></tr>)}</tbody></table></div>
    {pages("Frame", page, rows.frames.length, setPage)}
    <div className="wound-table" role="region" aria-label="Adjacent wound intervals" tabIndex={0}><table><caption>Adjacent scheduled intervals · no estimate across a missing frame</caption>
      <thead><tr><th scope="col">From → to</th><th scope="col">Elapsed (s)</th><th scope="col">Area change ({area}/s)</th><th scope="col">Closure change (1/s)</th></tr></thead>
      <tbody>{rows.intervals.slice(intervalPage * size, (intervalPage + 1) * size).map((r) => <tr key={r.from_frame_id}><th scope="row">{r.from_frame_id} → {r.to_frame_id}</th><td>{number(r.delta_time_s)}</td>
        <td>{r.status === "missing_endpoint" ? "Undefined: missing endpoint" : number(r.area_change_rate)}</td><td>{r.status === "missing_endpoint" ? "Undefined: missing endpoint" : number(r.closure_change_rate)}</td></tr>)}</tbody></table></div>
    {pages("Interval", intervalPage, rows.intervals.length, setIntervalPage)}
    <details className="wound-details"><summary>Exact masks, source identities and captured samples</summary>
      {rows.inputs.slice(page * size, (page + 1) * size).map((input) => <div key={input.frame_id}><h4>{input.frame_id} · {input.time_s} s</h4>
        {input.result_id ? <><code>{input.result_id}<br />{input.revision_hash}</code><p>Selected labels: {input.selected_label_count} · label union SHA-256 <code>{input.selected_labels_sha256}</code></p>
          <pre tabIndex={0}>{JSON.stringify({ source_id: input.source_id, source_sha256: input.source_sha256, result_record_sha256: input.result_record_sha256,
            labels: input.labels, geometry: input.geometry, selection: input.selection, sample: input.sample }, null, 2)}</pre>{inspect(input)}</> : <p>Missing: {input.missing_reason}</p>}</div>)}
      <p>Identities follow the current frame page. Original sources and masks remain immutable.</p>
    </details>
  </>;
}

export function WoundClosurePanel(props: WoundClosurePanelProps) {
  const { masks, reports, studyKey, inputVersion, active = true, busy = false } = props;
  const [draft, setDraft] = useState<Draft>(fresh), [view, setView] = useState<View | null>(null);
  const [pending, setPending] = useState<string | null>(null), [error, setError] = useState("");
  const setupStatus = useId();
  const generation = useRef(0), lock = useRef(false), alive = useRef(true), nextFrame = useRef(3);
  const scope = useMemo(() => JSON.stringify([studyKey, inputVersion, masks.map((m) => [key(m), m.source_id, m.source_sha256, m.mask_semantics, m.label_ids])]), [studyKey, inputVersion, masks]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const activeRef = useRef(active); activeRef.current = active;
  const lastStudy = useRef(studyKey);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => {
    generation.current++; lock.current = false; setPending(null); setError("");
    if (lastStudy.current !== studyKey) { lastStudy.current = studyKey; nextFrame.current = 3; setDraft(fresh()); setView(null); }
    else setView((old) => old?.reportId ? { ...old, status: null } : null);
  }, [scope, studyKey, active]);
  const edit = (change: (old: Draft) => Draft) => { generation.current++; setDraft(change); setView((old) => old?.reportId ? old : null); setError(""); };
  const patch = (i: number, change: Partial<FrameDraft>) => edit((old) => ({ ...old, frames: old.frames.map((f, j) => i === j ? { ...f, ...change } : f) }));
  let request: WoundRequest | null = null, invalid = "";
  try { request = requestFor(draft, masks); } catch (caught) { invalid = caught instanceof Error ? caught.message : "Check the frame inputs."; }
  const locked = Boolean(pending) || busy || !active;
  const perform = async (name: string, action: (current: () => boolean) => Promise<void>) => {
    if (lock.current || busy || !active) return;
    const id = ++generation.current, startScope = scope;
    const current = () => alive.current && activeRef.current && generation.current === id && scopeRef.current === startScope;
    lock.current = true; setPending(name); setError("");
    try { await action(current); } catch (caught) { if (current()) setError(safeError(caught, name)); }
    finally { if (generation.current === id && alive.current) { lock.current = false; setPending(null); } }
  };
  const previewReport = () => {
    if (!request) return;
    const submitted = request;
    void perform("Preview", async (current) => {
      setView(null);
      const response = checkedWoundPreview(await props.onPreview(submitted)); if (!current()) return;
      const token = { preview_id: response.preview_id, preview_hash: response.preview_hash };
      const rows = await readWoundRows(props.onQuery, token, response.summary, current); if (!rows || !current()) return;
      await bindWoundPreview(submitted, response.summary, rows, masks); if (!current()) return;
      setView({ summary: response.summary, rows, token, reportId: null, status: null, timeDeclaration: submitted.time_declaration });
    });
  };
  const showSaved = (saved: WoundSaved, rows: WoundRows) => setView({ summary: saved.summary, rows, token: null,
    reportId: saved.report_id, status: saved.status, timeDeclaration: saved.time_declaration });
  const saveReport = () => {
    if (!view?.token) return;
    const original = view;
    void perform("Save", async (current) => {
      const saved = checkedWoundSaved(await props.onSave(original.token!)); if (!current()) return;
      if (saved.summary.report_hash !== original.summary.report_hash || saved.summary.request_sha256 !== original.summary.request_sha256 || saved.summary.measurement.baseline_area !== original.summary.measurement.baseline_area || saved.summary.measurement.area_unit !== original.summary.measurement.area_unit || saved.time_declaration !== original.timeDeclaration) throw new WoundContractError("The saved report differs from this preview. Reload it before continuing.");
      showSaved(saved, original.rows); props.onSaved?.(saved);
    });
  };
  const openReport = (id: string) => { void perform("Open report", async (current) => {
    const saved = checkedWoundSaved(await props.onGet({ report_id: id })); if (!current()) return;
    if (saved.report_id !== id) throw new WoundContractError("A different saved report was returned. Reload the requested report.");
    const rows = await readWoundRows(props.onQuery, { report_id: id }, saved.summary, current);
    if (rows && current()) showSaved(saved, rows);
  }); };
  return <section className="research-panel wound-closure" aria-label="Wound closure" aria-busy={Boolean(pending)}>
    <header className="wound-heading"><div><h2>Wound closure</h2><p>Filled wound area over an explicitly timed specimen sequence.</p></div>
      {view?.reportId && <button type="button" disabled={locked} onClick={() => { generation.current++; setView(null); setError(""); }}>New wound report</button>}</header>
    {!view?.reportId && <fieldset className="wound-author" disabled={locked}><legend>Specimen and acquisition</legend>
      <div className="wound-fields"><label>Specimen identity<input value={draft.specimen} maxLength={240} onChange={(e) => edit((d) => ({ ...d, specimen: e.target.value }))} /></label>
        <label>Sequence identity<input value={draft.sequence} maxLength={240} onChange={(e) => edit((d) => ({ ...d, sequence: e.target.value }))} /></label></div>
      <label>Acquisition time basis<textarea value={draft.timeDeclaration} maxLength={2048} placeholder="Where the actual elapsed seconds were recorded" onChange={(e) => edit((d) => ({ ...d, timeDeclaration: e.target.value }))} /></label>
      <label>Filled-area definition<textarea value={draft.areaDeclaration} maxLength={2048} placeholder="Which filled regions represent the wound area" onChange={(e) => edit((d) => ({ ...d, areaDeclaration: e.target.value }))} /></label>
      <label className="wound-check"><input type="checkbox" checked={draft.filled} onChange={(e) => edit((d) => ({ ...d, filled: e.target.checked }))} />Selected labels represent filled wound area</label>
      <p>Boundary-only and skeleton masks cannot supply wound area. Masks are not filled or modified here.</p>
      <label>Shared field of view and calibration<textarea value={draft.gridDeclaration} maxLength={2048} placeholder="How this sequence retains one field of view, plane, grid and calibration" onChange={(e) => edit((d) => ({ ...d, gridDeclaration: e.target.value }))} /></label>
      <h3>Scheduled frames</h3><p>Enter actual seconds for every slot. The first frame must have positive observed area. Mark an unavailable acquisition as missing.</p>
      {draft.frames.map((frame, i) => <fieldset key={i} className="wound-frame"><legend>Frame slot {i + 1}{!i ? " · baseline" : ""}</legend>
        <div className="wound-fields"><label>Frame identity<input value={frame.id} maxLength={128} onChange={(e) => patch(i, { id: e.target.value })} /></label>
          <label>Actual time (s)<input type="text" inputMode="decimal" value={frame.time} onChange={(e) => patch(i, { time: e.target.value })} /></label></div>
        {i > 0 && <label className="wound-check"><input type="checkbox" checked={frame.missing} onChange={(e) => patch(i, { missing: e.target.checked })} />Missing acquisition</label>}
        {frame.missing ? <label>Missing frame reason<input value={frame.reason} maxLength={512} onChange={(e) => patch(i, { reason: e.target.value })} /></label> : <>
          <label>Exact filled-area mask<select value={frame.result} onChange={(e) => patch(i, { result: e.target.value, labels: "", zero: false })}><option value="">Choose a mask revision</option>
            {masks.map((mask) => <option key={key(mask)} value={key(mask)} disabled={mask.mask_semantics === "boundary-only" || mask.mask_semantics === "skeleton"}>{mask.name} · {mask.revision_hash.slice(0, 10)}{mask.mask_semantics === "boundary-only" || mask.mask_semantics === "skeleton" ? " · boundary/skeleton" : ""}</option>)}</select></label>
          {!frame.zero && <label>Filled-region label IDs<input value={frame.labels} placeholder="Positive label IDs, separated by commas" onChange={(e) => patch(i, { labels: e.target.value })} /></label>}
          <div className="wound-actions"><button type="button" disabled={!frame.result || frame.zero} onClick={() => patch(i, { labels: masks.find((m) => key(m) === frame.result)!.label_ids.join(", ") })}>Use all available labels</button>
            {i > 0 && <label className="wound-check"><input type="checkbox" checked={frame.zero} onChange={(e) => patch(i, { zero: e.target.checked })} />Observed zero area (no selected labels)</label>}</div>
          {frame.result && <details className="wound-details"><summary>Chosen mask identity</summary><code>{frame.result.replace(":", "\n")}</code></details>}
        </>}
        {draft.frames.length > 2 && i > 0 && <button type="button" onClick={() => edit((d) => ({ ...d, frames: d.frames.filter((_, j) => i !== j) }))}>Remove frame slot {i + 1}</button>}
      </fieldset>)}
      <button type="button" disabled={draft.frames.length >= 1000} onClick={() => { const added = newFrame(nextFrame.current++); edit((d) => ({ ...d, frames: [...d.frames, added] })); }}>Add frame slot</button>
      <details className="wound-details"><summary>Memory budget</summary><label>Working memory (MiB)<input inputMode="numeric" value={draft.workingMiB} onChange={(e) => edit((d) => ({ ...d, workingMiB: e.target.value }))} /></label></details>
    </fieldset>}
    {!masks.length && !view?.reportId && <p>No mask results are available. Prepare a filled wound label result for each observed frame first.</p>}
    {!view?.reportId && <><p className="wound-help" id={setupStatus}>{invalid || "Ready to verify exact masks, calibration and area/time endpoints."}</p>
      <div className="wound-actions"><button type="button" disabled={locked || !request} aria-describedby={setupStatus} onClick={previewReport}>Preview wound closure</button>
        {view?.token && <button type="button" disabled={locked} onClick={saveReport}>Save immutable report</button>}</div></>}
    {pending && <p role="status">{pending} in progress…{["Preview", "Open report"].includes(pending) && <button type="button" onClick={() => { generation.current++; lock.current = false; setPending(null); }}>Stop loading</button>}</p>}
    {error && <p role="alert">{error}</p>}
    {view && <div className="wound-report" key={view.summary.report_hash}>
      <h3>{view.reportId ? "Saved wound report" : "Verified preview"}</h3>
      <p>{view.summary.measurement.specimen_id} · {view.summary.measurement.sequence_id}<br />{view.summary.totals.observed_frames} observed · {view.summary.totals.missing_frames} missing · baseline {number(view.summary.measurement.baseline_area)} {unit(view.summary.measurement.area_unit)}</p>
      <p>{view.summary.measurement.calibration_status === "uncalibrated-pixel-area" ? "Uncalibrated pixel area; physical area was not inferred." : "Area uses the retained physical calibration."}</p>
      {view.reportId && view.status === null && <p role="status">Refresh current sample metadata to check changes against this saved report. <button type="button" disabled={locked} onClick={() => openReport(view.reportId!)}>Refresh saved report</button></p>}
      {view.status && !view.status.current && <p className="wound-stale" role="status">Current sample metadata has changed for {view.status.changes.length} source(s). These saved values and captured samples remain unchanged.</p>}
      <FrameTables view={view} masks={props.inspectionBindings ?? masks} disabled={locked} onInspect={props.onInspect} />
      <details className="wound-details"><summary>Report identity and measurement definitions</summary><p>Created {view.summary.created_at} · engine {view.summary.software.engine}</p><code>{view.summary.report_hash}</code>
        <dl><dt>Acquisition time basis</dt><dd>{view.timeDeclaration}</dd><dt>Filled-area definition</dt><dd>{view.summary.measurement.area_declaration}</dd><dt>Shared grid</dt><dd>{view.summary.measurement.grid_declaration}</dd></dl>
        <p>Study: {view.summary.sample_identity.study ?? "Not assigned"} · biological replicate: {view.summary.sample_identity.biological_replicate ?? "Not assigned"}</p>
        <p>{view.summary.sample_identity.missing_sample_frames} observed frames lack sample metadata; {view.summary.sample_identity.unassigned_biological_replicate_frames} lack a declared biological replicate.</p>
        <pre tabIndex={0}>{JSON.stringify({ request_sha256: view.summary.request_sha256, rules: view.summary.measurement.rules }, null, 2)}</pre>
      </details>
      {view.reportId && <div className="wound-actions"><button type="button" disabled={locked} onClick={() => { void perform("Reading input reviews", async () => props.onInspectReviews({ report_id: view.reportId!, report_hash: view.summary.report_hash })); }}>Inspect input reviews</button>
        <button type="button" disabled={locked || props.exportAvailable === false} onClick={() => { void perform("Export", async () => props.onExport({ report_id: view.reportId!, report_hash: view.summary.report_hash })); }}>Export wound report…</button></div>}
    </div>}
    {reports.length > 0 && <details className="wound-details"><summary>Saved wound reports ({reports.length})</summary><ul className="wound-saved-list">{reports.map((report) => <li key={report.id}><span>{report.specimen_id} · {report.sequence_id}<small>{report.created_at}{report.status.current ? "" : " · sample metadata changed"}</small></span><button type="button" disabled={locked} onClick={() => openReport(report.id)}>Open saved report</button></li>)}</ul></details>}
  </section>;
}
