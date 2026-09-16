// @vitest-environment node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
} from "./working-result-publication";
import {
  WORKING_RESULT_RETENTION_LEDGER,
  openWorkingResultRetentionStore,
  workingResultBatchRecoveryOwnerId,
  type WorkingResultArtifactIdentity,
} from "./working-result-retention";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-result-retention-"));
  temporaryRoots.push(root);
  return root;
}

function sha256(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

interface CreatedPack {
  jobId: string;
  resultId: string;
  revision: number;
  packPath: string;
  artifact: WorkingResultArtifactIdentity;
  payload: Buffer;
}

async function createPack(
  root: string,
  {
    jobId = "job_01",
    resultId = "result_01",
    revision = 0,
    payload = Buffer.from(`pack:${jobId}:${resultId}:${revision}`),
    mtimeMs,
  }: {
    jobId?: string;
    resultId?: string;
    revision?: number;
    payload?: Buffer;
    mtimeMs?: number;
  } = {},
): Promise<CreatedPack> {
  const directory = path.join(root, jobId);
  await fs.mkdir(directory, { recursive: true });
  const filename = `working-${resultId}-r${revision}.loci-result`;
  const packPath = path.join(directory, filename);
  await fs.writeFile(packPath, payload, { flag: "wx" });
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1_000;
    await fs.utimes(packPath, seconds, seconds);
  }
  return {
    jobId,
    resultId,
    revision,
    packPath,
    artifact: {
      artifactId: WORKING_RESULT_ARTIFACT_ID,
      filename,
      mediaType: WORKING_RESULT_MEDIA_TYPE,
      byteLength: payload.byteLength,
      sha256: sha256(payload),
    },
    payload,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("working-result retention", () => {
  it("persists a private, path-free, immutable project/result/revision reference", async () => {
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const store = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      quotaBytes: 1_000_000,
    });
    const pack = await createPack(root, { resultId: "_result_01" });

    const reference = await store.reference({
      projectId: "project_01",
      resultId: pack.resultId,
      revision: pack.revision,
      jobId: pack.jobId,
      artifact: pack.artifact,
      packPath: pack.packPath,
    });

    expect(reference).toMatchObject({
      projectId: "project_01",
      resultId: "_result_01",
      revision: 0,
      state: "referenced",
      unreferencedAt: null,
      artifact: pack.artifact,
    });
    const ledgerPath = path.join(root, WORKING_RESULT_RETENTION_LEDGER);
    const ledgerText = await fs.readFile(ledgerPath, "utf8");
    const ledger = JSON.parse(ledgerText) as { entries: Record<string, unknown> };
    expect(Object.keys(ledger.entries)).toHaveLength(1);
    expect(ledgerText).not.toContain(root);
    expect(ledgerText).not.toContain(pack.packPath);
    expect(ledgerText).not.toContain("sourcePath");
    if (process.platform !== "win32") {
      expect((await fs.stat(root)).mode & 0o077).toBe(0);
      expect((await fs.stat(ledgerPath)).mode & 0o077).toBe(0);
    }
    const diagnostics = await store.diagnostics();
    expect(diagnostics).toMatchObject({
      totalPackCount: 1,
      referencedPackCount: 1,
      unreferencedPackCount: 0,
      totalBytes: pack.payload.byteLength,
      referencedBytes: pack.payload.byteLength,
      gcBlocked: false,
    });
  });

  it("rejects escaped packs, symlinked packs, conflicting keys, and unknown fields", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = await openWorkingResultRetentionStore(root);
    const pack = await createPack(root);
    const outsidePath = path.join(outside, pack.artifact.filename);
    await fs.writeFile(outsidePath, pack.payload);
    const base = {
      projectId: "project_01",
      resultId: pack.resultId,
      revision: pack.revision,
      jobId: pack.jobId,
      artifact: pack.artifact,
    };

    await expect(store.reference({ ...base, packPath: outsidePath })).rejects.toThrow(
      /escaped its private job storage/i,
    );
    await expect(store.reference({
      ...base,
      packPath: pack.packPath,
      sourcePath: "/private/source.tif",
    } as never)).rejects.toThrow(/reference request is invalid/i);

    await fs.rm(pack.packPath);
    await fs.symlink(outsidePath, pack.packPath, "file");
    await expect(store.reference({ ...base, packPath: pack.packPath })).rejects.toThrow(
      /not a bounded regular file/i,
    );
    await fs.rm(pack.packPath);
    await fs.writeFile(pack.packPath, pack.payload);
    await store.reference({ ...base, packPath: pack.packPath });
    await expect(store.reference({
      ...base,
      artifact: { ...pack.artifact, sha256: "1".repeat(64) },
      packPath: pack.packPath,
    })).rejects.toThrow(/does not match its artifact identity|already references another artifact/i);
  });

  it("keeps an unreferenced pack for the full grace period, then deletes its tombstone and file", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const store = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      gracePeriodMs: 5_000,
    });
    const pack = await createPack(root, { mtimeMs: nowMs + 100 });
    nowMs += 200;
    await store.reference({
      projectId: "project_01",
      resultId: pack.resultId,
      revision: 0,
      jobId: pack.jobId,
      artifact: pack.artifact,
      packPath: pack.packPath,
    });
    nowMs += 100;
    await expect(store.unreference({
      projectId: "project_01",
      resultId: pack.resultId,
      revision: 0,
    })).resolves.toBe(true);

    nowMs += 4_999;
    const early = await store.collectGarbage();
    expect(early.deleted).toEqual([]);
    expect(early.graceRetainedCount).toBe(1);
    await expect(fs.stat(pack.packPath)).resolves.toBeDefined();

    nowMs += 2;
    const collected = await store.collectGarbage();
    expect(collected.deleted).toEqual([{
      jobId: pack.jobId,
      artifact: pack.artifact,
    }]);
    expect(collected.deletedBytes).toBe(pack.payload.byteLength);
    expect(JSON.stringify(collected)).not.toContain(root);
    await expect(fs.stat(pack.packPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(collected.diagnostics.totalPackCount).toBe(0);
    const ledger = JSON.parse(
      await fs.readFile(path.join(root, WORKING_RESULT_RETENTION_LEDGER), "utf8"),
    ) as { entries: Record<string, unknown> };
    expect(ledger.entries).toEqual({});
  });

  it("does not delete a pack while any project still references the same identity", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const store = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      gracePeriodMs: 1_000,
    });
    const pack = await createPack(root, { mtimeMs: nowMs + 10 });
    const common = {
      resultId: pack.resultId,
      revision: pack.revision,
      jobId: pack.jobId,
      artifact: pack.artifact,
      packPath: pack.packPath,
    };
    nowMs += 20;
    await store.reference({ projectId: "project_a", ...common });
    await store.reference({ projectId: "project_b", ...common });
    await store.unreference({ projectId: "project_a", resultId: pack.resultId, revision: 0 });
    nowMs += 2_000;

    expect((await store.collectGarbage()).deleted).toEqual([]);
    await expect(fs.stat(pack.packPath)).resolves.toBeDefined();
    await store.unreference({ projectId: "project_b", resultId: pack.resultId, revision: 0 });
    nowMs += 1_001;
    expect((await store.collectGarbage()).deleted).toHaveLength(1);
    await expect(fs.stat(pack.packPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims stale process leases while preserving durable project and batch recovery owners", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const firstProcess = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      gracePeriodMs: 0,
    });
    const projectPack = await createPack(root, {
      jobId: "job_project",
      resultId: "result_project",
      mtimeMs: nowMs + 1,
    });
    const batchPack = await createPack(root, {
      jobId: "job_batch",
      resultId: "result_batch",
      mtimeMs: nowMs + 2,
    });
    const orphanPack = await createPack(root, {
      jobId: "job_orphan",
      resultId: "result_orphan",
      mtimeMs: nowMs + 3,
    });
    const retiredBatchPack = await createPack(root, {
      jobId: "job_retired_batch",
      resultId: "result_retired_batch",
      mtimeMs: nowMs + 4,
    });
    const priorSession = "session-11111111-1111-4111-8111-111111111111";
    const currentSession = "session-22222222-2222-4222-8222-222222222222";
    const common = (pack: CreatedPack) => ({
      resultId: pack.resultId,
      revision: pack.revision,
      jobId: pack.jobId,
      artifact: pack.artifact,
      packPath: pack.packPath,
    });
    nowMs += 10;
    await firstProcess.reference({ projectId: priorSession, ...common(projectPack) });
    await firstProcess.reference({ projectId: "project_durable", ...common(projectPack) });
    await firstProcess.reference({ projectId: priorSession, ...common(batchPack) });
    await firstProcess.reference({ projectId: priorSession, ...common(orphanPack) });
    await firstProcess.reference({
      projectId: workingResultBatchRecoveryOwnerId("retired-batch"),
      ...common(retiredBatchPack),
    });

    // A second store models a new single app instance after the first process
    // exited without releasing its session-owned references.
    nowMs += 10;
    const restarted = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      gracePeriodMs: 0,
    });
    const receipt = await restarted.recoverStaleSessionReferences(currentSession, [{
      projectId: workingResultBatchRecoveryOwnerId("recoverable-batch"),
      ...common(batchPack),
    }]);
    expect(receipt.adopted).toEqual([
      expect.objectContaining({
        projectId: workingResultBatchRecoveryOwnerId("recoverable-batch"),
        resultId: batchPack.resultId,
        state: "referenced",
      }),
    ]);
    expect(receipt.released.map(({ resultId }) => resultId).sort()).toEqual([
      orphanPack.resultId,
      batchPack.resultId,
      projectPack.resultId,
      retiredBatchPack.resultId,
    ].sort());

    const collected = await restarted.collectGarbage({ gracePeriodMs: 0 });
    expect(collected.deleted.map(({ artifact }) => artifact.filename).sort()).toEqual([
      orphanPack.artifact.filename,
      retiredBatchPack.artifact.filename,
    ].sort());
    await expect(fs.stat(projectPack.packPath)).resolves.toBeDefined();
    await expect(fs.stat(batchPack.packPath)).resolves.toBeDefined();
    await expect(fs.stat(orphanPack.packPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(retiredBatchPack.packPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await restarted.diagnostics()).toMatchObject({
      totalPackCount: 2,
      referencedPackCount: 2,
      unreferencedPackCount: 0,
      gcBlocked: false,
    });
  });

  it("fails startup lease recovery atomically when a required batch pack is invalid", async () => {
    const root = await temporaryRoot();
    const firstProcess = await openWorkingResultRetentionStore(root, { gracePeriodMs: 0 });
    const orphanPack = await createPack(root, {
      jobId: "job_stale",
      resultId: "result_stale",
    });
    const requiredPack = await createPack(root, {
      jobId: "job_required",
      resultId: "result_required",
    });
    await firstProcess.reference({
      projectId: "session-11111111-1111-4111-8111-111111111111",
      resultId: orphanPack.resultId,
      revision: orphanPack.revision,
      jobId: orphanPack.jobId,
      artifact: orphanPack.artifact,
      packPath: orphanPack.packPath,
    });
    await fs.writeFile(requiredPack.packPath, Buffer.from("corrupt required pack"));
    const ledgerPath = path.join(root, WORKING_RESULT_RETENTION_LEDGER);
    const before = await fs.readFile(ledgerPath, "utf8");
    const restarted = await openWorkingResultRetentionStore(root, { gracePeriodMs: 0 });

    await expect(restarted.recoverStaleSessionReferences(
      "session-22222222-2222-4222-8222-222222222222",
      [{
        projectId: workingResultBatchRecoveryOwnerId("recoverable-batch"),
        resultId: requiredPack.resultId,
        revision: requiredPack.revision,
        jobId: requiredPack.jobId,
        artifact: requiredPack.artifact,
        packPath: requiredPack.packPath,
      }],
    )).rejects.toThrow(/does not match its artifact identity/i);

    expect(await fs.readFile(ledgerPath, "utf8")).toBe(before);
    await expect(fs.stat(orphanPack.packPath)).resolves.toBeDefined();
  });

  it("reconciles one project's exact add/remove set in a single ledger publication", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const store = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      gracePeriodMs: 0,
    });
    const original = await createPack(root, {
      jobId: "job_revisions",
      resultId: "result_revisions",
      revision: 0,
      mtimeMs: nowMs + 1,
    });
    const corrected = await createPack(root, {
      jobId: "job_revisions",
      resultId: "result_revisions",
      revision: 1,
      mtimeMs: nowMs + 2,
    });
    const record = (pack: CreatedPack) => ({
      resultId: pack.resultId,
      revision: pack.revision,
      jobId: pack.jobId,
      artifact: pack.artifact,
      packPath: pack.packPath,
    });
    nowMs += 10;

    const added = await store.reconcileProject("project_01", [
      record(original),
      record(corrected),
    ]);
    expect(added.references).toHaveLength(2);
    expect(added.released).toEqual([]);
    expect((await store.diagnostics()).referencedPackCount).toBe(2);

    nowMs += 10;
    const replaced = await store.reconcileProject("project_01", [record(corrected)]);
    expect(replaced.references.map(({ revision }) => revision)).toEqual([1]);
    expect(replaced.released).toEqual([{
      projectId: "project_01",
      resultId: original.resultId,
      revision: 0,
    }]);
    const afterReconcile = await store.diagnostics();
    expect(afterReconcile.referencedPackCount).toBe(1);
    expect(afterReconcile.unreferencedPackCount).toBe(1);

    nowMs += 1;
    const collected = await store.collectGarbage();
    expect(collected.deleted.map(({ artifact }) => artifact.filename)).toEqual([
      original.artifact.filename,
    ]);
    await expect(fs.stat(original.packPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(corrected.packPath)).resolves.toBeDefined();
  });

  it("leaves a project's old set untouched when any proposed reconciliation pack fails", async () => {
    const root = await temporaryRoot();
    const store = await openWorkingResultRetentionStore(root);
    const retained = await createPack(root, {
      jobId: "job_retained",
      resultId: "result_retained",
    });
    const validNew = await createPack(root, {
      jobId: "job_new_valid",
      resultId: "result_new_valid",
    });
    const invalidNew = await createPack(root, {
      jobId: "job_new_invalid",
      resultId: "result_new_invalid",
    });
    const record = (pack: CreatedPack) => ({
      resultId: pack.resultId,
      revision: pack.revision,
      jobId: pack.jobId,
      artifact: pack.artifact,
      packPath: pack.packPath,
    });
    await store.reconcileProject("project_01", [record(retained)]);
    const ledgerPath = path.join(root, WORKING_RESULT_RETENTION_LEDGER);
    const before = await fs.readFile(ledgerPath, "utf8");
    await fs.writeFile(
      invalidNew.packPath,
      Buffer.from("x".repeat(invalidNew.payload.byteLength)),
    );

    await expect(store.reconcileProject("project_01", [
      record(validNew),
      record(invalidNew),
    ])).rejects.toThrow(/does not match its artifact identity/i);

    expect(await fs.readFile(ledgerPath, "utf8")).toBe(before);
    expect(await store.diagnostics()).toMatchObject({
      referencedPackCount: 1,
      unreferencedPackCount: 2,
    });
  });

  it("reconciles shared packs per project and releases only after the final owner", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const store = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      gracePeriodMs: 0,
    });
    const pack = await createPack(root, { mtimeMs: nowMs + 1 });
    const record = {
      resultId: pack.resultId,
      revision: pack.revision,
      jobId: pack.jobId,
      artifact: pack.artifact,
      packPath: pack.packPath,
    };
    nowMs += 10;
    await store.reconcileProject("project_a", [record]);
    await store.reconcileProject("project_b", [record]);
    await store.reconcileProject("project_a", []);
    nowMs += 1;

    expect((await store.collectGarbage()).deleted).toEqual([]);
    await expect(fs.stat(pack.packPath)).resolves.toBeDefined();
    await store.reconcileProject("project_b", []);
    nowMs += 1;
    expect((await store.collectGarbage()).deleted).toHaveLength(1);
    await expect(fs.stat(pack.packPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks all collection when a referenced pack is missing, preserving unrelated orphans", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const store = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      gracePeriodMs: 0,
    });
    const referenced = await createPack(root, {
      jobId: "job_ref",
      resultId: "result_ref",
      mtimeMs: nowMs + 10,
    });
    nowMs += 20;
    await store.reference({
      projectId: "project_01",
      resultId: referenced.resultId,
      revision: 0,
      jobId: referenced.jobId,
      artifact: referenced.artifact,
      packPath: referenced.packPath,
    });
    const orphan = await createPack(root, {
      jobId: "job_orphan",
      resultId: "result_orphan",
      mtimeMs: nowMs + 10,
    });
    await fs.rm(referenced.packPath);
    nowMs += 1_000;

    const collected = await store.collectGarbage();
    expect(collected.deleted).toEqual([]);
    expect(collected.blockedReasons).toHaveLength(1);
    expect(collected.diagnostics).toMatchObject({
      missingReferencedPackCount: 1,
      gcBlocked: true,
    });
    await expect(fs.stat(orphan.packPath)).resolves.toBeDefined();
  });

  it("protects legacy untracked packs, reports quota pressure, and collects later orphans", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const legacy = await createPack(root, {
      jobId: "job_legacy",
      resultId: "result_legacy",
      payload: Buffer.from("legacy pack payload"),
      mtimeMs: nowMs - 10_000,
    });
    const store = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      gracePeriodMs: 0,
      quotaBytes: 5,
    });
    const initial = await store.diagnostics();
    expect(initial.legacyProtectedPackCount).toBe(1);
    expect(initial.overQuotaBytes).toBe(legacy.payload.byteLength - 5);
    expect((await store.collectGarbage()).deleted).toEqual([]);

    const orphan = await createPack(root, {
      jobId: "job_new",
      resultId: "result_new",
      payload: Buffer.from("new orphan"),
      mtimeMs: nowMs + 100,
    });
    nowMs += 1_000;
    const collected = await store.collectGarbage();
    expect(collected.deleted).toHaveLength(1);
    expect(collected.deleted[0].artifact.sha256).toBe(sha256(orphan.payload));
    await expect(fs.stat(orphan.packPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(legacy.packPath)).resolves.toBeDefined();
  });

  it("fails closed on a malformed or symlinked ledger", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const store = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      gracePeriodMs: 0,
    });
    const orphan = await createPack(root, { mtimeMs: nowMs + 1 });
    nowMs += 100;
    const ledgerPath = path.join(root, WORKING_RESULT_RETENTION_LEDGER);
    await fs.writeFile(ledgerPath, "not-json\n");

    await expect(store.collectGarbage()).rejects.toThrow(/not valid JSON/i);
    await expect(fs.stat(orphan.packPath)).resolves.toBeDefined();

    const target = path.join(root, "ledger-target.json");
    await fs.writeFile(target, "{}\n");
    await fs.rm(ledgerPath);
    await fs.symlink(target, ledgerPath, "file");
    await expect(store.collectGarbage()).rejects.toThrow(/not a bounded regular file/i);
    await expect(fs.stat(orphan.packPath)).resolves.toBeDefined();
  });

  it("skips a released pack whose bytes no longer match the ledger identity", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const store = await openWorkingResultRetentionStore(root, {
      now: () => new Date(nowMs),
      gracePeriodMs: 0,
    });
    const pack = await createPack(root, { mtimeMs: nowMs + 1 });
    nowMs += 10;
    await store.reference({
      projectId: "project_01",
      resultId: pack.resultId,
      revision: 0,
      jobId: pack.jobId,
      artifact: pack.artifact,
      packPath: pack.packPath,
    });
    await store.unreference({
      projectId: "project_01",
      resultId: pack.resultId,
      revision: 0,
    });
    await fs.writeFile(pack.packPath, Buffer.from("x".repeat(pack.payload.byteLength)));
    nowMs += 100;

    const collected = await store.collectGarbage();
    expect(collected.deleted).toEqual([]);
    expect(collected.integritySkippedCount).toBe(1);
    await expect(fs.stat(pack.packPath)).resolves.toBeDefined();
  });

  it("serializes concurrent references and leaves no temporary ledger files", async () => {
    const root = await temporaryRoot();
    const store = await openWorkingResultRetentionStore(root);
    const first = await createPack(root, {
      jobId: "job_a",
      resultId: "result_a",
    });
    const second = await createPack(root, {
      jobId: "job_b",
      resultId: "result_b",
    });
    await Promise.all([first, second].map((pack, index) => store.reference({
      projectId: `project_${index}`,
      resultId: pack.resultId,
      revision: 0,
      jobId: pack.jobId,
      artifact: pack.artifact,
      packPath: pack.packPath,
    })));

    const ledger = JSON.parse(
      await fs.readFile(path.join(root, WORKING_RESULT_RETENTION_LEDGER), "utf8"),
    ) as { entries: Record<string, unknown> };
    expect(Object.keys(ledger.entries)).toHaveLength(2);
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects a symlink as the retention root without changing its target mode", async () => {
    const parent = await temporaryRoot();
    const target = await temporaryRoot();
    const linkedRoot = path.join(parent, "working-results");
    await fs.chmod(target, 0o755);
    await fs.symlink(target, linkedRoot, "dir");

    await expect(openWorkingResultRetentionStore(linkedRoot)).rejects.toThrow(
      /must be a private directory/i,
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(target)).mode & 0o077).toBe(0o055);
    }
  });
});
