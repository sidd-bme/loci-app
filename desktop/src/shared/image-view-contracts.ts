export const HEX_32_PATTERN = /^[a-f0-9]{32}$/u;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/u;

export const MAX_IMAGE_VIEWS = 2;
export const MAX_CONTROL_VIEWS = 1;

/**
 * Renderer-safe target snapshot for an image view.
 * Contains only main-issued opaque tokens, IDs, and hashes.
 * Never exposes source paths, pixels, models, credentials, or native window handles.
 */
export interface ImageViewTargetSnapshot {
  readonly viewId: string;
  readonly sessionEpoch: string;
  readonly generation: number;
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly resultId: string | null;
  readonly resultRevisionHash: string | null;
}

export type ImageViewTarget = ImageViewTargetSnapshot;

/**
 * Verified source binding supplied by trusted main callers.
 */
export interface ImageViewBindingInput {
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly resultId?: string | null;
  readonly resultRevisionHash?: string | null;
}

export const TARGET_SNAPSHOT_KEYS: readonly (keyof ImageViewTargetSnapshot)[] = [
  "viewId",
  "sessionEpoch",
  "generation",
  "sourceId",
  "sourceSha256",
  "resultId",
  "resultRevisionHash",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value instanceof String || value instanceof Number || value instanceof Boolean) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actualKeys = Object.keys(value).sort().join(",");
  const expectedKeys = [...keys].sort().join(",");
  if (actualKeys !== expectedKeys) {
    throw new Error(`${label} has unsupported fields.`);
  }
}

/**
 * Strict validator for renderer-safe target snapshots.
 * Rejects unexpected keys, malformed/boxed values, and mismatched result pairs.
 */
export function validateTargetSnapshot(value: unknown): ImageViewTargetSnapshot {
  if (!isPlainRecord(value)) {
    throw new Error("Target snapshot must be a non-null plain object.");
  }
  exactKeys(value, TARGET_SNAPSHOT_KEYS, "Target snapshot");

  const {
    viewId,
    sessionEpoch,
    generation,
    sourceId,
    sourceSha256,
    resultId,
    resultRevisionHash,
  } = value;

  if (typeof viewId !== "string" || !viewId || viewId.length > 128 || /[\u0000-\u001f\u007f]/u.test(viewId)) {
    throw new Error("Target viewId is invalid.");
  }
  if (
    typeof sessionEpoch !== "string" ||
    !sessionEpoch ||
    sessionEpoch.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(sessionEpoch)
  ) {
    throw new Error("Target sessionEpoch is invalid.");
  }
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Target generation must be a non-negative safe integer.");
  }
  if (typeof sourceId !== "string" || !HEX_32_PATTERN.test(sourceId)) {
    throw new Error("Target sourceId must be a 32-character lowercase hex string.");
  }
  if (typeof sourceSha256 !== "string" || !HEX_64_PATTERN.test(sourceSha256)) {
    throw new Error("Target sourceSha256 must be a 64-character lowercase hex string.");
  }

  const hasResultId = resultId !== null && resultId !== undefined;
  const hasResultHash = resultRevisionHash !== null && resultRevisionHash !== undefined;

  if (!hasResultId && !hasResultHash) {
    if (resultId !== null || resultRevisionHash !== null) {
      throw new Error("Raw source target snapshot must have null resultId and resultRevisionHash.");
    }
  } else if (hasResultId && hasResultHash) {
    if (typeof resultId !== "string" || !HEX_32_PATTERN.test(resultId)) {
      throw new Error("Target resultId must be a 32-character lowercase hex string.");
    }
    if (typeof resultRevisionHash !== "string" || !HEX_64_PATTERN.test(resultRevisionHash)) {
      throw new Error("Target resultRevisionHash must be a 64-character lowercase hex string.");
    }
  } else {
    throw new Error("Target resultId and resultRevisionHash must both be present or both be null.");
  }

  return Object.freeze({
    viewId,
    sessionEpoch,
    generation,
    sourceId,
    sourceSha256,
    resultId,
    resultRevisionHash,
  });
}

/**
 * Strict validator for verified main-process image binding inputs.
 */
export function validateImageViewBindingInput(value: unknown): {
  sourceId: string;
  sourceSha256: string;
  resultId: string | null;
  resultRevisionHash: string | null;
} {
  if (!isPlainRecord(value)) {
    throw new Error("Image view binding must be a non-null plain object.");
  }

  const allowedKeys = new Set(["sourceId", "sourceSha256", "resultId", "resultRevisionHash"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error("Image view binding has unsupported fields.");
    }
  }

  const { sourceId, sourceSha256, resultId = null, resultRevisionHash = null } = value;

  if (typeof sourceId !== "string" || !HEX_32_PATTERN.test(sourceId)) {
    throw new Error("Binding sourceId must be a 32-character lowercase hex string.");
  }
  if (typeof sourceSha256 !== "string" || !HEX_64_PATTERN.test(sourceSha256)) {
    throw new Error("Binding sourceSha256 must be a 64-character lowercase hex string.");
  }

  const hasResultId = resultId !== null && resultId !== undefined;
  const hasResultHash = resultRevisionHash !== null && resultRevisionHash !== undefined;

  let validatedResultId: string | null = null;
  let validatedResultHash: string | null = null;

  if (!hasResultId && !hasResultHash) {
    validatedResultId = null;
    validatedResultHash = null;
  } else if (hasResultId && hasResultHash) {
    if (typeof resultId !== "string" || !HEX_32_PATTERN.test(resultId)) {
      throw new Error("Binding resultId must be a 32-character lowercase hex string.");
    }
    if (typeof resultRevisionHash !== "string" || !HEX_64_PATTERN.test(resultRevisionHash)) {
      throw new Error("Binding resultRevisionHash must be a 64-character lowercase hex string.");
    }
    validatedResultId = resultId;
    validatedResultHash = resultRevisionHash;
  } else {
    throw new Error("Binding resultId and resultRevisionHash must both be present or both be null.");
  }

  return Object.freeze({
    sourceId,
    sourceSha256,
    resultId: validatedResultId,
    resultRevisionHash: validatedResultHash,
  });
}
