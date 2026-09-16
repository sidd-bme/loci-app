import type {
  JobSpec,
  JobState,
  ProjectManifestV1,
  SourceDescriptorV1,
} from "./foundation-contracts";

export type ImageMode = "auto" | "brightfield" | "fluorescence";
export type Polarity = "auto" | "dark" | "bright";

export interface SegmentationSettings {
  image_mode: ImageMode;
  polarity: Polarity;
  expected_diameter_px: number;
  min_area_px: number;
  sensitivity: number;
  smoothing_px: number;
  split_touching: boolean;
  exclude_border: boolean;
}

export type CellposeDevice = "auto" | "cpu" | "mps" | "cuda";
export type CellposeProfileId = "cellpose-sam" | "cellpose-sam-v2";

export function isCellposeProfileId(value: string): value is CellposeProfileId {
  return value === "cellpose-sam" || value === "cellpose-sam-v2";
}

export interface CellposeSettings {
  max_edge_px: number;
  diameter_px: number;
  flow_threshold: number;
  cellprob_threshold: number;
  min_size_px: number;
  max_size_fraction: number;
  niter: number;
  batch_size: number;
  resample: boolean;
  augment: boolean;
  tile_overlap: number;
  normalize: boolean;
  percentile_low: number;
  percentile_high: number;
  tile_norm_blocksize: number;
  sharpen_radius: number;
  smooth_radius: number;
  invert: boolean;
  device: CellposeDevice;
}

export type AnalysisSettings = SegmentationSettings | CellposeSettings;

export type SegmentationBackendKind = "classical" | "cellpose" | "onnx";
export type SegmentationModelFormat = "builtin-algorithm" | "cellpose-native" | "onnx";
export type SegmentationProfileStatus = "ready" | "unavailable" | "validation_failed";

export interface SegmentationModelIdentity {
  format: SegmentationModelFormat;
  artifactId: string | null;
  sha256: string | null;
}

export interface SegmentationPreprocessing {
  channelConversion: "grayscale-luminance" | "rgb-or-replicated-grayscale";
  intensityNormalization: "per-image-percentile-1-99" | "cellpose-configurable-percentile";
  resizePolicy: "none" | "downsample-only";
  maxEdgePx: number | null;
  outputGrid: "source-resolution";
}

export interface SegmentationProfileProvenance {
  id: string;
  name: string;
  version: string;
  backendKind: SegmentationBackendKind;
  model: SegmentationModelIdentity;
  preprocessing: SegmentationPreprocessing;
}

export interface SegmentationProfile extends SegmentationProfileProvenance {
  schemaVersion: string;
  status: SegmentationProfileStatus;
  availability: { code: string; summary: string };
  rights: {
    codeLicense: string;
    modelLicense: string;
    redistribution: "bundled" | "permitted" | "not_permitted" | "unknown";
    commercialUse: "permitted" | "restricted" | "not_permitted" | "not_applicable" | "unknown";
    trainingDataLineage: string;
  };
  recommendedSettings: AnalysisSettings;
  settingsContract: SegmentationSettingDefinition[];
  validation: {
    status: "baseline" | "validated" | "limited" | "unvalidated";
    summary: string;
    failureModes: Array<{ code: string; summary: string }>;
  };
}

export interface SegmentationSettingDefinition {
  key: string;
  label: string;
  section: string;
  valueType: "boolean" | "integer" | "number" | "choice";
  help: string;
  minimum: number | null;
  maximum: number | null;
  step: number | null;
  choices: string[];
}

export interface SourceMetadata {
  name: string;
  relativePath: string;
  width: number;
  height: number;
  channels: number;
  dtype: string;
  format: string;
  pageCount: number;
  colorModel?: "intensity" | "interleaved-rgb" | "channel-composite";
  accessMode?: "full" | "overview";
  viewOnlyReason?: string;
  sourceDetails?: SourceDetails;
}

export interface ImsVolumeSourceDetails {
  kind: "ims-volume";
  width: number;
  height: number;
  depth: number;
  channels: number;
  timepoints: number;
  resolutionLevels: number;
  selectedResolutionLevel: number;
  selectedLevelWidth: number;
  selectedLevelHeight: number;
  selectedLevelDepth: number;
  selectedTimepoint: number;
  selectedZ: number;
  samplingStride: number;
  channelNames: string[];
  channelDtypes: string[];
  channelColorSources: string[];
  channelRangeSources: string[];
  compositeMode: "single-channel" | "rgb-components" | "loci-overview-composite";
  renderedDtype: string;
  physicalExtents?: Array<[number, number]>;
  voxelSize?: [number, number, number];
  physicalUnit?: string;
}

export interface TiffPyramidSourceDetails {
  kind: "tiff-pyramid";
  width: number;
  height: number;
  channels: number;
  dtype: string;
  resolutionLevels: number;
  selectedResolutionLevel: number;
  selectedLevelWidth: number;
  selectedLevelHeight: number;
  fullDecodedBytes: number;
  selectedDecodedBytes: number;
  tiled: boolean;
  selectedLevelTiled: boolean;
}

export type SourceDetails = ImsVolumeSourceDetails | TiffPyramidSourceDetails;

export interface DisplayStatistics {
  /** Histogram counts over the normalized display domain [0, 1]. */
  histogramBins: number[];
  /** Sampled 1st-percentile position in the normalized display domain. */
  percentileLow: number;
  /** Sampled 99th-percentile position in the normalized display domain. */
  percentileHigh: number;
  basis: "luminance" | "intensity";
  sampleCount: number;
  /** Source-value bounds used to normalize the interactive display. */
  displayMinimum: number;
  displayMaximum: number;
  /** Bounded-sample extrema for context; these are not guaranteed raw extrema. */
  sourceMinimum: number;
  sourceMaximum: number;
}

export interface ImportedImage extends Partial<Omit<SourceMetadata, "name" | "relativePath">> {
  sourceId: string;
  name: string;
  relativePath: string;
  previewDataUrl?: string;
  displayStatistics?: DisplayStatistics;
  /**
   * Exact renderer-safe descriptor restored from a project before this source
   * has been re-inspected. Fresh inspection clears it so later saves use the
   * newly verified engine metadata instead.
   */
  restoredDescriptor?: SourceDescriptorV1;
}

export interface CellMeasurement {
  cellId: number;
  areaPx: number;
  centroidXPx: number;
  centroidYPx: number;
  equivalentDiameterPx: number;
  eccentricity: number;
}

export interface AnalysisQualityFlag {
  code: string;
  severity: "warning" | "error";
  message: string;
}

export interface AnalysisQuality {
  status: "nominal" | "warning" | "invalid";
  scope: "structural_sanity_only";
  flags: AnalysisQualityFlag[];
}

export interface AnalysisCorrections {
  revision: number;
  hasManualEdits: boolean;
  canUndo: boolean;
  canRedo: boolean;
  appliedOperations: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  eventCount: number;
  eventsTruncated: boolean;
}

export interface AnalysisResult {
  resultId: string;
  evictedResultIds: string[];
  source: SourceMetadata;
  engine: { id: string; version: string };
  profile: SegmentationProfileProvenance;
  settings: AnalysisSettings;
  resolved: { polarity: "dark" | "bright" | "cellpose-model"; threshold: number };
  runtime?: {
    package: { name: string; version: string };
    model: { artifactId: string; sha256: string };
    requestedDevice: CellposeDevice;
    resolvedDevice: Exclude<CellposeDevice, "auto">;
    fallbackReason: string | null;
    inferenceScale: number;
  };
  metrics: { count: number; confluencePercent: number };
  quality: AnalysisQuality;
  measurements: CellMeasurement[];
  corrections: AnalysisCorrections;
  previewDataUrl: string;
  overlayDataUrl: string;
}

export interface AnalysisCorrectionReceipt {
  resultId: string;
  evictedResultIds: string[];
  metrics: AnalysisResult["metrics"];
  quality: AnalysisQuality;
  measurements: CellMeasurement[];
  corrections: AnalysisCorrections;
  overlayDataUrl: string;
}

export interface EditableInstanceBoundary {
  resultId: string;
  cellId: number;
  sourceCoordinate: SourcePoint;
  vertices: SourcePoint[];
  simplified: boolean;
}

export interface SourcePoint {
  x: number;
  y: number;
}

export interface ExportOptions {
  overlayPng: boolean;
  labelsTiff: boolean;
  measurementsCsv: boolean;
  summaryCsv: boolean;
  analysisJson: boolean;
}

export interface ExportReceipt {
  directory: string;
  bundleName?: string;
  files: Record<string, string>;
  cellCount?: number;
}

export interface ViewerDisplaySettings {
  /** Normalized display black point, from 0 inclusive to below whitePoint. */
  blackPoint: number;
  /** Normalized display white point, above blackPoint to 1 inclusive. */
  whitePoint: number;
  /** Additive display offset, from -50 to 50 percent. */
  brightness: number;
  /** Midpoint contrast, from 0 to 200 percent. */
  contrast: number;
  /** Display gamma, from 0.2 to 3. */
  gamma: number;
  /** sRGB-like saturation, from 0 to 200 percent. */
  saturation: number;
  red: boolean;
  green: boolean;
  blue: boolean;
}

export type ViewerExportFormat = "png" | "tiff";

export interface ViewerExportOptions {
  format: ViewerExportFormat;
  settings: ViewerDisplaySettings;
}

export interface ViewerExportReceipt {
  path: string;
  format: ViewerExportFormat;
  width: number;
  height: number;
  channels: number;
  dtype: "uint8" | "uint16";
  byteLength: number;
  sourceSha256: string;
  outputSha256: string;
  settings: ViewerDisplaySettings;
}

export interface BatchExportSession {
  batchId: string;
}

export interface BatchExportFailure {
  sourceId: string;
  message: string;
}

export interface DurableBatchItemSummary {
  sourceId: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  attemptCount: number;
  resultId: string | null;
  failureCode: string | null;
  failureSummary: string | null;
}

export type DurableBatchSessionState =
  | "active"
  | "needs-attention"
  | "completed"
  | "cancelled";

export interface DurableBatchSession {
  batchId: string;
  parentJobId: string;
  createdAt: string;
  publicTitle: string;
  state: DurableBatchSessionState;
  profileId: string;
  settings: AnalysisSettings;
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  retryable: number;
  items: DurableBatchItemSummary[];
}

export interface BatchExportReceipt {
  cancelled: boolean;
  exportedCount: number;
  failedCount: number;
  manifestPath: string;
  summaryPath?: string;
  outputDirectory: string;
}

export interface DesktopSessionState {
  sourceCount: number;
  resultCount: number;
  isRunning: boolean;
  projectDirty: boolean;
}

export interface QuitProjectSaveRequest {
  requestId: string;
}

export interface QuitProjectSaveResult {
  requestId: string;
  status: "saved" | "failed";
}

export interface WindowPresentationState {
  fullscreen: boolean;
  maximized: boolean;
}

export interface CellposeStatus {
  profileId: CellposeProfileId;
  ready: boolean;
  code: string;
  summary: string;
  package: {
    requiredVersion: string;
    installedVersion: string | null;
    exact: boolean;
  };
  model: {
    artifactId: string;
    expectedSha256: string;
    expectedSizeBytes: number;
    present: boolean;
    verified: boolean;
  };
  devices: { cpu: boolean | null; mps: boolean | null; cuda: boolean | null };
}

export interface CellposeModelImportLocation {
  profileId: CellposeProfileId;
  artifactId: string;
  /** App-relative label safe to display without exposing the user's home path. */
  displayPath: string;
}

export interface ProjectSummary {
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
  revision: number;
  sourceCount: number;
}

export interface RecentProjectSummary {
  recentId: string;
  title: string;
  updatedAt: string;
  sourceCount: number;
}

export interface ProjectSessionReceipt {
  summary: ProjectSummary;
  manifest: ProjectManifestV1;
  sources: ImportedImage[];
  /** Fresh private-registry summaries returned without exposing project paths. */
  recentProjects?: RecentProjectSummary[];
}

export interface JobSummary {
  jobId: string;
  revision: number;
  kind: JobSpec["kind"];
  title: string;
  state: JobState;
  target: {
    kind: "local" | "remote";
    scheduler?: "pbs" | "slurm" | "direct";
    label?: string;
  };
  progress: number | null;
  publicMessage: string;
  cancellationRequested: boolean;
  interruptedState?: JobState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface LociDesktopApi {
  pickImages: () => Promise<ImportedImage[]>;
  pickFolder: () => Promise<ImportedImage[]>;
  createProject: (manifest: ProjectManifestV1) => Promise<ProjectSessionReceipt | null>;
  openProject: () => Promise<ProjectSessionReceipt | null>;
  openRecentProject: (recentId: string) => Promise<ProjectSessionReceipt>;
  saveProject: (
    manifest: ProjectManifestV1,
    quitRequestId?: string,
  ) => Promise<ProjectSessionReceipt>;
  confirmDiscardUnsavedProject: () => Promise<boolean>;
  listRecentProjects: () => Promise<RecentProjectSummary[]>;
  listJobs: () => Promise<JobSummary[]>;
  importDroppedFiles: (files: File[]) => Promise<ImportedImage[]>;
  inspectSource: (sourceId: string) => Promise<ImportedImage>;
  restoreProjectResult: (sourceId: string) => Promise<AnalysisResult | null>;
  removeSource: (sourceId: string) => Promise<{ removed: boolean }>;
  revealSource: (sourceId: string) => Promise<void>;
  discardResult: (sourceId: string, resultId: string) => Promise<{ discarded: boolean }>;
  discardAllResults: () => Promise<{
    discarded: Array<{ sourceId: string; resultId: string }>;
  }>;
  deleteInstance: (
    sourceId: string,
    resultId: string,
    point: SourcePoint,
  ) => Promise<AnalysisCorrectionReceipt>;
  addPolygon: (
    sourceId: string,
    resultId: string,
    points: SourcePoint[],
  ) => Promise<AnalysisCorrectionReceipt>;
  splitInstance: (
    sourceId: string,
    resultId: string,
    target: SourcePoint,
    points: SourcePoint[],
  ) => Promise<AnalysisCorrectionReceipt>;
  mergeInstances: (
    sourceId: string,
    resultId: string,
    first: SourcePoint,
    second: SourcePoint,
  ) => Promise<AnalysisCorrectionReceipt>;
  replaceInstanceBoundary: (
    sourceId: string,
    resultId: string,
    target: SourcePoint,
    points: SourcePoint[],
  ) => Promise<AnalysisCorrectionReceipt>;
  getInstanceBoundary: (
    sourceId: string,
    resultId: string,
    target: SourcePoint,
  ) => Promise<EditableInstanceBoundary>;
  paintMask: (
    sourceId: string,
    resultId: string,
    points: SourcePoint[],
    radiusPx: number,
  ) => Promise<AnalysisCorrectionReceipt>;
  eraseMask: (
    sourceId: string,
    resultId: string,
    points: SourcePoint[],
    radiusPx: number,
  ) => Promise<AnalysisCorrectionReceipt>;
  moveBoundaryVertex: (
    sourceId: string,
    resultId: string,
    target: SourcePoint,
    vertices: SourcePoint[],
  ) => Promise<AnalysisCorrectionReceipt>;
  undoCorrection: (sourceId: string, resultId: string) => Promise<AnalysisCorrectionReceipt>;
  redoCorrection: (sourceId: string, resultId: string) => Promise<AnalysisCorrectionReceipt>;
  listProfiles: () => Promise<SegmentationProfile[]>;
  getCellposeStatus: (profileId: CellposeProfileId) => Promise<CellposeStatus>;
  importCellposeModel: (profileId: CellposeProfileId) => Promise<CellposeStatus | null>;
  openCellposeModelPage: (profileId: CellposeProfileId) => Promise<void>;
  openCellposeModelFolder: (
    profileId: CellposeProfileId,
  ) => Promise<CellposeModelImportLocation>;
  segment: (request: {
    sourceId: string;
    settings: AnalysisSettings;
    profileId?: string;
  }) => Promise<AnalysisResult>;
  createBatchRun: (request: {
    sourceIds: string[];
    settings: AnalysisSettings;
    profileId: string;
  }) => Promise<DurableBatchSession>;
  listRecoverableBatchRuns: () => Promise<DurableBatchSession[]>;
  resumeBatchRun: (batchId: string) => Promise<DurableBatchSession>;
  beginBatchRunItem: (batchId: string, sourceId: string) => Promise<DurableBatchItemSummary>;
  completeBatchRunItem: (
    batchId: string,
    sourceId: string,
    resultId: string,
  ) => Promise<DurableBatchItemSummary>;
  failBatchRunItem: (
    batchId: string,
    sourceId: string,
    failureSummary: string,
  ) => Promise<DurableBatchItemSummary>;
  finishBatchRun: (batchId: string, cancelled: boolean) => Promise<DurableBatchSession>;
  cancelAnalysis: () => Promise<{ cancelled: boolean }>;
  exportResult: (
    sourceId: string,
    resultId: string,
    options: ExportOptions,
  ) => Promise<ExportReceipt | null>;
  exportView: (
    sourceId: string,
    options: ViewerExportOptions,
  ) => Promise<ViewerExportReceipt | null>;
  beginBatchExport: (options: ExportOptions) => Promise<BatchExportSession | null>;
  exportBatchResult: (
    batchId: string,
    sourceId: string,
    resultId: string,
  ) => Promise<ExportReceipt>;
  finishBatchExport: (
    batchId: string,
    failures: BatchExportFailure[],
    cancelled: boolean,
  ) => Promise<BatchExportReceipt>;
  onImportRequested: (callback: () => void) => () => void;
  onFolderImportRequested: (callback: () => void) => () => void;
  onOpenProjectRequested: (callback: () => void) => () => void;
  onSaveProjectRequested: (callback: () => void) => () => void;
  onJobsChanged: (callback: (jobs: JobSummary[]) => void) => () => void;
  onSettingsRequested: (callback: () => void) => () => void;
  onEngineInvalidated: (
    callback: (event: { generation: number; message: string }) => void,
  ) => () => void;
  onQuitProjectSaveRequested: (
    callback: (request: QuitProjectSaveRequest) => Promise<boolean>,
  ) => () => void;
  onQuitProjectSaveCancelled: (
    callback: (request: QuitProjectSaveRequest) => void,
  ) => () => void;
  updateSessionState: (state: DesktopSessionState) => void;
  requestQuit: () => void;
  getWindowPresentation: () => Promise<WindowPresentationState>;
  onWindowPresentationChanged: (
    callback: (state: WindowPresentationState) => void,
  ) => () => void;
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    loci: LociDesktopApi;
  }
}
