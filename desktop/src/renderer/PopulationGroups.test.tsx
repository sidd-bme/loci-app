// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult } from "../shared/research-contracts";
import { checkedMembership, PopulationGroups } from "./PopulationGroups";
import type { PopulationResponse } from "./ResearchPopulationExplorer";
import { fullChartView } from "./population-chart-view";

const X = "intensity:7261772058:mean", Y = "intensity:7261772059:mean";
const result: ResearchResult = {
  schema: "loci.research-result/v1", id: "a".repeat(32), revision_hash: "b".repeat(64),
  source_id: "c".repeat(32), source_sha256: "d".repeat(64), kind: "segmentation",
  created_at: "2026-10-18T00:00:00+00:00", object_count: 1000,
  arrays: { labels: { shape: [100, 10], dtype: "uint32" } },
};
const binding = (current = result) => ({ result_id: current.id, revision_hash: current.revision_hash,
  source_id: current.source_id, source_sha256: current.source_sha256! });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const allLabels = Array.from({ length: 1000 }, (_, index) => index + 1);
const xDescriptor = { id: X, label: "raw X mean", kind: "intensity", unit: "source-intensity", channel: "raw X", statistic: "mean" };
const yDescriptor = { id: Y, label: "raw Y mean", kind: "intensity", unit: "source-intensity", channel: "raw Y", statistic: "mean" };
function membership(labels = [2, 3, 4], current = result) {
  const gate = { kind: "rectangle", x_metric: X, y_metric: Y, x_transform: "linear", y_transform: "linear",
    x_descriptor: xDescriptor, y_descriptor: yDescriptor, bounds: [2, 4, 4, 8], edge_policy: "include" };
  return {
    schema: "loci.population-gate/v1", ...binding(current), total_count: 1000,
    included_count: labels.length, labels, membership_sha256: sha({ ...binding(current), labels }),
    population_sha256: sha({ ...binding(current), labels: allLabels }), gate_sha256: sha(gate), gate,
    accounting: { excluded_missing_or_nonfinite_count: 0, excluded_nonpositive_log_count: 0,
      excluded_outside_count: 1000 - labels.length, axis_missing_or_nonfinite_counts: { x: 0, y: 0 },
      axis_nonpositive_log_counts: { x: 0, y: 0 } },
    centroids: labels.map((label) => ({ label, centroid_index: [Math.floor(((label - 1) % 1000) / 10), (label - 1) % 10], index_axes: "YX" })),
  };
}
type MembershipFixture = ReturnType<typeof membership>;
function populationData(current = result, xMetric = X): PopulationResponse {
  const value = (label: number, metric: string) => metric === X ? label : metric === Y ? label * 2 : 1;
  const summary = (metric: string) => ({ metric, count: 1000, missing_count: 0,
    min: value(1, metric), max: value(1000, metric), mean: value(500.5, metric), median: value(500.5, metric) });
  return {
    schema: "loci.population/v1", ...binding(current),
    metrics: [xDescriptor, yDescriptor,
      { id: "measure", label: "Area", kind: "area", unit: "pixel^2" }],
    query: { x_metric: xMetric, y_metric: Y, filters: [], sort: null, offset: 0, limit: 25,
      bins: 2, plot_limit: 500, selected_label: null }, total_count: 1000, filtered_count: 1000,
    accounting: { filter_excluded_count: 0, filter_missing_count: 0, scatter_missing_count: 0,
      metric_missing_counts: { [X]: 0, [Y]: 0, measure: 0 } },
    rows: allLabels.slice(0, 25).map((label) => ({ label, values: { [X]: label, [Y]: label * 2, measure: 1 },
      index_axes: "YX", centroid_index: [Math.floor((label - 1) / 10), (label - 1) % 10] })), selected: null,
    scatter: { points: allLabels.filter((label) => label % 2 === 1).map((label) => ({ label, x: value(label, xMetric), y: label * 2 })),
      total_count: 1000, displayed_count: 500, sampled: true, sampling: "deterministic-evenly-spaced-label-order" },
    histogram: { metric: xMetric, edges: xMetric === "measure" ? [1, 1] : [1, 501, 1000],
      counts: xMetric === "measure" ? [1000] : [500, 500], finite_count: 1000,
      missing_count: 0, endpoints: "left-closed-right-open-last-closed" },
    summaries: { x: summary(xMetric), y: summary(Y) }, membership_sha256: "7".repeat(64), query_sha256: "8".repeat(64),
  };
}
function summary(id: string, name: string, labels = [2, 3, 4], current = result, kind = "gate") {
  return { id, name, ...binding(current), definition_kind: kind, included_count: labels.length,
    total_count: 1000, membership_sha256: membership(labels, current).membership_sha256, record_sha256: "5".repeat(64) };
}
const left = summary("1".repeat(32), "Left", [1, 2, 3]);
const right = summary("2".repeat(32), "Right", [2, 3, 4]);
function saved(id = "3".repeat(32), name = "Named", labels = [2, 3, 4], current = result) {
  const { centroids: _centroids, ...receipt } = membership(labels, current);
  const data = { schema: "loci.population-group/v1", id, name, definition: { kind: "gate", gate: receipt.gate }, receipt };
  return { id, kind: "population_group", revision: 1, updated_at: "2026-10-18T00:00:00+00:00",
    data: { ...data, record_sha256: sha(data) } };
}
type Run = (operation: string, request: Record<string, unknown>) => Promise<unknown>;
function mount(run?: Run, groups = [left, right]) {
  const execute = vi.fn<Run>(run ?? (async (operation) => {
    if (operation === "population_group_list") return { schema: "loci.population-group-list/v1", groups };
    if (operation === "population_gate_evaluate") return membership();
    if (operation === "population_group_save") return saved();
    throw new Error(`Unexpected operation: ${operation}`);
  }));
  const api = { execute } as unknown as ResearchDesktopApi;
  const onHighlight = vi.fn(), onSelect = vi.fn(), onViewChange = vi.fn();
  const element = (current = result, data = populationData(current)) => <PopulationGroups api={api} result={current}
    data={data} disabled={false} selectedLabel={null} view={fullChartView()} onViewChange={onViewChange}
    onSelect={onSelect} onBinChoose={vi.fn()} onHighlight={onHighlight} />;
  const rendered = render(element());
  return { ...rendered, api, execute, onHighlight, onSelect, onViewChange,
    replace: (current = result, data = populationData(current)) => rendered.rerender(element(current, data)) };
}
function editor() { return within(screen.getByRole("region", { name: "Population gates and groups" })); }
async function open() {
  fireEvent.click(screen.getByText("Gates & named groups", { selector: "button" }));
  await waitFor(() => expect(screen.getByLabelText("Combine group Left")).toBeInTheDocument());
}
function setRectangle(bounds = [2, 4, 4, 8]) {
  fireEvent.change(screen.getByLabelText("Population gate tool"), { target: { value: "rectangle" } });
  for (const [index, label] of ["X minimum", "X maximum", "Y minimum", "Y maximum"].entries()) {
    fireEvent.change(screen.getByLabelText(`Gate ${label}`), { target: { value: String(bounds[index]) } });
  }
}
function evaluate() { fireEvent.click(editor().getByRole("button", { name: "Evaluate gate on all objects" })); }
async function highlighted(count = 3) {
  await waitFor(() => expect(editor().getByText(`${count.toLocaleString()} of 1,000 objects in highlighted membership.`)).toBeInTheDocument());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Exact membership response validation", () => {
  it("accepts the full engine-shaped sparse membership without using the scatter sample", () => {
    const receipt = membership([1, 42, 90000]);
    expect(checkedMembership(receipt, result)).toBe(receipt);
    expect(receipt.membership_sha256).toBe(sha({ ...binding(), labels: [1, 42, 90000] }));
  });
  const failures: Array<[string, (receipt: MembershipFixture) => void]> = [
    ["result", (receipt) => { receipt.result_id = "f".repeat(32); }],
    ["revision", (receipt) => { receipt.revision_hash = "f".repeat(64); }],
    ["source ID", (receipt) => { receipt.source_id = "f".repeat(32); }],
    ["source SHA", (receipt) => { receipt.source_sha256 = "f".repeat(64); }],
    ["hash", (receipt) => { receipt.membership_sha256 = "not-a-sha256"; }],
    ["count", (receipt) => { receipt.included_count = 2; }],
    ["over-limit population", (receipt) => { receipt.total_count = 100001; }],
    ["duplicate labels", (receipt) => { receipt.labels = [2, 2, 4]; }],
    ["unsorted labels", (receipt) => { receipt.labels = [4, 3, 2]; }],
    ["background label", (receipt) => { receipt.labels[0] = 0; }],
    ["noninteger label", (receipt) => { receipt.labels[0] = 1.5; }],
    ["centroid identity", (receipt) => { receipt.centroids[0].label = 1; }],
    ["centroid axes", (receipt) => { receipt.centroids[0].index_axes = "XY"; }],
    ["centroid dimensions", (receipt) => { receipt.centroids[0].centroid_index = [1]; }],
    ["nonfinite centroid", (receipt) => { receipt.centroids[0].centroid_index[0] = Infinity; }],
  ];
  it.each(failures)("refuses stale or malformed %s before highlighting", (_name, mutate) => {
    const receipt = membership(); mutate(receipt);
    expect(() => checkedMembership(receipt, result)).toThrow(/exact result revision/);
  });
});

describe("Reproducible gate and named group controls", () => {
  it("submits exact keyboard rectangle bounds and saves the evaluated membership hash with the trimmed name", async () => {
    const { execute, onHighlight, onSelect } = mount(); await open(); setRectangle(); evaluate(); await highlighted();
    expect(execute).toHaveBeenCalledWith("population_gate_evaluate", {
      result_id: result.id, revision_hash: result.revision_hash, include_centroids: true,
      gate: { kind: "rectangle", x_metric: X, y_metric: Y, x_transform: "linear", y_transform: "linear", bounds: [2, 4, 4, 8] },
    });
    expect(onHighlight).toHaveBeenLastCalledWith(membership());
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Population group name"), { target: { value: "  Positives  " } });
    fireEvent.click(editor().getByRole("button", { name: "Save fixed group & gate" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("population_group_save", {
      result_id: result.id, revision_hash: result.revision_hash, name: "Positives",
      gate: { kind: "rectangle", x_metric: X, y_metric: Y, x_transform: "linear", y_transform: "linear", bounds: [2, 4, 4, 8] },
      membership_sha256: membership().membership_sha256,
    }));
  });

  it("uses complete membership of 1000 objects while only 500 scatter points are drawn", async () => {
    const { container, onHighlight } = mount(async (operation) => operation === "population_group_list" ? { groups: [left, right] } : membership(allLabels));
    await open(); setRectangle([1, 1000, 2, 2000]); evaluate(); await highlighted(1000);
    const highlightedMembership = onHighlight.mock.calls.at(-1)![0] as MembershipFixture;
    expect(highlightedMembership.labels).toHaveLength(1000);
    expect(highlightedMembership.labels).toContain(1000);
    expect(container.querySelector('[data-point-label="1000"]')).toBeNull();
    expect(container.querySelectorAll("circle.population-point")).toHaveLength(500);
    expect(container.querySelectorAll("circle.population-point.selected")).toHaveLength(500);
  });

  it("submits polygon geometry in the chosen log10 coordinates and keeps accounting visible", async () => {
    const labels = [1, 2, 3, 4, 5, 6, 7]; // raw X*raw Y <= 100; label 8 gives 128.
    const { execute } = mount(async (operation) => operation === "population_group_list" ? { groups: [left, right] } : membership(labels));
    await open();
    fireEvent.change(screen.getByLabelText("Population gate tool"), { target: { value: "polygon" } });
    for (const axis of ["X", "Y"]) fireEvent.change(screen.getByLabelText(`Gate ${axis} transform`), { target: { value: "log10" } });
    fireEvent.change(screen.getByLabelText("Gate polygon vertices"), { target: { value: "0, 0\n2, 0\n0, 2" } });
    evaluate(); await highlighted(7);
    expect(execute).toHaveBeenCalledWith("population_gate_evaluate", {
      result_id: result.id, revision_hash: result.revision_hash, include_centroids: true,
      gate: { kind: "polygon", x_metric: X, y_metric: Y, x_transform: "log10", y_transform: "log10", vertices: [[0, 0], [2, 0], [0, 2]] },
    });
    expect(editor().getByText(/993 outside. Edges included/)).toBeInTheDocument();
    expect(document.querySelectorAll(".population-gate-outline")).toHaveLength(1);
  });

  it.each(["blank", "nonfinite", "reversed"])("refuses %s rectangle drafts before an engine request", async (problem) => {
    const { execute } = mount(); await open(); setRectangle();
    fireEvent.change(screen.getByLabelText("Gate X minimum"), { target: { value: problem === "blank" ? "" : problem === "nonfinite" ? "Infinity" : "5" } });
    evaluate(); await screen.findByRole("alert");
    expect(execute.mock.calls.some(([operation]) => operation === "population_gate_evaluate")).toBe(false);
  });

  it("loads a fixed saved group with the exact revision and complete centroids", async () => {
    const { execute, onHighlight } = mount(async (operation) => {
      if (operation === "population_group_list") return { groups: [left, right] };
      return { group: saved(left.id, "Left", [1, 2, 3]), membership: membership([1, 2, 3]) };
    });
    await open(); fireEvent.click(editor().getByRole("button", { name: "Highlight Left" })); await highlighted();
    expect(execute).toHaveBeenCalledWith("population_group_get", {
      result_id: result.id, revision_hash: result.revision_hash, group_id: left.id, include_centroids: true,
    });
    expect(onHighlight.mock.calls.at(-1)![0].labels).toEqual([1, 2, 3]);
    expect(editor().getByRole("button", { name: "Save fixed group & gate" })).toBeDisabled();
  });

  it.each(["union", "intersection", "unclassified"] as const)("creates an exact %s group from overlapping fixed groups", async (mode) => {
    const labels = mode === "union" ? [1, 2, 3, 4] : mode === "intersection" ? [2, 3] : allLabels.slice(4);
    const generated = saved("4".repeat(32), `Combined ${mode}`, labels);
    let combined = false;
    const { execute, onHighlight } = mount(async (operation) => {
      if (operation === "population_group_list") return { groups: [left, right, ...(combined ? [summary(generated.id, generated.data.name, labels, result, "combination")] : [])] };
      if (operation === "population_group_combine") { combined = true; return generated; }
      return { group: generated, membership: membership(labels) };
    });
    await open();
    fireEvent.click(screen.getByLabelText("Combine group Left")); fireEvent.click(screen.getByLabelText("Combine group Right"));
    fireEvent.change(screen.getByLabelText("Population group name"), { target: { value: generated.data.name } });
    fireEvent.click(editor().getByRole("button", { name: `Save ${mode}` }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("population_group_combine", {
      result_id: result.id, revision_hash: result.revision_hash, group_ids: [left.id, right.id], name: generated.data.name, mode,
    }));
    const checkbox = await screen.findByLabelText(`Combine group ${generated.data.name}`);
    expect(checkbox.closest("li")).toHaveTextContent(`${generated.data.name} · ${labels.length}`);
    fireEvent.click(editor().getByRole("button", { name: `Highlight ${generated.data.name}` })); await highlighted(labels.length);
    expect(onHighlight.mock.calls.at(-1)![0].labels).toEqual(labels);
  });

  it("applies a reusable gate from another result as a newly named group on the current revision", async () => {
    const otherResult = { ...result, id: "e".repeat(32), revision_hash: "f".repeat(64) };
    const reference = summary("6".repeat(32), "Reference", [1, 2, 3], otherResult);
    const created = saved("7".repeat(32), "Applied", [2, 3, 4]);
    let applied = false;
    const { execute } = mount(async (operation) => {
      if (operation === "population_group_list") return { groups: [left, right, reference, ...(applied ? [summary(created.id, "Applied")] : [])] };
      if (operation === "population_gate_apply") { applied = true; return created; }
      throw new Error(`Unexpected operation: ${operation}`);
    });
    await open(); fireEvent.change(screen.getByLabelText("Population group name"), { target: { value: "Applied" } });
    fireEvent.click(editor().getByText("Apply a saved gate to this result", { selector: "summary" }));
    fireEvent.click(editor().getByRole("button", { name: "Apply Reference as new group" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("population_gate_apply", {
      result_id: result.id, revision_hash: result.revision_hash, group_id: reference.id, name: "Applied",
    }));
    expect(await screen.findByLabelText("Combine group Applied")).toBeInTheDocument();
    expect(created.id).not.toBe(reference.id);
  });

  it("isolates unavailable-source groups while keeping intact current groups usable and reusable gates discoverable", async () => {
    const otherResult = { ...result, id: "e".repeat(32), revision_hash: "f".repeat(64), source_id: "9".repeat(32), source_sha256: "9".repeat(64) };
    const unavailableOtherGate = { ...summary("6".repeat(32), "Unavailable Other Gate", [1, 2, 3], otherResult), source_available: false };
    const unavailableOwnGroup = { ...summary("8".repeat(32), "Unavailable Own", [5], result), source_available: false };
    const created = saved("7".repeat(32), "Applied Reused", [2, 3, 4]);
    let applied = false;
    const { execute } = mount(async (operation) => {
      if (operation === "population_group_list") return { groups: [left, unavailableOwnGroup, unavailableOtherGate, ...(applied ? [summary(created.id, "Applied Reused")] : [])] };
      if (operation === "population_gate_apply") { applied = true; return created; }
      if (operation === "population_group_get") return { group: saved(left.id, "Left", [1, 2, 3]), membership: membership([1, 2, 3]) };
      throw new Error(`Unexpected operation: ${operation}`);
    });
    await open();
    expect(screen.getByLabelText("Combine group Left")).toBeEnabled();
    expect(editor().getByRole("button", { name: "Highlight Left" })).toBeEnabled();

    expect(screen.getByText(/Unavailable Own · 1 \(source unavailable\)/)).toBeInTheDocument();
    expect(screen.getByLabelText("Combine group Unavailable Own")).toBeDisabled();
    expect(editor().getByRole("button", { name: "Highlight Unavailable Own" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Population group name"), { target: { value: "Applied Reused" } });
    fireEvent.click(editor().getByText("Apply a saved gate to this result", { selector: "summary" }));
    fireEvent.click(editor().getByRole("button", { name: "Apply Unavailable Other Gate as new group" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("population_gate_apply", {
      result_id: result.id, revision_hash: result.revision_hash, group_id: unavailableOtherGate.id, name: "Applied Reused",
    }));
    expect(await screen.findByLabelText("Combine group Applied Reused")).toBeInTheDocument();
  });
});

describe("Gate response invalidation", () => {
  it.each(["geometry", "metric", "result"])("does not highlight a delayed response after %s changes", async (change) => {
    const pending = deferred<MembershipFixture>();
    const { execute, container, replace, onHighlight } = mount(async (operation) => operation === "population_group_list" ? { groups: [left, right] } : pending.promise);
    await open(); setRectangle(); evaluate();
    expect(execute.mock.calls.some(([operation]) => operation === "population_gate_evaluate")).toBe(true);
    if (change === "geometry") {
      fireEvent.keyDown(container.querySelector("svg.population-chart")!, { key: "Escape" });
      expect(screen.getByLabelText("Gate X minimum")).toHaveValue("");
    } else if (change === "metric") replace(result, populationData(result, "measure"));
    else replace({ ...result, id: "e".repeat(32), revision_hash: "f".repeat(64), parent_id: result.id });
    await act(async () => { pending.resolve(membership()); await pending.promise; });
    expect(onHighlight.mock.calls.filter(([value]) => value !== null)).toHaveLength(0);
    expect(container.querySelectorAll("circle.population-point.selected")).toHaveLength(0);
    expect(screen.queryByText(/objects in highlighted membership/)).not.toBeInTheDocument();
  });

  it("clears fixed membership when a correction creates a new revision and keeps parent groups out of the new list", async () => {
    const { replace, onHighlight, container } = mount(); await open(); setRectangle(); evaluate(); await highlighted();
    expect(container.querySelectorAll("circle.population-point.selected")).toHaveLength(1); // Only label 3 is displayed.
    replace({ ...result, id: "e".repeat(32), revision_hash: "f".repeat(64), parent_id: result.id });
    expect(onHighlight).toHaveBeenLastCalledWith(null);
    expect(container.querySelectorAll("circle.population-point.selected")).toHaveLength(0);
    expect(screen.queryByLabelText("Combine group Left")).not.toBeInTheDocument();
    expect(editor().getByText("No named groups on this revision yet.")).toBeInTheDocument();
  });

  it("clears selected combination operands when a correction creates a new revision", async () => {
    const { replace } = mount(); await open();
    fireEvent.click(screen.getByLabelText("Combine group Left"));
    fireEvent.change(screen.getByLabelText("Population group name"), { target: { value: "New combination" } });
    expect(editor().getByRole("button", { name: "Save union" })).toBeEnabled();
    replace({ ...result, id: "e".repeat(32), revision_hash: "f".repeat(64), parent_id: result.id });
    expect(screen.queryByLabelText("Combine group Left")).not.toBeInTheDocument();
    expect(editor().getByRole("button", { name: "Save union" })).toBeDisabled();
  });

  it("refuses an engine response carrying another source identity without highlighting it", async () => {
    const wrong = membership(); wrong.source_sha256 = "0".repeat(64);
    const { onHighlight } = mount(async (operation) => operation === "population_group_list" ? { groups: [left, right] } : wrong);
    await open(); setRectangle(); evaluate();
    expect(await screen.findByRole("alert")).toHaveTextContent("exact result revision");
    expect(onHighlight.mock.calls.filter(([value]) => value !== null)).toHaveLength(0);
  });
});
