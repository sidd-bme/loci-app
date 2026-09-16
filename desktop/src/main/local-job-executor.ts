import { randomUUID } from "node:crypto";

import {
  JOB_EVENT_SCHEMA,
  type JobEvent,
  type JobSpec,
  type JobState,
  type ResultManifest,
} from "../shared/foundation-contracts";
import { isTerminalJobState } from "../shared/job-transitions";
import type { JobPresentation, JobStore } from "./job-store";

const MAX_PUBLIC_PROGRESS_MESSAGE = 240;

export class LocalJobCancelledError extends Error {
  constructor(message = "The local job was cancelled.") {
    super(message);
    this.name = "LocalJobCancelledError";
  }
}

export interface LocalJobProgress {
  progress: number;
  message: string;
}

export interface LocalJobExecutionContext {
  jobId: string;
  signal: AbortSignal;
  reportProgress: (update: LocalJobProgress) => Promise<void>;
}

export interface LocalJobWorkResult<Value> {
  value: Value;
  resultManifest: ResultManifest;
}

export interface LocalJobSubmission<Value> {
  spec: JobSpec;
  presentation?: Partial<JobPresentation>;
  run: (context: LocalJobExecutionContext) => Promise<LocalJobWorkResult<Value>>;
  /**
   * Interrupt the active process boundary. It is never called for queued work.
   * Returning false means the executor will still wait for `run` to settle.
   */
  interrupt?: () => boolean;
}

export interface LocalJobHandle<Value> {
  jobId: string;
  completion: Promise<Value>;
}

export interface LocalJobExecutorOptions {
  now?: () => Date;
  mutationId?: () => string;
  notify?: () => void;
  progressIntervalMs?: number;
  progressStep?: number;
}

interface QueueItem<Value> {
  submission: LocalJobSubmission<Value>;
  controller: AbortController;
  cancellationRequested: boolean;
  cancellationPersistence: Promise<void> | null;
  completionStarted: boolean;
  lastProgress: number;
  lastProgressAt: number;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
}

function sanitizedPublicMessage(value: string): string {
  const singleLine = value
    .replace(/[\r\n\t\0-\x1f\x7f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return (singleLine || "Working…").slice(0, MAX_PUBLIC_PROGRESS_MESSAGE);
}

/**
 * Serial, main-process owner for local analytical work.
 *
 * The executor persists queue/cancellation/final-publication state before it
 * notifies the renderer. A successful `run` must return an already published,
 * verified ResultManifest; this class deliberately cannot turn an in-memory
 * result into a completed durable job.
 */
export class LocalJobExecutor {
  private readonly pending: Array<QueueItem<unknown>> = [];
  private active: QueueItem<unknown> | null = null;
  private pumping = false;
  private drainWaiters: Array<() => void> = [];
  private readonly now: () => Date;
  private readonly mutationId: () => string;
  private readonly notify: () => void;
  private readonly progressIntervalMs: number;
  private readonly progressStep: number;

  constructor(
    private readonly jobs: JobStore,
    options: LocalJobExecutorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.mutationId = options.mutationId ?? randomUUID;
    this.notify = options.notify ?? (() => undefined);
    this.progressIntervalMs = options.progressIntervalMs ?? 1_000;
    this.progressStep = options.progressStep ?? 0.02;
    if (!Number.isFinite(this.progressIntervalMs) || this.progressIntervalMs < 0) {
      throw new Error("The local job progress interval is invalid.");
    }
    if (!Number.isFinite(this.progressStep) || this.progressStep < 0 || this.progressStep > 1) {
      throw new Error("The local job progress step is invalid.");
    }
  }

  async submit<Value>(submission: LocalJobSubmission<Value>): Promise<LocalJobHandle<Value>> {
    await this.jobs.createJob(
      submission.spec,
      this.mutationId(),
      submission.presentation,
    );
    await this.append(
      submission.spec.jobId,
      "queued",
      "Waiting for local processing.",
      0,
    );

    let resolve!: (value: Value) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<Value>((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    const item: QueueItem<Value> = {
      submission,
      controller: new AbortController(),
      cancellationRequested: false,
      cancellationPersistence: null,
      completionStarted: false,
      lastProgress: 0,
      lastProgressAt: 0,
      resolve,
      reject,
    };
    this.pending.push(item as QueueItem<unknown>);
    void this.pump();
    return { jobId: submission.spec.jobId, completion };
  }

  async cancel(jobId: string): Promise<boolean> {
    if (typeof jobId !== "string" || !jobId) return false;
    const item = this.active?.submission.spec.jobId === jobId
      ? this.active
      : this.pending.find((candidate) => candidate.submission.spec.jobId === jobId);
    if (!item || item.cancellationRequested || item.completionStarted) return false;

    item.cancellationRequested = true;
    item.cancellationPersistence = this.jobs.requestCancellation(
      jobId,
      this.mutationId(),
      "Cancelled by the researcher.",
    ).then(() => undefined);
    try {
      await item.cancellationPersistence;
    } catch (error) {
      item.cancellationRequested = false;
      item.cancellationPersistence = null;
      throw error;
    }
    item.controller.abort(new LocalJobCancelledError());
    this.notify();

    if (item !== this.active) {
      const index = this.pending.indexOf(item);
      if (index >= 0) this.pending.splice(index, 1);
      await this.append(jobId, "cancelled", "Cancelled before local processing started.", 0, {
        reasonCode: "cancelled-before-start",
      });
      item.reject(new LocalJobCancelledError());
      this.resolveDrainIfIdle();
      return true;
    }

    item.submission.interrupt?.();
    return true;
  }

  async drain(): Promise<void> {
    if (!this.active && !this.pending.length && !this.pumping) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.active && this.pending.length) {
        const item = this.pending.shift() as QueueItem<unknown>;
        this.active = item;
        await this.execute(item);
        this.active = null;
      }
    } finally {
      this.pumping = false;
      this.resolveDrainIfIdle();
    }
  }

  private async execute(item: QueueItem<unknown>): Promise<void> {
    const jobId = item.submission.spec.jobId;
    try {
      await this.append(jobId, "running", "Starting local processing.", 0.02);
      // Cancellation can arrive after the durable running event is published
      // but before the submission enters its process boundary. Never invoke
      // work that is already cancelled: an interrupt cannot stop a worker
      // request that has not been registered yet.
      if (item.cancellationRequested || item.controller.signal.aborted) {
        throw new LocalJobCancelledError();
      }
      const outcome = await item.submission.run({
        jobId,
        signal: item.controller.signal,
        reportProgress: (update) => this.reportProgress(item, update),
      });
      if (item.cancellationRequested || item.controller.signal.aborted) {
        throw new LocalJobCancelledError();
      }
      await this.append(jobId, "verifying", "Verifying the published result.", 0.95);
      // Linearize cancellation against final result publication. There is no
      // await between this check and closing the cancellation gate, so either
      // cancel() records an accepted request first or it returns false because
      // completion has already started. An accepted cancellation can therefore
      // never race into a completed job/result binding.
      if (item.cancellationRequested || item.controller.signal.aborted) {
        throw new LocalJobCancelledError();
      }
      item.completionStarted = true;
      await this.append(jobId, "completed", "Local processing complete.", 1, {
        result: outcome.resultManifest,
      });
      item.resolve(outcome.value);
    } catch (error) {
      // A progress callback can observe cancellationRequested and reject while
      // the durable cancellation mutation is still being fsynced. Wait for
      // that mutation before deriving the next sequence number; otherwise the
      // terminal event can race it with the same sequence and be lost.
      await item.cancellationPersistence?.catch(() => undefined);
      const record = this.jobs.get(jobId);
      const state = record?.events.at(-1)?.state;
      if (state && !isTerminalJobState(state)) {
        const cancelled = item.cancellationRequested || item.controller.signal.aborted ||
          error instanceof LocalJobCancelledError;
        await this.append(
          jobId,
          cancelled ? "cancelled" : "failed",
          cancelled
            ? "Local processing cancelled."
            : "Local processing failed. Review the source and settings, then retry.",
          record?.events.at(-1)?.progress ?? null,
          { reasonCode: cancelled ? "cancelled-by-user" : "local-execution-failed" },
        ).catch(() => undefined);
      }
      item.reject(error);
    }
  }

  private async reportProgress(
    item: QueueItem<unknown>,
    update: LocalJobProgress,
  ): Promise<void> {
    if (item.cancellationRequested || item.controller.signal.aborted) {
      throw new LocalJobCancelledError();
    }
    if (!Number.isFinite(update.progress) || update.progress < 0 || update.progress > 1) {
      throw new Error("The local executor received invalid progress.");
    }
    // Reserve the final verification/completion range for durable publication.
    const progress = Math.max(0.02, Math.min(0.9, update.progress));
    if (progress < item.lastProgress) {
      throw new Error("The local executor received regressive progress.");
    }
    const timestamp = this.now().valueOf();
    const enoughProgress = progress - item.lastProgress >= this.progressStep;
    const enoughTime = timestamp - item.lastProgressAt >= this.progressIntervalMs;
    if (!enoughProgress && !enoughTime) return;
    item.lastProgress = progress;
    item.lastProgressAt = timestamp;
    await this.append(
      item.submission.spec.jobId,
      "running",
      sanitizedPublicMessage(update.message),
      progress,
    );
  }

  private async append(
    jobId: string,
    state: JobState,
    message: string,
    progress: number | null,
    options: { reasonCode?: string; result?: ResultManifest } = {},
  ): Promise<void> {
    const current = this.jobs.get(jobId);
    if (!current) throw new Error(`Unknown local job ${jobId}.`);
    const previous = current.events.at(-1) as JobEvent;
    const candidateTime = this.now();
    const occurredAt = candidateTime.valueOf() < Date.parse(previous.occurredAt)
      ? previous.occurredAt
      : candidateTime.toISOString();
    const event: JobEvent = {
      schemaVersion: JOB_EVENT_SCHEMA,
      jobId,
      sequence: previous.sequence + 1,
      occurredAt,
      state,
      progress,
      message: sanitizedPublicMessage(message),
      reasonCode: options.reasonCode ?? null,
      schedulerState: null,
    };
    await this.jobs.applyEvent(event, this.mutationId(), options.result);
    this.notify();
  }

  private resolveDrainIfIdle(): void {
    if (this.active || this.pending.length || this.pumping) return;
    const waiters = this.drainWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }
}
