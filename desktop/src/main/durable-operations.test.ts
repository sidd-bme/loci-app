// @vitest-environment node

import { describe, expect, it } from "vitest";

import { DurableOperationTracker } from "./durable-operations";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, reject, resolve };
}

describe("DurableOperationTracker", () => {
  it("does not finish draining until every registered publication settles", async () => {
    const tracker = new DurableOperationTracker();
    const first = deferred<string>();
    const second = deferred<string>();
    const firstOperation = tracker.run(() => first.promise);
    const secondOperation = tracker.run(() => second.promise);
    let drained = false;
    const draining = tracker.drain().then(() => {
      drained = true;
    });

    first.resolve("summary");
    await firstOperation;
    await Promise.resolve();
    expect(drained).toBe(false);

    second.resolve("manifest");
    await expect(secondOperation).resolves.toBe("manifest");
    await draining;
    expect(drained).toBe(true);
  });

  it("waits for failed work but does not make application shutdown fail", async () => {
    const tracker = new DurableOperationTracker();
    const publication = deferred<void>();
    const operation = tracker.run(() => publication.promise);
    const draining = tracker.drain();

    publication.reject(new Error("disk full"));

    await expect(operation).rejects.toThrow("disk full");
    await expect(draining).resolves.toBeUndefined();
  });

  it("rejects new publications once shutdown draining starts", async () => {
    const tracker = new DurableOperationTracker();
    await tracker.drain();

    await expect(tracker.run(async () => "late")).rejects.toThrow(/shutting down/i);
  });

  it("coalesces duplicate keyed finalizations into one publication", async () => {
    const tracker = new DurableOperationTracker();
    const publication = deferred<string>();
    let starts = 0;
    const start = () => {
      starts += 1;
      return publication.promise;
    };

    const first = tracker.runOnce("batch-1", start);
    const duplicate = tracker.runOnce("batch-1", start);
    expect(duplicate).toBe(first);
    expect(starts).toBe(1);

    publication.resolve("manifest");
    await expect(Promise.all([first, duplicate])).resolves.toEqual(["manifest", "manifest"]);
  });
});
