import { describe, expect, it } from "vitest";

import type { AnalysisResult, ImportedImage } from "../shared/contracts";
import type { ProjectReviewRecord } from "../shared/foundation-contracts";
import {
  buildReviewItems,
  countOutlierSourceIds,
  createReviewDecision,
  currentReviewStatus,
} from "./review-state";

function result(id: string, count = 100, revision = 0, quality: AnalysisResult["quality"]["status"] = "nominal"): AnalysisResult {
  return {
    resultId: id,
    evictedResultIds: [],
    source: { name: "image.png", relativePath: "group/image.png", width: 10, height: 10, channels: 1, dtype: "uint8", format: "PNG", pageCount: 1 },
    engine: { id: "loci-classical", version: "0.1.0" },
    profile: {
      id: "loci-classical",
      name: "LociSeg",
      version: "0.1.0",
      backendKind: "classical",
      model: { format: "builtin-algorithm", artifactId: null, sha256: null },
      preprocessing: { channelConversion: "grayscale-luminance", intensityNormalization: "per-image-percentile-1-99", resizePolicy: "none", maxEdgePx: null, outputGrid: "source-resolution" },
    },
    settings: { image_mode: "auto", polarity: "auto", expected_diameter_px: 34, min_area_px: 80, sensitivity: 0, smoothing_px: 1.2, split_touching: true, exclude_border: false },
    resolved: { polarity: "dark", threshold: 0.5 },
    metrics: { count, confluencePercent: 10 },
    quality: { status: quality, scope: "structural_sanity_only", flags: [] },
    measurements: [],
    corrections: { revision, hasManualEdits: revision > 0, canUndo: revision > 0, canRedo: false, appliedOperations: [], events: [], eventCount: revision, eventsTruncated: false },
    previewDataUrl: "data:image/png;base64,",
    overlayDataUrl: "data:image/png;base64,",
  };
}

function source(index: number, group = "plate-a"): ImportedImage {
  return {
    sourceId: `source-${index}`,
    name: `image-${index}.png`,
    relativePath: `${group}/image-${index}.png`,
  };
}

describe("review state", () => {
  it("binds review to the exact result and correction revision", () => {
    const analysis = result("result-1", 10, 2);
    const review = createReviewDecision("source-1", analysis, "reviewed", {
      id: () => "review-1",
      now: () => new Date("2026-09-01T01:00:00.000Z"),
    });
    expect(currentReviewStatus(analysis, [review])).toBe("reviewed");
    expect(currentReviewStatus({ ...analysis, corrections: { ...analysis.corrections, revision: 3 } }, [review])).toBe("unreviewed");
    expect(currentReviewStatus({ ...analysis, resultId: "result-2" }, [review])).toBe("unreviewed");
  });

  it("prevents structurally invalid results from being called reviewed", () => {
    const invalid = result("invalid", 0, 0, "invalid");
    expect(() => createReviewDecision("source-1", invalid, "reviewed")).toThrow(/cannot be marked reviewed/i);
  });

  it("records exclusion as an explicit source, result, and revision decision", () => {
    const invalid = result("invalid", 0, 3, "invalid");
    const exclusion = createReviewDecision("source-1", invalid, "excluded", {
      id: () => "exclusion-1",
      now: () => new Date("2026-09-01T02:00:00.000Z"),
      note: "  Focus failure\nexclude from reviewed counts  ",
    });

    expect(exclusion).toEqual({
      reviewId: "exclusion-1",
      sourceId: "source-1",
      resultId: "invalid",
      correctionRevision: 3,
      disposition: "excluded",
      decidedAt: "2026-09-01T02:00:00.000Z",
      note: "Focus failure exclude from reviewed counts",
    });
  });

  it("invalidates a prior review in the rendered item model after correction", () => {
    const original = result("result-1", 100, 0);
    const review = createReviewDecision("source-1", original, "reviewed", {
      id: () => "review-1",
      now: () => new Date("2026-09-01T01:00:00.000Z"),
    });
    const corrected = result("result-1", 101, 1);

    expect(buildReviewItems([source(1)], { "source-1": original }, [review])[0].reviewStatus)
      .toBe("reviewed");
    expect(buildReviewItems([source(1)], { "source-1": corrected }, [review])[0].reviewStatus)
      .toBe("unreviewed");
  });

  it("uses only the latest exact-revision decision", () => {
    const analysis = result("result-1");
    const reviews: ProjectReviewRecord[] = [
      { reviewId: "a", sourceId: "source-1", resultId: "result-1", correctionRevision: 0, disposition: "reviewed", decidedAt: "2026-09-01T00:00:00.000Z", note: "" },
      { reviewId: "b", sourceId: "source-1", resultId: "result-1", correctionRevision: 0, disposition: "excluded", decidedAt: "2026-09-01T01:00:00.000Z", note: "" },
    ];
    expect(currentReviewStatus(analysis, reviews)).toBe("excluded");
  });

  it("flags robust count outliers only within sufficiently large acquisition groups", () => {
    const sources = Array.from({ length: 10 }, (_, index) => source(index));
    const counts = [98, 99, 100, 100, 101, 101, 102, 99, 100, 300];
    const results = Object.fromEntries(sources.map((item, index) => [item.sourceId, result(`result-${index}`, counts[index])]));
    expect([...countOutlierSourceIds(sources, results)]).toEqual(["source-9"]);

    const smallSources = sources.slice(0, 7);
    expect(countOutlierSourceIds(smallSources, results).size).toBe(0);
  });

  it("does not flag a zero-MAD group and describes each item without changing quality", () => {
    const sources = Array.from({ length: 8 }, (_, index) => source(index));
    const results = Object.fromEntries(sources.map((item, index) => [item.sourceId, result(`result-${index}`, index === 7 ? 500 : 100)]));
    expect(countOutlierSourceIds(sources, results).size).toBe(0);
    const items = buildReviewItems(sources, results, []);
    expect(items).toHaveLength(8);
    expect(items.every(({ reviewStatus }) => reviewStatus === "unreviewed")).toBe(true);
    expect(items[0].acquisitionGroup).toBe("plate-a");
  });
});
