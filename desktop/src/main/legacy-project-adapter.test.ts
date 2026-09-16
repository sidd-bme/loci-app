// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openProject: vi.fn(),
  select: vi.fn(),
  verify: vi.fn(async (_path: string, artifact: unknown) => artifact),
}));

vi.mock("./project-store", () => ({ openProject: mocks.openProject }));
vi.mock("./project-result-selection", () => ({
  selectRestorableProjectResult: mocks.select,
}));
vi.mock("./working-result-publication", () => ({
  verifyRestorableProjectWorkingResultArtifact: mocks.verify,
}));

import { prepareLegacyProjectImport } from "./legacy-project-adapter";

const sha = (letter: string) => letter.repeat(64);
let root: string;

describe("legacy project adapter", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-legacy-adapter-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("selects and verifies the original and current correction packs", async () => {
    const sourcePath = path.join(root, "cells.png");
    await fs.writeFile(sourcePath, "pixels");
    const original = {
      artifactId: "working-result", filename: "working-result_1-r0.loci-result",
      mediaType: "application/vnd.loci.working-result+zip", byteLength: 10, sha256: sha("b"),
    };
    const corrected = {
      ...original, filename: "working-result_1-r2.loci-result", byteLength: 12, sha256: sha("c"),
    };
    const manifest = {
      projectId: "project_1", title: "Legacy study",
      sources: [{
        sourceId: "source_1", displayName: "Cells", relativeLabel: "cells.png",
        fingerprint: { status: "verified", sha256: sha("a"), verifiedAt: "2026-01-01" },
      }],
      reviews: [{
        sourceId: "source_1", resultId: "result_1", correctionRevision: 2,
        disposition: "reviewed", decidedAt: "2026-01-02",
      }],
    };
    mocks.openProject.mockResolvedValue({
      persistenceToken: sha("d"),
      document: {
        revision: 7, manifest,
        sourceLocators: [{
          sourceId: "source_1", kind: "local-file",
          platform: process.platform === "win32" ? "win32" : "posix",
          canonicalPath: sourcePath,
        }],
      },
    });
    mocks.select.mockReturnValue({
      modelResult: {
        resultId: "result_1", resultManifestId: "manifest_1",
        modelId: "cellpose-sam", modelSha256: sha("e"),
      },
      job: { spec: {
        jobId: "job_1",
        inputs: [{ fingerprintSha256: sha("a") }],
        operation: { settings: { sensitivity: 1e-7 } },
      } },
      resultManifest: {
        producer: { settingsSha256: sha("f"), engineVersion: "0.1.0" },
        sourceFingerprints: [{ sourceId: "source_1", sha256: sha("a") }],
      },
      originalArtifact: original,
      correction: { revision: 2, operationIds: ["op_1"], workingResultArtifact: corrected },
    });

    const prepared = await prepareLegacyProjectImport(
      path.join(root, "Legacy.loci-project"), path.join(root, "working-results"),
    );
    const canonicalSourcePath = await fs.realpath(sourcePath);

    const originalPath = path.join(root, "working-results", "job_1", original.filename);
    const correctedPath = path.join(root, "working-results", "job_1", corrected.filename);
    expect(mocks.verify.mock.calls).toEqual([
      [originalPath, original], [correctedPath, corrected],
    ]);
    expect(prepared).toMatchObject({
      legacy_project: {
        project_id: "project_1", title: "Legacy study", revision: 7, sha256: sha("d"),
      },
      items: [{
        legacy_source_id: "source_1", source_path: canonicalSourcePath, expected_sha256: sha("a"),
        result: {
          legacy_result_id: "result_1", correction_revision: 2,
          correction_operation_ids: ["op_1"],
          settings_json: '{"sensitivity":1e-7}',
          active_pack: { path: correctedPath, sha256: sha("c") },
          review_disposition: "reviewed",
        },
      }],
    });
  });
});
