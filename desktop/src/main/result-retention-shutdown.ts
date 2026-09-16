export interface ResultRetentionShutdownSteps {
  /** Seals the result publisher lane immediately and resolves when it is idle. */
  readonly drainResultLifecycle: () => Promise<void>;
  /** Seals project restore/checkpoint work that may establish result ownership. */
  readonly drainProjectOperations: () => Promise<void>;
  readonly cancelActiveAnalysis: () => Promise<void>;
  readonly drainLocalJobs: () => Promise<void>;
  /** Stops the worker after every result publisher has settled. */
  readonly disposeEngine: () => Promise<void>;
  /** Releases session ownership only when no publisher can add another ref. */
  readonly releaseSessionReferences: () => Promise<void>;
}

/**
 * Establish a hard shutdown boundary around result publication and retention.
 * Starting both durable drains first prevents a renderer IPC arriving during
 * cancellation from creating a reference after the release pass.
 */
export async function drainResultRetentionForShutdown(
  steps: Readonly<ResultRetentionShutdownSteps>,
): Promise<void> {
  const resultLifecycleDrain = steps.drainResultLifecycle();
  const projectOperationDrain = steps.drainProjectOperations();
  await steps.cancelActiveAnalysis();
  await Promise.all([
    resultLifecycleDrain,
    projectOperationDrain,
    steps.drainLocalJobs(),
  ]);
  await steps.disposeEngine();
  await steps.releaseSessionReferences();
}
