// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  JOB_SPEC_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  type ProjectJobRecord,
  type ProjectModelResultReference,
} from "../shared/foundation-contracts";
import {
  activeProjectModelResults,
  latestActiveProjectResultIds,
  replaceActiveProjectResultBinding,
  retireActiveProjectResultBindings,
} from "./active-project-results";
import {
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
} from "./working-result-publication";

const SOURCE_SHA256 = "a".repeat(64);

function segmentJob(
  jobId: string,
  resultId: string,
  sourceId: string,
  createdAt: string,
): ProjectJobRecord {
  return {
    spec: {
      schemaVersion: JOB_SPEC_SCHEMA,
      jobId,
      kind: "segment",
      createdAt,
      executionTarget: { kind: "local" },
      inputs: [{ sourceId, fingerprintSha256: SOURCE_SHA256, byteLength: null }],
      operation: {
        profileId: "loci-classical",
        modelId: "loci-classical",
        modelSha256: null,
        settings: null,
      },
      resources: { cpuCores: null, memoryMiB: null, gpuCount: 0, walltimeMinutes: null },
      expectedOutputs: [{
        artifactId: WORKING_RESULT_ARTIFACT_ID,
        mediaType: WORKING_RESULT_MEDIA_TYPE,
      }],
    },
    events: [],
    result: {
      schemaVersion: RESULT_MANIFEST_SCHEMA,
      resultManifestId: `manifest-${resultId}`,
      resultId,
      jobId,
      createdAt,
      sourceFingerprints: [{ sourceId, sha256: SOURCE_SHA256 }],
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
  };
}

function modelResult(
  sourceId: string,
  resultId: string,
  createdAt: string,
): ProjectModelResultReference {
  return {
    sourceId,
    resultId,
    modelId: "loci-classical",
    modelSha256: null,
    evidenceStatus: "experimental",
    createdAt,
    resultManifestId: `manifest-${resultId}`,
  };
}

describe("active project result bindings", () => {
  it("opens legacy history with only the latest result active per source", () => {
    const active = latestActiveProjectResultIds([
      modelResult("source-1", "result-old", "2026-09-01T00:00:01.000Z"),
      modelResult("source-1", "result-new", "2026-09-01T00:00:02.000Z"),
      modelResult("source-2", "result-other", "2026-09-01T00:00:01.000Z"),
    ]);

    expect(Object.fromEntries(active)).toEqual({
      "source-1": "result-new",
      "source-2": "result-other",
    });
  });

  it("keeps completed jobs as history while a cleared project reopens with no active result", () => {
    const jobs = [segmentJob("job-old", "result-old", "source-1", "2026-09-01T00:00:01.000Z")];
    const active = new Map<string, string>([["source-1", "result-old"]]);

    active.delete("source-1");
    const savedModelResults = activeProjectModelResults(jobs, active, () => "experimental");

    expect(jobs).toHaveLength(1);
    expect(savedModelResults).toEqual([]);
    expect(latestActiveProjectResultIds(savedModelResults).has("source-1")).toBe(false);
  });

  it("restores exact bindings when project persistence fails", async () => {
    const active = new Map<string, string>([
      ["source-1", "result-1"],
      ["source-2", "result-2"],
    ]);
    const failure = new Error("disk full");

    await expect(retireActiveProjectResultBindings(active, [
      { sourceId: "source-1", resultId: "result-1" },
      { sourceId: "source-2", resultId: "result-2" },
    ], async () => {
      expect(active.size).toBe(0);
      throw failure;
    })).rejects.toBe(failure);

    expect(Object.fromEntries(active)).toEqual({
      "source-1": "result-1",
      "source-2": "result-2",
    });
  });

  it("retires old bindings durably and lets a later segmentation become active", async () => {
    const jobs = [
      segmentJob("job-old", "result-old", "source-1", "2026-09-01T00:00:01.000Z"),
      segmentJob("job-new", "result-new", "source-1", "2026-09-01T00:00:03.000Z"),
    ];
    const active = new Map<string, string>([["source-1", "result-old"]]);
    const persist = vi.fn(async () => activeProjectModelResults(jobs, active, () => "experimental"));

    const cleared = await retireActiveProjectResultBindings(
      active,
      [{ sourceId: "source-1", resultId: "result-old" }],
      persist,
    );
    expect(cleared).toEqual([]);
    expect(active.has("source-1")).toBe(false);

    active.set("source-1", "result-new");
    const saved = activeProjectModelResults(jobs, active, () => "experimental");
    expect(saved).toEqual([expect.objectContaining({
      sourceId: "source-1",
      resultId: "result-new",
      resultManifestId: "manifest-result-new",
    })]);
    expect(latestActiveProjectResultIds(saved).get("source-1")).toBe("result-new");
  });

  it("binds a verified rerun before fully disposing the superseded session result", async () => {
    const active = new Map<string, string>([["source-1", "result-old"]]);
    const order: string[] = [];

    const superseded = await replaceActiveProjectResultBinding(
      active,
      "source-1",
      "result-new",
      async (resultId) => {
        expect(active.get("source-1")).toBe("result-new");
        order.push(`dispose:${resultId}`);
      },
    );

    expect(superseded).toBe("result-old");
    expect(active.get("source-1")).toBe("result-new");
    expect(order).toEqual(["dispose:result-old"]);
  });

  it("does not dispose when the verified binding is unchanged", async () => {
    const active = new Map<string, string>([["source-1", "result-1"]]);
    const dispose = vi.fn(async () => undefined);

    await expect(replaceActiveProjectResultBinding(
      active,
      "source-1",
      "result-1",
      dispose,
    )).resolves.toBe("result-1");

    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not roll the binding back after a superseded-cache cleanup failure", async () => {
    const active = new Map<string, string>([["source-1", "result-old"]]);
    const cleanupFailure = new Error("cache worker unavailable");

    await expect(replaceActiveProjectResultBinding(
      active,
      "source-1",
      "result-new",
      async () => {
        throw cleanupFailure;
      },
    )).rejects.toBe(cleanupFailure);

    expect(active.get("source-1")).toBe("result-new");
  });
});
