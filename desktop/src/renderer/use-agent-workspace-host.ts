import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentWorkspaceApi, AgentWorkspacePresentation, AgentWorkspaceState } from "../shared/agent-workspace-api";
import { AgentWorkspaceHost, type AgentHostActions, type AgentHostContext } from "./agent-workspace-host";

const EMPTY: AgentWorkspacePresentation = { selectedTaskId: null, section: "overview", draft: null };
export function useAgentWorkspaceHost(api: AgentWorkspaceApi | undefined, context: AgentHostContext,
  actions: AgentHostActions, onError: (message: string) => void) {
  const latest = useRef({ context, actions, onError }); latest.current = { context, actions, onError };
  const [state, setState] = useState<AgentWorkspaceState | null>(null);
  const [presentation, setPresentation] = useState<AgentWorkspacePresentation>(EMPTY);
  const [openRequest, setOpenRequest] = useState(0);
  const host = useMemo(() => api ? new AgentWorkspaceHost({ api, context: () => latest.current.context,
    actions: () => latest.current.actions, onState: setState, onPresentation: setPresentation,
    onReturn: () => setOpenRequest(value => value + 1), onError: value => latest.current.onError(value) }) : null, [api]);
  useEffect(() => { host?.start(); return () => host?.dispose(); }, [host]);
  useEffect(() => {
    let active = true;
    if (host && !context.switching && context.packet) void host.publish().catch(error => {
      if (active && latest.current.context.scope === context.scope && !latest.current.context.switching)
        latest.current.onError(error instanceof Error ? error.message : "Agent workspace status could not be published.");
    });
    return () => { active = false; };
  },
    [host, context.scope, context.switching, context.packet]);
  return { state, presentation, openRequest,
    detached: Boolean(state && state.status !== "docked"),
    changePresentation: (next: AgentWorkspacePresentation) => host?.changePresentation(next),
    open: () => {
      const scope = latest.current.context.scope;
      return host?.open().catch(error => { if (latest.current.context.scope === scope && !latest.current.context.switching)
        latest.current.onError(error instanceof Error ? error.message : "Could not open the agent workspace."); });
    },
    focus: () => {
      const scope = latest.current.context.scope;
      return host?.focus().catch(error => { if (latest.current.context.scope === scope && !latest.current.context.switching)
        latest.current.onError(error instanceof Error ? error.message : "Could not focus the agent workspace."); });
    } };
}
