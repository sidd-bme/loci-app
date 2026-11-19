import { describe, expect, it, vi } from "vitest";
import { drawSmoothSourceTile } from "./smooth-source-tiles";
import type { Tile } from "./viewer-camera";

const tile = (level: number, x: number, y: number) => ({
  tile: { key: `${level}:${x}:${y}`, level, x, y, width: 512, height: 512,
    left: x, top: y, sourceWidth: 512, sourceHeight: 512 } satisfies Tile,
  image: {} as CanvasImageSource,
});

describe("smooth source tile draw", () => {
  it("uses the original bitmap when no same-level neighbor joins the visible field", () => {
    const item = tile(0, 0, 0), otherLevel = tile(1, 512, 0), belowView = tile(0, 0, 512);
    const images = new Map([item, otherLevel, belowView].map(entry => [entry.tile.key, entry]));
    const drawImage = vi.fn();
    const context = { canvas: { width: 200, height: 200 }, drawImage } as unknown as CanvasRenderingContext2D;
    const scratch = { current: null };
    drawSmoothSourceTile(context, item, images, scratch, -1950, -100, 2048, 2048, 1);
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(item.image, -1950, -100, 2048, 2048);
    expect(scratch.current).toBeNull();
  });
});
