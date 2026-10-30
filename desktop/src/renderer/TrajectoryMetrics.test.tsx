// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult } from "../shared/research-contracts";
import type { TrackingGraph } from "./ResearchTemporalPanel";
import { TrajectoryMetrics } from "./TrajectoryMetrics";

afterEach(cleanup);
const result = { id: "1".repeat(32), revision_hash: "2".repeat(64) } as ResearchResult;
const summary = { schema: "loci.trajectory-summary/v1", metrics_schema: "loci.trajectory-metrics/v1", graph_sha256: "3".repeat(64),
  units: { position: "um", time: "s", velocity: "um/s", directionality: "dimensionless" },
  track_count: 14, interval_count: 14, observation_count: 28, storage: "persisted",
  rules: { directionality: "Net displacement divided by observed path length" }, numerical_policy: "Float64 arithmetic" };
function track(index: number) {
  return { track_key: JSON.stringify([`frame-${index}`, "1"]), start_frame_id: `frame-${index}`, start_label: "1",
    end_frame_id: `later-${index}`, end_label: "2", observation_count: 2, interval_count: 1, elapsed_s: 8,
    observed_path_length: 17, net_displacement: 13, net_displacement_xyz: [3, 4, 12], mean_velocity_xyz: [3 / 8, .5, 1.5],
    mean_speed: 17 / 8, directionality_ratio: 13 / 17, directionality_status: "defined", gap_frames: 1, uncertain_edge_count: 1, hypothesis_indices: [0] };
}
function page(offset = 0, table = "tracks") {
  return { schema: "loci.trajectory-page/v1", result_id: result.id, revision_hash: result.revision_hash, summary: structuredClone(summary),
    table, offset, limit: 12, total: 14, next_offset: offset === 0 ? 12 : null,
    rows: Array.from({ length: Math.min(12, 14 - offset) }, (_, i) => table === "tracks" ? track(offset + i) : {
      track_key: track(i).track_key, source_frame_id: `frame-${i}`, source_label: "1", target_frame_id: `later-${i}`, target_label: "2",
      elapsed_s: 8, displacement_xyz: [3, 4, 12], velocity_xyz: [.375, .5, 1.5], speed: 13 / 8, chord_length: 13,
      gap_frames: 1, identity_uncertain: true, association_provenance: "manual",
    }) };
}
const graph = { frames: [], edges: [], hypotheses: [], trajectories: [[
  { frame_id: "frame-0", label: "1", time_s: 0, centroid_world_xyz: [0, 0, 0], gap_before: null, measure: 1, speed: null, displacement: 0, path_length: 0 },
  { frame_id: "later-0", label: "2", time_s: 8, centroid_world_xyz: [3, 4, 12], gap_before: 1, measure: 1, speed: 13 / 8, displacement: 13, path_length: 13 },
]] } as TrackingGraph;
function setup(execute = vi.fn(async (_op: string, input: Record<string, unknown>) => page(Number(input.offset), String(input.table)))) {
  const props = { api: { execute } as unknown as ResearchDesktopApi, result, summary, graph, busy: false, onOpenFrame: vi.fn() };
  return { ...render(<TrajectoryMetrics {...props} />), props, execute };
}

describe("Exact trajectory measurements", () => {
  it("pages bound track summaries and preserves time-weighted speed and review flags", async () => {
    const view = setup();
    expect(await screen.findByText("1–12 of 14")).toBeVisible();
    expect(view.execute).toHaveBeenLastCalledWith("tracking_result", { result_id: result.id, revision_hash: result.revision_hash, table: "tracks", offset: 0, limit: 12 });
    const region = screen.getByRole("region", { name: "Trajectory measurement rows" });
    expect(within(region).getAllByText("2.125")).toHaveLength(12);
    expect(within(region).getAllByText("1 missing frames; 1 uncertain links; 1 hypotheses")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Next measurements" }));
    expect(await screen.findByText("13–14 of 14")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next measurements" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous measurements" }));
    expect(await screen.findByText("1–12 of 14")).toBeVisible();
  });
  it("shows signed XYZ interval velocities and opens their destination frame", async () => {
    const view = setup(); await screen.findByText("1–12 of 14");
    fireEvent.change(screen.getByLabelText("Trajectory measurement table"), { target: { value: "intervals" } });
    const controls = await screen.findAllByRole("button", { name: "Open destination frame" });
    expect(screen.getAllByText("0.375, 0.5, 1.5")).toHaveLength(12);
    fireEvent.click(controls[0]); expect(view.props.onOpenFrame).toHaveBeenCalledWith("later-0");
  });
  it("links keyboard-accessible observations in a labelled XY projection and marks gaps", async () => {
    const view = setup(); fireEvent.click(await screen.findByRole("button", { name: "Track 1" }));
    const plot = screen.getByRole("group", { name: "Selected trajectory in world XY coordinates" });
    expect(plot.querySelector("line")).toHaveAttribute("stroke-dasharray", "5 4");
    fireEvent.keyDown(within(plot).getByRole("button", { name: "Open frame at 8 seconds, object 2" }), { key: "Enter" });
    expect(view.props.onOpenFrame).toHaveBeenCalledWith("later-0");
    expect(screen.getByText(/world XY projection/)).toHaveTextContent("equal axis scale");
  });
  it.each(["revision", "graph", "total", "duplicate", "nonfinite", "cursor"])("rejects mismatched %s before presenting rows", async (mode) => {
    const response = page();
    if (mode === "revision") response.revision_hash = "9".repeat(64);
    if (mode === "graph") response.summary.graph_sha256 = "9".repeat(64);
    if (mode === "total") response.total = 15;
    if (mode === "duplicate") response.rows[1] = response.rows[0];
    if (mode === "nonfinite") (response.rows[0] as ReturnType<typeof track>).mean_speed = Infinity;
    if (mode === "cursor") response.next_offset = 11;
    setup(vi.fn().mockResolvedValue(response));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Track 1" })).not.toBeInTheDocument();
  });
  it("does not display an old page after switching measurement tables", async () => {
    let settle!: (value: unknown) => void;
    const execute = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; })).mockResolvedValue(page(0, "intervals"));
    setup(execute); fireEvent.change(screen.getByLabelText("Trajectory measurement table"), { target: { value: "intervals" } });
    await screen.findAllByRole("button", { name: "Open destination frame" });
    await act(async () => { settle(page()); });
    expect(screen.queryByRole("button", { name: "Track 1" })).not.toBeInTheDocument();
  });
  it("makes pixel units and legacy derivation explicit", async () => {
    const response = page(); response.summary.units = { ...summary.units, position: "pixel", velocity: "pixel/s" }; response.summary.storage = "derived-from-legacy-graph";
    const view = setup(vi.fn().mockResolvedValue(response));
    view.rerender(<TrajectoryMetrics {...view.props} summary={response.summary} />);
    expect(await screen.findByRole("note")).toHaveTextContent("pixels per second");
    expect(screen.getByText(/original saved result remains unchanged/)).toBeVisible();
  });
  it("keeps stationary and singleton directionality undefined", async () => {
    const response = page(); const row = response.rows[0] as ReturnType<typeof track>;
    Object.assign(row, { directionality_ratio: null, directionality_status: "stationary", mean_speed: 0 });
    setup(vi.fn().mockResolvedValue(response));
    expect(await screen.findByText("stationary")).toBeVisible();
  });
  it("offers explicit retry after a failed read", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("Read interrupted")).mockResolvedValue(page()); setup(execute);
    fireEvent.click(await screen.findByRole("button", { name: "Retry measurement page" }));
    await waitFor(() => expect(screen.getByText("1–12 of 14")).toBeVisible());
  });
});
