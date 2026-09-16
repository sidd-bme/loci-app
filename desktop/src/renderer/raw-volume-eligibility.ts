import type { ResearchSource } from "../shared/research-contracts";

const GEOMETRY_TOLERANCE = 1e-7;

function hasSourceDepth(source: ResearchSource): boolean {
  if (source.source_kind === "medical") {
    const shape = source.metadata.shape;
    return Boolean(
      shape &&
        shape.length === 3 &&
        Number.isInteger(shape[0]) &&
        shape[0] >= 2,
    );
  }
  const levels = source.metadata.levels;
  if (levels) {
    return levels.some(
      (level) => Number.isInteger(level.dimensions.z) && level.dimensions.z >= 2,
    );
  }
  const depth = source.metadata.dimensions?.z;
  return depth !== undefined && Number.isInteger(depth) && depth >= 2;
}

function geometryReason(source: ResearchSource): string | null {
  const affine = source.metadata.geometry?.affine;
  if (!affine) {
    return source.source_kind === "medical"
      ? "Raw 3D rendering requires verified source geometry."
      : null;
  }
  if (
    affine.length !== 4 ||
    affine.some(
      (row) =>
        row.length !== 4 || row.some((value) => !Number.isFinite(value)),
    )
  ) {
    return "Raw 3D rendering requires finite, invertible source geometry.";
  }
  const directions: number[][] = [];
  for (let column = 0; column < 3; column += 1) {
    const basis = [affine[0][column], affine[1][column], affine[2][column]];
    const spacing = Math.hypot(...basis);
    if (!Number.isFinite(spacing) || spacing <= 0) {
      return "Raw 3D rendering requires finite, invertible source geometry.";
    }
    directions.push(basis.map((value) => value / spacing));
  }
  for (let column = 0; column < 3; column += 1) {
    for (let other = 0; other < 3; other += 1) {
      const dot = directions[column].reduce(
        (total, value, row) => total + value * directions[other][row],
        0,
      );
      if (
        Math.abs(dot - (column === other ? 1 : 0)) > GEOMETRY_TOLERANCE
      ) {
        return "The source uses sheared voxel geometry, which raw 3D rendering cannot represent faithfully.";
      }
    }
  }
  return null;
}

/** Return the verified structural reason that raw 3D is unavailable. */
export function rawVolumeUnavailableReason(source: ResearchSource): string | null {
  if (source.source_kind !== "medical") {
    if (["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "")) {
      return "Interleaved RGB or RGBA samples are not scalar channels for raw 3D rendering.";
    }
    if (source.metadata.dimensions?.s !== undefined && source.metadata.dimensions.s !== 1) {
      return "Raw 3D rendering requires one scalar sample per voxel.";
    }
  }
  if (!hasSourceDepth(source)) {
    return "Raw 3D rendering requires at least two source Z planes.";
  }
  return geometryReason(source);
}
