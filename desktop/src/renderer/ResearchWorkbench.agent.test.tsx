// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench from "./ResearchWorkbench";
import type { ResearchAgentSessionsSnapshot, ResearchDesktopApi, ResearchResult, ResearchSelection, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import engineFixture from "./__fixtures__/agent-sessions-snapshot.json";
import type { SharedTaskPreview } from "./AgentPreviewComparison";

const wire = engineFixture as ResearchAgentSessionsSnapshot;
const ID_A = "a".repeat(32), ID_B = "b".repeat(32), SHA_A = "c".repeat(64), SHA_B = "d".repeat(64);
const RESULT_ID = "e".repeat(32);
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=";
const dimensions = { x: 512, y: 512, z: 5, t: 2, c: 2 };
const selection: ResearchSelection = { x: 0, y: 0, width: 512, height: 512, t: 0, c: 0, z: 2, level: 0 };
const geometry = { axes: "YX", unit: "um", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] };
const result: ResearchResult = { id: RESULT_ID, source_id: ID_A, source_sha256: SHA_A, kind: "cell-segmentation",
  created_at: "2026-10-27T00:01:00Z", revision_hash: "f".repeat(64), object_count: 1, geometry, selection,
  arrays: { image: { shape: [512, 512], dtype: "uint16" }, labels: { shape: [512, 512], dtype: "uint32" } } };
let polls: Array<() => void>;
let now: number;

beforeEach(() => {
  now = 20_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  polls = [];
  const interval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 2000 && typeof handler === "function") { polls.push(handler as () => void); return 9999; }
    return interval(handler, timeout, ...args);
  }) as typeof window.setInterval);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(Object.fromEntries([
    "setTransform", "fillRect", "clearRect", "drawImage", "beginPath", "moveTo", "lineTo", "closePath", "arc", "stroke",
    "fillText", "setLineDash", "save", "restore", "ellipse", "fill", "scale", "putImageData",
  ].map((key) => [key, vi.fn()])) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const visible = this.classList?.contains("image-viewport");
    return { x: 0, y: 0, left: 0, top: 0, right: visible ? 640 : 0, bottom: visible ? 480 : 0,
      width: visible ? 640 : 0, height: visible ? 480 : 0, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    naturalWidth = 512; naturalHeight = 512;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function source(id: string, sha256: string, name: string): ResearchSource {
  return { id, sha256, name, source_kind: "native", metadata: { axes: "TCZYX", dimensions,
    levels: [{ index: 0, dimensions }], channel_names: ["Raw", "Ramp"], channel_dtypes: ["uint16", "uint16"],
    physical_calibration: { unit: "um", spacing: [1, 1, 1] } } };
}

function harness() {
  let current: ResearchSnapshot = { project: { title: "Agent navigation races", project_id: "0".repeat(32) },
    sources: [source(ID_A, SHA_A, "Source A"), source(ID_B, SHA_B, "Source B")], results: [],
    jobs: [], samples: [], recipes: [], displays: [], selections: [], operations: {},
    agent_sessions: { ...wire, status: "connected_idle", pending_approval_count: 0, approvals: [], events: [],
      sessions: [{ ...wire.sessions[0], state: "connected_idle", current_operation: null, recent_result_ids: [], active_approval_id: null }],
    },
  };
  let resultPage!: (value: unknown) => void, resultView!: (value: unknown) => void;
  let sourceView!: (value: unknown) => void;
  let previewOutput!: (value: unknown) => void;
  let delayedSource: string | null = null;
  const execute = vi.fn(async (operation: string, request: Record<string, unknown>): Promise<unknown> => {
    const target = current.sources.find((item) => item.id === request.source_id);
    if (operation === "viewer_defaults") return { source_id: target!.id, source_sha256: target!.sha256, basis: "Synthetic acquisition range",
      channels: [{ channel: 0, low: 0, high: 65535, gamma: 1, color: "#ff0000", opacity: 1, visible: true },
        { channel: 1, low: 10, high: 4095, gamma: 1.2, color: "#00ff00", opacity: 0.8, visible: false }] };
    if (operation === "source_view") {
      if (request.source_id === delayedSource) return new Promise((resolve) => { sourceView = resolve; });
      return { source_id: target!.id, source_sha256: target!.sha256, revision: 0, state: null };
    }
    if (operation === "save_source_view") return { source_id: target!.id, source_sha256: target!.sha256,
      revision: Number(request.expected_revision) + 1, state: request.state };
    if (operation === "source_annotations") return { source_id: target!.id, source_sha256: target!.sha256,
      revision: 0, annotations: [], can_undo: false, can_redo: false };
    if (operation === "viewer_tile") return { image: png, source_sha256: target!.sha256,
      source_extent: [512, 512], selection: request.selection ?? { t: 0, z: 2, c: 0, z_stop: null },
      projection: request.projection ?? null, width: 512, height: 512 };
    if (operation === "result") return new Promise((resolve) => { resultPage = resolve; });
    if (operation === "result_view") return new Promise((resolve) => { resultView = resolve; });
    if (operation === "task_preview_get") return new Promise((resolve) => { previewOutput = resolve; });
    return {};
  });
  const api: ResearchDesktopApi = { createStudy: vi.fn(async () => current), openStudy: vi.fn(async () => current),
    getSnapshot: vi.fn(async () => current), addSources: vi.fn(async () => current), execute,
    reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn() };
  return { api, execute,
    publishResult() { current = { ...current, results: [result], agent_sessions: { ...current.agent_sessions!,
      sessions: current.agent_sessions!.sessions.map((session) => ({ ...session, recent_result_ids: [RESULT_ID] })) } }; },
    publishSource() { current = { ...current, agent_sessions: { ...current.agent_sessions!, events: [{ ...wire.events[0],
      id: "new-source-event", approval_id: null, operation: "source_image", kind: "operation_inspected", summary: "Source B region inspected",
      timestamp: "2026-10-27T00:02:00Z", targets: [{ kind: "source", id: ID_B, sha256: SHA_B,
        selection: { ...selection, x: 10, y: 20, width: 100, height: 120, z: 4, c: 1 } }] }] } }; },
    delaySource() { delayedSource = ID_B; },
    publishPreview() { current = { ...current, jobs: [{ id: "9".repeat(32), operation: "workflow_preview",
      state: "succeeded", request: { source_id: ID_A, source_sha256: SHA_A }, request_hash: "8".repeat(64), request_key: "preview-request",
      created_at: "2026-10-27T00:01:00Z", updated_at: "2026-10-27T00:02:00Z", progress: 1, cancel_requested: false, result_ids: [], error: null }],
      agent_sessions: { ...current.agent_sessions!, events: [{ ...wire.events[0], id: "preview-completed", approval_id: null,
        operation: "workflow_preview", kind: "task_completed", summary: "Workflow prefix preview available", targets: [{ kind: "job", id: "9".repeat(32) }] }] } }; },
    completePreview() {
      const preview: SharedTaskPreview = { schema: "loci.task-preview/v1", job_id: "9".repeat(32), operation: "workflow_preview",
        source_id: ID_A, source_sha256: SHA_A, request_sha256: "8".repeat(64), output_sha256: "7".repeat(64), adopted: false,
        created_at: "2026-10-27T00:02:00Z", output: { image: png, adopted: false, provenance: { selection },
          workflow: { id: "workflow-exact", revision: 3, definition_sha256: "6".repeat(64) }, target_node_id: "process-exact" } };
      previewOutput({ preview });
    },
    completeSource() { sourceView({ source_id: ID_B, source_sha256: SHA_B, revision: 0, state: null }); },
    completeResult() {
      resultPage({ result, measurements: [{ label: 1, measure: 2, measure_kind: "area", measure_unit: "um^2" }] });
      resultView({ result_id: result.id, revision_hash: result.revision_hash, image: png, shape: [512, 512], geometry, axis: "z", index: 0 });
    },
  };
}

function userClick(element: Element) {
  fireEvent.pointerDown(element, { pointerId: 1 }); fireEvent.pointerUp(element, { pointerId: 1 }); fireEvent.click(element);
}
async function startFollowing(state: ReturnType<typeof harness>) {
  render(<ResearchWorkbench api={state.api} onBack={vi.fn()} />);
  await screen.findByRole("checkbox", { name: "Channel 1 visible" });
  await waitFor(() => expect(screen.getByLabelText("Z plane")).toHaveValue("2"));
  userClick(screen.getByRole("button", { name: "Agent session status" }));
  userClick(screen.getByRole("checkbox", { name: "Follow agent" }));
  userClick(screen.getByRole("button", { name: "Close agent session drawer" }));
  now += 2000;
}
async function poll() {
  await act(async () => { polls.at(-1)!(); await Promise.resolve(); });
}
function viewer() { return screen.getByLabelText(/^Image viewer:/); }

describe("Agent navigation integration", () => {
  it("fits followed regions to the live viewport and shows the inspected scalar channel with local display settings", async () => {
    const state = harness(); await startFollowing(state);
    state.publishSource(); await poll();
    await screen.findByLabelText("Image viewer: Source B");
    await waitFor(() => expect(JSON.parse(viewer().getAttribute("data-camera")!)).toEqual({ x: 60, y: 80, scale: 3.84 }));
    expect(screen.getByRole("checkbox", { name: "Channel 1 visible" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Channel 2 visible" })).toBeChecked();
    expect(screen.getByLabelText("Z plane")).toHaveValue("4");
    await waitFor(() => expect(state.execute).toHaveBeenCalledWith("viewer_tile", expect.objectContaining({
      source_id: ID_B, channels: [
        { channel: 0, low: 0, high: 65535, gamma: 1, color: "#ff0000", opacity: 1, visible: false },
        { channel: 1, low: 10, high: 4095, gamma: 1.2, color: "#00ff00", opacity: 0.8, visible: true },
      ],
    }), expect.anything()));
  });

  it("discards a late result view after a human changes the plane and camera", async () => {
    const state = harness(); await startFollowing(state);
    state.publishResult(); await poll();
    await waitFor(() => expect(state.execute).toHaveBeenCalledWith("result", { result_id: RESULT_ID, offset: 0, limit: 200 }));
    fireEvent.input(screen.getByLabelText("Z plane"), { target: { value: "1" } });
    const beforeZoom = viewer().getAttribute("data-camera");
    userClick(screen.getByRole("button", { name: "Zoom in" }));
    const manualCamera = viewer().getAttribute("data-camera");
    expect(manualCamera).not.toBe(beforeZoom);
    await act(async () => { state.completeResult(); });
    expect(screen.getByLabelText("Z plane")).toHaveValue("1");
    expect(viewer()).toHaveAttribute("data-camera", manualCamera);
    expect(viewer()).not.toHaveAttribute("data-result-overlay");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the later human source selected when an agent result read completes", async () => {
    const state = harness(); await startFollowing(state);
    state.publishResult(); await poll();
    await waitFor(() => expect(state.execute).toHaveBeenCalledWith("result", expect.anything()));
    userClick(screen.getByRole("button", { name: /^Source B/ }));
    await waitFor(() => expect(screen.getByLabelText("Active image")).toHaveTextContent("Source B"));
    await screen.findByLabelText("Image viewer: Source B");
    await act(async () => { state.completeResult(); });
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Source B");
    expect(viewer()).toHaveAttribute("data-viewer-source", ID_B);
    expect(viewer()).not.toHaveAttribute("data-result-overlay");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("discards a pending followed source region after later human source, plane and camera intent", async () => {
    const state = harness(); await startFollowing(state); state.delaySource();
    state.publishSource(); await poll();
    await waitFor(() => expect(state.execute).toHaveBeenCalledWith("source_view", { source_id: ID_B }));
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Source B");
    userClick(screen.getByRole("button", { name: /^Source A/ }));
    await screen.findByLabelText("Image viewer: Source A");
    fireEvent.input(screen.getByLabelText("Z plane"), { target: { value: "1" } });
    userClick(screen.getByRole("button", { name: "Zoom in" }));
    const manualCamera = viewer().getAttribute("data-camera");
    await act(async () => { state.completeSource(); });
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Source A");
    expect(screen.getByLabelText("Z plane")).toHaveValue("1");
    expect(viewer()).toHaveAttribute("data-camera", manualCamera);
    expect(viewer()).toHaveAttribute("data-viewer-source", ID_A);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the exact cached preview without adopting or rerunning it and clears it on source change", async () => {
    const state = harness(); await startFollowing(state);
    state.publishPreview(); await poll();
    userClick(screen.getByRole("button", { name: "Agent session status" }));
    userClick(screen.getByRole("button", { name: `Inspect preview ${"9".repeat(32)}` }));
    await waitFor(() => expect(state.execute).toHaveBeenCalledWith("task_preview_get", { job_id: "9".repeat(32) }));
    await act(async () => { state.completePreview(); });
    expect(screen.getByRole("region", { name: "Agent preview comparison" })).toBeVisible();
    userClick(screen.getByText("Exact preview identity and settings"));
    expect(screen.getByText("workflow-exact")).toBeVisible();
    expect(screen.getByText("process-exact")).toBeVisible();
    expect(state.execute).not.toHaveBeenCalledWith("workflow_preview", expect.anything());
    expect(state.execute).not.toHaveBeenCalledWith("select_result", expect.anything());
    userClick(screen.getByRole("button", { name: /^Source B/ }));
    await screen.findByLabelText("Image viewer: Source B");
    expect(screen.queryByRole("region", { name: "Agent preview comparison" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Source B");
  });

  it("discards a late preview cache response after a human selects another source", async () => {
    const state = harness(); await startFollowing(state);
    state.publishPreview(); await poll();
    userClick(screen.getByRole("button", { name: "Agent session status" }));
    userClick(screen.getByRole("button", { name: `Inspect preview ${"9".repeat(32)}` }));
    await waitFor(() => expect(state.execute).toHaveBeenCalledWith("task_preview_get", { job_id: "9".repeat(32) }));
    userClick(screen.getByRole("button", { name: /^Source B/ }));
    await screen.findByLabelText("Image viewer: Source B");
    await act(async () => { state.completePreview(); });
    expect(screen.queryByRole("region", { name: "Agent preview comparison" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Source B");
    expect(viewer()).toHaveAttribute("data-viewer-source", ID_B);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
