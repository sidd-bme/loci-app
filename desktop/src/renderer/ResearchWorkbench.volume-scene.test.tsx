// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import type { ResearchDesktopApi, ResearchSnapshot, ResearchSource, ResearchWorkspaceChange } from "../shared/research-contracts";
import type { SavedSourceView } from "./source-view-store";
import type { VolumeSceneAdapter, VolumeSceneSnapshot, VolumeViewDocument, VolumeViewState } from "./volume-scene-types";
import ResearchWorkbench from "./ResearchWorkbench";

const renderers = vi.hoisted(() => new Map<string, {
  snapshot: VolumeSceneSnapshot; locked: boolean; changed: (() => void) | null; appliedStates: VolumeViewState[];
}>());

// Keep the Workbench, SourceViewStore and VolumeSceneBridge real. The test boundary
// replaces GPU rendering with an explicit adapter, never the lifecycle under test.
vi.mock("./RawVolumeViewport", async () => {
  const React = await import("react");
  return { RawVolumeViewport: ({ volume, loading, sceneHandleRef, onSceneChange }: {
    volume: { context: { source_id: string; t: number; components: Array<{ channel_index: number }> } } | null; loading?: boolean;
    sceneHandleRef?: RefObject<VolumeSceneAdapter | null>; onSceneChange?: () => void;
  }) => {
    const sourceId = !loading ? volume?.context.source_id : undefined;
    const entry = sourceId ? renderers.get(sourceId) : undefined;
    React.useEffect(() => {
      if (!entry || !sceneHandleRef) return;
      entry.snapshot.state.t = volume!.context.t;
      entry.snapshot.state.channels = volume!.context.components.map(component => component.channel_index);
      const adapter: VolumeSceneAdapter = {
        snapshot: () => structuredClone(entry.snapshot),
        apply: async (state) => {
          entry.appliedStates.push(structuredClone(state)); entry.snapshot.state = structuredClone(state);
          // Actual scene application resolves after a rendered frame, allowing
          // Workbench target effects to commit while the renderer is locked.
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        },
        capture: async () => { throw new Error("Lifecycle regression must not request an image capture."); },
        lock: (locked) => { entry.locked = locked; },
      };
      sceneHandleRef.current = adapter; entry.changed = onSceneChange ?? null;
      onSceneChange?.();
      return () => { if (sceneHandleRef.current === adapter) sceneHandleRef.current = null; entry.changed = null; };
    }, [entry, volume, sceneHandleRef, onSceneChange]);
    return entry ? <div aria-label="Mock volume renderer ready">
      <button type="button" onClick={() => {
        if (entry.locked) throw new Error("A human edit reached the locked mock renderer.");
        entry.snapshot.liveEpoch++;
        entry.snapshot.state.crosshair_source_xyz = [11, 3, 1];
        onSceneChange?.();
      }}>Move mock crosshair</button>
    </div> : <div aria-label="Mock volume renderer loading" />;
  } };
});

const first: ResearchSource = {
  id: "a".repeat(32), sha256: "b".repeat(64), name: "First volume", source_kind: "native",
  metadata: { format: "OME-TIFF", axes: "TCZYX", sample_semantics: "scalar", channel_names: ["Signal", "Reference"], channel_dtypes: ["uint8", "uint8"],
    dimensions: { x: 64, y: 48, z: 3, t: 2, c: 2 }, levels: [{ index: 0, dimensions: { x: 64, y: 48, z: 3, t: 2, c: 2 } }] },
};
const second: ResearchSource = { ...structuredClone(first), id: "c".repeat(32), sha256: "d".repeat(64), name: "Second volume" };
const scene = (): VolumeViewState => ({
  t: 0, channels: [0], result: null, selected_object: null,
  representation: { mode: "volume", extent: "context", render_mode: "blend", quality: 50 },
  camera: { projection: "parallel", position_xyz: [0, 0, 40], focal_point_xyz: [0, 0, 0], view_up_xyz: [0, 1, 0],
    clipping_range: [.1, 100], view_angle_degrees: 30, parallel_scale: 10, frame: "image", unit: "pixel" },
  crosshair_source_xyz: [2, 3, 1], clipping: { enabled: false, axis: "z", position_percent: 50 },
  refinement: { target_long_axis: 128, focus_region_xyzxyz: null },
  layout: { mode: "four", expanded_pane: null, pane_order: ["axial", "coronal", "sagittal", "volume"], col_split: 50, row_split: 50 },
  labels: { visible: false, opacity: .4, selected_only: false },
});
function gate() {
  let entered = false;
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { release, entered: () => entered, wait: async () => { entered = true; await promise; } };
}

beforeEach(() => {
  renderers.clear();
  for (const source of [first, second]) renderers.set(source.id, {
    snapshot: { state: scene(), liveEpoch: 0, rendererGeneration: 1, busy: false, available: true }, locked: false, changed: null, appliedStates: [],
  });
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const context = Object.fromEntries(["setTransform", "fillRect", "drawImage", "beginPath", "moveTo", "lineTo", "closePath", "arc",
    "stroke", "fillText", "setLineDash", "save", "restore", "ellipse", "fill"].map((name) => [name, vi.fn()]));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList?.contains("image-viewport") ? 640 : 0;
    const height = width ? 480 : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    naturalWidth = 64; naturalHeight = 48; private value = "";
    set src(value: string) { this.value = value; queueMicrotask(() => this.onload?.()); }
    get src() { return this.value; }
  });
});
afterEach(async () => {
  cleanup();
  await act(async () => { await Promise.resolve(); });
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function fixture() {
  let study: ResearchSnapshot = {
    project: { project_id: "e".repeat(32), title: "Volume lifecycle fixture" }, sources: [first, second],
    results: [], samples: [], recipes: [], displays: [], selections: [], jobs: [],
    operations: { view: { mutates: false, summary: "View" }, volume_view: { mutates: false, summary: "Volume state" } },
    workspace: { revision: 0, closed_sources: [], hidden_results: [] },
  };
  const events: string[] = [];
  let lastPresence: Record<string, unknown> | null = null;
  const sourceViews = new Map<string, SavedSourceView>([first, second].map((source) => [source.id,
    { source_id: source.id, source_sha256: source.sha256, revision: 0, state: null }]));
  const volumeViews = new Map<string, VolumeViewDocument>([first, second].map((source) => [source.id,
    { schema: "loci.volume-view/v1", source_id: source.id, source_sha256: source.sha256, geometry_sha256: "f".repeat(64), revision: 0, display_revision: 0, state: null }]));
  let nextSave: ReturnType<typeof gate> | null = null;
  let nextRead: ReturnType<typeof gate> | null = null;
  let nextRawVolume: ReturnType<typeof gate> | null = null;
  let agentRequest: Record<string, unknown> | null = null;
  const execute = vi.fn(async (operation: string, request: Record<string, unknown>): Promise<unknown> => {
    const sourceId = String(request.source_id);
    const source = [first, second].find((item) => item.id === sourceId);
    if (operation === "volume_view_requests") return { requests: agentRequest?.status === "queued" ? [structuredClone(agentRequest)] : [] };
    if (operation === "volume_view_request_apply") {
      if (!agentRequest || request.request_id !== agentRequest.request_id) throw new Error("Fixture request identity mismatch");
      const previous = volumeViews.get(first.id)!;
      const token = agentRequest.expected_live as Record<string, unknown>;
      if (request.live_token && JSON.stringify(request.live_token) !== JSON.stringify(token)) throw new Error("Fixture request token mismatch");
      const saved: VolumeViewDocument = { ...previous, revision: previous.revision + 1,
        state: structuredClone(agentRequest.proposed_state) as VolumeViewState };
      volumeViews.set(first.id, saved); agentRequest.status = "applying";
      return { request_id: agentRequest.request_id, status: "applying", live_token: { ...token, revision: saved.revision }, view: structuredClone(saved) };
    }
    if (operation === "volume_view_request_complete" || operation === "volume_view_request_fail") {
      if (!agentRequest || request.request_id !== agentRequest.request_id) throw new Error("Fixture request identity mismatch");
      agentRequest.status = operation === "volume_view_request_complete" ? "complete" : "failed";
      if (operation === "volume_view_request_fail") agentRequest.reason = request.reason;
      return { request_id: agentRequest.request_id, status: agentRequest.status };
    }
    if (!source) return {};
    if (operation === "viewer_defaults") {
      events.push(`source-defaults:${sourceId}`);
      return { source_id: sourceId, source_sha256: source.sha256, basis: "Synthetic acquisition range",
        channels: [{ channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true },
          { channel: 1, low: 0, high: 255, gamma: 1, color: "#00ff00", opacity: 1, visible: false }] };
    }
    if (operation === "source_view") return structuredClone(sourceViews.get(sourceId));
    if (operation === "save_source_view") {
      const previous = sourceViews.get(sourceId)!;
      if (request.expected_revision !== previous.revision) throw new Error("Fixture source display conflict");
      const saved = { ...previous, revision: previous.revision + 1, state: structuredClone(request.state) as SavedSourceView["state"] };
      sourceViews.set(sourceId, saved); return structuredClone(saved);
    }
    if (operation === "source_annotations") return { source_id: sourceId, source_sha256: source.sha256, revision: 0, annotations: [], can_undo: false, can_redo: false };
    if (operation === "viewer_tile") return { image: "data:image/png;base64,fixture", source_sha256: source.sha256,
      ...(request.overview ? { source_extent: [64, 48], width: 64, height: 48,
        selection: { t: request.t ?? 0, z: request.z ?? 0, c: request.c ?? 0, z_stop: request.z_stop ?? null }, projection: request.projection ?? null } : { selection: request.selection }) };
    if (operation === "viewer_volume") {
      if (nextRawVolume) { const pending = nextRawVolume; nextRawVolume = null; await pending.wait(); }
      return { schema_version: 1, context: { source_id: sourceId, source_sha256: source.sha256, t: request.t,
        components: (request.channel_indices as number[]).map(channel_index => ({ channel_index })) }, focus: null };
    }
    if (operation === "volume_view") {
      if (nextRead) { const pending = nextRead; nextRead = null; await pending.wait(); }
      return { ...structuredClone(volumeViews.get(sourceId)), display_revision: sourceViews.get(sourceId)!.revision };
    }
    if (operation === "save_volume_view") {
      if (nextSave) { const pending = nextSave; nextSave = null; await pending.wait(); }
      const previous = volumeViews.get(sourceId)!;
      if (request.expected_revision !== previous.revision || request.expected_display_revision !== sourceViews.get(sourceId)!.revision)
        throw new Error("Fixture volume scene conflict");
      const saved: VolumeViewDocument = { ...previous, revision: previous.revision + 1, display_revision: Number(request.expected_display_revision), state: structuredClone(request.state) as VolumeViewState };
      volumeViews.set(sourceId, saved); events.push(`scene-saved:${sourceId}:${saved.revision}`);
      return structuredClone(saved);
    }
    if (operation === "volume_view_presence") {
      if (request.available && (request.revision !== volumeViews.get(sourceId)!.revision || request.display_revision !== sourceViews.get(sourceId)!.revision))
        throw new Error("Fixture presence does not match persisted scene");
      if (sourceId === first.id) lastPresence = structuredClone(request);
      return structuredClone(request);
    }
    return {};
  });
  const openImages = vi.fn(async () => { events.push("native-open-images"); return null; });
  const openStudy = vi.fn(async () => { events.push("native-open-study"); return null; });
  const updateWorkspace = vi.fn(async (change: ResearchWorkspaceChange) => {
    events.push("native-close-source");
    const hidden = new Set(change.sources.filter((item) => !item.visible).map((item) => item.id));
    study = { ...study, sources: study.sources.filter((item) => !hidden.has(item.id)),
      workspace: { revision: change.expected_revision + 1, closed_sources: [first, second].filter((item) => hidden.has(item.id)), hidden_results: [] } };
    return study;
  });
  const api = { getSnapshot: vi.fn(async () => study), execute, openImages, openStudy, updateWorkspace,
    createStudy: vi.fn(async () => study), addSources: vi.fn(async () => study), reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn() } as ResearchDesktopApi;
  return { api, execute, events, openImages, openStudy, updateWorkspace,
    isSceneReady: () => lastPresence?.available === true && Number(lastPresence.revision) > 0,
    state: () => structuredClone(volumeViews.get(first.id)!),
    holdSave: () => { const pending = gate(); nextSave = pending; return pending; },
    holdRead: () => { const pending = gate(); nextRead = pending; return pending; },
    holdRawVolume: () => { const pending = gate(); nextRawVolume = pending; return pending; },
    externalSceneEdit: () => {
      const previous = volumeViews.get(first.id)!;
      const state = structuredClone(previous.state!); state.labels.opacity = .2;
      volumeViews.set(first.id, { ...previous, revision: previous.revision + 1, state });
    },
    externalDisplayEdit: () => {
      const previous = sourceViews.get(first.id)!;
      sourceViews.set(first.id, { ...previous, revision: previous.revision + 1 });
    },
    requestStatus: () => agentRequest?.status,
    queueAgentSet: (state: VolumeViewState) => {
      if (!lastPresence?.available) throw new Error("Fixture must publish a ready scene before queuing an agent edit");
      const expected_live = Object.fromEntries(["view_id", "renderer_generation", "live_epoch", "revision", "display_revision"].map(key => [key, lastPresence![key]]));
      agentRequest = { request_id: "6".repeat(32), source_id: first.id, source_sha256: first.sha256,
        kind: "set", status: "queued", expected_live, proposed_state: structuredClone(state), panes: [], max_size: 1024 };
      renderers.get(first.id)!.changed?.();
    },
  };
}

async function openVolume(f: ReturnType<typeof fixture>, initialized = true) {
  render(<ResearchWorkbench api={f.api} onBack={vi.fn()} />);
  const open = await screen.findByRole("button", { name: "3D volume" });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  await screen.findByLabelText("Mock volume renderer ready");
  if (initialized) await waitFor(() => expect(f.isSceneReady()).toBe(true));
}
function beginPointer() {
  const event = new Event("pointerdown", { bubbles: true }); Object.defineProperty(event, "pointerId", { value: 17 });
  fireEvent(screen.getByLabelText("Mock volume renderer ready"), event);
}
function endPointer() {
  const event = new Event("pointerup", { bubbles: true }); Object.defineProperty(event, "pointerId", { value: 17 }); fireEvent(window, event);
}

function pointerClick(element: Element) {
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new Event(type, { bubbles: true }); Object.defineProperty(event, "pointerId", { value: 23 });
    fireEvent(element, event);
  }
  fireEvent.click(element);
}

async function holdOlderAutosave(f: ReturnType<typeof fixture>) {
  const renderer = renderers.get(first.id)!, pending = f.holdSave();
  await act(async () => {
    renderer.snapshot.liveEpoch++;
    renderer.snapshot.state.labels.selected_only = true;
    renderer.changed?.();
  });
  await waitFor(() => expect(pending.entered()).toBe(true));
  return { renderer, pending };
}

describe("Workbench volume scene lifecycle barriers", () => {
  it("persists the latest local label controls when their debounce joins a superseded save", async () => {
    const f = fixture(); await openVolume(f);
    const renderer = renderers.get(first.id)!;
    const pending = f.holdSave();
    await act(async () => {
      renderer.snapshot.liveEpoch++;
      renderer.snapshot.state.labels.selected_only = true;
      renderer.changed?.();
    });
    await waitFor(() => expect(pending.entered()).toBe(true));
    await act(async () => {
      // Renderer state can advance without another workbench pointer event.
      renderer.snapshot.liveEpoch++;
      renderer.snapshot.state.labels.opacity = .7;
      renderer.changed?.();
      // Let the second 350ms debounce join the older unresolved native write.
      await new Promise(resolve => setTimeout(resolve, 400));
    });
    await act(async () => pending.release());
    await waitFor(() => expect(f.state().state?.labels).toEqual({ visible: false, selected_only: true, opacity: .7 }));
    expect(renderer.snapshot.state.labels).toEqual(f.state().state?.labels);
    expect(renderer.appliedStates).toEqual([]);
    expect(screen.queryByRole("button", { name: "Retry shared view" })).not.toBeInTheDocument();
  });

  it("drains an unchanged boundary snapshot after its pointer click supersedes an older autosave", async () => {
    const f = fixture(); await openVolume(f);
    const { renderer, pending } = await holdOlderAutosave(f);
    renderer.snapshot.liveEpoch++; renderer.snapshot.state.labels.opacity = .7;
    const boundaryState = structuredClone(renderer.snapshot.state);
    await act(async () => { pointerClick(screen.getByRole("button", { name: "Add images…" })); });
    try { expect(f.openImages).not.toHaveBeenCalled(); }
    finally { await act(async () => pending.release()); }
    await waitFor(() => expect(f.openImages).toHaveBeenCalledOnce());
    expect(f.state().state).toEqual(boundaryState);
    expect(renderer.snapshot.state).toEqual(boundaryState);
    const saved = f.events.filter(event => event.startsWith(`scene-saved:${first.id}:`));
    expect(saved.length).toBeGreaterThanOrEqual(3); // initial, older A, current boundary B
    expect(f.events.indexOf(saved.at(-1)!)).toBeLessThan(f.events.indexOf("native-open-images"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry shared view" })).not.toBeInTheDocument();
  });

  it.each(["human-input", "renderer-generation"] as const)("blocks a boundary snapshot changed by later %s while joining an older save", async (change) => {
    const f = fixture(); await openVolume(f);
    const { renderer, pending } = await holdOlderAutosave(f);
    renderer.snapshot.liveEpoch++; renderer.snapshot.state.labels.opacity = .7;
    await act(async () => { pointerClick(screen.getByRole("button", { name: "Add images…" })); });
    expect(f.openImages).not.toHaveBeenCalled();
    if (change === "human-input") {
      // The boundary's initiating click is accepted; this distinct later intent is not.
      fireEvent.keyDown(window, { key: "ArrowRight" });
      renderer.snapshot.liveEpoch++; renderer.snapshot.state.labels.opacity = .9;
    } else renderer.snapshot.rendererGeneration++;
    await act(async () => pending.release());
    await screen.findByRole("alert");
    expect(f.openImages).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Active image")).toHaveTextContent(first.name);
    expect(renderer.snapshot.state.labels.opacity).toBe(change === "human-input" ? .9 : .7);
    expect(renderer.appliedStates).toEqual([]);
  });

  it("blocks later human input after the boundary snapshot retry has started saving", async () => {
    const f = fixture(); await openVolume(f);
    const { renderer, pending: olderSave } = await holdOlderAutosave(f);
    renderer.snapshot.liveEpoch++; renderer.snapshot.state.labels.opacity = .7;
    await act(async () => { pointerClick(screen.getByRole("button", { name: "Add images…" })); });
    const boundarySave = f.holdSave();
    await act(async () => olderSave.release());
    try {
      await waitFor(() => expect(boundarySave.entered()).toBe(true));
      expect(f.openImages).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: "ArrowRight" });
      renderer.snapshot.liveEpoch++; renderer.snapshot.state.labels.opacity = .9;
    } finally { await act(async () => boundarySave.release()); }
    await screen.findByRole("alert");
    expect(f.openImages).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Active image")).toHaveTextContent(first.name);
    expect(renderer.snapshot.state.labels.opacity).toBe(.9);
    expect(renderer.appliedStates).toEqual([]);
  });

  it.each(["scene", "display"] as const)("does not retry a durable %s CAS conflict while draining a boundary snapshot", async (conflict) => {
    const f = fixture(); await openVolume(f);
    const { renderer, pending } = await holdOlderAutosave(f);
    const writesBeforeBoundary = f.execute.mock.calls.filter(([op]) => op === "save_volume_view").length;
    renderer.snapshot.liveEpoch++; renderer.snapshot.state.labels.opacity = .7;
    await act(async () => { pointerClick(screen.getByRole("button", { name: "Add images…" })); });
    if (conflict === "scene") f.externalSceneEdit(); else f.externalDisplayEdit();
    const externalState = f.state();
    await act(async () => pending.release());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Review the current revision/);
    expect(f.openImages).not.toHaveBeenCalled();
    expect(f.state()).toEqual(externalState);
    expect(f.execute.mock.calls.filter(([op]) => op === "save_volume_view")).toHaveLength(writesBeforeBoundary);
    expect(renderer.snapshot.state.labels.opacity).toBe(.7);
    expect(renderer.appliedStates).toEqual([]);
  });

  it("commits a pending scene before selecting another source", async () => {
    const f = fixture(); await openVolume(f);
    fireEvent.click(screen.getByRole("button", { name: "Move mock crosshair" }));
    const pending = f.holdSave();
    fireEvent.click(screen.getByRole("button", { name: /Second volume/ }));
    try {
      await waitFor(() => expect(pending.entered()).toBe(true));
      expect(screen.getByLabelText("Active image")).toHaveTextContent(first.name);
      expect(f.events).not.toContain(`source-defaults:${second.id}`);
    } finally { await act(async () => pending.release()); }
    await waitFor(() => expect(screen.getByLabelText("Active image")).toHaveTextContent(second.name));
    await waitFor(() => expect(f.events).toContain(`source-defaults:${second.id}`));
    expect(f.state().state?.crosshair_source_xyz).toEqual([11, 3, 1]);
    expect(f.events.indexOf(`scene-saved:${first.id}:2`)).toBeLessThan(f.events.indexOf(`source-defaults:${second.id}`));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["open-images", "close-source"] as const)("drains a pending scene before native %s despite workbench progress", async (boundary) => {
    const f = fixture(); await openVolume(f);
    fireEvent.click(screen.getByRole("button", { name: "Move mock crosshair" }));
    const pending = f.holdSave();
    const native = boundary === "open-images" ? f.openImages : f.updateWorkspace;
    fireEvent.click(screen.getByRole("button", { name: boundary === "open-images" ? "Add images…" : "Remove selected images" }));
    try {
      await waitFor(() => expect(pending.entered()).toBe(true));
      expect(native).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally { await act(async () => pending.release()); }
    await waitFor(() => expect(native).toHaveBeenCalledOnce());
    expect(f.state().state?.crosshair_source_xyz).toEqual([11, 3, 1]);
    expect(f.events.indexOf(`scene-saved:${first.id}:2`)).toBeLessThan(f.events.indexOf(`native-${boundary}`));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["renderer", "pointer"] as const)("keeps a real %s gesture busy during native draining", async (busyKind) => {
    const f = fixture(); await openVolume(f);
    const previous = f.state().revision;
    if (busyKind === "renderer") renderers.get(first.id)!.snapshot.busy = true;
    else beginPointer();
    fireEvent.click(screen.getByRole("button", { name: "Add images…" }));
    try {
      expect(await screen.findByRole("alert")).toHaveTextContent("Finish the active 3D interaction");
      expect(f.openImages).not.toHaveBeenCalled(); expect(f.state().revision).toBe(previous);
      expect(screen.getByLabelText("Active image")).toHaveTextContent(first.name);
    } finally { renderers.get(first.id)!.snapshot.busy = false; if (busyKind === "pointer") endPointer(); }
  });

  it("saves a ready scene before immediate source navigation beats the first debounce", async () => {
    const f = fixture(); await openVolume(f, false);
    expect(f.state().revision).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Move mock crosshair" }));
    fireEvent.click(screen.getByRole("button", { name: /Second volume/ }));
    await waitFor(() => expect(screen.getByLabelText("Active image")).toHaveTextContent(second.name));
    await waitFor(() => expect(f.events).toContain(`source-defaults:${second.id}`));
    expect(f.state().state?.crosshair_source_xyz).toEqual([11, 3, 1]);
    expect(f.events.indexOf(`scene-saved:${first.id}:1`)).toBeGreaterThanOrEqual(0);
    expect(f.events.indexOf(`scene-saved:${first.id}:1`)).toBeLessThan(f.events.indexOf(`source-defaults:${second.id}`));
  });

  it("awaits in-flight scene initialization before entering a native picker", async () => {
    const f = fixture(); const pending = f.holdRead();
    await openVolume(f, false);
    await waitFor(() => expect(pending.entered()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Add images…" }));
    try {
      expect(f.openImages).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally { await act(async () => pending.release()); }
    await waitFor(() => expect(f.openImages).toHaveBeenCalledOnce());
    expect(f.state().revision).toBeGreaterThan(0);
    expect(f.events.indexOf(`scene-saved:${first.id}:1`)).toBeLessThan(f.events.indexOf("native-open-images"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("keeps an agent scene edit on the ready payload without clearing or reloading identical inputs", async () => {
    const f = fixture(); await openVolume(f);
    const initialRequests = f.execute.mock.calls.filter(([op]) => op === "viewer_volume").length;
    const unexpectedReload = f.holdRawVolume();
    const target = structuredClone(renderers.get(first.id)!.snapshot.state);
    target.crosshair_source_xyz = [46, 34, 1]; target.labels.opacity = 0.65;
    try {
      await act(async () => { f.queueAgentSet(target); });
      await waitFor(() => expect(f.requestStatus()).toBe("complete"));
      expect(unexpectedReload.entered()).toBe(false);
      expect(f.execute.mock.calls.filter(([op]) => op === "viewer_volume")).toHaveLength(initialRequests);
      expect(renderers.get(first.id)!.snapshot.state).toEqual(target);
      expect(renderers.get(first.id)!.appliedStates).toEqual([target]);
      expect(screen.queryByText(/The volume renderer is unavailable/)).not.toBeInTheDocument();
    } finally { await act(async () => unexpectedReload.release()); }
  });

  it("waits for genuinely changed agent scene time and channels before applying or acknowledging", async () => {
    const f = fixture(); await openVolume(f);
    const load = f.holdRawVolume();
    const target = structuredClone(renderers.get(first.id)!.snapshot.state); target.t = 1; target.channels = [1];
    await act(async () => { f.queueAgentSet(target); });
    try {
      await waitFor(() => expect(load.entered()).toBe(true));
      expect(f.requestStatus()).toBe("applying");
      expect(renderers.get(first.id)!.appliedStates).toEqual([]);
      expect(f.execute).toHaveBeenCalledWith("viewer_volume", expect.objectContaining({ t: 1, channel_indices: [1] }));
    } finally { await act(async () => load.release()); }
    await waitFor(() => expect(f.requestStatus()).toBe("complete"));
    expect(renderers.get(first.id)!.appliedStates).toEqual([target]);
    expect(renderers.get(first.id)!.snapshot.state.t).toBe(1);
    expect(renderers.get(first.id)!.snapshot.state.channels).toEqual([1]);
  });

});
