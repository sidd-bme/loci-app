import type { ResearchDesktopApi } from "../shared/research-contracts";
import { checkedVisionChannels } from "../shared/vision-handoff";
import type { SavedSourceView, SourceViewStore } from "./source-view-store";
import type { ViewerChannel } from "./ImageViewport";

/** A single reader owns display adoption while the local write queue is paused. */
export class SourceDisplayFollower {
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private revision = -1;
  private ready: Promise<boolean> | null = null;
  constructor(private api: Pick<ResearchDesktopApi, "execute">, private sourceId: string,
    private sha: string, private store: SourceViewStore, private onChannels: (channels: ViewerChannel[]) => void,
    private onError: (error: unknown) => void) {}
  async start() {
    if (this.active) return;
    this.active = true;
    this.store.pause();
    this.ready = this.store.flush();
    const flushed = await this.ready;
    this.ready = null;
    if (!flushed) { this.active = false; throw new Error("Resolve the saved display error before following an assistant."); }
    this.revision = this.store.currentRevision;
    if (this.active) await this.poll();
  }
  async stop() {
    this.active = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.ready;
    await this.pending;
    this.store.resume();
  }
  private poll(): Promise<void> {
    this.pending = this.read().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async read() {
    try {
      const view = await this.api.execute("source_view", { source_id: this.sourceId }) as SavedSourceView;
      if (!this.active) return;
      if (view.source_id !== this.sourceId || view.source_sha256 !== this.sha ||
          !Number.isSafeInteger(view.revision) || view.revision < 0 || view.revision < this.revision)
        throw new Error("Assistant display settings do not match the current source revision.");
      if (view.revision !== this.revision) {
        const channels = view.state === null ? null : checkedVisionChannels(view.state.channels);
        this.store.adoptRevision(view.revision);
        this.revision = view.revision;
        if (channels) this.onChannels(channels);
      }
      this.timer = setTimeout(() => { this.timer = null; void this.poll(); }, 1000);
    } catch (error) {
      if (!this.active) return;
      this.active = false;
      this.onError(error);
    }
  }
}
