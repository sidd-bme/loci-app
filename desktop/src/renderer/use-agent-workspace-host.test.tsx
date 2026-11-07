// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentWorkspaceHost } from "./use-agent-workspace-host";
import type { AgentWorkspaceApi, AgentWorkspaceState } from "../shared/agent-workspace-api";
import type { AgentHostContext } from "./agent-workspace-host";
import type { ResearchSnapshot } from "../shared/research-contracts";
afterEach(cleanup);
it("survives StrictMode effect replay without publishing or reporting a disposed host", async () => {
  const snapshot = { project: { project_id: "a".repeat(32) }, sources: [], results: [], jobs: [] } as unknown as ResearchSnapshot;
  const context: AgentHostContext = { scope: "same-study", switching: false, packet: { snapshot, follow: false, refreshError: null, currentTargets: [], inspectablePreviewJobIds: [] } };
  let state: AgentWorkspaceState = { role: "main", status: "docked", binding: { projectId: snapshot.project.project_id!, studyEpoch: 0, generation: 0 },
    sequence: 0, snapshot: null, follow: false, refreshError: null, freshness: "unavailable", currentTargets: [], inspectablePreviewJobIds: [],
    presentation: { selectedTaskId: null, section: "overview", draft: null }, error: null, pendingCommands: 0, pendingCommandId: null };
  const api = { state: vi.fn(async () => state), onState: vi.fn(() => vi.fn()), onCommand: vi.fn(() => vi.fn()),
    publish: vi.fn(async (_binding: unknown, packet: NonNullable<AgentHostContext["packet"]>) => {
      state = { ...state, ...packet, sequence: state.sequence + 1 }; return state;
    }) } as unknown as AgentWorkspaceApi;
  const onError = vi.fn(), actions = { control: vi.fn(), navigate: vi.fn(), follow: vi.fn() };
  const view = renderHook(() => useAgentWorkspaceHost(api, context, actions, onError), { wrapper: StrictMode });
  await waitFor(() => expect(view.result.current.state?.snapshot?.project.project_id).toBe(snapshot.project.project_id));
  expect(onError).not.toHaveBeenCalled();
  expect(api.onCommand).toHaveBeenCalledTimes(2);
});
