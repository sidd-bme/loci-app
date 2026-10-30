// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
