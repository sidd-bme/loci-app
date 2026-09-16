import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ResultArtifact } from "../shared/foundation-contracts";

export const WORKING_RESULT_SCHEMA_VERSION = "1.0" as const;
export const WORKING_RESULT_MEDIA_TYPE =
  "application/vnd.loci.working-result+zip" as const;
export const WORKING_RESULT_ARTIFACT_ID = "working-result" as const;
export const WORKING_RESULT_ARRAY_MEDIA_TYPE = "application/x-npy" as const;

export const SAVED_WORKING_RESULT_UNAVAILABLE_MESSAGE =
  "This project declares a saved analysis result, but its recoverable working copy is missing, unreadable, or damaged. Run segmentation again to create a new result. The source image is unchanged.";

export const MAX_WORKING_RESULT_PACK_BYTES = 1024 * 1024 * 1024;
export const MAX_WORKING_RESULT_ARRAY_BYTES = 256 * 1024 * 1024;
export const MAX_WORKING_RESULT_EXPANDED_BYTES = 800 * 1024 * 1024;

export const WORKING_RESULT_ARRAY_ARTIFACTS = {
  "current-labels": "current-labels.npy",
  "base-labels": "base-labels.npy",
  "normalized-display": "normalized-display.npy",
} as const;

export type WorkingResultArrayArtifactId = keyof typeof WORKING_RESULT_ARRAY_ARTIFACTS;

export interface WorkingResultArrayArtifactReceipt {
  artifact_id: WorkingResultArrayArtifactId;
  entry: (typeof WORKING_RESULT_ARRAY_ARTIFACTS)[WorkingResultArrayArtifactId];
  media_type: typeof WORKING_RESULT_ARRAY_MEDIA_TYPE;
  size_bytes: number;
  sha256: string;
}

export interface WorkingResultReceipt {
  schema_version: typeof WORKING_RESULT_SCHEMA_VERSION;
  pack: {
    basename: string;
    media_type: typeof WORKING_RESULT_MEDIA_TYPE;
    size_bytes: number;
    sha256: string;
  };
  artifacts: WorkingResultArrayArtifactReceipt[];
}

export interface VerifiedWorkingResultPublication {
  /** Path-free receipt safe to retain in project/job state or send to the renderer. */
  receipt: WorkingResultReceipt;
  /** Main-process-only absolute path to the verified immutable pack. */
  packPath: string;
}

const PACK_BASENAME_PATTERN =
  /^working-([A-Za-z0-9_-]{1,160})-r(0|[1-9]\d{0,15})\.loci-result$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HASH_BUFFER_BYTES = 1024 * 1024;

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

function boundedPositiveInteger(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= maximum
  );
}

function validatedPackBasename(value: unknown): string {
  if (typeof value !== "string" || value.length > 210) {
    throw new Error("The analysis engine returned an invalid working-result receipt.");
  }
  const match = PACK_BASENAME_PATTERN.exec(value);
  const revision = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(revision) || path.basename(value) !== value) {
    throw new Error("The analysis engine returned an invalid working-result receipt.");
  }
  return value;
}

/**
 * Strictly copy the untrusted engine response into a bounded, path-free receipt.
 * Extra fields are rejected so local paths cannot be smuggled into durable state.
 */
export function validateWorkingResultReceipt(value: unknown): WorkingResultReceipt {
  if (!exactRecord(value, ["schema_version", "pack", "artifacts"])) {
    throw new Error("The analysis engine returned an invalid working-result receipt.");
  }
  if (
    value.schema_version !== WORKING_RESULT_SCHEMA_VERSION
    || !exactRecord(value.pack, ["basename", "media_type", "size_bytes", "sha256"])
    || value.pack.media_type !== WORKING_RESULT_MEDIA_TYPE
    || !boundedPositiveInteger(value.pack.size_bytes, MAX_WORKING_RESULT_PACK_BYTES)
    || typeof value.pack.sha256 !== "string"
    || !SHA256_PATTERN.test(value.pack.sha256)
    || !Array.isArray(value.artifacts)
    || value.artifacts.length !== Object.keys(WORKING_RESULT_ARRAY_ARTIFACTS).length
  ) {
    throw new Error("The analysis engine returned an invalid working-result receipt.");
  }

  const basename = validatedPackBasename(value.pack.basename);
  const seen = new Set<WorkingResultArrayArtifactId>();
  const artifactsById = new Map<
    WorkingResultArrayArtifactId,
    WorkingResultArrayArtifactReceipt
  >();
  let expandedBytes = 0;
  for (const candidate of value.artifacts) {
    if (
      !exactRecord(candidate, [
        "artifact_id",
        "entry",
        "media_type",
        "size_bytes",
        "sha256",
      ])
      || typeof candidate.artifact_id !== "string"
      || !Object.hasOwn(WORKING_RESULT_ARRAY_ARTIFACTS, candidate.artifact_id)
    ) {
      throw new Error(
        "The analysis engine returned invalid working-result artifact provenance.",
      );
    }
    const artifactId = candidate.artifact_id as WorkingResultArrayArtifactId;
    if (
      seen.has(artifactId)
      || candidate.entry !== WORKING_RESULT_ARRAY_ARTIFACTS[artifactId]
      || candidate.media_type !== WORKING_RESULT_ARRAY_MEDIA_TYPE
      || !boundedPositiveInteger(candidate.size_bytes, MAX_WORKING_RESULT_ARRAY_BYTES)
      || typeof candidate.sha256 !== "string"
      || !SHA256_PATTERN.test(candidate.sha256)
    ) {
      throw new Error(
        "The analysis engine returned invalid working-result artifact provenance.",
      );
    }
    seen.add(artifactId);
    expandedBytes += candidate.size_bytes;
    artifactsById.set(artifactId, {
      artifact_id: artifactId,
      entry: WORKING_RESULT_ARRAY_ARTIFACTS[artifactId],
      media_type: WORKING_RESULT_ARRAY_MEDIA_TYPE,
      size_bytes: candidate.size_bytes,
      sha256: candidate.sha256,
    });
  }
  if (
    seen.size !== Object.keys(WORKING_RESULT_ARRAY_ARTIFACTS).length
    || expandedBytes > MAX_WORKING_RESULT_EXPANDED_BYTES
  ) {
    throw new Error(
      "The analysis engine returned invalid working-result artifact provenance.",
    );
  }
  const artifacts = (Object.keys(WORKING_RESULT_ARRAY_ARTIFACTS) as
    WorkingResultArrayArtifactId[]).map((artifactId) => artifactsById.get(artifactId)!);

  return {
    schema_version: WORKING_RESULT_SCHEMA_VERSION,
    pack: {
      basename,
      media_type: WORKING_RESULT_MEDIA_TYPE,
      size_bytes: value.pack.size_bytes,
      sha256: value.pack.sha256,
    },
    artifacts,
  };
}

function sameFileIdentity(
  first: Awaited<ReturnType<typeof fs.lstat>>,
  second: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return (
    first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
  );
}

async function verifyImmutablePackFile(
  packPath: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<void> {
  const before = await fs.lstat(packPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedSize) {
    throw new Error("The published working-result file does not match its receipt.");
  }

  const handle = await fs.open(
    packPath,
    fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW),
  );
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error("The working-result file changed before verification.");
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
        throw new Error("The working-result file ended during verification.");
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }

  const after = await fs.lstat(packPath);
  if (!sameFileIdentity(before, after) || digest.digest("hex") !== expectedSha256) {
    throw new Error("The working-result file failed publication verification.");
  }
}

/**
 * Revalidate an immutable working pack against the path-free artifact saved in
 * a project before sending that pack back to the engine.
 */
export async function verifyStoredWorkingResultArtifact(
  packPath: string,
  value: unknown,
): Promise<ResultArtifact> {
  if (
    !exactRecord(value, ["artifactId", "filename", "mediaType", "byteLength", "sha256"])
    || value.artifactId !== WORKING_RESULT_ARTIFACT_ID
    || value.mediaType !== WORKING_RESULT_MEDIA_TYPE
    || !boundedPositiveInteger(value.byteLength, MAX_WORKING_RESULT_PACK_BYTES)
    || typeof value.sha256 !== "string"
    || !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new Error("The saved working-result artifact is invalid.");
  }
  const filename = validatedPackBasename(value.filename);
  if (
    typeof packPath !== "string"
    || !path.isAbsolute(packPath)
    || path.basename(packPath) !== filename
  ) {
    throw new Error("The saved working-result path does not match its project artifact.");
  }
  await verifyImmutablePackFile(packPath, value.byteLength, value.sha256);
  return {
    artifactId: WORKING_RESULT_ARTIFACT_ID,
    filename,
    mediaType: WORKING_RESULT_MEDIA_TYPE,
    byteLength: value.byteLength,
    sha256: value.sha256,
  };
}

/**
 * Convert private filesystem and integrity failures into one actionable,
 * path-free project-recovery error before the failure crosses IPC.
 */
export async function verifyRestorableProjectWorkingResultArtifact(
  packPath: string,
  value: unknown,
): Promise<ResultArtifact> {
  try {
    return await verifyStoredWorkingResultArtifact(packPath, value);
  } catch (cause) {
    throw new Error(SAVED_WORKING_RESULT_UNAVAILABLE_MESSAGE, { cause });
  }
}

/**
 * Verify the exact no-overwrite pack named by an engine receipt. The returned
 * receipt is a newly constructed path-free value; only `packPath` remains local
 * main-process authority and must never be exposed to renderer/project JSON.
 */
export async function verifyPublishedWorkingResult(
  directory: string,
  value: unknown,
): Promise<VerifiedWorkingResultPublication> {
  const receipt = validateWorkingResultReceipt(value);
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error("The private working-result directory must be absolute.");
  }
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("The private working-result location is not a real directory.");
  }
  const canonicalDirectory = await fs.realpath(directory);
  const packPath = path.resolve(canonicalDirectory, receipt.pack.basename);
  const relativePath = path.relative(canonicalDirectory, packPath);
  if (
    relativePath !== receipt.pack.basename
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error("The published working result escaped its private job directory.");
  }

  await verifyImmutablePackFile(packPath, receipt.pack.size_bytes, receipt.pack.sha256);
  return { receipt, packPath };
}
