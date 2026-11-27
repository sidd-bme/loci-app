import { useState } from "react";
import type { ResearchAgentAccessReceipt, ResearchAgentSessionsSnapshot } from "../shared/research-contracts";

interface Props {
  receipt: ResearchAgentAccessReceipt;
  sessions?: ResearchAgentSessionsSnapshot;
  client: string;
  onCheck?: () => Promise<void>;
  onReveal?: (policy: string) => Promise<void>;
  onCopyLaunch?: (policy: string) => Promise<void>;
  onOpenWorkspace?: () => void;
}

const liveStates = new Set(["connected_idle", "executing", "awaiting_approval", "paused"]);

export function AgentConnectionReceipt({ receipt, sessions, client, onCheck, onReveal, onCopyLaunch, onOpenWorkspace }: Props) {
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [copied, setCopied] = useState(false);
  const [launchCopied, setLaunchCopied] = useState(false);
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
  const prompt = receipt.verification_prompt ?? (receipt.disclosures.includes("agent_metadata")
    ? "Use Loci to inspect the analysis context. Tell me which image and region I have shared."
    : "Read the Loci recipe guide and tell me which operations this connection allows.");

  async function perform(work: () => Promise<void>, fallback: string) {
    setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : fallback); }
  }

  return <section className="research-agent-card research-agent-ready" aria-label="Created agent access receipt">
    <h3><span role="status">{title}</span></h3>
    {policy?.revoked ? <p>Create a new grant to reconnect.</p> : <>
      {connected ? <p>{policy?.paused ? "Session paused in Loci." : "Send a prompt in your assistant to work with this study."}</p> :
        <p>{workspace ? <>Open <code>{workspace}</code> as a project in {client === "antigravity" ? "Antigravity" : "Codex"}, trust the workspace and start a new chat.</> :
          client === "claude" ? <>Add the <code>loci-research</code> entry from <code>mcp-config.json</code> in Claude Desktop’s developer settings, then restart Claude.</> :
          <>Follow <code>README.txt</code> in the setup folder to connect Codex, then start a new chat.</>}</p>}
      <div className="research-agent-buttons">
        {!connected && <button className="research-primary" onClick={() => void perform(async () => { await navigator.clipboard.writeText(prompt); setCopied(true); }, "Open View first prompt to copy it manually.")}>{copied ? "Prompt copied" : "Copy prompt"}</button>}
        {connected && onOpenWorkspace && <button onClick={onOpenWorkspace}>View agent workspace</button>}
        {!connected && onCheck && <button disabled={checking} onClick={() => void perform(async () => {
          setChecking(true);
          try { await onCheck(); setChecked(true); } finally { setChecking(false); }
        }, "Could not check this connection.")}>{checking ? "Checking connection…" : "Check connection"}</button>}
      </div>
      {!connected && <details><summary>View first prompt</summary>
        <textarea aria-label="First prompt" className="research-agent-prompt" rows={3} readOnly value={prompt} />
      </details>}
      {checked && !connected && <p role="status">No active session for this setup. Send the first prompt in your assistant.</p>}
    </>}
    <div className="research-agent-buttons">
    {onReveal && <button onClick={() => void perform(() => onReveal(receipt.policy_sha256), "Could not show the setup folder.")}>Show setup folder</button>}
    {!connected && !policy?.revoked && workspace && onCopyLaunch && <button onClick={() => void perform(async () => {
      await onCopyLaunch(receipt.policy_sha256); setLaunchCopied(true);
    }, "Could not copy the command.")}>{launchCopied ? "Command copied" : "Copy terminal command"}</button>}
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
