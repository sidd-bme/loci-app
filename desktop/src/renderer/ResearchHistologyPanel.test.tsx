// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ResearchDesktopApi, ResearchSelection } from "../shared/research-contracts";
import { ResearchHistologyPanel } from "./ResearchHistologyPanel";

afterEach(cleanup);
const selection: ResearchSelection = { x: 10, y: 20, width: 64, height: 32, t: 0, c: 0, z: 0, level: 1 };
const preview = { adopted: false, image: "data:image/png;base64,AA==", region_count: 2, measurements: [{ label: 1, measure: 12 }], provenance: { tissue_mask: { initial_mask_fraction: 0.25 } } };
const result = { id: "result", revision_hash: "revision", source_id: "source", kind: "tissue-region-mask" };
type Props = ComponentProps<typeof ResearchHistologyPanel>;
function setup(execute = vi.fn().mockResolvedValue(preview)) {
  const props: Props = { api: { execute } as unknown as ResearchDesktopApi, sourceId: "source", selection, busy: false, report: async (work) => work(), onBusyChange: vi.fn(), onPreview: vi.fn(), onResult: vi.fn().mockResolvedValue(undefined) };
  return { props, execute, ...render(<ResearchHistologyPanel {...props} />) };
}

describe("ResearchHistologyPanel", () => {
  it("requires a declared control and current preview before adopting the exact selected field", async () => {
    const { props, execute } = setup();
    expect(screen.getByRole("button", { name: "Preview tissue mask" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Adopt tissue mask" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Tissue control or review criterion"), { target: { value: "Blank-slide control" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview tissue mask" }));
    await waitFor(() => expect(props.onPreview).toHaveBeenCalledWith(preview.image, preview.measurements));
    expect(execute).toHaveBeenCalledWith("tissue_preview", { source_id: "source", selection, settings: { closing_radius_pixels: 0, minimum_component_pixels: 0, control: "Blank-slide control" }, working_bytes: 512 * 1024 ** 2 });
    expect(screen.getByRole("status")).toHaveTextContent("2 connected regions · 25.00%");
    execute.mockResolvedValueOnce({ result, measurements: preview.measurements });
    fireEvent.click(screen.getByRole("button", { name: "Adopt tissue mask" }));
    await waitFor(() => expect(props.onResult).toHaveBeenCalledWith(result, preview.measurements));
    fireEvent.change(screen.getByLabelText("Tissue minimum region"), { target: { value: "20" } });
    expect(screen.getByRole("button", { name: "Adopt tissue mask" })).toBeDisabled();
  });

  it("discards a late preview when the source or selection changes", async () => {
    let finish!: (value: unknown) => void;
    const execute = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { props, rerender } = setup(execute);
    fireEvent.change(screen.getByLabelText("Tissue control or review criterion"), { target: { value: "Visual review" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview tissue mask" }));
    rerender(<ResearchHistologyPanel {...props} selection={{ ...selection, x: 30 }} />);
    await act(async () => finish(preview));
    expect(props.onPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Adopt tissue mask" })).toBeDisabled();
    expect(props.onBusyChange).toHaveBeenLastCalledWith(null);
  });

  it("blocks multi-plane masking and reports engine failure through the shared alert handler", async () => {
    const { props, rerender } = setup(vi.fn().mockRejectedValue(new Error("Invalid RGB source")));
    const failures: string[] = [];
    props.report = async (work) => { try { return await work(); } catch (error) { failures.push((error as Error).message); return undefined; } };
    rerender(<ResearchHistologyPanel {...props} selection={{ ...selection, z_stop: 3 }} />);
    fireEvent.change(screen.getByLabelText("Tissue control or review criterion"), { target: { value: "Visual review" } });
    expect(screen.getByRole("button", { name: "Preview tissue mask" })).toBeDisabled();
    rerender(<ResearchHistologyPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview tissue mask" }));
    await waitFor(() => expect(failures).toEqual(["Invalid RGB source"]));
    expect(props.onPreview).not.toHaveBeenCalled();
    expect(props.onBusyChange).toHaveBeenLastCalledWith(null);
  });
});
