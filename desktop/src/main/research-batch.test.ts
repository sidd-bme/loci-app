// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { ResearchJob, ResearchSource } from "../shared/research-contracts";
import {
  createResearchBatchKey,
  originalResearchBatchTask,
  researchBatchIdForJob,
  researchBatchRetryCandidates,
  validateResearchBatchTasks,
} from "./research-batch";

const batchId = "a".repeat(32);
const source: ResearchSource = {
  id: "b".repeat(32),
  name: "Bound image",
  sha256: "c".repeat(64),
  metadata: {},
};
const request = {
  source_id: source.id,
  selection: { x: 0, y: 0, width: 16, height: 16, t: 0, c: 0, z: 0, level: 0 },
  recipe: { steps: [], segmentation: null },
};

function job(overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    id: "d".repeat(32),
    operation: "run_recipe",
    request,
    request_key: createResearchBatchKey(batchId, "initial", 0),
    request_hash: "e".repeat(64),
    state: "queued",
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:00Z",
    progress: 0,
    cancel_requested: false,
    result_ids: [],
    error: null,
    ...overrides,
  };
}

describe("research durable batch contracts", () => {
  it("freezes exact source-bound recipe tasks and rejects changed source identities", () => {
    const tasks = validateResearchBatchTasks([{
      operation: "run_recipe",
      source: { id: source.id, sha256: source.sha256 },
      request,
    }], [source]);
    request.selection.width = 8;

    expect(tasks[0].request).toMatchObject({ selection: { width: 16 } });
    expect(() => validateResearchBatchTasks([{
      ...tasks[0], source: { ...tasks[0].source, sha256: "f".repeat(64) },
    }], [source])).toThrow("no longer matches");
  });

  it("uses parseable batch keys without renderer or filesystem metadata", () => {
    const key = createResearchBatchKey(batchId, "initial", 7);
    expect(key).toBe(`loci-batch:${batchId}:initial:00007`);
    expect(researchBatchIdForJob(job({ request_key: key }))).toBe(batchId);
    expect(() => createResearchBatchKey(batchId, "initial", 10_000)).toThrow("position");
  });

  it("resumes interrupted requests but leaves failed and cancelled requests for retry", () => {
    const interrupted = job({ state: "interrupted" });
    const failed = job({ id: "1".repeat(32), request_hash: "1".repeat(64), state: "failed" });
    const cancelled = job({ id: "2".repeat(32), request_hash: "2".repeat(64), state: "cancelled" });

    expect(researchBatchRetryCandidates([interrupted, failed, cancelled], batchId, "resume"))
      .toEqual([interrupted]);
    expect(researchBatchRetryCandidates([interrupted, failed, cancelled], batchId, "retry"))
      .toEqual([failed, cancelled]);
  });

  it("does not duplicate a request with a queued, running, or completed sibling", () => {
    const failed = job({ state: "failed" });
    for (const state of ["queued", "running", "succeeded"] as const) {
      const sibling = job({ id: state.padEnd(32, "0"), state });
      expect(researchBatchRetryCandidates([failed, sibling], batchId, "retry")).toEqual([]);
    }
  });

  it("reconstructs the exact original Cellpose task instead of its normalized wrapper", () => {
    const cellposeRequest = {
      source_id: source.id,
      selection: request.selection,
      profile_id: "cellpose-sam-v2",
      settings: { device: "mps" },
      measurement_channels: [0],
      working_bytes: 512 * 1024 ** 2,
    };
    const restored = originalResearchBatchTask(job({
      operation: "cellpose_run",
      request: { source_id: source.id, task_request: cellposeRequest },
    }), [source]);

    expect(restored).toEqual({
      operation: "cellpose_run",
      source: { id: source.id, sha256: source.sha256 },
      request: cellposeRequest,
    });
  });
});
