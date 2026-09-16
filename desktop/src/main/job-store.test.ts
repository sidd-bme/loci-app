// @vitest-environment node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  JOB_EVENT_SCHEMA,
  JOB_SPEC_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  type JobEvent,
  type JobSpec,
  type JobState,
  type ResultManifest,
} from "../shared/foundation-contracts";
import { JobTransitionError } from "../shared/job-transitions";
import {
  JobEventConflictError,
  JobResultError,
  JobStore,
  JobStoreCorruptError,
} from "./job-store";

let root: string;
let destination: string;
let clockIndex: number;

const SOURCE_DIGEST = "a".repeat(64);
const MODEL_DIGEST = "b".repeat(64);
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
const ARTIFACT_DIGEST = "d".repeat(64);

function jobSpec(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    schemaVersion: JOB_SPEC_SCHEMA,
    jobId: "job:one",
    kind: "segment",
    createdAt: "2026-08-31T00:00:00.000Z",
    executionTarget: { kind: "local" },
    inputs: [{ sourceId: "source:one", fingerprintSha256: SOURCE_DIGEST, byteLength: 42_000 }],
    operation: {
      profileId: "profile:cell",
      modelId: "model:cpsam",
      modelSha256: MODEL_DIGEST,
      settings: { ...CELLPOSE_JOB_SETTINGS },
    },
    resources: { cpuCores: 4, memoryMiB: 4096, gpuCount: 0, walltimeMinutes: 30 },
    expectedOutputs: [{ artifactId: "artifact:labels", mediaType: "image/tiff" }],
    ...overrides,
  };
}

function jobEvent(
  sequence: number,
  state: JobState,
  progress: number | null,
  overrides: Partial<JobEvent> = {},
): JobEvent {
  return {
    schemaVersion: JOB_EVENT_SCHEMA,
    jobId: "job:one",
    sequence,
    occurredAt: `2026-08-31T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    state,
    progress,
    message: state,
    reasonCode: null,
    schedulerState: null,
    ...overrides,
  };
}

function resultManifest(overrides: Partial<ResultManifest> = {}): ResultManifest {
  return {
    schemaVersion: RESULT_MANIFEST_SCHEMA,
    resultManifestId: "result-manifest:one",
    resultId: "result:one",
    jobId: "job:one",
    createdAt: "2026-08-31T00:00:05.000Z",
    sourceFingerprints: [{ sourceId: "source:one", sha256: SOURCE_DIGEST }],
    producer: {
      appVersion: "0.1.0",
      engineVersion: "0.1.0",
      modelId: "model:cpsam",
      modelSha256: MODEL_DIGEST,
      settingsSha256: SETTINGS_DIGEST,
    },
    artifacts: [{
      artifactId: "artifact:labels",
      filename: "labels.tiff",
      mediaType: "image/tiff",
      byteLength: 1_024,
      sha256: ARTIFACT_DIGEST,
    }],
    publication: { state: "verified", atomic: true, reason: null },
    ...overrides,
  };
}

const clock = () => {
  const value = new Date(Date.UTC(2026, 7, 31, 0, 1, clockIndex));
  clockIndex += 1;
  return value;
};

async function openedStore() {
  const store = new JobStore(destination, { now: clock });
  await store.open();
  return store;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-job-store-"));
  destination = path.join(root, "jobs", "jobs-v1.json");
  clockIndex = 0;
});

afterEach(async () => {
  await fs.rm(root, { force: true, recursive: true });
});

describe("JobStore", () => {
  it("atomically persists shared versioned contracts and restores them", async () => {
    const store = await openedStore();
    const created = await store.createJob(jobSpec(), "mutation:create", {
      title: "Segment three images",
    });
    expect(created.events.at(-1)?.state).toBe("staging");
    expect(created.spec.schemaVersion).toBe(JOB_SPEC_SCHEMA);

    const raw = JSON.parse(await fs.readFile(destination, "utf8"));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.jobs).toHaveLength(1);
    expect(raw.jobs[0].events[0].schemaVersion).toBe(JOB_EVENT_SCHEMA);
    expect((await fs.readdir(path.dirname(destination))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);

    const restored = new JobStore(destination, { now: clock });
    const result = await restored.open();
    expect(result.reconciledJobIds).toEqual(["job:one"]);
    expect(restored.get("job:one")?.events.at(-1)?.state).toBe("needs-attention");
  });

  it("uses the shared strict transition history and requires a verified completion result", async () => {
    const store = await openedStore();
    await store.createJob(jobSpec(), "mutation:create");
    await store.applyEvent(jobEvent(1, "queued", 0), "mutation:queue");
    await expect(store.applyEvent(
      jobEvent(2, "completed", 1),
      "mutation:bad-complete",
      resultManifest(),
    )).rejects.toBeInstanceOf(JobTransitionError);
    await store.applyEvent(jobEvent(2, "running", 0.1), "mutation:run");
    await store.applyEvent(jobEvent(3, "running", 0.7), "mutation:progress");
    await expect(store.applyEvent(
      jobEvent(4, "running", 0.6),
      "mutation:backwards",
    )).rejects.toMatchObject({ code: "progress-regression" });
    await store.applyEvent(jobEvent(4, "verifying", 0.9), "mutation:verify");
    await expect(store.applyEvent(
      jobEvent(5, "completed", 1),
      "mutation:no-result",
    )).rejects.toBeInstanceOf(JobResultError);
    const completed = await store.applyEvent(
      jobEvent(5, "completed", 1),
      "mutation:complete",
      resultManifest(),
    );
    expect(completed.result?.publication).toEqual({ state: "verified", atomic: true, reason: null });
    expect(store.getRendererSummary("job:one")?.finishedAt).toBe("2026-08-31T00:00:05.000Z");
    await expect(store.applyEvent(
      jobEvent(6, "completed", 1),
      "mutation:late",
      resultManifest(),
    )).rejects.toMatchObject({ code: "terminal-state" });
  });

  it("rejects incomplete, mismatched, and provisional result publication", async () => {
    const store = await openedStore();
    await store.createJob(jobSpec(), "mutation:create");
    await store.applyEvent(jobEvent(1, "running", 0.5), "mutation:run");

    await expect(store.applyEvent(
      jobEvent(2, "completed", 1),
      "mutation:provisional",
      resultManifest({
        createdAt: "2026-08-31T00:00:02.000Z",
        publication: { state: "provisional", atomic: false, reason: "hash pending" },
      }),
    )).rejects.toBeInstanceOf(JobResultError);
    await expect(store.applyEvent(
      jobEvent(2, "completed", 1),
      "mutation:missing-artifact",
      resultManifest({ createdAt: "2026-08-31T00:00:02.000Z", artifacts: [] }),
    )).rejects.toThrow(/expected artifact/i);
    await expect(store.applyEvent(
      jobEvent(2, "completed", 1),
      "mutation:wrong-source",
      resultManifest({
        createdAt: "2026-08-31T00:00:02.000Z",
        sourceFingerprints: [{ sourceId: "source:one", sha256: "e".repeat(64) }],
      }),
    )).rejects.toThrow(/fingerprint does not match/i);
    await expect(store.applyEvent(
      jobEvent(2, "completed", 1),
      "mutation:extra-source",
      resultManifest({
        createdAt: "2026-08-31T00:00:02.000Z",
        sourceFingerprints: [
          { sourceId: "source:one", sha256: SOURCE_DIGEST },
          { sourceId: "source:extra", sha256: SOURCE_DIGEST },
        ],
      }),
    )).rejects.toThrow(/exactly match/i);
  });

  it("treats an identical mutation as idempotent and rejects conflicting reuse", async () => {
    const store = await openedStore();
    await store.createJob(jobSpec(), "mutation:create");
    const event = jobEvent(1, "queued", 0);
    const first = await store.applyEvent(event, "mutation:queue");
    const duplicate = await store.applyEvent(cloneEvent(event), "mutation:queue");
    expect(duplicate).toEqual(first);
    expect(duplicate.events).toHaveLength(2);

    await expect(store.applyEvent(
      jobEvent(1, "failed", 0),
      "mutation:queue",
    )).rejects.toBeInstanceOf(JobEventConflictError);
    await expect(store.createJob(
      jobSpec({
        resources: { cpuCores: 8, memoryMiB: 4096, gpuCount: 0, walltimeMinutes: 30 },
      }),
      "mutation:create",
    )).rejects.toBeInstanceOf(JobEventConflictError);
  });

  it("persists cancellation intent without pretending the executor acknowledged it", async () => {
    const store = await openedStore();
    await store.createJob(jobSpec(), "mutation:create");
    await store.applyEvent(jobEvent(1, "queued", 0), "mutation:queue");
    const requested = await store.requestCancellation(
      "job:one",
      "mutation:cancel-request",
      "User changed the batch",
    );
    expect(requested.events.at(-1)?.state).toBe("queued");
    expect(requested.cancellation).toMatchObject({ reason: "User changed the batch" });
    expect(store.getRendererSummary("job:one")?.cancellationRequested).toBe(true);

    const acknowledged = await store.applyEvent(
      jobEvent(3, "cancelled", 0, { occurredAt: "2026-08-31T00:02:00.000Z" }),
      "mutation:cancelled",
    );
    expect(acknowledged.events.at(-1)?.state).toBe("cancelled");
  });

  it("refuses to publish or bind a completed result after cancellation is accepted", async () => {
    const store = await openedStore();
    await store.createJob(jobSpec(), "mutation:create");
    await store.applyEvent(jobEvent(1, "running", 0.5), "mutation:run");
    await store.applyEvent(jobEvent(2, "verifying", 0.95), "mutation:verify");
    await store.requestCancellation(
      "job:one",
      "mutation:cancel-request",
      "Cancelled during verification",
    );

    await expect(store.applyEvent(
      jobEvent(4, "completed", 1, { occurredAt: "2026-08-31T00:02:00.000Z" }),
      "mutation:late-complete",
      resultManifest(),
    )).rejects.toThrow(/accepted cancellation request cannot publish/i);
    expect(store.get("job:one")?.result).toBeNull();
    expect(store.get("job:one")?.events.at(-1)?.state).toBe("verifying");
  });

  it("reconciles active local and remote jobs conservatively after restart", async () => {
    const first = await openedStore();
    await first.createJob(jobSpec(), "mutation:create-local");
    await first.applyEvent(jobEvent(1, "running", 0.4), "mutation:run-local");
    await first.createJob(jobSpec({
      jobId: "job:remote",
      executionTarget: { kind: "remote", computeProfileId: "profile:vanda", scheduler: "pbs" },
    }), "mutation:create-remote", { title: "Remote segmentation", targetLabel: "Vanda" });
    await first.applyEvent(jobEvent(1, "queued", 0, { jobId: "job:remote" }), "mutation:queue-remote");
    await first.createJob(jobSpec({ jobId: "job:failed" }), "mutation:create-failed");
    await first.applyEvent(jobEvent(1, "failed", 0, { jobId: "job:failed" }), "mutation:failed");
    await first.createJob(jobSpec({
      jobId: "job:fingerprint",
      kind: "fingerprint",
      operation: { profileId: null, modelId: null, modelSha256: null, settings: null },
      expectedOutputs: [],
    }), "mutation:create-fingerprint");

    const restarted = new JobStore(destination, { now: clock });
    const result = await restarted.open();
    expect(result.reconciledJobIds.sort()).toEqual(["job:fingerprint", "job:one", "job:remote"]);
    expect(restarted.get("job:one")).toMatchObject({
      recovery: { interruptedState: "running" },
    });
    expect(restarted.get("job:one")?.events.at(-1)?.state).toBe("needs-attention");
    expect(restarted.get("job:remote")).toMatchObject({
      recovery: { interruptedState: "queued" },
    });
    expect(restarted.get("job:remote")?.events.at(-1)?.state).toBe("disconnected");
    expect(restarted.get("job:failed")?.events.at(-1)?.state).toBe("failed");
    expect(restarted.get("job:fingerprint")?.events.at(-1)?.state).toBe("failed");
    expect(restarted.get("job:fingerprint")?.recovery).toBeUndefined();

    const secondRestart = new JobStore(destination, { now: clock });
    expect((await secondRestart.open()).reconciledJobIds).toEqual([]);
  });

  it("exposes renderer summaries without source, model, or compute-profile identifiers", async () => {
    const store = await openedStore();
    await store.createJob(jobSpec({
      executionTarget: {
        kind: "remote",
        computeProfileId: "profile:secret-host",
        scheduler: "slurm",
      },
    }), "mutation:create", {
      title: "Remote\njob /Users/research/private image.tif",
      targetLabel: "Lab GPU",
    });
    await store.applyEvent(jobEvent(1, "queued", 0, {
      message: "Waiting for /private/remote/job/123",
    }), "mutation:queue");

    const summary = store.getRendererSummary("job:one");
    expect(summary?.title).toBe("Remote job <local path>");
    expect(summary?.publicMessage).toBe("Waiting for <local path>");
    expect(summary?.target).toEqual({ kind: "remote", scheduler: "slurm", label: "Lab GPU" });
    expect(JSON.stringify(summary)).not.toContain("secret-host");
    expect(JSON.stringify(summary)).not.toContain("source:one");
    expect(JSON.stringify(summary)).not.toContain("model:cpsam");
  });

  it("fails closed on corrupt persistence instead of resetting jobs", async () => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, JSON.stringify({ schemaVersion: 99, jobs: [] }), "utf8");
    await expect(new JobStore(destination).open()).rejects.toBeInstanceOf(JobStoreCorruptError);
    expect(await fs.readFile(destination, "utf8")).toContain('"schemaVersion":99');

    await fs.writeFile(destination, "{not-json", "utf8");
    await expect(new JobStore(destination).open()).rejects.toBeInstanceOf(JobStoreCorruptError);
    expect(await fs.readFile(destination, "utf8")).toBe("{not-json");
  });

  it("does not publish an in-memory record when the atomic rename cannot complete", async () => {
    const store = await openedStore();
    await fs.mkdir(destination, { recursive: true });

    await expect(store.createJob(jobSpec(), "mutation:create")).rejects.toThrow();
    expect(store.get("job:one")).toBeUndefined();
    expect((await fs.readdir(path.dirname(destination))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent mutations against the latest committed event", async () => {
    const store = await openedStore();
    await store.createJob(jobSpec(), "mutation:create");
    const [queued, cancellation] = await Promise.all([
      store.applyEvent(jobEvent(1, "queued", 0), "mutation:queue"),
      store.requestCancellation("job:one", "mutation:cancel-request"),
    ]);
    expect(queued.events.at(-1)?.state).toBe("queued");
    expect(cancellation.events.at(-1)?.state).toBe("queued");
    expect(store.get("job:one")?.events).toHaveLength(3);
  });

  it("bounds transient fingerprint history without deleting active or analytical jobs", async () => {
    const store = new JobStore(destination, { now: clock, maxRetainedFingerprintJobs: 2 });
    await store.open();
    await store.createJob(jobSpec({ jobId: "job:analysis" }), "mutation:create-analysis");

    for (let index = 0; index < 3; index += 1) {
      const jobId = `job:fingerprint:${index}`;
      const createdAt = `2026-08-31T00:00:${String(index * 2).padStart(2, "0")}.000Z`;
      await store.createJob(jobSpec({
        jobId,
        kind: "fingerprint",
        createdAt,
        operation: { profileId: null, modelId: null, modelSha256: null, settings: null },
        resources: { cpuCores: null, memoryMiB: null, gpuCount: 0, walltimeMinutes: null },
        expectedOutputs: [],
      }), `mutation:create-fingerprint-${index}`);
      await store.applyEvent(jobEvent(1, "failed", null, {
        jobId,
        occurredAt: `2026-08-31T00:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`,
      }), `mutation:fail-fingerprint-${index}`);
    }

    expect(store.get("job:analysis")).toBeDefined();
    expect(store.get("job:fingerprint:0")).toBeUndefined();
    expect(store.get("job:fingerprint:1")).toBeDefined();
    expect(store.get("job:fingerprint:2")).toBeDefined();
  });
});

function cloneEvent(event: JobEvent): JobEvent {
  return structuredClone(event);
}
