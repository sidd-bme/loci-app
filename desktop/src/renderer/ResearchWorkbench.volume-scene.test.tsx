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
  snapshot: VolumeSceneSnapshot; locked: boolean; changed: (() => void) | null;
}>());

// Keep the Workbench, SourceViewStore and VolumeSceneBridge real. The test boundary
// replaces GPU rendering with an explicit adapter, never the lifecycle under test.
vi.mock("./RawVolumeViewport", async () => {
  const React = await import("react");
  return { RawVolumeViewport: ({ volume, loading, sceneHandleRef, onSceneChange }: {
    volume: { context: { source_id: string } } | null; loading?: boolean;
    sceneHandleRef?: RefObject<VolumeSceneAdapter | null>; onSceneChange?: () => void;
  }) => {
    const sourceId = !loading ? volume?.context.source_id : undefined;
    const entry = sourceId ? renderers.get(sourceId) : undefined;
    React.useEffect(() => {
      if (!entry || !sceneHandleRef) return;
      const adapter: VolumeSceneAdapter = {
        snapshot: () => structuredClone(entry.snapshot),
        apply: async (state) => { entry.snapshot.state = structuredClone(state); },
        capture: async () => { throw new Error("Lifecycle regression must not request an image capture."); },
        lock: (locked) => { entry.locked = locked; },
      };
      sceneHandleRef.current = adapter; entry.changed = onSceneChange ?? null;
      onSceneChange?.();
      return () => { if (sceneHandleRef.current === adapter) sceneHandleRef.current = null; entry.changed = null; };
    }, [entry, sceneHandleRef, onSceneChange]);
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
  metadata: { format: "OME-TIFF", axes: "TCZYX", sample_semantics: "scalar", channel_names: ["Signal"], channel_dtypes: ["uint8"],
    dimensions: { x: 64, y: 48, z: 3, t: 1, c: 1 }, levels: [{ index: 0, dimensions: { x: 64, y: 48, z: 3, t: 1, c: 1 } }] },
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
    snapshot: { state: scene(), liveEpoch: 0, rendererGeneration: 1, busy: false, available: true }, locked: false, changed: null,
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
  const execute = vi.fn(async (operation: string, request: Record<string, unknown>): Promise<unknown> => {
    const sourceId = String(request.source_id);
    const source = [first, second].find((item) => item.id === sourceId);
    if (operation === "volume_view_requests") return { requests: [] };
    if (!source) return {};
    if (operation === "viewer_defaults") {
      events.push(`source-defaults:${sourceId}`);
      return { source_id: sourceId, source_sha256: source.sha256, basis: "Synthetic acquisition range",
        channels: [{ channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true }] };
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
    if (operation === "viewer_volume") return { schema_version: 1, context: { source_id: sourceId, source_sha256: source.sha256, t: request.t }, focus: null };
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

describe("Workbench volume scene lifecycle barriers", () => {
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
});
