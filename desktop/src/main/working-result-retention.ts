import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import {
  MAX_WORKING_RESULT_PACK_BYTES,
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
} from "./working-result-publication";

export const WORKING_RESULT_RETENTION_SCHEMA =
  "loci.working-result-retention/v1" as const;
export const WORKING_RESULT_RETENTION_LEDGER =
  ".working-result-retention-v1.json" as const;
export const DEFAULT_WORKING_RESULT_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_WORKING_RESULT_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;

const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const MAX_LEDGER_ENTRIES = 100_000;
const HASH_BUFFER_BYTES = 1024 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const JOB_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_OWNER_PATTERN =
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BATCH_RECOVERY_OWNER_PREFIX = "batch-recovery:";
const PACK_BASENAME_PATTERN =
  /^working-([A-Za-z0-9_-]{1,160})-r(0|[1-9]\d{0,15})\.loci-result$/;

export interface WorkingResultArtifactIdentity {
  artifactId: typeof WORKING_RESULT_ARTIFACT_ID;
  filename: string;
  mediaType: typeof WORKING_RESULT_MEDIA_TYPE;
  byteLength: number;
  sha256: string;
}

export interface WorkingResultReferenceKey {
  projectId: string;
  resultId: string;
  revision: number;
}

export interface WorkingResultReferenceInput extends WorkingResultReferenceKey {
  jobId: string;
  artifact: WorkingResultArtifactIdentity;
  /** Main-process authority only. This value is verified and is never persisted. */
  packPath: string;
}

export type WorkingResultProjectReferenceInput = Omit<
  WorkingResultReferenceInput,
  "projectId"
>;

export interface WorkingResultReference extends WorkingResultReferenceKey {
  jobId: string;
  artifact: WorkingResultArtifactIdentity;
  state: "referenced" | "unreferenced";
  referencedAt: string;
  unreferencedAt: string | null;
}

export interface WorkingResultRetentionDiagnostics {
  schemaVersion: typeof WORKING_RESULT_RETENTION_SCHEMA;
  quotaBytes: number;
  totalPackCount: number;
  totalBytes: number;
  referencedPackCount: number;
  referencedBytes: number;
  unreferencedPackCount: number;
  unreferencedBytes: number;
  legacyProtectedPackCount: number;
  unsafeEntryCount: number;
  missingReferencedPackCount: number;
  invalidReferencedPackCount: number;
  overQuotaBytes: number;
  gcBlocked: boolean;
}

export interface WorkingResultGarbageCollectionReceipt {
  deleted: Array<{
    jobId: string;
    artifact: WorkingResultArtifactIdentity;
  }>;
  deletedBytes: number;
  graceRetainedCount: number;
  integritySkippedCount: number;
  failedDeletionCount: number;
  blockedReasons: string[];
  diagnostics: WorkingResultRetentionDiagnostics;
}

export interface WorkingResultProjectReconciliationReceipt {
  projectId: string;
  references: WorkingResultReference[];
  released: WorkingResultReferenceKey[];
}

export interface WorkingResultSessionRecoveryReceipt {
  adopted: WorkingResultReference[];
  released: WorkingResultReferenceKey[];
}

export interface WorkingResultRetentionOptions {
  gracePeriodMs?: number;
  quotaBytes?: number;
  now?: () => Date;
}

interface RetentionLedger {
  schemaVersion: typeof WORKING_RESULT_RETENTION_SCHEMA;
  createdAt: string;
  updatedAt: string;
  entries: Record<string, WorkingResultReference>;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

interface ScannedPack extends FileIdentity {
  jobId: string;
  filename: string;
  filePath: string;
}

interface Inventory {
  packs: Map<string, ScannedPack>;
  unsafeEntryCount: number;
}

interface ClassifiedInventory {
  diagnostics: WorkingResultRetentionDiagnostics;
  referencedLocators: Set<string>;
  unreferencedEntriesByLocator: Map<string, WorkingResultReference[]>;
  invalidReferencedLocators: Set<string>;
}

interface VerifiedReferenceInput {
  input: WorkingResultReferenceInput;
  packPath: string;
  identity: FileIdentity;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key)),
  );
}

function identifier(value: unknown, location: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${location} is not a valid bounded identifier.`);
  }
  return value;
}

function jobIdentifier(value: unknown): string {
  if (typeof value !== "string" || !JOB_IDENTIFIER_PATTERN.test(value)) {
    throw new Error("The working-result job identifier is invalid.");
  }
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("The working-result revision must be a non-negative safe integer.");
  }
  return value as number;
}

function boundedInteger(
  value: unknown,
  location: string,
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {},
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${location} is outside its supported range.`);
  }
  return value;
}

function timestamp(value: unknown, location: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 80
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${location} is not a valid timestamp.`);
  }
  return value;
}

function artifactIdentity(
  value: unknown,
  resultId: string,
  expectedRevision: number,
): WorkingResultArtifactIdentity {
  if (!exactRecord(value, [
    "artifactId",
    "filename",
    "mediaType",
    "byteLength",
    "sha256",
  ])) {
    throw new Error("The working-result artifact identity is invalid.");
  }
  const expectedFilename = `working-${resultId}-r${expectedRevision}.loci-result`;
  if (
    value.artifactId !== WORKING_RESULT_ARTIFACT_ID
    || value.mediaType !== WORKING_RESULT_MEDIA_TYPE
    || value.filename !== expectedFilename
    || typeof value.filename !== "string"
    || !PACK_BASENAME_PATTERN.test(value.filename)
    || path.basename(value.filename) !== value.filename
    || typeof value.sha256 !== "string"
    || !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new Error("The working-result artifact identity is invalid.");
  }
  return {
    artifactId: WORKING_RESULT_ARTIFACT_ID,
    filename: value.filename,
    mediaType: WORKING_RESULT_MEDIA_TYPE,
    byteLength: boundedInteger(value.byteLength, "Working-result byte length", {
      minimum: 1,
      maximum: MAX_WORKING_RESULT_PACK_BYTES,
    }),
    sha256: value.sha256,
  };
}

function referenceKey(value: WorkingResultReferenceKey): string {
  return createHash("sha256")
    .update(JSON.stringify([value.projectId, value.resultId, value.revision]))
    .digest("hex");
}

function locator(jobId: string, filename: string): string {
  return `${jobId}/${filename}`;
}

function isBatchRecoveryOwner(projectId: string): boolean {
  return projectId.startsWith(BATCH_RECOVERY_OWNER_PREFIX);
}

/** A stable private owner used only while an unfinished durable batch needs a pack. */
export function workingResultBatchRecoveryOwnerId(batchIdValue: string): string {
  const batchId = identifier(batchIdValue, "Working-result batch identifier");
  const ownerId = `${BATCH_RECOVERY_OWNER_PREFIX}${batchId}`;
  return identifier(ownerId, "Working-result batch recovery owner");
}

function sameArtifact(
  left: WorkingResultArtifactIdentity,
  right: WorkingResultArtifactIdentity,
): boolean {
  return (
    left.artifactId === right.artifactId
    && left.filename === right.filename
    && left.mediaType === right.mediaType
    && left.byteLength === right.byteLength
    && left.sha256 === right.sha256
  );
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
  );
}

function fileIdentity(stat: Awaited<ReturnType<typeof fs.lstat>>): FileIdentity {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
  };
}

function normalizedReference(value: unknown, key?: string): WorkingResultReference {
  if (!exactRecord(value, [
    "projectId",
    "resultId",
    "revision",
    "jobId",
    "artifact",
    "state",
    "referencedAt",
    "unreferencedAt",
  ])) {
    throw new Error("The working-result retention ledger contains an invalid reference.");
  }
  const normalizedKey = {
    projectId: identifier(value.projectId, "Working-result project identifier"),
    resultId: identifier(value.resultId, "Working-result result identifier"),
    revision: revision(value.revision),
  };
  const referencedAt = timestamp(value.referencedAt, "Working-result reference time");
  const state = value.state;
  if (state !== "referenced" && state !== "unreferenced") {
    throw new Error("The working-result retention ledger contains an invalid state.");
  }
  const unreferencedAt = value.unreferencedAt === null
    ? null
    : timestamp(value.unreferencedAt, "Working-result release time");
  if (
    (state === "referenced" && unreferencedAt !== null)
    || (state === "unreferenced" && unreferencedAt === null)
    || (unreferencedAt !== null && Date.parse(unreferencedAt) < Date.parse(referencedAt))
  ) {
    throw new Error("The working-result retention ledger contains inconsistent state.");
  }
  if (key !== undefined && referenceKey(normalizedKey) !== key) {
    throw new Error("The working-result retention ledger key does not match its reference.");
  }
  return {
    ...normalizedKey,
    jobId: jobIdentifier(value.jobId),
    artifact: artifactIdentity(value.artifact, normalizedKey.resultId, normalizedKey.revision),
    state,
    referencedAt,
    unreferencedAt,
  };
}

function normalizedReferenceInput(value: unknown): WorkingResultReferenceInput {
  if (!exactRecord(value, [
    "projectId",
    "resultId",
    "revision",
    "jobId",
    "artifact",
    "packPath",
  ])) {
    throw new Error("The working-result reference request is invalid.");
  }
  const key = {
    projectId: identifier(value.projectId, "Working-result project identifier"),
    resultId: identifier(value.resultId, "Working-result result identifier"),
    revision: revision(value.revision),
  };
  if (typeof value.packPath !== "string" || !path.isAbsolute(value.packPath)) {
    throw new Error("The working-result pack location is invalid.");
  }
  return {
    ...key,
    jobId: jobIdentifier(value.jobId),
    artifact: artifactIdentity(value.artifact, key.resultId, key.revision),
    packPath: value.packPath,
  };
}

function normalizedReferenceKey(value: unknown): WorkingResultReferenceKey {
  if (!exactRecord(value, ["projectId", "resultId", "revision"])) {
    throw new Error("The working-result reference key is invalid.");
  }
  return {
    projectId: identifier(value.projectId, "Working-result project identifier"),
    resultId: identifier(value.resultId, "Working-result result identifier"),
    revision: revision(value.revision),
  };
}

function validateLedger(value: unknown): RetentionLedger {
  if (!exactRecord(value, ["schemaVersion", "createdAt", "updatedAt", "entries"])) {
    throw new Error("The working-result retention ledger is invalid.");
  }
  if (value.schemaVersion !== WORKING_RESULT_RETENTION_SCHEMA) {
    throw new Error("The working-result retention ledger version is unsupported.");
  }
  const createdAt = timestamp(value.createdAt, "Working-result ledger creation time");
  const updatedAt = timestamp(value.updatedAt, "Working-result ledger update time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("The working-result retention ledger timestamps are inconsistent.");
  }
  if (
    !value.entries
    || typeof value.entries !== "object"
    || Array.isArray(value.entries)
    || Object.getPrototypeOf(value.entries) !== Object.prototype
  ) {
    throw new Error("The working-result retention ledger entries are invalid.");
  }
  const rawEntries = Object.entries(value.entries as Record<string, unknown>);
  if (rawEntries.length > MAX_LEDGER_ENTRIES) {
    throw new Error("The working-result retention ledger has too many entries.");
  }
  const entries: Record<string, WorkingResultReference> = {};
  for (const [key, entry] of rawEntries) {
    if (!SHA256_PATTERN.test(key)) {
      throw new Error("The working-result retention ledger contains an invalid key.");
    }
    entries[key] = normalizedReference(entry, key);
  }
  return {
    schemaVersion: WORKING_RESULT_RETENTION_SCHEMA,
    createdAt,
    updatedAt,
    entries,
  };
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is not supported by every filesystem Electron supports.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function stableFileDigest(filePath: string): Promise<{
  identity: FileIdentity;
  sha256: string;
}> {
  const beforeStat = await fs.lstat(filePath);
  if (
    !beforeStat.isFile()
    || beforeStat.isSymbolicLink()
    || beforeStat.size < 1
    || beforeStat.size > MAX_WORKING_RESULT_PACK_BYTES
  ) {
    throw new Error("The working-result pack is not a bounded regular file.");
  }
  const before = fileIdentity(beforeStat);
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW),
  );
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    const opened = fileIdentity(await handle.stat());
    if (!sameIdentity(before, opened)) {
      throw new Error("The working-result pack changed before retention verification.");
    }
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, opened.size - position),
        position,
      );
      if (bytesRead <= 0) {
        throw new Error("The working-result pack ended during retention verification.");
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const after = fileIdentity(await fs.lstat(filePath));
  if (!sameIdentity(before, after)) {
    throw new Error("The working-result pack changed during retention verification.");
  }
  return { identity: before, sha256: digest.digest("hex") };
}

function diagnosticsFor(
  ledger: RetentionLedger,
  inventory: Inventory,
  quotaBytes: number,
): ClassifiedInventory {
  const referencedByLocator = new Map<string, WorkingResultReference>();
  const unreferencedEntriesByLocator = new Map<string, WorkingResultReference[]>();
  const invalidReferencedLocators = new Set<string>();
  for (const entry of Object.values(ledger.entries)) {
    const entryLocator = locator(entry.jobId, entry.artifact.filename);
    if (entry.state === "referenced") {
      const previous = referencedByLocator.get(entryLocator);
      if (previous && !sameArtifact(previous.artifact, entry.artifact)) {
        invalidReferencedLocators.add(entryLocator);
      } else {
        referencedByLocator.set(entryLocator, entry);
      }
    } else {
      const entries = unreferencedEntriesByLocator.get(entryLocator) ?? [];
      entries.push(entry);
      unreferencedEntriesByLocator.set(entryLocator, entries);
    }
  }

  let missingReferencedPackCount = 0;
  let invalidReferencedPackCount = invalidReferencedLocators.size;
  let referencedBytes = 0;
  for (const [entryLocator, entry] of referencedByLocator) {
    const pack = inventory.packs.get(entryLocator);
    if (!pack) {
      missingReferencedPackCount += 1;
    } else if (pack.size !== entry.artifact.byteLength) {
      invalidReferencedPackCount += 1;
      invalidReferencedLocators.add(entryLocator);
    } else {
      referencedBytes += pack.size;
    }
  }

  let totalBytes = 0;
  let unreferencedBytes = 0;
  let unreferencedPackCount = 0;
  let legacyProtectedPackCount = 0;
  const ledgerCreatedAt = Date.parse(ledger.createdAt);
  for (const [entryLocator, pack] of inventory.packs) {
    totalBytes += pack.size;
    if (!referencedByLocator.has(entryLocator)) {
      unreferencedPackCount += 1;
      unreferencedBytes += pack.size;
      if (
        !unreferencedEntriesByLocator.has(entryLocator)
        && pack.mtimeMs <= ledgerCreatedAt
      ) {
        legacyProtectedPackCount += 1;
      }
    }
  }
  const gcBlocked = missingReferencedPackCount > 0 || invalidReferencedPackCount > 0;
  return {
    diagnostics: {
      schemaVersion: WORKING_RESULT_RETENTION_SCHEMA,
      quotaBytes,
      totalPackCount: inventory.packs.size,
      totalBytes,
      referencedPackCount: referencedByLocator.size,
      referencedBytes,
      unreferencedPackCount,
      unreferencedBytes,
      legacyProtectedPackCount,
      unsafeEntryCount: inventory.unsafeEntryCount,
      missingReferencedPackCount,
      invalidReferencedPackCount,
      overQuotaBytes: Math.max(0, totalBytes - quotaBytes),
      gcBlocked,
    },
    referencedLocators: new Set(referencedByLocator.keys()),
    unreferencedEntriesByLocator,
    invalidReferencedLocators,
  };
}

export class WorkingResultRetentionStore {
  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly rootIdentity: Pick<FileIdentity, "dev" | "ino">,
    private readonly gracePeriodMs: number,
    private readonly quotaBytes: number,
    private readonly now: () => Date,
  ) {}

  static async open(
    requestedRoot: string,
    options: WorkingResultRetentionOptions = {},
  ): Promise<WorkingResultRetentionStore> {
    if (
      !options
      || typeof options !== "object"
      || Array.isArray(options)
      || Object.keys(options).some((key) => !["gracePeriodMs", "quotaBytes", "now"].includes(key))
    ) {
      throw new Error("The working-result retention options are invalid.");
    }
    if (typeof requestedRoot !== "string" || !path.isAbsolute(requestedRoot)) {
      throw new Error("The working-result retention root must be absolute.");
    }
    const gracePeriodMs = boundedInteger(
      options.gracePeriodMs ?? DEFAULT_WORKING_RESULT_GRACE_PERIOD_MS,
      "Working-result grace period",
      { maximum: 10 * 365 * 24 * 60 * 60 * 1_000 },
    );
    const quotaBytes = boundedInteger(
      options.quotaBytes ?? DEFAULT_WORKING_RESULT_QUOTA_BYTES,
      "Working-result quota",
      { minimum: 1 },
    );
    const now = options.now ?? (() => new Date());
    const initialNow = now();
    if (!(initialNow instanceof Date) || !Number.isFinite(initialNow.getTime())) {
      throw new Error("The working-result retention clock is invalid.");
    }
    await fs.mkdir(requestedRoot, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(requestedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("The working-result retention root must be a private directory.");
    }
    if (process.platform !== "win32") await fs.chmod(requestedRoot, 0o700);
    const root = await fs.realpath(requestedRoot);
    const store = new WorkingResultRetentionStore(
      root,
      { dev: rootStat.dev, ino: rootStat.ino },
      gracePeriodMs,
      quotaBytes,
      now,
    );
    await store.initialize(initialNow.toISOString());
    return store;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.catch(() => undefined).then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private currentTimestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The working-result retention clock is invalid.");
    }
    return value.toISOString();
  }

  private async assertRoot(): Promise<void> {
    const stat = await fs.lstat(this.root);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.dev !== this.rootIdentity.dev
      || stat.ino !== this.rootIdentity.ino
    ) {
      throw new Error("The working-result retention root changed unexpectedly.");
    }
  }

  private ledgerPath(): string {
    return path.join(this.root, WORKING_RESULT_RETENTION_LEDGER);
  }

  private async initialize(createdAt: string): Promise<void> {
    await this.assertRoot();
    try {
      await this.readLedger();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeLedger({
        schemaVersion: WORKING_RESULT_RETENTION_SCHEMA,
        createdAt,
        updatedAt: createdAt,
        entries: {},
      });
    }
  }

  private async readLedger(): Promise<RetentionLedger> {
    await this.assertRoot();
    const ledgerPath = this.ledgerPath();
    const before = await fs.lstat(ledgerPath);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.size < 1
      || before.size > MAX_LEDGER_BYTES
    ) {
      throw new Error("The working-result retention ledger is not a bounded regular file.");
    }
    const handle = await fs.open(
      ledgerPath,
      fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW),
    );
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!sameIdentity(fileIdentity(before), fileIdentity(opened))) {
        throw new Error("The working-result retention ledger changed before it was read.");
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const after = await fs.lstat(ledgerPath);
    if (!sameIdentity(fileIdentity(before), fileIdentity(after))) {
      throw new Error("The working-result retention ledger changed while it was read.");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new Error("The working-result retention ledger is not valid JSON.");
    }
    return validateLedger(value);
  }

  private async writeLedger(ledger: RetentionLedger): Promise<void> {
    await this.assertRoot();
    const normalized = validateLedger(ledger);
    const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
    if (bytes.byteLength > MAX_LEDGER_BYTES) {
      throw new Error("The working-result retention ledger exceeds its size bound.");
    }
    const temporary = path.join(
      this.root,
      `.${WORKING_RESULT_RETENTION_LEDGER}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.assertRoot();
      await fs.rename(temporary, this.ledgerPath());
      await fsyncDirectory(this.root);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async containedPackPath(
    jobId: string,
    filename: string,
    requestedPath: string,
  ): Promise<string> {
    await this.assertRoot();
    const jobDirectory = path.join(this.root, jobId);
    const directoryStat = await fs.lstat(jobDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("The working-result job storage is not a regular directory.");
    }
    const canonicalDirectory = await fs.realpath(jobDirectory);
    if (path.dirname(canonicalDirectory) !== this.root || path.basename(canonicalDirectory) !== jobId) {
      throw new Error("The working-result job storage escaped its private root.");
    }
    const requestedDirectory = path.dirname(path.normalize(requestedPath));
    const requestedDirectoryStat = await fs.lstat(requestedDirectory).catch(() => null);
    const canonicalRequestedDirectory = requestedDirectoryStat?.isDirectory()
      && !requestedDirectoryStat.isSymbolicLink()
      ? await fs.realpath(requestedDirectory)
      : null;
    if (
      path.basename(requestedPath) !== filename
      || canonicalRequestedDirectory !== canonicalDirectory
    ) {
      throw new Error("The working-result pack escaped its private job storage.");
    }
    return path.join(canonicalDirectory, filename);
  }

  private async scanInventory(): Promise<Inventory> {
    await this.assertRoot();
    const packs = new Map<string, ScannedPack>();
    let unsafeEntryCount = 0;
    const rootEntries = await fs.readdir(this.root, { withFileTypes: true });
    for (const rootEntry of rootEntries) {
      if (rootEntry.name === WORKING_RESULT_RETENTION_LEDGER) continue;
      if (!JOB_IDENTIFIER_PATTERN.test(rootEntry.name)) {
        if (!rootEntry.name.startsWith(`.${WORKING_RESULT_RETENTION_LEDGER}.`)) {
          unsafeEntryCount += 1;
        }
        continue;
      }
      const jobDirectory = path.join(this.root, rootEntry.name);
      const directoryStat = await fs.lstat(jobDirectory).catch(() => null);
      if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
        unsafeEntryCount += 1;
        continue;
      }
      const files = await fs.readdir(jobDirectory, { withFileTypes: true }).catch(() => null);
      if (!files) {
        unsafeEntryCount += 1;
        continue;
      }
      for (const file of files) {
        if (!file.name.endsWith(".loci-result")) continue;
        const match = PACK_BASENAME_PATTERN.exec(file.name);
        const packPath = path.join(jobDirectory, file.name);
        const stat = await fs.lstat(packPath).catch(() => null);
        if (
          !match
          || !stat?.isFile()
          || stat.isSymbolicLink()
          || stat.size < 1
          || stat.size > MAX_WORKING_RESULT_PACK_BYTES
        ) {
          unsafeEntryCount += 1;
          continue;
        }
        packs.set(locator(rootEntry.name, file.name), {
          jobId: rootEntry.name,
          filename: file.name,
          filePath: packPath,
          ...fileIdentity(stat),
        });
      }
    }
    return { packs, unsafeEntryCount };
  }

  private async verifyReferenceInput(
    normalized: WorkingResultReferenceInput,
  ): Promise<VerifiedReferenceInput> {
    const packPath = await this.containedPackPath(
      normalized.jobId,
      normalized.artifact.filename,
      normalized.packPath,
    );
    const verified = await stableFileDigest(packPath);
    if (
      verified.identity.size !== normalized.artifact.byteLength
      || verified.sha256 !== normalized.artifact.sha256
    ) {
      throw new Error("The working-result pack does not match its artifact identity.");
    }
    return { input: normalized, packPath, identity: verified.identity };
  }

  private assertNoLocatorConflict(
    entries: Iterable<WorkingResultReference>,
    candidate: WorkingResultReferenceInput,
  ): void {
    const candidateLocator = locator(candidate.jobId, candidate.artifact.filename);
    for (const entry of entries) {
      if (
        locator(entry.jobId, entry.artifact.filename) === candidateLocator
        && !sameArtifact(entry.artifact, candidate.artifact)
      ) {
        throw new Error("The working-result storage locator has conflicting artifact identities.");
      }
    }
  }

  async reference(input: WorkingResultReferenceInput): Promise<WorkingResultReference> {
    return this.exclusive(async () => {
      const normalized = normalizedReferenceInput(input);
      await this.verifyReferenceInput(normalized);
      const ledger = await this.readLedger();
      const key = referenceKey(normalized);
      const existing = ledger.entries[key];
      if (
        existing
        && (
          existing.jobId !== normalized.jobId
          || !sameArtifact(existing.artifact, normalized.artifact)
        )
      ) {
        throw new Error("This project result revision already references another artifact.");
      }
      this.assertNoLocatorConflict(Object.values(ledger.entries), normalized);
      if (existing?.state === "referenced") return structuredClone(existing);
      const now = this.currentTimestamp();
      const reference: WorkingResultReference = {
        projectId: normalized.projectId,
        resultId: normalized.resultId,
        revision: normalized.revision,
        jobId: normalized.jobId,
        artifact: normalized.artifact,
        state: "referenced",
        referencedAt: now,
        unreferencedAt: null,
      };
      ledger.entries[key] = reference;
      ledger.updatedAt = now;
      await this.writeLedger(ledger);
      return structuredClone(reference);
    });
  }

  /**
   * Replace one project's complete working-result reference set in one ledger
   * publication. Every proposed pack is verified before any prior reference is
   * released, so a bad input leaves the existing project set untouched.
   */
  async reconcileProject(
    projectIdValue: string,
    inputs: WorkingResultProjectReferenceInput[],
  ): Promise<WorkingResultProjectReconciliationReceipt> {
    return this.exclusive(async () => {
      const projectId = identifier(projectIdValue, "Working-result project identifier");
      if (!Array.isArray(inputs) || inputs.length > MAX_LEDGER_ENTRIES) {
        throw new Error("The working-result project reference set is invalid.");
      }
      const normalized = inputs.map((input) => {
        if (!exactRecord(input, [
          "resultId",
          "revision",
          "jobId",
          "artifact",
          "packPath",
        ])) {
          throw new Error("The working-result project reference set is invalid.");
        }
        return normalizedReferenceInput({ ...input, projectId });
      });
      const requestedKeys = new Set<string>();
      const requestedLocators = new Map<string, WorkingResultReferenceInput>();
      for (const input of normalized) {
        const key = referenceKey(input);
        if (requestedKeys.has(key)) {
          throw new Error("The working-result project reference set contains a duplicate revision.");
        }
        requestedKeys.add(key);
        const inputLocator = locator(input.jobId, input.artifact.filename);
        const previous = requestedLocators.get(inputLocator);
        if (previous && !sameArtifact(previous.artifact, input.artifact)) {
          throw new Error("The working-result project reference set contains conflicting artifacts.");
        }
        requestedLocators.set(inputLocator, input);
      }

      // Complete every expensive filesystem/hash check before reading or
      // transforming the authoritative ledger.
      const verified: VerifiedReferenceInput[] = [];
      for (const input of normalized) verified.push(await this.verifyReferenceInput(input));

      const ledger = await this.readLedger();
      for (const item of normalized) {
        const existing = ledger.entries[referenceKey(item)];
        if (
          existing
          && (
            existing.jobId !== item.jobId
            || !sameArtifact(existing.artifact, item.artifact)
          )
        ) {
          throw new Error("This project result revision already references another artifact.");
        }
        this.assertNoLocatorConflict(Object.values(ledger.entries), item);
      }
      // Recheck inode/size/mtime after all validation and conflict work. A pack
      // replaced in the reconciliation window aborts the transaction.
      for (const item of verified) {
        const latest = await fs.lstat(item.packPath).catch(() => null);
        if (
          !latest?.isFile()
          || latest.isSymbolicLink()
          || !sameIdentity(item.identity, fileIdentity(latest))
        ) {
          throw new Error("A working-result pack changed during project reconciliation.");
        }
      }

      const now = this.currentTimestamp();
      const released: WorkingResultReferenceKey[] = [];
      for (const [key, entry] of Object.entries(ledger.entries)) {
        if (
          entry.projectId === projectId
          && entry.state === "referenced"
          && !requestedKeys.has(key)
        ) {
          ledger.entries[key] = {
            ...entry,
            state: "unreferenced",
            unreferencedAt: now,
          };
          released.push({
            projectId: entry.projectId,
            resultId: entry.resultId,
            revision: entry.revision,
          });
        }
      }

      const references: WorkingResultReference[] = [];
      for (const item of normalized) {
        const key = referenceKey(item);
        const existing = ledger.entries[key];
        const reference: WorkingResultReference = existing?.state === "referenced"
          ? existing
          : {
              projectId,
              resultId: item.resultId,
              revision: item.revision,
              jobId: item.jobId,
              artifact: item.artifact,
              state: "referenced",
              referencedAt: now,
              unreferencedAt: null,
            };
        ledger.entries[key] = reference;
        references.push(structuredClone(reference));
      }
      ledger.updatedAt = now;
      await this.writeLedger(ledger);
      return {
        projectId,
        references,
        released,
      };
    });
  }

  /**
   * Reclaim process-owned references after an unclean exit.
   *
   * The caller must hold Loci's single-instance lock. Exact completed batch
   * outputs are adopted under stable batch owners before references belonging
   * to prior process sessions are released. Durable project owners are never
   * changed here. The complete stable-batch set is supplied on every startup,
   * so owners for batches that have since completed or been abandoned are also
   * released without accumulating indefinitely.
   */
  async recoverStaleSessionReferences(
    currentSessionOwnerIdValue: string,
    recoverableBatchInputs: WorkingResultReferenceInput[],
  ): Promise<WorkingResultSessionRecoveryReceipt> {
    return this.exclusive(async () => {
      const currentSessionOwnerId = identifier(
        currentSessionOwnerIdValue,
        "Working-result session owner",
      );
      if (!SESSION_OWNER_PATTERN.test(currentSessionOwnerId)) {
        throw new Error("The current working-result session owner is invalid.");
      }
      if (!Array.isArray(recoverableBatchInputs) || recoverableBatchInputs.length > MAX_LEDGER_ENTRIES) {
        throw new Error("The recoverable batch reference set is invalid.");
      }
      const normalized = recoverableBatchInputs.map((input) => {
        const candidate = normalizedReferenceInput(input);
        if (!isBatchRecoveryOwner(candidate.projectId)) {
          throw new Error("A recoverable batch reference has an invalid stable owner.");
        }
        return candidate;
      });
      const requestedKeys = new Set<string>();
      for (const input of normalized) {
        const key = referenceKey(input);
        if (requestedKeys.has(key)) {
          throw new Error("The recoverable batch reference set contains a duplicate revision.");
        }
        requestedKeys.add(key);
      }

      // Verify every pack before changing any ownership. A corrupt or missing
      // recoverable batch output makes startup cleanup fail closed.
      const verified: VerifiedReferenceInput[] = [];
      for (const input of normalized) verified.push(await this.verifyReferenceInput(input));
      const ledger = await this.readLedger();
      for (const input of normalized) {
        const existing = ledger.entries[referenceKey(input)];
        if (
          existing
          && (
            existing.jobId !== input.jobId
            || !sameArtifact(existing.artifact, input.artifact)
          )
        ) {
          throw new Error("This recoverable batch revision already references another artifact.");
        }
        this.assertNoLocatorConflict(Object.values(ledger.entries), input);
      }
      for (const item of verified) {
        const latest = await fs.lstat(item.packPath).catch(() => null);
        if (
          !latest?.isFile()
          || latest.isSymbolicLink()
          || !sameIdentity(item.identity, fileIdentity(latest))
        ) {
          throw new Error("A working-result pack changed during startup recovery.");
        }
      }

      const now = this.currentTimestamp();
      const released: WorkingResultReferenceKey[] = [];
      let ledgerChanged = false;
      for (const [key, entry] of Object.entries(ledger.entries)) {
        const staleSession = SESSION_OWNER_PATTERN.test(entry.projectId)
          && entry.projectId !== currentSessionOwnerId;
        const retiredBatchOwner = isBatchRecoveryOwner(entry.projectId)
          && !requestedKeys.has(key);
        if (entry.state !== "referenced" || (!staleSession && !retiredBatchOwner)) continue;
        ledger.entries[key] = {
          ...entry,
          state: "unreferenced",
          unreferencedAt: now,
        };
        ledgerChanged = true;
        released.push({
          projectId: entry.projectId,
          resultId: entry.resultId,
          revision: entry.revision,
        });
      }

      const adopted: WorkingResultReference[] = [];
      for (const input of normalized) {
        const key = referenceKey(input);
        const existing = ledger.entries[key];
        if (existing?.state !== "referenced") ledgerChanged = true;
        const reference: WorkingResultReference = existing?.state === "referenced"
          ? existing
          : {
              projectId: input.projectId,
              resultId: input.resultId,
              revision: input.revision,
              jobId: input.jobId,
              artifact: input.artifact,
              state: "referenced",
              referencedAt: now,
              unreferencedAt: null,
            };
        ledger.entries[key] = reference;
        adopted.push(structuredClone(reference));
      }
      if (ledgerChanged) {
        ledger.updatedAt = now;
        await this.writeLedger(ledger);
      }
      return { adopted, released };
    });
  }

  async unreference(input: WorkingResultReferenceKey): Promise<boolean> {
    return this.exclusive(async () => {
      const normalized = normalizedReferenceKey(input);
      const ledger = await this.readLedger();
      const key = referenceKey(normalized);
      const existing = ledger.entries[key];
      if (!existing || existing.state === "unreferenced") return false;
      const now = this.currentTimestamp();
      ledger.entries[key] = {
        ...existing,
        state: "unreferenced",
        unreferencedAt: now,
      };
      ledger.updatedAt = now;
      await this.writeLedger(ledger);
      return true;
    });
  }

  async diagnostics(): Promise<WorkingResultRetentionDiagnostics> {
    return this.exclusive(async () => {
      const ledger = await this.readLedger();
      const inventory = await this.scanInventory();
      return diagnosticsFor(ledger, inventory, this.quotaBytes).diagnostics;
    });
  }

  async collectGarbage(
    options: { gracePeriodMs?: number } = {},
  ): Promise<WorkingResultGarbageCollectionReceipt> {
    return this.exclusive(async () => {
      if (!exactRecord(options, options.gracePeriodMs === undefined ? [] : ["gracePeriodMs"])) {
        throw new Error("The working-result garbage-collection options are invalid.");
      }
      const gracePeriodMs = boundedInteger(
        options.gracePeriodMs ?? this.gracePeriodMs,
        "Working-result grace period",
        { maximum: 10 * 365 * 24 * 60 * 60 * 1_000 },
      );
      const ledger = await this.readLedger();
      const inventory = await this.scanInventory();
      const classified = diagnosticsFor(ledger, inventory, this.quotaBytes);
      if (classified.diagnostics.gcBlocked) {
        const blockedReasons: string[] = [];
        if (classified.diagnostics.missingReferencedPackCount) {
          blockedReasons.push("One or more referenced working results are missing.");
        }
        if (classified.diagnostics.invalidReferencedPackCount) {
          blockedReasons.push("One or more referenced working results have conflicting identity.");
        }
        return {
          deleted: [],
          deletedBytes: 0,
          graceRetainedCount: classified.diagnostics.unreferencedPackCount,
          integritySkippedCount: 0,
          failedDeletionCount: 0,
          blockedReasons,
          diagnostics: classified.diagnostics,
        };
      }

      const nowMs = Date.parse(this.currentTimestamp());
      const ledgerCreatedAtMs = Date.parse(ledger.createdAt);
      const deleted: WorkingResultGarbageCollectionReceipt["deleted"] = [];
      let deletedBytes = 0;
      let graceRetainedCount = 0;
      let integritySkippedCount = 0;
      let failedDeletionCount = 0;
      let ledgerChanged = false;

      const candidates = [...inventory.packs.entries()]
        .filter(([entryLocator]) => !classified.referencedLocators.has(entryLocator))
        .sort(([, left], [, right]) =>
          left.mtimeMs - right.mtimeMs || left.jobId.localeCompare(right.jobId) ||
          left.filename.localeCompare(right.filename));
      for (const [entryLocator, pack] of candidates) {
        const released = classified.unreferencedEntriesByLocator.get(entryLocator) ?? [];
        if (!released.length && pack.mtimeMs <= ledgerCreatedAtMs) {
          graceRetainedCount += 1;
          continue;
        }
        const releasedAtMs = released.length
          ? Math.max(...released.map((entry) => Date.parse(entry.unreferencedAt!)))
          : pack.mtimeMs;
        if (nowMs - releasedAtMs < gracePeriodMs) {
          graceRetainedCount += 1;
          continue;
        }

        let verified: Awaited<ReturnType<typeof stableFileDigest>>;
        try {
          verified = await stableFileDigest(pack.filePath);
        } catch {
          integritySkippedCount += 1;
          continue;
        }
        if (released.length) {
          if (
            !sameIdentity(pack, verified.identity)
            || released.some((entry) =>
              entry.artifact.byteLength !== verified.identity.size
              || entry.artifact.sha256 !== verified.sha256)
          ) {
            integritySkippedCount += 1;
            continue;
          }
        }

        const latest = await fs.lstat(pack.filePath).catch(() => null);
        if (
          !latest?.isFile()
          || latest.isSymbolicLink()
          || !sameIdentity(pack, fileIdentity(latest))
        ) {
          integritySkippedCount += 1;
          continue;
        }
        try {
          await fs.unlink(pack.filePath);
        } catch {
          failedDeletionCount += 1;
          continue;
        }
        const matchingReleasedKeys = Object.entries(ledger.entries).flatMap(([key, entry]) =>
          entry.state === "unreferenced"
          && locator(entry.jobId, entry.artifact.filename) === entryLocator
            ? [key]
            : []);
        for (const key of matchingReleasedKeys) delete ledger.entries[key];
        ledgerChanged ||= matchingReleasedKeys.length > 0;
        deletedBytes += pack.size;
        deleted.push({
          jobId: pack.jobId,
          artifact: released[0]?.artifact ?? {
            artifactId: WORKING_RESULT_ARTIFACT_ID,
            filename: pack.filename,
            mediaType: WORKING_RESULT_MEDIA_TYPE,
            byteLength: pack.size,
            sha256: verified.sha256,
          },
        });
      }

      if (ledgerChanged) {
        ledger.updatedAt = this.currentTimestamp();
        await this.writeLedger(ledger);
      }
      const finalInventory = await this.scanInventory();
      const finalDiagnostics = diagnosticsFor(
        ledger,
        finalInventory,
        this.quotaBytes,
      ).diagnostics;
      return {
        deleted,
        deletedBytes,
        graceRetainedCount,
        integritySkippedCount,
        failedDeletionCount,
        blockedReasons: [],
        diagnostics: finalDiagnostics,
      };
    });
  }
}

export async function openWorkingResultRetentionStore(
  root: string,
  options: WorkingResultRetentionOptions = {},
): Promise<WorkingResultRetentionStore> {
  return WorkingResultRetentionStore.open(root, options);
}
