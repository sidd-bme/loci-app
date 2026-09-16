import { randomUUID } from "node:crypto";

import type {
  QuitProjectSaveRequest,
  QuitProjectSaveResult,
} from "../shared/contracts";

export const QUIT_PROJECT_SAVE_TIMEOUT_MILLISECONDS = 15_000;

export type QuitProjectSaveOutcome =
  | "saved"
  | "failed"
  | "timed-out"
  | "renderer-unavailable";

interface PendingQuitProjectSave {
  requestId: string;
  resolve: (outcome: QuitProjectSaveOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  phase: "waiting" | "committing";
  rendererUnavailable: boolean;
  cancel: (request: QuitProjectSaveRequest) => void;
}

export class QuitProjectSaveCancelledError extends Error {
  constructor() {
    super("The quit project-save request was cancelled before publication.");
    this.name = "QuitProjectSaveCancelledError";
  }
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function validatedQuitProjectSaveRequestId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : null;
}

export function validatedQuitProjectSaveResult(value: unknown): QuitProjectSaveResult | null {
  if (!isExactRecord(value, ["requestId", "status"])) return null;
  const requestId = validatedQuitProjectSaveRequestId(value.requestId);
  if (requestId === null) return null;
  if (value.status !== "saved" && value.status !== "failed") return null;
  return { requestId, status: value.status };
}

/**
 * Coordinates one correlated renderer save request. Stale, malformed, or
 * duplicate acknowledgements cannot settle a later quit attempt.
 */
export class QuitProjectSaveCoordinator {
  private pending: PendingQuitProjectSave | null = null;
  private cancellationRevisionValue = 0;
  private publicationsBlocked = false;

  constructor(
    private readonly timeoutMilliseconds = QUIT_PROJECT_SAVE_TIMEOUT_MILLISECONDS,
    private readonly createRequestId: () => string = randomUUID,
  ) {
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0) {
      throw new RangeError("Quit project-save timeout must be a non-negative number.");
    }
  }

  get cancellationRevision(): number {
    return this.cancellationRevisionValue;
  }

  /**
   * Fence any project publication against the revision captured when that
   * publisher began. This deliberately does not claim the renderer's
   * correlated quit-save request: correction, batch, retirement, Create, and
   * Save As publishers all pass through the same low-level ProjectStore gate.
   */
  claimPublication(saveCancellationRevision: number): void {
    if (
      this.publicationsBlocked ||
      saveCancellationRevision !== this.cancellationRevisionValue
    ) {
      throw new QuitProjectSaveCancelledError();
    }
  }

  request(
    send: (request: QuitProjectSaveRequest) => void,
    cancel: (request: QuitProjectSaveRequest) => void = () => undefined,
  ): Promise<QuitProjectSaveOutcome> {
    if (this.pending) throw new Error("A quit project-save request is already pending.");
    const requestId = this.createRequestId();
    return new Promise((resolve) => {
      const pending: PendingQuitProjectSave = {
        requestId,
        resolve,
        timer: null,
        phase: "waiting",
        rendererUnavailable: false,
        cancel,
      };
      this.pending = pending;
      this.armTimeout(pending);
      try {
        send({ requestId });
      } catch {
        this.rendererUnavailable();
      }
    });
  }

  settle(value: unknown): boolean {
    const result = validatedQuitProjectSaveResult(value);
    if (!result || this.pending?.requestId !== result.requestId) return false;
    if (result.status === "failed") this.blockPublications();
    this.finish(result.requestId, result.status);
    return true;
  }

  rendererUnavailable(): boolean {
    const pending = this.pending;
    if (!pending) return false;
    if (pending.phase === "committing") {
      pending.rendererUnavailable = true;
      return true;
    }
    this.cancelPending(pending, "renderer-unavailable");
    return true;
  }

  /**
   * Claims the final atomic publication boundary for a save. Once claimed,
   * the renderer timeout cannot race an already-started rename. A save that
   * started before a later timeout is rejected using the cancellation
   * revision, so an ordinary autosave cannot publish after "Quit Without
   * Saving" either.
   */
  claimCommit(
    requestId: string | null,
    saveCancellationRevision: number,
  ): string | null {
    this.claimPublication(saveCancellationRevision);
    const pending = this.pending;
    if (requestId === null) return null;
    if (!pending || pending.requestId !== requestId) {
      throw new QuitProjectSaveCancelledError();
    }
    pending.phase = "committing";
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    return pending.requestId;
  }

  resumeSavingAfterCancelledRequest(): void {
    if (this.pending) {
      throw new Error("Cannot resume project saves while a quit-save request is active.");
    }
    this.publicationsBlocked = false;
  }

  completeCommit(requestId: string, succeeded: boolean): void {
    const pending = this.pending;
    if (!pending || pending.requestId !== requestId) return;
    if (!succeeded) {
      this.blockPublications();
      this.finish(requestId, "failed");
      return;
    }
    if (pending.rendererUnavailable) {
      this.finish(requestId, "saved");
      return;
    }
    pending.phase = "waiting";
    this.armTimeout(pending);
  }

  private finish(requestId: string, outcome: QuitProjectSaveOutcome): void {
    if (this.pending?.requestId !== requestId) return;
    const pending = this.pending;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(outcome);
  }

  private cancelPending(
    pending: PendingQuitProjectSave,
    outcome: Exclude<QuitProjectSaveOutcome, "saved" | "failed" | "timed-out">,
  ): void {
    this.pending = null;
    this.blockPublications();
    if (pending.timer) clearTimeout(pending.timer);
    try {
      pending.cancel({ requestId: pending.requestId });
    } catch {
      // Publication still fails closed through the cancellation revision.
    }
    pending.resolve(outcome);
  }

  private armTimeout(pending: PendingQuitProjectSave): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.pending !== pending || pending.phase === "committing") return;
      this.pending = null;
      this.blockPublications();
      try {
        pending.cancel({ requestId: pending.requestId });
      } catch {
        // The main-process publication guard is authoritative even when the
        // renderer disappears before it can observe the cancellation.
      }
      pending.resolve("timed-out");
    }, this.timeoutMilliseconds);
  }

  private blockPublications(): void {
    this.cancellationRevisionValue += 1;
    this.publicationsBlocked = true;
  }
}

export async function shouldQuitAfterProjectSave(
  hasActiveProject: boolean,
  requestSave: () => Promise<QuitProjectSaveOutcome>,
  confirmQuitWithoutSaving: (outcome: Exclude<QuitProjectSaveOutcome, "saved">) => Promise<boolean>,
): Promise<boolean> {
  if (!hasActiveProject) return true;
  const outcome = await requestSave();
  if (outcome === "saved") return true;
  return confirmQuitWithoutSaving(outcome);
}
