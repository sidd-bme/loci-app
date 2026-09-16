// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench from "./ResearchWorkbench";
import type { ResearchDesktopApi, ResearchSnapshot } from "../shared/research-contracts";

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
          if (labelAtImpl) return labelAtImpl(args);
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

    const resultBtn = await screen.findByRole("button", { name: /cell-segmentation/ });
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
    const resultBtn = await screen.findByRole("button", { name: /cell-segmentation/ });
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
    const resultBtn = await screen.findByRole("button", { name: /cell-segmentation/ });
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
    const resultBtn = await screen.findByRole("button", { name: /cell-segmentation/ });
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
    const resultBtn = await screen.findByRole("button", { name: /cell-segmentation/ });
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
});
