// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { waitForShutdownDecision } from "./shutdown";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("waitForShutdownDecision", () => {
  it("finishes without prompting when durable work settles within the grace period", async () => {
    const prompt = vi.fn(async () => "force-quit" as const);
    await expect(waitForShutdownDecision(Promise.resolve(), prompt, 0)).resolves.toEqual({
      kind: "completed",
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("returns a failed outcome without prompting when clean shutdown rejects", async () => {
    const prompt = vi.fn(async () => "force-quit" as const);
    const failure = new Error("disk unavailable");
    await expect(waitForShutdownDecision(Promise.reject(failure), prompt, 0)).resolves.toEqual({
      kind: "failed",
      error: failure,
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("returns force-quit only after the grace-period prompt chooses it", async () => {
    const operation = deferred();
    const prompt = vi.fn(async () => "force-quit" as const);
    await expect(waitForShutdownDecision(operation.promise, prompt, 0)).resolves.toEqual({
      kind: "force-quit",
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    operation.resolve();
    await operation.promise;
  });

  it("can keep waiting and then complete cleanly", async () => {
    const operation = deferred();
    const prompt = vi.fn(async () => {
      operation.resolve();
      return "keep-waiting" as const;
    });
    await expect(waitForShutdownDecision(operation.promise, prompt, 0)).resolves.toEqual({
      kind: "completed",
    });
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
