// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AgentWorkspaceApi } from "./shared/agent-workspace-api";

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.remove } }));
await import("./agent-preload");
const api = electron.expose.mock.calls[0]?.[1] as AgentWorkspaceApi;

describe("dedicated agent window preload", () => {
  it("exposes only the bounded workspace capability, with no generic study or filesystem API", () => {
    expect(electron.expose.mock.calls.map(([name]) => name)).toEqual(["lociAgentWorkspace"]);
    expect(api).not.toHaveProperty("execute");
    expect(api).not.toHaveProperty("openImages");
    expect(api).not.toHaveProperty("getPathForFile");
  });

  it("keeps a control pending until native acknowledgment and propagates refusal", async () => {
    let reject!: (error: Error) => void;
    const native = new Promise((_, fail) => { reject = fail; });
    electron.invoke.mockReturnValueOnce(native);
    const binding = { projectId: "a".repeat(32), studyEpoch: 3, generation: 4 };
    const request = { action: "pause_session", policy_sha256: "b".repeat(64) } as const;
    let resolved = false;
    const result = api.control(binding, request).then(value => { resolved = true; return value; });
    expect(electron.invoke).toHaveBeenLastCalledWith("loci-agent-workspace:control", binding, request);
    await Promise.resolve();
    expect(resolved).toBe(false);
    const refusal = expect(result).rejects.toThrow("study changed");
    reject(new Error("study changed"));
    await refusal;
  });

  it("does not expose native event objects and removes the exact subscription", () => {
    const receive = vi.fn(), stop = api.onFlush(receive);
    const [channel, listener] = electron.on.mock.calls.at(-1)!;
    const payload = { binding: { projectId: "a".repeat(32), studyEpoch: 1, generation: 2 }, flushId: "owned-flush" };
    listener({ sender: "privileged-native-event" }, payload);
    expect(receive).toHaveBeenCalledExactlyOnceWith(payload);
    stop();
    expect(electron.remove).toHaveBeenLastCalledWith(channel, listener);
  });
});
