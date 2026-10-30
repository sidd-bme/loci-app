// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { MorphometricsSummary, ResearchMorphometricsPanel } from "./ResearchMorphometricsPanel";

afterEach(cleanup);
const source = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Generated shape fixture", metadata: {} } as ResearchSource;
const parent: ResearchResult = { schema: "loci.research-result/v1", id: "c".repeat(32), revision_hash: "d".repeat(64),
  source_id: source.id, source_sha256: source.sha256, kind: "segmentation", created_at: "2026-10-30", object_count: 2,
  geometry: { axes: "YX", unit: "um" }, arrays: { image: { sha256: "e".repeat(64), shape: [8, 10] }, labels: { sha256: "f".repeat(64), shape: [8, 10] } } };
const record = { schema: "loci.morphometrics-result/v1", input: { result_id: parent.id, revision_hash: parent.revision_hash,
  image_sha256: parent.arrays!.image.sha256, labels_sha256: parent.arrays!.labels.sha256 }, object_count: 2, index_axes: "YX",
  calibration_status: "declared-physical-calibration", rules: { circularity: "4*pi*A/P^2", boundary: "Exact exposed pixel edges" }, units: { perimeter: "um" } };
const result: ResearchResult = { ...parent, id: "1".repeat(32), revision_hash: "2".repeat(64), kind: "morphometrics", parent_id: parent.id, morphometrics: record };
const response = () => ({ result: structuredClone(result), morphometrics: structuredClone(record), job: {
  id: "3".repeat(32), operation: "morphometrics_run", state: "succeeded", result_ids: [result.id],
} });
function setup() {
  const execute = vi.fn().mockResolvedValue(response());
  const props = { api: { execute } as unknown as ResearchDesktopApi, snapshot: { project: { project_id: "4".repeat(32) }, results: [parent] } as ResearchSnapshot,
    source, selectedResult: null as ResearchResult | null, active: true, busy: false, workingBytes: 16 * 1024 ** 2,
    onBusyChange: vi.fn(), onPublished: vi.fn().mockResolvedValue(undefined), onExplore: vi.fn(), onReview: vi.fn() };
  return { ...render(<ResearchMorphometricsPanel {...props} />), props, execute };
}
function choose() { fireEvent.change(screen.getByLabelText("Shape label result"), { target: { value: `${parent.id}:${parent.revision_hash}` } }); }

describe("Exact object shape workflow", () => {
  it("submits the chosen revision and adopts only the completed native derivative", async () => {
    const view = setup(); const run = screen.getByRole("button", { name: "Measure object shape" });
    expect(run).toBeDisabled(); choose(); fireEvent.click(run);
    await waitFor(() => expect(view.props.onPublished).toHaveBeenCalledWith(result));
    expect(view.execute).toHaveBeenCalledExactlyOnceWith("morphometrics_run", { result_id: parent.id, revision_hash: parent.revision_hash, working_bytes: 16 * 1024 ** 2 });
    expect(view.props.onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
  it.each(["unfinished job", "wrong arrays", "wrong input", "different source"])("refuses %s before selecting a result", async (reason) => {
    const view = setup(); const value = response();
    if (reason === "unfinished job") value.job.state = "running";
    if (reason === "wrong arrays") value.result.arrays!.labels.sha256 = "9".repeat(64);
    if (reason === "wrong input") (value.result.morphometrics as typeof record).input.revision_hash = "9".repeat(64);
    if (reason === "different source") value.result.source_id = "9".repeat(32);
    view.execute.mockResolvedValueOnce(value); choose(); fireEvent.click(screen.getByRole("button", { name: "Measure object shape" }));
    expect(await screen.findByRole("alert")).toBeVisible(); expect(view.props.onPublished).not.toHaveBeenCalled();
  });
  it("does not replay a delayed result after the researcher leaves the tool", async () => {
    const view = setup(); let settle!: (value: unknown) => void;
    view.execute.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    choose(); fireEvent.click(screen.getByRole("button", { name: "Measure object shape" }));
    view.rerender(<ResearchMorphometricsPanel {...view.props} active={false} />);
    await act(async () => { settle(response()); });
    expect(view.props.onPublished).not.toHaveBeenCalled(); expect(view.props.onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it("requires reselection when the exact parent revision disappears", () => {
    const view = setup(); choose();
    view.rerender(<ResearchMorphometricsPanel {...view.props} snapshot={{ ...view.props.snapshot, results: [{ ...parent, revision_hash: "9".repeat(64) }] }} />);
    expect(screen.getByRole("button", { name: "Measure object shape" })).toBeDisabled();
    expect(screen.getByLabelText("Shape label result")).toHaveValue("");
  });
  it("does not offer derived results or another source as a label parent", () => {
    const view = setup();
    view.rerender(<ResearchMorphometricsPanel {...view.props} snapshot={{ ...view.props.snapshot, results: [result, { ...parent, source_sha256: "9".repeat(64) }] }} />);
    expect(screen.getByText(/Create or import an object-label result/)).toBeVisible();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });
  it("opens linked statistics and review for the exact saved result", () => {
    const view = setup(); view.rerender(<ResearchMorphometricsPanel {...view.props} selectedResult={result} />);
    fireEvent.click(screen.getByRole("button", { name: "Plot and inspect objects" }));
    fireEvent.click(screen.getByRole("button", { name: "Review & export" }));
    expect(view.props.onExplore).toHaveBeenCalledWith(result); expect(view.props.onReview).toHaveBeenCalledWith(result);
    expect(screen.getByText(/Undefined ratios remain missing/)).toBeVisible();
  });
  it("keeps pixel calibration explicit and distinguishes volumetric descriptors", () => {
    const volume: ResearchResult = { ...result, geometry: { axes: "ZYX", unit: "pixel" }, morphometrics: { ...record, index_axes: "ZYX", calibration_status: "uncalibrated-pixel-geometry" } };
    render(<MorphometricsSummary result={volume} onExplore={vi.fn()} onReview={vi.fn()} />);
    expect(screen.getByRole("note")).toHaveTextContent("Uncalibrated");
    expect(screen.getByText(/Volume, exposed-face surface area and sphericity/)).toBeVisible();
  });
});
