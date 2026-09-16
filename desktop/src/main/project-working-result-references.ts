import path from "node:path";

import type { ProjectManifestV1 } from "../shared/foundation-contracts";
import { latestActiveProjectResultIds } from "./active-project-results";
import { selectRestorableProjectResult } from "./project-result-selection";
import {
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
} from "./working-result-publication";
import type { WorkingResultProjectReferenceInput } from "./working-result-retention";

/**
 * Build the complete ownership set required to reopen the project's active
 * results. Historical jobs retain immutable provenance metadata, but their
 * pixel-bearing working packs are not kept alive after the result is retired.
 */
export function projectWorkingResultReferences(
  manifest: ProjectManifestV1,
  workingRoot: string,
): WorkingResultProjectReferenceInput[] {
  if (typeof workingRoot !== "string" || !path.isAbsolute(workingRoot)) {
    throw new Error("The working-result root must be an absolute path.");
  }

  const activeResultIds = latestActiveProjectResultIds(manifest.modelResults);
  const references: WorkingResultProjectReferenceInput[] = [];
  for (const [sourceId, resultId] of [...activeResultIds].sort(([left], [right]) =>
    left.localeCompare(right))) {
    const selected = selectRestorableProjectResult(manifest, sourceId);
    if (!selected || selected.modelResult.resultId !== resultId) {
      throw new Error("The active model result does not bind to its exact recoverable job.");
    }
    const { job, correction, originalArtifact } = selected;
    references.push({
      resultId,
      revision: 0,
      jobId: job.spec.jobId,
      artifact: {
        artifactId: WORKING_RESULT_ARTIFACT_ID,
        filename: originalArtifact.filename,
        mediaType: WORKING_RESULT_MEDIA_TYPE,
        byteLength: originalArtifact.byteLength,
        sha256: originalArtifact.sha256,
      },
      packPath: path.join(workingRoot, job.spec.jobId, originalArtifact.filename),
    });
    if (!correction) continue;
    references.push({
      resultId,
      revision: correction.revision,
      jobId: job.spec.jobId,
      artifact: {
        artifactId: WORKING_RESULT_ARTIFACT_ID,
        filename: correction.workingResultArtifact.filename,
        mediaType: WORKING_RESULT_MEDIA_TYPE,
        byteLength: correction.workingResultArtifact.byteLength,
        sha256: correction.workingResultArtifact.sha256,
      },
      packPath: path.join(
        workingRoot,
        job.spec.jobId,
        correction.workingResultArtifact.filename,
      ),
    });
  }
  return references;
}
