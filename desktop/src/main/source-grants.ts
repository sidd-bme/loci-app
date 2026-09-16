import path from "node:path";

export interface SourceGrant {
  sourceId: string;
  path: string;
  name: string;
  relativePath: string;
  expectedSha256?: string;
  fingerprintVerifiedAt?: string;
  /** Set only after this application process has re-read and verified the file. */
  sessionFingerprintVerifiedAt?: string;
}

export interface SourceCandidate {
  path: string;
  relativePath: string;
}

export function relativePathKey(value: string): string {
  // Batch trees must remain collision-free when later opened on the default
  // case-insensitive macOS and Windows filesystems.
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function normalizedRelativePath(requestedValue: string): string {
  const normalized = path.posix.normalize(requestedValue.replaceAll("\\", "/")).normalize("NFC");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("The source folder structure is invalid.");
  }
  return normalized;
}

function suffixedFilename(filename: string, index: number): string {
  const extension = path.posix.extname(filename);
  const basename = path.posix.basename(filename, extension);
  return `${basename}_${index}${extension}`;
}

interface AllocatedFile {
  requested: string;
  relativePath: string;
}

/**
 * Allocate a portable mirrored path without merging source directories that
 * are distinct on a case-sensitive filesystem but collide on macOS/Windows.
 * Physical directory identities keep all files from one folder together; the
 * requested prefix lets an overlapping re-import adopt its newly selected
 * folder hierarchy instead of being pinned to an earlier flat import.
 */
export class RelativePathAllocator {
  private directoryAliases = new Map<string, string>();
  private occupiedNodes = new Map<string, { kind: "directory" | "file"; owner: string }>();
  private filesByOwner = new Map<string, AllocatedFile>();

  private physicalDirectory(
    ownerPath: string,
    directoryCount: number,
    directoryIndex: number,
  ): string {
    let directory = path.dirname(ownerPath);
    for (let index = directoryIndex + 1; index < directoryCount; index += 1) {
      directory = path.dirname(directory);
    }
    return path.resolve(directory);
  }

  reserve(requestedValue: string, ownerPath: string): string {
    if (!ownerPath) throw new Error("The source path is invalid.");
    const requested = normalizedRelativePath(requestedValue);
    const existing = this.filesByOwner.get(ownerPath);
    if (existing?.requested === requested) return existing.relativePath;
    if (
      existing &&
      path.posix.dirname(existing.requested) !== "." &&
      path.posix.dirname(requested) === "."
    ) {
      // Once folder context is known, a later single-file re-import must not
      // flatten the mirrored batch destination again.
      return existing.relativePath;
    }

    // A later folder import is authoritative for this source's mirrored path.
    // Release only its obsolete file leaf; shared directory aliases remain.
    if (existing) {
      const previousKey = relativePathKey(existing.relativePath);
      const previousNode = this.occupiedNodes.get(previousKey);
      if (previousNode?.kind === "file" && previousNode.owner === ownerPath) {
        this.occupiedNodes.delete(previousKey);
      }
    }

    const parts = requested.split("/");
    const filename = parts.pop();
    if (!filename) throw new Error("The source folder structure is invalid.");

    let requestedParent = "";
    let allocatedParent = "";
    for (const [directoryIndex, component] of parts.entries()) {
      requestedParent = requestedParent
        ? path.posix.join(requestedParent, component)
        : component;
      const physicalDirectory = this.physicalDirectory(
        ownerPath,
        parts.length,
        directoryIndex,
      );
      const aliasOwner = `${physicalDirectory}\0${requestedParent}`;
      const existingAlias = this.directoryAliases.get(aliasOwner);
      if (existingAlias) {
        allocatedParent = existingAlias;
        continue;
      }

      let candidate = allocatedParent
        ? path.posix.join(allocatedParent, component)
        : component;
      let index = 2;
      while (this.occupiedNodes.has(relativePathKey(candidate))) {
        const suffixed = `${component}_${index}`;
        candidate = allocatedParent ? path.posix.join(allocatedParent, suffixed) : suffixed;
        index += 1;
      }
      this.directoryAliases.set(aliasOwner, candidate);
      this.occupiedNodes.set(relativePathKey(candidate), {
        kind: "directory",
        owner: aliasOwner,
      });
      allocatedParent = candidate;
    }

    let allocated = allocatedParent
      ? path.posix.join(allocatedParent, filename)
      : filename;
    let index = 2;
    while (this.occupiedNodes.has(relativePathKey(allocated))) {
      const suffixed = suffixedFilename(filename, index);
      allocated = allocatedParent ? path.posix.join(allocatedParent, suffixed) : suffixed;
      index += 1;
    }
    this.occupiedNodes.set(relativePathKey(allocated), { kind: "file", owner: ownerPath });
    this.filesByOwner.set(ownerPath, { requested, relativePath: allocated });
    return allocated;
  }
}

export function reserveUniqueRelativePath(
  requestedValue: string,
  usedKeys: Set<string>,
): string {
  const normalized = normalizedRelativePath(requestedValue);

  const directory = path.posix.dirname(normalized);
  const extension = path.posix.extname(normalized);
  const basename = path.posix.basename(normalized, extension);
  let candidate = normalized;
  let index = 2;
  while (usedKeys.has(relativePathKey(candidate))) {
    const suffixedName = `${basename}_${index}${extension}`;
    candidate = directory === "." ? suffixedName : path.posix.join(directory, suffixedName);
    index += 1;
  }
  usedKeys.add(relativePathKey(candidate));
  return candidate;
}

export function refreshedSourceGrant(
  candidate: SourceCandidate,
  existingSourceId: string | undefined,
  allocateSourceId: () => string,
): SourceGrant {
  // An explicit re-import is the recovery path after the source-change guard
  // rejects a stale fingerprint. Preserve the stable renderer identity, but
  // deliberately discard the old fingerprint so inspection can establish a
  // fresh, double-hashed snapshot of the selected file.
  return {
    sourceId: existingSourceId ?? allocateSourceId(),
    path: candidate.path,
    name: path.basename(candidate.path),
    relativePath: candidate.relativePath,
  };
}
