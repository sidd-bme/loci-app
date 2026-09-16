// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { SourceMetadata } from "./contracts";
import {
  CAPABILITY_MANIFEST_SCHEMA,
  JOB_EVENT_SCHEMA,
  JOB_SPEC_SCHEMA,
  MAX_PROJECT_SOURCES,
  MODEL_MANIFEST_SCHEMA,
  PROJECT_MANIFEST_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  VALIDATION_REPORT_SCHEMA,
  type CapabilityManifest,
  type JobEvent,
  type JobSpec,
  type ModelManifest,
  type ProjectManifestV1,
  type ResultManifest,
  type ValidationReport,
} from "./foundation-contracts";
import {
  FoundationValidationError,
  assertRendererSafePayload,
  isRendererSafeProjectManifest,
  validateCapabilityManifest,
  validateJobEvent,
  validateJobSpec,
  validateModelManifest,
  validateProjectManifestV1,
  validateResultManifest,
  validateValidationReport,
  validateWorkspaceRecommendation,
} from "./foundation-validation";
import { createSourceDescriptor, recommendWorkspace } from "./source-routing";

const NOW = "2026-08-31T00:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CELLPOSE_JOB_SETTINGS = {
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
const SETTINGS_DIGEST = createHash("sha256")
  .update(JSON.stringify(Object.fromEntries(
    Object.entries(CELLPOSE_JOB_SETTINGS).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0),
  )))
  .digest("hex");

function metadata(): SourceMetadata {
  return {
    name: "field.png",
    relativePath: "experiment/field.png",
    width: 640,
    height: 480,
    channels: 3,
    dtype: "uint8",
    format: "PNG",
    pageCount: 1,
    colorModel: "interleaved-rgb",
    accessMode: "full",
  };
}

function jobSpec(): JobSpec {
  return {
    schemaVersion: JOB_SPEC_SCHEMA,
    jobId: "job-1",
    kind: "segment",
    createdAt: NOW,
    executionTarget: { kind: "local" },
    inputs: [{ sourceId: "source-1", fingerprintSha256: HASH_A, byteLength: 1024 }],
    operation: {
      profileId: "cellpose-sam",
      modelId: "cpsam",
      modelSha256: HASH_B,
      settings: { ...CELLPOSE_JOB_SETTINGS },
    },
    resources: { cpuCores: 4, memoryMiB: 4096, gpuCount: 0, walltimeMinutes: 30 },
    expectedOutputs: [{ artifactId: "labels", mediaType: "image/tiff" }],
  };
}

function event(overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    schemaVersion: JOB_EVENT_SCHEMA,
    jobId: "job-1",
    sequence: 0,
    occurredAt: NOW,
    state: "staging",
    progress: 0,
    message: "Preparing verified inputs.",
    reasonCode: null,
    schedulerState: null,
    ...overrides,
  };
}

function resultManifest(): ResultManifest {
  return {
    schemaVersion: RESULT_MANIFEST_SCHEMA,
    resultManifestId: "result-manifest-1",
    resultId: "result-1",
    jobId: "job-1",
    createdAt: NOW,
    sourceFingerprints: [{ sourceId: "source-1", sha256: HASH_A }],
    producer: {
      appVersion: "0.1.0",
      engineVersion: "0.1.0",
      modelId: "cpsam",
      modelSha256: HASH_B,
      settingsSha256: SETTINGS_DIGEST,
    },
    artifacts: [{
      artifactId: "labels",
      filename: "field_labels.tiff",
      mediaType: "image/tiff",
      byteLength: 2048,
      sha256: HASH_B,
    }],
    publication: { state: "verified", atomic: true, reason: null },
  };
}

function projectManifest(): ProjectManifestV1 {
  const descriptor = createSourceDescriptor(metadata(), {
    fingerprint: {
      status: "verified",
      algorithm: "sha256",
      sha256: HASH_A,
      verifiedAt: NOW,
    },
  });
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA,
    projectId: "project-1",
    title: "Cell-count review",
    createdAt: NOW,
    updatedAt: NOW,
    appVersion: "0.1.0",
    sources: [{
      sourceId: "source-1",
      displayName: "field.png",
      relativeLabel: "experiment/field.png",
      fingerprint: descriptor.fingerprint,
      inspectionStatus: "ready",
      descriptor,
      workspace: recommendWorkspace(descriptor),
      inspectionFailure: null,
    }],
    displayRecipes: [{
      recipeId: "recipe-1",
      sourceId: "source-1",
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
      channelSettings: [],
    }],
    annotations: [{
      annotationId: "annotation-1",
      sourceId: "source-1",
      kind: "point",
      points: [{ x: 10, y: 20, z: null, t: null }],
      label: "Review",
      color: "#20b8aa",
      properties: { reviewed: false },
    }],
    corrections: [{
      correctionId: "correction-1",
      sourceId: "source-1",
      resultId: "result-1",
      revision: 1,
      operationIds: ["operation-1"],
      workingResultArtifact: {
        artifactId: "working-result",
        filename: "working-result-1-r1.loci-result",
        mediaType: "application/vnd.loci.working-result+zip",
        byteLength: 4096,
        sha256: HASH_A,
      },
    }],
    modelResults: [{
      resultId: "result-1",
      sourceId: "source-1",
      modelId: "cpsam",
      modelSha256: HASH_B,
      evidenceStatus: "experimental",
      createdAt: NOW,
      resultManifestId: "result-manifest-1",
    }],
    reviews: [],
    jobs: [{
      spec: jobSpec(),
      events: [
        event(),
        event({ sequence: 1, state: "running", progress: 0.5 }),
        event({ sequence: 2, state: "completed", progress: 1 }),
      ],
      result: resultManifest(),
    }],
    migrations: [],
  };
}

function capabilityManifest(): CapabilityManifest {
  return {
    schemaVersion: CAPABILITY_MANIFEST_SCHEMA,
    capabilityId: "scientific-volumes",
    name: "Scientific Volumes",
    version: "1.0.0",
    appCompatibility: { minimum: "0.1.0", maximumExclusive: null },
    artifact: {
      sha256: HASH_A,
      sizeBytes: 4096,
      sourceUrl: "https://downloads.example.org/loci/scientific-volumes.loci-capability",
      offlineImportSupported: true,
    },
    dependencies: [],
    licenses: [{ component: "volume-runtime", spdxId: "Apache-2.0", sourceUrl: "https://example.org/source" }],
  };
}

function modelManifest(): ModelManifest {
  return {
    schemaVersion: MODEL_MANIFEST_SCHEMA,
    modelId: "example-model",
    name: "Example model",
    version: "1.0.0",
    artifact: { sha256: HASH_B, sizeBytes: 8192, bundled: false, sourceUrl: "https://example.org/model" },
    runtime: { backend: "example", requiredVersion: "1.0.0" },
    intendedDomain: {
      summary: "Cultured-cell brightfield images acquired within the declared protocol.",
      modalities: ["brightfield"],
      organisms: ["human"],
      channels: ["luminance"],
      pixelSize: { minimum: 0.2, maximum: 1.5, unit: "µm/px" },
    },
    preprocessing: ["Declared per-image normalization"],
    postprocessing: ["Source-grid restoration"],
    rights: {
      codeLicense: "Apache-2.0",
      checkpointLicense: "CC-BY-4.0",
      redistribution: "permitted",
      commercialUse: "permitted",
      trainingDataLineage: "Declared in the model card.",
    },
    evidenceStatus: "experimental",
    validationReportIds: ["report-1"],
    knownFailureModes: ["Out-of-focus images"],
  };
}

function validationReport(): ValidationReport {
  return {
    schemaVersion: VALIDATION_REPORT_SCHEMA,
    reportId: "report-1",
    modelId: "example-model",
    modelSha256: HASH_B,
    createdAt: NOW,
    evidenceStatus: "validated-for-domain",
    declaredDomain: "Cultured-cell brightfield images within the locked protocol.",
    dataset: {
      name: "Locked lab test",
      version: "1",
      splitPolicy: "Held out by acquisition day and well.",
      unitOfIndependence: "acquisition well",
      sampleCount: 42,
    },
    frozenConfigurationSha256: HASH_A,
    metrics: [{ id: "instance-f1-iou50", value: 0.9, unit: "fraction", higherIsBetter: true }],
    gates: [{ metricId: "instance-f1-iou50", operator: ">=", threshold: 0.85, passed: true }],
    strata: [],
    knownFailureModes: ["Out-of-focus images"],
    claimBoundary: "Validated only for the declared acquisition protocol; not a viability assay.",
  };
}

describe("renderer-safe project validation", () => {
  it.each(["_result-token", "-result-token"])(
    "accepts URL-safe result identifiers beginning with %s",
    (resultId) => {
      expect(validateResultManifest({ ...resultManifest(), resultId }).resultId).toBe(resultId);
    },
  );

  it("accepts a complete renderer-facing v1 project", () => {
    const manifest = projectManifest();

    expect(validateProjectManifestV1(manifest)).toBe(manifest);
    expect(isRendererSafeProjectManifest(manifest)).toBe(true);
  });

  it("binds every corrected revision to one exact immutable working-result pack", () => {
    const manifest = projectManifest();

    expect(validateProjectManifestV1(manifest).corrections[0]).toEqual({
      correctionId: "correction-1",
      sourceId: "source-1",
      resultId: "result-1",
      revision: 1,
      operationIds: ["operation-1"],
      workingResultArtifact: {
        artifactId: "working-result",
        filename: "working-result-1-r1.loci-result",
        mediaType: "application/vnd.loci.working-result+zip",
        byteLength: 4096,
        sha256: HASH_A,
      },
    });
  });

  it("accepts an undo-to-baseline revision with an exact pack and no applied operations", () => {
    const manifest = projectManifest();
    manifest.corrections[0].revision = 2;
    manifest.corrections[0].operationIds = [];

    expect(validateProjectManifestV1(manifest).corrections[0]).toMatchObject({
      revision: 2,
      operationIds: [],
      workingResultArtifact: {
        artifactId: "working-result",
        mediaType: "application/vnd.loci.working-result+zip",
      },
    });
  });

  it("rejects malformed or non-working-result correction-pack bindings", () => {
    const cases: Array<{
      label: string;
      mutate: (manifest: ProjectManifestV1) => void;
      message: RegExp;
    }> = [
      {
        label: "wrong artifact identifier",
        mutate: (manifest) => {
          manifest.corrections[0].workingResultArtifact.artifactId = "labels";
        },
        message: /verified Loci working-result pack/i,
      },
      {
        label: "wrong media type",
        mutate: (manifest) => {
          manifest.corrections[0].workingResultArtifact.mediaType = "application/zip";
        },
        message: /verified Loci working-result pack/i,
      },
      {
        label: "zero correction revision",
        mutate: (manifest) => {
          manifest.corrections[0].revision = 0;
        },
        message: /safe integer of at least 1/i,
      },
      {
        label: "unsafe artifact filename",
        mutate: (manifest) => {
          manifest.corrections[0].workingResultArtifact.filename = "../working-result.loci-result";
        },
        message: /normalized, portable relative display label/i,
      },
      {
        label: "invalid artifact digest",
        mutate: (manifest) => {
          manifest.corrections[0].workingResultArtifact.sha256 = "not-a-sha256";
        },
        message: /SHA-256 hex digest/i,
      },
      {
        label: "invalid artifact size",
        mutate: (manifest) => {
          manifest.corrections[0].workingResultArtifact.byteLength = -1;
        },
        message: /safe integer of at least 0/i,
      },
    ];

    for (const testCase of cases) {
      const manifest = projectManifest();
      testCase.mutate(manifest);
      expect(
        () => validateProjectManifestV1(manifest),
        testCase.label,
      ).toThrow(testCase.message);
    }
  });

  it("strictly rejects unknown correction-pack fields", () => {
    const manifest = projectManifest() as unknown as {
      corrections: Array<{
        workingResultArtifact: Record<string, unknown>;
      }>;
    };
    manifest.corrections[0].workingResultArtifact.compression = "zip";

    expect(() => validateProjectManifestV1(manifest)).toThrow(/not part of this schema/i);
  });

  it("persists lazy folder sources without fake inspected metadata", () => {
    const manifest = projectManifest();
    manifest.sources[0] = {
      sourceId: "source-1",
      displayName: "field.png",
      relativeLabel: "large-folder/field.png",
      fingerprint: {
        status: "pending",
        algorithm: "sha256",
        sha256: null,
        verifiedAt: null,
      },
      inspectionStatus: "pending",
      descriptor: null,
      workspace: null,
      inspectionFailure: null,
    };
    manifest.corrections = [];
    manifest.modelResults = [];
    manifest.jobs = [];

    expect(validateProjectManifestV1(manifest).sources[0]).toMatchObject({
      inspectionStatus: "pending",
      descriptor: null,
      workspace: null,
    });
  });

  it("uses a sanitized failure variant and rejects contradictory inspection states", () => {
    const failed = projectManifest();
    failed.sources[0] = {
      sourceId: "source-1",
      displayName: "field.png",
      relativeLabel: "field.png",
      fingerprint: {
        status: "failed",
        algorithm: "sha256",
        sha256: null,
        verifiedAt: null,
        reasonCode: "source-unreadable",
      },
      inspectionStatus: "failed",
      descriptor: null,
      workspace: null,
      inspectionFailure: { code: "decoder-unavailable", summary: "The source could not be inspected." },
    };
    failed.corrections = [];
    failed.modelResults = [];
    failed.jobs = [];
    expect(validateProjectManifestV1(failed).sources[0].inspectionStatus).toBe("failed");

    const contradictory = projectManifest() as unknown as {
      sources: Array<Record<string, unknown>>;
    };
    contradictory.sources[0].inspectionStatus = "pending";
    contradictory.sources[0].inspectionFailure = null;
    expect(() => validateProjectManifestV1(contradictory)).toThrow(/Only a ready source/i);
  });

  it("rejects hidden canonical paths, credentials, raw pixels, and binary values", () => {
    const withPath = { ...projectManifest(), canonicalPath: "/private/lab/project.loci" };
    const withCredential = { ...projectManifest(), sshPassword: "not-safe" };

    expect(() => validateProjectManifestV1(withPath)).toThrow(FoundationValidationError);
    expect(() => validateProjectManifestV1(withCredential)).toThrow(/not part|main-process-only/i);
    expect(() => assertRendererSafePayload({ authorization: "Bearer private" })).toThrow(/main-process-only/i);
    expect(() => assertRendererSafePayload({ sessionCookie: "private" })).toThrow(/main-process-only/i);
    expect(() => assertRendererSafePayload({ sshKey: "private" })).toThrow(/main-process-only/i);
    expect(() => assertRendererSafePayload({ jwt: "private" })).toThrow(/main-process-only/i);
    expect(() => assertRendererSafePayload({ clientCertificate: "private" })).toThrow(/main-process-only/i);
    expect(() => assertRendererSafePayload({ apiKey: "private" })).toThrow(/main-process-only/i);
    expect(() => assertRendererSafePayload({ accessKeyId: "private" })).toThrow(/main-process-only/i);
    expect(() => assertRendererSafePayload({ authentication: "private" })).toThrow(/main-process-only/i);
    expect(() => assertRendererSafePayload({ authCode: "private" })).toThrow(/main-process-only/i);
    expect(() => assertRendererSafePayload({ note: "Bearer private-token" })).toThrow(/credential-like/i);
    expect(() => assertRendererSafePayload({ note: "sk-abcdefghijklmnopqrst" })).toThrow(/credential-like/i);
    expect(() => assertRendererSafePayload({ note: "-----BEGIN OPENSSH PRIVATE KEY-----" })).toThrow(/credential-like/i);
    expect(() => assertRendererSafePayload({ rawPixels: new Uint8Array([1, 2]) })).toThrow(/main-process-only|binary/i);
    expect(isRendererSafeProjectManifest(withPath)).toBe(false);
  });

  it("rejects absolute paths even when hidden in an otherwise allowed message", () => {
    const manifest = projectManifest();
    manifest.jobs[0].events[0].message = "Staging failed at /Volumes/private/input.";

    expect(() => validateProjectManifestV1(manifest)).toThrow(/absolute local path/i);
    expect(() => assertRendererSafePayload({ message: "Staging failed at /data/study/input.tif" }))
      .toThrow(/absolute local path/i);
  });

  it("requires project source identity and workspace routing to match inspected metadata", () => {
    const mismatchedIdentity = projectManifest();
    mismatchedIdentity.sources[0].fingerprint = {
      status: "verified",
      algorithm: "sha256",
      sha256: HASH_B,
      verifiedAt: NOW,
    };
    expect(() => validateProjectManifestV1(mismatchedIdentity)).toThrow(/fingerprint must match/i);

    const mismatchedLabel = projectManifest();
    mismatchedLabel.sources[0].displayName = "other.png";
    expect(() => validateProjectManifestV1(mismatchedLabel)).toThrow(/labels must match/i);

    const mismatchedWorkspace = projectManifest();
    if (mismatchedWorkspace.sources[0].inspectionStatus !== "ready") {
      throw new Error("Expected ready fixture.");
    }
    mismatchedWorkspace.sources[0].workspace = {
      ...mismatchedWorkspace.sources[0].workspace,
      inferredWorkspace: "pathology-2d",
      workspace: "pathology-2d",
      decision: "structural",
      evidence: [{ code: "declared-tiff-pyramid", summary: "The TIFF declares multiple stored resolution levels." }],
      applicablePresets: ["h-and-e-display", "ihc-display", "generic-display"],
      requiredCapabilities: ["pathology-large-2d"],
    };
    expect(() => validateProjectManifestV1(mismatchedWorkspace)).toThrow(/deterministic source recommendation/i);
  });

  it("rejects non-JSON objects and descriptor fingerprint-state contradictions", () => {
    expect(() => assertRendererSafePayload({ value: new Map([["key", "value"]]) })).toThrow(/non-JSON object/i);

    const manifest = projectManifest();
    if (manifest.sources[0].inspectionStatus !== "ready") throw new Error("Expected ready fixture.");
    manifest.sources[0].descriptor.access.provisionalUntilFingerprintVerified = true;
    expect(() => validateProjectManifestV1(manifest)).toThrow(/fingerprint verification/i);
  });

  it("rejects duplicate sources and broken source/result references", () => {
    const duplicate = projectManifest();
    duplicate.sources.push(structuredClone(duplicate.sources[0]));
    expect(() => validateProjectManifestV1(duplicate)).toThrow(/duplicate/i);

    const brokenSource = projectManifest();
    brokenSource.annotations[0].sourceId = "missing-source";
    expect(() => validateProjectManifestV1(brokenSource)).toThrow(/unknown source/i);

    const brokenResult = projectManifest();
    brokenResult.modelResults = [];
    expect(() => validateProjectManifestV1(brokenResult)).toThrow(/unknown result/i);
  });

  it("requires portable, round-trip-stable source labels", () => {
    const nonNormalized = projectManifest();
    nonNormalized.sources[0].relativeLabel = "experiment/./field.png";
    if (nonNormalized.sources[0].inspectionStatus !== "ready") throw new Error("Expected ready fixture.");
    nonNormalized.sources[0].descriptor.relativeLabel = "experiment/./field.png";
    expect(() => validateProjectManifestV1(nonNormalized)).toThrow(/normalized, portable/i);

    const colliding = projectManifest();
    const second = structuredClone(colliding.sources[0]);
    second.sourceId = "source-2";
    second.relativeLabel = "EXPERIMENT/field.png";
    if (second.inspectionStatus !== "ready") throw new Error("Expected ready fixture.");
    second.descriptor.relativeLabel = second.relativeLabel;
    colliding.sources.push(second);
    expect(() => validateProjectManifestV1(colliding)).toThrow(/duplicate/i);
  });

  it("rejects source collections beyond the shared project/session limit", () => {
    const manifest = projectManifest();
    manifest.sources = new Array(MAX_PROJECT_SOURCES + 1).fill(manifest.sources[0]);
    expect(() => validateProjectManifestV1(manifest)).toThrow(/at most 20000 sources/i);
  });

  it("validates persisted display recipes rather than accepting arbitrary JSON", () => {
    const manifest = projectManifest() as unknown as {
      displayRecipes: Array<{ settings: Record<string, unknown> }>;
    };
    manifest.displayRecipes[0].settings.gamma = 0;
    expect(() => validateProjectManifestV1(manifest)).toThrow(/Gamma/i);

    manifest.displayRecipes[0].settings = {};
    expect(() => validateProjectManifestV1(manifest)).toThrow(/required/i);
  });

  it("keeps the one-display-recipe-per-source round-trip invariant", () => {
    const duplicateRecipe = projectManifest();
    duplicateRecipe.displayRecipes.push({
      ...structuredClone(duplicateRecipe.displayRecipes[0]),
      recipeId: "recipe-2",
    });
    expect(() => validateProjectManifestV1(duplicateRecipe)).toThrow(/duplicate/i);

    const duplicateChannel = projectManifest();
    duplicateChannel.displayRecipes[0].channelSettings = [
      { channelIndex: 0, visible: true, opacity: 1, color: null, blackPoint: 0, whitePoint: 1, gamma: 1 },
      { channelIndex: 0, visible: false, opacity: 0.5, color: null, blackPoint: 0, whitePoint: 1, gamma: 1 },
    ];
    expect(() => validateProjectManifestV1(duplicateChannel)).toThrow(/duplicate/i);
  });

  it("validates embedded job histories and completion records as a unit", () => {
    const skippedSequence = projectManifest();
    skippedSequence.jobs[0].events.push(event({
      sequence: 2,
      state: "running",
      progress: 0.4,
      occurredAt: "2026-08-31T00:00:01.000Z",
    }));
    expect(() => validateProjectManifestV1(skippedSequence)).toThrow(/contiguous/i);

    const prematureResult = projectManifest();
    prematureResult.jobs[0].events = [event()];
    expect(() => validateProjectManifestV1(prematureResult)).toThrow(/Only a completed job/i);

    const completedWithoutResult = projectManifest();
    completedWithoutResult.jobs[0].events = [
      event(),
      event({ sequence: 1, state: "running", progress: 0.5, occurredAt: "2026-08-31T00:00:01.000Z" }),
      event({ sequence: 2, state: "completed", progress: 1, occurredAt: "2026-08-31T00:00:02.000Z" }),
    ];
    completedWithoutResult.jobs[0].result = null;
    expect(() => validateProjectManifestV1(completedWithoutResult)).toThrow(/requires a verified result/i);
  });

  it("enforces same-source correction and embedded job/result provenance", () => {
    const wrongCorrectionSource = projectManifest();
    const secondSource = structuredClone(wrongCorrectionSource.sources[0]);
    secondSource.sourceId = "source-2";
    secondSource.relativeLabel = "experiment/field-2.png";
    if (secondSource.inspectionStatus !== "ready") throw new Error("Expected ready fixture.");
    secondSource.descriptor.relativeLabel = secondSource.relativeLabel;
    wrongCorrectionSource.sources.push(secondSource);
    wrongCorrectionSource.corrections[0].sourceId = "source-2";
    expect(() => validateProjectManifestV1(wrongCorrectionSource)).toThrow(/same source/i);

    const unknownJobSource = projectManifest();
    unknownJobSource.jobs[0].spec.inputs[0].sourceId = "missing-source";
    expect(() => validateProjectManifestV1(unknownJobSource)).toThrow(/unknown source/i);

    const unknownResultManifest = projectManifest();
    unknownResultManifest.modelResults[0].resultManifestId = "missing-result-manifest";
    expect(() => validateProjectManifestV1(unknownResultManifest)).toThrow(/unknown result manifest/i);

    const mismatchedProjectFingerprint = projectManifest();
    const source = mismatchedProjectFingerprint.sources[0];
    if (source.inspectionStatus !== "ready") throw new Error("Expected ready fixture.");
    source.fingerprint = {
      status: "verified",
      algorithm: "sha256",
      sha256: HASH_B,
      verifiedAt: NOW,
    };
    source.descriptor.fingerprint = structuredClone(source.fingerprint);
    expect(() => validateProjectManifestV1(mismatchedProjectFingerprint)).toThrow(/project source fingerprint/i);

    const mismatchedCreatedAt = projectManifest();
    mismatchedCreatedAt.modelResults[0].createdAt = "2026-08-31T00:00:01.000Z";
    expect(() => validateProjectManifestV1(mismatchedCreatedAt)).toThrow(/creation time/i);
  });

  it("compares SHA-256 provenance case-insensitively after validation", () => {
    const manifest = projectManifest();
    manifest.jobs[0].spec.inputs[0].fingerprintSha256 = HASH_A.toUpperCase();
    if (!manifest.jobs[0].result) throw new Error("Expected result fixture.");
    manifest.jobs[0].result.sourceFingerprints[0].sha256 = HASH_A.toUpperCase();
    manifest.jobs[0].result.producer.modelSha256 = HASH_B.toUpperCase();
    manifest.modelResults[0].modelSha256 = HASH_B.toUpperCase();

    expect(() => validateProjectManifestV1(manifest)).not.toThrow();
  });

  it("rejects biological auto-run recommendations even when other fields are valid", () => {
    const workspace = recommendWorkspace(createSourceDescriptor(metadata()));
    const unsafeWorkspace = {
      ...workspace,
      analysis: { autoRun: true, recommendedModelId: "cpsam", reason: "Filename looked biological." },
    };

    expect(() => validateWorkspaceRecommendation(unsafeWorkspace)).toThrow(/never auto-run/i);
  });
});

describe("capability and model evidence validation", () => {
  it("accepts checksum-pinned HTTPS capability metadata", () => {
    expect(validateCapabilityManifest(capabilityManifest())).toEqual(capabilityManifest());
  });

  it("rejects insecure capability downloads and dependency cycles", () => {
    const insecure = capabilityManifest();
    insecure.artifact.sourceUrl = "http://downloads.example.org/pack";
    expect(() => validateCapabilityManifest(insecure)).toThrow(/HTTPS/i);

    const selfDependency = capabilityManifest();
    selfDependency.dependencies = [{ capabilityId: "scientific-volumes", versionRange: "^1" }];
    expect(() => validateCapabilityManifest(selfDependency)).toThrow(/depend on itself/i);
  });

  it("accepts an experimental model while requiring reports for validated status", () => {
    expect(validateModelManifest(modelManifest()).evidenceStatus).toBe("experimental");

    const unsupportedClaim = modelManifest();
    unsupportedClaim.evidenceStatus = "validated-for-domain";
    unsupportedClaim.validationReportIds = [];
    expect(() => validateModelManifest(unsupportedClaim)).toThrow(/validation report/i);
  });

  it("accepts locked passing validation and rejects unsupported validated claims", () => {
    expect(validateValidationReport(validationReport()).evidenceStatus).toBe("validated-for-domain");

    const failedGate = validationReport();
    failedGate.gates[0].passed = false;
    expect(() => validateValidationReport(failedGate)).toThrow(/does not match/i);

    const correctlyFailedGate = validationReport();
    correctlyFailedGate.metrics[0].value = 0.5;
    correctlyFailedGate.gates[0].passed = false;
    expect(() => validateValidationReport(correctlyFailedGate)).toThrow(/passing locked gates/i);

    const unknownMetric = validationReport();
    unknownMetric.gates[0].metricId = "undeclared-metric";
    expect(() => validateValidationReport(unknownMetric)).toThrow(/undeclared metric/i);
  });
});

describe("job and result contract validation", () => {
  it("accepts local and credential-free remote job specifications", () => {
    expect(validateJobSpec(jobSpec())).toEqual(jobSpec());

    const remote = jobSpec();
    remote.executionTarget = { kind: "remote", computeProfileId: "vanda-profile", scheduler: "pbs" };
    expect(validateJobSpec(remote).executionTarget).toEqual(remote.executionTarget);
  });

  it("requires frozen fingerprints for analytical jobs but permits pending fingerprint work", () => {
    const analytical = jobSpec();
    analytical.inputs[0].fingerprintSha256 = null;
    expect(() => validateJobSpec(analytical)).toThrow(/frozen source fingerprint/i);

    const fingerprint = jobSpec();
    fingerprint.kind = "fingerprint";
    fingerprint.inputs[0].fingerprintSha256 = null;
    fingerprint.operation = {
      profileId: null,
      modelId: null,
      modelSha256: null,
      settings: null,
    };
    expect(() => validateJobSpec(fingerprint)).not.toThrow();
  });

  it("rejects credentials embedded in job settings", () => {
    const unsafe = jobSpec();
    unsafe.operation.settings = { password: "never-store-this" };

    expect(() => validateJobSpec(unsafe)).toThrow(/main-process-only/i);

    const unknown = jobSpec();
    unknown.operation.settings = { ...CELLPOSE_JOB_SETTINGS, arbitraryNote: "opaque" };
    expect(() => validateJobSpec(unknown)).toThrow(/not part of this (?:settings )?schema/i);

    const incomplete = jobSpec();
    incomplete.operation.settings = { flow_threshold: 0.4 };
    expect(() => validateJobSpec(incomplete)).toThrow(/required/i);

    const impossible = jobSpec();
    impossible.operation.settings = { ...CELLPOSE_JOB_SETTINGS, max_edge_px: -1 };
    expect(() => validateJobSpec(impossible)).toThrow(/supported range|at least/i);
  });

  it("requires completed job events to report complete progress", () => {
    expect(validateJobEvent(event())).toEqual(event());
    expect(() => validateJobEvent(event({ state: "completed", progress: 0.99 }))).toThrow(/progress 1/i);
  });

  it("accepts verified atomic results and rejects non-atomic verified publication", () => {
    expect(validateResultManifest(resultManifest())).toEqual(resultManifest());

    const unsafePublication = resultManifest();
    unsafePublication.publication.atomic = false;
    expect(() => validateResultManifest(unsafePublication)).toThrow(/atomically/i);
  });
});
