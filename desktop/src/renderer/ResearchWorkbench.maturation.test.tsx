// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench, { findNearestObject } from "./ResearchWorkbench";
import type { ResearchDesktopApi, ResearchSnapshot } from "../shared/research-contracts";

let canvasContext: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
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
    ].map((name) => [name, vi.fn()]),
  );
  canvasContext.createRadialGradient = vi.fn(() => ({
    addColorStop: vi.fn(),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 64;
      naturalHeight = 48;
      private value = "";
      set src(value: string) {
        this.value = value;
        const match = value.match(/#viewer-(\d+)x(\d+)$/);
        if (match) {
          this.naturalWidth = Number(match[1]);
          this.naturalHeight = Number(match[2]);
        }
        queueMicrotask(() => this.onload?.());
      }
      get src() {
        return this.value;
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("findNearestObject spatial picking", () => {
  const dummyView2D = {
    image: "data:image/png;base64,view",
    shape: [100, 100],
    resultId: "res-1",
    revisionHash: "rev-1",
    axis: "z" as const,
    index: 0,
    geometry: { axes: "yx", unit: "pixel", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
  };

  it("returns null when no rows are provided", () => {
    expect(findNearestObject({ u: 50, v: 50 }, [], dummyView2D)).toBeNull();
  });

  it("picks the closest 2D object centroid within default maxDistance", () => {
    const rows = [
      { label: 1, centroid_index: [10, 10], area: 50 },
      { label: 2, centroid_index: [50, 50], area: 50 }, // u = 50, v = 50
      { label: 3, centroid_index: [80, 80], area: 50 },
    ];
    const picked = findNearestObject({ u: 52, v: 48 }, rows, dummyView2D);
    expect(picked).toBe(1); // index 1 is row label 2
  });

  it("returns null if click is beyond maxDistance for small objects", () => {
    const rows = [
      { label: 1, centroid_index: [10, 10], area: 10 },
    ];
    expect(findNearestObject({ u: 100, v: 100 }, rows, dummyView2D, 20)).toBeNull();
  });

  it("allows clicking anywhere across a large object using area-derived radius", () => {
    const rows = [
      { label: 1, centroid_index: [100, 100], area: 10000 },
    ];
    const picked = findNearestObject({ u: 140, v: 100 }, rows, dummyView2D, 25);
    expect(picked).toBe(0);
  });

  it("filters 3D objects by current z plane index", () => {
    const viewZ2 = {
      ...dummyView2D,
      axis: "z" as const,
      index: 2,
    };
    const rows = [
      { label: 1, centroid_index: [0, 50, 50] },
      { label: 2, centroid_index: [2, 50, 50] },
      { label: 3, centroid_index: [5, 50, 50] },
    ];
    const picked = findNearestObject({ u: 50, v: 50 }, rows, viewZ2);
    expect(picked).toBe(1);
  });
});

describe("ResearchWorkbench maturation workflows", () => {
  const sampleSource = {
    id: "src-1",
    name: "Specimen 1",
    path: "/images/specimen1.tif",
    sha256: "sha-1",
    metadata: {
      format: "OME-TIFF",
      geometry: { axes: "yx", unit: "um", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
      physical_calibration: { unit: "um" },
      dimensions: { x: 512, y: 512, c: 2, z: 1, t: 1 },
      levels: [{ index: 0, dimensions: { x: 512, y: 512, c: 2, z: 1, t: 1 } }],
      channel_names: ["DAPI", "GFP"],
    },
  };

  const sampleSource2 = {
    id: "src-2",
    name: "Specimen 2",
    path: "/images/specimen2.tif",
    sha256: "sha-2",
    metadata: {
      format: "TIFF",
      geometry: { axes: "yx", unit: "um", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
      physical_calibration: { unit: "um" },
      dimensions: { x: 512, y: 512, c: 1, z: 1, t: 1 },
      levels: [{ index: 0, dimensions: { x: 512, y: 512, c: 1, z: 1, t: 1 } }],
      channel_names: ["Brightfield"],
    },
  };

  const sampleResult = {
    id: "res-1",
    source_id: "src-1",
    source_sha256: "sha-1",
    kind: "cell-segmentation",
    created_at: "2026-09-14T00:00:00Z",
    revision_hash: "rev-hash-123456",
    object_count: 2,
    selection: { x: 0, y: 0, width: 512, height: 512, c: 0, z: 0, t: 0, level: 0 },
    arrays: { image: { shape: [512, 512] } },
    geometry: { axes: "yx", unit: "um", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
    review: { disposition: "pending" as const },
  };

  const sampleMeasurements = [
    { label: 1, measure: 124.5678, measure_unit: "um²", area: 124.5678, centroid_index: [100, 150] },
    { label: 2, measure: 248.9123, measure_unit: "um²", area: 248.9123, centroid_index: [200, 250] },
  ];

  function makeApi(initialSnapshot?: ResearchSnapshot): ResearchDesktopApi {
    const snapshot: ResearchSnapshot = initialSnapshot ?? {
      project: { title: "Maturation Study" },
      sources: [sampleSource, sampleSource2],
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
      execute: vi.fn(async (op, args) => {
        const req = args as Record<string, unknown>;
        const source = snapshot.sources.find((item) => item.id === req.source_id) ?? snapshot.sources[0];
        if (op === "viewer_defaults") {
          const c = source?.metadata.dimensions?.c ?? 1;
          return {
            source_id: source.id,
            source_sha256: source.sha256,
            basis: "Source acquisition range",
            channels: Array.from({ length: c }, (_, channel) => ({
              channel,
              low: 0,
              high: 255,
              gamma: 1,
              color: "#ffffff",
              opacity: 1,
              visible: true,
            })),
          };
        }
        if (op === "source_view") {
          return {
            source_id: source.id,
            source_sha256: source.sha256,
            revision: 0,
            state: null,
          };
        }
        if (op === "save_source_view") {
          return {
            source_id: source.id,
            source_sha256: source.sha256,
            revision: Number(req.expected_revision ?? 0) + 1,
            state: req.state,
          };
        }
        if (op === "source_annotations") {
          return {
            source_id: source.id,
            source_sha256: source.sha256,
            revision: 0,
            annotations: [],
            can_undo: false,
            can_redo: false,
          };
        }
        if (op === "viewer_tile") {
          return {
            image: "data:image/png;base64,viewertile#viewer-512x512",
            source_sha256: source.sha256,
            source_extent: [512, 512],
            width: 512,
            height: 512,
          };
        }
        if (op === "result") {
          return {
            id: req.result_id,
            measurements: sampleMeasurements,
          };
        }
        if (op === "result_view") {
          return {
            image: "data:image/png;base64,resultview",
            measurements: sampleMeasurements,
            result_id: "res-1",
            revision_hash: "rev-hash-123456",
            axis: "z",
            index: 0,
            shape: [512, 512],
            geometry: sampleResult.geometry,
          };
        }
        if (op === "validate_recipe") {
          return { recipe: (req as { recipe: unknown }).recipe };
        }
        return {};
      }),
      reviewResult: vi.fn(async () => {}),
      exportResult: vi.fn(async () => {}),
      selectPath: vi.fn(async () => null),
      runBatchJob: vi.fn(async () => ({ batch_id: "b-1", jobs: [] })),
      cancelJob: vi.fn(async () => {}),
      exportVolumeFigure: vi.fn(async () => {}),
    } as unknown as ResearchDesktopApi;
  }

  it("renders active viewing badge and independent active styling for active image", async () => {
    const api = makeApi();
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    const specimenBtn = await screen.findByRole("button", { name: /Specimen 1/ });
    expect(specimenBtn).toHaveClass("active");
    expect(specimenBtn).toHaveTextContent("Viewing");
  });

  it("displays quantitative summary and interactive ResultTable with keyboard navigation in Review & Export tab", async () => {
    const api = makeApi();
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    // Switch to Info (Review & Export) tab via Results group
    const resultsBtn = await screen.findByRole("button", { name: "Results" });
    fireEvent.click(resultsBtn);

    // Select the result
    const resultBtn = await screen.findByRole("button", { name: /cell-segmentation/ });
    fireEvent.click(resultBtn);

    // Wait for the result view to load measurements
    await waitFor(() => {
      expect(screen.getByText("Quantitative summary")).toBeInTheDocument();
    });

    // Verify statistical summary card
    const objectsLabel = screen.getByText("Objects");
    expect(objectsLabel).toBeInTheDocument();
    expect(within(objectsLabel.closest(".research-stat-item")!).getByText("2")).toBeInTheDocument(); // count
    expect(screen.getByText("Mean measure")).toBeInTheDocument();
    expect(screen.getByText(/186\.74/)).toBeInTheDocument(); // (124.5678 + 248.9123) / 2
    expect(screen.getByText(/124\.57 – 248\.91/)).toBeInTheDocument(); // range

    // Verify ResultTable accessibility
    const tableRegion = screen.getByRole("region", { name: "Object measurements" });
    expect(tableRegion).toBeInTheDocument();

    const tableRows = screen.getAllByRole("row");
    expect(tableRows).toHaveLength(3);

    // Formatted numbers in cells
    expect(screen.getAllByText("124.568").length).toBeGreaterThan(0); // 3 decimals
    expect(screen.getByText("[100, 150]")).toBeInTheDocument(); // array centroid

    // Test row selection via click
    fireEvent.click(tableRows[1]);
    expect(tableRows[1]).toHaveClass("selected");
    expect(tableRows[1]).toHaveAttribute("aria-selected", "true");

    // Test keyboard navigation (ArrowDown)
    fireEvent.keyDown(tableRegion, { key: "ArrowDown" });
    await waitFor(() => {
      expect(tableRows[2]).toHaveClass("selected");
      expect(tableRows[2]).toHaveAttribute("aria-selected", "true");
    });

    // Test keyboard navigation (ArrowUp)
    fireEvent.keyDown(tableRegion, { key: "ArrowUp" });
    await waitFor(() => {
      expect(tableRows[1]).toHaveClass("selected");
      expect(tableRows[1]).toHaveAttribute("aria-selected", "true");
    });
  });

  it("gates preset recipes against channel compatibility in Analyze", async () => {
    const snapshotWithRecipe: ResearchSnapshot = {
      project: { title: "Maturation Study" },
      sources: [sampleSource2], // 1 channel
      results: [],
      samples: [],
      selections: [],
      recipes: [
        {
          id: "rec-multi-ch",
          data: {
            name: "Three-Channel Assay",
            recipe: {
              steps: [],
              measurement_channels: [0, 1, 2],
              segmentation: { method: "threshold", channel: 2, threshold: 0.5 },
              gates: [],
            },
          },
        },
      ],
      displays: [],
      jobs: [],
      operations: {},
    };
    const api = makeApi(snapshotWithRecipe);

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    const analyzeBtn = await screen.findByRole("button", { name: "Analyze" });
    fireEvent.click(analyzeBtn);

    // Verify preset picker is present
    const presetSelect = await screen.findByLabelText("Load saved recipe");
    expect(presetSelect).toBeInTheDocument();

    // Select the 3-channel preset on the 1-channel source
    fireEvent.change(presetSelect, { target: { value: "0" } });

    // Expect channel gating warning
    await waitFor(() => {
      expect(
        screen.getAllByText(/Preset 'Three-Channel Assay' requires channel 3, but this source only has 1 channel/i).length,
      ).toBeGreaterThan(0);
    });
  });
});
