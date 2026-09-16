import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

const REGISTRY_SCHEMA = "loci.managed-research-sessions/v1" as const;
const MARKER_SCHEMA = "loci.managed-research-session/v1" as const;
const MAX_REGISTRY_BYTES = 128 * 1024;
const MAX_MARKER_BYTES = 4 * 1024;
const MAX_SESSIONS = 32;
const SESSION_ID = /^[a-f0-9-]{36}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type ManagedSessionRecoveryReason =
  | "saved-study-missing"
  | "saved-study-unsafe"
  | "managed-session-missing"
  | "managed-session-unsafe";

export interface ManagedSessionSummary {
  sessionId: string;
  title: string;
  storage: "managed" | "saved";
  saved: boolean;
  status: "ready" | "recoverable";
  reason: ManagedSessionRecoveryReason | null;
  canKeep: boolean;
  canDiscard: boolean;
  /** Registry activity time; updated on adopt, open, save, or keep. */
  updatedAt: string;
}

export type ManagedSessionState =
  | { status: "empty" }
  | ManagedSessionSummary;

export interface ResolvedManagedSession {
  projectPath: string | null;
  state: ManagedSessionState;
}

export interface ManagedSessionReservation {
  sessionId: string;
  projectPath: string;
  title: string;
  createdAt: string;
}

interface SessionRecord {
  sessionId: string;
  title: string;
  managed: boolean;
  savedPath: string | null;
  activeLocation: "managed" | "saved";
  createdAt: string;
  updatedAt: string;
}

interface RegistryDocument {
  schemaVersion: typeof REGISTRY_SCHEMA;
  activeSessionId: string | null;
  sessions: SessionRecord[];
}

interface OwnershipMarker {
  schemaVersion: typeof MARKER_SCHEMA;
  sessionId: string;
  title: string;
  createdAt: string;
}

interface UndoRecord {
  token: string;
  record: SessionRecord;
  trashedPath: string | null;
}

export class ManagedResearchSessionError extends Error {
  constructor(
    readonly code:
      | "invalid-session"
      | "unsafe-storage"
      | "session-collision"
      | "session-unavailable"
      | "undo-unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedResearchSessionError";
  }
}

function emptyDocument(): RegistryDocument {
  return { schemaVersion: REGISTRY_SCHEMA, activeSessionId: null, sessions: [] };
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

function validText(value: unknown, maximum = 200): value is string {
  return typeof value === "string" &&
    value.length > 0 && value.length <= maximum && !CONTROL_CHARACTER.test(value);
}

function validStudyPath(value: unknown): value is string {
  return typeof value === "string" &&
    !CONTROL_CHARACTER.test(value) &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    value.toLocaleLowerCase("en-US").endsWith(".loci-study");
}

function legacySessionId(projectPath: string): string {
  const value = createHash("sha256").update(projectPath, "utf8").digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function parseRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).some((key) => ![
      "sessionId", "title", "managed", "savedPath", "activeLocation",
      "createdAt", "updatedAt",
    ].includes(key)) ||
    !validSessionId(entry.sessionId) ||
    !validText(entry.title) ||
    typeof entry.managed !== "boolean" ||
    (entry.savedPath !== null && !validStudyPath(entry.savedPath)) ||
    (entry.activeLocation !== "managed" && entry.activeLocation !== "saved") ||
    !validText(entry.createdAt, 64) ||
    !validText(entry.updatedAt, 64) ||
    (entry.activeLocation === "managed" && entry.managed !== true) ||
    (entry.activeLocation === "saved" && entry.savedPath === null)
  ) return null;
  return entry as unknown as SessionRecord;
}

function parseRegistry(value: unknown): RegistryDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyDocument();
  const candidate = value as Record<string, unknown>;
  // Preserve compatibility with the old single-path record without trusting it
  // as an owned managed directory.
  if (candidate.schema === 1 && validStudyPath(candidate.project)) {
    const now = new Date(0).toISOString();
    const sessionId = legacySessionId(candidate.project);
    return {
      schemaVersion: REGISTRY_SCHEMA,
      activeSessionId: sessionId,
      sessions: [{
        sessionId,
        title: path.basename(candidate.project, ".loci-study"),
        managed: false,
        savedPath: candidate.project,
        activeLocation: "saved",
        createdAt: now,
        updatedAt: now,
      }],
    };
  }
  if (
    candidate.schemaVersion !== REGISTRY_SCHEMA ||
    (candidate.activeSessionId !== null && !validSessionId(candidate.activeSessionId)) ||
    !Array.isArray(candidate.sessions) ||
    Object.keys(candidate).some((key) =>
      key !== "schemaVersion" && key !== "activeSessionId" && key !== "sessions")
  ) return emptyDocument();
  const sessions: SessionRecord[] = [];
  const ids = new Set<string>();
  for (const valueEntry of candidate.sessions) {
    const entry = parseRecord(valueEntry);
    if (!entry || ids.has(entry.sessionId)) continue;
    sessions.push(entry);
    ids.add(entry.sessionId);
    if (sessions.length === MAX_SESSIONS) break;
  }
  return {
    schemaVersion: REGISTRY_SCHEMA,
    activeSessionId: typeof candidate.activeSessionId === "string" &&
      ids.has(candidate.activeSessionId) ? candidate.activeSessionId : null,
    sessions,
  };
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some Electron-supported filesystems.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWrite(destination: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_REGISTRY_BYTES) {
    throw new ManagedResearchSessionError(
      "unsafe-storage",
      "The managed-session record exceeded its safety limit.",
    );
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
    await fsyncDirectory(path.dirname(destination));
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function plainDirectory(candidate: string): Promise<"ready" | "missing" | "unsafe"> {
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "unsafe";
    const canonical = await fs.realpath(candidate);
    const canonicalParent = await fs.realpath(path.dirname(candidate));
    return canonical === path.join(canonicalParent, path.basename(candidate)) ? "ready" : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

function markerValue(value: unknown): OwnershipMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  if (
    marker.schemaVersion !== MARKER_SCHEMA ||
    !validSessionId(marker.sessionId) ||
    !validText(marker.title) ||
    !validText(marker.createdAt, 64) ||
    Object.keys(marker).some((key) =>
      key !== "schemaVersion" && key !== "sessionId" && key !== "title" && key !== "createdAt")
  ) return null;
  return marker as unknown as OwnershipMarker;
}

/** Owns only app-managed .loci-study directories; saved user studies are never deleted. */
export class ManagedResearchSessionStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly reservedIds = new Set<string>();
  private readonly undoByToken = new Map<string, UndoRecord>();

  constructor(
    private readonly userData: string,
    private readonly idFactory: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (!path.isAbsolute(userData) || path.normalize(userData) !== userData) {
      throw new ManagedResearchSessionError(
        "unsafe-storage",
        "The application session storage location is invalid.",
      );
    }
  }

  private sessionsRoot(): string {
    return path.join(this.userData, "sessions");
  }

  private trashRoot(): string {
    return path.join(this.userData, "session-trash");
  }

  private registryPath(): string {
    return path.join(this.userData, "research-study.json");
  }

  private managedPath(sessionId: string): string {
    if (!validSessionId(sessionId)) {
      throw new ManagedResearchSessionError("invalid-session", "Select a valid recovery session.");
    }
    return path.join(this.sessionsRoot(), `${sessionId}.loci-study`);
  }

  private markerPath(sessionId: string): string {
    return path.join(this.managedPath(sessionId), ".loci-session-owner.json");
  }

  private exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureOwnedRoot(directory: string): Promise<void> {
    await fs.mkdir(this.userData, { recursive: true, mode: 0o700 });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const state = await plainDirectory(directory);
    if (state !== "ready") {
      throw new ManagedResearchSessionError(
        "unsafe-storage",
        "The application session storage is unavailable or redirected.",
      );
    }
  }

  private async readDocument(): Promise<RegistryDocument> {
    const destination = this.registryPath();
    try {
      const stat = await fs.lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REGISTRY_BYTES) {
        return emptyDocument();
      }
      const bytes = await fs.readFile(destination);
      if (bytes.byteLength > MAX_REGISTRY_BYTES) return emptyDocument();
      return parseRegistry(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch {
      return emptyDocument();
    }
  }

  private async writeDocument(document: RegistryDocument): Promise<void> {
    await this.ensureOwnedRoot(this.userData);
    await atomicWrite(this.registryPath(), document);
  }

  private async marker(sessionId: string): Promise<OwnershipMarker | null> {
    const directory = this.managedPath(sessionId);
    if (await plainDirectory(directory) !== "ready") return null;
    try {
      const markerPath = this.markerPath(sessionId);
      const stat = await fs.lstat(markerPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MARKER_BYTES) return null;
      const marker = markerValue(JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown);
      return marker?.sessionId === sessionId ? marker : null;
    } catch {
      return null;
    }
  }

  private async managedStatus(sessionId: string): Promise<"ready" | "missing" | "unsafe"> {
    if (await plainDirectory(this.sessionsRoot()) !== "ready") return "unsafe";
    const status = await plainDirectory(this.managedPath(sessionId));
    if (status !== "ready") return status;
    return await this.marker(sessionId) ? "ready" : "unsafe";
  }

  private async summarize(record: SessionRecord): Promise<ManagedSessionSummary> {
    const managed = record.managed ? await this.managedStatus(record.sessionId) : "missing";
    const saved = record.savedPath ? await plainDirectory(record.savedPath) : "missing";
    let reason: ManagedSessionRecoveryReason | null = null;
    if (record.activeLocation === "saved" && saved !== "ready") {
      reason = saved === "missing" ? "saved-study-missing" : "saved-study-unsafe";
    } else if (record.activeLocation === "managed" && managed !== "ready") {
      reason = managed === "missing" ? "managed-session-missing" : "managed-session-unsafe";
    }
    return {
      sessionId: record.sessionId,
      title: record.title,
      storage: record.activeLocation,
      saved: record.savedPath !== null,
      status: reason ? "recoverable" : "ready",
      reason,
      canKeep: Boolean(reason && managed === "ready"),
      canDiscard: true,
      updatedAt: record.updatedAt,
    };
  }

  reserve(title: string): Promise<ManagedSessionReservation> {
    return this.exclusively(async () => {
      const safeTitle = validText(title) ? title : "Untitled study";
      await this.ensureOwnedRoot(this.sessionsRoot());
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const sessionId = this.idFactory();
        if (!validSessionId(sessionId) || this.reservedIds.has(sessionId)) continue;
        const projectPath = this.managedPath(sessionId);
        if (await plainDirectory(projectPath) !== "missing") continue;
        this.reservedIds.add(sessionId);
        return { sessionId, projectPath, title: safeTitle, createdAt: this.now() };
      }
      throw new ManagedResearchSessionError(
        "session-collision",
        "Loci could not allocate a private recovery session. Try again.",
      );
    });
  }

  release(reservation: ManagedSessionReservation): void {
    this.reservedIds.delete(reservation.sessionId);
  }

  adopt(reservation: ManagedSessionReservation): Promise<ManagedSessionSummary> {
    return this.exclusively(async () => {
      if (
        !this.reservedIds.has(reservation.sessionId) ||
        reservation.projectPath !== this.managedPath(reservation.sessionId)
      ) {
        throw new ManagedResearchSessionError("invalid-session", "The recovery session reservation expired.");
      }
      if (await plainDirectory(reservation.projectPath) !== "ready") {
        throw new ManagedResearchSessionError(
          "session-unavailable",
          "The newly created recovery session is unavailable.",
        );
      }
      const marker: OwnershipMarker = {
        schemaVersion: MARKER_SCHEMA,
        sessionId: reservation.sessionId,
        title: reservation.title,
        createdAt: reservation.createdAt,
      };
      const markerPath = this.markerPath(reservation.sessionId);
      let markerHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        markerHandle = await fs.open(markerPath, "wx", 0o600);
        await markerHandle.writeFile(`${JSON.stringify(marker)}\n`);
        await markerHandle.sync();
        await markerHandle.close();
        markerHandle = undefined;
        await fsyncDirectory(reservation.projectPath);
      } catch (error) {
        await markerHandle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
            (await this.marker(reservation.sessionId))?.createdAt !== reservation.createdAt) {
          throw error;
        }
      }
      const timestamp = this.now();
      const record: SessionRecord = {
        sessionId: reservation.sessionId,
        title: reservation.title,
        managed: true,
        savedPath: null,
        activeLocation: "managed",
        createdAt: reservation.createdAt,
        updatedAt: timestamp,
      };
      const document = await this.readDocument();
      document.sessions = [record, ...document.sessions.filter(({ sessionId }) =>
        sessionId !== record.sessionId)].slice(0, MAX_SESSIONS);
      document.activeSessionId = record.sessionId;
      await this.writeDocument(document);
      this.reservedIds.delete(reservation.sessionId);
      return this.summarize(record);
    });
  }

  rememberOpened(projectPath: string, title: string): Promise<ManagedSessionSummary> {
    return this.exclusively(async () => {
      if (!validStudyPath(projectPath) || await plainDirectory(projectPath) !== "ready") {
        throw new ManagedResearchSessionError(
          "session-unavailable",
          "The selected study is unavailable or is not a plain study directory.",
        );
      }
      const timestamp = this.now();
      const record: SessionRecord = {
        sessionId: randomUUID(),
        title: validText(title) ? title : path.basename(projectPath, ".loci-study"),
        managed: false,
        savedPath: projectPath,
        activeLocation: "saved",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const document = await this.readDocument();
      document.sessions = [record, ...document.sessions].slice(0, MAX_SESSIONS);
      document.activeSessionId = record.sessionId;
      await this.writeDocument(document);
      return this.summarize(record);
    });
  }

  rememberSaved(sessionId: string, savedPath: string): Promise<ManagedSessionSummary> {
    return this.exclusively(async () => {
      if (!validStudyPath(savedPath) || await plainDirectory(savedPath) !== "ready") {
        throw new ManagedResearchSessionError(
          "session-unavailable",
          "The saved study is unavailable or is not a plain study directory.",
        );
      }
      const document = await this.readDocument();
      const record = document.sessions.find((entry) => entry.sessionId === sessionId);
      if (!record) throw new ManagedResearchSessionError("invalid-session", "The active session changed.");
      record.savedPath = savedPath;
      record.activeLocation = "saved";
      record.updatedAt = this.now();
      document.activeSessionId = sessionId;
      document.sessions = [record, ...document.sessions.filter((entry) => entry !== record)];
      await this.writeDocument(document);
      return this.summarize(record);
    });
  }

  resolveActive(): Promise<ResolvedManagedSession> {
    return this.exclusively(async () => {
      const document = await this.readDocument();
      const record = document.sessions.find(({ sessionId }) =>
        sessionId === document.activeSessionId);
      if (!record) return { projectPath: null, state: { status: "empty" } };
      const state = await this.summarize(record);
      if (state.status === "recoverable") return { projectPath: null, state };
      return {
        projectPath: record.activeLocation === "managed"
          ? this.managedPath(record.sessionId)
          : record.savedPath,
        state,
      };
    });
  }

  leaveActive(): Promise<void> {
    return this.exclusively(async () => {
      const document = await this.readDocument();
      if (document.activeSessionId === null) return;
      document.activeSessionId = null;
      await this.writeDocument(document);
    });
  }

  listRecovery(): Promise<ManagedSessionSummary[]> {
    return this.exclusively(async () => {
      const document = await this.readDocument();
      return Promise.all(document.sessions.map((record) => this.summarize(record)));
    });
  }

  keep(sessionId: string): Promise<ResolvedManagedSession> {
    return this.exclusively(async () => {
      const document = await this.readDocument();
      const record = document.sessions.find((entry) => entry.sessionId === sessionId);
      if (!record) {
        throw new ManagedResearchSessionError(
          "session-unavailable",
          "The selected recovery session is unavailable.",
        );
      }
      const current = await this.summarize(record);
      if (current.status === "recoverable") {
        if (!record.managed || await this.managedStatus(sessionId) !== "ready") {
          throw new ManagedResearchSessionError(
            "session-unavailable",
            "The selected recovery session is unavailable.",
          );
        }
        record.activeLocation = "managed";
      }
      record.updatedAt = this.now();
      document.activeSessionId = sessionId;
      document.sessions = [record, ...document.sessions.filter((entry) => entry !== record)];
      await this.writeDocument(document);
      const state = await this.summarize(record);
      return {
        projectPath: record.activeLocation === "managed"
          ? this.managedPath(sessionId)
          : record.savedPath,
        state,
      };
    });
  }

  discard(sessionId: string): Promise<{ undoToken: string }> {
    return this.exclusively(async () => {
      if (!validSessionId(sessionId)) {
        throw new ManagedResearchSessionError("invalid-session", "Select a valid recovery session.");
      }
      const document = await this.readDocument();
      const record = document.sessions.find((entry) => entry.sessionId === sessionId);
      if (!record) throw new ManagedResearchSessionError("invalid-session", "The recovery session was not found.");
      const token = randomUUID();
      let trashedPath: string | null = null;
      if (record.managed) {
        const status = await this.managedStatus(sessionId);
        if (status === "unsafe") {
          throw new ManagedResearchSessionError(
            "unsafe-storage",
            "The managed recovery session failed its ownership check and was preserved.",
          );
        }
        if (status === "ready") {
          await this.ensureOwnedRoot(this.trashRoot());
          trashedPath = path.join(this.trashRoot(), `${token}.loci-study`);
          await fs.rename(this.managedPath(sessionId), trashedPath);
          await fsyncDirectory(this.sessionsRoot());
          await fsyncDirectory(this.trashRoot());
        }
      }
      document.sessions = document.sessions.filter((entry) => entry.sessionId !== sessionId);
      if (document.activeSessionId === sessionId) document.activeSessionId = null;
      this.undoByToken.set(token, { token, record, trashedPath });
      try {
        await this.writeDocument(document);
      } catch (error) {
        if (trashedPath) {
          await fs.rename(trashedPath, this.managedPath(sessionId)).catch(() => undefined);
        }
        this.undoByToken.delete(token);
        throw error;
      }
      return { undoToken: token };
    });
  }

  undoDiscard(token: unknown): Promise<ManagedSessionSummary> {
    return this.exclusively(async () => {
      if (!validSessionId(token)) {
        throw new ManagedResearchSessionError("undo-unavailable", "The discard cannot be undone.");
      }
      const undo = this.undoByToken.get(token);
      if (!undo) throw new ManagedResearchSessionError("undo-unavailable", "The discard can no longer be undone.");
      if (undo.trashedPath) {
        if (await plainDirectory(this.managedPath(undo.record.sessionId)) !== "missing" ||
            await plainDirectory(undo.trashedPath) !== "ready") {
          throw new ManagedResearchSessionError(
            "undo-unavailable",
            "The recovery location changed and the discard cannot be undone safely.",
          );
        }
        await fs.rename(undo.trashedPath, this.managedPath(undo.record.sessionId));
      }
      const document = await this.readDocument();
      document.sessions = [undo.record, ...document.sessions.filter(({ sessionId }) =>
        sessionId !== undo.record.sessionId)].slice(0, MAX_SESSIONS);
      document.activeSessionId = undo.record.sessionId;
      await this.writeDocument(document);
      this.undoByToken.delete(token);
      return this.summarize(undo.record);
    });
  }
}
