import { describe, expect, it, vi } from "vitest";
import { rendererRole } from "./renderer-role";
import type { AgentWorkspaceApi } from "../shared/agent-workspace-api";
import type { ImageWindowApi } from "../shared/image-window-api";
const agent = (role: string) => ({ state: vi.fn(async () => ({ role })) }) as unknown as AgentWorkspaceApi;
const image = (role: string) => ({ state: vi.fn(async () => ({ role })) }) as unknown as ImageWindowApi;
describe("native renderer role", () => {
  it("queries workspace authority first without touching image-only API", async () => {
    const a = agent("workspace"), i = image("image");
    expect(await rendererRole(a, i)).toBe("workspace"); expect(i.state).not.toHaveBeenCalled();
  });
  it("falls back when the image sender rejects workspace IPC", async () => {
    const a = agent("main"), i = image("image"); vi.mocked(a.state).mockRejectedValue(new Error("Unauthorized sender"));
    expect(await rendererRole(a, i)).toBe("image"); expect(a.state).toHaveBeenCalledTimes(1);
  });
  it("preserves the ordinary main role", async () => {
    expect(await rendererRole(agent("main"), image("main"))).toBe("main");
    expect(await rendererRole(undefined, undefined)).toBe("main");
  });
  it("does not hide failure of the existing image role check", async () => {
    const i = image("image"); vi.mocked(i.state).mockRejectedValue(new Error("Failed native state"));
    await expect(rendererRole(undefined, i)).rejects.toThrow("Failed native state");
  });
});
