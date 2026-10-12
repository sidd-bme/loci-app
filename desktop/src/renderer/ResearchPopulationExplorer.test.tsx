// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previousFloat, ResearchPopulationExplorer, type PopulationFilter, type PopulationResponse, type PopulationRow } from "./ResearchPopulationExplorer";
import type { ResearchDesktopApi, ResearchResult } from "../shared/research-contracts";

const result: ResearchResult = { id: "result-a", revision_hash: "a".repeat(64), source_id: "source-a", source_sha256: "b".repeat(64),
  kind: "segmentation", created_at: "2026-10-03", object_count: 1000, arrays: { image: { shape: [64, 64] }, labels: { shape: [64, 64] } },
  selection: { x: 0, y: 0, width: 64, height: 64, level: 0, z: 2, c: 0, t: 3 } };
const objects: PopulationRow[] = Array.from({ length: 1000 }, (_, index) => ({ label: index + 1,
  values: { measure: index + 1, voxel_count: index + 2 }, index_axes: "YX", centroid_index: [index % 60 + 0.5, index % 60 + 0.5],
  bbox_start: [index % 60, index % 60], bbox_stop_exclusive: [index % 60 + 2, index % 60 + 2] }));

function response(request: Record<string, unknown>, input = objects, exactResult = result): PopulationResponse {
  const x = String(request.x_metric ?? "measure"), y = String(request.y_metric ?? "voxel_count");
  const filters = (request.filters ?? []) as PopulationFilter[];
  const filtered = input.filter((row) => filters.every(({ metric, min, max }) => row.values[metric] !== null &&
    (min === undefined || row.values[metric]! >= min) && (max === undefined || row.values[metric]! <= max)));
  const sort = request.sort as { metric: string; direction: "asc" | "desc" } | undefined;
  const ordered = [...filtered].sort((left, right) => sort ? (sort.direction === "asc" ? 1 : -1) *
    ((sort.metric === "label" ? left.label : left.values[sort.metric]!) - (sort.metric === "label" ? right.label : right.values[sort.metric]!)) : left.label - right.label);
  const selectedLabel = request.selected_label as number | null;
  const selectedRow = input.find((row) => row.label === selectedLabel);
  const selectedIndex = ordered.findIndex((row) => row.label === selectedLabel);
  const finite = filtered.filter((row) => row.values[x] !== null);
  const pairs = filtered.filter((row) => row.values[x] !== null && row.values[y] !== null).map((row) => ({ label: row.label, x: row.values[x]!, y: row.values[y]! }));
  const plotLimit = Number(request.plot_limit);
  const sampled = pairs.length > plotLimit;
  const points = sampled ? Array.from({ length: plotLimit }, (_, index) => pairs[Math.floor(index * (pairs.length - 1) / (plotLimit - 1))]) : pairs;
  const values = finite.map((row) => row.values[x]!);
  const low = Math.min(...values), high = Math.max(...values), mid = low / 2 + high / 2;
  const counts = values.length ? low === high ? [values.length] : [values.filter((value) => value < mid).length, values.filter((value) => value >= mid).length] : [];
  const offset = Number(request.offset);
  const summary = (metric: string) => {
    const numbers = filtered.map((row) => row.values[metric]).filter((value): value is number => value !== null).sort((a, b) => a - b);
    return { metric: input.length ? metric : null, count: numbers.length, missing_count: filtered.length - numbers.length,
      min: numbers[0] ?? null, max: numbers.at(-1) ?? null, mean: numbers.length ? numbers.reduce((sum, value) => sum + value / numbers.length, 0) : null,
      median: numbers.length ? numbers[Math.floor(numbers.length / 2)] : null };
  };
  return { schema: "loci.population/v1", result_id: exactResult.id, revision_hash: exactResult.revision_hash, source_id: exactResult.source_id,
    source_sha256: exactResult.source_sha256!, metrics: input.length ? [{ id: "measure", label: "Area", kind: "area", unit: "um^2" }, { id: "voxel_count", label: "Pixel count", kind: "count", unit: "pixel" }] : [],
    query: { x_metric: input.length ? x : null, y_metric: input.length ? y : null, filters, sort: sort ?? null, offset, limit: Number(request.limit),
      bins: Number(request.bins), plot_limit: plotLimit, selected_label: selectedLabel }, total_count: input.length, filtered_count: filtered.length,
    accounting: { filter_excluded_count: input.length - filtered.length, filter_missing_count: input.filter((row) => filters.some(({ metric }) => row.values[metric] === null)).length,
      scatter_missing_count: filtered.length - pairs.length, metric_missing_counts: { measure: filtered.filter((row) => row.values.measure === null).length,
        voxel_count: filtered.filter((row) => row.values.voxel_count === null).length } },
    rows: ordered.slice(offset, offset + Number(request.limit)), selected: selectedRow ? { row: selectedRow, filtered_index: selectedIndex < 0 ? null : selectedIndex } : null,
    histogram: { metric: input.length ? x : null, edges: counts.length ? low === high ? [low, high] : [low, mid, high] : [], counts,
      finite_count: finite.length, missing_count: filtered.length - finite.length, endpoints: "left-closed-right-open-last-closed" },
    scatter: { points, displayed_count: points.length, total_count: pairs.length, sampled, sampling: sampled ? "deterministic-evenly-spaced-label-order" : "all" },
    summaries: { x: summary(x), y: summary(y) },
    membership_sha256: "c".repeat(64), query_sha256: "d".repeat(64) };
}
function api(run = (request: Record<string, unknown>) => Promise.resolve(response(request))) {
  return { execute: vi.fn((operation: string, request: Record<string, unknown>) => {
    if (operation !== "population_query") throw new Error("Unexpected operation"); return run(request);
  }) } as unknown as ResearchDesktopApi;
}
function mount(desktopApi = api(), selectedLabel: number | null = null, exactResult = result) {
  const onSelect = vi.fn(), onLocate = vi.fn();
  const view = render(<ResearchPopulationExplorer api={desktopApi} result={exactResult} selectedLabel={selectedLabel} onSelect={onSelect} onLocate={onLocate} />);
  return { ...view, desktopApi, onSelect, onLocate };
}
it("hands a sparse object beyond the first page to correction with the exact result revision", async () => {
  const sparse = { ...objects[999], label: 0xffffffff };
  const desktopApi = api((request) => Promise.resolve(response(request, [...objects.slice(0, 999), sparse])));
  const onEdit = vi.fn();
  render(<ResearchPopulationExplorer api={desktopApi} result={result} selectedLabel={sparse.label} onSelect={vi.fn()} onLocate={vi.fn()} onEdit={onEdit} />);
  await screen.findByLabelText("Selected population object");
  fireEvent.click(controls(".population-selected").getByRole("button", { name: "Edit selected object" }));
  expect(onEdit).toHaveBeenCalledWith({ result_id: result.id, revision_hash: result.revision_hash, label: sparse.label });
  expect(desktopApi.execute).toHaveBeenCalledWith("population_query", expect.objectContaining({ selected_label: sparse.label, offset: 0 }));
});
// The scatter keeps 500 accessible object buttons. Query the actual control
// region so an unrelated button lookup does not inspect every plotted point.
function controls(selector: string, root: ParentNode = document) {
  const region = root.querySelector<HTMLElement>(selector);
  if (!region) throw new Error(`Missing population control region: ${selector}`);
  return within(region);
}
function scatterPoint(label: string) {
  const point = screen.getByLabelText(label, { selector: "circle[role=button]" });
  expect(point).toBeVisible();
  return point;
}
async function ready() {
  await screen.findByRole("table", { name: "Population object table" });
  return controls(".population-pagination").getByRole("button", { name: "Next page" });
}
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Revision-bound object population exploration", () => {
  it("uses full counts while paging a bounded table and discloses the scatter sample", async () => {
    const { desktopApi } = mount(); await ready();
    expect(screen.getByText("1,000 of 1,000 objects match.")).toBeInTheDocument();
    expect(screen.getByText(/Display sample: 500 of 1000 valid pairs/)).toBeInTheDocument();
    expect(screen.getByText(/T 4 · Z 3/)).toBeInTheDocument();
    expect(screen.getByRole("table").querySelectorAll("tbody tr")).toHaveLength(25);
    fireEvent.click(controls(".population-pagination").getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByRole("table").querySelector("tbody tr")).toHaveAttribute("data-label", "26"));
    expect(desktopApi.execute).toHaveBeenLastCalledWith("population_query", expect.objectContaining({ offset: 25, limit: 25, plot_limit: 500 }));
    fireEvent.change(screen.getByLabelText("Population sort direction"), { target: { value: "desc" } });
    await waitFor(() => expect(screen.getByRole("table").querySelector("tbody tr")).toHaveAttribute("data-label", "1000"));
  });

  it("applies inclusive finite ranges, preserves invalid drafts and restores them with Escape", async () => {
    const { desktopApi } = mount(); await ready();
    fireEvent.click(controls(".population-filter-heading").getByRole("button", { name: "Add range" }));
    fireEvent.change(screen.getByLabelText("Population minimum"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Population maximum"), { target: { value: "5" } });
    fireEvent.click(controls(".population-filters").getByRole("button", { name: "Apply filter" }));
    await screen.findByText(/3 of 1,000 objects match/);
    expect(screen.getByRole("table").querySelectorAll("tbody tr")).toHaveLength(3);
    expect(desktopApi.execute).toHaveBeenLastCalledWith("population_query", expect.objectContaining({ filters: [{ metric: "measure", min: 3, max: 5 }] }));
    const calls = vi.mocked(desktopApi.execute).mock.calls.length;
    fireEvent.change(screen.getByLabelText("Population minimum"), { target: { value: "Infinity" } });
    fireEvent.click(controls(".population-filters").getByRole("button", { name: "Apply filter" }));
    expect(screen.getByRole("alert")).toHaveTextContent("finite bound");
    expect(screen.getByLabelText("Population minimum")).toHaveValue("Infinity");
    expect(vi.mocked(desktopApi.execute).mock.calls).toHaveLength(calls);
    fireEvent.keyDown(screen.getByLabelText("Population minimum"), { key: "Escape" });
    expect(screen.getByLabelText("Population minimum")).toHaveValue("3");
    fireEvent.click(controls(".population-filter-heading").getByRole("button", { name: "Clear filters" }));
    await screen.findByText("1,000 of 1,000 objects match.");
  });

  it("keeps other ranges and narrows histogram bins using the exact right-open boundary", async () => {
    const { desktopApi } = mount(); await ready();
    fireEvent.click(controls(".population-filter-heading").getByRole("button", { name: "Add range" }));
    fireEvent.change(screen.getByLabelText("Range 1 metric"), { target: { value: "voxel_count" } });
    fireEvent.change(screen.getByLabelText("Population minimum"), { target: { value: "201" } });
    fireEvent.change(screen.getByLabelText("Population maximum"), { target: { value: "301" } });
    fireEvent.click(controls(".population-filters").getByRole("button", { name: "Apply filter" }));
    await screen.findByText(/101 of 1,000 objects match/);
    const bin = screen.getByLabelText("200 to 250: 50 objects. Filter to this bin", { selector: "g[role=button]" });
    expect(bin).toBeVisible();
    fireEvent.click(bin);
    await screen.findByText(/50 of 1,000 objects match/);
    expect(desktopApi.execute).toHaveBeenLastCalledWith("population_query", expect.objectContaining({ filters: [
      { metric: "voxel_count", min: 201, max: 301 }, { metric: "measure", min: 200, max: previousFloat(250) },
    ] }));
    expect(previousFloat(250)).toBeLessThan(250); expect(previousFloat(-250)).toBeLessThan(-250); expect(previousFloat(0)).toBe(-Number.MIN_VALUE);
  });

  it("resolves a scatter object beyond the visible page by exact label, then locates its supplied row", async () => {
    const { desktopApi, onSelect, onLocate, rerender } = mount(); await ready();
    fireEvent.keyDown(scatterPoint("Object 1000: 1,000, 1,001"), { key: "Enter" });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(objects[999]));
    expect(desktopApi.execute).toHaveBeenLastCalledWith("population_query", expect.objectContaining({ selected_label: 1000 }));
    rerender(<ResearchPopulationExplorer api={desktopApi} result={result} selectedLabel={1000} onSelect={onSelect} onLocate={onLocate} />);
    await screen.findByLabelText("Selected population object");
    fireEvent.click(controls(".population-selected").getByRole("button", { name: "Locate selected object" }));
    expect(onLocate).toHaveBeenCalledWith(objects[999]);
    fireEvent.click(controls(".population-selected").getByRole("button", { name: "Show selected object's page" }));
    await waitFor(() => expect(screen.getByRole("table").querySelector('[data-label="1000"]')).toHaveAttribute("aria-selected", "true"));
  });

  it("keeps exact selection outside filters and supports keyboard table selection", async () => {
    const { onSelect, onLocate } = mount(api(), 1); await ready();
    fireEvent.keyDown(screen.getByRole("region", { name: "Filtered object measurements" }), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith(objects[1]);
    fireEvent.keyDown(screen.getByRole("region", { name: "Filtered object measurements" }), { key: "End" });
    expect(onSelect).toHaveBeenCalledWith(objects[24]);
    fireEvent.click(controls(".population-filter-heading").getByRole("button", { name: "Add range" }));
    fireEvent.change(screen.getByLabelText("Population minimum"), { target: { value: "100" } });
    fireEvent.click(controls(".population-filters").getByRole("button", { name: "Apply filter" }));
    await screen.findByText("This selected object is outside the current ranges.");
    fireEvent.click(controls(".population-selected").getByRole("button", { name: "Locate selected object" }));
    expect(onLocate).toHaveBeenCalledWith(objects[0]);
  });

  it.each(["revision", "source", "counts", "histogram", "hash", "metric", "query"])("refuses malformed %s responses", async (failure) => {
    const desktopApi = api(async (request) => {
      const data = response(request);
      if (failure === "revision") data.revision_hash = "f".repeat(64);
      if (failure === "source") data.source_sha256 = "f".repeat(64);
      if (failure === "counts") data.filtered_count--;
      if (failure === "histogram") data.histogram.counts[0]++;
      if (failure === "hash") data.membership_sha256 = "not-a-hash";
      if (failure === "metric") data.histogram.metric = "unknown";
      if (failure === "query") data.query.filters = [{ metric: "measure", min: 20 }];
      return data;
    });
    mount(desktopApi);
    await screen.findByRole("alert"); expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry population" })).toBeEnabled();
  });

  it("resets ranges on a new revision and discards its predecessor's delayed response", async () => {
    let resolveOld!: (data: PopulationResponse) => void;
    let oldRequest!: Record<string, unknown>;
    const desktopApi = api((request) => request.revision_hash === result.revision_hash ? new Promise((resolve) => { resolveOld = resolve; oldRequest = request; })
      : Promise.resolve(response(request, objects.slice(0, 2), { ...result, id: "result-b", revision_hash: "e".repeat(64) })));
    const { rerender } = mount(desktopApi);
    expect(screen.getByText("Reading the complete population…")).toBeInTheDocument();
    rerender(<ResearchPopulationExplorer api={desktopApi} result={{ ...result, id: "result-b", revision_hash: "e".repeat(64) }} selectedLabel={null} onSelect={vi.fn()} onLocate={vi.fn()} />);
    await screen.findByText("2 of 2 objects match.");
    resolveOld(response(oldRequest));
    await waitFor(() => expect(screen.getByText("2 of 2 objects match.")).toBeInTheDocument());
    expect(screen.queryByText("1,000 of 1,000 objects match.")).not.toBeInTheDocument();
  });

  it("accounts for missing plot values and the empty-result state", async () => {
    const few = structuredClone(objects.slice(0, 3)); few[1].values.measure = null;
    const { unmount } = mount(api(async (request) => response(request, few))); await ready();
    expect(screen.getByText(/2 finite values · 1 missing/)).toBeInTheDocument();
    expect(screen.getByText(/1 objects missing an axis value/)).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("Missing"); unmount();
    mount(api(async (request) => response(request, [])));
    await screen.findByText(/This result contains no measured objects/);
    expect(screen.getByLabelText("Population X metric")).toBeDisabled();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps finite plot coordinates when numeric ranges would overflow subtraction", async () => {
    const extreme = structuredClone(objects.slice(0, 2)); extreme[0].values.measure = -Number.MAX_VALUE; extreme[1].values.measure = Number.MAX_VALUE;
    mount(api(async (request) => response(request, extreme))); await ready();
    const circles = screen.getByRole("group", { name: /versus/ }).querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    for (const circle of circles) { expect(Number(circle.getAttribute("cx"))).toBeGreaterThanOrEqual(76); expect(Number(circle.getAttribute("cx"))).toBeLessThanOrEqual(480); }
  });

  it("uses full-population summary domains when sampling omits an extreme object", async () => {
    const sampled = structuredClone(objects);
    // Label 2 is not one of the 500 evenly spaced display labels.
    sampled[1].values.measure = 5000;
    mount(api(async (request) => response(request, sampled))); await ready();
    const plot = screen.getByRole("group", { name: /versus/ });
    expect(plot).toHaveTextContent("5,000");
    expect(screen.queryByLabelText("Object 2: 5,000, 3", { selector: "circle[role=button]" })).not.toBeInTheDocument();
    const finalPoint = scatterPoint("Object 1000: 1,000, 1,001");
    expect(Number(finalPoint.getAttribute("cx"))).toBeCloseTo(76 + (1000 - 1) / (5000 - 1) * 404);
  });
});

describe("Statistics workspace interactions", () => {
  it("zooms, pans and resets display domains without querying or filtering objects", async () => {
    const { desktopApi } = mount(); await ready();
    const calls = vi.mocked(desktopApi.execute).mock.calls.length;
    const chart = screen.getByRole("group", { name: /versus/ });
    expect(chart).toHaveAttribute("data-view-x", "1,1000");
    fireEvent.click(within(screen.getByRole("group", { name: "Relationship view controls" })).getByRole("button", { name: "Zoom in relationship" }));
    const domain = chart.getAttribute("data-view-x")!.split(",").map(Number);
    expect(domain[0]).toBeCloseTo(150.85); expect(domain[1]).toBeCloseTo(850.15);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(Number(chart.getAttribute("data-view-x")!.split(",")[0])).toBeGreaterThan(domain[0]);
    fireEvent.keyDown(chart, { key: "Home" });
    expect(chart).toHaveAttribute("data-view-x", "1,1000");
    expect(screen.getByText("1,000 of 1,000 objects match.")).toBeInTheDocument();
    expect(vi.mocked(desktopApi.execute).mock.calls).toHaveLength(calls);
  });

  it("enlarges the same view, restores focus on Escape, and uses one tab stop for scatter objects", async () => {
    mount(); await ready();
    expect(document.querySelectorAll('.population-scatter circle[tabindex="0"]')).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("group", { name: "Relationship view controls" })).getByRole("button", { name: "Zoom in relationship" }));
    const domain = screen.getByRole("group", { name: /versus/ }).getAttribute("data-view-x");
    const enlarge = controls(".population-section-heading", screen.getByRole("region", { name: "Relationship chart" }))
      .getByRole("button", { name: "Enlarge relationship chart" });
    enlarge.focus(); fireEvent.click(enlarge);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".population-scatter")).toHaveAttribute("data-view-x", domain);
    expect(controls(".population-dialog-heading", dialog).getByRole("button", { name: "Close enlarged chart" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(enlarge).toHaveFocus();
    expect(screen.getByRole("group", { name: /versus/ })).toHaveAttribute("data-view-x", domain);
  });

  it("retains filters, page and chart domain when inactive, and resets the domain on metric changes", async () => {
    const { desktopApi, onSelect, onLocate, rerender } = mount(); await ready();
    const relationshipControls = screen.getByRole("group", { name: "Relationship view controls" });
    fireEvent.click(controls(".population-filter-heading").getByRole("button", { name: "Add range" }));
    const filters = screen.getByRole("form", { name: "Population numeric filters" });
    fireEvent.change(screen.getByLabelText("Population minimum"), { target: { value: "100" } });
    fireEvent.click(within(filters).getByRole("button", { name: "Apply filter" }));
    await screen.findByText(/901 of 1,000 objects match/);
    fireEvent.click(controls(".population-pagination").getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByRole("table").querySelector("tbody tr")).toHaveAttribute("data-label", "125"));
    fireEvent.click(within(relationshipControls).getByRole("button", { name: "Zoom in relationship" }));
    const domain = screen.getByRole("group", { name: /versus/ }).getAttribute("data-view-x");
    rerender(<ResearchPopulationExplorer api={desktopApi} result={result} selectedLabel={null} onSelect={onSelect} onLocate={onLocate} active={false} />);
    rerender(<ResearchPopulationExplorer api={desktopApi} result={result} selectedLabel={null} onSelect={onSelect} onLocate={onLocate} active />);
    await waitFor(() => expect(screen.getByRole("table").querySelector("tbody tr")).toHaveAttribute("data-label", "125"));
    expect(screen.getByLabelText("Population minimum")).toHaveValue("100");
    expect(screen.getByRole("group", { name: /versus/ })).toHaveAttribute("data-view-x", domain);
    fireEvent.change(screen.getByLabelText("Population X metric"), { target: { value: "voxel_count" } });
    await waitFor(() => expect(within(relationshipControls).getByRole("button", { name: "Reset relationship view" })).toBeDisabled());
    expect(desktopApi.execute).toHaveBeenLastCalledWith("population_query", expect.objectContaining({ x_metric: "voxel_count", offset: 0, filters: [{ metric: "measure", min: 100 }] }));
  });

  it("exports canonical bindings and explicit current axes at physical size, without renderer geometry", async () => {
    const desktopApi = api();
    desktopApi.exportStatisticsFigure = vi.fn(async () => null);
    mount(desktopApi); await ready();
    fireEvent.click(within(screen.getByRole("group", { name: "Relationship view controls" })).getByRole("button", { name: "Zoom in relationship" }));
    fireEvent.click(screen.getByText("Export a publication figure"));
    fireEvent.change(screen.getByLabelText("Figure chart"), { target: { value: "scatter" } });
    fireEvent.change(screen.getByLabelText("Figure display domain"), { target: { value: "current" } });
    fireEvent.click(within(screen.getByRole("form", { name: "Statistics figure export" })).getByRole("button", { name: "Export SVG + PNG…" }));
    await screen.findByText("Export cancelled.");
    const request = vi.mocked(desktopApi.exportStatisticsFigure).mock.calls[0][0];
    expect(request).toEqual({ schema_version: "loci.statistics-figure-request/v1", source_id: result.source_id, source_sha256: result.source_sha256,
      result_id: result.id, revision_hash: result.revision_hash, query: expect.objectContaining({ offset: 0, selected_label: null, bins: 16, plot_limit: 500, sort: null }),
      query_sha256: "d".repeat(64), membership_sha256: "c".repeat(64), chart: "scatter", domain: { mode: "current", x: expect.any(Array), y: expect.any(Array) },
      width_mm: 85, height_mm: 65, preset: "publication-monochrome" });
    if (request.domain.mode === "current") { expect(request.domain.x[0]).toBeCloseTo(150.85); expect(request.domain.x[1]).toBeCloseTo(850.15); }
    fireEvent.change(screen.getByLabelText("Figure width in millimetres"), { target: { value: "99999" } });
    fireEvent.click(within(screen.getByRole("form", { name: "Statistics figure export" })).getByRole("button", { name: "Export SVG + PNG…" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(desktopApi.exportStatisticsFigure).toHaveBeenCalledTimes(1);
    // Export options survive the query refresh needed for pagination.
    fireEvent.change(screen.getByLabelText("Figure width in millimetres"), { target: { value: "90" } });
    fireEvent.click(controls(".population-pagination").getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByRole("table").querySelector("tbody tr")).toHaveAttribute("data-label", "26"));
    expect(screen.getByLabelText("Figure width in millimetres")).toHaveValue("90");
    expect(screen.getByLabelText("Figure chart")).toHaveValue("scatter");
  });
});
