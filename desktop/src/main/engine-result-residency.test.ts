import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { EngineResultResidencyCoordinator } from "./engine-result-residency";
import {
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
  verifyStoredWorkingResultArtifact,
} from "./working-result-publication";

describe("EngineResultResidencyCoordinator", () => {
  it("accepts every valid leading character produced by URL-safe result tokens", () => {
    const coordinator = new EngineResultResidencyCoordinator();

    coordinator.observe("_result-a", []);
    coordinator.observe("-result-b", ["_result-a"]);

    expect(coordinator.isResident("-result-b")).toBe(true);
    expect(coordinator.isResident("_result-a")).toBe(false);
  });

  it("keeps arbitrarily many durable results usable across an eight-entry engine LRU", async () => {
    const coordinator = new EngineResultResidencyCoordinator();
    const residentOrder: string[] = [];
    const restore = vi.fn(async (requested: string) => {
      const existingIndex = residentOrder.indexOf(requested);
      if (existingIndex >= 0) residentOrder.splice(existingIndex, 1);
      residentOrder.push(requested);
      const evicted = residentOrder.length > 8 ? residentOrder.splice(0, 1) : [];
      coordinator.observe(requested, evicted);
    });

    for (let index = 1; index <= 12; index += 1) {
      const id = `result-${index}`;
      const evicted = index > 8 ? [`result-${index - 8}`] : [];
      coordinator.observe(id, evicted);
      residentOrder.push(id);
      if (residentOrder.length > 8) residentOrder.shift();
    }

    const exported: string[] = [];
    for (let index = 1; index <= 12; index += 1) {
      const id = `result-${index}`;
      await coordinator.withResidentResult(
        id,
        () => restore(id),
        async () => exported.push(id),
      );
    }

    expect(exported).toEqual(Array.from({ length: 12 }, (_, index) => `result-${index + 1}`));
    expect(restore).toHaveBeenCalledTimes(12);
  });

  it("serializes restore and operation so another restore cannot evict the requested result between them", async () => {
    const coordinator = new EngineResultResidencyCoordinator();
    const order: string[] = [];
    const first = coordinator.withResidentResult(
      "result-a",
      async () => {
        order.push("restore-a");
        coordinator.observe("result-a", []);
      },
      async () => {
        order.push("export-a");
      },
    );
    const second = coordinator.withResidentResult(
      "result-b",
      async () => {
        order.push("restore-b");
        coordinator.observe("result-b", ["result-a"]);
      },
      async () => {
        order.push("export-b");
      },
    );

    await Promise.all([first, second]);
    expect(order).toEqual(["restore-a", "export-a", "restore-b", "export-b"]);
  });

  it("settles cancellation while an exclusive operation is still queued and never enters that work", async () => {
    const coordinator = new EngineResultResidencyCoordinator();
    let releaseBlockingOperation!: () => void;
    const blockingOperation = new Promise<void>((resolve) => {
      releaseBlockingOperation = resolve;
    });
    const first = coordinator.runExclusive(() => blockingOperation);
    const controller = new AbortController();
    const queuedWork = vi.fn(async () => "should not run");
    const second = coordinator.runExclusive(queuedWork, controller.signal);

    controller.abort(new Error("Cancelled while waiting for engine residency"));

    await expect(second).rejects.toThrow("Cancelled while waiting for engine residency");
    expect(queuedWork).not.toHaveBeenCalled();

    releaseBlockingOperation();
    await first;
    // Let the preserved no-op queue entry drain after the first operation.
    await coordinator.runExclusive(async () => undefined);
    expect(queuedWork).not.toHaveBeenCalled();
  });

  it("does not settle early when cancellation arrives after exclusive work started", async () => {
    const coordinator = new EngineResultResidencyCoordinator();
    const controller = new AbortController();
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => { operationStarted = resolve; });
    let releaseOperation!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseOperation = resolve; });
    const operation = coordinator.runExclusive(async () => {
      operationStarted();
      await blocked;
      if (controller.signal.aborted) throw controller.signal.reason;
      return "complete";
    }, controller.signal);

    await started;
    controller.abort(new Error("Cancelled after engine work started"));
    let settled = false;
    void operation.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseOperation();
    await expect(operation).rejects.toThrow("Cancelled after engine work started");
  });

  it.each(["missing", "corrupt"])("fails closed when the %s durable pack cannot be verified", async (kind) => {
    const coordinator = new EngineResultResidencyCoordinator();
    const operation = vi.fn(async () => undefined);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "loci-residency-"));
    const filename = "working-job01-r0.loci-result";
    const packPath = path.join(directory, filename);
    const expectedPayload = Buffer.from("expected immutable working result");
    if (kind === "corrupt") await fs.writeFile(packPath, "tampered");
    const artifact = {
      artifactId: WORKING_RESULT_ARTIFACT_ID,
      filename,
      mediaType: WORKING_RESULT_MEDIA_TYPE,
      byteLength: expectedPayload.byteLength,
      sha256: createHash("sha256").update(expectedPayload).digest("hex"),
    };

    try {
      await expect(coordinator.withResidentResult(
        "result-1",
        async () => {
          await verifyStoredWorkingResultArtifact(packPath, artifact);
          coordinator.observe("result-1", []);
        },
        operation,
      )).rejects.toThrow();
      expect(operation).not.toHaveBeenCalled();
      expect(coordinator.isResident("result-1")).toBe(false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("requires an exact observed restore and clears residency after worker invalidation", async () => {
    const coordinator = new EngineResultResidencyCoordinator();

    await expect(coordinator.withResidentResult(
      "result-1",
      async () => coordinator.observe("result-other", []),
      async () => undefined,
    )).rejects.toThrow(/not restored/i);

    coordinator.observe("result-1", []);
    expect(coordinator.isResident("result-1")).toBe(true);
    coordinator.invalidate();
    expect(coordinator.isResident("result-1")).toBe(false);
  });

  it("rejects malformed eviction receipts before mutating residency", () => {
    const coordinator = new EngineResultResidencyCoordinator();
    coordinator.observe("result-1", []);

    expect(() => coordinator.observe("result-2", ["result-1", "result-1"]))
      .toThrow(/duplicate/i);
    expect(coordinator.isResident("result-1")).toBe(true);
    expect(coordinator.isResident("result-2")).toBe(false);
    expect(() => coordinator.observe("result-2", ["result-2"]))
      .toThrow(/claimed to publish/i);
  });
});
