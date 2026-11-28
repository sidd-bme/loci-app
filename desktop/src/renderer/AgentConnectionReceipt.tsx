import { useEffect, useState } from "react";
import type { ResearchAgentAccessReceipt, ResearchAgentSessionsSnapshot } from "../shared/research-contracts";

interface Props {
  receipt: ResearchAgentAccessReceipt;
  sessions?: ResearchAgentSessionsSnapshot;
  client: string;
  onCheck?: () => Promise<void>;
  onReveal?: (policy: string) => Promise<void>;
  onCopyLaunch?: (policy: string) => Promise<void>;
  onCopyWorkspacePath?: (policy: string) => Promise<void>;
  onCanOpenHost?: (policy: string) => Promise<boolean>;
  onOpenHost?: (policy: string) => Promise<boolean>;
  onOpenWorkspace?: () => void;
}

const liveStates = new Set(["connected_idle", "executing", "awaiting_approval", "paused"]);

export function AgentConnectionReceipt({
  receipt, sessions, client, onCheck, onReveal, onCopyLaunch, onCopyWorkspacePath, onCanOpenHost, onOpenHost, onOpenWorkspace,
}: Props) {
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [copied, setCopied] = useState<"prompt" | "command" | "path" | null>(null);
  const [launchAvailableFor, setLaunchAvailableFor] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openRequested, setOpenRequested] = useState(false);
  const [error, setError] = useState("");
  const policy = sessions?.policies.find(item => item.project_id === receipt.project_id && item.policy_sha256 === receipt.policy_sha256);
  const matching = sessions?.sessions.filter(item => item.project_id === receipt.project_id && item.policy_sha256 === receipt.policy_sha256) ?? [];
  const live = matching.filter(item => liveStates.has(item.state));
  const connected = !policy?.revoked && live.length > 0;
  const declaredClient = live.length === 1 ? live[0].client_id.toLowerCase() : "";
  const host = declaredClient.includes("antigravity") ? "Antigravity" : declaredClient.includes("codex") ? "Codex"
    : declaredClient.includes("claude") ? "Claude" : "Assistant";
  const title = policy?.revoked ? "Access revoked" : connected ? `${host} connected` : matching.length ? "Assistant disconnected" : "Waiting for your assistant";
  const workspace = receipt.antigravity_workspace ?? receipt.codex_workspace;
  const codexWorkspace = receipt.codex_workspace === "codex-workspace" && !receipt.antigravity_workspace;
  const canCheckHost = codexWorkspace && !connected && !policy?.revoked && Boolean(onCanOpenHost && onOpenHost);
  const policySha256 = receipt.policy_sha256;
  const showOpenHost = canCheckHost && launchAvailableFor === policySha256;
  const prompt = receipt.verification_prompt ?? (receipt.disclosures.includes("agent_metadata")
    ? "Use Loci to inspect the analysis context. Tell me which image and region I have shared."
    : "Read the Loci recipe guide and tell me which operations this connection allows.");

  useEffect(() => {
    if (!canCheckHost || !onCanOpenHost) return;
    let active = true;
    void onCanOpenHost(policySha256).then(available => {
      if (active) setLaunchAvailableFor(available ? policySha256 : null);
    }).catch(() => { if (active) setLaunchAvailableFor(null); });
    return () => { active = false; };
  }, [canCheckHost, onCanOpenHost, policySha256]);

  async function perform(work: () => Promise<void>, fallback: string) {
    setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : fallback); }
  }

  return <section className="research-agent-card research-agent-ready" aria-label="Created agent access receipt">
    <h3><span role="status">{title}</span></h3>
    {policy?.revoked ? <p>Create a new grant to reconnect.</p> : <>
      {connected ? <p>{policy?.paused ? "Session paused in Loci." : "Send a prompt in your assistant to work with this study."}</p> :
        <p>{receipt.antigravity_workspace ? <>In Antigravity, use <strong>New Project → Add Folder</strong> to select <code>{workspace}</code> as the only folder. Create the project and review any connection prompts.</> :
          workspace ? <>{showOpenHost ? "In Codex, review any workspace trust prompt before sending the first prompt." : <>Open <code>{workspace}</code> as a local project in Codex, review the trust prompt and start a new chat.</>}</> :
          client === "claude" ? <>Add the <code>loci-research</code> entry from <code>mcp-config.json</code> in Claude Desktop’s developer settings, then restart Claude.</> :
          <>Follow <code>README.txt</code> in the setup folder to connect Codex, then start a new chat.</>}</p>}
      <div className="research-agent-buttons">
        {showOpenHost && onOpenHost && <button className="research-primary" disabled={opening} onClick={() => void perform(async () => {
          setOpening(true);
          setOpenRequested(false);
          try {
            if (!await onOpenHost(policySha256)) {
              setLaunchAvailableFor(null);
              throw new Error("Codex desktop is unavailable. Use the setup folder or terminal command.");
            }
            setOpenRequested(true);
          } finally { setOpening(false); }
        }, "Could not open Codex.")}>{opening ? "Opening Codex…" : "Open in Codex"}</button>}
        {!connected && workspace && onCopyWorkspacePath && !showOpenHost && <button className="research-primary" onClick={() => void perform(async () => {
          await onCopyWorkspacePath(policySha256); setCopied("path");
        }, "Could not copy the workspace path.")}>{copied === "path" ? "Workspace path copied" : "Copy workspace path"}</button>}
        {!connected && <button className={showOpenHost || (workspace && onCopyWorkspacePath) ? undefined : "research-primary"} onClick={() => void perform(async () => { await navigator.clipboard.writeText(prompt); setCopied("prompt"); }, "Open View first prompt to copy it manually.")}>{copied === "prompt" ? "Prompt copied" : "Copy prompt"}</button>}
        {connected && onOpenWorkspace && <button onClick={onOpenWorkspace}>View agent workspace</button>}
        {!connected && onCheck && <button disabled={checking} onClick={() => void perform(async () => {
          setChecking(true);
          try { await onCheck(); setChecked(true); } finally { setChecking(false); }
        }, "Could not check this connection.")}>{checking ? "Checking connection…" : "Check connection"}</button>}
      </div>
      {openRequested && !connected && <p role="status">Continue in Codex. Check connection after sending the first prompt.</p>}
      {copied === "path" && !connected && <p role="status">Paste the workspace path in the assistant’s folder picker. On macOS, press Shift–Command–G in the picker to enter a path.</p>}
      {!connected && <details><summary>View first prompt</summary>
        <textarea aria-label="First prompt" className="research-agent-prompt" rows={3} readOnly value={prompt} />
      </details>}
      {checked && !connected && <p role="status">No active session for this setup. Send the first prompt in your assistant.</p>}
    </>}
    <div className="research-agent-buttons">
    {onReveal && <button onClick={() => void perform(() => onReveal(receipt.policy_sha256), "Could not show the setup folder.")}>Show setup folder</button>}
    {!connected && !policy?.revoked && workspace && onCopyLaunch && <button onClick={() => void perform(async () => {
      await onCopyLaunch(receipt.policy_sha256); setCopied("command");
    }, "Could not copy the command.")}>{copied === "command" ? "Command copied" : "Copy terminal command"}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    <details><summary>Connection record</summary><dl className="research-kv">
      <div><dt>Policy file</dt><dd>{receipt.policy_filename}</dd></div>
      <div><dt>MCP config</dt><dd>{receipt.antigravity_config_filename ?? receipt.codex_config_filename ?? receipt.config_filename}</dd></div>
      {receipt.plugin_filename && <div><dt>Local plugin</dt><dd>{receipt.plugin_filename}</dd></div>}
      <div><dt>Operations</dt><dd>{receipt.operations.join(", ")}</dd></div>
      <div><dt>Disclosures</dt><dd>{receipt.disclosures.join(", ") || "None"}</dd></div>
      <div><dt>Permission mode</dt><dd>{policy?.permission_mode ?? receipt.permission_mode ?? "Automatic"}</dd></div>
      <div><dt>Policy SHA-256</dt><dd>{receipt.policy_sha256}</dd></div>
      <div><dt>Project ID</dt><dd>{receipt.project_id}</dd></div>
      <div><dt>Recipe SHA-256</dt><dd>{receipt.recipe_sha256}</dd></div>
    </dl></details>
  </section>;
}
