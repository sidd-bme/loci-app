// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  type AnalysisResult,
  type SegmentationSettings,
} from "../shared/contracts";
import {
  JOB_SPEC_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  type JobSpec,
  type ProjectJobRecord,
  type ProjectModelResultReference,
  type ResultManifest,
} from "../shared/foundation-contracts";
import {
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
} from "./working-result-publication";
import { sha256CanonicalJson } from "./job-store";
import {
  assertRestoredProjectResultBinding,
  selectRestorableProjectResult,
} from "./project-result-selection";

const SOURCE_SHA256 = "a".repeat(64);
const ARTIFACT_SHA256 = "b".repeat(64);
const CLASSICAL_SETTINGS: SegmentationSettings = {
  image_mode: "auto",
  polarity: "auto",
  expected_diameter_px: 34,
  min_area_px: 80,
  sensitivity: 0,
  smoothing_px: 1.2,
  split_touching: true,
  exclude_border: false,
};

function jobSpec(jobId: string, createdAt: string): JobSpec {
  return {
    schemaVersion: JOB_SPEC_SCHEMA,
    jobId,
    kind: "segment",
    createdAt,
    executionTarget: { kind: "local" },
    inputs: [{ sourceId: "source-1", fingerprintSha256: SOURCE_SHA256, byteLength: null }],
    operation: {
      profileId: "loci-classical",
      modelId: "loci-classical",
      modelSha256: null,
      settings: CLASSICAL_SETTINGS,
    },
    resources: { cpuCores: null, memoryMiB: null, gpuCount: 0, walltimeMinutes: null },
    expectedOutputs: [{
      artifactId: WORKING_RESULT_ARTIFACT_ID,
      mediaType: WORKING_RESULT_MEDIA_TYPE,
    }],
  };
}

function resultManifest(
  jobId: string,
  resultId: string,
  resultManifestId: string,
  createdAt: string,
  withArtifact: boolean,
): ResultManifest {
  return {
    schemaVersion: RESULT_MANIFEST_SCHEMA,
    resultManifestId,
    resultId,
    jobId,
    createdAt,
    sourceFingerprints: [{ sourceId: "source-1", sha256: SOURCE_SHA256 }],
    producer: {
      appVersion: "0.1.0",
      engineVersion: "0.1.0",
      modelId: "loci-classical",
      modelSha256: null,
      settingsSha256: sha256CanonicalJson(CLASSICAL_SETTINGS),
    },
    artifacts: withArtifact ? [{
      artifactId: WORKING_RESULT_ARTIFACT_ID,
      filename: `working-${resultId}-r0.loci-result`,
      mediaType: WORKING_RESULT_MEDIA_TYPE,
      byteLength: 4_096,
      sha256: ARTIFACT_SHA256,
    }] : [],
    publication: { state: "verified", atomic: true, reason: null },
  };
}

function restoredAnalysis(): AnalysisResult {
  return {
    resultId: "result-current",
    evictedResultIds: [],
    source: {
      name: "cells.png",
      relativePath: "cells.png",
      width: 100,
      height: 80,
      dtype: "uint8",
      channels: 3,
      format: "png",
      pageCount: 1,
    },
    engine: { id: "loci-classical", version: "0.1.0" },
    profile: {
      id: "loci-classical",
      name: "Loci Adaptive Watershed",
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
    settings: CLASSICAL_SETTINGS,
    resolved: { polarity: "dark", threshold: 100 },
    metrics: { count: 1, confluencePercent: 2 },
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
    previewDataUrl: "data:image/png;base64,AA==",
    overlayDataUrl: "data:image/png;base64,AA==",
  };
}

function job(
  jobId: string,
  resultId: string,
  resultManifestId: string,
  jobCreatedAt: string,
  resultCreatedAt: string,
  withArtifact: boolean,
): ProjectJobRecord {
  return {
    spec: jobSpec(jobId, jobCreatedAt),
    events: [],
    result: resultManifest(jobId, resultId, resultManifestId, resultCreatedAt, withArtifact),
  };
}

function modelResult(
  resultId: string,
  resultManifestId: string,
  createdAt: string,
): ProjectModelResultReference {
  return {
    resultId,
    sourceId: "source-1",
    modelId: "loci-classical",
    modelSha256: null,
    evidenceStatus: "experimental",
    createdAt,
    resultManifestId,
  };
}

describe("project result restore selection", () => {
  it("does not resurrect a historical job after its active model-result binding was cleared", () => {
    const historicalJob = job(
      "job-history",
      "result-cleared",
      "manifest-cleared",
      "2026-09-01T00:00:01.000Z",
      "2026-09-01T00:00:02.000Z",
      true,
    );

    expect(selectRestorableProjectResult({
      modelResults: [],
      jobs: [historicalJob],
      corrections: [],
    }, "source-1")).toBeNull();
  });

  it("binds the selected model result to its exact artifact-bearing job", () => {
    const historicalWithoutArtifact = job(
      "job-parent",
      "result-old",
      "manifest-old",
      // A parent/finalization job can be persisted after the analytical child;
      // its job timestamp must not override the selected model result.
      "2026-09-01T00:00:09.000Z",
      "2026-09-01T00:00:01.000Z",
      false,
    );
    const selectedJob = job(
      "job-analysis",
      "result-current",
      "manifest-current",
      "2026-09-01T00:00:02.000Z",
      "2026-09-01T00:00:03.000Z",
      true,
    );

    const selected = selectRestorableProjectResult({
      modelResults: [modelResult("result-current", "manifest-current", "2026-09-01T00:00:03.000Z")],
      jobs: [historicalWithoutArtifact, selectedJob],
      corrections: [],
    }, "source-1");

    expect(selected?.job.spec.jobId).toBe("job-analysis");
    expect(selected?.resultManifest.resultId).toBe("result-current");
    expect(selected?.originalArtifact.filename).toBe("working-result-current-r0.loci-result");
  });

  it("does not fall back to another source job when the selected exact result lacks an artifact", () => {
    expect(() => selectRestorableProjectResult({
      modelResults: [modelResult("result-current", "manifest-current", "2026-09-01T00:00:03.000Z")],
      jobs: [
        job("job-old", "result-old", "manifest-old", "2026-09-01T00:00:01.000Z", "2026-09-01T00:00:01.000Z", true),
        job("job-current", "result-current", "manifest-current", "2026-09-01T00:00:02.000Z", "2026-09-01T00:00:03.000Z", false),
      ],
      corrections: [],
    }, "source-1")).toThrow(/missing its exact recoverable working-result artifact/i);
  });

  it("rejects a project result whose producer settings digest was detached from its job", () => {
    const selectedJob = job(
      "job-analysis",
      "result-current",
      "manifest-current",
      "2026-09-01T00:00:02.000Z",
      "2026-09-01T00:00:03.000Z",
      true,
    );
    selectedJob.result!.producer.settingsSha256 = "c".repeat(64);

    expect(() => selectRestorableProjectResult({
      modelResults: [modelResult("result-current", "manifest-current", "2026-09-01T00:00:03.000Z")],
      jobs: [selectedJob],
      corrections: [],
    }, "source-1")).toThrow(/settings digest does not match its exact project job/i);
  });

  it.each([
    {
      label: "profile",
      mutate: (analysis: AnalysisResult) => { analysis.profile.id = "cellpose-sam"; },
      error: /saved analysis profile/i,
    },
    {
      label: "settings",
      mutate: (analysis: AnalysisResult) => { analysis.settings = { ...CLASSICAL_SETTINGS, sensitivity: 2 }; },
      error: /saved settings digest/i,
    },
    {
      label: "model",
      mutate: (analysis: AnalysisResult) => { analysis.profile.model.sha256 = "d".repeat(64); },
      error: /saved model identity/i,
    },
    {
      label: "engine",
      mutate: (analysis: AnalysisResult) => { analysis.engine.version = "tampered"; },
      error: /saved engine provenance/i,
    },
    {
      label: "engine identity",
      mutate: (analysis: AnalysisResult) => { analysis.engine.id = "another-profile"; },
      error: /saved engine identity/i,
    },
  ])("rejects restored pack $label provenance before it can be trusted", ({ mutate, error }) => {
    const selected = selectRestorableProjectResult({
      modelResults: [modelResult("result-current", "manifest-current", "2026-09-01T00:00:03.000Z")],
      jobs: [job(
        "job-analysis",
        "result-current",
        "manifest-current",
        "2026-09-01T00:00:02.000Z",
        "2026-09-01T00:00:03.000Z",
        true,
      )],
      corrections: [],
    }, "source-1");
    expect(selected).not.toBeNull();
    const analysis = restoredAnalysis();
    mutate(analysis);

    expect(() => assertRestoredProjectResultBinding(selected!, analysis)).toThrow(error);
  });

  it("accepts a restored pack only when profile, model, settings, and producer all agree", () => {
    const selected = selectRestorableProjectResult({
      modelResults: [modelResult("result-current", "manifest-current", "2026-09-01T00:00:03.000Z")],
      jobs: [job(
        "job-analysis",
        "result-current",
        "manifest-current",
        "2026-09-01T00:00:02.000Z",
        "2026-09-01T00:00:03.000Z",
        true,
      )],
      corrections: [],
    }, "source-1");

    expect(() => assertRestoredProjectResultBinding(selected!, restoredAnalysis())).not.toThrow();
  });
});
