// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BatchChannelColorsResponse,
  ResearchSource,
} from "../shared/research-contracts";
import { SourceDisplayPanel } from "./SourceDisplayPanel";

afterEach(cleanup);

const source: ResearchSource = {
  id: "a".repeat(32), sha256: "b".repeat(64), name: "Three-plane image.ims", source_kind: "native",
  metadata: { axes: "TCZYX", dimensions: { t: 1, c: 3, z: 1, y: 10121, x: 8998, s: 1 },
    levels: [{ index: 0, dimensions: { t: 1, c: 3, z: 1, y: 10121, x: 8998, s: 1 } }],
    channel_dtypes: ["uint8", "uint8", "uint8"], sample_semantics: "none",
    physical_calibration: { spacing: [1, 352.77739353818794, 352.7772838408535], unit: "um" } },
};
function mount(overrides: Partial<Parameters<typeof SourceDisplayPanel>[0]> = {}) {
  const onRgbMapping = vi.fn(), onInterpretation = vi.fn();
  const props = { source, selection: { t: 0, c: 0, z: 0, x: 0, y: 0, width: 512, height: 512, level: 0 },
    onSelection: vi.fn(), channels: [0, 1, 2].map((channel) => ({ channel, visible: true, color: "#ffffff", low: 0, high: 255, gamma: 1, opacity: 1 })),
    onChannels: vi.fn(), projection: "plane" as const, onProjection: vi.fn(), onAuto: vi.fn(), onReset: vi.fn(),
    onCompare: vi.fn(), interpretation: "auto" as const, onInterpretation, onRgbMapping, ...overrides };
  return { ...render(<SourceDisplayPanel {...props} />), onRgbMapping, onInterpretation, props };
}
describe("image information disclosure", () => {
  it("reads histograms only on request and does not resample when the analysis crop moves", async () => {
    const execute = vi.fn(async () => ({ source_id: source.id, source_sha256: source.sha256,
      sample: { kind: "deterministic-native-pyramid-level", t: 0, z: 0, level: 0, viewport_dependent: false, sample_count_per_component: 100, shape: [10, 10] },
      histograms: [{ component: 0, label: "Channel 1", units: "native scalar sample values", dtype: "uint8", sample_count: 100,
        min: 0, max: 255, bin_range: [0, 255], counts: [10, 80, 10], percentile_1: 0, percentile_99: 255 }] }));
    const view = mount({ api: { execute } });
    expect(execute).not.toHaveBeenCalled();
    const details = screen.getAllByText("Histogram & levels")[0].closest("details")!;
    details.open = true; fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByRole("img", { name: "Channel 1 histogram", hidden: true })).toBeTruthy());
    expect(execute).toHaveBeenCalledExactlyOnceWith("viewer_histogram", { source_id: source.id, t: 0, z: 0, bins: 256 });
    view.rerender(<SourceDisplayPanel {...view.props} selection={{ ...view.props.selection, x: 512 }} />);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("offers one RGB tone curve and validates window/level changes for medical scalars", () => {
    const rgbView = mount({ source: { ...source, metadata: { ...source.metadata, sample_semantics: "RGB" } } });
    fireEvent.change(screen.getByLabelText("RGB gamma"), { target: { value: "2" } });
    fireEvent.blur(screen.getByLabelText("RGB gamma"));
    expect(rgbView.props.onChannels).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ channel: 0, gamma: 2 })]));
    cleanup();
    const scalarView = mount({ interpretation: "medical" });
    const width = screen.getByLabelText("Channel 1 window");
    fireEvent.change(width, { target: { value: "100" } }); fireEvent.blur(width);
    expect(scalarView.props.onChannels).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ channel: 0, low: 77.5, high: 177.5 })]));
  });
  it("keeps an explicit close action and restores focus to its summary", () => {
    mount();
    const summary = screen.getByText("Image info", { exact: true });
    const details = summary.closest("details")!;
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close image information" }));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });
  it("closes with Escape from an inner setting without changing its source declaration", () => {
    const { onInterpretation, onRgbMapping } = mount();
    const summary = screen.getByText("Image info", { exact: true });
    fireEvent.click(summary);
    const select = screen.getByRole("combobox", { name: "Open as" });
    select.focus(); fireEvent.keyDown(select, { key: "Escape" });
    expect(summary.closest("details")!.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(onInterpretation).not.toHaveBeenCalled();
    expect(onRgbMapping).not.toHaveBeenCalled();
  });
  it("retains explicit RGB mapping and interpretation and closes when the source changes", () => {
    const view = mount();
    const summary = screen.getByText("Image info", { exact: true });
    fireEvent.click(summary);
    fireEvent.change(screen.getByRole("combobox", { name: "Open as" }), { target: { value: "histology" } });
    expect(view.onInterpretation).toHaveBeenCalledWith("histology");
    fireEvent.click(screen.getByRole("button", { name: "Apply RGB mapping" }));
    expect(view.onRgbMapping).toHaveBeenCalledWith([0, 1, 2]);
    view.rerender(<SourceDisplayPanel {...view.props} source={{ ...source, id: "c".repeat(32), name: "Next image.ims" }} />);
    expect(summary.closest("details")!.open).toBe(false);
  });
  it("keeps raw 3D available for a multichannel scalar volume", () => {
    const onTask = vi.fn();
    const scalarVolume: ResearchSource = {
      ...source,
      metadata: {
        ...source.metadata,
        dimensions: { ...source.metadata.dimensions!, c: 6, z: 4 },
        levels: [{ index: 0, dimensions: { ...source.metadata.dimensions!, c: 6, z: 4 } }],
        channel_dtypes: Array(6).fill("uint16"),
      },
    };
    mount({ source: scalarVolume, interpretation: "volume", onTask });
    fireEvent.click(screen.getByText("Image info", { exact: true }));
    expect((screen.getByRole("option", { name: "Volume" }) as HTMLOptionElement).disabled).toBe(false);
    const explore = screen.getByRole("button", { name: "Explore in 3D" }) as HTMLButtonElement;
    expect(explore.disabled).toBe(false);
    fireEvent.click(explore);
    expect(onTask).toHaveBeenCalledWith("volume");
  });
  it("explains why interleaved RGB samples cannot open as raw 3D", () => {
    const rgbVolume: ResearchSource = {
      ...source,
      metadata: {
        ...source.metadata,
        dimensions: { ...source.metadata.dimensions!, c: 1, z: 4, s: 3 },
        levels: [{ index: 0, dimensions: { ...source.metadata.dimensions!, c: 1, z: 4, s: 3 } }],
        channel_dtypes: ["uint8"],
        sample_semantics: "RGB",
      },
    };
    mount({ source: rgbVolume, interpretation: "volume", onTask: vi.fn() });
    fireEvent.click(screen.getByText("Image info", { exact: true }));
    expect((screen.getByRole("option", { name: "Volume" }) as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Explore in 3D" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/Interleaved RGB or RGBA samples/)).toHaveLength(2);
  });
  it("explains why sheared medical geometry cannot open as raw 3D", () => {
    const sheared: ResearchSource = {
      id: "c".repeat(32), sha256: "d".repeat(64), name: "Sheared volume.nii", source_kind: "medical",
      metadata: { axes: "ZYX", shape: [4, 48, 64],
        geometry: { axes: "ZYX", affine: [[1, 0.2, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], unit: "mm", frame: "RAS" } },
    };
    mount({ source: sheared, interpretation: "medical", onTask: vi.fn() });
    fireEvent.click(screen.getByText("Image info", { exact: true }));
    expect((screen.getByRole("option", { name: "Volume" }) as HTMLOptionElement).disabled).toBe(true);
    const explore = screen.getByRole("button", { name: "Explore in 3D" }) as HTMLButtonElement;
    expect(explore.disabled).toBe(true);
    expect(explore.getAttribute("title")).toMatch(/sheared voxel geometry/);
  });
});

describe("batch channel colors (Milestone 5A)", () => {
  const otherSource: ResearchSource = {
    id: "d".repeat(32), sha256: "e".repeat(64), name: "Sample 2.ims", source_kind: "native",
    metadata: { axes: "TCZYX", dimensions: { t: 1, c: 3, z: 1, y: 100, x: 100, s: 1 },
      channel_dtypes: ["uint16", "uint16", "uint16"], sample_semantics: "none" },
  };

  it("opens batch channel colors dialog, previews changes, applies palette, and supports undo", async () => {
    const execute = vi.fn(async (op: string, req: Record<string, unknown>) => {
      if (op === "batch_channel_colors") {
        if (req.preview_only === true) {
          if (req.mapping_mode === "restore") {
            const response: BatchChannelColorsResponse = {
              preview_only: true,
              total_sources: 1,
              applicable_count: 1,
              affected_sources: [{
                source_id: source.id,
                source_name: source.name,
                revision: 2,
                status: "ready",
                reason: null,
                changes: [{ channel: 0, channel_name: "Ch 1", old_color: "#0000ff", new_color: "#ffffff" }],
              }],
              applied_count: 0,
              skipped_count: 0,
              previous_palettes: { [source.id]: [{ channel: 0, color: "#0000ff" }] },
              new_revisions: { [source.id]: 2 },
            };
            return response;
          }
          const response: BatchChannelColorsResponse = {
            preview_only: true,
            total_sources: 2,
            applicable_count: 1,
            affected_sources: [
              {
                source_id: source.id,
                source_name: source.name,
                revision: 1,
                status: "ready",
                reason: null,
                changes: [{ channel: 0, channel_name: "Ch 1", old_color: "#ffffff", new_color: "#0000ff" }],
              },
              {
                source_id: otherSource.id,
                source_name: otherSource.name,
                revision: 1,
                status: "skipped",
                reason: "Channel count mismatch",
                changes: [],
              },
            ],
            applied_count: 0,
            skipped_count: 1,
            previous_palettes: { [source.id]: [{ channel: 0, color: "#ffffff" }] },
            new_revisions: { [source.id]: 1, [otherSource.id]: 1 },
          };
          return response;
        } else if (req.mapping_mode === "restore") {
          const response: BatchChannelColorsResponse = {
            preview_only: false,
            total_sources: 2,
            applicable_count: 1,
            affected_sources: [
              {
                source_id: source.id,
                source_name: source.name,
                revision: 3,
                status: "applied",
                reason: null,
                changes: [{ channel: 0, channel_name: "Ch 1", old_color: "#0000ff", new_color: "#ffffff" }],
              },
            ],
            applied_count: 1,
            skipped_count: 0,
            previous_palettes: { [source.id]: [{ channel: 0, color: "#0000ff" }] },
            new_revisions: { [source.id]: 3 },
          };
          return response;
        } else {
          const response: BatchChannelColorsResponse = {
            preview_only: false,
            total_sources: 1,
            applicable_count: 1,
            affected_sources: [
              {
                source_id: source.id,
                source_name: source.name,
                revision: 2,
                status: "applied",
                reason: null,
                changes: [{ channel: 0, channel_name: "Ch 1", old_color: "#ffffff", new_color: "#0000ff" }],
              },
              {
                source_id: otherSource.id,
                source_name: otherSource.name,
                revision: 1,
                status: "skipped",
                reason: "Channel count mismatch",
                changes: [],
              },
            ],
            applied_count: 1,
            skipped_count: 1,
            previous_palettes: { [source.id]: [{ channel: 0, color: "#ffffff" }] },
            new_revisions: { [source.id]: 2, [otherSource.id]: 1 },
          };
          return response;
        }
      }
      return {};
    });

    const onChannels = vi.fn();
    const onBeforeBatch = vi.fn(async () => {});
    const onBatchApplied = vi.fn();
    mount({
      sources: [source, otherSource],
      selectedSourceIds: [source.id, otherSource.id],
      api: { execute },
      onChannels,
      onBeforeBatch,
      onBatchApplied,
    });

    // "Apply colors" button is visible in channel heading without trailing ellipsis
    const applyColorsBtn = screen.getByRole("button", { name: "Apply colors (2)" });
    expect(applyColorsBtn).toBeTruthy();

    // Open dialog
    fireEvent.click(applyColorsBtn);
    expect(await screen.findByText("Apply channel colours")).toBeTruthy();

    // Verify scope badge
    expect(screen.getByText("2 selected")).toBeTruthy();

    // Click "Preview"
    const previewBtn = screen.getByRole("button", { name: "Preview" });
    fireEvent.click(previewBtn);

    await waitFor(() => expect(screen.getByText("Status")).toBeTruthy());
    expect(execute).toHaveBeenCalledWith("batch_channel_colors", expect.objectContaining({
      preview_only: true,
      mapping_mode: "auto",
    }));

    // Verify table shows READY and SKIPPED
    expect(screen.getByText("READY")).toBeTruthy();
    expect(screen.getByText("SKIPPED")).toBeTruthy();
    expect(screen.getByText("Channel count mismatch")).toBeTruthy();

    // Click "Apply colors"
    const applyBtn = screen.getByRole("button", { name: /Apply colour to all 2 images/ });
    fireEvent.click(applyBtn);

    await waitFor(() => expect(screen.getByText(/Applied channel colors to 1 image/)).toBeTruthy());
    expect(onBatchApplied).toHaveBeenCalledWith(expect.objectContaining({ new_revisions: {
      [source.id]: 2,
      [otherSource.id]: 1,
    } }), expect.arrayContaining([expect.objectContaining({ channel: 0, color: "#0000ff" })]));
    expect(execute).toHaveBeenCalledWith("batch_channel_colors", expect.objectContaining({
      preview_only: false,
      expected_revisions: { [source.id]: 1, [otherSource.id]: 1 },
    }));
    expect(onChannels).not.toHaveBeenCalled();

    // Close dialog
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    // "Undo colors" button is now visible
    const undoBtn = screen.getByRole("button", { name: "Undo colors" });
    expect(undoBtn).toBeTruthy();

    // Click Undo
    fireEvent.click(undoBtn);
    await waitFor(() => expect(screen.getByText(/Restored previous colors for 1 image/)).toBeTruthy());
    expect(execute).toHaveBeenCalledWith("batch_channel_colors", expect.objectContaining({
      mapping_mode: "restore",
      preview_only: true,
      expected_revisions: { [source.id]: 2 },
    }));
    expect(execute).toHaveBeenCalledWith("batch_channel_colors", expect.objectContaining({
      mapping_mode: "restore",
      preview_only: false,
      expected_revisions: { [source.id]: 2 },
    }));
    expect(onBeforeBatch).toHaveBeenCalledTimes(4);
  });
});
