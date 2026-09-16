// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { drainResultRetentionForShutdown } from "./result-retention-shutdown";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("result-retention shutdown ordering", () => {
  it("settles every result publisher and the worker before releasing session refs", async () => {
    const lifecycle = deferred();
    const projects = deferred();
    const localJobs = deferred();
    const engine = deferred();
    const order: string[] = [];
    const releaseSessionReferences = vi.fn(async () => {
      order.push("retention:released");
    });

    const shutdown = drainResultRetentionForShutdown({
      drainResultLifecycle: () => {
        order.push("lifecycle:sealed");
        return lifecycle.promise;
      },
      drainProjectOperations: () => {
        order.push("projects:sealed");
        return projects.promise;
      },
      cancelActiveAnalysis: async () => {
        order.push("analysis:cancel-requested");
      },
      drainLocalJobs: () => {
        order.push("local-jobs:draining");
        return localJobs.promise;
      },
      disposeEngine: () => {
        order.push("engine:disposing");
        return engine.promise;
      },
      releaseSessionReferences,
    });

    await vi.waitFor(() => expect(order).toEqual([
      "lifecycle:sealed",
      "projects:sealed",
      "analysis:cancel-requested",
      "local-jobs:draining",
    ]));
    expect(releaseSessionReferences).not.toHaveBeenCalled();

    lifecycle.resolve();
    projects.resolve();
    localJobs.resolve();
    await vi.waitFor(() => expect(order).toContain("engine:disposing"));
    expect(releaseSessionReferences).not.toHaveBeenCalled();

    engine.resolve();
    await shutdown;
    expect(order.at(-1)).toBe("retention:released");
    expect(releaseSessionReferences).toHaveBeenCalledOnce();
  });

  it("does not release ownership when a publisher drain fails", async () => {
    const releaseSessionReferences = vi.fn(async () => undefined);
    const failure = new Error("publisher did not settle");

    await expect(drainResultRetentionForShutdown({
      drainResultLifecycle: async () => {
        throw failure;
      },
      drainProjectOperations: async () => undefined,
      cancelActiveAnalysis: async () => undefined,
      drainLocalJobs: async () => undefined,
      disposeEngine: async () => undefined,
      releaseSessionReferences,
    })).rejects.toBe(failure);

    expect(releaseSessionReferences).not.toHaveBeenCalled();
  });
});
