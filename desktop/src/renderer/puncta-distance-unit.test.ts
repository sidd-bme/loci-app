import { describe, expect, it } from "vitest";
import type { ResearchSource } from "../shared/research-contracts";
import { punctaDistanceUnit, UNVERIFIED_DISTANCE_UNIT } from "./puncta-distance-unit";

const dimensions = { t: 1, c: 1, z: 3, y: 20, x: 30 };
const selection = { x: 0, y: 0, width: 30, height: 20, t: 0, c: 0, z: 0, level: 1 };
const calibrated = (unit: string): ResearchSource => ({
  id: "source", name: "Image", sha256: "source-sha", source_kind: "native",
  metadata: { dimensions, physical_calibration: { unit: "mm", spacing: [4, 4] }, levels: [
    { index: 0, dimensions, calibration: { axes: "ZYX", spacing: [1, 1, 1], unit: "mm" } },
    { index: 1, dimensions, calibration: { axes: "YX", spacing: [0.5, 0.25], unit } },
  ] },
});

describe("puncta distance display unit", () => {
  it.each(["um", "µm", "μm", "micrometer", "micrometers"])("displays native %s as µm", (unit) => {
    expect(punctaDistanceUnit(calibrated(unit), selection)).toBe("µm");
  });

  it.each(["nm", "mm", "m", "pixel"])("retains the selected level's %s length unit", (unit) => {
    expect(punctaDistanceUnit(calibrated(unit), selection)).toBe(unit === "pixel" ? "px" : unit);
  });

  it("uses pixels for an explicitly uncalibrated native level despite base physical calibration", () => {
    const source = calibrated("um");
    source.metadata.levels![1].calibration = null;
    expect(punctaDistanceUnit(source, selection)).toBe("px");
  });

  it("requires the selected level and complete positive calibration on the selected axes", () => {
    const source = calibrated("um");
    expect(punctaDistanceUnit(source, { ...selection, level: 2 })).toBe(UNVERIFIED_DISTANCE_UNIT);
    expect(punctaDistanceUnit(source, { ...selection, z_stop: 3 })).toBe(UNVERIFIED_DISTANCE_UNIT);
    for (const spacing of [[1], [1, 0], [1, NaN], [1, Infinity]]) {
      source.metadata.levels![1].calibration!.spacing = spacing;
      expect(punctaDistanceUnit(source, selection)).toBe(UNVERIFIED_DISTANCE_UNIT);
    }
    source.metadata.levels![1].calibration = undefined;
    expect(punctaDistanceUnit(source, selection)).toBe(UNVERIFIED_DISTANCE_UNIT);
    expect(punctaDistanceUnit(calibrated("unsupported"), selection)).toBe(UNVERIFIED_DISTANCE_UNIT);
  });

  it("rejects ambiguous duplicate selected levels", () => {
    const source = calibrated("um");
    source.metadata.levels!.push({ ...source.metadata.levels![1], calibration: null });
    expect(punctaDistanceUnit(source, selection)).toBe(UNVERIFIED_DISTANCE_UNIT);
  });

  it("uses ZarrAdapter's normalized µm calibration and leaves incomplete Zarr units unverified", () => {
    const source = { ...calibrated("um"), source_kind: "ome_zarr" as const };
    expect(punctaDistanceUnit(source, selection)).toBe("µm");
    source.metadata.levels![1].calibration = null;
    expect(punctaDistanceUnit(source, selection)).toBe(UNVERIFIED_DISTANCE_UNIT);
    source.metadata.levels![1].calibration = { axes: "YX", spacing: [1, 1], unit: "nm" };
    expect(punctaDistanceUnit(source, selection)).toBe(UNVERIFIED_DISTANCE_UNIT);
  });

  it("uses source medical geometry rather than unrelated native calibration", () => {
    const source = { ...calibrated("um"), source_kind: "medical" as const };
    source.metadata.geometry = { axes: "ZYX", unit: "mm",
      affine: [[0.2, 0, 0, 0], [0, 0.2, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] };
    expect(punctaDistanceUnit(source, selection)).toBe("mm");
    source.metadata.geometry.affine![0][0] = 0;
    expect(punctaDistanceUnit(source, selection)).toBe(UNVERIFIED_DISTANCE_UNIT);
    source.metadata.geometry.affine![0][0] = NaN;
    expect(punctaDistanceUnit(source, selection)).toBe(UNVERIFIED_DISTANCE_UNIT);
    source.metadata.geometry = { unit: "mm" };
    expect(punctaDistanceUnit(source, selection)).toBe(UNVERIFIED_DISTANCE_UNIT);
  });
});
