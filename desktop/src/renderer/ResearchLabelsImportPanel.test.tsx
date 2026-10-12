// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchLabelsImportPreview, ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { ResearchLabelsImportPanel, checkedLabelsPreview, labelsImportUnavailable } from "./ResearchLabelsImportPanel";

afterEach(cleanup);
const source: ResearchSource = { id: "a".repeat(32), name: "Synthetic plane", sha256: "b".repeat(64), source_kind: "native", metadata: { dimensions: { x: 8, y: 4, t: 1, c: 2, z: 2 }, axes: "TCZYX" } };
const selection: ResearchSelection = { x: 0, y: 0, width: 8, height: 4, t: 0, c: 1, z: 1, level: 0 };
const preview: ResearchLabelsImportPreview = { source_id: source.id, source_sha256: source.sha256, selection, working_bytes: 64 * 1024 ** 2, grant_id: "c".repeat(32),
  geometry: null, file_name: "sparse.tif", file_sha256: "d".repeat(64), file_size_bytes: 1000, original_dtype: "uint32", shape: [4, 8], axes: "YX", object_count: 2,
  labels_sha256: "e".repeat(64), format: "TIFF", profile: "scalar-native-yx/v1", estimated_working_bytes: 2048,
  measurement_channel: { index: 1, name: "Raw channel 2", basis: "raw-source-channel-values" }, calibration_handling: {},
  image: "data:image/png;base64,cG5n", preview_width: 8, preview_height: 4 };
const result: ResearchResult = { id: "f".repeat(32), revision_hash: "1".repeat(64), source_id: source.id, source_sha256: source.sha256, kind: "imported-labels", created_at: "now", object_count: 2, selection, review: null };
function setup(overrides: Partial<Parameters<typeof ResearchLabelsImportPanel>[0]> = {}) {
  const execute = vi.fn().mockResolvedValue({ result, measurements: [] });
  const picker = vi.fn().mockResolvedValue(preview);
  const props = { api: { execute, labelsImportPreview: picker } as unknown as ResearchDesktopApi, source, selection, workingBytes: preview.working_bytes, scope: "study-a", busy: false,
    onBusy: vi.fn(), onResult: vi.fn().mockResolvedValue(undefined), ...overrides };
  return { props, execute, picker };
}

describe("checked external-label import", () => {
  it("shows real preview metadata and adopts only the opaque grant with unknown producer", async () => {
    const { props, picker, execute } = setup(); render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Import labels" }));
    expect(await screen.findByAltText("Checked label overlay on the selected source plane")).toHaveAttribute("src", preview.image);
    expect(screen.getByText("sparse.tif")).toBeVisible(); expect(screen.getByText(/uint32/)).toBeVisible();
    expect(screen.getByText(/Upstream settings and validation are unknown/)).toBeVisible();
    expect(picker).toHaveBeenCalledWith({ source_id: source.id, source_sha256: source.sha256, selection, working_bytes: preview.working_bytes });
    fireEvent.click(screen.getByRole("button", { name: "Import on this plane" }));
    await waitFor(() => expect(props.onResult).toHaveBeenCalledWith(result, [], expect.any(Function)));
    expect(execute).toHaveBeenCalledWith("labels_import", { source_id: source.id, source_sha256: source.sha256, grant_id: preview.grant_id, alignment: "same-native-yx-grid" });
  });
  it("cancellation and failure preserve the old result", async () => {
    const { props, picker, execute } = setup(); picker.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Unsupported label dtype"));
    render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String)));
    expect(screen.queryByText("Import on this plane")).toBeNull();
    fireEvent.click(screen.getByText("Import labels")); expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported label dtype");
    expect(execute).not.toHaveBeenCalled(); expect(props.onResult).not.toHaveBeenCalled();
  });
  it("discards a late picker preview after changing source plane", async () => {
    let finish!: (value: ResearchLabelsImportPreview) => void;
    const { props, picker } = setup(); picker.mockReturnValue(new Promise<ResearchLabelsImportPreview>((resolve) => { finish = resolve; }));
    const view = render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    view.rerender(<ResearchLabelsImportPanel {...props} selection={{ ...selection, c: 0 }} />); finish(preview);
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String))); expect(screen.queryByText("Import on this plane")).toBeNull();
  });
  it("does not select a completed import after a document change", async () => {
    let finish!: (value: unknown) => void;
    const { props, execute } = setup(); execute.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    fireEvent.click(await screen.findByText("Import on this plane"));
    view.rerender(<ResearchLabelsImportPanel {...props} scope="study-b" />); finish({ result });
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String))); expect(props.onResult).not.toHaveBeenCalled();
  });
  it("does not select a completed import after another navigation intent even before a render", async () => {
    let finish!: (value: unknown) => void;
    let intent = 1;
    const { props, execute } = setup({ navigationIntent: () => intent });
    execute.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    fireEvent.click(await screen.findByText("Import on this plane")); intent++;
    finish({ result }); await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String)));
    expect(props.onResult).not.toHaveBeenCalled();
  });
  it("invalidates a checked preview immediately when plane changes and records declared producer", async () => {
    const { props, execute } = setup(); const view = render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    await screen.findByText("Import on this plane"); fireEvent.change(screen.getByLabelText("Producer version (optional)"), { target: { value: "1.2" } });
    expect(screen.getByText("Import on this plane")).toBeDisabled(); fireEvent.change(screen.getByLabelText("Producer name (optional)"), { target: { value: "External tool" } });
    fireEvent.click(screen.getByText("Import on this plane")); await waitFor(() => expect(execute).toHaveBeenCalledWith("labels_import", expect.objectContaining({ producer: { name: "External tool", version: "1.2" } })));
    view.rerender(<ResearchLabelsImportPanel {...props} selection={{ ...selection, z: 0 }} />); expect(screen.queryByText("Import on this plane")).toBeNull();
  });
  it("shows an empty population without inventing objects", async () => {
    const { props, picker } = setup(); picker.mockResolvedValue({ ...preview, object_count: 0 }); render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByText("Import labels")); expect(await screen.findByText(/empty population/)).toBeVisible(); expect(screen.getByText("Import on this plane")).toBeEnabled();
  });
  it("rejects a path-like producer before submission and leaves the checked preview intact", async () => {
    const { props, execute } = setup(); render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByText("Import labels")); await screen.findByText("Import on this plane");
    fireEvent.change(screen.getByLabelText("Producer name (optional)"), { target: { value: "/private/tool" } });
    expect(screen.getByRole("alert")).toHaveTextContent("without file paths"); expect(screen.getByText("Import on this plane")).toBeDisabled();
    expect(execute).not.toHaveBeenCalled(); expect(screen.getByAltText("Checked label overlay on the selected source plane")).toBeVisible();
  });
  it("rejects preview identity mismatches and unsupported grids", () => {
    expect(() => checkedLabelsPreview({ ...preview, source_sha256: "0".repeat(64) }, source, selection, preview.working_bytes)).toThrow(/exact native source plane/);
    expect(() => checkedLabelsPreview({ ...preview, measurement_channel: { ...preview.measurement_channel, index: 0 } }, source, selection, preview.working_bytes)).toThrow();
    expect(labelsImportUnavailable(source, { ...selection, z_stop: 2 })).toMatch(/full level-0/);
    expect(labelsImportUnavailable({ ...source, metadata: { ...source.metadata, sample_semantics: "rgb" } }, selection)).toMatch(/RGB/);
  });
  it("sends only explicit native-plane keys after leaving a volume", async () => {
    const { props, picker } = setup({ selection: { ...selection, z_stop: undefined } });
    render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    await screen.findByText("Import on this plane");
    expect(Object.keys(picker.mock.calls[0][0].selection).sort()).toEqual(["c", "height", "level", "t", "width", "x", "y", "z"]);
  });
});
