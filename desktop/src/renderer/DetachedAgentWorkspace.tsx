import { useEffect, useRef, useState } from "react";
import type {
  AgentWorkspaceApi, AgentWorkspaceBinding, AgentWorkspaceNavigationRequest,
  AgentWorkspacePresentation, AgentWorkspaceState,
} from "../shared/agent-workspace-api";
import type { ResearchAgentControlRequest, ResearchAgentTargetReference } from "../shared/research-contracts";
import { AgentWorkspaceSurface, EMPTY_AGENT_PRESENTATION } from "./AgentWorkspaceSurface";
import { loadPreferences } from "./preferences";
import "./AgentWorkspaceSurface.css";

function bindingKey(value: AgentWorkspaceBinding | null): string {
  return value ? `${value.projectId}:${value.studyEpoch}:${value.generation}` : "";
}
function readableError(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback)
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    .replace(/\/?(?:Users|Volumes)\/[^\s]+/gu, "the selected study").slice(0, 1000);
}

/** A narrow host for the same surface; all study actions are completed by main. */
export function DetachedAgentWorkspace({ api }: { api: AgentWorkspaceApi }): React.JSX.Element {
  const [state, setState] = useState<AgentWorkspaceState | null>(null);
  const [presentation, setPresentation] = useState<AgentWorkspacePresentation>(EMPTY_AGENT_PRESENTATION);
  const [feedback, setFeedback] = useState<{ kind: "status" | "error"; message: string } | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const stateRef = useRef<AgentWorkspaceState | null>(null);
  const presentationRef = useRef(presentation);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingWrites = useRef(0);
  const presentationVersion = useRef(0);
  const acknowledgedVersion = useRef(0);
  const alive = useRef(true);
  const closing = useRef(false);
  const commandPending = useRef(false);
  const preferences = loadPreferences();

  useEffect(() => {
    const applyAppearance = () => {
      const next = loadPreferences();
      Object.assign(document.documentElement.dataset, { theme: next.theme, textSize: next.textSize,
        font: next.font ?? "system", motion: next.motion });
    };
    applyAppearance();
    document.documentElement.classList.add("agent-workspace-detached-root");
    window.addEventListener("storage", applyAppearance);
    return () => { document.documentElement.classList.remove("agent-workspace-detached-root"); window.removeEventListener("storage", applyAppearance); };
  }, []);

  useEffect(() => {
    let active = true;
    alive.current = true;
    const accept = (next: AgentWorkspaceState) => {
      if (!active || (stateRef.current && next.sequence < stateRef.current.sequence)) return;
      const rebound = bindingKey(next.binding) !== bindingKey(stateRef.current?.binding ?? null);
      stateRef.current = next;
      closing.current = next.status === "closing";
      setState(next);
      if (rebound || (pendingWrites.current === 0 && acknowledgedVersion.current === presentationVersion.current)) {
        presentationRef.current = next.presentation;
        setPresentation(next.presentation);
      }
      if (rebound) { presentationVersion.current = 0; acknowledgedVersion.current = 0; setFeedback(null); }
    };
    const removeState = api.onState(accept);
    const removeFlush = api.onFlush(request => {
      if (!active || bindingKey(request.binding) !== bindingKey(stateRef.current?.binding ?? null)) return;
      closing.current = true;
      setCommandBusy(true);
      // Read the ref only after outstanding writes settle. React state may still
      // reflect the previous keystroke when the native close event arrives.
      void writeQueue.current.catch(() => undefined).then(async () => {
        if (!active || bindingKey(request.binding) !== bindingKey(stateRef.current?.binding ?? null)) return;
        await api.flushed(request.binding, request.flushId, presentationRef.current);
      }).catch(error => {
        if (active) {
          closing.current = false; setCommandBusy(false);
          setFeedback({ kind: "error", message: readableError(error, "Could not return the workspace. Your draft is still here.") });
        }
      });
    });
    void api.state().then(accept).catch(error => {
      if (active) setFeedback({ kind: "error", message: readableError(error, "Could not load the agent workspace. Retry to reconnect.") });
    });
    return () => { active = false; alive.current = false; removeState(); removeFlush(); };
  }, [api, retry]);

  const changePresentation = (next: AgentWorkspacePresentation) => {
    const binding = stateRef.current?.binding;
    if (!binding || closing.current) return;
    presentationRef.current = next;
    setPresentation(next);
    pendingWrites.current += 1;
    const version = ++presentationVersion.current;
    const expected = bindingKey(binding);
    writeQueue.current = writeQueue.current.catch(() => undefined).then(async () => {
      if (bindingKey(stateRef.current?.binding ?? null) !== expected) throw new Error("The study changed before the draft could be transferred.");
      await api.updatePresentation(binding, next);
      if (bindingKey(stateRef.current?.binding ?? null) === expected) acknowledgedVersion.current = Math.max(acknowledgedVersion.current, version);
    }).catch(error => {
      if (alive.current && bindingKey(stateRef.current?.binding ?? null) === expected)
        setFeedback({ kind: "error", message: readableError(error, "Could not preserve the latest draft. Keep this window open and retry returning it.") });
    }).finally(() => { pendingWrites.current -= 1; });
  };

  const command = async (operation: (binding: AgentWorkspaceBinding) => Promise<unknown>, pending: string, done: string): Promise<boolean> => {
    const current = stateRef.current;
    if (!current?.binding || current.freshness !== "current" || current.pendingCommands > 0 || closing.current || commandPending.current) return false;
    const expected = bindingKey(current.binding);
    commandPending.current = true; setCommandBusy(true); setFeedback({ kind: "status", message: pending });
    try {
      // These promises resolve after the main host's completion acknowledgment.
      await operation(current.binding);
      if (!alive.current || bindingKey(stateRef.current?.binding ?? null) !== expected) return false;
      setFeedback({ kind: "status", message: done });
      return true;
    } catch (error) {
      if (alive.current && bindingKey(stateRef.current?.binding ?? null) === expected)
        setFeedback({ kind: "error", message: readableError(error, "The workspace action could not finish. Your current state is preserved.") });
      return false;
    } finally {
      commandPending.current = false;
      if (alive.current) setCommandBusy(false);
    }
  };
  const navigate = (intent: AgentWorkspaceNavigationRequest["intent"], target?: ResearchAgentTargetReference) => {
    void command(binding => api.navigate(binding, { requestId: crypto.randomUUID(), intent, ...(target ? { target } : {}) }),
      intent === "configure-access" ? "Opening access settings in the workspace…" : "Opening recorded evidence in the workspace…",
      intent === "configure-access" ? "Opened access settings in the workspace." : "Opened recorded evidence in the workspace.");
  };
  const control = (request: ResearchAgentControlRequest) => command(binding => api.control(binding, request),
    "Updating the agent workspace…", request.action === "approve_request" || request.action === "deny_request"
      ? "Approval decision recorded." : request.action === "stop_job" ? "Job stop requested." : "Agent workspace updated.");
  const dock = async () => {
    const binding = stateRef.current?.binding;
    if (!binding || commandPending.current || closing.current) return;
    setCommandBusy(true);
    try { await api.dock(binding); }
    catch (error) { if (alive.current) setFeedback({ kind: "error", message: readableError(error, "Could not return the workspace. Your draft is still here.") }); }
    finally { if (alive.current) setCommandBusy(false); }
  };

  if (!state?.snapshot || !state.binding || state.role !== "workspace") return <main className="detached-agent-workspace">
    <section className="detached-agent-workspace__waiting" aria-label="Agent workspace state">
      <h1>Agent workspace</h1>
      <p role={feedback?.kind === "error" ? "alert" : "status"}>{feedback?.message ?? (state ? "This study is no longer available in this window. Reopen the agent workspace from the current study." : "Loading the study's agent workspace…")}</p>
      <button type="button" onClick={() => { setFeedback(null); setRetry(value => value + 1); }}>Retry connection</button>
    </section>
  </main>;
  return <main className="detached-agent-workspace">
    <AgentWorkspaceSurface snapshot={state.snapshot} host="detached" followAgent={state.follow}
      refreshError={state.refreshError ?? (state.freshness !== "current" ? "The agent workspace is waiting for current study state." : null)}
      expandActivityDetails={preferences.agent.expandActivityDetails}
      commandBusy={commandBusy || state.pendingCommands > 0 || state.status === "closing"}
      presentation={presentation} onPresentationChange={changePresentation}
      feedback={feedback ?? (state.error ? { kind: "error", message: state.error } : null)}
      onError={message => setFeedback({ kind: "error", message })} onControl={control}
      onFollowAgentChange={follow => { void command(binding => api.setFollow(binding, follow), "Updating Follow agent…", "Follow agent updated."); }}
      onDock={() => { void dock(); }} onConfigureAccess={() => navigate("configure-access")}
      currentTargets={state.currentTargets} inspectablePreviewJobIds={state.inspectablePreviewJobIds}
      onOpenSource={target => navigate("open-source", target)} onOpenResult={target => navigate("open-result", target)}
      onReviewResult={target => navigate("review-result", target)} onOpenJob={target => navigate("open-job", target)}
      onOpenWorkflow={target => navigate("open-workflow", target)} onInspectPreview={target => navigate("inspect-preview", target)} />
  </main>;
}
