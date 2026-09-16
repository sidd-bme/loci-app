import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  JOB_EVENT_SCHEMA,
  type JobEvent,
  type ProjectJobRecord,
  type JobSpec,
  type JobState,
  type ResultManifest,
} from "../shared/foundation-contracts";
import {
  validateJobEvent,
  validateJobSpec,
  validateResultManifest,
} from "../shared/foundation-validation";
import {
  appendValidatedJobEvent,
  isTerminalJobState,
  validateJobEventHistory,
} from "../shared/job-transitions";

export type { JobEvent, JobSpec, JobState, ResultManifest } from "../shared/foundation-contracts";

export const JOB_STORE_SCHEMA_VERSION = 1 as const;
export const MAX_DURABLE_JOBS = 10_000;
export const MAX_JOB_STORE_BYTES = 64 * 1024 * 1024;
export const MAX_RETAINED_FINGERPRINT_JOBS = 128;

interface AppliedJobMutation {
  id: string;
  digest: string;
}

export interface JobPresentation {
  title: string;
  /** A user-selected display label. Connection identifiers remain main-process only. */
  targetLabel?: string;
}

export interface JobCancellationIntent {
  requestedAt: string;
  reason?: string;
}

export interface JobRecoveryMarker {
  interruptedState: JobState;
  detectedAt: string;
}

/** Main-process persistence wrapper around the public shared job contracts. */
export interface DurableJobRecordV1 {
  schemaVersion: typeof JOB_STORE_SCHEMA_VERSION;
  spec: JobSpec;
  events: JobEvent[];
  result: ResultManifest | null;
  presentation: JobPresentation;
  cancellation?: JobCancellationIntent;
  recovery?: JobRecoveryMarker;
  updatedAt: string;
  appliedMutations: AppliedJobMutation[];
}

export interface JobRendererSummary {
  jobId: string;
  revision: number;
  kind: JobSpec["kind"];
  title: string;
  state: JobState;
  target: {
    kind: "local" | "remote";
    scheduler?: "pbs" | "slurm" | "direct";
    label?: string;
  };
  progress: number | null;
  publicMessage: string;
  cancellationRequested: boolean;
  interruptedState?: JobState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

interface PersistedJobStoreV1 {
  schemaVersion: typeof JOB_STORE_SCHEMA_VERSION;
  writtenAt: string;
  jobs: DurableJobRecordV1[];
}

export interface JobStoreOpenResult {
  jobs: DurableJobRecordV1[];
  reconciledJobIds: string[];
}

export interface JobStoreOptions {
  now?: () => Date;
  /** Test seam; production keeps a small bounded history of transient source inspections. */
  maxRetainedFingerprintJobs?: number;
}

export class JobStoreError extends Error {}
export class JobStoreCorruptError extends JobStoreError {}
export class JobEventConflictError extends JobStoreError {}
export class JobResultError extends JobStoreError {}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string, maximum = 1_000): string {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new JobStoreCorruptError(`The job store contains an invalid ${field}.`);
  }
  return value;
}

function requireMutationId(value: unknown): string {
  const candidate = requireString(value, "mutation identifier", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(candidate)) {
    throw new JobStoreCorruptError("The job store contains an invalid mutation identifier.");
  }
  return candidate;
}

function requireDigest(value: unknown): string {
  const candidate = requireString(value, "mutation digest", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(candidate)) {
    throw new JobStoreCorruptError("The job store contains an invalid mutation digest.");
  }
  return candidate;
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const candidate = requireString(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(candidate) || !Number.isFinite(Date.parse(candidate))) {
    throw new JobStoreCorruptError(`The job store contains an invalid ${field}.`);
  }
  return candidate;
}

function sanitizePublicText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  let output = value.replace(/[\r\n\t\0-\x1f\x7f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!output) return undefined;
  output = output.replace(
    /(["'])(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/)[^"'\r\n]*\1/g,
    "$1<local path>$1",
  );
  output = output.replace(
    /((?:^|[\s:=(]))(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/).*/,
    "$1<local path>",
  );
  return output.slice(0, maximum);
}

function defaultTitle(kind: JobSpec["kind"]): string {
  switch (kind) {
    case "fingerprint": return "Verify source";
    case "segment": return "Segment images";
    case "render": return "Render view";
    case "export": return "Export results";
    case "train": return "Train model";
  }
}

function validatePresentation(value: unknown, fallbackKind: JobSpec["kind"]): JobPresentation {
  if (!isObject(value)) {
    throw new JobStoreCorruptError("The job store contains invalid presentation metadata.");
  }
  return {
    title: sanitizePublicText(requireString(value.title, "job title", 160), 160)
      ?? defaultTitle(fallbackKind),
    targetLabel: sanitizePublicText(value.targetLabel, 80),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

/** Exact JavaScript canonical JSON used by persisted job/result identities. */
export function canonicalJobJson(value: unknown): string {
  return stableJson(value);
}

function digestMutation(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJobJson(value)).digest("hex");
}

function latestEvent(record: DurableJobRecordV1): JobEvent {
  return record.events.at(-1) as JobEvent;
}

function mutationReceipt(
  records: ReadonlyMap<string, DurableJobRecordV1>,
  mutationId: string,
): { receipt: AppliedJobMutation; record: DurableJobRecordV1 } | undefined {
  for (const record of records.values()) {
    const receipt = record.appliedMutations.find((candidate) => candidate.id === mutationId);
    if (receipt) return { receipt, record };
  }
  return undefined;
}

function validateResultForCompletion(
  spec: JobSpec,
  resultValue: unknown,
  completedAt?: string,
): ResultManifest {
  const result = clone(validateResultManifest(resultValue));
  if (result.jobId !== spec.jobId) {
    throw new JobResultError("The result belongs to a different job.");
  }
  if (result.publication.state !== "verified" || result.publication.atomic !== true) {
    throw new JobResultError("A completed job requires an atomically published, verified result.");
  }
  if (Date.parse(result.createdAt) < Date.parse(spec.createdAt)
    || completedAt && Date.parse(result.createdAt) > Date.parse(completedAt)) {
    throw new JobResultError("The result timestamp falls outside the job execution interval.");
  }
  if (result.producer.modelId !== spec.operation.modelId
    || result.producer.modelSha256?.toLowerCase() !== spec.operation.modelSha256?.toLowerCase()) {
    throw new JobResultError("The result model provenance does not match the job specification.");
  }
  if (result.producer.settingsSha256 !== sha256CanonicalJson(spec.operation.settings)) {
    throw new JobResultError("The result settings provenance does not match the job specification.");
  }

  const fingerprints = new Map(result.sourceFingerprints.map((item) => [item.sourceId, item.sha256]));
  if (fingerprints.size !== spec.inputs.length) {
    throw new JobResultError("The result source fingerprints do not exactly match the job inputs.");
  }
  for (const input of spec.inputs) {
    const resultDigest = fingerprints.get(input.sourceId);
    if (!resultDigest) {
      throw new JobResultError(`The result is missing source fingerprint ${input.sourceId}.`);
    }
    if (input.fingerprintSha256 && input.fingerprintSha256.toLowerCase() !== resultDigest.toLowerCase()) {
      throw new JobResultError(`The result fingerprint does not match source ${input.sourceId}.`);
    }
  }

  const artifacts = new Map(result.artifacts.map((item) => [item.artifactId, item]));
  for (const expected of spec.expectedOutputs) {
    const artifact = artifacts.get(expected.artifactId);
    if (!artifact || artifact.mediaType !== expected.mediaType) {
      throw new JobResultError(`The verified result is missing expected artifact ${expected.artifactId}.`);
    }
  }
  return result;
}

/** Main-process integrity check for job snapshots embedded in a project file. */
export function validateDurableJobSnapshot(value: ProjectJobRecord): void {
  const spec = validateJobSpec(value.spec);
  const events = value.events.map((event) => validateJobEvent(event));
  if (!events.length) throw new JobStoreCorruptError("A project job has no event history.");
  validateJobEventHistory(events);
  if (events.some((event) => event.jobId !== spec.jobId)) {
    throw new JobStoreCorruptError("A project job contains an event for another job.");
  }
  const latest = events.at(-1) as JobEvent;
  if (latest.state === "completed") {
    if (value.result === null) {
      throw new JobStoreCorruptError("A completed project job is missing its result.");
    }
    validateResultForCompletion(spec, value.result, latest.occurredAt);
  } else if (value.result !== null) {
    throw new JobStoreCorruptError("A non-completed project job contains a final result.");
  }
}

function validateRecord(value: unknown): DurableJobRecordV1 {
  if (!isObject(value) || value.schemaVersion !== JOB_STORE_SCHEMA_VERSION) {
    throw new JobStoreCorruptError("The job store contains an unsupported job record.");
  }
  const spec = clone(validateJobSpec(value.spec));
  if (!Array.isArray(value.events) || value.events.length === 0) {
    throw new JobStoreCorruptError("A durable job must contain at least one event.");
  }
  const events = value.events.map((event) => clone(validateJobEvent(event)));
  validateJobEventHistory(events);
  if (events.some((event) => event.jobId !== spec.jobId)) {
    throw new JobStoreCorruptError("The job store contains an event for a different job.");
  }
  if (events[0].occurredAt !== spec.createdAt) {
    throw new JobStoreCorruptError("The initial job event does not match the job creation time.");
  }

  if (!Array.isArray(value.appliedMutations) || value.appliedMutations.length > 1_000_000) {
    throw new JobStoreCorruptError("The job store contains invalid mutation receipts.");
  }
  const appliedMutations = value.appliedMutations.map((item): AppliedJobMutation => {
    if (!isObject(item)) {
      throw new JobStoreCorruptError("The job store contains an invalid mutation receipt.");
    }
    return { id: requireMutationId(item.id), digest: requireDigest(item.digest) };
  });
  if (new Set(appliedMutations.map((item) => item.id)).size !== appliedMutations.length) {
    throw new JobStoreCorruptError("The job store contains duplicate mutation receipts.");
  }

  const latest = events.at(-1) as JobEvent;
  const updatedAt = requireIsoTimestamp(value.updatedAt, "job update timestamp");
  if (updatedAt !== latest.occurredAt) {
    throw new JobStoreCorruptError("The durable job update time does not match its latest event.");
  }

  const result = value.result === null
    ? null
    : validateResultForCompletion(spec, value.result, latest.occurredAt);
  if (latest.state === "completed" && result === null) {
    throw new JobStoreCorruptError("A completed job is missing its verified result.");
  }
  if (latest.state !== "completed" && result !== null) {
    throw new JobStoreCorruptError("A non-completed job cannot publish a final result.");
  }

  let cancellation: JobCancellationIntent | undefined;
  if (value.cancellation !== undefined) {
    if (!isObject(value.cancellation)) {
      throw new JobStoreCorruptError("The job store contains invalid cancellation intent.");
    }
    cancellation = {
      requestedAt: requireIsoTimestamp(value.cancellation.requestedAt, "cancellation timestamp"),
      reason: sanitizePublicText(value.cancellation.reason, 240),
    };
    if (Date.parse(cancellation.requestedAt) > Date.parse(updatedAt)) {
      throw new JobStoreCorruptError("Cancellation intent occurs after the latest job event.");
    }
  }

  let recovery: JobRecoveryMarker | undefined;
  if (value.recovery !== undefined) {
    if (!isObject(value.recovery)) {
      throw new JobStoreCorruptError("The job store contains an invalid recovery marker.");
    }
    const interruptedState = value.recovery.interruptedState;
    if (typeof interruptedState !== "string"
      || !["staging", "queued", "held", "running", "downloading", "verifying"].includes(interruptedState)) {
      throw new JobStoreCorruptError("The job store contains an invalid interrupted state.");
    }
    recovery = {
      interruptedState: interruptedState as JobState,
      detectedAt: requireIsoTimestamp(value.recovery.detectedAt, "recovery timestamp"),
    };
    if (latest.state !== "disconnected" && latest.state !== "needs-attention") {
      throw new JobStoreCorruptError("The job store contains an inconsistent recovery marker.");
    }
  }

  return {
    schemaVersion: JOB_STORE_SCHEMA_VERSION,
    spec,
    events,
    result,
    presentation: validatePresentation(value.presentation, spec.kind),
    cancellation,
    recovery,
    updatedAt,
    appliedMutations,
  };
}

function rendererSummary(record: DurableJobRecordV1): JobRendererSummary {
  const latest = latestEvent(record);
  const firstRunning = record.events.find((event) => event.state === "running");
  const target = record.spec.executionTarget;
  return {
    jobId: record.spec.jobId,
    revision: latest.sequence + 1,
    kind: record.spec.kind,
    title: record.presentation.title,
    state: latest.state,
    target: target.kind === "local"
      ? { kind: "local" }
      : {
          kind: "remote",
          scheduler: target.scheduler,
          label: record.presentation.targetLabel,
        },
    progress: latest.progress,
    publicMessage: sanitizePublicText(latest.message, 1_000) ?? "",
    cancellationRequested: Boolean(record.cancellation),
    interruptedState: record.recovery?.interruptedState,
    createdAt: record.spec.createdAt,
    updatedAt: record.updatedAt,
    startedAt: firstRunning?.occurredAt,
    finishedAt: isTerminalJobState(latest.state) ? latest.occurredAt : undefined,
  };
}

export class JobStore {
  private records = new Map<string, DurableJobRecordV1>();
  private opened = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly maxRetainedFingerprintJobs: number;

  constructor(
    private readonly destination: string,
    options: JobStoreOptions = {},
  ) {
    if (!path.isAbsolute(destination)) {
      throw new JobStoreError("The job store path must be absolute.");
    }
    this.now = options.now ?? (() => new Date());
    this.maxRetainedFingerprintJobs = options.maxRetainedFingerprintJobs
      ?? MAX_RETAINED_FINGERPRINT_JOBS;
    if (
      !Number.isSafeInteger(this.maxRetainedFingerprintJobs) ||
      this.maxRetainedFingerprintJobs < 1 ||
      this.maxRetainedFingerprintJobs > MAX_RETAINED_FINGERPRINT_JOBS
    ) {
      throw new JobStoreError("The retained fingerprint-job limit is invalid.");
    }
  }

  async open(): Promise<JobStoreOpenResult> {
    if (this.opened) return { jobs: this.list(), reconciledJobIds: [] };

    const loaded = new Map<string, DurableJobRecordV1>();
    try {
      const stat = await fs.lstat(this.destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOB_STORE_BYTES) {
        throw new JobStoreCorruptError("The job store exceeds its safe size or is not a regular file.");
      }
      const persistedText = await fs.readFile(this.destination, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(persistedText) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new JobStoreCorruptError("The job store is not valid JSON.");
        }
        throw error;
      }
      if (!isObject(parsed)
        || parsed.schemaVersion !== JOB_STORE_SCHEMA_VERSION
        || !Array.isArray(parsed.jobs)
        || parsed.jobs.length > MAX_DURABLE_JOBS) {
        throw new JobStoreCorruptError("The job store has an unsupported or invalid schema.");
      }
      const writtenAt = requireIsoTimestamp(parsed.writtenAt, "store timestamp");
      for (const value of parsed.jobs) {
        let record: DurableJobRecordV1;
        try {
          record = validateRecord(value);
        } catch (error) {
          if (error instanceof JobStoreCorruptError) throw error;
          throw new JobStoreCorruptError(
            error instanceof Error ? error.message : "The job store contains an invalid job.",
          );
        }
        if (loaded.has(record.spec.jobId)) {
          throw new JobStoreCorruptError("The job store contains duplicate jobs.");
        }
        loaded.set(record.spec.jobId, record);
      }
      const mutationIds = [...loaded.values()]
        .flatMap((record) => record.appliedMutations.map((item) => item.id));
      if (new Set(mutationIds).size !== mutationIds.length) {
        throw new JobStoreCorruptError("The job store contains duplicate mutation identifiers.");
      }
      if ([...loaded.values()].some(
        (record) => Date.parse(record.updatedAt) > Date.parse(writtenAt),
      )) {
        throw new JobStoreCorruptError("The store timestamp precedes a durable job update.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const reconciledJobIds: string[] = [];
    for (const [jobId, record] of loaded) {
      const interrupted = latestEvent(record);
      if (isTerminalJobState(interrupted.state)
        || interrupted.state === "disconnected"
        || interrupted.state === "needs-attention") {
        continue;
      }
      const state: JobState = record.spec.executionTarget.kind === "remote"
        ? "disconnected"
        : record.spec.kind === "fingerprint"
          ? "failed"
          : "needs-attention";
      const occurredAt = this.timestampAtOrAfter(interrupted.occurredAt);
      const event: JobEvent = {
        schemaVersion: JOB_EVENT_SCHEMA,
        jobId,
        sequence: interrupted.sequence + 1,
        occurredAt,
        state,
        progress: interrupted.progress,
        message: record.spec.executionTarget.kind === "remote"
          ? "Reconnect to the compute target before trusting this job state."
          : record.spec.kind === "fingerprint"
            ? "Source inspection was interrupted. Select the source to inspect it again."
            : "Loci restarted before this job reported a final state. Review or retry it.",
        reasonCode: "application-restarted",
        schedulerState: interrupted.schedulerState,
      };
      const mutationId = this.restartMutationId(loaded, jobId, event.sequence);
      const mutation = { mutationId, type: "restart-reconciliation", event };
      loaded.set(jobId, {
        ...record,
        events: appendValidatedJobEvent(record.events, event),
        recovery: state === "failed"
          ? undefined
          : { interruptedState: interrupted.state, detectedAt: occurredAt },
        updatedAt: occurredAt,
        appliedMutations: [
          ...record.appliedMutations,
          { id: mutationId, digest: digestMutation(mutation) },
        ],
      });
      reconciledJobIds.push(jobId);
    }
    if (reconciledJobIds.length) await this.persist(loaded);
    this.records = loaded;
    this.opened = true;
    return { jobs: this.list(), reconciledJobIds };
  }

  list(): DurableJobRecordV1[] {
    this.assertOpen();
    return [...this.records.values()]
      .sort((left, right) => left.spec.createdAt.localeCompare(right.spec.createdAt)
        || left.spec.jobId.localeCompare(right.spec.jobId))
      .map(clone);
  }

  get(jobId: string): DurableJobRecordV1 | undefined {
    this.assertOpen();
    const record = this.records.get(jobId);
    return record ? clone(record) : undefined;
  }

  listRendererSummaries(): JobRendererSummary[] {
    return this.list().map(rendererSummary);
  }

  getRendererSummary(jobId: string): JobRendererSummary | undefined {
    const record = this.get(jobId);
    return record ? rendererSummary(record) : undefined;
  }

  /** Wait until every queued atomic mutation has settled; useful during application shutdown. */
  async drain(): Promise<void> {
    await this.queue;
  }

  createJob(
    specValue: JobSpec,
    mutationIdValue: string,
    presentationValue?: Partial<JobPresentation>,
  ): Promise<DurableJobRecordV1> {
    return this.mutate(async (records) => {
      const spec = clone(validateJobSpec(specValue));
      const mutationId = requireMutationId(mutationIdValue);
      const presentation = validatePresentation({
        title: presentationValue?.title ?? defaultTitle(spec.kind),
        targetLabel: presentationValue?.targetLabel,
      }, spec.kind);
      const mutation = { mutationId, type: "create", spec, presentation };
      const digest = digestMutation(mutation);
      const prior = mutationReceipt(records, mutationId);
      if (prior) return this.replayedMutation(prior, digest);
      if (records.has(spec.jobId)) {
        throw new JobStoreError(`A job with identifier ${spec.jobId} already exists.`);
      }
      if (spec.kind === "fingerprint") {
        const completedFingerprints = [...records.values()]
          .filter((record) => record.spec.kind === "fingerprint"
            && isTerminalJobState(latestEvent(record).state))
          .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)
            || left.spec.jobId.localeCompare(right.spec.jobId));
        while (completedFingerprints.length >= this.maxRetainedFingerprintJobs) {
          const oldest = completedFingerprints.shift();
          if (oldest) records.delete(oldest.spec.jobId);
        }
      }
      if (records.size >= MAX_DURABLE_JOBS) {
        throw new JobStoreError(
          "The durable job history is full. Export or clear old job history before starting more work.",
        );
      }

      const initial: JobEvent = {
        schemaVersion: JOB_EVENT_SCHEMA,
        jobId: spec.jobId,
        sequence: 0,
        occurredAt: spec.createdAt,
        state: "staging",
        progress: 0,
        message: "Preparing job.",
        reasonCode: null,
        schedulerState: null,
      };
      validateJobEvent(initial);
      const record: DurableJobRecordV1 = {
        schemaVersion: JOB_STORE_SCHEMA_VERSION,
        spec,
        events: [initial],
        result: null,
        presentation,
        updatedAt: initial.occurredAt,
        appliedMutations: [{ id: mutationId, digest }],
      };
      records.set(spec.jobId, record);
      return { records, result: clone(record), changed: true };
    });
  }

  applyEvent(
    eventValue: JobEvent,
    mutationIdValue: string,
    resultValue?: ResultManifest,
  ): Promise<DurableJobRecordV1> {
    return this.mutate(async (records) => {
      const event = clone(validateJobEvent(eventValue));
      const mutationId = requireMutationId(mutationIdValue);
      const candidateResult = resultValue === undefined ? undefined : clone(resultValue);
      const mutation = { mutationId, type: "event", event, result: candidateResult ?? null };
      const digest = digestMutation(mutation);
      const prior = mutationReceipt(records, mutationId);
      if (prior) return this.replayedMutation(prior, digest, event.jobId);

      const current = records.get(event.jobId);
      if (!current) throw new JobStoreError(`Unknown job identifier ${event.jobId}.`);
      if (event.state === "completed" && current.cancellation) {
        throw new JobResultError(
          "A job with an accepted cancellation request cannot publish a completed result.",
        );
      }
      const events = appendValidatedJobEvent(current.events, event);
      let result: ResultManifest | null = null;
      if (event.state === "completed") {
        if (candidateResult === undefined) {
          throw new JobResultError("A completed job requires a verified result manifest.");
        }
        result = validateResultForCompletion(current.spec, candidateResult, event.occurredAt);
      } else if (candidateResult !== undefined) {
        throw new JobResultError("Only a completed job may publish its final result.");
      }

      const next: DurableJobRecordV1 = {
        ...current,
        events,
        result,
        recovery: event.state === "disconnected" || event.state === "needs-attention"
          ? current.recovery ?? {
              interruptedState: latestEvent(current).state,
              detectedAt: event.occurredAt,
            }
          : undefined,
        updatedAt: event.occurredAt,
        appliedMutations: [
          ...current.appliedMutations,
          { id: mutationId, digest },
        ],
      };
      records.set(event.jobId, next);
      return { records, result: clone(next), changed: true };
    });
  }

  requestCancellation(
    jobId: string,
    mutationIdValue: string,
    reasonValue?: string,
  ): Promise<DurableJobRecordV1> {
    return this.mutate(async (records) => {
      const mutationId = requireMutationId(mutationIdValue);
      const reason = sanitizePublicText(reasonValue, 240);
      const mutation = { mutationId, type: "request-cancellation", jobId, reason: reason ?? null };
      const digest = digestMutation(mutation);
      const prior = mutationReceipt(records, mutationId);
      if (prior) return this.replayedMutation(prior, digest, jobId);
      const current = records.get(jobId);
      if (!current) throw new JobStoreError(`Unknown job identifier ${jobId}.`);
      const previous = latestEvent(current);
      if (isTerminalJobState(previous.state)) {
        throw new JobStoreError(`Job ${jobId} is already ${previous.state}.`);
      }
      const occurredAt = this.timestampAtOrAfter(previous.occurredAt);
      const event: JobEvent = {
        schemaVersion: JOB_EVENT_SCHEMA,
        jobId,
        sequence: previous.sequence + 1,
        occurredAt,
        state: previous.state,
        progress: previous.progress,
        message: "Cancellation requested; waiting for the executor to acknowledge it.",
        reasonCode: "user-cancellation-requested",
        schedulerState: previous.schedulerState,
      };
      const next: DurableJobRecordV1 = {
        ...current,
        events: appendValidatedJobEvent(current.events, event),
        cancellation: current.cancellation ?? { requestedAt: occurredAt, reason },
        updatedAt: occurredAt,
        appliedMutations: [
          ...current.appliedMutations,
          { id: mutationId, digest },
        ],
      };
      records.set(jobId, next);
      return { records, result: clone(next), changed: true };
    });
  }

  private assertOpen(): void {
    if (!this.opened) throw new JobStoreError("Open the job store before using it.");
  }

  private timestampAtOrAfter(minimum?: string): string {
    const timestamp = this.now();
    if (minimum && timestamp.valueOf() < Date.parse(minimum)) {
      return new Date(minimum).toISOString();
    }
    return timestamp.toISOString();
  }

  private restartMutationId(
    records: ReadonlyMap<string, DurableJobRecordV1>,
    jobId: string,
    sequence: number,
  ): string {
    let attempt = 0;
    let candidate: string;
    do {
      candidate = `restart:${createHash("sha256")
        .update(`${jobId}:${sequence}:${attempt}`)
        .digest("hex")
        .slice(0, 24)}`;
      attempt += 1;
    } while (mutationReceipt(records, candidate));
    return candidate;
  }

  private replayedMutation(
    prior: { receipt: AppliedJobMutation; record: DurableJobRecordV1 },
    digest: string,
    expectedJobId?: string,
  ): { records: Map<string, DurableJobRecordV1>; result: DurableJobRecordV1; changed: false } {
    if (prior.receipt.digest !== digest) {
      throw new JobEventConflictError("The mutation identifier was reused with different content.");
    }
    if (expectedJobId && prior.record.spec.jobId !== expectedJobId) {
      throw new JobEventConflictError("The mutation belongs to a different job.");
    }
    return { records: this.records, result: clone(prior.record), changed: false };
  }

  private mutate<T>(
    operation: (records: Map<string, DurableJobRecordV1>) => Promise<{
      records: Map<string, DurableJobRecordV1>;
      result: T;
      changed: boolean;
    }>,
  ): Promise<T> {
    this.assertOpen();
    let result!: T;
    const queued = this.queue.then(async () => {
      const candidate = new Map(
        [...this.records].map(([id, record]) => [id, clone(record)]),
      );
      const outcome = await operation(candidate);
      if (outcome.changed) {
        await this.persist(outcome.records);
        this.records = outcome.records;
      }
      result = outcome.result;
    });
    this.queue = queued.catch(() => undefined);
    return queued.then(() => result);
  }

  private async persist(records: ReadonlyMap<string, DurableJobRecordV1>): Promise<void> {
    const latestTimestamp = [...records.values()]
      .map((record) => record.updatedAt)
      .reduce<string | undefined>((latest, candidate) => (
        !latest || Date.parse(candidate) > Date.parse(latest) ? candidate : latest
      ), undefined);
    const envelope: PersistedJobStoreV1 = {
      schemaVersion: JOB_STORE_SCHEMA_VERSION,
      writtenAt: this.timestampAtOrAfter(latestTimestamp),
      jobs: [...records.values()].sort((left, right) => left.spec.jobId.localeCompare(right.spec.jobId)),
    };
    const contents = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_JOB_STORE_BYTES) {
      throw new JobStoreError("The durable job history exceeds its safe storage limit.");
    }
    const temporary = `${this.destination}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(this.destination), { recursive: true });
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.destination);
      try {
        const directory = await fs.open(path.dirname(this.destination), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        // Some filesystems do not permit syncing directories. The file itself was fsynced.
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
