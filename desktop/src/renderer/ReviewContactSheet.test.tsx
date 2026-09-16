// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisResult, ImportedImage } from "../shared/contracts";
import ReviewContactSheet from "./ReviewContactSheet";
import ReviewInspector from "./ReviewInspector";
import type { ReviewItem } from "./review-state";

beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
  Element.prototype.scrollTo = vi.fn();
});

afterEach(cleanup);

function analysis(id: string, count: number, status: AnalysisResult["quality"]["status"] = "nominal"): AnalysisResult {
  return {
    resultId: id,
    evictedResultIds: [],
    source: { name: `${id}.png`, relativePath: `plate/${id}.png`, width: 20, height: 20, channels: 1, dtype: "uint8", format: "PNG", pageCount: 1 },
    engine: { id: "loci-classical", version: "0.1.0" },
    profile: { id: "loci-classical", name: "LociSeg", version: "0.1.0", backendKind: "classical", model: { format: "builtin-algorithm", artifactId: null, sha256: null }, preprocessing: { channelConversion: "grayscale-luminance", intensityNormalization: "per-image-percentile-1-99", resizePolicy: "none", maxEdgePx: null, outputGrid: "source-resolution" } },
    settings: { image_mode: "auto", polarity: "auto", expected_diameter_px: 34, min_area_px: 80, sensitivity: 0, smoothing_px: 1.2, split_touching: true, exclude_border: false },
    resolved: { polarity: "dark", threshold: 0.5 },
    metrics: { count, confluencePercent: 4 },
    quality: { status, scope: "structural_sanity_only", flags: [] },
    measurements: [],
    corrections: { revision: 0, hasManualEdits: false, canUndo: false, canRedo: false, appliedOperations: [], events: [], eventCount: 0, eventsTruncated: false },
    previewDataUrl: "data:image/png;base64,",
    overlayDataUrl: "data:image/png;base64,",
  };
}

function item(index: number, overrides: Partial<ReviewItem> = {}): ReviewItem {
  const source: ImportedImage = { sourceId: `source-${index}`, name: `image-${index}.png`, relativePath: `plate/image-${index}.png` };
  return {
    source,
    result: analysis(`result-${index}`, 100 + index),
    reviewStatus: "unreviewed",
    countOutlier: false,
    acquisitionGroup: "plate",
    ...overrides,
  };
}

describe("ReviewContactSheet", () => {
  it("renders result status, count and descriptive outlier state", () => {
    render(
      <ReviewContactSheet
        items={[item(0, { countOutlier: true }), item(1, { reviewStatus: "reviewed" })]}
        activeSourceId="source-0"
        onSelect={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /image-0\.png, Unreviewed, 100 cells/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Count outlier")).toBeVisible();
    expect(screen.getByText("Reviewed")).toBeVisible();
  });

  it("supports selection, open and roving arrow navigation", () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    render(<ReviewContactSheet items={[item(0), item(1), item(2)]} activeSourceId="source-0" onSelect={onSelect} onOpen={onOpen} />);
    const first = screen.getByRole("button", { name: /image-0\.png/i });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("source-1");
    fireEvent.doubleClick(first);
    expect(onOpen).toHaveBeenCalledWith("source-0");
  });

  it("shows a calm empty state", () => {
    render(<ReviewContactSheet items={[]} activeSourceId={null} onSelect={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText("No results match this review filter")).toBeVisible();
  });
});

describe("ReviewInspector", () => {
  it("exposes filter, sort and next-unreviewed controls", () => {
    const onFilterChange = vi.fn();
    const onSortChange = vi.fn();
    const onNext = vi.fn();
    render(
      <ReviewInspector
        summary={{ total: 12, processed: 10, unreviewed: 4, flagged: 2, reviewed: 5, excluded: 1 }}
        filter="all"
        sort="source"
        onFilterChange={onFilterChange}
        onSortChange={onSortChange}
        onNextUnreviewed={onNext}
        canGoToNext
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Flagged\s*2/i }));
    expect(onFilterChange).toHaveBeenCalledWith("flagged");
    fireEvent.change(screen.getByLabelText("Sort results"), { target: { value: "count-descending" } });
    expect(onSortChange).toHaveBeenCalledWith("count-descending");
    fireEvent.click(screen.getByRole("button", { name: "Next unreviewed" }));
    expect(onNext).toHaveBeenCalledOnce();
  });
});
