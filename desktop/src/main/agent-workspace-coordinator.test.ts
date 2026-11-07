// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import type { ResearchSnapshot } from '../shared/research-contracts';
import type { AgentWorkspaceBinding, AgentWorkspaceCommand, AgentWorkspacePresentation, AgentWorkspacePublishedState, AgentWorkspaceState } from '../shared/agent-workspace-api';
import type { AgentWorkspaceLayout, AgentWorkspaceLayouts } from './agent-workspace-layout';

const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), displays: [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }], listeners: new Map<string, Set<() => void>>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => electron.handlers.set(name, fn) }, screen: { getAllDisplays: () => electron.displays,
  on: (name: string, listener: () => void) => { const listeners = electron.listeners.get(name) ?? new Set(); listeners.add(listener); electron.listeners.set(name, listeners); },
  removeListener: (name: string, listener: () => void) => electron.listeners.get(name)?.delete(listener),
} }));
vi.mock('./worker-client', () => ({ sanitizedWorkerErrorMessage: (value: unknown) => String(value).replace(/\/private\/\S+/gu, 'private location') }));
import { AgentWorkspaceCoordinator } from './agent-workspace-coordinator';
import { emptyPresentation, validateControl, validateNavigation, validatePresentation, validatePublished } from './agent-workspace-validation';
import { visibleAgentWorkspaceBounds } from './agent-workspace-layout';

const PROJECT = 'a'.repeat(32), SOURCE = 'b'.repeat(32), RESULT = 'c'.repeat(32), TASK = 'd'.repeat(32), HASH = 'e'.repeat(64), REVISION = 'f'.repeat(64);
class Sender extends EventEmitter {
  mainFrame = {}; destroyed = false; send = vi.fn();
  isDestroyed() { return this.destroyed; }
}
class Window extends EventEmitter {
  webContents = new Sender(); destroyed = false; bounds = { x: 10, y: 10, width: 1000, height: 700 };
  show = vi.fn(); focus = vi.fn(); setTitle = vi.fn();
  setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = { ...bounds }; });
  getNormalBounds() { return { ...this.bounds }; }
  isDestroyed() { return this.destroyed; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.webContents.destroyed = true; this.emit('closed'); } }
}
function snapshot(): ResearchSnapshot {
  return { project: { project_id: PROJECT, title: 'Native test study' }, sources: [{ id: SOURCE, sha256: HASH, name: 'Image', metadata: { dimensions: { x: 20, y: 16, z: 4, t: 1, c: 1 } } }],
    results: [{ id: RESULT, revision_hash: REVISION, source_id: SOURCE, source_sha256: HASH }], jobs: [], samples: [], recipes: [], displays: [], selections: [], operations: {} } as unknown as ResearchSnapshot;
}
function packet(presentation?: AgentWorkspacePresentation): AgentWorkspacePublishedState { return { snapshot: snapshot(), follow: false, refreshError: null, currentTargets: [], inspectablePreviewJobIds: [], ...(presentation ? { presentation } : {}) }; }
function draft(): AgentWorkspacePresentation { return { selectedTaskId: TASK, section: 'plan', draft: { taskId: TASK, baseRevision: 2, goal: 'Unsaved human goal', steps: [{ id: 'human-step', title: '' }] } }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const coordinators: AgentWorkspaceCoordinator[] = [];
function harness(layout?: AgentWorkspaceLayout) {
  electron.handlers.clear();
  electron.displays = [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }];
  const main = new Window(), windows: Window[] = [], callbacks = new Set<() => void>();
  let identity: string | null = '/private/Study.loci-study';
  const bridge = { getViewDocumentIdentity: () => identity, getViewSnapshot: vi.fn(async () => snapshot()), onViewDocumentChanged: (callback: () => void) => { callbacks.add(callback); return () => { callbacks.delete(callback); }; } };
  const layouts: AgentWorkspaceLayouts = { read: vi.fn(async () => layout ?? null), write: vi.fn(async () => {}) };
  const load = vi.fn(async () => {});
  const factory = vi.fn(() => { const window = new Window(); windows.push(window); return { window: window as unknown as BrowserWindow, load }; });
  const coordinator = new AgentWorkspaceCoordinator(bridge, factory, layouts, { command: 100, flush: 50 }); coordinators.push(coordinator);
  coordinator.registerMain(main as unknown as BrowserWindow); coordinator.registerIpc();
  const event = (window: Window, frame = window.webContents.mainFrame) => ({ sender: window.webContents as unknown as WebContents, senderFrame: frame } as IpcMainInvokeEvent);
  const call = async <T = AgentWorkspaceState>(window: Window, name: string, ...args: unknown[]): Promise<T> => electron.handlers.get('loci-agent-workspace:' + name)!(event(window), ...args) as Promise<T>;
  const replace = (next = identity) => { identity = next; for (const cb of callbacks) cb(); };
  return { main, windows, bridge, layouts, load, factory, coordinator, event, call, replace };
}
function lastCommand(main: Window): AgentWorkspaceCommand { return main.webContents.send.mock.calls.filter(([channel]) => channel === 'loci-agent-workspace:command').at(-1)![1]; }
function lastFlush(window: Window): { binding: AgentWorkspaceBinding; flushId: string } { return window.webContents.send.mock.calls.filter(([channel]) => channel === 'loci-agent-workspace:flush').at(-1)![1]; }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => { for (const coordinator of coordinators.splice(0)) coordinator.dispose(); vi.useRealTimers(); });

describe('native agent workspace authority and lifecycle', () => {
  it('rejects unregistered, image-like and subframe senders; only native role selection is authoritative', async () => {
    const h = harness(), unknown = new Window();
    await expect(h.call(unknown, 'state')).rejects.toThrow('capability');
    await expect(electron.handlers.get('loci-agent-workspace:state')!(h.event(h.main, {}))).rejects.toThrow('capability');
    const state = await h.call(h.main, 'open'), child = h.windows[0];
    expect(state.role).toBe('main'); expect((await h.call(child, 'state')).role).toBe('workspace');
    await expect(h.call(child, 'publish', state.binding, packet())).rejects.toThrow('capability');
    await expect(h.call(child, 'open')).rejects.toThrow('capability');
    await expect(h.call(child, 'complete', state.binding, { commandId: 'fake', ok: true })).rejects.toThrow('capability');
    expect([...electron.handlers.keys()].every(name => name.startsWith('loci-agent-workspace:'))).toBe(true);
    expect([...electron.handlers.keys()].some(name => name.endsWith(':execute'))).toBe(false);
    expect(JSON.stringify(state)).not.toContain('/private/');
  });
  it('verifies project identity natively, focuses duplicate opens, and preserves the active editor draft', async () => {
    const h = harness(); const opened = await h.call(h.main, 'open', draft());
    expect(h.bridge.getViewSnapshot).toHaveBeenCalledOnce();
    expect(opened.binding).toEqual({ projectId: PROJECT, studyEpoch: 0, generation: 1 });
    const changed = draft(); changed.draft!.goal = 'Popup version';
    await h.call(h.windows[0], 'presentation', opened.binding, changed);
    const duplicate = await h.call(h.main, 'open', emptyPresentation());
    expect(h.factory).toHaveBeenCalledOnce(); expect(h.windows[0].focus).toHaveBeenCalledTimes(2);
    expect(duplicate.presentation).toEqual(changed);
    await expect(h.call(h.main, 'publish', duplicate.binding, packet(emptyPresentation()))).rejects.toThrow('detached editor');
    await expect(h.call(h.main, 'presentation', duplicate.binding, draft())).rejects.toThrow('active editing host');
  });
  it('discards a native project verification that finishes after same-path study replacement', async () => {
    const h = harness(), read = deferred<ResearchSnapshot>(); h.bridge.getViewSnapshot.mockReturnValueOnce(read.promise);
    const opening = h.call(h.main, 'open'); const refused = expect(opening).rejects.toThrow('study changed');
    h.replace(); read.resolve(snapshot()); await refused; expect(h.factory).not.toHaveBeenCalled();
  });
  it('publishes monotonically and refuses a forged project or stale native binding', async () => {
    const h = harness(); const initial = await h.call(h.main, 'publish', null, packet());
    const second = await h.call(h.main, 'publish', initial.binding, packet()); expect(second.sequence).toBeGreaterThan(initial.sequence);
    const forged = packet(); forged.snapshot.project.project_id = '0'.repeat(32);
    await expect(h.call(h.main, 'publish', second.binding, forged)).rejects.toThrow('another study');
    h.replace(); await expect(h.call(h.main, 'publish', second.binding, packet())).rejects.toThrow('stale');
  });
  it('waits for main completion and a fresh control snapshot; malformed completion does not lose the pending promise', async () => {
    const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0]; let done = false;
    const action = h.call(popup, 'control', opened.binding, { action: 'pause_session', policy_sha256: HASH }).then(value => { done = true; return value; });
    await tick(); const command = lastCommand(h.main); expect(done).toBe(false);
    await expect(h.call(h.main, 'complete', opened.binding, { commandId: command.commandId, ok: true })).rejects.toThrow('updated durable snapshot');
    await expect(h.call(h.main, 'complete', opened.binding, { commandId: command.commandId, ok: false })).rejects.toThrow('failure');
    expect((await h.call(h.main, 'state')).pendingCommandId).toBe(command.commandId);
    await h.call(h.main, 'publish', opened.binding, packet()); await h.call(h.main, 'complete', opened.binding, { commandId: command.commandId, ok: true });
    expect(await action).toMatchObject({ accepted: true, commandId: command.commandId });
    expect((await h.call(popup, 'state')).pendingCommands).toBe(0);
  });
  it('publishes Follow before acknowledging, and propagates an explicit main refusal', async () => {
    const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0];
    const follow = h.call(popup, 'follow', opened.binding, true); await tick(); const cmd = lastCommand(h.main);
    await expect(h.call(h.main, 'complete', opened.binding, { commandId: cmd.commandId, ok: true })).rejects.toThrow('Follow state');
    await h.call(h.main, 'publish', opened.binding, { ...packet(), follow: true }); await h.call(h.main, 'complete', opened.binding, { commandId: cmd.commandId, ok: true }); await follow;
    const navigation = h.call(popup, 'navigate', opened.binding, { requestId: 'navigate-1', intent: 'configure-access' }); const refused = expect(navigation).rejects.toThrow('Finish drawing'); await tick();
    await h.call(h.main, 'complete', opened.binding, { commandId: lastCommand(h.main).commandId, ok: false, error: 'Finish drawing' }); await refused;
  });
  it('rejects substituted exact targets before notifying main and accepts the full current result identity', async () => {
    const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0];
    const target = { kind: 'result', id: RESULT, revision_hash: REVISION, source_id: SOURCE, source_sha256: HASH };
    await expect(h.call(popup, 'navigate', opened.binding, { requestId: 'n', intent: 'open-result', target: { ...target, revision_hash: '0'.repeat(64) } })).rejects.toThrow('stale');
    const navigation = h.call(popup, 'navigate', opened.binding, { requestId: 'exact', intent: 'open-result', target }); await tick();
    expect(lastCommand(h.main)).toMatchObject({ kind: 'navigate', request: { target } });
    await h.call(h.main, 'complete', opened.binding, { commandId: lastCommand(h.main).commandId, ok: true }); await navigation;
  });
  it('requires a positive draft flush before docking and returns the last acknowledgment to the docked host', async () => {
    const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0], presentation = draft();
    const docking = h.call(h.main, 'dock', opened.binding); await tick(); expect(popup.destroyed).toBe(false);
    const flush = lastFlush(popup);
    await expect(h.call(h.main, 'flushed', flush.binding, flush.flushId, presentation)).rejects.toThrow('another window');
    await h.call(popup, 'flushed', flush.binding, flush.flushId, presentation);
    const docked = await docking; expect(popup.destroyed).toBe(true); expect(docked.status).toBe('docked'); expect(docked.presentation).toEqual(presentation);
    expect(docked.binding!.generation).toBeGreaterThan(opened.binding!.generation);
    expect(docked.snapshot!.agent_sessions).toBe(opened.snapshot!.agent_sessions); // no session mutation API was called
  });
  it('ordinary OS close flushes instead of destroying an unacknowledged draft', async () => {
    const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0], preventDefault = vi.fn();
    popup.emit('close', { preventDefault }); await tick(); expect(preventDefault).toHaveBeenCalled(); expect(popup.destroyed).toBe(false);
    const flush = lastFlush(popup); await h.call(popup, 'flushed', flush.binding, flush.flushId, draft()); await tick();
    expect(popup.destroyed).toBe(true); expect((await h.call(h.main, 'state')).presentation).toEqual(draft());
    await expect(h.call(h.main, 'dock', opened.binding)).rejects.toThrow('stale');
  });
  it('keeps the native window open on a missing draft acknowledgment and refuses close while a command is pending', async () => {
    vi.useFakeTimers(); const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0];
    const docking = h.call(h.main, 'dock', opened.binding); const refused = expect(docking).rejects.toThrow('not acknowledged');
    await tick(); await vi.advanceTimersByTimeAsync(51); await refused; expect(popup.destroyed).toBe(false); expect((await h.call(h.main, 'state')).status).toBe('open');
    const action = h.call(popup, 'follow', opened.binding, true); const cancelled = expect(action).rejects.toThrow('study changed'); await tick();
    await expect(h.call(h.main, 'dock', opened.binding)).rejects.toThrow('current agent workspace action');
    h.replace(); await cancelled;
  });
  it('revokes a command on renderer crash, keeps acknowledged draft, and refuses stale completions after reopen', async () => {
    const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0];
    await h.call(popup, 'presentation', opened.binding, draft());
    const action = h.call(popup, 'follow', opened.binding, true); const refused = expect(action).rejects.toThrow('renderer stopped'); await tick(); const command = lastCommand(h.main);
    popup.webContents.emit('render-process-gone'); await refused;
    const crashed = await h.call(h.main, 'state'); expect(crashed.status).toBe('crashed'); expect(crashed.presentation).toEqual(draft());
    await expect(h.call(h.main, 'complete', command.binding, { commandId: command.commandId, ok: true })).rejects.toThrow('stale');
    const reopened = await h.call(h.main, 'open'); expect(h.factory).toHaveBeenCalledOnce(); expect(reopened.binding!.generation).toBeGreaterThan(opened.binding!.generation);
    await expect(h.call(popup, 'presentation', opened.binding, draft())).rejects.toThrow('stale');
  });
  it('main closure revokes the popup and every pending completion without touching external sessions', async () => {
    const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0];
    const action = h.call(popup, 'follow', opened.binding, true); const refused = expect(action).rejects.toThrow('main workspace closed'); await tick();
    h.main.destroy(); await refused; expect(popup.destroyed).toBe(true);
    await expect(h.call(popup, 'state')).rejects.toThrow('capability');
  });
  it('restores a local arrangement within the remaining display when Sidecar is absent', async () => {
    const saved: AgentWorkspaceLayout = { schema: 'loci.agent-workspace-layout/v1', bounds: { x: 5000, y: 400, width: 1100, height: 800 } };
    const h = harness(saved); await h.call(h.main, 'restore');
    expect(h.windows[0].setBounds).toHaveBeenCalledWith({ x: 340, y: 100, width: 1100, height: 800 });
    expect(h.layouts.write).toHaveBeenCalled();
    expect(visibleAgentWorkspaceBounds(saved.bounds, [{ x: 0, y: 0, width: 1440, height: 900 }])).toEqual({ x: 340, y: 100, width: 1100, height: 800 });
  });
  it('moves an already-open window back on screen after Sidecar removal and unregisters display listeners', async () => {
    const h = harness(); await h.call(h.main, 'open'); const popup = h.windows[0];
    popup.bounds = { x: 2000, y: 20, width: 1000, height: 700 };
    for (const listener of electron.listeners.get('display-removed') ?? []) listener();
    expect(popup.bounds).toEqual({ x: 440, y: 20, width: 1000, height: 700 });
    expect(popup.focus).toHaveBeenCalledTimes(1);
    electron.displays = [{ workArea: { x: 0, y: 0, width: 900, height: 700 } }];
    for (const listener of electron.listeners.get('display-metrics-changed') ?? []) listener();
    expect(popup.bounds).toEqual({ x: 0, y: 0, width: 900, height: 700 });
    h.coordinator.dispose(); expect(electron.listeners.get('display-removed')?.size).toBe(0); expect(electron.listeners.get('display-metrics-changed')?.size).toBe(0);
  });
  it('failed shutdown flush leaves the window and acknowledged draft viable for continued work', async () => {
    vi.useFakeTimers(); const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0];
    await h.call(popup, 'presentation', opened.binding, draft());
    const quitting = h.coordinator.dockForShutdown(); const refused = expect(quitting).rejects.toThrow('not acknowledged');
    await tick(); await vi.advanceTimersByTimeAsync(51); await refused;
    expect(popup.destroyed).toBe(false); const state = await h.call(h.main, 'state'); expect(state.status).toBe('open'); expect(state.presentation).toEqual(draft());
    const changed = draft(); changed.draft!.goal = 'Continued after cancelled quit';
    expect((await h.call(popup, 'presentation', opened.binding, changed)).presentation).toEqual(changed);
    expect((await h.call(h.main, 'open')).status).toBe('open');
  });
  it('fences detached reopening throughout project save and restores it when quit is cancelled', async () => {
    const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0];
    const quitting = h.coordinator.dockForShutdown(); await tick();
    await expect(h.call(h.main, 'open')).rejects.toThrow('preparing to quit');
    await expect(h.call(popup, 'follow', opened.binding, true)).rejects.toThrow('preparing to quit');
    const flush = lastFlush(popup); await h.call(popup, 'flushed', flush.binding, flush.flushId, draft()); await quitting;
    const docked = await h.call(h.main, 'state'); expect(docked.presentation).toEqual(draft());
    await expect(h.call(h.main, 'open')).rejects.toThrow('preparing to quit');
    await expect(h.call(h.main, 'restore')).rejects.toThrow('preparing to quit');
    expect((await h.call(h.main, 'publish', docked.binding, packet())).status).toBe('docked');
    h.coordinator.cancelShutdown();
    const reopened = await h.call(h.main, 'open'); expect(reopened.status).toBe('open'); expect(reopened.presentation).toEqual(draft());
  });
  it('clears a failed OS-close warning after a successful draft handoff', async () => {
    vi.useFakeTimers(); const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0];
    popup.emit('close', { preventDefault: vi.fn() }); await tick(); await vi.advanceTimersByTimeAsync(51);
    expect((await h.call(h.main, 'state')).error).toContain('not acknowledged');
    const docking = h.call(h.main, 'dock', opened.binding); await tick();
    const flush = lastFlush(popup); await h.call(popup, 'flushed', flush.binding, flush.flushId, draft());
    expect((await docking).error).toBeNull();
  });
  it('revokes stale authority on a main renderer reload and retains the last acknowledged presentation', async () => {
    const h = harness(), opened = await h.call(h.main, 'open'), popup = h.windows[0];
    await h.call(popup, 'presentation', opened.binding, draft());
    h.main.webContents.emit('did-start-navigation', { isMainFrame: true }, 'app://same', false, true);
    expect(popup.destroyed).toBe(true);
    const state = await h.call(h.main, 'state'); expect(state.binding).toBeNull(); expect(state.presentation).toEqual(draft());
    await expect(h.call(h.main, 'publish', opened.binding, packet())).rejects.toThrow('stale');
  });
  it('rejects a failed command delivery immediately without leaving a blocked workspace', async () => {
    const h = harness(), opened = await h.call(h.main, 'open');
    h.main.webContents.send.mockImplementation(channel => { if (channel === 'loci-agent-workspace:command') throw new Error('Renderer cannot receive'); });
    await expect(h.call(h.windows[0], 'follow', opened.binding, true)).rejects.toThrow('cannot receive');
    expect((await h.call(h.main, 'state')).pendingCommands).toBe(0);
  });
});

describe('bounded presentation and request validation', () => {
  it('keeps blank unsaved edits while rejecting duplicate steps, wrong task identity and excessive state', () => {
    expect(validatePresentation(draft())).toEqual(draft());
    const duplicate = draft(); duplicate.draft!.steps.push({ ...duplicate.draft!.steps[0] }); expect(() => validatePresentation(duplicate)).toThrow();
    const wrong = draft(); wrong.selectedTaskId = RESULT; expect(() => validatePresentation(wrong)).toThrow();
    const huge = draft(); huge.draft!.goal = 'x'.repeat(2001); expect(() => validatePresentation(huge)).toThrow();
    expect(() => validatePresentation({ ...draft(), path: '/private' })).toThrow();
  });
  it('rejects generic operations, filesystem injection and incomplete exact navigation', () => {
    expect(() => validateControl({ action: 'execute', operation: 'run_recipe' })).toThrow();
    expect(() => validateControl({ action: 'pause_session', policy_sha256: HASH, project: '/private' })).toThrow();
    expect(() => validateNavigation({ requestId: 'id', intent: 'open-result', target: { kind: 'result', id: RESULT } })).toThrow();
    expect(() => validateNavigation({ requestId: 'id', intent: 'configure-access', target: { kind: 'source', id: SOURCE, sha256: HASH } })).toThrow();
  });
  it('bounds snapshots and rejects nonfinite or forged published state', () => {
    expect(() => validatePublished({ ...packet(), follow: 'yes' })).toThrow();
    const nonfinite = packet(); (nonfinite.snapshot as unknown as Record<string, unknown>).scientific_value = NaN; expect(() => validatePublished(nonfinite)).toThrow('Non-finite');
    const huge = packet(); huge.refreshError = 'x'.repeat(1001); expect(() => validatePublished(huge)).toThrow();
  });
});
