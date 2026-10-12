// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { ViewerRequestQueue, VIEW_OPERATIONS, QUEUED_VIEW_OPERATIONS } from "./viewer-request-queue";

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

  it("coalesces large quantitative views without granting detached read access", async () => {
    expect(VIEW_OPERATIONS.has("large_result_view")).toBe(false);
    expect(QUEUED_VIEW_OPERATIONS.has("large_result_view")).toBe(true);
    expect(VIEW_OPERATIONS.has("large_result_locate")).toBe(false);
    expect(QUEUED_VIEW_OPERATIONS.has("large_result_locate")).toBe(true);
    const first = deferred<unknown>();
    const run = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue("latest");
    const queue = new ViewerRequestQueue(run);
    const active = queue.request("large_result_view", { region: 0 });
    const intermediate = queue.request("large_result_view", { region: 1 });
    const latest = queue.request("large_result_view", { region: 2 });
    await expect(intermediate).rejects.toThrow("superseded");
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve("first");
    await expect(active).resolves.toBe("first");
    await expect(latest).resolves.toBe("latest");
    expect(run.mock.calls.map(([, request]) => request)).toEqual([{ region: 0 }, { region: 2 }]);
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

  // Scoped cancellation and multi-window coordinator tests

  it("cancels active A while queued B waits for physical settlement and runs afterwards", async () => {
    const decodeA = deferred<string>();
    const decodeB = deferred<string>();
    const run = vi.fn()
      .mockImplementationOnce(() => decodeA.promise)
      .mockImplementationOnce(() => decodeB.promise);

    const queue = new ViewerRequestQueue(run);

    const promiseA = queue.request<string>("viewer_tile", { tile: "A" }, "lane-1", "scope-A");
    await Promise.resolve(); // Allow start(A) to run
    const promiseB = queue.request<string>("viewer_tile", { tile: "B" }, "lane-1", "scope-B");

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith("viewer_tile", { tile: "A" });

    // Cancel Scope A promptly
    queue.cancelScope("scope-A");

    // A's caller promise must reject promptly without waiting for worker
    await expect(promiseA).rejects.toThrow("View cancelled");

    // B has NOT started yet because A is still physically decoding on worker
    expect(run).toHaveBeenCalledTimes(1);

    // Now worker finishes physical decode of cancelled A
    decodeA.resolve("result-A");
    await Promise.resolve();

    // Now B starts decoding
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith("viewer_tile", { tile: "B" });

    // B finishes and resolves normally
    decodeB.resolve("result-B");
    await expect(promiseB).resolves.toBe("result-B");
  });

  it("cancels queued A while B is active without disturbing active B", async () => {
    const decodeB = deferred<string>();
    const run = vi.fn().mockImplementationOnce(() => decodeB.promise);
    const queue = new ViewerRequestQueue(run);

    const promiseB = queue.request<string>("viewer_tile", { tile: "B" }, "lane-1", "scope-B");
    await Promise.resolve();
    const promiseA = queue.request<string>("viewer_tile", { tile: "A" }, "lane-1", "scope-A");

    // Cancel Scope A while B is active
    queue.cancelScope("scope-A");

    // A is rejected immediately
    await expect(promiseA).rejects.toThrow("View cancelled");

    // Active B completes normally
    decodeB.resolve("result-B");
    await expect(promiseB).resolves.toBe("result-B");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("handles late success and late failure of cancelled active jobs without unhandled rejection", async () => {
    // 1. Late success: worker resolves after scope cancelled
    const decodeA1 = deferred<string>();
    const queue1 = new ViewerRequestQueue(() => decodeA1.promise);
    const promiseA1 = queue1.request<string>("viewer_tile", { id: 1 }, "default", "scope-A");
    await Promise.resolve();

    queue1.cancelScope("scope-A");
    await expect(promiseA1).rejects.toThrow("View cancelled");

    // Resolving late does not crash or throw unhandled rejection
    decodeA1.resolve("late-success");
    await Promise.resolve();

    // 2. Late failure: worker rejects after scope cancelled
    const decodeA2 = deferred<string>();
    const queue2 = new ViewerRequestQueue(() => decodeA2.promise);
    const promiseA2 = queue2.request<string>("viewer_tile", { id: 2 }, "default", "scope-A");
    await Promise.resolve();

    queue2.cancelScope("scope-A");
    await expect(promiseA2).rejects.toThrow("View cancelled");

    // Rejecting late does not crash or throw unhandled rejection
    decodeA2.reject(new Error("Physical worker fault"));
    await Promise.resolve();
  });

  it("is safe and idempotent under repeated cancellation", async () => {
    const decode = deferred<string>();
    const queue = new ViewerRequestQueue(() => decode.promise);

    const promise = queue.request<string>("viewer_tile", {}, "default", "scope-A");
    await Promise.resolve();

    queue.cancelScope("scope-A");
    queue.cancelScope("scope-A");
    queue.cancelScope("scope-A");

    await expect(promise).rejects.toThrow("View cancelled");
    decode.resolve("ok");
    await Promise.resolve();
  });

  it("allows subsequent requests in the same scope to execute normally after cancellation", async () => {
    const decode1 = deferred<string>();
    const decode2 = deferred<string>();
    const run = vi.fn()
      .mockImplementationOnce(() => decode1.promise)
      .mockImplementationOnce(() => decode2.promise);

    const queue = new ViewerRequestQueue(run);

    const promise1 = queue.request<string>("viewer_tile", { pass: 1 }, "default", "scope-A");
    await Promise.resolve();

    queue.cancelScope("scope-A");
    await expect(promise1).rejects.toThrow("View cancelled");
    decode1.resolve("done-1");
    await Promise.resolve();

    // New request in the same scope
    const promise2 = queue.request<string>("viewer_tile", { pass: 2 }, "default", "scope-A");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    decode2.resolve("done-2");
    await expect(promise2).resolves.toBe("done-2");
  });

  it("maintains independent A/B sub-lanes across scopes", async () => {
    const active = deferred<string>();
    const run = vi.fn()
      .mockImplementationOnce(() => active.promise)
      .mockImplementation(async (_op, req) => req);

    const queue = new ViewerRequestQueue(run);

    const first = queue.request("viewer_tile", { id: "active" }, "lane-a", "scope-1");
    await Promise.resolve();

    const p1A = queue.request("viewer_tile", { id: "1-A" }, "lane-a", "scope-1");
    const p1B = queue.request("viewer_tile", { id: "1-B" }, "lane-b", "scope-1");
    const p2A = queue.request("viewer_tile", { id: "2-A" }, "lane-a", "scope-2");
    const p2B = queue.request("viewer_tile", { id: "2-B" }, "lane-b", "scope-2");

    active.resolve("active-done");
    await expect(first).resolves.toBe("active-done");

    await expect(p1A).resolves.toEqual({ id: "1-A" });
    await expect(p1B).resolves.toEqual({ id: "1-B" });
    await expect(p2A).resolves.toEqual({ id: "2-A" });
    await expect(p2B).resolves.toEqual({ id: "2-B" });
  });

  it("enforces the global limit of 32 pending lanes across all scopes", async () => {
    const active = deferred<string>();
    const queue = new ViewerRequestQueue(() => active.promise);

    const activeReq = queue.request("viewer_tile", {}, "lane-0", "scope-0");

    // Fill 16 in scope-1 and 16 in scope-2 (total 32 pending)
    const pendingList: Promise<unknown>[] = [];
    for (let i = 0; i < 16; i++) {
      pendingList.push(queue.request("viewer_tile", { i }, `lane-${i}`, "scope-1"));
    }
    for (let i = 0; i < 16; i++) {
      pendingList.push(queue.request("viewer_tile", { i }, `lane-${i}`, "scope-2"));
    }

    // 33rd pending request in scope-3 must be rejected by global bound
    await expect(queue.request("viewer_tile", {}, "overflow", "scope-3")).rejects.toThrow(
      "Too many independent viewer requests are waiting.",
    );

    queue.cancelPending();
    await Promise.all(pendingList.map((p) => expect(p).rejects.toThrow("cancelled")));
    active.resolve("done");
    await expect(activeReq).resolves.toBe("done");
  });

  it("validates scope and lane string inputs", async () => {
    const queue = new ViewerRequestQueue(async () => "ok");

    await expect(queue.request("viewer_tile", {}, "default", "")).rejects.toThrow(
      "Invalid viewer scheduling scope",
    );
    await expect(queue.request("viewer_tile", {}, "default", "scope\0null")).rejects.toThrow(
      "Invalid viewer scheduling scope",
    );
    await expect(queue.request("viewer_tile", {}, "", "main")).rejects.toThrow(
      "Invalid viewer scheduling lane",
    );
    await expect(queue.request("viewer_tile", {}, "lane\0null", "main")).rejects.toThrow(
      "Invalid viewer scheduling lane",
    );
  });
});
