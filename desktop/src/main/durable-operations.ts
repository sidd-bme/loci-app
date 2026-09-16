/**
 * Tracks small main-process publications that must settle before Electron exits.
 *
 * Worker exports have their own drain semantics. Batch summaries and manifests
 * are written by the main process, so they need an equivalent lifetime guard.
 */
export class DurableOperationTracker {
  private readonly active = new Set<Promise<void>>();
  private readonly keyed = new Map<string, Promise<unknown>>();
  private draining = false;

  get isBusy(): boolean {
    return this.active.size > 0;
  }

  run<T>(start: () => Promise<T>): Promise<T> {
    if (this.draining) {
      return Promise.reject(new Error("Loci is shutting down; no new durable operation can start."));
    }

    let operation: Promise<T>;
    try {
      operation = Promise.resolve(start());
    } catch (error) {
      operation = Promise.reject(error);
    }
    const settlement = operation.then(
      () => undefined,
      () => undefined,
    );
    this.active.add(settlement);
    void settlement.finally(() => this.active.delete(settlement));
    return operation;
  }

  runOnce<T>(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.keyed.get(key);
    if (existing) return existing as Promise<T>;
    const operation = this.run(start);
    this.keyed.set(key, operation);
    void operation.then(
      () => this.keyed.delete(key),
      () => this.keyed.delete(key),
    );
    return operation;
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size) {
      await Promise.all([...this.active]);
    }
  }

  async drain(): Promise<void> {
    this.draining = true;
    await this.waitForIdle();
  }
}
