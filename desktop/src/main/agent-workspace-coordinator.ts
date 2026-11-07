import { randomUUID } from "node:crypto";
import { ipcMain, screen, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { ResearchSnapshot } from "../shared/research-contracts";
import type { AgentWorkspaceBinding, AgentWorkspaceCommand, AgentWorkspaceCommandReceipt, AgentWorkspacePresentation, AgentWorkspacePublishedState, AgentWorkspaceState } from "../shared/agent-workspace-api";
import { assertNavigationCurrent, emptyPresentation, object, exact, validateBinding, validateControl, validateNavigation, validatePresentation, validatePublished } from "./agent-workspace-validation";
import { visibleAgentWorkspaceBounds, type AgentWorkspaceLayout, type AgentWorkspaceLayouts } from "./agent-workspace-layout";
import { sanitizedWorkerErrorMessage } from "./worker-client";

export interface AgentWorkspaceBridge {
  getViewDocumentIdentity(): string | null;
  getViewSnapshot(): Promise<ResearchSnapshot>;
  onViewDocumentChanged(listener: () => void): () => void;
}
export interface AgentWorkspaceWindowFactory { (): { window: BrowserWindow; load: () => Promise<void> } }
interface Popup { window: BrowserWindow; sender: WebContents; load: () => Promise<void>; identity: string }
interface PendingCommand { command: AgentWorkspaceCommand; sender: WebContents; frame: IpcMainInvokeEvent['senderFrame']; dataSequence: number; timer: NodeJS.Timeout; resolve: (receipt: AgentWorkspaceCommandReceipt) => void; reject: (error: Error) => void }
interface PendingFlush { flushId: string; binding: AgentWorkspaceBinding; timer: NodeJS.Timeout; resolve: () => void; reject: (error: Error) => void }

/** One study-bound human workspace; no image targeting, MCP process or generic execution capability. */
export class AgentWorkspaceCoordinator {
  private main: BrowserWindow | null = null;
  private popup: Popup | null = null;
  private identity: string | null;
  private projectId: string | null = null;
  private studyEpoch = 0;
  private generation = 0;
  private sequence = 0;
  private dataSequence = 0;
  private status: AgentWorkspaceState['status'] = 'docked';
  private packet: AgentWorkspacePublishedState | null = null;
  private presentation = emptyPresentation();
  private readonly presentations = new Map<string, AgentWorkspacePresentation>();
  private pending: PendingCommand | null = null;
  private flush: PendingFlush | null = null;
  private error: string | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private layoutTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private shuttingDown = false;
  private displayEventsRegistered = false;
  private readonly displayChanged = () => {
    const entry = this.popup;
    if (!entry || entry.window.isDestroyed()) return;
    try {
      const before = entry.window.getNormalBounds();
      const next = visibleAgentWorkspaceBounds(before, screen.getAllDisplays().map(d => d.workArea));
      if (['x', 'y', 'width', 'height'].some(key => before[key as keyof typeof before] !== next[key as keyof typeof next])) {
        entry.window.setBounds(next); this.queueLayout(entry);
      }
    } catch { this.error = 'The agent window could not be positioned on an available display.'; this.notify(); }
  };
  private readonly unsubscribe: () => void;
  constructor(private readonly bridge: AgentWorkspaceBridge, private readonly factory: AgentWorkspaceWindowFactory, private readonly layouts?: AgentWorkspaceLayouts,
    private readonly timeouts = { command: 30000, flush: 5000 }) {
    this.identity = bridge.getViewDocumentIdentity();
    this.unsubscribe = bridge.onViewDocumentChanged(() => this.revoke('The active study changed.'));
  }
  registerMain(window: BrowserWindow): void {
    if (this.main && !this.main.isDestroyed()) throw new Error('The main workspace is already registered.');
    this.main = window;
    // registerMain runs after app readiness; Electron screen is unavailable earlier.
    if (!this.displayEventsRegistered) {
      screen.on('display-removed', this.displayChanged);
      screen.on('display-metrics-changed', this.displayChanged);
      this.displayEventsRegistered = true;
    }
    window.on('closed', () => { if (this.main === window) { this.main = null; this.revoke('The main workspace closed.'); } });
    window.webContents.on('render-process-gone', () => { if (this.main === window) this.revoke('The main workspace renderer stopped.'); });
    window.webContents.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
      if (this.main === window && this.projectId && (details.isMainFrame ?? isMainFrame) !== false && !isInPlace) this.revoke('The main workspace renderer reloaded.');
    });
  }
  private currentIdentity(): string | null {
    const actual = this.bridge.getViewDocumentIdentity();
    if (actual !== this.identity) this.revoke('The active study changed.');
    return actual;
  }
  private binding(): AgentWorkspaceBinding | null { return this.projectId ? { projectId: this.projectId, studyEpoch: this.studyEpoch, generation: this.generation } : null; }
  private sender(event: IpcMainInvokeEvent, mainOnly = false): WebContents {
    const s = event.sender;
    if (this.disposed || s.isDestroyed() || event.senderFrame !== s.mainFrame || !this.main || this.main.isDestroyed() ||
      (s !== this.main.webContents && (mainOnly || s !== this.popup?.sender))) throw new Error('This window cannot use the agent workspace capability.');
    return s;
  }
  private assertBinding(event: IpcMainInvokeEvent, value: unknown, mainOnly = false): AgentWorkspaceBinding {
    this.sender(event, mainOnly); this.currentIdentity(); const binding = validateBinding(value), current = this.binding();
    if (!current || JSON.stringify(current) !== JSON.stringify(binding)) throw new Error('The agent workspace binding is stale.');
    return binding;
  }
  private state(sender: WebContents): AgentWorkspaceState {
    return structuredClone({ role: sender === this.main?.webContents ? 'main' : 'workspace', status: this.status, binding: this.binding(), sequence: this.sequence,
      snapshot: this.packet?.snapshot ?? null, follow: this.packet?.follow ?? false, refreshError: this.packet?.refreshError ?? null,
      freshness: !this.packet ? 'unavailable' : this.packet.refreshError ? 'stale' : 'current', currentTargets: this.packet?.currentTargets ?? [],
      inspectablePreviewJobIds: this.packet?.inspectablePreviewJobIds ?? [], presentation: this.presentation, error: this.error,
      pendingCommands: this.pending ? 1 : 0, pendingCommandId: this.pending?.command.commandId ?? null });
  }
  private notify(): void {
    this.sequence++;
    for (const sender of [this.main?.webContents, this.popup?.sender]) if (sender && !sender.isDestroyed() && !(sender === this.popup?.sender && this.status === 'crashed')) {
      try { sender.send('loci-agent-workspace:state-changed', this.state(sender)); }
      catch { this.error = 'A workspace renderer is unavailable for state updates.'; }
    }
  }
  private retain(): void { if (this.identity) this.presentations.set(this.identity, structuredClone(this.presentation)); }
  private cancelPending(message: string): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error(message)); this.pending = null; }
    if (this.flush) { clearTimeout(this.flush.timer); this.flush.reject(new Error(message)); this.flush = null; }
  }
  private revoke(message: string): void {
    this.retain(); this.cancelPending(message); this.studyEpoch++; this.generation++; this.projectId = null;
    this.identity = this.bridge.getViewDocumentIdentity(); this.packet = null;
    this.presentation = structuredClone(this.identity ? this.presentations.get(this.identity) ?? emptyPresentation() : emptyPresentation());
    const old = this.popup; if (this.layoutTimer) clearTimeout(this.layoutTimer); this.layoutTimer = null;
    if (old) void this.persistLayout(old);
    this.popup = null; this.status = 'docked'; this.error = null; this.opening = null; this.closing = null;
    if (old && !old.window.isDestroyed()) old.window.destroy(); this.notify();
  }
  private async establish(event: IpcMainInvokeEvent): Promise<void> {
    this.sender(event, true); const identity = this.currentIdentity(), epoch = this.studyEpoch;
    if (!identity) throw new Error('Open a study before opening the agent workspace.');
    if (this.projectId) return;
    const snapshot = await this.bridge.getViewSnapshot();
    this.sender(event, true);
    if (this.currentIdentity() !== identity || this.studyEpoch !== epoch) throw new Error('The study changed while verifying the agent workspace.');
    const projectId = snapshot.project.project_id;
    if (typeof projectId !== 'string' || !/^[a-f0-9]{32}$/u.test(projectId)) throw new Error('The native study has no verified project identity.');
    this.projectId = projectId;
    if (!this.packet) this.packet = validatePublished({ snapshot, follow: false, refreshError: null, currentTargets: [], inspectablePreviewJobIds: [] });
    this.notify();
  }
  private persistLayout(entry: Popup): Promise<void> {
    if (!this.layouts || entry.window.isDestroyed()) return Promise.resolve();
    return this.layouts.write(entry.identity, { schema: 'loci.agent-workspace-layout/v1', bounds: entry.window.getNormalBounds() }).catch(() => {
      if (this.popup === entry) { this.error = 'Could not save the local agent window arrangement.'; this.notify(); }
    });
  }
  private queueLayout(entry: Popup): void {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => { this.layoutTimer = null; void this.persistLayout(entry); }, 250);
  }
  private async open(event: IpcMainInvokeEvent, presentation?: unknown, restore = false): Promise<AgentWorkspaceState> {
    this.sender(event, true); this.currentIdentity(); this.sender(event, true);
    if (this.shuttingDown) throw new Error('Loci is preparing to quit. Keep working before opening the agent workspace.');
    if (this.opening) { const identity = this.identity, epoch = this.studyEpoch; await this.opening; this.sender(event, true); this.currentIdentity(); if (!this.popup || this.identity !== identity || this.studyEpoch !== epoch) throw new Error('The agent workspace changed while opening.'); this.popup.window.show(); this.popup.window.focus(); return this.state(event.sender); }
    if (this.popup && this.status !== 'crashed') { this.popup.window.show(); this.popup.window.focus(); return this.state(event.sender); }
    const work = async () => {
      await this.establish(event); const binding = this.binding()!, identity = this.identity!;
      if (!this.popup && presentation !== undefined) { this.presentation = validatePresentation(presentation); this.retain(); }
      let saved: AgentWorkspaceLayout | null = null, layoutError: string | null = null;
      try { saved = this.layouts ? await this.layouts.read(identity) : null; }
      catch (error) { if (restore) throw error; layoutError = 'The saved agent window arrangement is unavailable. The default position is used.'; }
      this.assertBinding(event, binding, true);
      if (restore && !saved) throw new Error('There is no saved agent workspace arrangement for this study.');
      let entry = this.popup;
      if (!entry) {
        const shell = this.factory(); entry = { ...shell, sender: shell.window.webContents, identity }; this.popup = entry; this.generation++;
        if (saved) entry.window.setBounds(visibleAgentWorkspaceBounds(saved.bounds, screen.getAllDisplays().map(d => d.workArea)));
        const owned = entry;
        owned.window.setTitle('Loci · Agent workspace');
        owned.window.on('move', () => this.queueLayout(owned));
        owned.window.on('resize', () => this.queueLayout(owned));
        owned.window.on('close', (ev: { preventDefault(): void }) => { if (this.popup !== owned) return; ev.preventDefault(); void this.dockInternal().catch(error => { if (this.popup === owned) { this.error = this.safe(error); this.notify(); } }); });
        owned.window.on('closed', () => { if (this.popup === owned) { this.popup = null; this.generation++; this.status = 'docked'; this.cancelPending('The agent workspace closed.'); this.notify(); } });
        owned.sender.on('render-process-gone', () => { if (this.popup !== owned) return; this.generation++; this.cancelPending('The agent workspace renderer stopped.'); this.status = 'crashed'; this.error = 'The agent workspace stopped. The last acknowledged draft is retained; reopen or return it to the main workspace.'; this.notify(); });
        owned.sender.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
          if (this.popup !== owned || this.status === 'opening' || (details.isMainFrame ?? isMainFrame) === false || isInPlace) return;
          this.generation++; this.cancelPending('The agent workspace renderer reloaded.'); this.status = 'opening'; this.notify();
        });
        owned.sender.on('did-finish-load', () => {
          if (this.popup === owned && this.status === 'opening' && !this.opening) { this.status = 'open'; this.notify(); }
        });
      }
      this.status = 'opening'; this.notify(); const generation = this.generation;
      try { await entry.load(); }
      catch (error) { if (this.popup === entry) { this.popup = null; this.generation++; this.status = 'docked'; if (!entry.window.isDestroyed()) entry.window.destroy(); this.notify(); } throw error; }
      this.sender(event, true); this.currentIdentity();
      if (this.popup !== entry || this.generation !== generation || this.studyEpoch !== binding.studyEpoch || this.identity !== identity) throw new Error('The agent workspace changed while loading.');
      this.status = 'open'; this.error = layoutError; entry.window.show(); entry.window.focus(); await this.persistLayout(entry);
      this.assertBinding(event, { ...binding, generation }, true);
      if (this.popup !== entry) throw new Error('The agent window changed while restoring its arrangement.');
      this.notify();
    };
    const promise = work(); this.opening = promise;
    try { await promise; return this.state(event.sender); } finally { if (this.opening === promise) this.opening = null; }
  }
  private async dockInternal(): Promise<void> {
    if (this.closing) return this.closing;
    const entry = this.popup; if (!entry) return;
    if (this.pending || this.status === 'opening') throw new Error('Wait for the current agent workspace action before returning the window.');
    const work = async () => {
      const binding = this.binding()!, generation = this.generation;
      if (this.status !== 'crashed') {
        this.status = 'closing'; this.notify();
        try { await new Promise<void>((resolve, reject) => { const flushId = randomUUID(); const timer = setTimeout(() => { if (this.flush?.flushId === flushId) { this.flush = null; reject(new Error('The local draft was not acknowledged. The agent window remains open; retry returning it.')); } }, this.timeouts.flush); this.flush = { flushId, binding, timer, resolve, reject }; entry.sender.send('loci-agent-workspace:flush', { binding, flushId }); }); }
        catch (error) { if (this.popup === entry && this.generation === generation) { this.status = 'open'; this.notify(); } throw error; }
      }
      await this.persistLayout(entry); this.currentIdentity();
      if (this.popup !== entry || this.generation !== generation || this.studyEpoch !== binding.studyEpoch) throw new Error('The study or agent window changed while returning the draft.');
      this.retain(); this.popup = null; this.generation++; this.status = 'docked'; this.error = null; this.cancelPending('The agent workspace returned to the main window.');
      if (!entry.window.isDestroyed()) entry.window.destroy(); this.notify();
    };
    const promise = work(); this.closing = promise;
    try { await promise; } finally { if (this.closing === promise) this.closing = null; }
  }
  private dispatch(event: IpcMainInvokeEvent, value: unknown, data: Omit<AgentWorkspaceCommand, 'commandId' | 'binding'>): Promise<AgentWorkspaceCommandReceipt> {
    const binding = this.assertBinding(event, value);
    if (this.shuttingDown) throw new Error('Loci is preparing to quit. Keep working before sending another agent workspace action.');
    if (event.sender !== this.popup?.sender || this.status !== 'open' || !this.packet || this.packet.refreshError) throw new Error('The agent workspace must be current and available before sending an action.');
    if (this.pending) throw new Error('Wait for the pending agent workspace action.');
    const command = { commandId: randomUUID(), binding, ...data } as AgentWorkspaceCommand;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending?.command.commandId === command.commandId) { this.pending = null; this.error = 'The main workspace did not acknowledge the action.'; this.notify(); reject(new Error(this.error)); } }, this.timeouts.command);
      this.pending = { command, sender: event.sender, frame: event.senderFrame, dataSequence: this.dataSequence, timer, resolve, reject }; this.notify();
      try { this.main!.webContents.send('loci-agent-workspace:command', command); }
      catch (error) { clearTimeout(timer); this.pending = null; this.error = 'The main workspace could not receive the action.'; this.notify(); reject(new Error(this.safe(error))); }
    });
  }
  private safe(error: unknown): string { return sanitizedWorkerErrorMessage(error instanceof Error ? error.message : error); }
  registerIpc(): void {
    const handle = (name: string, mainOnly: boolean, operation: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => ipcMain.handle('loci-agent-workspace:' + name, async (event, ...args) => { this.sender(event, mainOnly); try { return await operation(event, ...args); } catch (error) { throw new Error(this.safe(error)); } });
    handle('state', false, event => { this.currentIdentity(); this.sender(event); return this.state(event.sender); });
    handle('open', true, (event, presentation) => this.open(event, presentation));
    handle('restore', true, event => this.open(event, undefined, true));
    handle('focus', false, event => { this.currentIdentity(); this.sender(event); if (!this.popup || this.status === 'crashed') throw new Error('Open the agent workspace first.'); this.popup.window.show(); this.popup.window.focus(); });
    handle('dock', false, async (event, binding) => { const captured = this.assertBinding(event, binding); await this.dockInternal(); this.currentIdentity(); if (captured.studyEpoch !== this.studyEpoch || captured.projectId !== this.projectId) throw new Error('The study changed while returning the workspace.'); return this.state(event.sender); });
    handle('publish', true, async (event, binding, value) => {
      const identity = this.currentIdentity(), epoch = this.studyEpoch;
      if (binding === null) { if (this.projectId) throw new Error('Use the current native workspace binding.'); await this.establish(event); if (this.identity !== identity || this.studyEpoch !== epoch) throw new Error('The study changed during initial publication.'); }
      else this.assertBinding(event, binding, true);
      const packet = validatePublished(value);
      if (packet.snapshot.project.project_id !== this.projectId) throw new Error('The published agent snapshot belongs to another study.');
      if (packet.presentation !== undefined) { if (this.status !== 'docked') throw new Error('The detached editor owns its local draft.'); this.presentation = packet.presentation; this.retain(); }
      this.packet = packet; this.dataSequence++; this.notify(); return this.state(event.sender);
    });
    handle('presentation', false, (event, binding, value) => { this.assertBinding(event, binding); if ((this.status === 'docked') !== (event.sender === this.main?.webContents) || !['docked', 'open', 'closing'].includes(this.status)) throw new Error('Only the active editing host may update the local draft.'); this.presentation = validatePresentation(value); this.retain(); this.notify(); return this.state(event.sender); });
    handle('control', false, (event, binding, request) => this.dispatch(event, binding, { kind: 'control', request: validateControl(request) } as AgentWorkspaceCommand));
    handle('navigate', false, (event, binding, request) => { const checked = validateNavigation(request); if (this.packet) assertNavigationCurrent(this.packet, checked); return this.dispatch(event, binding, { kind: 'navigate', request: checked } as AgentWorkspaceCommand); });
    handle('follow', false, (event, binding, follow) => { if (typeof follow !== 'boolean') throw new Error('Choose a valid Follow state.'); return this.dispatch(event, binding, { kind: 'follow', follow } as AgentWorkspaceCommand); });
    handle('complete', true, (event, binding, value) => {
      this.assertBinding(event, binding, true); const v = object(value); exact(v, ['commandId', 'ok'], v.ok === false ? ['error'] : []);
      const pending = this.pending;
      if (!pending || v.commandId !== pending.command.commandId || typeof v.ok !== 'boolean') throw new Error('The workspace command is no longer pending.');
      if (!v.ok && (typeof v.error !== 'string' || !v.error || v.error.length > 1000)) throw new Error('Invalid workspace command failure.');
      if (v.ok && pending.command.kind === 'control' && (this.dataSequence <= pending.dataSequence || this.packet?.refreshError)) throw new Error('Publish the updated durable snapshot before acknowledging the control.');
      if (v.ok && pending.command.kind === 'follow' && this.packet?.follow !== pending.command.follow) throw new Error('Publish the acknowledged Follow state first.');
      if (v.ok && pending.command.kind === 'navigate') {
        if (!this.packet || this.packet.refreshError) throw new Error('Refresh the study before acknowledging navigation.');
        assertNavigationCurrent(this.packet, pending.command.request);
      }
      this.assertBinding({ sender: pending.sender, senderFrame: pending.frame } as IpcMainInvokeEvent, pending.command.binding);
      clearTimeout(pending.timer); this.pending = null;
      if (!v.ok) pending.reject(new Error(this.safe(v.error))); else pending.resolve({ commandId: pending.command.commandId, sequence: this.sequence + 1, accepted: true });
      this.notify();
    });
    handle('flushed', false, (event, binding, flushId, value) => { this.assertBinding(event, binding); const pending = this.flush;
      if (event.sender !== this.popup?.sender || !pending || pending.flushId !== flushId || JSON.stringify(pending.binding) !== JSON.stringify(binding)) throw new Error('The draft flush is stale or belongs to another window.');
      const presentation = validatePresentation(value); this.presentation = presentation; this.retain(); clearTimeout(pending.timer); this.flush = null; this.notify(); pending.resolve();
    });
  }
  /** Fence new detached editing through the subsequent project-save await. */
  async dockForShutdown(): Promise<void> {
    this.shuttingDown = true;
    try { await this.dockInternal(); }
    catch (error) { this.cancelShutdown(); throw error; }
  }
  /** The main quit flow must call this whenever quitting is cancelled or fails. */
  cancelShutdown(): void { this.shuttingDown = false; }
  dispose(): void {
    if (this.disposed) return;
    this.unsubscribe(); this.disposed = true;
    if (this.displayEventsRegistered) {
      screen.removeListener('display-removed', this.displayChanged);
      screen.removeListener('display-metrics-changed', this.displayChanged);
      this.displayEventsRegistered = false;
    }
    this.revoke('The agent workspace coordinator closed.');
  }
}
