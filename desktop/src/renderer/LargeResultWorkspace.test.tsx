// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { LargeAnalysisPanel, LargeResultInspector, LargeResultViewport, clampLargeRegion, fittedLargeImageSize, largeDisplayPixel } from "./LargeResultWorkspace";
import ResearchWorkbench from "./ResearchWorkbench";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const result: ResearchResult = { schema: "loci.research-result/v2", id: "r1", source_id: "s1", kind: "large-segmentation", created_at: "now", revision_hash: "a".repeat(64), object_count: 201, arrays: { image: { shape: [16384, 16384] } }, geometry: { unit: "um" } };
type Region = { x: number; y: number; width: number; height: number };
const row = { label: 19, voxel_count: 6, measure: 2.25, measure_unit: "um^2", centroid_index: [2, 3], nearest_centroid_distance: 8, distance_unit: "um", intensity: { raw: { mean: 100, sum: 600 } } };
function api(execute = vi.fn()): ResearchDesktopApi { return { execute, getSnapshot: vi.fn(), createStudy: vi.fn(), openStudy: vi.fn(), addSources: vi.fn(), reviewResult: vi.fn().mockResolvedValue({}), exportResult: vi.fn().mockResolvedValue({}), cancelJob: vi.fn() }; }
const reply = (region = { x: 0, y: 0, width: 16384, height: 16384 }) => ({ result_id: result.id, revision_hash: result.revision_hash, region, shape: [16384, 16384], image_shape: [1024, 1024], step: 16, image: "data:image/png;base64,AA==" });

it("maps displayed samples to exact native pixel indices including ragged endpoints", () => {
  const view = { ...reply(), region: { x: 501, y: 12, width: 1001, height: 503 }, image_shape: [252, 501], step: 2 };
  expect(largeDisplayPixel(view, 0, 0)).toEqual({ u: 501, v: 12 });
  expect(largeDisplayPixel(view, .99999, .99999)).toEqual({ u: 1501, v: 514 });
  expect(largeDisplayPixel(view, 1, 0)).toBeNull();
  expect(clampLargeRegion({ x: -20, y: 100, width: 60, height: 50 }, 100, 120)).toEqual({ x: 0, y: 70, width: 60, height: 50 });
});

it("fits native pixels to the stage without letterboxing the image hit bounds", async () => {
  let resized!: () => void;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {} disconnect() {}
  });
  expect(fittedLargeImageSize([64, 128], 900, 450)).toEqual({ width: 900, height: 450 });
  expect(fittedLargeImageSize([512, 512], 900, 450)).toEqual({ width: 450, height: 450 });
  const native = { ...reply({ x: 744, y: 744, width: 512, height: 512 }), step: 1, image_shape: [512, 512] };
  const execute = vi.fn().mockImplementation((_operation, request) => Promise.resolve(request.region.width === 512 ? native : reply()));
  render(<LargeResultViewport api={api(execute)} result={result} focus={{ point_index: [1000, 1000] }} onPickStart={() => 1} onPick={vi.fn()} />);
  const stage = screen.getByLabelText(/Result navigation: drag to pan/);
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 450, right: 900, bottom: 450, toJSON: () => ({}) });
  resized();
  const image = await screen.findByRole("img", { name: "Selected quantitative result region" });
  await waitFor(() => expect(image).toHaveClass("large-result-native-pixels"));
  await waitFor(() => expect(image).toHaveStyle({ width: "450px", height: "450px" }));
  expect(image).toHaveClass("large-result-native-pixels");
  expect(largeDisplayPixel(native, .5, .5)).toEqual({ u: 1000, v: 1000 });
});

it("focuses native detail on a located member pixel instead of the measured centroid", async () => {
  const execute = vi.fn().mockImplementation((_operation, request) => Promise.resolve({
    ...reply(request.region), step: 1, image_shape: [request.region.height, request.region.width],
  }));
  render(<LargeResultViewport api={api(execute)} result={result} focus={{ point_index: [1000, 1000] }} onPickStart={() => 1} onPick={vi.fn()} />);
  await waitFor(() => expect(execute).toHaveBeenCalledWith("large_result_view", expect.objectContaining({
    revision_hash: result.revision_hash, region: { x: 744, y: 744, width: 512, height: 512 },
  })));
});

it("disables scientific input synchronously while a new region is loading and rejects stale replies", async () => {
  let resolveOld!: (value: unknown) => void;
  const execute = vi.fn().mockImplementationOnce(() => Promise.resolve(reply())).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockImplementationOnce(() => Promise.resolve(reply()));
  render(<LargeResultViewport api={api(execute)} result={result} focus={null} onPickStart={() => 1} onPick={vi.fn()} />);
  const section = screen.getByRole("region", { name: "Large quantitative result" });
  await screen.findByRole("img"); fireEvent.load(screen.getByRole("img"));
  expect(section).toHaveAttribute("data-ready", "true");
  fireEvent.click(screen.getByLabelText("Zoom into large result"));
  expect(section).toHaveAttribute("data-ready", "false");
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Fit result" }));
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
  fireEvent.load(screen.getByRole("img"));
  resolveOld({ ...reply(), image: "data:image/png;base64,STALE" });
  await waitFor(() => expect(screen.getByRole("img")).not.toHaveAttribute("src", "data:image/png;base64,STALE"));
});

it("shows an error and retry instead of accepting a mismatched scientific revision", async () => {
  const execute = vi.fn().mockResolvedValueOnce({ ...reply(), revision_hash: "wrong" }).mockResolvedValue(reply());
  render(<LargeResultViewport api={api(execute)} result={result} focus={null} onPickStart={() => 1} onPick={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("exact result and region");
  fireEvent.click(screen.getByRole("button", { name: "Retry view" }));
  await screen.findByRole("img");
});

it("pages objects without a pooled summary and binds removal to the selected revision", async () => {
  const child = { ...result, id: "child", parent_id: result.id };
  const execute = vi.fn().mockImplementation((op) => Promise.resolve(op === "large_result_delete" ? { result: child } : { result, measurements: [row] }));
  const onResult = vi.fn().mockResolvedValue(undefined);
  render(<LargeResultInspector api={api(execute)} result={result} selected={row} onSelect={vi.fn()} onLocate={vi.fn()} busy={false} onBusy={vi.fn()} onError={vi.fn()} onActionStart={() => 1} onResult={onResult} onRefresh={vi.fn()} onUndo={vi.fn()} onRedo={vi.fn()} canRedo={false} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(execute).toHaveBeenCalledWith("result", { result_id: "r1", offset: 200, limit: 200 }));
  expect(screen.queryByText("Quantitative summary")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export result" })).toBeDisabled();
  const fingerprint = screen.getByText(result.revision_hash);
  expect(fingerprint).not.toBeVisible();
  fireEvent.click(screen.getByText("Technical record"));
  expect(fingerprint).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Remove object in new revision" }));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(child, 1));
  expect(execute).toHaveBeenCalledWith("large_result_delete", { result_id: result.id, revision_hash: result.revision_hash, label: 19 });
});

it("clears the previous object page synchronously while the next page is pending", async () => {
  let resolveNext!: (value: unknown) => void;
  const next = { ...row, label: 201 };
  const execute = vi.fn().mockImplementation((_operation, request) => request.offset === 0
    ? Promise.resolve({ result, measurements: [row] })
    : new Promise((resolve) => { resolveNext = resolve; }));
  render(<LargeResultInspector api={api(execute)} result={result} selected={null} onSelect={vi.fn()} onLocate={vi.fn()} busy={false} onBusy={vi.fn()} onError={vi.fn()} onActionStart={() => 1} onResult={vi.fn()} onRefresh={vi.fn()} onUndo={vi.fn()} onRedo={vi.fn()} canRedo={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "Next" }));
  expect(screen.queryByRole("button", { name: "#19" })).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Loading objects…");
  await waitFor(() => expect(execute).toHaveBeenCalledWith("result", { result_id: result.id, offset: 200, limit: 200 }));
  resolveNext({ result, measurements: [next] });
  expect(await screen.findByRole("button", { name: "#201" })).toBeInTheDocument();
});

it("uses the explicit plane/threshold policy and invalidates preflight when parameters change", async () => {
  const execute = vi.fn().mockResolvedValue({ decoded_labels_bytes: 1024 ** 3, disk_required_bytes: 3 * 1024 ** 3 });
  const source = { id: "s1", metadata: { physical_calibration: { unit: "um" } } } as ResearchSource;
  const selection = { x: 0, y: 0, width: 16384, height: 16384, c: 1, z: 2, t: 3, level: 0 };
  render(<LargeAnalysisPanel api={api(execute)} source={source} selection={selection} busy={false} onBusy={vi.fn()} onError={vi.fn()} onRunStart={() => 1} onResult={vi.fn()} />);
  const run = screen.getByRole("button", { name: "Segment large image" });
  await waitFor(() => expect(run).toBeEnabled());
  expect(execute).toHaveBeenCalledWith("large_components_preflight", expect.objectContaining({ selection, working_bytes: 256 * 1024 ** 2, segmentation: expect.objectContaining({ threshold: 100, method: "components" }) }));
  fireEvent.change(screen.getByLabelText("Large image threshold"), { target: { value: "200" } });
  expect(run).toBeDisabled();
  await waitFor(() => expect(run).toBeEnabled());
});

it("remounts identical PNG bytes for a new region and waits for that image to decode", async () => {
  const execute = vi.fn().mockImplementation((_op, request) => Promise.resolve({ ...reply(request.region), image_shape: [1024, 1024], step: request.region.width / 1024 }));
  render(<LargeResultViewport api={api(execute)} result={result} focus={null} onPickStart={() => 1} onPick={vi.fn()} />);
  const previous = await screen.findByRole("img"); fireEvent.load(previous);
  fireEvent.click(screen.getByLabelText("Zoom into large result"));
  await waitFor(() => expect(screen.getByRole("img")).not.toBe(previous));
  expect(screen.getByRole("img")).toHaveAttribute("src", previous.getAttribute("src"));
  const section = screen.getByRole("region", { name: "Large quantitative result" });
  expect(section).toHaveAttribute("data-ready", "false");
  fireEvent.load(previous);
  expect(section).toHaveAttribute("data-ready", "false");
  fireEvent.load(screen.getByRole("img"));
  expect(section).toHaveAttribute("data-ready", "true");
});

it("keeps the later table selection when an earlier image pick resolves", async () => {
  let resolvePick!: (value: unknown) => void;
  const later = { ...row, label: 20 };
  const execute = vi.fn().mockImplementation((operation: string) => {
    if (operation === "large_result_view") return Promise.resolve(reply());
    if (operation === "large_result_pick") return new Promise((resolve) => { resolvePick = resolve; });
    return Promise.resolve({ result, measurements: [row, later] });
  });
  const bridge = api(execute);
  function Workspace() {
    const intent = useRef(0);
    const [selected, setSelected] = useState<typeof row | null>(null);
    return <><LargeResultViewport api={bridge} result={result} focus={null}
      onPickStart={() => ++intent.current}
      onPick={(picked, expected) => { if (expected === intent.current) setSelected(picked as typeof row | null); }} />
      <LargeResultInspector api={bridge} result={result} selected={selected}
        onSelect={(picked) => { intent.current++; setSelected(picked as typeof row | null); }}
        onLocate={vi.fn()} busy={false} onBusy={vi.fn()} onError={vi.fn()}
        onActionStart={() => 0} onResult={vi.fn()} onRefresh={vi.fn()}
        onUndo={vi.fn()} onRedo={vi.fn()} canRedo={false} /></>;
  }
  render(<Workspace />);
  const image = await screen.findByRole("img", { name: "Selected quantitative result region" });
  fireEvent.load(image);
  image.setPointerCapture = vi.fn();
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100,
    x: 0, y: 0, toJSON: () => ({}),
  });
  fireEvent.pointerDown(image, { button: 0, clientX: 25, clientY: 25, pointerId: 1 });
  fireEvent.pointerUp(image, { button: 0, clientX: 25, clientY: 25, pointerId: 1 });
  await waitFor(() => expect(execute).toHaveBeenCalledWith("large_result_pick", expect.anything()));
  fireEvent.click(await screen.findByRole("button", { name: "#20" }));
  expect(screen.getByRole("region", { name: "Selected quantitative object" })).toHaveTextContent("Object #20");
  resolvePick({ result_id: result.id, revision_hash: result.revision_hash, measurement: row });
  await waitFor(() => expect(screen.getByRole("region", { name: "Selected quantitative object" })).toHaveTextContent("Object #20"));
});

it("does not focus a stale located pixel after a later table selection", async () => {
  const sourceId = "a".repeat(32), sourceHash = "b".repeat(64), resultId = "c".repeat(32);
  const source: ResearchSource = { id: sourceId, name: "Synthetic", sha256: sourceHash, source_kind: "native",
    metadata: { format: "OME-TIFF", dimensions: { x: 1024, y: 1024, z: 1, t: 1, c: 1 },
      levels: [{ index: 0, dimensions: { x: 1024, y: 1024, z: 1, t: 1, c: 1 } }],
      channel_names: ["Raw"], channel_dtypes: ["uint16"], physical_calibration: { unit: "um", spacing: [1, 1] } } };
  const quantitative: ResearchResult = { ...result, id: resultId, source_id: sourceId, source_sha256: sourceHash,
    object_count: 2, arrays: { image: { shape: [1024, 1024], dtype: "uint16" }, labels: { shape: [1024, 1024], dtype: "uint32" } },
    selection: { x: 0, y: 0, width: 1024, height: 1024, z: 0, t: 0, c: 0, level: 0 } };
  const second = { ...row, label: 20 };
  const snapshot: ResearchSnapshot = { project: { title: "Synthetic" }, sources: [source], results: [quantitative],
    samples: [], recipes: [], displays: [], selections: [], jobs: [], operations: {
      large_result_view: { mutates: false, summary: "view" }, large_result_locate: { mutates: false, summary: "locate" },
      result: { mutates: false, summary: "result" },
    } };
  let resolveLocate!: (value: unknown) => void;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), closePath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), fillText: vi.fn(),
    setLineDash: vi.fn(), save: vi.fn(), restore: vi.fn(), ellipse: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    naturalWidth = 1024; naturalHeight = 1024;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  const execute = vi.fn(async (operation: string, request: Record<string, unknown>): Promise<unknown> => {
    if (operation === "viewer_defaults") return { source_id: sourceId, source_sha256: sourceHash, basis: "Synthetic raw",
      channels: [{ channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true }] };
    if (operation === "source_view") return { source_id: sourceId, source_sha256: sourceHash, revision: 0, state: null };
    if (operation === "save_source_view") return { source_id: sourceId, source_sha256: sourceHash, revision: 1, state: request.state };
    if (operation === "source_annotations") return { source_id: sourceId, source_sha256: sourceHash, revision: 0, annotations: [], can_undo: false, can_redo: false };
    if (operation === "viewer_tile") return { image: "data:image/png;base64,AA==", source_sha256: sourceHash,
      source_extent: [1024, 1024], selection: request.selection ?? { t: 0, z: 0, c: 0, z_stop: null },
      projection: request.projection ?? null, width: 1024, height: 1024 };
    if (operation === "large_result_view") {
      const region = request.region as Region;
      return { result_id: resultId, revision_hash: quantitative.revision_hash, region, shape: [1024, 1024],
        image_shape: [region.height, region.width], step: 1, image: "data:image/png;base64,AA==" };
    }
    if (operation === "large_result_locate") return new Promise((resolve) => { resolveLocate = resolve; });
    if (operation === "result") return { result: quantitative, measurements: [row, second], total_rows: 2 };
    if (operation === "select_result") return { selection: { id: sourceId, revision: 1,
      data: { result_id: resultId, revision_hash: quantitative.revision_hash } }, result: quantitative };
    return {};
  });
  const bridge = { ...api(execute), getSnapshot: vi.fn().mockResolvedValue(snapshot) };
  render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
  const history = await screen.findByRole("button", { name: /Threshold segmentation.*2 objects/i });
  await waitFor(() => expect(history).toBeEnabled());
  fireEvent.click(history);
  fireEvent.click(await screen.findByRole("button", { name: "Results" }));
  fireEvent.click(await screen.findByRole("combobox", { name: "Results tool" }));
  fireEvent.click(await screen.findByRole("option", { name: "Review & export" }));
  await screen.findByRole("region", { name: "Large result objects" });
  fireEvent.click(await screen.findByRole("button", { name: "#19" }));
  fireEvent.click(screen.getByRole("button", { name: "Inspect object pixels" }));
  await waitFor(() => expect(execute).toHaveBeenCalledWith("large_result_locate", { result_id: resultId,
    revision_hash: quantitative.revision_hash, label: 19 }));
  fireEvent.click(screen.getByRole("button", { name: "#20" }));
  await act(async () => resolveLocate({ result_id: resultId, revision_hash: quantitative.revision_hash, label: 19, point_index: [100, 100] }));
  await waitFor(() => expect(screen.getByRole("region", { name: "Selected quantitative object" })).toHaveTextContent("Object #20"));
  expect(execute.mock.calls.filter(([operation, request]) => operation === "large_result_view" && (request.region as Region).width === 512)).toHaveLength(0);
});

it("renders remote import button and invokes importLargeResult with source id", async () => {
  const onResult = vi.fn().mockResolvedValue(undefined);
  const onRunStart = vi.fn().mockReturnValue(42);
  const source: ResearchSource = {
    id: "s1",
    name: "Source",
    sha256: "s".repeat(64),
    metadata: { dimensions: { t: 1, c: 1, z: 1, y: 1024, x: 1024 } },
  };
  const importedResult: ResearchResult = {
    ...result,
    id: "imported_r1",
    source_id: "s1",
  };
  const importLargeResult = vi.fn().mockResolvedValue({
    result: importedResult,
    snapshot: {},
  });
  const customApi = {
    ...api(),
    importLargeResult,
  };
  render(
    <LargeAnalysisPanel
      api={customApi}
      source={source}
      selection={{ t: 0, c: 0, z: 0, x: 0, y: 0, width: 1024, height: 1024, level: 0 }}
      busy={false}
      onBusy={vi.fn()}
      onError={vi.fn()}
      onRunStart={onRunStart}
      onResult={onResult}
    />
  );
  const importBtn = await screen.findByRole("button", { name: "Import remote result…" });
  expect(importBtn).toBeInTheDocument();
  fireEvent.click(importBtn);
  await waitFor(() => expect(importLargeResult).toHaveBeenCalledWith("s1"));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(importedResult, 42));
});
