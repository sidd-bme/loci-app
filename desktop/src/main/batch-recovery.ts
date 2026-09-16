import type { JobSpec, ResultManifest } from "../shared/foundation-contracts";
import type { BatchRunPlan } from "./batch-run-store";
import { sha256CanonicalJson } from "./job-store";
import {
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
} from "./working-result-publication";

export const DURABLE_BATCH_PROJECT_REQUIRED_MESSAGE =
  "Save this complete source set as a Loci project before starting a batch so every result can be recovered after restart.";

export interface BatchRecoverySummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface CompletedBatchResultReference {
  state: string;
  resultId: string | null;
}

export interface FrozenCompletedBatchResultReference extends CompletedBatchResultReference {
  sourceId: string;
  resultManifestId: string | null;
  createdAt: string;
}

export interface DurableBatchProjectSourceBinding {
  sourceId: string;
  fingerprintSha256: string | null;
  relativeLabel: string;
}

const BATCH_PLAN_PARENT_MISMATCH_MESSAGE =
  "The durable batch plan does not match its immutable parent job specification.";

/**
 * Bind the separately persisted batch ledger to the immutable job that
 * authorizes it. This check is deliberately set-based: plan serialization may
 * preserve a different order, but omission, addition, duplicate identity, or
 * any fingerprint substitution must fail closed.
 */
export function assertBatchPlanMatchesParent(
  plan: Readonly<BatchRunPlan>,
  parent: Readonly<JobSpec>,
): void {
  const fail = () => {
    throw new Error(BATCH_PLAN_PARENT_MISMATCH_MESSAGE);
  };
  if (
    parent.kind !== "segment" ||
    parent.inputs.length < 2 ||
    plan.batchId !== parent.jobId ||
    plan.createdAt !== parent.createdAt ||
    plan.sources.length !== parent.inputs.length
  ) fail();

  const parentBySourceId = new Map(parent.inputs.map((input) => [input.sourceId, input] as const));
  const planSourceIds = new Set(plan.sources.map(({ sourceId }) => sourceId));
  if (
    parentBySourceId.size !== parent.inputs.length ||
    planSourceIds.size !== plan.sources.length
  ) fail();

  for (const source of plan.sources) {
    const parentInput = parentBySourceId.get(source.sourceId);
    if (
      !parentInput ||
      parentInput.fingerprintSha256 === null ||
      source.fingerprintSha256 !== parentInput.fingerprintSha256
    ) fail();
  }
}

/**
 * The project owns the stable, portable labels used by a recursive batch.
 * A project may contain additional sources, but every source named by the
 * frozen batch must retain its exact identity, fingerprint, and label.
 */
export function assertBatchPlanMatchesProjectSources(
  plan: Readonly<BatchRunPlan>,
  projectSources: readonly DurableBatchProjectSourceBinding[],
): void {
  const fail = () => {
    throw new Error(
      "The durable batch plan no longer matches the saved project source identities and labels.",
    );
  };
  const projectBySourceId = new Map(
    projectSources.map((source) => [source.sourceId, source] as const),
  );
  if (projectBySourceId.size !== projectSources.length) fail();
  for (const source of plan.sources) {
    const projectSource = projectBySourceId.get(source.sourceId);
    if (
      !projectSource ||
      projectSource.fingerprintSha256 === null ||
      projectSource.fingerprintSha256 !== source.fingerprintSha256 ||
      projectSource.relativeLabel !== source.relativeLabel
    ) fail();
  }
}

/** Fail before creating durable job state unless every source has a stable project identity. */
export function assertDurableBatchProjectSources(
  projectSourceIds: readonly string[] | null,
  requestedSourceIds: readonly string[],
): void {
  if (!projectSourceIds) throw new Error(DURABLE_BATCH_PROJECT_REQUIRED_MESSAGE);
  const projectIds = new Set(projectSourceIds);
  if (
    requestedSourceIds.length < 2 ||
    requestedSourceIds.some((sourceId) => !projectIds.has(sourceId))
  ) {
    throw new Error(DURABLE_BATCH_PROJECT_REQUIRED_MESSAGE);
  }
}

/** Only an entirely completed ledger is eligible for idempotent parent finalization. */
export function isBatchLedgerComplete(summary: Readonly<BatchRecoverySummary>): boolean {
  return summary.total >= 2 &&
    summary.completed === summary.total &&
    summary.pending === 0 &&
    summary.running === 0 &&
    summary.failed === 0 &&
    summary.cancelled === 0;
}

/** Keep completed packs session-owned until project persistence and ownership both succeed. */
export function protectCompletedBatchResults(
  protectedResultIds: Set<string>,
  items: readonly CompletedBatchResultReference[],
): void {
  for (const item of items) {
    if (item.state === "completed" && item.resultId) protectedResultIds.add(item.resultId);
  }
}

export function releaseCompletedBatchProtection(
  protectedResultIds: Set<string>,
  items: readonly CompletedBatchResultReference[],
): void {
  for (const item of items) {
    if (item.state === "completed" && item.resultId) protectedResultIds.delete(item.resultId);
  }
}

/**
 * Build the exact active-result set that a completed batch is allowed to
 * checkpoint. A normal restart may have restored the prior saved binding, so
 * that binding can be replaced by the frozen batch result. A different
 * in-session binding is a newer rerun and must never be silently overwritten
 * or certified as part of the older batch.
 */
export function frozenBatchCheckpointBindings(
  currentBindings: ReadonlyMap<string, string>,
  savedBindings: ReadonlyMap<string, string>,
  savedResultCreatedAt: ReadonlyMap<string, string>,
  items: readonly FrozenCompletedBatchResultReference[],
): Map<string, string> {
  const next = new Map(currentBindings);
  const seenSources = new Set<string>();
  for (const item of items) {
    if (
      item.state !== "completed"
      || !item.sourceId
      || !item.resultId
      || !item.resultManifestId
      || !Number.isFinite(Date.parse(item.createdAt))
      || seenSources.has(item.sourceId)
    ) {
      throw new Error("The completed batch does not contain one exact result for every source.");
    }
    seenSources.add(item.sourceId);
    const currentResultId = currentBindings.get(item.sourceId);
    const savedResultId = savedBindings.get(item.sourceId);
    if (currentResultId !== item.resultId && currentResultId !== savedResultId) {
      throw new Error(
        "A source has a newer unsaved result. Reopen the saved project before finalizing this older batch.",
      );
    }
    if (currentResultId !== item.resultId && savedResultId) {
      const savedCreatedAt = savedResultCreatedAt.get(savedResultId);
      if (
        !savedCreatedAt
        || !Number.isFinite(Date.parse(savedCreatedAt))
        || Date.parse(savedCreatedAt) >= Date.parse(item.createdAt)
      ) {
        throw new Error(
          "The saved project already contains a result as new as this batch. Loci will not replace it during batch finalization.",
        );
      }
    }
    next.set(item.sourceId, item.resultId);
  }
  return next;
}

/**
 * Prove that one child analysis was executed under the frozen parent batch
 * provenance before it can enter (or revalidate) the durable item ledger.
 */
export function assertBatchChildMatchesParent(
  parent: JobSpec,
  child: JobSpec,
  result: ResultManifest,
  sourceId: string,
): void {
  const fail = () => {
    throw new Error("The child result does not match the frozen batch provenance.");
  };
  const parentInputs = parent.inputs.filter((input) => input.sourceId === sourceId);
  const childInput = child.inputs[0];
  if (
    parent.kind !== "segment" ||
    parent.inputs.length < 2 ||
    parentInputs.length !== 1 ||
    child.kind !== "segment" ||
    child.inputs.length !== 1 ||
    !childInput ||
    childInput.sourceId !== sourceId ||
    childInput.fingerprintSha256 !== parentInputs[0].fingerprintSha256 ||
    sha256CanonicalJson(child.executionTarget) !== sha256CanonicalJson(parent.executionTarget) ||
    child.operation.profileId !== parent.operation.profileId ||
    child.operation.modelId !== parent.operation.modelId ||
    child.operation.modelSha256 !== parent.operation.modelSha256
  ) fail();

  const settingsSha256 = sha256CanonicalJson(parent.operation.settings);
  if (
    sha256CanonicalJson(child.operation.settings) !== settingsSha256 ||
    result.jobId !== child.jobId ||
    result.publication.state !== "verified" ||
    result.publication.atomic !== true ||
    result.producer.modelId !== parent.operation.modelId ||
    result.producer.modelSha256 !== parent.operation.modelSha256 ||
    result.producer.settingsSha256 !== settingsSha256 ||
    result.sourceFingerprints.length !== 1 ||
    result.sourceFingerprints[0].sourceId !== sourceId ||
    result.sourceFingerprints[0].sha256 !== parentInputs[0].fingerprintSha256 ||
    !result.artifacts.some((artifact) =>
      artifact.artifactId === WORKING_RESULT_ARTIFACT_ID &&
      artifact.mediaType === WORKING_RESULT_MEDIA_TYPE)
  ) fail();
}
