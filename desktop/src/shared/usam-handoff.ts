import type {
  ResearchLabelsImportBinding,
  ResearchSelection,
  ResearchUsamHandoffBinding,
  ResearchUsamHandoffInput,
  ResearchUsamHandoffReceipt,
  ResearchUsamHandoffRecord,
} from "./research-contracts";

const ID_RE = /^[a-f0-9]{32}$/u;
const SHA_RE = /^[a-f0-9]{64}$/u;

function exactRecord(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function noPathText(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength ||
      /[/\\\u0000-\u001f\u007f]/u.test(value) || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function checkedSelection(value: unknown): ResearchSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Label import requires an explicit native YX plane or ZYX volume.");
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "c,height,level,t,width,x,y,z" && keys !== "c,height,level,t,width,x,y,z,z_stop") {
    throw new Error("Label import requires an explicit native YX plane or ZYX volume.");
  }
  const selection = value as Record<string, unknown>;
  if (Object.values(selection).some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0) ||
      selection.level !== 0 || selection.x !== 0 || selection.y !== 0 ||
      Number(selection.width) < 1 || Number(selection.height) < 1 ||
      (selection.z_stop !== undefined && Number(selection.z_stop) < Number(selection.z) + 2)) {
    throw new Error("Label import requires a full level-0 native grid and at least two planes for a volume.");
  }
  return structuredClone(selection) as unknown as ResearchSelection;
}

export function sameUsamSelection(left: ResearchSelection, right: ResearchSelection): boolean {
  return (["x", "y", "width", "height", "t", "c", "z", "level", "z_stop"] as const)
    .every((key) => left[key] === right[key]);
}

export function checkedLabelsBinding(
  value: unknown,
  options: { allowHandoff: boolean } = { allowHandoff: true },
): ResearchLabelsImportBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Select a valid native source plane.");
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = options.allowHandoff
    ? new Set(["source_id", "source_sha256", "selection", "working_bytes", "handoff_id", "use_handoff_manifest"])
    : new Set(["source_id", "source_sha256", "selection", "working_bytes"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key)) ||
      typeof input.source_id !== "string" || !ID_RE.test(input.source_id) ||
      typeof input.source_sha256 !== "string" || !SHA_RE.test(input.source_sha256) ||
      !Number.isSafeInteger(input.working_bytes) || Number(input.working_bytes) < 1024 * 1024 ||
      Number(input.working_bytes) > 8 * 1024 ** 3) {
    throw new Error("Invalid label-import binding or memory budget.");
  }
  if (input.handoff_id !== undefined && input.use_handoff_manifest !== undefined) {
    throw new Error("Invalid label-import binding or memory budget.");
  }
  if (input.handoff_id !== undefined && (typeof input.handoff_id !== "string" || !ID_RE.test(input.handoff_id))) {
    throw new Error("Invalid label-import binding or memory budget.");
  }
  if (input.use_handoff_manifest !== undefined && input.use_handoff_manifest !== true) {
    throw new Error("Invalid label-import binding or memory budget.");
  }
  const selection = checkedSelection(input.selection);
  return {
    source_id: input.source_id,
    source_sha256: input.source_sha256,
    selection,
    working_bytes: Number(input.working_bytes),
    ...(input.handoff_id !== undefined ? { handoff_id: input.handoff_id as string } : {}),
    ...(input.use_handoff_manifest === true ? { use_handoff_manifest: true } : {}),
  };
}

function checkedInputRecord(value: unknown, selection: ResearchSelection): ResearchUsamHandoffInput {
  const keys = ["file_name", "file_sha256", "file_size_bytes", "array_sha256", "dtype", "shape", "axes", "compression", "value_preservation"];
  const r = exactRecord(value, keys, "μSAM handoff input");
  const volume = selection.z_stop !== undefined;
  const expectedShape = volume
    ? [selection.z_stop! - selection.z, selection.height, selection.width]
    : [selection.height, selection.width];
  const expectedAxes = volume ? "ZYX" : "YX";
  if (r.file_name !== "input.tif" ||
      typeof r.file_sha256 !== "string" || !SHA_RE.test(r.file_sha256) ||
      typeof r.array_sha256 !== "string" || !SHA_RE.test(r.array_sha256) ||
      !Number.isSafeInteger(r.file_size_bytes) || Number(r.file_size_bytes) < 1 ||
      r.axes !== expectedAxes ||
      !Array.isArray(r.shape) || r.shape.length !== expectedShape.length ||
      r.shape.some((dim, index) => dim !== expectedShape[index]) ||
      r.value_preservation !== "exact-original-native-scalar-samples") {
    throw new Error("The μSAM handoff input record does not match the selected source grid.");
  }
  if (typeof r.dtype !== "string" || !/^(?:u?int(?:8|16|32|64)|float(?:16|32|64))$/u.test(r.dtype) ||
      r.compression !== "deflate") {
    throw new Error("Unsupported μSAM input dtype or compression.");
  }
  return r as unknown as ResearchUsamHandoffInput;
}

function checkGrid(record: Record<string, unknown>, selection: ResearchSelection): ResearchUsamHandoffInput {
  const input = checkedInputRecord(record.input, selection);
  const channel = exactRecord(record.measurement_channel, ["index", "name", "basis"], "measurement channel");
  if (channel.index !== selection.c || channel.basis !== "raw-source-channel-values") {
    throw new Error("The μSAM measurement channel disagrees with the selection.");
  }
  noPathText(channel.name, "measurement channel name");
  const geometry = exactRecord(record.geometry, ["axes", "affine", "unit", "frame"], "source grid");
  const calibration = exactRecord(record.calibration, ["status", "unit", "axes", "spacing"], "calibration");
  const matrix = geometry.affine;
  if (geometry.axes !== input.axes || !["image", "RAS", "LPS"].includes(String(geometry.frame)) ||
      !["pixel", "um", "nm", "mm", "m"].includes(String(geometry.unit)) ||
      !Array.isArray(matrix) || matrix.length !== 4 || !matrix.every(row =>
        Array.isArray(row) && row.length === 4 && row.every(value => typeof value === "number" && Number.isFinite(value))) ||
      matrix[3].some((value: number, i: number) => value !== (i === 3 ? 1 : 0)) ||
      calibration.unit !== geometry.unit || calibration.axes !== geometry.axes) {
    throw new Error("Invalid μSAM source geometry or calibration.");
  }
  const spacing = calibration.spacing;
  const validSpacing = geometry.unit === "pixel"
    ? calibration.status === "unknown" && spacing === null
    : calibration.status === "known" && Array.isArray(spacing) && spacing.length === input.shape.length &&
      spacing.every(value => typeof value === "number" && Number.isFinite(value) && value > 0);
  const profile = exactRecord(record.label_profile,
    ["profile", "alignment", "axes", "shape", "allowed_dtypes", "background_value", "format"], "label profile");
  const axes = input.axes.toLowerCase();
  if (!validSpacing || profile.axes !== input.axes || profile.profile !== `scalar-native-${axes}/v1` ||
      profile.alignment !== `same-native-${axes}-grid` || profile.format !== "TIFF" || profile.background_value !== 0 ||
      !Array.isArray(profile.shape) || profile.shape.length !== input.shape.length ||
      profile.shape.some((value, index) => value !== input.shape[index]) ||
      JSON.stringify(profile.allowed_dtypes) !== '["uint8","uint16","uint32"]') {
    throw new Error("Invalid μSAM label grid or spacing.");
  }
  return input;
}

export function checkedUsamHandoffBinding(value: unknown): ResearchUsamHandoffBinding {
  const keys = [
    "schema", "handoff_id", "manifest_sha256", "export_identity_basis", "binding_source",
    "exported_input_file_sha256", "exported_input_array_sha256", "exported_input_dtype",
    "exported_input_shape", "exported_input_axes", "mask_origin_verified_by_loci", "model_validation",
  ];
  const r = exactRecord(value, keys, "μSAM handoff binding");
  if (Object.keys(r).length !== keys.length ||
      r.schema !== "loci.usam-handoff-binding/v1" ||
      typeof r.handoff_id !== "string" || !ID_RE.test(r.handoff_id) ||
      typeof r.manifest_sha256 !== "string" || !SHA_RE.test(r.manifest_sha256) ||
      r.export_identity_basis !== "verified-loci-study-handoff" ||
      (r.binding_source !== "manifest-and-study-handoff" && r.binding_source !== "study-handoff-id") ||
      typeof r.exported_input_file_sha256 !== "string" || !SHA_RE.test(r.exported_input_file_sha256) ||
      typeof r.exported_input_array_sha256 !== "string" || !SHA_RE.test(r.exported_input_array_sha256) ||
      (r.exported_input_axes !== "YX" && r.exported_input_axes !== "ZYX") ||
      !Array.isArray(r.exported_input_shape) ||
      r.exported_input_shape.length !== (r.exported_input_axes === "ZYX" ? 3 : 2) ||
      r.exported_input_shape.some((dim) => !Number.isSafeInteger(dim) || Number(dim) < 1) ||
      r.mask_origin_verified_by_loci !== false ||
      r.model_validation !== "unknown") {
    throw new Error("The μSAM handoff binding provenance is invalid.");
  }
  noPathText(r.exported_input_dtype, "μSAM exported dtype", 64);
  return r as unknown as ResearchUsamHandoffBinding;
}

export function checkedUsamHandoffRecord(value: unknown): ResearchUsamHandoffRecord {
  const keys = [
    "schema", "handoff_id", "export_origin", "source_id", "source_sha256", "source_name",
    "selection", "measurement_channel", "geometry", "calibration", "input", "label_profile",
    "upstream_reference", "validation", "manifest_sha256",
  ];
  const r = exactRecord(value, keys, "μSAM handoff record");
  if (Object.keys(r).length !== keys.length ||
      r.schema !== "loci.usam-handoff/v1" ||
      r.export_origin !== "verified-loci-native-export" ||
      r.validation !== "not-established" ||
      typeof r.handoff_id !== "string" || !ID_RE.test(r.handoff_id) ||
      typeof r.source_id !== "string" || !ID_RE.test(r.source_id) ||
      typeof r.source_sha256 !== "string" || !SHA_RE.test(r.source_sha256) ||
      typeof r.manifest_sha256 !== "string" || !SHA_RE.test(r.manifest_sha256)) {
    throw new Error("The stored μSAM handoff record is invalid.");
  }
  noPathText(r.source_name, "μSAM source name", 256);
  const selection = checkedSelection(r.selection);
  checkGrid(r, selection);
  const upstream = exactRecord(r.upstream_reference, ["tool", "version", "commit"], "μSAM reference");
  if (upstream.tool !== "micro-sam" || upstream.version !== "2.0.1" ||
      upstream.commit !== "d45ab70ece93a9eb3ca1e237b9067767b0a18263") throw new Error("Unknown μSAM reference.");
  return r as unknown as ResearchUsamHandoffRecord;
}

export function checkedUsamHandoffRecords(value: unknown): ResearchUsamHandoffRecord[] {
  const payload = Array.isArray(value)
    ? value
    : exactRecord(value, ["handoffs"], "μSAM handoff list").handoffs;
  if (!Array.isArray(payload)) {
    throw new Error("Invalid μSAM handoff list.");
  }
  return payload.map((item) => checkedUsamHandoffRecord(item));
}

export function checkedUsamHandoffReceipt(
  value: unknown,
  sourceId: string,
  sourceSha256: string,
  selection: ResearchSelection,
): ResearchUsamHandoffReceipt {
  const keys = [
    "schema", "basename", "handoff_id", "manifest_sha256", "export_origin", "source_id",
    "source_sha256", "selection", "measurement_channel", "geometry", "calibration",
    "input", "label_profile", "validation", "artifacts",
  ];
  const r = exactRecord(value, keys, "μSAM handoff receipt");
  if (Object.keys(r).length !== keys.length ||
      r.schema !== "loci.usam-handoff-receipt/v1" ||
      r.export_origin !== "verified-loci-native-export" ||
      r.validation !== "not-established" ||
      r.source_id !== sourceId || r.source_sha256 !== sourceSha256 ||
      typeof r.handoff_id !== "string" || !ID_RE.test(r.handoff_id) ||
      typeof r.manifest_sha256 !== "string" || !SHA_RE.test(r.manifest_sha256)) {
    throw new Error("The μSAM handoff receipt does not match this source.");
  }
  noPathText(r.basename, "μSAM handoff folder name", 120);
  const receiptSelection = checkedSelection(r.selection);
  if (!sameUsamSelection(receiptSelection, selection)) {
    throw new Error("The μSAM handoff receipt selection disagrees with this view.");
  }
  const input = checkGrid(r, selection);
  const artifacts = exactRecord(r.artifacts, ["input.tif", "manifest.json", "README.md"], "μSAM handoff artifacts");
  if (Object.keys(artifacts).length !== 3) {
    throw new Error("The μSAM handoff bundle is incomplete.");
  }
  for (const item of Object.values(artifacts)) {
    const entry = exactRecord(item, ["sha256", "size_bytes"], "μSAM handoff artifact");
    if (typeof entry.sha256 !== "string" || !SHA_RE.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size_bytes) || Number(entry.size_bytes) < 1) {
      throw new Error("The μSAM handoff artifact hash is invalid.");
    }
  }
  const tiff = artifacts["input.tif"] as { sha256: string; size_bytes: number };
  if (tiff.sha256 !== input.file_sha256 || tiff.size_bytes !== input.file_size_bytes) {
    throw new Error("The μSAM receipt has conflicting input TIFF identities.");
  }
  return r as unknown as ResearchUsamHandoffReceipt;
}
