// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchRecipe,
  ResearchResult,
  ResearchSnapshot,
} from "../shared/research-contracts";
import { ResearchQuantificationPanel } from "./ResearchQuantificationPanel";

afterEach(cleanup);

const sourceId = "a".repeat(32);
const sourceSha = "b".repeat(64);
const selection = { x: 0, y: 0, width: 10, height: 8, t: 0, c: 0, z: 0, level: 0 };
const geometry = {
  axes: "YX",
  affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  unit: "um",
  frame: "image",
};
const dummyResult: ResearchResult = {
  id: "3".repeat(32),
  source_id: sourceId,
  source_sha256: sourceSha,
  kind: "fluorescence-field-assay",
  created_at: "now",
  revision_hash: "3".repeat(64),
  object_count: 1,
  arrays: {
    image: { shape: [8, 10], dtype: "float64", sha256: "9".repeat(64) },
  },
  geometry,
  selection,
  parent_id: null,
};
const snapshot: ResearchSnapshot = {
  project: { title: "Quantification" },
  sources: [{
    id: sourceId,
    name: "Widefield source",
    sha256: sourceSha,
    metadata: { dimensions: { t: 1, c: 2, z: 1, y: 8, x: 10 } },
  }],
  results: [],
  samples: [],
  recipes: [],
  displays: [],
  channels: [],
  selections: [],
  jobs: [],
  operations: {},
};
const channelMetadata = {
  source_id: sourceId,
  source_sha256: sourceSha,
  original_names: ["Channel 1 (DAPI)", "Channel 2 (IL4R)"],
  revision: 1,
  channels: [
    { index: 0, name: "DAPI", marker: "nuclei", fluorophore: "DAPI", declaration: "metadata" },
    { index: 1, name: "IL4R", marker: "receptor", fluorophore: "TRITC", declaration: "metadata" },
  ],
  basis: "explicit declarations",
};
const sourceAnnotations = {
  source_id: sourceId,
  source_sha256: sourceSha,
  revision: 3,
  annotations: [
    { id: "ann-focus-1", label: "focus", kind: "polygon", z: 0, t: 0 },
    { id: "ann-bg-1", label: "background", kind: "polygon", z: 0, t: 0 },
    { id: "ann-pt-1", label: "count", kind: "point", z: 0, t: 0, points: [{ x: 2, y: 3 }, { x: 4, y: 5 }] },
    { id: "ann-other-z", label: "wrong plane", kind: "rectangle", z: 1, t: 0 },
    { id: "ann-other-t", label: "wrong time", kind: "point", z: 0, t: 1, points: [{ x: 1, y: 1 }] },
  ],
};
const recipe: ResearchRecipe = {
  steps: [],
  segmentation: { method: "components", threshold: 0, polarity: "bright", min_size: 1, exclude_border: false },
  measurement_channels: [0],
  gates: [],
  working_bytes: 512 * 1024 ** 2,
};

function createApi(executeMock: ResearchDesktopApi["execute"]): ResearchDesktopApi {
  return {
    createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(),
    execute: executeMock, reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
  };
}

function renderFieldAssayPanel(executeMock: ResearchDesktopApi["execute"]) {
  const onPublished = vi.fn().mockResolvedValue(undefined);
  const onPreview = vi.fn();
  const utils = render(<ResearchQuantificationPanel
    api={createApi(executeMock)} snapshot={snapshot} source={snapshot.sources[0]} selection={selection}
    recipe={recipe} setRecipe={vi.fn()} report={async (work) => work()} busy={false}
    onBusyChange={vi.fn()} onPreview={onPreview} onPublished={onPublished}
  />);
  return { ...utils, onPublished, onPreview };
}

describe("ResearchQuantificationPanel - Field Assay Tab", () => {
  it("discards stale annotation responses when the exact source changes", async () => {
    const secondSource = {
      ...snapshot.sources[0],
      id: "c".repeat(32),
      sha256: "d".repeat(64),
      name: "Second source",
    };
    let resolveFirstAnnotations!: (value: typeof sourceAnnotations) => void;
    const firstAnnotations = new Promise<typeof sourceAnnotations>((resolve) => {
      resolveFirstAnnotations = resolve;
    });
    const execute = vi.fn(async (op: string, request: Record<string, unknown>) => {
      const requestedId = String(request.source_id);
      const requestedSource = requestedId === secondSource.id ? secondSource : snapshot.sources[0];
      if (op === "channel_metadata") return {
        ...channelMetadata,
        source_id: requestedSource.id,
        source_sha256: requestedSource.sha256,
      };
      if (op === "source_annotations") {
        if (requestedId === sourceId) return firstAnnotations;
        return {
          source_id: secondSource.id,
          source_sha256: secondSource.sha256,
          revision: 0,
          annotations: [],
        };
      }
      return {};
    });
    const api = createApi(execute);
    const props = {
      api,
      snapshot: { ...snapshot, sources: [snapshot.sources[0], secondSource] },
      selection,
      recipe,
      setRecipe: vi.fn(),
      report: async <T,>(work: () => Promise<T>) => work(),
      busy: false,
      onBusyChange: vi.fn(),
      onPreview: vi.fn(),
      onPublished: vi.fn(),
    };
    const { rerender } = render(
      <ResearchQuantificationPanel {...props} source={snapshot.sources[0]} />,
    );
    rerender(<ResearchQuantificationPanel {...props} source={secondSource} />);
    await screen.findByText(/original: Channel 1/);
    resolveFirstAnnotations(sourceAnnotations);
    await Promise.resolve();
    fireEvent.click(screen.getByText("Field assay"));

    expect(screen.getByLabelText("Field assay readiness")).toHaveTextContent("Second source");
    expect(screen.getByLabelText("Field assay readiness")).toHaveTextContent(secondSource.sha256.slice(0, 12));
    expect(screen.getByLabelText("Focus region selection").querySelectorAll("option")).toHaveLength(2);
    expect(screen.queryByText(/ROI: focus/)).not.toBeInTheDocument();
  });

  it("defaults to annotation mode for focus and background, shows warnings for whole-field or zero background", async () => {
    const execute = vi.fn(async (op: string) => {
      if (op === "channel_metadata") return channelMetadata;
      if (op === "source_annotations") return sourceAnnotations;
      return {};
    });

    renderFieldAssayPanel(execute);
    await screen.findByText(/original: Channel 1/);

    // Switch to field-assay tab
    fireEvent.click(screen.getByText("Field assay"));
    expect(screen.getByText("Fluorescence per nucleus")).toBeVisible();
    expect(screen.queryByText(/Recorded Dr Tan/)).not.toBeInTheDocument();

    // Select focus region: choose whole field
    const focusSelect = screen.getByLabelText("Focus region selection");
    fireEvent.change(focusSelect, { target: { value: "all" } });
    expect(screen.getByText(/Whole-field measurement is exploratory only/)).toBeVisible();

    // Select background mode: switch to explicit value of 0
    const bgModeSelect = screen.getByLabelText("Background mode selection");
    fireEvent.change(bgModeSelect, { target: { value: "value" } });
    expect(screen.getByText(/Unmeasured zero background is exploratory only/)).toBeVisible();
  });

  it("displays educational warning when Otsu or Yen automatic threshold is selected", async () => {
    const execute = vi.fn(async (op: string) => {
      if (op === "channel_metadata") return channelMetadata;
      if (op === "source_annotations") return sourceAnnotations;
      return {};
    });

    renderFieldAssayPanel(execute);
    await screen.findByText(/original: Channel 1/);
    fireEvent.click(screen.getByText("Field assay"));

    const segSelect = screen.getByLabelText("Segmentation method");
    fireEvent.change(segSelect, { target: { value: "otsu" } });

    expect(
      screen.getByText(/OTSU calculates an image-dependent threshold that varies across fields/),
    ).toBeVisible();
  });

  it("populates multi-point annotations and all_points option", async () => {
    const execute = vi.fn(async (op: string) => {
      if (op === "channel_metadata") return channelMetadata;
      if (op === "source_annotations") return sourceAnnotations;
      return {};
    });

    renderFieldAssayPanel(execute);
    await screen.findByText(/original: Channel 1/);
    fireEvent.click(screen.getByText("Field assay"));

    const countModeSelect = screen.getByLabelText("Count mode");
    fireEvent.change(countModeSelect, { target: { value: "points" } });

    const ptSelect = screen.getByLabelText("Manual points annotation");
    expect(ptSelect).toBeVisible();
    expect(screen.getByText("All point markers on T 0, Z 0")).toBeInTheDocument();
    expect(screen.getByText(/Marks: count \(2 points\)/)).toBeInTheDocument();
    expect(screen.queryByText(/wrong plane/)).not.toBeInTheDocument();
    expect(screen.queryByText(/wrong time/)).not.toBeInTheDocument();
  });

  it("passes all parameters on preview, locks adoption when config is altered, and enforces reviewed guards", async () => {
    const previewResponse = {
      preview: true,
      qc_overlay: "data:image/png;base64,fake",
      summary: { background_value_adu: 5.0 },
      warnings: [],
      nuclei_count: 10,
      reviewed_count: 10,
      count_mode: "algorithmic",
      saturation: { nuclei: 0, signal: 0, background: 0 },
      field_ratio: "150.0",
      integrated_signal_minus_background: 1500.0,
      raw_signal_sum: 2000.0,
      focus_mask_pixels: 100,
    };

    const execute = vi.fn(async (op: string) => {
      if (op === "channel_metadata") return channelMetadata;
      if (op === "source_annotations") return sourceAnnotations;
      if (op === "field_assay_preview") return previewResponse;
      if (op === "field_assay_run") return { adopted: true, result: dummyResult };
      return {};
    });

    const { onPublished } = renderFieldAssayPanel(execute);
    await screen.findByText(/original: Channel 1/);
    fireEvent.click(screen.getByText("Field assay"));

    // Preview field assay
    fireEvent.click(screen.getByText("Preview field assay"));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith(
        "field_assay_preview",
        expect.objectContaining({
          source_id: sourceId,
          nuclei_channel: 0,
          signal_channel: 1,
          segmentation_method: "manual",
          threshold_manual: 100,
          background_estimator: "median",
          exclude_boundary_nuclei: false,
          config: expect.objectContaining({
            nuclear_threshold: 100,
            segmentation_method: "manual",
            background_estimator: "median",
            min_nucleus_area_px: 10,
            max_nucleus_area_px: 5000,
            watershed_min_distance_px: 5,
          }),
        }),
      );
    });

    expect(await screen.findByText("Assay quantification preview")).toBeVisible();
    expect(screen.getByRole("img", { name: /Field assay QC overlay for Widefield source, T 0, Z 0/ })).toHaveAttribute(
      "src",
      previewResponse.qc_overlay,
    );

    // Check all review confirmations
    fireEvent.click(screen.getByLabelText("Confirm channel identity"));
    fireEvent.click(screen.getByLabelText("Confirm acquisition comparable"));
    fireEvent.click(screen.getByLabelText("Confirm focus reviewed"));
    fireEvent.click(screen.getByLabelText("Confirm nuclei reviewed"));
    fireEvent.click(screen.getByLabelText("Confirm background reviewed"));

    // Adopt button should be disabled because reviewer name is missing!
    expect(screen.getByText("Reviewer name is required for reviewed adoption.")).toBeVisible();
    const adoptButton = screen.getByText("Adopt reviewed field assay");
    expect(adoptButton).toBeDisabled();

    // Enter reviewer name
    fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Dr. Yingrou Tan" } });
    expect(adoptButton).not.toBeDisabled();

    // Now modify a parameter (e.g. threshold from 100 to 120)
    // Stale config locking should trigger!
    fireEvent.change(screen.getByLabelText("Manual threshold"), { target: { value: "120" } });

    expect(
      await screen.findByText(/Configuration changed since preview. Please click "Preview field assay" to update/),
    ).toBeVisible();
    expect(adoptButton).toBeDisabled();

    // Re-preview with new setting
    fireEvent.click(screen.getByText("Preview field assay"));
    await waitFor(() => expect(adoptButton).not.toBeDisabled());

    // Click adopt
    fireEvent.click(adoptButton);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith(
        "field_assay_run",
        expect.objectContaining({
          source_id: sourceId,
          endpoint_status: "reviewed",
          reviewer: "Dr. Yingrou Tan",
          channel_identity_confirmed: true,
          acquisition_comparable: true,
          focus_reviewed: true,
          nuclei_reviewed: true,
          background_reviewed: true,
          threshold_manual: 120,
          config: expect.objectContaining({
            endpoint_status: "reviewed",
            reviewer: "Dr. Yingrou Tan",
            nuclear_threshold: 120,
          }),
        }),
      );
      expect(onPublished).toHaveBeenCalledWith(dummyResult);
    });
  });
});
