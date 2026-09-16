// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  JOB_EVENT_SCHEMA,
  JOB_SPEC_SCHEMA,
  MAX_PROJECT_SOURCES,
  PROJECT_MANIFEST_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  SOURCE_DESCRIPTOR_SCHEMA,
  WORKSPACE_RECOMMENDATION_SCHEMA,
  type ProjectManifestV1,
} from "../shared/foundation-contracts";
import {
  MAX_PROJECT_FILE_BYTES,
  PROJECT_FILE_SCHEMA,
  PROJECT_SUMMARY_SCHEMA,
  ProjectStoreError,
  createProject,
  createProjectDocument,
  discardCreatedProject,
  installProjectPublicationGuard,
  migrateProjectDocument,
  openProject,
  reopenProject,
  sanitizedProjectSummary,
  saveProject,
  saveProjectAs,
  validateProjectDocument,
  type ProjectSourceLocatorV1,
} from "./project-store";
import { sha256CanonicalJson } from "./job-store";
import {
  QuitProjectSaveCoordinator,
  shouldQuitAfterProjectSave,
} from "./quit-project-save";

let root: string;

function manifest(overrides: Partial<ProjectManifestV1> = {}): ProjectManifestV1 {
  const fingerprint = {
    status: "pending" as const,
    algorithm: "sha256" as const,
    sha256: null,
    verifiedAt: null,
  };
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA,
    projectId: "project-1",
    title: "Cell study",
    createdAt: "2026-08-31T08:00:00.000Z",
    updatedAt: "2026-08-31T08:00:00.000Z",
    appVersion: "0.1.0",
    sources: [
      {
        sourceId: "source-1",
        displayName: "field-01.tif",
        relativeLabel: "plate-a/field-01.tif",
        fingerprint,
        inspectionStatus: "ready",
        inspectionFailure: null,
        descriptor: {
          schemaVersion: SOURCE_DESCRIPTOR_SCHEMA,
          displayName: "field-01.tif",
          relativeLabel: "plate-a/field-01.tif",
          format: "TIFF",
          formatAdapter: "tiff",
          dimensions: { width: 640, height: 480 },
          axes: [
            { name: "X", length: 640, unit: null, spacing: null },
            { name: "Y", length: 480, unit: null, spacing: null },
          ],
          channels: [
            {
              index: 0,
              name: "intensity",
              dtype: "uint8",
              colorSource: "not-applicable",
              rangeSource: "dtype",
            },
          ],
          colorModel: "intensity",
          calibration: null,
          pyramid: null,
          chunks: { storage: "striped", shape: null },
          access: {
            mode: "full",
            canRender: true,
            canAnalyze: true,
            canExportRenderedView: true,
            canExportNativeData: false,
            provisionalUntilFingerprintVerified: true,
            reason: null,
          },
          fingerprint,
          ambiguity: [
            {
              code: "biological-purpose-unknown",
              summary: "The biological purpose is not inferred from pixels.",
            },
          ],
        },
        workspace: {
          schemaVersion: WORKSPACE_RECOMMENDATION_SCHEMA,
          inferredWorkspace: "generic-2d",
          workspace: "generic-2d",
          decision: "safe-default",
          evidence: [
            {
              code: "ambiguous-single-plane",
              summary: "The source has no unambiguous structural marker for a specialist workspace.",
            },
          ],
          applicablePresets: ["generic-display", "brightfield-cell", "fluorescence", "h-and-e-display"],
          requiredCapabilities: [],
          userOverride: null,
          analysis: {
            autoRun: false,
            recommendedModelId: null,
            reason: "Loci does not infer a biological analysis task or start analysis from image structure alone.",
          },
        },
      },
    ],
    displayRecipes: [],
    annotations: [],
    corrections: [],
    modelResults: [],
    reviews: [],
    jobs: [],
    migrations: [],
    ...overrides,
  };
}

function manifestWithBoundCorrection(): ProjectManifestV1 {
  const value = manifest();
  const sourceSha256 = "a".repeat(64);
  const artifactSha256 = "b".repeat(64);
  const workingResultSha256 = "d".repeat(64);
  const classicalSettings = {
    image_mode: "auto" as const,
    polarity: "auto" as const,
    expected_diameter_px: 34,
    min_area_px: 80,
    sensitivity: 0,
    smoothing_px: 1.2,
    split_touching: true,
    exclude_border: false,
  };
  const settingsSha256 = sha256CanonicalJson(classicalSettings);
  const source = value.sources[0];
  if (source.inspectionStatus !== "ready") throw new Error("Expected ready fixture.");
  source.fingerprint = {
    status: "verified",
    algorithm: "sha256",
    sha256: sourceSha256,
    verifiedAt: "2026-08-31T08:00:01.000Z",
  };
  source.descriptor.fingerprint = structuredClone(source.fingerprint);
  source.descriptor.access.provisionalUntilFingerprintVerified = false;
  value.annotations = [{
    annotationId: "annotation-1",
    sourceId: "source-1",
    kind: "point",
    points: [{ x: 12, y: 24, z: null, t: null }],
    label: "Reviewed region",
    color: "#20b8aa",
    properties: { reviewerVisible: true },
  }];
  value.corrections = [{
    correctionId: "correction-bound",
    sourceId: "source-1",
    resultId: "result-1",
    revision: 1,
    operationIds: ["operation-1"],
    workingResultArtifact: {
      artifactId: "working-result",
      filename: "result-1-r1.loci-result",
      mediaType: "application/vnd.loci.working-result+zip",
      byteLength: 8192,
      sha256: workingResultSha256,
    },
  }];
  value.modelResults = [{
    resultId: "result-1",
    sourceId: "source-1",
    modelId: "loci-classical",
    modelSha256: null,
    evidenceStatus: "experimental",
    createdAt: "2026-08-31T08:01:01.500Z",
    resultManifestId: "result-manifest-1",
  }];
  value.reviews = [{
    reviewId: "review-1",
    sourceId: "source-1",
    resultId: "result-1",
    correctionRevision: 1,
    disposition: "reviewed",
    decidedAt: "2026-08-31T08:02:00.000Z",
    note: "Reviewed against the corrected working-result pack.",
  }];
  value.jobs = [{
    spec: {
      schemaVersion: JOB_SPEC_SCHEMA,
      jobId: "job-1",
      kind: "segment",
      createdAt: "2026-08-31T08:01:00.000Z",
      executionTarget: { kind: "local" },
      inputs: [{
        sourceId: "source-1",
        fingerprintSha256: sourceSha256,
        byteLength: 16,
      }],
      operation: {
        profileId: "loci-classical",
        modelId: "loci-classical",
        modelSha256: null,
        settings: classicalSettings,
      },
      resources: {
        cpuCores: 2,
        memoryMiB: 2048,
        gpuCount: 0,
        walltimeMinutes: 10,
      },
      expectedOutputs: [{ artifactId: "labels", mediaType: "image/tiff" }],
    },
    events: [
      {
        schemaVersion: JOB_EVENT_SCHEMA,
        jobId: "job-1",
        sequence: 0,
        occurredAt: "2026-08-31T08:01:00.000Z",
        state: "staging",
        progress: 0,
        message: "Preparing verified source.",
        reasonCode: null,
        schedulerState: null,
      },
      {
        schemaVersion: JOB_EVENT_SCHEMA,
        jobId: "job-1",
        sequence: 1,
        occurredAt: "2026-08-31T08:01:01.000Z",
        state: "running",
        progress: 0.5,
        message: "Segmenting source.",
        reasonCode: null,
        schedulerState: null,
      },
      {
        schemaVersion: JOB_EVENT_SCHEMA,
        jobId: "job-1",
        sequence: 2,
        occurredAt: "2026-08-31T08:01:02.000Z",
        state: "completed",
        progress: 1,
        message: "Verified result published.",
        reasonCode: null,
        schedulerState: null,
      },
    ],
    result: {
      schemaVersion: RESULT_MANIFEST_SCHEMA,
      resultManifestId: "result-manifest-1",
      resultId: "result-1",
      jobId: "job-1",
      createdAt: "2026-08-31T08:01:01.500Z",
      sourceFingerprints: [{ sourceId: "source-1", sha256: sourceSha256 }],
      producer: {
        appVersion: "0.1.0",
        engineVersion: "0.1.0",
        modelId: "loci-classical",
        modelSha256: null,
        settingsSha256,
      },
      artifacts: [{
        artifactId: "labels",
        filename: "field-01_labels.tiff",
        mediaType: "image/tiff",
        byteLength: 4096,
        sha256: artifactSha256,
      }],
      publication: { state: "verified", atomic: true, reason: null },
    },
  }];
  return value;
}

function locator(sourcePath: string): ProjectSourceLocatorV1 {
  return {
    sourceId: "source-1",
    kind: "local-file",
    platform: "posix",
    canonicalPath: sourcePath,
  };
}

async function fixture() {
  const sourcePath = path.join(root, "field-01.tif");
  const projectPath = path.join(root, "study.loci-project");
  await fs.writeFile(sourcePath, "immutable-source", "utf8");
  return { sourcePath: await fs.realpath(sourcePath), projectPath };
}

describe("project store", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-project-store-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates, reopens, and summarizes a private project without exposing locators", async () => {
    const { projectPath, sourcePath } = await fixture();
    const inputManifest = manifest();
    const created = await createProject(projectPath, inputManifest, [locator(sourcePath)]);

    expect(created.filePath).toBe(path.join(await fs.realpath(root), path.basename(projectPath)));
    expect(created.document.revision).toBe(0);
    expect(created.persistenceToken).toMatch(/^[a-f0-9]{64}$/u);
    expect((await fs.stat(projectPath)).mode & 0o077).toBe(0);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("immutable-source");

    // Caller mutation cannot mutate the stored session or the on-disk source authority.
    inputManifest.title = "mutated caller";
    expect(created.document.manifest.title).toBe("Cell study");

    const reopened = await openProject(projectPath);
    const reloaded = await reopenProject(reopened);
    expect(reloaded.document).toEqual(reopened.document);
    const summary = sanitizedProjectSummary(reopened);
    expect(summary).toEqual({
      schemaVersion: PROJECT_SUMMARY_SCHEMA,
      projectId: "project-1",
      title: "Cell study",
      createdAt: "2026-08-31T08:00:00.000Z",
      updatedAt: "2026-08-31T08:00:00.000Z",
      appVersion: "0.1.0",
      revision: 0,
      sources: [
        {
          sourceId: "source-1",
          displayName: "field-01.tif",
          relativeLabel: "plate-a/field-01.tif",
          fingerprintStatus: "pending",
          inspectionStatus: "ready",
          workspace: "generic-2d",
        },
      ],
      counts: {
        displayRecipes: 0,
        annotations: 0,
        corrections: 0,
        modelResults: 0,
        jobs: 0,
      },
    });
    expect(JSON.stringify(summary)).not.toContain(sourcePath);
    expect(summary).not.toHaveProperty("filePath");
    expect(summary.sources[0]).not.toHaveProperty("canonicalPath");
  });

  it("uses exclusive publication for Create and Save As", async () => {
    const { projectPath, sourcePath } = await fixture();
    const created = await createProject(projectPath, manifest(), [locator(sourcePath)]);
    await expect(createProject(projectPath, manifest(), [locator(sourcePath)]))
      .rejects.toMatchObject({ code: "already-exists" });

    const copyPath = path.join(root, "study-copy.loci-project");
    const copy = await saveProjectAs(created, copyPath);
    expect(copy.filePath).toBe(path.join(await fs.realpath(root), path.basename(copyPath)));
    expect(copy.document.revision).toBe(1);
    expect(copy.document.manifest.projectId).toBe(created.document.manifest.projectId);
    expect((await openProject(projectPath)).document.revision).toBe(0);
    await expect(saveProjectAs(created, copyPath)).rejects.toMatchObject({
      code: "already-exists",
    });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("immutable-source");
  });

  it("discards only the exact unchanged project created by a failed transaction", async () => {
    const { projectPath, sourcePath } = await fixture();
    const created = await createProject(projectPath, manifest(), [locator(sourcePath)]);

    await discardCreatedProject(created);

    await expect(fs.lstat(projectPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("immutable-source");
  });

  it("preserves a newly created project if it changed before compensating rollback", async () => {
    const { projectPath, sourcePath } = await fixture();
    const created = await createProject(projectPath, manifest(), [locator(sourcePath)]);
    const externallyChanged = `${await fs.readFile(projectPath, "utf8")} `;
    await fs.writeFile(projectPath, externallyChanged, { mode: 0o600 });

    await expect(discardCreatedProject(created)).rejects.toMatchObject({ code: "conflict" });

    await expect(fs.readFile(projectPath, "utf8")).resolves.toBe(externallyChanged);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("immutable-source");
  });

  it("atomically advances revisions and rejects a stale session", async () => {
    const { projectPath, sourcePath } = await fixture();
    const created = await createProject(projectPath, manifest(), [locator(sourcePath)]);
    const changed = manifest({
      title: "Updated study",
      updatedAt: "2026-08-31T09:00:00.000Z",
    });
    const saved = await saveProject(created, changed);
    expect(saved.document.revision).toBe(1);
    expect((await openProject(projectPath)).document.manifest.title).toBe("Updated study");

    await expect(saveProject(created, changed)).rejects.toMatchObject({ code: "conflict" });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("immutable-source");
    const temporaryFiles = (await fs.readdir(root)).filter((name) => name.endsWith(".tmp"));
    expect(temporaryFiles).toEqual([]);
  });

  it("checks cancellation at the final publication boundary without changing the project", async () => {
    const { projectPath, sourcePath } = await fixture();
    const created = await createProject(projectPath, manifest(), [locator(sourcePath)]);
    const before = await fs.readFile(projectPath);
    const cancelled = new Error("quit save cancelled");

    await expect(saveProject(
      created,
      manifest({ title: "Must not publish" }),
      created.document.sourceLocators,
      () => {
        throw cancelled;
      },
    )).rejects.toBe(cancelled);

    await expect(fs.readFile(projectPath)).resolves.toEqual(before);
    expect((await openProject(projectPath)).document.revision).toBe(0);
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each([
    "correction checkpoint",
    "batch finalization checkpoint",
    "result retirement checkpoint",
  ])("fences a paused %s when Quit Without Saving is chosen", async (publisher) => {
    const { projectPath, sourcePath } = await fixture();
    const created = await createProject(projectPath, manifest(), [locator(sourcePath)]);
    const before = await fs.readFile(projectPath);
    const coordinator = new QuitProjectSaveCoordinator(
      25,
      () => "11111111-1111-4111-8111-111111111111",
    );
    let reachedCommit!: () => void;
    let releaseCommit!: () => void;
    const commitReached = new Promise<void>((resolve) => { reachedCommit = resolve; });
    const commitReleased = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const uninstall = installProjectPublicationGuard({
      begin: () => coordinator.cancellationRevision,
      beforeCommit: async (revision) => {
        reachedCommit();
        await commitReleased;
        coordinator.claimPublication(revision);
      },
    });

    const saving = saveProject(
      created,
      manifest({ title: `Paused ${publisher}` }),
    );
    await commitReached;
    vi.useFakeTimers();
    try {
      const quitOutcome = coordinator.request(() => undefined);
      const quitDecision = shouldQuitAfterProjectSave(
        true,
        () => quitOutcome,
        async () => true,
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(quitDecision).resolves.toBe(true);

      releaseCommit();
      await expect(saving).rejects.toMatchObject({
        name: "QuitProjectSaveCancelledError",
      });
      await expect(fs.readFile(projectPath)).resolves.toEqual(before);
      expect((await openProject(projectPath)).document.revision).toBe(0);
      expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      releaseCommit();
      coordinator.rendererUnavailable();
      uninstall();
      vi.useRealTimers();
    }
  });

  it("re-enables fresh publishers after Keep Working while rejecting the stale paused save", async () => {
    const { projectPath, sourcePath } = await fixture();
    const created = await createProject(projectPath, manifest(), [locator(sourcePath)]);
    const before = await fs.readFile(projectPath);
    const coordinator = new QuitProjectSaveCoordinator(
      25,
      () => "11111111-1111-4111-8111-111111111111",
    );
    let reachedCommit!: () => void;
    let releaseCommit!: () => void;
    const commitReached = new Promise<void>((resolve) => { reachedCommit = resolve; });
    const commitReleased = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const uninstall = installProjectPublicationGuard({
      begin: () => coordinator.cancellationRevision,
      beforeCommit: async (revision) => {
        reachedCommit();
        await commitReleased;
        coordinator.claimPublication(revision);
      },
    });

    const staleSave = saveProject(created, manifest({ title: "Stale correction checkpoint" }));
    await commitReached;
    vi.useFakeTimers();
    try {
      const quitOutcome = coordinator.request(() => undefined);
      const quitDecision = shouldQuitAfterProjectSave(
        true,
        () => quitOutcome,
        async () => false,
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(quitDecision).resolves.toBe(false);
      coordinator.resumeSavingAfterCancelledRequest();

      releaseCommit();
      await expect(staleSave).rejects.toMatchObject({
        name: "QuitProjectSaveCancelledError",
      });
      await expect(fs.readFile(projectPath)).resolves.toEqual(before);

      const recovered = await saveProject(
        created,
        manifest({ title: "Recovered after Keep Working" }),
      );
      expect(recovered.document.revision).toBe(1);
      expect((await openProject(projectPath)).document.manifest.title)
        .toBe("Recovered after Keep Working");
    } finally {
      releaseCommit();
      coordinator.rendererUnavailable();
      uninstall();
      vi.useRealTimers();
    }
  });

  it("applies the shared quit fence to Create, Save, and Save As publishers", async () => {
    const { projectPath, sourcePath } = await fixture();
    const created = await createProject(projectPath, manifest(), [locator(sourcePath)]);
    const before = await fs.readFile(projectPath);
    const coordinator = new QuitProjectSaveCoordinator(
      1_000,
      () => "11111111-1111-4111-8111-111111111111",
    );
    const outcome = coordinator.request(() => undefined);
    coordinator.settle({
      requestId: "11111111-1111-4111-8111-111111111111",
      status: "failed",
    });
    await expect(outcome).resolves.toBe("failed");
    const uninstall = installProjectPublicationGuard({
      begin: () => coordinator.cancellationRevision,
      beforeCommit: (revision) => coordinator.claimPublication(revision),
    });
    const createdPath = path.join(root, "blocked-create.loci-project");
    const saveAsPath = path.join(root, "blocked-save-as.loci-project");
    try {
      await expect(createProject(
        createdPath,
        manifest({ projectId: "project-create" }),
        [locator(sourcePath)],
      )).rejects.toMatchObject({ name: "QuitProjectSaveCancelledError" });
      await expect(saveProject(
        created,
        manifest({ title: "Blocked save" }),
      )).rejects.toMatchObject({ name: "QuitProjectSaveCancelledError" });
      await expect(saveProjectAs(created, saveAsPath))
        .rejects.toMatchObject({ name: "QuitProjectSaveCancelledError" });

      await expect(fs.lstat(createdPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(saveAsPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(projectPath)).resolves.toEqual(before);
      expect((await openProject(projectPath)).document.revision).toBe(0);
      expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      coordinator.resumeSavingAfterCancelledRequest();
      uninstall();
    }
  });

  it("implements an explicit v1 identity migration and rejects unknown versions", async () => {
    const { sourcePath } = await fixture();
    const document = createProjectDocument(manifest(), [locator(sourcePath)]);
    const migrated = migrateProjectDocument(document);
    expect(migrated).toEqual(document);
    expect(migrated).not.toBe(document);

    expect(() => migrateProjectDocument({ ...document, schemaVersion: "loci.project-file/v2" }))
      .toThrowError(ProjectStoreError);
    try {
      migrateProjectDocument({ ...document, schemaVersion: "loci.project-file/v2" });
    } catch (error) {
      expect(error).toMatchObject({ code: "unsupported-version" });
    }
  });

  it("drops only legacy unbound corrections while preserving bound packs and project state", async () => {
    const { sourcePath } = await fixture();
    const document = createProjectDocument(
      manifestWithBoundCorrection(),
      [locator(sourcePath)],
    );
    const expected = structuredClone(document);
    const legacyDocument = structuredClone(document) as unknown as {
      manifest: {
        corrections: unknown[];
      };
    };
    legacyDocument.manifest.corrections.unshift({
      correctionId: "legacy-unbound-correction",
      sourceId: "source-1",
      resultId: "result-1",
      revision: 1,
      operationIds: ["legacy-operation"],
    });

    const migrated = migrateProjectDocument(legacyDocument);

    expect(migrated).toEqual(expected);
    expect(migrated.manifest.corrections).toEqual(expected.manifest.corrections);
    expect(migrated.manifest.reviews).toEqual(expected.manifest.reviews);
    expect(migrated.manifest.annotations).toEqual(expected.manifest.annotations);
    expect(migrated.manifest.modelResults).toEqual(expected.manifest.modelResults);
    expect(migrated.manifest.jobs).toEqual(expected.manifest.jobs);
    expect(migrated.sourceLocators).toEqual(expected.sourceLocators);
  });

  it("keeps migration strict for unknown document and bound-artifact fields", async () => {
    const { sourcePath } = await fixture();
    const document = createProjectDocument(
      manifestWithBoundCorrection(),
      [locator(sourcePath)],
    );

    expect(() => migrateProjectDocument({ ...document, debugState: true }))
      .toThrow(/unsupported field/i);

    const unknownArtifactField = structuredClone(document) as unknown as {
      manifest: {
        corrections: Array<{
          workingResultArtifact: Record<string, unknown>;
        }>;
      };
    };
    unknownArtifactField.manifest.corrections[0].workingResultArtifact.compression = "zip";
    expect(() => migrateProjectDocument(unknownArtifactField))
      .toThrow(/not part of this schema/i);
  });

  it("strictly rejects unknown fields, missing locators, traversal, and controls", async () => {
    const { projectPath, sourcePath } = await fixture();
    const document = createProjectDocument(manifest(), [locator(sourcePath)]);
    expect(() => validateProjectDocument({ ...document, password: "secret" }))
      .toThrow(/unsupported field/i);
    expect(() => validateProjectDocument({ ...document, sourceLocators: [] }))
      .toThrow(/exactly one/i);
    expect(() => validateProjectDocument({
      ...document,
      sourceLocators: [{ ...locator(sourcePath), canonicalPath: "/tmp/../private/image.tif" }],
    })).toThrow(/normalized absolute/i);
    expect(() => validateProjectDocument({
      ...document,
      sourceLocators: [{ ...locator(sourcePath), sourceId: "source\n1" }],
    })).toThrow(/invalid/i);

    const duplicateLocationManifest = manifest();
    const secondSource = structuredClone(duplicateLocationManifest.sources[0]);
    secondSource.sourceId = "source-2";
    secondSource.relativeLabel = "plate-b/field-01.tif";
    if (secondSource.inspectionStatus !== "ready") throw new Error("Expected ready fixture.");
    secondSource.descriptor.relativeLabel = secondSource.relativeLabel;
    duplicateLocationManifest.sources.push(secondSource);
    expect(() => validateProjectDocument({
      schemaVersion: PROJECT_FILE_SCHEMA,
      revision: 0,
      manifest: duplicateLocationManifest,
      sourceLocators: [locator(sourcePath), { ...locator(sourcePath), sourceId: "source-2" }],
    })).toThrow(/same source location/i);

    const unsafeManifest = structuredClone(manifest()) as ProjectManifestV1 & {
      rawPixels?: string;
    };
    unsafeManifest.rawPixels = "data:image/png;base64,AAAA";
    expect(() => createProjectDocument(unsafeManifest, [locator(sourcePath)]))
      .toThrow(/unsupported|forbidden|main-process-only|not part/i);

    await expect(createProject(
      `${root}/folder/../traversal.loci-project`,
      manifest(),
      [locator(sourcePath)],
    )).rejects.toMatchObject({ code: "invalid-location" });
    expect(projectPath).toContain(".loci-project");
  });

  it("rejects project source and locator counts above the shared session bound before expansion", async () => {
    const { sourcePath } = await fixture();
    const tooManySources = manifest();
    tooManySources.sources = new Array(MAX_PROJECT_SOURCES + 1).fill(tooManySources.sources[0]);
    expect(() => validateProjectDocument({
      schemaVersion: PROJECT_FILE_SCHEMA,
      revision: 0,
      manifest: tooManySources,
      sourceLocators: [],
    })).toThrow(/at most 20000 sources/i);

    expect(() => validateProjectDocument({
      schemaVersion: PROJECT_FILE_SCHEMA,
      revision: 0,
      manifest: manifest(),
      sourceLocators: new Array(MAX_PROJECT_SOURCES + 1).fill(locator(sourcePath)),
    })).toThrow(/at most 20000 source locators/i);
  });

  it("never permits a project publication to target an immutable source", async () => {
    const sourceAndProjectPath = path.join(root, "source.loci-project");
    await expect(createProject(
      sourceAndProjectPath,
      manifest(),
      [locator(sourceAndProjectPath)],
    )).rejects.toMatchObject({ code: "unsafe-source-target" });
    await expect(fs.stat(sourceAndProjectPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinks and malformed documents while opening", async () => {
    const { projectPath, sourcePath } = await fixture();
    await createProject(projectPath, manifest(), [locator(sourcePath)]);
    const linkPath = path.join(root, "linked.loci-project");
    await fs.symlink(projectPath, linkPath);
    await expect(openProject(linkPath)).rejects.toMatchObject({ code: "invalid-location" });

    const malformedPath = path.join(root, "malformed.loci-project");
    await fs.writeFile(malformedPath, "{not-json", { mode: 0o600 });
    await expect(openProject(malformedPath)).rejects.toMatchObject({ code: "invalid-project" });

    const oversizedPath = path.join(root, "oversized.loci-project");
    const handle = await fs.open(oversizedPath, "w", 0o600);
    await handle.truncate(MAX_PROJECT_FILE_BYTES + 1);
    await handle.close();
    await expect(openProject(oversizedPath)).rejects.toMatchObject({ code: "too-large" });
  });

  it("refuses to save a different logical project through an active session", async () => {
    const { projectPath, sourcePath } = await fixture();
    const created = await createProject(projectPath, manifest(), [locator(sourcePath)]);
    await expect(saveProject(created, manifest({ projectId: "other-project" })))
      .rejects.toMatchObject({ code: "invalid-project" });
  });
});
