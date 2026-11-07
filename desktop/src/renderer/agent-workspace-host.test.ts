import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSnapshotFence, AgentWorkspaceHost, waitForAgentNavigation, type AgentHostContext } from "./agent-workspace-host";
import type { AgentWorkspaceApi, AgentWorkspaceCommand, AgentWorkspaceNavigationRequest, AgentWorkspacePresentation, AgentWorkspaceState } from "../shared/agent-workspace-api";
import type { ResearchAgentControlRequest, ResearchSnapshot } from "../shared/research-contracts";
const snapshot = (title = "old") => ({ project: { project_id: "a".repeat(32), title }, sources: [], results: [], jobs: [] }) as unknown as ResearchSnapshot;
const empty: AgentWorkspacePresentation = { selectedTaskId: null, section: "overview", draft: null };
const binding = { projectId: "a".repeat(32), studyEpoch: 1, generation: 1 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
function setup() {
  let native: AgentWorkspaceState = { role: "main", status: "docked", binding, sequence: 1, snapshot: null,
    follow: false, refreshError: null, freshness: "current", currentTargets: [], inspectablePreviewJobIds: [], presentation: empty,
    error: null, pendingCommands: 0, pendingCommandId: null };
  let stateListener = (_state: AgentWorkspaceState) => undefined as void;
  let commandListener = (_command: AgentWorkspaceCommand) => undefined as void;
  let context: AgentHostContext = { scope: "first", switching: false, packet: { snapshot: snapshot(), follow: false, refreshError: null, currentTargets: [], inspectablePreviewJobIds: [] } };
  const order: string[] = [];
  const api = { state: vi.fn(async () => native),
    onState: vi.fn(listener => { stateListener = listener; return vi.fn(); }),
    onCommand: vi.fn(listener => { commandListener = listener; return vi.fn(); }),
    publish: vi.fn(async (_binding, packet) => { order.push(`publish:${packet.snapshot.project.title}`);
      native = { ...native, ...packet, sequence: native.sequence + 1 }; stateListener(native); return native; }),
    updatePresentation: vi.fn(async (_binding, presentation) => { native = { ...native, presentation, sequence: native.sequence + 1 }; stateListener(native); return native; }),
    open: vi.fn(async presentation => { native = { ...native, status: "open", binding: { ...binding, generation: 2 }, presentation, sequence: native.sequence + 1 }; stateListener(native); return native; }),
    restore: vi.fn(), focus: vi.fn(async () => undefined),
    complete: vi.fn(async (_binding, completion) => { order.push(`complete:${completion.ok}`); native = { ...native, pendingCommands: 0, pendingCommandId: null, sequence: native.sequence + 1 }; stateListener(native); }),
  } as unknown as AgentWorkspaceApi;
  const actions = { control: vi.fn(async (_request: ResearchAgentControlRequest, _current: () => boolean) => snapshot("fresh")),
    navigate: vi.fn(async (_request: AgentWorkspaceNavigationRequest, _current: () => boolean): Promise<void> => undefined),
    follow: vi.fn((follow: boolean) => { context = { ...context, packet: { ...context.packet!, follow } }; }) };
  const onState = vi.fn(), onPresentation = vi.fn(), onReturn = vi.fn(), onError = vi.fn();
  const host = new AgentWorkspaceHost({ api, context: () => context, actions: () => actions, onState, onPresentation, onReturn, onError });
  host.start();
  const emit = (patch: Partial<AgentWorkspaceState>) => { native = { ...native, ...patch, sequence: native.sequence + 1 }; stateListener(native); };
  const command = (body: Omit<Extract<AgentWorkspaceCommand, {kind: "control"}>, "binding" | "commandId"> |
    Omit<Extract<AgentWorkspaceCommand, {kind: "navigate"}>, "binding" | "commandId"> |
    Omit<Extract<AgentWorkspaceCommand, {kind: "follow"}>, "binding" | "commandId">) => {
    emit({ pendingCommands: 1, pendingCommandId: "command" });
    commandListener({ ...body, binding: native.binding!, commandId: "command" });
  };
  return { host, api, actions, order, onState, onPresentation, onReturn, onError, emit, command,
    context: () => context, setContext: (next: AgentHostContext) => { context = next; } };
}
afterEach(() => vi.unstubAllGlobals());
describe("snapshot version fence", () => {
  it("discards a poll started before a control even when it resolves after the reply", async () => {
    const fence = new AgentSnapshotFence(), pending = deferred<ResearchSnapshot>();
    const old = fence.read(() => pending.promise);
    expect(await fence.control(async () => snapshot("fresh"))).toEqual(snapshot("fresh"));
    pending.resolve(snapshot("old")); expect(await old).toBeNull();
    expect(await fence.read(async () => snapshot("newer"))).toEqual(snapshot("newer"));
  });
  it("rejects overlapping controls, skips polling and invalidates stale errors", async () => {
    const fence = new AgentSnapshotFence(), d = deferred<void>();
    const work = fence.control(async current => { await d.promise; return current(); });
    const read = vi.fn(); expect(await fence.read(read)).toBeNull(); expect(read).not.toHaveBeenCalled();
    await expect(fence.control(async () => true)).rejects.toThrow("current agent control");
    fence.invalidate(); d.resolve(); expect(await work).toBe(false);
    const error = deferred<ResearchSnapshot>(); const stale = fence.read(async () => { await error.promise; throw new Error("old error"); });
    fence.invalidate(); error.resolve(snapshot()); expect(await stale).toBeNull();
  });
});
describe("main agent workspace host", () => {
  it("publishes the returned control snapshot before acknowledging", async () => {
    const f = setup(); await settle(); f.order.length = 0;
    f.command({ kind: "control", request: { action: "pause_session", policy_sha256: "b".repeat(64) } });
    await settle(); expect(f.actions.control).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(["publish:fresh", "complete:true"]); f.host.dispose();
  });
  it("waits for real navigation completion instead of acknowledging selection enqueue", async () => {
    const f = setup(), rendered = deferred<void>(); await settle();
    f.actions.navigate.mockImplementation(async () => rendered.promise);
    f.command({ kind: "navigate", request: { requestId: "view", intent: "configure-access" } });
    await settle(); expect(f.api.complete).not.toHaveBeenCalled();
    rendered.resolve(); await settle(); expect(f.api.complete).toHaveBeenCalledWith(binding, { commandId: "command", ok: true }); f.host.dispose();
  });
  it("publishes follow state before successful completion", async () => {
    const f = setup(); await settle(); f.command({ kind: "follow", follow: true }); await settle();
    expect(vi.mocked(f.api.publish).mock.calls.at(-1)?.[1].follow).toBe(true);
    expect(f.order.at(-1)).toBe("complete:true"); f.host.dispose();
  });
  it("refuses a delayed command after same-path study replacement", async () => {
    const f = setup(), d = deferred<ResearchSnapshot>(); await settle();
    f.actions.control.mockImplementation(() => d.promise);
    f.command({ kind: "control", request: { action: "pause_session", policy_sha256: "b".repeat(64) } }); await settle();
    const guard = f.actions.control.mock.calls[0]?.[1];
    f.emit({ binding: null, pendingCommands: 0, pendingCommandId: null, snapshot: null });
    f.setContext({ ...f.context(), scope: "same-path-reopened" }); d.resolve(snapshot("stale")); await settle();
    expect(guard?.()).toBe(false); expect(f.api.complete).not.toHaveBeenCalled();
    expect(vi.mocked(f.api.publish).mock.calls.some(([, p]) => p.snapshot.project.title === "stale")).toBe(false); f.host.dispose();
  });
  it("revokes a command when the native pending command ID changes", async () => {
    const f = setup(), d = deferred<void>(); await settle(); f.actions.navigate.mockImplementation(() => d.promise);
    f.command({ kind: "navigate", request: { requestId: "view", intent: "configure-access" } }); await settle();
    f.emit({ pendingCommandId: "replacement" }); d.resolve(); await settle(); expect(f.api.complete).not.toHaveBeenCalled(); f.host.dispose();
  });
  it("hands off draft presentation and accepts the flushed draft when docked", async () => {
    const f = setup(); await settle();
    const presentation: AgentWorkspacePresentation = { selectedTaskId: "c".repeat(32), section: "plan", draft: { taskId: "c".repeat(32), baseRevision: 2, goal: "Edited goal", steps: [{ id: "step", title: "Inspect" }] } };
    f.host.changePresentation(presentation); await f.host.open();
    expect(f.api.open).toHaveBeenCalledWith(presentation);
    f.emit({ status: "docked", binding: { ...binding, generation: 3 }, presentation: { ...presentation, draft: { ...presentation.draft!, goal: "Popup edit" } } });
    expect(f.onPresentation.mock.lastCall?.[0].draft.goal).toBe("Popup edit"); expect(f.onReturn).toHaveBeenCalledTimes(1); f.host.dispose();
  });
  it("cannot publish a previous lifecycle's delayed initial state after StrictMode restart", async () => {
    const f = setup(), old = deferred<AgentWorkspaceState>(); f.host.dispose();
    vi.mocked(f.api.state).mockImplementationOnce(() => old.promise);
    f.host.start(); await settle(); f.host.dispose(); f.host.start(); await settle();
    const calls = vi.mocked(f.api.publish).mock.calls.length;
    old.resolve({ role: "main", binding: { ...binding, generation: 99 }, sequence: 999 } as AgentWorkspaceState); await settle();
    expect(f.api.publish).toHaveBeenCalledTimes(calls); expect(f.onState.mock.lastCall?.[0].binding.generation).toBe(1); f.host.dispose();
  });
});
describe("renderer navigation wait", () => {
  it("requires a later painted frame and rejects superseded intent", async () => {
    const frames: FrameRequestCallback[] = []; vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return 1; });
    let ready = false, current = true;
    const result = waitForAgentNavigation(() => ready, () => current);
    frames.shift()!(0); ready = true; frames.shift()!(1); await expect(result).resolves.toBeUndefined();
    const stale = waitForAgentNavigation(() => false, () => current); current = false; frames.shift()!(2);
    await expect(stale).rejects.toThrow("navigation intent changed");
  });
});
