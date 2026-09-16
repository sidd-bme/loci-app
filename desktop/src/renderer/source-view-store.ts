import type { ResearchDesktopApi, ResearchSelection } from "../shared/research-contracts";
import type { ViewerChannel } from "./ImageViewport";
import type { SourceInterpretation } from "./SourceDisplayPanel";
import type { Camera } from "./viewer-camera";

export type SourceViewState = {
  interpretation: SourceInterpretation;
  channels: ViewerChannel[];
  projection: "plane" | "max" | "mean";
  selection: ResearchSelection;
  camera: Camera | null;
  rgb_mapping?: [number, number, number] | null;
};
export type SavedSourceView = { source_id: string; source_sha256: string; revision: number; state: SourceViewState | null };

/** Each source owns a serial write queue. Source switches flush its last view. */
export class SourceViewStore {
  private pending: SourceViewState | null = null;
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failed = false;
  private paused = false;
  constructor(private api: ResearchDesktopApi, private sourceId: string, private sha: string,
    private revision: number, private onError: (error: unknown) => void) {}
  save(state: SourceViewState) {
    if (this.failed || this.paused) return;
    this.pending = structuredClone(state);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 400);
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  discard() {
    this.paused = true;
    this.pending = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
  /** Adopt a revision written by a separate, already-verified display operation. */
  adoptRevision(revision: number) {
    if (!Number.isInteger(revision) || revision < 0)
      throw new Error("The adopted display revision is invalid.");
    if (this.timer || this.pending || this.running)
      throw new Error("Flush pending display settings before adopting a revision.");
    this.revision = revision;
  }
  flush(): Promise<boolean> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.running) return this.running;
    if (this.failed) return Promise.resolve(false);
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  private async drain(): Promise<boolean> {
    try {
      while (this.pending) {
        const state = this.pending; this.pending = null;
        const output = await this.api.execute("save_source_view", {
          source_id: this.sourceId, source_sha256: this.sha, expected_revision: this.revision, state,
        }) as SavedSourceView;
        if (output.source_id !== this.sourceId || output.source_sha256 !== this.sha || output.revision !== this.revision + 1)
          throw new Error("The saved view receipt does not match its source revision.");
        this.revision = output.revision;
      }
    } catch (error) { this.failed = true; this.pending = null; this.onError(error); }
    return !this.failed;
  }
}
