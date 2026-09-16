/**
 * Keep the durable project document ahead of its working-result ownership
 * ledger. The project file is the authority that tells recovery which packs it
 * needs, so ownership must never move to a new manifest before that manifest is
 * durably published.
 */

export type ProjectRetentionAwaitable<T> = T | PromiseLike<T>;

export interface ProjectRetentionCheckpointSteps<TPersisted, TRolledBack> {
  /** Atomically publish the new project document. */
  readonly persist: () => ProjectRetentionAwaitable<TPersisted>;
  /** Reconcile ownership only after `persist` has completed. */
  readonly reconcile: (
    persisted: TPersisted,
  ) => ProjectRetentionAwaitable<void>;
  /** Restore the previous project document if reconciliation fails normally. */
  readonly rollbackPersistence: (
    persisted: TPersisted,
    failure: unknown,
  ) => ProjectRetentionAwaitable<TRolledBack>;
  /** Reassert the previous ownership set after the document rollback. */
  readonly reconcilePrevious: (
    rolledBack: TRolledBack,
    failure: unknown,
  ) => ProjectRetentionAwaitable<void>;
}

export class ProjectRetentionCheckpointError<TRolledBack = unknown> extends Error {
  readonly code = "project-retention-checkpoint-rolled-back" as const;

  constructor(
    cause: unknown,
    readonly rolledBack: TRolledBack,
  ) {
    super(
      "Working-result ownership could not be updated; the previous project checkpoint was restored.",
      { cause },
    );
    this.name = "ProjectRetentionCheckpointError";
  }
}

export class ProjectRetentionCheckpointFailClosedError<TPersisted = unknown> extends Error {
  readonly code = "project-retention-checkpoint-fail-closed" as const;

  constructor(
    cause: unknown,
    readonly rollbackFailure: unknown,
    readonly persisted: TPersisted,
  ) {
    super(
      "The project was saved, but working-result ownership and project rollback could not both be verified.",
      { cause },
    );
    this.name = "ProjectRetentionCheckpointFailClosedError";
  }
}

/**
 * Publish a project checkpoint before changing its pack ownership.
 *
 * A persistence failure cannot call `reconcile`, leaving the prior ownership
 * set untouched. A later reconciliation failure compensates by durably
 * restoring the prior document and ownership set before reporting failure.
 */
export async function checkpointProjectBeforeRetention<
  TPersisted,
  TRolledBack,
>(
  steps: Readonly<ProjectRetentionCheckpointSteps<TPersisted, TRolledBack>>,
): Promise<TPersisted> {
  const persisted = await steps.persist();
  try {
    await steps.reconcile(persisted);
    return persisted;
  } catch (failure) {
    let rolledBack: TRolledBack;
    try {
      rolledBack = await steps.rollbackPersistence(persisted, failure);
      await steps.reconcilePrevious(rolledBack, failure);
    } catch (rollbackFailure) {
      throw new ProjectRetentionCheckpointFailClosedError(
        failure,
        rollbackFailure,
        persisted,
      );
    }
    throw new ProjectRetentionCheckpointError(failure, rolledBack);
  }
}

export interface ProjectRestoreRetentionSteps<TInstalled> {
  /** Verify and publish the opened project's complete pack ownership set. */
  readonly reconcile: () => ProjectRetentionAwaitable<void>;
  /** Replace the current in-memory session only after ownership is verified. */
  readonly install: () => ProjectRetentionAwaitable<TInstalled>;
}

/**
 * Fail closed while opening a project: an invalid/missing retention set must
 * not displace the currently usable session or expose unrestorable bindings.
 */
export async function restoreProjectAfterRetention<TInstalled>(
  steps: Readonly<ProjectRestoreRetentionSteps<TInstalled>>,
): Promise<TInstalled> {
  await steps.reconcile();
  return steps.install();
}
