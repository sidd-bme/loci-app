import { TILE_EDGE, type Tile } from "./viewer-camera";

type SourceTile = { tile: Tile; image: CanvasImageSource };

/** Sample adjacent detail tiles as one image. The caller provides one plane's cache. */
export function drawSmoothSourceTile(
  context: CanvasRenderingContext2D,
  item: SourceTile,
  tiles: ReadonlyMap<string, SourceTile>,
  scratch: { current: HTMLCanvasElement | null },
  x: number, y: number, width: number, height: number, pixelRatio: number,
): void {
  const { tile, image } = item;
  const pixelWidth = width / tile.width;
  const pixelHeight = height / tile.height;
  const surfaceWidth = context.canvas.width / pixelRatio;
  const surfaceHeight = context.canvas.height / pixelRatio;
  const neighbor = (dx: number, dy: number) =>
    tiles.get(`${tile.level}:${tile.x + dx * TILE_EDGE}:${tile.y + dy * TILE_EDGE}`);
  // An offscreen join cannot contribute to a visible sample beyond half a texel.
  const left = x + pixelWidth / 2 >= 0 && neighbor(-1, 0);
  const right = x + width - pixelWidth / 2 <= surfaceWidth && neighbor(1, 0);
  const top = y + pixelHeight / 2 >= 0 && neighbor(0, -1);
  const bottom = y + height - pixelHeight / 2 <= surfaceHeight && neighbor(0, 1);
  if (!left && !right && !top && !bottom) {
    context.drawImage(image, x, y, width, height);
    return;
  }

  const padX = left ? 1 : 0, padY = top ? 1 : 0;
  const paddedWidth = tile.width + padX + (right ? 1 : 0);
  const paddedHeight = tile.height + padY + (bottom ? 1 : 0);
  const padded = scratch.current ??= document.createElement("canvas");
  if (padded.width !== paddedWidth) padded.width = paddedWidth;
  if (padded.height !== paddedHeight) padded.height = paddedHeight;
  const buffer = padded.getContext("2d")!;
  buffer.clearRect(0, 0, paddedWidth, paddedHeight);
  buffer.imageSmoothingEnabled = false;
  buffer.drawImage(image, padX, padY);

  // Every copied strip is exactly one native pixel wide or tall. At a cache
  // hole the closest available edge replaces a missing diagonal sample.
  const copy = (from: SourceTile, sx: number, sy: number, w: number, h: number, dx: number, dy: number) =>
    buffer.drawImage(from.image, sx, sy, w, h, dx, dy, w, h);
  if (left) copy(left, left.tile.width - 1, 0, 1, tile.height, 0, padY);
  if (right) copy(right, 0, 0, 1, tile.height, padX + tile.width, padY);
  if (top) copy(top, 0, top.tile.height - 1, tile.width, 1, padX, 0);
  if (bottom) copy(bottom, 0, 0, tile.width, 1, padX, padY + tile.height);

  for (const dx of [-1, 1]) {
    const side = dx < 0 ? left : right;
    if (!side) continue;
    for (const dy of [-1, 1]) {
      if (!(dy < 0 ? top : bottom)) continue;
      const diagonal = neighbor(dx, dy);
      const from = diagonal ?? side;
      const sx = dx < 0 ? from.tile.width - 1 : 0;
      const sy = diagonal
        ? (dy < 0 ? from.tile.height - 1 : 0)
        : (dy < 0 ? 0 : from.tile.height - 1);
      copy(from, sx, sy, 1, 1, dx < 0 ? 0 : paddedWidth - 1, dy < 0 ? 0 : paddedHeight - 1);
    }
  }

  // The two adjacent padded images agree inside the filter footprint. Assign
  // each destination pixel to one tile so alpha is composited exactly once.
  // Let the image sampler itself cover the original outer, unpadded edges.
  const snap = (css: number) => Math.round(css * pixelRatio) / pixelRatio;
  const clipLeft = left ? snap(x) : 0;
  const clipTop = top ? snap(y) : 0;
  const clipRight = right ? snap(x + width) : surfaceWidth;
  const clipBottom = bottom ? snap(y + height) : surfaceHeight;
  context.save();
  context.beginPath();
  context.rect(clipLeft, clipTop, clipRight - clipLeft, clipBottom - clipTop);
  context.clip();
  context.drawImage(padded, x - padX * pixelWidth, y - padY * pixelHeight,
    paddedWidth * pixelWidth, paddedHeight * pixelHeight);
  context.restore();
}
