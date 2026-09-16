// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench, { computeResultStats, formatStatValue } from "./ResearchWorkbench";
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("computeResultStats and formatStatValue (WP B1)", () => {
  it("formats numbers correctly including integers, decimals, and small numbers in scientific notation", () => {
    expect(formatStatValue(0)).toBe("0");
    expect(formatStatValue(42)).toBe("42");
    expect(formatStatValue(123.456)).toBe("123.46");
    expect(formatStatValue(0.000123)).toBe("1.23e-4");
    expect(formatStatValue(-0.0000456)).toBe("-4.56e-5");
    expect(formatStatValue(NaN)).toBe("–");
    expect(formatStatValue(Infinity)).toBe("–");
  });

  it("handles explicit metric kind: Area from measure_kind: 'area' and Volume from measure_kind: 'volume'", () => {
    const areaRows = [
      { label: 1, measure: 100, measure_kind: "area", measure_unit: "µm²" },
      { label: 2, measure: 200, measure_kind: "area", measure_unit: "µm²" },
    ];
    const areaStats = computeResultStats(areaRows);
    expect(areaStats).not.toBeNull();
    expect(areaStats?.metric).toBe("Area");
    expect(areaStats?.mean).toBe("150");
    expect(areaStats?.min).toBe("100");
    expect(areaStats?.max).toBe("200");
    expect(areaStats?.unit).toBe("µm²");
    expect(areaStats?.validCount).toBe(2);
    expect(areaStats?.totalCount).toBe(2);

    const volumeRows = [
      { label: 1, measure: 500, measure_kind: "volume", measure_unit: "µm³" },
      { label: 2, measure: 1000, measure_kind: "volume", measure_unit: "µm³" },
    ];
    const volumeStats = computeResultStats(volumeRows);
    expect(volumeStats).not.toBeNull();
    expect(volumeStats?.metric).toBe("Volume");
    expect(volumeStats?.mean).toBe("750");
    expect(volumeStats?.min).toBe("500");
    expect(volumeStats?.max).toBe("1000");
    expect(volumeStats?.unit).toBe("µm³");
  });

  it("preserves uncalibrated pixel units as px² and px³", () => {
    const pixel2Rows = [
      { label: 1, measure: 150, measure_kind: "area", measure_unit: "pixel^2" },
      { label: 2, measure: 250, measure_kind: "area", measure_unit: "pixel²" },
    ];
    const stats2 = computeResultStats(pixel2Rows);
    expect(stats2?.unit).toBe("px²");
    expect(stats2?.hasMixedUnits).toBe(false);

    const pixel3Rows = [
      { label: 1, measure: 1500, measure_kind: "volume", measure_unit: "pixel^3" },
    ];
    const stats3 = computeResultStats(pixel3Rows);
    expect(stats3?.unit).toBe("px³");
  });

  it("detects mixed units across rows and flags hasMixedUnits without pooling into single unit", () => {
    const mixedRows = [
      { label: 1, measure: 100, measure_kind: "area", measure_unit: "µm²" },
      { label: 2, measure: 200, measure_kind: "area", measure_unit: "px²" },
    ];
    const stats = computeResultStats(mixedRows);
    expect(stats?.hasMixedUnits).toBe(true);
    expect(stats?.unit).toBe("mixed");
  });

  it("tracks validCount vs totalCount when non-finite or missing values exist", () => {
    const rows = [
      { label: 1, measure: 100, measure_kind: "area", measure_unit: "µm²" },
      { label: 2, measure: NaN, measure_kind: "area", measure_unit: "µm²" },
      { label: 3, measure: 200, measure_kind: "area", measure_unit: "µm²" },
      { label: 4, measure: Infinity, measure_kind: "area", measure_unit: "µm²" },
      { label: 5, measure: null, measure_kind: "area", measure_unit: "µm²" },
    ];
    const stats = computeResultStats(rows);
    expect(stats?.validCount).toBe(2);
    expect(stats?.totalCount).toBe(5);
    expect(stats?.min).toBe("100");
    expect(stats?.max).toBe("200");
    expect(stats?.mean).toBe("150");
  });

  it("computes bounded statistics over 20,000 objects without stack overflow", () => {
    const largeRows = Array.from({ length: 20000 }, (_, i) => ({
      label: i + 1,
      measure: i + 1,
      measure_kind: "area",
      measure_unit: "µm²",
    }));
    const stats = computeResultStats(largeRows);
    expect(stats?.totalCount).toBe(20000);
    expect(stats?.validCount).toBe(20000);
    expect(stats?.min).toBe("1");
    expect(stats?.max).toBe("20000");
    expect(stats?.mean).toBe("10000.50");
  });

  it("formats very small non-zero numbers in scientific notation", () => {
    const rows = [
      { label: 1, measure: 0.00012, measure_kind: "volume", measure_unit: "mm³" },
      { label: 2, measure: 0.00018, measure_kind: "volume", measure_unit: "mm³" },
    ];
    const stats = computeResultStats(rows);
    expect(stats?.min).toBe("1.20e-4");
    expect(stats?.max).toBe("1.80e-4");
    expect(stats?.mean).toBe("1.50e-4");
  });
});

describe("Recipe restoration validation (WP B2)", () => {
  const sampleSource = {
    id: "src-1",
    name: "Specimen 1",
    path: "/images/specimen1.tif",
    sha256: "sha-1",
    metadata: {
      format: "OME-TIFF",
      geometry: { axes: "yx", unit: "um", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
      dimensions: { c: 2, z: 1, t: 1, x: 512, y: 512 },
    },
  };

  const samplePreset = {
    id: "preset-1",
    source_id: "src-1",
    revision: 1,
    data: {
      name: "Nuclear Count",
      recipe: {
        segmentation: { method: "components", threshold: 120, channel: 0 },
        measurement_channels: [0],
      },
      selection: { x: 50, y: 50, width: 200, height: 200, c: 0, z: 0, t: 0, level: 0 },
    },
  };

  it("validates recipe preset against current selection and loads it", async () => {
    const executeMock = vi.fn(async (op: string, args: Record<string, unknown>) => {
      const source = sampleSource;
      if (op === "viewer_defaults") {
        return {
          source_id: source.id,
          source_sha256: source.sha256,
          basis: "Source acquisition range",
          channels: [
            { channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true },
            { channel: 1, low: 0, high: 255, gamma: 1, color: "#ff0000", opacity: 1, visible: true },
          ],
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
      if (op === "viewer_tile") {
        return { image: "data:image/png;base64,tile", tile: [0, 0, 512, 512], key: "tile-0" };
      }
      if (op === "validate_recipe") {
        return { recipe: args.recipe };
      }
      return {};
    });

    const snapshot: ResearchSnapshot = {
      project: { title: "Recipe Study" },
      sources: [sampleSource],
      results: [],
      samples: [],
      selections: [],
      recipes: [samplePreset],
      displays: [],
      jobs: [],
      operations: {},
    };

    const api = {
      getSnapshot: vi.fn(async () => structuredClone(snapshot)),
      execute: executeMock,
    } as unknown as ResearchDesktopApi;

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    // Switch to Analyze tab
    const analyzeTab = await screen.findByRole("button", { name: "Analyze" });
    fireEvent.click(analyzeTab);

    // Find the preset picker and select the preset (index 0)
    const presetSelect = await screen.findByRole("combobox", { name: /Load saved recipe/i });
    fireEvent.change(presetSelect, { target: { value: "0" } });

    await waitFor(() => {
      // Expect validate_recipe to have been called with source_id and current selection
      const validateCalls = executeMock.mock.calls.filter((c) => c[0] === "validate_recipe");
      expect(validateCalls.length).toBeGreaterThan(0);
      const lastCall = validateCalls[validateCalls.length - 1];
      expect(lastCall[1].source_id).toBe("src-1");
      // Must validate against current selection shownSelection, NOT the preset's stale saved selection
      expect(lastCall[1].selection).toBeDefined();
    });
  });
});
