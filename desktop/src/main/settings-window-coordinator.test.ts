// @vitest-environment node
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { SettingsWindowCoordinator } from "./settings-window-coordinator";

const ipc = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: ipc }));

function fixture() {
  const frame = {}, contents = { mainFrame: frame, send: vi.fn(), isDestroyed: () => false };
  const window = Object.assign(new EventEmitter(), { webContents: contents,
    isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), focus: vi.fn(),
    show: vi.fn(), close: vi.fn(), destroy: vi.fn(),
  });
  let finish!: () => void, fail!: (reason: unknown) => void;
  const loaded = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const create = vi.fn(() => ({ window: window as unknown as BrowserWindow, load: () => loaded }));
  const compute = vi.fn(async (_operation: unknown, _request: unknown) => ({ targets: [] })), changed = vi.fn(), quit = vi.fn();
  const coordinator = new SettingsWindowCoordinator(create, compute, changed, quit);
  ipc.handle.mockClear(); coordinator.registerIpc();
  const sender = { sender: contents, senderFrame: frame };
  const call = (channel: string, event: unknown = sender, ...args: unknown[]) => {
    const handler = ipc.handle.mock.calls.find(([name]) => name === "loci-settings:" + channel)![1];
    return handler(event, ...args);
  };
  return { coordinator, window, contents, finish, fail, create, compute, changed, quit, sender, call };
}
describe("dedicated Settings window", () => {
  it("publishes the latest explicit route through startup and preserves a draft on generic refocus", async () => {
    const f = fixture();
    const launch = f.coordinator.open();
    const first = await f.call("navigation");
    expect(first).toEqual({ page: "appearance", revision: 1 });
    const switchToCompute = f.coordinator.open("compute");
    const refocus = f.coordinator.open();
    expect(await f.call("navigation")).toEqual({ page: "compute", revision: 2 });
    f.finish();
    await Promise.all([launch, switchToCompute, refocus]);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.contents.send).toHaveBeenCalledExactlyOnceWith("loci-settings:navigate", { page: "compute", revision: 2 });
    await f.coordinator.open();
    expect(await f.call("navigation")).toEqual({ page: "compute", revision: 2 });
    expect(f.contents.send).toHaveBeenCalledTimes(1); expect(f.window.restore).toHaveBeenCalled();
    await f.coordinator.open("appearance");
    expect(f.contents.send).toHaveBeenLastCalledWith("loci-settings:navigate", { page: "appearance", revision: 3 });
  });
  it("prefers the last explicit route while loading and reopens after close", async () => {
    const f = fixture();
    const launch = f.coordinator.open("compute"), first = f.coordinator.open("appearance"), last = f.coordinator.open("compute");
    expect(await f.call("navigation")).toEqual({ page: "compute", revision: 3 });
    f.finish(); await Promise.all([launch, first, last]);
    expect(f.contents.send).toHaveBeenCalledExactlyOnceWith("loci-settings:navigate", { page: "compute", revision: 3 });
    await f.call("close"); expect(f.window.close).toHaveBeenCalledOnce(); expect(f.quit).not.toHaveBeenCalled();
    f.window.emit("closed");
    await expect(f.call("navigation")).rejects.toThrow("active Settings window");
    await f.coordinator.open("compute"); expect(f.create).toHaveBeenCalledTimes(2);
    expect(await f.call("navigation")).toEqual({ page: "compute", revision: 4 });
  });
  it("refuses unknown pages and disposes a failed load", async () => {
    const f = fixture();
    await expect(f.coordinator.open("untrusted")).rejects.toThrow("Unknown Settings page");
    expect(f.create).not.toHaveBeenCalled();
    const pending = f.coordinator.open(); f.fail(new Error("internal load path"));
    await expect(pending).rejects.toThrow("Settings window could not be opened");
    expect(f.window.destroy).toHaveBeenCalledOnce();
    await expect(f.call("navigation")).rejects.toThrow("active Settings window");
  });
  it("accepts commands only from the active Settings main frame and refuses study application", async () => {
    const f = fixture(); const launch = f.coordinator.open(); f.finish(); await launch;
    for (const channel of ["navigation", "close", "quit", "compute-targets"]) {
      for (const event of [{ ...f.sender, sender: {} }, { ...f.sender, senderFrame: {} }, { ...f.sender, senderFrame: null }])
        await expect(f.call(channel, event, "list", {})).rejects.toThrow("active Settings window");
    }
    await expect(f.call("compute-targets", f.sender, "use", {})).rejects.toThrow("study workspace");
    expect(f.compute).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled(); expect(f.window.close).not.toHaveBeenCalled();
    await f.call("compute-targets", f.sender, "list", {}); expect(f.changed).not.toHaveBeenCalled();
    f.compute.mockRejectedValueOnce(new Error("Target revision changed."));
    await expect(f.call("compute-targets", f.sender, "save", {})).rejects.toThrow("Target revision changed");
    expect(f.changed).not.toHaveBeenCalled();
    await f.call("compute-targets", f.sender, "forget", { revision: 3 });
    expect(f.compute).toHaveBeenLastCalledWith("forget", { revision: 3 }); expect(f.changed).toHaveBeenCalledOnce();
    await f.call("quit"); expect(f.quit).toHaveBeenCalledOnce();
  });
});
