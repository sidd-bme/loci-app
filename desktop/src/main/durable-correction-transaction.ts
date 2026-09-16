/**
 * Framework-agnostic durable correction transaction orchestration.
 *
 * A correction is not durable until its immutable pack has been published,
 * renderer/project state has been committed, and the project checkpoint has
 * completed. Any failure after mutation must therefore restore the pre-mutate
 * state before control returns to the caller.
 */

import type { DurableOperationTracker } from "./durable-operations";
import type { ProjectSourceOperationQueue } from "./project-source-operations";

export type Awaitable<T> = T | PromiseLike<T>;

export type DurableCorrectionFailureStage = "publish" | "commit" | "checkpoint";

/**
 * Keep the complete mutation-to-checkpoint transaction on the same ordered
 * lane as explicit saves and autosaves. The inner result lane still supplies
 * the independent shutdown drain for working-result publications.
 */
export function runDurableCorrectionOnProjectLane<T>(
  projectOperations: Pick<ProjectSourceOperationQueue, "runProject">,
  resultOperations: Pick<DurableOperationTracker, "run">,
  start: () => Promise<T>,
): Promise<T> {
  return projectOperations.runProject(() => resultOperations.run(start));
}

export interface DurableCorrectionCommitContext<TMutation, TPublication> {
  readonly mutation: TMutation;
  readonly publication: TPublication;
}

export interface DurableCorrectionCheckpointContext<
  TMutation,
  TPublication,
  TCommit,
> extends DurableCorrectionCommitContext<TMutation, TPublication> {
  readonly commit: TCommit;
}

export interface DurableCorrectionRollbackContext<
  TMutation,
  TPublication,
  TCommit,
> {
  readonly failedStage: DurableCorrectionFailureStage;
  readonly failure: unknown;
  readonly mutation: TMutation;
  readonly publicationCompleted: boolean;
  readonly publication: TPublication | undefined;
  readonly commitCompleted: boolean;
  readonly commit: TCommit | undefined;
}

export interface DurableCorrectionInvalidationContext<
  TMutation,
  TPublication,
  TCommit,
> extends DurableCorrectionRollbackContext<TMutation, TPublication, TCommit> {
  readonly rollbackFailure: unknown;
}

export interface DurableCorrectionTransactionSteps<
  TMutation,
  TPublication,
  TCommit,
  TCheckpoint,
> {
  /** Apply the reversible in-memory/engine mutation. */
  readonly mutate: () => Awaitable<TMutation>;
  /** Publish and verify the immutable corrected working-result artifact. */
  readonly publish: (mutation: TMutation) => Awaitable<TPublication>;
  /** Commit the published correction receipt to active application state. */
  readonly commit: (
    context: Readonly<DurableCorrectionCommitContext<TMutation, TPublication>>,
  ) => Awaitable<TCommit>;
  /** Persist the committed correction in a durable project checkpoint. */
  readonly checkpoint: (
    context: Readonly<
      DurableCorrectionCheckpointContext<TMutation, TPublication, TCommit>
    >,
  ) => Awaitable<TCheckpoint>;
  /** Restore the exact pre-mutate state after any later-stage failure. */
  readonly rollback: (
    context: Readonly<
      DurableCorrectionRollbackContext<TMutation, TPublication, TCommit>
    >,
  ) => Awaitable<void>;
  /**
   * Mark the correction state unusable when rollback itself cannot be proven.
   * This is mandatory and is called even when invalidation may also fail.
   */
  readonly invalidate: (
    context: Readonly<
      DurableCorrectionInvalidationContext<TMutation, TPublication, TCommit>
    >,
  ) => Awaitable<void>;
}

export interface DurableCorrectionTransactionResult<
  TMutation,
  TPublication,
  TCommit,
  TCheckpoint,
> {
  readonly mutation: TMutation;
  readonly publication: TPublication;
  readonly commit: TCommit;
  readonly checkpoint: TCheckpoint;
}

/** A post-mutation stage failed, and the pre-mutate state was restored. */
export class DurableCorrectionTransactionError extends Error {
  readonly code = "durable-correction-rolled-back" as const;

  constructor(
    readonly failedStage: DurableCorrectionFailureStage,
    cause: unknown,
  ) {
    super(
      `Durable correction ${failedStage} failed after mutation; rollback completed.`,
      { cause },
    );
    this.name = "DurableCorrectionTransactionError";
  }
}

/**
 * Rollback could not be proven. Callers must treat the correction/result as
 * unusable even if the invalidation hook also encountered an error.
 */
export class DurableCorrectionFailClosedError extends Error {
  readonly code = "durable-correction-fail-closed" as const;
  readonly invalidationSucceeded: boolean;

  constructor(
    readonly failedStage: DurableCorrectionFailureStage,
    cause: unknown,
    readonly rollbackFailure: unknown,
    readonly invalidationFailure: unknown | null,
  ) {
    super(
      invalidationFailure === null
        ? `Durable correction ${failedStage} and rollback failed; the correction state was invalidated.`
        : `Durable correction ${failedStage}, rollback, and invalidation failed; the correction state must remain unusable.`,
      { cause },
    );
    this.name = "DurableCorrectionFailClosedError";
    this.invalidationSucceeded = invalidationFailure === null;
  }
}

function rollbackContext<TMutation, TPublication, TCommit>(
  failedStage: DurableCorrectionFailureStage,
  failure: unknown,
  mutation: TMutation,
  publicationCompleted: boolean,
  publication: TPublication | undefined,
  commitCompleted: boolean,
  commit: TCommit | undefined,
): Readonly<DurableCorrectionRollbackContext<TMutation, TPublication, TCommit>> {
  return Object.freeze({
    failedStage,
    failure,
    mutation,
    publicationCompleted,
    publication,
    commitCompleted,
    commit,
  });
}

/**
 * Execute one correction in the only safe durable order:
 * mutate -> publish -> commit -> checkpoint.
 *
 * Mutation failures are returned unchanged because no successful mutation
 * exists to roll back. Every later failure is rolled back before a typed error
 * is thrown. A rollback failure always invokes invalidation and produces the
 * distinct fail-closed error.
 */
export async function executeDurableCorrectionTransaction<
  TMutation,
  TPublication,
  TCommit,
  TCheckpoint,
>(
  steps: Readonly<
    DurableCorrectionTransactionSteps<
      TMutation,
      TPublication,
      TCommit,
      TCheckpoint
    >
  >,
): Promise<
  DurableCorrectionTransactionResult<
    TMutation,
    TPublication,
    TCommit,
    TCheckpoint
  >
> {
  // Deliberately outside the post-mutation catch: a failed mutation must not
  // call rollback or invalidation.
  const mutation = await steps.mutate();

  let failedStage: DurableCorrectionFailureStage = "publish";
  let publicationCompleted = false;
  let publication: TPublication | undefined;
  let commitCompleted = false;
  let commit: TCommit | undefined;

  try {
    publication = await steps.publish(mutation);
    publicationCompleted = true;

    failedStage = "commit";
    commit = await steps.commit(Object.freeze({ mutation, publication }));
    commitCompleted = true;

    failedStage = "checkpoint";
    const checkpoint = await steps.checkpoint(
      Object.freeze({ mutation, publication, commit }),
    );
    return Object.freeze({ mutation, publication, commit, checkpoint });
  } catch (failure) {
    const context = rollbackContext(
      failedStage,
      failure,
      mutation,
      publicationCompleted,
      publication,
      commitCompleted,
      commit,
    );
    try {
      await steps.rollback(context);
    } catch (rollbackFailure) {
      const invalidationContext = Object.freeze({
        ...context,
        rollbackFailure,
      });
      let invalidationFailure: unknown | null = null;
      try {
        await steps.invalidate(invalidationContext);
      } catch (failureDuringInvalidation) {
        invalidationFailure = failureDuringInvalidation;
      }
      throw new DurableCorrectionFailClosedError(
        failedStage,
        failure,
        rollbackFailure,
        invalidationFailure,
      );
    }
    throw new DurableCorrectionTransactionError(failedStage, failure);
  }
}
