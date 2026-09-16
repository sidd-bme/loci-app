import type { ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { sourceLevels } from "./viewer-camera";

type ResultGeometry = NonNullable<ResearchResult["geometry"]>;

export type ExactResultPlane = {
  image: string;
  shape: number[];
  resultId: string;
  revisionHash: string;
  axis: "x" | "y" | "z";
  index: number;
  geometry: ResultGeometry;
};

export type ResolvedResultPlaneOverlay = {
  key: string;
  image: string;
  resultId: string;
  revisionHash: string;
  sourceId: string;
  sourceSha256: string;
  left: number;
  top: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  opacity: number;
};

export type ResultOverlayResolution =
  | { ok: true; overlay: ResolvedResultPlaneOverlay }
  | { ok: false; reason: string };

type LevelWithOrigin = NonNullable<ResearchSource["metadata"]["levels"]>[number] & {
  origin_xyz?: [number, number, number] | null;
};

const UNIT = new Map([
  ["µm", "um"], ["μm", "um"], ["um", "um"],
  ["micrometer", "um"], ["micrometers", "um"],
  ["nm", "nm"], ["mm", "mm"], ["m", "m"], ["pixel", "pixel"],
]);

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function finiteAffine(value: unknown): value is number[][] {
  return Array.isArray(value) && value.length === 4 && value.every((row) =>
    Array.isArray(row) && row.length === 4 && row.every((item) =>
      typeof item === "number" && Number.isFinite(item)));
}

function sameGeometry(left: ResultGeometry, right: ResultGeometry): boolean {
  const leftAffine = left.affine, rightAffine = right.affine;
  return left.axes === right.axes && left.unit === right.unit &&
    (left.frame ?? "image") === (right.frame ?? "image") &&
    finiteAffine(leftAffine) && finiteAffine(rightAffine) &&
    leftAffine.every((row, y) => row.every((value, x) => close(value, rightAffine[y][x])));
}

function nativeExpectedGeometry(source: ResearchSource, level: LevelWithOrigin,
  selection: ResearchSelection): { xScale: number; yScale: number; xOrigin: number; yOrigin: number; unit: string } | null {
  const calibration = level.calibration;
  if (!calibration) return {
    xScale: 1, yScale: 1, xOrigin: selection.x, yOrigin: selection.y, unit: "pixel",
  };
  const unit = UNIT.get(calibration.unit);
  if (!unit || calibration.axes.length !== calibration.spacing.length) return null;
  const spacing = new Map([...calibration.axes].map((axis, index) => [axis, calibration.spacing[index]]));
  const xScale = spacing.get("X"), yScale = spacing.get("Y");
  if (!xScale || !yScale || !Number.isFinite(xScale) || !Number.isFinite(yScale)) return null;
  const origin = level.origin_xyz ?? [0, 0, 0];
  if (origin.length !== 3 || origin.some((value) => !Number.isFinite(value))) return null;
  return {
    xScale, yScale,
    xOrigin: origin[0] + xScale * selection.x,
    yOrigin: origin[1] + yScale * selection.y,
    unit,
  };
}

function slideExpectedGeometry(source: ResearchSource, selection: ResearchSelection) {
  const slide = (source.metadata as Record<string, unknown>).whole_slide as {
    micrometres_per_pixel_xy?: [number, number] | null;
    levels?: Array<{ index: number; downsample: number }>;
  } | undefined;
  const downsample = slide?.levels?.find((item) => item.index === selection.level)?.downsample;
  if (!downsample || !Number.isFinite(downsample)) return null;
  const [mppX, mppY] = slide?.micrometres_per_pixel_xy ?? [1, 1];
  if (![mppX, mppY].every((value) => Number.isFinite(value) && value > 0)) return null;
  return {
    xScale: mppX * downsample,
    yScale: mppY * downsample,
    xOrigin: mppX * (Math.round(selection.x * downsample) + downsample / 2),
    yOrigin: mppY * (Math.round(selection.y * downsample) + downsample / 2),
    unit: slide?.micrometres_per_pixel_xy ? "um" : "pixel",
  };
}

function axisAlignedGeometryMatches(geometry: ResultGeometry, expected: {
  xScale: number; yScale: number; xOrigin: number; yOrigin: number; unit: string;
}): boolean {
  if (geometry.axes !== "YX" || (geometry.frame ?? "image") !== "image" ||
      geometry.unit !== expected.unit || !finiteAffine(geometry.affine)) return false;
  const affine = geometry.affine;
  return close(affine[0][0], expected.xScale) && close(affine[1][1], expected.yScale) &&
    close(affine[0][3], expected.xOrigin) && close(affine[1][3], expected.yOrigin) &&
    close(affine[0][1], 0) && close(affine[1][0], 0) &&
    close(affine[0][2], 0) && close(affine[1][2], 0) &&
    close(affine[2][0], 0) && close(affine[2][1], 0) &&
    close(affine[3][0], 0) && close(affine[3][1], 0) && close(affine[3][3], 1);
}

/**
 * Resolve only an exact, source-grid 2D result. Registered, resampled, oblique,
 * orthogonal and volumetric result planes deliberately fall back to the exact
 * result-only viewport until the engine supplies a verified source mapping.
 */
export function resolveResultPlaneOverlay(source: ResearchSource, result: ResearchResult,
  plane: ExactResultPlane, opacity = 0.62): ResultOverlayResolution {
  if (result.source_id !== source.id || result.source_sha256 !== source.sha256 ||
      plane.resultId !== result.id || plane.revisionHash !== result.revision_hash)
    return { ok: false, reason: "Result and source identities do not match." };
  if (plane.axis !== "z" || plane.index !== 0 || plane.shape.length !== 2)
    return { ok: false, reason: "Only an exact 2D XY result can share the source camera." };
  const selection = result.selection;
  const arrayShape = result.arrays?.image?.shape;
  if (!selection || selection.z_stop !== undefined || !Array.isArray(arrayShape) ||
      arrayShape.length !== 2 || arrayShape[0] !== plane.shape[0] || arrayShape[1] !== plane.shape[1] ||
      plane.shape[0] !== selection.height || plane.shape[1] !== selection.width)
    return { ok: false, reason: "The result grid does not match its recorded source selection." };
  if (!result.geometry || !sameGeometry(result.geometry, plane.geometry))
    return { ok: false, reason: "The result plane geometry does not match its immutable revision." };
  const level = source.metadata.levels?.find((item) => item.index === selection.level) as LevelWithOrigin | undefined;
  if (!level || selection.x < 0 || selection.y < 0 || selection.width < 1 || selection.height < 1 ||
      selection.x + selection.width > level.dimensions.x || selection.y + selection.height > level.dimensions.y)
    return { ok: false, reason: "The result selection is outside its recorded source pyramid level." };
  const expected = source.source_kind === "whole_slide"
    ? slideExpectedGeometry(source, selection)
    : source.source_kind === "native" || source.source_kind === "ome_zarr"
      ? nativeExpectedGeometry(source, level, selection)
      : null;
  if (!expected || !axisAlignedGeometryMatches(plane.geometry, expected))
    return { ok: false, reason: "The result geometry is not a verified axis-aligned source crop." };
  if (!plane.image.startsWith("data:image/png;base64,") || !Number.isFinite(opacity) || opacity <= 0 || opacity > 1)
    return { ok: false, reason: "The result overlay image or opacity is invalid." };
  const scale = sourceLevels(source).find((item) => item.index === selection.level);
  if (!scale) return { ok: false, reason: "The result pyramid level is unavailable." };
  return { ok: true, overlay: {
    key: `${result.id}:${result.revision_hash}`,
    image: plane.image,
    resultId: result.id,
    revisionHash: result.revision_hash,
    sourceId: source.id,
    sourceSha256: source.sha256,
    left: selection.x * scale.sx,
    top: selection.y * scale.sy,
    width: selection.width * scale.sx,
    height: selection.height * scale.sy,
    pixelWidth: plane.shape[1],
    pixelHeight: plane.shape[0],
    opacity,
  } };
}

export function sourcePointToResultPixel(overlay: ResolvedResultPlaneOverlay,
  point: { x: number; y: number }): { u: number; v: number } | null {
  if (point.x < overlay.left || point.y < overlay.top ||
      point.x >= overlay.left + overlay.width || point.y >= overlay.top + overlay.height) return null;
  const u = Math.round((point.x - overlay.left) / overlay.width * overlay.pixelWidth - 0.5);
  const v = Math.round((point.y - overlay.top) / overlay.height * overlay.pixelHeight - 0.5);
  return u >= 0 && v >= 0 && u < overlay.pixelWidth && v < overlay.pixelHeight ? { u, v } : null;
}

export function resultPixelToSourcePoint(overlay: ResolvedResultPlaneOverlay,
  point: { u: number; v: number }): { x: number; y: number } | null {
  if (!Number.isInteger(point.u) || !Number.isInteger(point.v) || point.u < 0 || point.v < 0 ||
      point.u >= overlay.pixelWidth || point.v >= overlay.pixelHeight) return null;
  return {
    x: overlay.left + (point.u + 0.5) / overlay.pixelWidth * overlay.width,
    y: overlay.top + (point.v + 0.5) / overlay.pixelHeight * overlay.height,
  };
}
