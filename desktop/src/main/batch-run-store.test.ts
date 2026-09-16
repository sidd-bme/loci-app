// @vitest-environment node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BATCH_RUN_ITEM_SCHEMA,
  BATCH_RUN_PLAN_SCHEMA,
  BatchRunStore,
  BatchRunStoreError,
  sanitizeBatchRunPublicText,
  validateBatchRunItem,
  validateBatchRunPlan,
  type BatchRunPlanInput,
} from "./batch-run-store";

const CREATED_AT = "2026-09-01T00:00:00.000Z";
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

let root = "";
let tick = 0;

function clock(): Date {
  tick += 1;
  return new Date(Date.parse(CREATED_AT) + tick * 1_000);
}

function plan(overrides: Partial<BatchRunPlanInput> = {}): BatchRunPlanInput {
  return {
    batchId: "batch:plate-01",
    projectId: "project:cell-study",
    createdAt: CREATED_AT,
    publicTitle: "Plate 01",
    sources: [
      {
        sourceId: "source:field-01",
        fingerprintSha256: FINGERPRINT_A,
        relativeLabel: "plate-a/field-01.tif",
      },
      {
        sourceId: "source:field-02",
        fingerprintSha256: FINGERPRINT_B,
        relativeLabel: "plate-a/field-02.tif",
      },
    ],
    ...overrides,
  };
}

function privateBatchDirectory(batchId = "batch:plate-01"): string {
  const digest = createHash("sha256").update(batchId).digest("hex");
  return path.join(root, `batch-${digest}`);
}

function privateItemPath(sourceId: string, batchId = "batch:plate-01"): string {
  const digest = createHash("sha256").update(sourceId).digest("hex");
  return path.join(privateBatchDirectory(batchId), "items", `source-${digest}.json`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-batch-runs-"));
  tick = 0;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("BatchRunStore private persistence", () => {
  it("creates an immutable sharded plan and private item records", async () => {
    const input = plan({ publicTitle: "  Plate\n  01  " });
    const store = new BatchRunStore(root, { now: clock });
    const created = await store.create(input);

    expect(created.plan).toEqual({
      schemaVersion: BATCH_RUN_PLAN_SCHEMA,
      batchId: "batch:plate-01",
      projectId: "project:cell-study",
      createdAt: CREATED_AT,
      publicTitle: "Plate 01",
      sources: [
        {
          sourceId: "source:field-01",
          fingerprintSha256: FINGERPRINT_A,
          relativeLabel: "plate-a/field-01.tif",
        },
        {
          sourceId: "source:field-02",
          fingerprintSha256: FINGERPRINT_B,
          relativeLabel: "plate-a/field-02.tif",
        },
      ],
    });
    expect(created.items.map(({ state }) => state)).toEqual(["pending", "pending"]);
    expect(created.items.every(({ schemaVersion }) => schemaVersion === BATCH_RUN_ITEM_SCHEMA)).toBe(true);
    expect(JSON.stringify(created)).not.toContain(root);

    // Caller-owned objects cannot mutate the plan held by the store or the frozen disk record.
    input.sources[0].relativeLabel = "mutated.tif";
    created.plan.sources[0].relativeLabel = "also-mutated.tif";
    const reopened = await new BatchRunStore(root, { now: clock }).open("batch:plate-01");
    expect(reopened.plan.sources[0].relativeLabel).toBe("plate-a/field-01.tif");

    const batchDirectory = privateBatchDirectory();
    const entries = await fs.readdir(batchDirectory);
    expect(entries.sort()).toEqual(["items", "plan.json"]);
    expect((await fs.readdir(path.join(batchDirectory, "items"))).length).toBe(2);
    if (process.platform !== "win32") {
      expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(batchDirectory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(batchDirectory, "items"))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(batchDirectory, "plan.json"))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(privateItemPath("source:field-01"))).mode & 0o777).toBe(0o600);
    }
  });

  it("guards duplicate creation across store instances", async () => {
    const first = new BatchRunStore(root, { now: clock });
    const second = new BatchRunStore(root, { now: clock });
    const outcomes = await Promise.allSettled([first.create(plan()), second.create(plan())]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "already-exists" }),
    });
  });

  it("rejects unsafe permissions and symbolic-link records", async () => {
    if (process.platform === "win32") return;
    const store = new BatchRunStore(root, { now: clock });
    await store.create(plan());
    const itemPath = privateItemPath("source:field-01");

    await fs.chmod(itemPath, 0o644);
    await expect(new BatchRunStore(root).open("batch:plate-01")).rejects.toMatchObject({
      code: "unsafe-filesystem",
    });

    await fs.chmod(itemPath, 0o600);
    const outside = path.join(root, "outside.json");
    await fs.writeFile(outside, "{}", { mode: 0o600 });
    await fs.rm(itemPath);
    await fs.symlink(outside, itemPath);
    await expect(new BatchRunStore(root).open("batch:plate-01")).rejects.toBeInstanceOf(
      BatchRunStoreError,
    );
  });

  it("rejects a symbolic-link root before changing its target permissions", async () => {
    if (process.platform === "win32") return;
    const target = `${root}-target`;
    await fs.mkdir(target, { mode: 0o755 });
    await fs.chmod(target, 0o755);
    await fs.rm(root, { recursive: true, force: true });
    await fs.symlink(target, root);
    try {
      await expect(new BatchRunStore(root, { now: clock }).create(plan())).rejects.toMatchObject({
        code: "unsafe-filesystem",
      });
      expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it("removes abandoned atomic item temporaries before validating a run", async () => {
    await new BatchRunStore(root, { now: clock }).create(plan());
    const temporary = path.join(privateBatchDirectory(), "items", ".tmp-deadbeef");
    await fs.writeFile(temporary, "incomplete", { mode: 0o600 });

    await expect(new BatchRunStore(root, { now: clock }).open("batch:plate-01")).resolves.toMatchObject({
      recoveredSourceIds: [],
    });
    await expect(fs.lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("BatchRunStore lifecycle", () => {
  it("guards and idempotently completes a single attempt", async () => {
    const store = new BatchRunStore(root, { now: clock });
    await store.create(plan());

    const [firstBegin, secondBegin] = await Promise.all([
      store.beginAttempt("batch:plate-01", "source:field-01"),
      store.beginAttempt("batch:plate-01", "source:field-01"),
    ]);
    expect(firstBegin).toEqual(secondBegin);
    expect(firstBegin).toMatchObject({ state: "running", attemptCount: 1 });

    const result = { resultId: "_result:field-01", resultManifestId: "-manifest:field-01" };
    const completed = await store.completeAttempt("batch:plate-01", "source:field-01", result);
    await expect(store.completeAttempt("batch:plate-01", "source:field-01", result)).resolves.toEqual(completed);
    await expect(store.completeAttempt("batch:plate-01", "source:field-01", {
      resultId: "result:other",
      resultManifestId: "manifest:other",
    })).rejects.toMatchObject({ code: "invalid-transition" });
    await expect(store.beginAttempt("batch:plate-01", "source:field-01")).rejects.toMatchObject({
      code: "invalid-transition",
    });

    expect(await store.summary("batch:plate-01")).toMatchObject({
      total: 2,
      pending: 1,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
      retryable: 0,
    });
    await store.drain();
  });

  it("sanitizes failures, preserves attempt history, and retries only failed sources", async () => {
    const store = new BatchRunStore(root, { now: clock });
    await store.create(plan());
    await store.beginAttempt("batch:plate-01", "source:field-01");
    const failed = await store.failAttempt("batch:plate-01", "source:field-01", {
      code: "decoder-failed",
      summary: "Decoder failed at /Volumes/private/study/field-01.tif\nTrace details",
    });

    expect(failed).toMatchObject({
      state: "failed",
      failureCode: "decoder-failed",
      attemptCount: 1,
    });
    expect(failed.failureSummary).not.toContain("/Volumes/private");
    expect(failed.failureSummary).not.toContain("\n");
    expect(JSON.stringify(failed)).not.toContain(root);

    const retried = await store.retryFailed("batch:plate-01");
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ state: "pending", attemptCount: 1 });
    await expect(store.retryFailed("batch:plate-01", ["source:field-01"])).resolves.toEqual(retried);

    const secondAttempt = await store.beginAttempt("batch:plate-01", "source:field-01");
    expect(secondAttempt.attempts.map(({ state }) => state)).toEqual(["failed", "running"]);
    await store.completeAttempt("batch:plate-01", "source:field-01", {
      resultId: "result:retry",
      resultManifestId: "manifest:retry",
    });
    expect((await store.get("batch:plate-01", "source:field-01")).attempts.map(({ state }) => state))
      .toEqual(["failed", "completed"]);
  });

  it("cancels pending selections and active attempts without changing unrelated items", async () => {
    const store = new BatchRunStore(root, { now: clock });
    await store.create(plan());
    const cancelledPending = await store.cancelPending("batch:plate-01", ["source:field-02"]);
    expect(cancelledPending).toHaveLength(1);
    expect(cancelledPending[0]).toMatchObject({
      state: "cancelled",
      attemptCount: 0,
      failureCode: "user-cancelled",
    });
    await expect(store.cancelPending("batch:plate-01", ["source:field-02"])).resolves.toEqual(
      cancelledPending,
    );

    await store.beginAttempt("batch:plate-01", "source:field-01");
    const cancelledRunning = await store.cancelAttempt(
      "batch:plate-01",
      "source:field-01",
      "Cancelled while reading C:\\private\\field-01.tif",
    );
    expect(cancelledRunning).toMatchObject({
      state: "cancelled",
      attemptCount: 1,
      failureCode: "user-cancelled",
    });
    expect(cancelledRunning.failureSummary).not.toContain("C:\\private");
    expect((await store.summary("batch:plate-01")).cancelled).toBe(2);
  });

  it("honestly fails in-flight work when a new store recovers the run", async () => {
    const original = new BatchRunStore(root, { now: clock });
    await original.create(plan());
    await original.beginAttempt("batch:plate-01", "source:field-01");

    const recoveredStore = new BatchRunStore(root, { now: clock });
    const recovered = await recoveredStore.open("batch:plate-01");
    expect(recovered.recoveredSourceIds).toEqual(["source:field-01"]);
    expect(recovered.items[0]).toMatchObject({
      state: "failed",
      failureCode: "application-restarted",
      resultId: null,
      resultManifestId: null,
    });
    expect(recovered.items[0].failureSummary).not.toContain(root);

    await recoveredStore.retryFailed("batch:plate-01", ["source:field-01"]);
    const resumed = await recoveredStore.beginAttempt("batch:plate-01", "source:field-01");
    expect(resumed.attempts.map(({ state }) => state)).toEqual(["failed", "running"]);
  });

  it("requires an explicit open and keeps source membership private and guarded", async () => {
    await new BatchRunStore(root, { now: clock }).create(plan());
    const unopened = new BatchRunStore(root, { now: clock });
    await expect(unopened.get("batch:plate-01", "source:field-01")).rejects.toMatchObject({
      code: "not-open",
    });
    await unopened.open("batch:plate-01");
    await expect(unopened.get("batch:plate-01", "source:not-in-plan")).rejects.toMatchObject({
      code: "not-found",
    });
  });
});

describe("BatchRunStore schema validation", () => {
  it("rejects empty, duplicate, colliding, and non-portable plans", async () => {
    const store = new BatchRunStore(root, { now: clock });
    await expect(store.create(plan({ sources: [] }))).rejects.toMatchObject({ code: "invalid-record" });
    await expect(store.create(plan({
      batchId: "batch:duplicate-id",
      sources: [plan().sources[0], { ...plan().sources[1], sourceId: "source:field-01" }],
    }))).rejects.toMatchObject({ code: "invalid-record" });
    await expect(store.create(plan({
      batchId: "batch:duplicate-label",
      sources: [
        plan().sources[0],
        { ...plan().sources[1], relativeLabel: "PLATE-A/FIELD-01.TIF" },
      ],
    }))).rejects.toMatchObject({ code: "invalid-record" });
    await expect(store.create(plan({
      batchId: "batch:traversal",
      sources: [{ ...plan().sources[0], relativeLabel: "../field-01.tif" }],
    }))).rejects.toMatchObject({ code: "invalid-record" });
    await expect(store.create(plan({
      batchId: "batch:device-name",
      sources: [{ ...plan().sources[0], relativeLabel: "plate/CON.tif" }],
    }))).rejects.toMatchObject({ code: "invalid-record" });
  });

  it("rejects unsupported record fields and tampered plans", async () => {
    expect(() => validateBatchRunPlan({
      schemaVersion: BATCH_RUN_PLAN_SCHEMA,
      batchId: "batch:test",
      projectId: "project:test",
      createdAt: CREATED_AT,
      publicTitle: null,
      sources: [{
        sourceId: "source:test",
        fingerprintSha256: FINGERPRINT_A,
        relativeLabel: "field.tif",
      }],
      unexpected: true,
    })).toThrow(BatchRunStoreError);
    expect(() => validateBatchRunItem({
      schemaVersion: BATCH_RUN_ITEM_SCHEMA,
      batchId: "batch:test",
      sourceId: "source:test",
      state: "pending",
      attemptCount: 0,
      attempts: [],
      resultId: null,
      resultManifestId: null,
      failureCode: null,
      failureSummary: null,
      updatedAt: CREATED_AT,
      unexpected: true,
    })).toThrow(BatchRunStoreError);

    await new BatchRunStore(root, { now: clock }).create(plan());
    const planPath = path.join(privateBatchDirectory(), "plan.json");
    const stored = JSON.parse(await fs.readFile(planPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(planPath, `${JSON.stringify({ ...stored, unexpected: true })}\n`, { mode: 0o600 });
    await fs.chmod(planPath, 0o600);
    await expect(new BatchRunStore(root).open("batch:plate-01")).rejects.toMatchObject({
      code: "invalid-record",
    });
  });

  it("sanitizes public text without returning local absolute paths", () => {
    expect(sanitizeBatchRunPublicText("  Decoder\nfailed at /Volumes/secret/a.tif  "))
      .toBe("Decoder failed at <local path>");
    expect(sanitizeBatchRunPublicText("Open C:\\Users\\researcher\\image.tif"))
      .toBe("Open <local path>");
    expect(sanitizeBatchRunPublicText("Normal public summary")).toBe("Normal public summary");
    expect(sanitizeBatchRunPublicText("\n\t")).toBeNull();
  });

  it("rejects a relative or non-normalized private root", () => {
    expect(() => new BatchRunStore("relative/batches")).toThrow(BatchRunStoreError);
    expect(() => new BatchRunStore(`${root}${path.sep}nested${path.sep}..`)).toThrow(BatchRunStoreError);
  });
});
