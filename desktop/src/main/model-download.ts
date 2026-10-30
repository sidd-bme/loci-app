/** Explicit main-process downloads from a reviewed, code-owned artifact registry.
 * Never pass a renderer-supplied registry, URL, redirect policy, or output path.
 * Downloading verifies bytes only; the existing model importer must still qualify
 * and atomically adopt the artifact before any model execution.
 */
import { createHash } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import type { Readable } from "node:stream";

export interface PinnedModelArtifact {
  id: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  /** Exact HTTPS origins, reviewed alongside the pinned source URL. No wildcards. */
  redirectOrigins?: readonly string[];
}

export interface ModelDownloadResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Readable;
}

/** Test seam; implementations must honor the signal and return an unencoded body. */
export type ModelDownloadTransport = (url: URL, signal: AbortSignal) => Promise<ModelDownloadResponse>;

const MAX_BYTES = 8 * 1024 ** 3;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class DownloadError extends Error {}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DownloadError("Model download cancelled.");
}

function httpsUrl(value: string, base?: URL): URL {
  let url: URL;
  try {
    if (typeof value !== "string" || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error();
    url = base ? new URL(value, base) : new URL(value);
  } catch { throw new DownloadError("The registry download URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new DownloadError("Model downloads require HTTPS without URL credentials or fragments.");
  }
  return url;
}

function resolveArtifact(id: string, registry: readonly PinnedModelArtifact[]) {
  if (typeof id !== "string" || !Array.isArray(registry)) throw new DownloadError("Select a registered model artifact.");
  const matches = registry.filter((entry) => entry.id === id);
  if (matches.length !== 1) throw new DownloadError("Select one exact registered model artifact.");
  const entry = matches[0];
  const url = httpsUrl(entry.url);
  if (!/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 1 || entry.sizeBytes > MAX_BYTES) {
    throw new DownloadError("The registered model requires an exact SHA-256 and bounded byte size.");
  }
  const origins = new Set([url.origin]);
  if (entry.redirectOrigins !== undefined && !Array.isArray(entry.redirectOrigins)) {
    throw new DownloadError("Registry redirect origins must be explicit HTTPS origins.");
  }
  for (const value of entry.redirectOrigins ?? []) {
    const allowed = httpsUrl(value);
    if (allowed.href !== `${allowed.origin}/`) throw new DownloadError("Registry redirect origins must be exact origins.");
    origins.add(allowed.origin);
  }
  // Snapshot all authority before awaiting transport or filesystem operations.
  return { id, url, sha256: entry.sha256, sizeBytes: entry.sizeBytes, origins };
}

const requestHttps: ModelDownloadTransport = (url, signal) => new Promise((resolve, reject) => {
  const request = https.get(url, {
    signal,
    agent: false,
    rejectUnauthorized: true,
    headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity" },
  }, (response) => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: response }));
  request.setTimeout(60_000, () => request.destroy(new DownloadError("Model download connection timed out.")));
  request.on("error", reject);
});

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function privateDirectory(directory: string, expected?: Stats): Promise<Stats> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory ||
      (process.platform !== "win32" && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.())) ||
      (expected && !sameFile(expected, stat))) {
    throw new DownloadError("The private model download directory changed or is unsafe.");
  }
  return stat;
}

async function absent(filename: string): Promise<void> {
  try { await fs.lstat(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new DownloadError("The model download target already exists.");
}

async function unlinkOwned(filename: string, expected: Stats): Promise<void> {
  let stat: Stats;
  try { stat = await fs.lstat(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || !sameFile(stat, expected)) throw new DownloadError("The owned model download file changed.");
  await fs.unlink(filename);
}

function header(response: ModelDownloadResponse, name: string): string | undefined {
  const value = response.headers[name];
  if (value !== undefined && typeof value !== "string") throw new DownloadError("The download returned ambiguous HTTP headers.");
  return value;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * The caller supplies an absent file in an existing private canonical directory.
 * POSIX owner/mode and directory identities are checked, with no symlink parents.
 * Windows callers must supply an app-owned directory with appropriate ACLs.
 * This protects against unsafe paths, not a hostile process with the same UID:
 * Node does not expose directory-relative openat/linkat operations.
 */
export async function downloadModelArtifact(
  artifactId: string,
  registry: readonly PinnedModelArtifact[],
  targetFile: string,
  { signal = new AbortController().signal, transport = requestHttps }: {
    signal?: AbortSignal; transport?: ModelDownloadTransport;
  } = {},
): Promise<{ artifactId: string; path: string; sha256: string; sizeBytes: number }> {
  cancelled(signal);
  const artifact = resolveArtifact(artifactId, registry);
  if (typeof targetFile !== "string" || targetFile.includes("\0") || !path.isAbsolute(targetFile) ||
      path.resolve(targetFile) !== targetFile) throw new DownloadError("Choose an absolute canonical model download target.");
  const parent = path.dirname(targetFile);
  let stage: string | undefined;
  let stageStat: Stats | undefined;
  let file: FileHandle | undefined;
  let fileStat: Stats | undefined;
  let published = false;
  let response: ModelDownloadResponse | undefined;
  let completed = false;
  try {
    const parentStat = await privateDirectory(parent);
    await absent(targetFile);
    stage = await fs.mkdtemp(path.join(parent, ".loci-model-download-"));
    stageStat = await privateDirectory(stage);
    await privateDirectory(parent, parentStat);
    file = await fs.open(path.join(stage, "artifact.part"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await file.chmod(0o600);
    fileStat = await file.stat();
    if (!fileStat.isFile() || fileStat.nlink !== 1 ||
        (process.platform !== "win32" && ((fileStat.mode & 0o777) !== 0o600 || fileStat.uid !== process.getuid?.()))) {
      throw new DownloadError("The private model download file is unsafe.");
    }
    let url = artifact.url;
    const visited = new Set<string>();
    for (let redirects = 0; ; redirects++) {
      cancelled(signal);
      if (visited.has(url.href)) throw new DownloadError("The model download redirect loop was rejected.");
      visited.add(url.href);
      response = await transport(new URL(url.href), signal);
      cancelled(signal);
      if (!REDIRECTS.has(response.statusCode)) break;
      const location = header(response, "location");
      response.body.destroy();
      if (redirects >= MAX_REDIRECTS || !location) throw new DownloadError("The model download redirect limit or location is invalid.");
      const next = httpsUrl(location, url);
      if (!artifact.origins.has(next.origin)) throw new DownloadError("The model download redirected outside its reviewed origins.");
      url = next;
    }
    if (response.statusCode !== 200) throw new DownloadError("The model download did not return a complete HTTP 200 response.");
    const encoding = header(response, "content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") throw new DownloadError("Encoded model download responses are unsupported.");
    const length = header(response, "content-length");
    if (length !== undefined && (!/^(0|[1-9][0-9]*)$/u.test(length) || Number(length) !== artifact.sizeBytes)) {
      throw new DownloadError("The model download declared a different byte size.");
    }
    const digest = createHash("sha256");
    let sizeBytes = 0;
    const body = response.body;
    const abort = () => body.destroy(new DownloadError("Model download cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    try {
      cancelled(signal);
      for await (const chunk of body) {
        cancelled(signal);
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > 1024 ** 2) throw new DownloadError("The model download returned an invalid or oversized chunk.");
        if (chunk.byteLength > artifact.sizeBytes - sizeBytes) throw new DownloadError("The model download exceeded its exact byte size.");
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset, null);
          if (bytesWritten < 1) throw new DownloadError("The model download could not be written completely.");
          offset += bytesWritten;
        }
        digest.update(chunk);
        sizeBytes += chunk.byteLength;
      }
    } finally { signal.removeEventListener("abort", abort); }
    cancelled(signal);
    if (sizeBytes !== artifact.sizeBytes || digest.digest("hex") !== artifact.sha256) throw new DownloadError("The model download failed exact size or SHA-256 verification.");
    await file.sync();
    await privateDirectory(parent, parentStat);
    await privateDirectory(stage, stageStat);
    const partial = await fs.lstat(path.join(stage, "artifact.part"));
    if (!partial.isFile() || !sameFile(partial, fileStat) || partial.nlink !== 1 || partial.size !== sizeBytes) throw new DownloadError("The verified model download file changed.");
    cancelled(signal);
    // A hard link on the same filesystem publishes all bytes atomically and
    // fails with EEXIST for every existing target, including dangling symlinks.
    await fs.link(path.join(stage, "artifact.part"), targetFile);
    published = true;
    await privateDirectory(parent, parentStat);
    if (!sameFile(await fs.lstat(targetFile), fileStat)) throw new DownloadError("The published model download identity changed.");
    await syncDirectory(parent);
    await privateDirectory(parent, parentStat);
    cancelled(signal);
    completed = true;
    return { artifactId, path: targetFile, sha256: artifact.sha256, sizeBytes };
  } catch (error) {
    if (signal.aborted) throw new DownloadError("Model download cancelled.");
    if (error instanceof DownloadError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DownloadError("The model download target already exists.");
    throw new DownloadError("The model download failed; no model was imported.");
  } finally {
    response?.body.destroy();
    let cleanupFailed = false;
    try { await file?.close(); } catch { cleanupFailed = true; }
    try {
      if (published && !completed && fileStat) {
        await unlinkOwned(targetFile, fileStat);
      }
    } catch { cleanupFailed = true; }
    try {
      if (stage && stageStat) {
        await privateDirectory(stage, stageStat);
        const partialPath = path.join(stage, "artifact.part");
        if (fileStat) await unlinkOwned(partialPath, fileStat);
        await fs.rmdir(stage);
      } else if (stage) cleanupFailed = true;
    } catch { cleanupFailed = true; }
    if ((cleanupFailed || signal.aborted) && published && completed && fileStat) {
      try { await unlinkOwned(targetFile, fileStat); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new DownloadError("The model download could not safely clean up its owned temporary files.");
    cancelled(signal);
  }
}
