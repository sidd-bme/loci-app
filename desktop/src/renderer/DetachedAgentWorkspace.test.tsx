// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentWorkspaceApi, AgentWorkspaceFlushRequest, AgentWorkspaceState } from "../shared/agent-workspace-api";
import type { ResearchAgentSessionsSnapshot } from "../shared/research-contracts";
import { DetachedAgentWorkspace } from "./DetachedAgentWorkspace";
import engineFixture from "./__fixtures__/agent-sessions-snapshot.json";

afterEach(() => { cleanup(); localStorage.clear(); });
const wire = engineFixture as ResearchAgentSessionsSnapshot;
const sourceId = "a".repeat(32), sourceHash = "b".repeat(64);
function initialState(): AgentWorkspaceState {
  const sessions = structuredClone(wire);
  sessions.approvals = [];
  sessions.events = [{ ...wire.events[0], id: "event-1", approval_id: null, operation: "inspect_source", kind: "operation_inspected",
    targets: [{ kind: "source", id: sourceId, sha256: sourceHash }], summary: "Inspected exact source" }];
  sessions.tasks = [{ id: "task-a", revision: 3, policy_sha256: wire.policies[0].policy_sha256,
    session_id: wire.sessions[0].session_id, client_id: "Codex", created_at: "2026-11-07", updated_at: "2026-11-07", updated_by: "agent",
    goal: "Inspect the source", state: "active", stale: false, targets: [], assessments: [],
    steps: [{ id: "step-a", title: "Inspect source", state: "planned", note: "", targets: [] }] }];
  return { role: "workspace", status: "open", binding: { projectId: "e".repeat(32), studyEpoch: 1, generation: 1 },
    sequence: 1, freshness: "current", follow: false, refreshError: null, error: null, pendingCommands: 0, pendingCommandId: null,
    currentTargets: [], inspectablePreviewJobIds: [], presentation: { selectedTaskId: null, section: "overview", draft: null },
    snapshot: { project: { project_id: "e".repeat(32), title: "Source study" },
      sources: [{ id: sourceId, sha256: sourceHash, name: "Exact source", metadata: {} }], results: [], jobs: [], samples: [],
      recipes: [], displays: [], selections: [], operations: {}, agent_sessions: sessions } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(state = initialState()) {
  let onState = (_value: AgentWorkspaceState) => {}, onFlush = (_value: AgentWorkspaceFlushRequest) => {};
  const receipt = { commandId: "command-1", sequence: 2, accepted: true as const };
  const api: AgentWorkspaceApi = {
    state: vi.fn().mockResolvedValue(state), open: vi.fn(), focus: vi.fn(), restore: vi.fn(), dock: vi.fn().mockResolvedValue(state),
    publish: vi.fn(), updatePresentation: vi.fn().mockResolvedValue(state), control: vi.fn().mockResolvedValue(receipt),
    navigate: vi.fn().mockResolvedValue(receipt), setFollow: vi.fn().mockResolvedValue(receipt), complete: vi.fn(), flushed: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn((callback: (state: AgentWorkspaceState) => void) => { onState = callback; return vi.fn(); }), onCommand: vi.fn(() => vi.fn()),
    onFlush: vi.fn((callback: (request: AgentWorkspaceFlushRequest) => void) => { onFlush = callback; return vi.fn(); }),
  };
  return { api, state, receipt, emit: (next: AgentWorkspaceState) => act(() => onState(next)), flush: (value: AgentWorkspaceFlushRequest) => act(() => onFlush(value)) };
}

describe("Detached agent workspace", () => {
  it("does not replace a newer native event with a delayed startup snapshot", async () => {
    const h = harness(), startup = deferred<AgentWorkspaceState>();
    vi.mocked(h.api.state).mockReturnValue(startup.promise);
    render(<DetachedAgentWorkspace api={h.api} />);
    const next = { ...h.state, sequence: 2, snapshot: { ...h.state.snapshot!, project: { ...h.state.snapshot!.project, title: "Current study" } } };
    h.emit(next);
    expect(screen.getByText("Current study")).toBeVisible();
    await act(async () => startup.resolve(h.state));
    expect(screen.getByText("Current study")).toBeVisible();
    expect(screen.queryByText("Source study")).not.toBeInTheDocument();
  });

  it("flushes the latest keystroke after queued presentation writes before native return", async () => {
    const h = harness(), firstWrite = deferred<AgentWorkspaceState>();
    vi.mocked(h.api.updatePresentation).mockReturnValueOnce(firstWrite.promise);
    render(<DetachedAgentWorkspace api={h.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit plan" }));
    await waitFor(() => expect(h.api.updatePresentation).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "My last unsaved keystroke" } });
    h.flush({ binding: h.state.binding!, flushId: "flush-1" });
    expect(h.api.flushed).not.toHaveBeenCalled();
    // The acknowledged previous edit must not replace the newer local input.
    h.emit({ ...h.state, sequence: 2, presentation: vi.mocked(h.api.updatePresentation).mock.calls[0][1] });
    expect(screen.getByLabelText("Goal")).toHaveValue("My last unsaved keystroke");
    await act(async () => firstWrite.resolve(h.state));
    await waitFor(() => expect(h.api.flushed).toHaveBeenCalledWith(h.state.binding, "flush-1", {
      selectedTaskId: "task-a", section: "overview", draft: { taskId: "task-a", baseRevision: 3, goal: "My last unsaved keystroke",
        steps: [{ id: "step-a", title: "Inspect source" }] },
    }));
    expect(h.api.control).not.toHaveBeenCalled();
  });

  it("keeps an unacknowledged draft after a failed write and later snapshot refresh", async () => {
    const h = harness();
    vi.mocked(h.api.updatePresentation).mockRejectedValue(new Error("Draft handoff unavailable."));
    render(<DetachedAgentWorkspace api={h.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit plan" }));
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Preserve this human draft" } });
    await screen.findByText("Draft handoff unavailable.");
    await waitFor(() => expect(h.api.updatePresentation).toHaveBeenCalledTimes(2));
    h.emit({ ...h.state, sequence: 3 });
    expect(screen.getByLabelText("Goal")).toHaveValue("Preserve this human draft");
  });

  it("shows evidence navigation in progress until the main renderer acknowledges the exact target", async () => {
    const h = harness(), completion = deferred<typeof h.receipt>();
    vi.mocked(h.api.navigate).mockReturnValue(completion.promise);
    render(<DetachedAgentWorkspace api={h.api} />);
    fireEvent.click(await screen.findByRole("button", { name: `Open source ${sourceId}` }));
    expect(h.api.navigate).toHaveBeenCalledWith(h.state.binding, { requestId: expect.any(String), intent: "open-source",
      target: { kind: "source", id: sourceId, sha256: sourceHash } });
    expect(screen.getByText("Opening recorded evidence in the workspace…")).toBeVisible();
    expect(screen.queryByText("Opened recorded evidence in the workspace.")).not.toBeInTheDocument();
    await act(async () => completion.resolve(h.receipt));
    expect(screen.getByText("Opened recorded evidence in the workspace.")).toBeVisible();
  });

  it("does not report an old command complete after the native study binding changes", async () => {
    const h = harness(), completion = deferred<typeof h.receipt>();
    vi.mocked(h.api.navigate).mockReturnValue(completion.promise);
    render(<DetachedAgentWorkspace api={h.api} />);
    fireEvent.click(await screen.findByRole("button", { name: `Open source ${sourceId}` }));
    h.emit({ ...h.state, sequence: 2, binding: { ...h.state.binding!, studyEpoch: 2, generation: 2 } });
    await act(async () => completion.resolve(h.receipt));
    expect(screen.queryByText("Opened recorded evidence in the workspace.")).not.toBeInTheDocument();
    expect(h.api.control).not.toHaveBeenCalled();
  });

  it("hands ordinary return to native without disconnecting the external session", async () => {
    const h = harness();
    render(<DetachedAgentWorkspace api={h.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Return to workspace" }));
    await waitFor(() => expect(h.api.dock).toHaveBeenCalledWith(h.state.binding));
    expect(h.api.control).not.toHaveBeenCalled();
  });

  it("uses the local appearance preferences and renders stale snapshots without live controls", async () => {
    localStorage.setItem("loci.preferences.v1", JSON.stringify({ theme: "paper", textSize: "large", motion: "reduced" }));
    const h = harness({ ...initialState(), freshness: "stale", refreshError: "Current study state is unavailable." });
    render(<DetachedAgentWorkspace api={h.api} />);
    expect(await screen.findByRole("checkbox", { name: "Follow agent" })).toBeDisabled();
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(document.documentElement.dataset.motion).toBe("reduced");
    const activity = screen.getByRole("region", { name: "Agent activity timeline" });
    expect(within(activity).getByRole("button", { name: `Open source ${sourceId}` })).toBeDisabled();
    expect(h.api.navigate).not.toHaveBeenCalled();
  });
});
