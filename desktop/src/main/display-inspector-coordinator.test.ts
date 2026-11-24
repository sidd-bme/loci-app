import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISPLAY_INSPECTOR_IPC as prefix, type DisplayInspectorBinding, type DisplayInspectorSnapshot, type DisplayInspectorState,
} from "../shared/display-inspector-api";
import type { PreprocessInspectorSnapshot } from "../shared/preprocess-inspector-api";

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>() }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { ipcMain: { handle: (name: string, handler: never) => electron.handlers.set(name, handler) },
    screen: Object.assign(new EventEmitter(), {
      getCursorScreenPoint: () => ({ x: -350, y: 210 }),
      getDisplayNearestPoint: () => ({ workArea: { x: -1200, y: 0, width: 1200, height: 800 } }),
    }) };
});
import { screen } from "electron";
import { DisplayInspectorCoordinator } from "./display-inspector-coordinator";

class TestWindow extends EventEmitter {
  destroyed = false;
  focused = false;
  minimized = false;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => this.destroyed,
    send: vi.fn(),
  });
  show = vi.fn();
  getBounds = () => ({ x: 30, y: 20, width: 368, height: 600 });
  setBounds = vi.fn();
  focus = vi.fn(() => { this.focused = true; });
  isFocused() { return this.focused; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
}

const target = { sourceId: "a".repeat(32), sourceSha256: "b".repeat(64), studyGeneration: 3, documentGeneration: 4 };
const snapshot: DisplayInspectorSnapshot = {
  source: { id: target.sourceId, sha256: target.sourceSha256, name: "Stack", metadata: {} },
  channels: [{ channel: 0, gamma: 1, low: 0, high: 255, color: "#ffffff", visible: true }],
  selection: { x: 0, y: 0, width: 16, height: 16, z: 0, c: 0, t: 0, level: 0 },
  projection: "plane", interpretation: "auto", rgbMapping: null, viewReady: true,
};
const coordinators: DisplayInspectorCoordinator[] = [];
afterEach(() => { for (const item of coordinators.splice(0)) item.dispose(); });

function setup() {
  electron.handlers.clear();
  const main = new TestWindow();
  const windows: TestWindow[] = [];
  const load = vi.fn(async () => {});
  const requestedKinds: unknown[] = [];
  let changeStudy!: () => void;
  const coordinator = new DisplayInspectorCoordinator({
    onViewDocumentChanged: (listener) => { changeStudy = listener; return () => {}; },
  }, (_owner, kind) => {
    requestedKinds.push(kind);
    const child = new TestWindow();
    windows.push(child);
    return { window: child as unknown as BrowserWindow, load };
  });
  coordinators.push(coordinator);
  coordinator.registerMain(main as unknown as BrowserWindow);
  coordinator.registerIpc();
  const invoke = <T,>(sender: TestWindow, frame: unknown, method: string, ...args: unknown[]) =>
    electron.handlers.get(prefix + method)!({ sender: sender.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent, ...args) as T;
  const call = <T,>(sender: TestWindow, method: string, ...args: unknown[]) => invoke<T>(sender, sender.webContents.mainFrame, method, ...args);
  const open = (nextTarget = target, nextSnapshot = snapshot) => call<DisplayInspectorBinding>(main, "open", nextTarget, nextSnapshot);
  const ownerEdits = () => main.webContents.send.mock.calls.filter(([channel]) => channel === prefix + "owner-edit").map(([, edit]) => edit);
  return { main, windows, coordinator, open, invoke, call, changeStudy, load, ownerEdits, requestedKinds };
}

describe("native Display inspector", () => {
  it("positions only a newly opened inspector from the owner drag request", async () => {
    const h = setup();
    expect(() => h.call(h.main, "open", target, snapshot, { atPointer: true, x: 10 })).toThrow("placement");
    expect(h.windows).toHaveLength(0);
    const first = h.open();
    expect(h.windows[0].setBounds).not.toHaveBeenCalled();
    h.call(h.main, "dock", first);
    const second = h.call<DisplayInspectorBinding>(h.main, "open", target, snapshot, { atPointer: true });
    const child = h.windows[1];
    expect(child.setBounds).toHaveBeenCalledExactlyOnceWith({ x: -446, y: 192, width: 368, height: 600 });
    expect(child.show).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(child.show).toHaveBeenCalledOnce());
    expect(h.call(h.main, "open", target, snapshot, { atPointer: true })).toEqual(second);
    expect(child.setBounds).toHaveBeenCalledOnce();
  });

  it("restricts each role and relays only a bound display intent", async () => {
    const h = setup();
    const binding = h.open();
    const child = h.windows[0];
    expect(binding).toEqual({ ...target, generation: 1 });
    expect(h.call<DisplayInspectorState>(child, "state")).toEqual({ binding, snapshot, sequence: 0 });
    expect(() => h.call(h.main, "state")).toThrow("stale");
    expect(() => h.call(child, "open", target, snapshot)).toThrow("stale");
    expect(() => h.call(child, "publish", binding, snapshot)).toThrow("stale");
    expect(() => h.call(new TestWindow(), "state")).toThrow("stale");
    expect(() => h.invoke(child, {}, "state")).toThrow("stale");
    expect(() => h.invoke(child, null, "state")).toThrow("stale");
    const edit = { kind: "channel", channel: 0, edit: { field: "opacity", value: 0.5 } };
    await vi.waitFor(() => expect(child.show).toHaveBeenCalledOnce());
    expect(() => h.call(child, "edit", binding, { kind: "viewer_tile" })).toThrow("invalid");
    expect(() => h.call(child, "edit", binding, { kind: "channel", channel: 0, edit: { field: "low", value: Infinity } })).toThrow("invalid");
    expect(() => h.call(child, "edit", { ...binding, studyGeneration: 2 }, edit)).toThrow("stale");
    expect(() => h.call(h.main, "edit", binding, edit)).toThrow("stale");
    h.call(child, "edit", binding, edit);
    expect(h.ownerEdits()).toEqual([{ binding, action: edit }]);
    const changed = { ...snapshot, channels: [{ ...snapshot.channels[0], opacity: 0.5 }] };
    h.call(h.main, "publish", binding, changed);
    expect(child.webContents.send).toHaveBeenLastCalledWith(prefix + "state-changed", { binding, snapshot: changed, sequence: 1 });
    expect(() => h.call(h.main, "publish", binding, { ...changed, source: { ...changed.source, sha256: "c".repeat(64) } })).toThrow("stale");
  });

  it.each(["dock", "native-close", "unavailable", "display-removed"])("releases comparison and returns focus after %s", async (reason) => {
    const h = setup();
    const binding = h.open();
    const child = h.windows[0];
    await vi.waitFor(() => expect(child.show).toHaveBeenCalledOnce());
    h.call(child, "edit", binding, { kind: "compare", active: true });
    child.focused = false;
    child.emit("blur");
    h.call(child, "edit", binding, { kind: "compare", active: true });
    expect(h.ownerEdits().map((item) => item.action.active)).toEqual([true, false]);
    child.focused = true;
    h.call(child, "edit", binding, { kind: "compare", active: true });
    h.main.minimized = true;
    if (reason === "dock") h.call(child, "dock", binding);
    if (reason === "native-close") child.destroy();
    if (reason === "unavailable") child.webContents.emit("render-process-gone");
    if (reason === "display-removed") screen.emit("display-removed");
    expect(h.ownerEdits().map((item) => item.action.active)).toEqual([true, false, true, false]);
    expect(h.main.webContents.send).toHaveBeenLastCalledWith(prefix + "lifecycle", { binding, status: "closed", reason });
    expect(h.main.focus).toHaveBeenCalledOnce();
    expect(h.main.isMinimized()).toBe(false);
    expect(child.isDestroyed()).toBe(true);
  });

  it("drops a pending load on study change and fences shutdown, source replacement and renderer reload", async () => {
    const h = setup();
    let completeLoad!: () => void;
    h.load.mockImplementationOnce(() => new Promise<void>((resolve) => { completeLoad = resolve; }));
    const old = h.open();
    const retired = h.windows[0];
    await vi.waitFor(() => expect(h.load).toHaveBeenCalledOnce());
    h.changeStudy();
    completeLoad();
    expect(retired.isDestroyed()).toBe(true);
    expect(retired.show).not.toHaveBeenCalled();
    h.coordinator.suspend();
    expect(() => h.open()).toThrow("stale");
    h.coordinator.resume();
    const next = h.open({ ...target, studyGeneration: 4 });
    expect(() => h.call(h.main, "focus", old)).toThrow("stale");
    const child = h.windows[1];
    await vi.waitFor(() => expect(child.show).toHaveBeenCalledOnce());
    child.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(child.isDestroyed()).toBe(false);
    child.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(child.isDestroyed()).toBe(true);
    const nextSource = { ...target, sourceId: "c".repeat(32), sourceSha256: "d".repeat(64), studyGeneration: 4 };
    const newBinding = h.open(nextSource, { ...snapshot, source: { ...snapshot.source, id: nextSource.sourceId, sha256: nextSource.sourceSha256 } });
    h.call(h.main, "revoke", next);
    expect(h.call<DisplayInspectorState>(h.windows[2], "state").binding).toEqual(newBinding);
    h.main.webContents.emit("did-start-navigation", { isMainFrame: true }, "app://renderer", false, true);
    expect(h.windows[2].isDestroyed()).toBe(true);
  });
});

const preprocessTarget = { ...target, kind: "preprocess" as const };
const preprocess: PreprocessInspectorSnapshot = {
  kind: "preprocess", source: { id: target.sourceId, sha256: target.sourceSha256, name: "Stack" },
  selection: snapshot.selection, dimensions: { x: 16, y: 16, z: 1, t: 1, c: 1 }, spatialUnit: "px",
  drawing: false, revision: 7, editor: { rows: [], selected: null, focus: null }, previewDisabled: false,
};

it.each([true, false])("reports whether a retired Preprocess edit was acknowledged (%s)", async (acknowledged) => {
  const h = setup();
  const binding = h.call<DisplayInspectorBinding>(h.main, "open", preprocessTarget, preprocess);
  const child = h.windows[0];
  await vi.waitFor(() => expect(child.show).toHaveBeenCalledOnce());
  h.call(child, "edit", binding, { kind: "preprocess", request: 1, edit: { kind: "draft", id: 1, text: "-" } });
  if (acknowledged) h.call(h.main, "publish", binding, preprocess, false, 1);
  expect(h.call(h.main, "revoke", binding)).toBe(acknowledged ? undefined : "unavailable");
  expect(h.main.webContents.send).toHaveBeenLastCalledWith(prefix + "lifecycle", {
    binding, status: "closed", reason: acknowledged ? "revoked" : "unavailable",
  });
  expect(child.isDestroyed()).toBe(true);
  expect(h.main.focus).not.toHaveBeenCalled();
});

it("hosts one inspector, binds Preprocess to the native source, and waits for owner acknowledgement before docking", async () => {
  const h = setup();
  expect(() => h.call(h.main, "open", preprocessTarget, snapshot)).toThrow("stale");
  const binding = h.call<DisplayInspectorBinding>(h.main, "open", preprocessTarget, preprocess);
  const child = h.windows[0];
  expect(h.requestedKinds).toEqual(["preprocess"]);
  expect(() => h.open()).toThrow("stale");
  expect(h.windows).toHaveLength(1);
  await vi.waitFor(() => expect(child.show).toHaveBeenCalledOnce());
  expect(() => h.call(child, "edit", binding, { kind: "reset" })).toThrow("invalid");
  expect(() => h.call(child, "edit", binding, { kind: "preprocess", request: 1, edit: { kind: "run_recipe" } })).toThrow("invalid");
  expect(() => h.call(child, "edit", binding, { kind: "preprocess", request: 1, edit: { kind: "draft", id: 1, text: "0".repeat(129) } })).toThrow("invalid");
  expect(() => h.call(child, "edit", binding, { kind: "preprocess", request: 1, edit: { kind: "restore-numbers", revision: -1 } })).toThrow("invalid");
  const action = { kind: "preprocess", request: 1, edit: { kind: "draft", id: 1, text: "-" } };
  expect(() => h.call(child, "edit", { ...binding, sourceSha256: "c".repeat(64) }, action)).toThrow("stale");
  expect(() => h.call(h.main, "edit", binding, action)).toThrow("stale");
  h.call(child, "edit", binding, action);
  expect(() => h.call(child, "edit", binding, action)).toThrow("stale");
  expect(h.ownerEdits()).toEqual([{ binding, action }]);
  const restore = { kind: "preprocess", request: 2, edit: { kind: "restore-numbers", revision: 7 } };
  h.call(child, "edit", binding, restore);
  expect(h.ownerEdits()).toEqual([{ binding, action }, { binding, action: restore }]);
  expect(() => h.call(child, "dock", binding)).toThrow("stale");
  const preventDefault = vi.fn();
  child.emit("close", { preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(h.call<DisplayInspectorState>(child, "state").dockRequested).toBe(true);
  expect(() => h.call(h.main, "publish", binding, { ...preprocess, source: { ...preprocess.source, id: "other" } }, false, 1)).toThrow("stale");
  expect(() => h.call(h.main, "publish", binding, { ...preprocess, restoreNumbers: "blocked" }, false, 1)).toThrow("stale");
  expect(() => h.call(h.main, "publish", binding, preprocess, false, 2)).toThrow("stale");
  h.call(h.main, "publish", binding, { ...preprocess, previewDisabled: true, restoreNumbers: true }, false, 1);
  expect(h.call<DisplayInspectorState>(child, "state")).toMatchObject({ acknowledgedRequest: 1, snapshot: { previewDisabled: true, restoreNumbers: true } });
  expect(() => h.call(child, "dock", binding)).toThrow("stale");
  h.call(h.main, "publish", binding, preprocess, false, 2);
  h.call(child, "dock", binding);
  expect(child.isDestroyed()).toBe(true);
  expect(h.main.webContents.send).toHaveBeenLastCalledWith(prefix + "lifecycle", { binding, status: "closed", reason: "dock" });
  const display = h.open();
  expect(display.generation).toBe(binding.generation + 1);
  expect(() => h.call(child, "edit", binding, action)).toThrow("stale");
});
