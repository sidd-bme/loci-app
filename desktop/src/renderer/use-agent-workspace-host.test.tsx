// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentWorkspaceHost } from "./use-agent-workspace-host";
import type { AgentWorkspaceApi, AgentWorkspaceState } from "../shared/agent-workspace-api";
import type { AgentHostContext } from "./agent-workspace-host";
import type { ResearchSnapshot } from "../shared/research-contracts";
afterEach(cleanup);

function fixture() {
  const projectId = "b".repeat(32);
  const snapshot = { project: { project_id: projectId, title: "Old view" }, sources: [], results: [], jobs: [] } as unknown as ResearchSnapshot;
  const context: AgentHostContext = { scope: "study-before-return", switching: false,
    packet: { snapshot, follow: false, refreshError: null, currentTargets: [], inspectablePreviewJobIds: [] } };
  let state: AgentWorkspaceState = { role: "main", status: "docked", binding: { projectId, studyEpoch: 0, generation: 0 },
    sequence: 0, snapshot: null, follow: false, refreshError: null, freshness: "unavailable", currentTargets: [], inspectablePreviewJobIds: [],
    presentation: { selectedTaskId: null, section: "overview", draft: null }, error: null, pendingCommands: 0, pendingCommandId: null };
  let receive: (value: AgentWorkspaceState) => void = () => {};
  const api = {
    state: vi.fn(async () => state),
    onState: vi.fn((listener: typeof receive) => { receive = listener; return vi.fn(); }),
    onCommand: vi.fn(() => vi.fn()),
    focus: vi.fn(async () => {}),
    publish: vi.fn(async (binding: AgentWorkspaceState["binding"], packet: NonNullable<AgentHostContext["packet"]>) => {
      if (binding !== state.binding) throw new Error("The native study binding is stale.");
      state = { ...state, ...packet, binding: state.binding ?? { projectId, studyEpoch: 1, generation: 1 },
        sequence: state.sequence + 1 }; return state;
    }),
  } satisfies Partial<AgentWorkspaceApi>;
  const onError = vi.fn(), actions = { control: vi.fn(), navigate: vi.fn(), follow: vi.fn() };
  const invalidate = (notify = true) => {
    state = { ...state, binding: null, snapshot: null, sequence: state.sequence + 1 };
    if (notify) receive(state);
  };
  const mount = (initial: AgentHostContext) => renderHook(
    (current: AgentHostContext) => useAgentWorkspaceHost(api as unknown as AgentWorkspaceApi, current, actions, onError),
    { initialProps: initial },
  );
  return { api, context, onError, invalidate, mount };
}

it("resumes passive publication after starting while the workbench is hidden", async () => {
  const f = fixture();
  const view = f.mount({ ...f.context, switching: true });
  await act(async () => {});
  expect(f.api.state).not.toHaveBeenCalled();
  expect(f.api.publish).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
  view.rerender(f.context);
  await waitFor(() => expect(view.result.current.state?.snapshot?.project.title).toBe("Old view"));
  expect(f.onError).not.toHaveBeenCalled();
});

it("quietly defers an invalidated same-project binding until the owner confirms a fresh study scope", async () => {
  const f = fixture();
  const view = f.mount(f.context);
  await waitFor(() => expect(view.result.current.state?.snapshot?.project.title).toBe("Old view"));
  view.rerender({ ...f.context, switching: true });
  act(() => f.invalidate());
  const count = f.api.publish.mock.calls.length;
  view.rerender(f.context);
  await act(async () => {});
  expect(f.api.publish).toHaveBeenCalledTimes(count);
  expect(f.onError).not.toHaveBeenCalled();
  const snapshot = { ...f.context.packet!.snapshot, project: { ...f.context.packet!.snapshot.project, title: "Refreshed view" } };
  view.rerender({ scope: "study-after-confirmed-return", switching: false, packet: { ...f.context.packet!, snapshot } });
  await waitFor(() => expect(view.result.current.state?.snapshot?.project.title).toBe("Refreshed view"));
  expect(view.result.current.state?.binding?.studyEpoch).toBe(1);
  expect(f.onError).not.toHaveBeenCalled();
});

it("reports an explicit action blocked by a retired scope and never calls native focus", async () => {
  const f = fixture();
  const view = f.mount(f.context);
  await waitFor(() => expect(view.result.current.state?.binding).not.toBeNull());
  act(() => f.invalidate());
  await act(async () => { await view.result.current.focus(); });
  expect(f.api.focus).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenCalledExactlyOnceWith("The study changed or is still opening.");
});

it("retries the refreshed scope if old native state was read but never acknowledged", async () => {
  const f = fixture();
  let rejectOld!: (error: Error) => void;
  f.api.publish.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
  const view = f.mount(f.context);
  await waitFor(() => expect(f.api.publish).toHaveBeenCalledOnce());
  f.invalidate(false);
  const snapshot = { ...f.context.packet!.snapshot, project: { ...f.context.packet!.snapshot.project, title: "New view" } };
  view.rerender({ scope: "new-scope", switching: false, packet: { ...f.context.packet!, snapshot } });
  await act(async () => rejectOld(new Error("The native study binding is stale.")));
  await waitFor(() => expect(view.result.current.state?.snapshot?.project.title).toBe("New view"));
  expect(f.onError).not.toHaveBeenCalled();
});

it("reports a native publication failure while the current owner is ready", async () => {
  const f = fixture();
  const view = f.mount(f.context);
  await waitFor(() => expect(view.result.current.state?.snapshot?.project.title).toBe("Old view"));
  f.api.publish.mockRejectedValue(new Error("The agent workspace lost its native connection."));
  view.rerender({ ...f.context, packet: { ...f.context.packet!, follow: true } });
  await waitFor(() => expect(f.onError).toHaveBeenCalledWith("The agent workspace lost its native connection."));
});

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
