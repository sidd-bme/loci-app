import { afterEach, describe, expect, it, vi } from "vitest";
import { checkedVolumeViewState, VolumeSceneBridge } from "./volume-scene-bridge";
import type { VolumeLiveToken, VolumeSceneAdapter, VolumeSceneSnapshot, VolumeViewDocument, VolumeViewState } from "./volume-scene-types";

const sourceId = "a".repeat(32), sourceSha256 = "b".repeat(64);
const copy = <T,>(value: T): T => structuredClone(value);
const scene = (): VolumeViewState => ({
  t: 0, channels: [0], result: null, selected_object: null,
  representation: { mode: "volume", extent: "context", render_mode: "blend", quality: 50 },
  camera: { projection: "parallel", position_xyz: [0, 0, 40], focal_point_xyz: [0, 0, 0], view_up_xyz: [0, 1, 0],
    clipping_range: [.1, 100], view_angle_degrees: 30, parallel_scale: 10, frame: "image", unit: "pixel" },
  crosshair_source_xyz: [4, 5, 2], clipping: { enabled: false, axis: "z", position_percent: 50 },
  refinement: { target_long_axis: 128, focus_region_xyzxyz: null },
  layout: { mode: "four", expanded_pane: null, pane_order: ["axial", "coronal", "sagittal", "volume"], col_split: 50, row_split: 50 },
  labels: { visible: false, opacity: .4, selected_only: false },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const bridges: VolumeSceneBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose())); vi.useRealTimers(); });

function setup(options: { saved?: VolumeViewState | null; local?: VolumeViewState } = {}) {
  let document: VolumeViewDocument = { schema: "loci.volume-view/v1", source_id: sourceId, source_sha256: sourceSha256,
    geometry_sha256: "c".repeat(64), revision: 2, display_revision: 7, state: options.saved === undefined ? scene() : options.saved };
  let local: VolumeSceneSnapshot = { state: options.local ?? scene(), liveEpoch: 3, rendererGeneration: 1, available: true, busy: false };
  let presence: Record<string, unknown> | null = null;
  const requests: Array<Record<string, unknown>> = [];
  const lock = vi.fn();
  const apply = vi.fn(async (state: VolumeViewState) => { local = { ...local, state: copy(state) }; });
  const capture = vi.fn(async () => ({ image: "data:image/png;base64,aGVsbG8=", manifest: { schema: "test-capture", display_only: true }, width: 8, height: 4 }));
  const adapter: VolumeSceneAdapter = { snapshot: () => copy(local), apply, capture, lock };
  const flushDisplay = vi.fn(async () => 7);
  const onChanged = vi.fn(), onConflict = vi.fn(), onError = vi.fn();
  const handle = async (operation: string, input: Record<string, unknown>): Promise<unknown> => {
    if (operation === "volume_view") return copy(document);
    if (operation === "save_volume_view") {
      if (input.expected_revision !== document.revision || input.expected_display_revision !== document.display_revision) throw new Error("Revision conflict");
      document = { ...document, revision: document.revision + 1, state: copy(input.state as VolumeViewState) };
      return copy(document);
    }
    if (operation === "volume_view_presence") {
      if (input.available && (input.revision !== document.revision || input.display_revision !== document.display_revision)) throw new Error("Presence revision mismatch");
      if (presence && presence.view_id === input.view_id && presence.renderer_generation === input.renderer_generation &&
          Number(input.live_epoch) < Number(presence.live_epoch)) throw new Error("Live epoch cannot move backwards");
      presence = copy(input); return copy(input);
    }
    if (operation === "volume_view_requests") return { requests: copy(requests.filter((request) => ["queued", "applying"].includes(String(request.status)))) };
    const request = requests.find((candidate) => candidate.request_id === input.request_id);
    if (!request) throw new Error(`Unknown operation or request ${operation}`);
    if (operation === "volume_view_request_apply") {
      document = { ...document, revision: document.revision + 1, state: copy(request.proposed_state as VolumeViewState) };
      request.status = "applying";
      request.applied_live = { ...(request.expected_live as object), revision: document.revision };
      presence = { ...presence, revision: document.revision };
      return { request_id: request.request_id, status: "applying", live_token: copy(request.applied_live), view: copy(document) };
    }
    if (operation === "volume_view_request_complete") {
      if (!presence || presence.busy || !presence.available) throw new Error("View not ready");
      request.status = "complete"; return { request_id: request.request_id, status: "complete" };
    }
    if (operation === "volume_view_request_fail") { request.status = "failed"; return { request_id: request.request_id, status: "failed" }; }
    throw new Error(`Unexpected operation ${operation}`);
  };
  const execute = vi.fn(handle);
  const bridge = new VolumeSceneBridge({ api: { execute }, binding: { sourceId, sourceSha256, viewId: "workspace:volume" },
    adapter, flushDisplay, onChanged, onConflict, onError });
  bridges.push(bridge);
  const token = (): VolumeLiveToken => ({ view_id: "workspace:volume", renderer_generation: local.rendererGeneration, live_epoch: local.liveEpoch,
    revision: document.revision, display_revision: document.display_revision });
  const queue = (kind: "set" | "image", state = scene(), patch: Record<string, unknown> = {}) => {
    const request = { request_id: "d".repeat(32), source_id: sourceId, source_sha256: sourceSha256, kind, status: "queued", expected_live: token(),
      proposed_state: copy(state), panes: kind === "image" ? ["volume", "axial"] : [], max_size: 1024, ...patch };
    requests.push(request); return request;
  };
  return { bridge, execute, handle, adapter, apply, capture, lock, flushDisplay, onChanged, onConflict, onError, queue, token,
    local: () => copy(local), change: (patch: Partial<VolumeSceneSnapshot>) => { local = { ...local, ...copy(patch) }; },
    document: () => copy(document), changeDocument: (patch: Partial<VolumeViewDocument>) => { document = { ...document, ...copy(patch) }; },
    presence: () => copy(presence) };
}

describe("volume scene lifecycle and CAS", () => {
  it("withdraws the acknowledged epoch after its renderer has detached", async () => {
    const f = setup(); f.change({ liveEpoch: 37, rendererGeneration: 0 }); await f.bridge.start();
    f.adapter.snapshot = () => null;
    await f.bridge.dispose();
    expect(f.presence()).toMatchObject({ live_epoch: 37, renderer_generation: 0, available: false, busy: false });
  });
  it("waits for an in-flight presence before withdrawing its newly accepted epoch", async () => {
    const f = setup(); await f.bridge.start(); f.change({ liveEpoch: 44 });
    const gate = deferred<void>(); const entered = deferred<void>();
    f.execute.mockImplementation(async (operation, request) => {
      if (operation === "volume_view_presence" && request.available === true) { entered.resolve(); await gate.promise; }
      return f.handle(operation, request);
    });
    const update = f.bridge.update(); const rejected = expect(update).rejects.toThrow(/closed/);
    await entered.promise; f.adapter.snapshot = () => null;
    const disposal = f.bridge.dispose(); gate.resolve(); await disposal; await rejected;
    expect(f.presence()).toMatchObject({ live_epoch: 44, available: false, busy: false });
  });
  it("does not manufacture presence when disposed before first publication", async () => {
    const f = setup(); f.adapter.snapshot = () => null; await f.bridge.dispose();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("restores a saved scene once under a gesture lock and publishes only its exact bound revision", async () => {
    const saved = scene(); saved.crosshair_source_xyz = [8, 7, 6];
    const f = setup({ saved }); await f.bridge.start(); await f.bridge.start(); await f.bridge.update();
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(saved);
    expect(f.lock.mock.calls.slice(0, 2)).toEqual([[true], [false]]);
    expect(f.local().state).toEqual(saved);
    expect(f.presence()).toMatchObject({ available: true, revision: 2, display_revision: 7, live_epoch: 3 });
  });
  it("does not restore after human input changes while initial read is pending", async () => {
    const f = setup(); const wait = deferred<unknown>();
    f.execute.mockImplementationOnce(() => wait.promise);
    const start = f.bridge.start(); const rejection = expect(start).rejects.toThrow(/local volume view changed/);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalled());
    f.change({ liveEpoch: 4 }); wait.resolve(f.document()); await rejection;
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("preserves a completed human edit before delayed initialization and saves it against the original revision", async () => {
    const f = setup(); f.change({ available: false });
    const edited = scene(); edited.crosshair_source_xyz = [9, 4, 7];
    // The renderer became ready and a gesture finished before the debounced owner started the bridge.
    f.change({ available: true, busy: false, liveEpoch: 4, state: edited });
    await f.bridge.start({ restore: false }); await f.bridge.update();
    expect(f.apply).not.toHaveBeenCalled(); expect(f.local().state).toEqual(edited);
    expect(f.bridge.current).toMatchObject({ revision: 2, state: scene() });
    expect(f.presence()).toMatchObject({ available: false, revision: 2, live_epoch: 4 });
    expect(f.execute.mock.calls.filter(([operation]) => operation === "volume_view_requests")).toHaveLength(0);
    await f.bridge.save(f.local());
    expect(f.execute).toHaveBeenCalledWith("save_volume_view", expect.objectContaining({ expected_revision: 2, expected_display_revision: 7, state: edited }));
    expect(f.document().state).toEqual(edited); expect(f.local().state).toEqual(edited);
    expect(f.presence()).toMatchObject({ available: true, revision: 3, live_epoch: 4 });
  });
  it("keeps an explicitly selected correction revision when reopening the same source volume", async () => {
    const saved = scene(); saved.result = { result_id: "d".repeat(32), revision_hash: "e".repeat(64), label_sha256: "f".repeat(64) };
    const corrected = copy(saved); corrected.result = { ...saved.result, result_id: "e".repeat(32), revision_hash: "f".repeat(64) };
    const f = setup({ saved, local: corrected });
    await f.bridge.start({ preserveCurrentResult: true });
    expect(f.apply).not.toHaveBeenCalled(); expect(f.local().state).toEqual(corrected);
    expect(f.presence()).toMatchObject({ available: false });
    await f.bridge.save(f.local());
    expect(f.document().state?.result).toEqual(corrected.result);
  });
  it("keeps restore:false unavailable until an explicit save even when the human view equals the saved state", async () => {
    const f = setup(); f.change({ liveEpoch: 4 });
    await f.bridge.start({ restore: false }); await f.bridge.update();
    expect(f.presence()).toMatchObject({ available: false }); expect(f.apply).not.toHaveBeenCalled();
    await f.bridge.save(f.local());
    expect(f.presence()).toMatchObject({ available: true, revision: 3 });
  });
  it("treats a saved null camera as unresolved and preserves the verified renderer until explicit save", async () => {
    const unresolved = scene(); unresolved.camera = null; unresolved.crosshair_source_xyz = [8, 7, 6];
    const f = setup({ saved: unresolved }); const rendered = f.local();
    await f.bridge.start(); await f.bridge.update();
    expect(f.apply).not.toHaveBeenCalled(); expect(f.local()).toEqual(rendered);
    expect(f.bridge.current).toMatchObject({ revision: 2, state: unresolved });
    expect(f.presence()).toMatchObject({ available: false });
    await f.bridge.save(rendered);
    expect(f.execute).toHaveBeenCalledWith("save_volume_view", expect.objectContaining({ expected_revision: 2, state: rendered.state }));
    expect(f.document().state?.camera).toEqual(rendered.state.camera);
    expect(f.presence()).toMatchObject({ available: true, revision: 3 });
  });
  it("publishes no saved scene as unavailable, then saves an explicit snapshot with CAS", async () => {
    const f = setup({ saved: null }); await f.bridge.start();
    expect(f.presence()).toMatchObject({ available: false });
    await f.bridge.save(f.local());
    expect(f.execute).toHaveBeenCalledWith("save_volume_view", expect.objectContaining({ expected_revision: 2, expected_display_revision: 7, state: f.local().state }));
    expect(f.presence()).toMatchObject({ available: true, revision: 3 });
  });
  it("serializes captured writes and never applies an older saved scene over newer human work", async () => {
    const f = setup(); await f.bridge.start();
    const gate = deferred<void>(); let writes = 0, active = 0, maximum = 0;
    f.execute.mockImplementation(async (operation, input) => {
      if (operation !== "save_volume_view") return f.handle(operation, input);
      writes++; active++; maximum = Math.max(maximum, active);
      if (writes === 1) await gate.promise;
      try { return await f.handle(operation, input); } finally { active--; }
    });
    const first = f.bridge.save(f.local()); const firstRejected = expect(first).rejects.toThrow(/local volume view changed/);
    await vi.waitFor(() => expect(writes).toBe(1));
    const next = scene(); next.crosshair_source_xyz = [7, 1, 4];
    f.change({ state: next, liveEpoch: 4 });
    const second = f.bridge.save(f.local()); gate.resolve();
    await firstRejected; await second;
    expect(maximum).toBe(1); expect(writes).toBe(2);
    expect(f.document().state).toEqual(next); expect(f.local().state).toEqual(next); expect(f.apply).not.toHaveBeenCalled();
  });
  it("rejects a local change during display flush before any save", async () => {
    const f = setup(); await f.bridge.start();
    f.flushDisplay.mockImplementationOnce(async () => { f.change({ liveEpoch: 4 }); return 7; });
    await expect(f.bridge.save(f.local())).rejects.toThrow(/local volume view changed/);
    expect(f.execute.mock.calls.filter(([operation]) => operation === "save_volume_view")).toHaveLength(0);
  });
  it("reports an external revision conflict and requires explicit acknowledgment before a later save", async () => {
    const f = setup(); await f.bridge.start();
    f.changeDocument({ revision: 3 });
    await expect(f.bridge.save(f.local())).rejects.toThrow(/Review the current revision/);
    expect(f.onConflict).toHaveBeenLastCalledWith(f.document());
    await expect(f.bridge.save(f.local())).rejects.toThrow(/Review the current revision/);
    expect(f.execute.mock.calls.filter(([operation]) => operation === "save_volume_view")).toHaveLength(0);
    f.bridge.acceptConflict(f.document()); await f.bridge.save(f.local());
    expect(f.document().revision).toBe(4);
  });
  it("does not bless a display revision the renderer has not represented", async () => {
    const f = setup(); await f.bridge.start(); f.changeDocument({ display_revision: 8 });
    await expect(f.bridge.save(f.local())).rejects.toThrow(/source display changed/);
    expect(f.onConflict).toHaveBeenCalled();
    expect(f.execute.mock.calls.filter(([operation]) => operation === "save_volume_view")).toHaveLength(0);
  });
  it("re-reads a rejected CAS without retrying or changing the local scene", async () => {
    const f = setup(); await f.bridge.start();
    f.execute.mockImplementation(async (operation, input) => {
      if (operation === "save_volume_view") { f.changeDocument({ revision: 4 }); throw new Error("Revision conflict"); }
      return f.handle(operation, input);
    });
    await expect(f.bridge.save(f.local())).rejects.toThrow(/Review the current revision/);
    expect(f.onConflict).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }));
    expect(f.execute.mock.calls.filter(([operation]) => operation === "save_volume_view")).toHaveLength(1);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("publishes busy and unavailable states without polling for work", async () => {
    const f = setup(); await f.bridge.start(); f.execute.mockClear();
    f.change({ busy: true, liveEpoch: 4 }); await f.bridge.update();
    expect(f.presence()).toMatchObject({ busy: true, live_epoch: 4 });
    f.change({ available: false, busy: false }); await f.bridge.update();
    expect(f.presence()).toMatchObject({ available: false });
    expect(f.execute.mock.calls.filter(([operation]) => operation === "volume_view_requests")).toHaveLength(0);
  });
});

describe("exact-token agent handshake", () => {
  it("claims, renders and acknowledges an exact state under the gesture lock", async () => {
    const f = setup(); await f.bridge.start();
    const target = scene(); target.crosshair_source_xyz = [1, 2, 3]; const request = f.queue("set", target);
    await f.bridge.update();
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(target);
    expect(f.execute).toHaveBeenCalledWith("volume_view_request_complete", { request_id: request.request_id, live_token: { ...request.expected_live, revision: 3 }, capture: null });
    expect(f.local().state).toEqual(target); expect(f.lock).toHaveBeenLastCalledWith(false);
    expect(f.onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: target, revision: 3 }));
  });
  it("fails an old token and an interrupted apply without applying either scene", async () => {
    const f = setup(); await f.bridge.start();
    f.queue("set", scene(), { expected_live: { ...f.token(), live_epoch: 2 } });
    await expect(f.bridge.update()).rejects.toThrow(/older view/);
    expect(f.execute).toHaveBeenCalledWith("volume_view_request_fail", expect.objectContaining({ reason: "stale" }));
    f.queue("set", scene(), { request_id: "e".repeat(32), status: "applying", applied_live: f.token() });
    await expect(f.bridge.update()).rejects.toThrow(/interrupted volume request/);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("does not apply a claimed request after a renderer-generation change", async () => {
    const f = setup(); await f.bridge.start(); f.queue("set");
    f.execute.mockImplementation(async (operation, input) => {
      const value = await f.handle(operation, input);
      if (operation === "volume_view_request_apply") f.change({ rendererGeneration: 2 });
      return value;
    });
    await expect(f.bridge.update()).rejects.toThrow(/local volume view changed/);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.execute.mock.calls.filter(([operation]) => operation === "volume_view_request_complete")).toHaveLength(0);
    expect(f.lock).toHaveBeenLastCalledWith(false);
  });
  it("keeps applying presence alive every three seconds and clears busy before acknowledging", async () => {
    vi.useFakeTimers(); const f = setup(); await f.bridge.start();
    const target = scene(); target.crosshair_source_xyz = [1, 2, 3]; f.queue("set", target);
    const gate = deferred<void>();
    f.apply.mockImplementation(async (state) => { await gate.promise; f.change({ state }); });
    const update = f.bridge.update();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.apply).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9000);
    const busyPulses = f.execute.mock.calls.filter(([operation, request]) => operation === "volume_view_presence" && request.busy === true);
    expect(busyPulses).toHaveLength(3);
    expect(busyPulses.every(([, request]) => request.revision === 3 && request.live_epoch === 3)).toBe(true);
    gate.resolve(); await update;
    expect(f.presence()).toMatchObject({ busy: false, available: true, revision: 3 });
    expect(f.onError).not.toHaveBeenCalled();
  });
  it("delivers actual adapter pixels with the exact scene token, panes and manifest", async () => {
    const f = setup(); await f.bridge.start(); const request = f.queue("image"); await f.bridge.update();
    expect(f.capture).toHaveBeenCalledWith(["volume", "axial"], 1024);
    expect(f.execute).toHaveBeenCalledWith("volume_view_request_complete", expect.objectContaining({
      request_id: request.request_id, live_token: request.expected_live,
      capture: { image: "data:image/png;base64,aGVsbG8=", rendering: { kind: "gui-rendered-scene", source_id: sourceId, source_sha256: sourceSha256,
        geometry_sha256: "c".repeat(64), live_token: request.expected_live, panes: ["volume", "axial"], width: 8, height: 4,
        manifest: { schema: "test-capture", display_only: true } } },
    }));
  });
  it("discards an applying heartbeat that finishes after rendering and acknowledgment", async () => {
    vi.useFakeTimers(); const f = setup(); await f.bridge.start();
    const target = scene(); target.crosshair_source_xyz = [1, 2, 3]; f.queue("set", target);
    const applyGate = deferred<void>(); const pulseGate = deferred<number>();
    f.apply.mockImplementation(async (state) => { await applyGate.promise; f.change({ state }); });
    const update = f.bridge.update(); await vi.advanceTimersByTimeAsync(1);
    f.flushDisplay.mockImplementationOnce(() => pulseGate.promise);
    await vi.advanceTimersByTimeAsync(3000);
    applyGate.resolve(); await update;
    pulseGate.resolve(7); await vi.advanceTimersByTimeAsync(0);
    expect(f.presence()).toMatchObject({ busy: false, revision: 3 });
    expect(f.onError).not.toHaveBeenCalled();
  });
  it("discards pixels after human input changes during an asynchronous capture", async () => {
    const f = setup(); await f.bridge.start(); f.queue("image");
    f.capture.mockImplementation(async () => {
      f.change({ liveEpoch: 4 });
      return { image: "data:image/png;base64,aGVsbG8=", manifest: { schema: "test-capture", display_only: true }, width: 8, height: 4 };
    });
    await expect(f.bridge.update()).rejects.toThrow(/local volume view changed/);
    expect(f.execute.mock.calls.filter(([operation]) => operation === "volume_view_request_complete")).toHaveLength(0);
    expect(f.execute).toHaveBeenCalledWith("volume_view_request_fail", expect.objectContaining({ reason: "stale" }));
    expect(f.lock).toHaveBeenLastCalledWith(false);
  });
  it("refuses captures carrying native locations and never submits them", async () => {
    const f = setup(); await f.bridge.start(); f.queue("image");
    f.capture.mockResolvedValue({ image: "data:image/png;base64,aGVsbG8=", manifest: { schema: "test-capture", display_only: true, path: "/private/image" } as never, width: 8, height: 4 });
    await expect(f.bridge.update()).rejects.toThrow(/native locations/);
    expect(f.execute).toHaveBeenCalledWith("volume_view_request_fail", expect.objectContaining({ reason: "capture-failed" }));
    expect(f.execute.mock.calls.filter(([operation]) => operation === "volume_view_request_complete")).toHaveLength(0);
  });
  it("withdraws presence and cancels a capture when the bridge is disposed", async () => {
    const f = setup(); await f.bridge.start(); f.queue("image");
    const gate = deferred<void>(); f.capture.mockImplementation(async () => {
      await gate.promise; return { image: "data:image/png;base64,aGVsbG8=", manifest: { schema: "test-capture", display_only: true }, width: 8, height: 4 };
    });
    const update = f.bridge.update(); const rejected = expect(update).rejects.toThrow(/closed/);
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalled());
    await f.bridge.dispose(); gate.resolve(); await rejected;
    expect(f.presence()).toMatchObject({ available: false });
    expect(f.execute).toHaveBeenCalledWith("volume_view_request_fail", expect.objectContaining({ reason: "cancelled" }));
    expect(f.execute.mock.calls.filter(([operation]) => operation === "volume_view_request_complete")).toHaveLength(0);
  });
});

describe("renderer state boundary", () => {
  it.each([
    { crosshair_source_xyz: [0, Number.NaN, 1] }, { channels: [0, 0] },
    { labels: { visible: true, selected_only: false, opacity: .4 } },
    { layout: { ...scene().layout, pane_order: ["volume", "volume", "axial", "coronal"] } },
    { unexpected: true },
  ])("rejects unsupported state %# instead of silently repairing it", (patch) => {
    expect(() => checkedVolumeViewState({ ...scene(), ...patch })).toThrow(/supported state contract/);
  });
});
