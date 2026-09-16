import type { AnalysisSettings, ViewerDisplaySettings } from "./contracts";

/** Schema identifiers are deliberately stable strings so persisted documents are self-describing. */
export const SOURCE_DESCRIPTOR_SCHEMA = "loci.source-descriptor/v1" as const;
export const WORKSPACE_RECOMMENDATION_SCHEMA = "loci.workspace-recommendation/v1" as const;
export const PROJECT_MANIFEST_SCHEMA = "loci.project/v1" as const;
export const CAPABILITY_MANIFEST_SCHEMA = "loci.capability/v1" as const;
export const MODEL_MANIFEST_SCHEMA = "loci.model/v1" as const;
export const VALIDATION_REPORT_SCHEMA = "loci.validation-report/v1" as const;
export const JOB_SPEC_SCHEMA = "loci.job-spec/v1" as const;
export const JOB_EVENT_SCHEMA = "loci.job-event/v1" as const;
export const RESULT_MANIFEST_SCHEMA = "loci.result/v1" as const;
/** Shared session/project safety bound. Large folders stay lazy within this limit. */
export const MAX_PROJECT_SOURCES = 20_000;

export type SourceAxisName = "X" | "Y" | "Z" | "C" | "T";

export interface SourceAxisDescriptor {
  name: SourceAxisName;
  length: number;
  unit: string | null;
  spacing: number | null;
}

export interface SourceChannelDescriptor {
  index: number;
  name: string;
  dtype: string;
  colorSource: "declared" | "rgb-component" | "loci-fallback" | "not-applicable";
  rangeSource: "declared" | "dtype" | "sampled" | "not-applicable";
}

export interface SourcePhysicalCalibration {
  source: "declared-metadata";
  unit: string;
  voxelSize: [number, number, number | null];
  extents: Array<[number, number]> | null;
}

export interface SourcePyramidDescriptor {
  levels: number;
  selectedLevel: number;
  selectedShape: [number, number, number | null];
  tiled: boolean | null;
}

export interface SourceChunkDescriptor {
  storage: "contiguous" | "striped" | "tiled" | "hdf5-chunked" | "unknown";
  shape: number[] | null;
}

export type SourceFingerprint =
  | {
    status: "pending";
    algorithm: "sha256";
    sha256: null;
    verifiedAt: null;
  }
  | {
    status: "verified";
    algorithm: "sha256";
    sha256: string;
    verifiedAt: string;
  }
  | {
    status: "failed";
    algorithm: "sha256";
    sha256: null;
    verifiedAt: null;
    reasonCode: string;
  };

export interface SourceAccessPlan {
  mode: "full" | "overview";
  canRender: boolean;
  canAnalyze: boolean;
  canExportRenderedView: boolean;
  canExportNativeData: boolean;
  provisionalUntilFingerprintVerified: boolean;
  reason: string | null;
}

export type SourceAmbiguityCode =
  | "biological-purpose-unknown"
  | "page-axis-unknown"
  | "physical-calibration-missing"
  | "format-adapter-generic";

export interface SourceAmbiguity {
  code: SourceAmbiguityCode;
  summary: string;
}

export interface SourceDescriptorV1 {
  schemaVersion: typeof SOURCE_DESCRIPTOR_SCHEMA;
  displayName: string;
  /** Project-relative label only. Canonical filesystem paths are main-process state. */
  relativeLabel: string;
  format: string;
  formatAdapter: "raster" | "tiff" | "imaris-hdf5" | "generic";
  dimensions: { width: number; height: number };
  axes: SourceAxisDescriptor[];
  channels: SourceChannelDescriptor[];
  colorModel: "intensity" | "interleaved-rgb" | "channel-composite" | "unknown";
  calibration: SourcePhysicalCalibration | null;
  pyramid: SourcePyramidDescriptor | null;
  chunks: SourceChunkDescriptor;
  access: SourceAccessPlan;
  fingerprint: SourceFingerprint;
  ambiguity: SourceAmbiguity[];
}

export type WorkspaceKind = "generic-2d" | "pathology-2d" | "scientific-volume";
export type WorkspacePresetId =
  | "generic-display"
  | "brightfield-cell"
  | "fluorescence"
  | "h-and-e-display"
  | "ihc-display"
  | "multichannel-display"
  | "volume-display";

export interface WorkspaceEvidence {
  code: string;
  summary: string;
}

export interface WorkspaceRecommendation {
  schemaVersion: typeof WORKSPACE_RECOMMENDATION_SCHEMA;
  inferredWorkspace: WorkspaceKind;
  workspace: WorkspaceKind;
  decision: "structural" | "safe-default" | "user-override";
  evidence: WorkspaceEvidence[];
  applicablePresets: WorkspacePresetId[];
  requiredCapabilities: Array<
    "pathology-large-2d" | "scientific-volumes"
  >;
  userOverride: WorkspaceKind | null;
  analysis: {
    autoRun: false;
    recommendedModelId: null;
    reason: string;
  };
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface ProjectSourceReferenceBase {
  sourceId: string;
  displayName: string;
  /** Relative display label only; never an absolute or file:// path. */
  relativeLabel: string;
  fingerprint: SourceFingerprint;
}

/** A lazy folder import can be persisted without inventing dimensions or axes. */
export type ProjectSourceReference = ProjectSourceReferenceBase & (
  | {
    inspectionStatus: "pending";
    descriptor: null;
    workspace: null;
    inspectionFailure: null;
  }
  | {
    inspectionStatus: "ready";
    descriptor: SourceDescriptorV1;
    workspace: WorkspaceRecommendation;
    inspectionFailure: null;
  }
  | {
    inspectionStatus: "failed";
    descriptor: null;
    workspace: null;
    inspectionFailure: { code: string; summary: string };
  }
);

export interface ProjectDisplayRecipe {
  recipeId: string;
  sourceId: string;
  settings: ViewerDisplaySettings;
  channelSettings: Array<{
    channelIndex: number;
    visible: boolean;
    opacity: number;
    color: string | null;
    blackPoint: number;
    whitePoint: number;
    gamma: number;
  }>;
}

export interface ProjectAnnotation {
  annotationId: string;
  sourceId: string;
  kind: "point" | "polyline" | "polygon" | "rectangle" | "ellipse";
  points: Array<{ x: number; y: number; z: number | null; t: number | null }>;
  label: string;
  color: string;
  properties: Record<string, JsonPrimitive>;
}

export interface ProjectCorrectionReference {
  correctionId: string;
  sourceId: string;
  resultId: string;
  revision: number;
  operationIds: string[];
  /**
   * Path-free identity of the exact immutable working-result pack containing
   * this correction revision. Project restore must verify every field before
   * accepting pixels, measurements, or review state from the pack.
   */
  workingResultArtifact: ResultArtifact;
}

export interface ProjectModelResultReference {
  resultId: string;
  sourceId: string;
  modelId: string;
  modelSha256: string | null;
  evidenceStatus: ModelEvidenceStatus;
  createdAt: string;
  resultManifestId: string;
}

export type ProjectReviewDisposition = "reviewed" | "excluded";

/**
 * A human workflow decision bound to one exact analytical revision.
 *
 * Review is intentionally separate from structural quality and model evidence.
 * A correction or rerun creates a different revision/result and therefore
 * cannot inherit an older review decision.
 */
export interface ProjectReviewRecord {
  reviewId: string;
  sourceId: string;
  resultId: string;
  correctionRevision: number;
  disposition: ProjectReviewDisposition;
  decidedAt: string;
  note: string;
}

export interface ProjectJobRecord {
  spec: JobSpec;
  events: JobEvent[];
  result: ResultManifest | null;
}

export interface ProjectMigrationRecord {
  fromSchema: string;
  toSchema: string;
  migratedAt: string;
  appVersion: string;
}

/**
 * Renderer-safe project document. Canonical paths, file grants, credentials, raw
 * pixels, previews, SSH material, and scheduler tokens intentionally have no fields.
 */
export interface ProjectManifestV1 {
  schemaVersion: typeof PROJECT_MANIFEST_SCHEMA;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
  sources: ProjectSourceReference[];
  displayRecipes: ProjectDisplayRecipe[];
  annotations: ProjectAnnotation[];
  corrections: ProjectCorrectionReference[];
  modelResults: ProjectModelResultReference[];
  reviews: ProjectReviewRecord[];
  jobs: ProjectJobRecord[];
  migrations: ProjectMigrationRecord[];
}

export type CapabilityId =
  | "cell-analysis"
  | "pathology-large-2d"
  | "scientific-volumes"
  | "remote-compute";

export interface CapabilityManifest {
  schemaVersion: typeof CAPABILITY_MANIFEST_SCHEMA;
  capabilityId: CapabilityId;
  name: string;
  version: string;
  appCompatibility: { minimum: string; maximumExclusive: string | null };
  artifact: {
    sha256: string;
    sizeBytes: number;
    sourceUrl: string;
    offlineImportSupported: boolean;
  };
  dependencies: Array<{ capabilityId: CapabilityId; versionRange: string }>;
  licenses: Array<{
    component: string;
    spdxId: string;
    sourceUrl: string;
  }>;
}

export type ModelEvidenceStatus =
  | "unvalidated"
  | "experimental"
  | "validated-for-domain"
  | "not-recommended";

export interface ModelManifest {
  schemaVersion: typeof MODEL_MANIFEST_SCHEMA;
  modelId: string;
  name: string;
  version: string;
  artifact: {
    sha256: string | null;
    sizeBytes: number | null;
    bundled: boolean;
    sourceUrl: string | null;
  };
  runtime: { backend: string; requiredVersion: string };
  intendedDomain: {
    summary: string;
    modalities: string[];
    organisms: string[];
    channels: string[];
    pixelSize: { minimum: number; maximum: number; unit: string } | null;
  };
  preprocessing: string[];
  postprocessing: string[];
  rights: {
    codeLicense: string;
    checkpointLicense: string;
    redistribution: "permitted" | "not-permitted" | "unknown";
    commercialUse: "permitted" | "restricted" | "not-permitted" | "unknown";
    trainingDataLineage: string;
  };
  evidenceStatus: ModelEvidenceStatus;
  validationReportIds: string[];
  knownFailureModes: string[];
}

export interface ValidationMetric {
  id: string;
  value: number;
  unit: string;
  higherIsBetter: boolean;
}

export interface ValidationGate {
  metricId: string;
  operator: "<=" | ">=" | "<" | ">";
  threshold: number;
  passed: boolean;
}

export interface ValidationReport {
  schemaVersion: typeof VALIDATION_REPORT_SCHEMA;
  reportId: string;
  modelId: string;
  modelSha256: string | null;
  createdAt: string;
  evidenceStatus: ModelEvidenceStatus;
  declaredDomain: string;
  dataset: {
    name: string;
    version: string;
    splitPolicy: string;
    unitOfIndependence: string;
    sampleCount: number;
  };
  frozenConfigurationSha256: string;
  metrics: ValidationMetric[];
  gates: ValidationGate[];
  strata: Array<{ name: string; sampleCount: number; metrics: ValidationMetric[] }>;
  knownFailureModes: string[];
  claimBoundary: string;
}

export type JobKind = "fingerprint" | "segment" | "render" | "export" | "train";
export type JobExecutionTarget =
  | { kind: "local" }
  | { kind: "remote"; computeProfileId: string; scheduler: "pbs" | "slurm" | "direct" };

export interface JobSourceInput {
  sourceId: string;
  fingerprintSha256: string | null;
  byteLength: number | null;
}

export interface JobSpec {
  schemaVersion: typeof JOB_SPEC_SCHEMA;
  jobId: string;
  kind: JobKind;
  createdAt: string;
  executionTarget: JobExecutionTarget;
  inputs: JobSourceInput[];
  operation: {
    profileId: string | null;
    modelId: string | null;
    modelSha256: string | null;
    settings: AnalysisSettings | Record<string, JsonValue> | null;
  };
  resources: {
    cpuCores: number | null;
    memoryMiB: number | null;
    gpuCount: number;
    walltimeMinutes: number | null;
  };
  expectedOutputs: Array<{ artifactId: string; mediaType: string }>;
}

export type JobState =
  | "staging"
  | "queued"
  | "held"
  | "running"
  | "downloading"
  | "verifying"
  | "needs-attention"
  | "disconnected"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobEvent {
  schemaVersion: typeof JOB_EVENT_SCHEMA;
  jobId: string;
  sequence: number;
  occurredAt: string;
  state: JobState;
  progress: number | null;
  message: string;
  reasonCode: string | null;
  schedulerState: string | null;
}

export interface ResultArtifact {
  artifactId: string;
  filename: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface ResultManifest {
  schemaVersion: typeof RESULT_MANIFEST_SCHEMA;
  resultManifestId: string;
  resultId: string;
  jobId: string;
  createdAt: string;
  sourceFingerprints: Array<{ sourceId: string; sha256: string }>;
  producer: {
    appVersion: string;
    engineVersion: string;
    modelId: string | null;
    modelSha256: string | null;
    settingsSha256: string;
  };
  artifacts: ResultArtifact[];
  publication: {
    state: "verified" | "provisional" | "rejected";
    atomic: boolean;
    reason: string | null;
  };
}
