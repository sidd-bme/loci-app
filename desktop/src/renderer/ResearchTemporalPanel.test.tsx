// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchResult,
  ResearchSnapshot,
} from "../shared/research-contracts";
import { ResearchTemporalPanel, type TrackingGraph } from "./ResearchTemporalPanel";

afterEach(cleanup);

const ids = ["1".repeat(32), "2".repeat(32), "3".repeat(32)];
const sourceId = "a".repeat(32);
const results: ResearchResult[] = ids.slice(0, 2).map((id, index) => ({
  id,
  source_id: sourceId,
  kind: index ? "corrected-labels" : "segmentation",
  created_at: "now",
  revision_hash: String(index + 4).repeat(64),
  object_count: 1,
  parent_id: index ? ids[0] : null,
  arrays: {
    image: { shape: [8, 10], dtype: "float64" },
    labels: { shape: [8, 10], dtype: "uint32" },
  },
  selection: {
    x: 0,
    y: 0,
    width: 10,
    height: 8,
    t: index,
    c: 0,
    z: 0,
    level: 0,
  },
}));
const snapshot: ResearchSnapshot = {
  project: { title: "Timed study" },
  sources: [
    {
      id: sourceId,
      name: "Time series",
      sha256: "b".repeat(64),
      metadata: {
        timing: { source: "ome-plane-delta-t", elapsed_times: [0, 7], interval_unit: "s" },
      },
    },
  ],
  results,
  samples: [],
  recipes: [],
  displays: [],
  selections: [],
  jobs: [],
  operations: {},
};
const graph: TrackingGraph = {
  frames: [
    {
      frame_id: ids[0],
      time_s: 0,
      detections: [{ label: "1", centroid_world_xyz: [1, 2, 0], measure: 3 }],
    },
    {
      frame_id: ids[1],
      time_s: 7,
      detections: [{ label: "2", centroid_world_xyz: [2, 2, 0], measure: 4 }],
    },
  ],
  edges: [
    {
      source_frame_id: ids[0],
      source_label: "1",
      target_frame_id: ids[1],
      target_label: "2",
      cost: 1,
      gap: 0,
      identity_uncertain: true,
      provenance: "automatic",
    },
  ],
  hypotheses: [
    {
      kind: "ambiguous",
      frame_id: ids[0],
      label: "1",
      candidate_frame_id: ids[1],
      candidate_labels: ["2", "3"],
      reason: "near-tied distance-gated candidates",
    },
    {
      kind: "split_or_merge",
      frame_id: ids[0],
      label: "1",
      candidate_frame_id: ids[1],
      candidate_labels: ["2", "3"],
      reason: "one source has multiple plausible targets",
    },
    {
      kind: "split_or_merge",
      frame_id: ids[1],
      label: "2",
      candidate_frame_id: ids[0],
      candidate_labels: ["1", "4"],
      reason: "one target has multiple plausible sources",
    },
  ],
  trajectories: [
    [
      {
        frame_id: ids[0],
        label: "1",
        time_s: 0,
        centroid_world_xyz: [1, 2, 0],
        measure: 3,
        displacement: 0,
        path_length: 0,
        speed: null,
        gap_before: null,
      },
    ],
  ],
};

function api(execute: ResearchDesktopApi["execute"]): ResearchDesktopApi {
  return {
    createStudy: vi.fn(),
    openStudy: vi.fn(),
    getSnapshot: vi.fn(),
    addSources: vi.fn(),
    execute,
    reviewResult: vi.fn(),
    exportResult: vi.fn(),
    cancelJob: vi.fn(),
  };
}

function renderPanel(execute: ResearchDesktopApi["execute"], custom = snapshot) {
  const onPublished = vi.fn().mockResolvedValue(undefined);
  render(
    <ResearchTemporalPanel
      api={api(execute)}
      snapshot={custom}
      report={async (work) => work()}
      busy={false}
      onBusyChange={vi.fn()}
      onOpenResult={vi.fn().mockResolvedValue(undefined)}
      onPublished={onPublished}
    />,
  );
  return onPublished;
}

describe("ResearchTemporalPanel", () => {
  it("prefills actual seconds from an explicitly declared uniform OME cadence", () => {
    renderPanel(vi.fn(), {
      ...snapshot,
      sources: [{ ...snapshot.sources[0], metadata: {
        timing: { source: "ome-time-increment", elapsed_times: [], uniform_interval: 5, interval_unit: "s" },
      } }],
    });
    screen.getAllByText("Add frame").forEach((button) => fireEvent.click(button));
    expect(screen.getByLabelText("Frame 1 elapsed seconds")).toHaveValue(0);
    expect(screen.getByLabelText("Frame 2 elapsed seconds")).toHaveValue(5);
    expect(screen.getByLabelText("Confirm actual elapsed seconds")).not.toBeChecked();
  });

  it.each([
    { source: "ome-plane-delta-t", uniform_interval: 5, interval_unit: "s" },
    { source: "ome-time-increment", uniform_interval: 5, interval_unit: "min" },
    { source: "ome-time-increment", uniform_interval: -1, interval_unit: "s" },
    { source: "ome-time-increment", uniform_interval: Number.POSITIVE_INFINITY, interval_unit: "s" },
  ])("does not infer missing acquisition times from invalid or unrelated cadence metadata: %j", (timing) => {
    renderPanel(vi.fn(), {
      ...snapshot,
      sources: [{ ...snapshot.sources[0], metadata: { timing } }],
    });
    screen.getAllByText("Add frame").forEach((button) => fireEvent.click(button));
    expect(screen.getByLabelText("Frame 1 elapsed seconds")).toHaveValue(null);
    expect(screen.getByLabelText("Frame 2 elapsed seconds")).toHaveValue(null);
    expect(screen.getByText("Create temporal graph")).toBeDisabled();
  });

  it("submits exact ordered frames with verified elapsed seconds and physical tracking settings", async () => {
    const temporal: ResearchResult = {
      ...results[0],
      id: ids[2],
      revision_hash: "6".repeat(64),
      kind: "temporal-tracking",
      parent_id: results[0].id,
    };
    const execute = vi.fn().mockResolvedValue({
      result: temporal,
      tracking: graph,
      units: { position: "um", time: "s", speed: "um/s" },
    });
    const onPublished = renderPanel(execute);
    screen.getAllByText("Add frame").forEach((button) => fireEvent.click(button));
    expect(screen.getByLabelText("Frame 1 elapsed seconds")).toHaveValue(0);
    expect(screen.getByLabelText("Frame 2 elapsed seconds")).toHaveValue(7);
    fireEvent.click(screen.getByLabelText("Confirm actual elapsed seconds"));
    fireEvent.change(screen.getByLabelText("Tracking drift adjustment"), {
      target: { value: "translation" },
    });
    fireEvent.click(screen.getByText("Create temporal graph"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith("track_results", {
        frames: [
          { result_id: results[0].id, revision_hash: results[0].revision_hash, time_s: 0 },
          { result_id: results[1].id, revision_hash: results[1].revision_hash, time_s: 7 },
        ],
        time_declaration:
          "Elapsed times are actual seconds; manual entries replace unavailable verified metadata.",
        max_distance: 10,
        max_gap_frames: 0,
        ambiguity_distance: 1e-9,
        registration: {
          method: "translation",
          upsample_factor: 20,
          min_normalized_correlation: 0.25,
        },
        working_bytes: 512 * 1024 ** 2,
      }),
    );
    expect(onPublished).toHaveBeenCalledWith(temporal);
    expect(screen.getByText("Unresolved automatic hypotheses")).toBeVisible();
    expect(screen.getAllByText(/remains an unresolved automatic hypothesis/)).toHaveLength(3);
    expect(screen.getByText(/one source has multiple plausible targets/)).toHaveTextContent(
      "split_or_merge: 11111111:1 → 22222222 candidates 2, 3",
    );
    expect(screen.getByText(/one target has multiple plausible sources/)).toHaveTextContent(
      "split_or_merge: 22222222:2 → 11111111 candidates 1, 4",
    );
    expect(
      screen.getByText(/Associations describe observations, not biological lineage or identity/),
    ).toBeVisible();
  });

  it("requires every missing observation to carry an ID, reason, and increasing time", () => {
    renderPanel(vi.fn());
    fireEvent.click(screen.getByText("Add missing observation"));
    expect(screen.getByText(/Every frame needs a finite time/)).toBeVisible();
    expect(screen.getByText(/needs a unique ID and explicit reason/)).toBeVisible();
    expect(screen.getByText("Create temporal graph")).toBeDisabled();
  });

  it("replaces an acquisition with its chosen correction revision instead of duplicating a frame", async () => {
    const corrected: ResearchResult = {
      ...results[0],
      id: "c".repeat(32),
      revision_hash: "d".repeat(64),
      kind: "corrected-labels",
      parent_id: results[0].id,
    };
    const custom = { ...snapshot, results: [results[0], corrected, results[1]] };
    const temporal: ResearchResult = {
      ...corrected,
      id: ids[2],
      revision_hash: "6".repeat(64),
      kind: "temporal-tracking",
      parent_id: corrected.id,
    };
    const execute = vi.fn().mockResolvedValue({ result: temporal, tracking: graph });
    renderPanel(execute, custom);
    const add = screen.getAllByText("Add frame");
    fireEvent.click(add[0]);
    fireEvent.click(add[1]);
    fireEvent.click(add[2]);
    expect(screen.getAllByLabelText(/Frame \d elapsed seconds/)).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("Confirm actual elapsed seconds"));
    fireEvent.click(screen.getByText("Create temporal graph"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "track_results",
        expect.objectContaining({
          frames: [
            { result_id: corrected.id, revision_hash: corrected.revision_hash, time_s: 0 },
            { result_id: results[1].id, revision_hash: results[1].revision_hash, time_s: 7 },
          ],
        }),
      ),
    );
  });

  it("publishes an exact edge removal as a new immutable child revision", async () => {
    const temporal: ResearchResult = {
      ...results[0],
      id: ids[2],
      revision_hash: "6".repeat(64),
      kind: "temporal-tracking",
      parent_id: results[0].id,
    };
    const corrected: ResearchResult = {
      ...temporal,
      id: "7".repeat(32),
      revision_hash: "8".repeat(64),
      parent_id: temporal.id,
    };
    const withTemporal = { ...snapshot, results: [...results, temporal] };
    const execute = vi.fn((operation: string) =>
      operation === "tracking_result"
        ? Promise.resolve({ result: temporal, tracking: graph, units: { position: "um" } })
        : Promise.resolve({ result: corrected, tracking: { ...graph, edges: [] } }),
    );
    const onPublished = renderPanel(execute, withTemporal);
    fireEvent.change(screen.getByLabelText("Tracking result revision"), {
      target: { value: temporal.id },
    });
    fireEvent.click(screen.getByText("Inspect graph"));
    await screen.findByText("Observed associations");
    fireEvent.change(screen.getByLabelText("Association to remove"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByText("Publish corrected graph revision"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith("correct_tracks", {
        result_id: temporal.id,
        revision_hash: temporal.revision_hash,
        changes: [
          {
            op: "remove",
            source_frame_id: ids[0],
            source_label: "1",
            target_frame_id: ids[1],
            target_label: "2",
          },
        ],
      }),
    );
    expect(onPublished).toHaveBeenLastCalledWith(corrected);
  });
});
