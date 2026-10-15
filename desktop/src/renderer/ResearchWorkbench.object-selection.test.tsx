// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench from "./ResearchWorkbench";
import type { ResearchDesktopApi, ResearchSnapshot, ResearchLabelsImportBinding, ResearchLabelsImportPreview } from "../shared/research-contracts";

vi.mock("./ResearchPopulationExplorer", () => ({
  ResearchPopulationExplorer: ({ selectedLabel }: { selectedLabel: number | null }) =>
    <output aria-label="Population selected label">{selectedLabel ?? "none"}</output>,
}));

let canvasContext: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  canvasContext = Object.fromEntries(
    [
      "setTransform",
      "fillRect",
      "clearRect",
      "scale",
      "drawImage",
      "beginPath",
      "moveTo",
      "lineTo",
      "closePath",
      "arc",
      "stroke",
      "fillText",
      "setLineDash",
      "save",
      "restore",
      "ellipse",
      "fill",
      "getImageData",
      "putImageData",
    ].map((name) => [name, vi.fn()]),
  );
  canvasContext.getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(16) }));
  canvasContext.createRadialGradient = vi.fn(() => ({
    addColorStop: vi.fn(),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return {
      left: 0,
      top: 0,
      right: 512,
      bottom: 512,
      width: 512,
      height: 512,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Exact object selection and predictable navigation (WP A)", () => {
  const sampleSource = {
    id: "src-1",
    name: "Specimen 1",
    path: "/images/specimen1.tif",
    sha256: "sha-1",
    metadata: {
      format: "OME-TIFF",
      geometry: { axes: "yx", unit: "um", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
      physical_calibration: { unit: "um" },
      dimensions: { x: 512, y: 512, c: 1, z: 1, t: 1 },
      levels: [{ index: 0, dimensions: { x: 512, y: 512, c: 1, z: 1, t: 1 } }],
      channel_names: ["DAPI"],
    },
  };

  const sampleResult = {
    id: "res-1",
    source_id: "src-1",
    source_sha256: "sha-1",
    kind: "cell-segmentation",
    created_at: "2026-09-15T00:00:00Z",
    revision_hash: "rev-hash-abc",
    object_count: 3,
    selection: { x: 0, y: 0, width: 512, height: 512, c: 0, z: 0, t: 0, level: 0 },
    arrays: {
      image: { shape: [512, 512] },
      labels: { shape: [512, 512], dtype: "uint16", sha256: "labels-sha" },
    },
    geometry: { axes: "yx", unit: "um", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
    review: { disposition: "pending" as const },
  };

  const sampleRows = [
    { label: 5, measure: 120, measure_kind: "area", measure_unit: "µm²", centroid_index: [100, 100] },
    { label: 23, measure: 350, measure_kind: "area", measure_unit: "µm²", centroid_index: [200, 200] },
    { label: 104, measure: 50, measure_kind: "area", measure_unit: "µm²", centroid_index: [300, 300] },
  ];

  function buildApi(labelAtImpl?: (args: Record<string, unknown>) => { label: number } | Promise<{ label: number }>): ResearchDesktopApi {
    const snapshot: ResearchSnapshot = {
      project: { title: "Object Selection Study" },
      sources: [sampleSource],
      results: [sampleResult],
      samples: [],
      selections: [],
      recipes: [],
      displays: [],
      jobs: [],
      operations: {},
    };

    return {
      getSnapshot: vi.fn(async () => structuredClone(snapshot)),
      execute: vi.fn(async (op: string, args: Record<string, unknown>) => {
        if (op === "viewer_defaults") {
          return {
            source_id: sampleSource.id,
            source_sha256: sampleSource.sha256,
            basis: "Source acquisition range",
            channels: [{ channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true }],
          };
        }
        if (op === "source_view") {
          return {
            source_id: sampleSource.id,
            source_sha256: sampleSource.sha256,
            revision: 0,
            state: null,
          };
        }
        if (op === "source_annotations") {
          return {
            source_id: sampleSource.id,
            source_sha256: sampleSource.sha256,
            revision: 0,
            annotations: [],
            can_undo: false,
            can_redo: false,
          };
        }
        if (op === "viewer_tile") {
          return {
            image: "data:image/png;base64,viewertile#viewer-512x512",
            source_sha256: sampleSource.sha256,
            source_extent: [512, 512],
            selection: args.selection ?? { t: args.t ?? 0, z: args.z ?? 0, c: args.c ?? 0, z_stop: args.z_stop ?? null },
            projection: args.projection ?? null,
            width: 512,
            height: 512,
          };
        }
        if (op === "result") {
          return {
            result: sampleResult,
            measurements: sampleRows,
          };
        }
        if (op === "result_view") {
          return {
            image: "data:image/png;base64,resultview",
            result_id: sampleResult.id,
            revision_hash: sampleResult.revision_hash,
            axis: args.axis ?? "z",
            index: args.index ?? 0,
            shape: [512, 512],
            display: {},
            geometry: sampleResult.geometry,
          };
        }
        if (op === "result_label_at") {
          if (labelAtImpl) return { result_id: sampleResult.id, revision_hash: sampleResult.revision_hash, ...await labelAtImpl(args) };
          return {
            result_id: sampleResult.id,
            revision_hash: sampleResult.revision_hash,
            label: 0,
            axis: "z",
            index: 0,
            u: args.u,
            v: args.v,
          };
        }
        return {};
      }),
    } as unknown as ResearchDesktopApi;
  }

  it("retains a checked label preview after reselecting Segment & measure on the active Analyze tool", async () => {
    const api = buildApi();
    api.labelsImportPreview = vi.fn(async (binding: ResearchLabelsImportBinding): Promise<ResearchLabelsImportPreview> => ({ ...binding,
      grant_id: "a".repeat(32), geometry: sampleResult.geometry, file_name: "same-tool.tif", file_sha256: "b".repeat(64),
      file_size_bytes: 1000, original_dtype: "uint32", shape: [512, 512], axes: "YX", object_count: 3,
      labels_sha256: "c".repeat(64), format: "TIFF", profile: "scalar-native-yx/v1", estimated_working_bytes: 1000000,
      measurement_channel: { index: binding.selection.c, name: "Raw channel 1", basis: "raw-source-channel-values" }, calibration_handling: {},
      image: "data:image/png;base64,same-tool-preview", preview_width: 512, preview_height: 512 }));
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
    fireEvent.click(screen.getByText("Import existing labels"));
    await screen.findByRole("button", { name: "Import labels" });
    // Match the packaged journey's complete group + current-tool reselection.
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Analyze tool" }));
    fireEvent.click(screen.getByRole("option", { name: "Segment & measure" }));
    fireEvent.click(screen.getByRole("button", { name: "Import labels" }));
    expect(await screen.findByAltText("Checked label overlay on the selected source plane")).toHaveAttribute("src", "data:image/png;base64,same-tool-preview");
    expect(screen.getByRole("button", { name: "Import on this plane" })).toBeEnabled();
    expect(screen.getByText("same-tool.tif")).toBeVisible();
    expect(api.labelsImportPreview).toHaveBeenCalledTimes(1);
  });

  it.each(["leaving the import pane", "choosing another result"])("uses durable selection CAS and ignores a late import selection response after %s", async (navigation) => {
    const api = buildApi();
    const originalExecute = api.execute;
    const imported = { ...sampleResult, id: "e".repeat(32), revision_hash: "f".repeat(64), kind: "external-labels", review: null };
    let finishSelection!: (value: unknown) => void;
    api.labelsImportPreview = vi.fn(async (binding: ResearchLabelsImportBinding): Promise<ResearchLabelsImportPreview> => ({ ...binding, grant_id: "a".repeat(32), geometry: imported.geometry,
      file_name: "sparse.tif", file_sha256: "b".repeat(64), file_size_bytes: 1000, original_dtype: "uint32", shape: [512, 512], axes: "YX",
      object_count: 3, labels_sha256: "c".repeat(64), format: "TIFF", profile: "scalar-native-yx/v1", estimated_working_bytes: 1000000,
      measurement_channel: { index: binding.selection.c, name: "Raw channel 1", basis: "raw-source-channel-values" }, calibration_handling: {},
      image: "data:image/png;base64,checked", preview_width: 512, preview_height: 512 }));
    api.execute = vi.fn((operation, request) => {
      if (operation === "labels_import") return Promise.resolve({ result: imported, measurements: sampleRows });
      if (operation === "select_result") return new Promise((resolve) => { finishSelection = resolve; });
      return originalExecute(operation, request);
    });
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
    fireEvent.click(screen.getByText("Import existing labels"));
    fireEvent.click(await screen.findByRole("button", { name: "Import labels" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import on this plane" }));
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith("select_result", { result_id: imported.id, revision_hash: imported.revision_hash, expected_revision: 0 }));
    if (navigation === "leaving the import pane") fireEvent.click(screen.getByRole("button", { name: "View" }));
    else fireEvent.click(screen.getByRole("button", { name: /Cell segmentation, 3 objects/ }));
    finishSelection({ result: imported, selection: { id: sampleSource.id, revision: 1, data: { result_id: imported.id, revision_hash: imported.revision_hash } } });
    await waitFor(() => expect(screen.queryByText("Working: Importing labels")).not.toBeInTheDocument());
    expect((api.execute as ReturnType<typeof vi.fn>).mock.calls.some(([operation, request]) => operation === "result" && request.result_id === imported.id)).toBe(false);
    expect(screen.queryByText("external-labels")).not.toBeInTheDocument();
    if (navigation === "choosing another result") expect(screen.getByRole("button", { name: /Cell segmentation, 3 objects/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("selects exact sparse label ID via result_label_at and highlights corresponding table row", async () => {
    const api = buildApi((args) => {
      // If clicking near (200, 200), return label 23
      if (Math.abs(Number(args.u) - 200) < 20 && Math.abs(Number(args.v) - 200) < 20) {
        return { label: 23 };
      }
      return { label: 0 };
    });

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    // Switch to Results group / Review & export
    const resultsBtn = await screen.findByRole("button", { name: "Results" });
    fireEvent.click(resultsBtn);

    const resultBtn = await screen.findByRole("button", { name: /Cell segmentation/ });
    fireEvent.click(resultBtn);

    await waitFor(() => {
      expect(screen.getByText("Quantitative summary")).toBeInTheDocument();
    });

    const target = (document.querySelector(".research-image-frame") || document.querySelector("canvas"))!;
    expect(target).not.toBeNull();
    fireEvent.pointerDown(target, { clientX: 200, clientY: 200, button: 0 });
    fireEvent.pointerUp(target, { clientX: 200, clientY: 200, button: 0 });

    await waitFor(() => {
      const calls = (api.execute as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "result_label_at");
      expect(calls.length).toBeGreaterThan(0);
      const selectedRow = document.querySelector("tr.selected");
      expect(selectedRow).not.toBeNull();
      expect(selectedRow?.textContent).toContain("23");
    });
  });

  it("clears selection when clicking background (label === 0) in cavity or donut hole", async () => {
    let currentLabel = 5;
    const api = buildApi(() => ({ label: currentLabel }));

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    const resultsBtn = await screen.findByRole("button", { name: "Results" });
    fireEvent.click(resultsBtn);
    const resultBtn = await screen.findByRole("button", { name: /Cell segmentation/ });
    fireEvent.click(resultBtn);

    await waitFor(() => {
      expect(screen.getByText("Quantitative summary")).toBeInTheDocument();
    });

    const target = (document.querySelector(".research-image-frame") || document.querySelector("canvas"))!;

    // First click: label 5 (selects object)
    currentLabel = 5;
    fireEvent.pointerDown(target, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerUp(target, { clientX: 100, clientY: 100, button: 0 });

    await waitFor(() => {
      expect(document.querySelector("tr.selected")).not.toBeNull();
    });

    // Second click: inside concave cavity / donut hole -> label 0
    currentLabel = 0;
    fireEvent.pointerDown(target, { clientX: 105, clientY: 105, button: 0 });
    fireEvent.pointerUp(target, { clientX: 105, clientY: 105, button: 0 });

    await waitFor(() => {
      expect(document.querySelector("tr.selected")).toBeNull();
    });
  });

  it("selects correct object even when click on fringe is closer to neighbor centroid", async () => {
    const api = buildApi(() => ({ label: 5 }));

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    const resultsBtn = await screen.findByRole("button", { name: "Results" });
    fireEvent.click(resultsBtn);
    const resultBtn = await screen.findByRole("button", { name: /Cell segmentation/ });
    fireEvent.click(resultBtn);

    await waitFor(() => {
      expect(screen.getByText("Quantitative summary")).toBeInTheDocument();
    });

    const target = (document.querySelector(".research-image-frame") || document.querySelector("canvas"))!;
    fireEvent.pointerDown(target, { clientX: 108, clientY: 100, button: 0 });
    fireEvent.pointerUp(target, { clientX: 108, clientY: 100, button: 0 });

    await waitFor(() => {
      const selected = document.querySelector("tr.selected");
      expect(selected).not.toBeNull();
      expect(selected?.textContent).toContain("5");
    });
  });

  it("discards stale async pick response if a newer pick has started", async () => {
    let delayedResolve: (value: unknown) => void;
    let callCount = 0;

    const api = buildApi(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => {
          delayedResolve = () => resolve({ label: 5 });
        }) as any;
      }
      return { label: 104 };
    });

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    const resultsBtn = await screen.findByRole("button", { name: "Results" });
    fireEvent.click(resultsBtn);
    const resultBtn = await screen.findByRole("button", { name: /Cell segmentation/ });
    fireEvent.click(resultBtn);

    await waitFor(() => {
      expect(screen.getByText("Quantitative summary")).toBeInTheDocument();
    });

    const target = (document.querySelector(".research-image-frame") || document.querySelector("canvas"))!;

    // Click 1 (triggers delayed response for label 5)
    fireEvent.pointerDown(target, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerUp(target, { clientX: 50, clientY: 50, button: 0 });

    // Click 2 (immediately resolves with label 104)
    fireEvent.pointerDown(target, { clientX: 300, clientY: 300, button: 0 });
    fireEvent.pointerUp(target, { clientX: 300, clientY: 300, button: 0 });

    await waitFor(() => {
      const selected = document.querySelector("tr.selected");
      expect(selected).not.toBeNull();
      expect(selected?.textContent).toContain("104");
    });

    // Now resolve click 1's delayed response
    delayedResolve!({});

    // Selection should STILL be 104, NOT reverted to 5!
    await new Promise((r) => setTimeout(r, 50));
    const selectedAfter = document.querySelector("tr.selected");
    expect(selectedAfter?.textContent).toContain("104");
  });

  it("selects row from table and preserves camera scale without forced zoom", async () => {
    const api = buildApi();
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    const resultsBtn = await screen.findByRole("button", { name: "Results" });
    fireEvent.click(resultsBtn);
    const resultBtn = await screen.findByRole("button", { name: /Cell segmentation/ });
    fireEvent.click(resultBtn);

    await waitFor(() => {
      expect(screen.getByText("Quantitative summary")).toBeInTheDocument();
    });

    const rows = document.querySelectorAll("tr[role='row']");
    expect(rows.length).toBeGreaterThan(1);

    // Click on row 1 (label 5)
    fireEvent.click(rows[1]);

    await waitFor(() => {
      expect(rows[1]).toHaveClass("selected");
    });
  });
  it("resolves an image-picked object absent from the loaded measurement page", async () => {
    const api = buildApi(() => ({ label: 999 }));
    const original = api.execute;
    api.execute = vi.fn(async (operation, request, options) => {
      if (operation === "population_query") return {
        result_id: sampleResult.id, revision_hash: sampleResult.revision_hash,
        source_id: sampleSource.id, source_sha256: sampleSource.sha256,
        selected: { row: { label: 999, centroid_index: [200, 200] }, filtered_index: 998 },
      };
      return original(operation, request, options);
    });
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Results" }));
    fireEvent.click(await screen.findByRole("button", { name: /Cell segmentation/ }));
    await screen.findByText("Quantitative summary");
    fireEvent.click(screen.getByRole("button", { name: "Search all tools" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search all tools" }), { target: { value: "Statistics & objects" } });
    fireEvent.click(screen.getByRole("option", { name: "Statistics & objects" }));
    const target = (document.querySelector(".research-image-frame") || document.querySelector("canvas"))!;
    fireEvent.pointerDown(target, { clientX: 200, clientY: 200, button: 0 });
    fireEvent.pointerUp(target, { clientX: 200, clientY: 200, button: 0 });
    await waitFor(() => expect(screen.getByLabelText("Population selected label")).toHaveTextContent("999"));
    expect(api.execute).toHaveBeenCalledWith("population_query", {
      result_id: sampleResult.id, revision_hash: sampleResult.revision_hash, selected_label: 999, limit: 1,
    });
  });

  it("rejects an image pick bound to a different result revision", async () => {
    const api = buildApi(() => ({ label: 23, revision_hash: "wrong-revision" }));
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Results" }));
    fireEvent.click(await screen.findByRole("button", { name: /Cell segmentation/ }));
    await screen.findByText("Quantitative summary");
    const target = (document.querySelector(".research-image-frame") || document.querySelector("canvas"))!;
    fireEvent.pointerDown(target, { clientX: 200, clientY: 200, button: 0 });
    fireEvent.pointerUp(target, { clientX: 200, clientY: 200, button: 0 });
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith("result_label_at", expect.any(Object)));
    expect(document.querySelector("tr.selected")).toBeNull();
  });

});
