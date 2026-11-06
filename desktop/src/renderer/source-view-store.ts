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

function isSameSelection(a?: ResearchSelection, b?: ResearchSelection): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.t === b.t && a.c === b.c && a.z === b.z &&
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height &&
    a.level === b.level && a.z_stop === b.z_stop;
}

function isSameCamera(a?: Camera | null, b?: Camera | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.scale === b.scale;
}

function isSameRgbMapping(a?: [number, number, number] | null, b?: [number, number, number] | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function isSameChannel(a: ViewerChannel, b: ViewerChannel): boolean {
  return a.channel === b.channel && a.visible === b.visible &&
    a.low === b.low && a.high === b.high && a.gamma === b.gamma &&
    a.color === b.color && a.opacity === b.opacity;
}

function isSameChannels(a?: ViewerChannel[], b?: ViewerChannel[]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!isSameChannel(a[i], b[i])) return false;
  }
  return true;
}

export function isSameSourceViewState(a: SourceViewState | null, b: SourceViewState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.interpretation === b.interpretation &&
    a.projection === b.projection &&
    isSameSelection(a.selection, b.selection) &&
    isSameCamera(a.camera, b.camera) &&
    isSameRgbMapping(a.rgb_mapping, b.rgb_mapping) &&
    isSameChannels(a.channels, b.channels);
}

/** Each source owns a serial write queue. Source switches flush its last view. */
export class SourceViewStore {
  private pending: SourceViewState | null = null;
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failed = false;
  private paused = false;
  private lastSavedState: SourceViewState | null = null;
  constructor(private api: ResearchDesktopApi, private sourceId: string, private sha: string,
    private revision: number, private onError: (error: unknown) => void,
    initialState: SourceViewState | null = null) {
    if (initialState) this.lastSavedState = structuredClone(initialState);
  }
  save(state: SourceViewState) {
    if (this.failed || this.paused) return;
    const current = this.pending ?? this.lastSavedState;
    if (isSameSourceViewState(state, current)) return;
    this.pending = structuredClone(state);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 400);
  }
  get currentRevision() { return this.revision; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  discard() {
    this.paused = true;
    this.pending = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
  hasPending(): boolean {
    return Boolean(this.pending || this.running || this.timer);
  }
  /** Adopt a revision written by a separate, already-verified display operation. */
  adoptRevision(revision: number) {
    if (!Number.isSafeInteger(revision) || revision < this.revision)
      throw new Error("The adopted display revision is invalid.");
    if (this.timer || this.pending || this.running)
      throw new Error("Flush pending display settings before adopting a revision.");
    this.revision = revision;
    this.lastSavedState = null;
  }
  flush(): Promise<boolean> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.running) return this.running;
    if (this.failed) return Promise.resolve(false);
    if (!this.pending) return Promise.resolve(true);
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  private async drain(): Promise<boolean> {
    try {
      while (this.pending) {
        const state = this.pending;
        const output = await this.api.execute("save_source_view", {
          source_id: this.sourceId, source_sha256: this.sha, expected_revision: this.revision, state,
        }) as SavedSourceView;
        if (output.source_id !== this.sourceId || output.source_sha256 !== this.sha || output.revision !== this.revision + 1)
          throw new Error("The saved view receipt does not match its source revision.");
        this.revision = output.revision;
        this.lastSavedState = state;
        if (this.pending === state) this.pending = null;
      }
    } catch (error) { this.failed = true; this.pending = null; this.onError(error); }
    return !this.failed;
  }
}
