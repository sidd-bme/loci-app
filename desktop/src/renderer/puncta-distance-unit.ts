import type { ResearchSelection, ResearchSource } from "../shared/research-contracts";

export const UNVERIFIED_DISTANCE_UNIT = "unit unverified";

function displayUnit(unit: string | undefined): string | null {
  if (["um", "µm", "μm", "micrometer", "micrometers"].includes(unit ?? "")) return "µm";
  if (unit === "pixel") return "px";
  return unit && ["nm", "mm", "m"].includes(unit) ? unit : null;
}

/** Display only: follow Workbench.load_scalar's source/level geometry, never a result. */
export function punctaDistanceUnit(source: ResearchSource, selection: ResearchSelection): string {
  const volume = selection.z_stop !== undefined;
  if (source.source_kind === "medical") {
    const geometry = source.metadata.geometry;
    const affine = geometry?.affine;
    if (!geometry || !["YX", "ZYX"].includes(geometry.axes ?? "") ||
        (volume && geometry.axes !== "ZYX") || !Array.isArray(affine) || affine.length !== 4 ||
        affine.some((row) => !Array.isArray(row) || row.length !== 4 || row.some((value) => !Number.isFinite(value))))
      return UNVERIFIED_DISTANCE_UNIT;
    const determinant = affine[0][0] * (affine[1][1] * affine[2][2] - affine[1][2] * affine[2][1]) -
      affine[0][1] * (affine[1][0] * affine[2][2] - affine[1][2] * affine[2][0]) +
      affine[0][2] * (affine[1][0] * affine[2][1] - affine[1][1] * affine[2][0]);
    if (!Number.isFinite(determinant) || determinant === 0 ||
        affine[3].some((value, index) => value !== (index === 3 ? 1 : 0)))
      return UNVERIFIED_DISTANCE_UNIT;
    return displayUnit(geometry.unit) ?? UNVERIFIED_DISTANCE_UNIT;
  }

  const levels = source.metadata.levels?.filter((item) => item.index === selection.level);
  if (levels?.length !== 1) return UNVERIFIED_DISTANCE_UNIT;
  const calibration = levels[0].calibration;
  // NativeImage.geometry explicitly uses pixel geometry for an uncalibrated level.
  // ZarrAdapter's null calibration can also mean partial/unsupported spatial units.
  if (calibration === null)
    return source.source_kind === "ome_zarr" ? UNVERIFIED_DISTANCE_UNIT : "px";
  if (!calibration || !["YX", "ZYX"].includes(calibration.axes) ||
      (volume && calibration.axes !== "ZYX") || !Array.isArray(calibration.spacing) || calibration.spacing.length !== calibration.axes.length ||
      calibration.spacing.some((spacing) => !Number.isFinite(spacing) || spacing <= 0))
    return UNVERIFIED_DISTANCE_UNIT;
  // ZarrAdapter normalizes supported physical calibrations to micrometres.
  if (source.source_kind === "ome_zarr" && calibration.unit !== "um") return UNVERIFIED_DISTANCE_UNIT;
  return displayUnit(calibration.unit) ?? UNVERIFIED_DISTANCE_UNIT;
}
