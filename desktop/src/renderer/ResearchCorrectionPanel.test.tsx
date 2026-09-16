// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchResult,
} from "../shared/research-contracts";
import { ResearchCorrectionPanel, type Point } from "./ResearchCorrectionPanel";

afterEach(cleanup);

const parent: ResearchResult = {
  id: "a".repeat(32),
  source_id: "b".repeat(32),
  kind: "segmentation",
  created_at: "now",
  revision_hash: "c".repeat(64),
  object_count: 2,
  parent_id: null,
  review: { disposition: "reviewed" },
};
const child: ResearchResult = {
  ...parent,
  id: "d".repeat(32),
  kind: "corrected-labels",
  revision_hash: "e".repeat(64),
  parent_id: parent.id,
  review: null,
};
const info = {
  result_id: parent.id,
  revision_hash: parent.revision_hash,
  label_sha256: "f".repeat(64),
  shape: [4, 8, 10],
  label_ids: [1, 3],
  parent_id: null,
  measurement_channels: Array.from({ length: 20 }, (_, index) => ({
    index,
    name: `Raw channel ${index + 1}`,
    basis: "raw-source-channel-values",
  })),
  derived_measurement_arrays: null,
};

function bridge(execute: ResearchDesktopApi["execute"]): ResearchDesktopApi {
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

function props(api: ResearchDesktopApi, points: Point[] = []) {
  return {
    api,
    result: parent,
    points,
    setPoints: vi.fn(),
    report: async <T,>(work: () => Promise<T>) => {
      try {
        return await work();
      } catch {
        return undefined;
      }
    },
    onResult: vi.fn().mockResolvedValue(true),
    onUndo: vi.fn().mockResolvedValue(undefined),
    onRedo: vi.fn().mockResolvedValue(undefined),
    onViewChange: vi.fn(),
    onPreviewChange: vi.fn(),
    onMutationBusyChange: vi.fn(),
    planeSpacing: { u: 0.5, v: 2, unit: "um" },
    viewReady: true,
    busy: false,
    canUndo: true,
    canRedo: true,
  };
}

describe("ResearchCorrectionPanel", () => {
  it("uses the smallest unused uint32 ID for polygon add and requires an unreviewed child", async () => {
    const execute = vi.fn((operation: string) =>
      operation === "correction_info"
        ? Promise.resolve(info)
        : operation === "correct_result"
          ? Promise.resolve({ result: child, measurements: [] })
          : Promise.resolve({}),
    );
    render(
      <ResearchCorrectionPanel
        {...props(bridge(execute), [
          { u: 1, v: 1 },
          { u: 5, v: 1 },
          { u: 3, v: 5 },
        ])}
      />,
    );
    await screen.findByText(/Exact label SHA-256/);
    fireEvent.change(screen.getByLabelText("Correction tool"), {
      target: { value: "add" },
    });
    expect(screen.getByLabelText("New unused label ID")).toHaveValue(2);
    fireEvent.click(screen.getByText("Commit add polygon"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "correct_result",
        expect.objectContaining({
          operations: [
            expect.objectContaining({
              op: "polygon_add",
              label: 2,
              expected_input_sha256: info.label_sha256,
            }),
          ],
        }),
      ),
    );
  });

  it("merges only explicit labels and retains a target from that selection", async () => {
    const execute = vi.fn((operation: string) =>
      operation === "correction_info"
        ? Promise.resolve(info)
        : operation === "correct_result"
          ? Promise.resolve({ result: child })
          : Promise.resolve({}),
    );
    render(<ResearchCorrectionPanel {...props(bridge(execute))} />);
    await screen.findByText(/Exact label SHA-256/);
    expect(screen.getByLabelText("Merge label 1")).toBeChecked();
    expect(screen.getByLabelText("Merge label 3")).toBeChecked();
    fireEvent.change(screen.getByLabelText("Retained merge label"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByText("Merge selected labels"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "correct_result",
        expect.objectContaining({
          operations: [
            expect.objectContaining({
              op: "merge",
              source_labels: [1, 3],
              target_label: 3,
            }),
          ],
        }),
      ),
    );
  });

  it("accumulates 3D seeds with the correct XYZ mapping across XY and XZ planes", async () => {
    const execute = vi.fn((operation: string) =>
      operation === "correction_info"
        ? Promise.resolve(info)
        : operation === "correct_result"
          ? Promise.resolve({ result: child })
          : Promise.resolve({}),
    );
    const api = bridge(execute);
    const stable = props(api, [{ u: 4, v: 5 }]);
    const { rerender } = render(<ResearchCorrectionPanel {...stable} />);
    await screen.findByText(/Exact label SHA-256/);
    fireEvent.change(screen.getByLabelText("Correction tool"), {
      target: { value: "split" },
    });
    fireEvent.change(screen.getByLabelText("Split mode"), {
      target: { value: "3D" },
    });
    fireEvent.click(screen.getByText("Add drawn 3D seeds"));
    fireEvent.change(screen.getByLabelText("Correction plane"), {
      target: { value: "XZ" },
    });
    fireEvent.change(screen.getByLabelText("Correction plane index"), {
      target: { value: "6" },
    });
    rerender(<ResearchCorrectionPanel {...stable} points={[{ u: 7, v: 2 }]} />);
    fireEvent.click(screen.getByText("Add drawn 3D seeds"));
    expect(screen.getByText(/2 saved XYZ seeds/)).toBeVisible();
    fireEvent.click(screen.getByText("Commit seeded split"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "correct_result",
        expect.objectContaining({
          operations: [
            expect.objectContaining({
              mode: "3D",
              seeds: [
                { x: 4, y: 5, z: 0 },
                { x: 7, y: 6, z: 2 },
              ],
            }),
          ],
        }),
      ),
    );
  });

  it("uses a one-plane ROI slab and offers no more than 16 explicit raw channels", async () => {
    const twoDimensional = { ...info, shape: [8, 10] };
    const execute = vi.fn((operation: string) =>
      operation === "correction_info"
        ? Promise.resolve(twoDimensional)
        : operation === "roi_add"
          ? Promise.resolve({ result: { ...child, kind: "annotated-result" } })
          : Promise.resolve({}),
    );
    render(
      <ResearchCorrectionPanel
        {...props(bridge(execute), [
          { u: 1, v: 1 },
          { u: 5, v: 1 },
          { u: 3, v: 5 },
        ])}
      />,
    );
    await screen.findByText(/Exact label SHA-256/);
    fireEvent.change(screen.getByLabelText("Correction tool"), {
      target: { value: "roi" },
    });
    expect(screen.getByLabelText("ROI slab start")).toHaveValue(0);
    expect(screen.getByLabelText("ROI slab stop")).toHaveValue(1);
    expect(screen.getAllByLabelText(/Measure Raw channel/)).toHaveLength(16);
    fireEvent.click(screen.getByText("Add measured ROI"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "roi_add",
        expect.objectContaining({
          roi: expect.objectContaining({
            slab_start: 0,
            slab_stop_exclusive: 1,
          }),
          measurement_channels: [0],
        }),
      ),
    );
  });

  it("locks every competing revision action while a mutation is pending", async () => {
    let resolve!: (value: unknown) => void;
    const execute = vi.fn((operation: string) =>
      operation === "correction_info"
        ? Promise.resolve(info)
        : operation === "correct_result"
          ? new Promise((done) => {
              resolve = done;
            })
          : Promise.resolve({}),
    );
    render(<ResearchCorrectionPanel {...props(bridge(execute))} />);
    await screen.findByText(/Exact label SHA-256/);
    fireEvent.click(screen.getByText("Delete selected label"));
    await waitFor(() =>
      expect(screen.getByText("Undo revision")).toBeDisabled(),
    );
    expect(screen.getByText("Redo revision")).toBeDisabled();
    expect(screen.getByText("Merge selected labels")).toBeDisabled();
    expect(screen.getByLabelText("Correction plane")).toBeDisabled();
    resolve({ result: child });
    await waitFor(() =>
      expect(screen.getByText("Undo revision")).toBeEnabled(),
    );
  });

  it("loads an exact label boundary and commits only one selected vertex after preview", async () => {
    const vertices = [
      { u: 2, v: 2 },
      { u: 6, v: 2 },
      { u: 6, v: 6 },
      { u: 2, v: 6 },
    ];
    const execute = vi.fn((operation: string, request: Record<string, unknown>) =>
      operation === "correction_info" && "label" in request
        ? Promise.resolve({
            ...info,
            boundary: {
              label: 1,
              plane: "XY",
              index: 0,
              plane_axes_uv: ["X", "Y"],
              vertices_uv: vertices,
              world_vertices_xyz: vertices.map((point) => [point.u * 0.5, point.v * 2, 0]),
              geometry_sha256: "9".repeat(64),
              distance_unit: "um",
              world_frame: "image",
              coordinate_convention: "zero-based voxel-center UV; world XYZ",
              simplified: false,
            },
          })
        : operation === "correction_info"
          ? Promise.resolve(info)
          : operation === "correct_result"
            ? Promise.resolve({ result: child })
            : Promise.resolve({}),
    );
    const stable = props(bridge(execute));
    const setPoints = vi.mocked(stable.setPoints);
    const { rerender } = render(<ResearchCorrectionPanel {...stable} />);
    await screen.findByText(/Exact label SHA-256/);
    fireEvent.change(screen.getByLabelText("Correction tool"), {
      target: { value: "vertex" },
    });
    await screen.findByText(/Vertex 1 of 4 on XY 0/);
    await waitFor(() => expect(setPoints).toHaveBeenCalledWith(vertices));
    expect(execute).toHaveBeenCalledWith("correction_info", {
      result_id: parent.id,
      revision_hash: parent.revision_hash,
      label: 1,
      plane: "XY",
      index: 0,
    });
    expect(execute).not.toHaveBeenCalledWith("correct_result", expect.anything());

    rerender(<ResearchCorrectionPanel {...stable} points={vertices} />);
    fireEvent.click(screen.getByLabelText("Nudge selected vertex left one voxel"));
    const edited = [
      { u: 1, v: 2 },
      ...vertices.slice(1),
    ];
    expect(setPoints).toHaveBeenLastCalledWith(edited);
    rerender(<ResearchCorrectionPanel {...stable} points={edited} />);
    expect(screen.getByText("Commit boundary vertex")).toBeEnabled();
    fireEvent.click(screen.getByText("Commit boundary vertex"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith("correct_result", {
        result_id: parent.id,
        revision_hash: parent.revision_hash,
        operations: [
          {
            op: "move_boundary_vertex",
            expected_input_sha256: info.label_sha256,
            plane: "XY",
            index: 0,
            label: 1,
            source_vertices: vertices,
            vertices: edited,
          },
        ],
      }),
    );
  });

  it("keeps ROI available without labels and names exact registered-derived values", async () => {
    const imageOnly = {
      ...info,
      label_sha256: null,
      label_ids: [],
      measurement_channels: [
        {
          index: 0,
          name: "REGISTERED-DERIVED:image",
          basis: "REGISTERED-DERIVED scalar values",
        },
      ],
      derived_measurement_arrays: ["image"],
    };
    const execute = vi.fn((operation: string) =>
      operation === "correction_info"
        ? Promise.resolve(imageOnly)
        : operation === "roi_add"
          ? Promise.resolve({ result: { ...child, kind: "annotated-result" } })
          : Promise.resolve({}),
    );
    render(
      <ResearchCorrectionPanel
        {...props(bridge(execute), [
          { u: 1, v: 1 },
          { u: 5, v: 1 },
          { u: 3, v: 5 },
        ])}
      />,
    );
    await screen.findByText(/No label array: ROI measurement only/);
    expect(screen.getByLabelText("Correction tool")).toHaveValue("roi");
    expect(screen.getByRole("option", { name: "Add polygon" })).toBeDisabled();
    expect(screen.getByLabelText("Measure REGISTERED-DERIVED:image")).toBeChecked();
    expect(screen.getByText(/Measurement basis: REGISTERED-DERIVED/)).toBeVisible();
    fireEvent.click(screen.getByText("Add measured ROI"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "roi_add",
        expect.objectContaining({ measurement_channels: [0] }),
      ),
    );
  });
});
