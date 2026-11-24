import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISPLAY_INSPECTOR_IPC as displayPrefix,
  type DisplayInspectorSnapshot,
} from "../shared/display-inspector-api";
import {
  STUDY_NAVIGATOR_IPC as prefix,
  type StudyNavigatorBinding,
  type StudyNavigatorOpenOptions,
  type StudyNavigatorSnapshot,
  type StudyNavigatorState,
} from "../shared/study-navigator-api";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ipcMain: { handle: (name: string, handler: never) => electron.handlers.set(name, handler) },
    screen: Object.assign(new EventEmitter(), {
      getCursorScreenPoint: () => ({ x: 25, y: 80 }),
      getDisplayNearestPoint: () => ({ workArea: { x: -1024, y: 40, width: 1024, height: 768 } }),
    }),
  };
});

import { screen } from "electron";
import { DisplayInspectorCoordinator } from "./display-inspector-coordinator";
import { StudyNavigatorCoordinator } from "./study-navigator-coordinator";

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
  getBounds = () => ({ x: 0, y: 0, width: 340, height: 680 });
  setBounds = vi.fn();
  focus = vi.fn(() => {
    this.focused = true;
  });
  isFocused() {
    return this.focused;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.minimized = false;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
}

const sourceA = {
  id: "a".repeat(32),
  sha256: "1".repeat(64),
  name: "kidney_stack.ome.tif",
  metadata: { dimensions: { t: 1, c: 3, z: 16, y: 512, x: 512 } },
};
const sourceB = {
  id: "b".repeat(32),
  sha256: "2".repeat(64),
  name: "cellseg_volume.tif",
  metadata: { dimensions: { t: 1, c: 1, z: 8, y: 256, x: 256 } },
};
const target = { projectId: "study-1", studyGeneration: 2, documentGeneration: 5 };
const snapshot: StudyNavigatorSnapshot = {
  studyName: "Kidney fluorescence",
  sources: [sourceA, sourceB],
  activeSourceId: sourceA.id,
  activeSourceSha256: sourceA.sha256,
  selectedSourceIds: [sourceA.id],
  resultCounts: { [sourceA.id]: 2, [sourceB.id]: 0 },
  reorderDisabled: false,
  busy: false,
};

const disposables: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const item of disposables.splice(0)) item.dispose();
});

function setup() {
  electron.handlers.clear();
  const main = new TestWindow();
  const windows: TestWindow[] = [];
  const load = vi.fn(async () => {});
  const listeners = new Set<() => void>();
  const study = {
    onViewDocumentChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const coordinator = new StudyNavigatorCoordinator(study, () => {
    const child = new TestWindow();
    windows.push(child);
    return { window: child as unknown as BrowserWindow, load };
  });
  disposables.push(coordinator);
  coordinator.registerMain(main as unknown as BrowserWindow);
  coordinator.registerIpc();
  const invoke = <T,>(sender: TestWindow, frame: unknown, channelPrefix: string, method: string, ...args: unknown[]) =>
    electron.handlers.get(channelPrefix + method)!(
      { sender: sender.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
      ...args,
    ) as T;
  const call = <T,>(sender: TestWindow, method: string, ...args: unknown[]) =>
    invoke<T>(sender, sender.webContents.mainFrame, prefix, method, ...args);
  const open = (
    nextTarget = target,
    nextSnapshot = snapshot,
    options?: StudyNavigatorOpenOptions,
  ) => call<StudyNavigatorBinding>(main, "open", nextTarget, nextSnapshot, options);
  const ownerActions = () =>
    main.webContents.send.mock.calls
      .filter(([channel]) => channel === prefix + "owner-action")
      .map(([, payload]) => payload);
  const changeStudy = () => {
    for (const listener of [...listeners]) listener();
  };
  return { main, windows, study, coordinator, open, invoke, call, changeStudy, load, ownerActions };
}

describe("native Images navigator coordinator", () => {
  it("enforces sender/frame isolation and validates typed image selection and reorder commands", async () => {
    const h = setup();
    const binding = h.open();
    const child = h.windows[0];
    expect(binding).toEqual({ ...target, generation: 1 });
    expect(child.setBounds).not.toHaveBeenCalled();
    expect(h.call<StudyNavigatorState>(child, "state")).toEqual({ binding, snapshot, sequence: 0 });

    // Sender and frame boundaries
    expect(() => h.call(h.main, "state")).toThrow("stale");
    expect(() => h.call(child, "open", target, snapshot)).toThrow("stale");
    expect(() => h.call(child, "publish", binding, snapshot)).toThrow("stale");
    expect(() => h.call(new TestWindow(), "state")).toThrow("stale");
    expect(() => h.invoke(child, {}, prefix, "state")).toThrow("stale");
    expect(() => h.invoke(child, null, prefix, "state")).toThrow("stale");
    expect(() => h.call(h.main, "act", binding, { kind: "activate", sourceId: sourceB.id, sourceSha256: sourceB.sha256, modifier: "none" })).toThrow("stale");

    await vi.waitFor(() => expect(child.show).toHaveBeenCalledOnce());

    // Reject forged, stale, mismatched fingerprint, or malformed actions
    expect(() => h.call(child, "act", binding, { kind: "open_file" })).toThrow("invalid");
    expect(() => h.call(child, "act", { ...binding, studyGeneration: 1 }, {
      kind: "activate", sourceId: sourceB.id, sourceSha256: sourceB.sha256, modifier: "none",
    })).toThrow("stale");
    expect(() => h.call(child, "act", binding, {
      kind: "activate", sourceId: sourceB.id, sourceSha256: sourceA.sha256, modifier: "none",
    })).toThrow("invalid");
    expect(() => h.call(child, "act", binding, {
      kind: "activate", sourceId: sourceB.id, sourceSha256: sourceB.sha256, modifier: "none", visibleSourceIds: ["unknown"],
    })).toThrow("invalid");
    expect(() => h.call(child, "act", binding, {
      kind: "reorder", order: [{ sourceId: sourceA.id, sourceSha256: sourceA.sha256 }],
    })).toThrow("invalid");
    expect(() => h.call(child, "act", binding, {
      kind: "reorder", order: [
        { sourceId: sourceA.id, sourceSha256: sourceA.sha256 },
        { sourceId: sourceA.id, sourceSha256: sourceA.sha256 },
      ],
    })).toThrow("invalid");

    // Valid activate, toggle-selection, and reorder
    const activate = {
      kind: "activate" as const,
      sourceId: sourceB.id,
      sourceSha256: sourceB.sha256,
      modifier: "none" as const,
      visibleSourceIds: [sourceA.id, sourceB.id],
    };
    h.call(child, "act", binding, activate);
    const toggle = { kind: "toggle-selection" as const, sourceId: sourceA.id, sourceSha256: sourceA.sha256 };
    h.call(child, "act", binding, toggle);
    const reorder = {
      kind: "reorder" as const,
      order: [
        { sourceId: sourceB.id, sourceSha256: sourceB.sha256 },
        { sourceId: sourceA.id, sourceSha256: sourceA.sha256 },
      ],
    };
    h.call(child, "act", binding, reorder);
    expect(h.ownerActions()).toEqual([
      { binding, action: activate },
      { binding, action: toggle },
      { binding, action: reorder },
    ]);

    // Publish updated active source and verify reorderDisabled enforcement
    const updated: StudyNavigatorSnapshot = {
      ...snapshot,
      activeSourceId: sourceB.id,
      activeSourceSha256: sourceB.sha256,
      selectedSourceIds: [sourceB.id],
      reorderDisabled: true,
    };
    h.call(h.main, "publish", binding, updated);
    expect(child.webContents.send).toHaveBeenLastCalledWith(prefix + "state-changed", {
      binding,
      snapshot: updated,
      sequence: 1,
    });
    expect(() => h.call(child, "act", binding, reorder)).toThrow("invalid");
    expect(() => h.call(h.main, "publish", binding, { ...updated, activeSourceSha256: sourceA.sha256 })).toThrow("invalid");
  });

  it("places a new window at the release before showing and preserves position on reuse", async () => {
    const h = setup();
    expect(() => h.open(target, snapshot, { atPointer: false as unknown as true })).toThrow("invalid");
    const binding = h.open(target, snapshot, { atPointer: true, dropPoint: { x: -1125, y: 850 } });
    const child = h.windows[0];
    expect(binding.generation).toBe(1);
    expect(child.setBounds).toHaveBeenCalledExactlyOnceWith({ x: -1024, y: 128, width: 340, height: 680 });
    expect(child.show).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(child.show).toHaveBeenCalledOnce());
    expect(child.setBounds.mock.invocationCallOrder[0]).toBeLessThan(child.show.mock.invocationCallOrder[0]);
    expect(h.open(target, snapshot, { atPointer: true, dropPoint: { x: -480, y: 120 } })).toEqual(binding);
    expect(child.setBounds).toHaveBeenCalledOnce();
  });

  it.each(["dock", "native-close", "unavailable", "display-removed"] as const)(
    "cleans up and restores main focus after %s",
    async (reason) => {
      const h = setup();
      const binding = h.open();
      const child = h.windows[0];
      await vi.waitFor(() => expect(child.show).toHaveBeenCalledOnce());
      h.main.minimized = true;
      if (reason === "dock") h.call(child, "dock", binding);
      if (reason === "native-close") child.destroy();
      if (reason === "unavailable") child.webContents.emit("render-process-gone");
      if (reason === "display-removed") screen.emit("display-removed");
      expect(h.main.webContents.send).toHaveBeenLastCalledWith(prefix + "lifecycle", {
        binding,
        status: "closed",
        reason,
      });
      expect(h.main.isMinimized()).toBe(false);
      expect(h.main.focus).toHaveBeenCalledOnce();
      expect(child.isDestroyed()).toBe(true);
    },
  );

  it("revokes without stealing focus when the study document changes or main closes", async () => {
    const h = setup();
    const binding = h.open();
    const child = h.windows[0];
    await vi.waitFor(() => expect(child.show).toHaveBeenCalledOnce());
    h.changeStudy();
    expect(child.isDestroyed()).toBe(true);
    expect(h.main.focus).not.toHaveBeenCalled();
    expect(h.main.webContents.send).toHaveBeenLastCalledWith(prefix + "lifecycle", {
      binding,
      status: "closed",
      reason: "revoked",
    });
    expect(() => h.call(child, "act", binding, {
      kind: "activate", sourceId: sourceB.id, sourceSha256: sourceB.sha256, modifier: "none",
    })).toThrow("stale");
  });

  it("coexists cleanly with a simultaneously detached Display inspector", async () => {
    const h = setup();
    const displayWindows: TestWindow[] = [];
    const displayCoordinator = new DisplayInspectorCoordinator(h.study, () => {
      const child = new TestWindow();
      displayWindows.push(child);
      return { window: child as unknown as BrowserWindow, load: async () => {} };
    });
    disposables.push(displayCoordinator);
    displayCoordinator.registerMain(h.main as unknown as BrowserWindow);
    displayCoordinator.registerIpc();

    const navBinding = h.open();
    const displayTarget = {
      sourceId: sourceA.id,
      sourceSha256: sourceA.sha256,
      studyGeneration: target.studyGeneration,
      documentGeneration: target.documentGeneration,
    };
    const displaySnapshot: DisplayInspectorSnapshot = {
      source: { id: sourceA.id, sha256: sourceA.sha256, name: sourceA.name, metadata: {} },
      channels: [{ channel: 0, gamma: 1, low: 0, high: 255, color: "#ffffff", visible: true }],
      selection: { x: 0, y: 0, width: 16, height: 16, z: 0, c: 0, t: 0, level: 0 },
      projection: "plane",
      interpretation: "auto",
      rgbMapping: null,
      viewReady: true,
    };
    const displayBinding = h.invoke(
      h.main,
      h.main.webContents.mainFrame,
      displayPrefix,
      "open",
      displayTarget,
      displaySnapshot,
    );

    await vi.waitFor(() => {
      expect(h.windows[0].show).toHaveBeenCalledOnce();
      expect(displayWindows[0].show).toHaveBeenCalledOnce();
    });
    expect(h.windows[0].isDestroyed()).toBe(false);
    expect(displayWindows[0].isDestroyed()).toBe(false);

    // Docking Display leaves Images navigator open and responsive
    h.invoke(displayWindows[0], displayWindows[0].webContents.mainFrame, displayPrefix, "dock", displayBinding);
    expect(displayWindows[0].isDestroyed()).toBe(true);
    expect(h.windows[0].isDestroyed()).toBe(false);

    h.call(h.windows[0], "act", navBinding, {
      kind: "activate",
      sourceId: sourceB.id,
      sourceSha256: sourceB.sha256,
      modifier: "none",
    });
    expect(h.ownerActions()).toHaveLength(1);
  });
});
