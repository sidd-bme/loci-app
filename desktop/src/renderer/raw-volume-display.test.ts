import { describe, expect, it } from "vitest";
import { applyVolumeDisplayChannels, volumeDisplayChannels } from "./raw-volume-display";
import type { RawVolumeComponent } from "./RawVolumeViewport";
const component = (index: number): RawVolumeComponent => ({ channel_index: index, name: `C${index}`,
  color_rgb: [1, 1, 1], window: { low: -1000, high: 2000, gamma: 1 }, visible: true, opacity: 1,
  opacity_points: [[-1000, 0], [2000, 1]], provenance: { range: "source-native" } });
describe("detached native scalar volume display", () => {
  it("maps by source channel identity, preserving raw provenance and independent native units", () => {
    const raw = [component(2), component(0)];
    const before = structuredClone(raw);
    const output = applyVolumeDisplayChannels(raw, [
      { channel: 0, low: -160, high: 240, gamma: 1, color: "#00ff00", opacity: 0.4, visible: false },
      { channel: 2, low: 50, high: 500, gamma: 2, color: "#ff00ff", opacity: 0.8, visible: true },
    ]);
    expect(output[0].color_rgb).toEqual([1, 0, 1]);
    expect(output[1].window).toEqual({ low: -160, high: 240, gamma: 1 });
    expect(output[1].visible).toBe(false);
    expect(output[1].opacity).toBe(0.4);
    expect(output[0].provenance).toEqual({ range: "source-native" });
    expect(raw).toEqual(before);
    expect(volumeDisplayChannels(output)[0]).toEqual({ channel: 2, low: 50, high: 500, gamma: 2, color: "#ff00ff", opacity: 0.8, visible: true });
  });
  it("rejects missing and invalid display ranges without silently clipping scientific units", () => {
    expect(() => applyVolumeDisplayChannels([component(0)], [])).toThrow(/missing/);
    for (const high of [NaN, Infinity, -2000]) {
      expect(() => applyVolumeDisplayChannels([component(0)], [{ channel: 0, low: -1000, high,
        gamma: 1, color: "#ffffff", visible: true }])).toThrow(/Invalid/);
    }
  });
});
