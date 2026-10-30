// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { ResearchSpatialPanel, SpatialSummary, spatialRecord } from "./ResearchSpatialPanel";

afterEach(cleanup);
const source = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Known fixture", metadata: {} } as ResearchSource;
const results = ["c", "d", "e"].map((id): ResearchResult => ({
  id: id.repeat(32), revision_hash: id.repeat(64), source_id: source.id, source_sha256: source.sha256,
  kind: "segmentation", created_at: "2026-10-30", object_count: 2, geometry: { axes: "YX", unit: "um" },
  arrays: { labels: { shape: [10, 12], dtype: "uint32", sha256: id.repeat(64) } },
}));
const record = { schema: "loci.spatial-distance-bands/v1", distance_unit: "um", area_unit: "um^2",
  inputs: Object.fromEntries(["objects", "compartment", "boundary"].map((role, i) => [role, { result_id: results[i].id, revision_hash: results[i].revision_hash, labels_sha256: results[i].arrays!.labels.sha256 }])),
  bands: [{ lower: 0, upper: 100, pixel_count: 100, area: 100, object_count: 2, density: 0.02 }, { lower: 100, upper: 300, pixel_count: 0, area: 0, object_count: 0, density: null }],
};
function panel() {
  const execute = vi.fn().mockResolvedValue({ result: { ...results[0], id: "f".repeat(32), kind: "spatial-distance-bands", spatial: record }, spatial: record });
  const props = { api: { execute } as unknown as ResearchDesktopApi, snapshot: { results } as ResearchSnapshot, source,
    busy: false, active: true, workingBytes: 16 * 1024 ** 2, onBusyChange: vi.fn(), onPublished: vi.fn().mockResolvedValue(undefined) };
  return { ...render(<ResearchSpatialPanel {...props} />), props, execute };
}
function complete() {
  ["objects", "compartment", "boundary"].forEach((role, index) => fireEvent.change(screen.getByLabelText(`Spatial ${role}`), { target: { value: `${results[index].id}:${results[index].revision_hash}` } }));
  fireEvent.change(screen.getByLabelText("Spatial band edges"), { target: { value: "0, 100, 300" } });
  fireEvent.change(screen.getByLabelText("Spatial controls"), { target: { value: "Declared basal reference" } });
  fireEvent.change(screen.getByLabelText("Spatial boundary coverage"), { target: { value: "Full supplied boundary; crop limitations recorded" } });
}
describe("Tissue distance workflow", () => {
  it("retains incomplete input and submits exact revisions only when all definitions are present", async () => {
    const view = panel(); const run = screen.getByRole("button", { name: "Measure tissue distances" });
    expect(run).toBeDisabled(); complete();
    fireEvent.change(screen.getByLabelText("Spatial band edges"), { target: { value: "0, 1e, 300" } });
    expect(screen.getByLabelText("Spatial band edges")).toHaveValue("0, 1e, 300"); expect(run).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Spatial band edges"), { target: { value: "0, 100, 300" } });
    fireEvent.click(run);
    await waitFor(() => expect(view.props.onPublished).toHaveBeenCalledOnce());
    expect(view.execute).toHaveBeenCalledWith("spatial_distance_run", expect.objectContaining({ result_id: results[0].id, revision_hash: results[0].revision_hash,
      compartment: { result_id: results[1].id, revision_hash: results[1].revision_hash }, boundary: { result_id: results[2].id, revision_hash: results[2].revision_hash }, band_edges: [0, 100, 300], exclude_crop_border: true }));
  });
  it("does not navigate after the researcher leaves the active panel", async () => {
    const view = panel(); let resolve!: (value: unknown) => void;
    view.execute.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    complete(); fireEvent.click(screen.getByRole("button", { name: "Measure tissue distances" }));
    view.rerender(<ResearchSpatialPanel {...view.props} active={false} />);
    resolve({ result: { ...results[0], kind: "spatial-distance-bands" }, spatial: record });
    await waitFor(() => expect(view.props.onBusyChange).toHaveBeenLastCalledWith(false));
    expect(view.props.onPublished).not.toHaveBeenCalled();
  });
  it("distinguishes absent area from zero objects and refuses inconsistent density", () => {
    render(<SpatialSummary value={record} />);
    expect(screen.getByText("Undefined: no sampled area")).toBeVisible();
    expect(() => spatialRecord({ ...record, bands: [{ ...record.bands[0], density: 999 }] })).toThrow("inconsistent");
  });
});

const spatialResult: ResearchResult = {
  ...results[0], id: "f".repeat(32), kind: "spatial-distance-bands", object_count: 5, spatial: record,
  geometry: { axes: "YX", unit: "um", frame: "image", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
  arrays: Object.fromEntries(["labels", "compartment_labels", "boundary_labels", "distance_bands"].map((field) => [field, { shape: [10, 12] }])),
};
const maskFields = {
  objects: ["Objects (including excluded)", "Retained object labels, including excluded objects"],
  compartment: ["Tissue compartment", "Declared analyzable tissue compartment"],
  boundary: ["Reference boundary", "Declared boundary pixel centers"],
  bands: ["Distance bands", "Sampled compartment distance bands; zero outside supplied bands"],
} as const;
type MaskField = keyof typeof maskFields;
function maskView(field: MaskField, result = spatialResult) {
  return { result_id: result.id, revision_hash: result.revision_hash, axis: "z", index: 0,
    label_field: field, label_field_basis: maskFields[field][1], shape: [10, 12], geometry: result.geometry,
    image: "data:image/png;base64,AA==", label_image: "data:image/png;base64,AQ==" };
}
function maskSummary(execute = vi.fn(async (_operation: string, request: Record<string, unknown>) => maskView(request.label_field as MaskField))) {
  const api = { execute } as unknown as ResearchDesktopApi;
  return { ...render(<SpatialSummary value={record} api={api} result={spatialResult} />), api, execute };
}

describe("Saved tissue distance summary", () => {
  it("separates counted, retained and excluded objects and keeps physical density units", () => {
    render(<SpatialSummary value={record} result={spatialResult} />);
    expect(screen.getByText("2 counted in bands").parentElement).toHaveTextContent("2 counted in bands of 5 retained objects");
    expect(screen.getByText("3 excluded from bands")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Band (µm)" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Count" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Area (µm²)" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Density (objects/µm²)" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Tissue distance table" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("cell", { name: "0.0200000" })).toHaveAttribute("title", "0.02");
    expect(screen.getByText("Undefined: no sampled area")).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows zero density for sampled area with no counted objects, distinct from missing area", () => {
    render(<SpatialSummary value={{ ...record, bands: [{ ...record.bands[0], object_count: 0, density: 0 }, record.bands[1]] }} result={spatialResult} />);
    expect(screen.getByText("0 counted in bands")).toBeVisible();
    expect(screen.getByText("5 excluded from bands")).toBeVisible();
    expect(screen.getByRole("cell", { name: "0.00000" })).toBeVisible();
    expect(screen.getByText("Undefined: no sampled area")).toBeVisible();
  });

  it.each([1, -1, 2.5, NaN, Infinity])("refuses invalid retained totals (%s)", (objectCount) => {
    render(<SpatialSummary value={record} result={{ ...spatialResult, object_count: objectCount }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("retained object count");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("requests each real saved field on its own viewer lane and supports keyboard enlargement", async () => {
    const { execute } = maskSummary();
    expect(screen.getByRole("status")).toHaveTextContent("Loading saved mask");
    const select = screen.getByRole("combobox", { name: "Spatial mask" });
    for (const [field, [label, basis]] of Object.entries(maskFields)) {
      fireEvent.change(select, { target: { value: field } });
      expect(await screen.findByRole("img", { name: `${label} — saved spatial result` })).toHaveAttribute("src", maskView(field as MaskField).image);
      expect(execute).toHaveBeenLastCalledWith("result_view", { result_id: spatialResult.id, axis: "z", index: 0, labels: true, label_field: field }, { viewer_lane: expect.stringMatching(/^spatial-qc-[a-z0-9_-]+$/u) });
      expect(screen.getByText(basis, { exact: false })).toBeVisible();
    }
    const enlarge = screen.getByRole("button", { name: "Enlarge mask inspection" });
    enlarge.focus(); fireEvent.click(enlarge);
    const dialog = screen.getByRole("dialog", { name: "Spatial mask inspection" });
    expect(within(dialog).getByRole("img", { name: "Distance bands — saved spatial result" })).toBeVisible();
    const close = within(dialog).getByRole("button", { name: "Close spatial mask inspection" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" }); expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true }); expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(enlarge).toHaveFocus();
  });

  it("ignores a late mask response after selection changes", async () => {
    let finish!: (value: ReturnType<typeof maskView>) => void;
    const execute = vi.fn((_operation: string, request: Record<string, unknown>) => request.label_field === "objects"
      ? new Promise<ReturnType<typeof maskView>>((resolve) => { finish = resolve; }) : Promise.resolve(maskView(request.label_field as MaskField)));
    maskSummary(execute);
    fireEvent.change(screen.getByRole("combobox", { name: "Spatial mask" }), { target: { value: "boundary" } });
    await screen.findByRole("img", { name: "Reference boundary — saved spatial result" });
    await act(async () => { finish(maskView("objects")); });
    expect(screen.queryByRole("img", { name: /Objects/ })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Reference boundary — saved spatial result" })).toBeVisible();
  });

  it("removes the old image immediately when the result revision changes and ignores late responses", async () => {
    let finish!: (value: ReturnType<typeof maskView>) => void;
    const execute = vi.fn((_operation: string, request: Record<string, unknown>) => request.label_field === "boundary"
      ? new Promise<ReturnType<typeof maskView>>((resolve) => { finish = resolve; }) : Promise.resolve(maskView(request.label_field as MaskField)));
    const summary = maskSummary(execute);
    await screen.findByRole("img");
    fireEvent.change(screen.getByRole("combobox", { name: "Spatial mask" }), { target: { value: "boundary" } });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    const next = { ...spatialResult, revision_hash: "a".repeat(64) };
    execute.mockImplementation(async (_operation, request) => maskView(request.label_field as MaskField, next));
    summary.rerender(<SpatialSummary value={record} api={summary.api} result={next} />);
    await screen.findByRole("img", { name: "Objects (including excluded) — saved spatial result" });
    await act(async () => { finish(maskView("boundary")); });
    expect(screen.queryByRole("img", { name: /Reference boundary/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { result_id: "0".repeat(32) }, { revision_hash: "0".repeat(64) },
    { label_field: "boundary" }, { label_field_basis: "Invented basis" },
    { axis: "x" }, { index: 1 }, { shape: [12, 10] },
    { geometry: { ...spatialResult.geometry, unit: "mm" } },
    { geometry: { ...spatialResult.geometry, frame: "other" } },
    { geometry: { ...spatialResult.geometry, affine: [[2, 0], [0, 2]] } },
    { image: "https://example.test/image.png" }, { label_image: null },
  ])("rejects a mismatched or unsafe mask response (%j)", async (patch) => {
    maskSummary(vi.fn().mockResolvedValue({ ...maskView("objects"), ...patch }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match this saved revision and label field");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enlarge mask inspection" })).not.toBeInTheDocument();
  });

  it("recovers an API failure and an image decode error through an explicit retry", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("Saved preview is unavailable.")).mockResolvedValue(maskView("objects"));
    maskSummary(execute);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved preview is unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry mask preview" }));
    const image = await screen.findByRole("img");
    fireEvent.error(image);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not display the saved mask image");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry mask preview" }));
    expect(await screen.findByRole("img")).toBeVisible();
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
