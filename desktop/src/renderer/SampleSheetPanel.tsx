import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchSampleData, ResearchSnapshot } from "../shared/research-contracts";
import type { SampleSheetPreview } from "../shared/intensity-contracts";
import "./ExperimentIntensityPanel.css";

const MAX_BYTES = 1024 * 1024;
const fields = ["study", "sample", "condition", "biological_replicate", "plate", "well"] as const;
const labels = ["Study", "Sample", "Condition", "Biological replicate", "Plate", "Well"];
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*/u, "") : "Could not read the sample sheet. Retry its preview.";
function checkedPreview(value: unknown, csv: string, studyId: string | undefined): SampleSheetPreview {
  const row = value as SampleSheetPreview;
  if (!row || row.schema !== "loci.sample-sheet-preview/v1" || row.csv_text !== csv || row.study_id !== studyId ||
    !/^[a-f0-9]{64}$/u.test(row.preview_sha256) || !Array.isArray(row.rows) || row.rows.length > 1000 ||
    !Array.isArray(row.errors) || row.errors.some((issue) => typeof issue !== "string") || typeof row.can_apply !== "boolean" ||
    row.rows.some((entry) => !Number.isSafeInteger(entry.row_number) || typeof entry.source_id !== "string" || typeof entry.match !== "string" ||
      !Array.isArray(entry.issues) || entry.issues.some((issue) => typeof issue !== "string")))
    throw new Error("The sample preview does not match this study and CSV. Preview it again.");
  return row;
}
function SampleValues({ value }: { value: ResearchSampleData | null }) {
  return value ? <dl className="sample-sheet-values">{fields.map((field, index) => <div key={field}><dt>{labels[index]}</dt><dd>{value[field] ?? "Unassigned"}</dd></div>)}</dl> : <>No sample metadata</>;
}
async function fileBytes(file: File): Promise<ArrayBuffer> {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("Could not read that CSV file."));
    reader.readAsArrayBuffer(file);
  });
}
export function SampleSheetPanel({ api, snapshot, busy = false, onSnapshot }: {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; busy?: boolean;
  onSnapshot: (snapshot: ResearchSnapshot | null) => void;
}) {
  const [csv, setCsv] = useState("");
  const [templateCsv, setTemplateCsv] = useState("");
  const [preview, setPreview] = useState<{ signature: string; value: SampleSheetPreview } | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const generation = useRef(0), mounted = useRef(true);
  const signature = JSON.stringify([snapshot.project.project_id, snapshot.project.title, snapshot.sources, snapshot.samples, csv]);
  const live = useRef(signature); live.current = signature;
  const currentPreview = preview?.signature === signature ? preview.value : null;
  const blocked = busy || Boolean(pending);
  const byteCount = new TextEncoder().encode(csv).length;
  const reason = !csv.trim() ? "Load a template, choose a CSV file or paste its text." : byteCount > MAX_BYTES ? "Sample sheets must be at most 1 MiB." : "";
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    setPreview((old) => { if (old && old.signature !== signature) { setStale(true); return null; } return old; });
  }, [signature]);
  const run = async (name: string, work: (isCurrent: () => boolean) => Promise<void>) => {
    if (blocked) return;
    const token = ++generation.current, bound = signature;
    const isCurrent = () => mounted.current && generation.current === token && live.current === bound;
    setPending(name); setError(""); setNotice("");
    try { await work(isCurrent); }
    catch (caught) { if (mounted.current && token === generation.current) { setError(message(caught)); setPreview(null); } }
    finally { if (mounted.current && token === generation.current) setPending(""); }
  };
  const loadTemplate = () => run("Loading template", async (current) => {
    const response = await api.execute("sample_sheet_template", {}) as { schema: string; study_id: string; csv_text: string };
    if (!current()) return;
    if (response?.schema !== "loci.sample-sheet-template/v1" || response.study_id !== snapshot.project.project_id ||
      typeof response.csv_text !== "string" || new TextEncoder().encode(response.csv_text).length > MAX_BYTES)
      throw new Error("The template does not match the open study. Reload it.");
    setTemplateCsv(response.csv_text); setCsv(response.csv_text); setPreview(null); setStale(false);
    setNotice("Template loaded. Fill the required study, sample and condition values before previewing.");
  });
  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([templateCsv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "Loci-sample-sheet.csv"; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const prepare = () => run("Previewing sample sheet", async (current) => {
    if (reason) return;
    const response = await api.execute("sample_sheet_preview", { csv_text: csv });
    if (current()) { setPreview({ signature, value: checkedPreview(response, csv, snapshot.project.project_id) }); setStale(false); }
  });
  const apply = () => run("Applying sample sheet", async (current) => {
    if (!currentPreview?.can_apply) return;
    await api.execute("sample_sheet_apply", { preview: currentPreview });
    const next = await api.getSnapshot();
    if (current()) { onSnapshot(next); setPreview(null); setStale(false); setNotice(`Applied sample metadata for ${currentPreview.rows.length} images.`); }
  });
  return <section className="research-panel sample-sheet" aria-label="Sample sheet" aria-busy={Boolean(pending)}>
    <h2>Sample sheet</h2>
    <p>Assign samples by exact source ID. Manual editing remains in Review &amp; export.</p>
    <div className="research-actions"><button type="button" disabled={blocked || !snapshot.sources.length} onClick={() => void loadTemplate()}>Load sample sheet template</button>
      <button type="button" disabled={blocked || !templateCsv} onClick={downloadTemplate}>Download sample sheet template</button></div>
    {!snapshot.sources.length && <p>Add images to the study before preparing a sample sheet.</p>}
    <label>Choose CSV file<input type="file" accept=".csv,text/csv" aria-label="Sample sheet file" disabled={blocked} onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file) return;
      void run("Reading CSV file", async (current) => {
        if (file.size > MAX_BYTES) throw new Error("Sample sheets must be at most 1 MiB.");
        if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a .csv sample sheet.");
        const bytes = await fileBytes(file);
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { throw new Error("Sample sheets must use UTF-8 text."); }
        if (current()) { setCsv(text); setPreview(null); setStale(false); }
      });
    }} /></label>
    <label>CSV text<textarea aria-label="Sample sheet CSV" rows={6} spellCheck={false} value={csv} disabled={blocked}
      onChange={(event) => { setCsv(event.target.value); setError(""); setNotice(""); }} /></label>
    <p>Columns: source_id, study, sample, condition, biological_replicate, plate, well. Up to 1,000 rows and 1 MiB.</p>
    {reason && <p className="intensity-hint">{reason}</p>}
    {stale && <p className="intensity-caution">CSV or study metadata changed. Preview the sample sheet again before applying.</p>}
    <div className="research-actions"><button type="button" disabled={blocked || Boolean(reason)} onClick={() => void prepare()}>Preview sample sheet</button>
      <button type="button" disabled={blocked || !currentPreview?.can_apply} onClick={() => void apply()}>Apply sample sheet</button></div>
    {!currentPreview && !reason && <p className="intensity-hint">Preview the exact changes before applying.</p>}
    {pending && <p role="status">{pending}…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {currentPreview && <>
      <p>{currentPreview.rows.filter((row) => row.match === "matched").length} matched rows · {currentPreview.rows.filter((row) => row.match !== "matched").length} unmatched rows</p>
      {currentPreview.errors.length > 0 && <ul role="alert">{currentPreview.errors.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      {!currentPreview.can_apply && <p className="intensity-caution">Resolve every issue and preview again. No metadata has been applied.</p>}
      <div className="intensity-table" role="region" aria-label="Sample sheet before and after" tabIndex={0}><table>
        <caption>Every CSV row · exact source matches and proposed metadata</caption>
        <thead><tr><th scope="col">CSV row / source</th><th scope="col">Match</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Issues</th></tr></thead>
        <tbody>{currentPreview.rows.map((row) => <tr key={row.row_number}><th scope="row">{row.row_number} · {snapshot.sources.find((source) => source.id === row.source_id)?.name ?? "Unknown source"}<code>{row.source_id}</code></th>
          <td>{row.match}</td><td><SampleValues value={row.before} /></td><td><SampleValues value={row.after} /></td>
          <td>{row.issues.length ? row.issues.map((issue, index) => <p key={index}>{issue}</p>) : "No issues"}</td></tr>)}</tbody>
      </table></div>
    </>}
  </section>;
}
