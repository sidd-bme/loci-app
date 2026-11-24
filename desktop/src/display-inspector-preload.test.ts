import { expect, it, vi } from "vitest";
import type { DisplayInspectorApi } from "./shared/display-inspector-api";

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.remove } }));
await import("./display-inspector-preload");

it("exposes only the narrow inspector API and strips native IPC events from subscriptions", () => {
  expect(electron.expose.mock.calls.map(([name]) => name)).toEqual(["lociDisplayInspector"]);
  const api = electron.expose.mock.calls[0][1] as DisplayInspectorApi;
  expect(Object.keys(api).sort()).toEqual(["dock", "edit", "onState", "state"]);
  const onState = vi.fn();
  const stop = api.onState(onState);
  const [channel, listener] = electron.on.mock.calls[0];
  const snapshot = { binding: { generation: 8 }, sequence: 2 };
  listener({ sender: "privileged event" }, snapshot);
  expect(onState).toHaveBeenCalledExactlyOnceWith(snapshot);
  stop();
  expect(electron.remove).toHaveBeenCalledExactlyOnceWith(channel, listener);
});
