// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench, { computeResultStats, formatStatValue, Info } from "./ResearchWorkbench";
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
  it("formats numbers correctly including integers, decimals, small numbers, and boundary values", () => {
    expect(formatStatValue(0)).toBe("0");
    expect(formatStatValue(42)).toBe("42");
    expect(formatStatValue(123.456)).toBe("123.46");
    expect(formatStatValue(0.000123)).toBe("1.23e-4");
    expect(formatStatValue(-0.0000456)).toBe("-4.56e-5");
    expect(formatStatValue(NaN)).toBe("–");
    expect(formatStatValue(Infinity)).toBe("–");
    expect(formatStatValue(-Infinity)).toBe("–");
    // Boundary and small nonzero values retain nonzero sign and value representation
    expect(formatStatValue(0.001)).toBe("1.00e-3");
    expect(formatStatValue(-0.001)).toBe("-1.00e-3");
    expect(formatStatValue(0.0005)).toBe("5.00e-4");
    expect(formatStatValue(-0.0005)).toBe("-5.00e-4");
    expect(formatStatValue(0.00049)).toBe("4.90e-4");
    expect(formatStatValue(0.00051)).toBe("5.10e-4");
    // Finite large values
    expect(formatStatValue(1e308)).toBe("1e+308");
    expect(formatStatValue(-1e308)).toBe("-1e+308");
    expect(formatStatValue(10000.5)).toBe("10000.50");
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
    // Withhold pooled statistics and provide reason
    expect(stats?.mean).toBeNull();
    expect(stats?.min).toBeNull();
    expect(stats?.max).toBeNull();
    expect(stats?.incompatibleReason).toMatch(/mixed units/i);
    expect(stats?.validCount).toBe(2);
    expect(stats?.totalCount).toBe(2);
  });

  it("withholds pooled statistics for mixed kinds (area plus volume)", () => {
    const mixedKindRows = [
      { label: 1, measure: 100, measure_kind: "area", measure_unit: "µm²" },
      { label: 2, measure: 200, measure_kind: "volume", measure_unit: "µm²" },
    ];
    const stats = computeResultStats(mixedKindRows);
    expect(stats?.hasMixedKinds).toBe(true);
    expect(stats?.mean).toBeNull();
    expect(stats?.min).toBeNull();
    expect(stats?.max).toBeNull();
    expect(stats?.incompatibleReason).toMatch(/mixed measurement kinds/i);
  });

  it("withholds pooled statistics for incompatible metric fields (area field plus volume field)", () => {
    const mixedFieldRows = [
      { label: 1, area: 100 },
      { label: 2, volume: 200 },
    ];
    const stats = computeResultStats(mixedFieldRows);
    expect(stats?.mean).toBeNull();
    expect(stats?.min).toBeNull();
    expect(stats?.max).toBeNull();
    expect(stats?.incompatibleReason).toMatch(/incompatible metric fields/i);
  });

  it("withholds pooled statistics when unit metadata is inconsistently declared vs missing", () => {
    const mixedDeclaredRows = [
      { label: 1, measure: 100, measure_kind: "area", measure_unit: "µm²" },
      { label: 2, measure: 200, measure_kind: "area" },
    ];
    const stats = computeResultStats(mixedDeclaredRows);
    expect(stats?.hasMixedUnits).toBe(true);
    expect(stats?.unit).toBe("mixed");
    expect(stats?.mean).toBeNull();
    expect(stats?.min).toBeNull();
    expect(stats?.max).toBeNull();
    expect(stats?.incompatibleReason).toMatch(/some records declare units while others are unspecified/i);
  });

  it("counts each heterogeneous row without depending on row order", () => {
    const rows = [{ area: 100 }, { volume: 200 }, { volume: 300 }];
    const stats = computeResultStats(rows);
    expect(stats?.validCount).toBe(3);
    expect(stats?.excludedCount).toBe(0);
    expect(stats?.mean).toBeNull();
    expect(computeResultStats([...rows].reverse())).toEqual(stats);
  });

  it("does not conceal inconsistent metadata on an excluded value", () => {
    const stats = computeResultStats([
      { measure: 100, measure_kind: "area", measure_unit: "µm²" },
      { measure: NaN, measure_kind: "area" },
    ]);
    expect(stats?.validCount).toBe(1);
    expect(stats?.excludedCount).toBe(1);
    expect(stats?.mean).toBeNull();
    expect(stats?.incompatibleReason).toMatch(/some records declare units/);
  });

  it.each([1e16, 1e308])("preserves a small residual between cancelling values of %s", (magnitude) => {
    // The large positive and negative terms cancel exactly; the mean is 1 / 3.
    for (const values of [[magnitude, 1, -magnitude], [-magnitude, 1, magnitude], [1, magnitude, -magnitude]]) {
      const stats = computeResultStats(values.map((measure) => ({ measure })));
      expect(stats?.mean).toBe("0.33");
    }
  });

  it("labels consistently missing metadata as unspecified without assuming pixel calibration", () => {
    const unspecifiedRows = [
      { label: 1, measure: 100, measure_kind: "area" },
      { label: 2, measure: 200, measure_kind: "area" },
    ];
    const stats = computeResultStats(unspecifiedRows);
    expect(stats?.unit).toBe("unspecified");
    expect(stats?.hasMixedUnits).toBe(false);
    expect(stats?.mean).toBe("150");
    expect(stats?.min).toBe("100");
    expect(stats?.max).toBe("200");
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
    expect(stats?.excludedCount).toBe(3);
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

  it("computes finite mean for large finite values (1e308) without sum overflow or unexplained dash", () => {
    const overflowRows = [
      { label: 1, measure: 1e308, measure_kind: "area", measure_unit: "µm²" },
      { label: 2, measure: 1e308, measure_kind: "area", measure_unit: "µm²" },
    ];
    const stats = computeResultStats(overflowRows);
    expect(stats?.validCount).toBe(2);
    expect(stats?.totalCount).toBe(2);
    expect(stats?.min).toBe("1e+308");
    expect(stats?.max).toBe("1e+308");
    expect(stats?.mean).toBe("1e+308");
    expect(stats?.incompatibleReason).toBeNull();
  });

  it("preserves compatibility and results regardless of row order", () => {
    // Incompatible units reversed
    const reversedMixed = [
      { label: 2, measure: 200, measure_kind: "area", measure_unit: "px²" },
      { label: 1, measure: 100, measure_kind: "area", measure_unit: "µm²" },
    ];
    const statsRev = computeResultStats(reversedMixed);
    expect(statsRev?.hasMixedUnits).toBe(true);
    expect(statsRev?.mean).toBeNull();

    // Invalid row first
    const invalidFirst = [
      { label: 1, measure: NaN, measure_kind: "area", measure_unit: "µm²" },
      { label: 2, measure: 100, measure_kind: "area", measure_unit: "µm²" },
      { label: 3, measure: 200, measure_kind: "area", measure_unit: "µm²" },
    ];
    const statsInv = computeResultStats(invalidFirst);
    expect(statsInv?.validCount).toBe(2);
    expect(statsInv?.totalCount).toBe(3);
    expect(statsInv?.mean).toBe("150");
    expect(statsInv?.min).toBe("100");
    expect(statsInv?.max).toBe("200");
  });

  it("handles all-invalid rows honestly without shrinking count to zero", () => {
    const allInvalid = [
      { label: 1, measure: NaN, measure_kind: "area", measure_unit: "µm²" },
      { label: 2, measure: null, measure_kind: "area", measure_unit: "µm²" },
    ];
    const stats = computeResultStats(allInvalid);
    expect(stats?.totalCount).toBe(2);
    expect(stats?.validCount).toBe(0);
    expect(stats?.mean).toBeNull();
    expect(stats?.incompatibleReason).toMatch(/all 2 records excluded/i);
  });

  it("handles records with no numeric measurement field honestly", () => {
    const noField = [
      { label: 1, text: "alpha" },
      { label: 2, text: "beta" },
    ];
    const stats = computeResultStats(noField);
    expect(stats?.totalCount).toBe(2);
    expect(stats?.validCount).toBe(0);
    expect(stats?.mean).toBeNull();
    expect(stats?.incompatibleReason).toMatch(/no summary metric available/i);
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

describe("Info Review & export rendered summary component", () => {
  const mockSource = {
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

  const mockResult = {
    id: "res-1",
    source_id: "src-1",
    revision_hash: "abcd1234ef567890",
    method: "components",
    review: { disposition: "pending" as const },
    data: {},
  };

  const mockSnapshot: ResearchSnapshot = {
    project: { title: "Summary UI Study" },
    sources: [mockSource as any],
    results: [mockResult as any],
    samples: [],
    selections: [],
    recipes: [],
    displays: [],
    jobs: [],
    operations: {},
  };

  const createMockApi = () =>
    ({
      reviewResult: vi.fn(async () => {}),
      exportResult: vi.fn(async () => {}),
      getSnapshot: vi.fn(async () => structuredClone(mockSnapshot)),
    }) as unknown as ResearchDesktopApi;

  it("labels agent decisions and lets the researcher supersede them", async () => {
    const api = createMockApi();
    const result = { ...mockResult, kind: "segmentation", created_at: "2026-10-17T00:00:00Z", object_count: 2,
      review: { disposition: "reviewed", schema: "loci.result-review/v2" as const, actor: "agent" as const, actor_id: "codex" } };
    render(<Info source={mockSource} snapshot={mockSnapshot} api={api} result={result} rows={[]}
      selectedRow={null} onSelectRow={vi.fn()} onSave={vi.fn()} report={async (work) => await work()} busy={false} onSnapshot={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reviewed by agent");
    const button = screen.getByRole("button", { name: "Mark reviewed" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(api.reviewResult).toHaveBeenCalledWith(result.id, result.revision_hash, "reviewed"));
  });

  it("shows external input identity and unknown upstream settings independently of correction lineage", () => {
    const imported = { ...mockResult, kind: "corrected-labels", created_at: "now", object_count: 0, parent_id: "parent-exact-id",
      label_import: { file_name: "sparse.tif", producer: null, format: "TIFF", profile: "scalar-native-yx/v1", source_sha256: mockSource.sha256,
        file_sha256: "a".repeat(64), original_dtype: "uint32", shape: [512, 512] as [number, number] } };
    render(<Info source={mockSource} snapshot={mockSnapshot} api={createMockApi()} result={imported} rows={[]}
      selectedRow={null} onSelectRow={vi.fn()} onSave={vi.fn()} report={async (work) => await work()} busy={false} onSnapshot={vi.fn()} />);
    expect(screen.getByLabelText("Label import identity")).toHaveTextContent("sparse.tif");
    expect(screen.getByLabelText("Label import identity")).toHaveTextContent("Upstream settingsUnknown");
    expect(screen.getByLabelText("Label import identity")).toHaveTextContent("Correction parentparent-exact-id");
  });

  it("renders plain-language incompatible reason, withholds mean/range, and keeps table/controls interactive", () => {
    const api = createMockApi();
    const rows = [
      { label: 1, measure: 100, measure_kind: "area", measure_unit: "µm²" },
      { label: 2, measure: 200, measure_kind: "area", measure_unit: "px²" },
    ];

    function TestHost() {
      const [selected, setSelected] = React.useState<number | null>(null);
      return (
        <Info
          source={mockSource as any}
          snapshot={mockSnapshot}
          api={api}
          result={mockResult as any}
          rows={rows}
          selectedRow={selected}
          onSelectRow={setSelected}
          onSave={vi.fn()}
          report={async (w) => await w()}
          busy={false}
          onSnapshot={vi.fn()}
        />
      );
    }

    render(<TestHost />);

    // Total row count stays independent of summary compatibility.
    const objectsLabel = screen.getByText("Rows");
    expect(objectsLabel).toBeInTheDocument();
    expect(within(objectsLabel.closest(".research-stat-item")!).getByText("2")).toBeInTheDocument();

    // Pooled mean and range are withheld
    expect(screen.queryByText(/^Mean /)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Range/)).not.toBeInTheDocument();

    // Incompatible reason is visible beside the table
    expect(
      screen.getByText(/Cannot pool measurements: mixed units \(px², µm²\)/i),
    ).toBeInTheDocument();

    // ResultTable is rendered and interactive
    const tableRegion = screen.getByRole("region", { name: "Result measurements" });
    expect(tableRegion).toBeInTheDocument();
    const tableRows = screen.getAllByRole("row");
    expect(tableRows).toHaveLength(3); // header + 2 rows

    // Click row to select
    fireEvent.click(tableRows[1]);
    expect(tableRows[1]).toHaveClass("selected");

    // Keyboard navigation on table
    tableRegion.focus();
    fireEvent.keyDown(tableRegion, { key: "ArrowDown" });
    expect(tableRows[2]).toHaveClass("selected");

    // Review controls remain present and gated
    const reviewBtn = screen.getByRole("button", { name: "Mark reviewed" });
    expect(reviewBtn).toBeEnabled();
    const exportBtn = screen.getByRole("button", { name: "Export result" });
    expect(exportBtn).toBeDisabled(); // Requires reviewed disposition
  });

  it("renders exclusions note when non-finite values exist while computing valid mean", () => {
    const api = createMockApi();
    const rows = [
      { label: 1, measure: 100, measure_kind: "area", measure_unit: "µm²" },
      { label: 2, measure: NaN, measure_kind: "area", measure_unit: "µm²" },
      { label: 3, measure: 200, measure_kind: "area", measure_unit: "µm²" },
      { label: 4, measure: Infinity, measure_kind: "area", measure_unit: "µm²" },
      { label: 5, measure: null, measure_kind: "area", measure_unit: "µm²" },
    ];

    render(
      <Info
        source={mockSource as any}
        snapshot={mockSnapshot}
        api={api}
        result={mockResult as any}
        rows={rows}
        selectedRow={null}
        onSelectRow={vi.fn()}
        onSave={vi.fn()}
        report={async (w) => await w()}
        busy={false}
        onSnapshot={vi.fn()}
      />,
    );

    // Total count must not become a valid-value count or an object claim.
    const objectsLabel = screen.getByText("Rows");
    expect(within(objectsLabel.closest(".research-stat-item")!).getByText("5")).toBeInTheDocument();

    // Mean and Range computed from valid values
    expect(screen.getByText("Mean Area")).toBeInTheDocument();
    expect(screen.getByText(/150/)).toBeInTheDocument();
    expect(screen.getByText(/100 – 200/)).toBeInTheDocument();

    // Exclusion note is explicitly disclosed
    expect(
      screen.getByText(/2 of 5 rows have finite numeric values; 3 excluded from statistics/i),
    ).toBeInTheDocument();
  });

  it("labels arbitrary measurement records as rows without inferring object identity", () => {
    const api = createMockApi();
    const transectRows = [
      { measure: 45.2, measure_unit: "µm" },
      { measure: 52.8, measure_unit: "µm" },
    ];

    render(
      <Info
        source={mockSource as any}
        snapshot={mockSnapshot}
        api={api}
        result={mockResult as any}
        rows={transectRows}
        selectedRow={null}
        onSelectRow={vi.fn()}
        onSave={vi.fn()}
        report={async (w) => await w()}
        busy={false}
        onSnapshot={vi.fn()}
      />,
    );

    // Arbitrary measurement rows do not imply biological objects.
    expect(screen.getByText("Rows")).toBeInTheDocument();
    expect(screen.queryByText("Objects")).not.toBeInTheDocument();
    const summaryCard = screen.getByText("Quantitative summary").closest(".research-result-summary-card") as HTMLElement;
    expect(within(summaryCard).queryByText(/biological/i)).not.toBeInTheDocument();
    expect(screen.getByText("Mean measure")).toBeInTheDocument();
  });

  it("renders gracefully with long units without crashing", () => {
    const api = createMockApi();
    const rows = [
      { label: 1, measure: 10, measure_kind: "area", measure_unit: "cubic_micrometres_per_focal_quadrant" },
    ];

    render(
      <Info
        source={mockSource as any}
        snapshot={mockSnapshot}
        api={api}
        result={mockResult as any}
        rows={rows}
        selectedRow={null}
        onSelectRow={vi.fn()}
        onSave={vi.fn()}
        report={async (w) => await w()}
        busy={false}
        onSnapshot={vi.fn()}
      />,
    );

    expect(screen.getAllByText("cubic_micrometres_per_focal_quadrant").length).toBeGreaterThan(0);
  });

  it("keeps later metric fields visible when a heterogeneous result cannot be pooled", () => {
    render(<Info source={mockSource as any} snapshot={mockSnapshot}
      api={createMockApi()} result={mockResult as any}
      rows={[{ label: 1, area: 100 }, { label: 2, volume: 200 }]}
      selectedRow={null} onSelectRow={vi.fn()} onSave={vi.fn()}
      report={async (work) => await work()} busy={false} onSnapshot={vi.fn()} />);
    const table = screen.getByRole("region", { name: "Result measurements" });
    expect(within(table).getByRole("columnheader", { name: "Area" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "Volume" })).toBeVisible();
    expect(within(table).getByText("200")).toBeVisible();
    expect(screen.queryByText(/^Mean /)).not.toBeInTheDocument();
  });

  it("does not round small table values to zero or relabel infinity as NaN", () => {
    render(<Info source={mockSource as any} snapshot={mockSnapshot}
      api={createMockApi()} result={mockResult as any}
      rows={[{ measure: 0.00001, centroid_index: [0.001, -0.001] }, { measure: -0.00001 }, { measure: Infinity }]}
      selectedRow={null} onSelectRow={vi.fn()} onSave={vi.fn()}
      report={async (work) => await work()} busy={false} onSnapshot={vi.fn()} />);
    const table = screen.getByRole("region", { name: "Result measurements" });
    expect(within(table).getByRole("gridcell", { name: "1.00e-5" })).toBeVisible();
    expect(within(table).getByRole("gridcell", { name: "-1.00e-5" })).toBeVisible();
    expect(within(table).getByRole("gridcell", { name: "Infinity" })).toBeVisible();
    expect(within(table).getByText("[1.00e-3, -1.00e-3]")).toBeVisible();
  });

  it("presents per-channel statistics without JSON and retains signed precision", () => {
    const original = { label: 1, measure: 12, intensity: {
      "1: acquired signal": { mean: -0.000012345, sum: -0.002469, std_population: 0.0000001 },
      "2: acquired reference": { mean: 103.456789, sum: 20691.3578 },
    } };
    const rows = [structuredClone(original)];
    const onSelect = vi.fn();
    render(<Info source={mockSource as any} snapshot={mockSnapshot}
      api={createMockApi()} result={mockResult as any} rows={rows}
      selectedRow={null} onSelectRow={onSelect} onSave={vi.fn()}
      report={async (work) => await work()} busy={false} onSnapshot={vi.fn()} />);
    const table = screen.getByRole("region", { name: "Result measurements" });
    expect(within(table).getByRole("columnheader", { name: "Channel intensity" })).toBeVisible();
    const channels = within(table).getByText("2 channels");
    const details = channels.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(channels);
    expect(onSelect).not.toHaveBeenCalled();
    details.setAttribute("open", "");
    expect(within(details).getByText("1: acquired signal")).toBeVisible();
    expect(within(details).getByText("Population SD")).toBeVisible();
    expect(within(details).getByTitle("-0.000012345")).toHaveTextContent("-1.23e-5");
    expect(within(details).getByTitle("103.456789")).toHaveTextContent("103.457");
    expect(table.textContent).not.toContain('"std_population"');
    expect(rows).toEqual([original]);
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
        measurement_channels: [0], steps: [], gates: [], working_bytes: 41599,
      },
      selection: { x: 50, y: 50, width: 200, height: 200, c: 0, z: 0, t: 0, level: 0 },
    },
  };

  it("preflights a saved recipe against current selection and preserves its insufficient allowance", async () => {
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
      if (op === "recipe_preflight") {
        return { recipe: args.recipe, within_budget: false };
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
      // Restoring does not execute or discard the saved allowance.
      const validateCalls = executeMock.mock.calls.filter((c) => c[0] === "recipe_preflight");
      expect(validateCalls.length).toBeGreaterThan(0);
      const lastCall = validateCalls[validateCalls.length - 1];
      expect(lastCall[1].source_id).toBe("src-1");
      // Must validate against current selection shownSelection, NOT the preset's stale saved selection
      expect(lastCall[1].selection).toBeDefined();
      expect(screen.getByLabelText("Recipe memory allowance")).toHaveValue("41599");
      expect(executeMock.mock.calls.some(([op]) => op === "run_recipe")).toBe(false);
    });
  });

  it("preserves chosen memory allowance across switching between classical, adaptive, and cellpose-sam", async () => {
    const native = {
      listProfiles: vi.fn().mockResolvedValue([
        {
          schemaVersion: "1.2",
          id: "loci-classical",
          name: "Loci Adaptive Watershed",
          version: "0.1.0",
          status: "ready",
          availability: { code: "ready", summary: "Built in." },
          backendKind: "classical",
          model: { format: "builtin-algorithm", artifactId: null, sha256: null },
          preprocessing: {
            channelConversion: "grayscale-luminance",
            intensityNormalization: "per-image-percentile-1-99",
            resizePolicy: "none",
            maxEdgePx: null,
            outputGrid: "source-resolution",
          },
          rights: {
            codeLicense: "Apache-2.0",
            modelLicense: "not-applicable",
            redistribution: "bundled",
            commercialUse: "permitted",
            trainingDataLineage: "Deterministic",
          },
          recommendedSettings: {
            image_mode: "auto",
            polarity: "auto",
            expected_diameter_px: 34,
            min_area_px: 80,
            sensitivity: 0,
            smoothing_px: 1.2,
            split_touching: true,
            exclude_border: false,
          },
          settingsContract: [],
          validation: { status: "baseline", summary: "Baseline", failureModes: [] },
        },
        {
          schemaVersion: "1",
          id: "cellpose-sam",
          name: "Cellpose-SAM",
          version: "4.2.1.1",
          status: "ready",
          availability: { code: "ready", summary: "Ready" },
          backendKind: "cellpose",
          model: { format: "cellpose-native", artifactId: "cpsam", sha256: "1".repeat(64) },
          preprocessing: {
            channelConversion: "rgb-or-replicated-grayscale",
            intensityNormalization: "cellpose-configurable-percentile",
            resizePolicy: "downsample-only",
            maxEdgePx: 1000,
            outputGrid: "source-resolution",
          },
          rights: {
            codeLicense: "BSD-3-Clause",
            modelLicense: "BSD-3-Clause",
            redistribution: "not_permitted",
            commercialUse: "unknown",
            trainingDataLineage: "Upstream",
          },
          recommendedSettings: {
            max_edge_px: 1000,
            diameter_px: 30,
            flow_threshold: 0.4,
            cellprob_threshold: 0,
            min_size_px: 15,
            max_size_fraction: 0.4,
            niter: 250,
            batch_size: 8,
            resample: true,
            augment: false,
            tile_overlap: 0.1,
            normalize: true,
            percentile_low: 1,
            percentile_high: 99,
            tile_norm_blocksize: 0,
            sharpen_radius: 0,
            smooth_radius: 0,
            invert: false,
            device: "auto",
          },
          settingsContract: [],
          validation: { status: "limited", summary: "Review", failureModes: [] },
        },
      ]),
      getCellposeStatus: vi.fn().mockResolvedValue({
        profileId: "cellpose-sam",
        ready: true,
        code: "ready",
        summary: "Cellpose is ready.",
        package: { requiredVersion: "4.2.1.1", installedVersion: "4.2.1.1", exact: true },
        model: {
          artifactId: "cpsam",
          expectedSha256: "1".repeat(64),
          expectedSizeBytes: 1_000_000,
          present: true,
          verified: true,
        },
        devices: { cpu: true, mps: true, cuda: false },
      }),
    };
    Object.defineProperty(window, "loci", { configurable: true, value: native });

    const executeMock = vi.fn(async (op: string, args: Record<string, unknown>) => {
      if (op === "viewer_defaults") {
        return {
          source_id: sampleSource.id,
          source_sha256: sampleSource.sha256,
          basis: "Source acquisition range",
          channels: [
            { channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true },
            { channel: 1, low: 0, high: 255, gamma: 1, color: "#ff0000", opacity: 1, visible: true },
          ],
        };
      }
      if (op === "source_view") {
        return { source_id: sampleSource.id, source_sha256: sampleSource.sha256, revision: 0, state: null };
      }
      if (op === "viewer_tile") {
        return { image: "data:image/png;base64,tile", tile: [0, 0, 512, 512], key: "tile-0" };
      }
      if (op === "recipe_preflight") {
        return {
          source_id: sampleSource.id,
          source_sha256: sampleSource.sha256,
          working_bytes: (args.recipe as { working_bytes: number }).working_bytes,
          maximum_working_bytes: 8 * 1024 ** 3,
          estimated_working_bytes: 100 * 1024 ** 2,
          estimate_basis: "loci.recipe-working-bytes/v1",
          within_budget: true,
        };
      }
      return {};
    });

    const snapshot: ResearchSnapshot = {
      project: { title: "Preserve Allowance Study" },
      sources: [sampleSource],
      results: [],
      samples: [],
      selections: [],
      recipes: [],
      displays: [],
      jobs: [],
      operations: {},
    };

    const api = {
      getSnapshot: vi.fn(async () => structuredClone(snapshot)),
      execute: executeMock,
    } as unknown as ResearchDesktopApi;

    try {
      render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

      // Switch to Analyze tab
      const analyzeTab = await screen.findByRole("button", { name: "Analyze" });
      fireEvent.click(analyzeTab);

      // In Classical mode, memory allowance starts at 512 MiB
      const classicalAllowance = await screen.findByLabelText("Recipe memory allowance");
      expect(classicalAllowance).toHaveValue(String(512 * 1024 ** 2));

      // Change memory allowance to 2 GiB in Classical mode
      fireEvent.change(classicalAllowance, { target: { value: String(2 * 1024 ** 3) } });
      expect(classicalAllowance).toHaveValue(String(2 * 1024 ** 3));

      // Switch to Loci Adaptive Watershed
      const familySelect = screen.getByLabelText("Segmentation model");
      fireEvent.change(familySelect, { target: { value: "adaptive" } });

      // In Adaptive mode, memory allowance should be preserved at 2 GiB
      const adaptiveAllowance = await screen.findByLabelText("Adaptive memory allowance");
      expect(adaptiveAllowance).toHaveValue(String(2 * 1024 ** 3));

      // Change memory allowance to 4 GiB in Adaptive mode
      fireEvent.change(adaptiveAllowance, { target: { value: String(4 * 1024 ** 3) } });
      expect(adaptiveAllowance).toHaveValue(String(4 * 1024 ** 3));

      // Switch to Cellpose-SAM
      fireEvent.change(familySelect, { target: { value: "cellpose-sam" } });

      // In Cellpose mode, memory allowance should be preserved at 4 GiB
      const cellposeAllowance = await screen.findByLabelText("Cellpose memory allowance");
      expect(cellposeAllowance).toHaveValue(String(4 * 1024 ** 3));

      // Switch back to Classical methods
      fireEvent.change(familySelect, { target: { value: "classical" } });

      // In Classical mode, memory allowance should still be preserved at 4 GiB
      const classicalAllowanceAgain = await screen.findByLabelText("Recipe memory allowance");
      expect(classicalAllowanceAgain).toHaveValue(String(4 * 1024 ** 3));
    } finally {
      Reflect.deleteProperty(window, "loci");
    }
  });
});
