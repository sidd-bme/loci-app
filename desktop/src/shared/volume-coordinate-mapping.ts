import type { VolumeFigurePayloadRecord } from "./research-contracts";

type Vec3 = [number, number, number];
type VolumeCoordinates = Pick<VolumeFigurePayloadRecord,
  "role" | "frame" | "unit" | "level" | "dimensions_xyz" | "native_level_dimensions_xyz" |
  "source_dimensions_xyz" | "source_extent_xyzxyz" | "origin_xyz" | "spacing_xyz" |
  "direction_3x3" | "sampling">;

const AXES = [0, 1, 2] as const;
const BOUNDARY_TOLERANCE = 1e-8;
const TRANSFORM_METHOD = "nearest-whole-extent-ngff-transform";

function roundHalfEven(value: number): number {
  const lower = Math.floor(value);
  return value - lower === 0.5 && lower % 2 === 0 ? lower : Math.round(value);
}

/** Call after checking the dimensions, extent and monotonic index arrays. */
export function validateVolumeLevelZeroSampling(payload: VolumeCoordinates): void {
  const { role, level, frame, unit, sampling } = payload;
  const transform = sampling.level_zero_index_transform;
  const error = () => new Error("Raw-volume level-zero sampling coordinates are invalid.");
  if (level === 0 && payload.native_level_dimensions_xyz.some(
    (length, axis) => length !== payload.source_dimensions_xyz[axis],
  )) throw error();
  if (sampling.method === TRANSFORM_METHOD) {
    if (level === 0 || role !== "whole-volume-context" || frame !== "image" ||
        (unit !== "um" && unit !== "pixel") || !transform ||
        Object.keys(transform).sort().join(",") !== "scale_xyz,translation_xyz" ||
        !Array.isArray(transform.scale_xyz) || transform.scale_xyz.length !== 3 ||
        !Array.isArray(transform.translation_xyz) || transform.translation_xyz.length !== 3 ||
        payload.direction_3x3.some((value, index) => Math.abs(value - (index % 4 === 0 ? 1 : 0)) > 1e-7)) {
      throw error();
    }
  } else if ((sampling.method !== "nearest-whole-extent" &&
      !(sampling.method === "nearest-focus" && role === "native-detail-focus")) || transform !== undefined) {
    throw error();
  }

  for (const axis of AXES) {
    const nativeLength = payload.native_level_dimensions_xyz[axis];
    const sourceLength = payload.source_dimensions_xyz[axis];
    const nativeIndices = sampling.source_indices_xyz[axis];
    const levelZeroIndices = sampling.level_zero_indices_xyz[axis];
    if (transform) {
      const scale = transform.scale_xyz[axis];
      const offset = transform.translation_xyz[axis];
      const last = (nativeLength - 1) * scale + offset;
      if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(offset) ||
          !Number.isFinite(last) || offset < -BOUNDARY_TOLERANCE ||
          last > sourceLength - 1 + BOUNDARY_TOLERANCE ||
          (scale < 1 && Math.floor(last + 0.5) - Math.floor(offset + 0.5) < nativeLength - 1) ||
          nativeIndices.some((index, sample) =>
            levelZeroIndices[sample] !== Math.floor(index * scale + offset + 0.5))) {
        throw error();
      }
    } else if (nativeIndices.some((index, sample) => levelZeroIndices[sample] !== (
      nativeLength <= 1 || sourceLength <= 1 ? 0 :
        roundHalfEven(index * (sourceLength - 1) / (nativeLength - 1))
    ))) {
      throw error();
    }
  }
  if (transform) {
    const { origin, spacing } = volumeLevelZeroGeometry(payload);
    if (origin.some((value) => !Number.isFinite(value)) ||
        spacing.some((value) => !Number.isFinite(value) || value <= 0)) throw error();
  }
}

/** Resolve the level-zero basis without stretching reduced NGFF grid endpoints. */
export function volumeLevelZeroGeometry(context: VolumeCoordinates): { origin: Vec3; spacing: Vec3 } {
  const transform = context.sampling.level_zero_index_transform;
  const start = AXES.map((axis) => {
    const first = context.source_extent_xyzxyz[axis * 2];
    return transform ? first * transform.scale_xyz[axis] + transform.translation_xyz[axis] :
      context.sampling.level_zero_indices_xyz[axis][0];
  });
  const spacing = AXES.map((axis) => {
    const displaySpan = context.dimensions_xyz[axis] - 1;
    const nativeSpan = context.source_extent_xyzxyz[axis * 2 + 1] - context.source_extent_xyzxyz[axis * 2];
    const levelZeroSpan = context.sampling.level_zero_indices_xyz[axis].at(-1)! - start[axis];
    if (transform) {
      const nativeStride = displaySpan > 0 ? nativeSpan / displaySpan : 1;
      return context.spacing_xyz[axis] / nativeStride / transform.scale_xyz[axis];
    }
    return levelZeroSpan > 0 ? context.spacing_xyz[axis] * displaySpan / levelZeroSpan : context.spacing_xyz[axis];
  }) as Vec3;
  const origin = AXES.map((row) => context.origin_xyz[row] - AXES.reduce<number>((sum, axis) =>
    sum + start[axis] * spacing[axis] * context.direction_3x3[axis * 3 + row], 0,
  )) as Vec3;
  return { origin, spacing };
}

export function worldAtVolumeIndex(
  origin: Vec3, spacing: Vec3, direction: VolumeCoordinates["direction_3x3"], index: number[],
): Vec3 {
  return AXES.map((row) => origin[row] + AXES.reduce<number>((sum, axis) =>
    sum + direction[axis * 3 + row] * spacing[axis] * index[axis], 0,
  )) as Vec3;
}

export function validateVolumeFocusGeometry(context: VolumeCoordinates, focus: VolumeCoordinates): void {
  if (focus.direction_3x3.some((value, index) => Math.abs(value - context.direction_3x3[index]) > 1e-5)) {
    throw new Error("Raw-volume focus geometry disagrees with its context source coordinates.");
  }
  const { origin, spacing } = volumeLevelZeroGeometry(context);
  for (let corner = 0; corner < 8; corner += 1) {
    const displayIndex = AXES.map((axis) => corner & (1 << axis) ? focus.dimensions_xyz[axis] - 1 : 0);
    const sourceIndex = AXES.map((axis) => focus.sampling.level_zero_indices_xyz[axis][displayIndex[axis]]);
    const actual = worldAtVolumeIndex(focus.origin_xyz, focus.spacing_xyz, focus.direction_3x3, displayIndex);
    const expected = worldAtVolumeIndex(origin, spacing, context.direction_3x3, sourceIndex);
    const tolerance = context.sampling.level_zero_index_transform
      ? Math.max(Math.min(...spacing) * 1e-9, Number.EPSILON * 32 *
        Math.max(1, ...actual.map(Math.abs), ...expected.map(Math.abs)))
      : Math.max(1e-6, Math.hypot(...spacing) * 0.500001);
    if (![...actual, ...expected].every(Number.isFinite) ||
        Math.hypot(...actual.map((value, axis) => value - expected[axis])) > tolerance) {
      throw new Error("Raw-volume focus geometry disagrees with its context source coordinates.");
    }
  }
}
