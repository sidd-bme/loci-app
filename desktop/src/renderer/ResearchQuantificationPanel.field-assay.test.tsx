// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  original_names: ["Channel 1 (DAPI)", "Channel 2 (Signal)"],
  revision: 1,
  channels: [
    { index: 0, name: "DAPI", marker: "nuclei", fluorophore: "DAPI", declaration: "metadata" },
    { index: 1, name: "Signal", marker: "receptor", fluorophore: "TRITC", declaration: "metadata" },
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
  const props = {
    api: createApi(executeMock), snapshot, source: snapshot.sources[0], selection,
    recipe, setRecipe: vi.fn(), report: async <T,>(work: () => Promise<T>) => work(), busy: false,
    onBusyChange: vi.fn(), onPreview, onPublished,
  };
  const utils = render(<ResearchQuantificationPanel {...props} />);
  return { ...utils, onPublished, onPreview, props };
}

describe("ResearchQuantificationPanel - Field Assay Tab", () => {
  it("uses per-source ROI and count-mark ordinals while preserving exact annotation bindings", async () => {
    const annotations = [
      { id: "c".repeat(32), label: "focus", kind: "polygon", z: 0, t: 0 },
      { id: "d".repeat(32), label: "focus", kind: "rectangle", z: 0, t: 0 },
      { id: "e".repeat(32), label: "", kind: "rectangle", z: 0, t: 0 },
      { id: "f".repeat(32), label: "", kind: "point", z: 0, t: 0, points: [{ x: 2, y: 3 }] },
    ];
    const execute = vi.fn(async (op: string) => op === "channel_metadata" ? channelMetadata :
      op === "source_annotations" ? { ...sourceAnnotations, annotations } :
      op === "field_assay_preview" ? { preview: true, qc_overlay: "current-qc" } : {});
    renderFieldAssayPanel(execute);
    await screen.findByText(/original: Channel 1/);
    fireEvent.click(screen.getByText("Field assay", { exact: true }));
    const focus = screen.getByLabelText("Focus region selection");
    expect(within(focus).getByRole("option", { name: "ROI: focus · ROI 1 · T 0, Z 0" })).toHaveValue(annotations[0].id);
    expect(within(focus).getByRole("option", { name: "ROI: focus · ROI 2 · T 0, Z 0" })).toHaveValue(annotations[1].id);
    expect(within(focus).getByRole("option", { name: "ROI: Region 3 · T 0, Z 0" })).toHaveValue(annotations[2].id);
    expect(focus).not.toHaveTextContent(annotations[2].id.slice(0, 8));
    fireEvent.change(focus, { target: { value: annotations[2].id } });
    fireEvent.change(screen.getByLabelText("Background mode selection"), { target: { value: "value" } });
    fireEvent.change(screen.getByLabelText("Background ADU value"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Count mode"), { target: { value: "points" } });
    const points = screen.getByLabelText("Manual points annotation");
    expect(within(points).getByRole("option", { name: "Marks: Count marks 4 (1 point)" })).toHaveValue(annotations[3].id);
    fireEvent.change(points, { target: { value: annotations[3].id } });
    fireEvent.click(screen.getByRole("button", { name: "Preview field assay" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("field_assay_preview", expect.objectContaining({
      focus_annotation_id: annotations[2].id, manual_points_annotation_id: annotations[3].id,
      source_id: sourceId, z: 0, t: 0,
    })));
  });

  it("formats signed fractional measurements without changing their values and shows the empty zero-count ratio", async () => {
    const signed = -123.456789012345;
    const ratio = signed / 3;
    const execute = vi.fn(async (op: string, request: Record<string, unknown>) => {
      if (op === "channel_metadata") return channelMetadata;
      if (op === "source_annotations") return sourceAnnotations;
      if (op === "field_assay_preview") return { preview: true, qc_overlay: "current-qc",
        summary: { background_value_adu: 112.3456789012345, integrated_signal_minus_background_adu: signed },
        warnings: [], reviewed_count: Number(request.manual_count), count_mode: "manual_override",
        raw_signal_sum: 1000, focus_mask_pixels: 10, integrated_signal_minus_background: signed,
        field_ratio: request.manual_count === 0 ? "" : ratio };
      return {};
    });
    const view = renderFieldAssayPanel(execute);
    await screen.findByText(/original: Channel 1/);
    fireEvent.click(screen.getByText("Field assay", { exact: true }));
    fireEvent.change(screen.getByLabelText("Count mode"), { target: { value: "override" } });
    fireEvent.change(screen.getByLabelText("Manual count override value"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview field assay" }));
    expect(await screen.findByText("-123.457")).toHaveAttribute("data-exact-value", String(signed));
    expect(screen.getByText("-41.1523")).toHaveAttribute("data-exact-value", String(ratio));
    expect(screen.getByText(String(signed))).not.toBeVisible();
    expect(screen.getByText("3 (manual count)")).toBeVisible();
    expect(view.onPublished).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Manual count override value"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview field assay" }));
    expect(await screen.findByText("Undefined (0 nuclei)")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save exploratory" })).toBeEnabled();
    expect(view.onPublished).not.toHaveBeenCalled();
    expect(execute).toHaveBeenLastCalledWith("field_assay_preview", expect.objectContaining({ manual_count: 0 }));
  });

  it.each(["configuration", "plane", "source", "unmount"])(
    "does not publish a deferred preview after a %s change",
    async (change) => {
      let resolvePreview!: (value: Record<string, unknown>) => void;
      const pending = new Promise<Record<string, unknown>>((resolve) => { resolvePreview = resolve; });
      const execute = vi.fn(async (op: string, request: Record<string, unknown>) => {
        if (op === "channel_metadata") return { ...channelMetadata, source_id: request.source_id,
          source_sha256: request.source_id === sourceId ? sourceSha : "d".repeat(64) };
        if (op === "source_annotations") return { ...sourceAnnotations, source_id: request.source_id,
          source_sha256: request.source_id === sourceId ? sourceSha : "d".repeat(64) };
        if (op === "field_assay_preview") return pending;
        return {};
      });
      const view = renderFieldAssayPanel(execute);
      await screen.findByText(/original: Channel 1/);
      fireEvent.click(screen.getByText("Field assay"));
      await waitFor(() => expect(screen.getByRole("button", { name: "Preview field assay" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Preview field assay" }));
      await waitFor(() => expect(execute).toHaveBeenCalledWith("field_assay_preview", expect.anything()));
      if (change === "configuration")
        fireEvent.change(screen.getByLabelText("Manual threshold"), { target: { value: "120" } });
      else if (change === "plane")
        view.rerender(<ResearchQuantificationPanel {...view.props} selection={{ ...selection, z: 1 }} />);
      else if (change === "source")
        view.rerender(<ResearchQuantificationPanel {...view.props} source={{ ...snapshot.sources[0],
          id: "c".repeat(32), sha256: "d".repeat(64) }} />);
      else view.unmount();
      await act(async () => { resolvePreview({ preview: true, qc_overlay: "old-qc", overlay: "old-image", measurements: [{ area: 12 }] }); });
      expect(view.onPreview).not.toHaveBeenCalled();
      expect(view.onPublished).not.toHaveBeenCalled();
      expect(screen.queryByText("Assay quantification preview")).not.toBeInTheDocument();
    },
  );

  it("requires a fresh preview after saving changed channel identity declarations", async () => {
    const preview = { preview: true, qc_overlay: "current-qc", overlay: "current-image", measurements: [{ area: 12 }] };
    const execute = vi.fn(async (op: string, request: Record<string, unknown>) => {
      if (op === "channel_metadata") return channelMetadata;
      if (op === "source_annotations") return sourceAnnotations;
      if (op === "field_assay_preview") return preview;
      if (op === "channels") return { ...channelMetadata, revision: 2, channels: request.channels };
      if (op === "field_assay_run") return { adopted: true, result: dummyResult };
      return {};
    });
    const view = renderFieldAssayPanel(execute);
    await screen.findByText(/original: Channel 1/);
    fireEvent.click(screen.getByText("Field assay"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview field assay" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Preview field assay" }));
    await screen.findByText("Assay quantification preview");
    expect(view.onPreview).toHaveBeenCalledExactlyOnceWith(preview.overlay, preview.measurements);
    fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Dr Reviewer" } });
    expect(screen.getByRole("button", { name: "Approve & save" })).toBeEnabled();
    fireEvent.click(screen.getByText("Channels", { exact: true }));
    fireEvent.change(screen.getByLabelText("Channel 2 marker"), { target: { value: "corrected receptor identity" } });
    fireEvent.click(screen.getByRole("button", { name: "Save declarations at revision 1" }));
    await screen.findByRole("button", { name: "Save declarations at revision 2" });
    fireEvent.click(screen.getByText("Field assay"));
    expect(screen.getByText("Settings changed. Preview again before saving.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve & save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save exploratory" })).toBeDisabled();
    expect(execute.mock.calls.filter(([op]) => op === "field_assay_run")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Preview field assay" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve & save" })).toBeEnabled());
    expect(view.onPreview).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Approve & save" }));
    await waitFor(() => expect(view.onPublished).toHaveBeenCalledWith(dummyResult));
    expect(execute).toHaveBeenLastCalledWith("field_assay_run", expect.objectContaining({
      endpoint_status: "reviewed", reviewer: "Dr Reviewer", channel_identity_confirmed: true,
    }));
  });

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
    expect(screen.getByLabelText("Field assay readiness")).toHaveAttribute("data-source-sha256", secondSource.sha256);
    expect(screen.getByLabelText("Field assay readiness")).not.toHaveTextContent(secondSource.sha256.slice(0, 12));
    expect(screen.getByLabelText("Focus region selection").querySelectorAll("option")).toHaveLength(2);
    expect(screen.queryByText(/ROI: focus/)).not.toBeInTheDocument();
  });

  it("defaults to annotation mode for focus and background, explains how to approve whole-field or zero-background inputs", async () => {
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
    expect(screen.getByText("Choose a focus ROI to approve this assay.")).toBeVisible();

    // Select background mode: switch to explicit value of 0
    const bgModeSelect = screen.getByLabelText("Background mode selection");
    fireEvent.change(bgModeSelect, { target: { value: "value" } });
    expect(screen.getByText("Measure background before approving this assay.")).toBeVisible();
  });

  it("explains the automatic-threshold approval requirement until a manual count is supplied", async () => {
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
      screen.getByText("Approval needs a fixed threshold or manual count."),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Count mode"), { target: { value: "override" } });
    expect(screen.queryByText("Approval needs a fixed threshold or manual count.")).not.toBeInTheDocument();
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

    // Approval is a deliberate action, with no persistent acknowledgement state.
    expect(screen.queryByLabelText("Confirm channel identity")).not.toBeInTheDocument();
    expect(screen.getByText("Enter a reviewer name to approve.")).toBeVisible();
    const adoptButton = screen.getByRole("button", { name: "Approve & save" });
    expect(adoptButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save exploratory" })).toBeEnabled();

    // Enter reviewer name
    fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Dr. Yingrou Tan" } });
    expect(adoptButton).not.toBeDisabled();

    // Now modify a parameter (e.g. threshold from 100 to 120)
    // Stale config locking should trigger!
    fireEvent.change(screen.getByLabelText("Manual threshold"), { target: { value: "120" } });

    expect(
      await screen.findByText(/Settings changed. Preview again before saving./),
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

    // Saving a later exploratory result cannot reuse a previous approval.
    fireEvent.click(screen.getByRole("button", { name: "Save exploratory" }));
    await waitFor(() => expect(execute).toHaveBeenLastCalledWith(
      "field_assay_run", expect.objectContaining({
        endpoint_status: "exploratory", channel_identity_confirmed: false,
        acquisition_comparable: false, focus_reviewed: false,
        nuclei_reviewed: false, background_reviewed: false, saturation_reviewed: false,
        config: expect.objectContaining({ endpoint_status: "exploratory", focus_reviewed: false }),
      }),
    ));
  });
});
