// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AnalysisResult,
  CellposeProfileId,
  CellposeStatus,
  DurableBatchSession,
  ImportedImage,
  JobSummary,
  LociDesktopApi,
  QuitProjectSaveRequest,
  SegmentationProfile,
} from "../shared/contracts";
import App, {
  histogramPath,
  rangeProgress,
  simplifyCorrectionStroke,
  viewerFilterParameters,
} from "./App";
import { createProjectManifest } from "./project-manifest";

const previewDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const importedImage: ImportedImage = {
  sourceId: "source-1",
  name: "plate-a.tif",
  relativePath: "plate-a.tif",
  width: 2048,
  height: 1536,
  channels: 1,
  dtype: "uint16",
  format: "tiff",
  pageCount: 1,
  displayStatistics: {
    histogramBins: [1, 3, 8, 14, 9, 5, 2, 1],
    percentileLow: 0.08,
    percentileHigh: 0.91,
    basis: "intensity",
    sampleCount: 43,
    displayMinimum: 256,
    displayMaximum: 65_000,
    sourceMinimum: 128,
    sourceMaximum: 65_535,
  },
  previewDataUrl,
};

const imsOverview: ImportedImage = {
  ...importedImage,
  sourceId: "source-ims",
  name: "volume.ims",
  relativePath: "volume.ims",
  width: 2304,
  height: 2304,
  channels: 2,
  dtype: "uint16",
  format: "IMS",
  colorModel: "channel-composite",
  accessMode: "overview",
  viewOnlyReason: "This source is available as one bounded pyramid overview.",
  sourceDetails: {
    kind: "ims-volume",
    width: 2304,
    height: 2304,
    depth: 3,
    channels: 2,
    timepoints: 1,
    resolutionLevels: 2,
    selectedResolutionLevel: 1,
    selectedLevelWidth: 8,
    selectedLevelHeight: 6,
    selectedLevelDepth: 2,
    selectedTimepoint: 0,
    selectedZ: 1,
    samplingStride: 1,
    channelNames: ["Signal A", "Signal B"],
    channelDtypes: ["uint16", "uint16"],
    channelColorSources: ["declared-base-colour", "declared-base-colour"],
    channelRangeSources: ["stored-histogram-range", "stored-histogram-range"],
    compositeMode: "loci-overview-composite",
    renderedDtype: "uint8",
    physicalExtents: [[0, 230.4], [0, 115.2], [0, 6]],
    voxelSize: [0.1, 0.05, 2],
    physicalUnit: "um",
  },
};

const singleChannelImsOverview: ImportedImage = {
  ...imsOverview,
  sourceId: "source-ims-single",
  name: "single-channel.ims",
  relativePath: "single-channel.ims",
  channels: 1,
  colorModel: "intensity",
  sourceDetails: {
    kind: "ims-volume",
    width: 2304,
    height: 2304,
    depth: 3,
    channels: 1,
    timepoints: 1,
    resolutionLevels: 2,
    selectedResolutionLevel: 1,
    selectedLevelWidth: 8,
    selectedLevelHeight: 6,
    selectedLevelDepth: 2,
    selectedTimepoint: 0,
    selectedZ: 1,
    samplingStride: 1,
    channelNames: ["Signal A"],
    channelDtypes: ["uint16"],
    channelColorSources: ["declared-base-colour"],
    channelRangeSources: ["native-channel-values"],
    compositeMode: "single-channel",
    renderedDtype: "uint16",
  },
};

const tiffPyramidOverview: ImportedImage = {
  ...importedImage,
  sourceId: "source-pyramid",
  name: "whole-slide.tiff",
  relativePath: "whole-slide.tiff",
  width: 8192,
  height: 6144,
  channels: 3,
  dtype: "uint8",
  format: "TIFF",
  colorModel: "interleaved-rgb",
  accessMode: "overview",
  viewOnlyReason: "This source is available from one stored TIFF pyramid level.",
  sourceDetails: {
    kind: "tiff-pyramid",
    width: 8192,
    height: 6144,
    channels: 3,
    dtype: "uint8",
    resolutionLevels: 3,
    selectedResolutionLevel: 2,
    selectedLevelWidth: 512,
    selectedLevelHeight: 384,
    fullDecodedBytes: 150_994_944,
    selectedDecodedBytes: 589_824,
    tiled: true,
    selectedLevelTiled: true,
  },
};

const analysisResult: AnalysisResult = {
  resultId: "result-1",
  evictedResultIds: [],
  source: {
    name: importedImage.name,
    relativePath: importedImage.relativePath,
    width: importedImage.width!,
    height: importedImage.height!,
    channels: importedImage.channels!,
    dtype: importedImage.dtype!,
    format: importedImage.format!,
    pageCount: importedImage.pageCount!,
  },
  engine: { id: "loci-classical", version: "0.1.0" },
  profile: {
    id: "loci-classical",
    name: "Loci Classical",
    version: "0.1.0",
    backendKind: "classical",
    model: { format: "builtin-algorithm", artifactId: null, sha256: null },
    preprocessing: {
      channelConversion: "grayscale-luminance",
      intensityNormalization: "per-image-percentile-1-99",
      resizePolicy: "none",
      maxEdgePx: null,
      outputGrid: "source-resolution",
    },
  },
  settings: {
    image_mode: "auto",
    polarity: "auto",
    expected_diameter_px: 34,
    min_area_px: 80,
    sensitivity: 0,
    smoothing_px: 1.2,
    split_touching: true,
    exclude_border: false,
  },
  resolved: { polarity: "dark", threshold: 0.47 },
  metrics: { count: 42, confluencePercent: 12.5 },
  quality: { status: "nominal", scope: "structural_sanity_only", flags: [] },
  measurements: [],
  corrections: {
    revision: 0,
    hasManualEdits: false,
    canUndo: false,
    canRedo: false,
    appliedOperations: [],
    events: [],
    eventCount: 0,
    eventsTruncated: false,
  },
  previewDataUrl,
  overlayDataUrl: previewDataUrl,
};

const readyClassicalProfile: SegmentationProfile = {
  schemaVersion: "1.2",
  id: "loci-classical",
  name: "Loci Adaptive Watershed",
  version: "0.1.0",
  status: "ready",
  availability: { code: "ready", summary: "Built in." },
  backendKind: "classical",
  model: { format: "builtin-algorithm", artifactId: null, sha256: null },
  preprocessing: analysisResult.profile.preprocessing,
  rights: {
    codeLicense: "Apache-2.0",
    modelLicense: "not-applicable",
    redistribution: "bundled",
    commercialUse: "permitted",
    trainingDataLineage: "No learned weights.",
  },
  recommendedSettings: analysisResult.settings,
  settingsContract: [],
  validation: { status: "baseline", summary: "Baseline.", failureModes: [] },
};

const cellposeRecommendedSettings = {
  max_edge_px: 1000,
  diameter_px: 0,
  flow_threshold: 0.4,
  cellprob_threshold: 0,
  min_size_px: 15,
  max_size_fraction: 0.4,
  niter: 250,
  batch_size: 8,
  resample: true,
  augment: false,
  tile_overlap: 0.1,
  normalize: true,
  percentile_low: 1,
  percentile_high: 99,
  tile_norm_blocksize: 0,
  sharpen_radius: 0,
  smooth_radius: 0,
  invert: false,
  device: "auto" as const,
};

function cellposeProfile(
  id: CellposeProfileId,
  status: SegmentationProfile["status"] = "ready",
): SegmentationProfile {
  const websiteCompatible = id === "cellpose-sam";
  return {
    ...readyClassicalProfile,
    id,
    name: websiteCompatible ? "Cellpose-SAM · Website compatible" : "Cellpose-SAM v2",
    version: "4.2.1.1",
    status,
    availability: status === "ready"
      ? { code: "ready", summary: "The exact runtime and checkpoint are ready." }
      : { code: "package-missing", summary: "Install the exact Cellpose runtime and checkpoint." },
    backendKind: "cellpose",
    model: {
      format: "cellpose-native",
      artifactId: websiteCompatible ? "cpsam" : "cpsam_v2",
      sha256: websiteCompatible ? "1".repeat(64) : "2".repeat(64),
    },
    preprocessing: {
      channelConversion: "rgb-or-replicated-grayscale",
      intensityNormalization: "cellpose-configurable-percentile",
      resizePolicy: "downsample-only",
      maxEdgePx: 1000,
      outputGrid: "source-resolution",
    },
    recommendedSettings: cellposeRecommendedSettings,
    settingsContract: [{
      key: "max_edge_px",
      label: "Maximum inference edge",
      section: "Input",
      valueType: "integer",
      help: "Downsample only above this edge.",
      minimum: 64,
      maximum: 10_000,
      step: 16,
      choices: [],
    }],
  };
}

function cellposeStatus(profileId: CellposeProfileId, ready = true): CellposeStatus {
  const websiteCompatible = profileId === "cellpose-sam";
  return {
    profileId,
    ready,
    code: ready ? "ready" : "package-missing",
    summary: ready ? "Cellpose is ready." : "Cellpose runtime is not installed.",
    package: { requiredVersion: "4.2.1.1", installedVersion: ready ? "4.2.1.1" : null, exact: ready },
    model: {
      artifactId: websiteCompatible ? "cpsam" : "cpsam_v2",
      expectedSha256: websiteCompatible ? "1".repeat(64) : "2".repeat(64),
      expectedSizeBytes: websiteCompatible ? 1_233_587_898 : 1_233_586_851,
      present: ready,
      verified: ready,
    },
    devices: { cpu: ready, mps: ready, cuda: false },
  };
}

function mockApi(overrides: Partial<LociDesktopApi> = {}): LociDesktopApi {
  return {
    pickImages: vi.fn().mockResolvedValue([importedImage]),
    pickFolder: vi.fn().mockResolvedValue([importedImage]),
    createProject: vi.fn().mockResolvedValue(null),
    openProject: vi.fn().mockResolvedValue(null),
    openRecentProject: vi.fn().mockRejectedValue(new Error("Recent project unavailable.")),
    saveProject: vi.fn().mockRejectedValue(new Error("No active project.")),
    confirmDiscardUnsavedProject: vi.fn().mockResolvedValue(false),
    listRecentProjects: vi.fn().mockResolvedValue([]),
    listJobs: vi.fn().mockResolvedValue([]),
    importDroppedFiles: vi.fn().mockResolvedValue([importedImage]),
    inspectSource: vi.fn().mockResolvedValue(importedImage),
    restoreProjectResult: vi.fn().mockResolvedValue(null),
    listProfiles: vi.fn().mockResolvedValue([readyClassicalProfile]),
    getCellposeStatus: vi.fn().mockResolvedValue(cellposeStatus("cellpose-sam-v2", false)),
    importCellposeModel: vi.fn().mockResolvedValue(null),
    openCellposeModelPage: vi.fn().mockResolvedValue(undefined),
    openCellposeModelFolder: vi.fn().mockResolvedValue({
      profileId: "cellpose-sam-v2",
      artifactId: "cpsam_v2",
      displayPath: "Model Imports/cpsam_v2",
    }),
    segment: vi.fn().mockResolvedValue(analysisResult),
    createBatchRun: vi.fn().mockResolvedValue({
      batchId: "batch-1",
      parentJobId: "batch-1",
      createdAt: "2026-08-30T00:00:00.000Z",
      publicTitle: "Segment 2 images",
      state: "active",
      profileId: "loci-classical",
      settings: analysisResult.settings,
      total: 2,
      pending: 2,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      retryable: 0,
      items: [
        { sourceId: "source-1", state: "pending", attemptCount: 0, resultId: null, failureCode: null, failureSummary: null },
        { sourceId: "source-2", state: "pending", attemptCount: 0, resultId: null, failureCode: null, failureSummary: null },
      ],
    }),
    listRecoverableBatchRuns: vi.fn().mockResolvedValue([]),
    resumeBatchRun: vi.fn().mockRejectedValue(new Error("No recoverable batch.")),
    beginBatchRunItem: vi.fn().mockResolvedValue({
      sourceId: "source-1", state: "running", attemptCount: 1, resultId: null, failureCode: null, failureSummary: null,
    }),
    completeBatchRunItem: vi.fn().mockResolvedValue({
      sourceId: "source-1", state: "completed", attemptCount: 1, resultId: "result-1", failureCode: null, failureSummary: null,
    }),
    failBatchRunItem: vi.fn().mockResolvedValue({
      sourceId: "source-1", state: "failed", attemptCount: 1, resultId: null, failureCode: "analysis-failed", failureSummary: "Failed.",
    }),
    finishBatchRun: vi.fn().mockResolvedValue({
      batchId: "batch-1",
      parentJobId: "batch-1",
      createdAt: "2026-08-30T00:00:00.000Z",
      publicTitle: "Segment 2 images",
      state: "completed",
      profileId: "loci-classical",
      settings: analysisResult.settings,
      total: 2,
      pending: 0,
      running: 0,
      completed: 2,
      failed: 0,
      cancelled: 0,
      retryable: 0,
      items: [],
    }),
    removeSource: vi.fn().mockResolvedValue({ removed: true }),
    revealSource: vi.fn().mockResolvedValue(undefined),
    discardResult: vi.fn().mockResolvedValue({ discarded: true }),
    discardAllResults: vi.fn().mockResolvedValue({ discarded: [] }),
    deleteInstance: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      evictedResultIds: [],
      metrics: { ...analysisResult.metrics, count: analysisResult.metrics.count - 1 },
      quality: analysisResult.quality,
      measurements: analysisResult.measurements,
      corrections: {
        ...analysisResult.corrections,
        revision: 1,
        hasManualEdits: true,
        canUndo: true,
      },
      overlayDataUrl: analysisResult.overlayDataUrl,
    }),
    addPolygon: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      evictedResultIds: [],
      metrics: { ...analysisResult.metrics, count: analysisResult.metrics.count + 1 },
      quality: analysisResult.quality,
      measurements: analysisResult.measurements,
      corrections: {
        ...analysisResult.corrections,
        revision: 1,
        hasManualEdits: true,
        canUndo: true,
      },
      overlayDataUrl: analysisResult.overlayDataUrl,
    }),
    splitInstance: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      evictedResultIds: [],
      metrics: { ...analysisResult.metrics, count: analysisResult.metrics.count + 1 },
      quality: analysisResult.quality,
      measurements: analysisResult.measurements,
      corrections: { ...analysisResult.corrections, revision: 1, hasManualEdits: true, canUndo: true },
      overlayDataUrl: analysisResult.overlayDataUrl,
    }),
    mergeInstances: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      evictedResultIds: [],
      metrics: { ...analysisResult.metrics, count: analysisResult.metrics.count - 1 },
      quality: analysisResult.quality,
      measurements: analysisResult.measurements,
      corrections: { ...analysisResult.corrections, revision: 1, hasManualEdits: true, canUndo: true },
      overlayDataUrl: analysisResult.overlayDataUrl,
    }),
    replaceInstanceBoundary: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      evictedResultIds: [],
      metrics: analysisResult.metrics,
      quality: analysisResult.quality,
      measurements: analysisResult.measurements,
      corrections: { ...analysisResult.corrections, revision: 1, hasManualEdits: true, canUndo: true },
      overlayDataUrl: analysisResult.overlayDataUrl,
    }),
    getInstanceBoundary: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      cellId: 1,
      sourceCoordinate: { x: 10, y: 10 },
      vertices: [{ x: 8, y: 8 }, { x: 12, y: 8 }, { x: 10, y: 12 }],
      simplified: false,
    }),
    paintMask: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      evictedResultIds: [],
      metrics: analysisResult.metrics,
      quality: analysisResult.quality,
      measurements: analysisResult.measurements,
      corrections: { ...analysisResult.corrections, revision: 1, hasManualEdits: true, canUndo: true },
      overlayDataUrl: analysisResult.overlayDataUrl,
    }),
    eraseMask: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      evictedResultIds: [],
      metrics: analysisResult.metrics,
      quality: analysisResult.quality,
      measurements: analysisResult.measurements,
      corrections: { ...analysisResult.corrections, revision: 1, hasManualEdits: true, canUndo: true },
      overlayDataUrl: analysisResult.overlayDataUrl,
    }),
    moveBoundaryVertex: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      evictedResultIds: [],
      metrics: analysisResult.metrics,
      quality: analysisResult.quality,
      measurements: analysisResult.measurements,
      corrections: { ...analysisResult.corrections, revision: 1, hasManualEdits: true, canUndo: true },
      overlayDataUrl: analysisResult.overlayDataUrl,
    }),
    undoCorrection: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      evictedResultIds: [],
      metrics: analysisResult.metrics,
      quality: analysisResult.quality,
      measurements: analysisResult.measurements,
      corrections: { ...analysisResult.corrections, revision: 2, canRedo: true },
      overlayDataUrl: analysisResult.overlayDataUrl,
    }),
    redoCorrection: vi.fn().mockResolvedValue({
      resultId: analysisResult.resultId,
      evictedResultIds: [],
      metrics: analysisResult.metrics,
      quality: analysisResult.quality,
      measurements: analysisResult.measurements,
      corrections: { ...analysisResult.corrections, revision: 3, canUndo: true },
      overlayDataUrl: analysisResult.overlayDataUrl,
    }),
    cancelAnalysis: vi.fn().mockResolvedValue({ cancelled: true }),
    exportResult: vi.fn().mockResolvedValue({
      directory: "/lab/export",
      files: { overlay: "/lab/export/overlay.png", measurements: "/lab/export/cells.csv" },
    }),
    exportView: vi.fn().mockResolvedValue({
      path: "/lab/export/plate-a_loci_view.tiff",
      format: "tiff",
      width: 2048,
      height: 1536,
      channels: 1,
      dtype: "uint16",
      byteLength: 1024,
      sourceSha256: "a".repeat(64),
      outputSha256: "b".repeat(64),
      settings: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    }),
    beginBatchExport: vi.fn().mockResolvedValue({ batchId: "batch-1" }),
    exportBatchResult: vi.fn().mockResolvedValue({
      directory: "/lab/export/plate-a_loci",
      files: { overlay: "/lab/export/plate-a_loci/plate-a_overlay.png" },
    }),
    finishBatchExport: vi.fn().mockResolvedValue({
      cancelled: false,
      exportedCount: 2,
      failedCount: 0,
      manifestPath: "/lab/export/loci_batch_manifest.json",
      outputDirectory: "/lab/export",
    }),
    onImportRequested: vi.fn().mockReturnValue(() => undefined),
    onFolderImportRequested: vi.fn().mockReturnValue(() => undefined),
    onOpenProjectRequested: vi.fn().mockReturnValue(() => undefined),
    onSaveProjectRequested: vi.fn().mockReturnValue(() => undefined),
    onJobsChanged: vi.fn().mockReturnValue(() => undefined),
    onSettingsRequested: vi.fn().mockReturnValue(() => undefined),
    onEngineInvalidated: vi.fn().mockReturnValue(() => undefined),
    onQuitProjectSaveRequested: vi.fn().mockReturnValue(() => undefined),
    onQuitProjectSaveCancelled: vi.fn().mockReturnValue(() => undefined),
    updateSessionState: vi.fn(),
    requestQuit: vi.fn(),
    getWindowPresentation: vi.fn().mockResolvedValue({ fullscreen: false, maximized: false }),
    onWindowPresentationChanged: vi.fn().mockReturnValue(() => undefined),
    platform: "darwin",
    ...overrides,
  };
}

function successfulProjectCreation(sources: ImportedImage[]) {
  return vi.fn(async (manifest: ReturnType<typeof createProjectManifest>) => ({
    summary: {
      projectId: manifest.projectId,
      title: manifest.title,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      appVersion: manifest.appVersion,
      revision: 0,
      sourceCount: sources.length,
    },
    manifest,
    sources,
  }));
}

function successfulProjectSave(sources: ImportedImage[]) {
  return vi.fn(async (manifest: ReturnType<typeof createProjectManifest>) =>
    projectReceipt(manifest, sources, 1));
}

function projectReceipt(
  manifest: ReturnType<typeof createProjectManifest>,
  sources: ImportedImage[],
  revision = 0,
) {
  return {
    summary: {
      projectId: manifest.projectId,
      title: manifest.title,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      appVersion: manifest.appVersion,
      revision,
      sourceCount: sources.length,
    },
    manifest,
    sources,
  };
}

function declareActiveProjectResult(
  manifest: ReturnType<typeof createProjectManifest>,
  sourceId = "source-1",
  resultId = "result-1",
): void {
  manifest.modelResults = [
    ...manifest.modelResults.filter((result) => result.sourceId !== sourceId),
    {
    sourceId,
    resultId,
    modelId: "loci-classical",
    modelSha256: null,
    evidenceStatus: "experimental",
    createdAt: "2026-09-01T00:00:01.000Z",
    resultManifestId: `manifest-${resultId}`,
    },
  ];
}

async function saveImportedSourcesAsProject(api: LociDesktopApi): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(api.createProject).toHaveBeenCalledOnce());
  await screen.findByText("Project created");
}

function enterAnalyzeWorkspace(): void {
  fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
}

describe("Loci renderer", () => {
  it("keeps range-track progress finite at collapsed scientific level bounds", () => {
    expect(rangeProgress(0, 0, 0)).toBe("0%");
    expect(rangeProgress(0.5, 0, 1)).toBe("50%");
    expect(rangeProgress(2, 0, 1)).toBe("100%");
  });
  afterEach(cleanup);

  beforeEach(() => {
    window.localStorage.clear();
    globalThis.ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    };
    Element.prototype.scrollTo = vi.fn();
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(true);
    window.loci = mockApi();
  });

  it("caps freehand correction strokes while preserving their endpoints", () => {
    const points = Array.from({ length: 2_049 }, (_value, index) => ({
      x: index,
      y: index % 37,
    }));

    const simplified = simplifyCorrectionStroke(points);

    expect(simplified).toHaveLength(1_024);
    expect(simplified[0]).toEqual(points[0]);
    expect(simplified.at(-1)).toEqual(points.at(-1));
  });

  it("uses a precise identity display transform and conventional gamma direction", () => {
    expect(viewerFilterParameters({
      blackPoint: 0,
      whitePoint: 1,
      brightness: 0,
      contrast: 100,
      gamma: 1,
      saturation: 100,
      red: true,
      green: true,
      blue: true,
    })).toEqual({ saturation: 1, windowSlope: 1, windowOffset: 0, exponent: 1, amplitude: 1, offset: 0 });

    expect(viewerFilterParameters({
      blackPoint: 0.1,
      whitePoint: 0.9,
      brightness: 10,
      contrast: 120,
      gamma: 2,
      saturation: 80,
      red: true,
      green: true,
      blue: true,
    })).toEqual({ saturation: 0.8, windowSlope: 1.25, windowOffset: -0.125, exponent: 0.5, amplitude: 1.2, offset: 0 });
  });

  it("builds a bounded log-scaled preview histogram path", () => {
    const path = histogramPath([0, 1, 8, 2]);

    expect(path).toMatch(/^M 0 52 L /);
    expect(path).toContain("256.00");
    expect(path).toMatch(/Z$/);
    expect(histogramPath([])).toBe("M 0 52 L 256 52");
  });

  it("starts in a focused local-import state", () => {
    const { container } = render(<App />);

    expect(screen.getByRole("heading", { name: "Bring every detail into focus." })).toBeVisible();
    expect(screen.queryByText("100% offline")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open images" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open folder" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open project" })).toBeEnabled();
    expect(screen.getByRole("tab", { name: "View" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Train")).not.toBeInTheDocument();
    const titlebar = document.querySelector<HTMLElement>(".titlebar");
    expect(titlebar).not.toBeNull();
    expect(within(titlebar!).queryByRole("button", { name: /images|folder/i })).not.toBeInTheDocument();
    expect(within(titlebar!).getByText("Local processing")).toBeVisible();

    const logoButton = screen.getByRole("button", { name: "Pulse Loci logo" });
    expect(logoButton).toBeEnabled();
    expect(container.querySelector(".welcome-ripple")).toBeNull();
    fireEvent.click(logoButton);
    const firstRipple = container.querySelector(".welcome-ripple-primary");
    expect(firstRipple).toHaveAttribute(
      "data-sequence",
      "1",
    );
    fireEvent.click(logoButton);
    const secondRipple = container.querySelector(".welcome-ripple-primary");
    expect(secondRipple).toHaveAttribute("data-sequence", "2");
    expect(secondRipple).not.toBe(firstRipple);
  });

  it("reopens a durable project into its saved source and workspace without starting analysis", async () => {
    const manifest = createProjectManifest({
      projectId: "project-1",
      title: "Culture study",
      createdAt: "2026-08-31T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: { "source-1": "generic-2d" },
      defaultDisplay: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    }, {
      appVersion: "0.1.0",
      now: "2026-08-31T00:01:00.000Z",
    });
    const openProject = vi.fn().mockResolvedValue({
      summary: {
        projectId: "project-1",
        title: "Culture study",
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        appVersion: manifest.appVersion,
        revision: 0,
        sourceCount: 1,
      },
      manifest,
      sources: [importedImage],
      recentProjects: [{
        recentId: "recent-1",
        title: "Culture study",
        updatedAt: manifest.updatedAt,
        sourceCount: 1,
      }],
    });
    const listRecoverableBatchRuns = vi.fn().mockResolvedValue([]);
    window.loci = mockApi({ openProject, listRecoverableBatchRuns });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));

    await screen.findAllByText("Culture study");
    expect(openProject).toHaveBeenCalledOnce();
    await waitFor(() => expect(listRecoverableBatchRuns).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("tab", { name: "View" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("Generic 2D")[0]).toBeVisible();
    expect(window.loci.segment).not.toHaveBeenCalled();

    const sourceButton = screen.getAllByText("plate-a.tif")[0].closest("button");
    expect(sourceButton).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");
    fireEvent.contextMenu(sourceButton!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from Loci" }));
    await waitFor(() => expect(window.loci.removeSource).toHaveBeenCalledWith("source-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Culture study/i })).toBeVisible());
    expect(screen.getByRole("tab", { name: "View" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps an in-flight project result restoration when source hydration updates the active source", async () => {
    const restoredSource: ImportedImage = {
      ...importedImage,
      previewDataUrl: undefined,
    };
    const manifest = createProjectManifest({
      projectId: "project-restore-race",
      title: "Restore race study",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      sources: [restoredSource],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-09-01T00:00:00.000Z" });
    declareActiveProjectResult(manifest);
    let finishInspection: ((source: ImportedImage) => void) | undefined;
    let finishRestoration: ((result: AnalysisResult) => void) | undefined;
    const inspectSource = vi.fn(() => new Promise<ImportedImage>((resolve) => {
      finishInspection = resolve;
    }));
    const restoreProjectResult = vi.fn(() => new Promise<AnalysisResult | null>((resolve) => {
      finishRestoration = resolve;
    }));
    const api = mockApi({
      openProject: vi.fn().mockResolvedValue(projectReceipt(manifest, [restoredSource])),
      inspectSource,
      restoreProjectResult,
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(inspectSource).toHaveBeenCalledWith("source-1"));
    await waitFor(() => expect(restoreProjectResult).toHaveBeenCalledWith("source-1"));
    expect(screen.getByRole("main")).toHaveAttribute(
      "data-result-restoration-state",
      "pending",
    );
    expect(screen.getByText("Restoring saved result")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Analyze" })).toBeDisabled();

    await act(async () => finishInspection?.(importedImage));
    await screen.findByRole("img", { name: /Biological image plate-a\.tif/i });
    await act(async () => finishRestoration?.(analysisResult));
    await waitFor(() => expect(screen.getByRole("main")).toHaveAttribute(
      "data-result-restoration-state",
      "settled",
    ));
    expect(screen.queryByText("Restoring saved result")).not.toBeInTheDocument();

    enterAnalyzeWorkspace();
    expect(await screen.findByText("Cell count")).toBeVisible();
    expect(screen.getByText("42")).toBeVisible();
  });

  it("keeps restored result provenance distinct from the current next-run controls", async () => {
    const manifest = createProjectManifest({
      projectId: "project-result-provenance",
      title: "Provenance study",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0, whitePoint: 1, brightness: 0, contrast: 100,
        gamma: 1, saturation: 100, red: true, green: true, blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-09-01T00:00:00.000Z" });
    declareActiveProjectResult(manifest);
    const websiteProfile = cellposeProfile("cellpose-sam");
    const restoredCellposeResult: AnalysisResult = {
      ...analysisResult,
      profile: {
        id: websiteProfile.id,
        name: "Cellpose-SAM",
        version: websiteProfile.version,
        backendKind: websiteProfile.backendKind,
        model: websiteProfile.model,
        preprocessing: websiteProfile.preprocessing,
      },
      settings: structuredClone(cellposeRecommendedSettings),
      resolved: { polarity: "cellpose-model", threshold: 0 },
    };
    const segment = vi.fn().mockResolvedValue(analysisResult);
    window.loci = mockApi({
      openProject: vi.fn().mockResolvedValue(projectReceipt(manifest, [importedImage])),
      restoreProjectResult: vi.fn().mockResolvedValue(restoredCellposeResult),
      segment,
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findAllByText("Provenance study");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Analyze" })).toBeEnabled());
    enterAnalyzeWorkspace();
    const provenance = await screen.findByLabelText("Result provenance");

    expect(within(provenance).getByText("Displayed result")).toBeVisible();
    expect(within(provenance).getByText("Cellpose-SAM · v4.2.1.1")).toBeVisible();
    expect(within(provenance).getByText("Next run")).toBeVisible();
    expect(within(provenance).getByText("Loci Adaptive Watershed")).toBeVisible();
    expect(within(provenance).getByText(/run again uses the current model and settings/i))
      .toBeVisible();
    expect(within(provenance).getByText("Saved result settings")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /run again/i }));
    await waitFor(() => expect(segment).toHaveBeenCalledWith({
      sourceId: "source-1",
      settings: analysisResult.settings,
      profileId: "loci-classical",
    }));
  });

  it("shows an actionable error when a reopened project's saved working result is unavailable", async () => {
    const manifest = createProjectManifest({
      projectId: "project-missing-working-result",
      title: "Recovery warning study",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-09-01T00:00:00.000Z" });
    declareActiveProjectResult(manifest);
    const restoreProjectResult = vi.fn().mockRejectedValue(new Error(
      "This project declares a saved analysis result, but its recoverable working copy is missing, unreadable, or damaged. Run segmentation again to create a new result. The source image is unchanged.",
    ));
    window.loci = mockApi({
      openProject: vi.fn().mockResolvedValue(projectReceipt(manifest, [importedImage])),
      restoreProjectResult,
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));

    await waitFor(() => expect(restoreProjectResult).toHaveBeenCalledWith("source-1"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /recoverable working copy is missing, unreadable, or damaged/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/run segmentation again/i);
    enterAnalyzeWorkspace();
    expect(screen.queryByText("Cell count")).not.toBeInTheDocument();
    expect(restoreProjectResult).toHaveBeenCalledTimes(1);
  });

  it("does not immediately restore a project result after a successful explicit clear", async () => {
    const manifest = createProjectManifest({
      projectId: "project-clear-result",
      title: "Clear result study",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-09-01T00:00:00.000Z" });
    declareActiveProjectResult(manifest);
    const restoreProjectResult = vi.fn().mockResolvedValue(analysisResult);
    const api = mockApi({
      openProject: vi.fn().mockResolvedValue(projectReceipt(manifest, [importedImage])),
      restoreProjectResult,
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(restoreProjectResult).toHaveBeenCalledOnce());
    enterAnalyzeWorkspace();
    expect(await screen.findByText("42")).toBeVisible();

    const sourceCard = screen.getAllByText("plate-a.tif")[0].closest("button");
    expect(sourceCard).not.toBeNull();
    fireEvent.contextMenu(sourceCard!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear result" }));
    await waitFor(() => expect(api.discardResult).toHaveBeenCalledWith("source-1", "result-1"));
    await waitFor(() => expect(screen.queryByText("42")).not.toBeInTheDocument());
    expect(restoreProjectResult).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();
    expect(api.segment).toHaveBeenCalledOnce();
  });

  it("keeps a result visible when explicit durable clear fails", async () => {
    const api = mockApi({
      discardResult: vi.fn().mockRejectedValue(new Error("Project save failed.")),
    });
    window.loci = api;
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();

    const sourceCard = screen.getAllByText("plate-a.tif")[0].closest("button");
    expect(sourceCard).not.toBeNull();
    fireEvent.contextMenu(sourceCard!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear result" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/project save failed/i);
    expect(screen.getByText("42")).toBeVisible();
    expect(screen.getByRole("button", { name: "Export result" })).toBeEnabled();
  });

  it("does not report project creation success when the durable ownership checkpoint fails", async () => {
    const createProject = vi.fn().mockRejectedValue(new Error(
      "Working-result ownership could not be updated; the new project was rolled back.",
    ));
    window.loci = mockApi({ createProject });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/ownership could not be updated/i);
    expect(screen.queryByText("Project created")).not.toBeInTheDocument();
    expect(screen.getByText("Current session")).toBeVisible();
  });

  it("flushes a dirty project before quit even when the autosave debounce has not fired", async () => {
    const manifest = createProjectManifest({
      projectId: "project-quit-save",
      title: "Quit-safe study",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0, whitePoint: 1, brightness: 0, contrast: 100,
        gamma: 1, saturation: 100, red: true, green: true, blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-09-01T00:00:00.000Z" });
    let quitSave: ((request: QuitProjectSaveRequest) => Promise<boolean>) | undefined;
    let finishSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const saveProject = vi.fn(async (next: ReturnType<typeof createProjectManifest>) => {
      await saveGate;
      return projectReceipt(next, [importedImage], 1);
    });
    const api = mockApi({
      openProject: vi.fn().mockResolvedValue(projectReceipt(manifest, [importedImage])),
      saveProject,
      onQuitProjectSaveRequested: vi.fn((callback: (request: QuitProjectSaveRequest) => Promise<boolean>) => {
        quitSave = callback;
        return () => undefined;
      }),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findAllByText("Quit-safe study");
    fireEvent.change(screen.getByRole("slider", { name: "Brightness" }), {
      target: { value: "12" },
    });

    let quitOutcome: Promise<boolean> | undefined;
    act(() => {
      quitOutcome = quitSave?.({ requestId: "11111111-1111-4111-8111-111111111111" });
    });
    await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());
    expect(saveProject.mock.calls[0][0].displayRecipes[0]?.settings.brightness).toBe(12);
    let acknowledged = false;
    void quitOutcome?.then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);

    await act(async () => {
      finishSave?.();
      await expect(quitOutcome).resolves.toBe(true);
    });
  });

  it("fails a correlated quit save after main cancels it at the timeout boundary", async () => {
    const manifest = createProjectManifest({
      projectId: "project-quit-cancel",
      title: "Quit cancellation study",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0, whitePoint: 1, brightness: 0, contrast: 100,
        gamma: 1, saturation: 100, red: true, green: true, blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-09-01T00:00:00.000Z" });
    let quitSave: ((request: QuitProjectSaveRequest) => Promise<boolean>) | undefined;
    let cancelQuitSave: ((request: QuitProjectSaveRequest) => void) | undefined;
    let finishSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const saveProject = vi.fn(async (next: ReturnType<typeof createProjectManifest>) => {
      await saveGate;
      return projectReceipt(next, [importedImage], 1);
    });
    const api = mockApi({
      openProject: vi.fn().mockResolvedValue(projectReceipt(manifest, [importedImage])),
      saveProject,
      onQuitProjectSaveRequested: vi.fn((callback: (request: QuitProjectSaveRequest) => Promise<boolean>) => {
        quitSave = callback;
        return () => undefined;
      }),
      onQuitProjectSaveCancelled: vi.fn((callback: (request: QuitProjectSaveRequest) => void) => {
        cancelQuitSave = callback;
        return () => undefined;
      }),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findAllByText("Quit cancellation study");
    fireEvent.change(screen.getByRole("slider", { name: "Brightness" }), {
      target: { value: "15" },
    });
    const request = { requestId: "55555555-5555-4555-8555-555555555555" };
    let outcome: Promise<boolean> | undefined;
    act(() => {
      outcome = quitSave?.(request);
    });
    await waitFor(() => expect(saveProject).toHaveBeenCalledWith(
      expect.any(Object),
      request.requestId,
    ));

    act(() => cancelQuitSave?.(request));
    await act(async () => {
      finishSave?.();
      await expect(outcome).resolves.toBe(false);
    });
  });

  it("fails the quit-save handshake when the dirty project cannot be saved", async () => {
    const manifest = createProjectManifest({
      projectId: "project-quit-failure",
      title: "Quit failure study",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0, whitePoint: 1, brightness: 0, contrast: 100,
        gamma: 1, saturation: 100, red: true, green: true, blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-09-01T00:00:00.000Z" });
    let quitSave: ((request: QuitProjectSaveRequest) => Promise<boolean>) | undefined;
    const api = mockApi({
      openProject: vi.fn().mockResolvedValue(projectReceipt(manifest, [importedImage])),
      saveProject: vi.fn().mockRejectedValue(new Error("Project disk is unavailable.")),
      onQuitProjectSaveRequested: vi.fn((callback: (request: QuitProjectSaveRequest) => Promise<boolean>) => {
        quitSave = callback;
        return () => undefined;
      }),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findAllByText("Quit failure study");
    fireEvent.change(screen.getByRole("slider", { name: "Brightness" }), {
      target: { value: "8" },
    });

    let saved = true;
    await act(async () => {
      saved = await quitSave!({ requestId: "22222222-2222-4222-8222-222222222222" });
    });
    expect(saved).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent(/disk is unavailable/i);
  });

  it("coalesces an in-flight autosave and saves a newer edit before acknowledging quit", async () => {
    const manifest = createProjectManifest({
      projectId: "project-quit-coalesce",
      title: "Quit coalesce study",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0, whitePoint: 1, brightness: 0, contrast: 100,
        gamma: 1, saturation: 100, red: true, green: true, blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-09-01T00:00:00.000Z" });
    let requestSave: (() => void) | undefined;
    let quitSave: ((request: QuitProjectSaveRequest) => Promise<boolean>) | undefined;
    let finishFirstSave: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      finishFirstSave = resolve;
    });
    const saveProject = vi.fn(async (next: ReturnType<typeof createProjectManifest>) => {
      if (saveProject.mock.calls.length === 1) await firstSaveGate;
      return projectReceipt(next, [importedImage], saveProject.mock.calls.length);
    });
    const api = mockApi({
      openProject: vi.fn().mockResolvedValue(projectReceipt(manifest, [importedImage])),
      saveProject,
      onSaveProjectRequested: vi.fn((callback: () => void) => {
        requestSave = callback;
        return () => undefined;
      }),
      onQuitProjectSaveRequested: vi.fn((callback: (request: QuitProjectSaveRequest) => Promise<boolean>) => {
        quitSave = callback;
        return () => undefined;
      }),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findAllByText("Quit coalesce study");
    fireEvent.change(screen.getByRole("slider", { name: "Brightness" }), {
      target: { value: "10" },
    });
    act(() => requestSave?.());
    await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole("slider", { name: "Brightness" }), {
      target: { value: "20" },
    });

    let quitOutcome: Promise<boolean> | undefined;
    act(() => {
      quitOutcome = quitSave?.({ requestId: "33333333-3333-4333-8333-333333333333" });
    });
    finishFirstSave?.();
    await act(async () => {
      await expect(quitOutcome).resolves.toBe(true);
    });
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(saveProject.mock.calls[0][0].displayRecipes[0]?.settings.brightness).toBe(10);
    expect(saveProject.mock.calls[1][0].displayRecipes[0]?.settings.brightness).toBe(20);
  });

  it("can explicitly discard unsaved changes and open another project after a save conflict", async () => {
    const firstManifest = createProjectManifest({
      projectId: "project-1",
      title: "Culture study",
      createdAt: "2026-08-31T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-08-31T00:00:00.000Z" });
    const secondManifest = {
      ...structuredClone(firstManifest),
      projectId: "project-2",
      title: "Externally updated study",
      createdAt: "2026-08-31T00:02:00.000Z",
      updatedAt: "2026-08-31T00:02:00.000Z",
    };
    const receipt = (manifest: typeof firstManifest) => ({
      summary: {
        projectId: manifest.projectId,
        title: manifest.title,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        appVersion: manifest.appVersion,
        revision: 0,
        sourceCount: 1,
      },
      manifest,
      sources: [importedImage],
    });
    const openProject = vi.fn()
      .mockResolvedValueOnce(receipt(firstManifest))
      .mockResolvedValueOnce(receipt(secondManifest));
    let requestOpen: () => void = () => undefined;
    const onOpenProjectRequested = vi.fn((listener: () => void) => {
      requestOpen = listener;
      return () => undefined;
    });
    const api = mockApi({
      openProject,
      saveProject: vi.fn().mockRejectedValue(new Error("The project changed on disk.")),
      confirmDiscardUnsavedProject: vi.fn().mockResolvedValue(true),
      onOpenProjectRequested,
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findAllByText("Culture study");
    fireEvent.change(screen.getByRole("slider", { name: "Brightness" }), {
      target: { value: "10" },
    });
    await waitFor(() => expect(api.updateSessionState).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectDirty: true }),
    ));

    act(() => requestOpen());

    await screen.findAllByText("Externally updated study");
    expect(api.saveProject).toHaveBeenCalledOnce();
    expect(api.confirmDiscardUnsavedProject).toHaveBeenCalledOnce();
    expect(openProject).toHaveBeenCalledTimes(2);
  });

  it("shows active durable work in the bottom Job Center", async () => {
    window.loci = mockApi({
      listJobs: vi.fn().mockResolvedValue([{
        jobId: "job-1",
        revision: 2,
        kind: "fingerprint",
        title: "Inspect source",
        state: "running",
        target: { kind: "local" },
        progress: 0.2,
        publicMessage: "Reading trusted metadata and a bounded preview.",
        cancellationRequested: false,
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:01.000Z",
        startedAt: "2026-08-31T00:00:01.000Z",
      }]),
    });
    render(<App />);

    const jobCenter = await screen.findByRole("status", { name: "Background job status" });
    expect(within(jobCenter).getByText("Inspect source")).toBeVisible();
    expect(within(jobCenter).getByText("Running")).toBeVisible();
    expect(within(jobCenter).getByLabelText("20 percent")).toBeVisible();
  });

  it("opens imports in View and keeps display changes independent from analysis", async () => {
    const api = window.loci;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");

    expect(screen.getByRole("tab", { name: "View" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("img", { name: "Log-scaled preview intensity histogram" })).toBeVisible();
    expect(screen.getByRole("slider", { name: /Black point/ })).toBeEnabled();
    expect(screen.getByRole("slider", { name: /White point/ })).toBeEnabled();
    expect(screen.getByRole("slider", { name: "Brightness" })).toBeEnabled();
    expect(screen.queryByLabelText("Segmentation model")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "RGB components" })).not.toBeInTheDocument();
    expect(screen.getByText(/DN labels use the display basis, not raw extrema/i)).toBeVisible();
    expect(screen.getByText(/No stain or fluorophore identity is inferred/i)).toBeVisible();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Brightness numeric value" }), {
      target: { value: "12" },
    });
    expect(api.discardResult).not.toHaveBeenCalled();

    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "View" }));
    expect(screen.queryByText("Mask coverage")).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Brightness numeric value" })).toHaveValue(12);
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    expect(screen.getByText("42")).toBeVisible();

    const sourceCard = screen.getAllByText("plate-a.tif")[0].closest("button");
    expect(sourceCard).not.toBeNull();
    fireEvent.contextMenu(sourceCard!, { clientX: 160, clientY: 180 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear result" }));
    await waitFor(() => expect(api.discardResult).toHaveBeenCalledWith("source-1", "result-1"));

    fireEvent.click(screen.getByRole("tab", { name: "View" }));
    expect(screen.getByRole("spinbutton", { name: "Brightness numeric value" })).toHaveValue(12);
  });

  it("keeps an IMS overview view-only and identifies its composite provenance", async () => {
    const api = mockApi({ pickImages: vi.fn().mockResolvedValue([imsOverview]) });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("volume.ims");

    expect(screen.getByRole("tab", { name: "View" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Analyze" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export view" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Brightness" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "RGB components" })).not.toBeInTheDocument();
    expect(screen.getByText(/Overview only · pyramid level 2 of 2, central Z 2 of 2/i)).toBeVisible();
    expect(screen.getByText("2 source channels · composite")).toBeVisible();
    expect(screen.getByText("Loci overview composite")).toBeVisible();
    expect(screen.getByText("Declared base colours · stored histogram ranges")).toBeVisible();
    expect(screen.getByText("Signal A, Signal B")).toBeVisible();
    expect(screen.queryByText(/Single intensity plane/i)).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /Black point.*display units/i })).toBeEnabled();
    expect(screen.getByText(/rendered overview-composite samples/i)).toBeVisible();
    expect(screen.getByText(/not native channel intensities/i)).toBeVisible();
    expect(screen.getByText("0.1 × 0.05 × 2 um")).toBeVisible();
    expect(screen.getByText(/Export is disabled for overviews/i)).toBeVisible();
    expect(api.segment).not.toHaveBeenCalled();
    expect(api.exportView).not.toHaveBeenCalled();
  });

  it("identifies a single-channel IMS overview as native intensity", async () => {
    const api = mockApi({ pickImages: vi.fn().mockResolvedValue([singleChannelImsOverview]) });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("single-channel.ims");

    expect(screen.getByText("Single intensity")).toBeVisible();
    expect(screen.getByText(/Single intensity plane/i)).toBeVisible();
    expect(screen.getByText("Single stored channel")).toBeVisible();
    expect(screen.queryByText(/source channels · composite/i)).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /Black point.*DN/i })).toBeEnabled();
  });

  it("keeps a stored TIFF pyramid overview view-only with native geometry", async () => {
    const api = mockApi({ pickImages: vi.fn().mockResolvedValue([tiffPyramidOverview]) });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("whole-slide.tiff");

    expect(screen.getByRole("tab", { name: "Analyze" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export view" })).toBeDisabled();
    expect(screen.getByText(/pyramid level 3 of 3, 512 × 384 px from a 8,192 × 6,144 px source/i)).toBeVisible();
    expect(screen.getByText("3 levels · showing 3")).toBeVisible();
    expect(screen.getByText("Tiled pyramid · tiled overview")).toBeVisible();
    expect(screen.getByRole("heading", { name: "RGB components" })).toBeVisible();
    expect(api.segment).not.toHaveBeenCalled();
    expect(api.exportView).not.toHaveBeenCalled();
  });

  it("applies inspected percentile levels with Auto and compares the untouched preview", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");

    const sourcePreview = screen.getByAltText("Biological image plate-a.tif");
    expect(sourcePreview).toHaveStyle({ filter: 'url("#loci-viewer-display-filter")' });
    const compareButton = screen.getByRole("button", { name: "Hold to show original preview" });
    fireEvent.pointerDown(compareButton);
    await waitFor(() => {
      expect(sourcePreview).not.toHaveStyle({ filter: 'url("#loci-viewer-display-filter")' });
      expect(compareButton).toHaveAttribute("aria-pressed", "true");
    });
    fireEvent.pointerUp(compareButton);
    await waitFor(() => {
      expect(sourcePreview).toHaveStyle({ filter: 'url("#loci-viewer-display-filter")' });
      expect(compareButton).toHaveAttribute("aria-pressed", "false");
    });

    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    expect(screen.getByRole("spinbutton", { name: /Black point.*numeric value/ })).toHaveValue(8);
    expect(screen.getByRole("spinbutton", { name: /White point.*numeric value/ })).toHaveValue(91);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("spinbutton", { name: /Black point.*numeric value/ })).toHaveValue(0);
    expect(screen.getByRole("spinbutton", { name: /White point.*numeric value/ })).toHaveValue(100);
  });

  it("keeps window controls safe when inspection statistics are absent", async () => {
    const sourceWithoutStatistics = { ...importedImage, displayStatistics: undefined };
    window.loci = mockApi({ pickImages: vi.fn().mockResolvedValue([sourceWithoutStatistics]) });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");

    expect(screen.getByText(/Histogram becomes available after source inspection/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Auto" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Black point" })).toBeEnabled();
    expect(screen.getByRole("slider", { name: "White point" })).toBeEnabled();
  });

  it("labels RGB controls as colour components rather than fluorescence channels", async () => {
    const rgbSource: ImportedImage = {
      ...importedImage,
      channels: 3,
      dtype: "uint8",
      displayStatistics: {
        ...importedImage.displayStatistics!,
        basis: "luminance",
        displayMinimum: 0,
        displayMaximum: 255,
        sourceMinimum: 0,
        sourceMaximum: 255,
      },
    };
    window.loci = mockApi({ pickImages: vi.fn().mockResolvedValue([rgbSource]) });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");

    expect(screen.getByRole("heading", { name: "RGB components" })).toBeVisible();
    expect(screen.getByText(/not stains, biomarkers, or biological fluorescence channels/i)).toBeVisible();
    for (const component of ["R", "G", "B"]) {
      expect(screen.getByRole("button", { name: component })).toHaveAttribute("aria-pressed", "true");
    }
  });

  it("resets a display recipe when the same source id is re-imported", async () => {
    const rgbSource: ImportedImage = {
      ...importedImage,
      channels: 3,
      dtype: "uint8",
    };
    const pickImages = vi
      .fn()
      .mockResolvedValueOnce([rgbSource])
      .mockResolvedValueOnce([importedImage]);
    const exportView = vi.fn().mockResolvedValue(null);
    window.loci = mockApi({ exportView, pickImages });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findByRole("heading", { name: "RGB components" });
    fireEvent.click(screen.getByRole("button", { name: "R" }));
    expect(screen.getByRole("button", { name: "R" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.keyDown(window, { key: "o", metaKey: true });
    await waitFor(() => expect(pickImages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "RGB components" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Export view" }));

    await waitFor(() => expect(exportView).toHaveBeenCalledWith("source-1", {
      format: "tiff",
      settings: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    }));
  });

  it("exports a full-resolution adjusted view without segmentation", async () => {
    const exportView = vi.fn().mockResolvedValue({
      path: "/lab/export/plate-a_loci_view.png",
      format: "png",
      width: 2048,
      height: 1536,
      channels: 1,
      dtype: "uint8",
      byteLength: 512,
      sourceSha256: "a".repeat(64),
      outputSha256: "b".repeat(64),
      settings: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 8,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    });
    window.loci = mockApi({ exportView });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Brightness numeric value" }), {
      target: { value: "8" },
    });
    fireEvent.change(screen.getByLabelText("Rendered image format"), {
      target: { value: "png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export view" }));

    await waitFor(() => expect(exportView).toHaveBeenCalledWith("source-1", {
      format: "png",
      settings: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 8,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    }));
    expect(window.loci.segment).not.toHaveBeenCalled();
    expect(await screen.findByText("PNG saved as plate-a_loci_view.png.")).toBeVisible();
    expect(screen.queryByText(/\/lab\/export/)).not.toBeInTheDocument();
  });

  it("opens persisted appearance and export preferences from the title bar", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Application theme" }), { target: { value: "midnight" } });
    fireEvent.click(screen.getByRole("radio", { name: /Large/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Saving & export" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Default figure DPI" }), { target: { value: "600" } });
    fireEvent.blur(screen.getByRole("spinbutton", { name: "Default figure DPI" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "midnight");
    expect(document.documentElement).toHaveAttribute("data-text-size", "large");
    expect(window.localStorage.getItem("loci.preferences.v1")).toContain('"figureDpi":600');
  });

  it("suspends workspace shortcuts while Settings is modal", async () => {
    const api = window.loci;
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    expect(api.pickImages).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    fireEvent.keyDown(window, { key: "z", metaKey: true });

    expect(api.pickImages).toHaveBeenCalledOnce();
    expect(api.segment).not.toHaveBeenCalled();
    expect(api.undoCorrection).not.toHaveBeenCalled();
  });

  it("prefers the ready website-compatible Cellpose profile over v2 and classical", async () => {
    const getCellposeStatus = vi.fn().mockImplementation(async (profileId: CellposeProfileId) =>
      cellposeStatus(profileId));
    const api = mockApi({
      listProfiles: vi.fn().mockResolvedValue([
        readyClassicalProfile,
        cellposeProfile("cellpose-sam-v2"),
        cellposeProfile("cellpose-sam"),
      ]),
      getCellposeStatus,
    });
    window.loci = api;
    render(<App />);
    enterAnalyzeWorkspace();

    const selector = await screen.findByLabelText("Segmentation model");
    await waitFor(() => expect(selector).toHaveValue("cellpose-sam"));
    expect(within(selector).getByRole("option", {
      name: "Cellpose-SAM · Website-compatible default",
    })).toBeInTheDocument();
    const trustCard = screen.getByRole("article", {
      name: "Cellpose-SAM · Website compatible",
    });
    expect(within(trustCard).getByText("Website-compatible default")).toBeVisible();
    expect(within(trustCard).getByLabelText(/^Evidence state: Experimental\./)).toBeVisible();
    expect(trustCard).toHaveTextContent("compatibility choice, not an accuracy recommendation");
    await waitFor(() => expect(getCellposeStatus).toHaveBeenCalledWith("cellpose-sam"));
    expect(getCellposeStatus).not.toHaveBeenCalledWith("cellpose-sam-v2");
  });

  it("keeps a fresh installation runnable by falling back from missing Cellpose to the ready classical profile", async () => {
    const getCellposeStatus = vi.fn();
    const api = mockApi({
      listProfiles: vi.fn().mockResolvedValue([
        cellposeProfile("cellpose-sam", "unavailable"),
        cellposeProfile("cellpose-sam-v2", "unavailable"),
        readyClassicalProfile,
      ]),
      getCellposeStatus,
    });
    window.loci = api;
    render(<App />);
    enterAnalyzeWorkspace();

    const selector = await screen.findByLabelText("Segmentation model");
    await waitFor(() => expect(selector).toHaveValue("loci-classical"));
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    expect(screen.getByRole("button", { name: "Run segmentation" })).toBeEnabled();
    expect(getCellposeStatus).not.toHaveBeenCalled();
  });

  it("switches to Cellpose-specific controls and blocks an unprovisioned runtime", async () => {
    const api = mockApi({
      listProfiles: vi.fn().mockResolvedValue([
        readyClassicalProfile,
        cellposeProfile("cellpose-sam-v2", "unavailable"),
      ]),
      getCellposeStatus: vi.fn().mockResolvedValue(cellposeStatus("cellpose-sam-v2", false)),
    });
    window.loci = api;
    render(<App />);
    enterAnalyzeWorkspace();

    const selector = await screen.findByLabelText("Segmentation model");
    fireEvent.change(selector, { target: { value: "cellpose-sam-v2" } });
    const trustCard = await screen.findByRole("article", { name: "Cellpose-SAM v2" });
    expect(within(trustCard).getByText("Separate checkpoint · not the default")).toBeVisible();
    expect(within(trustCard).getByLabelText(/^Evidence state: Unvalidated\./)).toBeVisible();
    expect(within(trustCard).queryByText(/^Recommended(?: model)?$/i)).not.toBeInTheDocument();
    expect(await screen.findByText("Setup required")).toBeVisible();
    expect(screen.getByLabelText("Maximum inference edge")).toHaveValue(1000);
    await waitFor(() => expect(api.getCellposeStatus).toHaveBeenCalledWith("cellpose-sam-v2"));
    fireEvent.click(screen.getByRole("button", { name: "Download folder" }));
    await waitFor(() => expect(api.openCellposeModelFolder).toHaveBeenCalledWith(
      "cellpose-sam-v2",
    ));
    expect(await screen.findByText(/Model Imports\/cpsam_v2/)).toBeVisible();
    expect(screen.getByText(/staging copy can be deleted/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Official checkpoint" }));
    await waitFor(() => expect(api.openCellposeModelPage).toHaveBeenCalledWith(
      "cellpose-sam-v2",
    ));
    fireEvent.click(screen.getByRole("button", { name: "Import checkpoint" }));
    await waitFor(() => expect(api.importCellposeModel).toHaveBeenCalledWith("cellpose-sam-v2"));

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    expect(screen.getByRole("button", { name: /run segmentation/i })).toBeDisabled();
  });

  it("offers safe source actions without deleting the disk file", async () => {
    const secondSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "plate-b.tif",
      relativePath: "day-2/plate-b.tif",
    };
    window.loci = mockApi({
      pickFolder: vi.fn().mockResolvedValue([importedImage, secondSource]),
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Open folder$/i }));
    const plateB = (await screen.findAllByText("plate-b.tif"))[0].closest("button");
    expect(plateB).not.toBeNull();
    fireEvent.contextMenu(plateB!, { clientX: 180, clientY: 220 });
    expect(screen.getByRole("menu", { name: /actions for plate-b/i })).toBeVisible();
    // Opening actions for a different source must not select/restore it and
    // make the menu disappear under the workspace's restoration lock.
    expect(plateB).not.toHaveAttribute("aria-current", "true");
    expect(screen.getAllByText("plate-a.tif")[0].closest("button"))
      .toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from Loci" }));

    await waitFor(() => expect(window.loci.removeSource).toHaveBeenCalledWith("source-2"));
    expect(screen.queryByText("plate-b.tif")).not.toBeInTheDocument();
    expect(await screen.findByText(/source file was not deleted/i)).toBeVisible();
  });

  it("imports, segments, reviews, and exports through the desktop API", async () => {
    const api = window.loci;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    expect((await screen.findAllByText("plate-a.tif"))[0]).toBeVisible();
    expect(api.pickImages).toHaveBeenCalledOnce();
    enterAnalyzeWorkspace();

    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    await waitFor(() => expect(api.segment).toHaveBeenCalledOnce());
    expect(await screen.findByText("42")).toBeVisible();
    expect(screen.getByText("12.5%")).toBeVisible();
    expect(screen.getByText("Mask coverage")).toBeVisible();
    expect(screen.getByText("Review boundaries before using any count.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Export result" }));
    await waitFor(() => expect(api.exportResult).toHaveBeenCalledWith(
      "source-1",
      "result-1",
      {
        overlayPng: true,
        labelsTiff: true,
        measurementsCsv: true,
        summaryCsv: false,
        analysisJson: true,
      },
    ));
    expect(await screen.findByText("4 selected artifacts saved in export.")).toBeVisible();
    expect(screen.queryByText(/\/lab\/export/)).not.toBeInTheDocument();
  });

  it("marks the exact review item as reviewed and opens it back in analysis", async () => {
    class ResizeObserverStub {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;
    Element.prototype.scrollTo = vi.fn();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    const unreviewed = await screen.findByRole("button", {
      name: /plate-a\.tif, Unreviewed, 42 cells/i,
    });
    expect(unreviewed).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));

    expect(await screen.findByText("Result reviewed")).toBeVisible();
    const reviewed = await screen.findByRole("button", {
      name: /plate-a\.tif, Reviewed, 42 cells/i,
    });
    expect(screen.getByRole("button", { name: "Reviewed" })).toBeDisabled();

    fireEvent.doubleClick(reviewed);
    expect(screen.getByRole("tab", { name: "Analyze" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("heading", { name: "Check results before export" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("42")).toBeVisible();
  });

  it("discards a reviewed result as soon as analysis settings change", async () => {
    const api = window.loci;
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Expected diameter numeric value" }), {
      target: { value: "48" },
    });

    await waitFor(() => expect(api.discardAllResults).toHaveBeenCalledOnce());
    expect(screen.queryByText("42")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export result" })).toBeDisabled();
    expect(await screen.findByText(/settings changed.*run segmentation/i)).toBeVisible();
  });

  it("keeps the old result and setting when durable settings invalidation fails", async () => {
    const api = mockApi({
      discardAllResults: vi.fn().mockRejectedValue(new Error("Project checkpoint unavailable.")),
    });
    window.loci = api;
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();
    const diameter = screen.getByRole("spinbutton", { name: "Expected diameter numeric value" });
    const previousDiameter = Number((diameter as HTMLInputElement).value);

    fireEvent.change(diameter, { target: { value: String(previousDiameter + 10) } });

    await waitFor(() => expect(api.discardAllResults).toHaveBeenCalledOnce());
    expect(await screen.findByRole("alert")).toHaveTextContent(/checkpoint unavailable/i);
    expect(diameter).toHaveValue(previousDiameter);
    expect(screen.getByText("42")).toBeVisible();
    expect(screen.getByRole("button", { name: "Export result" })).toBeEnabled();
  });

  it("blocks analysis until the model registry has loaded", async () => {
    let resolveProfiles: ((profiles: SegmentationProfile[]) => void) | undefined;
    const listProfiles = vi.fn().mockImplementation(() => new Promise<SegmentationProfile[]>((resolve) => {
      resolveProfiles = resolve;
    }));
    window.loci = mockApi({ listProfiles });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    expect(screen.getByRole("button", { name: /run segmentation/i })).toBeDisabled();

    await act(async () => resolveProfiles?.([readyClassicalProfile]));
    await waitFor(() => expect(screen.getByRole("button", { name: /run segmentation/i })).toBeEnabled());
  });

  it("clears every source result when global analysis settings change", async () => {
    const secondSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "plate-b.tif",
      relativePath: "day-2/plate-b.tif",
    };
    const segment = vi.fn().mockImplementation(async (request: { sourceId: string }) => ({
      ...analysisResult,
      resultId: request.sourceId === "source-1" ? "result-1" : "result-2",
      source: {
        ...analysisResult.source,
        name: request.sourceId === "source-1" ? importedImage.name : secondSource.name,
        relativePath: request.sourceId === "source-1"
          ? importedImage.relativePath
          : secondSource.relativePath,
      },
    }));
    const api = mockApi({
      pickFolder: vi.fn().mockResolvedValue([importedImage, secondSource]),
      segment,
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Open folder$/i }));
    await screen.findAllByText("plate-b.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    await waitFor(() => expect(segment).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "source-1" })));

    const secondSourceButton = screen.getAllByText("plate-b.tif")[0].closest("button");
    expect(secondSourceButton).not.toBeNull();
    fireEvent.click(secondSourceButton!);
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    await waitFor(() => expect(segment).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "source-2" })));

    fireEvent.change(screen.getByRole("spinbutton", { name: "Expected diameter numeric value" }), {
      target: { value: "48" },
    });

    await waitFor(() => expect(api.discardAllResults).toHaveBeenCalledOnce());
    expect(screen.queryByText("42")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export result" })).toBeDisabled();
    expect(await screen.findByText(/settings changed.*run segmentation/i)).toBeVisible();
  });

  it("keeps v2 selectable and discards an original-Cellpose result before switching", async () => {
    const getCellposeStatus = vi.fn().mockImplementation(async (profileId: CellposeProfileId) =>
      cellposeStatus(profileId));
    const api = mockApi({
      listProfiles: vi.fn().mockResolvedValue([
        readyClassicalProfile,
        cellposeProfile("cellpose-sam"),
        cellposeProfile("cellpose-sam-v2"),
      ]),
      getCellposeStatus,
    });
    window.loci = api;
    render(<App />);
    enterAnalyzeWorkspace();
    const selector = await screen.findByLabelText("Segmentation model");
    await waitFor(() => expect(selector).toHaveValue("cellpose-sam"));
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    const activeSelector = screen.getByLabelText("Segmentation model");
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();
    expect(api.segment).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "cellpose-sam",
    }));

    fireEvent.change(activeSelector, { target: { value: "cellpose-sam-v2" } });

    await waitFor(() => expect(api.discardAllResults).toHaveBeenCalledOnce());
    expect(activeSelector).toHaveValue("cellpose-sam-v2");
    await waitFor(() => expect(getCellposeStatus).toHaveBeenCalledWith("cellpose-sam-v2"));
    expect(screen.queryByText("42")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export result" })).toBeDisabled();
  });

  it("keeps the old model and result when durable model invalidation fails", async () => {
    const api = mockApi({
      listProfiles: vi.fn().mockResolvedValue([
        readyClassicalProfile,
        cellposeProfile("cellpose-sam"),
        cellposeProfile("cellpose-sam-v2"),
      ]),
      getCellposeStatus: vi.fn().mockImplementation(async (profileId: CellposeProfileId) =>
        cellposeStatus(profileId)),
      discardAllResults: vi.fn().mockRejectedValue(new Error("Project checkpoint unavailable.")),
    });
    window.loci = api;
    render(<App />);
    enterAnalyzeWorkspace();
    const selector = await screen.findByLabelText("Segmentation model");
    await waitFor(() => expect(selector).toHaveValue("cellpose-sam"));
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Segmentation model"), {
      target: { value: "cellpose-sam-v2" },
    });

    await waitFor(() => expect(api.discardAllResults).toHaveBeenCalledOnce());
    expect(await screen.findByRole("alert")).toHaveTextContent(/checkpoint unavailable/i);
    expect(screen.getByLabelText("Segmentation model")).toHaveValue("cellpose-sam");
    expect(screen.getByText("42")).toBeVisible();
  });

  it("blocks analysis and correction controls while an export is active", async () => {
    let completeExport: ((value: { directory: string; files: Record<string, string> }) => void) | undefined;
    const exportResult = vi.fn().mockImplementation(() => new Promise((resolve) => {
      completeExport = resolve;
    }));
    const api = mockApi({ exportResult });
    window.loci = api;
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Export result" }));
    await waitFor(() => expect(exportResult).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /run again/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Draw cell boundary" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove segmented cell" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Split segmented cell" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge segmented cells" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reshape segmented cell boundary" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Paint segmentation mask" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Erase segmentation mask" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit boundary vertices" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(api.segment).toHaveBeenCalledOnce();

    completeExport?.({ directory: "/lab/export", files: { summary: "/lab/export/count.csv" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /run again/i })).toBeEnabled());
  });

  it("applies an engine-backed instance deletion and exposes undo", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();

    const sourceImage = screen.getByAltText("Biological image plate-a.tif");
    vi.spyOn(sourceImage, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 80,
      left: 100,
      top: 80,
      right: 500,
      bottom: 380,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove segmented cell" }));
    const viewport = sourceImage.closest<HTMLElement>(".canvas-viewport");
    expect(viewport).not.toBeNull();
    fireEvent.pointerDown(viewport!, {
      button: 0,
      pointerId: 7,
      clientX: 300,
      clientY: 230,
    });

    await waitFor(() => expect(window.loci.deleteInstance).toHaveBeenCalledWith(
      "source-1",
      "result-1",
      { x: 1024, y: 768 },
    ));
    expect(await screen.findByText("41")).toBeVisible();
    const undo = screen.getByRole("button", { name: "Undo manual correction" });
    expect(undo).toBeEnabled();
    fireEvent.click(undo);
    await waitFor(() => expect(window.loci.undoCorrection).toHaveBeenCalledWith("source-1", "result-1"));
  });

  it("routes split, merge, and reshape gestures through the correction engine", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();

    const sourceImage = screen.getByAltText("Biological image plate-a.tif");
    vi.spyOn(sourceImage, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 80,
      left: 100,
      top: 80,
      right: 500,
      bottom: 380,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    });
    const viewport = sourceImage.closest<HTMLElement>(".canvas-viewport");
    expect(viewport).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Split segmented cell" }));
    expect(screen.getByText(/Split instance/)).toBeVisible();
    fireEvent.pointerDown(viewport!, { button: 0, pointerId: 8, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(viewport!, { pointerId: 8, clientX: 260, clientY: 180 });
    fireEvent.pointerUp(viewport!, { pointerId: 8, clientX: 260, clientY: 180 });
    await waitFor(() => expect(window.loci.splitInstance).toHaveBeenCalledWith(
      "source-1",
      "result-1",
      { x: 512, y: 358 },
      expect.arrayContaining([expect.objectContaining({ x: 512 })]),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Merge segmented cells" }));
    fireEvent.pointerDown(viewport!, { button: 0, pointerId: 9, clientX: 200, clientY: 150 });
    fireEvent.pointerDown(viewport!, { button: 0, pointerId: 10, clientX: 300, clientY: 230 });
    await waitFor(() => expect(window.loci.mergeInstances).toHaveBeenCalledWith(
      "source-1",
      "result-1",
      { x: 512, y: 358 },
      { x: 1024, y: 768 },
    ));

    fireEvent.click(screen.getByRole("button", { name: "Reshape segmented cell boundary" }));
    fireEvent.pointerDown(viewport!, { button: 0, pointerId: 11, clientX: 200, clientY: 150 });
    fireEvent.pointerDown(viewport!, { button: 0, pointerId: 12, clientX: 180, clientY: 130 });
    fireEvent.pointerMove(viewport!, { pointerId: 12, clientX: 260, clientY: 130 });
    fireEvent.pointerMove(viewport!, { pointerId: 12, clientX: 260, clientY: 210 });
    fireEvent.pointerUp(viewport!, { pointerId: 12, clientX: 180, clientY: 210 });
    await waitFor(() => expect(window.loci.replaceInstanceBoundary).toHaveBeenCalledWith(
      "source-1",
      "result-1",
      { x: 512, y: 358 },
      [
        { x: 409.6, y: 256 },
        { x: 819.2, y: 256 },
        { x: 819.2, y: 665.6 },
      ],
    ));
  });

  it("routes source-pixel brush, eraser, and explicit vertex commits through durable corrections", async () => {
    const api = window.loci;
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();

    const sourceImage = screen.getByAltText("Biological image plate-a.tif");
    vi.spyOn(sourceImage, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 80,
      left: 100,
      top: 80,
      right: 500,
      bottom: 380,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    });
    const viewport = sourceImage.closest<HTMLElement>(".canvas-viewport");
    expect(viewport).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Paint segmentation mask" }));
    const radius = screen.getByRole("slider", { name: "Brush radius in source pixels" });
    fireEvent.change(radius, { target: { value: "12" } });
    fireEvent.pointerDown(viewport!, { button: 0, pointerId: 19, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(viewport!, { pointerId: 19, clientX: 215, clientY: 160 });
    fireEvent.pointerCancel(viewport!, { pointerId: 19, clientX: 215, clientY: 160 });
    expect(api.paintMask).not.toHaveBeenCalled();
    fireEvent.pointerDown(viewport!, { button: 0, pointerId: 20, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(viewport!, { pointerId: 20, clientX: 230, clientY: 170 });
    fireEvent.pointerUp(viewport!, { pointerId: 20, clientX: 230, clientY: 170 });
    await waitFor(() => expect(api.paintMask).toHaveBeenCalledWith(
      "source-1",
      "result-1",
      expect.arrayContaining([expect.objectContaining({ x: 512, y: 358.4 })]),
      12,
    ));

    await waitFor(() => expect(screen.getByRole("button", { name: "Erase segmentation mask" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Erase segmentation mask" }));
    fireEvent.pointerDown(viewport!, { button: 0, pointerId: 21, clientX: 250, clientY: 180 });
    fireEvent.pointerUp(viewport!, { pointerId: 21, clientX: 250, clientY: 180 });
    await waitFor(() => expect(api.eraseMask).toHaveBeenCalledWith(
      "source-1",
      "result-1",
      [{ x: 768, y: 512 }],
      12,
    ));

    await waitFor(() => expect(screen.getByRole("button", { name: "Edit boundary vertices" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Edit boundary vertices" }));
    fireEvent.pointerDown(viewport!, { button: 0, pointerId: 22, clientX: 300, clientY: 230 });
    await waitFor(() => expect(api.getInstanceBoundary).toHaveBeenCalledWith(
      "source-1",
      "result-1",
      { x: 1024, y: 768 },
    ));
    const commit = await screen.findByRole("button", { name: "Commit" });
    expect(commit).toBeDisabled();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(commit).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.moveBoundaryVertex).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();

    fireEvent.pointerDown(viewport!, { button: 0, pointerId: 23, clientX: 300, clientY: 230 });
    const commitAfterCancel = await screen.findByRole("button", { name: "Commit" });
    expect(api.getInstanceBoundary).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(commitAfterCancel).toBeEnabled();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(commitAfterCancel).toBeDisabled();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(commitAfterCancel).toBeEnabled();
    fireEvent.click(commitAfterCancel);
    await waitFor(() => expect(api.moveBoundaryVertex).toHaveBeenCalledWith(
      "source-1",
      "result-1",
      { x: 10, y: 10 },
      [{ x: 9, y: 8 }, { x: 12, y: 8 }, { x: 10, y: 12 }],
    ));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument());
  });

  it("inspects supported images dropped on the microscopy canvas", async () => {
    const api = window.loci;
    render(<App />);
    const canvas = screen.getByRole("region", { name: "Biological image canvas" });
    const file = new File(["pixels"], "plate-a.tif", { type: "image/tiff" });

    fireEvent.drop(canvas, { dataTransfer: { files: [file], types: ["Files"] } });

    await waitFor(() => expect(api.importDroppedFiles).toHaveBeenCalledWith([file]));
    expect((await screen.findAllByText("plate-a.tif"))[0]).toBeVisible();
  });

  it("processes a recursive folder into Review without exporting until explicitly requested", async () => {
    const nestedSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "very-long-cell-culture-image-name-that-needs-ellipsis.jpg",
      relativePath: "experiment/day-2/very-long-cell-culture-image-name-that-needs-ellipsis.jpg",
      format: "jpeg",
    };
    const nestedResult: AnalysisResult = {
      ...analysisResult,
      resultId: "result-2",
      source: {
        ...analysisResult.source,
        name: nestedSource.name,
        relativePath: nestedSource.relativePath,
        format: "jpeg",
      },
    };
    const segment = vi.fn()
      .mockResolvedValueOnce(analysisResult)
      .mockResolvedValueOnce(nestedResult);
    const api = mockApi({
      pickFolder: vi.fn().mockResolvedValue([importedImage, nestedSource]),
      createProject: successfulProjectCreation([importedImage, nestedSource]),
      saveProject: successfulProjectSave([importedImage, nestedSource]),
      inspectSource: vi.fn().mockImplementation(async (sourceId: string) =>
        sourceId === nestedSource.sourceId ? nestedSource : importedImage),
      segment,
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Open folder$/i }));
    expect((await screen.findAllByText(nestedSource.name))[0]).toHaveAttribute("title", nestedSource.name);
    expect(screen.getAllByText(/2,048 × 1,536/).length).toBeGreaterThan(0);
    await saveImportedSourcesAsProject(api);
    enterAnalyzeWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "Process all 2" }));
    await waitFor(() => expect(segment).toHaveBeenCalledTimes(2));
    expect(api.createBatchRun).toHaveBeenCalledWith({
      sourceIds: ["source-1", "source-2"],
      settings: analysisResult.settings,
      profileId: "loci-classical",
    });
    expect(api.beginBatchRunItem).toHaveBeenNthCalledWith(1, "batch-1", "source-1");
    expect(api.beginBatchRunItem).toHaveBeenNthCalledWith(2, "batch-1", "source-2");
    expect(api.completeBatchRunItem).toHaveBeenNthCalledWith(1, "batch-1", "source-1", "result-1");
    expect(api.completeBatchRunItem).toHaveBeenNthCalledWith(2, "batch-1", "source-2", "result-2");
    expect(api.finishBatchRun).toHaveBeenCalledWith("batch-1", false);
    expect(api.beginBatchExport).not.toHaveBeenCalled();
    expect(api.exportBatchResult).not.toHaveBeenCalled();
    expect(api.finishBatchExport).not.toHaveBeenCalled();
    expect(await screen.findByText("Batch ready for review")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Check results before export" })).toBeVisible();
    expect(screen.getByText("0 reviewed · 2 unreviewed · 0 excluded")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Export batch" }));
    await waitFor(() => expect(api.exportBatchResult).toHaveBeenCalledTimes(2));
    expect(api.exportBatchResult).toHaveBeenNthCalledWith(1, "batch-1", "source-1", "result-1");
    expect(api.exportBatchResult).toHaveBeenNthCalledWith(2, "batch-1", "source-2", "result-2");
    expect(api.finishBatchExport).toHaveBeenCalledWith("batch-1", [], false);
    expect(await screen.findByText("Batch export complete")).toBeVisible();
    expect(screen.getByText(/0 reviewed and 2 unreviewed included; 0 excluded/i)).toBeVisible();
  });

  it("removes batch completion badges when results are explicitly or globally retired", async () => {
    const secondSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "plate-b.tif",
      relativePath: "experiment/day-2/plate-b.tif",
    };
    const secondResult: AnalysisResult = {
      ...analysisResult,
      resultId: "result-2",
      source: {
        ...analysisResult.source,
        name: secondSource.name,
        relativePath: secondSource.relativePath,
      },
    };
    const api = mockApi({
      pickFolder: vi.fn().mockResolvedValue([importedImage, secondSource]),
      createProject: successfulProjectCreation([importedImage, secondSource]),
      saveProject: successfulProjectSave([importedImage, secondSource]),
      inspectSource: vi.fn().mockImplementation(async (sourceId: string) =>
        sourceId === secondSource.sourceId ? secondSource : importedImage),
      segment: vi.fn()
        .mockResolvedValueOnce(analysisResult)
        .mockResolvedValueOnce(secondResult),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Open folder$/i }));
    await screen.findAllByText("plate-b.tif");
    await saveImportedSourcesAsProject(api);
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Process all 2" }));
    await screen.findByText("Batch ready for review");
    expect(screen.getAllByLabelText("Analysis complete")).toHaveLength(2);

    const secondSourceButton = screen.getAllByText("plate-b.tif")[0].closest("button");
    expect(secondSourceButton).not.toBeNull();
    fireEvent.contextMenu(secondSourceButton!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear result" }));
    await waitFor(() => expect(api.discardResult).toHaveBeenCalledWith("source-2", "result-2"));
    await waitFor(() => expect(screen.getAllByLabelText("Analysis complete")).toHaveLength(1));

    enterAnalyzeWorkspace();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Expected diameter numeric value" }), {
      target: { value: "48" },
    });
    await waitFor(() => expect(api.discardAllResults).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByLabelText("Analysis complete")).not.toBeInTheDocument());
  });

  it("guides the researcher to save a project before creating any durable batch job", async () => {
    const secondSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "plate-b.tif",
      relativePath: "experiment/day-2/plate-b.tif",
    };
    const api = mockApi({
      pickFolder: vi.fn().mockResolvedValue([importedImage, secondSource]),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Open folder$/i }));
    await screen.findAllByText("plate-b.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Process all 2" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /save this complete source set as a Loci project/i,
    );
    expect(api.inspectSource).not.toHaveBeenCalled();
    expect(api.createBatchRun).not.toHaveBeenCalled();
    expect(api.beginBatchRunItem).not.toHaveBeenCalled();
    expect(api.segment).not.toHaveBeenCalled();
    expect(api.finishBatchRun).not.toHaveBeenCalled();
  });

  it("checkpoints the source set before inspection and verified fingerprints before creating a batch", async () => {
    const secondSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "plate-b.tif",
      relativePath: "experiment/day-2/plate-b.tif",
    };
    const initialManifest = createProjectManifest({
      projectId: "project-1",
      title: "Culture study",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-09-01T00:00:00.000Z" });
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const saveProject = vi.fn(async (manifest: ReturnType<typeof createProjectManifest>) => {
      await saveGate;
      return projectReceipt(manifest, [importedImage, secondSource], 1);
    });
    const inspectSource = vi.fn().mockImplementation(async (sourceId: string) =>
      sourceId === secondSource.sourceId ? secondSource : importedImage);
    const api = mockApi({
      openProject: vi.fn().mockResolvedValue(projectReceipt(initialManifest, [importedImage])),
      pickFolder: vi.fn().mockResolvedValue([secondSource]),
      saveProject,
      inspectSource,
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findAllByText("Culture study");
    fireEvent.click(screen.getByRole("button", { name: "Folder" }));
    await screen.findAllByText("plate-b.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Process all 2" }));

    await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());
    expect(saveProject.mock.calls[0][0].sources.map(({ sourceId }) => sourceId)).toEqual([
      "source-1",
      "source-2",
    ]);
    expect(inspectSource).not.toHaveBeenCalled();
    expect(api.createBatchRun).not.toHaveBeenCalled();

    releaseSave?.();
    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.createBatchRun).toHaveBeenCalledOnce());
    expect(inspectSource).toHaveBeenCalledTimes(2);
    expect(saveProject.mock.invocationCallOrder[0]).toBeLessThan(
      inspectSource.mock.invocationCallOrder[0],
    );
    expect(inspectSource.mock.invocationCallOrder[1]).toBeLessThan(
      saveProject.mock.invocationCallOrder[1],
    );
    expect(saveProject.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(api.createBatchRun).mock.invocationCallOrder[0],
    );
  });

  it("does not inspect or create a batch when the current project checkpoint fails", async () => {
    const secondSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "plate-b.tif",
      relativePath: "experiment/day-2/plate-b.tif",
    };
    const initialManifest = createProjectManifest({
      projectId: "project-1",
      title: "Culture study",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, {
      sources: [importedImage],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    }, { appVersion: "0.1.0", now: "2026-09-01T00:00:00.000Z" });
    const api = mockApi({
      openProject: vi.fn().mockResolvedValue(projectReceipt(initialManifest, [importedImage])),
      pickFolder: vi.fn().mockResolvedValue([secondSource]),
      saveProject: vi.fn().mockRejectedValue(new Error("Project checkpoint failed: disk full.")),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findAllByText("Culture study");
    fireEvent.click(screen.getByRole("button", { name: "Folder" }));
    await screen.findAllByText("plate-b.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Process all 2" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/checkpoint failed: disk full/i);
    expect(api.saveProject).toHaveBeenCalledOnce();
    expect(api.inspectSource).not.toHaveBeenCalled();
    expect(api.createBatchRun).not.toHaveBeenCalled();
    expect(api.beginBatchRunItem).not.toHaveBeenCalled();
    expect(api.segment).not.toHaveBeenCalled();
  });

  it("keeps more than eight completed batch results reviewable and exportable after engine-cache eviction", async () => {
    const sources = Array.from({ length: 9 }, (_, index): ImportedImage => ({
      ...importedImage,
      sourceId: `source-${index + 1}`,
      name: `field-${index + 1}.tif`,
      relativePath: `plate-a/field-${index + 1}.tif`,
    }));
    const results = sources.map((source, index): AnalysisResult => ({
      ...analysisResult,
      resultId: `result-${index + 1}`,
      // Exercise the historical renderer failure directly: the ninth decoded
      // result evicts the first only from the worker's bounded array cache.
      evictedResultIds: index === 8 ? ["result-1"] : [],
      source: {
        ...analysisResult.source,
        name: source.name,
        relativePath: source.relativePath,
      },
      metrics: { ...analysisResult.metrics, count: 40 + index },
    }));
    const resultBySource = new Map(sources.map((source, index) => [source.sourceId, results[index]]));
    const api = mockApi({
      pickFolder: vi.fn().mockResolvedValue(sources),
      createProject: successfulProjectCreation(sources),
      saveProject: successfulProjectSave(sources),
      inspectSource: vi.fn().mockImplementation(async (sourceId: string) =>
        sources.find((source) => source.sourceId === sourceId)),
      segment: vi.fn().mockImplementation(async ({ sourceId }: { sourceId: string }) =>
        resultBySource.get(sourceId)),
      createBatchRun: vi.fn().mockResolvedValue({
        batchId: "batch-nine",
        parentJobId: "batch-nine",
        createdAt: "2026-09-01T00:00:00.000Z",
        publicTitle: "Segment 9 images",
        state: "active",
        profileId: "loci-classical",
        settings: analysisResult.settings,
        total: 9,
        pending: 9,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        retryable: 0,
        items: sources.map((source) => ({
          sourceId: source.sourceId,
          state: "pending" as const,
          attemptCount: 0,
          resultId: null,
          failureCode: null,
          failureSummary: null,
        })),
      }),
      finishBatchRun: vi.fn().mockResolvedValue({
        batchId: "batch-nine",
        parentJobId: "batch-nine",
        createdAt: "2026-09-01T00:00:00.000Z",
        publicTitle: "Segment 9 images",
        state: "completed",
        profileId: "loci-classical",
        settings: analysisResult.settings,
        total: 9,
        pending: 0,
        running: 0,
        completed: 9,
        failed: 0,
        cancelled: 0,
        retryable: 0,
        items: [],
      }),
      beginBatchExport: vi.fn().mockResolvedValue({ batchId: "export-nine" }),
      finishBatchExport: vi.fn().mockResolvedValue({
        cancelled: false,
        exportedCount: 9,
        failedCount: 0,
        manifestPath: "/lab/export/loci_batch_manifest.json",
        outputDirectory: "/lab/export",
      }),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Open folder$/i }));
    await screen.findAllByText("field-9.tif");
    await saveImportedSourcesAsProject(api);
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Process all 9" }));

    await waitFor(() => expect(api.segment).toHaveBeenCalledTimes(9));
    expect(await screen.findByText("0 reviewed · 9 unreviewed · 0 excluded")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Export batch" }));
    await waitFor(() => expect(api.exportBatchResult).toHaveBeenCalledTimes(9));
    expect(api.exportBatchResult).toHaveBeenCalledWith("export-nine", "source-1", "result-1");
    expect(api.exportBatchResult).toHaveBeenCalledWith("export-nine", "source-9", "result-9");
    expect(api.finishBatchExport).toHaveBeenCalledWith("export-nine", [], false);
  });

  it("excludes only the exact current result decision from explicit batch export", async () => {
    const secondSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "plate-b.tif",
      relativePath: "experiment/day-2/plate-b.tif",
    };
    const secondResult: AnalysisResult = {
      ...analysisResult,
      resultId: "result-2",
      source: {
        ...analysisResult.source,
        name: secondSource.name,
        relativePath: secondSource.relativePath,
      },
    };
    const api = mockApi({
      pickFolder: vi.fn().mockResolvedValue([importedImage, secondSource]),
      createProject: successfulProjectCreation([importedImage, secondSource]),
      saveProject: successfulProjectSave([importedImage, secondSource]),
      inspectSource: vi.fn().mockImplementation(async (sourceId: string) =>
        sourceId === secondSource.sourceId ? secondSource : importedImage),
      segment: vi.fn()
        .mockResolvedValueOnce(analysisResult)
        .mockResolvedValueOnce(secondResult),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Open folder$/i }));
    await screen.findAllByText("plate-b.tif");
    await saveImportedSourcesAsProject(api);
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Process all 2" }));
    await screen.findByText("Batch ready for review");

    fireEvent.click(screen.getByRole("button", { name: "Exclude selected result" }));
    expect(await screen.findByText("Result excluded")).toBeVisible();
    expect(screen.getByText("0 reviewed · 1 unreviewed · 1 excluded")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Export batch" }));

    await waitFor(() => expect(api.exportBatchResult).toHaveBeenCalledOnce());
    expect(api.exportBatchResult).toHaveBeenCalledWith(
      "batch-1", "source-1", "result-1",
    );
    expect(api.exportBatchResult).not.toHaveBeenCalledWith(
      "batch-1", "source-2", "result-2",
    );
    expect(api.finishBatchExport).toHaveBeenCalledWith("batch-1", [], false);
    expect(await screen.findByText(/0 reviewed and 1 unreviewed included; 1 excluded/i)).toBeVisible();
  });

  it("stops an in-flight processing batch without starting an export", async () => {
    const secondSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "plate-b.tif",
      relativePath: "experiment/day-2/plate-b.tif",
    };
    let completeSegmentation: (() => void) | undefined;
    const segment = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        completeSegmentation = () => resolve(analysisResult);
      }),
    );
    const cancelAnalysis = vi.fn().mockResolvedValue({ cancelled: false });
    const finishBatchRun = vi.fn().mockResolvedValue({
      batchId: "batch-1",
      parentJobId: "batch-1",
      createdAt: "2026-08-30T00:00:00.000Z",
      publicTitle: "Segment 2 images",
      state: "cancelled",
      profileId: "loci-classical",
      settings: analysisResult.settings,
      total: 2,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 2,
      retryable: 0,
      items: [],
    });
    const api = mockApi({
      pickFolder: vi.fn().mockResolvedValue([importedImage, secondSource]),
      createProject: successfulProjectCreation([importedImage, secondSource]),
      saveProject: successfulProjectSave([importedImage, secondSource]),
      segment,
      cancelAnalysis,
      finishBatchRun,
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Open folder$/i }));
    await screen.findAllByText("plate-b.tif");
    await saveImportedSourcesAsProject(api);
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Process all 2" }));
    await waitFor(() => expect(segment).toHaveBeenCalledOnce());

    fireEvent.keyDown(window, { key: "o", metaKey: true });
    fireEvent.drop(screen.getByRole("region", { name: "Biological image canvas" }), {
      dataTransfer: {
        files: [new File(["pixels"], "late-import.tif", { type: "image/tiff" })],
        types: ["Files"],
      },
    });
    expect(window.loci.pickImages).not.toHaveBeenCalled();
    expect(window.loci.importDroppedFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop batch" }));
    await waitFor(() => expect(cancelAnalysis).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "Stop batch" })).toBeEnabled();
    completeSegmentation?.();

    await waitFor(() => expect(finishBatchRun).toHaveBeenCalledWith("batch-1", true));
    expect(window.loci.beginBatchExport).not.toHaveBeenCalled();
    expect(window.loci.exportBatchResult).not.toHaveBeenCalled();
    expect(window.loci.segment).toHaveBeenCalledOnce();
    expect(await screen.findByText("Batch stopped")).toBeVisible();
  });

  it("retries only unfinished items from a recoverable durable batch", async () => {
    const secondSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "plate-b.tif",
      relativePath: "experiment/day-2/plate-b.tif",
    };
    const secondResult: AnalysisResult = {
      ...analysisResult,
      resultId: "result-2",
      source: {
        ...analysisResult.source,
        name: secondSource.name,
        relativePath: secondSource.relativePath,
      },
    };
    const baseBatch: DurableBatchSession = {
      batchId: "durable-batch",
      parentJobId: "durable-batch",
      createdAt: "2026-09-01T00:00:00.000Z",
      publicTitle: "Segment 2 images",
      state: "needs-attention",
      profileId: "loci-classical",
      settings: analysisResult.settings,
      total: 2,
      pending: 0,
      running: 0,
      completed: 1,
      failed: 1,
      cancelled: 0,
      retryable: 1,
      items: [
        { sourceId: "source-1", state: "completed", attemptCount: 1, resultId: "result-1", failureCode: null, failureSummary: null },
        { sourceId: "source-2", state: "failed", attemptCount: 1, resultId: null, failureCode: "analysis-failed", failureSummary: "Failed." },
      ],
    };
    const resumed: DurableBatchSession = {
      ...baseBatch,
      state: "active",
      pending: 1,
      failed: 0,
      retryable: 0,
      items: [
        baseBatch.items[0],
        { sourceId: "source-2", state: "pending", attemptCount: 1, resultId: null, failureCode: null, failureSummary: null },
      ],
    };
    const completed: DurableBatchSession = {
      ...resumed,
      state: "completed",
      pending: 0,
      completed: 2,
      items: [],
    };
    const durableJob: JobSummary = {
      jobId: "durable-batch",
      revision: 4,
      kind: "segment",
      title: "Segment 2 images",
      state: "needs-attention",
      target: { kind: "local" },
      progress: 0.9,
      publicMessage: "1 image needs retry or review.",
      cancellationRequested: false,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:05:00.000Z",
    };
    const api = mockApi({
      pickFolder: vi.fn().mockResolvedValue([importedImage, secondSource]),
      inspectSource: vi.fn().mockImplementation(async (sourceId: string) =>
        sourceId === secondSource.sourceId ? secondSource : importedImage),
      listJobs: vi.fn().mockResolvedValue([durableJob]),
      listRecoverableBatchRuns: vi.fn().mockResolvedValue([baseBatch]),
      resumeBatchRun: vi.fn().mockResolvedValue(resumed),
      segment: vi.fn().mockResolvedValue(secondResult),
      finishBatchRun: vi.fn().mockResolvedValue(completed),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Open folder$/i }));
    await screen.findAllByText("plate-b.tif");
    fireEvent.click(await screen.findByRole("button", { name: /Open Job Center/ }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(api.resumeBatchRun).toHaveBeenCalledWith("durable-batch"));
    expect(api.beginBatchRunItem).toHaveBeenCalledTimes(1);
    expect(api.beginBatchRunItem).toHaveBeenCalledWith("durable-batch", "source-2");
    expect(api.segment).toHaveBeenCalledTimes(1);
    expect(api.segment).toHaveBeenCalledWith({
      sourceId: "source-2",
      settings: analysisResult.settings,
      profileId: "loci-classical",
    });
    expect(api.completeBatchRunItem).toHaveBeenCalledWith(
      "durable-batch", "source-2", "result-2",
    );
    expect(api.finishBatchRun).toHaveBeenCalledWith("durable-batch", false);
    expect(api.beginBatchExport).not.toHaveBeenCalled();
    expect(api.exportBatchResult).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Check results before export" })).toBeVisible();
  });

  it("finalizes a crash-complete batch without rerunning any image", async () => {
    const secondSource: ImportedImage = {
      ...importedImage,
      sourceId: "source-2",
      name: "plate-b.tif",
      relativePath: "experiment/day-2/plate-b.tif",
    };
    const recoverable: DurableBatchSession = {
      batchId: "crash-complete-batch",
      parentJobId: "crash-complete-batch",
      createdAt: "2026-09-01T00:00:00.000Z",
      publicTitle: "Segment 2 images",
      state: "needs-attention",
      profileId: "loci-classical",
      settings: analysisResult.settings,
      total: 2,
      pending: 0,
      running: 0,
      completed: 2,
      failed: 0,
      cancelled: 0,
      retryable: 0,
      items: [
        { sourceId: "source-1", state: "completed", attemptCount: 1, resultId: "result-1", failureCode: null, failureSummary: null },
        { sourceId: "source-2", state: "completed", attemptCount: 1, resultId: "result-2", failureCode: null, failureSummary: null },
      ],
    };
    const completed: DurableBatchSession = { ...recoverable, state: "completed" };
    const durableJob: JobSummary = {
      jobId: recoverable.parentJobId,
      revision: 5,
      kind: "segment",
      title: recoverable.publicTitle,
      state: "needs-attention",
      target: { kind: "local" },
      progress: 0.9,
      publicMessage: "Loci restarted before parent finalization.",
      cancellationRequested: false,
      createdAt: recoverable.createdAt,
      updatedAt: "2026-09-01T00:05:00.000Z",
    };
    const api = mockApi({
      pickFolder: vi.fn().mockResolvedValue([importedImage, secondSource]),
      inspectSource: vi.fn().mockImplementation(async (sourceId: string) =>
        sourceId === secondSource.sourceId ? secondSource : importedImage),
      listJobs: vi.fn().mockResolvedValue([durableJob]),
      listRecoverableBatchRuns: vi.fn().mockResolvedValue([recoverable]),
      resumeBatchRun: vi.fn().mockResolvedValue(completed),
    });
    window.loci = api;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Open folder$/i }));
    await screen.findAllByText("plate-b.tif");
    fireEvent.click(await screen.findByRole("button", { name: /Open Job Center/ }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(api.resumeBatchRun).toHaveBeenCalledWith(recoverable.batchId));
    expect(api.beginBatchRunItem).not.toHaveBeenCalled();
    expect(api.segment).not.toHaveBeenCalled();
    expect(api.completeBatchRunItem).not.toHaveBeenCalled();
    expect(api.finishBatchRun).not.toHaveBeenCalled();
    expect(await screen.findByText("Batch ready for review")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument());
  });

  it("surfaces import failures without creating placeholder results", async () => {
    window.loci = mockApi({ pickImages: vi.fn().mockRejectedValue(new Error("Unreadable TIFF header.")) });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unreadable TIFF header.");
    expect(screen.queryByText("Cell count")).not.toBeInTheDocument();
  });

  it("marks structurally invalid masks as not usable and shows the engine finding", async () => {
    const invalidResult: AnalysisResult = {
      ...analysisResult,
      quality: {
        status: "invalid",
        scope: "structural_sanity_only",
        flags: [{
          code: "foreground_fraction_extreme",
          severity: "error",
          message: "The mask covers 99.7% of the image, which is outside a usable range.",
        }],
      },
    };
    window.loci = mockApi({ segment: vi.fn().mockResolvedValue(invalidResult) });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));

    expect(await screen.findByText("Result not usable")).toBeVisible();
    expect(screen.getAllByText("not usable").length).toBeGreaterThan(0);
    expect(screen.getByText(/mask covers 99.7%/i)).toBeVisible();
    expect(screen.getByText("Mask coverage")).toBeVisible();
  });

  it("retains a verified result when cancelling a rerun that terminates the worker", async () => {
    let rejectRerun: ((reason?: unknown) => void) | undefined;
    const segment = vi
      .fn()
      .mockResolvedValueOnce(analysisResult)
      .mockImplementationOnce(
        () => new Promise<AnalysisResult>((_resolve, reject) => {
          rejectRerun = reject;
        }),
      )
      .mockResolvedValueOnce(analysisResult);
    const cancelAnalysis = vi.fn().mockImplementation(async () => {
      rejectRerun?.(new Error("Analysis cancelled."));
      return { cancelled: true };
    });
    window.loci = mockApi({ cancelAnalysis, segment });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /run again/i }));
    const cancelButton = await screen.findByRole("button", { name: "Cancel analysis" });
    expect(screen.getByRole("tab", { name: "View" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Analyze" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "View" }));
    expect(screen.getByRole("tab", { name: "Analyze" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(cancelButton);

    await waitFor(() => expect(cancelAnalysis).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: /run again/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Export result" })).toBeEnabled();
    expect(screen.getByText("42")).toBeVisible();
    expect(screen.getByText(/previously verified results remain available/i)).toBeVisible();
  });

  it("re-enables single-analysis cancellation when the main process has no matching job", async () => {
    let completeSegmentation!: (result: AnalysisResult) => void;
    const segment = vi.fn(() => new Promise<AnalysisResult>((resolve) => {
      completeSegmentation = resolve;
    }));
    const cancelAnalysis = vi.fn().mockResolvedValue({ cancelled: false });
    window.loci = mockApi({ cancelAnalysis, segment });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    await waitFor(() => expect(segment).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Cancel analysis" }));

    await waitFor(() => expect(cancelAnalysis).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "Cancel analysis" })).toBeEnabled();
    expect(screen.queryByText("Analysis stopped")).not.toBeInTheDocument();

    completeSegmentation(analysisResult);
    expect(await screen.findByRole("button", { name: /run again/i })).toBeEnabled();
  });

  it("retains verified review state when the analysis worker is invalidated", async () => {
    let invalidate: ((event: { generation: number; message: string }) => void) | undefined;
    window.loci = mockApi({
      onEngineInvalidated: vi.fn((callback) => {
        invalidate = callback;
        return () => undefined;
      }),
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await screen.findAllByText("plate-a.tif");
    enterAnalyzeWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /run segmentation/i }));
    expect(await screen.findByText("42")).toBeVisible();

    act(() => invalidate?.({ generation: 2, message: "Worker restarted." }));

    expect(screen.getByText("42")).toBeVisible();
    expect(screen.getByRole("button", { name: "Export result" })).toBeEnabled();
    expect(screen.getByText(/restored from their exact working copies/i)).toBeVisible();
  });
});
