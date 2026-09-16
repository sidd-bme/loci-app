import path from "node:path";
import { promises as fs } from "node:fs";

import type { ResultArtifact } from "../shared/foundation-contracts";
import { canonicalJobJson } from "./job-store";
import { openProject } from "./project-store";
import { selectRestorableProjectResult } from "./project-result-selection";
import { verifyRestorableProjectWorkingResultArtifact } from "./working-result-publication";

export interface LegacyProjectImportItem {
  legacy_source_id: string;
  source_path: string;
  source_name: string;
  expected_sha256: string | null;
  result: null | {
    legacy_result_id: string;
    result_manifest_id: string;
    job_id: string;
    model_id: string;
    model_sha256: string | null;
    settings_json: string;
    settings_sha256: string;
    engine_version: string;
    correction_revision: number;
    correction_operation_ids: string[];
    original_pack: ResultArtifact;
    active_pack: ResultArtifact & { path: string };
    review_disposition: "reviewed" | "excluded" | null;
  };
}

export interface PreparedLegacyProjectImport {
  legacy_project: {
    project_id: string;
    title: string;
    revision: number;
    sha256: string;
  };
  items: LegacyProjectImportItem[];
}

function expectedPlatform(): "posix" | "win32" {
  return process.platform === "win32" ? "win32" : "posix";
}

function packPath(workingRoot: string, jobId: string, artifact: ResultArtifact): string {
  return path.join(workingRoot, jobId, artifact.filename);
}

/** Prepare a path-authoritative, fully verified request without exposing it to the renderer. */
export async function prepareLegacyProjectImport(
  projectPath: string,
  workingRoot: string,
): Promise<PreparedLegacyProjectImport> {
  const project = await openProject(projectPath);
  const sourceById = new Map(
    project.document.manifest.sources.map((source) => [source.sourceId, source] as const),
  );
  const items: LegacyProjectImportItem[] = [];
  for (const locator of project.document.sourceLocators) {
    if (locator.platform !== expectedPlatform()) {
      throw new Error("The legacy project references source locations from another operating system.");
    }
    const source = sourceById.get(locator.sourceId);
    if (!source) throw new Error("The legacy project source index is inconsistent.");
    const before = await fs.lstat(locator.canonicalPath).catch(() => null);
    if (!before || before.isSymbolicLink() || !before.isFile()) {
      throw new Error("A legacy project source image is missing or is not a plain local file.");
    }
    const canonical = await fs.realpath(locator.canonicalPath);
    const selected = selectRestorableProjectResult(project.document.manifest, locator.sourceId);
    if (!selected) {
      items.push({
        legacy_source_id: locator.sourceId,
        source_path: canonical,
        source_name: source.displayName,
        expected_sha256: source.fingerprint.status === "verified"
          ? source.fingerprint.sha256 : null,
        result: null,
      });
      continue;
    }
    if (source.fingerprint.status !== "verified") {
      throw new Error("A saved legacy result requires a verified source fingerprint.");
    }
    const sourceSha256 = source.fingerprint.sha256;
    const sourceFingerprints = selected.resultManifest.sourceFingerprints.filter(
      (entry) => entry.sourceId === locator.sourceId && entry.sha256 === sourceSha256,
    );
    if (
      sourceFingerprints.length !== 1 ||
      selected.job.spec.inputs[0].fingerprintSha256 !== sourceSha256
    ) {
      throw new Error("The saved legacy result does not bind to the source fingerprint.");
    }
    const activeArtifact = selected.correction?.workingResultArtifact ?? selected.originalArtifact;
    const settings = selected.job.spec.operation.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("The saved legacy segmentation settings are invalid.");
    }
    const originalPath = packPath(workingRoot, selected.job.spec.jobId, selected.originalArtifact);
    const activePath = packPath(workingRoot, selected.job.spec.jobId, activeArtifact);
    await verifyRestorableProjectWorkingResultArtifact(originalPath, selected.originalArtifact);
    if (activePath !== originalPath) {
      await verifyRestorableProjectWorkingResultArtifact(activePath, activeArtifact);
    }
    const review = project.document.manifest.reviews
      .filter((candidate) =>
        candidate.sourceId === locator.sourceId &&
        candidate.resultId === selected.modelResult.resultId &&
        candidate.correctionRevision === (selected.correction?.revision ?? 0))
      .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt))[0];
    items.push({
      legacy_source_id: locator.sourceId,
      source_path: canonical,
      source_name: source.displayName,
      expected_sha256: sourceSha256,
      result: {
        legacy_result_id: selected.modelResult.resultId,
        result_manifest_id: selected.modelResult.resultManifestId,
        job_id: selected.job.spec.jobId,
        model_id: selected.modelResult.modelId,
        model_sha256: selected.modelResult.modelSha256,
        settings_json: canonicalJobJson(settings),
        settings_sha256: selected.resultManifest.producer.settingsSha256,
        engine_version: selected.resultManifest.producer.engineVersion,
        correction_revision: selected.correction?.revision ?? 0,
        correction_operation_ids: selected.correction?.operationIds ?? [],
        original_pack: structuredClone(selected.originalArtifact),
        active_pack: { ...structuredClone(activeArtifact), path: activePath },
        review_disposition: review?.disposition ?? null,
      },
    });
  }
  return {
    legacy_project: {
      project_id: project.document.manifest.projectId,
      title: project.document.manifest.title,
      revision: project.document.revision,
      sha256: project.persistenceToken,
    },
    items,
  };
}
