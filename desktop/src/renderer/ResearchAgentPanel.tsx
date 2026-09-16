import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ResearchAgentAccessReceipt,
  ResearchAgentDisclosure,
  ResearchDesktopApi,
  ResearchRecipe,
  ResearchSelection,
  ResearchSource,
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
  { id: "agent_metadata", title: "Agent metadata", detail: "Policy hash, project ID, granted-operation summary, and extra record metadata." },
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
): ResearchAgentAccessReceipt {
  const receipt = value as ResearchAgentAccessReceipt;
  if (
    !receipt ||
    receipt.schema !== "loci.agent-policy/v1" ||
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
  selection,
  recipe,
  report,
  busy,
  onBusyChange,
}: {
  api: ResearchDesktopApi;
  source: ResearchSource;
  selection: ResearchSelection;
  recipe: ResearchRecipe;
  report: Report;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}): React.JSX.Element {
  const [allowPreview, setAllowPreview] = useState(false);
  const [allowRun, setAllowRun] = useState(false);
  const [allowExport, setAllowExport] = useState(false);
  const [disclosures, setDisclosures] = useState<ResearchAgentDisclosure[]>([]);
  const [exportNameText, setExportNameText] = useState("");
  const [cpuSeconds, setCpuSeconds] = useState("300");
  const [memoryMiB, setMemoryMiB] = useState("4096");
  const [concurrency, setConcurrency] = useState("1");
  const [confirmed, setConfirmed] = useState(false);
  const [validation, setValidation] = useState<RecipeValidation | null>(null);
  const [receipt, setReceipt] = useState<ResearchAgentAccessReceipt | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [client, setClient] = useState("claude");
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
    validationFingerprint, allowPreview, allowRun, allowExport, disclosures,
    exportNameText, cpuSeconds, memoryMiB, concurrency, confirmed,
  ]);

  useEffect(() => {
    validationGeneration.current += 1;
    creationGeneration.current += 1;
    setValidation(null);
    setReceipt(null);
  }, [validationFingerprint]);
  useEffect(() => {
    creationGeneration.current += 1;
    setReceipt(null);
  }, [grantFingerprint]);
  useEffect(() => {
    setAllowPreview(false);
    setAllowRun(false);
    setAllowExport(false);
    setDisclosures([]);
    setExportNameText("");
    setConfirmed(false);
    setValidation(null);
    setReceipt(null);
  }, [source.id, source.sha256]);

  const cpu = validInteger(cpuSeconds, 1, 86_400);
  const memory = validInteger(memoryMiB, 64, 8 * 1024);
  const workers = validInteger(concurrency, 1, 64);
  const names = exportNames(exportNameText);
  const hasExportDisclosures = EXPORT_DISCLOSURES.every((item) => disclosures.includes(item));
  const limitsValid = cpu !== null && memory !== null && workers !== null;
  const exportValid = !allowExport || (allowRun && names !== null && hasExportDisclosures);
  const operationValid = !allowPreview || disclosures.includes("previews");
  const canCreate = Boolean(
    api.createAgentAccess && validation && limitsValid && exportValid && operationValid && confirmed && !busy && !localBusy,
  );

  const anticipatedOperations = [
    "inspect_source",
    "validate_recipe",
    ...(allowPreview ? ["preview_recipe"] : []),
    ...(allowRun ? ["submit_recipe", "job_status", "cancel_job", "result"] : []),
    ...(allowRun && disclosures.includes("previews") ? ["result_view"] : []),
    ...(allowExport ? ["export_result"] : []),
  ];

  const validate = async () => {
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
      if (output && generation === validationGeneration.current) setValidation(output);
    } finally {
      setLocalBusy(false);
      onBusyChange(false);
    }
  };

  const create = async () => {
    if (!canCreate || !validation || !api.createAgentAccess || cpu === null || memory === null || workers === null) return;
    const generation = ++creationGeneration.current;
    const request = {
      source_id: source.id,
      selection,
      recipe: agentRecipe,
      allow_preview: allowPreview,
      allow_run: allowRun,
      allow_export: allowExport,
      export_names: allowExport ? names! : [],
      disclosures,
      limits: { cpu_seconds: cpu, memory_bytes: memory * MIB, concurrency: workers },
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
        );
      }, "Could not create bounded local agent access.");
      if (output && generation === creationGeneration.current) setReceipt(output);
    } finally {
      setLocalBusy(false);
      onBusyChange(false);
    }
  };

  return (
    <div className="research-panel research-agent">
      <h2>Connect an assistant</h2>
      <p>Choose what an assistant may see and do in this study. Processing stays local.</p>
      <label>Assistant client <select aria-label="Assistant client" value={client} onChange={(event) => setClient(event.target.value)}>
        <option value="claude">Claude Desktop</option><option value="codex">ChatGPT desktop / Codex</option>
        <option value="web">ChatGPT web / claude.ai</option></select></label>
      {client === "web" ? <p className="research-derived-notice">Web clients cannot use this local connection directly. Use a desktop MCP client; Loci does not publish a hosted connector.</p> :
        <p className="research-agent-client-help">{client === "claude" ? "The saved bundle includes a Claude-compatible MCP configuration." : "The saved bundle includes STDIO settings and a Codex TOML configuration."} Connect it after reviewing the permissions below.</p>}
      <details><summary>Connection and safety details</summary><p>The local server has no shell, file browser, import, policy-editing or model-installation tool. Your assistant provider may receive the responses you allow.</p></details>

      <section className="research-agent-card" aria-label="Exact agent source and scope">
        <h3>Exact source and scope</h3>
        <dl className="research-kv">
          <div><dt>Display name</dt><dd>{source.name} (untrusted metadata)</dd></div>
          <div><dt>Source ID</dt><dd>{source.id}</dd></div>
          <div><dt>Source SHA-256</dt><dd>{source.sha256}</dd></div>
          <div><dt>Crop and axes</dt><dd>{scopeSummary(selection)}</dd></div>
          <div><dt>Measurement channels</dt><dd>{agentRecipe.measurement_channels.join(", ")}</dd></div>
          <div><dt>Working memory</dt><dd>{(agentRecipe.working_bytes / MIB).toLocaleString()} MiB</dd></div>
        </dl>
        <details><summary>Displayed recipe settings</summary><pre>{JSON.stringify(agentRecipe, null, 2)}</pre></details>
        {hasReferences && <p role="alert">Agent recipes currently reject flat-field and dark-field references. Remove those bindings from this recipe before validation.</p>}
        <button disabled={busy || localBusy || hasReferences} onClick={() => void validate()}>
          Validate exact scope and recipe
        </button>
        {validation && <div className="research-summary" aria-label="Exact recipe validation">
          <strong>Validated recipe SHA-256</strong> {validation.recipe_sha256}<br />
          {validation.estimated_working_bytes.toLocaleString()} estimated bytes · {validation.resolved_device} · {validation.scientific_validation}
        </div>}
      </section>

      <section className="research-agent-card" aria-label="Agent operation grants">
        <h3>Operation grants</h3>
        <label className="research-check"><input type="checkbox" checked={allowPreview} onChange={(event) => setAllowPreview(event.target.checked)} /> Allow display-only recipe previews</label>
        <label className="research-check"><input type="checkbox" checked={allowRun} onChange={(event) => {
          setAllowRun(event.target.checked);
          if (!event.target.checked) setAllowExport(false);
        }} /> Allow durable recipe runs and result reads</label>
        <label className="research-check"><input type="checkbox" checked={allowExport} disabled={!allowRun} onChange={(event) => setAllowExport(event.target.checked)} /> Allow exact reviewed-result export</label>
        <p><strong>Resulting tool scope:</strong> catalog (static, always available), {anticipatedOperations.join(", ")}</p>
        {allowPreview && !disclosures.includes("previews") && <p role="alert">Preview execution also requires the previews response disclosure.</p>}
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
        <label>Exact export directory names
          <input aria-label="Exact export names" value={exportNameText} onChange={(event) => setExportNameText(event.target.value)} placeholder="experiment-01-reviewed" />
        </label>
        <p>Use comma-separated, unique single-component names. After this form, a native dialog chooses one existing export root. The agent can only create these names and cannot overwrite them.</p>
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
        <p>The current recipe runtime is the bounded built-in classical CPU implementation. This form makes no model identity, performance, or biomedical validation claim.</p>
      </section>

      <label className="research-agent-confirm">
        <input aria-label="Confirm exact agent policy" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        I reviewed this exact source fingerprint, crop, recipe hash, operation grants,
        disclosures, export names, and resource limits.
      </label>
      <button className="research-primary" disabled={!canCreate} onClick={() => void create()}>
        Create bounded agent access
      </button>
      {!api.createAgentAccess && <p role="alert">This desktop build does not provide the native policy-bundle creator.</p>}
      <p>
        A native dialog will choose a new policy-bundle folder. Private study, policy, and
        export paths never appear in this panel. The agent cannot create or forge human review;
        a person must review the exact result in Loci before any authorized export.
      </p>

      {receipt && <section className="research-agent-card research-agent-ready" aria-label="Created agent access receipt">
        <h3>Local agent access is ready</h3>
        <dl className="research-kv">
          <div><dt>Policy file</dt><dd>{receipt.policy_filename}</dd></div>
          <div><dt>MCP config</dt><dd>{receipt.config_filename}</dd></div>
          <div><dt>Policy SHA-256</dt><dd>{receipt.policy_sha256}</dd></div>
          <div><dt>Project ID</dt><dd>{receipt.project_id}</dd></div>
          <div><dt>Recipe SHA-256</dt><dd>{receipt.recipe_sha256}</dd></div>
          <div><dt>Operations</dt><dd>{receipt.operations.join(", ")}</dd></div>
          <div><dt>Disclosures</dt><dd>{receipt.disclosures.length ? receipt.disclosures.join(", ") : "none"}</dd></div>
        </dl>
        <p>{client === "claude" ? "In Claude Desktop, open Developer settings → Edit Config. Merge the loci-research entry from mcp-config.json into your existing mcpServers, then restart Claude." : client === "codex" ? "In ChatGPT desktop / Codex, open Settings → MCP servers → Add server. Choose STDIO and enter the saved command and arguments. Or merge codex-config.toml into your existing configuration." : "Use this bundle with a compatible desktop MCP client."}</p>
        <p>Ask the assistant to list Loci's allowed tools, then inspect the selected source. The saved README includes setup and revocation steps. Connecting the client is a separate action.</p>
      </section>}
    </div>
  );
}
