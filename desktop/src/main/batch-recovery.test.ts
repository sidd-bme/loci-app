// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { AnalysisSettings } from "../shared/contracts";
import {
  JOB_SPEC_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  type JobSpec,
  type ResultManifest,
} from "../shared/foundation-contracts";
import {
  DURABLE_BATCH_PROJECT_REQUIRED_MESSAGE,
  assertBatchChildMatchesParent,
  assertDurableBatchProjectSources,
  frozenBatchCheckpointBindings,
  isBatchLedgerComplete,
  protectCompletedBatchResults,
  releaseCompletedBatchProtection,
} from "./batch-recovery";
import { sha256CanonicalJson } from "./job-store";
import {
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
} from "./working-result-publication";

const SOURCE_ONE_SHA256 = "1".repeat(64);
const SOURCE_TWO_SHA256 = "2".repeat(64);
const MODEL_SHA256 = "3".repeat(64);
const ARTIFACT_SHA256 = "4".repeat(64);
const settings: AnalysisSettings = {
  image_mode: "auto",
  polarity: "auto",
  expected_diameter_px: 34,
  min_area_px: 80,
  sensitivity: 0,
  smoothing_px: 1.2,
  split_touching: true,
  exclude_border: false,
};

function parentSpec(): JobSpec {
  return {
    schemaVersion: JOB_SPEC_SCHEMA,
    jobId: "batch-1",
    kind: "segment",
    createdAt: "2026-09-01T00:00:00.000Z",
    executionTarget: { kind: "local" },
    inputs: [
      { sourceId: "source-1", fingerprintSha256: SOURCE_ONE_SHA256, byteLength: null },
      { sourceId: "source-2", fingerprintSha256: SOURCE_TWO_SHA256, byteLength: null },
    ],
    operation: {
      profileId: "profile-a",
      modelId: "model-a",
      modelSha256: MODEL_SHA256,
      settings,
    },
    resources: { cpuCores: null, memoryMiB: null, gpuCount: 0, walltimeMinutes: null },
    expectedOutputs: [],
  };
}

function childSpec(overrides: Partial<JobSpec["operation"]> = {}): JobSpec {
  const parent = parentSpec();
  return {
    ...parent,
    jobId: "child-1",
    createdAt: "2026-09-01T00:00:01.000Z",
    inputs: [parent.inputs[0]],
    operation: { ...parent.operation, ...overrides },
    expectedOutputs: [{
      artifactId: WORKING_RESULT_ARTIFACT_ID,
      mediaType: WORKING_RESULT_MEDIA_TYPE,
    }],
  };
}

function childResult(child: JobSpec): ResultManifest {
  return {
    schemaVersion: RESULT_MANIFEST_SCHEMA,
    resultManifestId: "manifest-1",
    resultId: "result-1",
    jobId: child.jobId,
    createdAt: "2026-09-01T00:00:02.000Z",
    sourceFingerprints: [{ sourceId: "source-1", sha256: SOURCE_ONE_SHA256 }],
    producer: {
      appVersion: "0.1.0",
      engineVersion: "0.1.0",
      modelId: child.operation.modelId,
      modelSha256: child.operation.modelSha256,
      settingsSha256: sha256CanonicalJson(child.operation.settings),
    },
    artifacts: [{
      artifactId: WORKING_RESULT_ARTIFACT_ID,
      filename: "working-result-1-r0.loci-result",
      mediaType: WORKING_RESULT_MEDIA_TYPE,
      byteLength: 4_096,
      sha256: ARTIFACT_SHA256,
    }],
    publication: { state: "verified", atomic: true, reason: null },
  };
}

describe("durable batch recovery gates", () => {
  it("rejects a batch before job creation when there is no durable project source set", () => {
    expect(() => assertDurableBatchProjectSources(null, ["source-1", "source-2"]))
      .toThrow(DURABLE_BATCH_PROJECT_REQUIRED_MESSAGE);
  });

  it("rejects requested sources that have not yet been saved into the project", () => {
    expect(() => assertDurableBatchProjectSources(
      ["source-1", "source-2"],
      ["source-1", "source-3"],
    )).toThrow(DURABLE_BATCH_PROJECT_REQUIRED_MESSAGE);
  });

  it("accepts only requested sources with stable project identities", () => {
    expect(() => assertDurableBatchProjectSources(
      ["source-1", "source-2", "source-3"],
      ["source-1", "source-3"],
    )).not.toThrow();
  });

  it("finalizes only a wholly completed ledger", () => {
    expect(isBatchLedgerComplete({
      total: 2,
      pending: 0,
      running: 0,
      completed: 2,
      failed: 0,
      cancelled: 0,
    })).toBe(true);
    expect(isBatchLedgerComplete({
      total: 2,
      pending: 0,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 1,
    })).toBe(false);
    expect(isBatchLedgerComplete({
      total: 2,
      pending: 0,
      running: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
    })).toBe(false);
    expect(isBatchLedgerComplete({
      total: 2,
      pending: 1,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
    })).toBe(false);
  });

  it("keeps exact completed results session-owned until a verified checkpoint succeeds", () => {
    const protectedResultIds = new Set<string>();
    const items = [
      { state: "completed", resultId: "result-1" },
      { state: "completed", resultId: "result-2" },
      { state: "failed", resultId: null },
    ];

    protectCompletedBatchResults(protectedResultIds, items);
    protectCompletedBatchResults(protectedResultIds, items);
    expect([...protectedResultIds].sort()).toEqual(["result-1", "result-2"]);

    // Quit/project-switch cleanup consults this exact set and therefore cannot
    // unreference either pack after a failed checkpoint.
    expect(protectedResultIds.has("result-1")).toBe(true);
    expect(protectedResultIds.has("result-2")).toBe(true);

    releaseCompletedBatchProtection(protectedResultIds, items);
    releaseCompletedBatchProtection(protectedResultIds, items);
    expect(protectedResultIds).toEqual(new Set());
  });

  it("checkpoints the frozen batch results after restart restored the prior saved bindings", () => {
    const saved = new Map([
      ["source-1", "result-before-batch"],
      ["source-unrelated", "result-unrelated"],
    ]);
    const current = new Map(saved);
    const next = frozenBatchCheckpointBindings(current, saved, new Map([
      ["result-before-batch", "2026-09-01T00:00:01.000Z"],
      ["result-unrelated", "2026-09-01T00:00:01.000Z"],
    ]), [
      {
        sourceId: "source-1",
        state: "completed",
        resultId: "result-batch-1",
        resultManifestId: "manifest-batch-1",
        createdAt: "2026-09-01T00:00:02.000Z",
      },
      {
        sourceId: "source-2",
        state: "completed",
        resultId: "result-batch-2",
        resultManifestId: "manifest-batch-2",
        createdAt: "2026-09-01T00:00:03.000Z",
      },
    ]);

    expect([...next]).toEqual([
      ["source-1", "result-batch-1"],
      ["source-unrelated", "result-unrelated"],
      ["source-2", "result-batch-2"],
    ]);
    expect([...current]).toEqual([...saved]);
  });

  it("rejects batch finalization after a newer rerun replaced a frozen output", () => {
    const saved = new Map([["source-1", "result-before-batch"]]);
    const current = new Map([["source-1", "result-newer-rerun"]]);
    const items = [{
      sourceId: "source-1",
      state: "completed",
      resultId: "result-frozen-batch",
      resultManifestId: "manifest-frozen-batch",
      createdAt: "2026-09-01T00:00:02.000Z",
    }];

    expect(() => frozenBatchCheckpointBindings(current, saved, new Map([
      ["result-before-batch", "2026-09-01T00:00:01.000Z"],
    ]), items)).toThrow(
      /newer unsaved result/i,
    );
    expect([...current]).toEqual([["source-1", "result-newer-rerun"]]);
  });

  it("does not overwrite a newer result that was already saved after the batch", () => {
    const saved = new Map([["source-1", "result-newer-saved"]]);
    const current = new Map(saved);
    const items = [{
      sourceId: "source-1",
      state: "completed",
      resultId: "result-frozen-batch",
      resultManifestId: "manifest-frozen-batch",
      createdAt: "2026-09-01T00:00:02.000Z",
    }];

    expect(() => frozenBatchCheckpointBindings(current, saved, new Map([
      ["result-newer-saved", "2026-09-01T00:00:03.000Z"],
    ]), items)).toThrow(/saved project already contains a result as new/i);
  });

  it("accepts a child result only when its complete provenance matches the frozen batch", () => {
    const parent = parentSpec();
    const child = childSpec();
    expect(() => assertBatchChildMatchesParent(parent, child, childResult(child), "source-1"))
      .not.toThrow();
  });

  it("rejects a stale same-source result produced by another profile or model", () => {
    const parent = parentSpec();
    const stale = childSpec({ profileId: "profile-b", modelId: "model-b", modelSha256: null });
    expect(() => assertBatchChildMatchesParent(parent, stale, childResult(stale), "source-1"))
      .toThrow(/frozen batch provenance/i);
  });

  it("rejects a stale same-source result produced with different settings", () => {
    const parent = parentSpec();
    const stale = childSpec({ settings: { ...settings, sensitivity: 1 } });
    expect(() => assertBatchChildMatchesParent(parent, stale, childResult(stale), "source-1"))
      .toThrow(/frozen batch provenance/i);
  });
});
