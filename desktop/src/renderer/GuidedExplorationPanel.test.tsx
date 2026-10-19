// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchJob, ResearchRecipe, ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { GuidedExplorationPanel } from "./GuidedExplorationPanel";
afterEach(cleanup);
const source: ResearchSource = { id: "a".repeat(32), sha256: "b".repeat(64), source_kind: "native", name: "Synthetic.ome.tif",
  metadata: { axes: "TCZYX", dimensions: { t: 3, c: 3, z: 3, y: 256, x: 256, s: 1 }, channel_dtypes: ["uint8", "uint8", "uint8"], sample_semantics: "none" } };
const selection: ResearchSelection = { t: 1, c: 2, z: 1, x: 8, y: 16, width: 32, height: 24, level: 0 };
const configurations = [{ threshold: 64, min_size: 4 }, { threshold: 128, min_size: 4 }, { threshold: 192, min_size: 4 }];
const regions = [selection, { ...selection, x: 48 }, { ...selection, y: 64 }];
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=";
const boundary = { execution: "crop-local", halo_pixels: 0, border_objects: "retained-with-clipped-measurements", full_image_equivalence: false, scientific_validation: "unvalidated-research-method" };
function recipe(region = selection, config = configurations[0]): ResearchRecipe {
  return { steps: [], segmentation: { method: "components", ...config, polarity: "bright", exclude_border: false }, measurement_channels: [region.c], gates: [], working_bytes: 64 * 1024 * 1024 };
}
// Full research_exploration._preview wire shape. Mock hash identities do not
// claim cryptographic verification; the engine owns seal/replay regressions.
function preview(region = selection, config = configurations[0], count = 2, currentSource = source) {
  const size = { count, measure_kind: "area", measure_unit: "pixel^2", total: count * 6, mean: count ? 6 : null, median: count ? 6 : null, min: count ? 6 : null, max: count ? 6 : null, border_object_count: 0 };
  const receipt = { schema: "loci.exploration-preview/v1" as const, source_id: currentSource.id, source_sha256: currentSource.sha256,
    selection: structuredClone(region), effective_recipe: recipe(region, config), recipe_sha256: "c".repeat(64),
    geometry: { axes: "YX", affine: [[1, 0, 0, region.x], [0, 1, 0, region.y], [0, 0, 1, 0], [0, 0, 0, 1]], unit: "pixel", frame: "image" },
    runtime: { engine: "test-engine", numpy: "test-numpy", scipy: "test-scipy", scikit_image: "test-skimage", requested_device: "auto", resolved_device: "cpu", backend: "numpy-scipy-cpu", fallback_reason: null, scientific_validation: "unvalidated-research-method" },
    boundary_policy: { ...boundary }, content_hashes: { image_array_sha256: "d".repeat(64), labels_array_sha256: "e".repeat(64), measurements_sha256: "f".repeat(64), image_png_sha256: "1".repeat(64), label_image_png_sha256: "2".repeat(64) },
    object_count: count, size_summary: size, receipt_sha256: "3".repeat(64) };
  return { preview: true, adopted: false, image: png, label_image: png, object_count: count, size_summary: size, receipt, receipt_json: JSON.stringify(receipt) };
}
function comparison() {
  const cells = regions.flatMap((region, region_index) => configurations.map((config, configuration_index) => ({ region_index, configuration_index, ...preview(region, config, configuration_index === 2 ? 0 : 2) })));
  const receipt = { schema: "loci.exploration-comparison/v1", source_id: source.id, source_sha256: source.sha256, regions: structuredClone(regions), configurations: structuredClone(configurations),
    cells: cells.map(({ region_index, configuration_index, receipt: binding }) => ({ region_index, configuration_index, receipt: binding })), boundary_policy: { ...boundary }, receipt_sha256: "4".repeat(64) };
  return { preview: true, adopted: false, cells, receipt, receipt_json: JSON.stringify(receipt), comparison: { id: "5".repeat(32), kind: "exploration", revision: 1, data: receipt } };
}
function adopted(region = selection) {
  const result: ResearchResult = { schema: "loci.research-result/v2", id: "6".repeat(32), kind: "segmentation", source_id: source.id, source_sha256: source.sha256,
    selection: structuredClone(region), revision_hash: "7".repeat(64), object_count: 2, created_at: "2026-10-18T00:00:00Z", review: { disposition: "unreviewed" } };
  return { result, measurements: [{ label: 1, measure: 6 }, { label: 2, measure: 6 }], receipt: preview(region).receipt };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve }; }
function job(id: string, operation: string, request: Record<string, unknown>, state: ResearchJob["state"] = "running"): ResearchJob {
  // research_jobs.submit_job binds exploration to the source and nests the
  // original operation request; adoption gets its source from the receipt.
  const receipt = (request.receipt ?? (typeof request.receipt_json === "string" ? JSON.parse(request.receipt_json) : undefined)) as { source_id?: string } | undefined;
  const normalized = { source_id: request.source_id ?? receipt?.source_id, task_request: structuredClone(request) };
  return { id, operation, request: normalized, state, request_key: id, request_hash: "8".repeat(64), created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z", progress: 0, cancel_requested: false, result_ids: [], error: null };
}
function mount(execute = vi.fn<ResearchDesktopApi["execute"]>(async () => preview())) {
  const getSnapshot = vi.fn(async () => ({ jobs: [] as ResearchJob[] })), cancelJob = vi.fn(async (_id: string) => ({}));
  const api = { execute, getSnapshot: async () => {
    const value = await getSnapshot();
    return { ...value, jobs: value.jobs.map((item) => {
      if (!item.id.startsWith("own-")) return item;
      const submitted = execute.mock.calls.findLast(([operation, request]) => operation === item.operation && JSON.stringify(request) === JSON.stringify(item.request.task_request));
      return { ...item, request_key: (submitted?.[2] as { request_key?: string } | undefined)?.request_key ?? item.request_key };
    }) };
  }, cancelJob } as unknown as ResearchDesktopApi;
  const props = { api, source, selection, busy: false, onBusy: vi.fn(), onResult: vi.fn(async () => {}), onUse: vi.fn() };
  return { ...render(<GuidedExplorationPanel {...props} />), props, execute, getSnapshot, cancelJob };
}
function run() { fireEvent.click(screen.getByRole("button", { name: "Preview setting 1" })); }
async function shown() { await screen.findByRole("button", { name: "Adopt this region" }); }
function addRegions(view: ReturnType<typeof mount>) { for (const region of regions) { view.rerender(<GuidedExplorationPanel {...view.props} selection={region} />); fireEvent.click(screen.getByRole("button", { name: /Add current ROI/ })); } }
function compare() { fireEvent.click(screen.getByRole("button", { name: "Compare 3 regions × 3 settings" })); }

describe("guided exploration behavior", () => {
  it("binds preview to explicit source/hash/CZT/ROI without saving a workflow or adopting", async () => {
    const view = mount(), original = structuredClone({ source, selection }); run(); await shown();
    expect(view.execute).toHaveBeenCalledExactlyOnceWith("exploration_preview", { source_id: source.id, source_sha256: source.sha256, selection, threshold: 64, min_size: 4 }, { request_key: expect.stringMatching(/^exploration:/) });
    expect(view.props.onResult).not.toHaveBeenCalled(); expect(view.props.onUse).not.toHaveBeenCalled(); expect({ source, selection }).toEqual(original);
    expect(screen.getByText(/No result has been adopted/)).toBeInTheDocument();
  });
  it.each(["c", "z", "t", "x", "level"] as const)("discards a pending preview when selection %s changes", async (field) => {
    const pending = deferred<ReturnType<typeof preview>>(), view = mount(vi.fn(async () => pending.promise)); run();
    view.rerender(<GuidedExplorationPanel {...view.props} selection={{ ...selection, [field]: selection[field] + 1 }} />);
    await act(async () => pending.resolve(preview())); expect(screen.queryByRole("button", { name: "Adopt this region" })).not.toBeInTheDocument(); expect(view.props.onResult).not.toHaveBeenCalled();
  });
  it.each(["id", "sha256"] as const)("discards a pending preview after source %s changes", async (field) => {
    const pending = deferred<ReturnType<typeof preview>>(), view = mount(vi.fn(async () => pending.promise)); run();
    view.rerender(<GuidedExplorationPanel {...view.props} source={{ ...source, [field]: "9".repeat(field === "id" ? 32 : 64) }} />);
    await act(async () => pending.resolve(preview())); expect(screen.queryByRole("button", { name: "Adopt this region" })).not.toBeInTheDocument(); expect(view.props.onResult).not.toHaveBeenCalled();
  });
  it("retains a valid zero-object preview and an undefined mean", async () => {
    const view = mount(vi.fn(async () => preview(selection, configurations[0], 0))); run(); await shown();
    expect(screen.getByText(/0 objects · mean — pixel\^2/)).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Adopt this region" })).toBeEnabled(); expect(view.props.onResult).not.toHaveBeenCalled();
  });
  it.each(["", " ", "NaN", "Infinity", "unfinished"])("blocks invalid threshold %j until Escape restores the applied value", (value) => {
    const view = mount(), input = screen.getByLabelText("Setting 1 threshold"); fireEvent.change(input, { target: { value } });
    expect(input).toHaveValue(value); expect(input).toHaveAttribute("aria-invalid", "true"); expect(screen.getByRole("button", { name: "Preview setting 1" })).toBeDisabled(); run(); expect(view.execute).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" }); expect(input).toHaveValue("64"); expect(input).toHaveAttribute("aria-invalid", "false"); expect(screen.getByRole("button", { name: "Preview setting 1" })).toBeEnabled();
  });
  it.each(["", "0", "-1", "NaN", "Infinity"])("blocks invalid minimum-area %j until Escape restores it", (value) => {
    const view = mount(), input = screen.getByLabelText("Setting 1 minimum area"); fireEvent.change(input, { target: { value } }); expect(input).toHaveValue(value);
    expect(screen.getByRole("button", { name: "Preview setting 1" })).toBeDisabled(); run(); expect(view.execute).not.toHaveBeenCalled(); fireEvent.keyDown(input, { key: "Escape" }); expect(input).toHaveValue("4"); expect(screen.getByRole("button", { name: "Preview setting 1" })).toBeEnabled();
  });
  it("accepts a positive fractional physical area without coercing to whole pixels", async () => {
    const view = mount(vi.fn(async () => preview(selection, { threshold: 64, min_size: 0.75 })));
    fireEvent.change(screen.getByLabelText("Setting 1 minimum area"), { target: { value: "0.75" } }); run(); await shown();
    expect(view.execute).toHaveBeenCalledExactlyOnceWith("exploration_preview", { source_id: source.id, source_sha256: source.sha256, selection, threshold: 64, min_size: 0.75 }, { request_key: expect.stringMatching(/^exploration:/) });
  });
  it("adopts only the exact receipt and reports a result with matching source and selection", async () => {
    const cell = preview(), output = adopted(), view = mount(vi.fn(async (operation) => operation === "exploration_run" ? output : cell)); run(); await shown();
    fireEvent.click(screen.getByRole("button", { name: "Adopt this region" })); await waitFor(() => expect(view.props.onResult).toHaveBeenCalledExactlyOnceWith(output.result, output.measurements));
    expect(view.execute).toHaveBeenNthCalledWith(2, "exploration_run", { receipt_json: cell.receipt_json }, { request_key: expect.stringMatching(/^exploration:/) });
  });
  it.each(["source_id", "source_sha256", "selection"] as const)("rejects adopted result with mismatched %s", async (field) => {
    const output = adopted(); if (field === "selection") output.result.selection = { ...selection, c: 0 }; else output.result[field] = "0".repeat(field === "source_id" ? 32 : 64);
    const view = mount(vi.fn(async (operation) => operation === "exploration_run" ? output : preview())); run(); await shown(); fireEvent.click(screen.getByRole("button", { name: "Adopt this region" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not match the preview region/); expect(view.props.onResult).not.toHaveBeenCalled();
  });
  it("binds a 3×3 comparison in region-major order and uses only the selected configuration", async () => {
    const view = mount(vi.fn(async () => comparison())); addRegions(view); compare(); const articles = await screen.findAllByRole("article"); expect(articles).toHaveLength(9);
    expect(view.execute).toHaveBeenCalledExactlyOnceWith("exploration_compare", { source_id: source.id, source_sha256: source.sha256, regions, configurations }, { request_key: expect.stringMatching(/^exploration:/) });
    expect(articles.map((article) => article.getAttribute("aria-label"))).toEqual(regions.flatMap((_, r) => configurations.map((_, c) => `Comparison region ${r + 1} setting ${c + 1}`)));
    fireEvent.click(within(articles[5]).getByRole("button", { name: "Use settings in Analyze" })); expect(view.props.onUse).toHaveBeenCalledExactlyOnceWith(recipe(regions[1], configurations[2]), regions[1]); expect(view.props.onResult).not.toHaveBeenCalled();
  });
  it("disables adoption and use-settings after ROI or configuration changes", async () => {
    const view = mount(); run(); await shown(); view.rerender(<GuidedExplorationPanel {...view.props} selection={{ ...selection, x: 48 }} />);
    expect(screen.getByRole("button", { name: "Adopt this region" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Use settings in Analyze" })).toBeDisabled();
    view.rerender(<GuidedExplorationPanel {...view.props} />); fireEvent.change(screen.getByLabelText("Setting 1 threshold"), { target: { value: "100" } }); expect(screen.getByRole("button", { name: "Adopt this region" })).toBeDisabled(); expect(screen.getByText(/Previous preview/)).toBeInTheDocument();
  });
  it.each(["missing-cell", "wrong-order", "wrong-source", "wrong-region", "wrong-count"])("rejects malformed comparison %s", async (kind) => {
    const output = comparison(); if (kind === "missing-cell") output.cells.pop(); if (kind === "wrong-order") [output.cells[0], output.cells[1]] = [output.cells[1], output.cells[0]];
    if (kind === "wrong-source") output.cells[8].receipt.source_sha256 = "0".repeat(64); if (kind === "wrong-region") output.cells[8].receipt.selection.x++; if (kind === "wrong-count") output.cells[8].object_count++;
    const view = mount(vi.fn(async () => output)); addRegions(view); compare(); await screen.findByRole("alert"); expect(screen.queryByRole("article")).not.toBeInTheDocument(); expect(view.props.onResult).not.toHaveBeenCalled();
  });
  it("rejects a preview whose effective recipe does not match the requested settings", async () => {
    const cell = preview(); cell.receipt.effective_recipe = recipe(selection, configurations[1]); const view = mount(vi.fn(async () => cell)); run();
    expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.queryByRole("article")).not.toBeInTheDocument(); expect(view.props.onResult).not.toHaveBeenCalled();
  });
  it.each(["nonfinite-affine", "wrong-unit", "negative-area", "nonfinite-mean", "empty-mean"])("rejects a preview with invalid geometry/size semantics: %s", async (kind) => {
    const cell = preview(selection, configurations[0], kind === "empty-mean" ? 0 : 2);
    if (kind === "nonfinite-affine") cell.receipt.geometry.affine[0][0] = Number.POSITIVE_INFINITY;
    if (kind === "wrong-unit") cell.size_summary.measure_unit = "mm^2";
    if (kind === "negative-area") cell.size_summary.total = -1;
    if (kind === "nonfinite-mean") cell.size_summary.mean = Number.NaN;
    if (kind === "empty-mean") cell.size_summary.mean = 0;
    const view = mount(vi.fn(async () => cell)); run();
    expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.queryByRole("article")).not.toBeInTheDocument(); expect(view.props.onResult).not.toHaveBeenCalled();
  });
  it.each(["configuration", "compact-regions", "compact-settings", "geometry"])("rejects inconsistent comparison receipt %s", async (kind) => {
    const output = comparison();
    if (kind === "configuration") output.cells[8].receipt.effective_recipe = recipe(regions[2], configurations[0]);
    if (kind === "compact-regions") output.receipt.regions[2].x++;
    if (kind === "compact-settings") output.receipt.configurations[2].threshold++;
    if (kind === "geometry") output.cells[8].receipt.geometry.axes = "ZYX";
    const view = mount(vi.fn(async () => output)); addRegions(view); compare();
    expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
  it("cancels only the job for this exact pending request, then discards its output", async () => {
    const pending = deferred<ReturnType<typeof preview>>(), view = mount(vi.fn(async () => pending.promise));
    const request = { source_id: source.id, source_sha256: source.sha256, selection, ...configurations[0] };
    view.getSnapshot.mockResolvedValue({ jobs: [job("wrong-sha", "exploration_preview", { ...request, source_sha256: "0".repeat(64) }), job("wrong-roi", "exploration_preview", { ...request, selection: { ...selection, c: 0 } }), job("wrong-setting", "exploration_preview", { ...request, threshold: 128 }), job("other-operation", "exploration_compare", request), job("finished", "exploration_preview", request, "succeeded"), job("own-job", "exploration_preview", request)] });
    run(); fireEvent.click(await screen.findByRole("button", { name: "Cancel exploration" })); await waitFor(() => expect(view.cancelJob).toHaveBeenCalledExactlyOnceWith("own-job"));
    await act(async () => pending.resolve(preview())); expect(screen.queryByRole("button", { name: "Adopt this region" })).not.toBeInTheDocument();
  });
  it("does not cancel a different exploration when this request has no running job", async () => {
    const pending = deferred<ReturnType<typeof preview>>(), view = mount(vi.fn(async () => pending.promise));
    view.getSnapshot.mockResolvedValue({ jobs: [job("another", "exploration_preview", { source_id: source.id, source_sha256: source.sha256, selection: { ...selection, x: 48 }, ...configurations[0] })] });
    run(); fireEvent.click(await screen.findByRole("button", { name: "Cancel exploration" })); await waitFor(() => expect(view.getSnapshot).toHaveBeenCalledOnce()); await act(async () => pending.resolve(preview()));
    expect(view.cancelJob).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Adopt this region" })).not.toBeInTheDocument();
  });
  it("cancels adoption by its exact receipt request and does not publish a late result", async () => {
    const pending = deferred<ReturnType<typeof adopted>>(), cell = preview();
    const view = mount(vi.fn(async (operation) => operation === "exploration_run" ? pending.promise : cell)); run(); await shown();
    view.getSnapshot.mockResolvedValue({ jobs: [job("own-adoption", "exploration_run", { receipt_json: cell.receipt_json })] });
    fireEvent.click(screen.getByRole("button", { name: "Adopt this region" })); fireEvent.click(await screen.findByRole("button", { name: "Cancel exploration" }));
    await waitFor(() => expect(view.cancelJob).toHaveBeenCalledExactlyOnceWith("own-adoption")); await act(async () => pending.resolve(adopted())); expect(view.props.onResult).not.toHaveBeenCalled();
  });
});

it("opens the complete comparison with keyboard focus and restores focus on Escape", async () => {
  const view = mount(vi.fn(async () => comparison())); addRegions(view); compare();
  await screen.findAllByRole("article");
  const enlarge = screen.getByRole("button", { name: "Enlarge parameter comparison" }); enlarge.focus(); fireEvent.click(enlarge);
  const dialog = screen.getByRole("dialog", { name: "Parameter comparison" });
  expect(within(dialog).getAllByRole("article")).toHaveLength(9);
  expect(within(dialog).getByRole("button", { name: "Close parameter comparison" })).toHaveFocus();
  expect(within(dialog).getAllByText(/Threshold 128/)).toHaveLength(3);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Parameter comparison" })).not.toBeInTheDocument();
  expect(enlarge).toHaveFocus();
});

it("retains the original comparison plane while a changed scope disables adoption", async () => {
  const view = mount(vi.fn(async () => comparison())); addRegions(view); compare(); await screen.findAllByRole("article");
  fireEvent.click(screen.getByRole("button", { name: "Enlarge parameter comparison" }));
  view.rerender(<GuidedExplorationPanel {...view.props} selection={{ ...selection, c: 0, z: 0, t: 0 }} />);
  const dialog = screen.getByRole("dialog", { name: "Parameter comparison" });
  expect(within(dialog).getByText(/C 3 \/ Z 2 \/ T 2/)).toBeInTheDocument();
  expect(within(dialog).getByRole("status")).toHaveTextContent(/Close and compare again/);
  for (const button of within(dialog).getAllByRole("button", { name: "Adopt this region" })) expect(button).toBeDisabled();
});


it("automatically cancels the exact owned request when navigation makes it obsolete", async () => {
  const pending = deferred<ReturnType<typeof preview>>(), view = mount(vi.fn(async () => pending.promise));
  const request = { source_id: source.id, source_sha256: source.sha256, selection, ...configurations[0] };
  view.getSnapshot.mockResolvedValue({ jobs: [job("another-identical-task", "exploration_preview", request), job("own-navigation-task", "exploration_preview", request)] });
  run();
  view.rerender(<GuidedExplorationPanel {...view.props} selection={{ ...selection, z: 0 }} />);
  await waitFor(() => expect(view.cancelJob).toHaveBeenCalledExactlyOnceWith("own-navigation-task"));
  await act(async () => pending.resolve(preview()));
  expect(screen.queryByRole("button", { name: "Adopt this region" })).not.toBeInTheDocument();
});


it("forwards the original sealed JSON text without rewriting integral float spellings", async () => {
  const cell = preview();
  cell.receipt_json = cell.receipt_json.replace('"threshold":64', '"threshold":64.0');
  const view = mount(vi.fn(async operation => operation === "exploration_run" ? adopted() : cell));
  run(); await shown(); fireEvent.click(screen.getByRole("button", { name: "Adopt this region" }));
  await waitFor(() => expect(view.props.onResult).toHaveBeenCalledOnce());
  expect(view.execute).toHaveBeenNthCalledWith(2, "exploration_run", { receipt_json: cell.receipt_json }, { request_key: expect.stringMatching(/^exploration:/) });
});
