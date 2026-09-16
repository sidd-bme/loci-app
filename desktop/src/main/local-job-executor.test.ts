// @vitest-environment node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  JOB_SPEC_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  type JobSpec,
  type ResultManifest,
} from "../shared/foundation-contracts";
import { JobStore } from "./job-store";
import { LocalJobCancelledError, LocalJobExecutor } from "./local-job-executor";

const SOURCE_SHA = "a".repeat(64);
const MODEL_SHA = "b".repeat(64);
const SETTINGS = {
  image_mode: "auto" as const,
  polarity: "auto" as const,
  expected_diameter_px: 34,
  min_area_px: 80,
  sensitivity: 0,
  smoothing_px: 1.2,
  split_touching: true,
  exclude_border: false,
};

let root = "";
let store: JobStore;
let tick = 0;

function clock(): Date {
  const value = new Date(Date.UTC(2026, 8, 1, 0, 0, tick));
  tick += 1;
  return value;
}

function spec(jobId: string): JobSpec {
  return {
    schemaVersion: JOB_SPEC_SCHEMA,
    jobId,
    kind: "segment",
    createdAt: clock().toISOString(),
    executionTarget: { kind: "local" },
    inputs: [{ sourceId: `source:${jobId}`, fingerprintSha256: SOURCE_SHA, byteLength: 4_200 }],
    operation: {
      profileId: "loci-classical",
      modelId: "loci-classical",
      modelSha256: null,
      settings: SETTINGS,
    },
    resources: { cpuCores: null, memoryMiB: null, gpuCount: 0, walltimeMinutes: null },
    expectedOutputs: [],
  };
}

function result(job: JobSpec): ResultManifest {
  return {
    schemaVersion: RESULT_MANIFEST_SCHEMA,
    resultManifestId: `manifest:${job.jobId}`,
    resultId: `result:${job.jobId}`,
    jobId: job.jobId,
    createdAt: clock().toISOString(),
    sourceFingerprints: [{ sourceId: job.inputs[0].sourceId, sha256: SOURCE_SHA }],
    producer: {
      appVersion: "0.1.0",
      engineVersion: "0.1.0",
      modelId: "loci-classical",
      modelSha256: null,
      settingsSha256: createHash("sha256")
        .update(JSON.stringify(Object.fromEntries(Object.entries(SETTINGS).sort())))
        .digest("hex"),
    },
    artifacts: [],
    publication: { state: "verified", atomic: true, reason: null },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-local-executor-"));
  tick = 0;
  store = new JobStore(path.join(root, "jobs.json"), { now: clock });
  await store.open();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("LocalJobExecutor", () => {
  it("serializes work and persists truthful lifecycle events", async () => {
    const notify = vi.fn();
    const executor = new LocalJobExecutor(store, {
      now: clock,
      mutationId: (() => { let id = 0; return () => `mutation:${id++}`; })(),
      notify,
      progressIntervalMs: 0,
      progressStep: 0,
    });
    const order: string[] = [];
    const firstSpec = spec("first");
    const secondSpec = spec("second");
    const first = await executor.submit({
      spec: firstSpec,
      run: async ({ reportProgress }) => {
        order.push("first:start");
        await reportProgress({ progress: 0.4, message: "Running inference" });
        order.push("first:end");
        return { value: 11, resultManifest: result(firstSpec) };
      },
    });
    const second = await executor.submit({
      spec: secondSpec,
      run: async () => {
        order.push("second:start");
        return { value: 22, resultManifest: result(secondSpec) };
      },
    });

    await expect(first.completion).resolves.toBe(11);
    await expect(second.completion).resolves.toBe(22);
    await executor.drain();
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(store.get("first")?.events.map(({ state }) => state)).toEqual([
      "staging", "queued", "running", "running", "verifying", "completed",
    ]);
    expect(store.get("second")?.events.at(-1)?.state).toBe("completed");
    expect(notify).toHaveBeenCalled();
  });

  it("cancels queued work without invoking it", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const executor = new LocalJobExecutor(store, {
      now: clock,
      mutationId: (() => { let id = 0; return () => `cancel-q:${id++}`; })(),
    });
    const runningSpec = spec("running");
    const queuedSpec = spec("queued");
    const running = await executor.submit({
      spec: runningSpec,
      run: async () => {
        await blocked;
        return { value: true, resultManifest: result(runningSpec) };
      },
    });
    const queuedRun = vi.fn();
    const queued = await executor.submit({
      spec: queuedSpec,
      run: queuedRun,
    });

    await expect(executor.cancel("queued")).resolves.toBe(true);
    await expect(queued.completion).rejects.toBeInstanceOf(LocalJobCancelledError);
    expect(queuedRun).not.toHaveBeenCalled();
    expect(store.get("queued")?.events.at(-1)?.state).toBe("cancelled");
    release();
    await running.completion;
  });

  it("records running cancellation before interrupting the process boundary", async () => {
    let rejectWork!: (error: unknown) => void;
    const work = new Promise<never>((_resolve, reject) => { rejectWork = reject; });
    const interrupt = vi.fn(() => {
      rejectWork(new Error("worker terminated"));
      return true;
    });
    const executor = new LocalJobExecutor(store, {
      now: clock,
      mutationId: (() => { let id = 0; return () => `cancel-r:${id++}`; })(),
    });
    const activeSpec = spec("active");
    const handle = await executor.submit({ spec: activeSpec, run: () => work, interrupt });
    await vi.waitFor(() => expect(store.get("active")?.events.at(-1)?.state).toBe("running"));
    await expect(executor.cancel("active")).resolves.toBe(true);
    await expect(handle.completion).rejects.toThrow("worker terminated");
    expect(interrupt).toHaveBeenCalledOnce();
    expect(store.get("active")?.cancellation).toBeDefined();
    expect(store.get("active")?.events.at(-1)?.state).toBe("cancelled");
  });

  it("serializes terminal cancellation after an in-flight cancellation receipt", async () => {
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>((resolve) => { releaseProgress = resolve; });
    let allowCancellationPersistence!: () => void;
    const cancellationPersistenceGate = new Promise<void>((resolve) => {
      allowCancellationPersistence = resolve;
    });
    let cancellationEntered!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => { cancellationEntered = resolve; });
    const originalRequestCancellation = store.requestCancellation.bind(store);
    vi.spyOn(store, "requestCancellation").mockImplementation(async (...args) => {
      cancellationEntered();
      await cancellationPersistenceGate;
      return originalRequestCancellation(...args);
    });
    const executor = new LocalJobExecutor(store, {
      now: clock,
      mutationId: (() => { let id = 0; return () => `cancel-persist:${id++}`; })(),
    });
    const activeSpec = spec("cancel-persist");
    const handle = await executor.submit({
      spec: activeSpec,
      run: async ({ reportProgress }) => {
        await progressGate;
        await reportProgress({ progress: 0.4, message: "Processing." });
        return { value: true, resultManifest: result(activeSpec) };
      },
    });
    await vi.waitFor(() => expect(store.get(activeSpec.jobId)?.events.at(-1)?.state).toBe("running"));

    const cancellation = executor.cancel(activeSpec.jobId);
    await cancellationStarted;
    releaseProgress();
    await Promise.resolve();
    allowCancellationPersistence();

    await expect(cancellation).resolves.toBe(true);
    await expect(handle.completion).rejects.toBeInstanceOf(LocalJobCancelledError);
    const record = store.get(activeSpec.jobId);
    expect(record?.cancellation).toBeDefined();
    expect(record?.events.at(-1)?.state).toBe("cancelled");
    expect(record?.events.at(-2)?.reasonCode).toBe("user-cancellation-requested");
  });

  it("does not enter work when cancellation lands after running publication but before invocation", async () => {
    let acknowledgeRunning!: () => void;
    const runningPublished = new Promise<void>((resolve) => { acknowledgeRunning = resolve; });
    let releaseRunningAppend!: () => void;
    const holdRunningAppend = new Promise<void>((resolve) => { releaseRunningAppend = resolve; });
    const originalApplyEvent = store.applyEvent.bind(store);
    vi.spyOn(store, "applyEvent").mockImplementation(async (event, mutationId, resultManifest) => {
      const record = await originalApplyEvent(event, mutationId, resultManifest);
      if (event.state === "running" && event.progress === 0.02) {
        acknowledgeRunning();
        await holdRunningAppend;
      }
      return record;
    });

    const executor = new LocalJobExecutor(store, {
      now: clock,
      mutationId: (() => { let id = 0; return () => `cancel-before-run:${id++}`; })(),
    });
    const activeSpec = spec("cancel-before-run");
    const run = vi.fn(async () => ({ value: true, resultManifest: result(activeSpec) }));
    const interrupt = vi.fn(() => false);
    const handle = await executor.submit({ spec: activeSpec, run, interrupt });

    await runningPublished;
    await expect(executor.cancel(activeSpec.jobId)).resolves.toBe(true);
    releaseRunningAppend();

    await expect(handle.completion).rejects.toBeInstanceOf(LocalJobCancelledError);
    expect(run).not.toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(store.get(activeSpec.jobId)?.events.at(-1)?.state).toBe("cancelled");
    await executor.drain();
  });

  it("linearizes an accepted cancellation while verifying before completed result publication", async () => {
    let acknowledgeVerifying!: () => void;
    const verifyingPublished = new Promise<void>((resolve) => { acknowledgeVerifying = resolve; });
    let releaseVerifying!: () => void;
    const holdVerifying = new Promise<void>((resolve) => { releaseVerifying = resolve; });
    const originalApplyEvent = store.applyEvent.bind(store);
    vi.spyOn(store, "applyEvent").mockImplementation(async (event, mutationId, resultManifest) => {
      const record = await originalApplyEvent(event, mutationId, resultManifest);
      if (event.state === "verifying") {
        acknowledgeVerifying();
        await holdVerifying;
      }
      return record;
    });

    const executor = new LocalJobExecutor(store, {
      now: clock,
      mutationId: (() => { let id = 0; return () => `cancel-verifying:${id++}`; })(),
    });
    const activeSpec = spec("cancel-verifying");
    const interrupt = vi.fn(() => false);
    const handle = await executor.submit({
      spec: activeSpec,
      run: async () => ({ value: "must-not-bind", resultManifest: result(activeSpec) }),
      interrupt,
    });

    await verifyingPublished;
    await expect(executor.cancel(activeSpec.jobId)).resolves.toBe(true);
    releaseVerifying();

    await expect(handle.completion).rejects.toBeInstanceOf(LocalJobCancelledError);
    await executor.drain();
    const record = store.get(activeSpec.jobId);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(record?.events.at(-1)?.state).toBe("cancelled");
    expect(record?.events.some(({ state }) => state === "completed")).toBe(false);
    expect(record?.result).toBeNull();
  });

  it("rejects invalid or regressive executor progress and records failure", async () => {
    const executor = new LocalJobExecutor(store, {
      now: clock,
      mutationId: (() => { let id = 0; return () => `progress:${id++}`; })(),
      progressIntervalMs: 0,
      progressStep: 0,
    });
    const job = spec("bad-progress");
    const handle = await executor.submit({
      spec: job,
      run: async ({ reportProgress }) => {
        await reportProgress({ progress: 0.6, message: "First" });
        await reportProgress({ progress: 0.5, message: "Backwards" });
        return { value: true, resultManifest: result(job) };
      },
    });
    await expect(handle.completion).rejects.toThrow(/regressive progress/i);
    expect(store.get("bad-progress")?.events.at(-1)?.state).toBe("failed");
  });
});
