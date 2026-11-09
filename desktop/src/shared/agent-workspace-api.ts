import type { ResearchAgentControlRequest, ResearchAgentTargetReference, ResearchSnapshot } from "./research-contracts";

/** Native-issued study/window capability; never a filesystem locator. */
export interface AgentWorkspaceBinding { projectId: string; studyEpoch: number; generation: number }
export type AgentWorkspaceSection = "overview" | "plan" | "activity" | "approvals";
export interface AgentWorkspacePresentation {
  selectedTaskId: string | null;
  section: AgentWorkspaceSection;
  draft: { taskId: string; baseRevision: number; goal: string; steps: Array<{ id: string; title: string }> } | null;
}
export interface AgentWorkspacePublishedState {
  snapshot: ResearchSnapshot;
  follow: boolean;
  refreshError: string | null;
  currentTargets: ResearchAgentTargetReference[];
  inspectablePreviewJobIds: string[];
  /** Only the docked main host may hand off a local editor presentation. */
  presentation?: AgentWorkspacePresentation;
}
export interface AgentWorkspaceState {
  role: "main" | "workspace";
  status: "docked" | "opening" | "open" | "closing" | "crashed";
  binding: AgentWorkspaceBinding | null;
  sequence: number;
  snapshot: ResearchSnapshot | null;
  follow: boolean;
  refreshError: string | null;
  freshness: "current" | "stale" | "unavailable";
  currentTargets: ResearchAgentTargetReference[];
  inspectablePreviewJobIds: string[];
  presentation: AgentWorkspacePresentation;
  error: string | null;
  pendingCommands: number;
  pendingCommandId: string | null;
}
export interface AgentWorkspaceNavigationRequest {
  requestId: string;
  intent: "open-source" | "open-result" | "review-result" | "open-job" | "open-workflow" | "inspect-preview" | "configure-access";
  target?: ResearchAgentTargetReference;
}
export type AgentWorkspaceCommand = { commandId: string; binding: AgentWorkspaceBinding } & (
  | { kind: "control"; request: ResearchAgentControlRequest }
  | { kind: "navigate"; request: AgentWorkspaceNavigationRequest }
  | { kind: "follow"; follow: boolean }
);
export interface AgentWorkspaceCommandReceipt { commandId: string; sequence: number; accepted: true }
export type AgentWorkspaceCompletion = { commandId: string } & ({ ok: true } | { ok: false; error: string });
export interface AgentWorkspaceFlushRequest { binding: AgentWorkspaceBinding; flushId: string }

/** Dedicated IPC only. The popup never receives a generic research execute API. */
export interface AgentWorkspaceApi {
  state(): Promise<AgentWorkspaceState>;
  open(presentation?: AgentWorkspacePresentation): Promise<AgentWorkspaceState>;
  focus(): Promise<void>;
  restore(): Promise<AgentWorkspaceState>;
  dock(binding: AgentWorkspaceBinding): Promise<AgentWorkspaceState>;
  publish(binding: AgentWorkspaceBinding | null, state: AgentWorkspacePublishedState): Promise<AgentWorkspaceState>;
  updatePresentation(binding: AgentWorkspaceBinding, presentation: AgentWorkspacePresentation): Promise<AgentWorkspaceState>;
  control(binding: AgentWorkspaceBinding, request: ResearchAgentControlRequest): Promise<AgentWorkspaceCommandReceipt>;
  navigate(binding: AgentWorkspaceBinding, request: AgentWorkspaceNavigationRequest): Promise<AgentWorkspaceCommandReceipt>;
  setFollow(binding: AgentWorkspaceBinding, follow: boolean): Promise<AgentWorkspaceCommandReceipt>;
  complete(binding: AgentWorkspaceBinding, completion: AgentWorkspaceCompletion): Promise<void>;
  flushed(binding: AgentWorkspaceBinding, flushId: string, presentation: AgentWorkspacePresentation): Promise<void>;
  onState(listener: (state: AgentWorkspaceState) => void): () => void;
  onCommand(listener: (command: AgentWorkspaceCommand) => void): () => void;
  onFlush(listener: (request: AgentWorkspaceFlushRequest) => void): () => void;
}

declare global { interface Window { lociAgentWorkspace?: AgentWorkspaceApi } }
