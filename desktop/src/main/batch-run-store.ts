import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const BATCH_RUN_PLAN_SCHEMA = "loci.batch-run-plan/v1" as const;
export const BATCH_RUN_ITEM_SCHEMA = "loci.batch-run-item/v1" as const;

export const MAX_BATCH_RUN_SOURCES = 20_000;
export const MAX_BATCH_RUN_ATTEMPTS = 64;
export const MAX_BATCH_PLAN_BYTES = 64 * 1024 * 1024;
export const MAX_BATCH_ITEM_BYTES = 512 * 1024;

const PLAN_FILENAME = "plan.json";
const ITEMS_DIRECTORY = "items";
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const TEMPORARY_FILENAME = /^\.tmp-[a-f0-9-]+$/u;
const WINDOWS_INVALID_COMPONENT = /[<>:"|?*]/u;
const WINDOWS_RESERVED_COMPONENT = /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export type BatchRunItemState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type BatchRunAttemptState = "running" | "completed" | "failed" | "cancelled";

export interface BatchRunSourceInput {
  sourceId: string;
  fingerprintSha256: string;
  relativeLabel: string;
}

export interface BatchRunPlanInput {
  batchId: string;
  projectId: string;
  createdAt: string;
  sources: BatchRunSourceInput[];
  publicTitle?: string | null;
}

export interface BatchRunPlan {
  schemaVersion: typeof BATCH_RUN_PLAN_SCHEMA;
  batchId: string;
  projectId: string;
  createdAt: string;
  publicTitle: string | null;
  sources: BatchRunSourceInput[];
}

export interface BatchRunAttempt {
  attempt: number;
  state: BatchRunAttemptState;
  startedAt: string;
  finishedAt: string | null;
  resultId: string | null;
  resultManifestId: string | null;
  failureCode: string | null;
  failureSummary: string | null;
}

export interface BatchRunItem {
  schemaVersion: typeof BATCH_RUN_ITEM_SCHEMA;
  batchId: string;
  sourceId: string;
  state: BatchRunItemState;
  attemptCount: number;
  attempts: BatchRunAttempt[];
  resultId: string | null;
  resultManifestId: string | null;
  failureCode: string | null;
  failureSummary: string | null;
  updatedAt: string;
}

export interface BatchRunSnapshot {
  plan: BatchRunPlan;
  items: BatchRunItem[];
}

export interface BatchRunOpenResult extends BatchRunSnapshot {
  /** Sources whose in-flight attempt was honestly failed during restart recovery. */
  recoveredSourceIds: string[];
}

export type BatchRunPlanVerifier = (plan: Readonly<BatchRunPlan>) => void;

export interface BatchRunSummary {
  batchId: string;
  publicTitle: string | null;
  createdAt: string;
  updatedAt: string;
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  retryable: number;
}

export interface BatchRunFailure {
  code?: string | null;
  summary: string;
}

export class BatchRunStoreError extends Error {
  constructor(
    public readonly code:
      | "invalid-root"
      | "invalid-record"
      | "already-exists"
      | "not-found"
      | "not-open"
      | "unsafe-filesystem"
      | "invalid-transition"
      | "limit-exceeded",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BatchRunStoreError";
  }
}

interface RecordValue {
  [key: string]: unknown;
}

function cloned<T>(value: T): T {
  return structuredClone(value);
}

function record(value: unknown, location: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BatchRunStoreError("invalid-record", `${location} must be an object.`);
  }
  return value as RecordValue;
}

function exactKeys(value: RecordValue, expected: readonly string[], location: string): void {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      throw new BatchRunStoreError(
        "invalid-record",
        `${location} contains an unsupported field: ${key}.`,
      );
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      throw new BatchRunStoreError("invalid-record", `${location}.${key} is required.`);
    }
  }
}

function identifier(value: unknown, location: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new BatchRunStoreError("invalid-record", `${location} is not a valid identifier.`);
  }
  return value;
}

function sha256(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new BatchRunStoreError("invalid-record", `${location} is not a lowercase SHA-256 digest.`);
  }
  return value;
}

function isoTimestamp(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new BatchRunStoreError("invalid-record", `${location} is not a valid timestamp.`);
  }
  let normalized: string;
  try {
    normalized = new Date(value).toISOString();
  } catch {
    throw new BatchRunStoreError("invalid-record", `${location} is not a valid timestamp.`);
  }
  if (normalized !== value) {
    throw new BatchRunStoreError(
      "invalid-record",
      `${location} must be a normalized UTC timestamp with millisecond precision.`,
    );
  }
  return value;
}

function normalizedTimestamp(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new BatchRunStoreError("invalid-record", `${location} is not a valid timestamp.`);
  }
  return new Date(value).toISOString();
}

function integer(value: unknown, location: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new BatchRunStoreError("invalid-record", `${location} must be an integer of at least ${minimum}.`);
  }
  return value as number;
}

function nullableIdentifier(value: unknown, location: string): string | null {
  return value === null ? null : identifier(value, location);
}

function portableRelativeLabel(value: unknown, location: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    value !== value.normalize("NFC") ||
    CONTROL_CHARACTER.test(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    path.posix.isAbsolute(value)
  ) {
    throw new BatchRunStoreError("invalid-record", `${location} is not a portable relative label.`);
  }
  const parts = value.split("/");
  if (
    parts.some((part) =>
      !part ||
      part === "." ||
      part === ".." ||
      part.length > 255 ||
      part.endsWith(".") ||
      part.endsWith(" ") ||
      WINDOWS_INVALID_COMPONENT.test(part) ||
      WINDOWS_RESERVED_COMPONENT.test(part))
  ) {
    throw new BatchRunStoreError("invalid-record", `${location} is not a portable relative label.`);
  }
  return value;
}

function portableLabelKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US").normalize("NFC");
}

/** Remove filesystem locations and control characters before text can reach the renderer. */
export function sanitizeBatchRunPublicText(
  value: unknown,
  maximum = 1_000,
): string | null {
  if (typeof value !== "string") return null;
  let output = value
    .replace(/[\r\n\t\0-\x1f\x7f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!output) return null;
  output = output.replace(
    /(["'])(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/(?!\/))[^"'\r\n]*\1/g,
    "$1<local path>$1",
  );
  output = output.replace(
    /((?:^|[\s:=(]))(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/(?!\/)).*/g,
    "$1<local path>",
  );
  return output.slice(0, maximum) || null;
}

function validatedPublicText(value: unknown, location: string, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximum) {
    throw new BatchRunStoreError("invalid-record", `${location} is invalid.`);
  }
  const sanitized = sanitizeBatchRunPublicText(value, maximum);
  if (sanitized !== value) {
    throw new BatchRunStoreError("invalid-record", `${location} contains unsafe or unnormalized text.`);
  }
  return value;
}

function validatedSource(value: unknown, index: number): BatchRunSourceInput {
  const location = `$plan.sources[${index}]`;
  const item = record(value, location);
  exactKeys(item, ["sourceId", "fingerprintSha256", "relativeLabel"], location);
  return {
    sourceId: identifier(item.sourceId, `${location}.sourceId`),
    fingerprintSha256: sha256(item.fingerprintSha256, `${location}.fingerprintSha256`),
    relativeLabel: portableRelativeLabel(item.relativeLabel, `${location}.relativeLabel`),
  };
}

export function validateBatchRunPlan(value: unknown): BatchRunPlan {
  const item = record(value, "$plan");
  exactKeys(item, ["schemaVersion", "batchId", "projectId", "createdAt", "publicTitle", "sources"], "$plan");
  if (item.schemaVersion !== BATCH_RUN_PLAN_SCHEMA) {
    throw new BatchRunStoreError("invalid-record", "The batch plan schema is unsupported.");
  }
  if (!Array.isArray(item.sources) || item.sources.length < 1) {
    throw new BatchRunStoreError("invalid-record", "A batch plan requires at least one source.");
  }
  if (item.sources.length > MAX_BATCH_RUN_SOURCES) {
    throw new BatchRunStoreError(
      "limit-exceeded",
      `A batch run may contain at most ${MAX_BATCH_RUN_SOURCES.toLocaleString()} sources.`,
    );
  }
  const sources = item.sources.map(validatedSource);
  const sourceIds = sources.map(({ sourceId }) => sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new BatchRunStoreError("invalid-record", "The batch plan contains duplicate source identifiers.");
  }
  const relativeLabels = sources.map(({ relativeLabel }) => portableLabelKey(relativeLabel));
  if (new Set(relativeLabels).size !== relativeLabels.length) {
    throw new BatchRunStoreError(
      "invalid-record",
      "The batch plan contains relative labels that collide on a portable filesystem.",
    );
  }
  return {
    schemaVersion: BATCH_RUN_PLAN_SCHEMA,
    batchId: identifier(item.batchId, "$plan.batchId"),
    projectId: identifier(item.projectId, "$plan.projectId"),
    createdAt: isoTimestamp(item.createdAt, "$plan.createdAt"),
    publicTitle: validatedPublicText(item.publicTitle, "$plan.publicTitle", 160),
    sources,
  };
}

function attemptState(value: unknown, location: string): BatchRunAttemptState {
  if (!(["running", "completed", "failed", "cancelled"] as unknown[]).includes(value)) {
    throw new BatchRunStoreError("invalid-record", `${location} is not a supported attempt state.`);
  }
  return value as BatchRunAttemptState;
}

function itemState(value: unknown, location: string): BatchRunItemState {
  if (!(["pending", "running", "completed", "failed", "cancelled"] as unknown[]).includes(value)) {
    throw new BatchRunStoreError("invalid-record", `${location} is not a supported item state.`);
  }
  return value as BatchRunItemState;
}

function validatedAttempt(value: unknown, index: number): BatchRunAttempt {
  const location = `$item.attempts[${index}]`;
  const item = record(value, location);
  exactKeys(item, [
    "attempt",
    "state",
    "startedAt",
    "finishedAt",
    "resultId",
    "resultManifestId",
    "failureCode",
    "failureSummary",
  ], location);
  const state = attemptState(item.state, `${location}.state`);
  const startedAt = isoTimestamp(item.startedAt, `${location}.startedAt`);
  const finishedAt = item.finishedAt === null
    ? null
    : isoTimestamp(item.finishedAt, `${location}.finishedAt`);
  const resultId = nullableIdentifier(item.resultId, `${location}.resultId`);
  const resultManifestId = nullableIdentifier(item.resultManifestId, `${location}.resultManifestId`);
  const failureCode = nullableIdentifier(item.failureCode, `${location}.failureCode`);
  const failureSummary = validatedPublicText(item.failureSummary, `${location}.failureSummary`, 1_000);

  if (finishedAt !== null && Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new BatchRunStoreError("invalid-record", `${location}.finishedAt precedes its start.`);
  }
  if (state === "running") {
    if (finishedAt !== null || resultId !== null || resultManifestId !== null || failureCode !== null || failureSummary !== null) {
      throw new BatchRunStoreError("invalid-record", `${location} has inconsistent running-attempt fields.`);
    }
  } else if (finishedAt === null) {
    throw new BatchRunStoreError("invalid-record", `${location} is terminal without a finish time.`);
  }
  if (state === "completed") {
    if (resultId === null || resultManifestId === null || failureCode !== null || failureSummary !== null) {
      throw new BatchRunStoreError("invalid-record", `${location} has inconsistent completed-attempt fields.`);
    }
  } else if (state === "failed") {
    if (resultId !== null || resultManifestId !== null || failureCode === null || failureSummary === null) {
      throw new BatchRunStoreError("invalid-record", `${location} has inconsistent failed-attempt fields.`);
    }
  } else if (state === "cancelled") {
    if (resultId !== null || resultManifestId !== null || failureCode === null || failureSummary === null) {
      throw new BatchRunStoreError("invalid-record", `${location} has inconsistent cancelled-attempt fields.`);
    }
  }

  return {
    attempt: integer(item.attempt, `${location}.attempt`, 1),
    state,
    startedAt,
    finishedAt,
    resultId,
    resultManifestId,
    failureCode,
    failureSummary,
  };
}

export function validateBatchRunItem(value: unknown): BatchRunItem {
  const item = record(value, "$item");
  exactKeys(item, [
    "schemaVersion",
    "batchId",
    "sourceId",
    "state",
    "attemptCount",
    "attempts",
    "resultId",
    "resultManifestId",
    "failureCode",
    "failureSummary",
    "updatedAt",
  ], "$item");
  if (item.schemaVersion !== BATCH_RUN_ITEM_SCHEMA) {
    throw new BatchRunStoreError("invalid-record", "The batch item schema is unsupported.");
  }
  if (!Array.isArray(item.attempts) || item.attempts.length > MAX_BATCH_RUN_ATTEMPTS) {
    throw new BatchRunStoreError("limit-exceeded", "The batch item attempt history is invalid or too large.");
  }
  const attempts = item.attempts.map(validatedAttempt);
  const attemptCount = integer(item.attemptCount, "$item.attemptCount");
  if (attemptCount !== attempts.length) {
    throw new BatchRunStoreError("invalid-record", "The batch item attempt count is inconsistent.");
  }
  attempts.forEach((attempt, index) => {
    if (attempt.attempt !== index + 1) {
      throw new BatchRunStoreError("invalid-record", "Batch attempt numbers must be contiguous.");
    }
    if (index < attempts.length - 1 && attempt.state === "running") {
      throw new BatchRunStoreError("invalid-record", "Only the latest batch attempt may be running.");
    }
    if (
      index > 0 &&
      Date.parse(attempt.startedAt) < Date.parse(attempts[index - 1].finishedAt as string)
    ) {
      throw new BatchRunStoreError("invalid-record", "Batch attempt timestamps cannot move backwards.");
    }
  });

  const state = itemState(item.state, "$item.state");
  const resultId = nullableIdentifier(item.resultId, "$item.resultId");
  const resultManifestId = nullableIdentifier(item.resultManifestId, "$item.resultManifestId");
  const failureCode = nullableIdentifier(item.failureCode, "$item.failureCode");
  const failureSummary = validatedPublicText(item.failureSummary, "$item.failureSummary", 1_000);
  const updatedAt = isoTimestamp(item.updatedAt, "$item.updatedAt");
  const latest = attempts.at(-1);

  if (latest && Date.parse(updatedAt) < Date.parse(latest.finishedAt ?? latest.startedAt)) {
    throw new BatchRunStoreError("invalid-record", "The batch item update time precedes its attempt history.");
  }
  if (state === "pending") {
    if (latest?.state === "running" || resultId !== null || resultManifestId !== null || failureCode !== null || failureSummary !== null) {
      throw new BatchRunStoreError("invalid-record", "The pending batch item is inconsistent.");
    }
  } else if (state === "cancelled" && !latest) {
    if (resultId !== null || resultManifestId !== null || failureCode === null || failureSummary === null) {
      throw new BatchRunStoreError("invalid-record", "The cancelled pending item is inconsistent.");
    }
  } else {
    if (!latest || latest.state !== state) {
      throw new BatchRunStoreError("invalid-record", "The batch item state does not match its latest attempt.");
    }
    if (
      resultId !== latest.resultId ||
      resultManifestId !== latest.resultManifestId ||
      failureCode !== latest.failureCode ||
      failureSummary !== latest.failureSummary
    ) {
      throw new BatchRunStoreError("invalid-record", "The batch item result does not match its latest attempt.");
    }
  }

  return {
    schemaVersion: BATCH_RUN_ITEM_SCHEMA,
    batchId: identifier(item.batchId, "$item.batchId"),
    sourceId: identifier(item.sourceId, "$item.sourceId"),
    state,
    attemptCount,
    attempts,
    resultId,
    resultManifestId,
    failureCode,
    failureSummary,
    updatedAt,
  };
}

function itemFilename(sourceId: string): string {
  return `source-${createHash("sha256").update(sourceId).digest("hex")}.json`;
}

function batchDirectoryName(batchId: string): string {
  return `batch-${createHash("sha256").update(batchId).digest("hex")}`;
}

function initialItem(plan: BatchRunPlan, sourceId: string): BatchRunItem {
  return {
    schemaVersion: BATCH_RUN_ITEM_SCHEMA,
    batchId: plan.batchId,
    sourceId,
    state: "pending",
    attemptCount: 0,
    attempts: [],
    resultId: null,
    resultManifestId: null,
    failureCode: null,
    failureSummary: null,
    updatedAt: plan.createdAt,
  };
}

function serialized(value: unknown, maximum: number, label: string): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > maximum) {
    throw new BatchRunStoreError("limit-exceeded", `${label} exceeds its safe storage limit.`);
  }
  return bytes;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not supported by every filesystem. Every file is still fsynced.
  }
}

function hasPrivateDirectoryMode(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o777) === 0o700;
}

function hasPrivateFileMode(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o777) === 0o600;
}

async function assertPrivateDirectory(directory: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BatchRunStoreError("not-found", `${label} is unavailable.`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new BatchRunStoreError("unsafe-filesystem", `${label} is not a private directory.`);
  }
  if (!hasPrivateDirectoryMode(stat.mode)) {
    throw new BatchRunStoreError("unsafe-filesystem", `${label} has unsafe filesystem permissions.`);
  }
}

async function assertPrivateFile(filename: string, maximum: number, label: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BatchRunStoreError("not-found", `${label} is unavailable.`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BatchRunStoreError("unsafe-filesystem", `${label} is not a private regular file.`);
  }
  if (!hasPrivateFileMode(stat.mode)) {
    throw new BatchRunStoreError("unsafe-filesystem", `${label} has unsafe filesystem permissions.`);
  }
  if (stat.size > maximum) {
    throw new BatchRunStoreError("limit-exceeded", `${label} exceeds its safe storage limit.`);
  }
}

async function writeExclusive(filename: string, value: unknown, maximum: number, label: string): Promise<void> {
  const bytes = serialized(value, maximum, label);
  const handle = await fs.open(filename, "wx", 0o600);
  try {
    // The create mode is filtered through umask; explicitly restore the private contract.
    await handle.chmod(0o600).catch((error) => {
      if (process.platform !== "win32") throw error;
    });
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplace(filename: string, value: unknown, maximum: number, label: string): Promise<void> {
  await assertPrivateFile(filename, maximum, label);
  const directory = path.dirname(filename);
  await assertPrivateDirectory(directory, "The batch item directory");
  const temporary = path.join(directory, `.tmp-${randomUUID()}`);
  try {
    await writeExclusive(temporary, value, maximum, label);
    await fs.rename(temporary, filename);
    await syncDirectory(directory);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readJsonFile(filename: string, maximum: number, label: string): Promise<unknown> {
  await assertPrivateFile(filename, maximum, label);
  const bytes = await fs.readFile(filename);
  if (bytes.byteLength > maximum) {
    throw new BatchRunStoreError("limit-exceeded", `${label} exceeds its safe storage limit.`);
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new BatchRunStoreError("invalid-record", `${label} is not valid JSON.`, { cause: error });
  }
}

function safeFailure(value: BatchRunFailure, fallbackCode: string, fallbackSummary: string): {
  code: string;
  summary: string;
} {
  const code = value.code === null || value.code === undefined
    ? fallbackCode
    : identifier(value.code, "$failure.code");
  const summary = sanitizeBatchRunPublicText(value.summary, 1_000) ?? fallbackSummary;
  return { code, summary };
}

function planFromInput(input: BatchRunPlanInput): BatchRunPlan {
  const sources = input.sources.map((source) => ({
    sourceId: source.sourceId,
    fingerprintSha256: source.fingerprintSha256.toLowerCase(),
    relativeLabel: source.relativeLabel.normalize("NFC"),
  }));
  return validateBatchRunPlan({
    schemaVersion: BATCH_RUN_PLAN_SCHEMA,
    batchId: input.batchId,
    projectId: input.projectId,
    createdAt: normalizedTimestamp(input.createdAt, "$plan.createdAt"),
    publicTitle: sanitizeBatchRunPublicText(input.publicTitle, 160),
    sources,
  });
}

function assertItemBelongsToPlan(item: BatchRunItem, plan: BatchRunPlan): void {
  if (item.batchId !== plan.batchId || !plan.sources.some(({ sourceId }) => sourceId === item.sourceId)) {
    throw new BatchRunStoreError("invalid-record", "A batch item does not belong to its immutable plan.");
  }
}

function summarize(plan: BatchRunPlan, items: readonly BatchRunItem[]): BatchRunSummary {
  const counts: Record<BatchRunItemState, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const item of items) counts[item.state] += 1;
  const updatedAt = items.reduce(
    (latest, item) => Date.parse(item.updatedAt) > Date.parse(latest) ? item.updatedAt : latest,
    plan.createdAt,
  );
  return {
    batchId: plan.batchId,
    publicTitle: plan.publicTitle,
    createdAt: plan.createdAt,
    updatedAt,
    total: items.length,
    ...counts,
    retryable: counts.failed,
  };
}

/**
 * Private, sharded persistence for a recursive batch.
 *
 * The supplied root must be an absolute, dedicated application-data directory.
 * `open()` honestly marks attempts that were still running at process exit as
 * failed with `application-restarted`; it never claims that unknown work resumed.
 * Returned plans, items, and summaries contain source identifiers and portable
 * labels only—never this root or any canonical source/output path.
 */
export class BatchRunStore {
  private readonly root: string;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();
  private readonly openPlans = new Map<string, BatchRunPlan>();

  constructor(root: string, options: { now?: () => Date } = {}) {
    if (!path.isAbsolute(root) || path.normalize(root) !== root) {
      throw new BatchRunStoreError(
        "invalid-root",
        "The private batch-run root must be a normalized absolute path.",
      );
    }
    this.root = root;
    this.now = options.now ?? (() => new Date());
  }

  async create(input: BatchRunPlanInput): Promise<BatchRunOpenResult> {
    return this.enqueue(async () => {
      const plan = planFromInput(input);
      await this.ensureRoot();
      const finalDirectory = this.batchDirectory(plan.batchId);
      const lock = path.join(this.root, `.${batchDirectoryName(plan.batchId)}.lock`);
      let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
      const staging = path.join(this.root, `.staging-${randomUUID()}`);
      try {
        try {
          lockHandle = await fs.open(lock, "wx", 0o600);
          await lockHandle.chmod(0o600).catch((error) => {
            if (process.platform !== "win32") throw error;
          });
          await lockHandle.writeFile(`${plan.batchId}\n`, "utf8");
          await lockHandle.sync();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new BatchRunStoreError("already-exists", "This batch run already exists or has an incomplete creation lock.");
          }
          throw error;
        }
        try {
          await fs.lstat(finalDirectory);
          throw new BatchRunStoreError("already-exists", "This batch run already exists.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        await fs.mkdir(staging, { mode: 0o700 });
        await fs.chmod(staging, 0o700).catch((error) => {
          if (process.platform !== "win32") throw error;
        });
        const itemsDirectory = path.join(staging, ITEMS_DIRECTORY);
        await fs.mkdir(itemsDirectory, { mode: 0o700 });
        await fs.chmod(itemsDirectory, 0o700).catch((error) => {
          if (process.platform !== "win32") throw error;
        });
        await writeExclusive(
          path.join(staging, PLAN_FILENAME),
          plan,
          MAX_BATCH_PLAN_BYTES,
          "The batch plan",
        );
        for (const source of plan.sources) {
          await writeExclusive(
            path.join(itemsDirectory, itemFilename(source.sourceId)),
            initialItem(plan, source.sourceId),
            MAX_BATCH_ITEM_BYTES,
            "The batch item",
          );
        }
        await syncDirectory(itemsDirectory);
        await syncDirectory(staging);
        await fs.rename(staging, finalDirectory);
        await syncDirectory(this.root);
        this.openPlans.set(plan.batchId, cloned(plan));
        return {
          plan: cloned(plan),
          items: plan.sources.map(({ sourceId }) => initialItem(plan, sourceId)),
          recoveredSourceIds: [],
        };
      } finally {
        await lockHandle?.close().catch(() => undefined);
        await fs.rm(lock, { force: true }).catch(() => undefined);
        await fs.rm(staging, { force: true, recursive: true }).catch(() => undefined);
      }
    });
  }

  async open(
    batchIdValue: string,
    verifyPlan?: BatchRunPlanVerifier,
  ): Promise<BatchRunOpenResult> {
    return this.enqueue(async () => {
      const batchId = identifier(batchIdValue, "$batchId");
      const snapshot = await this.readSnapshot(batchId);
      // A restart recovery rewrites in-flight item state. Give the owner of the
      // immutable parent specification one synchronous, fail-closed boundary
      // before any such durable mutation or renderer exposure can occur.
      verifyPlan?.(cloned(snapshot.plan));
      const recoveredSourceIds: string[] = [];
      const recoveredItems: BatchRunItem[] = [];
      for (const current of snapshot.items) {
        if (current.state !== "running") {
          recoveredItems.push(current);
          continue;
        }
        const finishedAt = this.timestampAtOrAfter(current.updatedAt);
        const latest = current.attempts.at(-1) as BatchRunAttempt;
        const summary = "Loci restarted before this attempt reported a final state. Retry this source after revalidation.";
        const recovered: BatchRunItem = validateBatchRunItem({
          ...current,
          state: "failed",
          attempts: [
            ...current.attempts.slice(0, -1),
            {
              ...latest,
              state: "failed",
              finishedAt,
              failureCode: "application-restarted",
              failureSummary: summary,
            },
          ],
          resultId: null,
          resultManifestId: null,
          failureCode: "application-restarted",
          failureSummary: summary,
          updatedAt: finishedAt,
        });
        await atomicReplace(
          this.itemPath(batchId, current.sourceId),
          recovered,
          MAX_BATCH_ITEM_BYTES,
          "The batch item",
        );
        recoveredItems.push(recovered);
        recoveredSourceIds.push(current.sourceId);
      }
      this.openPlans.set(batchId, cloned(snapshot.plan));
      return {
        plan: cloned(snapshot.plan),
        items: recoveredItems.map((item) => cloned(item)),
        recoveredSourceIds,
      };
    });
  }

  async get(batchIdValue: string, sourceIdValue: string): Promise<BatchRunItem> {
    return this.enqueue(async () => {
      const plan = this.requireOpenPlan(batchIdValue);
      const sourceId = this.requirePlanSource(plan, sourceIdValue);
      return cloned(await this.readItem(plan, sourceId));
    });
  }

  async list(batchIdValue: string): Promise<BatchRunItem[]> {
    return this.enqueue(async () => {
      const plan = this.requireOpenPlan(batchIdValue);
      return this.readItems(plan);
    });
  }

  async beginAttempt(batchIdValue: string, sourceIdValue: string): Promise<BatchRunItem> {
    return this.mutateItem(batchIdValue, sourceIdValue, (current) => {
      if (current.state === "running") return current;
      if (current.state !== "pending") {
        throw new BatchRunStoreError(
          "invalid-transition",
          `A ${current.state} batch item cannot begin another attempt.`,
        );
      }
      if (current.attemptCount >= MAX_BATCH_RUN_ATTEMPTS) {
        throw new BatchRunStoreError("limit-exceeded", "This source has reached the batch retry limit.");
      }
      const startedAt = this.timestampAtOrAfter(current.updatedAt);
      const attempt: BatchRunAttempt = {
        attempt: current.attemptCount + 1,
        state: "running",
        startedAt,
        finishedAt: null,
        resultId: null,
        resultManifestId: null,
        failureCode: null,
        failureSummary: null,
      };
      return {
        ...current,
        state: "running",
        attemptCount: current.attemptCount + 1,
        attempts: [...current.attempts, attempt],
        resultId: null,
        resultManifestId: null,
        failureCode: null,
        failureSummary: null,
        updatedAt: startedAt,
      };
    });
  }

  async completeAttempt(
    batchIdValue: string,
    sourceIdValue: string,
    result: { resultId: string; resultManifestId: string },
  ): Promise<BatchRunItem> {
    const resultId = identifier(result.resultId, "$result.resultId");
    const resultManifestId = identifier(result.resultManifestId, "$result.resultManifestId");
    return this.mutateItem(batchIdValue, sourceIdValue, (current) => {
      if (current.state === "completed") {
        if (current.resultId === resultId && current.resultManifestId === resultManifestId) return current;
        throw new BatchRunStoreError("invalid-transition", "This batch item already completed with another result.");
      }
      if (current.state !== "running") {
        throw new BatchRunStoreError("invalid-transition", "Only a running batch item can complete.");
      }
      const finishedAt = this.timestampAtOrAfter(current.updatedAt);
      const latest = current.attempts.at(-1) as BatchRunAttempt;
      return {
        ...current,
        state: "completed",
        attempts: [
          ...current.attempts.slice(0, -1),
          { ...latest, state: "completed", finishedAt, resultId, resultManifestId },
        ],
        resultId,
        resultManifestId,
        failureCode: null,
        failureSummary: null,
        updatedAt: finishedAt,
      };
    });
  }

  async failAttempt(
    batchIdValue: string,
    sourceIdValue: string,
    failure: BatchRunFailure,
  ): Promise<BatchRunItem> {
    const safe = safeFailure(failure, "analysis-failed", "This source could not be processed.");
    return this.mutateItem(batchIdValue, sourceIdValue, (current) => {
      if (current.state === "failed") {
        if (current.failureCode === safe.code && current.failureSummary === safe.summary) return current;
        throw new BatchRunStoreError("invalid-transition", "This batch attempt already failed with another reason.");
      }
      if (current.state !== "running") {
        throw new BatchRunStoreError("invalid-transition", "Only a running batch item can fail.");
      }
      const finishedAt = this.timestampAtOrAfter(current.updatedAt);
      const latest = current.attempts.at(-1) as BatchRunAttempt;
      return {
        ...current,
        state: "failed",
        attempts: [
          ...current.attempts.slice(0, -1),
          {
            ...latest,
            state: "failed",
            finishedAt,
            failureCode: safe.code,
            failureSummary: safe.summary,
          },
        ],
        resultId: null,
        resultManifestId: null,
        failureCode: safe.code,
        failureSummary: safe.summary,
        updatedAt: finishedAt,
      };
    });
  }

  async cancelAttempt(
    batchIdValue: string,
    sourceIdValue: string,
    summaryValue = "Cancelled by the researcher.",
  ): Promise<BatchRunItem> {
    const summary = sanitizeBatchRunPublicText(summaryValue, 1_000) ?? "Cancelled by the researcher.";
    return this.mutateItem(batchIdValue, sourceIdValue, (current) => {
      if (current.state === "cancelled") return current;
      if (current.state !== "running") {
        throw new BatchRunStoreError("invalid-transition", "Only a running batch item can cancel its attempt.");
      }
      const finishedAt = this.timestampAtOrAfter(current.updatedAt);
      const latest = current.attempts.at(-1) as BatchRunAttempt;
      return {
        ...current,
        state: "cancelled",
        attempts: [
          ...current.attempts.slice(0, -1),
          {
            ...latest,
            state: "cancelled",
            finishedAt,
            failureCode: "user-cancelled",
            failureSummary: summary,
          },
        ],
        resultId: null,
        resultManifestId: null,
        failureCode: "user-cancelled",
        failureSummary: summary,
        updatedAt: finishedAt,
      };
    });
  }

  async cancelPending(batchIdValue: string, sourceIdsValue?: string[]): Promise<BatchRunItem[]> {
    return this.mutateSelection(batchIdValue, sourceIdsValue, (current) => {
      if (current.state === "cancelled") return current;
      if (current.state !== "pending") {
        throw new BatchRunStoreError("invalid-transition", "Only pending batch items can be cancelled before processing.");
      }
      const updatedAt = this.timestampAtOrAfter(current.updatedAt);
      return {
        ...current,
        state: "cancelled",
        failureCode: "user-cancelled",
        failureSummary: "Cancelled before processing.",
        updatedAt,
      };
    }, (item) => item.state === "pending");
  }

  async retryFailed(batchIdValue: string, sourceIdsValue?: string[]): Promise<BatchRunItem[]> {
    return this.mutateSelection(batchIdValue, sourceIdsValue, (current) => {
      if (current.state === "pending" && current.attempts.at(-1)?.state === "failed") return current;
      if (current.state !== "failed") {
        throw new BatchRunStoreError("invalid-transition", "Only failed batch items can be queued for retry.");
      }
      const updatedAt = this.timestampAtOrAfter(current.updatedAt);
      return {
        ...current,
        state: "pending",
        resultId: null,
        resultManifestId: null,
        failureCode: null,
        failureSummary: null,
        updatedAt,
      };
    }, (item) => item.state === "failed");
  }

  async summary(batchIdValue: string): Promise<BatchRunSummary> {
    return this.enqueue(async () => {
      const plan = this.requireOpenPlan(batchIdValue);
      return summarize(plan, await this.readItems(plan));
    });
  }

  async drain(): Promise<void> {
    await this.queue;
  }

  private async ensureRoot(): Promise<void> {
    try {
      const existing = await fs.lstat(this.root);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new BatchRunStoreError(
          "unsafe-filesystem",
          "The private batch-run root is not a private directory.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    }
    await fs.chmod(this.root, 0o700).catch((error) => {
      if (process.platform !== "win32") throw error;
    });
    await assertPrivateDirectory(this.root, "The private batch-run root");
  }

  private batchDirectory(batchId: string): string {
    return path.join(this.root, batchDirectoryName(batchId));
  }

  private itemPath(batchId: string, sourceId: string): string {
    return path.join(this.batchDirectory(batchId), ITEMS_DIRECTORY, itemFilename(sourceId));
  }

  private timestampAtOrAfter(minimum: string): string {
    const now = this.now();
    if (!Number.isFinite(now.valueOf())) {
      throw new BatchRunStoreError("invalid-record", "The batch-run clock returned an invalid time.");
    }
    return new Date(Math.max(now.valueOf(), Date.parse(minimum))).toISOString();
  }

  private requireOpenPlan(batchIdValue: string): BatchRunPlan {
    const batchId = identifier(batchIdValue, "$batchId");
    const plan = this.openPlans.get(batchId);
    if (!plan) {
      throw new BatchRunStoreError("not-open", "Open this batch run before reading or changing its items.");
    }
    return plan;
  }

  private requirePlanSource(plan: BatchRunPlan, sourceIdValue: string): string {
    const sourceId = identifier(sourceIdValue, "$sourceId");
    if (!plan.sources.some((source) => source.sourceId === sourceId)) {
      throw new BatchRunStoreError("not-found", "This source is not part of the batch run.");
    }
    return sourceId;
  }

  private async cleanAndValidateItemsDirectory(directory: string): Promise<void> {
    await assertPrivateDirectory(directory, "The batch item directory");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new BatchRunStoreError("unsafe-filesystem", "The batch item directory contains a symbolic link.");
      }
      if (TEMPORARY_FILENAME.test(entry.name) && entry.isFile()) {
        await fs.rm(entryPath, { force: true });
      }
    }
  }

  private async readSnapshot(batchId: string): Promise<BatchRunSnapshot> {
    await this.ensureRoot();
    const directory = this.batchDirectory(batchId);
    await assertPrivateDirectory(directory, "The batch run directory");
    const batchEntries = await fs.readdir(directory, { withFileTypes: true });
    if (
      batchEntries.length !== 2 ||
      !batchEntries.some((entry) => entry.name === PLAN_FILENAME && entry.isFile()) ||
      !batchEntries.some((entry) => entry.name === ITEMS_DIRECTORY && entry.isDirectory()) ||
      batchEntries.some((entry) => entry.isSymbolicLink())
    ) {
      throw new BatchRunStoreError("invalid-record", "The private batch run layout is invalid.");
    }
    const plan = validateBatchRunPlan(await readJsonFile(
      path.join(directory, PLAN_FILENAME),
      MAX_BATCH_PLAN_BYTES,
      "The batch plan",
    ));
    if (plan.batchId !== batchId) {
      throw new BatchRunStoreError("invalid-record", "The batch plan identifier does not match its private record.");
    }
    const itemsDirectory = path.join(directory, ITEMS_DIRECTORY);
    await this.cleanAndValidateItemsDirectory(itemsDirectory);
    const entries = await fs.readdir(itemsDirectory, { withFileTypes: true });
    const expectedNames = new Set(plan.sources.map(({ sourceId }) => itemFilename(sourceId)));
    const actualNames = entries.map((entry) => entry.name);
    if (
      actualNames.length !== expectedNames.size ||
      entries.some((entry) => !entry.isFile() || !expectedNames.has(entry.name))
    ) {
      throw new BatchRunStoreError("invalid-record", "The batch item records do not exactly match the immutable plan.");
    }
    const items = await this.readItems(plan);
    return { plan: cloned(plan), items };
  }

  private async readItem(plan: BatchRunPlan, sourceId: string): Promise<BatchRunItem> {
    const item = validateBatchRunItem(await readJsonFile(
      this.itemPath(plan.batchId, sourceId),
      MAX_BATCH_ITEM_BYTES,
      "The batch item",
    ));
    assertItemBelongsToPlan(item, plan);
    if (item.sourceId !== sourceId) {
      throw new BatchRunStoreError("invalid-record", "The batch item identifier does not match its private record.");
    }
    return item;
  }

  private async readItems(plan: BatchRunPlan): Promise<BatchRunItem[]> {
    const items: BatchRunItem[] = [];
    // Read sequentially to avoid opening thousands of file descriptors for a large experiment.
    for (const source of plan.sources) items.push(await this.readItem(plan, source.sourceId));
    return items;
  }

  private mutateItem(
    batchIdValue: string,
    sourceIdValue: string,
    transform: (current: BatchRunItem) => BatchRunItem,
  ): Promise<BatchRunItem> {
    return this.enqueue(async () => {
      const plan = this.requireOpenPlan(batchIdValue);
      const sourceId = this.requirePlanSource(plan, sourceIdValue);
      const current = await this.readItem(plan, sourceId);
      const candidate = validateBatchRunItem(transform(cloned(current)));
      assertItemBelongsToPlan(candidate, plan);
      if (candidate.sourceId !== current.sourceId || candidate.batchId !== current.batchId) {
        throw new BatchRunStoreError("invalid-record", "A batch mutation cannot change item identity.");
      }
      if (JSON.stringify(candidate) !== JSON.stringify(current)) {
        await atomicReplace(
          this.itemPath(plan.batchId, sourceId),
          candidate,
          MAX_BATCH_ITEM_BYTES,
          "The batch item",
        );
      }
      return cloned(candidate);
    });
  }

  private mutateSelection(
    batchIdValue: string,
    sourceIdsValue: string[] | undefined,
    transform: (current: BatchRunItem) => BatchRunItem,
    defaultFilter: (current: BatchRunItem) => boolean,
  ): Promise<BatchRunItem[]> {
    return this.enqueue(async () => {
      const plan = this.requireOpenPlan(batchIdValue);
      let sourceIds: string[];
      if (sourceIdsValue === undefined) {
        const items = await this.readItems(plan);
        sourceIds = items.filter(defaultFilter).map(({ sourceId }) => sourceId);
      } else {
        if (!Array.isArray(sourceIdsValue) || sourceIdsValue.length > plan.sources.length) {
          throw new BatchRunStoreError("invalid-record", "The batch source selection is invalid.");
        }
        sourceIds = sourceIdsValue.map((sourceId) => this.requirePlanSource(plan, sourceId));
        if (new Set(sourceIds).size !== sourceIds.length) {
          throw new BatchRunStoreError("invalid-record", "The batch source selection contains duplicates.");
        }
      }

      // Validate every transition before publishing any selected item.
      const candidates: Array<{ current: BatchRunItem; candidate: BatchRunItem }> = [];
      for (const sourceId of sourceIds) {
        const current = await this.readItem(plan, sourceId);
        const candidate = validateBatchRunItem(transform(cloned(current)));
        assertItemBelongsToPlan(candidate, plan);
        candidates.push({ current, candidate });
      }
      for (const { current, candidate } of candidates) {
        if (JSON.stringify(current) === JSON.stringify(candidate)) continue;
        await atomicReplace(
          this.itemPath(plan.batchId, current.sourceId),
          candidate,
          MAX_BATCH_ITEM_BYTES,
          "The batch item",
        );
      }
      return candidates.map(({ candidate }) => cloned(candidate));
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const queued = this.queue.then(async () => {
      try {
        result = await operation();
      } catch (error) {
        if (error instanceof BatchRunStoreError) throw error;
        // Node filesystem errors include the private filename in their public message.
        // Keep that detail out of any future IPC error serialization.
        throw new BatchRunStoreError(
          "unsafe-filesystem",
          "The private batch-run store could not complete the requested operation.",
        );
      }
    });
    this.queue = queued.catch(() => undefined);
    return queued.then(() => result);
  }
}
