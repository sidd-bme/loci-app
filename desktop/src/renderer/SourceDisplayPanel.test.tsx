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
  it("selects logical RGB channels and edits the selected tone without recoloring the lookup table", async () => {
    const rgb: ResearchSource = { ...source, metadata: { ...source.metadata, sample_semantics: "RGB",
      dimensions: { ...source.metadata.dimensions!, c: 2, z: 3, s: 3 }, channel_dtypes: ["uint16", "uint16"],
      palette: { stored_index_dtype: "uint8", lookup_dtype: "uint16", lookup_policy: "actual-IFD-ColorMap", expansion: "exact-RGB-lookup-no-normalization" } } };
    const execute = vi.fn(async (_operation: string, request: Record<string, unknown>) => ({
      source_id: source.id, source_sha256: source.sha256,
      sample: { kind: "deterministic-native-pyramid-level", t: 0, z: 0, c: request.c, level: 0,
        viewport_dependent: false, sample_count_per_component: 100, shape: [10, 10] },
      histograms: [0, 1, 2].map((component) => ({ component, label: ["Red", "Green", "Blue"][component],
        units: "palette lookup RGB component values", dtype: "uint16", sample_count: 100,
        min: 0, max: 65280, bin_range: [0, 65535], counts: [10, 80, 10], percentile_1: 0, percentile_99: 65280 })),
    }));
    const view = mount({ source: rgb, api: { execute },
      channels: [{ channel: 1, low: 0, high: 65535, gamma: 1, color: "#ffffff", opacity: 1, visible: true }],
      selection: { t: 0, c: 1, z: 0, x: 0, y: 0, width: 32, height: 32, level: 0 } });
    expect((screen.getByLabelText("Image channel") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByRole("option", { name: "Maximum projection" }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("RGB white point"), { target: { value: "60000" } });
    fireEvent.blur(screen.getByLabelText("RGB white point"));
    expect(view.props.onChannels).toHaveBeenLastCalledWith([expect.objectContaining({ channel: 1, high: 60000 })]);
    const details = screen.getByText("Histogram & levels").closest("details")!;
    details.open = true; fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByRole("img", { name: "RGB tone histogram", hidden: true })).toBeTruthy());
    expect(execute).toHaveBeenCalledWith("viewer_histogram", { source_id: source.id, t: 0, z: 0, c: 1, bins: 256 });
    expect(screen.getByText(/Palette lookup RGB values/).textContent).toContain("C 2");
    fireEvent.change(screen.getByLabelText("Image channel"), { target: { value: "0" } });
    expect(view.props.onSelection).toHaveBeenLastCalledWith({ ...view.props.selection, c: 0 });
  });
  it.each(["", "1.5", "0", "9000"])("rejects invalid analysis width draft %j without changing selection", (draft) => {
    const view = mount();
    fireEvent.click(screen.getByText("Analysis region", { exact: true }));
    const input = screen.getByLabelText("Width");
    fireEvent.change(input, { target: { value: draft } });
    expect(view.props.onSelection).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(view.props.onSelection).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("512");
  });
  it("commits an integer analysis region and discards typed text when source identity changes", () => {
    const view = mount();
    const input = screen.getByLabelText("Width") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1024" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(view.props.onSelection).toHaveBeenCalledExactlyOnceWith({ ...view.props.selection, width: 1024 });
    fireEvent.change(input, { target: { value: "unfinished" } });
    view.rerender(<SourceDisplayPanel {...view.props} source={{ ...source, sha256: "c".repeat(64) }} />);
    expect((screen.getByLabelText("Width") as HTMLInputElement).value).toBe("512");
  });
  it("rejects crop offsets outside the remaining source extent", () => {
    const view = mount({ selection: { t: 0, c: 0, z: 0, x: 8800, y: 0, width: 198, height: 512, level: 0 } });
    const input = screen.getByLabelText("X");
    fireEvent.change(input, { target: { value: "8801" } });
    fireEvent.blur(input);
    expect(view.props.onSelection).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
  it("publishes a numeric draft once on Enter or changed blur without rounding", () => {
    const view = mount();
    fireEvent.click(screen.getByText("Image info", { exact: true }));
    const gamma = screen.getByLabelText("Channel 1 gamma") as HTMLInputElement;
    gamma.closest("details")!.open = true;
    gamma.focus();
    fireEvent.change(gamma, { target: { value: "1.23456789012345" } });
    expect(view.props.onChannels).not.toHaveBeenCalled();
    fireEvent.keyDown(gamma, { key: "Enter" });
    expect(view.props.onChannels).toHaveBeenCalledTimes(1);
    expect(view.props.onChannels).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ channel: 0, gamma: 1.23456789012345 }),
    ]));
    fireEvent.blur(gamma);
    expect(view.props.onChannels).toHaveBeenCalledTimes(1);
    fireEvent.change(gamma, { target: { value: "2.5" } });
    fireEvent.blur(gamma);
    fireEvent.blur(gamma);
    expect(view.props.onChannels).toHaveBeenCalledTimes(2);
    expect(view.props.onChannels).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ channel: 0, gamma: 2.5 }),
    ]));
  });

  it.each(["", " ", "NaN", "Infinity", "not a number", "0.05", "11"])(
    "rejects invalid gamma draft %j and restores the applied value with Escape",
    (draft) => {
      const view = mount();
      fireEvent.click(screen.getByText("Image info", { exact: true }));
      const gamma = screen.getByLabelText("Channel 1 gamma") as HTMLInputElement;
      gamma.closest("details")!.open = true;
      gamma.focus();
      fireEvent.change(gamma, { target: { value: draft } });
      fireEvent.keyDown(gamma, { key: "Enter" });
      expect(view.props.onChannels).not.toHaveBeenCalled();
      expect(gamma.getAttribute("aria-invalid")).toBe("true");
      expect(gamma.title).toBe("Enter a finite value from 0.1 to 10.");
      expect(screen.getByRole("alert").textContent).toBe(gamma.title);
      gamma.focus();
      fireEvent.keyDown(gamma, { key: "Escape" });
      expect(gamma.value).toBe("1");
      expect(gamma.getAttribute("aria-invalid")).toBe("false");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("Image info", { exact: true }).closest("details")!.open).toBe(true);
      fireEvent.blur(gamma);
      expect(view.props.onChannels).not.toHaveBeenCalled();
    },
  );

  it("restores the last applied value and synchronizes external values and source identity", () => {
    const view = mount();
    fireEvent.click(screen.getByText("Image info", { exact: true }));
    let gamma = screen.getByLabelText("Channel 1 gamma") as HTMLInputElement;
    fireEvent.change(gamma, { target: { value: "2" } });
    fireEvent.blur(gamma);
    fireEvent.change(gamma, { target: { value: "bad" } });
    fireEvent.blur(gamma);
    fireEvent.keyDown(gamma, { key: "Escape" });
    expect(gamma.value).toBe("2");
    expect(view.props.onChannels).toHaveBeenCalledTimes(1);

    fireEvent.change(gamma, { target: { value: "bad" } });
    fireEvent.blur(gamma);
    const channels = view.props.channels.map((channel) => ({ ...channel, gamma: 3 }));
    view.rerender(<SourceDisplayPanel {...view.props} channels={channels} />);
    expect(gamma.value).toBe("3");
    expect(gamma.getAttribute("aria-invalid")).toBe("false");

    fireEvent.change(gamma, { target: { value: "9" } });
    const nextSource = { ...source, id: "c".repeat(32) };
    view.rerender(<SourceDisplayPanel {...view.props} channels={channels} source={nextSource} />);
    gamma = screen.getByLabelText("Channel 1 gamma") as HTMLInputElement;
    expect(gamma.value).toBe("3");
    fireEvent.change(gamma, { target: { value: "8" } });
    view.rerender(<SourceDisplayPanel {...view.props} channels={channels} source={{ ...nextSource, sha256: "d".repeat(64) }} />);
    gamma = screen.getByLabelText("Channel 1 gamma") as HTMLInputElement;
    expect(gamma.value).toBe("3");
    fireEvent.blur(gamma);
    expect(view.props.onChannels).toHaveBeenCalledTimes(1);
  });

  it("rejects unordered limits with the corresponding reason", () => {
    const view = mount();
    fireEvent.click(screen.getByText("Image info", { exact: true }));
    const low = screen.getByLabelText("Channel 1 low") as HTMLInputElement;
    fireEvent.change(low, { target: { value: "255" } });
    fireEvent.blur(low);
    expect(low.title).toBe("Low must be below high.");
    fireEvent.keyDown(low, { key: "Escape" });
    const high = screen.getByLabelText("Channel 1 high") as HTMLInputElement;
    fireEvent.change(high, { target: { value: "0" } });
    fireEvent.blur(high);
    expect(high.title).toBe("High must be above low.");
    expect(view.props.onChannels).not.toHaveBeenCalled();
  });

  it("shows the opacity value in the slider's 0–1 units as controlled channels update", () => {
    const view = mount();
    fireEvent.click(screen.getByText("Image info", { exact: true }));
    expect(screen.getByLabelText("Channel 1 opacity value").textContent).toBe("1");
    fireEvent.change(screen.getByRole("slider", { name: "Channel 1 opacity" }), { target: { value: "0.42" } });
    const updated = vi.mocked(view.props.onChannels).mock.lastCall![0];
    expect(updated[0].opacity).toBe(0.42);
    view.rerender(<SourceDisplayPanel {...view.props} channels={updated} />);
    expect(screen.getByLabelText("Channel 1 opacity value").textContent).toBe("0.42");
  });

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

    // "Copy colours to images…" button is visible in channel heading without trailing ellipsis
    const applyColorsBtn = screen.getByRole("button", { name: "Copy colours to images… (2)" });
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

    // Click "Copy colours to images…"
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
