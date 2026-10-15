import { describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchSource } from "../shared/research-contracts";
import { initialSourceDisplay, type SourceDisplayDefaults } from "./initial-source-display";

const source = { id: "source", sha256: "fingerprint", metadata: { sample_semantics: "none" } } as ResearchSource;
const channel = { channel: 0, low: 0, high: 65535, color: "#123456", gamma: 1.5, opacity: 0.7, visible: true };
const defaults = (): SourceDisplayDefaults => ({ source_id: source.id, source_sha256: source.sha256,
  channels: [channel], basis: { channels: [{ channel: 0, range: "native-dtype-range" }] } });
const setup = (output: unknown = { ...defaults(), channels: [{ ...channel, low: 53, high: 2048 }] }) => {
  const execute = vi.fn().mockResolvedValue(output);
  return { execute, api: { execute } as unknown as ResearchDesktopApi };
};

describe("initial scalar display", () => {
  it("uses a whole-image sample at the opening plane without changing other display properties", async () => {
    const { api, execute } = setup();
    const original = defaults();
    const prepared = await initialSourceDisplay(api, source, original, false, 7);
    expect(execute).toHaveBeenCalledWith("viewer_defaults", { source_id: source.id, t: 0, z: 7, auto: true });
    expect(prepared.channels).toEqual([{ ...channel, low: 53, high: 2048 }]);
    expect(original.channels).toEqual([channel]);
  });
  it("preserves saved views, acquisition ranges, and RGB without sampling", async () => {
    const { api, execute } = setup();
    const original = defaults();
    expect(await initialSourceDisplay(api, source, original, true, 0)).toBe(original);
    expect(await initialSourceDisplay(api, { ...source, metadata: { sample_semantics: "RGB" } }, original, false, 0)).toBe(original);
    const acquired = { ...original, basis: { channels: [{ channel: 0, range: "ims-ColorRange" }] } };
    expect(await initialSourceDisplay(api, source, acquired, false, 0)).toBe(acquired);
    expect(execute).not.toHaveBeenCalled();
  });
  it("fills missing ranges in a mixed acquisition while retaining recorded ranges", async () => {
    const acquired = { ...channel, channel: 1, low: 100, high: 1000 };
    const original = { ...defaults(), channels: [channel, acquired], basis: { channels: [
      { channel: 0, range: "native-dtype-range" }, { channel: 1, range: "ims-ColorRange" }] } };
    const { api } = setup({ ...defaults(), channels: [{ ...channel, low: 5, high: 45 }, { ...acquired, low: 200, high: 300 }] });
    const result = await initialSourceDisplay(api, source, original, false, 0);
    expect(result.channels).toEqual([{ ...channel, low: 5, high: 45 }, acquired]);
  });
  it.each([
    { ...defaults(), source_sha256: "different" },
    { ...defaults(), channels: [] },
    { ...defaults(), channels: [channel, channel] },
    { ...defaults(), channels: [{ ...channel, low: NaN }] },
    { ...defaults(), channels: [{ ...channel, low: 4, high: 4 }] },
  ])("rejects stale or invalid sampled ranges", async (output) => {
    const { api } = setup(output);
    await expect(initialSourceDisplay(api, source, defaults(), false, 0)).rejects.toThrow(/range/);
  });
});
