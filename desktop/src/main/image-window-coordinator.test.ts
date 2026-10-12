// @vitest-environment node

import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";

import type { ImageViewTargetSnapshot } from "../shared/image-view-contracts";
import type {
  ImageWindowPresentation,
  ImageWindowState,
} from "../shared/image-window-api";
import type { ResearchSnapshot, ResearchSource } from "../shared/research-contracts";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/private/test-user-data" },
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) =>
      electronMocks.handlers.set(channel, handler),
  },
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  },
}));

vi.mock("./worker-client", () => ({
  sanitizedWorkerErrorMessage: (value: unknown) => String(value),
}));

import { ImageWindowCoordinator } from "./image-window-coordinator";

const SOURCE_A = "a".repeat(32);
const SOURCE_B = "b".repeat(32);
const HASH_A = "c".repeat(64);
const HASH_B = "d".repeat(64);

const sources: ResearchSource[] = [
  {
    id: SOURCE_A,
    sha256: HASH_A,
    name: "Image A",
    metadata: { dimensions: { x: 100, y: 80, z: 2, t: 1, c: 1 } },
  },
  {
    id: SOURCE_B,
    sha256: HASH_B,
    name: "Image B",
    metadata: { dimensions: { x: 120, y: 90, z: 1, t: 1, c: 1 } },
  },
];

function researchSnapshot(): ResearchSnapshot {
  return {
    project: { title: "Detached test" },
    sources: structuredClone(sources),
    results: [],
    samples: [],
    recipes: [],
    displays: [],
    selections: [],
    jobs: [],
    operations: {},
  };
}

class FakeWebContents extends EventEmitter {
  readonly mainFrame = {};
  destroyed = false;
  readonly send = vi.fn();
  isDestroyed(): boolean { return this.destroyed; }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  destroyed = false;
  visible = false;
  fullscreen = false;
  title = "";
  bounds = { x: 40, y: 40, width: 900, height: 700 };
  readonly show = vi.fn(() => { this.visible = true; });
  readonly focus = vi.fn(() => { this.emit("focus"); });
  readonly setTitle = vi.fn((value: string) => { this.title = value; });
  readonly setFullScreen = vi.fn((value: boolean) => {
    this.fullscreen = value;
    this.emit(value ? "enter-full-screen" : "leave-full-screen");
  });
  readonly setBounds = vi.fn((value: typeof this.bounds) => { this.bounds = { ...value }; });
  getBounds() { return { ...this.bounds }; }
  getNormalBounds() { return { ...this.bounds }; }
  isMaximized(): boolean { return false; }
  isFullScreen(): boolean { return this.fullscreen; }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }
}

interface StubBridge {
  getViewDocumentIdentity: ReturnType<typeof vi.fn>;
  onViewDocumentChanged: ReturnType<typeof vi.fn>;
  getViewSnapshot: ReturnType<typeof vi.fn>;
  executeImageView: ReturnType<typeof vi.fn>;
  exportVolumeFigure: ReturnType<typeof vi.fn>;
  cancelImageView: ReturnType<typeof vi.fn>;
  replaceDocument: () => void;
}

function makeBridge(): StubBridge {
  const listeners = new Set<() => void>();
  const bridge: StubBridge = {
    getViewDocumentIdentity: vi.fn(() => "/private/Study.loci-study"),
    onViewDocumentChanged: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getViewSnapshot: vi.fn(async () => researchSnapshot()),
    executeImageView: vi.fn(async (
      target: ImageViewTargetSnapshot,
      operation: string,
      _request: unknown,
      _options: unknown,
      access: "read" | "annotate",
      assertTargetCurrent?: () => void,
    ) => {
      assertTargetCurrent?.();
      if (operation === "annotate_source" && access !== "annotate") {
        throw new Error("Operation is not available to an image view.");
      }
      return operation === "annotate_source"
        ? { source_id: target.sourceId, source_sha256: target.sourceSha256, revision: 2 }
        : { source_id: target.sourceId, source_sha256: target.sourceSha256 };
    }),
    exportVolumeFigure: vi.fn(async (
      request: { source_id?: unknown; source_sha256?: unknown },
      assertTargetCurrent?: () => void,
    ) => {
      assertTargetCurrent?.();
      return { source_id: request.source_id, source_sha256: request.source_sha256 };
    }),
    cancelImageView: vi.fn(),
    replaceDocument: () => { for (const listener of [...listeners]) listener(); },
  };
  return bridge;
}

interface Harness {
  bridge: StubBridge;
  control: FakeWindow;
  imageWindows: FakeWindow[];
  loads: Array<ReturnType<typeof vi.fn>>;
  layout: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
}

function harness(): Harness {
  const bridge = makeBridge();
  const control = new FakeWindow();
  const imageWindows: FakeWindow[] = [];
  const loads: Array<ReturnType<typeof vi.fn>> = [];
  const factory = () => {
    const window = new FakeWindow();
    window.bounds.x += imageWindows.length * 80;
    const load = vi.fn(async () => undefined);
    imageWindows.push(window);
    loads.push(load);
    return {
      window: window as unknown as BrowserWindow,
      load,
    };
  };
  const layout = {
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
  };
  const Coordinator = ImageWindowCoordinator as unknown as new (
    bridge: StubBridge,
    factory: () => { window: BrowserWindow; load: () => Promise<void> },
    layout?: { read: (document: string) => Promise<unknown>; write: (document: string, value: unknown) => Promise<void> },
  ) => ImageWindowCoordinator;
  const coordinator = new Coordinator(bridge, factory, layout);
  coordinator.registerControl(control as unknown as BrowserWindow);
  coordinator.registerIpc();
  return { bridge, control, imageWindows, loads, layout };
}

function event(sender: FakeWebContents, frame: unknown = sender.mainFrame): IpcMainInvokeEvent {
  return { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
}

async function invoke(
  name: string,
  sender: FakeWebContents,
  ...args: unknown[]
): Promise<unknown> {
  const handler = electronMocks.handlers.get(`loci-image:${name}`);
  if (!handler) throw new Error(`Missing test IPC handler loci-image:${name}`);
  return handler(event(sender), ...args);
}

async function state(sender: FakeWebContents): Promise<ImageWindowState> {
  return await invoke("state", sender) as ImageWindowState;
}

async function open(sender: FakeWebContents, sourceId: string): Promise<ImageWindowState> {
  return await invoke("open", sender, sourceId) as ImageWindowState;
}

function presentation(): ImageWindowPresentation {
  return {
    mode: "plane",
    selection: { x: 0, y: 0, width: 100, height: 80, z: 0, t: 0, c: 0, level: 0 },
    channels: [{ channel: 0, low: 0, high: 255, gamma: 1, visible: true, color: "#ffffff" }],
    projection: "plane",
    tool: "navigate",
    draft: [],
    annotations: [],
    camera: null,
    showScaleBar: true,
    showNavigator: true,
  };
}

beforeEach(() => electronMocks.handlers.clear());

describe("native image window coordinator authority", () => {
  it("validates and transfers current display settings before creating the native window", async () => {
    const { control, imageWindows } = harness();
    const seed = presentation();
    seed.channels[0] = { ...seed.channels[0], color: "#a020e0", opacity: 0.37, gamma: 1.4 };
    seed.camera = { x: 12, y: 25, scale: 2 };
    const source = (await invoke("state", control.webContents)) as ImageWindowState;
    expect(source.views).toHaveLength(0);
    await expect(invoke("open", control.webContents, SOURCE_A,
      { sourceSha256: "0".repeat(64), presentation: seed })).rejects.toThrow("does not match");
    expect(imageWindows).toHaveLength(0);
    const opened = await invoke("open", control.webContents, SOURCE_A,
      { sourceSha256: HASH_A, presentation: seed }) as ImageWindowState;
    expect(opened.views[0].initialPresentation).toEqual(seed);
    expect(await invoke("presentation", imageWindows[0].webContents)).toMatchObject({ presentation: seed });
  });

  it("opens verified medical shape metadata without requiring native dimensions", async () => {
    const { bridge, control, imageWindows } = harness();
    const snapshot = researchSnapshot();
    snapshot.sources[0] = { ...snapshot.sources[0], source_kind: "medical", metadata: { shape: [2, 80, 100], geometry: { axes: "ZYX" } } };
    bridge.getViewSnapshot.mockResolvedValue(snapshot);
    await open(control.webContents, SOURCE_A);
    expect(imageWindows).toHaveLength(1);
    expect((await state(control.webContents)).views[0].source.metadata.shape).toEqual([2, 80, 100]);
  });
  it("registers only image-window IPC and rejects unknown or subframe senders", async () => {
    const { control } = harness();
    expect([...electronMocks.handlers.keys()]).not.toContain("loci-research:execute");
    expect([...electronMocks.handlers.keys()].every((key) => key.startsWith("loci-image:"))).toBe(true);

    const unknown = new FakeWebContents();
    await expect(invoke("state", unknown)).rejects.toThrow("cannot use");
    const handler = electronMocks.handlers.get("loci-image:state")!;
    await expect(handler(event(control.webContents, {}))).rejects.toThrow("cannot use");
  });

  it("prevents an image sender from targeting another view or using control capabilities", async () => {
    const { bridge, control, imageWindows } = harness();
    await open(control.webContents, SOURCE_A);
    await open(control.webContents, SOURCE_B);
    const controlState = await state(control.webContents);
    const [targetA, targetB] = controlState.views.map((view) => view.target);
    const senderA = imageWindows[0].webContents;

    await expect(invoke("close", senderA, targetB)).rejects.toThrow("cannot target another view");
    await expect(invoke("pin", senderA, targetA)).rejects.toThrow("cannot use");
    await expect(invoke("open", senderA, SOURCE_A)).rejects.toThrow("cannot use");
    await expect(invoke("publish", senderA, targetA, presentation())).rejects.toThrow("cannot use");
    await expect(invoke("execute", senderA, targetA, "annotate_source", {
      source_id: SOURCE_A,
      source_sha256: HASH_A,
      expected_revision: 1,
      action: "undo",
    })).rejects.toThrow("not available");

    await expect(invoke("execute", control.webContents, targetA, "annotate_source", {
      source_id: SOURCE_A,
      source_sha256: HASH_A,
      expected_revision: 1,
      action: "undo",
    })).resolves.toMatchObject({ source_id: SOURCE_A });
    expect(bridge.executeImageView.mock.calls.at(-1)?.[4]).toBe("annotate");
  });

  it("closing A invalidates its pending reply without cancelling B", async () => {
    const { bridge, control, imageWindows } = harness();
    await open(control.webContents, SOURCE_A);
    await open(control.webContents, SOURCE_B);
    const [targetA, targetB] = (await state(control.webContents)).views.map((view) => view.target);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bridge.executeImageView.mockImplementationOnce(async (
      _target: ImageViewTargetSnapshot,
      _operation: string,
      _request: unknown,
      _options: unknown,
      _access: string,
      assertTargetCurrent?: () => void,
    ) => {
      await gate;
      assertTargetCurrent?.();
      return { source_id: SOURCE_A, source_sha256: HASH_A };
    });
    const pendingA = invoke("execute", imageWindows[0].webContents, targetA, "source_view", {
      source_id: SOURCE_A,
    });
    await vi.waitFor(() => expect(bridge.executeImageView).toHaveBeenCalled());
    await invoke("close", imageWindows[0].webContents, targetA);
    release();
    await expect(pendingA).rejects.toThrow(/closed|capability|cancelled/i);
    expect(bridge.cancelImageView).toHaveBeenCalledWith(targetA.viewId);
    expect(bridge.cancelImageView).not.toHaveBeenCalledWith(targetB.viewId);
    expect((await state(imageWindows[1].webContents)).target?.viewId).toBe(targetB.viewId);
  });

  it("rejects a late draft from a different plane before forwarding it to controls", async () => {
    const { control, imageWindows } = harness();
    const opened = await open(control.webContents, SOURCE_A);
    const target = opened.views[0].target;
    await invoke("publish", control.webContents, target, presentation());
    await expect(invoke("interact", imageWindows[0].webContents, target,
      { kind: "draft", plane: { t: 0, z: 1 }, points: [{ x: 10, y: 20 }] })).rejects.toThrow("plane changed");
    await invoke("interact", imageWindows[0].webContents, target,
      { kind: "draft", plane: { t: 0, z: 0 }, points: [{ x: 10, y: 20 }] });
    expect(control.webContents.send).toHaveBeenCalledWith("loci-image:interaction", {
      target, interaction: { kind: "draft", plane: { t: 0, z: 0 }, points: [{ x: 10, y: 20 }] },
    });
  });

  it("tracks image focus while control focus preserves target and pinning freezes it", async () => {
    const { control, imageWindows } = harness();
    await open(control.webContents, SOURCE_A);
    await open(control.webContents, SOURCE_B);
    const [targetA, targetB] = (await state(control.webContents)).views.map((view) => view.target);

    imageWindows[0].focus();
    expect((await state(control.webContents)).target?.viewId).toBe(targetA.viewId);
    control.focus();
    expect((await state(control.webContents)).target?.viewId).toBe(targetA.viewId);
    await invoke("pin", control.webContents, targetA);
    imageWindows[1].focus();
    const pinned = await state(control.webContents);
    expect(pinned.pinned).toBe(true);
    expect(pinned.target?.viewId).toBe(targetA.viewId);
    await invoke("pin", control.webContents, null);
    const unpinned = await state(control.webContents);
    expect(unpinned.pinned).toBe(false);
    expect(unpinned.target?.viewId).toBe(targetB.viewId);
  });

  it("revokes the old generation on renderer crash and reopens only the current target", async () => {
    const { bridge, control, imageWindows, loads } = harness();
    await open(control.webContents, SOURCE_A);
    const oldTarget = (await state(control.webContents)).views[0].target;
    imageWindows[0].webContents.emit("render-process-gone");
    const crashed = await state(control.webContents);
    const currentTarget = crashed.views[0].target;
    expect(currentTarget.generation).toBe(oldTarget.generation + 1);
    expect(crashed.views[0].status).toBe("crashed");
    expect(bridge.cancelImageView).toHaveBeenCalledWith(oldTarget.viewId);

    await expect(invoke("execute", imageWindows[0].webContents, oldTarget, "source_view", {
      source_id: SOURCE_A,
    })).rejects.toThrow(/generation is stale/i);
    await expect(invoke("reopen", control.webContents, oldTarget)).rejects.toThrow(/generation is stale/i);
    await expect(invoke("reopen", control.webContents, currentTarget)).resolves.toBeUndefined();
    expect(loads[0]).toHaveBeenCalledTimes(2);
    await expect(invoke("execute", imageWindows[0].webContents, currentTarget, "source_view", {
      source_id: SOURCE_A,
    })).resolves.toMatchObject({ source_id: SOURCE_A });
  });

  it("allows two same-source views with independent identities and enforces the limit", async () => {
    const { control } = harness();
    await open(control.webContents, SOURCE_A);
    await open(control.webContents, SOURCE_A);
    const views = (await state(control.webContents)).views;
    expect(views).toHaveLength(2);
    expect(new Set(views.map((view) => view.target.viewId)).size).toBe(2);
    expect(views.every((view) => view.source.id === SOURCE_A)).toBe(true);
    await expect(open(control.webContents, SOURCE_B)).rejects.toThrow("Two image windows");
  });

  it("allows a child to export only its own exact source binding", async () => {
    const { bridge, control, imageWindows } = harness();
    await open(control.webContents, SOURCE_A);
    await open(control.webContents, SOURCE_B);
    const [targetA, targetB] = (await state(control.webContents)).views.map((view) => view.target);
    const requestA = { source_id: SOURCE_A, source_sha256: HASH_A, manifest: "bounded-test" };

    await expect(invoke(
      "export-figure",
      imageWindows[0].webContents,
      targetA,
      requestA,
    )).resolves.toMatchObject({ source_id: SOURCE_A, source_sha256: HASH_A });
    expect(bridge.exportVolumeFigure).toHaveBeenCalledWith(requestA, expect.any(Function));

    const callsAfterAllowedExport = bridge.exportVolumeFigure.mock.calls.length;
    await expect(invoke(
      "export-figure",
      imageWindows[0].webContents,
      targetA,
      { ...requestA, source_sha256: HASH_B },
    )).rejects.toThrow("does not match");
    await expect(invoke(
      "export-figure",
      imageWindows[0].webContents,
      targetB,
      { source_id: SOURCE_B, source_sha256: HASH_B },
    )).rejects.toThrow("cannot target another view");
    expect(bridge.exportVolumeFigure).toHaveBeenCalledTimes(callsAfterAllowedExport);
  });

  it("rechecks the captured export target after a native dialog before publishing", async () => {
    const { bridge, control, imageWindows } = harness();
    await open(control.webContents, SOURCE_A);
    const targetA = (await state(control.webContents)).views[0].target;
    let dialogOpened!: () => void;
    const dialogStarted = new Promise<void>((resolve) => { dialogOpened = resolve; });
    let closeDialog!: () => void;
    const dialog = new Promise<void>((resolve) => { closeDialog = resolve; });
    let published = false;
    bridge.exportVolumeFigure.mockImplementationOnce(async (
      _request: unknown,
      assertTargetCurrent?: () => void,
    ) => {
      assertTargetCurrent?.();
      dialogOpened();
      await dialog;
      assertTargetCurrent?.();
      published = true;
      return { exported: true };
    });

    const pending = invoke(
      "export-figure",
      imageWindows[0].webContents,
      targetA,
      { source_id: SOURCE_A, source_sha256: HASH_A },
    );
    await dialogStarted;
    await invoke("close", imageWindows[0].webContents, targetA);
    closeDialog();
    await expect(pending).rejects.toThrow(/closed|capability/i);
    expect(published).toBe(false);
  });

  it("revokes every view synchronously when the document is replaced", async () => {
    const { bridge, control, imageWindows } = harness();
    await open(control.webContents, SOURCE_A);
    await open(control.webContents, SOURCE_B);
    const targets = (await state(control.webContents)).views.map((view) => view.target);
    bridge.replaceDocument();

    expect(imageWindows.every((window) => window.isDestroyed())).toBe(true);
    expect(bridge.cancelImageView.mock.calls.map(([viewId]) => viewId)).toEqual(
      expect.arrayContaining(targets.map((target) => target.viewId)),
    );
    const cleared = await state(control.webContents);
    expect(cleared.views).toEqual([]);
    expect(cleared.target).toBeNull();
    await expect(invoke("execute", control.webContents, targets[0], "source_view", {
      source_id: SOURCE_A,
    })).rejects.toThrow(/no longer registered|closed/i);
  });
});
