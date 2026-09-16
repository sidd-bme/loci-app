import { promises as fs } from "node:fs";
import path from "node:path";

export interface PathRedaction {
  value: string;
  replacement: string;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function isLociExportMarker(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "bundle_kind" in value &&
    value.bundle_kind === "loci-export"
  );
}

/**
 * Recognize a published Loci bundle by its stable marker or, for exports made
 * before markers were introduced, by the complete legacy artifact set. A
 * laboratory folder that merely ends in `_loci` remains importable.
 */
export async function isLociExportBundleDirectory(directoryValue: string): Promise<boolean> {
  const directoryName = path.basename(path.resolve(directoryValue));
  const match = /^(.*)_loci$/i.exec(directoryName);
  if (!match?.[1]) return false;

  const stem = match[1];
  const entries = await fs.readdir(directoryValue, { withFileTypes: true });
  const markerEntry = entries.find(
    (entry) => entry.isFile() && portablePathKey(entry.name) === "loci-export.json",
  );
  if (markerEntry) {
    try {
      const marker: unknown = JSON.parse(
        await fs.readFile(path.join(directoryValue, markerEntry.name), "utf8"),
      );
      if (isLociExportMarker(marker)) return true;
    } catch {
      // A corrupt or unreadable marker is not evidence that an ordinary lab
      // folder is an export. Fall through to the legacy artifact check.
    }
  }

  const fileNames = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => portablePathKey(entry.name)),
  );
  return [
    `${stem}_overlay.png`,
    `${stem}_labels.tiff`,
    `${stem}_measurements.csv`,
    `${stem}_analysis.json`,
  ].every((name) => fileNames.has(portablePathKey(name)));
}

export async function canonicalizeBatchRoot(rootValue: string): Promise<string> {
  const root = path.resolve(rootValue);
  await fs.mkdir(root, { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  const stat = await fs.stat(canonicalRoot);
  if (!stat.isDirectory()) throw new Error("The selected batch destination is not a folder.");
  return canonicalRoot;
}

/**
 * Create the mirrored parent one component at a time. Existing symbolic links
 * are rejected before they can redirect mkdir or the engine outside the
 * destination selected by the user.
 */
export async function createContainedBatchDirectory(
  canonicalRootValue: string,
  sourceRelativePath: string,
): Promise<string> {
  const canonicalRoot = await fs.realpath(canonicalRootValue);
  const normalized = path.normalize(sourceRelativePath);
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error("The source folder structure is invalid.");
  }

  const relativeDirectory = path.dirname(normalized);
  if (relativeDirectory === ".") return canonicalRoot;

  const parts = relativeDirectory.split(path.sep).filter((part) => part && part !== ".");
  let current = canonicalRoot;
  for (const part of parts) {
    if (part === "..") throw new Error("The source folder structure is invalid.");
    const candidate = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      try {
        await fs.mkdir(candidate);
      } catch (mkdirError) {
        if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) {
          throw mkdirError;
        }
      }
      stat = await fs.lstat(candidate);
    }

    if (stat.isSymbolicLink()) {
      throw new Error("A symbolic link inside the batch destination would escape its folder.");
    }
    if (!stat.isDirectory()) {
      throw new Error("A mirrored batch folder conflicts with an existing file.");
    }

    const canonicalCandidate = await fs.realpath(candidate);
    if (!isContainedPath(canonicalRoot, canonicalCandidate)) {
      throw new Error("The batch output escaped the selected destination.");
    }
    current = canonicalCandidate;
  }
  return current;
}

/** Resolve the requested mirrored parent without touching the filesystem. */
export function containedBatchDirectoryPath(
  canonicalRootValue: string,
  sourceRelativePath: string,
): string {
  const canonicalRoot = path.resolve(canonicalRootValue);
  const normalized = path.normalize(sourceRelativePath);
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error("The source folder structure is invalid.");
  }
  const candidate = path.resolve(canonicalRoot, path.dirname(normalized));
  if (!isContainedPath(canonicalRoot, candidate)) {
    throw new Error("The batch output escaped the selected destination.");
  }
  return candidate;
}

export async function assertExportReceiptContained(
  canonicalRootValue: string,
  directoryValue: string,
  fileValues: string[],
): Promise<void> {
  const canonicalRoot = await fs.realpath(canonicalRootValue);
  const canonicalDirectory = await fs.realpath(directoryValue);
  if (!isContainedPath(canonicalRoot, canonicalDirectory)) {
    throw new Error("The batch output escaped the selected destination.");
  }
  for (const fileValue of fileValues) {
    const canonicalFile = await fs.realpath(fileValue);
    if (!isContainedPath(canonicalDirectory, canonicalFile)) {
      throw new Error("A batch artifact escaped its result bundle.");
    }
  }
}

/** Redact paths before renderer-provided error text is persisted in a manifest. */
export function sanitizeBatchFailureMessage(
  messageValue: unknown,
  redactions: PathRedaction[],
): string | null {
  if (typeof messageValue !== "string") return null;
  let message = messageValue.replaceAll(/[\r\n\t]+/g, " ").replaceAll(/\s{2,}/g, " ").trim();
  if (!message) return null;

  for (const redaction of [...redactions].sort((left, right) => right.value.length - left.value.length)) {
    if (!redaction.value) continue;
    message = message.replaceAll(redaction.value, redaction.replacement);
    const slashVariant = redaction.value.replaceAll("\\", "/");
    if (slashVariant !== redaction.value) {
      message = message.replaceAll(slashVariant, redaction.replacement);
    }
  }

  // Preserve the useful error category while replacing quoted POSIX, Windows,
  // and UNC paths in full, including paths containing spaces.
  message = message.replace(
    /(["'])(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/)[^"'\r\n]*\1/g,
    "$1<local path>$1",
  );
  // An unquoted absolute path is inherently ambiguous once it contains spaces.
  // Redact the remainder of that message instead of risking a partial disclosure.
  message = message.replace(
    /((?:^|[\s:=(]))(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/).*/,
    "$1<local path>",
  );

  return message.slice(0, 1_000);
}
