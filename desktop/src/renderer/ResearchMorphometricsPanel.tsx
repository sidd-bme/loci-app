import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchJob, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { resultTitle } from "./result-title";
import { sanitizeRendererError } from "./ContextHelp";
import "./ResearchMorphometricsPanel.css";

const PARENTS = new Set(["segmentation", "cell-segmentation", "adaptive-segmentation", "cellpose-segmentation", "model-segmentation", "external-labels", "corrected-labels"]);
const isId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/u.test(v);
const isSha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
type Morphometry = { schema: string; input: { result_id: string; revision_hash: string; image_sha256: string; labels_sha256: string };
  object_count: number; index_axes: "YX" | "ZYX"; calibration_status: string; rules: Record<string, string>; units: Record<string, string> };

function checkedRecord(value: unknown, result: ResearchResult): Morphometry {
  const v = value as Morphometry | null;
  if (!v || v.schema !== "loci.morphometrics-result/v1" || !isId(v.input?.result_id) || !isSha(v.input?.revision_hash) ||
      !isSha(v.input?.image_sha256) || !isSha(v.input?.labels_sha256) || v.input.result_id !== result.parent_id ||
      !Number.isSafeInteger(v.object_count) || v.object_count < 0 || v.object_count !== result.object_count ||
      !["YX", "ZYX"].includes(v.index_axes) || v.index_axes !== result.geometry?.axes ||
      !["uncalibrated-pixel-geometry", "declared-physical-calibration"].includes(v.calibration_status) ||
      (v.calibration_status === "uncalibrated-pixel-geometry") !== (result.geometry?.unit === "pixel") ||
      !v.rules || !Object.values(v.rules).every((s) => typeof s === "string") || !v.units ||
      !Object.values(v.units).every((s) => typeof s === "string")) throw new Error("Shape measurements have an inconsistent saved identity. Reload the exact result.");
  return v;
}

export function MorphometricsSummary({ result, onExplore, onReview }: {
  result: ResearchResult; onExplore: (result: ResearchResult) => void; onReview: (result: ResearchResult) => void;
}) {
  try {
    const record = checkedRecord(result.morphometrics, result);
    return <section className="morphometrics-summary" aria-label="Saved object shape measurements">
      <h3>Saved shape measurements</h3>
      <p>{record.object_count} {record.object_count === 1 ? "object" : "objects"} · {record.index_axes === "YX" ? "2D pixel geometry" : "3D voxel geometry"}</p>
      {record.calibration_status === "uncalibrated-pixel-geometry" && <p role="note">Uncalibrated: lengths and areas use pixels. Physical comparisons require verified source calibration.</p>}
      <p>{record.index_axes === "YX" ? "Area, exposed-edge perimeter, circularity, eccentricity and elongation." : "Volume, exposed-face surface area and sphericity."} Undefined ratios remain missing with their recorded reasons. Objects touching the crop border remain flagged.</p>
      <div className="morphometrics-actions"><button onClick={() => onExplore(result)}>Plot and inspect objects</button><button onClick={() => onReview(result)}>Review & export</button></div>
      <details><summary>Measurement definitions</summary><dl>{Object.entries(record.rules).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{value}</dd></div>)}</dl></details>
    </section>;
  } catch (error) { return <p role="alert">{sanitizeRendererError(error instanceof Error ? error.message : "Invalid shape measurement record.")}</p>; }
}

export function ResearchMorphometricsPanel({ api, snapshot, source, selectedResult, active, busy, workingBytes, onBusyChange, onPublished, onExplore, onReview }: {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; source: ResearchSource; selectedResult: ResearchResult | null;
  active: boolean; busy: boolean; workingBytes: number; onBusyChange: (value: boolean) => void;
  onPublished: (result: ResearchResult) => Promise<void>; onExplore: (result: ResearchResult) => void; onReview: (result: ResearchResult) => void;
}) {
  const candidates = snapshot.results.filter((r) => r.source_id === source.id && r.source_sha256 === source.sha256 && PARENTS.has(r.kind) &&
    r.schema === "loci.research-result/v1" && ["YX", "ZYX"].includes(r.geometry?.axes ?? "") &&
    Object.keys(r.arrays ?? {}).sort().join(",") === "image,labels" && isSha(r.arrays?.labels?.sha256) && isSha(r.arrays?.image?.sha256));
  const [chosen, setChosen] = useState(""); const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const parent = candidates.find((r) => `${r.id}:${r.revision_hash}` === chosen);
  const identity = JSON.stringify([snapshot.project.project_id, source.id, source.sha256, candidates.map((r) => [r.id, r.revision_hash]), chosen]);
  const current = useRef({ identity, active, api }); current.current = { identity, active, api };
  const mounted = useRef(true); const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run() {
    if (!parent || busy || running.current || !active) return;
    const started = identity, usedApi = api;
    const live = () => mounted.current && current.current.active && current.current.identity === started && current.current.api === usedApi;
    running.current = true; setPending(true); setError(""); onBusyChange(true);
    try {
      const response = await usedApi.execute("morphometrics_run", { result_id: parent.id, revision_hash: parent.revision_hash, working_bytes: workingBytes }) as { result: ResearchResult; morphometrics: unknown; job: ResearchJob };
      if (!live()) return;
      const result = response.result, job = response.job;
      if (!result || !isId(result.id) || !isSha(result.revision_hash) || result.id === parent.id || result.kind !== "morphometrics" ||
          result.parent_id !== parent.id || result.source_id !== source.id || result.source_sha256 !== source.sha256 ||
          result.arrays?.image?.sha256 !== parent.arrays?.image?.sha256 || result.arrays?.labels?.sha256 !== parent.arrays?.labels?.sha256 ||
          !job || !isId(job.id) || job.operation !== "morphometrics_run" || job.state !== "succeeded" || job.owner ||
          !Array.isArray(job.result_ids) || job.result_ids.length !== 1 || job.result_ids[0] !== result.id)
        throw new Error("Shape measurements did not return the exact completed native job and input revision. Inspect Jobs before retrying.");
      const record = checkedRecord(result.morphometrics, result);
      if (record.input.result_id !== parent.id || record.input.revision_hash !== parent.revision_hash ||
          record.input.image_sha256 !== parent.arrays?.image?.sha256 || record.input.labels_sha256 !== parent.arrays?.labels?.sha256)
        throw new Error("Shape measurements refer to different source arrays. Reload the exact input revision.");
      await onPublished(result);
    } catch (e) { if (live()) setError(sanitizeRendererError(e instanceof Error ? e.message : "Shape measurement failed.")); }
    finally { running.current = false; if (mounted.current) setPending(false); onBusyChange(false); }
  }
  const saved = selectedResult?.kind === "morphometrics" && selectedResult.source_id === source.id && selectedResult.source_sha256 === source.sha256 ? selectedResult : null;
  return <section className="research-morphometrics" aria-label="Nuclear and cell shape">
    <h2>Nuclear & cell shape</h2>
    <p>Add shape measurements to a saved 2D or 3D label mask. Original labels and raw intensity measurements are retained.</p>
    <label>Label result<select aria-label="Shape label result" value={parent ? chosen : ""} disabled={busy || pending || !active} onChange={(e) => { setChosen(e.target.value); setError(""); }}>
      <option value="">Choose a saved label mask…</option>{candidates.map((r, i) => <option key={r.id} value={`${r.id}:${r.revision_hash}`}>{resultTitle(r)} · Run {i + 1} · {r.geometry?.axes === "ZYX" ? "3D" : "2D"} · {r.revision_hash.slice(0, 8)}</option>)}
    </select></label>
    {!candidates.length && <p>Create or import an object-label result on this image first. Correct its masks before measuring shape.</p>}
    {parent && <p>{parent.object_count} {parent.object_count === 1 ? "object" : "objects"} · {parent.geometry?.unit === "pixel" ? "uncalibrated pixels" : `declared calibration in ${parent.geometry?.unit}`}</p>}
    <p>Boundaries follow the full pixel or voxel edges, including holes. These are digital shape descriptors; smooth-contour estimates can differ.</p>
    <button className="primary" disabled={!parent || busy || pending || !active} onClick={() => void run()}>{pending ? "Measuring shape…" : "Measure object shape"}</button>
    {error && <p role="alert">{error}</p>}
    {saved && <MorphometricsSummary result={saved} onExplore={onExplore} onReview={onReview} />}
  </section>;
}
