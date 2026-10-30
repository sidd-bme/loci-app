import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot } from "../shared/research-contracts";
import { checkedSpatialDensityGroups, checkedSpatialDensityPage, checkedSpatialDensityPreview, checkedSpatialDensitySaved, checkedSpatialDensityStatus, spatialDensityRequestHash,
  type SpatialDensityGroup, type SpatialDensityInput, type SpatialDensityPage, type SpatialDensityRequest, type SpatialDensityStatus, type SpatialDensitySummary,
  type SpatialDensityTable, type SpatialDensityTables, type SpatialDensityTarget, type SpatialDensityViewSummary } from "../shared/spatial-density-contracts";
import { populationDisplayUnit } from "./PopulationChart";
import { ScientificNumber } from "./ScientificNumber";
import "./SpatialDensityPanel.css";

const exactKey = (r: Pick<ResearchResult, "id" | "revision_hash">) => r.id + ":" + r.revision_hash;
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*/u, "") : "The density report could not be prepared. Retry the operation.";
const unit = (value: string) => populationDisplayUnit(value).replace("^2", "²");
const reasonLabel: Record<string, string> = { missing_sample_metadata: "Missing sample metadata", missing_biological_replicate: "Donor not declared",
  outside_explicit_stratum: "Outside the selected time / plane", crop_border: "Touches crop border", outside_compartment: "Outside compartment", outside_bands: "Outside supplied bands" };
type View = { summary: SpatialDensityViewSummary; preview: { preview_id: string; preview_hash: string } | null; savedId: string | null; signature: string; status: SpatialDensityStatus | null };
function resultName(snapshot: ResearchSnapshot, result: Pick<ResearchResult, "id" | "source_id">) {
  const index = snapshot.results.filter((r) => r.source_id === result.source_id && r.kind === "spatial-distance-bands").findIndex((r) => r.id === result.id);
  return (snapshot.sources.find((s) => s.id === result.source_id)?.name ?? "Bound source") + " · distance bands" + (index >= 0 ? " " + (index + 1) : "");
}
function fieldGroups(result: ResearchResult, groups: SpatialDensityGroup[]) {
  const objects = (result.spatial as { inputs?: { objects?: { result_id: string; revision_hash: string } } } | undefined)?.inputs?.objects;
  return groups.filter((g) => g.source_available && g.source_id === result.source_id && g.source_sha256 === result.source_sha256 &&
    ((g.result_id === result.id && g.revision_hash === result.revision_hash) || (g.result_id === objects?.result_id && g.revision_hash === objects?.revision_hash)));
}
function viewTarget(view: View): SpatialDensityTarget {
  if (view.savedId) return { report_id: view.savedId };
  if (view.preview) return view.preview;
  throw new Error("The density preview identity is unavailable. Preview again.");
}
async function readInputs(api: ResearchDesktopApi, target: SpatialDensityTarget, summary: SpatialDensityViewSummary, current: () => boolean): Promise<SpatialDensityInput[] | null> {
  if (summary.aggregation.input_snapshots.length === summary.totals.selected_fields) return summary.aggregation.input_snapshots;
  const all: SpatialDensityInput[] = [];
  let offset = 0;
  do {
    if (!current()) return null;
    const page = checkedSpatialDensityPage(await api.execute("spatial_density_query", { ...target, table: "input_snapshots", offset, limit: 100 }), summary, "input_snapshots", offset, 100);
    if (!current()) return null;
    all.push(...page.rows);
    if (page.next_offset === null) break;
    offset = page.next_offset;
  } while (all.length < summary.totals.selected_fields);
  if (all.length !== summary.totals.selected_fields || new Set(all.map((f) => f.result.id)).size !== all.length)
    throw new Error("The report's exact field bindings are incomplete. Reopen the report and retry.");
  return all;
}
function Details({ title, children, defaultOpen = false, onOpen }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; onOpen?: () => void }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details className="density-details" open={open} onToggle={(e) => { const next = e.currentTarget.open; setOpen(next); if (next) onOpen?.(); }}>
    <summary>{title}</summary>{open && children}
  </details>;
}
function PagedTable<T extends SpatialDensityTable>({ api, target, summary, table, name, headings, renderRow, enabled = true, disabled = false, inputs }: {
  api: ResearchDesktopApi; target: SpatialDensityTarget; summary: SpatialDensityViewSummary; table: T; name: string; headings: string[];
  renderRow: (row: SpatialDensityTables[T][number]) => ReactNode[]; enabled?: boolean; disabled?: boolean; inputs?: SpatialDensityInput[];
}) {
  const [offset, setOffset] = useState(0), [previous, setPrevious] = useState<number[]>([]);
  const [page, setPage] = useState<SpatialDensityPage<T> | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const targetKey = JSON.stringify(target), hash = summary.report_hash, total = summary.tables[table].total;
  useEffect(() => {
    if (!enabled) return;
    let current = true; setLoading(true); setError(""); setPage(null);
    void api.execute("spatial_density_query", { ...target, table, offset, limit: 50 }).then((response) => {
      const next = checkedSpatialDensityPage(response, summary, table, offset, 50, inputs);
      if (current) setPage(next);
    }).catch((caught) => { if (current) setError(message(caught)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
    // Each mounted table is keyed by immutable report identity; only its own cursor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, targetKey, hash, table, offset, enabled, retry, inputs]);
  const shown = page?.offset === offset ? page : null;
  return <><div className="density-table" role="region" aria-label={name} aria-busy={loading || !enabled} tabIndex={0}>
    <table><caption>{name}</caption><thead><tr>{headings.map((heading) => <th scope="col" key={heading}>{heading}</th>)}</tr></thead>
      <tbody>{shown?.rows.map((row, index) => <tr key={offset + index}>{renderRow(row).map((cell, column) =>
        column === 0 ? <th scope="row" key={column}>{cell}</th> : <td key={column}>{cell}</td>)}</tr>)}</tbody>
    </table>
    {(!enabled || loading) && <p role="status">Reading {name.toLowerCase()}…</p>}
    {error && <p role="alert">{error} <button type="button" disabled={disabled || loading} onClick={() => setRetry((n) => n + 1)}>Retry {name.toLowerCase()}</button></p>}
    {shown?.total === 0 && <p>No rows for this report scope.</p>}
  </div>
    <div className="density-pages" role="group" aria-label={name + " pages"}>
      <button type="button" disabled={disabled || loading || !previous.length} onClick={() => { setOffset(previous.at(-1)!); setPrevious((old) => old.slice(0, -1)); }}>Previous</button>
      <span>{shown && shown.returned ? "Rows " + (shown.offset + 1) + "–" + (shown.offset + shown.returned) + " of " + shown.total : total + " rows"}</span>
      <button type="button" disabled={disabled || loading || !shown || shown.next_offset === null} onClick={() => {
        if (shown?.next_offset != null) { setPrevious((old) => [...old, offset]); setOffset(shown.next_offset); }
      }}>Next</button>
    </div>
  </>;
}
function ReportTables({ api, view, snapshot, onInspect, disabled, active }: {
  api: ResearchDesktopApi; view: View; snapshot: ResearchSnapshot; onInspect: (result: ResearchResult) => void; disabled: boolean; active: boolean;
}) {
  const summary = view.summary, a = summary.aggregation, target = viewTarget(view);
  const distanceUnit = unit(a.contract.distance_unit), areaUnit = unit(a.contract.area_unit), densityUnit = "objects/" + areaUnit;
  const [needInputs, setNeedInputs] = useState(summary.totals.excluded_fields > 0), [inputs, setInputs] = useState<SpatialDensityInput[] | null>(
    a.input_snapshots.length === summary.totals.selected_fields ? a.input_snapshots : null);
  const [inputError, setInputError] = useState(""), [inputRetry, setInputRetry] = useState(0);
  const targetKey = JSON.stringify(target);
  useEffect(() => {
    if (!active || !needInputs || inputs) return;
    let current = true; setInputError("");
    void readInputs(api, target, summary, () => current).then((next) => { if (current && next) setInputs(next); })
      .catch((caught) => { if (current) setInputError(message(caught)); });
    return () => { current = false; };
    // Target/report changes remount this report body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, active, targetKey, needInputs, inputs, inputRetry]);
  const band = (index: number) => "[" + a.contract.band_edges[index] + ", " + a.contract.band_edges[index + 1] + ") " + distanceUnit;
  const number = (value: number | null) => <ScientificNumber value={value} />;
  const inspect = (id: string) => {
    const bound = inputs!.find((f) => f.result.id === id)!.result;
    const exact = snapshot.results.find((r) => r.id === id && r.revision_hash === bound.revision_hash && r.source_id === bound.source_id && r.source_sha256 === bound.source_sha256);
    return <span className="density-field-link">{resultName(snapshot, bound)}{exact
      ? <button type="button" disabled={disabled} onClick={() => onInspect(exact)}>Inspect exact result</button>
      : <small>Exact revision unavailable in this study</small>}</span>;
  };
  const shared = { api, target, summary, disabled, enabled: active };
  return <>
    <p>{a.phenotype_name ?? "All eligible objects"} · Time {a.stratum.t + 1}, plane {a.stratum.z + 1}</p>
    <p>{summary.totals.selected_fields} selected fields · {summary.totals.excluded_fields} excluded from donor pools.</p>
    <p>Counts and sampled band areas are pooled within each declared donor. Condition summaries weight donors equally; SD requires at least two defined donor densities.</p>
    {inputError && <p role="alert">{inputError} <button type="button" disabled={disabled} onClick={() => setInputRetry((n) => n + 1)}>Retry exact field bindings</button></p>}
    <PagedTable {...shared} table="condition_rows" name="Condition density summaries"
      headings={["Study / condition", "Band", "Defined / total donors", "Mean (" + densityUnit + ")", "SD", "Median", "Zero-area donors"]}
      renderRow={(r) => [<>{r.study}<br />{r.condition}</>, band(r.band_index), r.n + " / " + r.n_donors_total, number(r.mean), number(r.sd), number(r.median), r.n_undefined_zero_area]} />
    <Details title={"Donor counts, sampled areas and densities (" + summary.tables.donor_rows.total + ")"}>
      <PagedTable {...shared} table="donor_rows" name="Donor density endpoints" headings={["Study / condition / donor", "Band", "Fields", "Count", "Area (" + areaUnit + ")", "Density (" + densityUnit + ")"]}
        renderRow={(r) => [<>{r.study}<br />{r.condition}<br />{r.biological_replicate}</>, band(r.band_index), r.n_fields, r.object_count, number(r.sampled_area), r.density === null ? "Undefined: zero sampled area" : number(r.density)]} />
    </Details>
    <Details title={"Field counts and exact result links (" + summary.totals.selected_fields + ")"} onOpen={() => setNeedInputs(true)}>
      <PagedTable {...shared} enabled={active && Boolean(inputs)} inputs={inputs ?? undefined} table="field_rows" name="Field density measurements"
        headings={["Exact field", "Study / condition / donor", "Time / plane", "Band", "Phenotype / eligible count", "Sampled area", "Density", "Donor pool"]}
        renderRow={(r) => {
          const field = inputs!.find((f) => f.result.id === r.result_id)!;
          const fieldArea = unit(field.result.contract.area_unit), fieldDistance = unit(field.result.contract.distance_unit);
          return [inspect(r.result_id), r.metadata ? <>{r.metadata.study}<br />{r.metadata.condition}<br />{r.metadata.biological_replicate ?? "Donor not declared"}</> : "Missing sample metadata",
            (r.selection.t + 1) + " / " + (r.selection.z + 1), "[" + r.lower + ", " + r.upper + ") " + fieldDistance, r.object_count + " / " + r.eligible_object_count,
            <>{number(r.sampled_area)} {fieldArea}</>, r.density === null ? "Undefined: zero sampled area" : <>{number(r.density)} objects/{fieldArea}</>, r.included_in_donor_pool ? "Included" : "Excluded — see audit"];
        }} />
    </Details>
    {a.condition_pair && <Details title={"Paired donors: " + a.condition_pair[1] + " minus " + a.condition_pair[0]} defaultOpen>
      <p>Descriptive differences within the same study and declared donor. No significance test is calculated.</p>
      <PagedTable {...shared} table="paired_summary" name="Paired density summaries" headings={["Study", "Band", "Defined pairs", "Mean difference (" + densityUnit + ")", "SD", "Median"]}
        renderRow={(r) => [r.study, band(r.band_index), r.n, number(r.mean), number(r.sd), number(r.median)]} />
      <PagedTable {...shared} table="paired_rows" name="Paired donor differences" headings={["Study / donor", "Band", a.condition_pair[0], a.condition_pair[1], "Difference (" + densityUnit + ")"]}
        renderRow={(r) => [<>{r.study}<br />{r.biological_replicate}</>, band(r.band_index), number(r.left_density), number(r.right_density), r.difference === null ? "Undefined: zero sampled area" : number(r.difference)]} />
      <PagedTable {...shared} table="unmatched_donors" name="Unmatched donors" headings={["Study", "Condition", "Donor", "Reason"]}
        renderRow={(r) => [r.study, r.condition, r.biological_replicate, "Missing paired condition"]} />
    </Details>}
    <Details title="Exclusions and field audit" defaultOpen={summary.totals.excluded_fields > 0} onOpen={() => setNeedInputs(true)}>
      <p>Object exclusion reasons may overlap. Phenotype selection changes the count; the full sampled band area remains the denominator.</p>
      <PagedTable {...shared} enabled={active && Boolean(inputs)} inputs={inputs ?? undefined} table="exclusion_audit" name="Density exclusion audit"
        headings={["Field", "Donor-pool status", "Object exclusion reasons"]}
        renderRow={(r) => [inspect(r.result_id), r.reasons.length ? r.reasons.map((reason) => reasonLabel[reason]).join("; ") : "Included",
          Object.entries(r.object_exclusions).map(([reason, n]) => reasonLabel[reason] + ": " + n).join("; ") || "None"]} />
    </Details>
    <Details title="Exact report identity and rules" onOpen={() => setNeedInputs(true)}>
      <p>Created {summary.created_at} · engine {summary.software.engine}</p><code className="density-hash">{summary.report_hash}</code>
      <pre tabIndex={0} aria-label="Density report rules and identities">{JSON.stringify({ contract: a.contract, rules: a.rules, request_sha256: summary.request_sha256,
        inputs: inputs?.map((f) => ({ result_id: f.result.id, revision_hash: f.result.revision_hash, source_id: f.result.source_id, source_sha256: f.result.source_sha256,
          record_sha256: f.result.record_sha256, sample_revision: f.sample?.revision ?? null, phenotype_id: f.phenotype?.id ?? null, phenotype_record_sha256: f.phenotype?.record_sha256 ?? null })) ?? "Reading exact field bindings…" }, null, 2)}</pre>
    </Details>
  </>;
}

export function SpatialDensityPanel({ api, snapshot, active = true, busy = false, onInspect, onSnapshot }: {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; active?: boolean; busy?: boolean;
  onInspect: (result: ResearchResult) => void; onSnapshot: (snapshot: ResearchSnapshot | null) => void;
}) {
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]), [phenotype, setPhenotype] = useState(false);
  const [phenotypeName, setPhenotypeName] = useState(""), [groupIds, setGroupIds] = useState<Record<string, string>>({});
  const [stratumKey, setStratumKey] = useState(""), [pair, setPair] = useState(false), [left, setLeft] = useState(""), [right, setRight] = useState("");
  const [groups, setGroups] = useState<SpatialDensityGroup[]>([]), [reports, setReports] = useState<SpatialDensitySummary[]>([]);
  const [catalogError, setCatalogError] = useState(""), [catalogLoading, setCatalogLoading] = useState(false), [catalogTick, setCatalogTick] = useState(0);
  const [view, setView] = useState<View | null>(null), [pending, setPending] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [exportKey, setExportKey] = useState<string | null>(null), [cancelling, setCancelling] = useState(false), [checkingStatus, setCheckingStatus] = useState(false);
  const mounted = useRef(true), generation = useRef(0), inFlight = useRef(false), exportRef = useRef<string | null>(null);
  const activeRef = useRef(active); activeRef.current = active;
  const callbacks = useRef({ onSnapshot }); callbacks.current = { onSnapshot };
  const candidates = snapshot.results.filter((r) => r.kind === "spatial-distance-bands" && r.schema !== "loci.research-result/v2");
  const selected = selectedKeys.map((key) => candidates.find((r) => exactKey(r) === key));
  const exact = selected.filter((r): r is ResearchResult => Boolean(r));
  const strata = [...new Set(exact.filter((r) => r.selection).map((r) => `${r.selection!.t}:${r.selection!.z}`))];
  const chosenStratum = strata.includes(stratumKey) ? { t: Number(stratumKey.split(":")[0]), z: Number(stratumKey.split(":")[1]) } : null;
  const conditions = [...new Set(exact.flatMap((r) => snapshot.samples.filter((s) => s.id === r.source_id).map((s) => s.data.condition)))].sort();
  const selectedGroups = exact.map((r) => fieldGroups(r, groups).find((g) => `${g.id}:${g.record_sha256}` === groupIds[exactKey(r)]));
  const reason = !selectedKeys.length ? "Choose at least one saved tissue-distance result." : selectedKeys.length > 256 ? "Choose at most 256 fields." :
    selected.length !== exact.length ? "A selected exact revision is unavailable. Clear it or restore it before previewing." :
    !chosenStratum ? "Choose the time and plane to pool." : phenotype && (catalogLoading || catalogError) ? "Load the saved phenotype groups before previewing." :
    phenotype && (!phenotypeName.trim() || selectedGroups.some((g) => !g)) ? "Name the common phenotype and choose one exact saved group for every field." :
    pair && (!conditions.includes(left) || !conditions.includes(right) || left === right) ? "Choose two different declared conditions for the paired comparison." : "";
  const request: SpatialDensityRequest = { fields: exact.map((r, index) => ({ result_id: r.id, revision_hash: r.revision_hash,
    ...(phenotype && selectedGroups[index] ? { phenotype_group_id: selectedGroups[index]!.id, phenotype_record_sha256: selectedGroups[index]!.record_sha256 } : {}) })),
    ...(chosenStratum ? { stratum: chosenStratum } : {}), ...(phenotype ? { phenotype_name: phenotypeName.trim() } : {}), ...(pair ? { condition_pair: [left, right] as [string, string] } : {}) };
  const evidence = JSON.stringify([selectedKeys, exact.map((r) => [r.id, r.revision_hash, r.source_id, r.source_sha256, r.spatial, r.selection]),
    snapshot.samples.filter((s) => exact.some((r) => r.source_id === s.id)), snapshot.sources.filter((s) => exact.some((r) => r.source_id === s.id)).map((s) => [s.id, s.sha256])]);
  const signature = JSON.stringify([request, evidence, phenotype, groupIds, stratumKey, pair, left, right]);
  const live = useRef(signature); live.current = signature;
  const previewCurrent = Boolean(view && !view.savedId && view.signature === signature);
  const stale = Boolean(view && !view.savedId && !previewCurrent);
  const locked = busy || Boolean(pending) || cancelling;
  const setupLocked = busy || cancelling || Boolean(view?.savedId) || Boolean(pending && pending !== "Preparing density preview");
  const savedEvidence = JSON.stringify([snapshot.samples, snapshot.sources.map((s) => [s.id, s.sha256]), snapshot.results.map((r) => [r.id, r.revision_hash, r.source_sha256])]);
  const job = exportKey ? snapshot.jobs.find((j) => j.request_key === exportKey && j.operation === "spatial_density_export") : null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++;
    const key = exportRef.current; exportRef.current = null; if (key) void api.cancelDataExport?.(key).catch(() => {});
  }; }, [api]);
  useEffect(() => {
    if (!active) return;
    let current = true; setCatalogLoading(true); setCatalogError("");
    void Promise.all([api.execute("population_group_list", {}), api.execute("spatial_density_list", {})]).then(([groupResponse, reportResponse]) => {
      const nextGroups = checkedSpatialDensityGroups(groupResponse);
      const next = (reportResponse as { reports: SpatialDensitySummary[] })?.reports;
      if (!Array.isArray(next) || next.some((r) => !r || !/^[a-f0-9]{32}$/u.test(r.id) || typeof r.created_at !== "string" ||
          r.phenotype_name !== null && typeof r.phenotype_name !== "string" || !r.stratum || !Number.isSafeInteger(r.stratum.t) || !Number.isSafeInteger(r.stratum.z) || r.stratum.t < 0 || r.stratum.z < 0))
        throw new Error("The saved density report list is invalid. Refresh saved reports.");
      next.forEach((r) => checkedSpatialDensityStatus(r.status));
      if (current) { setGroups(nextGroups); setReports(next); }
    }).catch((caught) => { if (current) setCatalogError(message(caught)); }).finally(() => { if (current) setCatalogLoading(false); });
    return () => { current = false; };
  }, [api, active, catalogTick]);
  useEffect(() => {
    if (!active || !view?.savedId) return;
    let current = true; setCheckingStatus(true);
    const id = view.savedId, retained = view.summary;
    void api.execute("spatial_density_get", { report_id: id }).then((response) => {
      const next = checkedSpatialDensitySaved(response);
      if (next.report_id !== id || next.summary.report_hash !== retained.report_hash || next.summary.request_sha256 !== retained.request_sha256) throw new Error("The saved density snapshot changed unexpectedly. Reopen the report.");
      if (current) setView((old) => old?.savedId === id ? { ...old, status: next.status } : old);
    }).catch((caught) => { if (current) { setView((old) => old?.savedId === id ? { ...old, status: null } : old); setError(message(caught)); } })
      .finally(() => { if (current) setCheckingStatus(false); });
    return () => { current = false; };
    // A live status refresh never replaces immutable saved report values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, active, view?.savedId, savedEvidence]);
  useEffect(() => {
    if (!exportKey) return;
    let current = true, reading = false;
    const poll = async () => { if (reading) return; reading = true;
      try { const next = await api.getSnapshot(); if (current && mounted.current) callbacks.current.onSnapshot(next); }
      catch (caught) { if (current) setError(`Could not refresh export status: ${message(caught)}`); }
      finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 1000);
    return () => { current = false; window.clearInterval(timer); };
  }, [api, exportKey]);
  const run = async (label: string, work: (current: () => boolean) => Promise<void>) => {
    if (locked || inFlight.current) return;
    inFlight.current = true; const token = ++generation.current, captured = live.current;
    const current = () => mounted.current && activeRef.current && token === generation.current && captured === live.current;
    setPending(label); setError(""); setNotice("");
    try { await work(current); } catch (caught) { if (current()) setError(message(caught)); }
    finally { inFlight.current = false; if (mounted.current && token === generation.current) setPending(""); }
  };
  const preview = () => run("Preparing density preview", async (current) => {
    if (reason) return;
    const requestHash = await spatialDensityRequestHash(request);
    if (!current()) return;
    const response = await api.execute("spatial_density_preview", { ...request });
    if (!current()) return;
    const retained = checkedSpatialDensityPreview(response, request, snapshot, requestHash);
    setView({ summary: retained.summary, preview: { preview_id: retained.preview_id, preview_hash: retained.preview_hash }, savedId: null, signature, status: null });
  });
  const save = () => run("Saving density report", async (current) => {
    if (!previewCurrent || !view?.preview) return;
    const saved = checkedSpatialDensitySaved(await api.execute("spatial_density_save", { ...view.preview }));
    if (saved.summary.report_hash !== view.summary.report_hash || saved.summary.request_sha256 !== view.summary.request_sha256)
      throw new Error("The saved density report differs from the preview. Preview again.");
    if (!current()) return;
    setView({ ...view, summary: saved.summary, preview: null, savedId: saved.report_id, status: saved.status }); setCatalogTick((n) => n + 1); setNotice("Density report saved as an immutable snapshot.");
    const next = await api.getSnapshot(); if (mounted.current) callbacks.current.onSnapshot(next);
  });
  const open = (id: string) => run("Opening saved density report", async (current) => {
    const saved = checkedSpatialDensitySaved(await api.execute("spatial_density_get", { report_id: id }));
    if (saved.report_id !== id) throw new Error("The opened report does not match the selected report.");
    if (current()) setView({ summary: saved.summary, preview: null, savedId: id, status: saved.status, signature: "" });
  });
  const reuse = () => run("Restoring saved density settings", async (current) => {
    if (!view?.savedId) return;
    const a = view.summary.aggregation, inputs = await readInputs(api, { report_id: view.savedId }, view.summary, current);
    if (!current() || !inputs) return;
    setSelectedKeys(inputs.map((f) => exactKey(f.result))); setStratumKey(a.stratum.t + ":" + a.stratum.z);
    setPhenotype(a.phenotype_name !== null); setPhenotypeName(a.phenotype_name ?? "");
    setGroupIds(Object.fromEntries(inputs.flatMap((f) => f.phenotype ? [[exactKey(f.result), f.phenotype.id + ":" + f.phenotype.record_sha256]] : [])));
    setPair(Boolean(a.condition_pair)); setLeft(a.condition_pair?.[0] ?? ""); setRight(a.condition_pair?.[1] ?? "");
    setView(null); setNotice("Saved settings restored. Preview current inputs before saving a new report."); setError("");
  });
  const exportReport = () => run("Exporting density report", async (current) => {
    if (!view?.savedId || !api.planSpatialDensityExport || !api.exportSpatialDensityReport || !api.cancelDataExport) return;
    const key = `scientific-export:${crypto.randomUUID()}`; exportRef.current = key; setExportKey(key);
    try {
      const plan = await api.planSpatialDensityExport(view.savedId, key);
      if (!current() || exportRef.current !== key) return;
      if (plan?.schema !== "loci.spatial-density-export-plan/v1" || plan.report_id !== view.savedId || plan.report_hash !== view.summary.report_hash || !/^[a-f0-9]{64}$/u.test(plan.plan_hash))
        throw new Error("The export plan does not match this saved density report.");
      checkedSpatialDensityStatus(plan.status);
      const receipt = await api.exportSpatialDensityReport(view.savedId, plan.plan_hash, key);
      if (!current() || exportRef.current !== key) return;
      if (!receipt) { setNotice("Destination selection cancelled. The saved report is unchanged."); return; }
      if (receipt.schema !== "loci.spatial-density-export-receipt/v1" || receipt.report_hash !== view.summary.report_hash ||
          typeof receipt.basename !== "string" || !receipt.basename || /[/\\]/u.test(receipt.basename) || !/^[a-f0-9]{64}$/u.test(receipt.manifest_sha256))
        throw new Error("The export receipt does not match this saved report. Check Jobs before retrying.");
      setNotice(`Saved ${receipt.basename}. Exact report values and provenance were exported.`);
      const next = await api.getSnapshot(); if (current()) callbacks.current.onSnapshot(next);
    } finally { if (exportRef.current === key) { exportRef.current = null; if (mounted.current) setExportKey(null); } }
  });
  const cancel = async () => {
    const key = exportRef.current; if (!key || cancelling || !api.cancelDataExport) return;
    setCancelling(true); generation.current++; exportRef.current = null; setExportKey(null); setPending("");
    try { const receipt = await api.cancelDataExport(key); if (mounted.current) setNotice(receipt.cancelled
      ? "Cancellation requested. Check Jobs and the destination before retrying with a fresh export plan."
      : "Cancellation was not confirmed. Check Jobs and the destination before retrying."); }
    catch (caught) { if (mounted.current) setError(`Could not confirm cancellation: ${message(caught)}`); }
    finally { if (mounted.current) setCancelling(false); }
  };
  return <section className="research-panel spatial-density" aria-label="Spatial donor density" aria-busy={Boolean(pending)}>
    <h2>Spatial donor density</h2><p>Pool tissue-distance counts and sampled areas within declared donors, then compare conditions.</p>
    <fieldset className="density-setup" hidden={Boolean(view?.savedId)} disabled={setupLocked}><legend>Fields and comparison</legend>
      {!candidates.length && <p>No tissue-distance results yet. Create distance bands from calibrated object, compartment and boundary masks.</p>}
      <div className="density-field-choices">{candidates.map((r) => {
        const key = exactKey(r), checked = selectedKeys.includes(key), sample = snapshot.samples.find((s) => s.id === r.source_id)?.data;
        return <div className="density-field-choice" key={key} data-density-result-id={r.id} data-revision-hash={r.revision_hash}>
          <label><input type="checkbox" aria-label={`Density field: ${resultName(snapshot, r)}`} checked={checked} onChange={(e) => setSelectedKeys((old) => e.target.checked ? [...old, key] : old.filter((value) => value !== key))} />
            <span>{resultName(snapshot, r)}<small>{sample ? `${sample.study} · ${sample.condition} · ${sample.biological_replicate ?? "Donor not declared"}` : "Missing sample metadata"}</small></span></label>
          {checked && phenotype && <label>Saved phenotype group<select aria-label={`Phenotype group for ${resultName(snapshot, r)}`} value={groupIds[key] ?? ""} onChange={(e) => setGroupIds((old) => ({ ...old, [key]: e.target.value }))}>
            <option value="">Choose an exact saved group…</option>{fieldGroups(r, groups).map((g) => <option key={g.id} value={`${g.id}:${g.record_sha256}`}>{g.name} · {g.included_count} members</option>)}
          </select></label>}
          <details className="density-details"><summary>Exact field identity</summary><code className="density-hash">{r.id}<br />{r.revision_hash}</code></details>
        </div>;
      })}</div>
      {selected.some((r) => !r) && <button type="button" onClick={() => setSelectedKeys((old) => old.filter((key) => candidates.some((r) => exactKey(r) === key)))}>Clear unavailable fields</button>}
      <label>Time and plane<select aria-label="Density time and plane" value={stratumKey} onChange={(e) => setStratumKey(e.target.value)}>
        <option value="">Choose the stratum to pool…</option>{strata.map((s) => <option key={s} value={s}>Time {Number(s.split(":")[0]) + 1}, plane {Number(s.split(":")[1]) + 1}</option>)}
      </select></label>
      <p>Other timepoints and planes stay in the audit. Fields without sample metadata or a declared donor do not enter donor summaries.</p>
      <label className="density-check"><input type="checkbox" checked={phenotype} onChange={(e) => setPhenotype(e.target.checked)} />Count a saved phenotype</label>
      {phenotype && <><label>Common phenotype name<input aria-label="Density phenotype name" maxLength={256} value={phenotypeName} onChange={(e) => setPhenotypeName(e.target.value)} /></label>
        <p>Choose one saved group for every field. Groups must bind this spatial result or its exact object input.</p></>}
      <label className="density-check"><input type="checkbox" checked={pair} onChange={(e) => setPair(e.target.checked)} />Compare paired conditions</label>
      {pair && <div className="density-pair">{([["Left condition", left, setLeft], ["Right condition", right, setRight]] as const).map(([label, value, setter]) =>
        <label key={label}>{label}<select aria-label={`Density ${label.toLowerCase()}`} value={value} onChange={(e) => setter(e.target.value)}><option value="">Choose condition…</option>{conditions.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>)}<p>Difference = right minus left, paired by donor within each study.</p></div>}
    </fieldset>
    {!view?.savedId && reason && <p>{reason}</p>}
    {stale && <p className="density-caution" role="status">Settings or source metadata changed. Preview again before saving. The previous preview is hidden.</p>}
    <div className="research-actions">{!view?.savedId ? <><button type="button" disabled={locked || Boolean(reason)} onClick={() => void preview()}>Preview donor density</button>
      <button type="button" disabled={locked || !previewCurrent} onClick={() => void save()}>Save density report</button></> : <>
      <button type="button" disabled={locked} onClick={reuse}>Reuse settings for new preview</button>
      <button type="button" disabled={locked} onClick={() => { setView(null); setError(""); setNotice(""); }}>Set up another report</button>
      <button type="button" disabled={locked || !api.planSpatialDensityExport || !api.exportSpatialDensityReport || !api.cancelDataExport} onClick={() => void exportReport()}>Export density report…</button></>}
      {(exportKey || cancelling) && <button type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Cancelling…" : "Cancel density export"}</button>}
    </div>
    {!view?.savedId && <p>Save a current preview before exporting.</p>}
    {view?.savedId && (!api.planSpatialDensityExport || !api.exportSpatialDensityReport || !api.cancelDataExport) && <p>Native density export is unavailable in this app connection.</p>}
    {pending && <p role="status">{pending}{job ? ` · ${job.state}` : ""}…</p>}
    {job && Number.isFinite(job.progress) && job.progress >= 0 && job.progress <= 1 && <progress aria-label="Density export progress" max={1} value={job.progress} />}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <details className="density-details"><summary>Saved density reports ({reports.length})</summary>
      <button type="button" disabled={locked || catalogLoading} onClick={() => setCatalogTick((n) => n + 1)}>Refresh saved reports and groups</button>
      {catalogLoading && <p role="status">Reading saved reports and phenotype groups…</p>}{catalogError && <p role="alert">{catalogError}</p>}
      {!catalogLoading && !catalogError && !reports.length && <p>No density reports have been saved in this study.</p>}
      <ul className="density-report-list">{reports.map((r) => <li key={r.id}><span>{r.phenotype_name ?? "All eligible objects"} · Time {r.stratum.t + 1}, plane {r.stratum.z + 1}<small>{r.created_at}{!r.status.current && " · Sample metadata changed"}</small></span>
        <button type="button" disabled={locked} aria-label={`Open density report ${r.id}`} onClick={() => void open(r.id)}>Open saved report</button></li>)}</ul>
    </details>
    {view && !stale && <section aria-label={view.savedId ? "Saved density report" : "Density preview"}>
      <h3>{view.savedId ? "Saved density report" : "Density preview"}</h3>
      {view.savedId && view.summary.report_schema === "loci.spatial-density-report/v1" &&
        <p>Historical report format. Saved values and export remain available; reuse settings to create a new report.</p>}
      {view.savedId && <div className="density-current-status" role="status"><p>{checkingStatus ? "Checking current sample metadata…" : !view.status ? "Current metadata could not be verified. Saved values remain unchanged." : view.status.current ? "Current sample metadata matches this saved report." : "Sample metadata has changed. Historical report values remain unchanged."}</p>
        {!checkingStatus && view.status && !view.status.current && <ul>{view.status.changes.map((r, i) => {
          const bound = view.summary.aggregation.input_snapshots.find((f) => f.result.id === r.result_id)?.result ?? snapshot.results.find((f) => f.id === r.result_id);
          return <li key={i}>{bound ? resultName(snapshot, bound) : r.result_id} · sample metadata changed</li>;
        })}</ul>}</div>}
      <ReportTables key={JSON.stringify(viewTarget(view))} api={api} view={view} snapshot={snapshot} onInspect={onInspect} disabled={locked} active={active} />
    </section>}
  </section>;
}
