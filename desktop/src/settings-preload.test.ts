// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SettingsWindowApi } from "./shared/settings-window-api";

const bridge = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.remove },
}));
await import("./settings-preload");
const api = bridge.expose.mock.calls[0][1] as SettingsWindowApi;
describe("Settings preload", () => {
  it("exposes only Settings navigation, lifecycle and compute targets", async () => {
    expect(bridge.expose.mock.calls.map(([name]) => name)).toEqual(["lociSettings"]);
    expect(Object.keys(api).sort()).toEqual(["close", "computeTargets", "getNavigation", "onNavigate", "requestQuit"]);
    await api.getNavigation(); await api.computeTargets("list", {}); await api.close(); await api.requestQuit();
    expect(bridge.invoke.mock.calls).toEqual([
      ["loci-settings:navigation"], ["loci-settings:compute-targets", "list", {}], ["loci-settings:close"], ["loci-settings:quit"],
    ]);
  });
  it("forwards only route data and removes its own listener", () => {
    const callback = vi.fn(), stop = api.onNavigate(callback);
    const [channel, listener] = bridge.on.mock.calls[0];
    const route = { page: "compute", revision: 7 };
    listener({ sender: "native event" }, route);
    expect(callback).toHaveBeenCalledExactlyOnceWith(route);
    stop();
    expect(bridge.remove).toHaveBeenCalledExactlyOnceWith(channel, listener);
  });
});
