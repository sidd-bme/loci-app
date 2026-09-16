import { app } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  PROJECT_FILE_EXTENSION,
  openProject,
  sanitizedProjectSummary,
  type OpenProjectSession,
} from "./project-store";

const RECENT_PROJECTS_SCHEMA = "loci.recent-projects/v1" as const;
const MAX_RECENT_PROJECTS = 8;
const MAX_REGISTRY_BYTES = 64 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const OPAQUE_ID = /^[a-f0-9-]{36}$/u;

interface RecentProjectEntry {
  recentId: string;
  projectPath: string;
}

interface RecentProjectDocument {
  schemaVersion: typeof RECENT_PROJECTS_SCHEMA;
  entries: RecentProjectEntry[];
}

export interface RecentProjectSummary {
  recentId: string;
  title: string;
  updatedAt: string;
  sourceCount: number;
}

function registryPath(): string {
  return path.join(app.getPath("userData"), "recent-projects.json");
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function validStoredPath(value: unknown): value is string {
  return typeof value === "string" &&
    !CONTROL_CHARACTER.test(value) &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    path.extname(value).toLocaleLowerCase("en-US") === PROJECT_FILE_EXTENSION;
}

function parsedRegistry(value: unknown): RecentProjectDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { schemaVersion: RECENT_PROJECTS_SCHEMA, entries: [] };
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== RECENT_PROJECTS_SCHEMA ||
    !Array.isArray(candidate.entries) ||
    Object.keys(candidate).some((key) => key !== "schemaVersion" && key !== "entries")
  ) {
    return { schemaVersion: RECENT_PROJECTS_SCHEMA, entries: [] };
  }

  const entries: RecentProjectEntry[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const valueEntry of candidate.entries) {
    if (!valueEntry || typeof valueEntry !== "object" || Array.isArray(valueEntry)) continue;
    const entry = valueEntry as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, "recentId") ||
      !Object.hasOwn(entry, "projectPath") ||
      !validOpaqueId(entry.recentId) ||
      !validStoredPath(entry.projectPath)
    ) continue;
    const pathKey = process.platform === "win32"
      ? entry.projectPath.toLocaleLowerCase("en-US")
      : entry.projectPath;
    if (ids.has(entry.recentId) || paths.has(pathKey)) continue;
    ids.add(entry.recentId);
    paths.add(pathKey);
    entries.push({ recentId: entry.recentId, projectPath: entry.projectPath });
    if (entries.length === MAX_RECENT_PROJECTS) break;
  }
  return { schemaVersion: RECENT_PROJECTS_SCHEMA, entries };
}

async function readRegistry(destination: string): Promise<RecentProjectDocument> {
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REGISTRY_BYTES) {
      return { schemaVersion: RECENT_PROJECTS_SCHEMA, entries: [] };
    }
    const bytes = await fs.readFile(destination);
    if (bytes.byteLength > MAX_REGISTRY_BYTES) {
      return { schemaVersion: RECENT_PROJECTS_SCHEMA, entries: [] };
    }
    return parsedRegistry(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    return { schemaVersion: RECENT_PROJECTS_SCHEMA, entries: [] };
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not available on every filesystem Electron supports.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeRegistry(
  destination: string,
  entries: readonly RecentProjectEntry[],
): Promise<void> {
  const document: RecentProjectDocument = {
    schemaVersion: RECENT_PROJECTS_SCHEMA,
    entries: entries.slice(0, MAX_RECENT_PROJECTS).map((entry) => ({ ...entry })),
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_REGISTRY_BYTES) {
    throw new Error("The recent-project registry exceeded its safety limit.");
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, destination);
    await fsyncDirectory(path.dirname(destination));
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function canonicalRegularProject(projectPath: string): Promise<string | undefined> {
  if (!validStoredPath(projectPath)) return undefined;
  try {
    const stat = await fs.lstat(projectPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return await fs.realpath(projectPath);
  } catch {
    return undefined;
  }
}

interface ResolvedEntry {
  entry: RecentProjectEntry;
  summary: RecentProjectSummary;
}

/**
 * Serializes registry reads and writes so concurrent import/save actions cannot
 * reorder or discard one another. Instantiate once in the Electron main process.
 */
export class RecentProjectRegistry {
  private queue: Promise<void> = Promise.resolve();
  private readonly summaryByPath = new Map<string, RecentProjectSummary>();

  constructor(private readonly destination = registryPath()) {}

  private exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async resolvedEntries(): Promise<ResolvedEntry[]> {
    const document = await readRegistry(this.destination);
    const resolved: ResolvedEntry[] = [];
    let changed = false;
    for (const stored of document.entries) {
      const projectPath = await canonicalRegularProject(stored.projectPath);
      if (!projectPath) {
        changed = true;
        continue;
      }
      try {
        const project = await openProject(projectPath);
        const summary = sanitizedProjectSummary(project);
        resolved.push({
          entry: { recentId: stored.recentId, projectPath },
          summary: {
            recentId: stored.recentId,
            title: summary.title,
            updatedAt: summary.updatedAt,
            sourceCount: summary.sources.length,
          },
        });
        this.summaryByPath.set(projectPath, resolved.at(-1)!.summary);
        if (projectPath !== stored.projectPath) changed = true;
      } catch {
        changed = true;
      }
    }
    if (changed) await writeRegistry(this.destination, resolved.map(({ entry }) => entry));
    return resolved;
  }

  list(): Promise<RecentProjectSummary[]> {
    return this.exclusively(async () =>
      (await this.resolvedEntries()).map(({ summary }) => ({ ...summary })));
  }

  remember(project: OpenProjectSession): Promise<RecentProjectSummary[]> {
    return this.exclusively(async () => {
      const canonicalPath = await canonicalRegularProject(project.filePath);
      if (!canonicalPath) throw new Error("Only a saved, regular Loci project can be remembered.");
      const projectSummary = sanitizedProjectSummary(project);
      const document = await readRegistry(this.destination);
      const usableEntries: RecentProjectEntry[] = [];
      for (const stored of document.entries) {
        const storedPath = await canonicalRegularProject(stored.projectPath);
        if (storedPath) usableEntries.push({ ...stored, projectPath: storedPath });
      }
      const pathKey = process.platform === "win32"
        ? canonicalPath.toLocaleLowerCase("en-US")
        : canonicalPath;
      const existing = usableEntries.find((entry) => {
        const candidate = process.platform === "win32"
          ? entry.projectPath.toLocaleLowerCase("en-US")
          : entry.projectPath;
        return candidate === pathKey;
      });
      const currentSummary: RecentProjectSummary = {
        recentId: existing?.recentId ?? randomUUID(),
        title: projectSummary.title,
        updatedAt: projectSummary.updatedAt,
        sourceCount: projectSummary.sources.length,
      };
      this.summaryByPath.set(canonicalPath, currentSummary);
      const next: RecentProjectEntry[] = [
        {
          recentId: currentSummary.recentId,
          projectPath: canonicalPath,
        },
        ...usableEntries
          .filter(({ projectPath }) => {
            const candidate = process.platform === "win32"
              ? projectPath.toLocaleLowerCase("en-US")
              : projectPath;
            return candidate !== pathKey;
          }),
      ].slice(0, MAX_RECENT_PROJECTS);
      await writeRegistry(this.destination, next);
      return next.flatMap((entry) => {
        const summary = this.summaryByPath.get(entry.projectPath);
        return summary ? [{ ...summary, recentId: entry.recentId }] : [];
      });
    });
  }

  resolve(recentId: string): Promise<string | undefined> {
    return this.exclusively(async () => {
      if (!validOpaqueId(recentId)) return undefined;
      const resolved = await this.resolvedEntries();
      return resolved.find(({ entry }) => entry.recentId === recentId)?.entry.projectPath;
    });
  }

  remove(recentId: string): Promise<void> {
    return this.exclusively(async () => {
      const resolved = await this.resolvedEntries();
      const next = validOpaqueId(recentId)
        ? resolved.map(({ entry }) => entry).filter((entry) => entry.recentId !== recentId)
        : resolved.map(({ entry }) => entry);
      await writeRegistry(this.destination, next);
    });
  }

  clear(): Promise<void> {
    return this.exclusively(async () => {
      this.summaryByPath.clear();
      await writeRegistry(this.destination, []);
    });
  }
}
