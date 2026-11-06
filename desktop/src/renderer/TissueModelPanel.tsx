import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchJob, ResearchResult, ResearchSelection, ResearchSnapshot, ResearchSource,
  ResearchTissueImportPhase, ResearchTissueProfiles } from "../shared/research-contracts";
import { sanitizeRendererError } from "./ContextHelp";
import "./TissueModelPanel.css";

const PROFILE_ID = "puma-tissue-cpu" as const;
const SHA = /^[a-f0-9]{64}$/u;
const ID = /^[a-f0-9]{32}$/u;
const MAX_IMAGE_BYTES = 20 * 1024 ** 2;
const GiB = 1024 ** 3;
type ProfileEntry = ResearchTissueProfiles["profiles"][number];
type LoadedProfile = ProfileEntry & { runtimeHash: string };
type TissueRequest = {
  source_id: string; source_sha256: string; series: number;
  context_selection: ResearchSelection; output_selection: ResearchSelection;
  profile_id: typeof PROFILE_ID; profile_contract_sha256: string; runtime_contract_sha256: string;
  weights_sha256: string; rgb_policy: "puma-first-three-samples";
  declared_stain: "hematoxylin-eosin"; working_bytes: number;
};
type TissuePreview = {
  preview_id: string; preview_hash: string; adopted: false; region_count: number;
  selected_class: 4; entity_type: "tissue-region"; output_selection: ResearchSelection;
  context_selection: ResearchSelection; overlay_png: string; scientific_review: "pending"; job: ResearchJob;
};
type Setup = { epoch: number; profileId: typeof PROFILE_ID; sourceKey: string; api: ResearchDesktopApi;
  phase: ResearchTissueImportPhase["phase"]; cancelPending: boolean; timer?: ReturnType<typeof setInterval> };
type InspectionMode = "compartments" | "tissue_classes" | "score";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${canonical(key)}:${canonical(child)}`).join(",")}}`;
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Invalid tissue-model metadata.");
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
const equal = (a: unknown, b: unknown) => { try { return canonical(a) === canonical(b); } catch { return false; } };
const sha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const png = (value: unknown): value is string => typeof value === "string" && value.startsWith("data:image/png;base64,") && value.length <= MAX_IMAGE_BYTES;
const errorText = (error: unknown, fallback: string) => sanitizeRendererError(error instanceof Error ? error.message : fallback);

async function checkedProfile(value: unknown, profileId: typeof PROFILE_ID): Promise<LoadedProfile> {
  const response = value as ResearchTissueProfiles | null;
  const entries = response?.profiles;
  if (!Array.isArray(entries) || entries.length !== 1) throw new Error("The tissue-model catalogue is unavailable. Refresh model status.");
  const entry = entries[0];
  if (!entry || typeof entry !== "object") throw new Error("The tissue-model catalogue is unavailable. Refresh model status.");
  const { profile: p, store: s, runtime: r } = entry;
  if (!p || p.schema !== "loci.tissue-model-profile/v1" || p.id !== profileId || !sha(p.contract_sha256) ||
      !sha(p.model?.sha256) || !sha(p.model?.conversion_receipt_sha256) || !integer(p.model?.bytes, 1, 256 * 1024 ** 2) ||
      p.input?.rgb_policy !== "puma-first-three-samples" || p.input.maximum_context_edge !== 1024 ||
      p.resources?.minimum_working_bytes !== 2 * GiB || p.resources.maximum_working_bytes !== 8 * GiB ||
      p.selected_compartment?.class_id !== 4 || p.selected_compartment.name !== "epidermis" ||
      !p.runtime || typeof p.runtime !== "object" || Array.isArray(p.runtime) ||
      !s || s.schema !== "loci.puma-store-status/v1" || s.profile_id !== p.id || s.profile_contract_sha256 !== p.contract_sha256 ||
      s.weights_sha256 !== p.model.sha256 || s.weights_bytes !== p.model.bytes || s.conversion_receipt_sha256 !== p.model.conversion_receipt_sha256 ||
      !["missing", "invalid", "verified", "provisioned-unverified"].includes(s.state) ||
      s.provisioned !== ["verified", "provisioned-unverified"].includes(s.state) || s.files_verified !== (s.state === "verified") ||
      s.runtime_compatibility !== "not-established" || s.scientific_qualification !== "not-established" ||
      s.model_execution_performed !== false || s.execution_authority !== false ||
      !r || !["missing", "mismatch", "metadata-matches-unverified"].includes(r.status) ||
      r.runtime_import_verified !== false || r.technical_compatibility_verified !== false ||
      !Array.isArray(r.missing) || !Array.isArray(r.mismatched))
    throw new Error("The tissue-model profile or status has an inconsistent identity. Refresh model status.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(p.runtime)));
  return { ...entry, runtimeHash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
}

function sourceProblem(source: ResearchSource, selection: ResearchSelection): string | null {
  const d = source.metadata.dimensions;
  if (source.source_kind !== "native" || !["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "") ||
      d?.c !== 1 || d.s !== (source.metadata.sample_semantics === "RGBA" ? 4 : 3) ||
      !equal(source.metadata.channel_dtypes, ["uint8"]))
    return "Choose a native 8-bit RGB or RGBA histology image. Scalar channels and palette indices are not supported.";
  if (!integer(source.metadata.selected_series, 0, 65535)) return "The native image series is unavailable. Reopen the source before model use.";
  if (!integer(d.x, 1, 1024) || !integer(d.y, 1, 1024))
    return "This candidate requires a complete native image of at most 1024 × 1024 pixels. A viewport crop does not replace the normalization context.";
  if (selection.level !== 0 || selection.c !== 0 || selection.z_stop !== undefined)
    return "Choose one native level-0 RGB plane to preview epidermis.";
  if (!integer(selection.x, 0, d.x - 1) || !integer(selection.y, 0, d.y - 1) ||
      !integer(selection.width, 1, d.x - selection.x) || !integer(selection.height, 1, d.y - selection.y) ||
      !integer(selection.z, 0, d.z - 1) || !integer(selection.t, 0, d.t - 1))
    return "The output region is outside this exact source plane. Choose a current native region.";
  return null;
}

function checkedJob(job: ResearchJob | undefined, operation: string, sourceId: string, request: unknown, resultIds: string[]) {
  if (!job || !id(job.id) || job.operation !== operation || job.state !== "succeeded" || job.cancel_requested !== false || job.owner ||
      !equal(job.result_ids, resultIds) || !equal(job.request, { source_id: sourceId, task_request: request }))
    throw new Error("The tissue operation did not return its exact completed native job. Inspect Jobs before retrying.");
}
function checkedPreview(value: unknown, request: TissueRequest): TissuePreview {
  const p = value as TissuePreview | null;
  if (!p || !id(p.preview_id) || !sha(p.preview_hash) || p.adopted !== false || !integer(p.region_count, 0, 4096) ||
      p.selected_class !== 4 || p.entity_type !== "tissue-region" || p.scientific_review !== "pending" || !png(p.overlay_png) ||
      !equal(p.context_selection, request.context_selection) || !equal(p.output_selection, request.output_selection))
    throw new Error("The tissue preview does not match this exact source region. Preview again.");
  checkedJob(p.job, "tissue_model_preview", request.source_id, request, []);
  return p;
}
function tissueResult(result: ResearchResult | null, source: ResearchSource): result is ResearchResult {
  return Boolean(result && result.source_id === source.id && result.source_sha256 === source.sha256 &&
    id(result.id) && sha(result.revision_hash) && result.tissue_model?.schema === "loci.puma-tissue-result/v1" &&
    ["original_selected_compartment", "edited_selected_compartment"].includes(result.tissue_model.label_semantics));
}

export function TissueModelPanel({ api, snapshot, source, selection, selectedResult, active, busy,
  onBusyChange, onPublished, onInspect, onCorrect, onReview, profileId = PROFILE_ID }: {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; source: ResearchSource; selection: ResearchSelection;
  selectedResult: ResearchResult | null; active: boolean; busy: boolean; profileId?: typeof PROFILE_ID;
  onBusyChange: (value: boolean) => void; onPublished: (result: ResearchResult) => Promise<void>;
  onInspect: (result: ResearchResult) => void; onCorrect: (result: ResearchResult) => void; onReview: (result: ResearchResult) => void;
}) {
  const [profile, setProfile] = useState<LoadedProfile | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [workingBytes, setWorkingBytes] = useState(2 * GiB);
  const sourceKey = JSON.stringify([snapshot.project.project_id, source.id, source.sha256]);
  const [declaration, setDeclaration] = useState<{ sourceKey: string; stain: string } | null>(null);
  const stain = declaration?.sourceKey === sourceKey ? declaration.stain : "";
  const [pending, setPending] = useState<"preview" | "run" | null>(null);
  const [retained, setRetained] = useState<{ identity: string; preview: TissuePreview } | null>(null);
  const [setupPhase, setSetupPhase] = useState<ResearchTissueImportPhase["phase"]>("idle");
  const [setupMessage, setSetupMessage] = useState("");
  const [cancelPending, setCancelPending] = useState(false);
  const setup = useRef<Setup | null>(null), setupEpoch = useRef(0), operation = useRef(false), refreshEpoch = useRef(0);
  const mounted = useRef(true);
  const problem = sourceProblem(source, selection);
  const d = source.metadata.dimensions;
  const request: TissueRequest | null = profile && !problem && d && stain === "hematoxylin-eosin" ? {
    source_id: source.id, source_sha256: source.sha256, series: source.metadata.selected_series!,
    context_selection: { x: 0, y: 0, width: d.x, height: d.y, c: 0, z: selection.z, t: selection.t, level: 0 },
    output_selection: { x: selection.x, y: selection.y, width: selection.width, height: selection.height,
      c: selection.c, z: selection.z, t: selection.t, level: selection.level },
    profile_id: profileId, profile_contract_sha256: profile.profile.contract_sha256, runtime_contract_sha256: profile.runtimeHash,
    weights_sha256: profile.profile.model.sha256, rgb_policy: "puma-first-three-samples",
    declared_stain: "hematoxylin-eosin", working_bytes: workingBytes,
  } : null;
  const identity = JSON.stringify([sourceKey, source.metadata, request, profile?.runtime, profile?.store.state]);
  const current = useRef({ identity, sourceKey, profileId, active, api }); current.current = { identity, sourceKey, profileId, active, api };
  const currentPreview = retained?.identity === identity && active ? retained.preview : null;
  const canExecute = Boolean(profile?.store.provisioned && profile.runtime.status === "metadata-matches-unverified");
  const setupActive = setupPhase !== "idle";
  const disabled = busy || pending !== null || setupActive || !active;
  const saved = tissueResult(selectedResult, source) ? selectedResult : null;
  const [inspectionMode, setInspectionMode] = useState<InspectionMode>("compartments");
  const [inspection, setInspection] = useState<{ key: string; image: string; basis: string } | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const inspectionEpoch = useRef(0);
  const inspectionKey = JSON.stringify([sourceKey, saved?.id, saved?.revision_hash, inspectionMode]);
  const inspectionCurrent = useRef({ key: inspectionKey, active, api }); inspectionCurrent.current = { key: inspectionKey, active, api };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setRetained(null); }, [identity, active]);
  useEffect(() => { setError(""); }, [sourceKey, active]);
  const isCurrentSetup = (value: Setup) => mounted.current && setup.current === value && value.epoch === setupEpoch.current &&
    current.current.active && value.sourceKey === current.current.sourceKey && value.profileId === current.current.profileId && value.api === current.current.api;
  useEffect(() => () => {
    const value = setup.current;
    if (value?.timer) clearInterval(value.timer);
    if (value && value.phase !== "importing") void value.api.cancelTissueModelImport?.(value.profileId).catch(() => undefined);
    setupEpoch.current += 1; setup.current = null;
  }, [sourceKey, profileId, active, api]);

  async function refresh() {
    const epoch = ++refreshEpoch.current, usedApi = api, usedProfile = profileId;
    setLoading(true); setError("");
    try {
      const next = await checkedProfile(await usedApi.execute("tissue_model_profiles", {}), usedProfile);
      if (mounted.current && epoch === refreshEpoch.current && current.current.api === usedApi && current.current.profileId === usedProfile) setProfile(next);
    } catch (caught) {
      if (mounted.current && epoch === refreshEpoch.current) { setProfile(null); setError(errorText(caught, "Model status could not be read.")); }
    } finally { if (mounted.current && epoch === refreshEpoch.current) setLoading(false); }
  }
  useEffect(() => { if (active) void refresh(); return () => { refreshEpoch.current += 1; }; }, [active, api, profileId]);

  async function importFiles() {
    if (!api.importTissueModel || disabled || setup.current || operation.current) return;
    const value: Setup = { epoch: ++setupEpoch.current, profileId, sourceKey, api, phase: "choosing-weights", cancelPending: false };
    setup.current = value; setSetupPhase(value.phase); setSetupMessage(""); setCancelPending(false); setError(""); setRetained(null);
    onBusyChange(true);
    const poll = () => {
      if (!value.api.getTissueModelImportStatus || !isCurrentSetup(value)) return;
      void value.api.getTissueModelImportStatus(value.profileId).then(next => {
        if (!isCurrentSetup(value) || next.profile_id !== value.profileId || next.phase === "idle") return;
        value.phase = next.phase; setSetupPhase(next.phase);
        if (next.phase === "importing") setSetupMessage("Importing exact files. Local import must finish before it can be closed.");
      }).catch(() => { /* The awaited setup reports its own terminal error. */ });
    };
    value.timer = setInterval(poll, 250);
    try {
      const response = await value.api.importTissueModel!(value.profileId);
      if (!isCurrentSetup(value) || !response) return;
      const next = await checkedProfile(response, value.profileId);
      if (isCurrentSetup(value)) setProfile(next);
    } catch (caught) { if (isCurrentSetup(value)) setError(errorText(caught, "Tissue model import failed.")); }
    finally {
      if (value.timer) clearInterval(value.timer);
      if (setup.current === value) {
        setup.current = null;
        if (mounted.current) { setSetupPhase("idle"); setSetupMessage(""); setCancelPending(false); }
      } else if (mounted.current && !setup.current) { setSetupPhase("idle"); setSetupMessage(""); setCancelPending(false); }
      onBusyChange(false);
    }
  }
  async function cancelSetup() {
    const value = setup.current;
    if (!value || !isCurrentSetup(value) || value.phase === "importing" || value.cancelPending || !value.api.cancelTissueModelImport) return;
    value.cancelPending = true; setCancelPending(true);
    try {
      const response = await value.api.cancelTissueModelImport(value.profileId);
      if (!isCurrentSetup(value)) return;
      if (response.phase === "importing") { value.phase = "importing"; setSetupPhase("importing"); }
      setSetupMessage(response.cancelled ? "Selection cancelled. Close any remaining file dialog." : "Import is finishing; cancellation is unavailable.");
    } catch (caught) {
      if (isCurrentSetup(value)) { value.cancelPending = false; setCancelPending(false); setError(errorText(caught, "Selection cancellation failed.")); }
    }
  }
  async function execute(kind: "preview" | "run") {
    if (!request || !canExecute || disabled || operation.current || (kind === "run" && !currentPreview)) return;
    const started = identity, usedApi = api, accepted = structuredClone(request);
    const token = currentPreview ? { preview_id: currentPreview.preview_id, preview_hash: currentPreview.preview_hash } : null;
    const live = () => mounted.current && current.current.active && current.current.identity === started && current.current.api === usedApi;
    operation.current = true; setPending(kind); setError(""); if (kind === "preview") setRetained(null); onBusyChange(true);
    try {
      if (kind === "preview") {
        const output = await usedApi.execute("tissue_model_preview", accepted);
        if (!live()) return;
        setRetained({ identity: started, preview: checkedPreview(output, accepted) });
      } else {
        const response = await usedApi.execute("tissue_model_run", token!) as { adopted: boolean; result: ResearchResult; region_count: number; job: ResearchJob };
        if (!live()) return;
        const result = response.result;
        if (response.adopted !== true || !tissueResult(result, source) || result.kind !== "tissue-model-regions" || result.parent_id ||
            result.tissue_model!.label_semantics !== "original_selected_compartment" || !equal(result.tissue_model!.preview, token) ||
            !equal(result.selection, accepted.output_selection) || !integer(result.object_count, 0, 4096) || result.object_count !== response.region_count || response.region_count !== currentPreview!.region_count ||
            ["class_labels", "probabilities", "image", "labels"].some(name => !sha(result.arrays?.[name]?.sha256)) ||
            result.arrays?.class_labels?.dtype !== "uint8" || result.arrays?.probabilities?.dtype !== "float32" ||
            result.arrays?.image?.dtype !== "float32" || result.arrays?.labels?.dtype !== "uint32" ||
            !equal(result.arrays?.image?.shape, [accepted.output_selection.height, accepted.output_selection.width]) ||
            !equal(result.arrays?.labels?.shape, [accepted.output_selection.height, accepted.output_selection.width]) ||
            !equal(result.arrays?.class_labels?.shape, [accepted.output_selection.height, accepted.output_selection.width]) ||
            !equal(result.arrays?.probabilities?.shape, [6, accepted.output_selection.height, accepted.output_selection.width]))
          throw new Error("The saved tissue result does not match the exact preview. Inspect Jobs before retrying.");
        checkedJob(response.job, "tissue_model_run", accepted.source_id, token, [result.id]);
        setRetained(null);
        await onPublished(result);
      }
    } catch (caught) { if (live()) setError(errorText(caught, "Tissue model operation failed.")); }
    finally { operation.current = false; if (mounted.current) setPending(null); onBusyChange(false); }
  }
  async function inspect() {
    if (!saved || disabled || inspecting) return;
    const expected = saved, key = inspectionKey, mode = inspectionMode, usedApi = api, epoch = ++inspectionEpoch.current;
    const field = mode === "tissue_classes" ? "tissue_classes" : "compartments";
    setInspecting(true); setInspection(null); setError("");
    try {
      const output = await usedApi.execute("result_view", { result_id: expected.id, axis: "z", index: 0, labels: mode !== "score", label_field: field }) as {
        result_id: string; revision_hash: string; axis: string; index: number; image: string; label_field: string; label_field_basis: string; shape: number[];
      };
      if (!mounted.current || epoch !== inspectionEpoch.current || !inspectionCurrent.current.active || inspectionCurrent.current.key !== key || inspectionCurrent.current.api !== usedApi) return;
      if (output.result_id !== expected.id || output.revision_hash !== expected.revision_hash || output.axis !== "z" || output.index !== 0 ||
          output.label_field !== field || typeof output.label_field_basis !== "string" || !png(output.image) || !equal(output.shape, expected.arrays?.image?.shape))
        throw new Error("The displayed tissue field does not match this exact saved revision.");
      setInspection({ key, image: output.image, basis: output.label_field_basis });
    } catch (caught) { if (mounted.current && inspectionCurrent.current.key === key) setError(errorText(caught, "Saved tissue field could not be displayed.")); }
    finally { if (mounted.current && epoch === inspectionEpoch.current) setInspecting(false); }
  }

  const storeText = !profile ? "Model status unavailable" : profile.store.state === "missing" ? "Exact model files not imported"
    : profile.store.state === "invalid" ? "Managed files need inspection" : profile.store.files_verified ? "Exact file identities verified" : "Model files present; verification repeats before execution";
  const runtimeText = profile?.runtime.status === "missing" ? "The separately installed runtime is missing."
    : profile?.runtime.status === "mismatch" ? "The installed runtime does not match this profile."
      : "Runtime package metadata matches; compatibility and accuracy remain unqualified.";
  const modeTitle = inspectionMode === "tissue_classes" ? "Original tissue classes" : inspectionMode === "score" ? "Original epidermis score"
    : saved?.tissue_model?.label_semantics === "edited_selected_compartment" ? "Edited compartment regions" : "Original epidermis regions";
  return <section className="tissue-model-panel" aria-label="Epidermis tissue model">
    <h2>Epidermis tissue model</h2>
    <p>Preview a candidate epidermis mask on declared H&amp;E histology, then inspect and correct its tissue regions.</p>
    <section className="tissue-model-setup" aria-label="PUMA model setup">
      <h3>PUMA · research candidate</h3>
      <p role="status">{loading && !profile ? "Checking local model files…" : storeText}</p>
      {profile && <p>{runtimeText}</p>}
      <div className="tissue-model-actions">
        <button type="button" disabled={disabled || loading || !api.importTissueModel} onClick={() => void importFiles()}>{setupActive ? setupPhase === "importing" ? "Importing exact files…" : "Choosing model files…" : "Import weights & receipt…"}</button>
        <button type="button" disabled={disabled || loading} onClick={() => void refresh()}>Refresh model status</button>
        {setupActive && <button type="button" disabled={setupPhase === "importing" || cancelPending || !api.cancelTissueModelImport} onClick={() => void cancelSetup()}>Cancel selection</button>}
      </div>
      {setupMessage && <p role="status">{setupMessage}</p>}
      <p className="tissue-model-note">Import the converted network weights and their exact conversion receipt. Import does not install a runtime or establish scientific validation.</p>
      {profile && <details><summary>Model identity &amp; limits</summary><dl className="research-kv">
        <dt>Weights SHA-256</dt><dd>{profile.profile.model.sha256}</dd>
        <dt>Conversion receipt SHA-256</dt><dd>{profile.profile.model.conversion_receipt_sha256}</dd>
        <dt>Model files</dt><dd>{profile.profile.model.bytes.toLocaleString()} bytes of weights</dd>
        <dt>Runtime</dt><dd>{Object.entries(profile.runtime.expected).map(([name, version]) => `${name} ${version}`).join(" · ")}</dd>
      </dl><p>Six tissue classes are retained. Class 4 identifies the model’s epidermis category; it does not define a basal boundary or a dermal compartment. Scores are not validated confidence estimates.</p>
        <p>Original model predictions remain separate from later compartment edits. Model weights do not supply source calibration.</p></details>}
    </section>
    <div className="tissue-model-input">
      <label>Declared preparation<select aria-label="Tissue preparation" value={stain} disabled={disabled} onChange={event => setDeclaration({ sourceKey, stain: event.target.value })}>
        <option value="">Choose the known preparation…</option><option value="hematoxylin-eosin">Hematoxylin &amp; eosin (H&amp;E)</option>
      </select></label>
      <p className="tissue-model-note">Declare preparation from acquisition records. RGB components do not identify stains.</p>
      {problem ? <p role="note">{problem}</p> : <dl className="tissue-model-scope">
        <dt>Normalization context</dt><dd>Full native image · {d?.x} × {d?.y} pixels</dd>
        <dt>Output region</dt><dd>{selection.width} × {selection.height} pixels at x {selection.x}, y {selection.y}</dd>
        <dt>Plane</dt><dd>Z {selection.z + 1} · T {selection.t + 1}</dd>
      </dl>}
      {source.metadata.sample_semantics === "RGBA" && <p className="tissue-model-note">The first three samples are used as RGB. Alpha is discarded without compositing.</p>}
      <label>Memory allowance<select aria-label="Tissue model memory allowance" value={workingBytes} disabled={disabled} onChange={event => setWorkingBytes(Number(event.target.value))}>
        {[2, 4, 8].map(size => <option key={size} value={size * GiB}>{size} GiB</option>)}
      </select></label>
      <p className="tissue-model-note">Local CPU execution uses the complete image for normalization. Selecting an output region does not change that context.</p>
    </div>
    <div className="tissue-model-actions">
      <button type="button" className="research-primary" disabled={disabled || !request || !canExecute} onClick={() => void execute("preview")}>{pending === "preview" ? "Computing preview…" : "Preview candidate mask"}</button>
      <button type="button" disabled={disabled || !currentPreview || !canExecute} onClick={() => void execute("run")}>{pending === "run" ? "Creating tissue result…" : "Create result from preview"}</button>
    </div>
    {!stain && !problem && <p className="tissue-model-note">Choose the known preparation before previewing.</p>}
    {currentPreview && <figure className="tissue-model-preview"><img src={currentPreview.overlay_png} alt="Exact source-region preview with candidate epidermis overlay" />
      <figcaption>{currentPreview.region_count} tissue {currentPreview.region_count === 1 ? "region" : "regions"} · preview only. Creating a result repeats inference and must reproduce this exact preview.</figcaption></figure>}
    {error && <p role="alert">{error}</p>}
    {saved && <section className="tissue-model-saved" aria-label="Saved tissue result">
      <h3>{saved.tissue_model?.label_semantics === "edited_selected_compartment" ? "Edited tissue compartment" : "Saved epidermis candidate"}</h3>
      <p>{saved.object_count} tissue {saved.object_count === 1 ? "region" : "regions"} · revision {saved.revision_hash.slice(0, 8)}</p>
      <label>Inspect retained field<select aria-label="Tissue result field" value={inspectionMode} disabled={disabled || inspecting} onChange={event => setInspectionMode(event.target.value as InspectionMode)}>
        <option value="compartments">{saved.tissue_model?.label_semantics === "edited_selected_compartment" ? "Edited compartment regions" : "Original epidermis regions"}</option>
        <option value="tissue_classes">Original tissue classes</option><option value="score">Original epidermis score</option>
      </select></label>
      <div className="tissue-model-actions"><button type="button" disabled={disabled || inspecting} onClick={() => void inspect()}>{inspecting ? "Loading exact field…" : "Inspect saved field"}</button>
        <button type="button" disabled={disabled} onClick={() => onInspect(saved)}>Open result in workbench</button></div>
      {inspection?.key === inspectionKey && <figure className="tissue-model-preview"><img src={inspection.image} alt={modeTitle} /><figcaption>{modeTitle} · display only. {inspectionMode === "score" ? "Retained model score; not validated confidence." : inspection.basis}</figcaption></figure>}
      <p className="tissue-model-note">Region edits change only the derived compartment labels. Original tissue classes and epidermis scores remain retained.</p>
      <div className="tissue-model-actions"><button type="button" disabled={disabled} onClick={() => onCorrect(saved)}>Correct compartment regions</button><button type="button" disabled={disabled} onClick={() => onReview(saved)}>Review &amp; export</button></div>
    </section>}
  </section>;
}
