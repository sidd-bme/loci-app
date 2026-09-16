// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { ProjectSourceOperationQueue } from "./project-source-operations";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

describe("ProjectSourceOperationQueue", () => {
  it("waits for an in-flight project autosave before starting batch source inspection", async () => {
    const queue = new ProjectSourceOperationQueue();
    const autosave = deferred<void>();
    const order: string[] = [];

    const saving = queue.runProject(async () => {
      order.push("save-start");
      await autosave.promise;
      order.push("save-finish");
    });
    const inspect = vi.fn(async () => {
      order.push("inspect");
      return "ready";
    });
    const inspecting = queue.runSourceOnce("source-1", inspect);

    await vi.waitFor(() => expect(order).toEqual(["save-start"]));
    expect(inspect).not.toHaveBeenCalled();
    expect(queue.isProjectBusy).toBe(true);

    autosave.resolve();
    await expect(Promise.all([saving, inspecting])).resolves.toEqual([undefined, "ready"]);
    expect(order).toEqual(["save-start", "save-finish", "inspect"]);
  });

  it("coalesces duplicate source requests while they wait behind a project operation", async () => {
    const queue = new ProjectSourceOperationQueue();
    const autosave = deferred<void>();
    const saving = queue.runProject(() => autosave.promise);
    const inspect = vi.fn(async () => "ready");

    const first = queue.runSourceOnce("source-1", inspect);
    const duplicate = queue.runSourceOnce("source-1", inspect);
    expect(duplicate).toBe(first);
    expect(queue.isSourceInspectionBusy).toBe(true);

    autosave.resolve();
    await saving;
    await expect(Promise.all([first, duplicate])).resolves.toEqual(["ready", "ready"]);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(queue.isSourceInspectionBusy).toBe(false);
  });

  it("does not let a later project save overlap a source inspection", async () => {
    const queue = new ProjectSourceOperationQueue();
    const inspection = deferred<void>();
    const order: string[] = [];

    const inspecting = queue.runSourceOnce("source-1", async () => {
      order.push("inspect-start");
      await inspection.promise;
      order.push("inspect-finish");
    });
    const saving = queue.runProject(async () => {
      order.push("save");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["inspect-start"]);

    inspection.resolve();
    await Promise.all([inspecting, saving]);
    expect(order).toEqual(["inspect-start", "inspect-finish", "save"]);
  });
});
