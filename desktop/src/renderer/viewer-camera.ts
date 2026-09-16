import type { ResearchSource } from "../shared/research-contracts";

/** Camera coordinates are level-zero pixel edges, independent of analysis ROIs. */
export type Camera = { x: number; y: number; scale: number };
export type ViewportSize = { width: number; height: number };
export type ImageExtent = { width: number; height: number; aspectY: number };
export type Tile = {
  key: string; level: number; x: number; y: number; width: number; height: number;
  left: number; top: number; sourceWidth: number; sourceHeight: number;
};
export const TILE_EDGE = 512;
export const MAX_VISIBLE_TILES = 64;
const MIN_CAMERA_SCALE = 1e-8;
const MAX_CAMERA_SCALE = 32;

export function imageExtent(source: ResearchSource): ImageExtent {
  const d = source.metadata.dimensions;
  const shape = source.metadata.shape;
  const width = d?.x ?? shape?.at(-1) ?? 0;
  const height = d?.y ?? shape?.at(-2) ?? 0;
  const spacing = source.metadata.physical_calibration?.spacing;
  const geometry = source.metadata.geometry as { affine?: number[][] } | undefined;
  const affine = geometry?.affine;
  const sx = affine ? Math.hypot(...affine.slice(0, 3).map((row) => row[0])) : spacing?.at(-1);
  const sy = affine ? Math.hypot(...affine.slice(0, 3).map((row) => row[1])) : spacing?.at(-2);
  return { width, height, aspectY: sx && sy && sx > 0 && sy > 0 ? sy / sx : 1 };
}

export type ViewportInsets = { right?: number; left?: number; top?: number; bottom?: number };

export function fitCamera(extent: ImageExtent, size: ViewportSize, insets?: ViewportInsets): Camera {
  const left = insets?.left ?? 0;
  const right = insets?.right ?? 0;
  const top = insets?.top ?? 0;
  const bottom = insets?.bottom ?? 0;
  const visibleWidth = Math.max(10, size.width - left - right);
  const visibleHeight = Math.max(10, size.height - top - bottom);
  const scale = Math.max(MIN_CAMERA_SCALE, Math.min(MAX_CAMERA_SCALE,
    Math.min(visibleWidth / extent.width,
      visibleHeight / (extent.height * extent.aspectY)) * 0.96));
  const xOffset = (right - left) / (2 * scale);
  const yOffset = (bottom - top) / (2 * scale * extent.aspectY);
  return { x: extent.width / 2 + xOffset, y: extent.height / 2 + yOffset, scale };
}

export function screenToSource(camera: Camera, size: ViewportSize, extent: ImageExtent,
  x: number, y: number): { x: number; y: number } {
  return { x: camera.x + (x - size.width / 2) / camera.scale,
    y: camera.y + (y - size.height / 2) / (camera.scale * extent.aspectY) };
}

export function sourceToScreen(camera: Camera, size: ViewportSize, extent: ImageExtent,
  x: number, y: number): { x: number; y: number } {
  return { x: size.width / 2 + (x - camera.x) * camera.scale,
    y: size.height / 2 + (y - camera.y) * camera.scale * extent.aspectY };
}

export function boundedCamera(camera: Camera, extent: ImageExtent, size: ViewportSize, insets?: ViewportInsets): Camera {
  const minimum = fitCamera(extent, size, insets).scale * 0.2;
  const scale = Math.max(minimum, Math.min(MAX_CAMERA_SCALE, camera.scale));
  const right = insets?.right ?? 0;
  const left = insets?.left ?? 0;
  const top = insets?.top ?? 0;
  const bottom = insets?.bottom ?? 0;
  const marginX = Math.max(0, (right + left) / scale);
  const marginY = Math.max(0, (bottom + top) / (scale * extent.aspectY));
  // Allow margin around the image while always retaining an accessible edge.
  return { scale, x: Math.max(-marginX, Math.min(extent.width + marginX, camera.x)),
    y: Math.max(-marginY, Math.min(extent.height + marginY, camera.y)) };
}

export function zoomCamera(camera: Camera, extent: ImageExtent, size: ViewportSize,
  factor: number, x = size.width / 2, y = size.height / 2, insets?: ViewportInsets): Camera {
  const anchor = screenToSource(camera, size, extent, x, y);
  const next = boundedCamera({ ...camera, scale: camera.scale * factor }, extent, size, insets);
  return boundedCamera({ ...next,
    x: anchor.x - (x - size.width / 2) / next.scale,
    y: anchor.y - (y - size.height / 2) / (next.scale * extent.aspectY) }, extent, size, insets);
}

export function sourceLevels(source: ResearchSource) {
  const extent = imageExtent(source);
  const levels = source.metadata.levels ?? [{ index: 0,
    dimensions: { x: extent.width, y: extent.height, z: 1, t: 1, c: 1 } }];
  const slide = (source.metadata as Record<string, unknown>).whole_slide as
    { levels?: Array<{ index: number; downsample: number }> } | undefined;
  return levels.map((level) => {
    const slideScale = slide?.levels?.find((item) => item.index === level.index)?.downsample;
    return { ...level, sx: slideScale ?? extent.width / level.dimensions.x,
      sy: slideScale ?? extent.height / level.dimensions.y };
  });
}

export function visibleTiles(source: ResearchSource, camera: Camera, size: ViewportSize,
  dpr: number): { tiles: Tile[]; level: number; undersampled: boolean } {
  const extent = imageExtent(source);
  const levels = sourceLevels(source);
  const density = camera.scale * Math.max(1, dpr);
  // Coarsest level still at least as sharp as one decoded pixel per device pixel.
  let chosen = levels[0];
  for (const level of levels) {
    if (Math.max(level.sx, level.sy * extent.aspectY) * density <= 1.25) chosen = level;
  }
  const start = screenToSource(camera, size, extent, 0, 0);
  const end = screenToSource(camera, size, extent, size.width, size.height);
  const tilesFor = (level: typeof chosen): Tile[] => {
    const d = level.dimensions;
    const x0 = Math.max(0, Math.floor(start.x / level.sx / TILE_EDGE) * TILE_EDGE);
    const y0 = Math.max(0, Math.floor(start.y / level.sy / TILE_EDGE) * TILE_EDGE);
    const x1 = Math.min(d.x, Math.ceil(end.x / level.sx));
    const y1 = Math.min(d.y, Math.ceil(end.y / level.sy));
    const result: Tile[] = [];
    for (let y = y0; y < y1; y += TILE_EDGE) {
      for (let x = x0; x < x1; x += TILE_EDGE) {
        const width = Math.min(TILE_EDGE, d.x - x), height = Math.min(TILE_EDGE, d.y - y);
        result.push({ key: `${level.index}:${x}:${y}`, level: level.index, x, y, width, height,
          left: x * level.sx, top: y * level.sy,
          sourceWidth: width * level.sx, sourceHeight: height * level.sy });
        if (result.length > MAX_VISIBLE_TILES) return result;
      }
    }
    return result.sort((a, b) =>
      Math.hypot(a.left + a.sourceWidth / 2 - camera.x, a.top + a.sourceHeight / 2 - camera.y) -
      Math.hypot(b.left + b.sourceWidth / 2 - camera.x, b.top + b.sourceHeight / 2 - camera.y));
  };
  let tiles = tilesFor(chosen);
  const desired = chosen.index;
  while (tiles.length > MAX_VISIBLE_TILES && levels.indexOf(chosen) < levels.length - 1) {
    chosen = levels[levels.indexOf(chosen) + 1];
    tiles = tilesFor(chosen);
  }
  // For an unpyramided whole extent, use the bounded prepared overview until
  // zoom exposes a bounded native tile set. It never replaces native data.
  return { tiles: tiles.length > MAX_VISIBLE_TILES ? [] : tiles,
    level: chosen.index, undersampled: chosen.index !== desired || tiles.length > MAX_VISIBLE_TILES };
}
