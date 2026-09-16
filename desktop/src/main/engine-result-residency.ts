// Engine result identifiers are URL-safe random tokens. Unlike UUID-backed
// identifiers, a valid token may begin with "-" or "_".
const RESULT_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVICTIONS_PER_RECEIPT = 10_000;

function resultId(value: unknown, label: string): string {
  if (typeof value !== "string" || !RESULT_ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function evictionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_EVICTIONS_PER_RECEIPT) {
    throw new Error("The analysis engine returned invalid result eviction provenance.");
  }
  const ids = value.map((candidate) => resultId(candidate, "An evicted result identifier"));
  if (new Set(ids).size !== ids.length) {
    throw new Error("The analysis engine returned duplicate result eviction provenance.");
  }
  return ids;
}

/**
 * Tracks only the engine worker's bounded in-memory result cache.
 *
 * Durable result identity, review metadata, and verified working-result packs
 * deliberately live elsewhere. An LRU eviction must never be interpreted as a
 * logical deletion of a research result.
 */
export class EngineResultResidencyCoordinator {
  private readonly residentResultIds = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();

  observe(resultIdValue: unknown, evictedResultIdsValue: unknown): void {
    const currentResultId = resultId(resultIdValue, "The current result identifier");
    const evictedResultIds = evictionIds(evictedResultIdsValue);
    if (evictedResultIds.includes(currentResultId)) {
      throw new Error("The analysis engine evicted the result it claimed to publish.");
    }
    for (const evictedResultId of evictedResultIds) {
      this.residentResultIds.delete(evictedResultId);
    }
    this.residentResultIds.add(currentResultId);
  }

  isResident(resultIdValue: unknown): boolean {
    return this.residentResultIds.has(resultId(resultIdValue, "The result identifier"));
  }

  discard(resultIdValue: unknown): void {
    this.residentResultIds.delete(resultId(resultIdValue, "The result identifier"));
  }

  invalidate(): void {
    this.residentResultIds.clear();
  }

  /**
   * Serialize restore plus cache-dependent work as one critical section.
   * Otherwise restoring result B can evict result A between A's restore and
   * export/correction request.
   */
  withResidentResult<T>(
    resultIdValue: unknown,
    restore: () => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const requestedResultId = resultId(resultIdValue, "The result identifier");
    let result!: T;
    const queued = this.operationQueue.then(async () => {
      if (!this.residentResultIds.has(requestedResultId)) {
        await restore();
      }
      if (!this.residentResultIds.has(requestedResultId)) {
        throw new Error("The verified working result was not restored into the analysis engine.");
      }
      result = await operation();
    });
    this.operationQueue = queued.catch(() => undefined);
    return queued.then(() => result);
  }

  runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let result!: T;
    let started = false;
    const queued = this.operationQueue.then(async () => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("The queued engine operation was cancelled.");
      }
      started = true;
      result = await operation();
    });
    this.operationQueue = queued.catch(() => undefined);
    if (!signal) return queued.then(() => result);

    // A local analysis can be accepted by LocalJobExecutor while it is still
    // waiting behind a restore/export in this independent residency queue. In
    // that window there is no worker request for cancelCurrent() to interrupt.
    // Settle the caller immediately, and leave a no-op queue entry behind so
    // the serialization order remains intact. Once work has actually started,
    // its owner must perform the normal process-boundary cancellation and
    // durable cleanup before the promise settles.
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        if (started) return;
        finish(() => reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("The queued engine operation was cancelled."),
        ));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void queued.then(
        () => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }
}
