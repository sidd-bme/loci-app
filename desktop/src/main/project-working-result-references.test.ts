// @vitest-environment node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JOB_SPEC_SCHEMA,
  PROJECT_MANIFEST_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  type ProjectJobRecord,
  type ProjectManifestV1,
  type ProjectModelResultReference,
  type ResultArtifact,
} from "../shared/foundation-contracts";
import { projectWorkingResultReferences } from "./project-working-result-references";
import { sha256CanonicalJson } from "./job-store";
import {
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
} from "./working-result-publication";
import { openWorkingResultRetentionStore } from "./working-result-retention";

const SOURCE_SHA256 = "a".repeat(64);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-active-result-retention-"));
  temporaryRoots.push(root);
  return root;
}

function sha256(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

function artifact(resultId: string, payload: Buffer): ResultArtifact {
  return {
    artifactId: WORKING_RESULT_ARTIFACT_ID,
    filename: `working-${resultId}-r0.loci-result`,
    mediaType: WORKING_RESULT_MEDIA_TYPE,
    byteLength: payload.byteLength,
    sha256: sha256(payload),
  };
}

function segmentJob(
  jobId: string,
  resultId: string,
  resultManifestId: string,
  createdAt: string,
  workingArtifact: ResultArtifact,
): ProjectJobRecord {
  return {
    spec: {
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
        settingsSha256: sha256CanonicalJson(null),
      },
      artifacts: [workingArtifact],
      publication: { state: "verified", atomic: true, reason: null },
    },
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

function manifest(
  jobs: ProjectJobRecord[],
  modelResults: ProjectModelResultReference[],
): ProjectManifestV1 {
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA,
    projectId: "project-1",
    title: "Active result retention",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:10.000Z",
    appVersion: "0.1.0",
    sources: [],
    displayRecipes: [],
    annotations: [],
    corrections: [],
    modelResults,
    reviews: [],
    jobs,
    migrations: [],
  };
}

async function writePack(
  root: string,
  jobId: string,
  workingArtifact: ResultArtifact,
  payload: Buffer,
): Promise<string> {
  const directory = path.join(root, jobId);
  await fs.mkdir(directory, { recursive: true });
  const packPath = path.join(directory, workingArtifact.filename);
  await fs.writeFile(packPath, payload, { flag: "wx" });
  return packPath;
}

describe("active project working-result retention", () => {
  it("releases a retired pack and retains only the fresh rerun without accumulating history", async () => {
    const root = await temporaryRoot();
    const store = await openWorkingResultRetentionStore(root, { gracePeriodMs: 0 });
    const oldPayload = Buffer.from("old working result");
    const newPayload = Buffer.from("new working result");
    const oldArtifact = artifact("result-old", oldPayload);
    const newArtifact = artifact("result-new", newPayload);
    const oldJob = segmentJob(
      "job-old",
      "result-old",
      "manifest-old",
      "2026-09-01T00:00:01.000Z",
      oldArtifact,
    );
    const newJob = segmentJob(
      "job-new",
      "result-new",
      "manifest-new",
      "2026-09-01T00:00:02.000Z",
      newArtifact,
    );
    const oldPack = await writePack(root, "job-old", oldArtifact, oldPayload);
    const newPack = await writePack(root, "job-new", newArtifact, newPayload);

    const oldActive = manifest(
      [oldJob],
      [modelResult("result-old", "manifest-old", "2026-09-01T00:00:01.000Z")],
    );
    await store.reconcileProject(
      oldActive.projectId,
      projectWorkingResultReferences(oldActive, root),
    );

    const retired = manifest([oldJob], []);
    await store.reconcileProject(
      retired.projectId,
      projectWorkingResultReferences(retired, root),
    );

    const rerunActive = manifest(
      [oldJob, newJob],
      [modelResult("result-new", "manifest-new", "2026-09-01T00:00:02.000Z")],
    );
    const rerunReferences = projectWorkingResultReferences(rerunActive, root);
    expect(rerunReferences).toEqual([
      expect.objectContaining({ resultId: "result-new", jobId: "job-new", packPath: newPack }),
    ]);
    await store.reconcileProject(rerunActive.projectId, rerunReferences);

    expect(await store.diagnostics()).toMatchObject({
      totalPackCount: 2,
      referencedPackCount: 1,
      unreferencedPackCount: 1,
      missingReferencedPackCount: 0,
    });
    await store.collectGarbage({ gracePeriodMs: 0 });
    await expect(fs.stat(oldPack)).rejects.toThrow();
    await expect(fs.stat(newPack)).resolves.toBeDefined();
  });

  it("does not let a missing inactive historical pack block reconciliation", async () => {
    const root = await temporaryRoot();
    const store = await openWorkingResultRetentionStore(root);
    const missingPayload = Buffer.from("missing retired working result");
    const activePayload = Buffer.from("available active working result");
    const missingArtifact = artifact("result-retired", missingPayload);
    const activeArtifact = artifact("result-active", activePayload);
    const retiredJob = segmentJob(
      "job-retired",
      "result-retired",
      "manifest-retired",
      "2026-09-01T00:00:01.000Z",
      missingArtifact,
    );
    const activeJob = segmentJob(
      "job-active",
      "result-active",
      "manifest-active",
      "2026-09-01T00:00:02.000Z",
      activeArtifact,
    );
    const retiredPack = await writePack(root, "job-retired", missingArtifact, missingPayload);
    const retiredProject = manifest(
      [retiredJob],
      [modelResult("result-retired", "manifest-retired", "2026-09-01T00:00:01.000Z")],
    );
    await store.reconcileProject(
      retiredProject.projectId,
      projectWorkingResultReferences(retiredProject, root),
    );
    await fs.rm(retiredPack);

    await writePack(root, "job-active", activeArtifact, activePayload);
    const project = manifest(
      [retiredJob, activeJob],
      [modelResult("result-active", "manifest-active", "2026-09-01T00:00:02.000Z")],
    );

    const references = projectWorkingResultReferences(project, root);
    expect(references.map(({ jobId }) => jobId)).toEqual(["job-active"]);
    await expect(store.reconcileProject(project.projectId, references)).resolves.toMatchObject({
      references: [expect.objectContaining({ resultId: "result-active" })],
    });
    expect(await store.diagnostics()).toMatchObject({
      referencedPackCount: 1,
      missingReferencedPackCount: 0,
      gcBlocked: false,
    });
  });

  it("keeps a restored active pack session-owned when project ownership is later replaced", async () => {
    const root = await temporaryRoot();
    const store = await openWorkingResultRetentionStore(root, { gracePeriodMs: 0 });
    const payload = Buffer.from("restored active working result");
    const workingArtifact = artifact("result-restored", payload);
    const job = segmentJob(
      "job-restored",
      "result-restored",
      "manifest-restored",
      "2026-09-01T00:00:02.000Z",
      workingArtifact,
    );
    const project = manifest(
      [job],
      [modelResult("result-restored", "manifest-restored", "2026-09-01T00:00:02.000Z")],
    );
    const packPath = await writePack(root, "job-restored", workingArtifact, payload);
    const [restoredReference] = projectWorkingResultReferences(project, root);

    await store.reconcileProject(project.projectId, [restoredReference]);
    await store.reference({
      projectId: "session-restored",
      ...restoredReference,
    });
    await store.reconcileProject(project.projectId, []);

    expect(await store.diagnostics()).toMatchObject({
      referencedPackCount: 1,
      unreferencedPackCount: 0,
      missingReferencedPackCount: 0,
    });
    await store.collectGarbage({ gracePeriodMs: 0 });
    await expect(fs.stat(packPath)).resolves.toBeDefined();

    await store.unreference({
      projectId: "session-restored",
      resultId: restoredReference.resultId,
      revision: restoredReference.revision,
    });
    await store.collectGarbage({ gracePeriodMs: 0 });
    await expect(fs.stat(packPath)).rejects.toThrow();
  });

  it("rejects an active identity that matches more than one durable job", () => {
    const payload = Buffer.from("ambiguous working result");
    const workingArtifact = artifact("result-active", payload);
    const first = segmentJob(
      "job-first",
      "result-active",
      "manifest-active",
      "2026-09-01T00:00:02.000Z",
      workingArtifact,
    );
    const duplicate = {
      ...first,
      spec: { ...first.spec, jobId: "job-duplicate" },
    };
    const project = manifest(
      [first, duplicate],
      [modelResult("result-active", "manifest-active", "2026-09-01T00:00:02.000Z")],
    );

    expect(() => projectWorkingResultReferences(project, path.resolve("private/loci/working-results")))
      .toThrow(/does not bind to one exact durable result manifest/i);
  });
});
