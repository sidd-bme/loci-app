import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import {
  MAX_PROJECT_SOURCES,
  type ProjectManifestV1,
} from "../shared/foundation-contracts";
import { validateProjectManifestV1 } from "../shared/foundation-validation";
import { validateDurableJobSnapshot } from "./job-store";

export const PROJECT_FILE_SCHEMA = "loci.project-file/v1" as const;
export const PROJECT_SUMMARY_SCHEMA = "loci.project-summary/v1" as const;
export const PROJECT_FILE_EXTENSION = ".loci-project" as const;
export const MAX_PROJECT_FILE_BYTES = 128 * 1024 * 1024;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ProjectPathPlatform = "posix" | "win32";

/**
 * Main-process-only source authority. This is deliberately absent from the
 * renderer-safe ProjectManifestV1 and every summary returned by this module.
 */
export interface ProjectSourceLocatorV1 {
  sourceId: string;
  kind: "local-file";
  platform: ProjectPathPlatform;
  canonicalPath: string;
}

export interface ProjectFileV1 {
  schemaVersion: typeof PROJECT_FILE_SCHEMA;
  revision: number;
  manifest: ProjectManifestV1;
  sourceLocators: ProjectSourceLocatorV1[];
}

export interface OpenProjectSession {
  /** Main-process-only project-document location. Never send this object over IPC. */
  filePath: string;
  document: ProjectFileV1;
  persistenceToken: string;
}

export interface ProjectPublicationGuard<Token = unknown> {
  /** Captured synchronously when a publisher starts, before any filesystem I/O. */
  begin: () => Token;
  /** Runs at the final application-controlled boundary before atomic publication. */
  beforeCommit: (token: Token) => void | Promise<void>;
  /** Optional failure notification for a guard that claimed an external transaction. */
  failed?: (token: Token) => void;
}

const NO_PROJECT_PUBLICATION_GUARD: ProjectPublicationGuard<undefined> = {
  begin: () => undefined,
  beforeCommit: () => undefined,
};

let projectPublicationGuard: ProjectPublicationGuard<any> = NO_PROJECT_PUBLICATION_GUARD;

/**
 * Install the process-wide project publication fence. All project writers use
 * this lowest-level boundary, including correction/batch checkpoints and
 * compensating result-retirement saves that never originate in the renderer.
 */
export function installProjectPublicationGuard<Token>(
  guard: ProjectPublicationGuard<Token>,
): () => void {
  const previous = projectPublicationGuard;
  projectPublicationGuard = guard;
  return () => {
    if (projectPublicationGuard === guard) projectPublicationGuard = previous;
  };
}

interface ProjectPublicationAttempt {
  guard: ProjectPublicationGuard<any>;
  token: unknown;
}

function beginProjectPublication(): ProjectPublicationAttempt {
  const guard = projectPublicationGuard;
  return { guard, token: guard.begin() };
}

async function beforeProjectPublicationCommit(
  attempt: ProjectPublicationAttempt,
  publisherBoundary: () => void | Promise<void> = () => undefined,
): Promise<void> {
  await attempt.guard.beforeCommit(attempt.token);
  await publisherBoundary();
}

function projectPublicationFailed(attempt: ProjectPublicationAttempt): void {
  attempt.guard.failed?.(attempt.token);
}

export interface ProjectSummary {
  schemaVersion: typeof PROJECT_SUMMARY_SCHEMA;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
  revision: number;
  sources: Array<{
    sourceId: string;
    displayName: string;
    relativeLabel: string;
    fingerprintStatus: "pending" | "verified" | "failed";
    inspectionStatus: "pending" | "ready" | "failed";
    workspace: "generic-2d" | "pathology-2d" | "scientific-volume" | null;
  }>;
  counts: {
    displayRecipes: number;
    annotations: number;
    corrections: number;
    modelResults: number;
    jobs: number;
  };
}

export class ProjectStoreError extends Error {
  constructor(
    public readonly code:
      | "invalid-project"
      | "unsupported-version"
      | "invalid-location"
      | "already-exists"
      | "not-found"
      | "conflict"
      | "too-large"
      | "unsafe-source-target",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectStoreError";
  }
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectStoreError("invalid-project", `${location} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  location: string,
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      throw new ProjectStoreError(
        "invalid-project",
        `${location} contains an unsupported field: ${key}.`,
      );
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      throw new ProjectStoreError("invalid-project", `${location}.${key} is required.`);
    }
  }
}

function safeIdentifier(value: unknown, location: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    CONTROL_CHARACTER.test(value) ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new ProjectStoreError("invalid-project", `${location} is invalid.`);
  }
  return value;
}

function canonicalSourcePath(
  value: unknown,
  platform: ProjectPathPlatform,
  location: string,
): string {
  if (typeof value !== "string" || !value || CONTROL_CHARACTER.test(value)) {
    throw new ProjectStoreError("invalid-project", `${location} is invalid.`);
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value) || pathApi.normalize(value) !== value) {
    throw new ProjectStoreError(
      "invalid-project",
      `${location} must be a normalized absolute ${platform} path.`,
    );
  }
  return value;
}

function validateSourceLocator(
  value: unknown,
  index: number,
): ProjectSourceLocatorV1 {
  const location = `project.sourceLocators[${index}]`;
  const candidate = record(value, location);
  exactKeys(candidate, ["sourceId", "kind", "platform", "canonicalPath"], location);
  if (candidate.kind !== "local-file") {
    throw new ProjectStoreError("invalid-project", `${location}.kind is unsupported.`);
  }
  if (candidate.platform !== "posix" && candidate.platform !== "win32") {
    throw new ProjectStoreError("invalid-project", `${location}.platform is unsupported.`);
  }
  return {
    sourceId: safeIdentifier(candidate.sourceId, `${location}.sourceId`),
    kind: "local-file",
    platform: candidate.platform,
    canonicalPath: canonicalSourcePath(
      candidate.canonicalPath,
      candidate.platform,
      `${location}.canonicalPath`,
    ),
  };
}

function validateRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProjectStoreError(
      "invalid-project",
      "project.revision must be a non-negative safe integer.",
    );
  }
  return value as number;
}

function cloned<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Version migration entry point. Version 1 is intentionally an identity
 * migration today; keeping the switch here makes future migrations explicit
 * and prevents a newer document from being interpreted as an older schema.
 */
export function migrateProjectDocument(value: unknown): ProjectFileV1 {
  const candidate = record(value, "project");
  const schemaVersion = candidate.schemaVersion;
  if (schemaVersion !== PROJECT_FILE_SCHEMA) {
    throw new ProjectStoreError(
      "unsupported-version",
      `This project version is not supported: ${String(schemaVersion)}.`,
    );
  }
  const manifest = record(candidate.manifest, "project.manifest");
  // `reviews` and correction-pack identities were added while the v1 format
  // was still in beta. A legacy correction has no trustworthy way to recover
  // its exact immutable pack, so fail safe by dropping only that unbound
  // correction reference. The original analytical result remains available.
  const corrections = Array.isArray(manifest.corrections)
    ? manifest.corrections.filter((correction) => {
        if (correction === null || typeof correction !== "object" || Array.isArray(correction)) {
          return true;
        }
        if (Object.hasOwn(correction, "workingResultArtifact")) return true;
        const keys = Object.keys(correction).sort();
        const legacyKeys = [
          "correctionId",
          "operationIds",
          "resultId",
          "revision",
          "sourceId",
        ];
        return JSON.stringify(keys) !== JSON.stringify(legacyKeys);
      })
    : manifest.corrections;
  const normalized = {
    ...candidate,
    manifest: {
      ...manifest,
      ...(Object.hasOwn(manifest, "reviews") ? {} : { reviews: [] }),
      corrections,
    },
  };
  return validateProjectDocument(normalized);
}

export function validateProjectDocument(value: unknown): ProjectFileV1 {
  const candidate = record(value, "project");
  exactKeys(candidate, ["schemaVersion", "revision", "manifest", "sourceLocators"], "project");
  if (candidate.schemaVersion !== PROJECT_FILE_SCHEMA) {
    throw new ProjectStoreError(
      "unsupported-version",
      `This project version is not supported: ${String(candidate.schemaVersion)}.`,
    );
  }

  const manifestCandidate = record(candidate.manifest, "project.manifest");
  if (!Array.isArray(manifestCandidate.sources)) {
    throw new ProjectStoreError("invalid-project", "project.manifest.sources must be an array.");
  }
  if (manifestCandidate.sources.length > MAX_PROJECT_SOURCES) {
    throw new ProjectStoreError(
      "invalid-project",
      `A project may contain at most ${MAX_PROJECT_SOURCES} sources.`,
    );
  }
  if (!Array.isArray(candidate.sourceLocators)) {
    throw new ProjectStoreError("invalid-project", "project.sourceLocators must be an array.");
  }
  if (candidate.sourceLocators.length > MAX_PROJECT_SOURCES) {
    throw new ProjectStoreError(
      "invalid-project",
      `A project may contain at most ${MAX_PROJECT_SOURCES} source locators.`,
    );
  }

  let manifest: ProjectManifestV1;
  try {
    manifest = validateProjectManifestV1(candidate.manifest);
    manifest.jobs.forEach(validateDurableJobSnapshot);
  } catch (error) {
    throw new ProjectStoreError(
      "invalid-project",
      error instanceof Error ? error.message : "The project manifest is invalid.",
      { cause: error },
    );
  }
  const sourceLocators = candidate.sourceLocators.map(validateSourceLocator);
  const locatorIds = new Set<string>();
  const locatorPaths = new Set<string>();
  for (const locator of sourceLocators) {
    if (locatorIds.has(locator.sourceId)) {
      throw new ProjectStoreError(
        "invalid-project",
        `The project contains duplicate locator sourceId ${locator.sourceId}.`,
      );
    }
    locatorIds.add(locator.sourceId);
    const locatorPathKey = locator.platform === "win32"
      ? locator.canonicalPath.toLocaleLowerCase("en-US")
      : locator.canonicalPath;
    if (locatorPaths.has(locatorPathKey)) {
      throw new ProjectStoreError(
        "invalid-project",
        "A project cannot assign the same source location to multiple source identifiers.",
      );
    }
    locatorPaths.add(locatorPathKey);
  }
  const manifestIds = new Set(manifest.sources.map(({ sourceId }) => sourceId));
  if (
    locatorIds.size !== manifestIds.size ||
    [...manifestIds].some((sourceId) => !locatorIds.has(sourceId))
  ) {
    throw new ProjectStoreError(
      "invalid-project",
      "Every project source must have exactly one main-process locator.",
    );
  }

  return cloned({
    schemaVersion: PROJECT_FILE_SCHEMA,
    revision: validateRevision(candidate.revision),
    manifest,
    sourceLocators,
  });
}

export function createProjectDocument(
  manifest: ProjectManifestV1,
  sourceLocators: ProjectSourceLocatorV1[],
): ProjectFileV1 {
  return validateProjectDocument({
    schemaVersion: PROJECT_FILE_SCHEMA,
    revision: 0,
    manifest,
    sourceLocators,
  });
}

function serialized(document: ProjectFileV1): Buffer {
  const normalized = validateProjectDocument(document);
  const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
  if (bytes.byteLength > MAX_PROJECT_FILE_BYTES) {
    throw new ProjectStoreError(
      "too-large",
      `The project document exceeds ${MAX_PROJECT_FILE_BYTES} bytes.`,
    );
  }
  return bytes;
}

function persistenceToken(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedProjectPath(requestedPath: string): string {
  if (
    typeof requestedPath !== "string" ||
    !requestedPath ||
    CONTROL_CHARACTER.test(requestedPath) ||
    !path.isAbsolute(requestedPath) ||
    path.normalize(requestedPath) !== requestedPath ||
    path.extname(requestedPath).toLocaleLowerCase("en-US") !== PROJECT_FILE_EXTENSION
  ) {
    throw new ProjectStoreError(
      "invalid-location",
      `Project files require a normalized absolute ${PROJECT_FILE_EXTENSION} path.`,
    );
  }
  return requestedPath;
}

async function checkedWritableDestination(requestedPath: string): Promise<string> {
  const destination = checkedProjectPath(requestedPath);
  let parent: string;
  try {
    parent = await fs.realpath(path.dirname(destination));
    if (!(await fs.stat(parent)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new ProjectStoreError(
      "invalid-location",
      "The project destination directory does not exist or cannot be used.",
      { cause: error },
    );
  }
  return path.join(parent, path.basename(destination));
}

function samePath(left: string, right: string, platform: ProjectPathPlatform): boolean {
  if (platform === "win32") {
    return path.win32.normalize(left).toLocaleLowerCase("en-US") ===
      path.win32.normalize(right).toLocaleLowerCase("en-US");
  }
  return path.posix.normalize(left) === path.posix.normalize(right);
}

async function canonicalComparablePath(value: string): Promise<string> {
  try {
    const parent = await fs.realpath(path.dirname(value));
    return path.join(parent, path.basename(value));
  } catch {
    return value;
  }
}

async function assertProjectIsNotSource(
  destination: string,
  sourceLocators: readonly ProjectSourceLocatorV1[],
): Promise<void> {
  const destinationPlatform: ProjectPathPlatform = process.platform === "win32" ? "win32" : "posix";
  const comparableDestination = await canonicalComparablePath(destination);
  for (const locator of sourceLocators) {
    const comparableSource = locator.platform === destinationPlatform
      ? await canonicalComparablePath(locator.canonicalPath)
      : locator.canonicalPath;
    if (
      locator.platform === destinationPlatform &&
      samePath(comparableDestination, comparableSource, destinationPlatform)
    ) {
      throw new ProjectStoreError(
        "unsafe-source-target",
        "A project document cannot replace one of its immutable source images.",
      );
    }
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some supported filesystems do not allow syncing directory handles. The
    // file itself has already been flushed before publication.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeTemporary(destination: string, bytes: Uint8Array): Promise<string> {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function publishExclusive(
  destination: string,
  bytes: Uint8Array,
  beforeCommit: () => void | Promise<void> = () => undefined,
): Promise<void> {
  const temporary = await writeTemporary(destination, bytes);
  try {
    // Linking a fully flushed same-directory temporary file is an atomic,
    // no-overwrite publication on the filesystems supported by Electron.
    await beforeCommit();
    await fs.link(temporary, destination);
    await fsyncDirectory(path.dirname(destination));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new ProjectStoreError(
        "already-exists",
        "A project already exists at the selected location.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function publishReplacement(
  destination: string,
  bytes: Uint8Array,
  expectedPersistenceToken: string,
  beforeCommit: () => void | Promise<void> = () => undefined,
): Promise<void> {
  const temporary = await writeTemporary(destination, bytes);
  try {
    // Node exposes atomic replacement but not a portable hash-conditional
    // rename. Recheck after the potentially slow temp write so external edits
    // are rejected at the narrowest practical point before publication.
    const latestBytes = await readProjectBytes(destination);
    if (persistenceToken(latestBytes) !== expectedPersistenceToken) {
      throw new ProjectStoreError(
        "conflict",
        "The project changed on disk while it was being saved. Reopen it before saving again.",
      );
    }
    // This claim is the last application-controlled boundary
    // before the atomic rename is submitted to the filesystem. It lets a
    // timed-out quit save fail closed without creating a partially-written
    // project or racing a late publication.
    await beforeCommit();
    await fs.rename(temporary, destination);
    await fsyncDirectory(path.dirname(destination));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readProjectBytes(projectPath: string): Promise<Buffer> {
  let stat;
  try {
    stat = await fs.lstat(projectPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectStoreError("not-found", "The selected project no longer exists.", {
        cause: error,
      });
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ProjectStoreError(
      "invalid-location",
      "The selected project must be a regular file, not a link or directory.",
    );
  }
  if (stat.size > MAX_PROJECT_FILE_BYTES) {
    throw new ProjectStoreError(
      "too-large",
      `The project document exceeds ${MAX_PROJECT_FILE_BYTES} bytes.`,
    );
  }
  const bytes = await fs.readFile(projectPath);
  if (bytes.byteLength > MAX_PROJECT_FILE_BYTES) {
    throw new ProjectStoreError(
      "too-large",
      `The project document exceeds ${MAX_PROJECT_FILE_BYTES} bytes.`,
    );
  }
  return bytes;
}

function parseProjectBytes(bytes: Buffer): ProjectFileV1 {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new ProjectStoreError("invalid-project", "The project document is not valid JSON.", {
      cause: error,
    });
  }
  return migrateProjectDocument(value);
}

function session(filePath: string, document: ProjectFileV1, bytes: Buffer): OpenProjectSession {
  return {
    filePath,
    document: cloned(document),
    persistenceToken: persistenceToken(bytes),
  };
}

export async function createProject(
  requestedPath: string,
  manifest: ProjectManifestV1,
  sourceLocators: ProjectSourceLocatorV1[],
): Promise<OpenProjectSession> {
  const publication = beginProjectPublication();
  try {
    const destination = await checkedWritableDestination(requestedPath);
    const document = createProjectDocument(manifest, sourceLocators);
    await assertProjectIsNotSource(destination, document.sourceLocators);
    const bytes = serialized(document);
    await publishExclusive(destination, bytes, () =>
      beforeProjectPublicationCommit(publication));
    return session(destination, document, bytes);
  } catch (error) {
    projectPublicationFailed(publication);
    throw error;
  }
}

/**
 * Remove only the exact revision-zero project publication represented by a
 * freshly-created session. This is a compensating action for a failed
 * post-publication ownership checkpoint; it must never remove a project that
 * has since been saved or edited by another process.
 */
export async function discardCreatedProject(current: OpenProjectSession): Promise<void> {
  if (current.document.revision !== 0 || !SHA256.test(current.persistenceToken)) {
    throw new ProjectStoreError(
      "conflict",
      "Only an unchanged newly created project can be discarded during rollback.",
    );
  }
  const destination = checkedProjectPath(current.filePath);
  const before = await fs.lstat(destination).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectStoreError(
        "conflict",
        "The newly created project is no longer available for safe rollback.",
        { cause: error },
      );
    }
    throw error;
  });
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PROJECT_FILE_BYTES) {
    throw new ProjectStoreError(
      "conflict",
      "The newly created project changed before rollback and was preserved.",
    );
  }
  const bytes = await readProjectBytes(destination);
  const document = parseProjectBytes(bytes);
  if (
    persistenceToken(bytes) !== current.persistenceToken ||
    document.revision !== current.document.revision ||
    document.manifest.projectId !== current.document.manifest.projectId
  ) {
    throw new ProjectStoreError(
      "conflict",
      "The newly created project changed before rollback and was preserved.",
    );
  }
  const after = await fs.lstat(destination);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    throw new ProjectStoreError(
      "conflict",
      "The newly created project changed before rollback and was preserved.",
    );
  }
  await fs.unlink(destination);
  await fsyncDirectory(path.dirname(destination));
}

export async function openProject(requestedPath: string): Promise<OpenProjectSession> {
  const projectPath = checkedProjectPath(requestedPath);
  const bytes = await readProjectBytes(projectPath);
  return session(projectPath, parseProjectBytes(bytes), bytes);
}

/** Re-read and validate the active project after an external-change prompt. */
export async function reopenProject(current: OpenProjectSession): Promise<OpenProjectSession> {
  return openProject(current.filePath);
}

export async function saveProject(
  current: OpenProjectSession,
  manifest: ProjectManifestV1,
  sourceLocators: ProjectSourceLocatorV1[] = current.document.sourceLocators,
  beforeCommit: () => void | Promise<void> = () => undefined,
): Promise<OpenProjectSession> {
  const publication = beginProjectPublication();
  try {
    const destination = checkedProjectPath(current.filePath);
    const currentBytes = await readProjectBytes(destination);
    if (!SHA256.test(current.persistenceToken) || persistenceToken(currentBytes) !== current.persistenceToken) {
      throw new ProjectStoreError(
        "conflict",
        "The project changed on disk. Reopen it before saving again.",
      );
    }
    const persisted = parseProjectBytes(currentBytes);
    if (
      persisted.revision !== current.document.revision ||
      persisted.manifest.projectId !== current.document.manifest.projectId
    ) {
      throw new ProjectStoreError(
        "conflict",
        "The project changed on disk. Reopen it before saving again.",
      );
    }
    if (
      manifest.projectId !== current.document.manifest.projectId ||
      manifest.createdAt !== current.document.manifest.createdAt
    ) {
      throw new ProjectStoreError(
        "invalid-project",
        "Save must preserve the active project's identity and creation time.",
      );
    }
    const document = validateProjectDocument({
      schemaVersion: PROJECT_FILE_SCHEMA,
      revision: current.document.revision + 1,
      manifest,
      sourceLocators,
    });
    await assertProjectIsNotSource(destination, document.sourceLocators);
    const bytes = serialized(document);
    await publishReplacement(destination, bytes, current.persistenceToken, () =>
      beforeProjectPublicationCommit(publication, beforeCommit));
    return session(destination, document, bytes);
  } catch (error) {
    projectPublicationFailed(publication);
    throw error;
  }
}

/**
 * Publish the active logical project at a new location without overwriting an
 * existing file. Project identity is retained; the original file is untouched
 * and the returned session becomes the new active location.
 */
export async function saveProjectAs(
  current: OpenProjectSession,
  requestedPath: string,
  manifest: ProjectManifestV1 = current.document.manifest,
  sourceLocators: ProjectSourceLocatorV1[] = current.document.sourceLocators,
): Promise<OpenProjectSession> {
  const publication = beginProjectPublication();
  try {
    const destination = await checkedWritableDestination(requestedPath);
    if (
      manifest.projectId !== current.document.manifest.projectId ||
      manifest.createdAt !== current.document.manifest.createdAt
    ) {
      throw new ProjectStoreError(
        "invalid-project",
        "Save As must preserve the active project's identity and creation time.",
      );
    }
    const document = validateProjectDocument({
      schemaVersion: PROJECT_FILE_SCHEMA,
      revision: current.document.revision + 1,
      manifest,
      sourceLocators,
    });
    await assertProjectIsNotSource(destination, document.sourceLocators);
    const bytes = serialized(document);
    await publishExclusive(destination, bytes, () =>
      beforeProjectPublicationCommit(publication));
    return session(destination, document, bytes);
  } catch (error) {
    projectPublicationFailed(publication);
    throw error;
  }
}

export function sanitizedProjectSummary(
  input: OpenProjectSession | ProjectFileV1,
): ProjectSummary {
  const document = "document" in input ? input.document : input;
  const validated = validateProjectDocument(document);
  return {
    schemaVersion: PROJECT_SUMMARY_SCHEMA,
    projectId: validated.manifest.projectId,
    title: validated.manifest.title,
    createdAt: validated.manifest.createdAt,
    updatedAt: validated.manifest.updatedAt,
    appVersion: validated.manifest.appVersion,
    revision: validated.revision,
    sources: validated.manifest.sources.map((source) => ({
      sourceId: source.sourceId,
      displayName: source.displayName,
      relativeLabel: source.relativeLabel,
      fingerprintStatus: source.fingerprint.status,
      inspectionStatus: source.inspectionStatus,
      workspace: source.workspace?.workspace ?? null,
    })),
    counts: {
      displayRecipes: validated.manifest.displayRecipes.length,
      annotations: validated.manifest.annotations.length,
      corrections: validated.manifest.corrections.length,
      modelResults: validated.manifest.modelResults.length,
      jobs: validated.manifest.jobs.length,
    },
  };
}
