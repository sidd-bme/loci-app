import { DurableOperationTracker } from "./durable-operations";

/**
 * Serializes project publications and source inspection requests.
 *
 * Project manifests capture source fingerprint state. Keeping both operations
 * on one ordered lane prevents an autosave from rejecting (or racing) the
 * next source in a batch preflight. Duplicate inspection requests for the
 * same source still share one promise.
 */
export class ProjectSourceOperationQueue {
  private readonly projectOperations = new DurableOperationTracker();
  private readonly sourceInspections = new DurableOperationTracker();
  private readonly pendingSourceInspections = new Map<string, Promise<unknown>>();
  private projectOperationCount = 0;
  private projectOperationTail: Promise<void> = Promise.resolve();

  get isProjectBusy(): boolean {
    return this.projectOperationCount > 0;
  }

  get isSourceInspectionBusy(): boolean {
    return this.pendingSourceInspections.size > 0;
  }

  runProject<T>(start: () => Promise<T>): Promise<T> {
    this.projectOperationCount += 1;
    const previous = this.projectOperationTail;
    const operation = this.projectOperations.run(async () => {
      await previous;
      await this.sourceInspections.waitForIdle();
      return start();
    });
    this.projectOperationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.finally(() => {
      this.projectOperationCount = Math.max(0, this.projectOperationCount - 1);
    });
  }

  runSourceOnce<T>(sourceId: string, start: () => Promise<T>): Promise<T> {
    const existing = this.pendingSourceInspections.get(sourceId);
    if (existing) return existing as Promise<T>;

    const operation = this.runProject(() => this.sourceInspections.run(start));
    this.pendingSourceInspections.set(sourceId, operation);
    void operation.then(
      () => this.pendingSourceInspections.delete(sourceId),
      () => this.pendingSourceInspections.delete(sourceId),
    );
    return operation;
  }

  async drainProjects(): Promise<void> {
    await this.projectOperations.drain();
  }

  async drainSourceInspections(): Promise<void> {
    await this.sourceInspections.drain();
  }
}
