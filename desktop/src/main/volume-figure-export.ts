import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";

import type {
  VolumeFigureExportReceipt,
  VolumeFigureExportRequest,
  VolumeFigurePayloadRecord,
} from "../shared/research-contracts";

export const MAX_VOLUME_FIGURE_PNG_BYTES = 32 * 1024 * 1024;
export const MAX_VOLUME_FIGURE_METADATA_BYTES = 1024 * 1024;
export const MAX_VOLUME_FIGURE_EDGE = 8192;
export const MAX_VOLUME_FIGURE_PIXELS = 16_000_000;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_ID = /^[a-f0-9]{32}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

type VerifiedSource = { source_id: string; source_sha256: string };

export interface PublishVolumeFigureBundleOptions {
  destination: string;
  request: unknown;
  verifiedSource: VerifiedSource;
  applicationVersion: string;
  publishStagedBundle: (request: VolumeFigurePublicationRequest) => Promise<void>;
}

export interface VolumeFigurePublicationRequest {
  parent: string;
  staging: string;
  destination: string;
  parent_identity: { device: string; inode: string };
  staging_identity: { device: string; inode: string };
  artifacts: Array<{
    name: "image.png" | "manifest.json";
    sha256: string;
    size_bytes: number;
  }>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    throw new Error(`${label} has unsupported fields.`);
}

function boundedString(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || !value || value.length > maximum || CONTROL_CHARACTER.test(value))
    throw new Error(`${label} is invalid.`);
  return value;
}

function finiteNumber(value: unknown, label: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new Error(`${label} is invalid.`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = finiteNumber(value, label, minimum, maximum);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function vector(value: unknown, length: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new Error(`${label} is invalid.`);
  return value.map((item, index) => finiteNumber(item, `${label}[${index}]`));
}

function integerVector(value: unknown, length: number, label: string, positive = false): number[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new Error(`${label} is invalid.`);
  return value.map((item, index) => integer(item, `${label}[${index}]`, positive ? 1 : 0));
}

function validateIndexAxes(
  value: unknown,
  dimensions: number[],
  limits: number[],
  label: string,
): void {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} is invalid.`);
  value.forEach((axisValue, axis) => {
    if (!Array.isArray(axisValue) || axisValue.length !== dimensions[axis])
      throw new Error(`${label} is invalid.`);
    let previous = -1;
    axisValue.forEach((item, index) => {
      const current = integer(item, `${label}[${axis}][${index}]`, 0, limits[axis] - 1);
      if (current <= previous) throw new Error(`${label} must be strictly increasing.`);
      previous = current;
    });
  });
}

function validatePayload(value: unknown, expectedRole: "context" | "focus", sourceT: number): VolumeFigurePayloadRecord {
  const payload = record(value, `${expectedRole} payload`);
  exactKeys(payload, [
    "role", "data_sha256", "t", "level", "dimensions_xyz", "native_level_dimensions_xyz",
    "source_dimensions_xyz", "source_extent_xyzxyz", "origin_xyz", "spacing_xyz",
    "direction_3x3", "affine_4x4", "unit", "frame", "scalar_type", "source_dtypes", "component_indices",
    "encoding_basis", "byte_length", "sampling",
  ], `${expectedRole} payload`);
  if ((expectedRole === "context" && payload.role !== "whole-volume-context") ||
      (expectedRole === "focus" && !["level-zero-focus", "native-detail-focus"].includes(String(payload.role))))
    throw new Error(`The ${expectedRole} payload role is invalid.`);
  if (typeof payload.data_sha256 !== "string" || !SHA256.test(payload.data_sha256))
    throw new Error(`The ${expectedRole} data fingerprint is invalid.`);
  if (integer(payload.t, `${expectedRole} T index`) !== sourceT)
    throw new Error(`The ${expectedRole} payload has a stale T binding.`);
  integer(payload.level, `${expectedRole} level`);
  const dimensions = integerVector(payload.dimensions_xyz, 3, `${expectedRole} dimensions`, true);
  if (dimensions[2] < 2) throw new Error(`The ${expectedRole} payload has no volume depth.`);
  const nativeDimensions = integerVector(
    payload.native_level_dimensions_xyz, 3, `${expectedRole} native dimensions`, true,
  );
  const sourceDimensions = integerVector(
    payload.source_dimensions_xyz, 3, `${expectedRole} source dimensions`, true,
  );
  const sourceExtent = integerVector(payload.source_extent_xyzxyz, 6, `${expectedRole} source extent`);
  for (let axis = 0; axis < 3; axis += 1) {
    if (sourceExtent[axis * 2] > sourceExtent[axis * 2 + 1] ||
        sourceExtent[axis * 2 + 1] >= nativeDimensions[axis])
      throw new Error(`The ${expectedRole} source extent is invalid.`);
  }
  const origin = vector(payload.origin_xyz, 3, `${expectedRole} origin`);
  const spacing = vector(payload.spacing_xyz, 3, `${expectedRole} spacing`);
  if (spacing.some((item) => item <= 0)) throw new Error(`The ${expectedRole} spacing is invalid.`);
  const direction = vector(payload.direction_3x3, 9, `${expectedRole} direction`);
  for (let column = 0; column < 3; column += 1) {
    for (let other = 0; other < 3; other += 1) {
      let dot = 0;
      for (let row = 0; row < 3; row += 1)
        dot += direction[column * 3 + row] * direction[other * 3 + row];
      if (!approximatelyEqual(dot, column === other ? 1 : 0))
        throw new Error(`The ${expectedRole} direction is not orthonormal.`);
    }
  }
  if (!Array.isArray(payload.affine_4x4) || payload.affine_4x4.length !== 4)
    throw new Error(`The ${expectedRole} affine is invalid.`);
  const affine = payload.affine_4x4.map((row, index) =>
    vector(row, 4, `${expectedRole} affine row ${index}`));
  if (affine[3].some((item, index) => item !== (index === 3 ? 1 : 0)))
    throw new Error(`The ${expectedRole} affine is invalid.`);
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      if (!approximatelyEqual(affine[row][column], direction[column * 3 + row] * spacing[column]))
        throw new Error(`The ${expectedRole} affine disagrees with direction and spacing.`);
    }
    if (!approximatelyEqual(affine[column][3], origin[column]))
      throw new Error(`The ${expectedRole} affine disagrees with its origin.`);
  }
  if (!["pixel", "nm", "um", "mm", "m"].includes(String(payload.unit)) ||
      !["image", "RAS", "LPS"].includes(String(payload.frame)))
    throw new Error(`The ${expectedRole} geometry labels are invalid.`);
  boundedString(payload.scalar_type, `${expectedRole} scalar type`, 32);
  if (!Array.isArray(payload.source_dtypes) || !payload.source_dtypes.length || payload.source_dtypes.length > 4)
    throw new Error(`The ${expectedRole} source dtypes are invalid.`);
  payload.source_dtypes.forEach((item, index) => boundedString(item, `${expectedRole} dtype ${index}`, 32));
  if (!Array.isArray(payload.component_indices) || payload.component_indices.length !== payload.source_dtypes.length ||
      new Set(payload.component_indices).size !== payload.component_indices.length)
    throw new Error(`The ${expectedRole} component indices are invalid.`);
  payload.component_indices.forEach((item, index) =>
    integer(item, `${expectedRole} component ${index}`, 0, 15));
  boundedString(payload.encoding_basis, `${expectedRole} encoding basis`, 128);
  integer(payload.byte_length, `${expectedRole} byte length`, 1, 64 * 1024 * 1024);
  const sampling = record(payload.sampling, `${expectedRole} sampling`);
  exactKeys(sampling, ["method", "source_indices_xyz", "level_zero_indices_xyz"], `${expectedRole} sampling`);
  boundedString(sampling.method, `${expectedRole} sampling method`, 128);
  validateIndexAxes(sampling.source_indices_xyz, dimensions, nativeDimensions, `${expectedRole} source indices`);
  validateIndexAxes(sampling.level_zero_indices_xyz, dimensions, sourceDimensions, `${expectedRole} level-zero indices`);
  return value as VolumeFigurePayloadRecord;
}

function approximatelyEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected));
}

function sameNumberArray(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && actual.every((item, index) =>
    approximatelyEqual(item, expected[index]));
}

function worldAtIndex(payload: VolumeFigurePayloadRecord, index: number[]): number[] {
  return [0, 1, 2].map((row) => payload.origin_xyz[row] + [0, 1, 2].reduce(
    (total, column) => total + payload.direction_3x3[column * 3 + row] *
      payload.spacing_xyz[column] * index[column],
    0,
  ));
}

function nearestSampleIndex(values: number[], target: number): number {
  let nearest = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (Math.abs(values[index] - target) < Math.abs(values[nearest] - target)) nearest = index;
  }
  return nearest;
}

function validateTransfer(
  value: unknown,
  seen: Set<number>,
  mode: "volume" | "mpr",
  activePayload: VolumeFigurePayloadRecord,
): void {
  const transfer = record(value, "Volume transfer");
  exactKeys(transfer, [
    "channel_index", "name", "color_rgb", "color_mode", "window", "opacity", "visible",
    "source_opacity_points", "resolved_points", "opacity_unit_distance", "provenance",
  ], "Volume transfer");
  const channel = integer(transfer.channel_index, "Volume transfer channel", 0, 15);
  if (seen.has(channel)) throw new Error("Volume transfer channels must be unique.");
  seen.add(channel);
  boundedString(transfer.name, "Volume transfer name", 80);
  const color = vector(transfer.color_rgb, 3, "Volume transfer colour");
  if (color.some((item) => item < 0 || item > 1)) throw new Error("Volume transfer colour is invalid.");
  if (!["constant", "intensity"].includes(String(transfer.color_mode)))
    throw new Error("Volume transfer colour mode is invalid.");
  const expectedColorMode = mode === "volume" ? "constant" : "intensity";
  if (transfer.color_mode !== expectedColorMode)
    throw new Error("Volume transfer colour mode disagrees with the representation.");
  const window = record(transfer.window, "Volume transfer window");
  exactKeys(window, ["low", "high", "gamma"], "Volume transfer window");
  const low = finiteNumber(window.low, "Volume transfer low");
  const high = finiteNumber(window.high, "Volume transfer high");
  if (high <= low) throw new Error("Volume transfer high must exceed low.");
  finiteNumber(window.gamma, "Volume transfer gamma", 0.1, 10);
  finiteNumber(transfer.opacity, "Volume transfer opacity", 0, 1);
  if (typeof transfer.visible !== "boolean") throw new Error("Volume transfer visibility is invalid.");
  if (!Array.isArray(transfer.source_opacity_points) || transfer.source_opacity_points.length < 2 || transfer.source_opacity_points.length > 32)
    throw new Error("Volume transfer source opacity points are invalid.");
  let previousSourceScalar = -Number.MAX_VALUE;
  transfer.source_opacity_points.forEach((point, index) => {
    const pair = vector(point, 2, `Volume transfer source opacity point ${index}`);
    if (pair[1] < 0 || pair[1] > 1) throw new Error("Volume transfer opacity is invalid.");
    if (pair[0] < previousSourceScalar) throw new Error("Volume transfer source opacity points are unordered.");
    previousSourceScalar = pair[0];
  });
  if (!Array.isArray(transfer.resolved_points) || transfer.resolved_points.length !== 5)
    throw new Error("Volume transfer resolved points are invalid.");
  transfer.resolved_points.forEach((value, index) => {
    const point = record(value, `Volume transfer resolved point ${index}`);
    exactKeys(point, ["scalar", "opacity", "color_rgb"], `Volume transfer resolved point ${index}`);
    finiteNumber(point.scalar, `Volume transfer resolved scalar ${index}`);
    finiteNumber(point.opacity, `Volume transfer resolved opacity ${index}`, 0, 1);
    const pointColor = vector(point.color_rgb, 3, `Volume transfer resolved colour ${index}`);
    if (pointColor.some((item) => item < 0 || item > 1))
      throw new Error("Volume transfer resolved colour is invalid.");
    const output = index / 4;
    const expectedScalar = index === 0 ? low : low + output ** Number(window.gamma) * (high - low);
    const expectedOpacity = output * Number(transfer.opacity);
    const colorLevel = expectedColorMode === "constant" ? 1 : output;
    if (!approximatelyEqual(Number(point.scalar), expectedScalar) ||
        !approximatelyEqual(Number(point.opacity), expectedOpacity) ||
        pointColor.some((item, colorIndex) =>
          !approximatelyEqual(item, color[colorIndex] * colorLevel)))
      throw new Error("Volume transfer resolved points disagree with the rendered mapping.");
  });
  if (mode === "mpr") {
    if (transfer.opacity_unit_distance !== null)
      throw new Error("An MPR transfer must not claim a volume opacity unit distance.");
  } else {
    const distance = finiteNumber(
      transfer.opacity_unit_distance, "Volume transfer opacity unit distance", Number.MIN_VALUE,
    );
    const expectedDistance = Math.hypot(...activePayload.dimensions_xyz.map(
      (length, axis) => (length - 1) * activePayload.spacing_xyz[axis],
    )) / Math.max(...activePayload.dimensions_xyz);
    if (!approximatelyEqual(distance, expectedDistance))
      throw new Error("Volume transfer opacity unit distance disagrees with the active payload.");
  }
  const provenance = record(transfer.provenance, "Volume transfer provenance");
  if (Object.keys(provenance).length > 32) throw new Error("Volume transfer provenance is too large.");
  Object.entries(provenance).forEach(([key, item]) => {
    boundedString(key, "Volume transfer provenance key", 80);
    boundedString(item, "Volume transfer provenance value", 256);
  });
}

export function checkedVolumeFigureRequest(
  value: unknown,
  verifiedSource: VerifiedSource,
): VolumeFigureExportRequest {
  const request = record(value, "Volume figure request");
  exactKeys(request, [
    "schema_version", "source_id", "source_sha256", "width_px", "height_px", "png_base64", "manifest",
  ], "Volume figure request");
  if (request.schema_version !== "loci.volume-figure-request/v1" ||
      typeof request.source_id !== "string" || !SOURCE_ID.test(request.source_id) ||
      typeof request.source_sha256 !== "string" || !SHA256.test(request.source_sha256))
    throw new Error("Volume figure export needs an exact source binding.");
  if (verifiedSource.source_id !== request.source_id || verifiedSource.source_sha256 !== request.source_sha256)
    throw new Error("The source changed before the volume figure could be published.");
  const width = integer(request.width_px, "Volume figure width", 1, MAX_VOLUME_FIGURE_EDGE);
  const height = integer(request.height_px, "Volume figure height", 1, MAX_VOLUME_FIGURE_EDGE);
  if (width * height > MAX_VOLUME_FIGURE_PIXELS) throw new Error("The volume figure pixel count is too large.");
  if (typeof request.png_base64 !== "string" || request.png_base64.length > 4 * Math.ceil(MAX_VOLUME_FIGURE_PNG_BYTES / 3))
    throw new Error("The volume figure PNG is too large.");

  const manifest = record(request.manifest, "Volume figure manifest");
  exactKeys(manifest, [
    "schema_version", "figure", "source", "payloads", "representation", "camera", "transfers",
    "clipping", "mpr", "background", "software", "provenance",
  ], "Volume figure manifest");
  if (manifest.schema_version !== "loci.volume-figure/v1") throw new Error("The volume figure manifest schema is unsupported.");
  const figure = record(manifest.figure, "Volume figure description");
  exactKeys(figure, ["kind", "format", "width_px", "height_px", "device_pixel_ratio", "capture_scale"], "Volume figure description");
  if (figure.kind !== "screen-resolution-rendered-figure" || figure.format !== "png" ||
      figure.width_px !== width || figure.height_px !== height || figure.capture_scale !== 1)
    throw new Error("The volume figure must describe its native PNG capture exactly.");
  finiteNumber(figure.device_pixel_ratio, "Volume figure device pixel ratio", 0.25, 16);
  const source = record(manifest.source, "Volume figure source");
  exactKeys(source, ["source_id", "source_sha256", "t"], "Volume figure source");
  if (source.source_id !== request.source_id || source.source_sha256 !== request.source_sha256)
    throw new Error("The volume figure manifest has a stale source binding.");
  const sourceT = integer(source.t, "Volume figure T index");

  const payloads = record(manifest.payloads, "Volume figure payloads");
  exactKeys(payloads, ["context", "focus"], "Volume figure payloads");
  const contextPayload = validatePayload(payloads.context, "context", sourceT);
  const focusPayload = payloads.focus === null ? null : validatePayload(payloads.focus, "focus", sourceT);
  if (focusPayload && (
    focusPayload.source_dimensions_xyz.join(",") !== contextPayload.source_dimensions_xyz.join(",") ||
    focusPayload.component_indices.join(",") !== contextPayload.component_indices.join(",") ||
    focusPayload.source_dtypes.join(",") !== contextPayload.source_dtypes.join(",") ||
    focusPayload.unit !== contextPayload.unit || focusPayload.frame !== contextPayload.frame
  )) throw new Error("The volume focus payload is not bound to the context geometry and components.");

  const representation = record(manifest.representation, "Volume representation");
  exactKeys(representation, ["mode", "extent", "interpolation", "shading", "orientation_axes",
    ...(Object.hasOwn(representation, "lighting") ? ["lighting"] : [])], "Volume representation");
  if (!["volume", "mpr"].includes(String(representation.mode)) ||
      !["context", "focus"].includes(String(representation.extent)) ||
      representation.interpolation !== "linear" || typeof representation.shading !== "boolean" ||
      representation.orientation_axes !== true)
    throw new Error("The volume representation is invalid.");
  if (representation.shading) {
    const lighting = record(representation.lighting, "Volume lighting");
    exactKeys(lighting, ["ambient", "diffuse", "specular", "specular_power", "gradient_opacity"], "Volume lighting");
    if (representation.mode !== "volume" || lighting.ambient !== 0.22 || lighting.diffuse !== 0.68 ||
        lighting.specular !== 0.25 || lighting.specular_power !== 20 || lighting.gradient_opacity !== false)
      throw new Error("The shaded volume lighting configuration is unsupported.");
  } else if (representation.lighting != null) throw new Error("Unshaded figures cannot declare lighting.");
  if (representation.extent === "focus" && payloads.focus === null)
    throw new Error("A focus figure requires a verified focus payload.");
  const activePayload = representation.extent === "focus" ? focusPayload! : contextPayload;

  const camera = record(manifest.camera, "Volume camera");
  exactKeys(camera, [
    "projection", "position_xyz", "focal_point_xyz", "view_up_xyz", "clipping_range",
    "view_angle_degrees", "parallel_scale",
  ], "Volume camera");
  if (!["perspective", "parallel"].includes(String(camera.projection))) throw new Error("The volume camera projection is invalid.");
  vector(camera.position_xyz, 3, "Volume camera position");
  vector(camera.focal_point_xyz, 3, "Volume camera focal point");
  vector(camera.view_up_xyz, 3, "Volume camera view up");
  const clippingRange = vector(camera.clipping_range, 2, "Volume camera clipping range");
  if (clippingRange[0] < 0 || clippingRange[1] <= clippingRange[0]) throw new Error("The volume camera clipping range is invalid.");
  finiteNumber(camera.view_angle_degrees, "Volume camera view angle", 0.01, 179);
  if (camera.projection === "parallel") finiteNumber(camera.parallel_scale, "Volume camera parallel scale", Number.MIN_VALUE);
  else if (camera.parallel_scale !== null) throw new Error("A perspective camera must not claim a parallel scale.");

  if (!Array.isArray(manifest.transfers) || manifest.transfers.length < 1 || manifest.transfers.length > 4)
    throw new Error("Volume figure transfers are invalid.");
  const seen = new Set<number>();
  manifest.transfers.forEach((transfer) => validateTransfer(
    transfer,
    seen,
    representation.mode as "volume" | "mpr",
    activePayload,
  ));
  if ([...seen].join(",") !== activePayload.component_indices.join(","))
    throw new Error("Volume transfers do not match the active payload components.");

  const clipping = record(manifest.clipping, "Volume clipping");
  if (clipping.enabled === false) exactKeys(clipping, ["enabled"], "Volume clipping");
  else {
    exactKeys(clipping, ["enabled", "axis", "position_percent", "plane_origin_xyz", "plane_normal_xyz"], "Volume clipping");
    if (clipping.enabled !== true || !["x", "y", "z"].includes(String(clipping.axis)))
      throw new Error("Volume clipping is invalid.");
    finiteNumber(clipping.position_percent, "Volume clipping position", 0, 100);
    const clippingOrigin = vector(clipping.plane_origin_xyz, 3, "Volume clipping origin");
    const clippingNormal = vector(clipping.plane_normal_xyz, 3, "Volume clipping normal");
    const axis = ["x", "y", "z"].indexOf(String(clipping.axis));
    const displayIndex = [0, 0, 0];
    displayIndex[axis] = (contextPayload.dimensions_xyz[axis] - 1) * Number(clipping.position_percent) / 100;
    const expectedOrigin = worldAtIndex(contextPayload, displayIndex);
    const expectedNormal = [0, 1, 2].map((row) => contextPayload.direction_3x3[axis * 3 + row]);
    if (!sameNumberArray(clippingOrigin, expectedOrigin) || !sameNumberArray(clippingNormal, expectedNormal))
      throw new Error("Volume clipping geometry disagrees with the context payload.");
  }

  if (manifest.mpr === null) {
    if (representation.mode === "mpr") throw new Error("An MPR figure requires exact slice indices.");
  } else {
    const mpr = record(manifest.mpr, "Volume MPR state");
    exactKeys(mpr, ["context_display_indices_xyz", "active_payload_indices_xyz", "source_indices_xyz", "world_xyz"], "Volume MPR state");
    const contextIndices = integerVector(mpr.context_display_indices_xyz, 3, "Volume MPR context indices");
    const activeIndices = integerVector(mpr.active_payload_indices_xyz, 3, "Volume MPR active-payload indices");
    const sourceIndices = integerVector(mpr.source_indices_xyz, 3, "Volume MPR source indices");
    const world = vector(mpr.world_xyz, 3, "Volume MPR world position");
    for (let axis = 0; axis < 3; axis += 1) {
      if (contextIndices[axis] >= contextPayload.dimensions_xyz[axis] ||
          activeIndices[axis] >= activePayload.dimensions_xyz[axis] ||
          sourceIndices[axis] !== contextPayload.sampling.level_zero_indices_xyz[axis][contextIndices[axis]] ||
          activeIndices[axis] !== nearestSampleIndex(
            activePayload.sampling.level_zero_indices_xyz[axis], sourceIndices[axis],
          )) throw new Error("Volume MPR indices disagree with the displayed payloads.");
    }
    if (!sameNumberArray(world, worldAtIndex(contextPayload, contextIndices)))
      throw new Error("Volume MPR world position disagrees with the context geometry.");
    if (representation.mode !== "mpr") throw new Error("A volume rendering must not claim MPR slices.");
  }

  const background = record(manifest.background, "Volume background");
  exactKeys(background, ["rgb"], "Volume background");
  const backgroundRgb = vector(background.rgb, 3, "Volume background colour");
  if (backgroundRgb.some((item) => item < 0 || item > 1)) throw new Error("Volume background colour is invalid.");
  const software = record(manifest.software, "Volume software");
  exactKeys(software, ["renderer", "renderer_version", "capture_method"], "Volume software");
  if (software.renderer !== "vtk.js" || software.renderer_version !== "36.12.0" ||
      software.capture_method !== "captureNextImage") throw new Error("The volume renderer identity is invalid.");
  const provenance = record(manifest.provenance, "Volume figure provenance");
  exactKeys(provenance, [
    "artifact_semantics", "screen_resolution_only", "scale_bar_included", "high_resolution_claim",
    "biological_or_clinical_validation_claim", "metadata_contains_source_pixel_data",
  ], "Volume figure provenance");
  if (provenance.artifact_semantics !== "Rendered display RGB at native canvas resolution; not original-value scientific data." ||
      provenance.screen_resolution_only !== true || provenance.scale_bar_included !== false ||
      provenance.high_resolution_claim !== false ||
      provenance.biological_or_clinical_validation_claim !== false ||
      provenance.metadata_contains_source_pixel_data !== false)
    throw new Error("The volume figure provenance is invalid.");

  const metadataBytes = Buffer.byteLength(JSON.stringify(manifest), "utf8");
  if (metadataBytes > MAX_VOLUME_FIGURE_METADATA_BYTES)
    throw new Error("The volume figure metadata is too large.");
  return value as VolumeFigureExportRequest;
}

function decodePng(request: VolumeFigureExportRequest): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(request.png_base64))
    throw new Error("The volume figure PNG encoding is invalid.");
  const bytes = Buffer.from(request.png_base64, "base64");
  if (bytes.toString("base64") !== request.png_base64 || bytes.byteLength > MAX_VOLUME_FIGURE_PNG_BYTES)
    throw new Error("The volume figure PNG encoding is invalid or too large.");
  if (bytes.byteLength < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== request.width_px || bytes.readUInt32BE(20) !== request.height_px ||
      bytes[24] !== 8 || ![2, 6].includes(bytes[25]) || bytes[26] !== 0 || bytes[27] !== 0 ||
      ![0, 1].includes(bytes[28]))
    throw new Error("The captured PNG header disagrees with the volume figure request.");
  let offset = 8;
  let chunks = 0;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < bytes.byteLength && chunks < 100_000) {
    if (offset + 12 > bytes.byteLength) throw new Error("The captured PNG is truncated.");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) throw new Error("The captured PNG is truncated.");
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(end - 4))
      throw new Error("The captured PNG has a corrupt chunk checksum.");
    if (chunks === 0 && kind !== "IHDR") throw new Error("The captured PNG has no leading IHDR chunk.");
    if (kind === "IDAT") sawImageData = true;
    if (kind === "IEND") {
      if (length !== 0 || end !== bytes.byteLength) throw new Error("The captured PNG has an invalid end marker.");
      sawEnd = true;
    }
    offset = end;
    chunks += 1;
  }
  if (!sawImageData || !sawEnd || offset !== bytes.byteLength)
    throw new Error("The captured PNG is incomplete.");
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeVerifiedFile(destination: string, bytes: Uint8Array): Promise<string> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(destination, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.byteLength)
      throw new Error("A staged volume figure artifact could not be verified.");
    const stored = await fs.readFile(destination);
    const digest = sha256(stored);
    if (digest !== sha256(bytes)) throw new Error("A staged volume figure artifact changed before publication.");
    return digest;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // The fully flushed files and same-directory rename remain authoritative
    // on filesystems that do not support directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function absent(value: string): Promise<boolean> {
  try {
    await fs.lstat(value);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function publishVolumeFigureBundle({
  destination,
  request: value,
  verifiedSource,
  applicationVersion,
  publishStagedBundle,
}: PublishVolumeFigureBundleOptions): Promise<VolumeFigureExportReceipt> {
  const request = checkedVolumeFigureRequest(value, verifiedSource);
  const png = decodePng(request);
  const version = boundedString(applicationVersion, "Loci application version", 64);
  const resolved = path.resolve(destination);
  if (!path.isAbsolute(destination) || path.extname(resolved).toLocaleLowerCase("en-US") !== ".loci-figure" ||
      path.basename(resolved).length > 160 || CONTROL_CHARACTER.test(path.basename(resolved)))
    throw new Error("Choose a bounded .loci-figure destination.");
  const requestedParent = path.dirname(resolved);
  const parentStat = await fs.lstat(requestedParent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new Error("The volume figure destination parent is unsafe.");
  const parent = await fs.realpath(requestedParent);
  const parentIdentity = { device: String(parentStat.dev), inode: String(parentStat.ino) };
  const target = path.join(parent, path.basename(resolved));
  if (!(await absent(target))) throw new Error("A file or folder already exists at the volume figure destination.");

  const imageHash = sha256(png);
  const finalManifest = {
    ...request.manifest,
    artifact: {
      name: "image.png",
      sha256: imageHash,
      size_bytes: png.byteLength,
      width_px: request.width_px,
      height_px: request.height_px,
    },
    software: { ...request.manifest.software, application: "Loci", application_version: version },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(finalManifest, null, 2)}\n`, "utf8");
  if (manifestBytes.byteLength > MAX_VOLUME_FIGURE_METADATA_BYTES)
    throw new Error("The completed volume figure manifest is too large.");

  const staging = await fs.mkdtemp(path.join(parent, `.loci-volume-figure-${process.pid}-${randomUUID()}-`));
  let published = false;
  try {
    const stageStat = await fs.lstat(staging, { bigint: true });
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || await fs.realpath(staging) !== staging)
      throw new Error("The volume figure staging directory is unsafe.");
    const storedImageHash = await writeVerifiedFile(path.join(staging, "image.png"), png);
    const manifestHash = await writeVerifiedFile(path.join(staging, "manifest.json"), manifestBytes);
    if (storedImageHash !== imageHash) throw new Error("The staged volume figure PNG hash changed.");
    await fsyncDirectory(staging);
    const finalParentStat = await fs.lstat(parent, { bigint: true });
    if (!finalParentStat.isDirectory() || finalParentStat.isSymbolicLink() ||
        String(finalParentStat.dev) !== parentIdentity.device ||
        String(finalParentStat.ino) !== parentIdentity.inode ||
        await fs.realpath(parent) !== parent || !(await absent(target)))
      throw new Error("The volume figure destination changed before publication.");
    await publishStagedBundle({
      parent,
      staging,
      destination: target,
      parent_identity: parentIdentity,
      staging_identity: { device: String(stageStat.dev), inode: String(stageStat.ino) },
      artifacts: [
        { name: "image.png", sha256: imageHash, size_bytes: png.byteLength },
        { name: "manifest.json", sha256: manifestHash, size_bytes: manifestBytes.byteLength },
      ],
    });
    published = true;
    return {
      basename: path.basename(target),
      width: request.width_px,
      height: request.height_px,
      hashes: { "image.png": imageHash, "manifest.json": manifestHash },
    };
  } finally {
    if (!published) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
