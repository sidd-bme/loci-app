// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchChannelColorsDialog } from "./BatchChannelColorsDialog";
import type {
  BatchChannelColorsResponse,
  ResearchSource,
} from "../shared/research-contracts";
import type { ViewerChannel } from "./ImageViewport";

afterEach(cleanup);

const mockSource1: ResearchSource = {
  id: "a".repeat(32),
  name: "siIL4RA_Untreated_5.ims",
  sha256: "1".repeat(64),
  metadata: {
    dimensions: { x: 512, y: 512, z: 10, c: 3, t: 1 },
    channel_names: ["DAPI", "GFP", "Cy5"],
    pixel_size: { x: 0.2, y: 0.2, z: 1.0, unit: "um" },
  } as any,
};

const mockSource2: ResearchSource = {
  id: "b".repeat(32),
  name: "siIL4RA_Treated_2.ims",
  sha256: "2".repeat(64),
  metadata: {
    dimensions: { x: 512, y: 512, z: 10, c: 3, t: 1 },
    channel_names: ["DAPI", "GFP", "Cy5"],
    pixel_size: { x: 0.2, y: 0.2, z: 1.0, unit: "um" },
  } as any,
};

const mockChannels: ViewerChannel[] = [
  { channel: 0, color: "#0000ff", low: 0, high: 255, gamma: 1, visible: true },
  { channel: 1, color: "#00ff00", low: 0, high: 255, gamma: 1, visible: true },
  { channel: 2, color: "#ff0000", low: 0, high: 255, gamma: 1, visible: true },
];

describe("BatchChannelColorsDialog", () => {
  it("renders minimal dialog scoped to selected images with smart auto-mapping", async () => {
    const response: BatchChannelColorsResponse = {
      preview_only: false,
      total_sources: 2,
      applicable_count: 2,
      affected_sources: [
        {
          source_id: mockSource1.id,
          source_name: "siIL4RA_Untreated_5.ims",
          revision: 1,
          status: "applied",
          reason: null,
          changes: [{ channel: 0, channel_name: "DAPI", old_color: "#0000ff", new_color: "#00ffff" }],
        },
        {
          source_id: mockSource2.id,
          source_name: "siIL4RA_Treated_2.ims",
          revision: 1,
          status: "applied",
          reason: null,
          changes: [{ channel: 0, channel_name: "DAPI", old_color: "#0000ff", new_color: "#00ffff" }],
        },
      ],
      applied_count: 2,
      skipped_count: 0,
      previous_palettes: {
        [mockSource1.id]: [{ channel: 0, color: "#0000ff" }],
        [mockSource2.id]: [{ channel: 0, color: "#0000ff" }],
      },
      new_revisions: { [mockSource1.id]: 1, [mockSource2.id]: 1 },
    };
    const execute = vi.fn().mockResolvedValue(response);

    const onClose = vi.fn();
    const onBeforeRequest = vi.fn(async () => {});
    const onApplied = vi.fn();

    render(
      <BatchChannelColorsDialog
        open={true}
        onClose={onClose}
        api={{ execute }}
        activeSource={mockSource1}
        sources={[mockSource1, mockSource2]}
        selectedSourceIds={[mockSource1.id, mockSource2.id]}
        activeChannels={mockChannels}
        onBeforeRequest={onBeforeRequest}
        onApplied={onApplied}
      />,
    );

    // Shows modal and selected badge
    expect(screen.getByRole("dialog", { name: "Apply channel colours" })).toBeVisible();
    expect(screen.getByText("2 selected")).toBeVisible();

    // Primary button states target count
    const applyButton = screen.getByRole("button", { name: "Apply colour to all 2 images" });
    expect(applyButton).toBeVisible();

    // Change preset
    const presetSelect = screen.getByRole("combobox", { name: "Palette preset" });
    fireEvent.change(presetSelect, { target: { value: "cmy-subtractive" } });

    // Click apply
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith("batch_channel_colors", expect.objectContaining({
        source_ids: [mockSource1.id, mockSource2.id],
        preview_only: false,
        mapping_mode: "auto",
        expected_revisions: response.new_revisions,
      }));
    });

    await waitFor(() => {
      expect(onBeforeRequest).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][1]).toMatchObject({ preview_only: true });
      expect(onApplied).toHaveBeenCalledWith(response, expect.arrayContaining([
        expect.objectContaining({ channel: 0, color: "#00ffff" }),
      ]));
    });
  });
  it("previews all loaded images with an explicit index mapping", async () => {
    const execute = vi.fn().mockResolvedValue({ affected_sources: [], new_revisions: {} });
    render(<BatchChannelColorsDialog open onClose={vi.fn()} api={{ execute }}
      activeSource={mockSource1} sources={[mockSource1, mockSource2]}
      selectedSourceIds={[mockSource1.id]} activeChannels={mockChannels} />);
    fireEvent.change(screen.getByLabelText("Target images"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Channel mapping"), { target: { value: "index" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("batch_channel_colors", {
      source_ids: [mockSource1.id, mockSource2.id], preview_only: true,
      mapping_mode: "index", color_map: { "0": "#0000ff", "1": "#00ff00", "2": "#ff0000" },
    }));
    expect(screen.getByText("2 loaded")).toBeVisible();
  });

});
