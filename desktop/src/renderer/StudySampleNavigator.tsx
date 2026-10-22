import { useEffect, useMemo, useState } from "react";
import type { ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { reviewLabel } from "./ResearchReviewHistory";
import { resultTitle } from "./result-title";
import "./StudySampleNavigator.css";

const SOURCE_PAGE_SIZE = 25;
const RESULT_PAGE_SIZE = 10;
const ALL = "all";
const UNASSIGNED = "unassigned";
const declaredKey = (value: string) => JSON.stringify(["declared", value]);
const blank = (value: unknown): boolean => typeof value !== "string" || !value.trim();
const declarationKey = (value: string | null | undefined) => blank(value) ? UNASSIGNED : declaredKey(value!);
const required = ["study", "sample", "condition"] as const;
type Status = "all" | "missing" | "unassigned" | "pending" | "none";

/** Same exact-review guard as the workbench history. A contradictory receipt is pending. */
export function studyResultReviewState(result: ResearchResult): "pending" | "reviewed" | "excluded" {
  const review = result.review;
  if (!review || (review.result_id !== undefined && review.result_id !== result.id) ||
    (review.revision_hash !== undefined && review.revision_hash !== result.revision_hash)) return "pending";
  return review.disposition === "reviewed" || review.disposition === "excluded" ? review.disposition : "pending";
}
function DeclaredValue({ value, required = false }: { value?: string | null; required?: boolean }) {
  return blank(value) ? <span className="study-sample-unassigned">{required ? "Missing" : "Unassigned"}</span> :
    <span className="study-sample-declaration">{value}</span>;
}
function CreationTime({ value }: { value: string }) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? <time dateTime={value}>{date.toLocaleString()}</time> : <>Creation time unavailable</>;
}
function Results({ source, results, disabled, onInspect }: {
  source: ResearchSource; results: ResearchResult[]; disabled: boolean;
  onInspect?: (result: ResearchResult) => void;
}) {
  const [open, setOpen] = useState(false), [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(results.length / RESULT_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return <details className="study-source-results" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Results ({results.length})</summary>
    {open && <>
      <ol start={current * RESULT_PAGE_SIZE + 1}>{results.slice(current * RESULT_PAGE_SIZE, (current + 1) * RESULT_PAGE_SIZE).map((result) => {
        const state = studyResultReviewState(result);
        const bound = result.source_sha256 === source.sha256;
        return <li key={JSON.stringify([result.id, result.revision_hash])} data-result-id={result.id} data-revision-hash={result.revision_hash}>
          <strong>{resultTitle(result)}</strong><span><CreationTime value={result.created_at} /></span>
          <span>{reviewLabel(state === "pending" ? null : result.review)}</span>
          <button type="button" disabled={disabled || !onInspect || !bound}
            title={!bound ? "The result's recorded source fingerprint does not match this image." : undefined}
            onClick={() => onInspect?.(result)}>Inspect result</button>
          {!bound && <span className="study-sample-unassigned">Source binding unavailable</span>}
          <details className="study-sample-technical"><summary>Technical result identity</summary>
            <dl><dt>Result ID</dt><dd>{result.id}</dd><dt>Revision</dt><dd>{result.revision_hash}</dd>
              <dt>Source ID</dt><dd>{result.source_id}</dd><dt>Source fingerprint</dt><dd>{result.source_sha256 ?? "Unavailable"}</dd>
              <dt>Created</dt><dd>{result.created_at}</dd></dl>
          </details>
        </li>;
      })}</ol>
      {pages > 1 && <div className="study-sample-pages" role="group" aria-label={`Result pages for ${source.name}`}>
        <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous results</button>
        <span>Page {current + 1} of {pages}</span>
        <button type="button" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>Next results</button>
      </div>}
    </>}
  </details>;
}

export type StudySampleNavigation = {
  onInspectResult?: (result: ResearchResult) => void | Promise<void>;
  onEditMetadata?: (source: ResearchSource) => void | Promise<void>;
};
/** Snapshot-only navigation: this component has no API or mutation capability. */
export function StudySampleNavigator({ snapshot, busy = false, onInspectResult, onEditMetadata }: StudySampleNavigation & {
  snapshot: ResearchSnapshot; busy?: boolean;
}) {
  const [query, setQuery] = useState(""), [status, setStatus] = useState<Status>("all");
  const [condition, setCondition] = useState(ALL), [replicate, setReplicate] = useState(ALL), [page, setPage] = useState(0);
  const [navigating, setNavigating] = useState(false), [error, setError] = useState("");
  const study = JSON.stringify([snapshot.project.project_id, snapshot.project.title]);
  const rows = useMemo(() => {
    const samples = new Map(snapshot.samples.map((sample) => [sample.id, sample.data]));
    const bySource = new Map<string, ResearchResult[]>();
    for (const result of snapshot.results) {
      const group = bySource.get(result.source_id) ?? []; group.push(result); bySource.set(result.source_id, group);
    }
    return snapshot.sources.map((source) => {
      const sample = samples.get(source.id);
      const results = bySource.get(source.id) ?? [];
      const missing = required.filter((field) => blank(sample?.[field]));
      const counts = { pending: 0, reviewed: 0, excluded: 0 };
      for (const result of results) counts[studyResultReviewState(result)]++;
      return { source, sample, results, missing, counts };
    });
  }, [snapshot.sources, snapshot.samples, snapshot.results]);
  const options = (field: "condition" | "biological_replicate") => [...new Set(rows.map((row) => row.sample?.[field]).filter((value): value is string => !blank(value)))];
  const conditions = options("condition"), replicates = options("biological_replicate");
  const conditionKeys = JSON.stringify(conditions.map(declaredKey)), replicateKeys = JSON.stringify(replicates.map(declaredKey));
  useEffect(() => { setQuery(""); setStatus("all"); setCondition(ALL); setReplicate(ALL); setPage(0); setError(""); }, [study]);
  useEffect(() => {
    if (condition !== ALL && condition !== UNASSIGNED && !conditions.some((value) => declaredKey(value) === condition)) { setCondition(ALL); setPage(0); }
    if (replicate !== ALL && replicate !== UNASSIGNED && !replicates.some((value) => declaredKey(value) === replicate)) { setReplicate(ALL); setPage(0); }
  }, [conditionKeys, replicateKeys, condition, replicate]);
  const matches = rows.filter((row) => {
    const search = query.toLocaleLowerCase();
    return (!search || row.source.name.toLocaleLowerCase().includes(search) || row.sample?.sample.toLocaleLowerCase().includes(search)) &&
      (condition === ALL || declarationKey(row.sample?.condition) === condition) &&
      (replicate === ALL || declarationKey(row.sample?.biological_replicate) === replicate) &&
      (status === "all" || (status === "missing" && row.missing.length > 0) ||
        (status === "unassigned" && declarationKey(row.sample?.biological_replicate) === UNASSIGNED) ||
        (status === "pending" && row.counts.pending > 0) || (status === "none" && !row.results.length));
  });
  const pages = Math.max(1, Math.ceil(matches.length / SOURCE_PAGE_SIZE)), current = Math.min(page, pages - 1);
  const blocked = busy || navigating;
  const navigate = async (work: () => void | Promise<void>) => {
    if (blocked) return;
    setNavigating(true); setError("");
    try { await work(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open the selected study record. Refresh the study and retry."); }
    finally { setNavigating(false); }
  };
  const declarationOption = (value: string) => <option key={declaredKey(value)} value={declaredKey(value)}>{value === "Unassigned" ? "Unassigned (declared)" : `“${value}”`}</option>;
  return <section className="study-sample-navigator" aria-label="Sources & samples" aria-busy={navigating}>
    <h2>Sources &amp; samples</h2>
    <div className="study-sample-filters">
      <label>Find images or samples<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label>
      <label>Status<select value={status} aria-label="Sample status" onChange={(event) => { setStatus(event.target.value as Status); setPage(0); }}>
        <option value="all">All images</option><option value="missing">Missing metadata</option><option value="unassigned">Unassigned replicate</option>
        <option value="pending">Has results to review</option><option value="none">No results</option>
      </select></label>
      <label>Condition<select value={condition} aria-label="Condition filter" onChange={(event) => { setCondition(event.target.value); setPage(0); }}>
        <option value={ALL}>All conditions</option><option value={UNASSIGNED}>Unassigned (no declaration)</option>{conditions.map(declarationOption)}
      </select></label>
      <label>Biological replicate<select value={replicate} aria-label="Biological replicate filter" onChange={(event) => { setReplicate(event.target.value); setPage(0); }}>
        <option value={ALL}>All replicates</option><option value={UNASSIGNED}>Unassigned (no declaration)</option>{replicates.map(declarationOption)}
      </select></label>
    </div>
    <p className="study-sample-match-count" role="status">{matches.length} of {rows.length} images{matches.length ? ` · showing ${current * SOURCE_PAGE_SIZE + 1}–${Math.min(matches.length, (current + 1) * SOURCE_PAGE_SIZE)}` : ""}</p>
    {error && <p role="alert">{error}</p>}
    <div className="study-sample-table" role="region" aria-label="Sources and samples table" tabIndex={0}>
      <table><caption>Visible sources and declared sample metadata</caption><thead><tr>
        {["Image", "Sample", "Condition", "Biological replicate", "Results", "Actions"].map((label) => <th key={label} scope="col">{label}</th>)}
      </tr></thead><tbody>{matches.slice(current * SOURCE_PAGE_SIZE, (current + 1) * SOURCE_PAGE_SIZE).map(({ source, sample, results, missing, counts }) =>
        <tr key={JSON.stringify([source.id, source.sha256])} data-source-id={source.id} data-source-sha256={source.sha256}>
          <th scope="row"><span className="study-sample-source-name">{source.name}</span>
            {source.locator_state === "relink-required" && <span className="study-sample-availability">Relink required</span>}
            <details className="study-sample-technical"><summary>Source &amp; metadata details</summary>
              {missing.length > 0 && <p>Missing required metadata: {missing.join(", ")}</p>}
              <dl>{(["study", "plate", "well"] as const).map((field) => <div key={field}><dt>{{ study: "Study", plate: "Plate", well: "Well" }[field]}</dt><dd><DeclaredValue value={sample?.[field]} required={field === "study"} /></dd></div>)}
                <dt>Source ID</dt><dd>{source.id}</dd><dt>Source fingerprint</dt><dd>{source.sha256}</dd></dl>
            </details>
          </th>
          <td><DeclaredValue value={sample?.sample} required /></td><td><DeclaredValue value={sample?.condition} required /></td>
          <td><DeclaredValue value={sample?.biological_replicate} /></td>
          <td>{results.length ? <><span className="study-sample-counts">{counts.pending} to review · {counts.reviewed} reviewed · {counts.excluded} excluded</span>
            <Results source={source} results={results} disabled={blocked} onInspect={onInspectResult ? (result) => { void navigate(() => onInspectResult(result)); } : undefined} /></> : "No results"}</td>
          <td><button type="button" disabled={blocked || !onEditMetadata} onClick={() => { void navigate(() => onEditMetadata!(source)); }}>Edit metadata</button></td>
        </tr>)}
      </tbody></table>
    </div>
    {!matches.length && <p>{rows.length ? "No images match these filters." : "Add images to list their sample metadata and results."}</p>}
    {pages > 1 && <div className="study-sample-pages" role="group" aria-label="Source pages">
      <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous images</button>
      <span>Page {current + 1} of {pages}</span>
      <button type="button" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>Next images</button>
    </div>}
  </section>;
}
