import { useEffect, useId, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot } from "../shared/research-contracts";
import type { ScientificExportPreview, ScientificExportRequest } from "../shared/scientific-export-contracts";
import "./ScientificDataExportPanel.css";

type Group = {
  id: string; name: string; result_id: string; revision_hash: string;
  source_id: string; source_sha256: string; included_count: number; source_available?: boolean;
};
type GroupState = { identity: string; groups: Group[]; status: "loading" | "ready" | "error"; error?: string };
type ActiveRequest = { key: string; scope: string; phase: "planning" | "exporting"; generation: number };
const resultKey = (result: ResearchResult) => JSON.stringify([result.id, result.revision_hash]);
const reviewStatus = (result: ResearchResult) => result.review?.disposition ?? "pending";
const errorMessage = (error: unknown) => {
  if (!(error instanceof Error)) return "Could not prepare scientific data. Retry the preview.";
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .replace(/^(?:(?:Error|ValueError|FileExistsError|PermissionError|FileNotFoundError|RuntimeError):\s*)+/u, "");
  return /destination (?:must be absent|already exists)/iu.test(message)
    ? "That destination already exists. Choose a new package name or destination."
    : message;
};
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function requestIdentity(request: ScientificExportRequest): string {
  return JSON.stringify([request.purpose, request.bindings.map((binding) => [
    binding.result_id, binding.revision_hash, binding.source_id, binding.source_sha256,
    binding.subset, [...binding.group_ids].sort(),
  ])]);
}

function checkedPreview(value: ScientificExportPreview, request: ScientificExportRequest): ScientificExportPreview {
  const plan = value?.plan;
  if (!plan || plan.schema !== "loci.data-export-plan/v1" || typeof value.plan_json !== "string" || !value.plan_json ||
    plan.purpose !== request.purpose || requestIdentity(plan.request) !== requestIdentity(request) ||
    !/^[a-f0-9]{64}$/.test(plan.plan_sha256) ||
    ![plan.source_count, plan.result_count, plan.total_count, plan.selected_count, plan.measurement_count,
      plan.group_count, plan.membership_count, plan.declared_replicate_count, plan.unassigned_source_count].every(count) ||
    plan.result_count !== request.bindings.length || plan.selected_count > plan.total_count ||
    plan.source_count !== new Set(request.bindings.map((binding) => binding.source_id)).size ||
    typeof plan.mixed_units !== "boolean" || !Array.isArray(plan.results) || plan.results.length !== request.bindings.length ||
    plan.results.some((row, index) => {
      const binding = request.bindings[index];
      return row.result_id !== binding.result_id || row.revision_hash !== binding.revision_hash || row.source_id !== binding.source_id ||
        typeof row.name !== "string" || typeof row.review_status !== "string" ||
        ![row.total_count, row.selected_count, row.measurement_count, row.group_count].every(count) || row.selected_count > row.total_count ||
        !Array.isArray(row.preview) || row.preview.length > 5 || row.preview.some((entry) =>
          [entry.label, entry.measure, entry.measure_unit].some((cell) => typeof cell !== "string"));
    })) throw new Error("Preview does not match the requested exact revisions. Prepare it again.");
  return value;
}

export type ScientificDataExportDraft = {
  scope: "current" | "study";
  chosenResults: string[];
  purpose: ScientificExportRequest["purpose"];
  subset: "all" | "groups";
  chosenGroups: Record<string, string[]>;
};
export type ScientificDataExportDraftControl = {
  draft: ScientificDataExportDraft | null;
  onDraftChange: (draft: ScientificDataExportDraft) => void;
};

export function ScientificDataExportPanel({ api, snapshot, result, busy = false, onSnapshot, onSelectResult, onOpenPopulation, draftControl }: {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; result: ResearchResult | null; busy?: boolean;
  onSnapshot?: (snapshot: ResearchSnapshot | null) => void;
  onSelectResult?: (result: ResearchResult) => void;
  onOpenPopulation?: () => void;
  draftControl?: ScientificDataExportDraftControl;
}) {
  const headingId = useId();
  // Only the editable choices live above result/tab mounts. Prepared plans and
  // active requests remain local and cannot be restored by returning to a tab.
  const [localDraft, setLocalDraft] = useState<ScientificDataExportDraft>(() => ({
    scope: "current", chosenResults: result ? [resultKey(result)] : [],
    purpose: "reviewed", subset: "all", chosenGroups: {},
  }));
  const draft = draftControl?.draft ?? localDraft;
  const { scope, chosenResults, purpose, subset, chosenGroups } = draft;
  const updateDraft = <K extends keyof ScientificDataExportDraft>(key: K,
    value: ScientificDataExportDraft[K] | ((old: ScientificDataExportDraft[K]) => ScientificDataExportDraft[K])) => {
    const next = { ...draft, [key]: typeof value === "function" ? value(draft[key]) : value };
    if (draftControl) draftControl.onDraftChange(next); else setLocalDraft(next);
  };
  const setScope = (value: typeof scope) => updateDraft("scope", value);
  const setChosenResults = (value: (old: string[]) => string[]) => updateDraft("chosenResults", value);
  const setPurpose = (value: typeof purpose) => updateDraft("purpose", value);
  const setSubset = (value: typeof subset) => updateDraft("subset", value);
  const setChosenGroups = (value: (old: Record<string, string[]>) => Record<string, string[]>) => updateDraft("chosenGroups", value);
  const [groups, setGroups] = useState<GroupState | null>(null);
  const [groupRefresh, setGroupRefresh] = useState(0);
  const [prepared, setPrepared] = useState<{ scope: string; value: ScientificExportPreview } | null>(null);
  const [stalePreview, setStalePreview] = useState(false);
  const [pending, setPending] = useState<ActiveRequest | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0), groupGeneration = useRef(0), mounted = useRef(true);
  const active = useRef<ActiveRequest | null>(null);
  const onSnapshotRef = useRef(onSnapshot); onSnapshotRef.current = onSnapshot;
  const selectedKeys = scope === "current" ? (result ? [resultKey(result)] : []) : chosenResults;
  const selected = selectedKeys.map((key) => snapshot.results.find((entry) => resultKey(entry) === key));
  const exactResults = selected.filter((entry): entry is ResearchResult => Boolean(entry));
  const boundSources = exactResults.map((entry) => snapshot.sources.find((source) => source.id === entry.source_id));
  const bindingIdentity = JSON.stringify(exactResults.map((entry, index) => [
    entry.id, entry.revision_hash, entry.source_id, entry.source_sha256, boundSources[index]?.sha256, boundSources[index]?.locator_state,
  ]));
  const groupIdentity = JSON.stringify([bindingIdentity, groupRefresh]);
  const signature = JSON.stringify([
    snapshot.project.project_id, snapshot.project.title, scope, selectedKeys, exactResults, boundSources, snapshot.samples, purpose, subset,
    subset === "groups" ? [chosenGroups, groupIdentity, groups] : null,
  ]);
  const liveScope = useRef(signature);
  if (liveScope.current !== signature) { liveScope.current = signature; generation.current++; }
  const validSources = selected.length === exactResults.length && boundSources.every((source, index) =>
    source && source.locator_state !== "relink-required" && source.sha256 === exactResults[index].source_sha256 &&
    /^[a-f0-9]{64}$/.test(source.sha256) && /^[a-f0-9]{64}$/.test(exactResults[index].revision_hash));
  const groupReady = groups?.identity === groupIdentity && groups.status === "ready";
  const selectedGroupIds = (entry: ResearchResult) => chosenGroups[resultKey(entry)] ?? [];
  const missingGroups = subset === "groups" && (!groupReady || exactResults.some((entry) => {
    const ids = selectedGroupIds(entry);
    return ids.length === 0 || ids.some((id) => !groups?.groups.some((group) => group.id === id && group.result_id === entry.id &&
      group.revision_hash === entry.revision_hash && group.source_available !== false));
  }));
  const unavailable = !api.planDataExport || !api.exportDataPackage || !api.cancelDataExport;
  const scopeIssue = selectedKeys.length === 0 ? "Choose at least one exact result revision." :
    selectedKeys.length > 100 ? "Choose at most 100 exact result revisions." :
    !validSources ? "A selected revision or its matching source is unavailable. Restore the source or choose an available revision." :
    missingGroups ? "Choose at least one named group for every selected result revision." : "";
  const currentPlan = prepared?.scope === signature ? prepared.value : null;
  const job = pending?.phase === "exporting" ? snapshot.jobs.find((entry) =>
    entry.operation === "scientific_data_export" && entry.request_key === pending.key) : undefined;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; generation.current++; groupGeneration.current++;
      const obsolete = active.current; active.current = null;
      if (obsolete) void api.cancelDataExport?.(obsolete.key).catch(() => { /* No mounted surface to report to. */ });
    };
  }, [api]);

  useEffect(() => {
    setPrepared((old) => { if (old) setStalePreview(true); return null; });
    setError(""); setNotice("");
    const obsolete = active.current;
    if (obsolete && obsolete.scope !== signature) {
      active.current = null; setPending(null);
      void api.cancelDataExport?.(obsolete.key).catch((caught) => {
        if (mounted.current) setError(`Could not confirm cancellation of the previous request: ${errorMessage(caught)}`);
      });
    }
  }, [api, signature]);

  useEffect(() => {
    if (pending?.phase !== "exporting" || job || !onSnapshotRef.current) return;
    let observing = true, reading = false;
    const current = () => observing && mounted.current && active.current === pending &&
      pending.scope === liveScope.current;
    const discover = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await api.getSnapshot();
        if (current()) onSnapshotRef.current?.(next);
      } catch (caught) {
        if (current()) setError(`Could not refresh export status: ${errorMessage(caught)}`);
      } finally { reading = false; }
    };
    // Bootstrap the workbench's durable-job polling even when it started idle.
    // Once our job is visible, its existing lifecycle owns subsequent refreshes.
    void discover();
    const timer = window.setInterval(() => { void discover(); }, 1000);
    return () => { observing = false; window.clearInterval(timer); };
  }, [api, pending, job]);

  useEffect(() => {
    const token = ++groupGeneration.current;
    if (subset !== "groups" || !validSources || !exactResults.length) return;
    setGroups({ identity: groupIdentity, groups: [], status: "loading" });
    void Promise.all(exactResults.map(async (entry) => {
      const response = await api.execute("population_group_list", { result_id: entry.id, revision_hash: entry.revision_hash }) as { groups: Group[] };
      if (!Array.isArray(response?.groups) || response.groups.some((group) => typeof group.id !== "string" || typeof group.name !== "string" ||
        group.result_id !== entry.id || group.revision_hash !== entry.revision_hash || group.source_id !== entry.source_id ||
        group.source_sha256 !== entry.source_sha256 || !count(group.included_count))) {
        throw new Error("Saved groups do not match this exact result revision. Refresh the groups.");
      }
      return response.groups;
    })).then((loaded) => {
      if (mounted.current && token === groupGeneration.current) setGroups({ identity: groupIdentity, groups: loaded.flat(), status: "ready" });
    }).catch((caught) => {
      if (mounted.current && token === groupGeneration.current) setGroups({ identity: groupIdentity, groups: [], status: "error", error: errorMessage(caught) });
    });
    return () => { groupGeneration.current++; };
    // Exact identities drive this read; job-only snapshot updates must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, subset, groupIdentity, validSources]);

  const isCurrent = (request: ActiveRequest) => mounted.current && active.current === request &&
    generation.current === request.generation && liveScope.current === request.scope;
  const begin = (phase: ActiveRequest["phase"]) => {
    const request = { key: `scientific-export:${crypto.randomUUID()}`, scope: signature, phase, generation: ++generation.current };
    active.current = request; setPending(request); setStalePreview(false); setError(""); setNotice("");
    return request;
  };
  const finish = (request: ActiveRequest) => {
    if (active.current === request) { active.current = null; if (mounted.current) setPending(null); }
  };
  const preview = async () => {
    if (active.current || cancelling || busy || scopeIssue || unavailable) return;
    setPrepared(null); setStalePreview(false);
    if (purpose === "reviewed" && exactResults.some((entry) => reviewStatus(entry) !== "reviewed")) {
      setError("Reviewed data requires every selected revision to be reviewed. Review those revisions or choose Provisional data for review.");
      return;
    }
    const request = begin("planning");
    const payload: ScientificExportRequest = { purpose, bindings: exactResults.map((entry, index) => ({
      result_id: entry.id, revision_hash: entry.revision_hash, source_id: entry.source_id,
      source_sha256: boundSources[index]!.sha256, subset, group_ids: subset === "groups" ? [...selectedGroupIds(entry)].sort() : [],
    })) };
    try {
      const value = await api.planDataExport!(payload, request.key);
      if (isCurrent(request)) setPrepared({ scope: request.scope, value: checkedPreview(value, payload) });
    } catch (caught) { if (isCurrent(request)) setError(errorMessage(caught)); }
    finally { finish(request); }
  };
  const exportData = async () => {
    if (!currentPlan || active.current || cancelling || busy || scopeIssue || unavailable) return;
    const request = begin("exporting");
    try {
      const receipt = await api.exportDataPackage!(currentPlan.plan_json, request.key);
      if (!isCurrent(request)) return;
      if (!receipt) { setNotice("Destination selection cancelled. The preview is ready to export."); return; }
      setNotice(`Saved ${receipt.basename} · ${receipt.result_count} results · ${receipt.source_count} sources · ${receipt.selected_count} objects.`);
      if (onSnapshotRef.current) {
        try { const next = await api.getSnapshot(); if (isCurrent(request)) onSnapshotRef.current(next); }
        catch (caught) { if (isCurrent(request)) setError(`Data saved; study refresh failed: ${errorMessage(caught)}`); }
      }
    } catch (caught) {
      if (isCurrent(request)) { setPrepared(null); setStalePreview(false); setError(`${errorMessage(caught)} Prepare a new preview before exporting.`); }
    } finally { finish(request); }
  };
  const cancel = async () => {
    const request = active.current;
    if (!request || !api.cancelDataExport || cancelling) return;
    generation.current++; active.current = null; setPending(null); setPrepared(null); setStalePreview(false); setCancelling(true); setError("");
    setNotice("Cancellation requested…");
    try {
      const receipt = await api.cancelDataExport(request.key);
      if (mounted.current && liveScope.current === request.scope) setNotice(receipt.cancelled ?
        request.phase === "planning" ? "Preparation cancelled. No package was written." :
          "Cancellation requested. Check Jobs and the destination before retrying." :
        "Cancellation was not confirmed. Check Jobs and the destination before retrying.");
      if (request.phase === "exporting" && onSnapshotRef.current) {
        const next = await api.getSnapshot();
        if (mounted.current && liveScope.current === request.scope) onSnapshotRef.current?.(next);
      }
    } catch (caught) { if (mounted.current) { setNotice(""); setError(`Could not confirm cancellation: ${errorMessage(caught)}`); } }
    finally { if (mounted.current) setCancelling(false); }
  };
  const resultLabel = (entry: ResearchResult) => `${snapshot.sources.find((source) => source.id === entry.source_id)?.name ?? "Unavailable source"} · ${entry.method_label ?? entry.kind}`;
  const resultObjectLabel = (entry: ResearchResult) => `${entry.object_count.toLocaleString()} ${entry.object_count === 1 ? "object" : "objects"}`;
  const toggle = (items: string[], key: string, checked: boolean) => checked ? [...items, key] : items.filter((item) => item !== key);
  const unreviewedResults = exactResults.filter((entry) => reviewStatus(entry) !== "reviewed");
  const isStalePreview = !currentPlan && (prepared !== null || stalePreview) && !pending && !cancelling && !error && !notice && !scopeIssue;

  return <section className="scientific-data-export research-panel" aria-labelledby={headingId}>
    <h3 id={headingId}>Export scientific data</h3>
    <p>UTF-8 CSV tables with schemas and provenance.</p>
    <label>Results<select aria-label="Data export result scope" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
      <option value="current">Current result</option><option value="study">Choose study results</option>
    </select></label>
    {scope === "current" && (result ? <p className="scientific-data-export__identity">
      {resultLabel(result)} · {resultObjectLabel(result)} · {reviewStatus(result)}<code title={result.revision_hash}>Revision {result.revision_hash}</code>
    </p> : <p>Select a result to export its scientific data.</p>)}
    {scope === "study" && <fieldset className="scientific-data-export__choices"><legend>Exact result revisions</legend>
      {snapshot.results.length === 0 && <p>This study has no results. Run an analysis first.</p>}
      {snapshot.results.map((entry) => <div className="scientific-data-export__choice-row" key={resultKey(entry)}>
        <label className="scientific-data-export__choice">
          <input type="checkbox" checked={chosenResults.includes(resultKey(entry))}
            onChange={(event) => setChosenResults((old) => toggle(old, resultKey(entry), event.target.checked))} />
          <span>{resultLabel(entry)} · {resultObjectLabel(entry)} · {reviewStatus(entry)}<code title={entry.revision_hash}>Revision {entry.revision_hash}</code></span>
        </label>
        {onSelectResult && entry.id !== result?.id && <button type="button" className="scientific-data-export__inspect-btn"
          disabled={busy || Boolean(pending) || cancelling} onClick={() => onSelectResult(entry)}>Inspect rev {entry.revision_hash.slice(0, 8)}</button>}
      </div>)}
    </fieldset>}
    <label>Purpose<select aria-label="Data export purpose" value={purpose} onChange={(event) => setPurpose(event.target.value as typeof purpose)}>
      <option value="reviewed">Reviewed data</option><option value="provisional">Provisional data for review</option>
    </select></label>
    {purpose === "provisional" && <p>Pending and excluded review statuses are preserved. Export does not approve a result.</p>}
    <label>Objects<select aria-label="Data export object scope" value={subset} onChange={(event) => setSubset(event.target.value as typeof subset)}>
      <option value="all">All objects</option><option value="groups">Named groups subset</option>
    </select></label>
    {subset === "groups" && <>
      <p>The union of selected groups is exported for each exact revision.</p>
      {validSources && exactResults.length > 0 && (!groups || groups.identity !== groupIdentity || groups.status === "loading") && <p role="status">Loading named groups…</p>}
      {groups?.identity === groupIdentity && groups.status === "error" && <p role="alert">{groups.error}</p>}
      {groupReady && exactResults.map((entry) => {
        const available = groups.groups.filter((group) => group.result_id === entry.id && group.revision_hash === entry.revision_hash);
        return <fieldset key={resultKey(entry)} className="scientific-data-export__choices"><legend>{resultLabel(entry)}</legend>
          {available.length === 0 && <>
            <p>No named groups for this revision. Save a group or choose All objects.</p>
            <div className="scientific-data-export__recovery">
              <button type="button" disabled={busy || Boolean(pending) || cancelling} onClick={() => setSubset("all")}>Use All objects</button>
              {onOpenPopulation && entry.id === result?.id && <button type="button" disabled={busy || Boolean(pending) || cancelling}
                onClick={onOpenPopulation}>Create group in Statistics &amp; objects</button>}
            </div>
          </>}
          {available.map((group) => <label key={group.id} className="scientific-data-export__choice">
            <input type="checkbox" checked={selectedGroupIds(entry).includes(group.id)} disabled={group.source_available === false}
              onChange={(event) => setChosenGroups((old) => ({ ...old, [resultKey(entry)]: toggle(old[resultKey(entry)] ?? [], group.id, event.target.checked) }))} />
            <span>{group.name} · {group.included_count} objects{group.source_available === false ? " · source unavailable" : ""}</span>
          </label>)}
        </fieldset>;
      })}
      <button type="button" disabled={Boolean(pending) || cancelling} onClick={() => setGroupRefresh((old) => old + 1)}>Refresh groups</button>
    </>}
    {unavailable && <p role="status">Scientific data export is unavailable in this app connection.</p>}
    {scopeIssue && <p className="scientific-data-export__hint">{scopeIssue}</p>}
    {isStalePreview && <p className="scientific-data-export__caution">Export settings or review state changed since the last preview. Preview data again before exporting.</p>}
    <div className="research-actions">
      <button type="button" onClick={() => void preview()} disabled={unavailable || Boolean(scopeIssue) || busy || Boolean(pending) || cancelling}>Preview data</button>
      <button type="button" onClick={() => void exportData()} disabled={!currentPlan || unavailable || Boolean(scopeIssue) || busy || Boolean(pending) || cancelling}>Export data package…</button>
      {(pending || cancelling) && <button type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Cancelling…" : "Cancel data export"}</button>}
    </div>
    {pending?.phase === "planning" && <p role="status">Preparing preview: validating exact revisions, objects, metrics and groups…</p>}
    {pending?.phase === "exporting" && <div role="status"><p>Exporting scientific data{job ? ` · ${job.state}` : " · choose a destination in the native dialog"}…</p>
      {job && Number.isFinite(job.progress) && job.progress >= 0 && job.progress <= 1 && <progress aria-label="Scientific data export progress" value={job.progress} max={1} />}
    </div>}
    {error && <p role="alert">{error}</p>}
    {error && purpose === "reviewed" && unreviewedResults.length > 0 && <div className="scientific-data-export__recovery">
      <button type="button" disabled={busy || Boolean(pending) || cancelling} onClick={() => setPurpose("provisional")}>Use Provisional data for review</button>
      {onSelectResult && unreviewedResults[0] && unreviewedResults[0].id !== result?.id && <button type="button"
        disabled={busy || Boolean(pending) || cancelling} onClick={() => onSelectResult(unreviewedResults[0])}>Inspect unreviewed rev {unreviewedResults[0].revision_hash.slice(0, 8)}</button>}
    </div>}
    {notice && <p role="status" className="scientific-data-export__notice">{notice}</p>}
    {currentPlan && <div className="scientific-data-export__preview">
      <h4>Prepared scope</h4>
      <dl className="scientific-data-export__counts">
        {[["Results", currentPlan.plan.result_count], ["Sources", currentPlan.plan.source_count],
          ["Objects in revisions", currentPlan.plan.total_count], ["Objects to export", currentPlan.plan.selected_count],
          ["Metric values", currentPlan.plan.measurement_count], ["Groups", currentPlan.plan.group_count],
          ["Group memberships", currentPlan.plan.membership_count], ["Declared condition/replicate groups", currentPlan.plan.declared_replicate_count],
          ["Sources without a declared replicate", currentPlan.plan.unassigned_source_count]].map(([label, value]) =>
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {currentPlan.plan.mixed_units && <p className="scientific-data-export__caution">Mixed measurement units are present. Compare rows within the same metric and unit; convert units explicitly before pooling values.</p>}
      {currentPlan.plan.unassigned_source_count > 0 && <p>Assign biological replicates in study metadata before treating sources as independent samples.</p>}
      {currentPlan.plan.selected_count === 0 && <p>This scope contains zero objects. The package will retain its empty tables, schemas and provenance.</p>}
      {currentPlan.plan.results.map((entry) => <div key={JSON.stringify([entry.result_id, entry.revision_hash])}>
        <h4>{entry.name} · {entry.review_status}</h4>
        <p className="scientific-data-export__identity"><code>Result {entry.result_id}<br />Revision {entry.revision_hash}</code>
          {entry.selected_count} of {entry.total_count} objects · {entry.measurement_count} metric values · {entry.group_count} groups</p>
        {entry.preview.length > 0 && <div className="scientific-data-export__table" role="region" aria-label={`Data preview for ${entry.name}`} tabIndex={0}>
          <table><caption>First {entry.preview.length} object rows · exact stored values</caption>
            <thead><tr><th scope="col">Label</th><th scope="col">Measure</th><th scope="col">Unit</th></tr></thead>
            <tbody>{entry.preview.map((row, index) => <tr key={index}><td>{row.label}</td><td>{row.measure}</td><td>{row.measure_unit}</td></tr>)}</tbody>
          </table>
        </div>}
      </div>)}
    </div>}
  </section>;
}
