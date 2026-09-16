/** Renderer-safe records for the native research workbench bridge. */
export interface ResearchDimensions {
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  s?: number;
}
export interface ResearchLevel {
  index: number;
  dimensions: ResearchDimensions;
  calibration?: { axes: string; spacing: number[]; unit: string } | null;
}
export interface ResearchSource {
  id: string;
  name: string;
  sha256: string;
  size_bytes?: number;
  source_kind?: "native" | "whole_slide" | "ome_zarr" | "medical";
  locator_state?: "relink-required";
  relink_hint?: {
    selection_kind?: "series" | "file";
    file_count?: number;
    image_group?: string;
    multiscale_index?: number | null;
  };
  metadata: {
    format?: string;
    axes?: string;
    shape?: number[];
    geometry?: { axes?: string; unit?: string; frame?: string; affine?: number[][] };
    dimensions?: ResearchDimensions;
    levels?: ResearchLevel[];
    channel_names?: string[];
    channel_dtypes?: string[];
    sample_semantics?: string;
    physical_calibration?: { unit?: string; spacing?: number[] } | null;
    timing?: {
      source?: string;
      elapsed_times?: number[];
      uniform_interval?: number | null;
      interval_unit?: string;
    } | null;
  };
}
export interface ResearchResult {
  id: string;
  source_id: string;
  kind: string;
  created_at: string;
  revision_hash: string;
  object_count: number;
  source_sha256?: string;
  arrays?: Record<
    string,
    { shape?: number[]; dtype?: string; sha256?: string; [key: string]: unknown }
  >;
  geometry?: {
    axes?: string;
    affine?: number[][];
    unit?: string;
    frame?: string;
  } | null;
  selection?: (ResearchSelection & { elapsed_time_s?: number }) | null;
  parent_id?: string | null;
  review?: { disposition: string } | null;
}
export interface ResearchChannelDeclaration {
  index: number;
  name: string;
  marker: string;
  fluorophore: string;
  declaration: string;
}
export interface ResearchChannelMetadata {
  source_id: string;
  source_sha256: string;
  original_names: string[];
  revision: number;
  channels: ResearchChannelDeclaration[];
  basis: string;
}
export interface ResearchRecipe {
  input_transform?: "rgb_intensity";
  steps: Array<Record<string, unknown>>;
  segmentation: Record<string, unknown> | null;
  measurement_channels: number[];
  gates: Array<{
    name: string;
    channel: string;
    statistic: "mean" | "sum" | "max";
    threshold: number;
    control: string;
  }>;
  working_bytes: number;
  references?: Partial<Record<
    "flatfield" | "darkfield",
    { source_id: string; selection: ResearchSelection }
  >>;
}
export type ResearchAgentDisclosure =
  | "geometry"
  | "source_names"
  | "previews"
  | "measurements"
  | "provenance"
  | "agent_metadata";
export interface ResearchAgentAccessRequest {
  source_id: string;
  selection: ResearchSelection;
  recipe: ResearchRecipe;
  allow_preview: boolean;
  allow_run: boolean;
  allow_export: boolean;
  export_names: string[];
  disclosures: ResearchAgentDisclosure[];
  limits: { cpu_seconds: number; memory_bytes: number; concurrency: number };
}
export interface ResearchAgentAccessReceipt {
  schema: "loci.agent-policy/v1";
  policy_sha256: string;
  project_id: string;
  recipe_sha256: string;
  policy_filename: string;
  config_filename: string;
  disclosures: ResearchAgentDisclosure[];
  operations: string[];
  source_id: string;
  selection: ResearchSelection;
}
export interface ResearchSample {
  id: string;
  revision: number;
  data: ResearchSampleData;
}
export interface ResearchSampleData {
  study: string;
  sample: string;
  condition: string;
  biological_replicate?: string | null;
  plate?: string | null;
  well?: string | null;
}
export type ResearchJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface ResearchJob {
  id: string;
  operation: string;
  request: Record<string, unknown>;
  request_key: string;
  request_hash: string;
  state: ResearchJobState;
  created_at: string;
  updated_at: string;
  progress: number;
  cancel_requested: boolean;
  result_ids: string[];
  error: string | null;
}
export interface ResearchBatchSourceBinding {
  id: string;
  sha256: string;
}
export interface ResearchBatchTask {
  operation: "run_recipe" | "classical_run" | "cellpose_run";
  source: ResearchBatchSourceBinding;
  request: Record<string, unknown>;
}
export interface ResearchBatchReceipt {
  batch_id: string;
  jobs: ResearchJob[];
}
export interface ResearchWorkspaceChange {
  expected_revision: number;
  sources: Array<{ id: string; sha256: string; visible: boolean }>;
  results: Array<{ id: string; revision_hash: string; visible: boolean }>;
}
export interface ResearchSourceOrderChange {
  expected_revision: number;
  sources: Array<{ id: string; sha256: string }>;
}
export interface ResearchSnapshot {
  project: { title: string; counts?: Record<string, number> };
  sources: ResearchSource[];
  results: ResearchResult[];
  workspace?: { revision: number; closed_sources: ResearchSource[]; hidden_results: ResearchResult[] };
  samples: ResearchSample[];
  recipes: unknown[];
  displays: unknown[];
  channels?: Array<{
    id: string;
    revision: number;
    data: Omit<ResearchChannelMetadata, "source_id" | "revision" | "basis">;
  }>;
  selections: Array<{
    id: string;
    revision: number;
    data: { result_id: string; revision_hash: string };
  }>;
  comparisons?: Array<{
    id: string;
    revision: number;
    updated_at: string;
    data: Record<string, unknown>;
  }>;
  jobs: ResearchJob[];
  operations: Record<string, { mutates: boolean; summary: string }>;
}
export interface ResearchSelection {
  x: number;
  y: number;
  width: number;
  height: number;
  t: number;
  c: number;
  z: number;
  z_stop?: number;
  level: number;
}

export type VolumeFigurePayloadRecord = {
  role: "whole-volume-context" | "level-zero-focus" | "native-detail-focus";
  data_sha256: string;
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
  scalar_type: string;
  source_dtypes: string[];
  component_indices: number[];
  encoding_basis: string;
  byte_length: number;
  sampling: {
    method: string;
    source_indices_xyz: [number[], number[], number[]];
    level_zero_indices_xyz: [number[], number[], number[]];
  };
};

export type VolumeFigureExportRequest = {
  schema_version: "loci.volume-figure-request/v1";
  source_id: string;
  source_sha256: string;
  width_px: number;
  height_px: number;
  png_base64: string;
  manifest: {
    schema_version: "loci.volume-figure/v1";
    figure: {
      kind: "screen-resolution-rendered-figure";
      format: "png";
      width_px: number;
      height_px: number;
      device_pixel_ratio: number;
      capture_scale: 1;
    };
    source: { source_id: string; source_sha256: string; t: number };
    payloads: { context: VolumeFigurePayloadRecord; focus: VolumeFigurePayloadRecord | null };
    representation: {
      mode: "volume" | "mpr";
      extent: "context" | "focus";
      interpolation: "linear";
      shading: boolean;
      blend_mode?: string | null;
      quality?: number | null;
      lighting?: { ambient: number; diffuse: number; specular: number; specular_power: number; gradient_opacity: false } | null;
      orientation_axes: true;
    };
    camera: {
      projection: "perspective" | "parallel";
      position_xyz: [number, number, number];
      focal_point_xyz: [number, number, number];
      view_up_xyz: [number, number, number];
      clipping_range: [number, number];
      view_angle_degrees: number;
      parallel_scale: number | null;
    };
    transfers: Array<{
      channel_index: number;
      name: string;
      color_rgb: [number, number, number];
      color_mode: "constant" | "intensity";
      window: { low: number; high: number; gamma: number };
      opacity: number;
      visible: boolean;
      source_opacity_points: [number, number][];
      resolved_points: Array<{
        scalar: number;
        opacity: number;
        color_rgb: [number, number, number];
      }>;
      opacity_unit_distance: number | null;
      provenance: Record<string, string>;
    }>;
    clipping: { enabled: false } | {
      enabled: true;
      axis: "x" | "y" | "z";
      position_percent: number;
      plane_origin_xyz: [number, number, number];
      plane_normal_xyz: [number, number, number];
    };
    mpr: null | {
      context_display_indices_xyz: [number, number, number];
      active_payload_indices_xyz: [number, number, number];
      source_indices_xyz: [number, number, number];
      world_xyz: [number, number, number];
    };
    background: { rgb: [number, number, number] };
    software: {
      renderer: "vtk.js";
      renderer_version: "36.12.0";
      capture_method: "captureNextImage";
    };
    provenance: {
      artifact_semantics: "Rendered display RGB at native canvas resolution; not original-value scientific data.";
      screen_resolution_only: true;
      scale_bar_included: false;
      high_resolution_claim: false;
      biological_or_clinical_validation_claim: false;
      metadata_contains_source_pixel_data: false;
    };
  };
};

export type VolumeFigureExportReceipt = {
  basename: string;
  width: number;
  height: number;
  hashes: { "image.png": string; "manifest.json": string };
};
export interface ManagedSessionSummary {
  sessionId: string;
  title: string;
  storage: "managed" | "saved";
  saved: boolean;
  status: "ready" | "recoverable";
  reason: "saved-study-missing" | "saved-study-unsafe" | "managed-session-missing" | "managed-session-unsafe" | null;
  canKeep: boolean;
  canDiscard: boolean;
  /** Registry activity time, not scientific source or result metadata. */
  updatedAt?: string;
}
export type ManagedSessionState = { status: "empty" } | ManagedSessionSummary;

export type BatchChannelColorPalette = Array<{ channel: number; color: string }>;
export interface BatchChannelColorChange {
  channel: number;
  channel_name: string;
  old_color: string;
  new_color: string;
}
export interface BatchChannelColorSource {
  source_id: string;
  source_name: string;
  revision: number;
  status: "ready" | "applied" | "unchanged" | "skipped";
  reason: string | null;
  changes: BatchChannelColorChange[];
}
export interface BatchChannelColorsResponse {
  preview_only: boolean;
  total_sources: number;
  applicable_count: number;
  applied_count: number;
  skipped_count: number;
  affected_sources: BatchChannelColorSource[];
  previous_palettes: Record<string, BatchChannelColorPalette>;
  new_revisions: Record<string, number>;
}
export interface ResearchExecuteOptions {
  /** Stable identity of one renderer view; used only for main-process request scheduling. */
  viewer_lane: string;
}
export interface ResearchDesktopApi {
  updateWorkspace?(request: ResearchWorkspaceChange): Promise<ResearchSnapshot>;
  reorderSources?(request: ResearchSourceOrderChange): Promise<ResearchSnapshot>;
  exportSourceView?(request: Record<string, unknown>): Promise<{
    basename: string; sha256: string; width: number; height: number; sampling: string;
    format?: "png" | "tiff"; dtype?: "uint8" | "uint16"; channels?: number;
    display_revision?: string;
  } | null>;
  exportVolumeFigure?(request: VolumeFigureExportRequest): Promise<VolumeFigureExportReceipt | null>;
  exportSourceAnnotations?(binding: { source_id: string; source_sha256: string; expected_revision: number }): Promise<{ basename: string; sha256: string; annotation_count: number } | null>;
  importSourceAnnotations?(binding: { source_id: string; source_sha256: string; expected_revision: number }): Promise<unknown | null>;
  importLegacyProject?(): Promise<{ snapshot: ResearchSnapshot; receipt: Record<string, unknown> } | null>;
  openImages?(kind?: "files" | "folder" | "dicom" | "ome_zarr"): Promise<ResearchSnapshot | null>;
  openDropped?(files: File[]): Promise<ResearchSnapshot | null>;
  sessionState?(): Promise<ManagedSessionState>;
  newSession?(): Promise<ManagedSessionState>;
  saveAs?(): Promise<ResearchSnapshot | null>;
  recoveryList?(): Promise<ManagedSessionSummary[]>;
  recoveryKeep?(sessionId: string): Promise<ResearchSnapshot | null>;
  recoveryDiscard?(sessionId: string): Promise<{ undoToken: string }>;
  recoveryUndo?(undoToken: string): Promise<ManagedSessionState>;
  cancelView?(): Promise<unknown>;
  inspectVendor?(): Promise<ResearchVendorGrant | null>;
  convertVendor?(request: ResearchVendorRequest): Promise<{
    snapshot: ResearchSnapshot; conversion: Record<string, unknown>;
  } | null>;
  /** Native archive dialogs keep canonical paths outside renderer-safe state. */
  exportStudy?(): Promise<unknown | null>;
  importStudy?(): Promise<ResearchSnapshot | null>;
  relinkSource?(
    sourceId: string,
    kind: "file" | "dicom" | "ome_zarr",
  ): Promise<ResearchSnapshot | null>;
  exportRecipe?(recipeId: string, sourceId: string): Promise<unknown | null>;
  importRecipe?(bindings: Record<string, string>): Promise<unknown | null>;
  createStudy(): Promise<ResearchSnapshot | null>;
  openStudy(): Promise<ResearchSnapshot | null>;
  getSnapshot(): Promise<ResearchSnapshot | null>;
  addSources(kind?: "files" | "dicom" | "ome_zarr"): Promise<ResearchSnapshot>;
  /** Opens a local package picker; package paths never cross the renderer boundary. */
  importModel?(workingBytes: number, recoveryModelId?: string): Promise<unknown>;
  /** Opens native destination dialogs; no canonical path crosses into the renderer. */
  createAgentAccess?(
    request: ResearchAgentAccessRequest,
  ): Promise<ResearchAgentAccessReceipt | null>;
  execute(
    operation: string,
    request: Record<string, unknown>,
    options?: ResearchExecuteOptions,
  ): Promise<unknown>;
  submitBatch?(tasks: ResearchBatchTask[]): Promise<ResearchBatchReceipt>;
  runBatchJob?(batchId: string, jobId: string): Promise<unknown>;
  resumeBatch?(batchId: string): Promise<ResearchBatchReceipt>;
  retryBatch?(batchId: string): Promise<ResearchBatchReceipt>;
  exportBatch?(
    bindings: Array<{
      source_id: string;
      source_sha256: string;
      result_id: string;
      revision_hash: string;
    }>,
    options: { mode: "bundles" | "bundles+summary" | "summary-only" },
  ): Promise<{
    exportedCount: number;
    selectedCount: number;
    mode: "bundles" | "bundles+summary" | "summary-only";
    manifestName: string;
    summaryName: string | null;
  } | null>;
  reviewResult(
    resultId: string,
    revisionHash: string,
    disposition: "reviewed" | "excluded" | "pending",
  ): Promise<unknown>;
  exportResult(resultId: string, revisionHash: string): Promise<unknown>;
  cancelJob(jobId: string): Promise<unknown>;
}

export interface ResearchVendorGrant {
  grant_id: string;
  source_name: string;
  source_sha256: string;
  inspection: {
    schema_version: "loci.vendor-inspection/v1";
    format: string;
    source_size_bytes: number;
    source_sha256: string;
    series: Array<{
      index: number; dimensions: { x: number; y: number; z: number; c: number; t: number };
      dimension_order: string; dtype: string; channel_names: string[];
      samples_per_channel: number[];
      calibration: Record<string, { value: number; unit: string }> | null;
    }>;
    runtime: { bioformats_version: string; bioformats_jar_sha256: string;
      bioformats_jar_size_bytes: number; java_sha256: string; java_version: string };
  };
}
export interface ResearchVendorRequest {
  grant_id: string; series: number; c: number; z: number; t: number;
  crop: { x: number; y: number; width: number; height: number } | null;
  heap_mib: number; timeout_seconds: number; max_output_bytes: number;
}

export interface ResearchFieldAssayPreviewRequest {
  source_id: string;
  nuclei_channel: number;
  signal_channel: number;
  z?: number;
  t?: number;
  focus_annotation_id?: string;
  focus_mask_base64?: string;
  focus_all?: boolean;
  background_value?: number;
  background_annotation_id?: string;
  background_mask_base64?: string;
  manual_count?: number;
  manual_points?: Array<{ x: number; y: number; id?: string }>;
  manual_points_annotation_id?: string;
  config?: Record<string, unknown>;
  endpoint_status?: "exploratory" | "reviewed";
}

export interface ResearchFieldAssayRunRequest extends ResearchFieldAssayPreviewRequest {
  reviewer?: string;
  assay_notes?: string;
  channel_identity_confirmed?: boolean;
  acquisition_comparable?: boolean;
  focus_reviewed?: boolean;
  nuclei_reviewed?: boolean;
  background_reviewed?: boolean;
  saturation_reviewed?: boolean;
}

export interface ResearchBatchChannelColorsRequest {
  source_ids: string[];
  preview_only?: boolean;
  mapping_mode?: "index" | "name" | "auto" | "restore";
  color_map?: Record<string, string>;
  restore_palettes?: Record<string, Array<{ channel: number; color: string }>>;
  expected_revisions?: Record<string, number>;
}
