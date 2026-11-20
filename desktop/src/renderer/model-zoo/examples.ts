import {
  isModelLibraryId,
  type ModelLibraryId,
} from "../../shared/model-library";

export type ModelZooExampleKind = "prediction" | "input-only";

export interface ModelZooExampleCredit {
  readonly modelId: ModelLibraryId;
  readonly modelVersion: string;
  readonly kind: ModelZooExampleKind;
  readonly subject: string;
  readonly attribution: string;
  readonly imageLicense: string;
  readonly sourceUrl: string;
  readonly publicationUrl: string;
  readonly displayTransform: string;
  readonly predictionOrigin: string | null;
  readonly extraMetadata: Readonly<Record<string, unknown>>;
}

export interface ModelZooPredictionExample {
  readonly kind: "prediction";
  readonly modelId: ModelLibraryId;
  readonly credit: Readonly<ModelZooExampleCredit>;
  readonly thumbnailUrl: string;
  readonly originalUrl: string;
  readonly overlayUrl: string;
}

export interface ModelZooInputOnlyExample {
  readonly kind: "input-only";
  readonly modelId: ModelLibraryId;
  readonly credit: Readonly<ModelZooExampleCredit>;
  readonly thumbnailUrl: string;
  readonly originalUrl: string;
  readonly overlayUrl: null;
}

export type ModelZooResolvedExample =
  | ModelZooPredictionExample
  | ModelZooInputOnlyExample;

export type ModelZooExampleRegistry = Readonly<
  Partial<Record<ModelLibraryId, Readonly<ModelZooResolvedExample>>>
>;

const MANDATORY_CREDIT_KEYS = new Set([
  "modelId",
  "modelVersion",
  "kind",
  "subject",
  "attribution",
  "imageLicense",
  "sourceUrl",
  "publicationUrl",
  "displayTransform",
  "predictionOrigin",
]);

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Accepts only local bundled asset URLs emitted by Vite (or in-memory data:image/
 * test doubles). Never permits remote http(s) or executable schemes so rendering
 * the gallery cannot trigger automatic network egress.
 */
export function isSafeLocalAssetUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("//")) return false;
  if (/^(?:https?|javascript|vbscript|ftp|ws|wss):/iu.test(trimmed)) {
    return false;
  }
  if (/^data:/iu.test(trimmed)) {
    return /^data:image\/(?:webp|png|jpeg|gif);base64,/iu.test(trimmed);
  }
  return true;
}

export function parseModelZooExampleCredit(
  raw: unknown,
  expectedModelId: ModelLibraryId,
): Readonly<ModelZooExampleCredit> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const modelId = readNonEmptyString(record, "modelId");
  if (!modelId || !isModelLibraryId(modelId) || modelId !== expectedModelId) {
    return null;
  }

  const kind = record.kind;
  if (kind !== "prediction" && kind !== "input-only") {
    return null;
  }

  const modelVersion = readNonEmptyString(record, "modelVersion");
  const subject = readNonEmptyString(record, "subject");
  const attribution = readNonEmptyString(record, "attribution");
  const imageLicense = readNonEmptyString(record, "imageLicense");
  const sourceUrl = readNonEmptyString(record, "sourceUrl");
  const publicationUrl = readNonEmptyString(record, "publicationUrl");
  const displayTransform = readNonEmptyString(record, "displayTransform");
  if (
    !modelVersion ||
    !subject ||
    !attribution ||
    !imageLicense ||
    !sourceUrl ||
    !publicationUrl ||
    !displayTransform
  ) {
    return null;
  }

  if (!Object.hasOwn(record, "predictionOrigin")) {
    return null;
  }
  const rawOrigin = record.predictionOrigin;
  let predictionOrigin: string | null;
  if (kind === "prediction") {
    if (typeof rawOrigin !== "string" || rawOrigin.trim().length === 0) {
      return null;
    }
    predictionOrigin = rawOrigin.trim();
  } else {
    if (rawOrigin !== null) {
      return null;
    }
    predictionOrigin = null;
  }

  const extraMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!MANDATORY_CREDIT_KEYS.has(key)) {
      extraMetadata[key] = value;
    }
  }

  return Object.freeze({
    modelId,
    modelVersion,
    kind,
    subject,
    attribution,
    imageLicense,
    sourceUrl,
    publicationUrl,
    displayTransform,
    predictionOrigin,
    extraMetadata: Object.freeze(extraMetadata),
  });
}

const CREDIT_PATH_RE = /(?:^|\/)examples\/([^/]+)\/credit\.json$/;
const MEDIA_PATH_RE =
  /(?:^|\/)examples\/([^/]+)\/(thumbnail|original|overlay)\.webp$/;

export function buildModelZooExampleRegistry(
  creditFiles: Readonly<Record<string, unknown>>,
  mediaFiles: Readonly<Record<string, string>>,
): ModelZooExampleRegistry {
  const mediaByModel = new Map<
    ModelLibraryId,
    Partial<Record<"thumbnail" | "original" | "overlay", string>>
  >();

  for (const [filePath, url] of Object.entries(mediaFiles)) {
    const match = MEDIA_PATH_RE.exec(filePath.replace(/\\/g, "/"));
    if (!match) continue;
    const [, rawId, slot] = match;
    if (!isModelLibraryId(rawId) || !isSafeLocalAssetUrl(url)) continue;
    const bucket = mediaByModel.get(rawId) ?? {};
    bucket[slot as "thumbnail" | "original" | "overlay"] = url;
    mediaByModel.set(rawId, bucket);
  }

  const resolved: Partial<Record<ModelLibraryId, Readonly<ModelZooResolvedExample>>> =
    {};

  for (const [filePath, rawCredit] of Object.entries(creditFiles)) {
    const match = CREDIT_PATH_RE.exec(filePath.replace(/\\/g, "/"));
    if (!match) continue;
    const [, rawId] = match;
    if (!isModelLibraryId(rawId)) continue;

    const credit = parseModelZooExampleCredit(rawCredit, rawId);
    if (!credit) continue;

    const media = mediaByModel.get(rawId);
    if (!media?.thumbnail || !media?.original) continue;

    if (credit.kind === "prediction") {
      if (!media.overlay) continue;
      resolved[rawId] = Object.freeze({
        kind: "prediction",
        modelId: rawId,
        credit,
        thumbnailUrl: media.thumbnail,
        originalUrl: media.original,
        overlayUrl: media.overlay,
      });
    } else {
      resolved[rawId] = Object.freeze({
        kind: "input-only",
        modelId: rawId,
        credit,
        thumbnailUrl: media.thumbnail,
        originalUrl: media.original,
        overlayUrl: null,
      });
    }
  }

  return Object.freeze(resolved);
}

const bundledCreditFiles = import.meta.glob<unknown>("./examples/*/credit.json", {
  eager: true,
  import: "default",
});

const bundledMediaFiles = import.meta.glob<string>("./examples/*/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});

export const BUNDLED_MODEL_ZOO_EXAMPLES: ModelZooExampleRegistry =
  buildModelZooExampleRegistry(bundledCreditFiles, bundledMediaFiles);
