import type { AgentWorkspaceApi, AgentWorkspaceBinding, AgentWorkspaceCommand, AgentWorkspaceNavigationRequest,
  AgentWorkspacePresentation, AgentWorkspacePublishedState, AgentWorkspaceState } from "../shared/agent-workspace-api";
import type { ResearchAgentControlRequest, ResearchSnapshot } from "../shared/research-contracts";

const EMPTY: AgentWorkspacePresentation = { selectedTaskId: null, section: "overview", draft: null };
const key = (binding: AgentWorkspaceBinding | null): string => binding
  ? `${binding.projectId}:${binding.studyEpoch}:${binding.generation}` : "";
const clone = <T,>(value: T): T => structuredClone(value);
const failure = (error: unknown): string => (error instanceof Error ? error.message : "The agent workspace action failed.")
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
  .replace(/\/?(?:Users|Volumes)\/[^\s]+/gu, "the selected study").slice(0, 1000);

/** A version barrier around the existing poll, not another snapshot store/poller. */
export class AgentSnapshotFence {
  private version = 0;
  private controls = 0;
  invalidate(): void { this.version++; }
  get pending(): boolean { return this.controls > 0; }
  async read(getSnapshot: () => Promise<ResearchSnapshot | null>): Promise<ResearchSnapshot | null> {
    if (this.pending) return null;
    const version = this.version;
    try { const next = await getSnapshot(); return version === this.version && !this.pending ? next : null; }
    catch (error) { if (version !== this.version || this.pending) return null; throw error; }
  }
  async control<T>(work: (current: () => boolean) => Promise<T>): Promise<T> {
    if (this.pending) throw new Error("Wait for the current agent control to finish.");
    const version = ++this.version; this.controls++;
    try { return await work(() => version === this.version); }
    finally { this.controls--; this.version++; }
  }
}

export interface AgentHostContext {
  scope: string;
  switching: boolean;
  packet: Omit<AgentWorkspacePublishedState, "presentation"> | null;
}
export interface AgentHostActions {
  control(request: ResearchAgentControlRequest, current: () => boolean): Promise<ResearchSnapshot | null>;
  navigate(request: AgentWorkspaceNavigationRequest, current: () => boolean): Promise<void>;
  follow(value: boolean, current: () => boolean): void;
}
interface Options {
  api: AgentWorkspaceApi;
  context(): AgentHostContext;
  actions(): AgentHostActions;
  onState(state: AgentWorkspaceState): void;
  onPresentation(value: AgentWorkspacePresentation): void;
  onReturn(): void;
  onError(message: string): void;
}

/** Main renderer adapter. Native issues authority; this owns no research state. */
export class AgentWorkspaceHost {
  private state: AgentWorkspaceState | null = null;
  private alive = false;
  private lifecycle = 0;
  private unlisten: Array<() => void> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private presentation = clone(EMPTY);
  private presentationWrites = 0;
  private scope: string | null = null;
  private blockedScope: string | null = null;
  private boundScope: string | null = null;
  private activeCommand: string | null = null;
  constructor(private readonly options: Options) {}

  start(): void {
    const lifecycle = ++this.lifecycle, scope = this.options.context().scope;
    this.alive = true; this.queue = Promise.resolve(); this.state = null;
    this.unlisten = [this.options.api.onState(state => { if (this.live(lifecycle)) this.accept(state); }),
      this.options.api.onCommand(command => { if (this.live(lifecycle)) void this.command(command); })];
    void this.publish().catch(error => { if (this.live(lifecycle) && this.options.context().scope === scope) this.report(error); });
  }
  dispose(): void {
    this.alive = false; this.lifecycle++; this.activeCommand = null; this.presentationWrites = 0;
    for (const remove of this.unlisten) remove(); this.unlisten = [];
  }
  private live(lifecycle: number): boolean { return this.alive && lifecycle === this.lifecycle; }
  private report(error: unknown): void { if (this.alive) this.options.onError(failure(error)); }
  private context(): AgentHostContext {
    const context = this.options.context();
    if (context.scope !== this.scope) { this.scope = context.scope; this.blockedScope = null; this.activeCommand = null; }
    if (!this.alive || context.switching || this.blockedScope === context.scope)
      throw new Error("The study changed or is still opening.");
    return context;
  }
  private accept(next: AgentWorkspaceState): void {
    if (!this.alive || next.role !== "main" || (this.state && next.sequence < this.state.sequence)) return;
    const previous = this.state;
    const rebound = key(previous?.binding ?? null) !== key(next.binding);
    if (previous?.binding && (!next.binding || previous.binding.studyEpoch !== next.binding.studyEpoch || previous.binding.projectId !== next.binding.projectId)) {
      this.blockedScope = this.boundScope ?? this.scope ?? this.options.context().scope; this.boundScope = null; this.activeCommand = null;
    }
    this.state = next;
    if (rebound || this.presentationWrites === 0) {
      this.presentation = clone(next.presentation); this.options.onPresentation(clone(next.presentation));
    }
    this.options.onState(next);
    if (previous && previous.status !== "docked" && next.status === "docked") this.options.onReturn();
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const lifecycle = this.lifecycle;
    const next = this.queue.then(() => {
      if (!this.live(lifecycle)) throw new Error("The agent workspace renderer was replaced.");
      return work();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async nativeState(): Promise<AgentWorkspaceState> {
    const lifecycle = this.lifecycle;
    const next = await this.options.api.state();
    if (!this.live(lifecycle)) throw new Error("The agent workspace renderer was replaced.");
    this.accept(next);
    if (!this.state || this.state.role !== "main") throw new Error("The main agent workspace is unavailable.");
    return this.state;
  }
  publish(snapshot?: ResearchSnapshot): Promise<void> {
    const requested = this.options.context().scope, lifecycle = this.lifecycle;
    return this.enqueue(async () => {
      let context = this.context();
      if (context.scope !== requested || !context.packet) return;
      if (!this.state) await this.nativeState();
      context = this.context();
      if (context.scope !== requested || !context.packet) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        const native = this.state!, currentPacket = context.packet;
        if (!currentPacket) return;
        const packet: AgentWorkspacePublishedState = { ...currentPacket, ...(snapshot ? { snapshot } : {}),
          ...(native.status === "docked" ? { presentation: clone(this.presentation) } : {}) };
        if (native.binding && packet.snapshot.project.project_id !== native.binding.projectId)
          throw new Error("The native study binding does not match the current snapshot.");
        try {
          const next = await this.options.api.publish(native.binding, packet);
          if (this.options.context().scope !== requested || !this.live(lifecycle)) return;
          this.accept(next); this.boundScope = requested; return;
        } catch (error) {
          if (attempt || !this.live(lifecycle) || this.options.context().scope !== requested) throw error;
          await this.nativeState(); context = this.context();
        }
      }
    });
  }
  changePresentation(next: AgentWorkspacePresentation): void {
    let context: AgentHostContext;
    try { context = this.context(); } catch { return; }
    if (this.state && this.state.status !== "docked") return;
    this.presentation = clone(next); this.options.onPresentation(clone(next));
    this.presentationWrites++;
    const lifecycle = this.lifecycle;
    void this.enqueue(async () => {
      const latest = this.context();
      if (latest.scope !== context.scope) return;
      if (!this.state?.binding) await this.nativeState();
      if (!this.state?.binding || this.state.status !== "docked") throw new Error("The editing host changed before saving the local draft.");
      const result = await this.options.api.updatePresentation(this.state.binding, next);
      if (this.live(lifecycle) && this.options.context().scope === context.scope) this.accept(result);
    }).catch(error => { if (this.live(lifecycle) && this.options.context().scope === context.scope) this.report(error); })
      .finally(() => { if (this.live(lifecycle)) this.presentationWrites--; });
  }
  async open(restore = false): Promise<void> {
    const context = this.context(), lifecycle = this.lifecycle;
    await this.publish();
    await this.enqueue(async () => {
      if (this.context().scope !== context.scope) throw new Error("The study changed before opening its agent workspace.");
      const next = restore ? await this.options.api.restore() : await this.options.api.open(clone(this.presentation));
      if (this.live(lifecycle) && this.options.context().scope === context.scope) this.accept(next);
    });
  }
  async focus(): Promise<void> { this.context(); await this.options.api.focus(); }
  private async command(command: AgentWorkspaceCommand): Promise<void> {
    const scope = this.options.context().scope, lifecycle = this.lifecycle;
    try {
      this.context();
      const native = await this.nativeState();
      if (this.activeCommand || key(native.binding) !== key(command.binding) || native.pendingCommandId !== command.commandId) return;
      this.activeCommand = command.commandId;
      const current = () => this.live(lifecycle) && this.options.context().scope === scope && !this.options.context().switching &&
        this.blockedScope !== scope && this.activeCommand === command.commandId &&
        key(this.state?.binding ?? null) === key(command.binding) && this.state?.pendingCommandId === command.commandId;
      if (!current()) return;
      if (command.kind === "control") {
        const snapshot = await this.options.actions().control(command.request, current);
        if (!current()) return;
        if (!snapshot) throw new Error("The agent control did not return a current durable snapshot.");
        await this.publish(snapshot);
      } else if (command.kind === "follow") {
        this.options.actions().follow(command.follow, current);
        if (!current()) return;
        await this.publish();
      } else {
        await this.options.actions().navigate(command.request, current);
        if (!current()) return;
        await this.publish();
      }
      if (current()) await this.options.api.complete(command.binding, { commandId: command.commandId, ok: true });
    } catch (error) {
      if (this.live(lifecycle) && this.options.context().scope === scope && !this.options.context().switching &&
          key(this.state?.binding ?? null) === key(command.binding) && this.state?.pendingCommandId === command.commandId) {
        await this.options.api.complete(command.binding, { commandId: command.commandId, ok: false, error: failure(error) }).catch(() => undefined);
        this.report(error);
      }
    } finally { if (this.activeCommand === command.commandId) this.activeCommand = null; }
  }
}

/** Resolve after a real renderer predicate becomes true; selection requests are not acknowledgments. */
export function waitForAgentNavigation(ready: () => boolean, current: () => boolean, timeout = 20000): Promise<void> {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    let frames = 0;
    const tick = () => {
      if (!current()) { reject(new Error("The study or navigation intent changed before rendering.")); return; }
      if (++frames > 1 && ready()) { resolve(); return; }
      if (Date.now() >= deadline) { reject(new Error("The exact recorded target did not finish rendering.")); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
