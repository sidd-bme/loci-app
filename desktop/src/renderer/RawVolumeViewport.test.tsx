// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import {
  contextClippingPlane,
  qualityToSamplingFactor,
  type RawVolumePayload,
  type RawVolumeResponse,
  RENDER_MODE_DETAILS,
  validateRawVolumePayload,
  validateRawVolumeResponse,
  worldAtDisplayIndex,
} from "./RawVolumeViewport";

function payload(): RawVolumePayload {
  return {
    schema_version: 1,
    role: "whole-volume-context",
    source_id: "source-1",
    source_sha256: "a".repeat(64),
    t: 0,
    level: 0,
    dimensions_xyz: [2, 1, 2],
    native_level_dimensions_xyz: [2, 1, 2],
    source_dimensions_xyz: [2, 1, 2],
    source_extent_xyzxyz: [0, 1, 0, 0, 0, 1],
    origin_xyz: [10, 20, 30],
    spacing_xyz: [0.4, 0.8, 2.5],
    direction_3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    affine_4x4: [[0.4, 0, 0, 10], [0, 0.8, 0, 20], [0, 0, 2.5, 30], [0, 0, 0, 1]],
    unit: "um",
    frame: "image",
    scalar_type: "uint8",
    source_dtypes: ["uint8"],
    encoding_basis: "native-common-dtype",
    interleave: "voxel-major",
    components: [{
      channel_index: 0,
      name: "C1",
      color_rgb: [1, 1, 1],
      window: { low: 0, high: 255, gamma: 1 },
      opacity: 1,
      visible: true,
      opacity_points: [[0, 0], [255, 1]],
      provenance: { range: "native-dtype-range" },
    }],
    data_base64: "AAECAw==",
    data_sha256: "0".repeat(64),
    byte_length: 4,
    sampling: {
      method: "nearest-whole-extent",
      source_indices_xyz: [[0, 1], [0], [0, 1]],
      level_zero_indices_xyz: [[0, 1], [0], [0, 1]],
      aggregate_budget_bytes: 1024 * 1024,
      estimated_aggregate_bytes: 18,
    },
  };
}

function responseWithFocus(): RawVolumeResponse {
  const context = payload();
  context.dimensions_xyz = [2, 1, 2];
  context.native_level_dimensions_xyz = [4, 1, 4];
  context.source_dimensions_xyz = [4, 1, 4];
  context.source_extent_xyzxyz = [0, 3, 0, 0, 0, 3];
  context.spacing_xyz = [1.2, 0.8, 7.5];
  context.affine_4x4 = [[1.2, 0, 0, 10], [0, 0.8, 0, 20], [0, 0, 7.5, 30], [0, 0, 0, 1]];
  context.sampling.source_indices_xyz = [[0, 3], [0], [0, 3]];
  context.sampling.level_zero_indices_xyz = [[0, 3], [0], [0, 3]];

  const focus = payload();
  focus.role = "level-zero-focus";
  focus.native_level_dimensions_xyz = [4, 1, 4];
  focus.source_dimensions_xyz = [4, 1, 4];
  focus.source_extent_xyzxyz = [2, 3, 0, 0, 2, 3];
  focus.origin_xyz = [10.8, 20, 35];
  focus.affine_4x4 = [[0.4, 0, 0, 10.8], [0, 0.8, 0, 20], [0, 0, 2.5, 35], [0, 0, 0, 1]];
  focus.sampling.source_indices_xyz = [[2, 3], [0], [2, 3]];
  focus.sampling.level_zero_indices_xyz = [[2, 3], [0], [2, 3]];
  return { schema_version: 1, context, focus };
}

describe("validateRawVolumePayload", () => {
  it("accepts a bounded scalar whole-volume payload", () => {
    expect(() => validateRawVolumePayload(payload())).not.toThrow();
  });

  it("rejects 2D, length-mismatched, and sheared payloads", () => {
    const twoDimensional = payload();
    twoDimensional.dimensions_xyz = [2, 2, 1];
    expect(() => validateRawVolumePayload(twoDimensional)).toThrow(/two Z planes/);

    const wrongLength = payload();
    wrongLength.byte_length = 3;
    expect(() => validateRawVolumePayload(wrongLength)).toThrow(/byte length/);

    const shear = payload();
    shear.direction_3x3 = [1, 0.2, 0, 0, 1, 0, 0, 0, 1];
    expect(() => validateRawVolumePayload(shear)).toThrow(/affine|orthonormal/);
  });

  it("rejects reversed, out-of-level, and endpoint-mismatched source sampling", () => {
    const reversed = payload();
    reversed.source_extent_xyzxyz = [1, 0, 0, 0, 0, 1];
    expect(() => validateRawVolumePayload(reversed)).toThrow(/extent/);

    const outside = payload();
    outside.sampling.source_indices_xyz[0] = [0, 2];
    expect(() => validateRawVolumePayload(outside)).toThrow(/sampling/);

    const endpoint = responseWithFocus().context;
    endpoint.sampling.source_indices_xyz[0] = [0, 2];
    expect(() => validateRawVolumePayload(endpoint)).toThrow(/sampling/);

    const wrongLevelZero = payload();
    wrongLevelZero.sampling.level_zero_indices_xyz[2] = [0, 2];
    expect(() => validateRawVolumePayload(wrongLevelZero)).toThrow(/sampling/);
  });

  it("accepts the engine's rounded nearest interior samples with exact extent endpoints", () => {
    const rounded = payload();
    rounded.dimensions_xyz = [4, 1, 2];
    rounded.native_level_dimensions_xyz = [11, 1, 2];
    rounded.source_dimensions_xyz = [11, 1, 2];
    rounded.source_extent_xyzxyz = [0, 10, 0, 0, 0, 1];
    rounded.spacing_xyz[0] = 4 / 3;
    rounded.affine_4x4[0][0] = 4 / 3;
    rounded.sampling.source_indices_xyz[0] = [0, 3, 7, 10];
    rounded.sampling.level_zero_indices_xyz[0] = [0, 3, 7, 10];
    rounded.byte_length = 8;
    rounded.data_base64 = "AAAAAAAAAAA=";
    rounded.sampling.estimated_aggregate_bytes = 35;
    expect(() => validateRawVolumePayload(rounded)).not.toThrow();
  });

  it("binds focus geometry to the same level-zero source coordinate frame", () => {
    expect(() => validateRawVolumeResponse(responseWithFocus())).not.toThrow();

    const wrongFrame = responseWithFocus();
    wrongFrame.focus!.frame = "RAS";
    expect(() => validateRawVolumeResponse(wrongFrame)).toThrow(/not bound/);

    const wrongOrigin = responseWithFocus();
    wrongOrigin.focus!.origin_xyz[0] += 2;
    wrongOrigin.focus!.affine_4x4[0][3] += 2;
    expect(() => validateRawVolumeResponse(wrongOrigin)).toThrow(/geometry/);

    const wrongSourceDimensions = responseWithFocus();
    wrongSourceDimensions.focus!.native_level_dimensions_xyz = [5, 1, 4];
    wrongSourceDimensions.focus!.source_dimensions_xyz = [5, 1, 4];
    expect(() => validateRawVolumeResponse(wrongSourceDimensions)).toThrow(/not bound/);
  });

  it("uses vtk column-major direction so oblique reflected index-to-world matches the affine", () => {
    const image = vtkImageData.newInstance();
    image.setDimensions(10, 8, 6);
    image.setOrigin([10, 20, 30]);
    image.setSpacing([0.4, 0.8, 2.5]);
    image.setDirection([0, 1, 0, -1, 0, 0, 0, 0, -1]);
    expect(image.indexToWorld([3, 2, 1])).toEqual([8.4, 21.2, 27.5]);
    image.delete();
  });

  it("derives crosshair and clipping coordinates once in the context world frame", () => {
    const oblique = payload();
    oblique.dimensions_xyz = [10, 8, 6];
    oblique.native_level_dimensions_xyz = [10, 8, 6];
    oblique.source_dimensions_xyz = [10, 8, 6];
    oblique.direction_3x3 = [0, 1, 0, -1, 0, 0, 0, 0, -1];
    oblique.affine_4x4 = [[0, -0.8, 0, 10], [0.4, 0, 0, 20], [0, 0, -2.5, 30], [0, 0, 0, 1]];
    expect(worldAtDisplayIndex(oblique, [3, 2, 1])).toEqual([8.4, 21.2, 27.5]);
    expect(contextClippingPlane(oblique, 0, 50)).toEqual({ origin: [10, 21.8, 30], normal: [0, 1, 0] });
    expect(() => contextClippingPlane(oblique, 0, 101)).toThrow(/percentage/);
  });
});

describe("qualityToSamplingFactor", () => {
  it("computes expected sampling factors across quality ranges", () => {
    expect(qualityToSamplingFactor(10)).toBeCloseTo(2.5);
    expect(qualityToSamplingFactor(50)).toBeCloseTo(1.0);
    expect(qualityToSamplingFactor(100)).toBeCloseTo(0.35);
    expect(qualityToSamplingFactor(30)).toBeCloseTo(1.75);
    expect(qualityToSamplingFactor(75)).toBeCloseTo(0.675);
  });

  it("clamps values below 10 and above 100", () => {
    expect(qualityToSamplingFactor(0)).toBeCloseTo(2.5);
    expect(qualityToSamplingFactor(-50)).toBeCloseTo(2.5);
    expect(qualityToSamplingFactor(150)).toBeCloseTo(0.35);
  });

  it("monotonically decreases sampling factor as quality increases", () => {
    const qualities = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (let i = 1; i < qualities.length; i++) {
      expect(qualityToSamplingFactor(qualities[i])).toBeLessThan(
        qualityToSamplingFactor(qualities[i - 1]),
      );
    }
  });
});

describe("RENDER_MODE_DETAILS", () => {
  it("provides correct shading and blend configuration for all 3D modes", () => {
    expect(RENDER_MODE_DETAILS.blend.shade).toBe(false);
    expect(RENDER_MODE_DETAILS.normal_shading.shade).toBe(true);
    expect(RENDER_MODE_DETAILS.mip.shade).toBe(false);
    expect(RENDER_MODE_DETAILS.average.shade).toBe(false);
    expect(RENDER_MODE_DETAILS.minip.shade).toBe(false);

    expect(RENDER_MODE_DETAILS.blend.label).toBe("Blend");
    expect(RENDER_MODE_DETAILS.normal_shading.label).toBe("Normal Shading");
    expect(RENDER_MODE_DETAILS.mip.label).toBe("MIP");
    expect(RENDER_MODE_DETAILS.average.label).toBe("Average");
    expect(RENDER_MODE_DETAILS.minip.label).toBe("MinIP");
  });
});

