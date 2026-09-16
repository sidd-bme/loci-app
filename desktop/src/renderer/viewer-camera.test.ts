import { describe, expect, it } from "vitest";
import type { ResearchSource } from "../shared/research-contracts";
import { boundedCamera, fitCamera, imageExtent, screenToSource, sourceToScreen, visibleTiles, zoomCamera } from "./viewer-camera";

const source: ResearchSource = { id: "a", name: "fixture", sha256: "b", metadata: {
  dimensions: { x: 8998, y: 10121, c: 3, z: 1, t: 1 },
  levels: [0, 1, 2, 3, 4].map((index) => ({ index,
    dimensions: { x: Math.floor(8998 / 2 ** index), y: Math.floor(10121 / 2 ** index), c: 3, z: 1, t: 1 } })),
} };
const size = { width: 1000, height: 800 };

describe("image camera independent of analysis scope", () => {
  it("fits every original edge and round trips source coordinates", () => {
    const extent = imageExtent(source), camera = fitCamera(extent, size);
    for (const [x, y] of [[0, 0], [8998, 10121], [7523.25, 889.75]]) {
      const screen = sourceToScreen(camera, size, extent, x, y);
      expect(screen.x).toBeGreaterThanOrEqual(0);
      expect(screen.x).toBeLessThanOrEqual(size.width);
      expect(screen.y).toBeGreaterThanOrEqual(0);
      expect(screen.y).toBeLessThanOrEqual(size.height);
      const returned = screenToSource(camera, size, extent, screen.x, screen.y);
      expect(returned.x).toBeCloseTo(x, 8); expect(returned.y).toBeCloseTo(y, 8);
    }
  });
  it("keeps the cursor source point fixed through zoom", () => {
    const extent = imageExtent(source), camera = fitCamera(extent, size);
    const before = screenToSource(camera, size, extent, 560, 240);
    const after = zoomCamera(camera, extent, size, 4, 560, 240);
    expect(screenToSource(after, size, extent, 560, 240)).toEqual(before);
  });
  it("automatically requests native pixels at device-pixel 1:1 and near all edges", () => {
    const extent = imageExtent(source);
    expect(visibleTiles(source, fitCamera(extent, size), size, 2).level).toBeGreaterThan(0);
    for (const x of [0, extent.width]) for (const y of [0, extent.height]) {
      const request = visibleTiles(source, { x, y, scale: 0.5 }, size, 2);
      expect(request.level).toBe(0); expect(request.tiles.length).toBeGreaterThan(0);
      expect(request.tiles.length).toBeLessThanOrEqual(64);
      for (const tile of request.tiles) {
        expect(tile.width).toBeLessThanOrEqual(512); expect(tile.height).toBeLessThanOrEqual(512);
      }
    }
  });
  it("preserves physical pixel aspect without inventing units", () => {
    const anisotropic = { ...source, metadata: { ...source.metadata,
      physical_calibration: { spacing: [1, 3, 2], unit: "um" } } };
    expect(imageExtent(anisotropic).aspectY).toBe(1.5);
  });
  it("fits a small image within the same persisted-safe scale used by zoom", () => {
    const tiny: ResearchSource = { ...source, metadata: { ...source.metadata,
      dimensions: { x: 8, y: 8, c: 2, z: 2, t: 1 },
      levels: [{ index: 0, dimensions: { x: 8, y: 8, c: 2, z: 2, t: 1 } }],
    } };
    const extent = imageExtent(tiny);
    const fitted = fitCamera(extent, { width: 640, height: 480 });

    expect(fitted).toEqual({ x: 4, y: 4, scale: 32 });
    expect(boundedCamera(fitted, extent, { width: 640, height: 480 })).toEqual(fitted);
    expect(zoomCamera(fitted, extent, { width: 640, height: 480 }, 100).scale).toBe(32);
    for (const [x, y] of [[0, 0], [8, 8]]) {
      const screen = sourceToScreen(fitted, { width: 640, height: 480 }, extent, x, y);
      expect(screen.x).toBeGreaterThanOrEqual(0);
      expect(screen.x).toBeLessThanOrEqual(640);
      expect(screen.y).toBeGreaterThanOrEqual(0);
      expect(screen.y).toBeLessThanOrEqual(480);
    }
  });
  it("centers the image in the visible region when a right inspector overlay is present", () => {
    const extent = imageExtent(source);
    const viewportSize = { width: 1200, height: 800 };
    const insets = { right: 320 }; // 320px inspector on right side
    const camera = fitCamera(extent, viewportSize, insets);
    const centerScreen = sourceToScreen(camera, viewportSize, extent, extent.width / 2, extent.height / 2);
    // Visible area is [0, 1200 - 320] = [0, 880], so center must be at 440px
    expect(centerScreen.x).toBeCloseTo((1200 - 320) / 2, 4);
    expect(centerScreen.y).toBeCloseTo(800 / 2, 4);

    // Bounded camera preserves this accessible center
    const bounded = boundedCamera(camera, extent, viewportSize, insets);
    const boundedCenter = sourceToScreen(bounded, viewportSize, extent, extent.width / 2, extent.height / 2);
    expect(boundedCenter.x).toBeCloseTo((1200 - 320) / 2, 4);
  });
});

