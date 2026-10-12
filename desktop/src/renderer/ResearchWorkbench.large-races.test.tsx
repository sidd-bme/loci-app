// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ResearchWorkbench from "./ResearchWorkbench";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const SHA_A = "c".repeat(64);
const SHA_B = "d".repeat(64);
const RESULT_ID = "e".repeat(32);
const CHILD_ID = "f".repeat(32);
const row = { label: 1, voxel_count: 4, measure: 1, measure_unit: "um^2",
  centroid_index: [10.5, 10.5], nearest_centroid_distance: null, distance_unit: "um",
  intensity: { raw: { mean: 200, sum: 800 } } };
const source = (id: string, name: string, sha256: string): ResearchSource => ({
  id, name, sha256, source_kind: "native", metadata: { format: "OME-TIFF",
    dimensions: { x: 64, y: 64, z: 1, t: 1, c: 1 },
    levels: [{ index: 0, dimensions: { x: 64, y: 64, z: 1, t: 1, c: 1 } }],
    channel_names: ["Raw"], channel_dtypes: ["uint16"],
    physical_calibration: { unit: "um", spacing: [.5, .5] },
  },
});
const result: ResearchResult = {
  schema: "loci.research-result/v2", id: RESULT_ID, source_id: ID_A,
  source_sha256: SHA_A, kind: "large-components", created_at: "now",
  revision_hash: "1".repeat(64), object_count: 1,
  arrays: { image: { shape: [64, 64], dtype: "uint16" }, labels: { shape: [64, 64], dtype: "uint32" } },
  geometry: { axes: "YX", unit: "um", affine: [[.5, 0, 0], [0, .5, 0], [0, 0, 1]] },
  selection: { x: 0, y: 0, width: 64, height: 64, z: 0, t: 0, c: 0, level: 0 },
};
const child: ResearchResult = { ...result, id: CHILD_ID, kind: "large-corrected-labels",
  revision_hash: "2".repeat(64), parent_id: RESULT_ID, object_count: 0 };

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
    arc: vi.fn(), stroke: vi.fn(), fillText: vi.fn(), setLineDash: vi.fn(),
    save: vi.fn(), restore: vi.fn(), ellipse: vi.fn(), fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 64;
    naturalHeight = 64;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function harness(initialResult = false, delayedSelection = false) {
  let current: ResearchSnapshot = {
    project: { title: "Synthetic study" },
    sources: [source(ID_A, "Source A", SHA_A), source(ID_B, "Source B", SHA_B)],
    results: initialResult ? [result] : [], samples: [], recipes: [], displays: [],
    selections: [], jobs: [], operations: {
      large_components_preflight: { mutates: false, summary: "preflight" },
      large_components_run: { mutates: true, summary: "run" },
      large_result_view: { mutates: false, summary: "view" },
      large_result_delete: { mutates: true, summary: "delete" },
      result: { mutates: false, summary: "result" },
    },
  };
  let resolveRun!: (value: unknown) => void;
  let resolveDelete!: (value: unknown) => void;
  let resolvePick!: (value: unknown) => void;
  let resolveSelection!: () => void;
  const execute = vi.fn(async (operation: string, request: Record<string, unknown>): Promise<unknown> => {
    const target = current.sources.find((item) => item.id === request.source_id);
    if (operation === "viewer_defaults") return {
      source_id: target!.id, source_sha256: target!.sha256, basis: "Synthetic raw",
      channels: [{ channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true }],
    };
    if (operation === "source_view") return { source_id: target!.id, source_sha256: target!.sha256, revision: 0, state: null };
    if (operation === "save_source_view") return { source_id: target!.id, source_sha256: target!.sha256, revision: 1, state: request.state };
    if (operation === "source_annotations") return { source_id: target!.id, source_sha256: target!.sha256, revision: 0, annotations: [], can_undo: false, can_redo: false };
    if (operation === "viewer_tile") return {
      image: "data:image/png;base64,AA==", source_sha256: target!.sha256,
      source_extent: [64, 64], selection: request.selection ?? { t: 0, z: 0, c: 0, z_stop: null },
      projection: request.projection ?? null, width: 64, height: 64,
    };
    if (operation === "large_components_preflight") return { decoded_labels_bytes: 64 * 64 * 4, disk_required_bytes: 2 ** 20 };
    if (operation === "large_components_run") return new Promise((resolve) => { resolveRun = resolve; });
    if (operation === "large_result_delete") return new Promise((resolve) => { resolveDelete = resolve; });
    if (operation === "large_result_pick") return new Promise((resolve) => { resolvePick = resolve; });
    if (operation === "large_result_view") {
      const region = request.region as { width: number; height: number };
      return { result_id: request.result_id, revision_hash: request.revision_hash,
        region, shape: [64, 64], image_shape: [region.height, region.width], step: 1,
        image: "data:image/png;base64,AA==" };
    }
    if (operation === "result") {
      const found = current.results.find((item) => item.id === request.result_id)!;
      return { result: found, measurements: found.id === RESULT_ID ? [row] : [], total_rows: found.object_count };
    }
    if (operation === "select_result") {
      const found = current.results.find((item) => item.id === request.result_id)!;
      const publish = () => {
        const selection = { id: ID_A, revision: (current.selections.find((item) => item.id === ID_A)?.revision ?? 0) + 1,
          data: { result_id: found.id, revision_hash: found.revision_hash } };
        current = { ...current, selections: [selection] };
        return { selection, result: found };
      };
      if (delayedSelection) return new Promise((resolve) => { resolveSelection = () => resolve(publish()); });
      return publish();
    }
    return {};
  });
  const getSnapshot = vi.fn(async () => current);
  const api: ResearchDesktopApi = {
    createStudy: vi.fn(async () => current), openStudy: vi.fn(async () => current),
    addSources: vi.fn(async () => current), getSnapshot, execute,
    reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
  };
  return {
    api, execute, getSnapshot,
    completeRun() { current = { ...current, results: [...current.results, result] }; resolveRun({ result }); },
    completeDelete() { current = { ...current, results: [...current.results, child] }; resolveDelete({ result: child }); },
    completePick(measurement: typeof row | null) { resolvePick({ result_id: RESULT_ID, revision_hash: result.revision_hash, measurement }); },
    completeSelection() { resolveSelection(); },
    current: () => current,
  };
}

async function chooseAnalyze() {
  fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
  fireEvent.click(await screen.findByRole("combobox", { name: "Analyze tool" }));
  fireEvent.click(await screen.findByRole("option", { name: "Segment & measure" }));
}
async function chooseInfo() {
  fireEvent.click(await screen.findByRole("button", { name: "Results" }));
  fireEvent.click(await screen.findByRole("combobox", { name: "Results tool" }));
  fireEvent.click(await screen.findByRole("option", { name: "Review & export" }));
}
async function sourceButton(name: string) {
  const button = await screen.findByRole("button", { name: new RegExp(`^${name}`) });
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByLabelText("Active image")).toHaveTextContent(name));
}

it("keeps a completed A run in history without replacing B after A to B to A navigation", async () => {
  const state = harness();
  render(<ResearchWorkbench api={state.api} onBack={vi.fn()} />);
  await screen.findByRole("main", { name: "Research workspace" });
  await chooseAnalyze();
  fireEvent.change(screen.getByLabelText("Segmentation model"), { target: { value: "large-components" } });
  const run = await screen.findByRole("button", { name: "Segment large image" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  await waitFor(() => expect(state.execute).toHaveBeenCalledWith("large_components_run", expect.anything()));
  await sourceButton("Source B");
  await sourceButton("Source A");
  state.completeRun();
  await waitFor(() => expect(screen.getByRole("button", { name: /large-components.*1 objects/i })).toBeInTheDocument());
  expect(screen.getByLabelText("Active image")).toHaveTextContent("Source A");
  expect(screen.queryByRole("region", { name: "Large quantitative result" })).not.toBeInTheDocument();
  expect(state.execute).not.toHaveBeenCalledWith("select_result", expect.anything());
  expect(state.current().results).toHaveLength(1);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("leaves B on screen when A's large run finishes after switching sources", async () => {
  const state = harness();
  render(<ResearchWorkbench api={state.api} onBack={vi.fn()} />);
  await screen.findByRole("main", { name: "Research workspace" });
  await chooseAnalyze();
  fireEvent.change(screen.getByLabelText("Segmentation model"), { target: { value: "large-components" } });
  const run = await screen.findByRole("button", { name: "Segment large image" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  await waitFor(() => expect(state.execute).toHaveBeenCalledWith("large_components_run", expect.anything()));
  await sourceButton("Source B");
  const snapshotsBeforeCompletion = state.getSnapshot.mock.calls.length;
  state.completeRun();
  await waitFor(() => expect(state.getSnapshot.mock.calls.length).toBeGreaterThan(snapshotsBeforeCompletion));
  expect(screen.getByLabelText("Active image")).toHaveTextContent("Source B");
  expect(screen.queryByRole("region", { name: "Large quantitative result" })).not.toBeInTheDocument();
  expect(state.execute).not.toHaveBeenCalledWith("select_result", expect.anything());
  await sourceButton("Source A");
  expect(await screen.findByRole("button", { name: /large-components.*1 objects/i })).toBeInTheDocument();
});

it("does not adopt A after navigating to B while its result selection is pending", async () => {
  const state = harness(false, true);
  render(<ResearchWorkbench api={state.api} onBack={vi.fn()} />);
  await screen.findByRole("main", { name: "Research workspace" });
  await chooseAnalyze();
  fireEvent.change(screen.getByLabelText("Segmentation model"), { target: { value: "large-components" } });
  const run = await screen.findByRole("button", { name: "Segment large image" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  await waitFor(() => expect(state.execute).toHaveBeenCalledWith("large_components_run", expect.anything()));
  state.completeRun();
  await waitFor(() => expect(state.execute).toHaveBeenCalledWith("select_result", expect.anything()));
  await sourceButton("Source B");
  const snapshotsBeforeSelection = state.getSnapshot.mock.calls.length;
  state.completeSelection();
  await waitFor(() => expect(state.getSnapshot.mock.calls.length).toBeGreaterThan(snapshotsBeforeSelection));
  expect(screen.getByLabelText("Active image")).toHaveTextContent("Source B");
  expect(screen.queryByRole("region", { name: "Large quantitative result" })).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps B visible when deletion of A resolves after navigation", async () => {
  const state = harness(true);
  render(<ResearchWorkbench api={state.api} onBack={vi.fn()} />);
  await screen.findByRole("main", { name: "Research workspace" });
  const history = await screen.findByRole("button", { name: /large-components.*1 objects/i });
  await waitFor(() => expect(history).toBeEnabled());
  fireEvent.click(history);
  await chooseInfo();
  await screen.findByRole("region", { name: "Large result objects" });
  fireEvent.click(await screen.findByRole("button", { name: "#1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove object in new revision" }));
  await waitFor(() => expect(state.execute).toHaveBeenCalledWith("large_result_delete", expect.anything()));
  await sourceButton("Source B");
  const snapshotsBeforeCompletion = state.getSnapshot.mock.calls.length;
  // Settle the deliberately deferred deletion and its snapshot adoption before
  // checking the displayed source; observing the API call alone is insufficient.
  await act(async () => { state.completeDelete(); });
  await waitFor(() => expect(state.getSnapshot.mock.calls.length).toBeGreaterThan(snapshotsBeforeCompletion));
  await waitFor(() => expect(screen.getByLabelText("Active image")).toHaveTextContent("Source B"));
  expect(screen.queryByRole("region", { name: "Large quantitative result" })).not.toBeInTheDocument();
  expect(state.execute).not.toHaveBeenCalledWith("select_result", expect.anything());
  expect(state.current().results).toHaveLength(2);
  await sourceButton("Source A");
  expect(await screen.findByRole("button", { name: /large-corrected-labels.*0 objects/i })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Large quantitative result" })).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not let a delayed image pick replace the user's later table selection", async () => {
  const state = harness(true);
  render(<ResearchWorkbench api={state.api} onBack={vi.fn()} />);
  await screen.findByRole("main", { name: "Research workspace" });
  const history = await screen.findByRole("button", { name: /large-components.*1 objects/i });
  await waitFor(() => expect(history).toBeEnabled());
  fireEvent.click(history);
  await chooseInfo();
  const image = await screen.findByRole("img", { name: "Selected quantitative result region" });
  fireEvent.load(image);
  image.setPointerCapture = vi.fn();
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100,
    x: 0, y: 0, toJSON: () => ({}),
  });
  fireEvent.pointerDown(image, { button: 0, clientX: 25, clientY: 25, pointerId: 1 });
  fireEvent.pointerUp(image, { button: 0, clientX: 25, clientY: 25, pointerId: 1 });
  await waitFor(() => expect(state.execute).toHaveBeenCalledWith("large_result_pick", expect.anything()));
  fireEvent.click(await screen.findByRole("button", { name: "#1" }));
  expect(screen.getByRole("region", { name: "Selected quantitative object" })).toHaveTextContent("Object #1");
  state.completePick(null);
  await waitFor(() => expect(screen.getByRole("region", { name: "Selected quantitative object" })).toHaveTextContent("Object #1"));
});

it("keeps B visible when remote adoption on A resolves after navigation", async () => {
  const state = harness(false);
  let resolveAdopt!: (value: unknown) => void;
  const adoptedResult: ResearchResult = {
    ...result,
    id: "adopted".padEnd(32, "0"),
    revision_hash: "9".repeat(64),
    source_id: ID_A,
  };
  state.api.importLargeResult = vi.fn().mockImplementation(() => new Promise((resolve) => {
    resolveAdopt = resolve;
  }));
  render(<ResearchWorkbench api={state.api} onBack={vi.fn()} />);
  await screen.findByRole("main", { name: "Research workspace" });
  await chooseAnalyze();
  fireEvent.change(screen.getByLabelText("Segmentation model"), { target: { value: "large-components" } });
  const importBtn = await screen.findByRole("button", { name: "Import remote result…" });
  fireEvent.click(importBtn);
  await waitFor(() => expect(state.api.importLargeResult).toHaveBeenCalledWith(ID_A));
  await sourceButton("Source B");
  const snapshotsBeforeCompletion = state.getSnapshot.mock.calls.length;
  state.current().results.push(adoptedResult);
  resolveAdopt({ result: adoptedResult, snapshot: state.current() });
  await waitFor(() => expect(state.getSnapshot.mock.calls.length).toBeGreaterThan(snapshotsBeforeCompletion));
  expect(screen.getByLabelText("Active image")).toHaveTextContent("Source B");
  expect(screen.queryByRole("region", { name: "Large quantitative result" })).not.toBeInTheDocument();
  expect(state.execute).not.toHaveBeenCalledWith("select_result", expect.anything());
});

it("discovers a newly submitted adoption job while the import promise is still pending", async () => {
  const state = harness(false);
  let finish!: (value: null) => void;
  state.api.importLargeResult = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<ResearchWorkbench api={state.api} onBack={vi.fn()} />);
  await screen.findByRole("main", { name: "Research workspace" });
  await chooseAnalyze();
  fireEvent.change(screen.getByLabelText("Segmentation model"), { target: { value: "large-components" } });
  fireEvent.click(await screen.findByRole("button", { name: "Import remote result…" }));
  await waitFor(() => expect(state.api.importLargeResult).toHaveBeenCalledWith(ID_A));
  const baselineCalls = state.getSnapshot.mock.calls.length;
  // Submission happens after the picker/grant, so the previous snapshot had no job.
  state.current().jobs.push({ id: "e".repeat(32), operation: "large_result_adopt",
    request: {}, request_key: "synthetic", request_hash: "f".repeat(64), state: "running",
    created_at: "now", updated_at: "now", progress: .1, cancel_requested: false,
    result_ids: [], error: null });
  await waitFor(() => expect(state.getSnapshot.mock.calls.length).toBeGreaterThan(baselineCalls), { timeout: 2500 });
  fireEvent.click(screen.getByRole("button", { name: /Jobs/ }));
  expect(await screen.findByRole("button", { name: /^Cancel$/ })).toBeEnabled();
  finish(null);
});
