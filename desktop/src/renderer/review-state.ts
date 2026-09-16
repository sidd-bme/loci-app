import type { AnalysisResult, ImportedImage } from "../shared/contracts";
import type {
  ProjectReviewDisposition,
  ProjectReviewRecord,
} from "../shared/foundation-contracts";

export const COUNT_OUTLIER_POLICY_VERSION = "loci.count-outlier/mad-v1" as const;
export const MIN_OUTLIER_GROUP_SIZE = 8;
export const MODIFIED_Z_THRESHOLD = 3.5;

export type CurrentReviewStatus = "unreviewed" | ProjectReviewDisposition;

export interface ReviewItem {
  source: ImportedImage;
  result: AnalysisResult | null;
  reviewStatus: CurrentReviewStatus;
  countOutlier: boolean;
  acquisitionGroup: string;
}

export interface ReviewDecisionOptions {
  now?: () => Date;
  id?: () => string;
  note?: string;
}

function latestExactReview(
  result: Pick<AnalysisResult, "resultId" | "corrections">,
  reviews: readonly ProjectReviewRecord[],
): ProjectReviewRecord | undefined {
  return reviews
    .filter((review) =>
      review.resultId === result.resultId &&
      review.correctionRevision === result.corrections.revision)
    .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt) ||
      right.reviewId.localeCompare(left.reviewId))[0];
}

export function currentReviewStatus(
  result: Pick<AnalysisResult, "resultId" | "corrections"> | null | undefined,
  reviews: readonly ProjectReviewRecord[],
): CurrentReviewStatus {
  if (!result) return "unreviewed";
  return latestExactReview(result, reviews)?.disposition ?? "unreviewed";
}

export function createReviewDecision(
  sourceId: string,
  result: Pick<AnalysisResult, "resultId" | "corrections" | "quality">,
  disposition: ProjectReviewDisposition,
  options: ReviewDecisionOptions = {},
): ProjectReviewRecord {
  if (!sourceId || !result.resultId) throw new Error("A review requires a source and result.");
  if (disposition === "reviewed" && result.quality.status === "invalid") {
    throw new Error("A structurally invalid result cannot be marked reviewed. Exclude it instead.");
  }
  const note = (options.note ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (note.length > 1_000) throw new Error("A review note may contain at most 1,000 characters.");
  return {
    reviewId: (options.id ?? (() => globalThis.crypto.randomUUID()))(),
    sourceId,
    resultId: result.resultId,
    correctionRevision: result.corrections.revision,
    disposition,
    decidedAt: (options.now ?? (() => new Date()))().toISOString(),
    note,
  };
}

function portableParent(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "." : normalized.slice(0, separator);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

/**
 * Descriptive triage only. A count outlier is not a biological or accuracy
 * judgment and is never calculated across acquisition-folder boundaries.
 */
export function countOutlierSourceIds(
  sources: readonly ImportedImage[],
  results: Readonly<Record<string, AnalysisResult>>,
): Set<string> {
  const groups = new Map<string, Array<{ sourceId: string; count: number }>>();
  for (const source of sources) {
    const result = results[source.sourceId];
    if (!result || result.quality.status === "invalid") continue;
    const group = portableParent(source.relativePath);
    const existing = groups.get(group) ?? [];
    existing.push({ sourceId: source.sourceId, count: result.metrics.count });
    groups.set(group, existing);
  }

  const outliers = new Set<string>();
  for (const entries of groups.values()) {
    if (entries.length < MIN_OUTLIER_GROUP_SIZE) continue;
    const center = median(entries.map(({ count }) => count));
    const deviation = median(entries.map(({ count }) => Math.abs(count - center)));
    if (deviation === 0) continue;
    for (const entry of entries) {
      const modifiedZ = 0.6745 * Math.abs(entry.count - center) / deviation;
      if (modifiedZ > MODIFIED_Z_THRESHOLD) outliers.add(entry.sourceId);
    }
  }
  return outliers;
}

export function buildReviewItems(
  sources: readonly ImportedImage[],
  results: Readonly<Record<string, AnalysisResult>>,
  reviews: readonly ProjectReviewRecord[],
): ReviewItem[] {
  const outliers = countOutlierSourceIds(sources, results);
  return sources.map((source) => {
    const result = results[source.sourceId] ?? null;
    return {
      source,
      result,
      reviewStatus: currentReviewStatus(result, reviews),
      countOutlier: outliers.has(source.sourceId),
      acquisitionGroup: portableParent(source.relativePath),
    };
  });
}
