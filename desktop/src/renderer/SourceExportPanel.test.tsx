// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchSelection,
  ResearchSource,
} from "../shared/research-contracts";
import type { ViewerChannel } from "./ImageViewport";
import { SourceExportPanel } from "./SourceExportPanel";

afterEach(cleanup);

const sources: ResearchSource[] = ["a", "c"].map((value, index) => ({
  id: value.repeat(32),
  name: `Source ${index + 1}`,
  sha256: String(index + 1).repeat(64),
  metadata: { dimensions: { t: 2, c: 2, z: 5, y: 400, x: 600 } },
}));
const selection: ResearchSelection = {
  x: 10,
  y: 20,
  width: 200,
  height: 160,
  t: 1,
  c: 1,
  z: 2,
  z_stop: 5,
  level: 0,
};
const channels: ViewerChannel[] = [
  { channel: 0, low: 10, high: 1000, gamma: 1, visible: true, color: "#ffffff" },
  { channel: 1, low: 20, high: 800, gamma: 1.2, visible: true, color: "#ff00ff" },
];

function bridge(exportSourceView: NonNullable<ResearchDesktopApi["exportSourceView"]>): ResearchDesktopApi {
  return {
    createStudy: vi.fn(),
    openStudy: vi.fn(),
    getSnapshot: vi.fn(),
    addSources: vi.fn(),
    execute: vi.fn(),
    reviewResult: vi.fn(),
    exportResult: vi.fn(),
    cancelJob: vi.fn(),
    exportSourceView,
  };
}

function panel(
  api: ResearchDesktopApi,
  source = sources[0],
  onError = vi.fn(),
) {
  return <SourceExportPanel
    api={api}
    source={source}
    selection={selection}
    channels={channels}
    projection="max"
    onError={onError}
  />;
}

describe("SourceExportPanel", () => {
  it("describes a rendered PNG exactly, binds the display request, and treats cancellation as no export", async () => {
    const exportSourceView = vi.fn().mockResolvedValue(null);
    const onError = vi.fn();
    render(panel(bridge(exportSourceView), sources[0], onError));
    fireEvent.click(screen.getByText("Export rendered image"));

    expect(screen.getByText(
      "Display RGB with the current channel settings and embedded rendering provenance. No annotations or original-value measurements.",
    )).toBeVisible();
    const button = screen.getByRole("button", { name: "Export PNG…" });
    fireEvent.click(button);
    await waitFor(() => expect(exportSourceView).toHaveBeenCalledWith({
      source_id: sources[0].id,
      source_sha256: sources[0].sha256,
      format: "png",
      view: {
        source_id: sources[0].id,
        overview: true,
        max_edge: 1024,
        t: selection.t,
        z: selection.z,
        c: selection.c,
        channels,
        figure: {
          dpi: 300,
          scale_bar: false,
          channel_legend: false,
          channel_labels: [],
        },
        projection: "max",
        z_stop: selection.z_stop,
      },
    }));
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveTextContent("Export PNG…");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
  });

  it("requests a full-resolution TIFF16 for the whole selected source plane", async () => {
    const exportSourceView = vi.fn().mockResolvedValue({
      basename: "rendered-source.tiff",
      sha256: "d".repeat(64),
      width: 600,
      height: 400,
      sampling: "full-resolution source plane",
      format: "tiff",
      dtype: "uint16",
      channels: 3,
    });
    render(panel(bridge(exportSourceView)));
    fireEvent.click(screen.getByText("Export rendered image"));
    fireEvent.change(screen.getByLabelText("Rendered export format"), {
      target: { value: "tiff" },
    });

    expect(screen.getByLabelText("Rendered export extent")).toHaveValue("whole");
    expect(screen.getByText(/16-bit display RGB from the selected source plane/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Export TIFF16…" }));

    await waitFor(() => expect(exportSourceView).toHaveBeenCalledWith({
      source_id: sources[0].id,
      source_sha256: sources[0].sha256,
      format: "tiff",
      view: {
        source_id: sources[0].id,
        selection: {
          x: 0,
          y: 0,
          width: 600,
          height: 400,
          t: selection.t,
          c: selection.c,
          z: selection.z,
          z_stop: selection.z_stop,
          level: 0,
        },
        channels,
        figure: {
          dpi: 300,
          scale_bar: false,
          channel_legend: false,
          channel_labels: [],
        },
        projection: "max",
      },
    }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved 600 × 400 · rendered-source.tiff",
    );
  });

  it("drops a completed PNG receipt after a source switch and binds the next export to the new source", async () => {
    type ExportReceipt = {
      basename: string;
      sha256: string;
      width: number;
      height: number;
      sampling: string;
    };
    let resolveFirst!: (value: ExportReceipt | null) => void;
    const exportSourceView = vi.fn((request: Record<string, unknown>) => {
      if (request.source_id === sources[0].id) {
        return new Promise<ExportReceipt | null>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        basename: "current-source.png",
        sha256: "e".repeat(64),
        width: 600,
        height: 400,
        sampling: "overview",
      });
    });
    const api = bridge(exportSourceView);
    const onError = vi.fn();
    const view = render(panel(api, sources[0], onError));
    fireEvent.click(screen.getByText("Export rendered image"));
    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));
    await waitFor(() => expect(exportSourceView).toHaveBeenCalledOnce());

    view.rerender(panel(api, sources[1], onError));
    await act(async () => {
      resolveFirst({
        basename: "stale-source.png",
        sha256: "f".repeat(64),
        width: 600,
        height: 400,
        sampling: "overview",
      });
      await Promise.resolve();
    });
    expect(screen.queryByText(/stale-source\.png/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved 600 × 400 · current-source.png",
    );
    expect(exportSourceView).toHaveBeenLastCalledWith(expect.objectContaining({
      source_id: sources[1].id,
      source_sha256: sources[1].sha256,
      view: expect.objectContaining({ source_id: sources[1].id }),
    }));
    expect(onError).not.toHaveBeenCalled();
  });

  it("binds DPI, a calibrated scale bar, and editable visible-channel legend entries", async () => {
    const calibrated: ResearchSource = {
      ...sources[0],
      metadata: {
        ...sources[0].metadata,
        sample_semantics: "none",
        channel_names: ["DAPI", "Reporter"],
        physical_calibration: { unit: "µm", spacing: [0.75, 0.5] },
      },
    };
    const exportSourceView = vi.fn().mockResolvedValue(null);
    render(<SourceExportPanel
      api={bridge(exportSourceView)} source={calibrated} selection={selection}
      channels={channels} projection="max" onError={vi.fn()} defaultDpi={600}
    />);
    fireEvent.click(screen.getByText("Export rendered image"));

    expect(screen.getByLabelText("Rendered export DPI")).toHaveValue(600);
    fireEvent.click(screen.getByLabelText("Include calibrated scale bar"));
    fireEvent.click(screen.getByLabelText("Include channel legend"));
    fireEvent.change(screen.getByLabelText("Channel 2 legend label"), {
      target: { value: "Membrane reporter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));

    await waitFor(() => expect(exportSourceView).toHaveBeenCalledWith(expect.objectContaining({
      view: expect.objectContaining({
        figure: {
          dpi: 600,
          scale_bar: true,
          channel_legend: true,
          channel_labels: [
            { channel: 0, name: "DAPI", color: "#ffffff" },
            { channel: 1, name: "Membrane reporter", color: "#ff00ff" },
          ],
        },
      }),
    })));
  });

  it("resolves labels when channels arrive later without replacing an intentional blank", async () => {
    const source: ResearchSource = {
      ...sources[0],
      metadata: {
        ...sources[0].metadata,
        sample_semantics: "none",
        channel_names: ["Nuclei"],
      },
    };
    const exportSourceView = vi.fn().mockResolvedValue(null);
    const api = bridge(exportSourceView);
    const view = render(<SourceExportPanel api={api} source={source} selection={selection}
      channels={[]} projection="max" onError={vi.fn()} />);
    fireEvent.click(screen.getByText("Export rendered image"));

    view.rerender(<SourceExportPanel api={api} source={source} selection={selection}
      channels={channels} projection="max" onError={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Include channel legend"));
    expect(screen.getByLabelText("Channel 1 legend label")).toHaveValue("Nuclei");
    expect(screen.getByLabelText("Channel 2 legend label")).toHaveValue("Channel 2");

    fireEvent.change(screen.getByLabelText("Channel 1 legend label"), { target: { value: "" } });
    view.rerender(<SourceExportPanel api={api} source={source} selection={selection}
      channels={channels.map((entry) => ({ ...entry }))} projection="max" onError={vi.fn()} />);
    expect(screen.getByLabelText("Channel 1 legend label")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Export PNG…" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Channel 1 legend label"), {
      target: { value: "Nuclear stain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));
    await waitFor(() => expect(exportSourceView).toHaveBeenCalledWith(expect.objectContaining({
      view: expect.objectContaining({
        figure: expect.objectContaining({
          channel_labels: [
            { channel: 0, name: "Nuclear stain", color: "#ffffff" },
            { channel: 1, name: "Channel 2", color: "#ff00ff" },
          ],
        }),
      }),
    })));
  });

  it("lets the user turn off a selected legend after all channels become hidden", () => {
    const scalar = { ...sources[0], metadata: { ...sources[0].metadata, sample_semantics: "none" } };
    const api = bridge(vi.fn());
    const view = render(<SourceExportPanel api={api} source={scalar} selection={selection}
      channels={channels} projection="max" onError={vi.fn()} />);
    fireEvent.click(screen.getByText("Export rendered image"));
    fireEvent.click(screen.getByLabelText("Include channel legend"));

    const hidden = channels.map((entry) => ({ ...entry, visible: false }));
    view.rerender(<SourceExportPanel api={api} source={scalar} selection={selection}
      channels={hidden} projection="max" onError={vi.fn()} />);
    const toggle = screen.getByLabelText("Include channel legend");
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(screen.getByRole("button", { name: "Export PNG…" })).toBeDisabled();

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Export PNG…" })).toBeEnabled();
  });

  it("offers a scale bar for valid physical medical geometry without calibration metadata", async () => {
    const medical: ResearchSource = {
      ...sources[0],
      source_kind: "medical",
      metadata: {
        format: "NIfTI",
        shape: [5, 400, 600],
        geometry: {
          axes: "ZYX",
          unit: "mm",
          frame: "LPS",
          affine: [[0, -0.8, 0, 10], [0.4, 0, 0, 20], [0, 0, 2.5, 30], [0, 0, 0, 1]],
        },
      },
    };
    const exportSourceView = vi.fn().mockResolvedValue(null);
    render(<SourceExportPanel api={bridge(exportSourceView)} source={medical}
      selection={selection} channels={channels} projection="max" onError={vi.fn()} />);
    fireEvent.click(screen.getByText("Export rendered image"));

    const scaleBar = screen.getByLabelText("Include calibrated scale bar");
    expect(scaleBar).toBeEnabled();
    fireEvent.click(scaleBar);
    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));
    await waitFor(() => expect(exportSourceView).toHaveBeenCalledWith(expect.objectContaining({
      view: expect.objectContaining({
        figure: expect.objectContaining({ scale_bar: true }),
      }),
    })));
  });

  it("leaves scale bars unavailable without physical calibration and bounds DPI", () => {
    render(panel(bridge(vi.fn())));
    fireEvent.click(screen.getByText("Export rendered image"));
    expect(screen.getByLabelText("Include calibrated scale bar")).toBeDisabled();
    expect(screen.getByText(/Pixel-only, unknown, and RGBA geometry/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Rendered export DPI"), { target: { value: "1201" } });
    expect(screen.getByRole("button", { name: "Export PNG…" })).toBeDisabled();
  });

  it("uses a changed preference only as the initializer for a new panel", () => {
    const api = bridge(vi.fn());
    const view = render(<SourceExportPanel api={api} source={sources[0]} selection={selection}
      channels={channels} projection="max" onError={vi.fn()} defaultDpi={450} />);
    fireEvent.click(screen.getByText("Export rendered image"));
    fireEvent.change(screen.getByLabelText("Rendered export DPI"), { target: { value: "500" } });

    view.rerender(<SourceExportPanel api={api} source={sources[0]} selection={selection}
      channels={channels} projection="max" onError={vi.fn()} defaultDpi={600} />);

    expect(screen.getByLabelText("Rendered export DPI")).toHaveValue(500);
  });
});
