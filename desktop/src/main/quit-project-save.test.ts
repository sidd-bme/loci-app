// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  QuitProjectSaveCancelledError,
  QuitProjectSaveCoordinator,
  shouldQuitAfterProjectSave,
  validatedQuitProjectSaveResult,
} from "./quit-project-save";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

describe("QuitProjectSaveCoordinator", () => {
  it("settles only the exact correlated acknowledgement", async () => {
    const send = vi.fn();
    const coordinator = new QuitProjectSaveCoordinator(1_000, () => FIRST_ID);
    const outcome = coordinator.request(send);

    expect(send).toHaveBeenCalledWith({ requestId: FIRST_ID });
    expect(coordinator.settle({ requestId: SECOND_ID, status: "saved" })).toBe(false);
    expect(coordinator.settle({ requestId: FIRST_ID, status: "saved", extra: true })).toBe(false);
    expect(coordinator.settle({ requestId: FIRST_ID, status: "saved" })).toBe(true);
    await expect(outcome).resolves.toBe("saved");
    expect(coordinator.settle({ requestId: FIRST_ID, status: "failed" })).toBe(false);
  });

  it("reports a renderer send failure without waiting for the timeout", async () => {
    const coordinator = new QuitProjectSaveCoordinator(1_000, () => FIRST_ID);
    await expect(coordinator.request(() => {
      throw new Error("renderer destroyed");
    })).resolves.toBe("renderer-unavailable");
  });

  it("blocks unrelated publications after a failed save until Keep Working resumes them", async () => {
    const coordinator = new QuitProjectSaveCoordinator(1_000, () => FIRST_ID);
    const beforeFailure = coordinator.cancellationRevision;
    const outcome = coordinator.request(() => undefined);
    expect(coordinator.settle({ requestId: FIRST_ID, status: "failed" })).toBe(true);
    await expect(outcome).resolves.toBe("failed");

    expect(() => coordinator.claimCommit(null, beforeFailure))
      .toThrow(QuitProjectSaveCancelledError);
    expect(() => coordinator.claimCommit(null, coordinator.cancellationRevision))
      .toThrow(QuitProjectSaveCancelledError);
    coordinator.resumeSavingAfterCancelledRequest();
    expect(coordinator.claimCommit(null, coordinator.cancellationRevision)).toBeNull();
  });

  it("lets the shared publication fence inspect a pending quit without claiming its renderer save", async () => {
    const coordinator = new QuitProjectSaveCoordinator(1_000, () => FIRST_ID);
    const revision = coordinator.cancellationRevision;
    const outcome = coordinator.request(() => undefined);

    expect(() => coordinator.claimPublication(revision)).not.toThrow();
    expect(coordinator.claimCommit(null, revision)).toBeNull();
    expect(coordinator.settle({ requestId: FIRST_ID, status: "saved" })).toBe(true);
    await expect(outcome).resolves.toBe("saved");
  });

  it("settles a pending request when the renderer becomes unavailable", async () => {
    const coordinator = new QuitProjectSaveCoordinator(1_000, () => FIRST_ID);
    const outcome = coordinator.request(() => undefined);
    expect(coordinator.rendererUnavailable()).toBe(true);
    await expect(outcome).resolves.toBe("renderer-unavailable");
    expect(coordinator.rendererUnavailable()).toBe(false);
  });

  it("times out and permits a later request with a fresh identity", async () => {
    vi.useFakeTimers();
    const ids = [FIRST_ID, SECOND_ID];
    const coordinator = new QuitProjectSaveCoordinator(25, () => ids.shift()!);
    const first = coordinator.request(() => undefined);
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toBe("timed-out");

    const second = coordinator.request(() => undefined);
    expect(coordinator.settle({ requestId: FIRST_ID, status: "saved" })).toBe(false);
    expect(coordinator.settle({ requestId: SECOND_ID, status: "failed" })).toBe(true);
    await expect(second).resolves.toBe("failed");
    vi.useRealTimers();
  });

  it("cancels a timed-out renderer request and rejects a save that reaches publication later", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const coordinator = new QuitProjectSaveCoordinator(25, () => FIRST_ID);
    const saveCancellationRevision = coordinator.cancellationRevision;
    const outcome = coordinator.request(() => undefined, cancel);

    await vi.advanceTimersByTimeAsync(25);

    await expect(outcome).resolves.toBe("timed-out");
    expect(cancel).toHaveBeenCalledWith({ requestId: FIRST_ID });
    expect(() => coordinator.claimCommit(null, saveCancellationRevision))
      .toThrow(QuitProjectSaveCancelledError);
    expect(() => coordinator.claimCommit(FIRST_ID, coordinator.cancellationRevision))
      .toThrow(QuitProjectSaveCancelledError);
    expect(() => coordinator.claimCommit(null, coordinator.cancellationRevision))
      .toThrow(QuitProjectSaveCancelledError);
    coordinator.resumeSavingAfterCancelledRequest();
    expect(coordinator.claimCommit(null, coordinator.cancellationRevision)).toBeNull();
    vi.useRealTimers();
  });

  it("claims the atomic publication boundary before the timeout can offer discard", async () => {
    vi.useFakeTimers();
    const coordinator = new QuitProjectSaveCoordinator(25, () => FIRST_ID);
    const outcome = coordinator.request(() => undefined);

    expect(coordinator.claimCommit(FIRST_ID, coordinator.cancellationRevision)).toBe(FIRST_ID);
    await vi.advanceTimersByTimeAsync(100);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(coordinator.settle({ requestId: FIRST_ID, status: "saved" })).toBe(true);
    await expect(outcome).resolves.toBe("saved");
    vi.useRealTimers();
  });

  it("restores a bounded acknowledgement timeout after a committed save returns", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const coordinator = new QuitProjectSaveCoordinator(25, () => FIRST_ID);
    const outcome = coordinator.request(() => undefined, cancel);
    expect(coordinator.claimCommit(FIRST_ID, coordinator.cancellationRevision)).toBe(FIRST_ID);

    coordinator.completeCommit(FIRST_ID, true);
    await vi.advanceTimersByTimeAsync(25);

    await expect(outcome).resolves.toBe("timed-out");
    expect(cancel).toHaveBeenCalledWith({ requestId: FIRST_ID });
    vi.useRealTimers();
  });

  it("does not let a save from an earlier cancelled attempt claim a later quit request", async () => {
    vi.useFakeTimers();
    const ids = [FIRST_ID, SECOND_ID];
    const coordinator = new QuitProjectSaveCoordinator(25, () => ids.shift()!);
    const staleRevision = coordinator.cancellationRevision;
    const first = coordinator.request(() => undefined);
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toBe("timed-out");
    coordinator.resumeSavingAfterCancelledRequest();

    const second = coordinator.request(() => undefined);
    expect(() => coordinator.claimCommit(null, staleRevision))
      .toThrow(QuitProjectSaveCancelledError);
    expect(coordinator.settle({ requestId: SECOND_ID, status: "saved" })).toBe(true);
    await expect(second).resolves.toBe("saved");
    vi.useRealTimers();
  });

  it("finishes a claimed commit when the renderer disappears", async () => {
    const coordinator = new QuitProjectSaveCoordinator(1_000, () => FIRST_ID);
    const outcome = coordinator.request(() => undefined);
    expect(coordinator.claimCommit(FIRST_ID, coordinator.cancellationRevision)).toBe(FIRST_ID);
    expect(coordinator.rendererUnavailable()).toBe(true);

    coordinator.completeCommit(FIRST_ID, true);

    await expect(outcome).resolves.toBe("saved");
  });

  it("rejects overlapping requests rather than cross-settling them", () => {
    const coordinator = new QuitProjectSaveCoordinator(1_000, () => FIRST_ID);
    void coordinator.request(() => undefined);
    expect(() => coordinator.request(() => undefined)).toThrow(/already pending/i);
    coordinator.rendererUnavailable();
  });
});

describe("quit project-save decision", () => {
  it("does not involve the renderer when no project exists", async () => {
    const requestSave = vi.fn(async () => "failed" as const);
    const confirmDiscard = vi.fn(async () => false);
    await expect(shouldQuitAfterProjectSave(false, requestSave, confirmDiscard)).resolves.toBe(true);
    expect(requestSave).not.toHaveBeenCalled();
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("continues after a verified save", async () => {
    const confirmDiscard = vi.fn(async () => false);
    await expect(shouldQuitAfterProjectSave(
      true,
      async () => "saved",
      confirmDiscard,
    )).resolves.toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it.each(["failed", "timed-out", "renderer-unavailable"] as const)(
    "fails closed after %s unless discard is explicit",
    async (outcome) => {
      const keepWorking = vi.fn(async () => false);
      await expect(shouldQuitAfterProjectSave(
        true,
        async () => outcome,
        keepWorking,
      )).resolves.toBe(false);
      expect(keepWorking).toHaveBeenCalledWith(outcome);

      await expect(shouldQuitAfterProjectSave(
        true,
        async () => outcome,
        async () => true,
      )).resolves.toBe(true);
    },
  );
});

describe("validatedQuitProjectSaveResult", () => {
  it("accepts only the exact path-free result contract", () => {
    expect(validatedQuitProjectSaveResult({ requestId: FIRST_ID, status: "saved" })).toEqual({
      requestId: FIRST_ID,
      status: "saved",
    });
    expect(validatedQuitProjectSaveResult({ requestId: "../escape", status: "saved" })).toBeNull();
    expect(validatedQuitProjectSaveResult({ requestId: FIRST_ID, status: "other" })).toBeNull();
  });
});
