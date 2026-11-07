import { useEffect, useMemo, useRef, useState } from "react";
import type { ResearchAgentTargetReference, ResearchDesktopApi, ResearchSnapshot } from "../shared/research-contracts";
import { checkedGraphWorkflow } from "../shared/workflow-graph-contracts";
import { checkedWorkflow } from "./workflow-editor";

export interface AgentWorkflowNavigation {
  requestId: string;
  target: ResearchAgentTargetReference;
  version: 1 | 2;
  current(): boolean;
}
export interface AgentWorkflowNavigationProps {
  agentNavigation?: AgentWorkflowNavigation | null;
  onAgentNavigationComplete?: (requestId: string, error?: string) => void;
}
export function assertAgentWorkflow(record: { id: string; revision: number; data: { definition_sha256: string } }, target: ResearchAgentTargetReference): void {
  if (target.kind !== "workflow" || record.id !== target.id ||
      (target.revision !== undefined && target.revision !== record.revision) ||
      (target.sha256 !== undefined && target.sha256 !== record.data.definition_sha256))
    throw new Error("The recorded workflow revision changed. Refresh its evidence before opening it.");
}

/** Bounded document metadata reads, triggered by retained workflow evidence, never a snapshot poller. */
export function useAgentWorkflowTargets(api: ResearchDesktopApi, snapshot: ResearchSnapshot | null, scope: string, enabled: boolean) {
  const [value, setValue] = useState<{ scope: string; targets: Array<ResearchAgentTargetReference & { version: 1 | 2 }> }>({ scope: "", targets: [] });
  const current = useRef(scope); current.current = scope;
  const signature = JSON.stringify([...(snapshot?.agent_sessions?.events ?? []), ...(snapshot?.agent_sessions?.tasks ?? []),
    ...(snapshot?.agent_sessions?.approvals ?? [])].flatMap(item => item.targets ?? []).filter(target => target.kind === "workflow"));
  const classic = Boolean(snapshot?.operations.workflow_list), graph = Boolean(snapshot?.operations.workflow_graph_list);
  useEffect(() => {
    let alive = true;
    if (!enabled || (!classic && !graph)) { setValue({ scope, targets: [] }); return; }
    setValue({ scope, targets: [] });
    void Promise.all(([1, 2] as const).map(async version => {
      if (version === 1 ? !classic : !graph) return [];
      const output = await api.execute(version === 1 ? "workflow_list" : "workflow_graph_list", {}) as { workflows?: unknown[] };
      if (!Array.isArray(output.workflows) || output.workflows.length > 1000) throw new Error("The workflow library is unavailable.");
      return output.workflows.map(raw => {
        const record = version === 1 ? checkedWorkflow(raw) : checkedGraphWorkflow(raw);
        return { kind: "workflow" as const, id: record.id, revision: record.revision, sha256: record.data.definition_sha256, version };
      });
    })).then(groups => { if (alive && current.current === scope) setValue({ scope, targets: groups.flat() }); })
      .catch(() => { if (alive && current.current === scope) setValue({ scope, targets: [] }); });
    return () => { alive = false; };
  }, [api, scope, enabled, classic, graph, signature]);
  return useMemo(() => value.scope === scope ? value.targets : [], [scope, value]);
}
