import {
  CAPABILITY_MANIFEST_SCHEMA,
  JOB_EVENT_SCHEMA,
  JOB_SPEC_SCHEMA,
  MAX_PROJECT_SOURCES,
  MODEL_MANIFEST_SCHEMA,
  PROJECT_MANIFEST_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  SOURCE_DESCRIPTOR_SCHEMA,
  VALIDATION_REPORT_SCHEMA,
  WORKSPACE_RECOMMENDATION_SCHEMA,
  type CapabilityId,
  type CapabilityManifest,
  type JobEvent,
  type JobSpec,
  type JobState,
  type ModelEvidenceStatus,
  type ModelManifest,
  type ProjectManifestV1,
  type ResultManifest,
  type SourceDescriptorV1,
  type SourceFingerprint,
  type ValidationMetric,
  type ValidationReport,
  type WorkspaceRecommendation,
} from "./foundation-contracts";
import { recommendWorkspace } from "./source-routing";

type UnknownRecord = Record<string, unknown>;

export type FoundationValidationCode =
  | "invalid-type"
  | "invalid-value"
  | "unexpected-field"
  | "unsafe-renderer-payload"
  | "duplicate-id"
  | "broken-reference";

export class FoundationValidationError extends Error {
  constructor(
    public readonly code: FoundationValidationCode,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "FoundationValidationError";
  }
}

function fail(code: FoundationValidationCode, path: string, message: string): never {
  throw new FoundationValidationError(code, path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-type", path, `${path} must be an object.`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("unexpected-field", `${path}.${key}`, `${path}.${key} is not part of this schema.`);
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      fail("invalid-value", `${path}.${key}`, `${path}.${key} is required.`);
    }
  }
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid-type", path, `${path} must be an array.`);
  return value;
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > 16_384) {
    fail("invalid-value", path, `${path} must be a${allowEmpty ? "" : " non-empty"} bounded string.`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    fail("invalid-value", path, `${path} has an unsupported value.`);
  }
  return value as T;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid-value", path, `${path} must be a finite number.`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  const parsed = finite(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail("invalid-value", path, `${path} must be a safe integer of at least ${minimum}.`);
  }
  return parsed;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("invalid-type", path, `${path} must be boolean.`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function identifier(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/.test(parsed)) {
    fail("invalid-value", path, `${path} must be a stable identifier.`);
  }
  return parsed;
}

function isoDate(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    fail("invalid-value", path, `${path} must be an ISO-8601 timestamp.`);
  }
  return parsed;
}

function sha256(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!/^[a-fA-F0-9]{64}$/.test(parsed)) {
    fail("invalid-value", path, `${path} must be a SHA-256 hex digest.`);
  }
  return parsed.toLowerCase();
}

function sameSha256(left: string | null, right: string | null): boolean {
  return left === null || right === null
    ? left === right
    : left.toLowerCase() === right.toLowerCase();
}

function httpsUrl(value: unknown, path: string): string {
  const parsed = string(value, path);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    fail("invalid-value", path, `${path} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    fail("invalid-value", path, `${path} must be an HTTPS URL without embedded credentials.`);
  }
  return parsed;
}

function nullableHttpsUrl(value: unknown, path: string): string | null {
  return value === null ? null : httpsUrl(value, path);
}

function relativeLabel(value: unknown, path: string): string {
  const parsed = string(value, path);
  const normalized = parsed.replaceAll("\\", "/");
  const components = normalized.split("/");
  if (
    parsed !== normalized ||
    parsed !== parsed.normalize("NFC") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(normalized) ||
    components.some((component) => !component || component === "." || component === "..")
  ) {
    fail(
      "unsafe-renderer-payload",
      path,
      `${path} must be a normalized, portable relative display label.`,
    );
  }
  return parsed;
}

function portableRelativeLabelKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function unique(values: string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail("duplicate-id", path, `${path} contains duplicate identifier ${value}.`);
    seen.add(value);
  }
}

const FORBIDDEN_RENDERER_KEY = /(?:password|passphrase|private.?key|ssh.?key|credential|secret|authorization|authentication|bearer|cookie|signed.?cookie|oauth|session.?id|(?:auth|access|api|refresh|identity).?token|(?:auth|access|api).?(?:key|code)|token$|jwt|client.?cert(?:ificate)?|certificate|pem|keytab|connection.?string|canonical.?path|absolute.?path|source.?path|source.?locator|raw.?pixels|preview.?data|ssh.?config)/i;
const EMBEDDED_LOCAL_PATH = /(?:^|[\s"'(=:\[])(?:\/(?!\/)[^\s"'<>]*|[a-zA-Z]:[\\/]|\\\\[^\\\s]+\\)/;
const SENSITIVE_RENDERER_VALUE = /(?:-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----|(?:^|\s)Bearer\s+\S+|(?:^|\s)(?:sk|ghp|xox[baprs])-[A-Za-z0-9_-]{12,}(?:\s|$)|(?:^|\s)[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?:\s|$))/i;

/** Reject hidden path, credential, binary, and non-JSON payloads before renderer exposure. */
export function assertRendererSafePayload(value: unknown, rootPath = "$project"): void {
  const active = new WeakSet<object>();
  const visit = (current: unknown, path: string): void => {
    if (typeof current === "string") {
      const normalized = current.replaceAll("\\", "/");
      if (
        current.includes("\0") ||
        normalized.startsWith("/") ||
        /^[a-zA-Z]:\//.test(normalized) ||
        /^file:/i.test(normalized) ||
        EMBEDDED_LOCAL_PATH.test(current)
      ) {
        fail("unsafe-renderer-payload", path, `${path} contains an absolute local path.`);
      }
      if (SENSITIVE_RENDERER_VALUE.test(current)) {
        fail("unsafe-renderer-payload", path, `${path} contains credential-like material.`);
      }
      return;
    }
    if (typeof current === "number") {
      finite(current, path);
      return;
    }
    if (current === null || typeof current === "boolean") return;
    if (typeof current !== "object") {
      fail("unsafe-renderer-payload", path, `${path} is not JSON-safe.`);
    }
    if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) {
      fail("unsafe-renderer-payload", path, `${path} contains raw binary data.`);
    }
    if (
      !Array.isArray(current) &&
      Object.getPrototypeOf(current) !== Object.prototype &&
      Object.getPrototypeOf(current) !== null
    ) {
      fail("unsafe-renderer-payload", path, `${path} contains a non-JSON object.`);
    }
    if (active.has(current)) fail("unsafe-renderer-payload", path, `${path} contains a cycle.`);
    active.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else {
      for (const [key, child] of Object.entries(current)) {
        if (FORBIDDEN_RENDERER_KEY.test(key)) {
          fail("unsafe-renderer-payload", `${path}.${key}`, `${path}.${key} is main-process-only data.`);
        }
        visit(child, `${path}.${key}`);
      }
    }
    active.delete(current);
  };
  visit(value, rootPath);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as UnknownRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requireSemanticMatch(actual: unknown, expected: unknown, path: string, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("invalid-value", path, message);
  }
}

function validateFingerprint(value: unknown, path: string): SourceFingerprint {
  const item = record(value, path);
  const status = oneOf(item.status, ["pending", "verified", "failed"] as const, `${path}.status`);
  exactKeys(
    item,
    status === "failed"
      ? ["status", "algorithm", "sha256", "verifiedAt", "reasonCode"]
      : ["status", "algorithm", "sha256", "verifiedAt"],
    path,
  );
  oneOf(item.algorithm, ["sha256"] as const, `${path}.algorithm`);
  if (status === "verified") {
    sha256(item.sha256, `${path}.sha256`);
    isoDate(item.verifiedAt, `${path}.verifiedAt`);
  } else if (item.sha256 !== null || item.verifiedAt !== null) {
    fail("invalid-value", path, `${path} cannot include a digest or verification time before verification.`);
  }
  if (status === "failed") identifier(item.reasonCode, `${path}.reasonCode`);
  return value as SourceFingerprint;
}

export function validateSourceDescriptorV1(value: unknown): SourceDescriptorV1 {
  const item = record(value, "$descriptor");
  exactKeys(item, [
    "schemaVersion", "displayName", "relativeLabel", "format", "formatAdapter", "dimensions",
    "axes", "channels", "colorModel", "calibration", "pyramid", "chunks", "access", "fingerprint", "ambiguity",
  ], "$descriptor");
  oneOf(item.schemaVersion, [SOURCE_DESCRIPTOR_SCHEMA] as const, "$descriptor.schemaVersion");
  string(item.displayName, "$descriptor.displayName");
  relativeLabel(item.relativeLabel, "$descriptor.relativeLabel");
  string(item.format, "$descriptor.format");
  oneOf(item.formatAdapter, ["raster", "tiff", "imaris-hdf5", "generic"] as const, "$descriptor.formatAdapter");
  const dimensions = record(item.dimensions, "$descriptor.dimensions");
  exactKeys(dimensions, ["width", "height"], "$descriptor.dimensions");
  integer(dimensions.width, "$descriptor.dimensions.width", 1);
  integer(dimensions.height, "$descriptor.dimensions.height", 1);
  const axes = array(item.axes, "$descriptor.axes");
  if (axes.length < 2 || axes.length > 5) fail("invalid-value", "$descriptor.axes", "A source must declare two to five axes.");
  const axisNames = axes.map((axis, index) => {
    const axisRecord = record(axis, `$descriptor.axes[${index}]`);
    exactKeys(axisRecord, ["name", "length", "unit", "spacing"], `$descriptor.axes[${index}]`);
    const name = oneOf(axisRecord.name, ["X", "Y", "Z", "C", "T"] as const, `$descriptor.axes[${index}].name`);
    integer(axisRecord.length, `$descriptor.axes[${index}].length`, 1);
    if (axisRecord.unit !== null) string(axisRecord.unit, `$descriptor.axes[${index}].unit`);
    if (axisRecord.spacing !== null && finite(axisRecord.spacing, `$descriptor.axes[${index}].spacing`) <= 0) {
      fail("invalid-value", `$descriptor.axes[${index}].spacing`, "Axis spacing must be positive.");
    }
    return name;
  });
  unique(axisNames, "$descriptor.axes");
  if (!axisNames.includes("X") || !axisNames.includes("Y")) {
    fail("invalid-value", "$descriptor.axes", "Source axes must include X and Y.");
  }
  const xAxis = axes.map((axis) => record(axis, "$axis")).find((axis) => axis.name === "X");
  const yAxis = axes.map((axis) => record(axis, "$axis")).find((axis) => axis.name === "Y");
  if (xAxis?.length !== dimensions.width || yAxis?.length !== dimensions.height) {
    fail("invalid-value", "$descriptor.axes", "X/Y axis lengths must match source dimensions.");
  }
  const channels = array(item.channels, "$descriptor.channels");
  if (channels.length < 1 || channels.length > 256) fail("invalid-value", "$descriptor.channels", "Channel count is out of range.");
  channels.forEach((channel, index) => {
    const channelRecord = record(channel, `$descriptor.channels[${index}]`);
    exactKeys(channelRecord, ["index", "name", "dtype", "colorSource", "rangeSource"], `$descriptor.channels[${index}]`);
    if (integer(channelRecord.index, `$descriptor.channels[${index}].index`) !== index) {
      fail("invalid-value", `$descriptor.channels[${index}].index`, "Channel indices must be contiguous and zero-based.");
    }
    string(channelRecord.name, `$descriptor.channels[${index}].name`);
    string(channelRecord.dtype, `$descriptor.channels[${index}].dtype`);
    oneOf(channelRecord.colorSource, ["declared", "rgb-component", "loci-fallback", "not-applicable"] as const, `$descriptor.channels[${index}].colorSource`);
    oneOf(channelRecord.rangeSource, ["declared", "dtype", "sampled", "not-applicable"] as const, `$descriptor.channels[${index}].rangeSource`);
  });
  const cAxis = axes.map((axis) => record(axis, "$axis")).find((axis) => axis.name === "C");
  if (cAxis && cAxis.length !== channels.length) {
    fail("invalid-value", "$descriptor.channels", "Channel descriptors must match the declared C axis.");
  }
  oneOf(item.colorModel, ["intensity", "interleaved-rgb", "channel-composite", "unknown"] as const, "$descriptor.colorModel");
  if (item.calibration !== null) {
    const calibration = record(item.calibration, "$descriptor.calibration");
    exactKeys(calibration, ["source", "unit", "voxelSize", "extents"], "$descriptor.calibration");
    oneOf(calibration.source, ["declared-metadata"] as const, "$descriptor.calibration.source");
    string(calibration.unit, "$descriptor.calibration.unit");
    const voxel = array(calibration.voxelSize, "$descriptor.calibration.voxelSize");
    if (voxel.length !== 3) fail("invalid-value", "$descriptor.calibration.voxelSize", "Voxel size must have three values.");
    voxel.forEach((spacing, index) => {
      if (spacing !== null && finite(spacing, `$descriptor.calibration.voxelSize[${index}]`) <= 0) {
        fail("invalid-value", `$descriptor.calibration.voxelSize[${index}]`, "Voxel spacing must be positive.");
      }
    });
    if (calibration.extents !== null) {
      array(calibration.extents, "$descriptor.calibration.extents").forEach((extent, index) => {
        const values = array(extent, `$descriptor.calibration.extents[${index}]`);
        if (values.length !== 2 || finite(values[1], `${index}[1]`) <= finite(values[0], `${index}[0]`)) {
          fail("invalid-value", `$descriptor.calibration.extents[${index}]`, "Physical extents must be increasing pairs.");
        }
      });
    }
  }
  if (item.pyramid !== null) {
    const pyramid = record(item.pyramid, "$descriptor.pyramid");
    exactKeys(pyramid, ["levels", "selectedLevel", "selectedShape", "tiled"], "$descriptor.pyramid");
    const levels = integer(pyramid.levels, "$descriptor.pyramid.levels", 1);
    const selectedLevel = integer(pyramid.selectedLevel, "$descriptor.pyramid.selectedLevel");
    if (selectedLevel >= levels) fail("invalid-value", "$descriptor.pyramid.selectedLevel", "Selected level must exist.");
    const shape = array(pyramid.selectedShape, "$descriptor.pyramid.selectedShape");
    if (shape.length !== 3) fail("invalid-value", "$descriptor.pyramid.selectedShape", "Selected shape must have three values.");
    shape.forEach((size, index) => {
      if (size !== null) integer(size, `$descriptor.pyramid.selectedShape[${index}]`, 1);
    });
    if (pyramid.tiled !== null) bool(pyramid.tiled, "$descriptor.pyramid.tiled");
  }
  const chunks = record(item.chunks, "$descriptor.chunks");
  exactKeys(chunks, ["storage", "shape"], "$descriptor.chunks");
  oneOf(chunks.storage, ["contiguous", "striped", "tiled", "hdf5-chunked", "unknown"] as const, "$descriptor.chunks.storage");
  if (chunks.shape !== null) array(chunks.shape, "$descriptor.chunks.shape").forEach((size, index) => integer(size, `$descriptor.chunks.shape[${index}]`, 1));
  const access = record(item.access, "$descriptor.access");
  exactKeys(access, ["mode", "canRender", "canAnalyze", "canExportRenderedView", "canExportNativeData", "provisionalUntilFingerprintVerified", "reason"], "$descriptor.access");
  oneOf(access.mode, ["full", "overview"] as const, "$descriptor.access.mode");
  ["canRender", "canAnalyze", "canExportRenderedView", "canExportNativeData", "provisionalUntilFingerprintVerified"].forEach((key) => bool(access[key], `$descriptor.access.${key}`));
  nullableString(access.reason, "$descriptor.access.reason");
  const fingerprint = validateFingerprint(item.fingerprint, "$descriptor.fingerprint");
  if (access.provisionalUntilFingerprintVerified !== (fingerprint.status !== "verified")) {
    fail("invalid-value", "$descriptor.access.provisionalUntilFingerprintVerified", "Provisional state must reflect fingerprint verification.");
  }
  if (access.mode === "overview" && (access.canAnalyze || access.canExportNativeData)) {
    fail("invalid-value", "$descriptor.access", "Overview-only sources cannot advertise native analysis or export.");
  }
  array(item.ambiguity, "$descriptor.ambiguity").forEach((ambiguity, index) => {
    const ambiguityRecord = record(ambiguity, `$descriptor.ambiguity[${index}]`);
    exactKeys(ambiguityRecord, ["code", "summary"], `$descriptor.ambiguity[${index}]`);
    oneOf(ambiguityRecord.code, ["biological-purpose-unknown", "page-axis-unknown", "physical-calibration-missing", "format-adapter-generic"] as const, `$descriptor.ambiguity[${index}].code`);
    string(ambiguityRecord.summary, `$descriptor.ambiguity[${index}].summary`);
  });
  return value as SourceDescriptorV1;
}

export function validateWorkspaceRecommendation(value: unknown): WorkspaceRecommendation {
  const item = record(value, "$workspace");
  exactKeys(item, ["schemaVersion", "inferredWorkspace", "workspace", "decision", "evidence", "applicablePresets", "requiredCapabilities", "userOverride", "analysis"], "$workspace");
  oneOf(item.schemaVersion, [WORKSPACE_RECOMMENDATION_SCHEMA] as const, "$workspace.schemaVersion");
  const workspaces = ["generic-2d", "pathology-2d", "scientific-volume"] as const;
  const inferred = oneOf(item.inferredWorkspace, workspaces, "$workspace.inferredWorkspace");
  const effective = oneOf(item.workspace, workspaces, "$workspace.workspace");
  const decision = oneOf(item.decision, ["structural", "safe-default", "user-override"] as const, "$workspace.decision");
  array(item.evidence, "$workspace.evidence").forEach((evidence, index) => {
    const evidenceRecord = record(evidence, `$workspace.evidence[${index}]`);
    exactKeys(evidenceRecord, ["code", "summary"], `$workspace.evidence[${index}]`);
    identifier(evidenceRecord.code, `$workspace.evidence[${index}].code`);
    string(evidenceRecord.summary, `$workspace.evidence[${index}].summary`);
  });
  array(item.applicablePresets, "$workspace.applicablePresets").forEach((preset, index) => oneOf(preset, ["generic-display", "brightfield-cell", "fluorescence", "h-and-e-display", "ihc-display", "multichannel-display", "volume-display"] as const, `$workspace.applicablePresets[${index}]`));
  const requiredCapabilities = array(item.requiredCapabilities, "$workspace.requiredCapabilities");
  requiredCapabilities.forEach((capability, index) => oneOf(capability, ["pathology-large-2d", "scientific-volumes"] as const, `$workspace.requiredCapabilities[${index}]`));
  const expectedCapabilities: string[] = [];
  if (inferred === "scientific-volume" || effective === "scientific-volume") expectedCapabilities.push("scientific-volumes");
  if (inferred === "pathology-2d" || effective === "pathology-2d") expectedCapabilities.push("pathology-large-2d");
  if (JSON.stringify(requiredCapabilities) !== JSON.stringify(expectedCapabilities)) {
    fail("invalid-value", "$workspace.requiredCapabilities", "Required capabilities must match the effective workspace.");
  }
  if (item.userOverride !== null) oneOf(item.userOverride, workspaces, "$workspace.userOverride");
  if (decision === "user-override") {
    if (item.userOverride === null || item.userOverride !== effective) fail("invalid-value", "$workspace.userOverride", "A user override must equal the effective workspace.");
  } else if (item.userOverride !== null || inferred !== effective) {
    fail("invalid-value", "$workspace", "A non-overridden recommendation must use the inferred workspace.");
  }
  const analysis = record(item.analysis, "$workspace.analysis");
  exactKeys(analysis, ["autoRun", "recommendedModelId", "reason"], "$workspace.analysis");
  if (analysis.autoRun !== false || analysis.recommendedModelId !== null) {
    fail("invalid-value", "$workspace.analysis", "Workspace routing must never auto-run or biologically infer a model.");
  }
  string(analysis.reason, "$workspace.analysis.reason");
  return value as WorkspaceRecommendation;
}

const CAPABILITY_IDS = ["cell-analysis", "pathology-large-2d", "scientific-volumes", "remote-compute"] as const;
const EVIDENCE_STATES = ["unvalidated", "experimental", "validated-for-domain", "not-recommended"] as const;

export function validateCapabilityManifest(value: unknown): CapabilityManifest {
  const item = record(value, "$capability");
  exactKeys(item, ["schemaVersion", "capabilityId", "name", "version", "appCompatibility", "artifact", "dependencies", "licenses"], "$capability");
  oneOf(item.schemaVersion, [CAPABILITY_MANIFEST_SCHEMA] as const, "$capability.schemaVersion");
  const capabilityId = oneOf(item.capabilityId, CAPABILITY_IDS, "$capability.capabilityId");
  string(item.name, "$capability.name");
  string(item.version, "$capability.version");
  const compatibility = record(item.appCompatibility, "$capability.appCompatibility");
  exactKeys(compatibility, ["minimum", "maximumExclusive"], "$capability.appCompatibility");
  string(compatibility.minimum, "$capability.appCompatibility.minimum");
  nullableString(compatibility.maximumExclusive, "$capability.appCompatibility.maximumExclusive");
  const artifact = record(item.artifact, "$capability.artifact");
  exactKeys(artifact, ["sha256", "sizeBytes", "sourceUrl", "offlineImportSupported"], "$capability.artifact");
  sha256(artifact.sha256, "$capability.artifact.sha256");
  integer(artifact.sizeBytes, "$capability.artifact.sizeBytes", 1);
  httpsUrl(artifact.sourceUrl, "$capability.artifact.sourceUrl");
  bool(artifact.offlineImportSupported, "$capability.artifact.offlineImportSupported");
  const dependencyIds = array(item.dependencies, "$capability.dependencies").map((dependency, index) => {
    const dependencyRecord = record(dependency, `$capability.dependencies[${index}]`);
    exactKeys(dependencyRecord, ["capabilityId", "versionRange"], `$capability.dependencies[${index}]`);
    const id = oneOf(dependencyRecord.capabilityId, CAPABILITY_IDS, `$capability.dependencies[${index}].capabilityId`);
    if (id === capabilityId) fail("invalid-value", `$capability.dependencies[${index}]`, "A capability cannot depend on itself.");
    string(dependencyRecord.versionRange, `$capability.dependencies[${index}].versionRange`);
    return id;
  });
  unique(dependencyIds, "$capability.dependencies");
  const licenses = array(item.licenses, "$capability.licenses");
  if (!licenses.length) fail("invalid-value", "$capability.licenses", "Capability licenses must be declared.");
  licenses.forEach((license, index) => {
    const licenseRecord = record(license, `$capability.licenses[${index}]`);
    exactKeys(licenseRecord, ["component", "spdxId", "sourceUrl"], `$capability.licenses[${index}]`);
    string(licenseRecord.component, `$capability.licenses[${index}].component`);
    string(licenseRecord.spdxId, `$capability.licenses[${index}].spdxId`);
    httpsUrl(licenseRecord.sourceUrl, `$capability.licenses[${index}].sourceUrl`);
  });
  return value as CapabilityManifest;
}

function evidenceState(value: unknown, path: string): ModelEvidenceStatus {
  return oneOf(value, EVIDENCE_STATES, path);
}

export function validateModelManifest(value: unknown): ModelManifest {
  const item = record(value, "$model");
  exactKeys(item, ["schemaVersion", "modelId", "name", "version", "artifact", "runtime", "intendedDomain", "preprocessing", "postprocessing", "rights", "evidenceStatus", "validationReportIds", "knownFailureModes"], "$model");
  oneOf(item.schemaVersion, [MODEL_MANIFEST_SCHEMA] as const, "$model.schemaVersion");
  identifier(item.modelId, "$model.modelId");
  string(item.name, "$model.name");
  string(item.version, "$model.version");
  const artifact = record(item.artifact, "$model.artifact");
  exactKeys(artifact, ["sha256", "sizeBytes", "bundled", "sourceUrl"], "$model.artifact");
  if (artifact.sha256 !== null) sha256(artifact.sha256, "$model.artifact.sha256");
  if (artifact.sizeBytes !== null) integer(artifact.sizeBytes, "$model.artifact.sizeBytes", 1);
  bool(artifact.bundled, "$model.artifact.bundled");
  nullableHttpsUrl(artifact.sourceUrl, "$model.artifact.sourceUrl");
  if (artifact.bundled && (artifact.sha256 === null || artifact.sizeBytes === null)) {
    fail("invalid-value", "$model.artifact", "A bundled artifact must declare its digest and size.");
  }
  const runtime = record(item.runtime, "$model.runtime");
  exactKeys(runtime, ["backend", "requiredVersion"], "$model.runtime");
  string(runtime.backend, "$model.runtime.backend");
  string(runtime.requiredVersion, "$model.runtime.requiredVersion");
  const domain = record(item.intendedDomain, "$model.intendedDomain");
  exactKeys(domain, ["summary", "modalities", "organisms", "channels", "pixelSize"], "$model.intendedDomain");
  string(domain.summary, "$model.intendedDomain.summary");
  for (const key of ["modalities", "organisms", "channels"] as const) {
    array(domain[key], `$model.intendedDomain.${key}`).forEach((entry, index) => string(entry, `$model.intendedDomain.${key}[${index}]`));
  }
  if (domain.pixelSize !== null) {
    const pixel = record(domain.pixelSize, "$model.intendedDomain.pixelSize");
    exactKeys(pixel, ["minimum", "maximum", "unit"], "$model.intendedDomain.pixelSize");
    const minimum = finite(pixel.minimum, "$model.intendedDomain.pixelSize.minimum");
    const maximum = finite(pixel.maximum, "$model.intendedDomain.pixelSize.maximum");
    if (minimum <= 0 || maximum < minimum) fail("invalid-value", "$model.intendedDomain.pixelSize", "Pixel-size bounds are invalid.");
    string(pixel.unit, "$model.intendedDomain.pixelSize.unit");
  }
  for (const key of ["preprocessing", "postprocessing", "validationReportIds", "knownFailureModes"] as const) {
    array(item[key], `$model.${key}`).forEach((entry, index) => key === "validationReportIds" ? identifier(entry, `$model.${key}[${index}]`) : string(entry, `$model.${key}[${index}]`));
  }
  unique(array(item.validationReportIds, "$model.validationReportIds") as string[], "$model.validationReportIds");
  const rights = record(item.rights, "$model.rights");
  exactKeys(rights, ["codeLicense", "checkpointLicense", "redistribution", "commercialUse", "trainingDataLineage"], "$model.rights");
  string(rights.codeLicense, "$model.rights.codeLicense");
  string(rights.checkpointLicense, "$model.rights.checkpointLicense");
  oneOf(rights.redistribution, ["permitted", "not-permitted", "unknown"] as const, "$model.rights.redistribution");
  oneOf(rights.commercialUse, ["permitted", "restricted", "not-permitted", "unknown"] as const, "$model.rights.commercialUse");
  string(rights.trainingDataLineage, "$model.rights.trainingDataLineage");
  const status = evidenceState(item.evidenceStatus, "$model.evidenceStatus");
  if (status === "validated-for-domain" && array(item.validationReportIds, "$model.validationReportIds").length === 0) {
    fail("invalid-value", "$model.validationReportIds", "A validated model must cite a validation report.");
  }
  return value as ModelManifest;
}

function validateMetric(value: unknown, path: string): ValidationMetric {
  const item = record(value, path);
  exactKeys(item, ["id", "value", "unit", "higherIsBetter"], path);
  identifier(item.id, `${path}.id`);
  finite(item.value, `${path}.value`);
  string(item.unit, `${path}.unit`, true);
  bool(item.higherIsBetter, `${path}.higherIsBetter`);
  return value as ValidationMetric;
}

function validateViewerDisplaySettings(value: unknown, path: string): void {
  const item = record(value, path);
  exactKeys(item, ["blackPoint", "whitePoint", "brightness", "contrast", "gamma", "saturation", "red", "green", "blue"], path);
  const black = finite(item.blackPoint, `${path}.blackPoint`);
  const white = finite(item.whitePoint, `${path}.whitePoint`);
  const brightness = finite(item.brightness, `${path}.brightness`);
  const contrast = finite(item.contrast, `${path}.contrast`);
  const gamma = finite(item.gamma, `${path}.gamma`);
  const saturation = finite(item.saturation, `${path}.saturation`);
  if (black < 0 || white > 1 || black >= white) fail("invalid-value", path, "Display black/white points are invalid.");
  if (brightness < -50 || brightness > 50) fail("invalid-value", `${path}.brightness`, "Brightness must be between -50 and 50.");
  if (contrast < 0 || contrast > 200) fail("invalid-value", `${path}.contrast`, "Contrast must be between 0 and 200.");
  if (gamma < 0.2 || gamma > 3) fail("invalid-value", `${path}.gamma`, "Gamma must be between 0.2 and 3.");
  if (saturation < 0 || saturation > 200) fail("invalid-value", `${path}.saturation`, "Saturation must be between 0 and 200.");
  ["red", "green", "blue"].forEach((key) => bool(item[key], `${path}.${key}`));
}

const CLASSICAL_JOB_SETTING_KEYS = [
  "image_mode", "polarity", "expected_diameter_px", "min_area_px", "sensitivity",
  "smoothing_px", "split_touching", "exclude_border",
] as const;
const CELLPOSE_JOB_SETTING_KEYS = [
  "max_edge_px", "diameter_px", "flow_threshold", "cellprob_threshold", "min_size_px",
  "max_size_fraction", "niter", "batch_size", "resample", "augment", "tile_overlap",
  "normalize", "percentile_low", "percentile_high", "tile_norm_blocksize",
  "sharpen_radius", "smooth_radius", "invert", "device",
] as const;
const CLASSICAL_JOB_SETTING_KEY_SET = new Set<string>(CLASSICAL_JOB_SETTING_KEYS);
const CELLPOSE_JOB_SETTING_KEY_SET = new Set<string>(CELLPOSE_JOB_SETTING_KEYS);

function boundedNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  minimumExclusive = false,
): number {
  const parsed = finite(value, path);
  if ((minimumExclusive ? parsed <= minimum : parsed < minimum) || parsed > maximum) {
    fail("invalid-value", path, `${path} is outside the supported range.`);
  }
  return parsed;
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = integer(value, path, minimum);
  if (parsed > maximum) fail("invalid-value", path, `${path} is outside the supported range.`);
  return parsed;
}

/**
 * JobSpec v1 freezes only the currently executable segmentation settings.
 * Other job kinds keep settings null until their own versioned schemas exist.
 */
function validateSegmentJobSettings(value: unknown, path: string): void {
  const item = record(value, path);
  const keys = Object.keys(item);
  const usesClassical = keys.some((key) => CLASSICAL_JOB_SETTING_KEY_SET.has(key));
  const usesCellpose = keys.some((key) => CELLPOSE_JOB_SETTING_KEY_SET.has(key));
  if (usesClassical === usesCellpose) {
    fail("invalid-value", path, "Segmentation settings must match one supported profile schema.");
  }
  if (usesClassical) {
    exactKeys(item, CLASSICAL_JOB_SETTING_KEYS, path);
    oneOf(item.image_mode, ["auto", "brightfield", "fluorescence"] as const, `${path}.image_mode`);
    oneOf(item.polarity, ["auto", "dark", "bright"] as const, `${path}.polarity`);
    boundedNumber(item.expected_diameter_px, `${path}.expected_diameter_px`, 4, 1_000);
    boundedInteger(item.min_area_px, `${path}.min_area_px`, 1, 10_000_000);
    boundedNumber(item.sensitivity, `${path}.sensitivity`, -1, 1);
    boundedNumber(item.smoothing_px, `${path}.smoothing_px`, 0, 20);
    bool(item.split_touching, `${path}.split_touching`);
    bool(item.exclude_border, `${path}.exclude_border`);
    return;
  }

  exactKeys(item, CELLPOSE_JOB_SETTING_KEYS, path);
  boundedInteger(item.max_edge_px, `${path}.max_edge_px`, 64, 10_000);
  boundedNumber(item.diameter_px, `${path}.diameter_px`, 0, 10_000);
  boundedNumber(item.flow_threshold, `${path}.flow_threshold`, 0, 3);
  boundedNumber(item.cellprob_threshold, `${path}.cellprob_threshold`, -10, 10);
  boundedInteger(item.min_size_px, `${path}.min_size_px`, 0, 10_000_000);
  boundedNumber(item.max_size_fraction, `${path}.max_size_fraction`, 0, 1, true);
  boundedInteger(item.niter, `${path}.niter`, 1, 10_000);
  boundedInteger(item.batch_size, `${path}.batch_size`, 1, 256);
  bool(item.resample, `${path}.resample`);
  bool(item.augment, `${path}.augment`);
  boundedNumber(item.tile_overlap, `${path}.tile_overlap`, 0.05, 0.5);
  bool(item.normalize, `${path}.normalize`);
  const percentileLow = boundedNumber(item.percentile_low, `${path}.percentile_low`, 0, 100);
  const percentileHigh = boundedNumber(item.percentile_high, `${path}.percentile_high`, 0, 100);
  if (percentileLow >= percentileHigh) {
    fail("invalid-value", `${path}.percentile_high`, "Cellpose percentiles must satisfy low < high.");
  }
  boundedInteger(item.tile_norm_blocksize, `${path}.tile_norm_blocksize`, 0, 10_000);
  boundedNumber(item.sharpen_radius, `${path}.sharpen_radius`, 0, 10_000);
  boundedNumber(item.smooth_radius, `${path}.smooth_radius`, 0, 10_000);
  bool(item.invert, `${path}.invert`);
  oneOf(item.device, ["auto", "cpu", "mps", "cuda"] as const, `${path}.device`);
}

export function validateValidationReport(value: unknown): ValidationReport {
  const item = record(value, "$validation");
  exactKeys(item, ["schemaVersion", "reportId", "modelId", "modelSha256", "createdAt", "evidenceStatus", "declaredDomain", "dataset", "frozenConfigurationSha256", "metrics", "gates", "strata", "knownFailureModes", "claimBoundary"], "$validation");
  oneOf(item.schemaVersion, [VALIDATION_REPORT_SCHEMA] as const, "$validation.schemaVersion");
  identifier(item.reportId, "$validation.reportId");
  identifier(item.modelId, "$validation.modelId");
  if (item.modelSha256 !== null) sha256(item.modelSha256, "$validation.modelSha256");
  isoDate(item.createdAt, "$validation.createdAt");
  const status = evidenceState(item.evidenceStatus, "$validation.evidenceStatus");
  string(item.declaredDomain, "$validation.declaredDomain");
  const dataset = record(item.dataset, "$validation.dataset");
  exactKeys(dataset, ["name", "version", "splitPolicy", "unitOfIndependence", "sampleCount"], "$validation.dataset");
  string(dataset.name, "$validation.dataset.name");
  string(dataset.version, "$validation.dataset.version");
  string(dataset.splitPolicy, "$validation.dataset.splitPolicy");
  string(dataset.unitOfIndependence, "$validation.dataset.unitOfIndependence");
  integer(dataset.sampleCount, "$validation.dataset.sampleCount", 1);
  sha256(item.frozenConfigurationSha256, "$validation.frozenConfigurationSha256");
  const metrics = array(item.metrics, "$validation.metrics").map((metric, index) => validateMetric(metric, `$validation.metrics[${index}]`));
  unique(metrics.map((metric) => metric.id), "$validation.metrics");
  const metricById = new Map(metrics.map((metric) => [metric.id, metric]));
  const gates = array(item.gates, "$validation.gates");
  gates.forEach((gate, index) => {
    const gateRecord = record(gate, `$validation.gates[${index}]`);
    exactKeys(gateRecord, ["metricId", "operator", "threshold", "passed"], `$validation.gates[${index}]`);
    const metricId = identifier(gateRecord.metricId, `$validation.gates[${index}].metricId`);
    const metric = metricById.get(metricId);
    if (!metric) fail("broken-reference", `$validation.gates[${index}].metricId`, "Validation gate references an undeclared metric.");
    const operator = oneOf(gateRecord.operator, ["<=", ">=", "<", ">"] as const, `$validation.gates[${index}].operator`);
    const threshold = finite(gateRecord.threshold, `$validation.gates[${index}].threshold`);
    const passed = bool(gateRecord.passed, `$validation.gates[${index}].passed`);
    const computed = operator === "<="
      ? metric.value <= threshold
      : operator === ">="
        ? metric.value >= threshold
        : operator === "<"
          ? metric.value < threshold
          : metric.value > threshold;
    if (passed !== computed) fail("invalid-value", `$validation.gates[${index}].passed`, "Gate outcome does not match its metric and locked threshold.");
  });
  array(item.strata, "$validation.strata").forEach((stratum, index) => {
    const stratumRecord = record(stratum, `$validation.strata[${index}]`);
    exactKeys(stratumRecord, ["name", "sampleCount", "metrics"], `$validation.strata[${index}]`);
    string(stratumRecord.name, `$validation.strata[${index}].name`);
    integer(stratumRecord.sampleCount, `$validation.strata[${index}].sampleCount`, 1);
    array(stratumRecord.metrics, `$validation.strata[${index}].metrics`).forEach((metric, metricIndex) => validateMetric(metric, `$validation.strata[${index}].metrics[${metricIndex}]`));
  });
  array(item.knownFailureModes, "$validation.knownFailureModes").forEach((mode, index) => string(mode, `$validation.knownFailureModes[${index}]`));
  string(item.claimBoundary, "$validation.claimBoundary");
  if (status === "validated-for-domain") {
    if (item.modelSha256 === null || !metrics.length || !gates.length || gates.some((gate) => record(gate, "$gate").passed !== true)) {
      fail("invalid-value", "$validation", "Validated evidence requires a model digest, metrics, and passing locked gates.");
    }
  }
  return value as ValidationReport;
}

export function validateJobSpec(value: unknown): JobSpec {
  const item = record(value, "$job");
  exactKeys(item, ["schemaVersion", "jobId", "kind", "createdAt", "executionTarget", "inputs", "operation", "resources", "expectedOutputs"], "$job");
  oneOf(item.schemaVersion, [JOB_SPEC_SCHEMA] as const, "$job.schemaVersion");
  identifier(item.jobId, "$job.jobId");
  const kind = oneOf(item.kind, ["fingerprint", "segment", "render", "export", "train"] as const, "$job.kind");
  isoDate(item.createdAt, "$job.createdAt");
  const target = record(item.executionTarget, "$job.executionTarget");
  if (target.kind === "local") {
    exactKeys(target, ["kind"], "$job.executionTarget");
  } else {
    exactKeys(target, ["kind", "computeProfileId", "scheduler"], "$job.executionTarget");
    oneOf(target.kind, ["remote"] as const, "$job.executionTarget.kind");
    identifier(target.computeProfileId, "$job.executionTarget.computeProfileId");
    oneOf(target.scheduler, ["pbs", "slurm", "direct"] as const, "$job.executionTarget.scheduler");
  }
  const inputs = array(item.inputs, "$job.inputs");
  if (!inputs.length) fail("invalid-value", "$job.inputs", "A job must have at least one source input.");
  const inputIds = inputs.map((input, index) => {
    const inputRecord = record(input, `$job.inputs[${index}]`);
    exactKeys(inputRecord, ["sourceId", "fingerprintSha256", "byteLength"], `$job.inputs[${index}]`);
    const id = identifier(inputRecord.sourceId, `$job.inputs[${index}].sourceId`);
    if (inputRecord.fingerprintSha256 !== null) {
      sha256(inputRecord.fingerprintSha256, `$job.inputs[${index}].fingerprintSha256`);
    } else if (kind !== "fingerprint") {
      fail(
        "invalid-value",
        `$job.inputs[${index}].fingerprintSha256`,
        "Analytical jobs require a frozen source fingerprint.",
      );
    }
    if (inputRecord.byteLength !== null) integer(inputRecord.byteLength, `$job.inputs[${index}].byteLength`);
    return id;
  });
  unique(inputIds, "$job.inputs");
  const operation = record(item.operation, "$job.operation");
  exactKeys(operation, ["profileId", "modelId", "modelSha256", "settings"], "$job.operation");
  if (operation.profileId !== null) identifier(operation.profileId, "$job.operation.profileId");
  if (operation.modelId !== null) identifier(operation.modelId, "$job.operation.modelId");
  if (operation.modelSha256 !== null) sha256(operation.modelSha256, "$job.operation.modelSha256");
  if (operation.settings !== null) assertRendererSafePayload(operation.settings, "$job.operation.settings");
  if (kind === "segment") {
    validateSegmentJobSettings(operation.settings, "$job.operation.settings");
  } else if (operation.settings !== null) {
    fail(
      "invalid-value",
      "$job.operation.settings",
      `JobSpec v1 requires null settings for ${kind} jobs until that operation has a versioned settings schema.`,
    );
  }
  const resources = record(item.resources, "$job.resources");
  exactKeys(resources, ["cpuCores", "memoryMiB", "gpuCount", "walltimeMinutes"], "$job.resources");
  for (const key of ["cpuCores", "memoryMiB", "walltimeMinutes"] as const) if (resources[key] !== null) integer(resources[key], `$job.resources.${key}`, 1);
  integer(resources.gpuCount, "$job.resources.gpuCount");
  const outputIds = array(item.expectedOutputs, "$job.expectedOutputs").map((output, index) => {
    const outputRecord = record(output, `$job.expectedOutputs[${index}]`);
    exactKeys(outputRecord, ["artifactId", "mediaType"], `$job.expectedOutputs[${index}]`);
    const id = identifier(outputRecord.artifactId, `$job.expectedOutputs[${index}].artifactId`);
    string(outputRecord.mediaType, `$job.expectedOutputs[${index}].mediaType`);
    return id;
  });
  unique(outputIds, "$job.expectedOutputs");
  return value as JobSpec;
}

export function validateJobEvent(value: unknown): JobEvent {
  const item = record(value, "$event");
  exactKeys(item, ["schemaVersion", "jobId", "sequence", "occurredAt", "state", "progress", "message", "reasonCode", "schedulerState"], "$event");
  oneOf(item.schemaVersion, [JOB_EVENT_SCHEMA] as const, "$event.schemaVersion");
  identifier(item.jobId, "$event.jobId");
  integer(item.sequence, "$event.sequence");
  isoDate(item.occurredAt, "$event.occurredAt");
  const state = oneOf(item.state, ["staging", "queued", "held", "running", "downloading", "verifying", "needs-attention", "disconnected", "completed", "failed", "cancelled"] as const, "$event.state");
  if (item.progress !== null) {
    const progress = finite(item.progress, "$event.progress");
    if (progress < 0 || progress > 1) fail("invalid-value", "$event.progress", "Progress must be between zero and one.");
  }
  string(item.message, "$event.message");
  nullableString(item.reasonCode, "$event.reasonCode");
  nullableString(item.schedulerState, "$event.schedulerState");
  if (state === "completed" && item.progress !== 1) fail("invalid-value", "$event.progress", "Completed events must report progress 1.");
  return value as JobEvent;
}

const EMBEDDED_JOB_TRANSITIONS: Readonly<Record<JobState, ReadonlySet<JobState>>> = {
  staging: new Set(["queued", "running", "failed", "cancelled", "disconnected", "needs-attention"]),
  queued: new Set(["held", "running", "failed", "cancelled", "disconnected", "needs-attention"]),
  held: new Set(["queued", "failed", "cancelled", "disconnected", "needs-attention"]),
  running: new Set(["downloading", "verifying", "completed", "failed", "cancelled", "disconnected", "needs-attention"]),
  downloading: new Set(["verifying", "failed", "cancelled", "disconnected", "needs-attention"]),
  verifying: new Set(["completed", "failed", "cancelled", "disconnected", "needs-attention"]),
  disconnected: new Set(["staging", "queued", "held", "running", "downloading", "verifying", "failed", "cancelled", "needs-attention"]),
  "needs-attention": new Set(["staging", "queued", "held", "running", "downloading", "verifying", "failed", "cancelled", "disconnected"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

function validateEmbeddedJobRecord(
  spec: JobSpec,
  events: JobEvent[],
  resultValue: unknown,
  path: string,
): void {
  if (!events.length) fail("invalid-value", `${path}.events`, "A persisted job must include its event history.");
  const first = events[0];
  if (first.sequence !== 0 || first.state !== "staging" || first.occurredAt !== spec.createdAt) {
    fail("invalid-value", `${path}.events[0]`, "A job history must begin at its declared creation time in staging state.");
  }
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const next = events[index];
    if (next.sequence !== previous.sequence + 1) {
      fail("invalid-value", `${path}.events[${index}].sequence`, "Job event sequences must be contiguous.");
    }
    if (Date.parse(next.occurredAt) < Date.parse(previous.occurredAt)) {
      fail("invalid-value", `${path}.events[${index}].occurredAt`, "Job event timestamps cannot move backwards.");
    }
    const repeatedActiveState = next.state === previous.state && !["completed", "failed", "cancelled"].includes(previous.state);
    if (!repeatedActiveState && !EMBEDDED_JOB_TRANSITIONS[previous.state].has(next.state)) {
      fail("invalid-value", `${path}.events[${index}].state`, `Job state cannot move from ${previous.state} to ${next.state}.`);
    }
    if (
      next.state === previous.state &&
      previous.progress !== null &&
      next.progress !== null &&
      next.progress < previous.progress
    ) {
      fail("invalid-value", `${path}.events[${index}].progress`, "Progress cannot decrease within one job state.");
    }
  }

  const latest = events.at(-1) as JobEvent;
  if (resultValue === null) {
    if (latest.state === "completed") {
      fail("invalid-value", `${path}.result`, "A completed job requires a verified result manifest.");
    }
    return;
  }
  if (latest.state !== "completed") {
    fail("invalid-value", `${path}.result`, "Only a completed job may retain a final result manifest.");
  }
  const result = validateResultManifest(resultValue);
  if (result.jobId !== spec.jobId) fail("broken-reference", `${path}.result`, "Result belongs to another job.");
  if (
    result.publication.state !== "verified" ||
    result.publication.atomic !== true ||
    Date.parse(result.createdAt) < Date.parse(spec.createdAt) ||
    Date.parse(result.createdAt) > Date.parse(latest.occurredAt)
  ) {
    fail("invalid-value", `${path}.result`, "Completed jobs require an atomically published result created during execution.");
  }
  if (
    result.producer.modelId !== spec.operation.modelId ||
    !sameSha256(result.producer.modelSha256, spec.operation.modelSha256)
  ) {
    fail("invalid-value", `${path}.result.producer`, "Result model provenance does not match the job specification.");
  }
  const fingerprints = new Map(result.sourceFingerprints.map((source) => [source.sourceId, source.sha256]));
  if (fingerprints.size !== spec.inputs.length) {
    fail("invalid-value", `${path}.result.sourceFingerprints`, "Result fingerprints must exactly match job inputs.");
  }
  spec.inputs.forEach((input, index) => {
    const digest = fingerprints.get(input.sourceId);
    if (!digest || input.fingerprintSha256 && !sameSha256(digest, input.fingerprintSha256)) {
      fail("invalid-value", `${path}.result.sourceFingerprints`, `Result fingerprint does not match input ${index + 1}.`);
    }
  });
  const artifacts = new Map(result.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  spec.expectedOutputs.forEach((expected) => {
    const artifact = artifacts.get(expected.artifactId);
    if (!artifact || artifact.mediaType !== expected.mediaType) {
      fail("invalid-value", `${path}.result.artifacts`, `Result is missing expected artifact ${expected.artifactId}.`);
    }
  });
}

export function validateResultManifest(value: unknown): ResultManifest {
  const item = record(value, "$result");
  exactKeys(item, ["schemaVersion", "resultManifestId", "resultId", "jobId", "createdAt", "sourceFingerprints", "producer", "artifacts", "publication"], "$result");
  oneOf(item.schemaVersion, [RESULT_MANIFEST_SCHEMA] as const, "$result.schemaVersion");
  identifier(item.resultManifestId, "$result.resultManifestId");
  identifier(item.resultId, "$result.resultId");
  identifier(item.jobId, "$result.jobId");
  isoDate(item.createdAt, "$result.createdAt");
  const sourceIds = array(item.sourceFingerprints, "$result.sourceFingerprints").map((source, index) => {
    const sourceRecord = record(source, `$result.sourceFingerprints[${index}]`);
    exactKeys(sourceRecord, ["sourceId", "sha256"], `$result.sourceFingerprints[${index}]`);
    const id = identifier(sourceRecord.sourceId, `$result.sourceFingerprints[${index}].sourceId`);
    sha256(sourceRecord.sha256, `$result.sourceFingerprints[${index}].sha256`);
    return id;
  });
  unique(sourceIds, "$result.sourceFingerprints");
  const producer = record(item.producer, "$result.producer");
  exactKeys(producer, ["appVersion", "engineVersion", "modelId", "modelSha256", "settingsSha256"], "$result.producer");
  string(producer.appVersion, "$result.producer.appVersion");
  string(producer.engineVersion, "$result.producer.engineVersion");
  if (producer.modelId !== null) identifier(producer.modelId, "$result.producer.modelId");
  if (producer.modelSha256 !== null) sha256(producer.modelSha256, "$result.producer.modelSha256");
  sha256(producer.settingsSha256, "$result.producer.settingsSha256");
  const artifacts = array(item.artifacts, "$result.artifacts");
  const artifactIds = artifacts.map((artifact, index) => {
    const artifactRecord = record(artifact, `$result.artifacts[${index}]`);
    exactKeys(artifactRecord, ["artifactId", "filename", "mediaType", "byteLength", "sha256"], `$result.artifacts[${index}]`);
    const id = identifier(artifactRecord.artifactId, `$result.artifacts[${index}].artifactId`);
    relativeLabel(artifactRecord.filename, `$result.artifacts[${index}].filename`);
    string(artifactRecord.mediaType, `$result.artifacts[${index}].mediaType`);
    integer(artifactRecord.byteLength, `$result.artifacts[${index}].byteLength`);
    sha256(artifactRecord.sha256, `$result.artifacts[${index}].sha256`);
    return id;
  });
  unique(artifactIds, "$result.artifacts");
  const publication = record(item.publication, "$result.publication");
  exactKeys(publication, ["state", "atomic", "reason"], "$result.publication");
  oneOf(publication.state, ["verified", "provisional", "rejected"] as const, "$result.publication.state");
  bool(publication.atomic, "$result.publication.atomic");
  nullableString(publication.reason, "$result.publication.reason");
  if (publication.state === "verified" && publication.atomic !== true) fail("invalid-value", "$result.publication", "Verified results must be published atomically.");
  return value as ResultManifest;
}

function validateResultArtifactRecord(value: unknown, path: string): void {
  const artifact = record(value, path);
  exactKeys(artifact, ["artifactId", "filename", "mediaType", "byteLength", "sha256"], path);
  identifier(artifact.artifactId, `${path}.artifactId`);
  relativeLabel(artifact.filename, `${path}.filename`);
  string(artifact.mediaType, `${path}.mediaType`);
  integer(artifact.byteLength, `${path}.byteLength`);
  sha256(artifact.sha256, `${path}.sha256`);
}

export function validateProjectManifestV1(value: unknown): ProjectManifestV1 {
  const item = record(value, "$project");
  exactKeys(item, ["schemaVersion", "projectId", "title", "createdAt", "updatedAt", "appVersion", "sources", "displayRecipes", "annotations", "corrections", "modelResults", "reviews", "jobs", "migrations"], "$project");
  const sources = array(item.sources, "$project.sources");
  if (sources.length > MAX_PROJECT_SOURCES) {
    fail("invalid-value", "$project.sources", `A project may contain at most ${MAX_PROJECT_SOURCES} sources.`);
  }
  assertRendererSafePayload(value);
  oneOf(item.schemaVersion, [PROJECT_MANIFEST_SCHEMA] as const, "$project.schemaVersion");
  identifier(item.projectId, "$project.projectId");
  string(item.title, "$project.title");
  const createdAt = isoDate(item.createdAt, "$project.createdAt");
  const updatedAt = isoDate(item.updatedAt, "$project.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail("invalid-value", "$project.updatedAt", "Project update time cannot precede creation.");
  string(item.appVersion, "$project.appVersion");
  const projectFingerprintBySourceId = new Map<string, SourceFingerprint>();
  const sourceRelativeLabelKeys: string[] = [];
  const sourceIds = sources.map((source, index) => {
    const sourceRecord = record(source, `$project.sources[${index}]`);
    exactKeys(sourceRecord, ["sourceId", "displayName", "relativeLabel", "fingerprint", "inspectionStatus", "descriptor", "workspace", "inspectionFailure"], `$project.sources[${index}]`);
    const id = identifier(sourceRecord.sourceId, `$project.sources[${index}].sourceId`);
    const displayName = string(sourceRecord.displayName, `$project.sources[${index}].displayName`);
    const sourceRelativeLabel = relativeLabel(sourceRecord.relativeLabel, `$project.sources[${index}].relativeLabel`);
    sourceRelativeLabelKeys.push(portableRelativeLabelKey(sourceRelativeLabel));
    const fingerprint = validateFingerprint(sourceRecord.fingerprint, `$project.sources[${index}].fingerprint`);
    projectFingerprintBySourceId.set(id, fingerprint);
    const inspectionStatus = oneOf(sourceRecord.inspectionStatus, ["pending", "ready", "failed"] as const, `$project.sources[${index}].inspectionStatus`);
    if (inspectionStatus === "ready") {
      const descriptor = validateSourceDescriptorV1(sourceRecord.descriptor);
      const workspace = validateWorkspaceRecommendation(sourceRecord.workspace);
      if (displayName !== descriptor.displayName || sourceRelativeLabel !== descriptor.relativeLabel) {
        fail(
          "invalid-value",
          `$project.sources[${index}]`,
          "Project source labels must match their inspected descriptor.",
        );
      }
      requireSemanticMatch(
        fingerprint,
        descriptor.fingerprint,
        `$project.sources[${index}].fingerprint`,
        "Project source fingerprint must match its inspected descriptor.",
      );
      requireSemanticMatch(
        workspace,
        recommendWorkspace(descriptor, workspace.userOverride),
        `$project.sources[${index}].workspace`,
        "Persisted workspace routing must match the deterministic source recommendation.",
      );
      if (sourceRecord.inspectionFailure !== null) fail("invalid-value", `$project.sources[${index}].inspectionFailure`, "A ready source cannot retain an inspection failure.");
    } else {
      if (sourceRecord.descriptor !== null || sourceRecord.workspace !== null) {
        fail("invalid-value", `$project.sources[${index}]`, "Only a ready source may contain inspected metadata and a workspace recommendation.");
      }
      if (inspectionStatus === "pending") {
        if (sourceRecord.inspectionFailure !== null) fail("invalid-value", `$project.sources[${index}].inspectionFailure`, "A pending source cannot contain an inspection failure.");
      } else {
        const failure = record(sourceRecord.inspectionFailure, `$project.sources[${index}].inspectionFailure`);
        exactKeys(failure, ["code", "summary"], `$project.sources[${index}].inspectionFailure`);
        identifier(failure.code, `$project.sources[${index}].inspectionFailure.code`);
        string(failure.summary, `$project.sources[${index}].inspectionFailure.summary`);
      }
    }
    return id;
  });
  unique(sourceIds, "$project.sources");
  unique(sourceRelativeLabelKeys, "$project.sources.relativeLabel");
  const sourceIdSet = new Set(sourceIds);
  const requireSource = (sourceId: unknown, path: string): string => {
    const id = identifier(sourceId, path);
    if (!sourceIdSet.has(id)) fail("broken-reference", path, `${path} references an unknown source.`);
    return id;
  };
  const recipeSourceIds: string[] = [];
  const recipeIds = array(item.displayRecipes, "$project.displayRecipes").map((recipe, index) => {
    const recipeRecord = record(recipe, `$project.displayRecipes[${index}]`);
    exactKeys(recipeRecord, ["recipeId", "sourceId", "settings", "channelSettings"], `$project.displayRecipes[${index}]`);
    const id = identifier(recipeRecord.recipeId, `$project.displayRecipes[${index}].recipeId`);
    recipeSourceIds.push(requireSource(recipeRecord.sourceId, `$project.displayRecipes[${index}].sourceId`));
    validateViewerDisplaySettings(recipeRecord.settings, `$project.displayRecipes[${index}].settings`);
    const channelIndices = array(recipeRecord.channelSettings, `$project.displayRecipes[${index}].channelSettings`).map((channel, channelIndex) => {
      const channelRecord = record(channel, `$project.displayRecipes[${index}].channelSettings[${channelIndex}]`);
      exactKeys(channelRecord, ["channelIndex", "visible", "opacity", "color", "blackPoint", "whitePoint", "gamma"], `$project.displayRecipes[${index}].channelSettings[${channelIndex}]`);
      const channelIndexValue = integer(channelRecord.channelIndex, `$project.displayRecipes[${index}].channelSettings[${channelIndex}].channelIndex`);
      bool(channelRecord.visible, `$project.displayRecipes[${index}].channelSettings[${channelIndex}].visible`);
      const opacity = finite(channelRecord.opacity, `$project.displayRecipes[${index}].channelSettings[${channelIndex}].opacity`);
      const black = finite(channelRecord.blackPoint, `$project.displayRecipes[${index}].channelSettings[${channelIndex}].blackPoint`);
      const white = finite(channelRecord.whitePoint, `$project.displayRecipes[${index}].channelSettings[${channelIndex}].whitePoint`);
      const gamma = finite(channelRecord.gamma, `$project.displayRecipes[${index}].channelSettings[${channelIndex}].gamma`);
      if (opacity < 0 || opacity > 1 || black < 0 || white > 1 || black >= white || gamma <= 0) fail("invalid-value", `$project.displayRecipes[${index}].channelSettings[${channelIndex}]`, "Channel display settings are outside their valid range.");
      nullableString(channelRecord.color, `$project.displayRecipes[${index}].channelSettings[${channelIndex}].color`);
      return String(channelIndexValue);
    });
    unique(channelIndices, `$project.displayRecipes[${index}].channelSettings`);
    return id;
  });
  unique(recipeIds, "$project.displayRecipes");
  unique(recipeSourceIds, "$project.displayRecipes.sourceId");
  const annotationIds = array(item.annotations, "$project.annotations").map((annotation, index) => {
    const annotationRecord = record(annotation, `$project.annotations[${index}]`);
    exactKeys(annotationRecord, ["annotationId", "sourceId", "kind", "points", "label", "color", "properties"], `$project.annotations[${index}]`);
    const id = identifier(annotationRecord.annotationId, `$project.annotations[${index}].annotationId`);
    requireSource(annotationRecord.sourceId, `$project.annotations[${index}].sourceId`);
    oneOf(annotationRecord.kind, ["point", "polyline", "polygon", "rectangle", "ellipse"] as const, `$project.annotations[${index}].kind`);
    const points = array(annotationRecord.points, `$project.annotations[${index}].points`);
    if (!points.length) fail("invalid-value", `$project.annotations[${index}].points`, "An annotation must contain points.");
    points.forEach((point, pointIndex) => {
      const pointRecord = record(point, `$project.annotations[${index}].points[${pointIndex}]`);
      exactKeys(pointRecord, ["x", "y", "z", "t"], `$project.annotations[${index}].points[${pointIndex}]`);
      finite(pointRecord.x, `$project.annotations[${index}].points[${pointIndex}].x`);
      finite(pointRecord.y, `$project.annotations[${index}].points[${pointIndex}].y`);
      if (pointRecord.z !== null) finite(pointRecord.z, `$project.annotations[${index}].points[${pointIndex}].z`);
      if (pointRecord.t !== null) finite(pointRecord.t, `$project.annotations[${index}].points[${pointIndex}].t`);
    });
    string(annotationRecord.label, `$project.annotations[${index}].label`, true);
    string(annotationRecord.color, `$project.annotations[${index}].color`);
    const properties = record(annotationRecord.properties, `$project.annotations[${index}].properties`);
    Object.entries(properties).forEach(([key, property]) => {
      identifier(key, `$project.annotations[${index}].properties.${key}`);
      if (property !== null && !["string", "number", "boolean"].includes(typeof property)) fail("invalid-type", `$project.annotations[${index}].properties.${key}`, "Annotation properties must be primitive JSON values.");
      if (typeof property === "number") finite(property, `$project.annotations[${index}].properties.${key}`);
    });
    return id;
  });
  unique(annotationIds, "$project.annotations");
  const correctionLinks: Array<{ sourceId: string; resultId: string; path: string }> = [];
  const correctionIds = array(item.corrections, "$project.corrections").map((correction, index) => {
    const correctionRecord = record(correction, `$project.corrections[${index}]`);
    exactKeys(correctionRecord, ["correctionId", "sourceId", "resultId", "revision", "operationIds", "workingResultArtifact"], `$project.corrections[${index}]`);
    const id = identifier(correctionRecord.correctionId, `$project.corrections[${index}].correctionId`);
    const sourceId = requireSource(correctionRecord.sourceId, `$project.corrections[${index}].sourceId`);
    const resultId = identifier(correctionRecord.resultId, `$project.corrections[${index}].resultId`);
    correctionLinks.push({ sourceId, resultId, path: `$project.corrections[${index}]` });
    integer(correctionRecord.revision, `$project.corrections[${index}].revision`, 1);
    const operationIds = array(correctionRecord.operationIds, `$project.corrections[${index}].operationIds`).map((operationId, operationIndex) => identifier(operationId, `$project.corrections[${index}].operationIds[${operationIndex}]`));
    unique(operationIds, `$project.corrections[${index}].operationIds`);
    validateResultArtifactRecord(correctionRecord.workingResultArtifact, `$project.corrections[${index}].workingResultArtifact`);
    const workingArtifact = record(correctionRecord.workingResultArtifact, `$project.corrections[${index}].workingResultArtifact`);
    if (
      workingArtifact.artifactId !== "working-result" ||
      workingArtifact.mediaType !== "application/vnd.loci.working-result+zip"
    ) {
      fail("invalid-value", `$project.corrections[${index}].workingResultArtifact`, "A correction must reference a verified Loci working-result pack.");
    }
    return id;
  });
  unique(correctionIds, "$project.corrections");
  const modelResultById = new Map<string, {
    sourceId: string;
    resultManifestId: string;
    modelId: string;
    modelSha256: string | null;
    createdAt: string;
  }>();
  const modelResultIds = array(item.modelResults, "$project.modelResults").map((result, index) => {
    const resultRecord = record(result, `$project.modelResults[${index}]`);
    exactKeys(resultRecord, ["resultId", "sourceId", "modelId", "modelSha256", "evidenceStatus", "createdAt", "resultManifestId"], `$project.modelResults[${index}]`);
    const id = identifier(resultRecord.resultId, `$project.modelResults[${index}].resultId`);
    const sourceId = requireSource(resultRecord.sourceId, `$project.modelResults[${index}].sourceId`);
    const modelId = identifier(resultRecord.modelId, `$project.modelResults[${index}].modelId`);
    const modelSha256 = resultRecord.modelSha256 === null
      ? null
      : sha256(resultRecord.modelSha256, `$project.modelResults[${index}].modelSha256`);
    evidenceState(resultRecord.evidenceStatus, `$project.modelResults[${index}].evidenceStatus`);
    const createdAt = isoDate(resultRecord.createdAt, `$project.modelResults[${index}].createdAt`);
    const resultManifestId = identifier(resultRecord.resultManifestId, `$project.modelResults[${index}].resultManifestId`);
    modelResultById.set(id, { sourceId, resultManifestId, modelId, modelSha256, createdAt });
    return id;
  });
  unique(modelResultIds, "$project.modelResults");
  const modelResultByResultId = new Map(
    [...modelResultById.entries()].map(([resultId, details]) => [resultId, details] as const),
  );
  const reviewIds = array(item.reviews, "$project.reviews").map((review, index) => {
    const reviewRecord = record(review, `$project.reviews[${index}]`);
    exactKeys(
      reviewRecord,
      ["reviewId", "sourceId", "resultId", "correctionRevision", "disposition", "decidedAt", "note"],
      `$project.reviews[${index}]`,
    );
    const reviewId = identifier(reviewRecord.reviewId, `$project.reviews[${index}].reviewId`);
    const sourceId = requireSource(reviewRecord.sourceId, `$project.reviews[${index}].sourceId`);
    const resultId = identifier(reviewRecord.resultId, `$project.reviews[${index}].resultId`);
    const modelResult = modelResultByResultId.get(resultId);
    if (!modelResult || modelResult.sourceId !== sourceId) {
      fail(
        "broken-reference",
        `$project.reviews[${index}].resultId`,
        "A review must reference a model result for the same source.",
      );
    }
    integer(reviewRecord.correctionRevision, `$project.reviews[${index}].correctionRevision`);
    oneOf(
      reviewRecord.disposition,
      ["reviewed", "excluded"] as const,
      `$project.reviews[${index}].disposition`,
    );
    isoDate(reviewRecord.decidedAt, `$project.reviews[${index}].decidedAt`);
    string(reviewRecord.note, `$project.reviews[${index}].note`, true);
    return reviewId;
  });
  unique(reviewIds, "$project.reviews");
  for (const link of correctionLinks) {
    const declared = modelResultById.get(link.resultId);
    if (!declared) fail("broken-reference", link.path, `Correction references unknown result ${link.resultId}.`);
    if (declared.sourceId !== link.sourceId) {
      fail("broken-reference", link.path, "A correction and its model result must belong to the same source.");
    }
  }
  const jobs = array(item.jobs, "$project.jobs");
  const resultByManifestId = new Map<string, ResultManifest>();
  const jobIds = jobs.map((job, index) => {
    const jobPath = `$project.jobs[${index}]`;
    const jobRecord = record(job, jobPath);
    exactKeys(jobRecord, ["spec", "events", "result"], jobPath);
    const spec = validateJobSpec(jobRecord.spec);
    spec.inputs.forEach((input, inputIndex) => {
      requireSource(input.sourceId, `${jobPath}.spec.inputs[${inputIndex}].sourceId`);
      const projectFingerprint = projectFingerprintBySourceId.get(input.sourceId)!;
      if (spec.kind !== "fingerprint" && projectFingerprint.status !== "verified") {
        fail("invalid-value", `${jobPath}.spec.inputs[${inputIndex}]`, "Analytical jobs require a verified project source fingerprint.");
      }
      if (
        input.fingerprintSha256 !== null &&
        (projectFingerprint.status !== "verified" || !sameSha256(input.fingerprintSha256, projectFingerprint.sha256))
      ) {
        fail("invalid-value", `${jobPath}.spec.inputs[${inputIndex}].fingerprintSha256`, "Job input fingerprint does not match the project source fingerprint.");
      }
    });
    const events = array(jobRecord.events, `${jobPath}.events`).map((event) => validateJobEvent(event));
    events.forEach((event) => {
      if (event.jobId !== spec.jobId) fail("broken-reference", `${jobPath}.events`, "Job event belongs to another job.");
    });
    validateEmbeddedJobRecord(spec, events, jobRecord.result, jobPath);
    if (jobRecord.result !== null) {
      const result = validateResultManifest(jobRecord.result);
      result.sourceFingerprints.forEach((source, sourceIndex) => {
        requireSource(source.sourceId, `${jobPath}.result.sourceFingerprints[${sourceIndex}].sourceId`);
        const projectFingerprint = projectFingerprintBySourceId.get(source.sourceId)!;
        if (projectFingerprint.status !== "verified" || !sameSha256(source.sha256, projectFingerprint.sha256)) {
          fail("invalid-value", `${jobPath}.result.sourceFingerprints[${sourceIndex}].sha256`, "Result fingerprint does not match the project source fingerprint.");
        }
      });
      if (resultByManifestId.has(result.resultManifestId)) {
        fail("duplicate-id", `${jobPath}.result.resultManifestId`, "Result manifest identifiers must be unique within a project.");
      }
      resultByManifestId.set(result.resultManifestId, result);
    }
    return spec.jobId;
  });
  unique(jobIds, "$project.jobs");
  for (const [resultId, declared] of modelResultById) {
    const result = resultByManifestId.get(declared.resultManifestId);
    if (!result) {
      fail("broken-reference", "$project.modelResults", `Model result ${resultId} references an unknown result manifest.`);
    }
    if (result.resultId !== resultId || !result.sourceFingerprints.some(({ sourceId }) => sourceId === declared.sourceId)) {
      fail("broken-reference", "$project.modelResults", `Model result ${resultId} does not match its source/result manifest provenance.`);
    }
    if (
      result.producer.modelId !== declared.modelId ||
      !sameSha256(result.producer.modelSha256, declared.modelSha256)
    ) {
      fail("broken-reference", "$project.modelResults", `Model result ${resultId} does not match its producer provenance.`);
    }
    if (result.createdAt !== declared.createdAt) {
      fail("broken-reference", "$project.modelResults", `Model result ${resultId} creation time does not match its result manifest.`);
    }
  }
  array(item.migrations, "$project.migrations").forEach((migration, index) => {
    const migrationRecord = record(migration, `$project.migrations[${index}]`);
    exactKeys(migrationRecord, ["fromSchema", "toSchema", "migratedAt", "appVersion"], `$project.migrations[${index}]`);
    string(migrationRecord.fromSchema, `$project.migrations[${index}].fromSchema`);
    string(migrationRecord.toSchema, `$project.migrations[${index}].toSchema`);
    isoDate(migrationRecord.migratedAt, `$project.migrations[${index}].migratedAt`);
    string(migrationRecord.appVersion, `$project.migrations[${index}].appVersion`);
  });
  return value as ProjectManifestV1;
}

export function isRendererSafeProjectManifest(value: unknown): value is ProjectManifestV1 {
  try {
    validateProjectManifestV1(value);
    return true;
  } catch (error) {
    if (error instanceof FoundationValidationError) return false;
    throw error;
  }
}

/** Exported for adapters that need a strongly typed capability identifier. */
export function validateCapabilityId(value: unknown): CapabilityId {
  return oneOf(value, CAPABILITY_IDS, "$capabilityId");
}
