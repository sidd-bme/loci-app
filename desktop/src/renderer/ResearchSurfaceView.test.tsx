// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchResult,
} from "../shared/research-contracts";
import {
  ResearchSurfaceView,
  rotateWorld,
  type SurfaceMesh,
} from "./ResearchSurfaceView";

const result: ResearchResult = {
  id: "a".repeat(32),
  source_id: "b".repeat(32),
  revision_hash: "c".repeat(64),
  kind: "segmentation",
  created_at: "fixture",
  object_count: 1,
  parent_id: null,
  arrays: { image: { shape: [10, 12, 14] }, labels: { shape: [10, 12, 14] } },
  review: null,
};
const mesh: SurfaceMesh = {
  schema: "loci.surface-display/v1",
  vertices_world_xyz: [
    [1, 2, 3],
    [2, 2, 3],
    [1, 4, 3],
  ],
  faces: [[0, 1, 2]],
  world_bounds: [
    [0, 0, 0],
    [4, 4, 4],
  ],
  geometry: { unit: "mm", frame: "LPS" },
  source_shape: [10, 12, 14],
  display_shape: [10, 12, 14],
  strides_zyx: [1, 1, 1],
  marching_step: 1,
  isovalue: 50,
  display_range: [0, 100],
  purpose: "display only",
  mode: "intensity",
  binding: { result_id: result.id, revision_hash: result.revision_hash },
  adopted: false,
};
const selection = {
  x: 0,
  y: 0,
  width: 14,
  height: 12,
  c: 0,
  z: 0,
  z_stop: 10,
  t: 0,
  level: 0,
};
let context: Record<string, unknown>;
beforeEach(() => {
  context = Object.fromEntries(
    [
      "setTransform",
      "fillRect",
      "beginPath",
      "moveTo",
      "lineTo",
      "closePath",
      "fill",
      "stroke",
      "fillText",
    ].map((name) => [name, vi.fn()]),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function bridge(execute: ResearchDesktopApi["execute"]): ResearchDesktopApi {
  return {
    execute,
    createStudy: vi.fn(),
    openStudy: vi.fn(),
    getSnapshot: vi.fn(),
    addSources: vi.fn(),
    reviewResult: vi.fn(),
    exportResult: vi.fn(),
    cancelJob: vi.fn(),
  };
}

describe("calibrated surface display", () => {
  it("uses world XYZ rotation without swapping axes or changing vector length", () => {
    expect(rotateWorld([2, 3, 4], 0, 0)).toEqual([2, 3, 4]);
    const rotated = rotateWorld([2, 3, 4], 0.3, -0.5);
    expect(Math.hypot(...rotated)).toBeCloseTo(Math.hypot(2, 3, 4), 12);
    expect(rotateWorld([1, 0, 0], Math.PI / 2, 0)[2]).toBeCloseTo(-1, 12);
  });
  it("draws only a verified read-only result mesh and orbits without new analysis", async () => {
    const execute = vi.fn().mockResolvedValue(mesh);
    render(
      <ResearchSurfaceView
        api={bridge(execute)}
        sourceId={result.source_id}
        selection={selection}
        result={result}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Build surface"));
    const canvas = await screen.findByLabelText(
      /Interactive world-coordinate surface/,
    );
    expect(execute).toHaveBeenCalledWith("surface_view", {
      result_id: result.id,
      revision_hash: result.revision_hash,
      mode: "intensity",
      max_edge: 80,
    });
    await waitFor(() => {
      expect(context.fill).toHaveBeenCalled();
      expect(context.fillText).toHaveBeenCalledWith("World LPS · mm", 12, 20);
    });
    expect(screen.getByLabelText("Surface display level")).toHaveValue(50);
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(execute).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Surface display level"), {
      target: { value: "75" },
    });
    expect(
      screen.queryByLabelText(/Interactive world-coordinate surface/),
    ).not.toBeInTheDocument();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("rejects a mesh from another immutable revision", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({
        ...mesh,
        binding: { ...mesh.binding, revision_hash: "f".repeat(64) },
      });
    render(
      <ResearchSurfaceView
        api={bridge(execute)}
        sourceId={result.source_id}
        selection={selection}
        result={result}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Build surface"));
    expect(await screen.findByRole("alert")).toHaveTextContent("did not match");
    expect(
      screen.queryByLabelText(/Interactive world-coordinate surface/),
    ).not.toBeInTheDocument();
  });
  it("discards a delayed surface when the selected source changes", async () => {
    let resolve!: (value: unknown) => void;
    const execute = vi.fn(
      () =>
        new Promise<unknown>((done) => {
          resolve = done;
        }),
    );
    const api = bridge(execute);
    const view = render(
      <ResearchSurfaceView
        api={api}
        sourceId={result.source_id}
        selection={selection}
        result={null}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Build surface"));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    view.rerender(
      <ResearchSurfaceView
        api={api}
        sourceId={"d".repeat(32)}
        selection={selection}
        result={null}
        onClose={vi.fn()}
      />,
    );
    await act(async () =>
      resolve({ ...mesh, binding: { source_id: result.source_id } }),
    );
    expect(
      screen.queryByLabelText(/Interactive world-coordinate surface/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Build surface")).toBeEnabled();
  });
});
