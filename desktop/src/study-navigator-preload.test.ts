import { expect, it, vi } from "vitest";
import { createStudyNavigatorOwnerApi } from "./study-navigator-bridge";
import type { StudyNavigatorApi } from "./shared/study-navigator-api";

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.remove },
}));
await import("./study-navigator-preload");

it("exposes only the narrow Images navigator API and strips native IPC events from subscriptions", () => {
  expect(electron.expose.mock.calls.map(([name]) => name)).toEqual(["lociStudyNavigator"]);
  const api = electron.expose.mock.calls[0][1] as StudyNavigatorApi;
  expect(Object.keys(api).sort()).toEqual(["act", "dock", "onState", "state"]);
  const onState = vi.fn();
  const stop = api.onState(onState);
  const [channel, listener] = electron.on.mock.calls[0];
  const snapshot = { binding: { generation: 4 }, sequence: 1 };
  listener({ sender: "privileged event" }, snapshot);
  expect(onState).toHaveBeenCalledExactlyOnceWith(snapshot);
  stop();
  expect(electron.remove).toHaveBeenCalledExactlyOnceWith(channel, listener);
});

it("forwards optional atPointer placement and strips native IPC events on the owner bridge", async () => {
  const invoke = vi.fn();
  const on = vi.fn();
  const removeListener = vi.fn();
  const owner = createStudyNavigatorOwnerApi({ invoke, on, removeListener });
  const target = { projectId: "study-1", studyGeneration: 1, documentGeneration: 2 };
  const snapshot = {
    studyName: "Study",
    sources: [],
    activeSourceId: null,
    activeSourceSha256: null,
    selectedSourceIds: [],
    reorderDisabled: false,
    busy: false,
  };
  await owner.open(target, snapshot);
  expect(invoke).toHaveBeenLastCalledWith("loci-study-navigator:open", target, snapshot);
  await owner.open(target, snapshot, { atPointer: true });
  expect(invoke).toHaveBeenLastCalledWith("loci-study-navigator:open", target, snapshot, { atPointer: true });
  const onAction = vi.fn();
  const stop = owner.onAction(onAction);
  const [channel, listener] = on.mock.calls[0];
  expect(channel).toBe("loci-study-navigator:owner-action");
  const payload = { binding: { ...target, generation: 1 }, action: { kind: "toggle-selection", sourceId: "s", sourceSha256: "a".repeat(64) } };
  listener({ sender: "native" }, payload);
  expect(onAction).toHaveBeenCalledExactlyOnceWith(payload);
  stop();
  expect(removeListener).toHaveBeenCalledExactlyOnceWith(channel, listener);
});
