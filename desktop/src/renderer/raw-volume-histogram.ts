import type { RawVolumePayload } from "./RawVolumeViewport";

type TypedScalars =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array;

export const MAX_RAW_VOLUME_HISTOGRAM_VALUES = 262_144;
export const RAW_VOLUME_HISTOGRAM_BINS = 256;

export type RawVolumeHistogramBasis = {
  kind: "deterministic-equally-spaced-whole-display-volume";
  source_id: string;
  source_sha256: string;
  role: "whole-volume-context";
  t: number;
  level: number;
  dimensions_xyz: [number, number, number];
  sample_count_per_component: number;
  total_sample_values: number;
  seed: "inclusive-linear-index-v1";
};

export type RawVolumeHistogramRecord = {
  channel_index: number;
  label: string;
  units: "decoded display-level scalar values";
  dtype: RawVolumePayload["scalar_type"];
  sample_count: number;
  min: number;
  max: number;
  bin_range: [number, number];
  counts: number[];
  percentile_1: number;
  percentile_99: number;
  clipping: { below_percentile_1_bin: number; above_percentile_99_bin: number };
  basis: RawVolumeHistogramBasis;
};

function sampledVoxelIndex(index: number, sampleCount: number, voxelCount: number): number {
  if (sampleCount === 1) return 0;
  return Math.round(index * (voxelCount - 1) / (sampleCount - 1));
}

function constantBinHigh(value: number, dtype: RawVolumePayload["scalar_type"]): number {
  let increment = dtype === "float32"
    ? Math.max(Number.MIN_VALUE, Math.abs(value) * Number.EPSILON)
    : 1;
  let high = value + increment;
  if (dtype === "float32" && high <= value) {
    increment *= 2;
    high = value + increment;
  }
  if (!Number.isFinite(high) || high <= value) {
    throw new Error("Raw-volume histogram cannot form a finite bin range.");
  }
  return high;
}

function percentileBin(counts: number[], rank: number): number {
  let cumulative = 0;
  for (let index = 0; index < counts.length; index += 1) {
    cumulative += counts[index];
    if (cumulative >= rank) return index;
  }
  return counts.length - 1;
}

export function buildRawVolumeHistograms(
  payload: RawVolumePayload,
  values: TypedScalars,
): RawVolumeHistogramRecord[] {
  if (payload.role !== "whole-volume-context") {
    throw new Error("Raw-volume histograms require the whole-volume context payload.");
  }
  const components = payload.components.length;
  if (!Number.isInteger(components) || components < 1 || components > 4) {
    throw new Error("Raw-volume histograms require one to four interleaved components.");
  }
  const voxelCount = payload.dimensions_xyz.reduce((total, value) => total * value, 1);
  const expectedValues = voxelCount * components;
  if (!Number.isSafeInteger(voxelCount) || voxelCount < 1 ||
      values.length !== expectedValues || !Number.isSafeInteger(expectedValues)) {
    throw new Error("Decoded raw-volume scalars disagree with the declared display dimensions.");
  }
  const expectedArray = {
    uint8: Uint8Array,
    int8: Int8Array,
    uint16: Uint16Array,
    int16: Int16Array,
    uint32: Uint32Array,
    int32: Int32Array,
    float32: Float32Array,
  }[payload.scalar_type];
  if (!expectedArray || !(values instanceof expectedArray)) {
    throw new Error("Decoded raw-volume scalars disagree with the declared scalar type.");
  }
  // Sampling bounds the plotted distribution. It must not let a NaN or
  // infinity elsewhere in a floating-point payload enter VTK unnoticed.
  if (values instanceof Float32Array && !values.every(Number.isFinite)) {
    throw new Error("Decoded raw-volume scalar values must all be finite.");
  }
  const sampleCount = Math.min(voxelCount, Math.floor(MAX_RAW_VOLUME_HISTOGRAM_VALUES / components));
  if (sampleCount < 1) throw new Error("Raw-volume histogram sample bound is invalid.");
  const basis: RawVolumeHistogramBasis = {
    kind: "deterministic-equally-spaced-whole-display-volume",
    source_id: payload.source_id,
    source_sha256: payload.source_sha256,
    role: "whole-volume-context",
    t: payload.t,
    level: payload.level,
    dimensions_xyz: [...payload.dimensions_xyz],
    sample_count_per_component: sampleCount,
    total_sample_values: sampleCount * components,
    seed: "inclusive-linear-index-v1",
  };
  return payload.components.map((component, componentIndex) => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < sampleCount; index += 1) {
      const value = values[sampledVoxelIndex(index, sampleCount, voxelCount) * components + componentIndex];
      if (!Number.isFinite(value)) throw new Error("Decoded raw-volume histogram samples must be finite.");
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const binHigh = max > min ? max : constantBinHigh(max, payload.scalar_type);
    const counts = Array.from({ length: RAW_VOLUME_HISTOGRAM_BINS }, () => 0);
    for (let index = 0; index < sampleCount; index += 1) {
      const value = values[sampledVoxelIndex(index, sampleCount, voxelCount) * components + componentIndex];
      const bin = Math.min(
        RAW_VOLUME_HISTOGRAM_BINS - 1,
        Math.max(0, Math.floor((value - min) / (binHigh - min) * RAW_VOLUME_HISTOGRAM_BINS)),
      );
      counts[bin] += 1;
    }
    const lowerBin = percentileBin(counts, Math.max(1, Math.ceil(sampleCount * 0.01)));
    const upperBin = percentileBin(counts, Math.max(1, Math.ceil(sampleCount * 0.99)));
    const lowerEdge = min + lowerBin / RAW_VOLUME_HISTOGRAM_BINS * (binHigh - min);
    const upperEdge = Math.min(max, min + (upperBin + 1) / RAW_VOLUME_HISTOGRAM_BINS * (binHigh - min));
    const lowerTail = counts.slice(0, lowerBin).reduce((total, count) => total + count, 0);
    const upperTail = counts.slice(upperBin + 1).reduce((total, count) => total + count, 0);
    return {
      channel_index: component.channel_index,
      label: component.name,
      units: "decoded display-level scalar values",
      dtype: payload.scalar_type,
      sample_count: sampleCount,
      min,
      max,
      bin_range: [min, binHigh],
      counts,
      percentile_1: lowerEdge,
      percentile_99: upperEdge,
      clipping: { below_percentile_1_bin: lowerTail, above_percentile_99_bin: upperTail },
      basis,
    };
  });
}
