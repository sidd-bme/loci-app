import { useEffect, useId, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchSnapshot } from "../shared/research-contracts";
import {
  AgentWorkspaceSurface, EMPTY_AGENT_PRESENTATION, pillSummary, stateTone,
  type AgentWorkspacePresentation, type AgentWorkspaceSurfaceProps,
} from "./AgentWorkspaceSurface";
import "./AgentSessionIndicator.css";

export type AgentSessionIndicatorProps = Omit<AgentWorkspaceSurfaceProps, "onControl" | "host" | "onDock" | "onClose" | "closeButtonRef"> & {
  api: ResearchDesktopApi;
  onSnapshot: (next: ResearchSnapshot) => void;
  detached?: boolean;
  onFocusDetached?: () => void;
  /** Increment after a completed native dock/close handoff to reopen the shared surface. */
  openRequest?: number;
};

/** The status entry remains mounted while its surface moves between hosts. */
export function AgentSessionIndicator({ api, onSnapshot, detached = false, onFocusDetached, openRequest = 0,
  presentation, onPresentationChange, ...surface }: AgentSessionIndicatorProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [localPresentation, setLocalPresentation] = useState<AgentWorkspacePresentation>(EMPTY_AGENT_PRESENTATION);
  const currentPresentation = presentation ?? localPresentation;
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const drawerId = useId();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (detached) setOpen(false); }, [detached]);
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open || detached) return;
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !container.current?.contains(document.activeElement)) return;
      event.preventDefault(); setOpen(false); trigger.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", outside); };
  }, [open, detached]);

  const sessions = surface.snapshot.agent_sessions;
  const pending = sessions?.approvals.filter(item => item.state === "pending").length ?? 0;
  const activeOperation = sessions?.sessions.find(session => ["connected_idle", "executing", "awaiting_approval", "paused"].includes(session.state) && session.current_operation)?.current_operation ?? null;
  const label = surface.refreshError ? "Agent status unavailable" : pillSummary(sessions?.status ?? "none", pending, activeOperation);
  const tone = surface.refreshError ? "warning" : stateTone(sessions?.status ?? "none");
  return <div className="agent-session-indicator" ref={container}>
    <button ref={trigger} type="button" className={`agent-session-pill tone-${tone}`}
      aria-label="Agent session status" aria-expanded={open && !detached}
      aria-controls={open && !detached ? drawerId : undefined}
      title={detached ? "Focus the detached agent workspace" : "Open agent workspace"}
      onClick={() => { if (detached) onFocusDetached?.(); else setOpen(value => !value); }}>
      <span className="agent-session-pill__dot" aria-hidden="true" />
      <span className="agent-session-pill__label" role="status">{label}</span>
      {pending > 0 && <span className="agent-session-pill__badge">{pending}</span>}
    </button>
    {open && !detached && <section id={drawerId} className="agent-session-drawer" aria-label="Agent session and approvals">
      <AgentWorkspaceSurface {...surface} presentation={currentPresentation}
        onPresentationChange={next => { if (!presentation) setLocalPresentation(next); onPresentationChange?.(next); }}
        onControl={api.controlAgentSession ? async request => {
          const next = await api.controlAgentSession!(request);
          if (next && mounted.current) onSnapshot(next);
          return Boolean(next) && mounted.current;
        } : undefined}
        closeButtonRef={closeButton} onClose={close} />
    </section>}
  </div>;
}
