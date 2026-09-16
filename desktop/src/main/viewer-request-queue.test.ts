// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { ViewerRequestQueue } from "./viewer-request-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("ViewerRequestQueue", () => {
  it("runs one request and retains only the newest pending request", async () => {
    const first = deferred<unknown>();
    const latest = deferred<unknown>();
    const run = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise);
    const queue = new ViewerRequestQueue(run);

    const active = queue.request("viewer_tile", { z: 0 });
    await Promise.resolve();
    const replaced = queue.request("viewer_tile", { z: 1 });
    const pending = queue.request("viewer_tile", { z: 2 });

    await expect(replaced).rejects.toThrow("superseded by a newer request");
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve("first");
    await expect(active).resolves.toBe("first");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith("viewer_tile", { z: 2 });
    latest.resolve("latest");
    await expect(pending).resolves.toBe("latest");
  });

  it("cancels the pending request without disturbing the active request", async () => {
    const first = deferred<unknown>();
    const run = vi.fn(() => first.promise);
    const queue = new ViewerRequestQueue(run);
    const active = queue.request("result_view", { index: 0 });
    await Promise.resolve();
    const pending = queue.request("result_view", { index: 1 });

    queue.cancelPending();
    await expect(pending).rejects.toThrow("View cancelled");
    first.resolve("kept");
    await expect(active).resolves.toBe("kept");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retains a result plane when independent source tiles arrive", async () => {
    const first = deferred<unknown>();
    const run = vi.fn().mockImplementationOnce(() => first.promise)
      .mockImplementation(async (operation, request) => ({ operation, request }));
    const queue = new ViewerRequestQueue(run);
    const active = queue.request("viewer_tile", { tile: 0 });
    const result = queue.request("result_view", { revision: "exact", index: 0 });
    const replaced = queue.request("viewer_tile", { tile: 1 });
    const latest = queue.request("viewer_tile", { tile: 2 });
    await expect(replaced).rejects.toThrow("superseded");
    first.resolve("source");
    await expect(active).resolves.toBe("source");
    await expect(result).resolves.toEqual({ operation: "result_view", request: { revision: "exact", index: 0 } });
    await expect(latest).resolves.toEqual({ operation: "viewer_tile", request: { tile: 2 } });
    expect(run.mock.calls.map(([operation]) => operation)).toEqual(["viewer_tile", "result_view", "viewer_tile"]);
  });

  it("retains concurrent A/B requests while superseding stale work within each pane", async () => {
    const first = deferred<unknown>();
    const run = vi.fn().mockImplementationOnce(() => first.promise)
      .mockImplementation(async (_operation, request) => request);
    const queue = new ViewerRequestQueue(run);

    const activeA = queue.request("viewer_tile", { pane: "A", tile: 0 }, "comparison-a");
    await Promise.resolve();
    const staleA = queue.request("viewer_tile", { pane: "A", tile: 1 }, "comparison-a");
    const paneB = queue.request("viewer_tile", { pane: "B", tile: 0 }, "comparison-b");
    const latestA = queue.request("viewer_tile", { pane: "A", tile: 2 }, "comparison-a");

    await expect(staleA).rejects.toThrow("superseded by a newer request");
    first.resolve({ pane: "A", tile: 0 });
    await expect(activeA).resolves.toEqual({ pane: "A", tile: 0 });
    await expect(paneB).resolves.toEqual({ pane: "B", tile: 0 });
    await expect(latestA).resolves.toEqual({ pane: "A", tile: 2 });
    expect(run.mock.calls.map(([, request]) => request)).toEqual([
      { pane: "A", tile: 0 },
      { pane: "B", tile: 0 },
      { pane: "A", tile: 2 },
    ]);
  });

  it("bounds pending lanes to supported kinds and cancels every lane", async () => {
    const first = deferred<unknown>();
    const queue = new ViewerRequestQueue(() => first.promise);
    const active = queue.request("viewer_tile", {});
    const result = queue.request("result_view", {});
    const volume = queue.request("viewer_volume", {});
    await expect(queue.request("unbounded-lane", {})).rejects.toThrow("Unsupported");
    queue.cancelPending();
    await expect(result).rejects.toThrow("cancelled");
    await expect(volume).rejects.toThrow("cancelled");
    first.resolve("done");
    await expect(active).resolves.toBe("done");
  });

  it("rejects a new lane when the bounded pending queue is full", async () => {
    const first = deferred<unknown>();
    const queue = new ViewerRequestQueue(() => first.promise);
    const active = queue.request("viewer_tile", {}, "active");
    const pending = Array.from({ length: 32 }, (_, index) =>
      queue.request("viewer_tile", { index }, `pane-${index}`));

    await expect(queue.request("viewer_tile", {}, "overflow"))
      .rejects.toThrow("Too many independent viewer requests");
    queue.cancelPending();
    await Promise.all(pending.map((request) => expect(request).rejects.toThrow("cancelled")));
    first.resolve("done");
    await expect(active).resolves.toBe("done");
  });
});
