import "@kitware/vtk.js/Rendering/Profiles/Volume";
import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkPiecewiseFunction from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";
import vtkMouseCameraTrackballPanManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator";
import vtkMouseCameraTrackballRotateManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator";
import vtkMouseCameraTrackballZoomManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator";
import vtkInteractorStyleManipulator from "@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator";
import vtkOrientationMarkerWidget from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget";
import { Corners } from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget/Constants";
import vtkAxesActor from "@kitware/vtk.js/Rendering/Core/AxesActor";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkImageMapper from "@kitware/vtk.js/Rendering/Core/ImageMapper";
import { SlicingMode } from "@kitware/vtk.js/Rendering/Core/ImageMapper/Constants";
import vtkImageSlice from "@kitware/vtk.js/Rendering/Core/ImageSlice";
import vtkVolume from "@kitware/vtk.js/Rendering/Core/Volume";
import vtkVolumeMapper from "@kitware/vtk.js/Rendering/Core/VolumeMapper";
import { BlendMode } from "@kitware/vtk.js/Rendering/Core/VolumeMapper/Constants";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VolumeFigureExportReceipt, VolumeFigureExportRequest, VolumeFigurePayloadRecord } from "../shared/research-contracts";
import { HistogramPlot, type HistogramRecord } from "./DisplayHistogram";
import { buildRawVolumeHistograms, type RawVolumeHistogramRecord } from "./raw-volume-histogram";
import { ArrowLeftRight, Grid2X2, Maximize2, Minimize2, Box, SlidersHorizontal } from "lucide-react";
import { MprSlicePane } from "./MprSlicePane";
import { mprPlanes, worldToIndex, type MprScalars, type Vec3 } from "./mpr-reslice";
import "./RawVolumeViewport.css";

export type RawVolumeScalarType =
  | "uint8"
  | "int8"
  | "uint16"
  | "int16"
  | "uint32"
  | "int32"
  | "float32";

export type RawVolumeComponent = {
  channel_index: number;
  name: string;
  color_rgb: [number, number, number];
  window: { low: number; high: number; gamma: number };
  opacity: number;
  visible: boolean;
  opacity_points: [number, number][];
  provenance: Record<string, string>;
};

export type RawVolumePayload = {
  schema_version: 1;
  role: "whole-volume-context" | "level-zero-focus" | "native-detail-focus";
  source_id: string;
  source_sha256: string;
  source_identity?: string;
  t: number;
  level: number;
  dimensions_xyz: [number, number, number];
  native_level_dimensions_xyz: [number, number, number];
  source_dimensions_xyz: [number, number, number];
  source_extent_xyzxyz: [number, number, number, number, number, number];
  origin_xyz: [number, number, number];
  spacing_xyz: [number, number, number];
  direction_3x3: [number, number, number, number, number, number, number, number, number];
  affine_4x4: number[][];
  unit: "pixel" | "nm" | "um" | "mm" | "m";
  frame: "image" | "RAS" | "LPS";
  scalar_type: RawVolumeScalarType;
  source_dtypes: string[];
  encoding_basis: string;
  interleave: "voxel-major";
  components: RawVolumeComponent[];
  data_base64: string;
  data_sha256: string;
  byte_length: number;
  sampling: {
    method: string;
    source_indices_xyz: [number[], number[], number[]];
    level_zero_indices_xyz: [number[], number[], number[]];
    aggregate_budget_bytes: number;
    estimated_aggregate_bytes: number;
  };
  refinement?: {
    available: boolean;
    maximum_target_long_axis: number;
    focus_supported: boolean;
  };
};

export type RawVolumeResponse = {
  schema_version: 1;
  context: RawVolumePayload;
  focus: RawVolumePayload | null;
};

export type RawVolumeRefinementRequest = {
  target_long_axis: number;
  focus_region_xyzxyz?: [number, number, number, number, number, number];
};

type CameraSnapshot = {
  binding: string;
  position: number[];
  focalPoint: number[];
  viewUp: number[];
  parallelScale?: number;
};

type Props = {
  volume: RawVolumeResponse | null;
  loading?: boolean;
  error?: string | null;
  onRequestRefinement?: (request: RawVolumeRefinementRequest) => void;
  onExportFigure?: (request: VolumeFigureExportRequest) => Promise<VolumeFigureExportReceipt | null>;
};

type TransferState = RawVolumeComponent & { opacity: number; visible: boolean };
type TypedScalars =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array;

export type VolumeRenderMode = "blend" | "normal_shading" | "mip" | "average" | "minip";

export const RENDER_MODE_DETAILS: Record<VolumeRenderMode, {
  label: string;
  title: string;
  blendMode: number;
  shade: boolean;
}> = {
  blend: {
    label: "Blend",
    title: "Alpha-composited volumetric emission-absorption rendering (unshaded)",
    blendMode: BlendMode.COMPOSITE_BLEND,
    shade: false,
  },
  normal_shading: {
    label: "Normal Shading",
    title: "Directional surface normal lighting (Phong shading) computed from volume gradients",
    blendMode: BlendMode.COMPOSITE_BLEND,
    shade: true,
  },
  mip: {
    label: "MIP",
    title: "Maximum Intensity Projection — brightest voxel along each ray",
    blendMode: BlendMode.MAXIMUM_INTENSITY_BLEND,
    shade: false,
  },
  average: {
    label: "Average",
    title: "Average Intensity Projection — X-ray-like transmission mean along each ray",
    blendMode: BlendMode.AVERAGE_INTENSITY_BLEND,
    shade: false,
  },
  minip: {
    label: "MinIP",
    title: "Minimum Intensity Projection — darkest voxel along each ray",
    blendMode: BlendMode.MINIMUM_INTENSITY_BLEND,
    shade: false,
  },
};

/** Convert 10–100 quality slider to ray sampling factor (quality 10: 2.5x spacing, quality 50: 1.0x spacing, quality 100: 0.35x spacing). */
export function qualityToSamplingFactor(quality: number): number {
  const clamped = Math.max(10, Math.min(100, quality));
  if (clamped <= 50) {
    const t = (clamped - 10) / 40;
    return 2.5 - t * 1.5;
  }
  const t = (clamped - 50) / 50;
  return 1.0 - t * 0.65;
}

const MAX_SCALAR_BYTES = 64 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 128 * 1024 * 1024;
const MAX_FIGURE_EDGE = 8192;
const MAX_FIGURE_PIXELS = 16 * 1024 * 1024;
const TYPE_INFO: Record<RawVolumeScalarType, [number, (buffer: ArrayBuffer) => TypedScalars]> = {
  uint8: [1, (buffer) => new Uint8Array(buffer)],
  int8: [1, (buffer) => new Int8Array(buffer)],
  uint16: [2, (buffer) => new Uint16Array(buffer)],
  int16: [2, (buffer) => new Int16Array(buffer)],
  uint32: [4, (buffer) => new Uint32Array(buffer)],
  int32: [4, (buffer) => new Int32Array(buffer)],
  float32: [4, (buffer) => new Float32Array(buffer)],
};

function finiteVector(value: unknown, count: number, positive = false): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === count &&
    value.every((item) =>
      typeof item === "number" && Number.isFinite(item) && (!positive || item > 0)
    )
  );
}

const VOLUME_ROLES = ["whole-volume-context", "level-zero-focus", "native-detail-focus"] as const;
const VOLUME_FRAMES = ["image", "RAS", "LPS"] as const;
const VOLUME_UNITS = ["pixel", "nm", "um", "mm", "m"] as const;

function nativeToLevelZero(index: number, nativeLength: number, sourceLength: number): number {
  if (nativeLength <= 1 || sourceLength <= 1) return 0;
  return Math.round(index * (sourceLength - 1) / (nativeLength - 1));
}

export function validateRawVolumePayload(payload: RawVolumePayload): void {
  if (payload.schema_version !== 1 || payload.interleave !== "voxel-major") {
    throw new Error("Unsupported raw-volume payload schema.");
  }
  if (!VOLUME_ROLES.includes(payload.role) || !VOLUME_FRAMES.includes(payload.frame) ||
      !VOLUME_UNITS.includes(payload.unit) || !Number.isInteger(payload.level) || payload.level < 0) {
    throw new Error("Raw-volume role, frame, unit, or level is invalid.");
  }
  if (
    !finiteVector(payload.dimensions_xyz, 3, true) ||
    payload.dimensions_xyz.some((value) => !Number.isInteger(value)) ||
    payload.dimensions_xyz[2] < 2
  ) {
    throw new Error("Raw-volume dimensions must be positive XYZ integers with at least two Z planes.");
  }
  if (
    !finiteVector(payload.native_level_dimensions_xyz, 3, true) ||
    !finiteVector(payload.source_dimensions_xyz, 3, true) ||
    payload.native_level_dimensions_xyz.some((value) => !Number.isInteger(value)) ||
    payload.source_dimensions_xyz.some((value) => !Number.isInteger(value)) ||
    !finiteVector(payload.source_extent_xyzxyz, 6) ||
    payload.source_extent_xyzxyz.some((value) => !Number.isInteger(value))
  ) {
    throw new Error("Raw-volume source dimensions or extent are invalid.");
  }
  if (payload.native_level_dimensions_xyz.some((value, axis) => value > payload.source_dimensions_xyz[axis])) {
    throw new Error("Raw-volume native dimensions exceed the level-zero source.");
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const low = payload.source_extent_xyzxyz[axis * 2];
    const high = payload.source_extent_xyzxyz[axis * 2 + 1];
    if (low < 0 || low > high || high >= payload.native_level_dimensions_xyz[axis]) {
      throw new Error("Raw-volume source extent is outside its native level.");
    }
    if (payload.role === "whole-volume-context" &&
        (low !== 0 || high !== payload.native_level_dimensions_xyz[axis] - 1)) {
      throw new Error("Whole-volume context does not cover its complete native level.");
    }
  }
  if (payload.role !== "whole-volume-context" &&
      (payload.level !== 0 || payload.native_level_dimensions_xyz.some(
        (value, axis) => value !== payload.source_dimensions_xyz[axis],
      ))) {
    throw new Error("Raw-volume focus must use level-zero source coordinates.");
  }
  if (!finiteVector(payload.origin_xyz, 3) || !finiteVector(payload.spacing_xyz, 3, true)) {
    throw new Error("Raw-volume origin and spacing are invalid.");
  }
  if (!finiteVector(payload.direction_3x3, 9)) {
    throw new Error("Raw-volume direction is invalid.");
  }
  if (
    !Array.isArray(payload.affine_4x4) ||
    payload.affine_4x4.length !== 4 ||
    payload.affine_4x4.some((row) => !finiteVector(row, 4)) ||
    payload.affine_4x4[3].some((value, index) => value !== (index === 3 ? 1 : 0))
  ) {
    throw new Error("Raw-volume affine is invalid.");
  }
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      const expectedBasis = payload.direction_3x3[column * 3 + row] * payload.spacing_xyz[column];
      if (Math.abs(payload.affine_4x4[row][column] - expectedBasis) > 1e-7) {
        throw new Error("Raw-volume affine disagrees with direction and spacing.");
      }
    }
    if (Math.abs(payload.affine_4x4[column][3] - payload.origin_xyz[column]) > 1e-7) {
      throw new Error("Raw-volume affine disagrees with its origin.");
    }
  }
  const direction = payload.direction_3x3;
  for (let column = 0; column < 3; column += 1) {
    for (let other = 0; other < 3; other += 1) {
      let dot = 0;
      for (let row = 0; row < 3; row += 1) dot += direction[column * 3 + row] * direction[other * 3 + row];
      if (Math.abs(dot - (column === other ? 1 : 0)) > 1e-5) {
        throw new Error("Raw-volume direction must be orthonormal.");
      }
    }
  }
  if (!TYPE_INFO[payload.scalar_type] || !Number.isInteger(payload.byte_length)) {
    throw new Error("Raw-volume scalar encoding is invalid.");
  }
  if (!Array.isArray(payload.components) || payload.components.length < 1 || payload.components.length > 4) {
    throw new Error("Raw-volume payloads require one to four components.");
  }
  if (!/^[0-9a-f]{64}$/.test(payload.source_sha256)) {
    throw new Error("Raw-volume source fingerprint is invalid.");
  }
  const samplingAxes = [payload.sampling.source_indices_xyz, payload.sampling.level_zero_indices_xyz];
  if (samplingAxes.some((axes) => !Array.isArray(axes) || axes.length !== 3)) {
    throw new Error("Raw-volume sampling coordinates are invalid.");
  }
  samplingAxes.forEach((axes, coordinateLevel) => {
    axes.forEach((indices, axis) => {
      const nativeLow = payload.source_extent_xyzxyz[axis * 2];
      const nativeHigh = payload.source_extent_xyzxyz[axis * 2 + 1];
      const maximum = (coordinateLevel === 0
        ? payload.native_level_dimensions_xyz
        : payload.source_dimensions_xyz)[axis] - 1;
      const expectedLow = coordinateLevel === 0 ? nativeLow : nativeToLevelZero(
        nativeLow, payload.native_level_dimensions_xyz[axis], payload.source_dimensions_xyz[axis],
      );
      const expectedHigh = coordinateLevel === 0 ? nativeHigh : nativeToLevelZero(
        nativeHigh, payload.native_level_dimensions_xyz[axis], payload.source_dimensions_xyz[axis],
      );
      if (
        !Array.isArray(indices) ||
        indices.length !== payload.dimensions_xyz[axis] ||
        indices.some((value) => !Number.isInteger(value) || value < expectedLow || value > expectedHigh || value > maximum) ||
        indices.some((value, index) => index > 0 && value <= indices[index - 1]) ||
        indices[0] !== expectedLow || indices.at(-1) !== expectedHigh
      ) {
        throw new Error("Raw-volume sampling coordinates are invalid.");
      }
    });
  });
  const [itemSize] = TYPE_INFO[payload.scalar_type];
  const expected = payload.dimensions_xyz.reduce((total, value) => total * value, 1) * payload.components.length * itemSize;
  if (payload.byte_length !== expected || expected > MAX_SCALAR_BYTES) {
    throw new Error("Raw-volume byte length violates the bounded payload contract.");
  }
  const minimumAggregate = Math.ceil(expected * (3 + 4 / 3));
  if (
    !Number.isInteger(payload.sampling.aggregate_budget_bytes) ||
    !Number.isInteger(payload.sampling.estimated_aggregate_bytes) ||
    payload.sampling.aggregate_budget_bytes > MAX_AGGREGATE_BYTES ||
    payload.sampling.estimated_aggregate_bytes < minimumAggregate ||
    payload.sampling.estimated_aggregate_bytes > payload.sampling.aggregate_budget_bytes
  ) {
    throw new Error("Raw-volume aggregate memory accounting is invalid.");
  }
  if (!/^[0-9a-f]{64}$/.test(payload.data_sha256) || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data_base64)) {
    throw new Error("Raw-volume data identity or base64 encoding is invalid.");
  }
  const maximumBase64 = 4 * Math.ceil(expected / 3);
  if (payload.data_base64.length !== maximumBase64) {
    throw new Error("Raw-volume base64 length disagrees with its declared bytes.");
  }
  for (const component of payload.components) {
    if (
      !finiteVector(component.color_rgb, 3) ||
      component.color_rgb.some((value) => value < 0 || value > 1) ||
      !Number.isFinite(component.window.low) ||
      !Number.isFinite(component.window.high) ||
      component.window.high <= component.window.low ||
      !Number.isFinite(component.window.gamma) ||
      component.window.gamma < 0.1 ||
      component.window.gamma > 10 ||
      !Number.isFinite(component.opacity) ||
      component.opacity < 0 ||
      component.opacity > 1
    ) {
      throw new Error("A raw-volume channel transfer mapping is invalid.");
    }
  }
}

export function validateRawVolumeResponse(response: RawVolumeResponse): void {
  if (response.schema_version !== 1) throw new Error("Unsupported raw-volume response schema.");
  validateRawVolumePayload(response.context);
  if (response.context.role !== "whole-volume-context") {
    throw new Error("Raw-volume response requires a whole-volume context.");
  }
  if (!response.focus) return;
  validateRawVolumePayload(response.focus);
  if (
    response.context.sampling.estimated_aggregate_bytes +
      response.focus.sampling.estimated_aggregate_bytes >
    MAX_AGGREGATE_BYTES
  ) {
    throw new Error("Combined context and focus exceed the raw-volume memory budget.");
  }
  if (
    response.context.role !== "whole-volume-context" ||
    response.focus.role === "whole-volume-context" ||
    response.focus.source_id !== response.context.source_id ||
    response.focus.source_sha256 !== response.context.source_sha256 ||
    response.focus.t !== response.context.t ||
    response.focus.frame !== response.context.frame ||
    response.focus.unit !== response.context.unit ||
    response.focus.source_dimensions_xyz.some(
      (value, axis) => value !== response.context.source_dimensions_xyz[axis],
    ) ||
    response.focus.direction_3x3.some(
      (value, index) => Math.abs(value - response.context.direction_3x3[index]) > 1e-5,
    ) ||
    response.focus.components.map((value) => value.channel_index).join(",") !==
      response.context.components.map((value) => value.channel_index).join(",")
  ) {
    throw new Error("Raw-volume focus is not bound to its whole-volume context.");
  }
  const contextFirst = response.context.sampling.level_zero_indices_xyz.map((indices) => indices[0]);
  const contextLast = response.context.sampling.level_zero_indices_xyz.map((indices) => indices.at(-1)!);
  const levelZeroSpacing = response.context.spacing_xyz.map((spacing, axis) => {
    const sourceSpan = contextLast[axis] - contextFirst[axis];
    return sourceSpan > 0
      ? spacing * (response.context.dimensions_xyz[axis] - 1) / sourceSpan
      : spacing;
  });
  const samplingTolerance = Math.max(1e-6, Math.hypot(...levelZeroSpacing) * 0.500001);
  const expectedWorld = (sourceIndex: number[]) => [0, 1, 2].map((row) =>
    response.context.origin_xyz[row] + [0, 1, 2].reduce((sum, axis) =>
      sum + response.context.direction_3x3[axis * 3 + row] * levelZeroSpacing[axis] *
        (sourceIndex[axis] - contextFirst[axis]), 0,
    )) as [number, number, number];
  for (let corner = 0; corner < 8; corner += 1) {
    const focusDisplayIndex = [0, 1, 2].map((axis) =>
      corner & (1 << axis) ? response.focus!.dimensions_xyz[axis] - 1 : 0,
    ) as [number, number, number];
    const focusSourceIndex = [0, 1, 2].map((axis) =>
      response.focus!.sampling.level_zero_indices_xyz[axis][focusDisplayIndex[axis]],
    );
    const actual = worldAtDisplayIndex(response.focus, focusDisplayIndex);
    const expected = expectedWorld(focusSourceIndex);
    if (Math.hypot(...actual.map((value, axis) => value - expected[axis])) > samplingTolerance) {
      throw new Error("Raw-volume focus geometry disagrees with its context source coordinates.");
    }
  }
}

function decodeScalars(payload: RawVolumePayload): { bytes: Uint8Array; values: TypedScalars } {
  validateRawVolumePayload(payload);
  const binary = atob(payload.data_base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const [, construct] = TYPE_INFO[payload.scalar_type];
  return { bytes, values: construct(bytes.buffer) };
}

function histogramBinding(payload: RawVolumePayload): string {
  return [
    payload.source_id,
    payload.source_sha256,
    payload.data_sha256,
    payload.role,
    payload.level,
    payload.dimensions_xyz.join("x"),
  ].join(":");
}

function asHistogramRecord(record: RawVolumeHistogramRecord): HistogramRecord {
  return {
    component: record.channel_index,
    label: record.label,
    units: record.units,
    dtype: record.dtype,
    sample_count: record.sample_count,
    min: record.min,
    max: record.max,
    bin_range: record.bin_range,
    counts: record.counts,
    percentile_1: record.percentile_1,
    percentile_99: record.percentile_99,
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function transferFunctions(component: TransferState, colorMode: "constant" | "intensity" | "volume") {
  const color = vtkColorTransferFunction.newInstance();
  const opacity = vtkPiecewiseFunction.newInstance();
  const { low, high, gamma } = component.window;
  const isGrayscale = component.color_rgb.every((val) => Math.abs(val - component.color_rgb[0]) < 0.05);

  if (colorMode === "volume") {
    const baseColor = component.color_rgb;
    if (isGrayscale) {
      color.addRGBPoint(low, 0.04, 0.04, 0.04);
      for (let step = 1; step <= 4; step += 1) {
        const output = step / 4;
        const sourceFraction = output ** gamma;
        const value = low + sourceFraction * (high - low);
        const level = 0.04 + 0.96 * output;
        color.addRGBPoint(value, level, level, level);
      }
    } else {
      color.addRGBPoint(low, baseColor[0] * 0.15, baseColor[1] * 0.15, baseColor[2] * 0.15);
      for (let step = 1; step <= 4; step += 1) {
        const output = step / 4;
        const sourceFraction = output ** gamma;
        const value = low + sourceFraction * (high - low);
        const intensity = 0.25 + 0.75 * output;
        color.addRGBPoint(value, baseColor[0] * intensity, baseColor[1] * intensity, baseColor[2] * intensity);
      }
    }

    opacity.addPoint(low, 0);
    for (let step = 1; step <= 4; step += 1) {
      const output = step / 4;
      const sourceFraction = output ** gamma;
      const value = low + sourceFraction * (high - low);
      const stepOpacity = (output ** 1.8) * component.opacity * 0.60;
      opacity.addPoint(value, stepOpacity);
    }
  } else {
    color.addRGBPoint(low, ...component.color_rgb.map((value) => colorMode === "constant" ? value : 0) as [number, number, number]);
    opacity.addPoint(low, 0);
    for (let step = 1; step <= 4; step += 1) {
      const output = step / 4;
      const sourceFraction = output ** gamma;
      const value = low + sourceFraction * (high - low);
      const colorLevel = colorMode === "constant" ? 1 : output;
      color.addRGBPoint(value, component.color_rgb[0] * colorLevel, component.color_rgb[1] * colorLevel, component.color_rgb[2] * colorLevel);
      opacity.addPoint(value, output * component.opacity);
    }
  }
  return { color, opacity };
}

function resolvedTransferPoints(component: TransferState, colorMode: "constant" | "intensity") {
  const { low, high, gamma } = component.window;
  return Array.from({ length: 5 }, (_, step) => {
    const output = step / 4;
    const scalar = step === 0 ? low : low + output ** gamma * (high - low);
    const colorLevel = colorMode === "constant" ? 1 : output;
    return {
      scalar,
      opacity: output * component.opacity,
      color_rgb: component.color_rgb.map((value) => value * colorLevel) as [number, number, number],
    };
  });
}

function nearestIndex(values: number[], target: number): number {
  let nearest = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (Math.abs(values[index] - target) < Math.abs(values[nearest] - target)) nearest = index;
  }
  return nearest;
}

export function worldAtDisplayIndex(payload: RawVolumePayload, index: [number, number, number]): [number, number, number] {
  return [0, 1, 2].map((row) => payload.origin_xyz[row] + [0, 1, 2].reduce(
    (value, column) => value + payload.direction_3x3[column * 3 + row] * payload.spacing_xyz[column] * index[column],
    0,
  )) as [number, number, number];
}

export function contextClippingPlane(payload: RawVolumePayload, axis: 0 | 1 | 2, percentage: number) {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)
    throw new Error("Clipping position must be a percentage from 0 to 100.");
  const index: [number, number, number] = [0, 0, 0];
  index[axis] = (payload.dimensions_xyz[axis] - 1) * percentage / 100;
  return {
    origin: worldAtDisplayIndex(payload, index),
    normal: [0, 1, 2].map((row) => payload.direction_3x3[axis * 3 + row]) as [number, number, number],
  };
}

function rgbHex(rgb: [number, number, number]): string {
  return `#${rgb.map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
}

function figurePayload(payload: RawVolumePayload): VolumeFigurePayloadRecord {
  return {
    role: payload.role,
    data_sha256: payload.data_sha256,
    t: payload.t,
    level: payload.level,
    dimensions_xyz: [...payload.dimensions_xyz],
    native_level_dimensions_xyz: [...payload.native_level_dimensions_xyz],
    source_dimensions_xyz: [...payload.source_dimensions_xyz],
    source_extent_xyzxyz: [...payload.source_extent_xyzxyz],
    origin_xyz: [...payload.origin_xyz],
    spacing_xyz: [...payload.spacing_xyz],
    direction_3x3: [...payload.direction_3x3],
    affine_4x4: payload.affine_4x4.map((row) => [...row]),
    unit: payload.unit,
    frame: payload.frame,
    scalar_type: payload.scalar_type,
    source_dtypes: [...payload.source_dtypes],
    component_indices: payload.components.map((component) => component.channel_index),
    encoding_basis: payload.encoding_basis,
    byte_length: payload.byte_length,
    sampling: {
      method: payload.sampling.method,
      source_indices_xyz: payload.sampling.source_indices_xyz.map((axis) => [...axis]) as [number[], number[], number[]],
      level_zero_indices_xyz: payload.sampling.level_zero_indices_xyz.map((axis) => [...axis]) as [number[], number[], number[]],
    },
  };
}

function figureRenderStateSignature(
  volume: RawVolumeResponse,
  mode: "volume" | "mpr",
  detailView: "context" | "focus",
  transfers: TransferState[],
  clipEnabled: boolean,
  clipAxis: 0 | 1 | 2,
  clipPosition: number,
  slices: [number, number, number],
  shadingEnabled?: boolean,
  renderMode?: VolumeRenderMode,
  quality?: number,
): string {
  return JSON.stringify({
    context: volume.context.data_sha256,
    focus: volume.focus?.data_sha256 ?? null,
    mode,
    detailView,
    transfers,
    clipping: clipEnabled ? [clipAxis, clipPosition] : null,
    slices,
    shading: shadingEnabled ?? false,
    renderMode: renderMode ?? "blend",
    quality: quality ?? 50,
  });
}

function hexRgb(value: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/iu.test(value)) return null;
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function TransferNumber({ label, value, minimum, maximum, onCommit }: {
  label: string; value: number; minimum?: number; maximum?: number; onCommit: (value: number) => boolean;
}) {
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(String(value)); setInvalid(false); }, [value]);
  return (
    <input
      aria-label={label}
      value={text}
      className={invalid ? "invalid" : undefined}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = Number(event.target.value);
        setInvalid(
          !Number.isFinite(parsed) ||
          (minimum !== undefined && parsed < minimum) ||
          (maximum !== undefined && parsed > maximum),
        );
      }}
      onBlur={() => {
        const parsed = Number(text);
        if (Number.isFinite(parsed) && (minimum === undefined || parsed >= minimum) &&
            (maximum === undefined || parsed <= maximum) && onCommit(parsed)) {
          setInvalid(false);
        } else {
          setText(String(value)); setInvalid(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") { setText(String(value)); setInvalid(false); }
      }}
    />
  );
}

export function RawVolumeViewport({
  volume,
  loading = false,
  error = null,
  onRequestRefinement,
  onExportFigure,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<any>(null);

  const syncContainer = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    const scene = sceneRef.current;
    if (node && scene?.generic) {
      if (scene.generic.getContainer() !== node) {
        scene.generic.setContainer(node);
        if (scene.resize) {
          scene.resize.disconnect();
          scene.resize.observe(node);
        }
      }
      try {
        scene.generic.resize();
        scene.renderWindow?.render();
      } catch {
        /* best-effort */
      }
    }
  }, []);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [contextState, setContextState] = useState<"ready" | "lost" | "restoring">("ready");
  const [mode, setMode] = useState<"volume" | "mpr">("volume");
  const [renderMode, setRenderMode] = useState<VolumeRenderMode>("blend");
  const [quality, setQuality] = useState(50);
  const [layout, setLayout] = useState<"four" | "single">("four");
  const [expandedPane, setExpandedPane] = useState<string | null>(null);
  const [colSplit, setColSplit] = useState(50);
  const [rowSplit, setRowSplit] = useState(50);
  const [paneOrder, setPaneOrder] = useState<string[]>(["axial", "coronal", "sagittal", "volume"]);
  const panesContainerRef = useRef<HTMLDivElement>(null);
  const splitDrag = useRef<{
    type: "col" | "row" | "both";
    startX: number;
    startY: number;
    startCol: number;
    startRow: number;
    rect: DOMRect;
  } | null>(null);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [verifiedPlanes, setVerifiedPlanes] = useState<{ volume: RawVolumeResponse; values: MprScalars[] } | null>(null);
  const [clipEnabled, setClipEnabled] = useState(false);
  const [clipAxis, setClipAxis] = useState<0 | 1 | 2>(2);
  const [clipPosition, setClipPosition] = useState(50);
  const [slices, setSlices] = useState<[number, number, number]>([0, 0, 0]);
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  const [detailView, setDetailView] = useState<"context" | "focus">("context");
  const [detailSpan, setDetailSpan] = useState<32 | 64 | 96>(96);
  const [sceneRevision, setSceneRevision] = useState(0);
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [exportError, setExportError] = useState("");
  const previousContextRef = useRef<RawVolumePayload | null>(null);
  const initialCameraRef = useRef<CameraSnapshot | null>(null);
  const lostCameraRef = useRef<CameraSnapshot | null>(null);
  const selectedFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!volume) return;
    const previous = previousContextRef.current;
    const sameBinding =
      previous?.source_id === volume.context.source_id &&
      previous.source_sha256 === volume.context.source_sha256 &&
      previous.t === volume.context.t &&
      previous.components.map((item) => item.channel_index).join(",") ===
        volume.context.components.map((item) => item.channel_index).join(",");
    setTransfers((current) =>
      volume.context.components.map((component) => {
        const retained = sameBinding
          ? current.find((item) => item.channel_index === component.channel_index)
          : undefined;
        return retained
          ? { ...component, window: retained.window, color_rgb: retained.color_rgb,
              opacity: retained.opacity, visible: retained.visible }
          : { ...component };
      }),
    );
    setSlices((current) => {
      if (!sameBinding || !previous) {
        return volume.context.dimensions_xyz.map((value) => Math.floor(value / 2)) as [number, number, number];
      }
      return current.map((oldIndex, axis) => {
        const sourceIndex = previous.sampling.level_zero_indices_xyz[axis][oldIndex];
        const candidates = volume.context.sampling.level_zero_indices_xyz[axis];
        let nearest = 0;
        for (let index = 1; index < candidates.length; index += 1) {
          if (Math.abs(candidates[index] - sourceIndex) < Math.abs(candidates[nearest] - sourceIndex)) nearest = index;
        }
        return nearest;
      }) as [number, number, number];
    });
    previousContextRef.current = volume.context;
  }, [volume]);

  useEffect(() => {
    if (!volume?.context.refinement?.available || volume.focus || !onRequestRefinement) return;
    // Do not replace the coarse context until its verified bytes have been
    // bound to VTK. This preserves a genuinely visible progressive first pass
    // instead of starting refinement while the renderer is still decoding it.
    if (sceneRef.current?.imageRecords?.[0]?.payload !== volume.context) return;
    const current = Math.max(...volume.context.dimensions_xyz);
    const maximum = volume.context.refinement.maximum_target_long_axis;
    if (current >= maximum) return;
    const timer = window.setTimeout(() => {
      onRequestRefinement({ target_long_axis: Math.min(maximum, Math.max(128, current * 2)) });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [onRequestRefinement, sceneRevision, volume]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let generic: any = null;
    let renderer: any = null;
    let canvas: HTMLCanvasElement | null = null;
    let resize: ResizeObserver | null = null;
    let resizeScheduled = false;
    const onLost = (event: Event) => {
      event.preventDefault();
      const scene = sceneRef.current;
      if (scene) scene.stateEpoch += 1;
      const camera = scene?.renderer.getActiveCamera?.();
      if (camera && scene.binding) {
        lostCameraRef.current = {
          binding: scene.binding,
          position: [...camera.getPosition()],
          focalPoint: [...camera.getFocalPoint()],
          viewUp: [...camera.getViewUp()],
          parallelScale: camera.getParallelScale?.(),
        };
      }
      setContextState("lost");
    };
    const onRestored = () => {
      if (sceneRef.current) sceneRef.current.stateEpoch += 1;
      setContextState("restoring");
      // WebGL resources owned by vtk.js are invalid after a genuine device
      // context loss. Recreate the renderer and rebind the already verified
      // payload instead of treating a successful render() call as recovery.
      window.requestAnimationFrame(() => setRendererGeneration((value) => value + 1));
    };
    try {
      generic = vtkGenericRenderWindow.newInstance({ background: [0.082, 0.082, 0.082], listenWindowResize: false });
      generic.setContainer(container);
      generic.resize();
      renderer = generic.getRenderer();
      const renderWindow = generic.getRenderWindow();
      const interactor = renderWindow.getInteractor();
      interactor.setDesiredUpdateRate(45);
      const interactorStyle = vtkInteractorStyleManipulator.newInstance();
      const mouseManipulators = [
        vtkMouseCameraTrackballRotateManipulator.newInstance({ button: 1 }),
        vtkMouseCameraTrackballPanManipulator.newInstance({ button: 3 }),
        vtkMouseCameraTrackballPanManipulator.newInstance({ button: 1, shift: true }),
        vtkMouseCameraTrackballZoomManipulator.newInstance({ dragEnabled: false, scrollEnabled: true }),
        vtkMouseCameraTrackballRotateManipulator.newInstance({ button: 2 }),
        vtkMouseCameraTrackballRotateManipulator.newInstance({ button: 1, alt: true }),
        vtkMouseCameraTrackballPanManipulator.newInstance({ button: 2, shift: true }),
        vtkMouseCameraTrackballZoomManipulator.newInstance({ button: 1, control: true }),
        vtkMouseCameraTrackballZoomManipulator.newInstance({ button: 3, control: true }),
      ];
      mouseManipulators.forEach((manipulator) => interactorStyle.addMouseManipulator(manipulator));
      interactor.setInteractorStyle(interactorStyle);
      const apiWindow: any = generic.getApiSpecificRenderWindow();
      canvas = apiWindow.getCanvas?.() as HTMLCanvasElement | null;
      if (!canvas) throw new Error("The graphics device did not provide a volume canvas.");
      canvas.addEventListener("webglcontextlost", onLost);
      canvas.addEventListener("webglcontextrestored", onRestored);
      resize = new ResizeObserver(() => {
        if (resizeScheduled) return;
        resizeScheduled = true;
        window.requestAnimationFrame(() => {
          resizeScheduled = false;
          if (sceneRef.current?.generic !== generic) return;
          try {
            generic.resize();
            sceneRef.current?.renderWindow?.render();
          } catch (caught) {
            setRenderError(caught instanceof Error ? caught.message : "Could not resize the volume renderer.");
          }
        });
      });
      resize.observe(container);
      const axesActor = vtkAxesActor.newInstance();
      const orientationWidget = vtkOrientationMarkerWidget.newInstance({
        actor: axesActor,
        interactor,
        parentRenderer: renderer,
        viewportCorner: Corners.BOTTOM_LEFT,
        viewportSize: 0.13,
        minPixelSize: 64,
        maxPixelSize: 120,
      });
      orientationWidget.setEnabled(true);
      // vtk.js sets its enabled flag after the first internal viewport update.
      // Update once more so a constructor-provided corner/size is applied even
      // when the canvas does not resize after widget creation.
      orientationWidget.updateViewport();
      sceneRef.current = { generic, renderer, renderWindow, apiWindow, canvas, imageRecords: [], sliceRecords: [],
        transferObjects: [], clippingPlanes: [], binding: null, initialCamera: null,
        contextHistogram: null, stateEpoch: 0, renderStateSignature: null,
        axesActor, orientationWidget, interactorStyle, mouseManipulators, resize };
    } catch (caught) {
      setRenderError(caught instanceof Error ? caught.message : "Could not initialize the volume renderer.");
      try { generic?.delete(); } catch { /* the partially initialized renderer is already unusable */ }
    }
    return () => {
      resize?.disconnect();
      canvas?.removeEventListener("webglcontextlost", onLost);
      canvas?.removeEventListener("webglcontextrestored", onRestored);
      const scene = sceneRef.current;
      try { scene?.orientationWidget.setEnabled(false); scene?.orientationWidget.delete(); scene?.axesActor.delete(); }
      catch { /* release is best-effort after a device failure */ }
      try {
        scene?.interactorStyle.removeAllMouseManipulators();
        scene?.mouseManipulators.forEach((item: any) => item.delete());
        scene?.interactorStyle.delete();
      } catch { /* release is best-effort after a device failure */ }
      scene?.clippingPlanes.forEach((item: any) => item.delete());
      scene?.transferObjects.forEach((item: any) => item.delete());
      scene?.sliceRecords.forEach((record: any) => {
        renderer?.removeActor(record.actor); record.actor.delete(); record.mapper.delete();
      });
      scene?.imageRecords.forEach((record: any) => {
        renderer?.removeVolume(record.actor); record.actor.delete(); record.mapper.delete();
        record.image.getPointData().getScalars()?.delete(); record.image.delete();
      });
      sceneRef.current = null;
      try { generic?.delete(); } catch { /* release is best-effort after a device failure */ }
    };
  }, [rendererGeneration]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !volume) return;
    let cancelled = false;
    setRenderError(null);
    void (async () => {
      try {
        validateRawVolumeResponse(volume);
        const payloads = [volume.context, ...(volume.focus ? [volume.focus] : [])];
        const decoded = payloads.map(decodeScalars);
        const digests = await Promise.all(decoded.map((item) => sha256(item.bytes)));
        if (digests.some((digest, index) => digest !== payloads[index].data_sha256)) {
          throw new Error("Raw-volume bytes failed their SHA-256 integrity check.");
        }
        if (cancelled || sceneRef.current !== scene) return;
        setVerifiedPlanes({ volume, values: decoded.map((item) => item.values) });
        const contextHistogramKey = histogramBinding(volume.context);
        const contextHistogram = scene.contextHistogram?.binding === contextHistogramKey
          ? scene.contextHistogram.records
          : buildRawVolumeHistograms(volume.context, decoded[0].values);
        const nextImageRecords = payloads.map((payload, payloadIndex) => {
          const image = vtkImageData.newInstance();
          image.setDimensions(...payload.dimensions_xyz);
          image.setOrigin(payload.origin_xyz);
          image.setSpacing(payload.spacing_xyz);
          image.setDirection(payload.direction_3x3);
          image.getPointData().setScalars(
            vtkDataArray.newInstance({
              name: `${payload.role}-scalars`,
              numberOfComponents: payload.components.length,
              values: decoded[payloadIndex].values,
            }),
          );
          const mapper = vtkVolumeMapper.newInstance({ autoAdjustSampleDistances: true });
          mapper.setInputData(image);
          // Start moving Retina views at half resolution in each dimension;
          // VTK adapts during interaction and restores full resolution at rest.
          mapper.setInitialInteractionScale(4);
          mapper.setInteractionSampleDistanceFactor(2);
          const actor = vtkVolume.newInstance();
          actor.setMapper(mapper);
          actor.setVisibility(false);
          actor.getProperty().setIndependentComponents(true);
          actor.getProperty().setInterpolationTypeToLinear();
          actor.getProperty().setShade(false);
          return { payload, image, mapper, actor };
        });
        const nextSliceRecords = nextImageRecords.flatMap((imageRecord, payloadIndex) =>
          ([SlicingMode.I, SlicingMode.J, SlicingMode.K] as const).map((slicingMode, axis) => {
            const mapper = vtkImageMapper.newInstance();
            mapper.setInputData(imageRecord.image);
            mapper.setSlicingMode(slicingMode);
            mapper.setSlice(Math.floor(imageRecord.payload.dimensions_xyz[axis] / 2));
            const actor = vtkImageSlice.newInstance();
            actor.setMapper(mapper);
            actor.getProperty().setIndependentComponents(true);
            actor.getProperty().setInterpolationTypeToLinear();
            actor.setVisibility(false);
            return { mapper, actor, payloadIndex, axis };
          }),
        );
        const nextBinding = `${volume.context.source_id}:${volume.context.source_sha256}:${volume.context.t}`;
        const resetCamera = scene.binding !== nextBinding;
        // VTK computes camera bounds from visible props. Make the whole-volume
        // context visible before the first fit; the render-state effect below
        // then applies the selected Volume/MPR and Whole/Focus representation.
        if (resetCamera) nextImageRecords[0].actor.setVisibility(true);
        scene.axesActor.setUserMatrix([
          volume.context.direction_3x3[0], volume.context.direction_3x3[1], volume.context.direction_3x3[2], 0,
          volume.context.direction_3x3[3], volume.context.direction_3x3[4], volume.context.direction_3x3[5], 0,
          volume.context.direction_3x3[6], volume.context.direction_3x3[7], volume.context.direction_3x3[8], 0,
          0, 0, 0, 1,
        ]);
        scene.orientationWidget.updateMarkerOrientation();
        nextImageRecords.forEach((record) => scene.renderer.addVolume(record.actor));
        nextSliceRecords.forEach((record) => scene.renderer.addActor(record.actor));
        const oldImages = scene.imageRecords;
        const oldSlices = scene.sliceRecords;
        scene.imageRecords = nextImageRecords;
        scene.sliceRecords = nextSliceRecords;
        scene.binding = nextBinding;
        scene.contextHistogram = { binding: contextHistogramKey, records: contextHistogram };
        oldSlices.forEach((record: any) => {
          scene.renderer.removeActor(record.actor);
          record.actor.delete();
          record.mapper.delete();
        });
        oldImages.forEach((record: any) => {
          scene.renderer.removeVolume(record.actor);
          record.actor.delete();
          record.mapper.delete();
          record.image.getPointData().getScalars()?.delete();
          record.image.delete();
        });
        if (resetCamera) {
          scene.renderer.resetCamera();
          const camera = scene.renderer.getActiveCamera();
          const fittedCamera: CameraSnapshot = {
            binding: nextBinding,
            position: [...camera.getPosition()],
            focalPoint: [...camera.getFocalPoint()],
            viewUp: [...camera.getViewUp()],
            parallelScale: camera.getParallelScale?.(),
          };
          if (initialCameraRef.current?.binding !== nextBinding) initialCameraRef.current = fittedCamera;
          scene.initialCamera = initialCameraRef.current;
          const lostCamera = lostCameraRef.current;
          if (lostCamera?.binding === nextBinding) {
            camera.setPosition(...lostCamera.position);
            camera.setFocalPoint(...lostCamera.focalPoint);
            camera.setViewUp(...lostCamera.viewUp);
            if (Number.isFinite(lostCamera.parallelScale)) camera.setParallelScale?.(lostCamera.parallelScale);
            camera.orthogonalizeViewUp?.();
          }
          // A snapshot belongs to exactly one recovery attempt. Keeping an
          // unmatched pose could apply stale camera state if that source is
          // selected again later in the same mounted workbench.
          lostCameraRef.current = null;
        }
        setSceneRevision((value) => value + 1);
      } catch (caught) {
        if (!cancelled) setRenderError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => { cancelled = true; };
  }, [rendererGeneration, volume]);

  useEffect(() => {
    if (volume) return;
    setTransfers([]); setDetailView("context"); setVerifiedPlanes(null);
    const scene = sceneRef.current;
    if (!scene) return;
    scene.imageRecords.forEach((record: any) => record.actor.setVisibility(false));
    scene.sliceRecords.forEach((record: any) => record.actor.setVisibility(false));
    try { scene.renderWindow.render(); }
    catch (caught) { setRenderError(caught instanceof Error ? caught.message : "Could not clear the prior volume."); }
  }, [volume]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !volume || transfers.length === 0) return;
    const activePayloadIndex = detailView === "focus" && volume.focus ? 1 : 0;
    const sourceCrosshair = slices.map((index, axis) =>
      volume.context.sampling.level_zero_indices_xyz[axis][index]) as [number, number, number];
    scene.transferObjects.forEach((item: any) => item.delete());
    scene.transferObjects = [];
    scene.clippingPlanes.forEach((item: any) => item.delete());
    scene.clippingPlanes = [];
    const activeModeDetails = RENDER_MODE_DETAILS[renderMode] ?? RENDER_MODE_DETAILS.blend;
    const qualityFactor = qualityToSamplingFactor(quality);
    for (const [recordIndex, record] of scene.imageRecords.entries()) {
      record.actor.setVisibility(mode === "volume" && recordIndex === activePayloadIndex);
      if (typeof record.mapper.setBlendMode === "function") {
        record.mapper.setBlendMode(activeModeDetails.blendMode);
      }
      if (typeof record.mapper.setSampleDistance === "function") {
        const minSpacing = Math.min(...record.payload.spacing_xyz);
        const nominalDistance = Math.max(0.01, minSpacing * qualityFactor);
        record.mapper.setSampleDistance(nominalDistance);
        const maxRayLength = Math.hypot(...record.payload.dimensions_xyz.map(
          (length: number, axis: number) => (length - 1) * record.payload.spacing_xyz[axis],
        ));
        if (typeof record.mapper.setMaximumSamplesPerRay === "function") {
          record.mapper.setMaximumSamplesPerRay(Math.max(1000, Math.ceil(maxRayLength / nominalDistance) + 200));
        }
      }
      const property = record.actor.getProperty();
      if (typeof property.setShade === "function") {
        property.setShade(activeModeDetails.shade);
        property.setAmbient(0.22);
        property.setDiffuse(0.68);
        property.setSpecular(0.25);
        property.setSpecularPower(20.0);
      }
      transfers.forEach((component, index) => {
        // Composite volume color carries channel identity. Scalar intensity is
        // encoded by opacity, with optional explicitly recorded Phong lighting.
        const { color, opacity } = transferFunctions(component, "constant");
        scene.transferObjects.push(color, opacity);
        property.setRGBTransferFunction(index, color);
        property.setScalarOpacity(index, opacity);
        property.setComponentWeight(index, component.visible ? 1 : 0);
        if (typeof property.setUseGradientOpacity === "function") {
          property.setUseGradientOpacity(index, false);
        }
        const physicalDiagonal = Math.hypot(...record.payload.dimensions_xyz.map(
          (length: number, axis: number) => (length - 1) * record.payload.spacing_xyz[axis],
        ));
        property.setScalarOpacityUnitDistance(
          index,
          physicalDiagonal / Math.max(...record.payload.dimensions_xyz),
        );
      });
    }
    scene.sliceRecords.forEach((record: any) => {
      record.actor.setVisibility(mode === "mpr" && record.payloadIndex === activePayloadIndex);
      const payload = scene.imageRecords[record.payloadIndex].payload as RawVolumePayload;
      record.mapper.setSlice(nearestIndex(payload.sampling.level_zero_indices_xyz[record.axis], sourceCrosshair[record.axis]));
      const property = record.actor.getProperty();
      transfers.forEach((component, index) => {
        const { color, opacity } = transferFunctions(component, "intensity");
        scene.transferObjects.push(color, opacity);
        property.setRGBTransferFunction(index, color);
        property.setPiecewiseFunction(index, opacity);
        property.setComponentWeight(index, component.visible ? component.opacity : 0);
      });
    });
    scene.imageRecords.forEach((record: any) => record.mapper.removeAllClippingPlanes());
    if (clipEnabled) {
      const { origin, normal } = contextClippingPlane(volume.context, clipAxis, clipPosition);
      const plane = vtkPlane.newInstance({ origin, normal });
      scene.clippingPlanes.push(plane);
      scene.imageRecords.forEach((record: any) => record.mapper.addClippingPlane(plane));
    }
    try {
      if (containerRef.current && scene.generic && scene.generic.getContainer() !== containerRef.current) {
        scene.generic.setContainer(containerRef.current);
        if (scene.resize) {
          scene.resize.disconnect();
          scene.resize.observe(containerRef.current);
        }
        scene.generic.resize();
      }
      scene.renderer.resetCameraClippingRange?.();
      scene.renderWindow.render();
      scene.stateEpoch += 1;
      scene.renderStateSignature = figureRenderStateSignature(
        volume, mode, detailView, transfers, clipEnabled, clipAxis, clipPosition, slices,
        activeModeDetails.shade, renderMode, quality,
      );
      setContextState("ready");
    }
    catch (caught) { setRenderError(caught instanceof Error ? caught.message : "Could not render the volume."); }
  }, [clipAxis, clipEnabled, clipPosition, detailView, mode, quality, renderMode, sceneRevision, slices, transfers, volume]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (containerRef.current && scene.generic && scene.generic.getContainer() !== containerRef.current) {
      scene.generic.setContainer(containerRef.current);
      if (scene.resize) {
        scene.resize.disconnect();
        scene.resize.observe(containerRef.current);
      }
    }
    const frame = window.requestAnimationFrame(() => {
      try {
        scene.generic.resize();
        scene.renderWindow.render();
      } catch { /* best-effort */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layout, expandedPane, colSplit, rowSplit, paneOrder]);

  const caption = useMemo(() => {
    if (!volume) return null;
    const payload = volume.context;
    return `${payload.native_level_dimensions_xyz.join(" × ")} source voxels · ${payload.dimensions_xyz.join(" × ")} display · ${payload.unit} · ${payload.frame}`;
  }, [volume]);

  const activePayload = detailView === "focus" && volume?.focus ? volume.focus : volume?.context ?? null;
  const crosshair = useMemo(() => {
    if (!volume) return null;
    const source = slices.map((index, axis) =>
      volume.context.sampling.level_zero_indices_xyz[axis][index]) as [number, number, number];
    return { source, world: worldAtDisplayIndex(volume.context, slices) };
  }, [slices, volume]);
  const focusContainsCrosshair = Boolean(volume?.focus && crosshair && crosshair.source.every(
    (value, axis) => value >= volume.focus!.source_extent_xyzxyz[axis * 2] &&
      value <= volume.focus!.source_extent_xyzxyz[axis * 2 + 1],
  ));
  useEffect(() => {
    const focus = volume?.focus;
    if (!focus) {
      selectedFocusRef.current = null;
      setDetailView("context");
      return;
    }
    // Wait until this exact response has passed schema and byte-digest checks.
    // By then the context-preserving slice mapping above has also settled.
    if (verifiedPlanes?.volume !== volume) return;
    const binding = `${focus.source_id}:${focus.source_sha256}:${focus.data_sha256}:${focus.source_extent_xyzxyz.join(",")}`;
    if (selectedFocusRef.current !== binding) {
      selectedFocusRef.current = binding;
      setDetailView(focusContainsCrosshair ? "focus" : "context");
    } else if (!focusContainsCrosshair) {
      // Keep the user's source location and fall back to the whole context.
      setDetailView("context");
    }
  }, [focusContainsCrosshair, verifiedPlanes, volume]);

  const resetCamera = () => {
    const scene = sceneRef.current;
    if (!scene) return;
    try {
      const camera = scene.renderer.getActiveCamera();
      const initial = scene.initialCamera;
      if (initial && initial.binding === scene.binding) {
        camera.setPosition(...initial.position); camera.setFocalPoint(...initial.focalPoint);
        camera.setViewUp(...initial.viewUp);
        if (Number.isFinite(initial.parallelScale)) camera.setParallelScale?.(initial.parallelScale);
      }
      // The stored pose was captured immediately after the initial bounds fit.
      // Re-fitting here changes the restored focal distance/scale slightly and
      // makes R drift from the source-bound initial view.
      scene.renderer.resetCameraClippingRange?.();
      scene.orientationWidget.updateMarkerOrientation(); scene.renderWindow.render();
      scene.stateEpoch += 1;
    }
    catch (caught) { setRenderError(caught instanceof Error ? caught.message : "Could not reset the volume camera."); }
  };

  const moveSlice = (axis: 0 | 1 | 2, delta: number) => {
    if (!volume) return;
    if (sceneRef.current) sceneRef.current.stateEpoch += 1;
    setSlices((current) => current.map((value, index) => index === axis
      ? Math.max(0, Math.min(volume.context.dimensions_xyz[axis] - 1, value + delta)) : value) as [number, number, number]);
  };

  const onStageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLowerCase();
    if (key === "r") { event.preventDefault(); resetCamera(); return; }
    if (mode === "mpr") {
      const action = event.key === "ArrowLeft" ? [0, -1] : event.key === "ArrowRight" ? [0, 1]
        : event.key === "ArrowUp" ? [1, 1] : event.key === "ArrowDown" ? [1, -1]
          : event.key === "PageUp" ? [2, 1] : event.key === "PageDown" ? [2, -1] : null;
      if (action) { event.preventDefault(); moveSlice(action[0] as 0 | 1 | 2, action[1]); }
      return;
    }
    const scene = sceneRef.current;
    const camera = scene?.renderer.getActiveCamera?.();
    if (!camera) return;
    try {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight")
        camera.azimuth(event.key === "ArrowLeft" ? -5 : 5);
      else if (event.key === "ArrowUp" || event.key === "ArrowDown")
        camera.elevation(event.key === "ArrowUp" ? 5 : -5);
      else if (["+", "=", "-", "_"].includes(event.key))
        camera.dolly(["+", "="].includes(event.key) ? 1.1 : 0.9);
      else return;
      event.preventDefault(); camera.orthogonalizeViewUp?.();
      scene.renderer.resetCameraClippingRange?.(); scene.orientationWidget.updateMarkerOrientation();
      scene.renderWindow.render();
      scene.stateEpoch += 1;
    } catch (caught) { setRenderError(caught instanceof Error ? caught.message : "Could not move the volume camera."); }
  };

  const requestFocus = () => {
    if (!volume || !onRequestRefinement) return;
    if (sceneRef.current) sceneRef.current.stateEpoch += 1;
    const context = volume.context;
    const source = context.sampling.level_zero_indices_xyz;
    const centre = slices.map((value, axis) => source[axis][value]) as [number, number, number];
    const full = context.source_dimensions_xyz;
    const bounds = full.map((length, axis) => {
      const span = Math.min(detailSpan, length);
      const start = Math.max(0, Math.min(length - span, centre[axis] - Math.floor(span / 2)));
      return [start, start + span - 1] as const;
    });
    const extent: [number, number, number, number, number, number] = [
      bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1], bounds[2][0], bounds[2][1],
    ];
    onRequestRefinement({ target_long_axis: 256, focus_region_xyzxyz: extent });
  };

  const exportFigure = async () => {
    const scene = sceneRef.current;
    if (!onExportFigure || !volume || !scene || exporting) return;
    setExporting(true); setExportStatus(""); setExportError("");
    try {
      validateRawVolumeResponse(volume);
      const activeModeDetails = RENDER_MODE_DETAILS[renderMode] ?? RENDER_MODE_DETAILS.blend;
      const expectedBinding = `${volume.context.source_id}:${volume.context.source_sha256}:${volume.context.t}`;
      const expectedRenderState = figureRenderStateSignature(
        volume, mode, detailView, transfers, clipEnabled, clipAxis, clipPosition, slices,
        activeModeDetails.shade, renderMode, quality,
      );
      if (contextState !== "ready" || scene.binding !== expectedBinding ||
          scene.renderStateSignature !== expectedRenderState ||
          scene.imageRecords[0]?.payload !== volume.context ||
          (volume.focus && scene.imageRecords[1]?.payload !== volume.focus))
        throw new Error("Wait for the current verified volume to finish rendering before export.");
      const canvas = scene.canvas as HTMLCanvasElement;
      const width = canvas.width;
      const height = canvas.height;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
          width > MAX_FIGURE_EDGE || height > MAX_FIGURE_EDGE || width * height > MAX_FIGURE_PIXELS)
        throw new Error("The current volume canvas exceeds the bounded figure export size.");
      const camera = scene.renderer.getActiveCamera?.();
      if (!camera) throw new Error("The current volume camera is unavailable.");
      const cameraBefore = {
        position: [...camera.getPosition()],
        focalPoint: [...camera.getFocalPoint()],
        viewUp: [...camera.getViewUp()],
        clippingRange: [...camera.getClippingRange()],
        viewAngle: camera.getViewAngle(),
        parallel: camera.getParallelProjection(),
        parallelScale: camera.getParallelScale(),
      };
      const stateEpoch = scene.stateEpoch;
      if ([cameraBefore.position, cameraBefore.focalPoint, cameraBefore.viewUp].some(
        (items) => items.length !== 3 || items.some((item) => !Number.isFinite(item)),
      ) || cameraBefore.clippingRange.length !== 2 || cameraBefore.clippingRange.some((item) => !Number.isFinite(item)) ||
          !Number.isFinite(cameraBefore.viewAngle) || !Number.isFinite(cameraBefore.parallelScale))
        throw new Error("The current volume camera cannot be recorded exactly.");
      const capture = scene.apiWindow.captureNextImage?.("image/png", {
        resetCamera: false,
        size: null,
        scale: 1,
      }) as Promise<string> | null | undefined;
      if (!capture) throw new Error("The graphics device cannot capture this volume figure.");
      scene.renderWindow.render();
      const dataUrl = await capture;
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,"))
        throw new Error("The graphics device did not return a PNG capture.");
      const cameraAfter = [
        [...camera.getPosition()], [...camera.getFocalPoint()], [...camera.getViewUp()],
        [...camera.getClippingRange()], camera.getViewAngle(), camera.getParallelProjection(), camera.getParallelScale(),
      ];
      if (JSON.stringify(cameraAfter) !== JSON.stringify([
        cameraBefore.position, cameraBefore.focalPoint, cameraBefore.viewUp,
        cameraBefore.clippingRange, cameraBefore.viewAngle, cameraBefore.parallel, cameraBefore.parallelScale,
      ]) || canvas.width !== width || canvas.height !== height || scene.binding !== expectedBinding ||
          scene.stateEpoch !== stateEpoch || scene.renderStateSignature !== expectedRenderState ||
          sceneRef.current !== scene || scene.imageRecords[0]?.payload !== volume.context ||
          (volume.focus && scene.imageRecords[1]?.payload !== volume.focus))
        throw new Error("The volume view changed during figure capture; try again.");
      const clipping = clipEnabled ? contextClippingPlane(volume.context, clipAxis, clipPosition) : null;
      const sourceIndices = slices.map((index, axis) =>
        volume.context.sampling.level_zero_indices_xyz[axis][index]) as [number, number, number];
      const activePayloadIndices = activePayload?.sampling.level_zero_indices_xyz.map((indices, axis) =>
        nearestIndex(indices, sourceIndices[axis])) as [number, number, number];
      const request: VolumeFigureExportRequest = {
        schema_version: "loci.volume-figure-request/v1",
        source_id: volume.context.source_id,
        source_sha256: volume.context.source_sha256,
        width_px: width,
        height_px: height,
        png_base64: dataUrl.slice("data:image/png;base64,".length),
        manifest: {
          schema_version: "loci.volume-figure/v1",
          figure: {
            kind: "screen-resolution-rendered-figure",
            format: "png",
            width_px: width,
            height_px: height,
            device_pixel_ratio: window.devicePixelRatio || 1,
            capture_scale: 1,
          },
          source: {
            source_id: volume.context.source_id,
            source_sha256: volume.context.source_sha256,
            t: volume.context.t,
          },
          payloads: {
            context: figurePayload(volume.context),
            focus: volume.focus ? figurePayload(volume.focus) : null,
          },
          representation: {
            mode,
            extent: detailView,
            interpolation: "linear",
            shading: mode === "volume" && activeModeDetails.shade,
            blend_mode: mode === "volume" ? renderMode : null,
            quality: mode === "volume" ? quality : null,
            lighting: mode === "volume" && activeModeDetails.shade
              ? { ambient: 0.22, diffuse: 0.68, specular: 0.25, specular_power: 20, gradient_opacity: false }
              : null,
            orientation_axes: true,
          },
          camera: {
            projection: cameraBefore.parallel ? "parallel" : "perspective",
            position_xyz: cameraBefore.position as [number, number, number],
            focal_point_xyz: cameraBefore.focalPoint as [number, number, number],
            view_up_xyz: cameraBefore.viewUp as [number, number, number],
            clipping_range: cameraBefore.clippingRange as [number, number],
            view_angle_degrees: cameraBefore.viewAngle,
            parallel_scale: cameraBefore.parallel ? cameraBefore.parallelScale : null,
          },
          transfers: transfers.map((transfer) => ({
            channel_index: transfer.channel_index,
            name: transfer.name,
            color_rgb: [...transfer.color_rgb],
            color_mode: mode === "volume" ? "constant" : "intensity",
            window: { ...transfer.window },
            opacity: transfer.opacity,
            visible: transfer.visible,
            source_opacity_points: transfer.opacity_points.map((point) => [...point]),
            resolved_points: resolvedTransferPoints(
              transfer,
              mode === "volume" ? "constant" : "intensity",
            ),
            opacity_unit_distance: mode === "volume" && activePayload
              ? Math.hypot(...activePayload.dimensions_xyz.map(
                (length, axis) => (length - 1) * activePayload.spacing_xyz[axis],
              )) / Math.max(...activePayload.dimensions_xyz)
              : null,
            provenance: { ...transfer.provenance },
          })),
          clipping: clipping ? {
            enabled: true,
            axis: (["x", "y", "z"] as const)[clipAxis],
            position_percent: clipPosition,
            plane_origin_xyz: clipping.origin,
            plane_normal_xyz: clipping.normal,
          } : { enabled: false },
          mpr: mode === "mpr" && crosshair ? {
            context_display_indices_xyz: [...slices],
            active_payload_indices_xyz: activePayloadIndices,
            source_indices_xyz: sourceIndices,
            world_xyz: [...crosshair.world],
          } : null,
          background: { rgb: [0.082, 0.082, 0.082] },
          software: {
            renderer: "vtk.js",
            renderer_version: "36.12.0",
            capture_method: "captureNextImage",
          },
          provenance: {
            artifact_semantics: "Rendered display RGB at native canvas resolution; not original-value scientific data.",
            screen_resolution_only: true,
            scale_bar_included: false,
            high_resolution_claim: false,
            biological_or_clinical_validation_claim: false,
            metadata_contains_source_pixel_data: false,
          },
        },
      };
      const receipt = await onExportFigure(request);
      if (receipt) setExportStatus(`Saved ${receipt.width} × ${receipt.height} · ${receipt.basename}`);
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : "Could not export this volume figure.");
    } finally {
      setExporting(false);
    }
  };

  const invalidateFigureCapture = () => {
    if (sceneRef.current) sceneRef.current.stateEpoch += 1;
  };

  const updateTransfer = (channelIndex: number, change: (value: TransferState) => TransferState) => {
    invalidateFigureCapture();
    setTransfers((current) => current.map((value) => value.channel_index === channelIndex ? change(value) : value));
  };

  const focusUsesNativeSteps = volume?.focus ? volume.focus.sampling.level_zero_indices_xyz.every((indices) =>
    indices.every((value, index) => index === 0 || value === indices[index - 1] + 1)) : false;
  const contextHistograms = useMemo(() => {
    if (!volume) return [];
    const histogram = sceneRef.current?.contextHistogram;
    return histogram?.binding === histogramBinding(volume.context)
      ? histogram.records as RawVolumeHistogramRecord[]
      : [];
  }, [sceneRevision, volume]);

  const slicePlanes = useMemo(() => activePayload ? mprPlanes(activePayload) : [], [activePayload]);
  const sliceValues = verifiedPlanes?.volume === volume ? verifiedPlanes?.values[detailView === "focus" && volume?.focus ? 1 : 0] : null;
  const showFour = layout === "four";
  const togglePane = (id: string) => { invalidateFigureCapture(); setExpandedPane((current) => current === id ? null : id); };
  const moveCrosshair = (world: Vec3) => {
    if (!volume) return;
    const index = worldToIndex(volume.context, world);
    invalidateFigureCapture();
    setSlices(index.map((value, axis) => Math.max(0, Math.min(volume.context.dimensions_xyz[axis] - 1, Math.round(value)))) as Vec3);
  };

  const swapWithNext = (paneId: string) => {
    invalidateFigureCapture();
    setPaneOrder((current) => {
      const index = current.indexOf(paneId);
      if (index === -1) return current;
      const nextIndex = (index + 1) % current.length;
      const next = [...current];
      const temp = next[index];
      next[index] = next[nextIndex];
      next[nextIndex] = temp;
      return next;
    });
  };

  const handleSplitPointerDown = (type: "col" | "row" | "both", event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const container = panesContainerRef.current?.getBoundingClientRect();
    if (!container) return;
    splitDrag.current = {
      type,
      startX: event.clientX,
      startY: event.clientY,
      startCol: colSplit,
      startRow: rowSplit,
      rect: container,
    };
    setIsDraggingSplit(true);
  };

  const handleSplitPointerMove = (event: React.PointerEvent) => {
    const d = splitDrag.current;
    if (!d) return;
    if (d.type === "col" || d.type === "both") {
      const pct = ((event.clientX - d.rect.left) / d.rect.width) * 100;
      setColSplit(Math.max(20, Math.min(80, Math.round(pct))));
    }
    if (d.type === "row" || d.type === "both") {
      const pct = ((event.clientY - d.rect.top) / d.rect.height) * 100;
      setRowSplit(Math.max(20, Math.min(80, Math.round(pct))));
    }
  };

  const handleSplitPointerUp = (event: React.PointerEvent) => {
    if (splitDrag.current) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      splitDrag.current = null;
      setIsDraggingSplit(false);
    }
  };

  return (
    <section className="raw-volume" aria-label="Raw whole-volume viewport"
      data-layout={showFour ? "four" : "single"}
      data-expanded-pane={expandedPane ?? "none"}
      data-source-id={volume?.context.source_id}
      data-source-sha256={volume?.context.source_sha256}
      data-context-dimensions={volume?.context.dimensions_xyz.join("x")}
      data-context-byte-length={volume?.context.byte_length}
      data-context-level={volume?.context.level}
      data-active-view={activePayload?.role}
      data-focus-extent={volume?.focus?.source_extent_xyzxyz.join(",")}
      data-focus-byte-length={volume?.focus?.byte_length}
      data-focus-native-steps={volume?.focus ? String(focusUsesNativeSteps) : undefined}
      data-transfer-ranges={transfers.map((component) => `${component.window.low}:${component.window.high}`).join(",")}
      data-transfer-range-basis={volume?.context.components.map((component) => component.provenance.range).join(",")}>
      <div className="raw-volume-toolbar">
        <div className="raw-volume-segment" role="group" aria-label="Volume layout">
          <button type="button" aria-pressed={showFour} onClick={() => { invalidateFigureCapture(); setLayout("four"); setExpandedPane(null); }}><Grid2X2 aria-hidden="true" />Four panes</button>
          <button type="button" aria-pressed={!showFour} onClick={() => { invalidateFigureCapture(); setLayout("single"); setExpandedPane(null); }}><Box aria-hidden="true" />3D view</button>
        </div>
        {volume?.focus ? <div className="raw-volume-segment" role="group" aria-label="Displayed volume extent">
          <button type="button" aria-pressed={detailView === "context"} onClick={() => { invalidateFigureCapture(); setDetailView("context"); }}>Whole</button>
          <button type="button" aria-pressed={detailView === "focus"} disabled={!focusContainsCrosshair}
            title={focusContainsCrosshair ? "Show detail around the current crosshair" : "Move the crosshair into this focus region, or request new detail"}
            onClick={() => { invalidateFigureCapture(); setDetailView("focus"); }}>Focus</button>
        </div> : null}
        <button type="button" onClick={resetCamera} title="Fit the active volume and restore its initial view">Reset camera</button>
        {mode === "volume" && (
          <>
            <label className="raw-volume-control" title="Volume rendering mode">
              <span>Mode</span>
              <select
                aria-label="3D rendering mode"
                value={renderMode}
                onChange={(event) => {
                  invalidateFigureCapture();
                  setRenderMode(event.target.value as VolumeRenderMode);
                }}
              >
                {Object.entries(RENDER_MODE_DETAILS).map(([key, details]) => (
                  <option key={key} value={key} title={details.title}>
                    {details.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="raw-volume-quality-control" title="Raycasting sample density: lower for faster rendering, higher for sharper sub-voxel detail without aliasing">
              <span>Quality</span>
              <input
                aria-label="3D rendering quality"
                type="range"
                min={10}
                max={100}
                step={5}
                value={quality}
                onChange={(event) => {
                  invalidateFigureCapture();
                  setQuality(Number(event.target.value));
                }}
              />
              <span className="raw-volume-quality-val">{quality}%</span>
            </label>
          </>
        )}
        {onExportFigure ? <button type="button" disabled={exporting || loading || !volume || contextState !== "ready" || Boolean(error || renderError)}
          onClick={() => void exportFigure()} title="Export the 3D pane with its exact display provenance; the separate slice panes are not included">
          {exporting ? "Exporting…" : "Export PNG…"}
        </button> : null}
        <label><input type="checkbox" checked={clipEnabled} onChange={(event) => { invalidateFigureCapture(); setClipEnabled(event.target.checked); }} />Clip</label>
        {clipEnabled ? (
          <><label>Axis<select aria-label="Clipping axis" value={clipAxis} onChange={(event) => { invalidateFigureCapture(); setClipAxis(Number(event.target.value) as 0 | 1 | 2); }}><option value={0}>X</option><option value={1}>Y</option><option value={2}>Z</option></select></label><label>Position<input aria-label="Clipping position" type="range" min={0} max={100} value={clipPosition} onChange={(event) => { invalidateFigureCapture(); setClipPosition(Number(event.target.value)); }} /></label></>
        ) : null}
        {volume?.context.refinement?.focus_supported && onRequestRefinement ? <>
          <label>Detail span<select aria-label="Detail span" value={detailSpan}
            onChange={(event) => setDetailSpan(Number(event.target.value) as 32 | 64 | 96)}>
            <option value={32}>32 voxels</option><option value={64}>64 voxels</option><option value={96}>96 voxels</option>
          </select></label>
          <button type="button" onClick={requestFocus}>Detail at crosshair</button>
        </> : null}
      </div>
      {exportError ? <p className="raw-volume-export-status raw-volume-export-error" role="alert">{exportError}</p> : null}
      {exportStatus ? <p className="raw-volume-export-status" role="status">{exportStatus}</p> : null}
      {(showFour || mode === "mpr") && volume ? (
        <div className="raw-volume-slices">
          {(["X", "Y", "Z"] as const).map((label, axis) => <label key={label}>{label}<input aria-label={`${label} slice`} type="range" min={0} max={volume.context.dimensions_xyz[axis] - 1} value={slices[axis]} onChange={(event) => { invalidateFigureCapture(); setSlices((current) => current.map((value, index) => index === axis ? Number(event.target.value) : value) as [number, number, number]); }} /><output aria-label={`${label} source index`}>{crosshair?.source[axis]}</output></label>)}
          {crosshair ? <span className="raw-volume-world">World {crosshair.world.map((value) => value.toFixed(3)).join(", ")} {volume.context.unit}</span> : null}
        </div>
      ) : null}
      <div
        ref={panesContainerRef}
        className={`raw-volume-panes ${showFour && !expandedPane ? "raw-volume-panes-four" : "raw-volume-panes-single"} ${isDraggingSplit ? "is-splitting" : ""}`}
        style={
          showFour && !expandedPane
            ? {
                gridTemplateColumns: `${colSplit}fr ${100 - colSplit}fr`,
                gridTemplateRows: `${rowSplit}fr ${100 - rowSplit}fr`,
                position: "relative",
              }
            : undefined
        }
      >
        {slicePlanes.map((plane) => (
          <div
            className="mpr-pane-slot"
            key={plane.id}
            hidden={Boolean(!showFour || (expandedPane && expandedPane !== plane.id))}
            style={{ order: paneOrder.indexOf(plane.id) >= 0 ? paneOrder.indexOf(plane.id) : 0 }}
          >
            {showFour && activePayload && sliceValues && crosshair ? (
              <MprSlicePane
                payload={activePayload}
                values={sliceValues}
                plane={plane}
                crosshair={crosshair.world}
                visible={!expandedPane || expandedPane === plane.id}
                transfers={transfers}
                expanded={expandedPane === plane.id}
                onExpand={() => togglePane(plane.id)}
                onCrosshair={moveCrosshair}
                onSwap={() => swapWithNext(plane.id)}
              />
            ) : null}
          </div>
        ))}
        <section
          key="volume"
          className="mpr-pane mpr-pane-volume"
          aria-label="3D view"
          hidden={Boolean(showFour && expandedPane && expandedPane !== "volume")}
          style={{ order: paneOrder.indexOf("volume") >= 0 ? paneOrder.indexOf("volume") : 3 }}
        >
          <header className="mpr-pane-header">
            <span className="mpr-plane-mark" />
            <strong>3D</strong>
            <div className="raw-volume-segment" role="group" aria-label="Rendering mode">
              <button type="button" aria-pressed={mode === "volume"} onClick={() => { invalidateFigureCapture(); setMode("volume"); }}>Volume</button>
              <button type="button" aria-pressed={mode === "mpr"} onClick={() => { invalidateFigureCapture(); setMode("mpr"); }} title="Show the three source-grid planes together in 3D">MPR</button>
            </div>
            {showFour ? (
              <button
                type="button"
                className="mpr-swap"
                aria-label="Swap 3D view position"
                title="Swap with next quadrant"
                onClick={() => swapWithNext("volume")}
              >
                <ArrowLeftRight size={13} aria-hidden="true" />
              </button>
            ) : null}
            {showFour ? (
              <button type="button" className="mpr-expand" aria-label={`${expandedPane === "volume" ? "Restore" : "Expand"} 3D view`} onClick={() => togglePane("volume")}>
                {expandedPane === "volume" ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </button>
            ) : null}
          </header>
          <div className="raw-volume-stage" ref={syncContainer} aria-label="Interactive three-dimensional volume"
            tabIndex={0} onKeyDown={onStageKeyDown} onPointerDown={invalidateFigureCapture}
            onWheel={invalidateFigureCapture} onContextMenu={(event) => event.preventDefault()}>
            <div className="raw-volume-frame-label">Rotating source XYZ axes · {activePayload?.frame ?? "image"} frame</div>
            <p className="raw-volume-help">{mode === "volume"
              ? "Left-drag or Alt-drag to orbit · right-drag or Shift-drag to pan · scroll / pinch to zoom · Ctrl-drag to zoom · R reset"
              : "Arrow keys move X/Y · Page Up/Down moves Z · left-drag to orient · right-drag to pan · scroll to zoom · R reset"}</p>
          </div>
        </section>
        {showFour && !expandedPane && (
          <>
            <div
              className={`raw-volume-divider-v ${splitDrag.current?.type === "col" ? "is-dragging" : ""}`}
              style={{ left: `${colSplit}%` }}
              title="Drag to resize columns; double-click to reset"
              onPointerDown={(e) => handleSplitPointerDown("col", e)}
              onPointerMove={handleSplitPointerMove}
              onPointerUp={handleSplitPointerUp}
              onPointerCancel={handleSplitPointerUp}
              onDoubleClick={() => { setColSplit(50); setRowSplit(50); }}
            />
            <div
              className={`raw-volume-divider-h ${splitDrag.current?.type === "row" ? "is-dragging" : ""}`}
              style={{ top: `${rowSplit}%` }}
              title="Drag to resize rows; double-click to reset"
              onPointerDown={(e) => handleSplitPointerDown("row", e)}
              onPointerMove={handleSplitPointerMove}
              onPointerUp={handleSplitPointerUp}
              onPointerCancel={handleSplitPointerUp}
              onDoubleClick={() => { setColSplit(50); setRowSplit(50); }}
            />
            <div
              className={`raw-volume-divider-center ${splitDrag.current?.type === "both" ? "is-dragging" : ""}`}
              style={{ left: `${colSplit}%`, top: `${rowSplit}%` }}
              title="Drag to resize both dimensions; double-click to reset"
              onPointerDown={(e) => handleSplitPointerDown("both", e)}
              onPointerMove={handleSplitPointerMove}
              onPointerUp={handleSplitPointerUp}
              onPointerCancel={handleSplitPointerUp}
              onDoubleClick={() => { setColSplit(50); setRowSplit(50); }}
            />
          </>
        )}
      </div>
      {showFour ? <p className="raw-volume-reslice-note">{activePayload?.frame === "image" ? "Source-coordinate planes" : "Patient-frame planes · radiological orientation"} · linked crosshair · resliced display samples, not native measurements</p> : null}
      {transfers.length > 0 ? <div className="raw-volume-channels" aria-label="Volume channels">{transfers.map((component) => {
        const defaults = volume?.context.components.find((item) => item.channel_index === component.channel_index);
        const histogram = contextHistograms.find((item) => item.channel_index === component.channel_index);
        return <details className="raw-volume-channel" key={component.channel_index}>
          <summary><input aria-label={`${component.name} visible`} type="checkbox" checked={component.visible}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => updateTransfer(component.channel_index, (value) => ({ ...value, visible: event.target.checked }))} />
            <span className="raw-volume-swatch" style={{ backgroundColor: rgbHex(component.color_rgb) }} />
            <span>{component.name}</span><small>{component.window.low.toLocaleString()}–{component.window.high.toLocaleString()}</small></summary>
          <div className="raw-volume-channel-settings">
            <label>Colour<input aria-label={`${component.name} colour`} type="color" value={rgbHex(component.color_rgb)}
              onChange={(event) => { const color = hexRgb(event.target.value); if (color) updateTransfer(component.channel_index, (value) => ({ ...value, color_rgb: color })); }} /></label>
            <label>Low<TransferNumber label={`${component.name} low`} value={component.window.low}
              onCommit={(low) => { if (low >= component.window.high) return false; updateTransfer(component.channel_index, (value) => ({ ...value, window: { ...value.window, low } })); return true; }} /></label>
            <label>High<TransferNumber label={`${component.name} high`} value={component.window.high}
              onCommit={(high) => { if (high <= component.window.low) return false; updateTransfer(component.channel_index, (value) => ({ ...value, window: { ...value.window, high } })); return true; }} /></label>
            <label>Gamma<TransferNumber label={`${component.name} gamma`} value={component.window.gamma} minimum={0.1} maximum={10}
              onCommit={(gamma) => { updateTransfer(component.channel_index, (value) => ({ ...value, window: { ...value.window, gamma } })); return true; }} /></label>
            <label className="raw-volume-opacity">Opacity<input aria-label={`${component.name} opacity`} type="range" min={0} max={1} step={0.01} value={component.opacity}
              onChange={(event) => updateTransfer(component.channel_index, (value) => ({ ...value, opacity: Number(event.target.value) }))} /></label>
            <button type="button" disabled={!defaults} onClick={() => defaults && updateTransfer(component.channel_index, () => ({ ...defaults }))}>Reset channel</button>
            {histogram ? <div className="raw-volume-histogram">
              <HistogramPlot records={[asHistogramRecord(histogram)]} low={component.window.low} high={component.window.high}
                colors={[rgbHex(component.color_rgb)]} label={`${component.name} whole-context display volume`}
                onRange={(low, high) => updateTransfer(component.channel_index, (value) => ({ ...value, window: { ...value.window, low, high } }))} />
              <small>Whole-context display sample · level {histogram.basis.level} · T {histogram.basis.t} · {histogram.sample_count.toLocaleString()} values · {histogram.basis.seed.replaceAll("-", " ")}</small>
            </div> : null}
          </div>
        </details>;
      })}</div> : null}
      <footer className="raw-volume-status" aria-live="polite">
        <span>{error ?? renderError ?? (loading ? "Loading bounded whole-volume detail…" : (contextState === "ready" ? caption : contextState === "lost" ? "Graphics context lost. Waiting for restoration…" : "Restoring volume renderer…") ?? "Choose a 3D scalar source.")}</span>
        {volume ? <small>Whole context · {volume.context.sampling.method.replaceAll("-", " ")} · level {volume.context.level} · {volume.context.byte_length.toLocaleString()} bytes
          {volume.focus ? ` · Focus ${volume.focus.source_extent_xyzxyz.join(", ")} shown separately (${volume.focus.byte_length.toLocaleString()} bytes; ${focusUsesNativeSteps ? "native source steps" : "sampled source steps"})` : ""}</small> : null}
      </footer>
    </section>
  );
}
