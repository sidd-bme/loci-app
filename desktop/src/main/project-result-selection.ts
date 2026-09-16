import type {
  AnalysisResult,
} from "../shared/contracts";
import type {
  ProjectCorrectionReference,
  ProjectJobRecord,
  ProjectManifestV1,
  ProjectModelResultReference,
  ResultArtifact,
  ResultManifest,
} from "../shared/foundation-contracts";
import { sha256CanonicalJson } from "./job-store";
import {
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
} from "./working-result-publication";

export interface RestorableProjectResult {
  modelResult: ProjectModelResultReference;
  job: ProjectJobRecord;
  resultManifest: ResultManifest;
  originalArtifact: ResultArtifact;
  correction: ProjectCorrectionReference | null;
}

type ProjectResultIndex = Pick<
  ProjectManifestV1,
  "modelResults" | "jobs" | "corrections"
>;

function sameSha256(left: string | null, right: string | null): boolean {
  return left === null || right === null
    ? left === right
    : left.toLowerCase() === right.toLowerCase();
}

/**
 * Re-establish the cryptographic producer binding at project-restore time.
 *
 * JobStore already applies this rule when a job first completes. Projects are
 * long-lived, independently portable documents, so restore must not rely on
 * that historical validation having happened in the current process.
 */
export function assertProjectResultProducerBinding(
  job: ProjectJobRecord,
  result: ResultManifest,
): void {
  if (
    result.jobId !== job.spec.jobId ||
    result.producer.modelId !== job.spec.operation.modelId ||
    !sameSha256(result.producer.modelSha256, job.spec.operation.modelSha256)
  ) {
    throw new Error("The saved result producer does not match its exact project job.");
  }
  if (
    result.producer.settingsSha256.toLowerCase() !==
    sha256CanonicalJson(job.spec.operation.settings)
  ) {
    throw new Error("The saved result settings digest does not match its exact project job.");
  }
}

/**
 * Compare trusted metadata decoded from the immutable working pack with the
 * exact producer/job record selected from the project. Call this before the
 * result is installed into any session registry or given a retention owner.
 */
export function assertRestoredProjectResultBinding(
  selected: RestorableProjectResult,
  analysis: AnalysisResult,
): void {
  const { job, modelResult, resultManifest } = selected;
  assertProjectResultProducerBinding(job, resultManifest);
  if (
    analysis.resultId !== resultManifest.resultId ||
    job.spec.operation.profileId === null ||
    analysis.profile.id !== job.spec.operation.profileId ||
    analysis.profile.id !== job.spec.operation.modelId ||
    analysis.profile.id !== resultManifest.producer.modelId ||
    analysis.profile.id !== modelResult.modelId
  ) {
    throw new Error("The restored working result does not match its saved analysis profile.");
  }
  if (
    !sameSha256(analysis.profile.model.sha256, resultManifest.producer.modelSha256) ||
    !sameSha256(analysis.profile.model.sha256, modelResult.modelSha256) ||
    analysis.runtime &&
      !sameSha256(analysis.runtime.model.sha256, resultManifest.producer.modelSha256)
  ) {
    throw new Error("The restored working result does not match its saved model identity.");
  }
  if (
    sha256CanonicalJson(analysis.settings) !==
    resultManifest.producer.settingsSha256.toLowerCase()
  ) {
    throw new Error("The restored working result does not match its saved settings digest.");
  }
  if (analysis.engine.version !== resultManifest.producer.engineVersion) {
    throw new Error("The restored working result does not match its saved engine provenance.");
  }
  if (analysis.engine.id !== analysis.profile.id) {
    throw new Error("The restored working result does not match its saved engine identity.");
  }
  if (
    analysis.runtime &&
    analysis.runtime.model.artifactId !== analysis.profile.model.artifactId
  ) {
    throw new Error("The restored working result does not match its saved runtime model identity.");
  }
}

/**
 * Resolve the current saved model result through its exact result identities.
 *
 * A job's timestamp is not a result-selection contract: parent batch jobs and
 * historical attempts can share a source and may not contain a working pack.
 */
export function selectRestorableProjectResult(
  manifest: ProjectResultIndex,
  sourceId: string,
): RestorableProjectResult | null {
  const modelResult = manifest.modelResults
    .filter((candidate) => candidate.sourceId === sourceId)
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.resultManifestId.localeCompare(left.resultManifestId) ||
      right.resultId.localeCompare(left.resultId))[0];
  if (!modelResult) return null;

  const matchingJobs = manifest.jobs.filter((job) =>
    job.spec.kind === "segment" &&
    job.spec.inputs.length === 1 &&
    job.spec.inputs[0].sourceId === sourceId &&
    job.spec.operation.modelId === modelResult.modelId &&
    job.spec.operation.modelSha256 === modelResult.modelSha256 &&
    job.result?.resultId === modelResult.resultId &&
    job.result.resultManifestId === modelResult.resultManifestId &&
    job.result.producer.modelId === modelResult.modelId &&
    job.result.producer.modelSha256 === modelResult.modelSha256);
  const resultManifest = matchingJobs[0]?.result ?? null;
  if (matchingJobs.length !== 1 || !resultManifest) {
    throw new Error("The saved model result does not bind to one exact durable result manifest.");
  }

  const job = matchingJobs[0];
  assertProjectResultProducerBinding(job, resultManifest);
  const artifacts = resultManifest.artifacts.filter((artifact) =>
    artifact.artifactId === WORKING_RESULT_ARTIFACT_ID &&
    artifact.mediaType === WORKING_RESULT_MEDIA_TYPE);
  if (artifacts.length !== 1) {
    throw new Error("The saved model result is missing its exact recoverable working-result artifact.");
  }

  const correction = manifest.corrections
    .filter((candidate) =>
      candidate.sourceId === sourceId &&
      candidate.resultId === modelResult.resultId)
    .sort((left, right) => right.revision - left.revision)[0] ?? null;
  return {
    modelResult,
    job,
    resultManifest,
    originalArtifact: artifacts[0],
    correction,
  };
}
