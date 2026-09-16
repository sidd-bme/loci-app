// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { ImsVolumeSourceDetails, SourceMetadata, TiffPyramidSourceDetails } from "./contracts";
import type { SourceFingerprint } from "./foundation-contracts";
import {
  createSourceDescriptor,
  describeAndRecommendWorkspace,
  recommendWorkspace,
} from "./source-routing";

function source(overrides: Partial<SourceMetadata> = {}): SourceMetadata {
  return {
    name: "field-01.png",
    relativePath: "day-1/field-01.png",
    width: 1024,
    height: 768,
    channels: 3,
    dtype: "uint8",
    format: "PNG",
    pageCount: 1,
    colorModel: "interleaved-rgb",
    accessMode: "full",
    ...overrides,
  };
}

const pyramidDetails: TiffPyramidSourceDetails = {
  kind: "tiff-pyramid",
  width: 80_000,
  height: 60_000,
  channels: 3,
  dtype: "uint8",
  resolutionLevels: 5,
  selectedResolutionLevel: 4,
  selectedLevelWidth: 2_500,
  selectedLevelHeight: 1_875,
  fullDecodedBytes: 14_400_000_000,
  selectedDecodedBytes: 14_062_500,
  tiled: true,
  selectedLevelTiled: true,
};

const imsDetails: ImsVolumeSourceDetails = {
  kind: "ims-volume",
  width: 2048,
  height: 1024,
  depth: 41,
  channels: 2,
  timepoints: 3,
  resolutionLevels: 4,
  selectedResolutionLevel: 2,
  selectedLevelWidth: 512,
  selectedLevelHeight: 256,
  selectedLevelDepth: 11,
  selectedTimepoint: 0,
  selectedZ: 5,
  samplingStride: 1,
  channelNames: ["Autofluorescence", "PI"],
  channelDtypes: ["uint16", "uint16"],
  channelColorSources: ["declared-base-colour", "declared-base-colour"],
  channelRangeSources: ["stored-histogram-range", "bounded-sampled-display-range"],
  compositeMode: "loci-overview-composite",
  renderedDtype: "uint8",
  physicalExtents: [[0, 409.6], [0, 204.8], [0, 41]],
  voxelSize: [0.2, 0.2, 1],
  physicalUnit: "µm",
};

describe("source descriptors", () => {
  it("describes an ordinary RGB source without inferring biology from its filename", () => {
    const descriptor = createSourceDescriptor(source({
      name: "definite_H&E_tumor_cells.png",
      relativePath: "definite_H&E_tumor_cells.png",
    }));

    expect(descriptor.formatAdapter).toBe("raster");
    expect(descriptor.colorModel).toBe("interleaved-rgb");
    expect(descriptor.axes.map((axis) => axis.name)).toEqual(["X", "Y", "C"]);
    expect(descriptor.channels.map((channel) => channel.name)).toEqual(["Red", "Green", "Blue"]);
    expect(descriptor.ambiguity.map((item) => item.code)).toContain("biological-purpose-unknown");
  });

  it("keeps canonical filesystem paths out of renderer labels", () => {
    const descriptor = createSourceDescriptor(source({
      name: "/private/lab/field.png",
      relativePath: "C:\\Users\\Researcher\\secret\\field.png",
    }));

    expect(descriptor.displayName).toBe("field.png");
    expect(descriptor.relativeLabel).toBe("field.png");
    expect(JSON.stringify(descriptor)).not.toContain("Researcher");
    expect(JSON.stringify(descriptor)).not.toContain("private/lab");
  });

  it("maps declared IMS axes, channels, calibration, and overview restrictions", () => {
    const descriptor = createSourceDescriptor(source({
      name: "volume.ims",
      relativePath: "volume.ims",
      width: 2048,
      height: 1024,
      channels: 2,
      dtype: "uint16",
      format: "IMS",
      colorModel: "channel-composite",
      accessMode: "overview",
      viewOnlyReason: "Overview plane only.",
      sourceDetails: imsDetails,
    }));

    expect(descriptor.formatAdapter).toBe("imaris-hdf5");
    expect(descriptor.axes.map(({ name, length }) => [name, length])).toEqual([
      ["X", 2048], ["Y", 1024], ["Z", 41], ["C", 2], ["T", 3],
    ]);
    expect(descriptor.channels).toMatchObject([
      { name: "Autofluorescence", colorSource: "declared", rangeSource: "declared" },
      { name: "PI", colorSource: "declared", rangeSource: "sampled" },
    ]);
    expect(descriptor.calibration?.voxelSize).toEqual([0.2, 0.2, 1]);
    expect(descriptor.access).toMatchObject({
      mode: "overview",
      canAnalyze: false,
      canExportNativeData: false,
      canExportRenderedView: false,
    });
  });

  it("marks a verified fingerprint as non-provisional", () => {
    const fingerprint: SourceFingerprint = {
      status: "verified",
      algorithm: "sha256",
      sha256: "a".repeat(64),
      verifiedAt: "2026-08-31T00:00:00.000Z",
    };
    const descriptor = createSourceDescriptor(source(), { fingerprint });

    expect(descriptor.fingerprint).toEqual(fingerprint);
    expect(descriptor.access.provisionalUntilFingerprintVerified).toBe(false);
  });

  it("rejects impossible structural dimensions", () => {
    expect(() => createSourceDescriptor(source({ width: 0 }))).toThrow(/width/i);
    expect(() => createSourceDescriptor(source({ channels: 0 }))).toThrow(/channel/i);
    expect(() => createSourceDescriptor(source({ pageCount: 1.5 }))).toThrow(/page count/i);
  });
});

describe("adaptive workspace routing", () => {
  it("routes ambiguous single-plane RGB to Generic 2D with no analysis auto-run", () => {
    const { recommendation } = describeAndRecommendWorkspace(source({
      name: "H&E_cell_culture.png",
      relativePath: "H&E_cell_culture.png",
    }));

    expect(recommendation).toMatchObject({
      inferredWorkspace: "generic-2d",
      workspace: "generic-2d",
      decision: "safe-default",
      requiredCapabilities: [],
      analysis: { autoRun: false, recommendedModelId: null },
    });
    expect(recommendation.applicablePresets).toContain("h-and-e-display");
  });

  it("routes a declared pyramidal TIFF to pathology", () => {
    const descriptor = createSourceDescriptor(source({
      name: "slide.tif",
      relativePath: "slide.tif",
      width: 80_000,
      height: 60_000,
      format: "TIFF",
      sourceDetails: pyramidDetails,
      accessMode: "overview",
    }));

    expect(recommendWorkspace(descriptor)).toMatchObject({
      inferredWorkspace: "pathology-2d",
      workspace: "pathology-2d",
      decision: "structural",
      requiredCapabilities: ["pathology-large-2d"],
      analysis: { autoRun: false, recommendedModelId: null },
    });
  });

  it("keeps a pyramidal multichannel TIFF in the pathology workspace", () => {
    const descriptor = createSourceDescriptor(source({
      name: "multiplex-slide.tif",
      relativePath: "multiplex-slide.tif",
      width: 80_000,
      height: 60_000,
      channels: 2,
      format: "TIFF",
      colorModel: "channel-composite",
      sourceDetails: { ...pyramidDetails, channels: 2 },
    }));

    expect(recommendWorkspace(descriptor).workspace).toBe("pathology-2d");
  });

  it("routes declared non-RGB channel data to the scientific workspace", () => {
    const descriptor = createSourceDescriptor(source({
      name: "two-channel.tif",
      relativePath: "two-channel.tif",
      channels: 2,
      format: "TIFF",
      colorModel: "channel-composite",
    }));

    expect(recommendWorkspace(descriptor)).toMatchObject({
      workspace: "scientific-volume",
      requiredCapabilities: ["scientific-volumes"],
    });
  });

  it("does not route a one-level TIFF as pathology", () => {
    const descriptor = createSourceDescriptor(source({
      name: "ordinary.tif",
      relativePath: "ordinary.tif",
      format: "TIFF",
      sourceDetails: { ...pyramidDetails, resolutionLevels: 1, selectedResolutionLevel: 0 },
    }));

    expect(recommendWorkspace(descriptor).workspace).toBe("generic-2d");
  });

  it("routes IMS to the scientific-volume workspace even when all scientific axes are singleton", () => {
    const descriptor = createSourceDescriptor(source({
      name: "single-plane.ims",
      relativePath: "single-plane.ims",
      width: 2048,
      height: 1024,
      channels: 1,
      dtype: "uint16",
      format: "IMS",
      colorModel: "intensity",
      sourceDetails: {
        ...imsDetails,
        depth: 1,
        channels: 1,
        timepoints: 1,
        channelNames: ["Intensity"],
        channelDtypes: ["uint16"],
        channelColorSources: ["declared-base-colour"],
        channelRangeSources: ["native-channel-values"],
        compositeMode: "single-channel",
      },
    }));

    expect(recommendWorkspace(descriptor)).toMatchObject({
      workspace: "scientific-volume",
      requiredCapabilities: ["scientific-volumes"],
    });
  });

  it("keeps an undeclared multipage raster generic and records axis ambiguity", () => {
    const descriptor = createSourceDescriptor(source({ pageCount: 17, format: "TIFF" }));

    expect(recommendWorkspace(descriptor).workspace).toBe("generic-2d");
    expect(descriptor.ambiguity.map((item) => item.code)).toContain("page-axis-unknown");
  });

  it("respects an explicit Open as override without changing the structural inference", () => {
    const descriptor = createSourceDescriptor(source());
    const recommendation = recommendWorkspace(descriptor, "pathology-2d");

    expect(recommendation).toMatchObject({
      inferredWorkspace: "generic-2d",
      workspace: "pathology-2d",
      userOverride: "pathology-2d",
      decision: "user-override",
      analysis: { autoRun: false, recommendedModelId: null },
    });
  });

  it("retains the source adapter capability when a scientific source is opened generically", () => {
    const descriptor = createSourceDescriptor(source({
      name: "volume.ims",
      relativePath: "volume.ims",
      width: 2048,
      height: 1024,
      channels: 2,
      dtype: "uint16",
      format: "IMS",
      colorModel: "channel-composite",
      sourceDetails: imsDetails,
    }));

    expect(recommendWorkspace(descriptor, "generic-2d")).toMatchObject({
      inferredWorkspace: "scientific-volume",
      workspace: "generic-2d",
      requiredCapabilities: ["scientific-volumes"],
    });
  });
});
