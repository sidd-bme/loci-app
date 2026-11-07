import type { ResearchDesktopApi } from "../shared/research-contracts";
import type { VolumeLiveToken, VolumePane, VolumeSceneAdapter, VolumeSceneCapture, VolumeSceneSnapshot, VolumeViewDocument, VolumeViewState } from "./volume-scene-types";

type FailureReason = "unavailable" | "stale" | "busy" | "capture-failed" | "cancelled";
type SceneRequest = {
  request_id: string; source_id: string; source_sha256: string; kind: "set" | "image";
  status: "queued" | "applying"; expected_live: VolumeLiveToken; applied_live?: VolumeLiveToken;
  proposed_state: VolumeViewState; panes: VolumePane[]; max_size: number;
};
export interface VolumeSceneBridgeOptions {
  api: Pick<ResearchDesktopApi, "execute">;
  binding: { sourceId: string; sourceSha256: string; viewId: string };
  adapter: VolumeSceneAdapter;
  /** Flush serialized channel-display writes; return the revision represented by this renderer. */
  flushDisplay: () => Promise<number>;
  /** A persisted receipt, never an instruction to apply it to the renderer. */
  onChanged?: (view: VolumeViewDocument) => void;
  onConflict?: (view: VolumeViewDocument) => void;
  onError?: (error: Error) => void;
}
export class VolumeSceneBridgeError extends Error {
  constructor(readonly reason: FailureReason, message: string) { super(message); this.name = "VolumeSceneBridgeError"; }
}
const fail: (reason: FailureReason, message: string) => never = (reason, message) => { throw new VolumeSceneBridgeError(reason, message); };
const panes: VolumePane[] = ["volume", "axial", "coronal", "sagittal"];
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const id = (value: unknown) => typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
const number = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => number(value, min, max) && Number.isSafeInteger(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const vector = (value: unknown, count: number, indices = false): value is number[] => Array.isArray(value) && value.length === count && value.every((item) => indices ? integer(item) : number(item, -1e30, 1e30));
const clone = <T,>(value: T): T => structuredClone(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);
class SupersededHeartbeat extends Error {}

/** Structural checks at the renderer boundary; source dimensions/artifacts remain engine authority. */
export function checkedVolumeViewState(value: unknown): VolumeViewState {
  const invalid = () => fail("stale", "The volume scene does not match the supported state contract.");
  if (!exact(value, ["t", "channels", "result", "selected_object", "representation", "camera", "crosshair_source_xyz", "clipping", "refinement", "layout", "labels"])) return invalid();
  if (!integer(value.t) || !Array.isArray(value.channels) || value.channels.length < 1 || value.channels.length > 4 ||
      !value.channels.every((channel) => integer(channel)) || new Set(value.channels).size !== value.channels.length || !vector(value.crosshair_source_xyz, 3, true)) return invalid();
  const representation = value.representation;
  if (!exact(representation, ["mode", "extent", "render_mode", "quality"]) || !["volume", "mpr"].includes(String(representation.mode)) ||
      !["context", "focus"].includes(String(representation.extent)) || !["blend", "normal_shading", "mip", "average", "minip"].includes(String(representation.render_mode)) || !integer(representation.quality, 1, 100)) return invalid();
  const clipping = value.clipping;
  if (!exact(clipping, ["enabled", "axis", "position_percent"]) || typeof clipping.enabled !== "boolean" || !["x", "y", "z"].includes(String(clipping.axis)) || !number(clipping.position_percent, 0, 100)) return invalid();
  const refinement = value.refinement;
  if (!exact(refinement, ["target_long_axis", "focus_region_xyzxyz"]) || !integer(refinement.target_long_axis, 16, 256)) return invalid();
  const focus = refinement.focus_region_xyzxyz;
  if (focus !== null && (!vector(focus, 6, true) || focus[1] < focus[0] || focus[3] < focus[2] || focus[5] <= focus[4])) return invalid();
  if (representation.extent === "focus" && focus === null) return invalid();
  const layout = value.layout;
  if (!exact(layout, ["mode", "expanded_pane", "pane_order", "col_split", "row_split"]) || !["four", "single"].includes(String(layout.mode)) ||
      (layout.expanded_pane !== null && !panes.includes(layout.expanded_pane as VolumePane)) || !Array.isArray(layout.pane_order) || layout.pane_order.length !== 4 ||
      new Set(layout.pane_order).size !== 4 || !layout.pane_order.every((pane) => panes.includes(pane)) || !number(layout.col_split, 10, 90) || !number(layout.row_split, 10, 90)) return invalid();
  const labels = value.labels;
  if (!exact(labels, ["visible", "opacity", "selected_only"]) || typeof labels.visible !== "boolean" || typeof labels.selected_only !== "boolean" || !number(labels.opacity, 0, 1)) return invalid();
  const result = value.result;
  if (result !== null && (!exact(result, ["result_id", "revision_hash", "label_sha256"]) || !id(result.result_id) || !hash(result.revision_hash) || !hash(result.label_sha256))) return invalid();
  const selected = value.selected_object;
  if (selected !== null && (!record(result) || !exact(selected, ["result_id", "revision_hash", "label_sha256", "label_id"]) ||
      !integer(selected.label_id, 1, 0xffffffff) || ["result_id", "revision_hash", "label_sha256"].some((key) => selected[key] !== result[key]))) return invalid();
  if (labels.visible && result === null) return invalid();
  const camera = value.camera;
  if (camera !== null) {
    if (!exact(camera, ["projection", "position_xyz", "focal_point_xyz", "view_up_xyz", "clipping_range", "view_angle_degrees", "parallel_scale", "frame", "unit"]) ||
        !["parallel", "perspective"].includes(String(camera.projection)) || !vector(camera.position_xyz, 3) || !vector(camera.focal_point_xyz, 3) || !vector(camera.view_up_xyz, 3) ||
        !vector(camera.clipping_range, 2) || camera.clipping_range[0] <= 0 || camera.clipping_range[1] <= camera.clipping_range[0] || !number(camera.view_angle_degrees, .01, 179) ||
        (camera.parallel_scale !== null && !number(camera.parallel_scale, 1e-12, 1e30)) || (camera.projection === "parallel" && camera.parallel_scale === null) ||
        typeof camera.frame !== "string" || !camera.frame || typeof camera.unit !== "string" || !camera.unit) return invalid();
    const direction = camera.position_xyz.map((position, axis) => position - (camera.focal_point_xyz as number[])[axis]);
    const up = camera.view_up_xyz;
    if (Math.hypot(...direction) <= 1e-12 || Math.hypot(direction[1] * up[2] - direction[2] * up[1], direction[2] * up[0] - direction[0] * up[2], direction[0] * up[1] - direction[1] * up[0]) <= 1e-12) return invalid();
  }
  if (new TextEncoder().encode(canonical(value)).length > 64 * 1024) return invalid();
  return clone(value as unknown as VolumeViewState);
}

function checkedToken(value: unknown): VolumeLiveToken {
  if (!exact(value, ["view_id", "renderer_generation", "live_epoch", "revision", "display_revision"]) || typeof value.view_id !== "string" ||
      !/^[A-Za-z0-9_:-]{1,128}$/u.test(value.view_id) ||
      ![value.renderer_generation, value.live_epoch, value.revision, value.display_revision].every((item) => integer(item)))
    return fail("stale", "The volume request has an invalid live view token.");
  return clone(value as unknown as VolumeLiveToken);
}

export class VolumeSceneBridge {
  private view: VolumeViewDocument | null = null;
  private conflict: VolumeViewDocument | null = null;
  private initialized = false;
  private explicitSaveRequired = false;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tasks: Promise<unknown> = Promise.resolve();
  private nativeTasks: Promise<unknown> = Promise.resolve();
  private heartbeatPending = false;
  private active: { request: SceneRequest; original: VolumeSceneSnapshot; token: VolumeLiveToken; applying: boolean } | null = null;

  constructor(private readonly options: VolumeSceneBridgeOptions) {
    if (!id(options.binding.sourceId) || !hash(options.binding.sourceSha256) || !/^[A-Za-z0-9_:-]{1,128}$/u.test(options.binding.viewId))
      fail("stale", "The volume bridge requires an exact source and view binding.");
    this.options = { ...options, binding: { ...options.binding } };
  }
  get current(): VolumeViewDocument | null { return this.view ? clone(this.view) : null; }
  private report(error: unknown): Error {
    const value = error instanceof Error ? error : new Error("The volume workspace operation failed.");
    if (!this.disposed) this.options.onError?.(value);
    return value;
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tasks.then(() => { this.alive(); return work(); });
    this.tasks = next.catch(() => undefined);
    return next.catch((error) => { throw this.report(error); });
  }
  private execute(operation: string, request: Record<string, unknown>, allowDisposed = false, guard?: () => void): Promise<unknown> {
    const next = this.nativeTasks.then(() => { if (!allowDisposed) this.alive(); guard?.(); return this.options.api.execute(operation, request); });
    this.nativeTasks = next.catch(() => undefined);
    return next;
  }
  private alive() { if (this.disposed) fail("cancelled", "The volume workspace was closed."); }
  private snapshot(ready = true): VolumeSceneSnapshot {
    this.alive();
    const snapshot = this.options.adapter.snapshot();
    if (!snapshot || !integer(snapshot.liveEpoch) || !integer(snapshot.rendererGeneration) || typeof snapshot.busy !== "boolean" || typeof snapshot.available !== "boolean")
      return fail("unavailable", "The volume renderer is unavailable.");
    if (ready && !snapshot.available) return fail("unavailable", "The volume renderer is unavailable.");
    if (ready && snapshot.busy) return fail("busy", "Finish the current volume interaction first.");
    return { ...snapshot, state: checkedVolumeViewState(snapshot.state) };
  }
  private unchanged(before: VolumeSceneSnapshot, state = true, ready = true): VolumeSceneSnapshot {
    const after = this.snapshot(ready);
    if (before.liveEpoch !== after.liveEpoch || before.rendererGeneration !== after.rendererGeneration || (state && !equal(before.state, after.state)))
      return fail("stale", "The local volume view changed while the operation was pending.");
    return after;
  }
  private document(value: unknown): VolumeViewDocument {
    const binding = this.options.binding;
    if (!exact(value, ["schema", "source_id", "source_sha256", "geometry_sha256", "revision", "display_revision", "state"]) ||
        value.schema !== "loci.volume-view/v1" || value.source_id !== binding.sourceId || value.source_sha256 !== binding.sourceSha256 ||
        !hash(value.geometry_sha256) || !integer(value.revision) || !integer(value.display_revision) || (this.view && value.geometry_sha256 !== this.view.geometry_sha256))
      return fail("stale", "The saved volume view lost its source or geometry binding.");
    return { ...value, state: value.state === null ? null : checkedVolumeViewState(value.state) } as VolumeViewDocument;
  }
  private async read(): Promise<VolumeViewDocument> {
    return this.document(await this.execute("volume_view", { source_id: this.options.binding.sourceId }));
  }
  private token(snapshot: VolumeSceneSnapshot): VolumeLiveToken {
    if (!this.view) return fail("unavailable", "Load the volume view before publishing it.");
    return { view_id: this.options.binding.viewId, renderer_generation: snapshot.rendererGeneration, live_epoch: snapshot.liveEpoch,
      revision: this.view.revision, display_revision: this.view.display_revision };
  }
  private conflictWith(view: VolumeViewDocument): never {
    this.view = clone(view); this.conflict = clone(view);
    this.options.onConflict?.(clone(view));
    return fail("stale", "The saved volume view or source display changed. Review the current revision before saving again.");
  }
  /** Explicit acknowledgment only; never applies or saves a conflicting scene. */
  acceptConflict(view: VolumeViewDocument): void {
    this.alive();
    if (!this.conflict || !equal(this.document(view), this.conflict)) fail("stale", "The conflict acknowledgment is no longer current.");
    this.conflict = null;
  }
  private async synchronize(before: VolumeSceneSnapshot, ready = true): Promise<void> {
    const displayRevision = await this.options.flushDisplay();
    this.unchanged(before, true, ready);
    if (!integer(displayRevision)) fail("stale", "The source display flush did not return its represented revision.");
    const current = await this.read();
    this.unchanged(before, true, ready);
    if ((this.view && current.revision !== this.view.revision) || current.display_revision !== displayRevision || this.conflict) this.conflictWith(current);
    this.view = current;
  }
  private async presence(snapshot: VolumeSceneSnapshot, available: boolean, busy = snapshot.busy, token = this.token(snapshot), guard?: () => void): Promise<void> {
    const displayRevision = await this.options.flushDisplay();
    guard?.();
    this.unchanged(snapshot, false, false);
    if (displayRevision !== token.display_revision) fail("stale", "The source display changed before presence publication.");
    const value = await this.execute("volume_view_presence", { ...token, source_id: this.options.binding.sourceId,
      source_sha256: this.options.binding.sourceSha256, busy, available }, false, guard);
    guard?.();
    this.unchanged(snapshot, false, false);
    if (!record(value) || value.source_id !== this.options.binding.sourceId || value.source_sha256 !== this.options.binding.sourceSha256 ||
        !equal(Object.fromEntries(Object.keys(token).map((key) => [key, value[key]])), token) || value.busy !== busy || value.available !== available)
      fail("stale", "The volume presence receipt does not match this renderer.");
  }

  /** Use restore:false when human intent changed before this delayed initialization. */
  start({ restore = true, preserveCurrentResult = false }: { restore?: boolean; preserveCurrentResult?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      if (this.initialized) return;
      const before = this.snapshot();
      await this.synchronize(before);
      const unresolvedCamera = this.view!.state !== null && this.view!.state.camera === null;
      const resultChanged = preserveCurrentResult && this.view!.state !== null && !equal(before.state.result, this.view!.state.result);
      const restoreSaved = restore && !unresolvedCamera && !resultChanged;
      this.options.adapter.lock(true);
      try {
        this.unchanged(before);
        if (restoreSaved && this.view!.state && !equal(before.state, this.view!.state)) {
          await this.options.adapter.apply(clone(this.view!.state));
          const after = this.unchanged(before, false);
          if (!equal(after.state, this.view!.state)) fail("stale", "The restored volume scene was not rendered exactly.");
        }
        this.explicitSaveRequired = !restoreSaved;
        this.initialized = true;
        this.options.onChanged?.(clone(this.view!));
        await this.presence(this.snapshot(), restoreSaved && this.view!.state !== null);
      } finally {
        this.options.adapter.lock(false);
        if (this.initialized && !this.disposed && !this.timer) this.timer = setInterval(() => { void this.heartbeat(); }, 3000);
      }
    });
  }
  /** Save this captured human scene, never whatever happens to exist when a queued write runs. */
  save(snapshot: VolumeSceneSnapshot): Promise<VolumeViewDocument> {
    const captured = clone(snapshot);
    return this.enqueue(async () => {
      if (!this.initialized) fail("unavailable", "Load the volume workspace before saving it.");
      if (this.conflict) this.conflictWith(this.view!);
      this.unchanged(captured);
      await this.synchronize(captured);
      const previous = this.view!;
      try {
        const value = this.document(await this.execute("save_volume_view", { source_id: previous.source_id, source_sha256: previous.source_sha256,
          expected_revision: previous.revision, expected_display_revision: previous.display_revision, state: captured.state }, false, () => { this.unchanged(captured); }));
        if (value.revision !== previous.revision + 1 || value.display_revision !== previous.display_revision || !equal(value.state, captured.state))
          fail("stale", "The saved scene receipt does not match the submitted snapshot.");
        this.view = value;
        this.unchanged(captured);
        this.explicitSaveRequired = false;
        this.options.onChanged?.(clone(value));
        await this.presence(captured, true);
        return clone(value);
      } catch (error) {
        // A failed CAS is re-read, never retried against a newer revision automatically.
        const current = await this.read();
        if (current.revision !== this.view!.revision || current.display_revision !== this.view!.display_revision) this.conflictWith(current);
        throw error;
      }
    });
  }
  /** Notify after gesture/readiness changes; publishes availability and services a bounded request batch. */
  update(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.initialized) return;
      const snapshot = this.snapshot(false);
      await this.synchronize(snapshot, false);
      const available = snapshot.available && !this.explicitSaveRequired && this.view!.state !== null && equal(snapshot.state, this.view!.state) && !this.conflict;
      await this.presence(snapshot, available);
      if (!available || snapshot.busy) return;
      const output = await this.execute("volume_view_requests", {});
      this.unchanged(snapshot);
      if (!record(output) || !Array.isArray(output.requests) || output.requests.length > 32) fail("stale", "The volume mailbox returned an invalid request batch.");
      for (const raw of output.requests) {
        if (!record(raw) || raw.source_id !== this.options.binding.sourceId || raw.source_sha256 !== this.options.binding.sourceSha256) continue;
        const request = this.request(raw);
        if (request.expected_live.view_id !== this.options.binding.viewId) continue;
        await this.service(request);
      }
    });
  }
  private request(raw: Record<string, unknown>): SceneRequest {
    if (!id(raw.request_id) || !["set", "image"].includes(String(raw.kind)) || !["queued", "applying"].includes(String(raw.status)))
      return fail("stale", "The volume mailbox returned an invalid request.");
    const request = { ...raw, expected_live: checkedToken(raw.expected_live), proposed_state: checkedVolumeViewState(raw.proposed_state) } as SceneRequest;
    if (raw.applied_live !== undefined) request.applied_live = checkedToken(raw.applied_live);
    if (request.kind === "image" && (!Array.isArray(request.panes) || request.panes.length < 1 || request.panes.length > 4 ||
        new Set(request.panes).size !== request.panes.length || !request.panes.every((pane) => panes.includes(pane)) || !integer(request.max_size, 64, 2048)))
      return fail("capture-failed", "The requested volume capture is outside its pane or size bounds.");
    return request;
  }
  private async service(request: SceneRequest): Promise<void> {
    let reason: FailureReason = "stale";
    try {
      // An interrupted apply is not resumed blindly: the original local gesture lock no longer exists.
      if (request.status !== "queued") fail("stale", "An interrupted volume request needs a fresh live token.");
      const before = this.snapshot();
      if (!equal(this.token(before), request.expected_live) || !equal(before.state, this.view!.state)) fail("stale", "The queued volume request targets an older view.");
      this.options.adapter.lock(true);
      this.unchanged(before);
      this.active = { request, original: before, token: request.expected_live, applying: false };
      await this.synchronize(before);
      await this.presence(before, true, false);
      if (!equal(this.token(before), request.expected_live)) fail("stale", "The queued volume request targets an older display revision.");
      let capture: Record<string, unknown> | null = null;
      if (request.kind === "set") {
        const output = await this.execute("volume_view_request_apply", { request_id: request.request_id, live_token: request.expected_live }, false, () => { this.unchanged(before); });
        this.unchanged(before);
        if (!record(output) || output.request_id !== request.request_id || output.status !== "applying") fail("stale", "The volume apply receipt is invalid.");
        const token = checkedToken(output.live_token);
        const view = this.document(output.view);
        if (!equal(token, { ...request.expected_live, revision: request.expected_live.revision + 1 }) ||
            view.revision !== token.revision || view.display_revision !== token.display_revision || !equal(view.state, request.proposed_state))
          fail("stale", "The volume apply receipt lost its exact target binding.");
        this.view = view;
        this.active.token = token; this.active.applying = true;
        await this.options.adapter.apply(clone(request.proposed_state));
        const rendered = this.unchanged(before, false);
        if (!equal(rendered.state, request.proposed_state)) fail("stale", "The requested volume scene was not rendered exactly.");
        this.active.applying = false;
      } else {
        if (!equal(request.proposed_state, before.state)) fail("stale", "The capture request does not match the current scene.");
        reason = "capture-failed";
        const image = await this.options.adapter.capture([...request.panes], request.max_size);
        this.unchanged(before);
        this.checkCapture(image, request.max_size);
        capture = { image: image.image, rendering: { kind: "gui-rendered-scene", source_id: this.view!.source_id,
          source_sha256: this.view!.source_sha256, geometry_sha256: this.view!.geometry_sha256, live_token: this.active.token,
          panes: [...request.panes], width: image.width, height: image.height, manifest: image.manifest } };
      }
      const rendered = this.snapshot();
      this.unchanged(before, false);
      await this.presence(rendered, true, false, this.active.token);
      this.unchanged(rendered);
      const complete = await this.execute("volume_view_request_complete", { request_id: request.request_id, live_token: this.active.token, capture }, false, () => { this.unchanged(rendered); });
      this.unchanged(rendered);
      if (!record(complete) || complete.request_id !== request.request_id || complete.status !== "complete") fail("stale", "The volume request was not acknowledged as complete.");
      if (request.kind === "set") this.options.onChanged?.(clone(this.view!));
    } catch (error) {
      reason = error instanceof VolumeSceneBridgeError ? error.reason : reason;
      await this.execute("volume_view_request_fail", { request_id: request.request_id, reason }, true);
      throw error;
    } finally { this.active = null; this.options.adapter.lock(false); }
  }
  private checkCapture(value: VolumeSceneCapture, maximum: number) {
    if (!value || typeof value.image !== "string" || !value.image.startsWith("data:image/png;base64,") || value.image.length > 24 * 1024 ** 2 ||
        !integer(value.width, 1, maximum) || !integer(value.height, 1, maximum) || !record(value.manifest))
      fail("capture-failed", "The renderer did not return a bounded PNG capture.");
    const walk = (node: unknown, depth = 0): void => {
      if (depth > 16) fail("capture-failed", "The capture manifest exceeds its nesting bound.");
      if (Array.isArray(node)) node.forEach((item) => walk(item, depth + 1));
      else if (record(node)) Object.entries(node).forEach(([key, item]) => {
        if (/path|locator|directory/iu.test(key)) fail("capture-failed", "The capture manifest must not contain native locations.");
        walk(item, depth + 1);
      });
      else if (typeof node === "string" && (/^(?:\/|file:|\\)/u.test(node) || node.includes(":\\"))) fail("capture-failed", "The capture manifest must not contain native locations.");
      else if (typeof node === "number" && !Number.isFinite(node)) fail("capture-failed", "The capture manifest contains a non-finite value.");
      else if (node !== null && !["string", "number", "boolean"].includes(typeof node)) fail("capture-failed", "The capture manifest must contain only data.");
    };
    walk(value.manifest);
    if (new TextEncoder().encode(canonical(value.manifest)).length > 240 * 1024) fail("capture-failed", "The capture manifest exceeds its receipt bound.");
  }
  private async heartbeat(): Promise<void> {
    if (this.disposed || this.heartbeatPending) return;
    this.heartbeatPending = true;
    try {
      if (this.active) {
        const active = this.active;
        const applying = active.applying;
        const token = clone(active.token);
        const guard = () => { if (this.active !== active || active.applying !== applying || !equal(active.token, token)) throw new SupersededHeartbeat(); };
        const snapshot = this.unchanged(active.original, false, false);
        if (!applying && !equal(snapshot.state, this.view?.state)) fail("stale", "The renderer changed during an agent request.");
        await this.presence(snapshot, snapshot.available, applying || snapshot.busy, token, guard);
      } else await this.update();
    } catch (error) { if (!(error instanceof SupersededHeartbeat)) this.report(error); }
    finally { this.heartbeatPending = false; }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.options.adapter.lock(false);
    if (!this.view) return;
    const snapshot = this.options.adapter.snapshot();
    const token = this.active?.token ?? { view_id: this.options.binding.viewId, live_epoch: snapshot?.liveEpoch ?? 0,
      renderer_generation: snapshot?.rendererGeneration ?? 0, revision: this.view.revision, display_revision: this.view.display_revision };
    await this.execute("volume_view_presence", { ...token, source_id: this.options.binding.sourceId,
      source_sha256: this.options.binding.sourceSha256, busy: false, available: false }, true);
  }
}
