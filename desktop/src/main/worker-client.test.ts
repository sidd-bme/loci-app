// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnedChildren = vi.hoisted(() => [] as MockChild[]);

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => "/tmp/loci-test",
  },
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new MockChild();
    spawnedChildren.push(child);
    return child;
  }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

import { EngineWorkerClient, sanitizedWorkerErrorMessage } from "./worker-client";

class MockChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  killed = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk) => this.writes.push(String(chunk)));
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  respond(result: unknown): void {
    this.respondTo(this.writes.length - 1, result);
  }

  respondTo(writeIndex: number, result: unknown): void {
    const request = JSON.parse(this.writes.at(writeIndex) ?? "{}") as { id?: string };
    this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }
}

describe("EngineWorkerClient", () => {
  it("supervises a research job without an immediate zero timeout and can cancel it", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const pending = client.request("research_run", { job_id: "a".repeat(32) }, 0);
    const rejection = expect(pending).rejects.toThrow("Analysis cancelled.");
    await vi.advanceTimersByTimeAsync(5000);
    expect(spawnedChildren[0].killed).toBe(false);
    expect(client.cancelCurrent()).toBe(true);
    await rejection;
    await client.dispose();
  });
  beforeEach(() => {
    spawnedChildren.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const child of spawnedChildren) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  it("redacts canonical local paths before an engine error can cross IPC", () => {
    expect(sanitizedWorkerErrorMessage(
      "Image does not exist: /Volumes/lab/study/private field.tif",
    )).toBe("Image does not exist: <local path>");
    expect(sanitizedWorkerErrorMessage(
      "Could not decode '/Users/researcher/Downloads/field.tif' safely.",
    )).toBe("Could not decode '<local path>' safely.");
    expect(sanitizedWorkerErrorMessage(
      "Image does not exist: /data/study/input.tif",
    )).toBe("Image does not exist: <local path>");
    expect(sanitizedWorkerErrorMessage(
      "Decoder failed under /System/Library/Frameworks/ImageIO.framework",
    )).toBe("Decoder failed under <local path>");
  });

  it("redacts a path-bearing worker process failure for requests and listeners", async () => {
    const client = new EngineWorkerClient();
    const invalidated = vi.fn();
    client.onInvalidated(invalidated);
    const inspection = client.request("inspect", {});
    const child = spawnedChildren[0];

    child.emit("error", new Error("spawn /Users/researcher/private/loci-engine ENOENT"));

    await expect(inspection).rejects.toThrow("spawn <local path>");
    expect(invalidated).toHaveBeenCalledWith({
      generation: 1,
      reason: expect.objectContaining({ message: "spawn <local path>" }),
    });
    await client.dispose();
  });

  it("bounds an unterminated stdout message before constructing a JSON line", async () => {
    const client = new EngineWorkerClient(64);
    const request = client.request("health", {});
    const rejection = expect(request).rejects.toThrow("bounded message size");
    const first = spawnedChildren[0];

    first.stdout.write(Buffer.alloc(65, 0x78));
    await rejection;
    expect(first.killed).toBe(true);

    const replacement = client.request<string>("health", {});
    spawnedChildren[1].respond("ready");
    await expect(replacement).resolves.toBe("ready");
    await client.dispose();
  });

  it("accepts a bounded JSON response fragmented across stdout chunks", async () => {
    const client = new EngineWorkerClient(1024);
    const request = client.request<{ status: string }>("health", {});
    const child = spawnedChildren[0];
    const responseId = (JSON.parse(child.writes[0]) as { id: string }).id;
    const response = Buffer.from(JSON.stringify({ id: responseId, result: { status: "ready" } }) + "\n");

    child.stdout.write(response.subarray(0, 11));
    child.stdout.write(response.subarray(11));
    await expect(request).resolves.toEqual({ status: "ready" });
    await client.dispose();
  });

  it("keeps a replacement worker alive when the cancelled worker exits late", async () => {
    const client = new EngineWorkerClient();
    const invalidated = vi.fn();
    client.onInvalidated(invalidated);

    const first = client.request("segment", { source: "first" });
    const firstRejection = expect(first).rejects.toThrow("Analysis cancelled.");
    const firstChild = spawnedChildren[0];
    expect(client.cancelCurrent()).toBe(true);
    await firstRejection;

    const second = client.request<{ count: number }>("segment", { source: "second" });
    const secondChild = spawnedChildren[1];
    firstChild.emit("exit", null, "SIGTERM");
    firstChild.emit("error", new Error("late old-worker error"));

    secondChild.respond({ count: 42 });
    await expect(second).resolves.toEqual({ count: 42 });
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(invalidated).toHaveBeenCalledWith({
      generation: 1,
      reason: expect.objectContaining({ message: "Analysis cancelled." }),
    });

    await client.dispose();
  });

  it("rejects a pre-cancelled request before spawning or registering worker work", async () => {
    const client = new EngineWorkerClient();
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before worker registration"));

    await expect(client.request("segment", { source: "late" }, 180_000, controller.signal))
      .rejects.toThrow("Analysis cancelled.");
    expect(spawnedChildren).toHaveLength(0);
    expect(client.cancelCurrent()).toBe(false);
    await client.dispose();
  });

  it("allows an in-flight export to finish instead of terminating its worker", async () => {
    const client = new EngineWorkerClient();
    const invalidated = vi.fn();
    client.onInvalidated(invalidated);

    const exporting = client.request<{ bundleName: string }>("export", {
      resultId: "result-1",
    });
    const child = spawnedChildren[0];

    expect(client.cancelCurrent()).toBe(false);
    expect(child.killed).toBe(false);

    child.respond({ bundleName: "sample_loci" });
    await expect(exporting).resolves.toEqual({ bundleName: "sample_loci" });
    expect(invalidated).not.toHaveBeenCalled();

    await client.dispose();
  });

  it("does not apply the generic request timeout to a durable export", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const exporting = client.request<{ bundleName: string }>("export", {}, 50);
    const child = spawnedChildren[0];

    await vi.advanceTimersByTimeAsync(500);
    expect(child.killed).toBe(false);

    child.respond({ bundleName: "slow_loci" });
    await expect(exporting).resolves.toEqual({ bundleName: "slow_loci" });
    await client.dispose();
  });

  it("treats a rendered-view export as durable publication", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const exporting = client.request<{ path: string }>("export_view", {}, 50);
    const child = spawnedChildren[0];

    await vi.advanceTimersByTimeAsync(500);
    expect(child.killed).toBe(false);

    child.respond({ path: "/exports/view.tiff" });
    await expect(exporting).resolves.toEqual({ path: "/exports/view.tiff" });
    await client.dispose();
  });

  it.each(["publish_working_result", "restore_working_result", "research_project_clone"])(
    "treats %s as durable result-state publication",
    async (method) => {
      vi.useFakeTimers();
      const client = new EngineWorkerClient();
      const operation = client.request<{ resultId: string }>(method, {}, 50);
      const child = spawnedChildren[0];

      await vi.advanceTimersByTimeAsync(500);
      expect(child.killed).toBe(false);

      child.respond({ resultId: "result-1" });
      await expect(operation).resolves.toEqual({ resultId: "result-1" });
      await client.dispose();
    },
  );

  it("waits for an in-flight export before disposing its worker", async () => {
    const client = new EngineWorkerClient();
    const exporting = client.request<{ bundleName: string }>("export", {});
    const child = spawnedChildren[0];
    let disposed = false;

    const disposal = client.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(child.killed).toBe(false);

    child.respond({ bundleName: "drained_loci" });
    await expect(exporting).resolves.toEqual({ bundleName: "drained_loci" });
    await disposal;
    expect(disposed).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("waits for in-flight batch metadata publication before disposing", async () => {
    const client = new EngineWorkerClient();
    const publishing = client.request<{ files: Record<string, string> }>(
      "publish_batch_metadata",
      {},
    );
    const child = spawnedChildren[0];
    let disposed = false;

    const disposal = client.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(child.killed).toBe(false);

    child.respond({ files: { manifest: "/batch/manifest.json" } });
    await expect(publishing).resolves.toEqual({
      files: { manifest: "/batch/manifest.json" },
    });
    await disposal;
    expect(disposed).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("can force-dispose a worker after a durable shutdown grace period", async () => {
    const client = new EngineWorkerClient();
    const exporting = client.request("export", {});
    const exportRejection = expect(exporting).rejects.toThrow("Force quit requested");
    const child = spawnedChildren[0];
    let disposed = false;
    const disposal = client.dispose().then(() => {
      disposed = true;
    });

    await Promise.resolve();
    expect(disposed).toBe(false);
    client.forceDispose(new Error("Force quit requested"));

    await exportRejection;
    await disposal;
    expect(disposed).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("does not let a later request timeout kill an active export", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const exporting = client.request<{ bundleName: string }>("export", {});
    const laterInspection = client.request("inspect", {}, 50);
    const inspectionRejection = expect(laterInspection).rejects.toThrow(
      "inspect operation timed out",
    );
    const child = spawnedChildren[0];

    await vi.advanceTimersByTimeAsync(50);
    await inspectionRejection;
    expect(child.killed).toBe(false);

    child.respondTo(0, { bundleName: "protected_loci" });
    await expect(exporting).resolves.toEqual({ bundleName: "protected_loci" });
    await client.dispose();
  });

  it("does not protect an export queued behind a timed-out request", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const inspection = client.request("inspect", {}, 50);
    const exporting = client.request("export", {});
    const inspectionRejection = expect(inspection).rejects.toThrow(
      "inspect operation timed out",
    );
    const exportRejection = expect(exporting).rejects.toThrow(
      "inspect operation timed out",
    );
    const child = spawnedChildren[0];

    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([inspectionRejection, exportRejection]);
    expect(child.killed).toBe(true);
    await client.dispose();
  });

  it("allows cancellation before a queued export has started", async () => {
    const client = new EngineWorkerClient();
    const segmenting = client.request("segment", {});
    const exporting = client.request("export", {});
    const segmentRejection = expect(segmenting).rejects.toThrow("Analysis cancelled.");
    const exportRejection = expect(exporting).rejects.toThrow("Analysis cancelled.");
    const child = spawnedChildren[0];

    expect(client.cancelCurrent()).toBe(true);
    await Promise.all([segmentRejection, exportRejection]);
    expect(child.killed).toBe(true);
    await client.dispose();
  });

  it("cancels segmentation even when preview inspection is queued on the same worker", async () => {
    const client = new EngineWorkerClient();
    const inspect = client.request("inspect", { source: "plate-a" });
    const segment = client.request("segment", { source: "plate-a" });
    const inspectRejection = expect(inspect).rejects.toThrow("Analysis cancelled.");
    const segmentRejection = expect(segment).rejects.toThrow("Analysis cancelled.");
    const child = spawnedChildren[0];

    expect(client.cancelCurrent()).toBe(true);
    expect(child.killed).toBe(true);
    await Promise.all([inspectRejection, segmentRejection]);

    await client.dispose();
  });

  it("does not terminate a worker when no cancellable request is pending", async () => {
    const client = new EngineWorkerClient();
    const health = client.request<string>("health", {});
    const child = spawnedChildren[0];
    child.respond("ready");
    await expect(health).resolves.toBe("ready");

    expect(client.cancelCurrent()).toBe(false);
    expect(child.killed).toBe(false);

    await client.dispose();
  });

  it("invalidates a timed-out generation once and accepts work on the next generation", async () => {
    vi.useFakeTimers();
    const client = new EngineWorkerClient();
    const invalidated = vi.fn();
    client.onInvalidated(invalidated);

    const timedOut = client.request("inspect", {}, 50);
    const timedOutRejection = expect(timedOut).rejects.toThrow("inspect operation timed out");
    const firstChild = spawnedChildren[0];
    await vi.advanceTimersByTimeAsync(50);
    await timedOutRejection;

    const next = client.request<string>("inspect", {}, 50);
    const secondChild = spawnedChildren[1];
    firstChild.emit("exit", null, "SIGTERM");
    secondChild.respond("ready");

    await expect(next).resolves.toBe("ready");
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(invalidated.mock.calls[0][0].generation).toBe(1);
    expect(invalidated.mock.calls[0][0].reason.message).toContain("inspect operation timed out");

    await client.dispose();
  });
});
