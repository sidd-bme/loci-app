import type {
  ModelEvidenceStatus,
  ProjectJobRecord,
  ProjectModelResultReference,
} from "../shared/foundation-contracts";

export interface ActiveProjectResultBinding {
  readonly sourceId: string;
  readonly resultId: string;
}

/**
 * Resolve legacy project documents that may contain more than one historical
 * model-result reference per source into one explicit active binding.
 */
export function latestActiveProjectResultIds(
  modelResults: readonly ProjectModelResultReference[],
): Map<string, string> {
  const latest = [...modelResults].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) ||
    right.resultManifestId.localeCompare(left.resultManifestId) ||
    right.resultId.localeCompare(left.resultId));
  const result = new Map<string, string>();
  for (const candidate of latest) {
    if (!result.has(candidate.sourceId)) {
      result.set(candidate.sourceId, candidate.resultId);
    }
  }
  return result;
}

/**
 * Materialize only the active per-source bindings into the project document.
 * Completed jobs remain in `jobs` as immutable history, but are not silently
 * promoted back to active results merely because they still exist.
 */
export function activeProjectModelResults(
  jobs: readonly ProjectJobRecord[],
  activeResultIdsBySourceId: ReadonlyMap<string, string>,
  evidenceStatusForModel: (modelId: string) => ModelEvidenceStatus,
): ProjectModelResultReference[] {
  return [...activeResultIdsBySourceId]
    .sort(([leftSource], [rightSource]) => leftSource.localeCompare(rightSource))
    .map(([sourceId, resultId]) => {
      const matchingJobs = jobs.filter((job) =>
        job.spec.kind === "segment" &&
        job.spec.inputs.length === 1 &&
        job.spec.inputs[0].sourceId === sourceId &&
        job.result?.resultId === resultId &&
        Boolean(job.spec.operation.modelId) &&
        job.result?.producer.modelId === job.spec.operation.modelId &&
        job.result?.producer.modelSha256 === job.spec.operation.modelSha256);
      const job = matchingJobs[0];
      const result = job?.result ?? null;
      const modelId = job?.spec.operation.modelId ?? null;
      if (matchingJobs.length !== 1 || !job || !result || !modelId) {
        throw new Error(
          "The active analysis result does not bind to one exact completed segmentation job.",
        );
      }
      return {
        resultId,
        sourceId,
        modelId,
        modelSha256: job.spec.operation.modelSha256,
        evidenceStatus: evidenceStatusForModel(modelId),
        createdAt: result.createdAt,
        resultManifestId: result.resultManifestId,
      };
    });
}

/**
 * Temporarily retire exact bindings while their new durable project checkpoint
 * is written. A failed checkpoint restores every binding before the error is
 * exposed, allowing the renderer to keep both the result and old controls.
 */
export async function retireActiveProjectResultBindings<T>(
  activeResultIdsBySourceId: Map<string, string>,
  bindings: readonly ActiveProjectResultBinding[],
  persistRetirement: () => Promise<T>,
): Promise<T> {
  for (const { sourceId, resultId } of bindings) {
    if (activeResultIdsBySourceId.get(sourceId) !== resultId) {
      throw new Error("The requested result is not the active saved result for this source.");
    }
  }
  for (const { sourceId } of bindings) activeResultIdsBySourceId.delete(sourceId);
  try {
    return await persistRetirement();
  } catch (error) {
    for (const { sourceId, resultId } of bindings) {
      activeResultIdsBySourceId.set(sourceId, resultId);
    }
    throw error;
  }
}

/**
 * Make a newly verified result authoritative before releasing the prior
 * session copy. When the prior result belongs to the saved checkpoint, its
 * project reference remains intact until that checkpoint is reconciled; an
 * unsaved prior result is no longer a rollback target after replacement.
 */
export async function replaceActiveProjectResultBinding(
  activeResultIdsBySourceId: Map<string, string>,
  sourceId: string,
  resultId: string,
  disposeSuperseded: (resultId: string) => Promise<void>,
): Promise<string | null> {
  if (!sourceId || !resultId) {
    throw new Error("The active result replacement is invalid.");
  }
  const supersededResultId = activeResultIdsBySourceId.get(sourceId) ?? null;
  activeResultIdsBySourceId.set(sourceId, resultId);
  if (supersededResultId && supersededResultId !== resultId) {
    await disposeSuperseded(supersededResultId);
  }
  return supersededResultId;
}
