import type { SourceMetadata } from "./contracts";
import {
  SOURCE_DESCRIPTOR_SCHEMA,
  WORKSPACE_RECOMMENDATION_SCHEMA,
  type SourceAmbiguity,
  type SourceChannelDescriptor,
  type SourceDescriptorV1,
  type SourceFingerprint,
  type WorkspaceKind,
  type WorkspaceRecommendation,
} from "./foundation-contracts";

const PENDING_FINGERPRINT: SourceFingerprint = {
  status: "pending",
  algorithm: "sha256",
  sha256: null,
  verifiedAt: null,
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function safeDisplayLabel(value: string, fallback: string): string {
  const normalized = value.replaceAll("\\", "/").replaceAll("\0", "").trim();
  const segments = normalized.split("/").filter(Boolean);
  const isUnsafe =
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(normalized) ||
    segments.includes("..");
  if (isUnsafe) return segments.at(-1) || fallback;
  return normalized || fallback;
}

function formatAdapter(source: SourceMetadata): SourceDescriptorV1["formatAdapter"] {
  if (source.sourceDetails?.kind === "ims-volume") return "imaris-hdf5";
  if (source.sourceDetails?.kind === "tiff-pyramid") return "tiff";
  const format = source.format.trim().toLowerCase();
  if (format.includes("tif")) return "tiff";
  if (["png", "jpeg", "jpg", "bmp", "webp"].some((item) => format.includes(item))) {
    return "raster";
  }
  return "generic";
}

function resolvedColorModel(source: SourceMetadata): SourceDescriptorV1["colorModel"] {
  if (source.colorModel) return source.colorModel;
  if (source.channels === 1) return "intensity";
  if (source.channels === 3 || source.channels === 4) return "interleaved-rgb";
  return "unknown";
}

function defaultChannelName(
  index: number,
  channelCount: number,
  colorModel: SourceDescriptorV1["colorModel"],
): string {
  if (colorModel === "interleaved-rgb") {
    const labels = channelCount === 4 ? ["Red", "Green", "Blue", "Alpha"] : ["Red", "Green", "Blue"];
    return labels[index] ?? `Component ${index + 1}`;
  }
  return channelCount === 1 ? "Intensity" : `Channel ${index + 1}`;
}

function channelsFor(source: SourceMetadata): SourceChannelDescriptor[] {
  const colorModel = resolvedColorModel(source);
  const ims = source.sourceDetails?.kind === "ims-volume" ? source.sourceDetails : null;
  return Array.from({ length: positiveInteger(source.channels, "Channel count") }, (_, index) => {
    const rawColorSource = ims?.channelColorSources[index] ?? "";
    const rawRangeSource = ims?.channelRangeSources[index] ?? "";
    return {
      index,
      name: ims?.channelNames[index] || defaultChannelName(index, source.channels, colorModel),
      dtype: ims?.channelDtypes[index] || source.dtype,
      colorSource: colorModel === "interleaved-rgb"
        ? "rgb-component"
        : rawColorSource.startsWith("declared-")
          ? "declared"
          : ims
            ? "loci-fallback"
            : "not-applicable",
      rangeSource: rawRangeSource === "stored-histogram-range"
        ? "declared"
        : rawRangeSource === "bounded-sampled-display-range"
          ? "sampled"
          : rawRangeSource === "native-channel-values"
            ? "dtype"
            : "not-applicable",
    };
  });
}

function ambiguityFor(source: SourceMetadata, adapter: SourceDescriptorV1["formatAdapter"]): SourceAmbiguity[] {
  const ambiguity: SourceAmbiguity[] = [];
  if (!source.sourceDetails) {
    ambiguity.push({
      code: "biological-purpose-unknown",
      summary: "Pixel structure alone does not identify the biological task or stain.",
    });
  }
  if (source.pageCount > 1 && !source.sourceDetails) {
    ambiguity.push({
      code: "page-axis-unknown",
      summary: "Multiple pages are present, but no declared Z or time axis is available.",
    });
  }
  if (source.sourceDetails?.kind !== "ims-volume" || !source.sourceDetails.voxelSize) {
    ambiguity.push({
      code: "physical-calibration-missing",
      summary: "No complete physical pixel calibration was declared.",
    });
  }
  if (adapter === "generic") {
    ambiguity.push({
      code: "format-adapter-generic",
      summary: "The source uses the generic image adapter.",
    });
  }
  return ambiguity;
}

export interface SourceDescriptorOptions {
  fingerprint?: SourceFingerprint;
}

/** Convert current engine metadata into the versioned, renderer-safe source contract. */
export function createSourceDescriptor(
  source: SourceMetadata,
  options: SourceDescriptorOptions = {},
): SourceDescriptorV1 {
  const width = positiveInteger(source.width, "Source width");
  const height = positiveInteger(source.height, "Source height");
  positiveInteger(source.pageCount, "Page count");
  const adapter = formatAdapter(source);
  const ims = source.sourceDetails?.kind === "ims-volume" ? source.sourceDetails : null;
  const pyramid = source.sourceDetails?.kind === "tiff-pyramid" ? source.sourceDetails : null;
  const colorModel = resolvedColorModel(source);
  const accessMode = source.accessMode ?? "full";

  const axes: SourceDescriptorV1["axes"] = [
    { name: "X", length: width, unit: ims?.physicalUnit ?? null, spacing: ims?.voxelSize?.[0] ?? null },
    { name: "Y", length: height, unit: ims?.physicalUnit ?? null, spacing: ims?.voxelSize?.[1] ?? null },
  ];
  if (ims) {
    axes.push(
      { name: "Z", length: positiveInteger(ims.depth, "Z depth"), unit: ims.physicalUnit ?? null, spacing: ims.voxelSize?.[2] ?? null },
      { name: "C", length: positiveInteger(ims.channels, "IMS channel count"), unit: null, spacing: null },
      { name: "T", length: positiveInteger(ims.timepoints, "Timepoint count"), unit: null, spacing: null },
    );
  } else if (source.channels > 1) {
    axes.push({ name: "C", length: source.channels, unit: null, spacing: null });
  }

  const selectedShape: [number, number, number | null] | null = ims
    ? [ims.selectedLevelWidth, ims.selectedLevelHeight, ims.selectedLevelDepth]
    : pyramid
      ? [pyramid.selectedLevelWidth, pyramid.selectedLevelHeight, null]
      : null;

  return {
    schemaVersion: SOURCE_DESCRIPTOR_SCHEMA,
    displayName: safeDisplayLabel(source.name, "Untitled source"),
    relativeLabel: safeDisplayLabel(source.relativePath, safeDisplayLabel(source.name, "Untitled source")),
    format: source.format.trim() || "unknown",
    formatAdapter: adapter,
    dimensions: { width, height },
    axes,
    channels: channelsFor(source),
    colorModel,
    calibration: ims?.voxelSize && ims.physicalUnit
      ? {
        source: "declared-metadata",
        unit: ims.physicalUnit,
        voxelSize: [ims.voxelSize[0], ims.voxelSize[1], ims.voxelSize[2]],
        extents: ims.physicalExtents ?? null,
      }
      : null,
    pyramid: selectedShape
      ? {
        levels: ims?.resolutionLevels ?? pyramid?.resolutionLevels ?? 1,
        selectedLevel: ims?.selectedResolutionLevel ?? pyramid?.selectedResolutionLevel ?? 0,
        selectedShape,
        tiled: pyramid ? pyramid.tiled : null,
      }
      : null,
    chunks: {
      storage: ims
        ? "hdf5-chunked"
        : pyramid?.selectedLevelTiled
          ? "tiled"
          : pyramid
            ? "striped"
            : "unknown",
      shape: null,
    },
    access: {
      mode: accessMode,
      canRender: true,
      canAnalyze: accessMode === "full",
      canExportRenderedView: accessMode === "full",
      canExportNativeData: accessMode === "full",
      provisionalUntilFingerprintVerified: options.fingerprint?.status !== "verified",
      reason: source.viewOnlyReason ?? null,
    },
    fingerprint: options.fingerprint ?? { ...PENDING_FINGERPRINT },
    ambiguity: ambiguityFor(source, adapter),
  };
}

/**
 * Route only from trustworthy structural evidence. File names and image colours
 * never imply H&E, fluorescence, viability, or a biological analysis task.
 */
export function recommendWorkspace(
  descriptor: SourceDescriptorV1,
  userOverride: WorkspaceKind | null = null,
): WorkspaceRecommendation {
  const hasDeclaredVolumeAxes = descriptor.axes.some(
    (axis) => (axis.name === "Z" || axis.name === "T") && axis.length > 1,
  );
  const hasDeclaredScientificChannels = descriptor.colorModel === "channel-composite";
  const hasNonRgbChannelAxis =
    descriptor.channels.length > 1 && descriptor.colorModel !== "interleaved-rgb";
  const isScientificVolume =
    descriptor.formatAdapter === "imaris-hdf5" ||
    hasDeclaredVolumeAxes ||
    hasDeclaredScientificChannels ||
    hasNonRgbChannelAxis;
  const isPyramidalTiff =
    descriptor.formatAdapter === "tiff" &&
    descriptor.pyramid !== null &&
    descriptor.pyramid.levels > 1;

  const inferredWorkspace: WorkspaceKind = isPyramidalTiff
    ? "pathology-2d"
    : isScientificVolume
      ? "scientific-volume"
      : "generic-2d";
  const workspace = userOverride ?? inferredWorkspace;
  const requiredCapabilities = new Set<"pathology-large-2d" | "scientific-volumes">();
  if (inferredWorkspace === "scientific-volume" || workspace === "scientific-volume") {
    requiredCapabilities.add("scientific-volumes");
  }
  if (inferredWorkspace === "pathology-2d" || workspace === "pathology-2d") {
    requiredCapabilities.add("pathology-large-2d");
  }

  const structural = inferredWorkspace !== "generic-2d";
  const evidence = inferredWorkspace === "scientific-volume"
    ? [{
      code: "declared-scientific-dimensions",
      summary: "The source declares an IMS container, scientific channels, or Z/T dimensions.",
    }]
    : inferredWorkspace === "pathology-2d"
      ? [{
        code: "declared-tiff-pyramid",
        summary: "The TIFF declares multiple stored resolution levels.",
      }]
      : [{
        code: "ambiguous-single-plane",
        summary: "The source has no unambiguous structural marker for a specialist workspace.",
      }];

  return {
    schemaVersion: WORKSPACE_RECOMMENDATION_SCHEMA,
    inferredWorkspace,
    workspace,
    decision: userOverride ? "user-override" : structural ? "structural" : "safe-default",
    evidence,
    applicablePresets: workspace === "scientific-volume"
      ? ["multichannel-display", "volume-display"]
      : workspace === "pathology-2d"
        ? ["h-and-e-display", "ihc-display", "generic-display"]
        : ["generic-display", "brightfield-cell", "fluorescence", "h-and-e-display"],
    requiredCapabilities: [...requiredCapabilities],
    userOverride,
    analysis: {
      autoRun: false,
      recommendedModelId: null,
      reason: "Loci does not infer a biological analysis task or start analysis from image structure alone.",
    },
  };
}

export function describeAndRecommendWorkspace(
  source: SourceMetadata,
  options: SourceDescriptorOptions & { userOverride?: WorkspaceKind | null } = {},
): { descriptor: SourceDescriptorV1; recommendation: WorkspaceRecommendation } {
  const descriptor = createSourceDescriptor(source, options);
  return {
    descriptor,
    recommendation: recommendWorkspace(descriptor, options.userOverride ?? null),
  };
}
