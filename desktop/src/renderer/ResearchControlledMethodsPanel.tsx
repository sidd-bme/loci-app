import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, FileInput, FlaskConical } from "lucide-react";
import type { ControlledMethodBinding, ControlledMethodInfo, ControlledMethodInputBinding, ControlledMethodMetric } from "../shared/controlled-method-contracts";
import type { ResearchDesktopApi, ResearchJob, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { sanitizeRendererError } from "./ContextHelp";
import { resultTitle } from "./result-title";
import "./ResearchControlledMethodsPanel.css";

const PARENTS = new Set(["segmentation", "cell-segmentation", "adaptive-segmentation", "cellpose-segmentation", "model-segmentation", "external-labels", "corrected-labels"]);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
type Flight = { preflight_hash: string; preflight: { request: ControlledMethodBinding; label_ids: number[]; estimated_working_bytes: number; input_sha256: string }; runtime: ControlledMethodInfo["runtime"] };
type MethodSummary = { schema: string; method_id: string; manifest_sha256: string; module_sha256: string; input_sha256: string; output_sha256: string; preflight_hash: string; origin: "adopted-external" | "executed-local-child"; total_rows: number; raw_channels: number[]; metrics: ControlledMethodMetric[] };
type MethodPage = { result_id: string; revision_hash: string; rows: { label_id: number; values: number[] }[]; next_offset: number | null; total_rows: number };
const errorText = (error: unknown) => sanitizeRendererError(error instanceof Error ? error.message : "The controlled-method operation could not complete.");

const same = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length && entries.every(([key, value]) => Object.hasOwn(right, key) && same(value, (right as Record<string, unknown>)[key]));
};
const qualified = (runtime: ControlledMethodInfo["runtime"] | undefined) => runtime?.available === true && runtime.execution_available === true && runtime.qualification === "accepted-native-evidence";

type MethodCatalogPage = { methods: ControlledMethodInfo[]; next_offset: number | null };
function checkedCatalog(value: unknown, offset: number): MethodCatalogPage {
  const page = value as MethodCatalogPage | undefined;
  if (!page || !Array.isArray(page.methods) || page.methods.length > 50 ||
      (page.next_offset !== null && (page.next_offset !== offset + 50 || page.next_offset > 10000 || page.methods.length !== 50)) ||
      new Set(page.methods.map(item => item?.method_id)).size !== page.methods.length ||
      page.methods.some(item => !item || !id(item.method_id) || !sha(item.manifest_sha256) || !sha(item.module_sha256) ||
        item.manifest?.schema !== "loci.controlled-method/v1" || typeof item.manifest.id !== "string" || typeof item.manifest.version !== "string" ||
        item.manifest.module?.sha256 !== item.module_sha256 || !item.manifest.rights ||
        ![item.manifest.rights.license, item.manifest.rights.source, item.manifest.rights.use_basis].every(v => typeof v === "string") ||
        !Array.isArray(item.manifest.metrics) || item.manifest.metrics.length < 1 || item.manifest.metrics.length > 16 ||
        item.manifest.metrics.some(metric => !metric || typeof metric.id !== "string" || typeof metric.unit !== "string" || typeof metric.description !== "string" || !["measurement", "prediction"].includes(metric.kind)) ||
        !["approved", "not-reviewed", "revoked"].includes(item.rights_status) || !item.runtime ||
        typeof item.runtime.available !== "boolean" || typeof item.runtime.execution_available !== "boolean" || typeof item.runtime.qualification !== "string"))
    throw new Error("The registered method page is inconsistent. Reload the method list before continuing.");
  return page;
}
function mergeMethods(known: ControlledMethodInfo[], incoming: ControlledMethodInfo[]): ControlledMethodInfo[] {
  const merged = new Map(known.map(item => [item.method_id, item]));
  for (const next of incoming) {
    const previous = merged.get(next.method_id);
    if (previous && (previous.manifest_sha256 !== next.manifest_sha256 || previous.module_sha256 !== next.module_sha256))
      throw new Error("A registered method ID returned a different immutable identity. Reload the method list.");
    merged.set(next.method_id, next);
  }
  return [...merged.values()];
}

function checkedSummary(result: ResearchResult): MethodSummary {
  const value = result.controlled_method as MethodSummary | undefined;
  if (result.kind !== "controlled-method" || !id(result.id) || !sha(result.revision_hash) || !value || value.schema !== "loci.controlled-method-derivative/v1" || !id(value.method_id) ||
      ![value.manifest_sha256, value.module_sha256, value.input_sha256, value.output_sha256, value.preflight_hash].every(sha) ||
      !["adopted-external", "executed-local-child"].includes(value.origin) ||
      !Number.isSafeInteger(value.total_rows) || value.total_rows < 0 || value.total_rows !== result.object_count ||
      !Array.isArray(value.raw_channels) || value.raw_channels.length < 1 || value.raw_channels.length > 8 ||
      value.raw_channels.some(channel => !Number.isSafeInteger(channel) || channel < 0 || channel > 255) || new Set(value.raw_channels).size !== value.raw_channels.length ||
      !Array.isArray(value.metrics) || value.metrics.length < 1 || value.metrics.length > 16 ||
      new Set(value.metrics.map(metric => metric.id)).size !== value.metrics.length || value.metrics.some(metric => !["measurement", "prediction"].includes(metric.kind) || typeof metric.id !== "string" || typeof metric.unit !== "string" || typeof metric.description !== "string"))
    throw new Error("The saved method identity or output contract is inconsistent. Reload this exact result.");
  return value;
}

export function ControlledMethodSummary({ api, result }: { api: ResearchDesktopApi; result: ResearchResult }) {
  const [page, setPage] = useState<MethodPage | null>(null), [offset, setOffset] = useState(0), [error, setError] = useState("");
  const [opened, setOpened] = useState(false);
  const key = `${result.id}:${result.revision_hash}`;
  useEffect(() => { setPage(null); setOffset(0); setError(""); }, [key]);
  useEffect(() => {
    if (!opened) return;
    let live = true;
    setPage(null); setError("");
    void api.execute("method_query", { result_id: result.id, revision_hash: result.revision_hash, offset, limit: 25 }).then(value => {
      if (!live) return;
      const next = value as MethodPage;
      const summary = checkedSummary(result);
      if (!next || next.result_id !== result.id || next.revision_hash !== result.revision_hash || next.total_rows !== summary.total_rows ||
          !Array.isArray(next.rows) || next.rows.length !== Math.min(25, Math.max(0, summary.total_rows - offset)) ||
          next.next_offset !== (offset + 25 < summary.total_rows ? offset + 25 : null) ||
          new Set(next.rows.map(row => row.label_id)).size !== next.rows.length || next.rows.some(row => !Number.isSafeInteger(row.label_id) || row.label_id < 1 ||
            !Array.isArray(row.values) || row.values.length !== summary.metrics.length || row.values.some(v => !Number.isFinite(v))))
        throw new Error("The returned method rows do not match this exact result.");
      setPage(next);
    }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [api, key, opened, offset]);
  try {
    const summary = checkedSummary(result);
    return <section className="controlled-method-summary" aria-label="Saved controlled method output">
      <h3>Saved method output</h3>
      <p>{summary.origin === "adopted-external" ? "External output adopted" : "Executed in a qualified local worker"} · {summary.total_rows.toLocaleString()} objects</p>
      <p>{summary.origin === "adopted-external" ? "Externally supplied values are bound to the exact input labels. Loci has not verified how they were produced." : "The saved receipt binds the method, runtime and exact input buffers."} Scientific review is recorded separately.</p>
      <details onToggle={event => setOpened(event.currentTarget.open)}><summary>Inspect method values</summary>
        {error && <p role="alert">{error}</p>}
        {!page && !error && opened && <p role="status">Loading exact retained values…</p>}
        {page && <><div className="controlled-method-table" role="region" aria-label="Exact retained method values" tabIndex={0}><table><thead><tr><th scope="col">Label</th>{summary.metrics.map(metric => <th key={metric.id} scope="col">{metric.description}<small>{metric.kind} · {metric.unit}</small></th>)}</tr></thead>
          <tbody>{page.rows.map(row => <tr key={row.label_id}><th scope="row">{row.label_id}</th>{row.values.map((value, index) => <td key={summary.metrics[index].id}>{String(value)}</td>)}</tr>)}</tbody></table></div>
          <div className="controlled-method-actions"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous values</button>
            <span>{page.total_rows ? `${offset + 1}–${offset + page.rows.length} of ${page.total_rows}` : "0 values"}</span><button disabled={page.next_offset === null} onClick={() => setOffset(page.next_offset!)}>Next values</button></div></>}
      </details>
      <details><summary>Exact method provenance</summary><dl>{(["manifest_sha256", "module_sha256", "input_sha256", "output_sha256"] as const).map(field => <div key={field}><dt>{field.replaceAll("_", " ")}</dt><dd>{summary[field]}</dd></div>)}</dl></details>
    </section>;
  } catch (e) { return <p role="alert">{errorText(e)}</p>; }
}

export function ResearchControlledMethodsPanel({ api, snapshot, source, selectedResult, active, busy, workingBytes, onBusyChange, onPublished }: {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; source: ResearchSource; selectedResult: ResearchResult | null;
  active: boolean; busy: boolean; workingBytes: number; onBusyChange: (busy: boolean) => void; onPublished: (result: ResearchResult) => Promise<void>;
}) {
  const [methods, setMethods] = useState<ControlledMethodInfo[]>([]), [chosen, setChosen] = useState("");
  const [nextMethodOffset, setNextMethodOffset] = useState<number | null>(null);
  const [parentKey, setParentKey] = useState(""), [channels, setChannels] = useState<number[]>([]);
  const [flight, setFlight] = useState<Flight | null>(null), [grant, setGrant] = useState<{ output_grant_id: string; output_sha256: string; preflight_hash: string } | null>(null);
  const [pending, setPending] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reviewer, setReviewer] = useState(""), [evidence, setEvidence] = useState("");
  const candidates = snapshot.results.filter(result => result.source_id === source.id && result.source_sha256 === source.sha256 && PARENTS.has(result.kind) && result.geometry?.axes === "YX" && result.arrays?.labels && result.arrays?.image);
  const parent = candidates.find(result => `${result.id}:${result.revision_hash}` === parentKey);
  const method = methods.find(item => item.method_id === chosen);
  const binding: ControlledMethodBinding | null = method && parent ? { method_id: method.method_id, manifest_sha256: method.manifest_sha256, module_sha256: method.module_sha256, result_id: parent.id, revision_hash: parent.revision_hash, raw_channels: channels, working_bytes: workingBytes } : null;
  const study = snapshot.project.project_id;
  const identity = JSON.stringify([study, source.id, source.sha256, binding]);
  const live = useRef({ identity, active, api, study }); live.current = { identity, active, api, study };
  const mounted = useRef(true), running = useRef(false), registryVersion = useRef(0), catalog = useRef<ControlledMethodInfo[]>([]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setFlight(null); setGrant(null); setNotice(""); }, [identity]);
  useEffect(() => { catalog.current = []; setMethods([]); setNextMethodOffset(null); setChosen(""); setParentKey(""); setChannels([]); setReviewer(""); setEvidence(""); setError(""); }, [study]);
  useEffect(() => { setParentKey(""); setChannels([]); }, [source.id, source.sha256]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const version = registryVersion.current;
    void api.execute("method_list", { offset: 0, limit: 50 }).then(value => {
      if (!current) return;
      const page = checkedCatalog(value, 0);
      const next = registryVersion.current === version ? mergeMethods(catalog.current, page.methods) : mergeMethods(page.methods, catalog.current);
      catalog.current = next; setMethods(next);
      setNextMethodOffset(page.next_offset);
    }).catch(e => { if (current) setError(errorText(e)); });
    return () => { current = false; };
  }, [api, study, active]);
  async function perform(label: string, action: () => Promise<void>) {
    if (running.current || busy || !active) return;
    running.current = true; setPending(label); setError(""); setNotice(""); onBusyChange(true);
    try { await action(); } catch (e) { if (mounted.current && live.current.identity === identity && live.current.api === api && live.current.active) setError(errorText(e)); }
    finally { running.current = false; if (mounted.current) setPending(""); onBusyChange(false); }
  }
  const current = () => mounted.current && live.current.identity === identity && live.current.api === api && live.current.active;
  async function loadMoreMethods() {
    if (nextMethodOffset === null) return;
    const offset = nextMethodOffset, version = registryVersion.current;
    await perform("Loading more methods…", async () => {
      const page = checkedCatalog(await api.execute("method_list", { offset, limit: 50 }), offset);
      if (!current()) return;
      // A concurrent native import or rights decision remains newer than this listing.
      const next = registryVersion.current === version ? mergeMethods(catalog.current, page.methods) : mergeMethods(page.methods, catalog.current);
      catalog.current = next; setMethods(next); setNextMethodOffset(page.next_offset);
    });
  }
  const input = flight && binding ? { ...binding, preflight_hash: flight.preflight_hash } as ControlledMethodInputBinding : null;
  function acceptMethod(next: ControlledMethodInfo) {
    if (!id(next.method_id) || !sha(next.manifest_sha256) || next.module_sha256 !== next.manifest.module.sha256) throw new Error("The imported method identity is inconsistent.");
    const updated = mergeMethods(catalog.current, [next]);
    registryVersion.current += 1;
    catalog.current = updated; setMethods(updated); setChosen(next.method_id);
  }
  async function run(mode: "execute" | "adopt-external") {
    if (!input || !parent || !flight || !method || (mode === "adopt-external" && !grant) ||
        (mode === "execute" && (!qualified(flight.runtime) || method.rights_status !== "approved"))) return;
    await perform(mode === "execute" ? "Running method…" : "Adopting external output…", async () => {
      const request = { ...input, mode, ...(mode === "adopt-external" ? { output_grant_id: grant!.output_grant_id } : {}) };
      const output = await api.execute("method_run", request) as { result: ResearchResult; job: ResearchJob };
      if (!current()) return;
      const result = output.result, job = output.job;
      if (!result || !id(result.id) || !sha(result.revision_hash) || result.id === parent.id || result.kind !== "controlled-method" || result.parent_id !== parent.id || result.source_id !== source.id || result.source_sha256 !== source.sha256 ||
          result.arrays?.image?.sha256 !== parent.arrays?.image?.sha256 || result.arrays?.labels?.sha256 !== parent.arrays?.labels?.sha256 ||
          !same(result.selection, parent.selection) || !same(result.geometry, parent.geometry) ||
          !job || !id(job.id) || !same(job.request, { source_id: source.id, task_request: request }) || job.operation !== "method_run" || job.state !== "succeeded" || job.owner || !Array.isArray(job.result_ids) || job.result_ids.length !== 1 || job.result_ids[0] !== result.id)
        throw new Error("The returned method result does not match its completed job and exact input. Inspect Jobs before retrying.");
      const saved = checkedSummary(result);
      if (saved.method_id !== input.method_id || saved.manifest_sha256 !== input.manifest_sha256 || saved.module_sha256 !== input.module_sha256 || saved.preflight_hash !== input.preflight_hash ||
          saved.input_sha256 !== flight.preflight.input_sha256 || saved.total_rows !== flight.preflight.label_ids.length || !same(saved.raw_channels, input.raw_channels) || !same(saved.metrics, method.manifest.metrics) ||
          saved.origin !== (mode === "execute" ? "executed-local-child" : "adopted-external") || (grant && mode === "adopt-external" && saved.output_sha256 !== grant.output_sha256))
        throw new Error("The method output provenance differs from the accepted input.");
      await onPublished(result);
    });
  }
  const locked = busy || Boolean(pending) || !active;
  const channelCount = source.metadata.dimensions?.c ?? 1;
  return <section className="controlled-method-panel" aria-label="Controlled reusable methods">
    <div className="controlled-method-heading"><FlaskConical size={20} aria-hidden="true"/><div><h3>Reusable methods</h3><p>Apply a versioned method to exact saved labels and raw channels.</p></div></div>
    <button disabled={locked || !api.importControlledMethod} onClick={() => void perform("Importing method…", async () => { const next = await api.importControlledMethod!(); if (next && current()) acceptMethod(next); })}><FileInput size={16} aria-hidden="true"/> Import method package</button>
    <label>Registered method<select value={chosen} disabled={locked} onChange={event => setChosen(event.target.value)}><option value="">Choose a method…</option>{methods.map(item => <option key={item.method_id} value={item.method_id}>{item.manifest.id} · {item.manifest.version}</option>)}</select></label>
    {nextMethodOffset !== null && <div className="controlled-method-actions"><span>{methods.length} registered methods loaded</span><button disabled={locked} onClick={() => void loadMoreMethods()}>Load more methods</button></div>}
    {!methods.length && <p className="controlled-method-empty">Import a local Loci method package to inspect its declared outputs and rights. Importing a package does not execute it.</p>}
    {method && <>
      <div className="controlled-method-definition"><strong>{method.manifest.id} <span>v{method.manifest.version}</span></strong><p>{method.manifest.rights.license} · Rights {method.rights_status.replaceAll("-", " ")}</p>
        <ul>{method.manifest.metrics.map(metric => <li key={metric.id}><span>{metric.description}</span><small>{metric.kind} · {metric.unit}</small></li>)}</ul></div>
      <label>Input label result<select value={parent ? parentKey : ""} disabled={locked} onChange={event => { setParentKey(event.target.value); const selected = candidates.find(r => `${r.id}:${r.revision_hash}` === event.target.value); setChannels(selected?.selection ? [selected.selection.c] : []); }}><option value="">Choose saved labels…</option>{candidates.map(result => <option key={result.id} value={`${result.id}:${result.revision_hash}`}>{resultTitle(result)} · {result.revision_hash.slice(0, 8)}</option>)}</select></label>
      {parent && <fieldset disabled={locked}><legend>Raw input channels, in selected order</legend><div className="controlled-method-channels">{Array.from({ length: channelCount }, (_, channel) => <label key={channel}><input type="checkbox" checked={channels.includes(channel)} disabled={!channels.includes(channel) && channels.length >= 8} onChange={event => setChannels(old => event.target.checked ? [...old, channel] : old.filter(c => c !== channel))}/>Channel {channel + 1}</label>)}</div><p>{channels.length ? channels.map(c => `Channel ${c + 1}`).join(" → ") : "Select at least one raw channel."}</p></fieldset>}
      <button disabled={locked || !binding || !channels.length} onClick={() => void perform("Checking exact inputs…", async () => {
        const next = await api.execute("method_preflight", { ...binding! }) as Flight;
        if (!current()) return;
        if (!next || !sha(next.preflight_hash) || !sha(next.preflight?.input_sha256) || !same(next.preflight.request, binding) ||
            !Array.isArray(next.preflight.label_ids) || next.preflight.label_ids.some((label, index, labels) => !Number.isSafeInteger(label) || label < 1 || label > 0xffffffff || (index > 0 && label <= labels[index - 1])) ||
            !Number.isSafeInteger(next.preflight.estimated_working_bytes) || next.preflight.estimated_working_bytes < 1 || next.preflight.estimated_working_bytes > workingBytes || !next.runtime ||
            typeof next.runtime.available !== "boolean" || typeof next.runtime.execution_available !== "boolean" || typeof next.runtime.qualification !== "string")
          throw new Error("The preflight does not describe the selected method inputs.");
        setFlight(next); setGrant(null);
      })}>Check method inputs</button>
      {input && flight && <div className="controlled-method-ready" role="region" aria-label="Exact method input ready"><strong>{flight.preflight.label_ids.length.toLocaleString()} objects · Exact inputs checked</strong>
        <p>{qualified(flight.runtime) ? "A qualified local execution runtime is available." : flight.runtime.execution_reason || flight.runtime.reason || "Local controlled execution is unavailable."}</p>
        <div className="controlled-method-actions"><button disabled={locked || !api.exportControlledMethodInput} onClick={() => void perform("Exporting exact inputs…", async () => { const receipt = await api.exportControlledMethodInput!(input); if (receipt && current()) { if (receipt.preflight_hash !== input.preflight_hash || !sha(receipt.sha256)) throw new Error("Input export receipt does not match this preflight."); setNotice(`Exact input package exported: ${receipt.basename}`); } })}><ArrowDownToLine size={16} aria-hidden="true"/>Export exact inputs</button>
          <button disabled={locked || !api.chooseControlledMethodOutput} onClick={() => void perform("Checking external output…", async () => { const next = await api.chooseControlledMethodOutput!(input); if (next && current()) { if (next.preflight_hash !== input.preflight_hash || !sha(next.output_sha256) || !id(next.output_grant_id)) throw new Error("The external output belongs to a different preflight."); setGrant(next); } })}>Choose external output</button></div>
        {grant && <><p>Returned values checked against the exact input package. Adopting them retains externally supplied values; their production remains unverified.</p><button className="primary" disabled={locked} onClick={() => void run("adopt-external")}>Adopt external output</button></>}
        <button disabled={locked || !qualified(flight.runtime) || method.rights_status !== "approved"} onClick={() => void run("execute")}>Run locally</button>
      </div>}
      <details><summary>Method rights and provenance</summary><p>{method.manifest.rights.use_basis}</p><p>{method.manifest.rights.source}</p><p>Rights decisions authorize an exact method. They do not approve its scientific results.</p>
        <label>Reviewer<input value={reviewer} maxLength={256} disabled={locked} onChange={event => setReviewer(event.target.value)}/></label><label>Rights evidence<textarea value={evidence} maxLength={8192} disabled={locked} onChange={event => setEvidence(event.target.value)}/></label>
        <div className="controlled-method-actions">{(["approved", "revoked"] as const).map(decision => <button key={decision} disabled={locked || !reviewer.trim() || !evidence.trim() || !api.reviewControlledMethodRights} onClick={() => void perform("Recording rights decision…", async () => { const next = await api.reviewControlledMethodRights!({ method_id: method.method_id, manifest_sha256: method.manifest_sha256, module_sha256: method.module_sha256, decision, reviewer, evidence }); if (next && current()) acceptMethod(next); })}>{decision === "approved" ? "Review execution rights" : "Revoke execution rights"}</button>)}</div>
        <dl><dt>Manifest SHA-256</dt><dd>{method.manifest_sha256}</dd><dt>Module SHA-256</dt><dd>{method.module_sha256}</dd></dl>
      </details>
    </>}
    {pending && <p role="status">{pending}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {selectedResult?.kind === "controlled-method" && selectedResult.source_id === source.id && selectedResult.source_sha256 === source.sha256 && <ControlledMethodSummary key={`${study}:${selectedResult.id}:${selectedResult.revision_hash}`} api={api} result={selectedResult}/>}
  </section>;
}
