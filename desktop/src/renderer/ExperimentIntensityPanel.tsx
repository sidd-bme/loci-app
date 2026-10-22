import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot } from "../shared/research-contracts";
import { checkedIntensityReport, type IntensityCatalog, type IntensityCompartment, type IntensityDeclaration,
  type IntensityDescriptor, type IntensityEndpoint, type IntensityReport, type IntensityRequest, type IntensitySaved,
  type IntensityStatus } from "../shared/intensity-contracts";
import "./ExperimentIntensityPanel.css";
import { ScientificNumber } from "./ScientificNumber";

type SavedSummary = { id: string; created_at: string; endpoint: IntensityEndpoint; declaration: IntensityDeclaration };
type ReportView = { report: IntensityReport; reportJson?: string; savedId: string | null; signature: string; status: IntensityStatus | null };
type ExportRequest = { key: string; generation: number };
const keyOf = (result: Pick<ResearchResult, "id" | "revision_hash">) => JSON.stringify([result.id, result.revision_hash]);
const compartmentNames: Record<IntensityCompartment, string> = { object: "Object", cell: "Whole cell", nuclear: "Nuclear intersection", cytoplasm: "Remaining cytoplasm" };
const compartments = Object.keys(compartmentNames) as IntensityCompartment[];
const disposition = (result: ResearchResult) => result.review?.disposition ?? "pending";
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*/u, "") : "Could not prepare the intensity comparison. Retry the preview.";
const exactNumber = (value: number | null) => value === null ? "Not estimable" : Object.is(value, -0) ? "-0" : String(value);
const resultDescription = (snapshot: ResearchSnapshot, result: ResearchResult) => {
  const describe = (row: ResearchResult) => `${snapshot.sources.find((source) => source.id === row.source_id)?.name ?? "Unavailable source"} · ${row.method_label ?? row.kind}`;
  const matching = snapshot.results.filter((row) => describe(row) === describe(result));
  return `${describe(result)}${matching.length > 1 ? ` · result ${matching.findIndex((row) => keyOf(row) === keyOf(result)) + 1}` : ""}`;
};
function boundDescription(binding: IntensityReport["bindings"][number] | undefined, fallback: string): string {
  const source = binding?.source as { name?: string } | undefined;
  const descriptor = binding?.descriptor as IntensityDescriptor | undefined;
  return `${source?.name ?? fallback}${descriptor?.label ? ` · ${descriptor.label}` : ""}`;
}
function reportDescription(report: IntensityReport, resultId: string): string {
  const binding = report.bindings.find((entry) => entry.result_id === resultId);
  const description = boundDescription(binding, "Bound result");
  const matching = report.bindings.filter((entry) => boundDescription(entry, "Bound result") === description);
  return `${description}${matching.length > 1 ? ` · image ${matching.findIndex((entry) => entry.result_id === resultId) + 1}` : ""}`;
}
function ResultIdentity({ result }: { result: ResearchResult }) {
  return <dl className="intensity-declaration intensity-identity"><div><dt>Result ID</dt><dd>{result.id}</dd></div>
    <div><dt>Revision</dt><dd>{result.revision_hash}</dd></div><div><dt>Source ID</dt><dd>{result.source_id}</dd></div>
    <div><dt>Source fingerprint</dt><dd>{result.source_sha256 ?? "Unavailable"}</dd></div><div><dt>Created</dt><dd>{result.created_at}</dd></div></dl>;
}
function reportTime(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isFinite(date.getTime()) ? `${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date)} UTC` : "Time unavailable";
}
const meanDescriptor = (descriptor: IntensityDescriptor, compartment?: string) => descriptor.kind === "intensity" && descriptor.statistic === "mean" &&
  descriptor.unit === "source-intensity" && typeof descriptor.channel === "string" && Boolean(descriptor.channel) &&
  (!compartment || (descriptor.compartment ?? "object") === compartment);
function endpoint(compartment: IntensityCompartment): IntensityEndpoint {
  return { schema: "loci.intensity-endpoint/v1", kind: "raw-channel-intensity", statistic: "mean", unit: "source-intensity", compartment };
}
const statusLabels: Record<string, string> = {
  revision_hash: "exact result revision", source_sha256: "source fingerprint", source: "source details", review: "review decision",
  review_sha256: "review decision", sample_document: "sample metadata", channels: "channel metadata", producing_channels: "producing channel bindings",
  scope: "acquisition / run scope", provenance_sha256: "producing provenance", row_sha256: "stored measurements", object_count: "object count", references: "referenced measurements",
};
function friendlyStatus(reason: string): string {
  if (reason.startsWith("changed: ")) return `Changed: ${[...new Set(reason.slice(9).split(", ").map((field) => statusLabels[field] ?? field.replaceAll("_", " ")))].join(", ")}`;
  if (reason.startsWith("unavailable:")) return "The exact input could not be verified. Restore its source or inspect the bound revision.";
  return reason.replaceAll("_", " ").replaceAll("-", " ");
}
function checkedStatus(value: IntensityStatus): IntensityStatus {
  if (!value || typeof value.current !== "boolean" || !Array.isArray(value.changes) || value.changes.some((row) => typeof row.result_id !== "string" || typeof row.reason !== "string"))
    throw new Error("Current input status is unavailable. Refresh the saved report.");
  return value;
}
function checkedSaved(value: unknown): IntensitySaved {
  const saved = value as IntensitySaved;
  const report = checkedIntensityReport(saved?.report);
  if (typeof saved.report_id !== "string" || saved.report_id !== report.report_hash.slice(0, 32)) throw new Error("Saved report identity is inconsistent. Reopen it.");
  return { ...saved, report, status: checkedStatus(saved.status) };
}
function checkedRequestedReport(value: unknown, request: IntensityRequest, snapshot: ResearchSnapshot): { report: IntensityReport; reportJson: string } {
  const reportJson = (value as { report_json?: unknown })?.report_json;
  if (typeof reportJson !== "string" || reportJson.length > 8 * 1024 ** 2 || /[^\x00-\x7f]/u.test(reportJson))
    throw new Error("The exact comparison snapshot is unavailable. Preview again.");
  const report = checkedIntensityReport(JSON.parse(reportJson));
  if (JSON.stringify(report.result_ids) !== JSON.stringify(request.result_ids) || report.endpoint.compartment !== request.endpoint.compartment ||
    Object.keys(request.declaration).some((field) => report.declaration[field as keyof IntensityDeclaration] !== request.declaration[field as keyof IntensityDeclaration]) ||
    report.bindings.length !== request.result_ids.length || report.bindings.some((binding, index) => {
      const result = snapshot.results.find((row) => row.id === request.result_ids[index]);
      const descriptor = binding.descriptor as IntensityDescriptor | undefined;
      return !result || binding.result_id !== result.id || binding.revision_hash !== result.revision_hash || binding.source_id !== result.source_id ||
        binding.source_sha256 !== result.source_sha256 || descriptor?.id !== request.metric_ids[result.id];
    })) throw new Error("The comparison does not match the requested exact evidence and endpoint. Preview again.");
  return { report, reportJson };
}
function evidence(snapshot: ResearchSnapshot, keys: string[]) {
  const results = keys.map((key) => snapshot.results.find((row) => keyOf(row) === key));
  return [snapshot.project.project_id, snapshot.project.title, results,
    results.map((row) => snapshot.sources.find((source) => source.id === row?.source_id)),
    results.map((row) => snapshot.samples.find((sample) => sample.id === row?.source_id))];
}
function signatureFor(snapshot: ResearchSnapshot, keys: string[], compartment: string, metrics: Record<string, string>, declaration: IntensityDeclaration) {
  return JSON.stringify([evidence(snapshot, keys), keys, compartment, metrics, declaration]);
}

function ReplicatePlot({ report }: { report: IntensityReport }) {
  const values = [...report.replicates.map((row) => row.mean), ...report.conditions.map((row) => row.mean)].filter((value): value is number => value !== null);
  if (!values.length) return <p>No valid declared replicate means to plot. Inspect the image reasons below.</p>;
  const low = Math.min(...values), high = Math.max(...values), scale = Math.max(Math.abs(low), Math.abs(high), 1);
  const x = (value: number) => 3 + (high === low ? 0.5 : (value / scale - low / scale) / (high / scale - low / scale)) * 94;
  return <div className="intensity-plot" role="region" aria-label="Intensity replicate plot" tabIndex={0}>
    <div role="img" aria-label="Declared replicate means by condition">
      {report.conditions.map((condition) => {
        const rows = report.replicates.filter((row) => row.condition === condition.condition && row.mean !== null);
        return <div className="intensity-plot-row" key={condition.condition}>
          <span className="intensity-plot-label" title={condition.condition}>{condition.condition}</span>
          <div className="intensity-plot-lane">
            {rows.map((row, point) => <span className="intensity-plot-point" key={row.biological_replicate}
              style={{ left: `${x(row.mean!)}%`, top: `${20 + ((point % 5) - 2) * 5}px` }}
              title={`${condition.condition} · ${row.biological_replicate}: ${exactNumber(row.mean)}`} />)}
            {condition.mean !== null && <span className="intensity-plot-mean" style={{ left: `${x(condition.mean)}%` }}
              title={`${condition.condition} mean: ${exactNumber(condition.mean)}`} />}
          </div>
        </div>;
      })}
      <div className="intensity-plot-range"><span>{exactNumber(low)}</span><span>{exactNumber(high)}</span></div>
    </div>
    <p className="intensity-axis-label">Raw mean intensity (source-intensity units)</p>
    <p>Circles: declared replicate means. Line: condition mean.</p>
  </div>;
}
function ReportTables({ report, snapshot, onInspect, disabled }: { report: IntensityReport; snapshot: ResearchSnapshot; onInspect: (result: ResearchResult) => void; disabled: boolean }) {
  return <>
    <p><strong>{compartmentNames[report.endpoint.compartment]} raw-channel mean</strong> · source-intensity units</p>
    <p className="intensity-hint">Equal weight at each step: objects → images → declared replicates → conditions.</p>
    <details className="intensity-details"><summary>Channel declaration &amp; method</summary>
      <dl className="intensity-declaration"><div><dt>Shared channel declaration</dt><dd>{report.declaration.channel}</dd></div>
        <div><dt>Acquisition context</dt><dd>{report.declaration.acquisition_context}</dd></div><div><dt>Comparability rationale</dt><dd>{report.declaration.rationale}</dd></div></dl>
      <p>Object means have equal weight within each image; image means have equal weight within each declared replicate; replicate means have equal weight within each condition. SD is descriptive sample SD; it needs at least two valid replicate means. Declared groups do not establish independent sampling.</p>
    </details>
    <ReplicatePlot report={report} />
    <div className="intensity-table" role="region" aria-label="Intensity condition means" tabIndex={0}><table>
      <caption>Condition means · source-intensity units</caption><thead><tr>{["Condition", "Mean", "Sample SD", "Objects / valid", "Images / valid", "Declared replicate groups / valid", "Images without replicate"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{report.conditions.map((row) => <tr key={row.condition}><th scope="row">{row.condition}</th><td><ScientificNumber value={row.mean} /></td><td><ScientificNumber value={row.sd} /></td>
        <td>{row.object_count} / {row.valid_object_count}</td><td>{row.image_count} / {row.valid_image_count}</td><td>{row.declared_replicate_count} / {row.valid_replicate_count}</td><td>{row.unassigned_image_count}</td></tr>)}</tbody>
    </table></div>
    <details className="intensity-details"><summary>Declared replicate means ({report.replicates.length})</summary>
      <div className="intensity-table" role="region" aria-label="Intensity replicate means" tabIndex={0}><table><caption>Equal-weight image means within each condition / declared replicate</caption>
        <thead><tr>{["Condition", "Declared replicate", "Mean", "Images / valid", "Objects / valid"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{report.replicates.map((row) => <tr key={JSON.stringify([row.condition, row.biological_replicate])}><th scope="row">{row.condition}</th><td>{row.biological_replicate}</td>
          <td><ScientificNumber value={row.mean} /></td><td>{row.image_count} / {row.valid_image_count}</td><td>{row.object_count} / {row.valid_object_count}</td></tr>)}</tbody></table></div>
    </details>
    <details className="intensity-details"><summary>Image means &amp; inclusion reasons ({report.images.length})</summary>
      <div className="intensity-table" role="region" aria-label="Intensity image means" tabIndex={0}><table><caption>Exact selected revisions · equal-weight object means per image</caption>
        <thead><tr>{["Image / measurement", "Sample / condition / replicate", "Literal channel", "Mean", "Objects / valid / null / missing", "Reason"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{report.images.map((row) => {
          const binding = report.bindings.find((entry) => entry.result_id === row.result_id);
          const descriptor = binding?.descriptor as IntensityDescriptor | undefined;
          const exact = snapshot.results.find((entry) => entry.id === row.result_id && entry.revision_hash === row.revision_hash && entry.source_id === row.source_id);
          const audit = report.audit.find((entry) => entry.result_id === row.result_id);
          return <tr key={row.result_id} data-intensity-result-id={row.result_id} data-revision-hash={row.revision_hash}><th scope="row">{reportDescription(report, row.result_id)}
            {exact ? <button type="button" aria-label={`Inspect result: ${reportDescription(report, row.result_id)}`} disabled={disabled} onClick={() => onInspect(exact)}>Inspect result</button> : <span>Exact revision unavailable in this study.</span>}
            <details className="intensity-details"><summary aria-label={`Technical identity for ${reportDescription(report, row.result_id)}`}>Technical identity</summary><dl className="intensity-declaration intensity-identity">
              <div><dt>Result ID</dt><dd>{row.result_id}</dd></div><div><dt>Revision</dt><dd>{row.revision_hash}</dd></div>
              <div><dt>Source ID</dt><dd>{row.source_id}</dd></div><div><dt>Source fingerprint</dt><dd>{binding?.source_sha256 ?? "Unavailable"}</dd></div>
            </dl></details></th>
            <td>{row.sample}<br />{row.condition}<br />{row.biological_replicate ?? "Unassigned"}</td><td>{descriptor?.channel ?? "Unavailable"}</td><td><ScientificNumber value={row.mean} /></td>
            <td>{row.object_count} / {row.valid_object_count} / {row.null_object_count} / {row.missing_object_count}</td><td>{String(audit?.review_disposition ?? "unavailable")} · {row.reason}</td></tr>;
        })}</tbody></table></div>
    </details>
    <details className="intensity-details"><summary>Exact report identity &amp; settings</summary>
      <p>Created {report.created_at} · engine {report.software.engine}</p><code className="intensity-hash">{report.report_hash}</code>
      <pre tabIndex={0} aria-label="Exact intensity report identity and settings">{JSON.stringify({ endpoint: report.endpoint, bindings: report.bindings, aggregation: report.aggregation, audit: report.audit }, null, 2)}</pre>
    </details>
  </>;
}

export function ExperimentIntensityPanel({ api, snapshot, active = true, busy = false, seed, onInspect, onSnapshot }: {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; active?: boolean; busy?: boolean;
  seed?: { result: ResearchResult; serial: number } | null;
  onInspect: (result: ResearchResult) => void; onSnapshot: (snapshot: ResearchSnapshot | null) => void;
}) {
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [compartment, setCompartment] = useState<IntensityCompartment | "">("");
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [declaration, setDeclaration] = useState<IntensityDeclaration>({ channel: "", acquisition_context: "", rationale: "" });
  const [catalog, setCatalog] = useState<{ identity: string; value: IntensityCatalog } | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false), [catalogError, setCatalogError] = useState("");
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [view, setView] = useState<ReportView | null>(null);
  const [reports, setReports] = useState<SavedSummary[]>([]), [reportsLoaded, setReportsLoaded] = useState(false);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [stale, setStale] = useState(false);
  const [cancelling, setCancelling] = useState(false), [statusChecking, setStatusChecking] = useState(false);
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(null);
  const mounted = useRef(true), generation = useRef(0), catalogGeneration = useRef(0), statusGeneration = useRef(0);
  const inFlight = useRef(false), activeExport = useRef<ExportRequest | null>(null);
  const selected = selectedKeys.map((key) => snapshot.results.find((result) => keyOf(result) === key));
  const exact = selected.filter((result): result is ResearchResult => Boolean(result));
  const identity = JSON.stringify(evidence(snapshot, selectedKeys));
  const signature = signatureFor(snapshot, selectedKeys, compartment, metrics, declaration);
  const savedEvidence = JSON.stringify(evidence(snapshot, view?.savedId ? view.report.bindings.map((binding) =>
    keyOf({ id: binding.result_id, revision_hash: binding.revision_hash })) : []));
  const live = useRef(signature); live.current = signature;
  const onSnapshotRef = useRef(onSnapshot); onSnapshotRef.current = onSnapshot;
  const locked = busy || Boolean(pending) || cancelling;
  const setupLocked = locked || Boolean(view?.savedId);
  const currentCatalog = catalog?.identity === identity ? catalog.value : null;
  const job = exportRequest ? snapshot.jobs.find((row) => row.request_key === exportRequest.key && row.operation === "intensity_export") : null;
  const scopeReason = !selectedKeys.length ? "Choose at least one exact result revision." : selectedKeys.length > 100 ? "Choose at most 100 exact result revisions." :
    selected.length !== exact.length ? "A selected exact revision is unavailable. Restore it or clear the selection." :
    new Set(exact.map((row) => row.source_id)).size !== exact.length ? "Choose one exact revision per source." :
    exact.some((row) => row.schema === "loci.research-result/v2") ? "Indexed v2 results are unsupported. Choose bounded object results." :
    exact.some((row) => disposition(row) === "pending") ? "Review pending revisions in Review & export before comparing intensity." :
    exact.reduce((sum, row) => sum + row.object_count, 0) > 50_000 ? "Choose revisions with at most 50,000 objects in total." : "";
  const availableCompartments = compartments.filter((part) => currentCatalog?.results.length && currentCatalog.results.every((row) => row.descriptors.some((descriptor) => meanDescriptor(descriptor, part))));
  const reason = scopeReason || (catalogLoading ? "Reading the actual stored intensity measurements…" : catalogError || (!currentCatalog ? "Load the stored measurements for these revisions." :
    !availableCompartments.length ? "These revisions share no supported raw mean compartment. Choose compatible measured results." :
    !compartment || !availableCompartments.includes(compartment) ? "Choose a measured compartment shared by every selected result." :
    currentCatalog.results.some((row) => !row.descriptors.some((descriptor) => descriptor.id === metrics[row.result_id] && meanDescriptor(descriptor, compartment))) ? "Choose an actual literal channel mean for every selected result." :
    !declaration.channel.trim() || !declaration.acquisition_context.trim() || !declaration.rationale.trim() ? "Describe the shared channel, acquisition context and comparability rationale." : ""));
  const previewCurrent = view && !view.savedId && view.signature === signature;

  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; generation.current++; catalogGeneration.current++; statusGeneration.current++;
    const request = activeExport.current; activeExport.current = null;
    if (request) void api.cancelDataExport?.(request.key).catch(() => {});
  }; }, [api]);
  useEffect(() => {
    if (!seed) return;
    setSelectedKeys((old) => [...old.filter((key) => {
      const result = snapshot.results.find((row) => keyOf(row) === key);
      return result && result.source_id !== seed.result.source_id;
    }), keyOf(seed.result)]);
    setView(null); setError(""); setNotice("");
    // The explicit route is an intent, not a response to ordinary snapshot refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.serial]);
  useEffect(() => {
    setView((old) => {
      if (old && !old.savedId && old.signature !== signature) { setStale(true); return null; }
      return old;
    });
  }, [signature]);
  useEffect(() => {
    if (!active || scopeReason || catalog?.identity === identity) {
      setCatalogLoading(false);
      return;
    }
    const token = ++catalogGeneration.current;
    setCatalogLoading(true); setCatalogError("");
    void api.execute("intensity_catalog", { result_ids: exact.map((row) => row.id) }).then((response) => {
      if (!mounted.current || token !== catalogGeneration.current) return;
      const value = response as IntensityCatalog;
      if (value?.schema !== "loci.experiment-intensity-catalog/v1" || !Array.isArray(value.results) || value.results.length !== exact.length || value.results.some((row, index) =>
        row.result_id !== exact[index].id || row.revision_hash !== exact[index].revision_hash || row.source_id !== exact[index].source_id ||
        !Array.isArray(row.descriptors) || row.descriptors.some((descriptor) => !meanDescriptor(descriptor)))) throw new Error("Stored measurement choices do not match these exact revisions. Retry them.");
      setCatalog({ identity, value });
    }).catch((caught) => { if (mounted.current && token === catalogGeneration.current) setCatalogError(message(caught)); })
      .finally(() => { if (mounted.current && token === catalogGeneration.current) setCatalogLoading(false); });
    return () => { catalogGeneration.current++; };
    // Exact bound evidence drives this read; draft prose and jobs do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, active, identity, scopeReason, catalogRefresh]);
  const refreshReports = async () => {
    setReportsLoading(true);
    try {
    const response = await api.execute("intensity_list", {}) as { reports: SavedSummary[] };
    if (!Array.isArray(response?.reports) || response.reports.some((row) => typeof row.id !== "string" || typeof row.created_at !== "string" || !row.endpoint || !row.declaration))
      throw new Error("Could not read saved intensity reports. Refresh the list.");
    if (mounted.current) { setReports(response.reports); setReportsLoaded(true); }
    } finally { if (mounted.current) setReportsLoading(false); }
  };
  useEffect(() => {
    if (!active || reportsLoaded || !api.planIntensityExport) return;
    let current = true;
    void refreshReports().catch((caught) => { if (current && mounted.current) setError(message(caught)); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, active, reportsLoaded]);
  useEffect(() => {
    if (!view?.savedId || !active) return;
    const token = ++statusGeneration.current;
    setStatusChecking(true);
    setView((old) => old?.savedId === view.savedId ? { ...old, status: null } : old);
    void api.execute("intensity_get", { report_id: view.savedId }).then((response) => {
      if (!mounted.current || token !== statusGeneration.current) return;
      const saved = checkedSaved(response);
      if (saved.report_id !== view.savedId || saved.report.report_hash !== view.report.report_hash) throw new Error("The saved report changed unexpectedly. Reopen it before continuing.");
      setView((old) => old?.savedId === saved.report_id ? { ...old, status: saved.status } : old);
    }).catch((caught) => { if (mounted.current && token === statusGeneration.current) setError(message(caught)); })
      .finally(() => { if (mounted.current && token === statusGeneration.current) setStatusChecking(false); });
    return () => { statusGeneration.current++; };
    // Current inputs are separate from the retained report snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, active, view?.savedId, savedEvidence]);
  useEffect(() => {
    if (!exportRequest || job || !onSnapshotRef.current) return;
    let observing = true, reading = false;
    const discover = async () => {
      if (reading) return;
      reading = true;
      try { const next = await api.getSnapshot(); if (observing && mounted.current && activeExport.current === exportRequest) onSnapshotRef.current(next); }
      catch (caught) { if (observing && mounted.current) setError(`Could not refresh export status: ${message(caught)}`); }
      finally { reading = false; }
    };
    void discover();
    const timer = window.setInterval(() => void discover(), 1000);
    return () => { observing = false; window.clearInterval(timer); };
  }, [api, exportRequest, job]);
  const run = async (name: string, work: (current: () => boolean) => Promise<void>) => {
    if (locked || inFlight.current) return;
    inFlight.current = true;
    const token = ++generation.current, bound = live.current;
    const current = () => mounted.current && generation.current === token && live.current === bound;
    setPending(name); setError(""); setNotice("");
    try { await work(current); }
    catch (caught) { if (mounted.current && token === generation.current) setError(message(caught)); }
    finally { inFlight.current = false; if (mounted.current && token === generation.current) setPending(""); }
  };
  const prepare = () => run("Preparing intensity comparison", async (current) => {
    if (reason || !compartment) return;
    setView(null); setStale(false);
    const request: IntensityRequest = { result_ids: exact.map((row) => row.id), endpoint: endpoint(compartment),
      metric_ids: Object.fromEntries(exact.map((row) => [row.id, metrics[row.id]])), declaration: { ...declaration } };
    const preview = checkedRequestedReport(await api.execute("intensity_preview", { ...request }), request, snapshot);
    if (current()) setView({ ...preview, savedId: null, signature, status: null });
  });
  const save = () => run("Saving intensity report", async (current) => {
    if (!previewCurrent || !view?.reportJson) return;
    const saved = checkedSaved(await api.execute("intensity_save", { report_json: view.reportJson }));
    if (saved.report.report_hash !== view.report.report_hash) throw new Error("The saved report differs from the preview. Preview again.");
    if (!current()) return;
    setView({ ...view, savedId: saved.report_id, status: saved.status }); setNotice("Intensity report saved as an immutable snapshot.");
    await refreshReports();
    const next = await api.getSnapshot(); if (mounted.current) onSnapshotRef.current(next);
  });
  const open = (id: string) => run("Opening saved intensity report", async (current) => {
    const saved = checkedSaved(await api.execute("intensity_get", { report_id: id }));
    if (saved.report_id !== id) throw new Error("The opened report does not match the selected report.");
    if (current()) { setView({ report: saved.report, savedId: saved.report_id, status: saved.status, signature: "" }); setStale(false); }
  });
  const recompute = () => run("Recomputing as new preview", async (current) => {
    if (!view?.savedId) return;
    const old = view.report;
    const keys = old.bindings.map((binding) => keyOf({ id: binding.result_id, revision_hash: binding.revision_hash }));
    const literalMetrics = Object.fromEntries(old.bindings.map((binding) => {
      const descriptor = binding.descriptor as IntensityDescriptor | undefined;
      if (!descriptor || !meanDescriptor(descriptor, old.endpoint.compartment)) throw new Error("A saved literal measurement is unavailable. Set up a new comparison.");
      return [binding.result_id, descriptor.id];
    }));
    const request: IntensityRequest = { result_ids: old.result_ids, endpoint: old.endpoint, metric_ids: literalMetrics, declaration: old.declaration };
    const preview = checkedRequestedReport(await api.execute("intensity_preview", { ...request }), request, snapshot);
    if (!current()) return;
    setSelectedKeys(keys); setCompartment(old.endpoint.compartment); setMetrics(literalMetrics); setDeclaration({ ...old.declaration });
    setView({ ...preview, savedId: null, status: null, signature: signatureFor(snapshot, keys, old.endpoint.compartment, literalMetrics, old.declaration) });
    setStale(false); setNotice("New preview computed from current inputs. Save it as a new report; the saved snapshot remains unchanged.");
  });
  const exportReport = () => run("Preparing intensity export", async (current) => {
    if (!view?.savedId || !api.planIntensityExport || !api.exportIntensityReport || !api.cancelDataExport) return;
    const request = { key: `scientific-export:${crypto.randomUUID()}`, generation: generation.current };
    activeExport.current = request; setExportRequest(request);
    try {
      const plan = await api.planIntensityExport(view.savedId, request.key);
      if (!current() || activeExport.current !== request) return;
      if (plan?.schema !== "loci.intensity-export-plan/v1" || plan.report_id !== view.savedId || plan.report_hash !== view.report.report_hash || !/^[a-f0-9]{64}$/u.test(plan.plan_hash))
        throw new Error("Export plan does not match the exact saved report. Retry the export.");
      const status = checkedStatus(plan.status); setView((old) => old?.savedId === view.savedId ? { ...old, status } : old);
      setPending("Exporting intensity report");
      const receipt = await api.exportIntensityReport(view.savedId, plan.plan_hash, request.key);
      if (!current() || activeExport.current !== request) return;
      if (!receipt) { setNotice("Destination selection cancelled. Retry export to prepare a fresh plan."); return; }
      if (receipt.schema !== "loci.intensity-export-receipt/v1" || receipt.report_hash !== view.report.report_hash || typeof receipt.basename !== "string")
        throw new Error("Export receipt does not match this saved report. Check Jobs before retrying.");
      setNotice(`Saved ${receipt.basename}. Exact saved report values and provenance were exported.`);
      const next = await api.getSnapshot(); if (current()) onSnapshotRef.current(next);
    } catch (caught) { if (current()) throw new Error(`${message(caught)} Retry export to prepare a fresh plan.`); }
    finally { if (activeExport.current === request) { activeExport.current = null; if (mounted.current) setExportRequest(null); } }
  });
  const cancelExport = async () => {
    const request = activeExport.current;
    if (!request || cancelling || !api.cancelDataExport) return;
    generation.current++; activeExport.current = null; setExportRequest(null); setPending(""); setCancelling(true); setError("");
    try {
      const receipt = await api.cancelDataExport(request.key);
      if (mounted.current) setNotice(receipt.cancelled ? "Cancellation requested. Check Jobs and the destination before retrying with a fresh export plan." : "Cancellation was not confirmed. Check Jobs and the destination before retrying.");
      const next = await api.getSnapshot(); if (mounted.current) onSnapshotRef.current(next);
    } catch (caught) { if (mounted.current) setError(`Could not confirm cancellation: ${message(caught)}`); }
    finally { if (mounted.current) setCancelling(false); }
  };
  return <section className="research-panel experiment-intensity" aria-label="Experiment intensity" aria-busy={Boolean(pending) || catalogLoading}>
    <h2>Experiment intensity</h2>
    <p>Compare stored raw-channel means across images, declared replicates and conditions.</p>
    {view?.savedId && <p className="intensity-caution">Viewing an immutable saved report. Recompute explicitly to prepare a new comparison.</p>}
    <fieldset hidden={Boolean(view?.savedId)} disabled={setupLocked} className="intensity-setup"><legend>Exact evidence &amp; endpoint</legend>
      <p>One revision per source; up to 100 revisions and 50,000 objects. Reviewed results contribute. Excluded results remain in the audit.</p>
      {!snapshot.results.length && <p>No saved results. Segment and measure an image, then review its exact revision.</p>}
      <div className="intensity-result-choices">{snapshot.results.map((row) => {
        const checked = selectedKeys.includes(keyOf(row));
        const other = exact.some((entry) => entry.source_id === row.source_id && keyOf(entry) !== keyOf(row));
        const review = disposition(row);
        const description = resultDescription(snapshot, row);
        const why = row.schema === "loci.research-result/v2" ? "Unsupported indexed result" : review === "pending" ? "Blocked until reviewed" : review === "excluded" ? "Excluded from estimates; audit only" : "Reviewed";
        return <div key={keyOf(row)} className="intensity-result-row" data-intensity-result-id={row.id} data-revision-hash={row.revision_hash}><label className="intensity-result-choice"><input type="checkbox" aria-label={`Intensity result: ${description} · ${why}`} checked={checked}
          disabled={!checked && (review === "pending" || row.schema === "loci.research-result/v2" || other)} onChange={(event) => {
            setSelectedKeys((old) => event.target.checked ? [...old, keyOf(row)] : old.filter((key) => key !== keyOf(row))); setError(""); setNotice("");
          }} /><span>{description}<small>{why}{other ? " · Clear the other selected revision on this source first" : ""}</small></span></label>
          <details className="intensity-choice-identity"><summary aria-label={`Technical identity for ${description}`}>Technical identity</summary><ResultIdentity result={row} /></details></div>;
      })}</div>
      {selectedKeys.some((key) => !snapshot.results.some((row) => keyOf(row) === key)) && <button type="button" onClick={() => setSelectedKeys((old) => old.filter((key) => snapshot.results.some((row) => keyOf(row) === key)))}>Clear unavailable revisions</button>}
      <label>Compartment<select aria-label="Intensity compartment" value={compartment} onChange={(event) => { setCompartment(event.target.value as typeof compartment); setMetrics({}); }}>
        <option value="">Choose measured compartment</option>{availableCompartments.map((part) => <option key={part} value={part}>{compartmentNames[part]} mean</option>)}
      </select></label>
      {currentCatalog?.results.map((row) => <label key={row.result_id} data-intensity-result-id={row.result_id} data-revision-hash={row.revision_hash}>{resultDescription(snapshot, exact.find((entry) => entry.id === row.result_id)!)}<select aria-label={`Intensity channel for ${resultDescription(snapshot, exact.find((entry) => entry.id === row.result_id)!)}`}
        value={metrics[row.result_id] ?? ""} disabled={!compartment} onChange={(event) => setMetrics((old) => ({ ...old, [row.result_id]: event.target.value }))}>
        <option value="">Choose literal stored channel mean</option>{row.descriptors.filter((descriptor) => meanDescriptor(descriptor, compartment)).map((descriptor) => <option key={descriptor.id} value={descriptor.id}>{descriptor.channel} · {descriptor.label}</option>)}
      </select></label>)}
      <label>Shared channel declaration<input aria-label="Shared channel declaration" maxLength={256} value={declaration.channel} onChange={(event) => setDeclaration((old) => ({ ...old, channel: event.target.value }))} /></label>
      <label>Acquisition context<textarea aria-label="Acquisition context" maxLength={2048} rows={2} value={declaration.acquisition_context} onChange={(event) => setDeclaration((old) => ({ ...old, acquisition_context: event.target.value }))} /></label>
      <label>Comparability rationale<textarea aria-label="Comparability rationale" maxLength={2048} rows={3} value={declaration.rationale} onChange={(event) => setDeclaration((old) => ({ ...old, rationale: event.target.value }))} /></label>
      <p>Your declaration records the intended channel and acquisition comparability. It does not verify calibration or biological identity. Incompatible recorded methods, units or scopes remain blocked.</p>
    </fieldset>
    {!view?.savedId && reason && <p className="intensity-hint">{reason}</p>}
    {catalogError && !view?.savedId && <button type="button" disabled={locked} onClick={() => { setCatalog(null); setCatalogError(""); setCatalogRefresh((old) => old + 1); }}>Retry stored measurements</button>}
    {stale && !view?.savedId && <p className="intensity-caution">Settings or bound evidence changed. Preview the intensity comparison again before saving.</p>}
    <div className="research-actions">{!view?.savedId && <><button type="button" disabled={locked || Boolean(reason)} onClick={() => void prepare()}>Preview intensity comparison</button>
      <button type="button" disabled={locked || !previewCurrent} onClick={() => void save()}>Save intensity report</button></>}
      {view?.savedId && <><button type="button" disabled={locked} onClick={() => void recompute()}>Recompute as new preview</button>
        <button type="button" disabled={locked} onClick={() => { setView(null); setNotice(""); setError(""); }}>Set up another comparison</button>
        <button type="button" disabled={locked || !api.planIntensityExport || !api.exportIntensityReport || !api.cancelDataExport} onClick={() => void exportReport()}>Export intensity report…</button></>}
      {(exportRequest || cancelling) && <button type="button" disabled={cancelling} onClick={() => void cancelExport()}>{cancelling ? "Cancelling…" : "Cancel intensity export"}</button>}
    </div>
    {!view?.savedId && <p className="intensity-hint">Save a current preview before exporting an intensity report.</p>}
    {view?.savedId && (!api.planIntensityExport || !api.exportIntensityReport || !api.cancelDataExport) && <p className="intensity-hint">Intensity report export is unavailable in this app connection.</p>}
    {pending && <p role="status">{pending}{job ? ` · ${job.state}` : ""}…</p>}
    {job && Number.isFinite(job.progress) && job.progress >= 0 && job.progress <= 1 && <progress aria-label="Intensity export progress" value={job.progress} max={1} />}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <details className="intensity-details"><summary>Saved intensity reports ({reports.length})</summary>
      <button type="button" disabled={locked} onClick={() => void run("Reading saved reports", async () => refreshReports())}>Refresh saved intensity reports</button>
      {reportsLoading && <p role="status">Reading saved intensity reports…</p>}
      {reportsLoaded && !reports.length && <p>No intensity reports have been saved in this study.</p>}
      <ul className="intensity-report-list">{reports.map((row, index) => <li key={row.id} data-report-id={row.id}><span>{row.declaration.channel} · {compartmentNames[row.endpoint.compartment]} · {reportTime(row.created_at)}</span>
        <button type="button" disabled={locked} aria-label={`Open saved intensity report ${index + 1}: ${row.declaration.channel} · ${compartmentNames[row.endpoint.compartment]} · ${reportTime(row.created_at)}`} onClick={() => void open(row.id)}>Open saved report</button>
        <details className="intensity-details"><summary>Report identity</summary><code className="intensity-hash">{row.id}</code><p>Created {row.created_at}</p></details></li>)}</ul>
    </details>
    {view && <section className="intensity-report" aria-label={view.savedId ? "Saved intensity report" : "Intensity comparison preview"}>
      <h3>{view.savedId ? "Saved intensity report" : "Comparison preview"}</h3>
      {view.savedId && <div className="intensity-current-status" role="status"><p>{statusChecking ? "Checking current inputs…" : !view.status ? "Current input status could not be verified. Saved values remain unchanged." : view.status.current ? "Current inputs match this saved report." : "Current inputs differ. Saved values remain unchanged."}</p>
        {!statusChecking && view.status && !view.status.current && <ul>{view.status.changes.map((row, index) => <li key={index}>
          {reportDescription(view.report, row.result_id)} · {friendlyStatus(row.reason)}</li>)}</ul>}</div>}
      {view.savedId && view.status && <details className="intensity-details"><summary>Current input status details</summary>
        {view.status.changes.map((row, index) => <dl className="intensity-declaration intensity-identity" key={index}><div><dt>Result ID</dt><dd>{row.result_id}</dd></div>
          <div><dt>Saved revision</dt><dd>{view.report.bindings.find((binding) => binding.result_id === row.result_id)?.revision_hash ?? "Unavailable"}</dd></div></dl>)}
        <pre tabIndex={0} aria-label="Exact current input status">{JSON.stringify(view.status, null, 2)}</pre></details>}
      <ReportTables report={view.report} snapshot={snapshot} onInspect={onInspect} disabled={locked} />
    </section>}
  </section>;
}
