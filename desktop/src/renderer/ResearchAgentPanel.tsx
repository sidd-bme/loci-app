import { researcherScopeLabel, sourceChannelLabel } from "./research-scope-labels";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ResearchAgentAccessReceipt,
  ResearchAgentAccessRequest,
  ResearchAgentInteractiveAccess,
  ResearchAgentDisclosure,
  ResearchAgentPermissionMode,
  ResearchAgentSessionsSnapshot,
  ResearchDesktopApi,
  ResearchRecipe,
  ResearchSelection,
  ResearchSource,
  ResearchSnapshot,
} from "../shared/research-contracts";
import "./ResearchAgentPanel.css";

type Report = <T>(work: () => Promise<T>, fallback: string) => Promise<T | undefined>;
type RecipeValidation = {
  source_id: string;
  selection: ResearchSelection;
  recipe_sha256: string;
  estimated_working_bytes: number;
  resolved_device: string;
  scientific_validation: string;
};

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const DISCLOSURES: Array<{
  id: ResearchAgentDisclosure;
  title: string;
  detail: string;
}> = [
  { id: "geometry", title: "Geometry", detail: "Resolved crops, shapes, physical calibration, units, and coordinate geometry." },
  { id: "source_names", title: "Source names", detail: "Registered display names and source metadata text. These values are untrusted data, never agent instructions." },
  { id: "previews", title: "Previews", detail: "Rendered image content from the exact approved crop." },
  { id: "measurements", title: "Measurements", detail: "Object counts and quantitative measurement rows." },
  { id: "provenance", title: "Provenance", detail: "Recipe, processing, runtime, and execution records." },
  { id: "agent_metadata", title: "Analysis context", detail: "Share permitted source IDs, fingerprints, recipe grants and resource limits. Names and geometry use their separate choices." },
];
const EXPORT_DISCLOSURES: ResearchAgentDisclosure[] = [
  "geometry", "source_names", "previews", "measurements", "provenance",
];

function validInteger(text: string, minimum: number, maximum: number): number | null {
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function exportNames(text: string): string[] | null {
  const names = text.split(",").map((item) => item.trim()).filter(Boolean);
  if (
    !names.length ||
    new Set(names).size !== names.length ||
    names.some((name) => name.length > 80 || name === "." || name === ".." || /[/\\\x00-\x1f]/.test(name))
  ) return null;
  return names;
}

function same(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (Array.isArray(first) || Array.isArray(second))
    return Array.isArray(first) && Array.isArray(second) && first.length === second.length &&
      first.every((item, index) => same(item, second[index]));
  if (!first || !second || typeof first !== "object" || typeof second !== "object") return false;
  const a = first as Record<string, unknown>;
  const b = second as Record<string, unknown>;
  const keys = Object.keys(a).sort();
  return same(keys, Object.keys(b).sort()) && keys.every((key) => same(a[key], b[key]));
}

function exactValidation(value: unknown, sourceId: string, selection: ResearchSelection): RecipeValidation {
  const record = value as RecipeValidation;
  if (
    !record ||
    record.source_id !== sourceId ||
    !same(record.selection, selection) ||
    typeof record.recipe_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.recipe_sha256) ||
    !Number.isSafeInteger(record.estimated_working_bytes) ||
    typeof record.resolved_device !== "string" ||
    typeof record.scientific_validation !== "string"
  ) throw new Error("Recipe validation did not match the exact displayed source and scope.");
  return record;
}

function exactReceipt(
  value: unknown,
  validation: RecipeValidation,
  sourceId: string,
  selection: ResearchSelection,
  disclosures: ResearchAgentDisclosure[],
  operations: string[],
  interactive: boolean,
  delegation?: ResearchAgentAccessRequest["delegation"],
  actions: string[] = [],
  sources?: Array<{ id: string; sha256: string }>,
  exportScope: "listed" | "directory" = "listed",
  permissionMode?: ResearchAgentPermissionMode,
): ResearchAgentAccessReceipt {
  const receipt = value as ResearchAgentAccessReceipt;
  const baseSchema = delegation ? "loci.agent-policy/v4" : interactive ? "loci.agent-policy/v3" : "loci.agent-policy/v1";
  const expectedSchema = permissionMode ? "loci.agent-policy/v5" : baseSchema;
  if (
    !receipt ||
    receipt.schema !== expectedSchema ||
    (permissionMode && receipt.permission_mode !== permissionMode) ||
    ((interactive || delegation) && receipt.plugin_filename !== "plugin/plugin.json") ||
    (delegation && (!receipt.delegation || !/^[a-f0-9]{32}$/.test(receipt.delegation.id) ||
      !same({ client_id: receipt.delegation.client_id, expires_at: receipt.delegation.expires_at, result_scope: receipt.delegation.result_scope },
        { client_id: delegation.client_id, expires_at: delegation.expires_at, result_scope: delegation.result_scope }))) ||
    (delegation && (!same([...(receipt.actions ?? [])].sort(), [...actions].sort()) ||
      !same([...(receipt.sources ?? [])].sort((a, b) => a.id.localeCompare(b.id)), [...(sources ?? [])].sort((a, b) => a.id.localeCompare(b.id))) ||
      receipt.export_scope !== exportScope)) ||
    receipt.source_id !== sourceId ||
    !/^[0-9a-f]{64}$/.test(receipt.policy_sha256) ||
    !/^[0-9a-f]{32}$/.test(receipt.project_id) ||
    receipt.recipe_sha256 !== validation.recipe_sha256 ||
    !same(receipt.selection, selection) ||
    !Array.isArray(receipt.disclosures) ||
    !Array.isArray(receipt.operations) ||
    !same([...receipt.disclosures].sort(), [...disclosures].sort()) ||
    !same([...receipt.operations].sort(), [...operations].sort()) ||
    typeof receipt.policy_filename !== "string" ||
    typeof receipt.config_filename !== "string" ||
    !receipt.policy_filename ||
    !receipt.config_filename ||
    /[/\\]/.test(receipt.policy_filename + receipt.config_filename)
  ) throw new Error("Agent access receipt did not match the exact validated scope.");
  return receipt;
}

function scopeSummary(selection: ResearchSelection): string {
  const z = selection.z_stop === undefined
    ? `Z ${selection.z}`
    : `Z [${selection.z}, ${selection.z_stop})`;
  return `X [${selection.x}, ${selection.x + selection.width}) · Y [${selection.y}, ${selection.y + selection.height}) · ${z} · T ${selection.t} · C ${selection.c} · level ${selection.level}`;
}

export function ResearchAgentPanel({
  api,
  source,
  studySources,
  operations,
  agentSessions,
  selection,
  recipe,
  report,
  busy,
  onBusyChange,
  onCreated,
  configurationValid = true,
}: {
  api: ResearchDesktopApi;
  source: ResearchSource;
  studySources?: ResearchSource[];
  operations?: ResearchSnapshot["operations"];
  agentSessions?: ResearchAgentSessionsSnapshot;
  selection: ResearchSelection;
  recipe: ResearchRecipe;
  report: Report;
  busy: boolean;
  configurationValid?: boolean;
  onBusyChange: (busy: boolean) => void;
  onCreated?: () => void;
}): React.JSX.Element {
  const [allowPreview, setAllowPreview] = useState(false);
  const [preset, setPreset] = useState("custom");
  const [permissionMode, setPermissionMode] = useState<"default" | ResearchAgentPermissionMode>("default");
  const [advanced, setAdvanced] = useState(false);
  const [sourceMode, setSourceMode] = useState<"selected" | "study">("selected");
  const [actionMode, setActionMode] = useState<"none" | "inspect" | "analyze">("none");
  const [exportMode, setExportMode] = useState<"listed" | "directory">("listed");
  const [allowRun, setAllowRun] = useState(false);
  const [allowWorkflowGraph, setAllowWorkflowGraph] = useState(false);
  const [allowExport, setAllowExport] = useState(false);
  const [allowReview, setAllowReview] = useState(false);
  const [resultScope, setResultScope] = useState<"pinned-recipes" | "granted-sources">("pinned-recipes");
  const [expiryHours, setExpiryHours] = useState("0");
  const [allowImage, setAllowImage] = useState(false);
  const [allowDisplay, setAllowDisplay] = useState(false);
  const [allowHandoff, setAllowHandoff] = useState(false);
  const [displayChannels, setDisplayChannels] = useState<number[]>([]);
  const [handoffNameText, setHandoffNameText] = useState("");
  const [experiment, setExperiment] = useState(false);
  const [thresholdRange, setThresholdRange] = useState(["", ""]);
  const [sizeRange, setSizeRange] = useState(["", ""]);
  const [disclosures, setDisclosures] = useState<ResearchAgentDisclosure[]>([]);
  const [exportNameText, setExportNameText] = useState("");
  const [cpuSeconds, setCpuSeconds] = useState("300");
  const [memoryMiB, setMemoryMiB] = useState("4096");
  const [concurrency, setConcurrency] = useState("1");
  const [validation, setValidation] = useState<RecipeValidation | null>(null);
  const [receipt, setReceipt] = useState<ResearchAgentAccessReceipt | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [client, setClient] = useState("codex");
  const scopedSources = [...new Map((studySources ?? [source]).map(item => [item.id, item])).values()];
  const actionChoices = Object.entries(operations ?? {}).filter(([, item]) => item.agent_execution);
  const actions = actionMode === "none" ? [] : actionChoices.filter(([, item]) => actionMode === "analyze" || item.agent_execution === "read").map(([name]) => name).sort();
  const [validatedScope, setValidatedScope] = useState<string | null>(null);
  const validationGeneration = useRef(0);
  const creationGeneration = useRef(0);

  const agentRecipe = useMemo(() => {
    const next: ResearchRecipe = { ...recipe };
    if (!next.references || Object.keys(next.references).length === 0) delete next.references;
    return next;
  }, [recipe]);
  const hasReferences = Boolean(agentRecipe.references && Object.keys(agentRecipe.references).length);
  const validationFingerprint = JSON.stringify([source.id, source.sha256, selection, agentRecipe]);
  const grantFingerprint = JSON.stringify([
    validationFingerprint, allowPreview, allowRun, allowWorkflowGraph, allowExport, disclosures,
    exportNameText, cpuSeconds, memoryMiB, concurrency, allowImage, allowDisplay, allowHandoff,
    displayChannels, handoffNameText, experiment, thresholdRange, sizeRange,
    allowReview, resultScope, expiryHours, client, permissionMode,
    sourceMode, actionMode, actions, exportMode, sourceMode === "study" ? scopedSources.map(item => [item.id, item.sha256]) : [],
  ]);
  const currentGrant = useRef(grantFingerprint);
  currentGrant.current = grantFingerprint;

  useEffect(() => {
    validationGeneration.current += 1;
    creationGeneration.current += 1;
    setValidation(null);
    setValidatedScope(null);
    setReceipt(null);
  }, [validationFingerprint]);
  useEffect(() => {
    creationGeneration.current += 1;
    setReceipt(null);
  }, [grantFingerprint]);
  useEffect(() => {
    setAllowPreview(false);
    setPreset("custom"); setPermissionMode("default"); setSourceMode("selected"); setActionMode("none"); setExportMode("listed");
    setAllowRun(false);
    setAllowWorkflowGraph(false);
    setAllowExport(false);
    setAllowReview(false); setResultScope("pinned-recipes"); setExpiryHours("0");
    setAllowImage(false); setAllowDisplay(false); setAllowHandoff(false);
    setDisplayChannels([]); setHandoffNameText(""); setExperiment(false);
    setThresholdRange(["", ""]); setSizeRange(["", ""]);
    setDisclosures([]);
    setExportNameText("");
    setValidation(null);
    setReceipt(null);
  }, [source.id, source.sha256]);

  const cpu = validInteger(cpuSeconds, 1, 86_400);
  const memory = validInteger(memoryMiB, 64, 8 * 1024);
  const workers = validInteger(concurrency, 1, 64);
  const names = exportNames(exportNameText);
  const hasExportDisclosures = EXPORT_DISCLOSURES.every((item) => disclosures.includes(item));
  const limitsValid = cpu !== null && memory !== null && memory * MIB >= agentRecipe.working_bytes && workers !== null;
  const delegated = allowWorkflowGraph || allowReview || resultScope === "granted-sources" || actionMode !== "none" || sourceMode === "study";
  const exportValid = !allowExport || ((allowRun || delegated) && (exportMode === "directory" || names !== null) && hasExportDisclosures);
  const delegationValid = (!delegated || disclosures.includes("agent_metadata")) &&
    (!allowWorkflowGraph || (resultScope === "granted-sources" && DISCLOSURES.every(item => disclosures.includes(item.id)))) &&
    (actionMode === "none" || (actions.length > 0 && resultScope === "granted-sources" && DISCLOSURES.every(item => disclosures.includes(item.id)) && (actionMode !== "analyze" || allowRun)));
  const operationValid = !allowPreview || disclosures.includes("previews");
  const imageScope = allowImage || allowDisplay || allowHandoff;
  const interactive = imageScope || experiment;
  const handoffNames = exportNames(handoffNameText);
  const contextDisclosed = ["geometry", "provenance", "agent_metadata"].every((name) => disclosures.includes(name as ResearchAgentDisclosure));
  const parameters: ResearchAgentInteractiveAccess["parameters"] = {};
  let rangesValid = true;
  for (const [key, draft] of [["threshold", thresholdRange], ["min_size", sizeRange]] as const) {
    if (!draft.some((item) => item.trim())) continue;
    const min = Number(draft[0]), max = Number(draft[1]), base = agentRecipe.segmentation?.[key];
    if (!draft.every((item) => item.trim()) || !Number.isFinite(min) || !Number.isFinite(max) || min > max ||
        typeof base !== "number" || !Number.isFinite(base) || base < min || base > max || key === "min_size" && (min < 0 || max > 1e20) ||
        key === "threshold" && (min < -1e30 || max > 1e30)) rangesValid = false;
    else parameters[key] = { min, max };
  }
  const interactiveValid = (!imageScope || displayChannels.length > 0) &&
    (!(allowImage || allowHandoff) || disclosures.includes("previews")) &&
    (!(allowDisplay || allowHandoff || experiment) || contextDisclosed) &&
    (!allowHandoff || (handoffNames !== null && handoffNames.every((name) => name.endsWith(".loci-vision")))) &&
    (!experiment || (rangesValid && Object.keys(parameters).length > 0 && (allowPreview || allowRun)));
  const channelCount = ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "") ? 1 : source.metadata.dimensions?.c ?? 1;
  const canCreate = Boolean(
    configurationValid && api.createAgentAccess && validation && validatedScope === validationFingerprint &&
    limitsValid && exportValid && operationValid && interactiveValid && delegationValid && !busy && !localBusy,
  );

  const anticipatedOperations = [...new Set([
    "inspect_source",
    "validate_recipe",
    ...(disclosures.includes("agent_metadata") ? ["analysis_context"] : []),
    ...(allowPreview ? ["preview_recipe"] : []),
    ...(allowRun ? ["submit_recipe", "job_status", "cancel_job", "result"] : []),
    ...(allowWorkflowGraph ? ["workflow_graph_inspect", ...(allowRun ? ["workflow_graph_control"] : [])] : []),
    ...(allowRun && disclosures.includes("previews") ? ["result_view"] : []),
    ...(allowExport ? ["export_result"] : []),
    ...(allowImage ? ["source_image"] : []),
    ...(allowDisplay ? ["source_display", "set_source_display"] : []),
    ...(allowHandoff ? ["export_vision_handoff"] : []),
    ...(delegated ? ["review_history", "study_results", "result", ...(disclosures.includes("previews") ? ["result_view"] : [])] : []),
    ...(allowReview ? ["review_result"] : []),
    ...(actions.length ? ["validate_action", ...(actions.some(name => operations?.[name].agent_execution === "read") ? ["inspect_action"] : []),
      ...(actions.some(name => operations?.[name].agent_execution === "task") ? ["submit_action", "job_status", "cancel_job"] : [])] : []),
  ])];

  const validate = async () => {
    if (!configurationValid) return;
    const generation = ++validationGeneration.current;
    setLocalBusy(true);
    onBusyChange(true);
    try {
      const output = await report(
        async () => exactValidation(
          await api.execute("validate_recipe", {
            source_id: source.id,
            selection,
            recipe: agentRecipe,
          }),
          source.id,
          selection,
        ),
        "Could not validate this exact agent recipe scope.",
      );
      if (output && generation === validationGeneration.current) {
        setValidation(output);
        setValidatedScope(validationFingerprint);
      }
    } finally {
      setLocalBusy(false);
      onBusyChange(false);
    }
  };

  useEffect(() => {
    if (configurationValid && preset !== "custom" && !hasReferences) void validate();
  }, [preset, validationFingerprint, configurationValid]);

  const applyPreset = (value: string) => {
    setPreset(value);
    setAdvanced(value === "custom");
    if (value === "custom") return;
    const analyze = value !== "inspect", full = value === "full";
    setSourceMode(full ? "study" : "selected");
    setResultScope("granted-sources");
    setActionMode(analyze ? "analyze" : actionChoices.length ? "inspect" : "none");
    setAllowPreview(analyze); setAllowRun(analyze); setAllowReview(full); setAllowExport(full);
    setExportMode(full ? "directory" : "listed");
    setAllowImage(true); setAllowDisplay(analyze); setAllowHandoff(false); setExperiment(false);
    setDisplayChannels(Array.from({ length: Math.min(channelCount, 16) }, (_, index) => index));
    setDisclosures(DISCLOSURES.map(item => item.id));
  };

  const create = async () => {
    if (!canCreate || !validation || !api.createAgentAccess || cpu === null || memory === null || workers === null) return;
    const generation = ++creationGeneration.current;
    // The deliberate grant click authorizes this displayed policy, not later edits.
    const authorizedGrant = grantFingerprint;
    const resolvedPermissionMode = permissionMode === "default" ? undefined : permissionMode;
    const request: ResearchAgentAccessRequest = {
      source_id: source.id,
      selection,
      recipe: agentRecipe,
      ...(resolvedPermissionMode ? { permission_mode: resolvedPermissionMode } : {}),
      allow_preview: allowPreview,
      allow_run: allowRun,
      ...(allowWorkflowGraph ? { allow_workflow_graph: true } : {}),
      allow_export: allowExport,
      export_names: allowExport && exportMode === "listed" ? names! : [],
      disclosures,
      limits: { cpu_seconds: cpu, memory_bytes: memory * MIB, concurrency: workers },
      ...(delegated ? { delegation: {
        client_id: client,
        expires_at: expiryHours === "0" ? null : new Date(Date.now() + Number(expiryHours) * 3_600_000).toISOString(),
        result_scope: resultScope,
        allow_review: allowReview,
      } } : {}),
      ...(delegated ? { actions, export_scope: exportMode } : {}),
      ...(sourceMode === "study" ? { source_scope: { mode: "study-sources", sources: scopedSources.map(item => ({ id: item.id, sha256: item.sha256 })) } } : {}),
      ...(interactive ? { interactive: {
        allow_image: allowImage, allow_display: allowDisplay, allow_handoff: allowHandoff,
        channels: imageScope ? [...displayChannels].sort((a, b) => a - b) : [],
        handoff_names: allowHandoff ? handoffNames! : [], parameters: experiment ? parameters : {},
      } } : {}),
    };
    setLocalBusy(true);
    onBusyChange(true);
    try {
      const output = await report(async () => {
        const value = await api.createAgentAccess!(request);
        return value === null ? null : exactReceipt(
          value,
          validation,
          source.id,
          selection,
          disclosures,
          anticipatedOperations,
          interactive,
          request.delegation,
          actions,
          request.source_scope?.sources ?? [{ id: source.id, sha256: source.sha256 }],
          exportMode,
          resolvedPermissionMode,
        );
      }, "Could not create bounded local agent access.");
      if (output && generation === creationGeneration.current && currentGrant.current === authorizedGrant) {
        setReceipt(output);
        onCreated?.();
      }
    } finally {
      setLocalBusy(false);
      onBusyChange(false);
    }
  };

  return (
    <div className="research-panel research-agent">
      <h2>Connect an assistant</h2>
      <p>Grant a scope once, then let your assistant work within it.</p>
      <label>Assistant client <select aria-label="Assistant client" value={client} onChange={(event) => setClient(event.target.value)}>
        <option value="codex">Codex</option><option value="claude">Claude Desktop</option>
        <option value="web">ChatGPT web / claude.ai</option></select></label>
      {client === "web" ? <p className="research-derived-notice">For a file-based conversation, use Agent → Export vision handoff, then upload image.png and context.json to your chosen vision model. Live automation requires a compatible local MCP client.</p> :
        <p className="research-agent-client-help">{client === "claude" ? "The saved bundle includes a Claude-compatible MCP configuration." : "The saved bundle includes STDIO settings and Codex configuration. Interactive access also includes a local Loci plugin."} Connect it after reviewing the permissions below.</p>}
      <details><summary>Connection and safety details</summary><p>The local server has no shell, file browser, import, policy-editing or model-installation tool. Your assistant provider may receive the responses you allow.</p></details>

      <label>Access level<select aria-label="Assistant access level" value={preset} onChange={(event) => applyPreset(event.target.value)}>
        <option value="custom">Custom permissions</option><option value="inspect">Inspect</option>
        <option value="analyze" disabled={!actionChoices.length}>Analyze</option><option value="full" disabled={!actionChoices.length}>Full study</option>
      </select></label>
      <label>Session permission mode<select aria-label="Session permission mode" value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as "default" | ResearchAgentPermissionMode)}>
        <option value="default">Automatic (ask approval for mutating actions)</option>
        <option value="ask_approval">Ask for approval (confirm mutating actions in Loci)</option>
        <option value="full_access">Full access (run granted actions without per-call prompts)</option>
        <option value="inspect_only">Inspect only (read-only; mutating actions blocked)</option>
      </select></label>
      {preset !== "custom" && <p className="research-agent-preset-summary">{preset === "inspect" ? "Read images, measurements and review history within the region shown." : preset === "analyze" ? "Inspect, run analyses, correct labels and remeasure within the region shown. Review decisions stay with you." : `Inspect and analyze all ${scopedSources.length} current sources, correct results, approve revisions as an agent, and export into your chosen folder.`} Your connected provider may receive these images and records.</p>}

      <section className="research-agent-card" aria-label="Exact agent source and scope">
        <h3>Source and scope</h3>
        <dl className="research-kv">
          <div><dt>Display name</dt><dd>{source.name}</dd></div>
          <div><dt>Crop and axes</dt><dd>{sourceMode === "study" ? `All pixels, channels, Z planes and timepoints in ${scopedSources.length} current sources` : researcherScopeLabel(source, selection)}</dd></div>
          <div><dt>Measurement channels</dt><dd>{sourceMode === "study" ? "All acquisition channels" : agentRecipe.measurement_channels.map((channel) => sourceChannelLabel(source, channel)).join(", ")}</dd></div>
          <div><dt>Memory limit</dt><dd>{Number(memoryMiB).toLocaleString()} MiB per task</dd></div>
        </dl>
        {sourceMode === "study" && <details><summary>Included sources ({scopedSources.length})</summary><ul>{scopedSources.map(item => <li key={item.id}>{item.name}</li>)}</ul><p>Sources added later require a new grant.</p></details>}
        <details><summary>Technical record</summary><dl className="research-kv">
          <div><dt>API coordinates (zero-based)</dt><dd>{scopeSummary(selection)}</dd></div>
          <div><dt>Coordinate basis</dt><dd>X/Y are zero-based pixel offsets; API intervals are half-open. C/Z/T above are one-based.</dd></div>
          <div><dt>Source ID</dt><dd>{source.id}</dd></div>
          <div><dt>Source SHA-256</dt><dd>{source.sha256}</dd></div>
        </dl></details>
        <details><summary>Displayed recipe settings</summary><pre>{JSON.stringify(agentRecipe, null, 2)}</pre></details>
        {hasReferences && <p role="alert">Agent recipes currently reject flat-field and dark-field references. Remove those bindings from this recipe before validation.</p>}
        <button disabled={busy || localBusy || hasReferences || !configurationValid} onClick={() => void validate()}>
          Validate exact scope and recipe
        </button>
        {validation && <div className="research-summary" aria-label="Exact recipe validation">
          <strong>Scope and settings checked</strong><br />
          {validation.estimated_working_bytes.toLocaleString()} estimated bytes · {validation.resolved_device}
          <details><summary>Technical record</summary><p>Recipe SHA-256 <code>{validation.recipe_sha256}</code></p>
            <p>Method validation: {validation.scientific_validation}</p></details>
        </div>}
      </section>

      <details className="research-agent-custom" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)} onChange={() => setPreset("custom")}><summary>Customize permissions</summary>
      <section className="research-agent-card" aria-label="Agent operation grants">
        <h3>Operation grants</h3>
        <label className="research-check"><input type="checkbox" checked={allowPreview} onChange={(event) => setAllowPreview(event.target.checked)} /> Allow display-only recipe previews</label>
        <label className="research-check"><input type="checkbox" checked={allowRun} onChange={(event) => {
          setAllowRun(event.target.checked);
          if (!event.target.checked && !delegated) setAllowExport(false);
        }} /> Allow durable recipe runs and result reads</label>
        <label className="research-check"><input type="checkbox" checked={allowWorkflowGraph} onChange={(event) => setAllowWorkflowGraph(event.target.checked)} /> Compose reusable workflows from granted actions</label>
        {allowWorkflowGraph && <p>Each workflow step keeps its existing source and action permissions. Workflow changes and execution also require run access.</p>}
        {allowWorkflowGraph && (resultScope !== "granted-sources" || !DISCLOSURES.every(item => disclosures.includes(item.id))) && <p role="alert">Workflow access requires source-scoped results and every response disclosure below.</p>}
        <label className="research-check"><input type="checkbox" checked={allowExport} disabled={!allowRun && !delegated} onChange={(event) => setAllowExport(event.target.checked)} /> Allow exact reviewed-result export</label>
        <p><strong>Resulting tool scope:</strong> catalog and recipe_guide (static), {anticipatedOperations.join(", ")}</p>
        {allowPreview && !disclosures.includes("previews") && <p role="alert">Preview execution also requires the previews response disclosure.</p>}
      </section>

      <section className="research-agent-card" aria-label="Delegated review grants">
        <h3>Result access and review</h3>
        <label>Source access<select aria-label="Agent source access" value={sourceMode} onChange={(event) => setSourceMode(event.target.value as typeof sourceMode)}>
          <option value="selected">Selected source region</option><option value="study">All current study sources</option>
        </select></label>
        <label>Shared research actions<select aria-label="Agent research actions" value={actionMode} onChange={(event) => setActionMode(event.target.value as typeof actionMode)}>
          <option value="none">Approved recipe only</option><option value="inspect" disabled={!actionChoices.length}>Inspect saved results</option>
          <option value="analyze" disabled={!actionChoices.length}>Analyze, annotate and correct</option>
        </select></label>
        {actions.length > 0 && <details><summary>Included actions ({actions.length})</summary><ul>{actions.map(name => <li key={name}>{operations?.[name].summary}</li>)}</ul></details>}
        <label>Results the assistant may inspect<select aria-label="Agent result scope" value={resultScope} onChange={(event) => {
          setResultScope(event.target.value as typeof resultScope);
          if (event.target.value === "pinned-recipes" && !allowRun && !allowReview) setAllowExport(false);
        }}>
          <option value="pinned-recipes">This approved recipe</option>
          <option value="granted-sources">Any method within the granted source region and channels</option>
        </select></label>
        <label className="research-check"><input type="checkbox" checked={allowReview} onChange={(event) => setAllowReview(event.target.checked)} /> Allow the assistant to approve or exclude result revisions</label>
        {allowReview && <p>Decisions are labelled Reviewed by agent. The assistant records its reason and coverage; your later decision keeps the earlier history.</p>}
        {delegated && <>
          <label>Access expires<select aria-label="Agent access expiry" value={expiryHours} onChange={(event) => setExpiryHours(event.target.value)}>
            <option value="0">When revoked</option><option value="24">After 24 hours</option><option value="168">After 7 days</option>
          </select></label>
          <p>Client identity is declared as {client}; Loci does not authenticate the model behind the connection.</p>
          {!delegationValid && <p role="alert">Shared research actions require access to any method in the granted sources, all response disclosures, and run permission for analysis or corrections. Review access requires analysis context disclosure.</p>}
        </>}
      </section>

      <section className="research-agent-card" aria-label="Interactive assistant grants">
        <h3>Images and display</h3>
        <label className="research-check"><input type="checkbox" checked={allowImage} onChange={(event) => setAllowImage(event.target.checked)} /> Allow source images for vision analysis</label>
        <label className="research-check"><input type="checkbox" checked={allowDisplay} onChange={(event) => setAllowDisplay(event.target.checked)} /> Allow reversible channel display changes</label>
        <label className="research-check"><input type="checkbox" checked={allowHandoff} onChange={(event) => setAllowHandoff(event.target.checked)} /> Allow local vision handoff export</label>
        {imageScope && <>
          <p>Image reads stay inside the approved region. Display changes apply to the selected channels across this source. The analysis channel ({selection.c + 1}) remains in the source scope. Channel numbers here start at 1; saved requests use zero-based indices.</p>
          {sourceMode === "study" ? <p>All acquisition channels of the listed sources are included. Each image response can display up to 16 channels.</p> : <div className="research-agent-channels">{Array.from({ length: Math.min(channelCount, 256) }, (_, channel) => <label className="research-check" key={channel}>
            <input aria-label={`Grant display channel ${channel + 1}`} type="checkbox" checked={displayChannels.includes(channel)}
              disabled={!displayChannels.includes(channel) && displayChannels.length >= 16}
              onChange={(event) => setDisplayChannels((old) => event.target.checked ? [...old, channel] : old.filter((item) => item !== channel))} /> Channel {channel + 1}
          </label>)}</div>}
          {channelCount > 256 && <p>For channel indices above 256, create an explicit access request with the CLI.</p>}
          {!displayChannels.length && <p role="alert">Select at least one display channel.</p>}
        </>}
        {allowHandoff && <label>Exact handoff directory names<input aria-label="Exact vision handoff names" value={handoffNameText}
          onChange={(event) => setHandoffNameText(event.target.value)} placeholder="candidate-01.loci-vision" /></label>}
        {(allowImage || allowHandoff) && !disclosures.includes("previews") && <p role="alert">Image access requires previews disclosure.</p>}
        {(allowDisplay || allowHandoff) && !contextDisclosed && <p role="alert">Display and handoff access require geometry, provenance and analysis context disclosures.</p>}
        {allowDisplay && <p>Open Agent → Follow assistant display to see changes in this window. Display changes preserve source pixels and numerical analysis.</p>}
        {allowHandoff && <p>Handoffs are provisional image/context files. They do not require or confer result review. Names must end in .loci-vision.</p>}
      </section>

      <section className="research-agent-card" aria-label="Experimental recipe grants">
        <h3>Experimental analysis</h3>
        <label className="research-check"><input type="checkbox" checked={experiment} onChange={(event) => setExperiment(event.target.checked)} /> Allow bounded recipe exploration</label>
        {experiment && <>
          <p>Allow a numeric range for either setting below. Leave both fields blank to keep that setting fixed. Each range must contain the displayed recipe value; all other recipe fields and the source region stay fixed.</p>
          <div className="research-grid">
            <label>Threshold minimum<input aria-label="Threshold minimum" type="number" step="any" value={thresholdRange[0]} onChange={(event) => setThresholdRange([event.target.value, thresholdRange[1]])} /></label>
            <label>Threshold maximum<input aria-label="Threshold maximum" type="number" step="any" value={thresholdRange[1]} onChange={(event) => setThresholdRange([thresholdRange[0], event.target.value])} /></label>
            <label>Minimum size lower bound<input aria-label="Minimum size lower bound" type="number" step="any" min="0" value={sizeRange[0]} onChange={(event) => setSizeRange([event.target.value, sizeRange[1]])} /></label>
            <label>Minimum size upper bound<input aria-label="Minimum size upper bound" type="number" step="any" min="0" value={sizeRange[1]} onChange={(event) => setSizeRange([sizeRange[0], event.target.value])} /></label>
          </div>
          <p>Threshold uses processed intensity units. Minimum size uses calibrated area or volume when available; otherwise pixels or voxels. Check the recipe guide before choosing a range.</p>
          {(!rangesValid || !Object.keys(parameters).length) && <p role="alert">Enter at least one valid range containing its current recipe value.</p>}
          {(!contextDisclosed || !(allowPreview || allowRun)) && <p role="alert">Exploration requires geometry, provenance and analysis context, plus preview or run access.</p>}
        </>}
      </section>

      <section className="research-agent-card" aria-label="Agent disclosure grants">
        <h3>Response disclosures</h3>
        <p>Every category starts denied. A tool response omits a category unless you select it here.</p>
        {DISCLOSURES.map((item) => <label className="research-agent-disclosure" key={item.id}>
          <span><input aria-label={`Disclose ${item.id}`} type="checkbox" checked={disclosures.includes(item.id)} onChange={(event) => setDisclosures((old) => event.target.checked ? [...old, item.id] : old.filter((value) => value !== item.id))} /> <strong>{item.title}</strong></span>
          <small>{item.detail}</small>
        </label>)}
        <p className="research-derived-notice">
          Loci does not send data to a cloud service. If you connect the generated local MCP
          configuration to a cloud-hosted agent, that client may transmit every category you
          disclose. Confirm the client, account, and data authorization separately.
        </p>
      </section>

      {allowExport && <section className="research-agent-card" aria-label="Agent export grant">
        <h3>Reviewed-result export</h3>
        {delegated && <label>Export names<select aria-label="Agent export scope" value={exportMode} onChange={(event) => setExportMode(event.target.value as typeof exportMode)}>
          <option value="listed">Only the listed names</option><option value="directory">Any new name inside the chosen folder</option>
        </select></label>}
        {exportMode === "listed" && <>
        <label>Exact export directory names
          <input aria-label="Exact export names" value={exportNameText} onChange={(event) => setExportNameText(event.target.value)} placeholder="experiment-01-reviewed" />
        </label>
        <p>Use comma-separated, unique single-component names. After this form, a native dialog chooses one existing export root. The agent can only create these names and cannot overwrite them.</p>
        </>}
        {exportMode === "directory" && <p>Choose one existing export folder in the next dialog. Every export uses a new name; existing files are preserved.</p>}
        {!hasExportDisclosures && <p role="alert">Full research export requires geometry, source names, previews, measurements, and provenance disclosures.</p>}
      </section>}

      <section className="research-agent-card" aria-label="Agent resource limits">
        <h3>Resource limits</h3>
        <div className="research-grid">
          <label>CPU seconds<input aria-label="Agent CPU seconds" type="number" min="1" max="86400" step="1" value={cpuSeconds} onChange={(event) => setCpuSeconds(event.target.value)} /></label>
          <label>Memory MiB<input aria-label="Agent memory MiB" type="number" min="64" max="8192" step="1" value={memoryMiB} onChange={(event) => setMemoryMiB(event.target.value)} /></label>
          <label>Concurrency<input aria-label="Agent concurrency" type="number" min="1" max="64" step="1" value={concurrency} onChange={(event) => setConcurrency(event.target.value)} /></label>
        </div>
        {!limitsValid && <p role="alert">Use integer limits: 1–86,400 CPU seconds, 64–8,192 MiB, and concurrency 1–64.</p>}
      </section>
      </details>

      <button className="research-primary" aria-label={`Grant selected access to ${source.name}`}
        disabled={!canCreate} onClick={() => void create()}>
        Grant selected access
      </button>
      {!api.createAgentAccess && <p role="alert">This desktop build does not provide the native policy-bundle creator.</p>}
      <details><summary>Access and review</summary><p>Choose a new access-bundle folder in the next dialog.
        Exports require review of the exact result revision. {allowReview ? "This grant permits agent review." : "Review stays with the researcher."} The built-in recipe runs locally on CPU.</p></details>

      {receipt && <section className="research-agent-card research-agent-ready" aria-label="Created agent access receipt">
        <h3>Local agent access bundle is ready (not connected yet)</h3>
        <dl className="research-kv">
          <div><dt>Connection state</dt><dd>{agentSessions?.sessions.some(s => s.policy_sha256 === receipt.policy_sha256 && ["connected_idle", "executing", "awaiting_approval", "paused"].includes(s.state)) ? "Connected over STDIO" : "Bundle ready · Waiting for MCP client connection"}</dd></div>
          <div><dt>Permission mode</dt><dd>{receipt.permission_mode ?? (permissionMode === "default" ? "ask_approval (or inspect_only when read-only)" : permissionMode)}</dd></div>
          <div><dt>Policy file</dt><dd>{receipt.policy_filename}</dd></div>
          <div><dt>MCP config</dt><dd>{receipt.config_filename}</dd></div>
          {receipt.plugin_filename && <div><dt>Local plugin</dt><dd>{receipt.plugin_filename}</dd></div>}
          <div><dt>Operations</dt><dd>{receipt.operations.join(", ")}</dd></div>
          <div><dt>Disclosures</dt><dd>{receipt.disclosures.length ? receipt.disclosures.join(", ") : "none"}</dd></div>
        </dl>
        <details><summary>Technical record</summary><dl className="research-kv">
          <div><dt>Policy SHA-256</dt><dd>{receipt.policy_sha256}</dd></div>
          <div><dt>Project ID</dt><dd>{receipt.project_id}</dd></div>
          <div><dt>Recipe SHA-256</dt><dd>{receipt.recipe_sha256}</dd></div>
        </dl></details>
        <p>{client === "claude" ? "In Claude Desktop, open Developer settings → Edit Config. Merge the loci-research entry from mcp-config.json into your existing mcpServers, then restart Claude." : client === "codex" ? "Use the saved README to add the local plugin in Codex, or merge codex-config.toml into your existing MCP configuration. Preserve your other servers." : "Use this bundle with a compatible desktop MCP client."}</p>
        <p>{disclosures.includes("agent_metadata")
          ? "Ask the assistant to read Loci's analysis context and recipe guide, then inspect the permitted source."
          : "Ask the assistant to read Loci's recipe guide, then inspect the permitted source using the binding in Technical record."} The saved README includes setup and revocation steps.</p>
      </section>}
    </div>
  );
}
