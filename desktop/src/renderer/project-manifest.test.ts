import { describe, expect, it } from "vitest";

import type { ImportedImage, ViewerDisplaySettings } from "../shared/contracts";
import {
  JOB_EVENT_SCHEMA,
  JOB_SPEC_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  type ProjectJobRecord,
  type ProjectReviewRecord,
} from "../shared/foundation-contracts";
import { validateProjectManifestV1 } from "../shared/foundation-validation";
import { createProjectManifest, restoredWorkspaceOverrides } from "./project-manifest";

const display: ViewerDisplaySettings = {
  blackPoint: 0,
  whitePoint: 1,
  brightness: 0,
  contrast: 100,
  gamma: 1,
  saturation: 100,
  red: true,
  green: true,
  blue: true,
};

const identity = {
  projectId: "project-1",
  title: "Culture study",
  createdAt: "2026-08-31T00:00:00.000Z",
};

describe("renderer project manifests", () => {
  it("persists lazy folder stubs without inventing image metadata", () => {
    const source: ImportedImage = {
      sourceId: "source-1",
      name: "plate.tif",
      relativePath: "day-1/plate.tif",
    };
    const manifest = createProjectManifest(identity, {
      sources: [source],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: display,
    }, { appVersion: "0.1.0", now: "2026-08-31T00:01:00.000Z" });

    expect(manifest.sources[0]).toMatchObject({
      inspectionStatus: "pending",
      descriptor: null,
      workspace: null,
    });
  });

  it("records structural routing and explicit user overrides separately", () => {
    const source: ImportedImage = {
      sourceId: "source-2",
      name: "slide.tif",
      relativePath: "slide.tif",
      width: 8_192,
      height: 6_144,
      channels: 3,
      dtype: "uint8",
      format: "TIFF",
      pageCount: 1,
      colorModel: "interleaved-rgb",
      sourceDetails: {
        kind: "tiff-pyramid",
        width: 8_192,
        height: 6_144,
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
    const manifest = createProjectManifest(identity, {
      sources: [source],
      displayBySourceId: {},
      workspaceOverrideBySourceId: { "source-2": "generic-2d" },
      defaultDisplay: display,
    }, { appVersion: "0.1.0", now: "2026-08-31T00:01:00.000Z" });

    expect(manifest.sources[0]).toMatchObject({
      inspectionStatus: "ready",
      workspace: {
        inferredWorkspace: "pathology-2d",
        workspace: "generic-2d",
        decision: "user-override",
      },
    });
    expect(restoredWorkspaceOverrides(manifest)).toEqual({ "source-2": "generic-2d" });
  });

  it("preserves an exact restored descriptor until the source is re-inspected", () => {
    const inspected: ImportedImage = {
      sourceId: "source-volume",
      name: "volume.ims",
      relativePath: "study/volume.ims",
      width: 2_048,
      height: 1_024,
      channels: 2,
      dtype: "uint16",
      format: "IMS",
      pageCount: 24,
      colorModel: "channel-composite",
      accessMode: "overview",
      viewOnlyReason: "Native plane access is not installed yet.",
      sourceDetails: {
        kind: "ims-volume",
        width: 2_048,
        height: 1_024,
        depth: 12,
        channels: 2,
        timepoints: 2,
        resolutionLevels: 4,
        selectedResolutionLevel: 3,
        selectedLevelWidth: 256,
        selectedLevelHeight: 128,
        selectedLevelDepth: 2,
        selectedTimepoint: 0,
        selectedZ: 1,
        samplingStride: 1,
        channelNames: ["PI", "Autofluorescence"],
        channelDtypes: ["uint16", "uint16"],
        channelColorSources: ["declared-color", "declared-color"],
        channelRangeSources: ["stored-histogram-range", "stored-histogram-range"],
        compositeMode: "loci-overview-composite",
        renderedDtype: "uint8",
        physicalExtents: [[0, 204.8], [0, 102.4], [0, 24]],
        voxelSize: [0.1, 0.1, 2],
        physicalUnit: "um",
      },
    };
    const original = createProjectManifest(identity, {
      sources: [inspected],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: display,
    }, { appVersion: "0.1.0", now: "2026-08-31T00:01:00.000Z" });
    const saved = original.sources[0];
    if (saved.inspectionStatus !== "ready") throw new Error("Expected a ready source fixture.");
    const reopenedStub: ImportedImage = {
      sourceId: inspected.sourceId,
      name: inspected.name,
      relativePath: inspected.relativePath,
      width: saved.descriptor.dimensions.width,
      height: saved.descriptor.dimensions.height,
      channels: saved.descriptor.channels.length,
      dtype: saved.descriptor.channels[0].dtype,
      format: saved.descriptor.format,
      pageCount: 24,
      colorModel: saved.descriptor.colorModel === "unknown"
        ? undefined
        : saved.descriptor.colorModel,
      accessMode: saved.descriptor.access.mode,
      viewOnlyReason: saved.descriptor.access.reason ?? undefined,
      restoredDescriptor: structuredClone(saved.descriptor),
    };

    const reopenedSave = createProjectManifest(identity, {
      sources: [reopenedStub],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: display,
    }, {
      appVersion: "0.1.0",
      now: "2026-08-31T00:02:00.000Z",
      previous: original,
    });

    const restored = reopenedSave.sources[0];
    expect(restored.inspectionStatus).toBe("ready");
    if (restored.inspectionStatus !== "ready") return;
    expect(restored.descriptor).toEqual(saved.descriptor);
    expect(restored.workspace).toMatchObject({
      inferredWorkspace: "scientific-volume",
      workspace: "scientific-volume",
      decision: "structural",
    });
    expect(() => validateProjectManifestV1(reopenedSave)).not.toThrow();
  });

  it("persists only source-scoped review records with their result revision", () => {
    const source: ImportedImage = {
      sourceId: "source-1",
      name: "field.tif",
      relativePath: "day-1/field.tif",
      width: 640,
      height: 480,
      channels: 1,
      dtype: "uint8",
      format: "TIFF",
      pageCount: 1,
    };
    const previous = createProjectManifest(identity, {
      sources: [source],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: display,
    }, { appVersion: "0.1.0", now: "2026-08-31T00:01:00.000Z" });
    const fingerprint = {
      status: "verified" as const,
      algorithm: "sha256" as const,
      sha256: "a".repeat(64),
      verifiedAt: "2026-08-31T00:00:00.000Z",
    };
    previous.sources[0].fingerprint = fingerprint;
    if (previous.sources[0].inspectionStatus !== "ready") {
      throw new Error("Expected an inspected source fixture.");
    }
    previous.sources[0].descriptor.fingerprint = fingerprint;
    previous.jobs = [{
      spec: {
        schemaVersion: JOB_SPEC_SCHEMA,
        jobId: "segment-1",
        kind: "segment",
        createdAt: "2026-08-31T00:00:00.000Z",
        executionTarget: { kind: "local" },
        inputs: [{
          sourceId: "source-1",
          fingerprintSha256: fingerprint.sha256,
          byteLength: null,
        }],
        operation: {
          profileId: "loci-classical",
          modelId: "loci-classical",
          modelSha256: null,
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
        },
        resources: { cpuCores: 2, memoryMiB: 1024, gpuCount: 0, walltimeMinutes: 10 },
        expectedOutputs: [],
      },
      events: [
        {
          schemaVersion: JOB_EVENT_SCHEMA,
          jobId: "segment-1",
          sequence: 0,
          occurredAt: "2026-08-31T00:00:00.000Z",
          state: "staging",
          progress: 0,
          message: "Preparing source.",
          reasonCode: null,
          schedulerState: null,
        },
        {
          schemaVersion: JOB_EVENT_SCHEMA,
          jobId: "segment-1",
          sequence: 1,
          occurredAt: "2026-08-31T00:00:01.000Z",
          state: "running",
          progress: 0.5,
          message: "Segmenting source.",
          reasonCode: null,
          schedulerState: null,
        },
        {
          schemaVersion: JOB_EVENT_SCHEMA,
          jobId: "segment-1",
          sequence: 2,
          occurredAt: "2026-08-31T00:00:02.000Z",
          state: "completed",
          progress: 1,
          message: "Result verified.",
          reasonCode: null,
          schedulerState: null,
        },
      ],
      result: {
        schemaVersion: RESULT_MANIFEST_SCHEMA,
        resultManifestId: "result-manifest-1",
        resultId: "result-1",
        jobId: "segment-1",
        createdAt: "2026-08-31T00:00:02.000Z",
        sourceFingerprints: [{ sourceId: "source-1", sha256: fingerprint.sha256 }],
        producer: {
          appVersion: "0.1.0",
          engineVersion: "0.1.0",
          modelId: "loci-classical",
          modelSha256: null,
          settingsSha256: "b".repeat(64),
        },
        artifacts: [],
        publication: { state: "verified", atomic: true, reason: null },
      },
    }];
    previous.modelResults = [{
      resultId: "result-1",
      sourceId: "source-1",
      modelId: "loci-classical",
      modelSha256: null,
      evidenceStatus: "experimental",
      createdAt: "2026-08-31T00:00:02.000Z",
      resultManifestId: "result-manifest-1",
    }];
    const retainedReview: ProjectReviewRecord = {
      reviewId: "review-1",
      sourceId: "source-1",
      resultId: "result-1",
      correctionRevision: 2,
      disposition: "reviewed",
      decidedAt: "2026-08-31T00:00:03.000Z",
      note: "Boundaries checked after correction.",
    };
    const removedSourceReview: ProjectReviewRecord = {
      ...retainedReview,
      reviewId: "review-removed",
      sourceId: "source-removed",
    };

    const saved = createProjectManifest(identity, {
      sources: [source],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      reviews: [retainedReview, removedSourceReview],
      defaultDisplay: display,
    }, {
      appVersion: "0.1.0",
      now: "2026-08-31T00:02:00.000Z",
      previous,
    });

    expect(saved.reviews).toEqual([retainedReview]);
    expect(saved.reviews[0]).toMatchObject({
      sourceId: "source-1",
      resultId: "result-1",
      correctionRevision: 2,
      disposition: "reviewed",
    });
    expect(() => validateProjectManifestV1(saved)).not.toThrow();
  });

  it("drops job history that references a removed source", () => {
    const source = (sourceId: string): ImportedImage => ({
      sourceId,
      name: `${sourceId}.tif`,
      relativePath: `${sourceId}.tif`,
    });
    const fingerprintJob = (jobId: string, sourceId: string): ProjectJobRecord => ({
      spec: {
        schemaVersion: JOB_SPEC_SCHEMA,
        jobId,
        kind: "fingerprint",
        createdAt: "2026-08-31T00:00:00.000Z",
        executionTarget: { kind: "local" },
        inputs: [{ sourceId, fingerprintSha256: null, byteLength: null }],
        operation: { profileId: null, modelId: null, modelSha256: null, settings: null },
        resources: { cpuCores: null, memoryMiB: null, gpuCount: 0, walltimeMinutes: null },
        expectedOutputs: [],
      },
      events: [{
        schemaVersion: JOB_EVENT_SCHEMA,
        jobId,
        sequence: 0,
        occurredAt: "2026-08-31T00:00:00.000Z",
        state: "staging",
        progress: 0,
        message: "Preparing source inspection.",
        reasonCode: null,
        schedulerState: null,
      }],
      result: null,
    });
    const previous = createProjectManifest(identity, {
      sources: [source("source-1"), source("source-2")],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: display,
    }, { appVersion: "0.1.0", now: "2026-08-31T00:01:00.000Z" });
    previous.jobs = [fingerprintJob("job-1", "source-1"), fingerprintJob("job-2", "source-2")];

    const next = createProjectManifest(identity, {
      sources: [source("source-1")],
      displayBySourceId: {},
      workspaceOverrideBySourceId: {},
      defaultDisplay: display,
    }, {
      appVersion: "0.1.0",
      now: "2026-08-31T00:02:00.000Z",
      previous,
    });

    expect(next.jobs.map(({ spec }) => spec.jobId)).toEqual(["job-1"]);
    expect(() => validateProjectManifestV1(next)).not.toThrow();
  });
});
