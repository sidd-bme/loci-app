import { describe, expect, it } from "vitest";
import {
  MAX_RAW_VOLUME_HISTOGRAM_VALUES,
  buildRawVolumeHistograms,
} from "./raw-volume-histogram";
import type { RawVolumePayload } from "./RawVolumeViewport";

function payload(components = 2): RawVolumePayload {
  return {
    schema_version: 1,
    role: "whole-volume-context",
    source_id: "source-1",
    source_sha256: "a".repeat(64),
    t: 0,
    level: 2,
    dimensions_xyz: [4, 1, 2],
    native_level_dimensions_xyz: [4, 1, 2],
    source_dimensions_xyz: [4, 1, 2],
    source_extent_xyzxyz: [0, 3, 0, 0, 0, 1],
    origin_xyz: [0, 0, 0],
    spacing_xyz: [1, 1, 1],
    direction_3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    affine_4x4: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    unit: "pixel",
    frame: "image",
    scalar_type: "uint8",
    source_dtypes: Array.from({ length: components }, () => "uint8"),
    encoding_basis: "native-common-dtype",
    interleave: "voxel-major",
    components: Array.from({ length: components }, (_, index) => ({
      channel_index: index,
      name: `C${index + 1}`,
      color_rgb: [1, 1, 1] as [number, number, number],
      window: { low: 0, high: 255, gamma: 1 },
      opacity: 1,
      visible: true,
      opacity_points: [[0, 0], [255, 1]] as [number, number][],
      provenance: {},
    })),
    data_base64: "",
    data_sha256: "b".repeat(64),
    byte_length: 8 * components,
    sampling: {
      method: "nearest-whole-extent",
      source_indices_xyz: [[0, 1, 2, 3], [0], [0, 1]],
      level_zero_indices_xyz: [[0, 1, 2, 3], [0], [0, 1]],
      aggregate_budget_bytes: 1,
      estimated_aggregate_bytes: 1,
    },
  };
}

describe("buildRawVolumeHistograms", () => {
  it("uses a deterministic whole-display-volume sample without copying decoded scalars", () => {
    const decoded = new Uint8Array([
      0, 100,
      10, 110,
      20, 120,
      30, 130,
      40, 140,
      50, 150,
      60, 160,
      70, 170,
    ]);
    const first = buildRawVolumeHistograms(payload(), decoded);
    const second = buildRawVolumeHistograms(payload(), decoded);

    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      channel_index: 0,
      label: "C1",
      sample_count: 8,
      min: 0,
      max: 70,
      units: "decoded display-level scalar values",
    });
    expect(first[1]).toMatchObject({ channel_index: 1, min: 100, max: 170 });
    expect(first[0].counts.reduce((total, count) => total + count, 0)).toBe(8);
    expect(first[0].basis).toEqual({
      kind: "deterministic-equally-spaced-whole-display-volume",
      source_id: "source-1",
      source_sha256: "a".repeat(64),
      role: "whole-volume-context",
      t: 0,
      level: 2,
      dimensions_xyz: [4, 1, 2],
      sample_count_per_component: 8,
      total_sample_values: 16,
      seed: "inclusive-linear-index-v1",
    });
  });

  it("caps all component samples at the declared bounded value count", () => {
    const source = payload(2);
    source.dimensions_xyz = [150_000, 1, 1];
    const decoded = new Uint8Array(300_000);

    const records = buildRawVolumeHistograms(source, decoded);

    expect(records[0].sample_count * records.length).toBe(MAX_RAW_VOLUME_HISTOGRAM_VALUES);
    expect(records[0].basis.total_sample_values).toBe(MAX_RAW_VOLUME_HISTOGRAM_VALUES);
  });

  it("rejects non-finite decoded float values rather than silently dropping them", () => {
    const source = payload(1);
    source.scalar_type = "float32";

    expect(() => buildRawVolumeHistograms(source, new Float32Array([0, 1, 2, 3, 4, 5, 6, Number.NaN])))
      .toThrow(/finite/);
  });

  it("rejects an unsampled non-finite float before it can enter the renderer", () => {
    const voxelCount = MAX_RAW_VOLUME_HISTOGRAM_VALUES + 100;
    const source = payload(1);
    source.scalar_type = "float32";
    source.dimensions_xyz = [voxelCount, 1, 1];
    const decoded = new Float32Array(voxelCount);
    const sampled = new Set(Array.from({ length: MAX_RAW_VOLUME_HISTOGRAM_VALUES }, (_, index) =>
      Math.round(index * (voxelCount - 1) / (MAX_RAW_VOLUME_HISTOGRAM_VALUES - 1))));
    const unsampled = Array.from({ length: voxelCount }, (_, index) => index)
      .find((index) => !sampled.has(index));
    expect(unsampled).toBeDefined();
    decoded[unsampled!] = Number.NaN;

    expect(() => buildRawVolumeHistograms(source, decoded)).toThrow(/all be finite/);
  });

  it("keeps constant floating-point bins finite without inventing a unit-wide range", () => {
    const source = payload(1);
    source.scalar_type = "float32";
    const records = buildRawVolumeHistograms(source, new Float32Array(8).fill(0.5));

    expect(records[0].counts.reduce((total, count) => total + count, 0)).toBe(8);
    expect(records[0].min).toBe(0.5);
    expect(records[0].max).toBe(0.5);
    expect(records[0].bin_range[1]).toBeGreaterThan(0.5);
    expect(records[0].bin_range[1] - 0.5).toBeLessThan(1);
    expect(records[0].percentile_1).toBe(0.5);
    expect(records[0].percentile_99).toBe(0.5);
  });

  it("rejects decoded arrays whose storage type disagrees with the payload", () => {
    expect(() => buildRawVolumeHistograms(payload(1), new Int8Array(8)))
      .toThrow(/scalar type/);
  });
});
