// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench from "./ResearchWorkbench";
import type {
  ResearchBatchReceipt,
  ResearchBatchTask,
  ResearchDesktopApi,
  ResearchJob,
  ResearchSnapshot,
} from "../shared/research-contracts";

let canvasContext: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  canvasContext = Object.fromEntries(
    [
      "setTransform", "fillRect", "drawImage", "beginPath", "moveTo",
      "lineTo", "closePath", "arc", "stroke", "fillText", "setLineDash", "save", "restore", "ellipse", "fill",
    ].map((name) => [name, vi.fn()]),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList?.contains("image-viewport")) {
        return {
          left: 0,
          top: 0,
          right: 640,
          bottom: 480,
          width: 640,
          height: 480,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
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
const snapshot: ResearchSnapshot = {
  project: { title: "Test study" },
  sources: [
    {
      id: "a".repeat(32),
      name: "Specimen",
      sha256: "b".repeat(64),
      metadata: {
        format: "OME-TIFF",
        dimensions: { x: 64, y: 48, z: 3, t: 1, c: 2 },
        levels: [{ index: 0, dimensions: { x: 64, y: 48, z: 3, t: 1, c: 2 } }],
        channel_names: ["DAPI", "Marker"],
      },
    },
  ],
  results: [
    {
      id: "c".repeat(32),
      source_id: "a".repeat(32),
      kind: "segmentation",
      created_at: "now",
      revision_hash: "d".repeat(64),
      object_count: 1,
    },
  ],
  samples: [],
  recipes: [],
  displays: [],
  selections: [],
  jobs: [],
  operations: {
    view: { mutates: false, summary: "view" },
    volume_view: { mutates: false, summary: "volume" },
    preview_recipe: { mutates: false, summary: "preview" },
    run_recipe: { mutates: true, summary: "run" },
    result: { mutates: false, summary: "result" },
    sample: { mutates: true, summary: "sample" },
  },
};
const geometry = {
  axes: "ZYX",
  affine: [
    [1, 0, 0, 0],
    [0, 2, 0, 0],
    [0, 0, 3, 0],
    [0, 0, 0, 1],
  ],
  unit: "um",
  frame: "image",
};
function resultView(
  result = snapshot.results[0],
  axis: "x" | "y" | "z" = "z",
  index = 1,
  shape: number[] = [3, 48, 64],
) {
  return {
    image: "data:image/png;base64,result",
    shape,
    result_id: result.id,
    revision_hash: result.revision_hash,
    axis,
    index,
    geometry,
  };
}
function viewerContractResponse(
  operation: string,
  request: Record<string, unknown>,
  active: ResearchSnapshot,
) {
  const source = active.sources.find((item) => item.id === request.source_id);
  if (!source) return undefined;
  if (operation === "viewer_defaults") {
    const count = source.metadata.sample_semantics === "RGB"
      ? 1
      : (source.metadata.dimensions?.c ?? 1);
    return {
      source_id: source.id,
      source_sha256: source.sha256,
      basis: "Source acquisition range",
      channels: Array.from({ length: count }, (_, channel) => ({
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
  if (operation === "source_view") {
    return {
      source_id: source.id,
      source_sha256: source.sha256,
      revision: 0,
      state: null,
    };
  }
  if (operation === "save_source_view") {
    return {
      source_id: source.id,
      source_sha256: source.sha256,
      revision: Number(request.expected_revision) + 1,
      state: request.state,
    };
  }
  if (operation === "source_annotations") {
    return {
      source_id: source.id,
      source_sha256: source.sha256,
      revision: 0,
      annotations: [],
      can_undo: false,
      can_redo: false,
    };
  }
  if (operation === "viewer_tile") {
    const dimensions = source.metadata.dimensions!;
    const selection = request.selection as
      | { width?: number; height?: number }
      | undefined;
    const width = request.overview ? Math.min(1024, dimensions.x) : Number(selection?.width);
    const height = request.overview ? Math.min(1024, dimensions.y) : Number(selection?.height);
    return {
      image: `data:image/png;base64,viewer#viewer-${width}x${height}`,
      source_sha256: source.sha256,
      ...(request.overview ? {
        source_extent: [dimensions.x, dimensions.y],
        width,
        height,
      } : { selection: request.selection }),
    };
  }
  return undefined;
}
function api(overrides: Partial<ResearchDesktopApi> = {}): ResearchDesktopApi {
  let activeSnapshot = snapshot;
  const batchJobs: ResearchJob[] = [];
  const suppliedSnapshot = overrides.getSnapshot;
  const suppliedExecute = overrides.execute;
  const getSnapshot = vi.fn(async () => {
    const value = suppliedSnapshot ? await suppliedSnapshot() : snapshot;
    if (!value) return value;
    const batchIds = new Set(batchJobs.map((job) => job.id));
    activeSnapshot = {
      ...value,
      jobs: [...value.jobs.filter((job) => !batchIds.has(job.id)), ...batchJobs],
    };
    return activeSnapshot;
  });
  const execute = vi.fn(
    async (operation: string, request: Record<string, unknown>) => {
      const viewerResponse = viewerContractResponse(
        operation,
        request,
        activeSnapshot,
      );
      if (viewerResponse !== undefined) {
        if (operation === "viewer_tile" && !request.overview && suppliedExecute) {
          const legacy = (await suppliedExecute("view", {
            source_id: request.source_id,
            selection: request.selection,
            channels: request.channels,
            ...(request.projection ? { projection: request.projection } : {}),
          })) as { image?: string };
          const response = viewerResponse as { image: string };
          if (legacy?.image) {
            response.image = `${legacy.image}${response.image.slice(response.image.indexOf("#viewer-"))}`;
          }
        }
        return viewerResponse;
      }
      if (suppliedExecute) return suppliedExecute(operation, request);
      if (operation === "view") {
        return { image: "data:image/png;base64,one" };
      }
      if (operation === "result") {
        return { measurements: [{ label: 1, area: 22 }] };
      }
      if (operation === "result_view") return resultView();
      return {};
    },
  );
  const submitBatch = vi.fn(async (tasks: ResearchBatchTask[]): Promise<ResearchBatchReceipt> => {
    const batchId = "8".repeat(32);
    for (const [index, task] of tasks.entries()) {
      batchJobs.push({
        id: (index + 1).toString(16).padStart(32, "0"),
        operation: task.operation,
        request: task.operation === "run_recipe"
          ? task.request
          : { source_id: task.source.id, task_request: task.request },
        request_key: `loci-batch:${batchId}:initial:${String(index).padStart(5, "0")}`,
        request_hash: (index + 17).toString(16).padStart(64, "0"),
        state: "queued",
        created_at: `2026-09-08T00:00:${String(index).padStart(2, "0")}Z`,
        updated_at: `2026-09-08T00:00:${String(index).padStart(2, "0")}Z`,
        progress: 0,
        cancel_requested: false,
        result_ids: [],
        error: null,
      });
    }
    return { batch_id: batchId, jobs: structuredClone(batchJobs) };
  });
  const runBatchJob = vi.fn(async (_batchId: string, jobId: string) => {
    const job = batchJobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error("Unknown batch job");
    job.state = "running";
    const request = job.operation === "run_recipe"
      ? job.request
      : job.request.task_request as Record<string, unknown>;
    try {
      const output = await execute(job.operation, request);
      const resultId = (output as { result?: { id?: string } })?.result?.id;
      job.state = "succeeded";
      job.progress = 1;
      job.result_ids = resultId ? [resultId] : [];
      return output;
    } catch (error) {
      job.state = "failed";
      job.error = error instanceof Error ? error.message : "Batch failed.";
      throw error;
    }
  });
  return {
    createStudy: vi.fn().mockResolvedValue(snapshot),
    openStudy: vi.fn().mockResolvedValue(snapshot),
    addSources: vi.fn().mockResolvedValue(snapshot),
    reviewResult: vi.fn().mockResolvedValue({}),
    exportResult: vi.fn().mockResolvedValue({}),
    exportBatch: vi.fn().mockResolvedValue({
      exportedCount: 1, selectedCount: 1, mode: "bundles+summary",
      manifestName: "loci_batch_manifest.json", summaryName: "loci_count_summary.csv",
    }),
    cancelJob: vi.fn().mockResolvedValue({}),
    submitBatch,
    runBatchJob,
    resumeBatch: vi.fn(async (batchId) => ({ batch_id: batchId, jobs: structuredClone(batchJobs) })),
    retryBatch: vi.fn(async (batchId) => ({ batch_id: batchId, jobs: structuredClone(batchJobs) })),
    ...overrides,
    getSnapshot,
    execute,
  };
}

async function selectHistoryResult(name = /segmentation/) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return button;
}
async function openTool(
  group: "View" | "Annotate" | "Analyze" | "Results",
  tool: string,
) {
  fireEvent.click(await screen.findByRole("button", { name: group }));
  const labels: Record<string, string> = { Display: "Image & channels", Annotate: "Draw & measure", Epidermis: "Epidermal thickness", Correction: "Edit labels & ROIs",
    Analyze: "Segment & measure", Process: "Preprocess", Model: "Use a model", Quantify: "Fluorescence & field assay",
    Temporal: "Track over time", Registration: "Register & resample", Info: "Review & export", Study: "Study & batch" };
  fireEvent.click(await screen.findByRole("combobox", { name: `${group} tool` }));
  fireEvent.click(await screen.findByRole("option", { name: labels[tool] }));
}
async function openAdvancedTool(tool: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Search all tools" }));
  fireEvent.change(await screen.findByLabelText("Search all tools"), {
    target: { value: tool },
  });
  fireEvent.click(await screen.findByRole("button", { name: tool }));
}
describe("ResearchWorkbench", () => {
  it("opens the dedicated epidermal measurement workflow and finds IL4R by task name", async () => {
    const desktop = api();
    const execute = vi.mocked(desktop.execute);
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    await screen.findByLabelText("Image viewer: Specimen");
    fireEvent.change(screen.getByLabelText("Display scope"), { target: { value: "max" } });
    await waitFor(() => expect(execute).toHaveBeenCalledWith("viewer_tile",
      expect.objectContaining({ projection: "max" }),
      expect.objectContaining({ viewer_lane: expect.stringMatching(/^image-viewport-/) })));
    const before = execute.mock.calls.length;
    await openTool("Annotate", "Epidermis");
    await waitFor(() => {
      const requests = execute.mock.calls.slice(before).filter(([operation]) => operation === "viewer_tile");
      expect(requests.length).toBeGreaterThan(0);
      requests.forEach(([, request]) => {
        expect(request).not.toHaveProperty("projection");
        expect(request.selection ?? request).not.toHaveProperty("z_stop");
      });
    });
    expect(await screen.findByRole("heading", { name: "Epidermal thickness" })).toBeVisible();
    expect(screen.getByLabelText("Transect class")).toBeVisible();
    expect(screen.getByRole("button", { name: "Epidermal Transect" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Rectangle" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search all tools" }));
    fireEvent.change(screen.getByLabelText("Search all tools"), { target: { value: "IL4R" } });
    expect(screen.getByRole("button", { name: "Fluorescence & field assay" })).toBeVisible();
  });

  it("keeps file drag state stable across children and clears it on every exit path", async () => {
    const openDropped = vi.fn().mockResolvedValue(null);
    const openImages = vi.fn().mockResolvedValue(null);
    render(
      <ResearchWorkbench
        api={api({
          getSnapshot: vi.fn().mockResolvedValue(null),
          openDropped,
          openImages,
        })}
        onBack={vi.fn()}
      />,
    );

    const main = await screen.findByRole("main", { name: "Loci workspace" });
    const primary = screen.getByRole("button", { name: "Open images" });
    const file = new File(["image"], "field.tif", { type: "image/tiff" });
    const transfer = { types: ["Files"], files: [file], dropEffect: "none" };
    fireEvent.dragEnter(main, { dataTransfer: transfer });
    expect(main).toHaveClass("is-drag-active");
    expect(screen.getByRole("heading", { name: "Drop to open" })).toBeVisible();

    fireEvent.dragEnter(primary, { dataTransfer: transfer });
    fireEvent.dragLeave(primary, { dataTransfer: transfer });
    expect(main).toHaveClass("is-drag-active");
    fireEvent.dragLeave(main, { dataTransfer: transfer });
    expect(main).not.toHaveClass("is-drag-active");

    fireEvent.dragEnter(main, { dataTransfer: transfer });
    fireEvent.click(primary);
    expect(main).not.toHaveClass("is-drag-active");
    await waitFor(() => expect(openImages).toHaveBeenCalledWith("files"));

    fireEvent.dragEnter(main, { dataTransfer: transfer });
    fireEvent(window, new Event("blur"));
    expect(main).not.toHaveClass("is-drag-active");

    fireEvent.dragEnter(main, { dataTransfer: transfer });
    fireEvent.drop(main, { dataTransfer: transfer });
    expect(main).not.toHaveClass("is-drag-active");
    await waitFor(() => expect(openDropped).toHaveBeenCalledWith([file]));
  });

  it("exposes settings, selection state, inspector state, and visible scalar labels", async () => {
    const onOpenSettings = vi.fn();
    render(
      <ResearchWorkbench
        api={api()}
        onBack={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );

    await screen.findByRole("main", { name: "Research workspace" });
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();

    const sourceButton = screen.getByRole("button", { name: /Specimen/ });
    expect(sourceButton).toHaveAttribute("aria-current", "true");

    const displayTab = screen.getByRole("button", { name: "View" });
    const processTab = screen.getByRole("button", { name: "Analyze" });
    expect(displayTab).toHaveAttribute("aria-pressed", "true");
    expect(processTab).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(processTab);
    expect(displayTab).toHaveAttribute("aria-pressed", "false");
    expect(processTab).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(displayTab);
    fireEvent.click(await screen.findByText("DAPI"));

    for (const [name, label] of [
      ["Channel 1 low", "Low"],
      ["Channel 1 high", "High"],
      ["Channel 1 gamma", "Gamma"],
      ["Channel 1 color", "Colour"],
    ]) {
      expect((await screen.findByLabelText(name)).closest("label")).toHaveTextContent(
        label,
      );
    }

    const historyButton = screen.getByRole("button", {
      name: /segmentation/,
    });
    expect(historyButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(historyButton);
    await waitFor(() =>
      expect(historyButton).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("locks the visible workspace while Save as study settles and always releases it", async () => {
    let settle!: {
      resolve: (value: ResearchSnapshot | null) => void;
      reject: (reason: Error) => void;
    };
    const saveAs = vi.fn(() => new Promise<ResearchSnapshot | null>((resolve, reject) => {
      settle = { resolve, reject };
    }));
    render(<ResearchWorkbench api={api({ saveAs })} onBack={vi.fn()} />);
    const main = await screen.findByRole("main", { name: "Research workspace" });
    const viewer = await screen.findByLabelText("Image viewer: Specimen");

    const beginSave = async () => {
      const priorCalls = saveAs.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Save study" }));
      await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(priorCalls + 1));
      expect(main).toHaveAttribute("inert");
      expect(main).toHaveAttribute("aria-busy", "true");
      expect(screen.getByText("Updating workspace…")).toBeVisible();
      expect(viewer).toBeInTheDocument();
      expect(screen.getByLabelText("Active image")).toHaveTextContent("Specimen");
    };

    await beginSave();
    settle.resolve(null);
    await waitFor(() => expect(main).not.toHaveAttribute("inert"));
    expect(main).not.toHaveAttribute("aria-busy");
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Specimen");

    await beginSave();
    settle.reject(new Error("Save destination is unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save destination is unavailable");
    await waitFor(() => expect(main).not.toHaveAttribute("inert"));
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Specimen");
    expect(screen.getByRole("button", { name: /Specimen/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await beginSave();
    settle.resolve({ ...snapshot, project: { title: "Saved study" } });
    await waitFor(() => expect(main).not.toHaveAttribute("inert"));
    expect(main).not.toHaveAttribute("aria-busy");
    expect(screen.queryByText("Updating workspace…")).not.toBeInTheDocument();
  });

  it("pauses pending source refinement through a cancelled Save as without losing the last frame", async () => {
    let finishSave!: (value: null) => void;
    let rejectTile!: (error: Error) => void;
    let delayed = false;
    const saveAs = vi.fn(() => new Promise<null>((resolve) => { finishSave = resolve; }));
    const desktop = api({ saveAs });
    const original = desktop.execute;
    desktop.execute = vi.fn(async (operation, request) => {
      if (operation === "viewer_tile" && !request.overview && !delayed) {
        delayed = true;
        return new Promise((_, reject) => { rejectTile = reject; });
      }
      return original(operation, request);
    });
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    const viewer = await screen.findByLabelText("Image viewer: Specimen");
    await waitFor(() => expect(delayed).toBe(true));
    const previousCacheBytes = Number(viewer.getAttribute("data-cache-bytes"));
    expect(previousCacheBytes).toBeGreaterThan(0);
    const previousCamera = viewer.getAttribute("data-camera");
    fireEvent.click(screen.getByText("File"));
    fireEvent.click(screen.getByRole("button", { name: "Save as study…" }));
    await waitFor(() => expect(saveAs).toHaveBeenCalledOnce());
    rejectTile(new Error("Wait for the study to finish opening."));
    await waitFor(() => expect(viewer.querySelector(".image-view-loading")).toBeNull());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(viewer).toHaveAttribute("data-cache-bytes", String(previousCacheBytes));
    expect(viewer).toHaveAttribute("data-camera", previousCamera);
    finishSave(null);
    await waitFor(() => expect(Number(viewer.getAttribute("data-cache-bytes"))).toBeGreaterThan(previousCacheBytes));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(viewer).toHaveAttribute("data-camera", previousCamera);
  });

  it("pauses source refinement across workspace result changes and preserves exact undo", async () => {
    let finishClear!: () => void;
    let rejectTile!: (error: Error) => void;
    let delayed = false;
    const cleared: ResearchSnapshot = {
      ...snapshot,
      results: [],
      workspace: {
        revision: 1,
        closed_sources: [],
        hidden_results: snapshot.results,
      },
    };
    const restored: ResearchSnapshot = {
      ...snapshot,
      workspace: { revision: 2, closed_sources: [], hidden_results: [] },
    };
    const updateWorkspace = vi.fn((request) => {
      if (request.expected_revision === 0) {
        return new Promise<ResearchSnapshot>((resolve) => {
          finishClear = () => resolve(cleared);
        });
      }
      return Promise.resolve(restored);
    });
    const desktop = api({ updateWorkspace });
    const original = desktop.execute;
    desktop.execute = vi.fn(async (operation, request) => {
      if (operation === "viewer_tile" && !request.overview && !delayed) {
        delayed = true;
        return new Promise((_, reject) => { rejectTile = reject; });
      }
      return original(operation, request);
    });
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    const main = await screen.findByRole("main", { name: "Research workspace" });
    const viewer = await screen.findByLabelText("Image viewer: Specimen");
    await waitFor(() => expect(delayed).toBe(true));
    const previousCacheBytes = viewer.getAttribute("data-cache-bytes");
    const previousCamera = viewer.getAttribute("data-camera");

    fireEvent.click(screen.getByText("Manage images & results"));
    fireEvent.click(screen.getByRole("button", { name: "Clear image results" }));
    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledOnce());
    expect(main).toHaveAttribute("inert");
    rejectTile(new Error("Wait for the study to finish opening."));
    await Promise.resolve();
    finishClear();

    expect(await screen.findByText("Results cleared from the working list.")).toBeVisible();
    await waitFor(() => expect(main).not.toHaveAttribute("inert"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Image viewer: Specimen")).toBe(viewer);
    expect(Number(viewer.getAttribute("data-cache-bytes"))).toBeGreaterThanOrEqual(
      Number(previousCacheBytes),
    );
    expect(viewer).toHaveAttribute("data-camera", previousCamera);
    expect(screen.queryByRole("button", { name: /segmentation/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledTimes(2));
    expect(updateWorkspace.mock.calls).toEqual([
      [{ expected_revision: 0, sources: [], results: [{
        id: snapshot.results[0].id,
        revision_hash: snapshot.results[0].revision_hash,
        visible: false,
      }] }],
      [{ expected_revision: 1, sources: [], results: [{
        id: snapshot.results[0].id,
        revision_hash: snapshot.results[0].revision_hash,
        visible: true,
      }] }],
    ]);
    expect(await screen.findByRole("button", { name: /segmentation/ })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Image viewer: Specimen")).toBe(viewer);
    expect(viewer).toHaveAttribute("data-camera", previousCamera);
  });

  it("retains workspace undo while restarting interrupted display preparation", async () => {
    let finishClear!: () => void;
    let rejectDefaults!: (error: Error) => void;
    let delayed = false;
    const cleared: ResearchSnapshot = {
      ...snapshot,
      results: [],
      workspace: {
        revision: 1,
        closed_sources: [],
        hidden_results: snapshot.results,
      },
    };
    const restored: ResearchSnapshot = {
      ...snapshot,
      workspace: { revision: 2, closed_sources: [], hidden_results: [] },
    };
    const updateWorkspace = vi.fn((request) => {
      if (request.expected_revision === 0) {
        return new Promise<ResearchSnapshot>((resolve) => {
          finishClear = () => resolve(cleared);
        });
      }
      return Promise.resolve(restored);
    });
    const desktop = api({ updateWorkspace });
    const original = desktop.execute;
    desktop.execute = vi.fn(async (operation, request) => {
      if (operation === "viewer_defaults" && !delayed) {
        delayed = true;
        return new Promise((_, reject) => { rejectDefaults = reject; });
      }
      return original(operation, request);
    });
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    const main = await screen.findByRole("main", { name: "Research workspace" });
    await waitFor(() => expect(delayed).toBe(true));

    fireEvent.click(screen.getByText("Manage images & results"));
    fireEvent.click(screen.getByRole("button", { name: "Clear image results" }));
    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledOnce());
    expect(main).toHaveAttribute("inert");
    rejectDefaults(new Error("Wait for the study to finish opening."));
    await Promise.resolve();
    finishClear();

    expect(await screen.findByText("Results cleared from the working list.")).toBeVisible();
    await waitFor(() => expect(main).not.toHaveAttribute("inert"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await screen.findByLabelText("Image viewer: Specimen");
    const undo = screen.getByRole("button", { name: "Undo" });
    await waitFor(() => expect(undo).toBeEnabled());
    fireEvent.click(undo);

    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledTimes(2));
    expect(updateWorkspace).toHaveBeenLastCalledWith({
      expected_revision: 1,
      sources: [],
      results: [{
        id: snapshot.results[0].id,
        revision_hash: snapshot.results[0].revision_hash,
        visible: true,
      }],
    });
    expect(await screen.findByRole("button", { name: /segmentation/ })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("restarts pending display preparation after a cancelled image picker and ignores its abandoned failure", async () => {
    let finishPicker!: (value: null) => void;
    let rejectDefaults!: (error: Error) => void;
    let delayed = false;
    const openImages = vi.fn(() => new Promise<null>((resolve) => { finishPicker = resolve; }));
    const desktop = api({ openImages });
    const original = desktop.execute;
    desktop.execute = vi.fn(async (operation, request) => {
      if (operation === "viewer_defaults" && !delayed) {
        delayed = true;
        return new Promise((_, reject) => { rejectDefaults = reject; });
      }
      return original(operation, request);
    });
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    const main = await screen.findByRole("main", { name: "Research workspace" });
    await waitFor(() => expect(delayed).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Open images" }));
    await waitFor(() => expect(openImages).toHaveBeenCalledOnce());
    expect(main).toHaveAttribute("inert");
    rejectDefaults(new Error("Wait for the study to finish opening."));
    await Promise.resolve();
    finishPicker(null);
    const viewer = await screen.findByLabelText("Image viewer: Specimen");
    await waitFor(() => expect(Number(viewer.getAttribute("data-cache-bytes"))).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(main).not.toHaveAttribute("inert");
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Specimen");
  });

  it("resets a volume projection before requesting a newly selected RGB source", async () => {
    const rgbSource = {
      id: "e".repeat(32),
      name: "RGB slide",
      sha256: "f".repeat(64),
      metadata: {
        format: "PNG",
        dimensions: { x: 80, y: 60, z: 1, t: 1, c: 3 },
        levels: [
          {
            index: 0,
            dimensions: { x: 80, y: 60, z: 1, t: 1, c: 3 },
          },
        ],
        channel_names: ["R", "G", "B"],
        sample_semantics: "RGB" as const,
      },
    };
    const switchedSnapshot: ResearchSnapshot = {
      ...snapshot,
      sources: [...snapshot.sources, rgbSource],
    };
    const execute = vi.fn((operation: string, _request: Record<string, unknown>) =>
      operation === "view"
        ? Promise.resolve({ image: "data:image/png;base64,view" })
        : Promise.resolve({}),
    );
    render(
      <ResearchWorkbench
        api={api({
          getSnapshot: vi.fn().mockResolvedValue(switchedSnapshot),
          execute,
        })}
        onBack={vi.fn()}
      />,
    );

    // The source's saved settings must finish hydrating before the user changes
    // its projection; this test then checks the subsequent source transition.
    await waitFor(() => expect(execute).toHaveBeenCalledWith("view",
      expect.objectContaining({ source_id: snapshot.sources[0].id })));
    fireEvent.change(await screen.findByLabelText("Display scope"), {
      target: { value: "max" },
    });
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "view",
        expect.objectContaining({
          source_id: snapshot.sources[0].id,
          projection: "max",
        }),
      ),
    );

    const originalSourceButton = screen.getByRole("button", {
      name: /Specimen/,
    });
    const rgbSourceButton = screen.getByRole("button", { name: /RGB slide/ });
    fireEvent.click(rgbSourceButton);
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "view",
        expect.objectContaining({ source_id: rgbSource.id }),
      ),
    );
    const rgbRequests = execute.mock.calls
      .filter(
        ([operation, request]) =>
          operation === "view" && request.source_id === rgbSource.id,
      )
      .map(([, request]) => request);
    expect(rgbRequests).not.toHaveLength(0);
    expect(originalSourceButton).not.toHaveAttribute("aria-current");
    expect(rgbSourceButton).toHaveAttribute("aria-current", "true");
    for (const request of rgbRequests) {
      expect(request).not.toHaveProperty("projection");
      expect(request.selection).not.toHaveProperty("z_stop");
    }
    expect(screen.queryByText(/Choose a Z stop/)).not.toBeInTheDocument();
  });

  it("never carries a saved camera across source hydration and restores it for its own source", async () => {
    const compactSource = {
      id: "e".repeat(32),
      name: "Compact RGB source",
      sha256: "f".repeat(64),
      metadata: {
        format: "PNG",
        dimensions: { x: 40, y: 30, z: 1, t: 1, c: 3 },
        levels: [{ index: 0, dimensions: { x: 40, y: 30, z: 1, t: 1, c: 3 } }],
        channel_names: ["R", "G", "B"],
        sample_semantics: "RGB" as const,
      },
    };
    const largeSource = {
      ...snapshot.sources[0],
      metadata: {
        ...snapshot.sources[0].metadata,
        dimensions: { x: 1_000, y: 800, z: 3, t: 1, c: 2 },
        levels: [{ index: 0, dimensions: { x: 1_000, y: 800, z: 3, t: 1, c: 2 } }],
      },
    };
    const switchedSnapshot: ResearchSnapshot = {
      ...snapshot,
      sources: [largeSource, compactSource],
    };
    const largeCamera = { x: 800, y: 600, scale: 1 };
    const views = new Map([
      [largeSource.id, {
        source_id: largeSource.id,
        source_sha256: largeSource.sha256,
        revision: 0,
        state: {
          interpretation: "auto" as const,
          channels: [{ channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true }],
          projection: "plane" as const,
          selection: { level: 0, t: 0, c: 0, z: 1, x: 0, y: 0, width: 1_000, height: 800 },
          camera: largeCamera,
          rgb_mapping: null,
        },
      }],
      [compactSource.id, {
        source_id: compactSource.id,
        source_sha256: compactSource.sha256,
        revision: 0,
        state: null,
      }],
    ]);
    const desktop = api({ getSnapshot: vi.fn().mockResolvedValue(switchedSnapshot) });
    const originalExecute = desktop.execute;
    const calls: Array<{ operation: string; sourceId: string; camera?: { x: number; y: number; scale: number } | null }> = [];
    desktop.execute = vi.fn(async (operation, request) => {
      const sourceId = String(request.source_id ?? "");
      if (operation === "source_view") {
        calls.push({ operation, sourceId });
        return structuredClone(views.get(sourceId));
      }
      if (operation === "save_source_view") {
        const state = request.state as { camera: { x: number; y: number; scale: number } | null };
        calls.push({ operation, sourceId, camera: structuredClone(state.camera) });
        if (sourceId === compactSource.id && state.camera &&
          (state.camera.x < -40 || state.camera.x > 80))
          throw new Error("camera x must be between -40 and 80");
        const prior = views.get(sourceId)!;
        const saved = {
          ...prior,
          revision: Number(request.expected_revision) + 1,
          state: structuredClone(request.state),
        };
        views.set(sourceId, saved as typeof prior);
        return saved;
      }
      return originalExecute(operation, request);
    });
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    const firstViewer = await screen.findByLabelText("Image viewer: Specimen");
    await waitFor(() => expect(JSON.parse(firstViewer.getAttribute("data-camera")!)).toEqual(largeCamera));
    fireEvent.click(screen.getByRole("button", { name: /Compact RGB source/ }));
    const compactViewer = await screen.findByLabelText("Image viewer: Compact RGB source");
    await waitFor(() => {
      const camera = JSON.parse(compactViewer.getAttribute("data-camera")!);
      expect(camera.y).toBe(15);
      expect(camera.x).not.toBe(largeCamera.x);
    });
    await waitFor(() => expect(calls.some((call) => call.operation === "save_source_view" &&
      call.sourceId === compactSource.id)).toBe(true));
    const compactSaves = calls.filter((call) => call.operation === "save_source_view" &&
      call.sourceId === compactSource.id);
    expect(compactSaves.every((call) => call.camera?.x !== largeCamera.x)).toBe(true);
    expect(calls.findIndex((call) => call.operation === "save_source_view" && call.sourceId === largeSource.id))
      .toBeLessThan(calls.findIndex((call) => call.operation === "source_view" && call.sourceId === compactSource.id));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Specimen/ }));
    const restored = await screen.findByLabelText("Image viewer: Specimen");
    await waitFor(() => expect(JSON.parse(restored.getAttribute("data-camera")!)).toEqual(largeCamera));
    expect(calls.findIndex((call) => call.operation === "save_source_view" && call.sourceId === compactSource.id))
      .toBeLessThan(calls.findLastIndex((call) => call.operation === "source_view" && call.sourceId === largeSource.id));
  });

  it("adopts batch display revisions without autosaving stale source-view state", async () => {
    let revision = 0;
    let currentColor = "#ffffff";
    const savedExpectedRevisions: number[] = [];
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      const source = snapshot.sources[0];
      if (operation === "source_view") return {
        source_id: source.id,
        source_sha256: source.sha256,
        revision,
        state: null,
      };
      if (operation === "save_source_view") {
        expect(request.expected_revision).toBe(revision);
        savedExpectedRevisions.push(Number(request.expected_revision));
        revision += 1;
        return {
          source_id: source.id,
          source_sha256: source.sha256,
          revision,
          state: request.state,
        };
      }
      if (operation === "batch_channel_colors") {
        const expected = request.expected_revisions as Record<string, number> | undefined;
        if (expected) expect(expected[source.id]).toBe(revision);
        const previewOnly = request.preview_only === true;
        const restore = request.mapping_mode === "restore";
        const targetColor = restore
          ? ((request.restore_palettes as Record<string, Array<{ color: string }>>)[source.id][0].color)
          : "#0000ff";
        const changed = targetColor !== currentColor;
        const oldColor = currentColor;
        if (!previewOnly && changed) {
          currentColor = targetColor;
          revision += 1;
        }
        return {
          preview_only: previewOnly,
          total_sources: 1,
          applicable_count: changed ? 1 : 0,
          applied_count: !previewOnly && changed ? 1 : 0,
          skipped_count: 0,
          affected_sources: [{
            source_id: source.id,
            source_name: source.name,
            revision,
            status: changed ? (previewOnly ? "ready" : "applied") : "unchanged",
            reason: null,
            changes: changed ? [{
              channel: 0,
              channel_name: "DAPI",
              old_color: oldColor,
              new_color: targetColor,
            }] : [],
          }],
          previous_palettes: { [source.id]: [{ channel: 0, color: oldColor }] },
          new_revisions: { [source.id]: revision },
        };
      }
      return viewerContractResponse(operation, request, snapshot) ?? {};
    });
    const desktop = {
      getSnapshot: vi.fn(async () => snapshot),
      execute,
      onSnapshot: vi.fn(() => () => {}),
      onEvent: vi.fn(() => () => {}),
      logClientEvent: vi.fn(async () => {}),
    } as unknown as ResearchDesktopApi;
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Apply colors" }));
    await screen.findByRole("dialog", { name: "Apply channel colours" });
    fireEvent.change(screen.getByRole("combobox", { name: "Palette preset" }), {
      target: { value: "fluorescence-4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply colour to 1 image" }));
    await screen.findByText(/Applied channel colors to 1 image/);
    const savesAfterApply = savedExpectedRevisions.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(savedExpectedRevisions).toHaveLength(savesAfterApply);
    expect(currentColor).toBe("#0000ff");
    expect(revision).toBe(savesAfterApply + 1);

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo colors" }));
    await screen.findByText(/Restored previous colors for 1 image/);
    const savesAfterUndo = savedExpectedRevisions.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(savedExpectedRevisions).toHaveLength(savesAfterUndo);
    expect(currentColor).toBe("#ffffff");
    expect(revision).toBe(savesAfterUndo + 2);
  });

  it("keeps whole-slide camera tiles independent from the declared analysis region", async () => {
    const dimensions = { x: 5000, y: 4000, z: 1, t: 1, c: 1, s: 3 };
    const wsiSnapshot: ResearchSnapshot = {
      ...snapshot,
      sources: [{
        id: "e".repeat(32),
        name: "Public RGB slide",
        sha256: "f".repeat(64),
        source_kind: "whole_slide",
        metadata: {
          format: "NDPI",
          dimensions,
          levels: [{ index: 0, dimensions }],
          channel_names: ["Source RGB samples"],
          sample_semantics: "RGB",
        },
      }],
      results: [],
    };
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      if (operation === "view")
        return { image: "data:image/png;base64,view", selection: request.selection };
      if (operation === "tissue_preview")
        return {
          adopted: false,
          image: "data:image/png;base64,tissue",
          region_count: 0,
          measurements: [],
          provenance: { tissue_mask: { initial_mask_fraction: 0 } },
        };
      return {};
    });
    render(<ResearchWorkbench api={api({
      getSnapshot: vi.fn().mockResolvedValue(wsiSnapshot),
      execute,
    })} onBack={vi.fn()} />);

    await screen.findByLabelText("Image viewer: Public RGB slide");
    await openTool("Analyze", "Analyze");
    expect(screen.getByText("Whole image", { selector: "strong" })).toBeVisible();
    expect(screen.getByText("5,000 × 4,000 · one plane")).toBeVisible();
    await openTool("View", "Display");
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "2048" } });
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "2048" } });
    expect(screen.getByLabelText("Width")).toHaveValue(2048);
    expect(screen.getByLabelText("Height")).toHaveValue(2048);
    await openTool("Analyze", "Analyze");
    expect(screen.getByText("Selected region")).toBeVisible();
    expect(screen.getByText("2,048 × 2,048 · one plane")).toBeVisible();
    for (const request of execute.mock.calls.filter(([operation]) => operation === "view").map(([, value]) => value))
      expect(request.selection).not.toMatchObject({ width: 2048, height: 2048 });
    fireEvent.change(screen.getByLabelText("Segmentation model"), { target: { value: "stain" } });
    fireEvent.change(screen.getByLabelText("Tissue control or review criterion"), {
      target: { value: "Declared technical control" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview tissue mask" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(
      "tissue_preview",
      expect.objectContaining({ selection: expect.objectContaining({ width: 2048, height: 2048 }) }),
    ));
  });

  it("preserves a valid projection and display range while the camera chooses pyramid levels", async () => {
    const pyramidSnapshot: ResearchSnapshot = {
      ...snapshot,
      sources: snapshot.sources.map((source) => ({
        ...source,
        metadata: {
          ...source.metadata,
          dimensions: { x: 1280, y: 960, z: 3, t: 1, c: 2 },
          levels: [
            {
              index: 0, dimensions: { x: 1280, y: 960, z: 3, t: 1, c: 2 },
            },
            {
              index: 1, dimensions: { x: 640, y: 480, z: 3, t: 1, c: 2 },
            },
          ],
        },
      })),
    };
    const singleLevelSource = {
      ...pyramidSnapshot.sources[0],
      id: "e".repeat(32),
      name: "Single-level source",
      metadata: {
        ...pyramidSnapshot.sources[0].metadata,
        levels: [pyramidSnapshot.sources[0].metadata.levels![0]],
      },
    };
    pyramidSnapshot.sources.push(singleLevelSource);
    const execute = vi.fn((operation: string, _request: Record<string, unknown>) =>
      operation === "view"
        ? Promise.resolve({ image: "data:image/png;base64,view" })
        : Promise.resolve({}),
    );
    render(
      <ResearchWorkbench
        api={api({
          getSnapshot: vi.fn().mockResolvedValue(pyramidSnapshot),
          execute,
        })}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText("DAPI"));
    const low = await screen.findByLabelText("Channel 1 low");
    fireEvent.change(low, {
      target: { value: "7" },
    });
    fireEvent.blur(low);
    fireEvent.change(screen.getByLabelText("Display scope"), {
      target: { value: "max" },
    });
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "view",
        expect.objectContaining({ projection: "max" }),
      ),
    );

    const viewer = await screen.findByLabelText("Image viewer: Specimen");
    await waitFor(() => expect(viewer).toHaveAttribute("data-auto-level", "1"));
    for (let index = 0; index < 2; index += 1)
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(viewer).toHaveAttribute("data-auto-level", "0"));
    expect(screen.getByLabelText("Display scope")).toHaveValue("max");
    expect(screen.getByLabelText("Channel 1 low")).toHaveValue("7");
    fireEvent.click(screen.getByRole("button", { name: /Single-level source/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("view",
      expect.objectContaining({ source_id: singleLevelSource.id })));
    const changedSourceRequests = execute.mock.calls.filter(
      ([operation, request]) => operation === "view" && request.source_id === singleLevelSource.id,
    ).map(([, request]) => request);
    for (const request of changedSourceRequests) {
      expect(request.selection).toMatchObject({ level: 0 });
      expect(request).not.toHaveProperty("projection");
      expect(request.selection).not.toHaveProperty("z_stop");
    }
  });

  it("reports model-import failures and binds explicit recovery to the selected model", async () => {
    const modelId = "e".repeat(32);
    const bridge = api({
      importModel: vi.fn().mockRejectedValue(new Error("Selected package differs from this model")),
      execute: vi.fn(async (operation: string) => operation === "model_list" ? {
        models: [{ model_id: modelId, package: { id: "Portable model", version: "1" },
          availability: { state: "reimport-required" }, technical_compatibility: "historical" }],
      } : operation === "view" ? { image: "data:image/png;base64,one" } : {}),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Model");
    fireEvent.change(await screen.findByLabelText("Model package"), { target: { value: modelId } });
    fireEvent.click(await screen.findByRole("button", { name: "Re-import this exact model" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Selected package differs from this model");
    expect(bridge.importModel).toHaveBeenCalledWith(expect.any(Number), modelId);
    expect(screen.getByRole("button", { name: "Import managed package" })).toBeEnabled();
  });

  it("chooses the working-memory budget before importing a managed package", async () => {
    const bridge = api({ importModel: vi.fn().mockResolvedValue({}) });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Model");
    expect(screen.getByLabelText("Model package")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Model working memory"), {
      target: { value: String(2 * 1024 ** 3) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import managed package" }));
    await waitFor(() =>
      expect(bridge.importModel).toHaveBeenCalledWith(2 * 1024 ** 3, undefined),
    );
  });

  it("keeps imported source pixels locked until exact relinking and then refreshes the same source ID", async () => {
    const missing: ResearchSnapshot = {
      ...snapshot,
      sources: snapshot.sources.map((source) => ({ ...source, locator_state: "relink-required" })),
      results: [],
    };
    const bridge = api({
      getSnapshot: vi.fn().mockResolvedValue(missing),
      relinkSource: vi.fn().mockResolvedValue({ ...snapshot, results: [] }),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    expect(await screen.findByText(/This source needs an exact local copy/)).toBeVisible();
    expect(bridge.execute).not.toHaveBeenCalledWith(
      "viewer_tile", expect.anything(), expect.anything(),
    );
    await openAdvancedTool("Import & share results");
    fireEvent.click(await screen.findByRole("button", { name: "Relink exact source" }));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("viewer_tile", expect.objectContaining({
      source_id: snapshot.sources[0].id,
    }), expect.objectContaining({ viewer_lane: expect.stringMatching(/^image-viewport-/) })));
    expect(await screen.findByLabelText("Image viewer: Specimen")).toBeVisible();
  });

  it("renders real orthogonal planes and maps clicks using the returned crop shape", async () => {
    const execute = vi.fn(async (operation: string) =>
      operation === "volume_view"
        ? {
            planes: {
              xy: "data:image/png;base64,xy",
              xz: "data:image/png;base64,xz",
              yz: "data:image/png;base64,yz",
            },
            shape: [3, 48, 64],
            crosshair: [1, 24, 32],
            world_xyz: [32, 24, 1],
            value: 42,
          }
        : { image: "data:image/png;base64,view" },
    );
    const bridge = api({ execute });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByText("Load linked orthogonal crop"));
    const pane = await screen.findByAltText("XZ orthogonal plane");
    expect(await screen.findByAltText("XY orthogonal plane")).toHaveAttribute(
      "src",
      "data:image/png;base64,xy",
    );
    expect(await screen.findByAltText("YZ orthogonal plane")).toBeVisible();
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 20,
      width: 128,
      height: 60,
    } as DOMRect);
    fireEvent.click(pane, { clientX: 74, clientY: 65 });
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "volume_view",
        expect.objectContaining({ crosshair: [2, 24, 32] }),
      ),
    );
    expect(screen.getByText(/value: 42/)).toBeVisible();
  });

  it("explains why a multi-Z RGB source cannot enter scalar 3D volume rendering", async () => {
    const rgbStudy = structuredClone(snapshot);
    rgbStudy.sources[0].name = "RGB Z stack";
    rgbStudy.sources[0].metadata = {
      ...rgbStudy.sources[0].metadata,
      sample_semantics: "RGB",
      dimensions: { x: 64, y: 48, z: 4, t: 1, c: 3 },
      levels: [{
        index: 0,
        dimensions: { x: 64, y: 48, z: 4, t: 1, c: 3 },
      }],
      channel_names: ["Red", "Green", "Blue"],
    };
    const bridge = api({
      getSnapshot: vi.fn().mockResolvedValue(rgbStudy),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);

    const volume = await screen.findByRole("button", { name: "3D volume" });
    expect(volume).toBeDisabled();
    expect(screen.getByText(/scalar|RGB/i, {
      selector: 'span[role="status"]',
    })).toBeVisible();
    fireEvent.click(volume);
    await Promise.resolve();
    expect(bridge.execute).not.toHaveBeenCalledWith(
      "viewer_volume",
      expect.anything(),
    );
  });

  it("renders a finite number of views after the receipt settles", async () => {
    const bridge = api();
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await screen.findByLabelText("Image viewer: Specimen");
    await waitFor(() => expect(vi.mocked(bridge.execute).mock.calls.some(
      ([operation]) => operation === "viewer_tile",
    )).toBe(true));
    const calls = vi.mocked(bridge.execute).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(vi.mocked(bridge.execute).mock.calls.length).toBe(calls);
    expect(calls).toBeLessThanOrEqual(5);
  });
  it("shows restore failures even on the welcome screen", async () => {
    render(
      <ResearchWorkbench
        api={api({
          getSnapshot: vi
            .fn()
            .mockRejectedValue(new Error("Study schema is unsupported")),
        })}
        onBack={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Study schema is unsupported",
    );
  });
  it("previews ordered edits without adopting them and preserves the parameter", async () => {
    const bridge = api();
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Process");
    fireEvent.click(screen.getByText("gaussian", { exact: true }));
    fireEvent.change(screen.getByLabelText("Step 1 sigma"), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByText("Preview selected crop"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith(
        "preview_recipe",
        expect.objectContaining({
          recipe: expect.objectContaining({
            steps: [{ op: "gaussian", sigma: 2.5 }],
          }),
        }),
      ),
    );
    expect(bridge.execute).not.toHaveBeenCalledWith(
      "run_recipe",
      expect.anything(),
    );
  });
  it("uses the source-bound tile operation and keeps display changes out of recipes", async () => {
    const bridge = api();
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith(
        "viewer_tile",
        expect.objectContaining({ source_id: "a".repeat(32) }),
        expect.objectContaining({ viewer_lane: expect.stringMatching(/^image-viewport-/) }),
      ),
    );
    fireEvent.change(screen.getByLabelText("Channel 1 low"), {
      target: { value: "7" },
    });
    expect(bridge.execute).not.toHaveBeenCalledWith(
      "recipe",
      expect.anything(),
    );
  });
  it("discards an older tile response after a newer selection request", async () => {
    let first!: (value: unknown) => void;
    let calls = 0;
    const bridge = api({
      execute: vi.fn((operation: string, request: Record<string, unknown>) => {
        if (operation !== "view") return Promise.resolve({});
        calls += 1;
        return calls === 1
          ? new Promise((resolve) => {
              first = resolve;
            })
          : Promise.resolve({ image: "data:image/png;base64,new" });
      }),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(1));
    fireEvent.change(screen.getByLabelText("Z plane"), { target: { value: "2" } });
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    first({ image: "data:image/png;base64,old" });
    await waitFor(() => expect(canvasContext.drawImage.mock.calls.flat().some(
      (value) => value?.src?.startsWith?.("data:image/png;base64,new"),
    )).toBe(true));
    expect(canvasContext.drawImage.mock.calls.flat().some(
      (value) => value?.src?.startsWith?.("data:image/png;base64,old"),
    )).toBe(false);
  });
  it("saves explicit sample metadata and displays linked result measurements", async () => {
    const bridge = api();
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await screen.findAllByText("Specimen");
    await openTool("Results", "Info");
    fireEvent.click(screen.getByText("Study metadata", { exact: true }));
    fireEvent.change(screen.getByLabelText("condition"), {
      target: { value: "Drug" },
    });
    fireEvent.click(screen.getByText("Save metadata"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith(
        "sample",
        expect.objectContaining({
          data: expect.objectContaining({
            condition: "Drug",
            study: "Test study",
          }),
        }),
      ),
    );
    await selectHistoryResult();
    await openTool("Analyze", "Analyze");
    await waitFor(() => expect(screen.getByText("22")).toBeVisible());
  });
  it("refreshes exact review state, blocks duplicate review writes, and gates export", async () => {
    const reviewed = structuredClone(snapshot);
    reviewed.results[0].review = { disposition: "reviewed" };
    let current = snapshot;
    let finishReview!: () => void;
    const fetchSnapshot = vi.fn(() => Promise.resolve(current));
    const reviewResult = vi.fn(
      () => new Promise<void>((resolve) => {
        finishReview = () => {
          current = reviewed;
          resolve();
        };
      }),
    );
    const bridge = api({ getSnapshot: fetchSnapshot, reviewResult });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Results", "Info");

    expect(screen.getByText("Review required before export")).toBeVisible();
    const markReviewed = screen.getByRole("button", { name: "Mark reviewed" });
    const exportRevision = screen.getByRole("button", { name: "Export revision" });
    expect(exportRevision).toBeDisabled();
    fireEvent.click(markReviewed);
    fireEvent.click(markReviewed);
    expect(reviewResult).toHaveBeenCalledOnce();
    expect(markReviewed).toBeDisabled();
    expect(screen.getByText("Review pending")).toBeVisible();

    finishReview();
    await waitFor(() => expect(screen.getByText("Reviewed")).toBeVisible());
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(markReviewed).toBeDisabled();
    expect(exportRevision).toBeEnabled();
  });
  it("requires an explicit generic RGB intensity conversion without assuming histology", async () => {
    const rgb = structuredClone(snapshot);
    rgb.sources[0].metadata.sample_semantics = "RGB";
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(rgb) });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Analyze");
    expect(screen.queryByLabelText("Stain basis")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run recipe" })).toBeDisabled();
    expect(bridge.execute).not.toHaveBeenCalledWith("run_recipe", expect.anything());
    fireEvent.change(screen.getByLabelText("RGB analysis input"), { target: { value: "rgb_intensity" } });
    expect(screen.queryByLabelText("Measurement channel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("run_recipe", expect.objectContaining({
      source_id: rgb.sources[0].id,
      recipe: expect.objectContaining({ input_transform: "rgb_intensity", measurement_channels: [], gates: [], segmentation: expect.objectContaining({ threshold: 0.5 }) }),
    })));
  });

  it("sends a declared RGB histology request and keeps preview non-adopted", async () => {
    const rgb = structuredClone(snapshot);
    rgb.sources[0].metadata.sample_semantics = "RGB";
    const bridge = api({
      getSnapshot: vi.fn().mockResolvedValue(rgb),
      execute: vi.fn((operation: string) =>
        operation === "view"
          ? Promise.resolve({ image: "data:image/png;base64,view" })
          : operation === "histology_preview"
            ? Promise.resolve({
                image: "data:image/png;base64,stain",
                measurements: [],
              })
            : Promise.resolve({}),
      ),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Analyze");
    fireEvent.change(screen.getByLabelText("Segmentation model"), { target: { value: "stain" } });
    expect(
      screen.getByText("Stain minimum object area (pixel²)"),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Stain basis"), {
      target: { value: "H-DAB" },
    });
    fireEvent.change(screen.getByLabelText("Stain component"), {
      target: { value: "1" },
    });
    expect(screen.queryByLabelText("Threshold")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Stain-coordinate threshold")).toHaveValue(
      0.15,
    );
    fireEvent.change(screen.getByLabelText("Stain-coordinate threshold"), {
      target: { value: "0.27" },
    });
    fireEvent.change(screen.getByLabelText("Stain minimum object size"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByText("Preview declared stain"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith(
        "histology_preview",
        expect.objectContaining({
          basis: "H-DAB",
          component: 1,
          steps: [],
          segmentation: expect.objectContaining({
            method: "components",
            threshold: 0.27,
            min_size: 4,
          }),
          gates: [],
        }),
      ),
    );
    expect(bridge.execute).not.toHaveBeenCalledWith(
      "histology_run",
      expect.anything(),
    );
  });
  it("labels calibrated RGB stain minimum size as physical area", async () => {
    const rgb = structuredClone(snapshot);
    rgb.sources[0].metadata.sample_semantics = "RGB";
    rgb.sources[0].metadata.physical_calibration = {
      unit: "um",
      spacing: [0.5, 0.5],
    };
    render(
      <ResearchWorkbench
        api={api({ getSnapshot: vi.fn().mockResolvedValue(rgb) })}
        onBack={vi.fn()}
      />,
    );
    await openTool("Analyze", "Analyze");
    fireEvent.change(screen.getByLabelText("Segmentation model"), { target: { value: "stain" } });
    expect(screen.getByText("Stain minimum object area (um²)")).toBeVisible();
    expect(screen.getByLabelText("Stain minimum object size")).toHaveValue(10);
  });
  it("sends only the explicit stain-coordinate rule with its retained control", async () => {
    const rgb = structuredClone(snapshot);
    rgb.sources[0].metadata.sample_semantics = "RGB";
    const bridge = api({
      getSnapshot: vi.fn().mockResolvedValue(rgb),
      execute: vi.fn((operation: string) =>
        operation === "view"
          ? Promise.resolve({ image: "data:image/png;base64,view" })
          : operation === "histology_preview"
            ? Promise.resolve({ image: "data:image/png;base64,stain", measurements: [] })
            : Promise.resolve({}),
      ),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Analyze");
    fireEvent.change(screen.getByLabelText("Segmentation model"), { target: { value: "stain" } });
    fireEvent.click(screen.getByLabelText("Enable stain measurement rule"));
    expect(screen.getByText("Preview declared stain")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Stain rule name"), {
      target: { value: "Declared-positive" },
    });
    fireEvent.change(screen.getByLabelText("Stain rule channel"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Stain rule statistic"), {
      target: { value: "max" },
    });
    fireEvent.change(screen.getByLabelText("Stain rule threshold"), {
      target: { value: "0.42" },
    });
    fireEvent.change(screen.getByLabelText("Stain rule control or evidence"), {
      target: { value: "Threshold from the declared control section" },
    });
    fireEvent.change(screen.getByLabelText("Stain basis"), {
      target: { value: "H-DAB" },
    });
    expect(screen.getByLabelText("Stain rule channel")).toHaveDisplayValue("DAB basis");
    expect(screen.getByLabelText("Stain rule control or evidence")).toHaveValue(
      "Threshold from the declared control section",
    );
    fireEvent.click(screen.getByText("Preview declared stain"));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith(
      "histology_preview",
      expect.objectContaining({
        basis: "H-DAB",
        gates: [{
          name: "Declared-positive",
          channel: "DAB-basis",
          statistic: "max",
          threshold: 0.42,
          control: "Threshold from the declared control section",
        }],
      }),
    ));
    expect(screen.getByText(/strictly greater than the declared threshold/)).toBeVisible();
  });
  it("binds model adoption to the returned exact preview", async () => {
    const model = {
      model_id: "e".repeat(32),
      package: {
        id: "synthetic",
        version: "1",
        input: { channels: [{ name: "declared-fluorescence-intensity", source_index: 0 }] },
      },
      technical_compatibility: "reference-qualified",
      reference_qualification: {},
      scientific_validation: { status: "unvalidated" },
      usage_rights: {},
    };
    const bridge = api({
      execute: vi.fn((operation: string, request: Record<string, unknown>) => {
        if (operation === "view")
          return Promise.resolve({ image: "data:image/png;base64,view" });
        if (operation === "model_list")
          return Promise.resolve({ models: [model] });
        if (operation === "model_preview")
          return Promise.resolve({
            preview: { id: "f".repeat(32), preview_sha256: "1".repeat(64) },
            overlay_png: "data:image/png;base64,overlay",
          });
        return Promise.resolve({});
      }),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Model");
    fireEvent.change(await screen.findByLabelText("Model package"), {
      target: { value: model.model_id },
    });
    fireEvent.click(screen.getByText("Preview model overlay"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith(
        "model_preview",
        expect.objectContaining({
          model_id: model.model_id,
          channel_mapping: [
            {
              model_input_index: 0,
              model_channel: "declared-fluorescence-intensity",
              source_channel: 0,
            },
          ],
          postprocessing: expect.objectContaining({ split_height: null }),
          working_bytes: 512 * 1024 ** 2,
        }),
      ),
    );
    fireEvent.click(await screen.findByText("Adopt exact preview"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith("model_run", {
        preview_id: "f".repeat(32),
        preview_sha256: "1".repeat(64),
      }),
    );
  });
  it("invalidates a pending model preview when a model setting changes", async () => {
    const model = {
      model_id: "e".repeat(32),
      package: {
        id: "synthetic",
        input: { channels: [{ name: "declared-fluorescence-intensity", source_index: 0 }] },
      },
    };
    const bridge = api({
      execute: vi.fn((operation: string) =>
        operation === "view"
          ? Promise.resolve({ image: "data:image/png;base64,view" })
          : operation === "model_list"
            ? Promise.resolve({ models: [model] })
            : operation === "model_preview"
              ? Promise.resolve({
                  preview: {
                    id: "f".repeat(32),
                    preview_sha256: "1".repeat(64),
                  },
                  overlay_png: "data:image/png;base64,overlay",
                })
              : Promise.resolve({}),
      ),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Model");
    fireEvent.change(await screen.findByLabelText("Model package"), {
      target: { value: model.model_id },
    });
    fireEvent.click(screen.getByText("Preview model overlay"));
    expect(await screen.findByText(/Pending preview/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Model threshold"), {
      target: { value: "0.7" },
    });
    await waitFor(() =>
      expect(screen.getByText("Adopt exact preview")).toBeDisabled(),
    );
  });
  it("holds the study worker through preview and batch, then permits another preview", async () => {
    let finishPreview!: (value: unknown) => void;
    let finishRun!: (value: unknown) => void;
    const execute = vi.fn(
      (operation: string, request: Record<string, unknown>) => {
        if (operation === "view")
          return Promise.resolve({
            image: "data:image/png;base64,view",
            selection: request.selection,
          });
        if (operation === "preview_recipe")
          return new Promise((resolve) => {
            finishPreview = resolve;
          });
        if (operation === "run_recipe")
          return new Promise((resolve) => {
            finishRun = resolve;
          });
        return Promise.resolve({});
      },
    );
    const bridge = api({ execute });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Results", "Study");
    const included = screen.getByLabelText("Include Specimen in batch");
    fireEvent.click(included);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const batch = screen.getByRole("button", {
      name: "Run selected sources sequentially",
    });
    expect(batch).toBeDisabled();
    expect(included).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previewing…" })).toBeDisabled();
    fireEvent.click(batch);
    expect(
      execute.mock.calls.filter(([operation]) => operation === "run_recipe"),
    ).toHaveLength(0);
    finishPreview({ object_count: 2 });
    await waitFor(() => expect(batch).toBeEnabled());
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
    fireEvent.click(batch);
    expect(batch).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    await waitFor(() => expect(bridge.runBatchJob).toHaveBeenCalledOnce());
    finishRun({ result: { id: "9".repeat(32) } });
    await waitFor(() => expect(batch).toBeEnabled());
    expect(await screen.findByText(/Specimen: succeeded/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      execute.mock.calls.filter(
        ([operation]) => operation === "preview_recipe",
      ),
    ).toHaveLength(2);
    finishPreview({ object_count: 2 });
    await waitFor(() => expect(batch).toBeEnabled());
  });

  it("submits every source before running and stops before the next queued item", async () => {
    const second = { ...structuredClone(snapshot.sources[0]), id: "f".repeat(32), name: "Second" };
    const study = { ...structuredClone(snapshot), sources: [snapshot.sources[0], second] };
    const batchId = "8".repeat(32);
    const jobs = study.sources.map((item, index): ResearchJob => ({
      id: (index + 1).toString(16).padStart(32, "0"),
      operation: "run_recipe",
      request: { source_id: item.id, selection: {}, recipe: {} },
      request_key: `loci-batch:${batchId}:initial:${String(index).padStart(5, "0")}`,
      request_hash: (index + 10).toString(16).padStart(64, "0"),
      state: "queued",
      created_at: `2026-09-08T00:00:0${index}Z`,
      updated_at: `2026-09-08T00:00:0${index}Z`,
      progress: 0,
      cancel_requested: false,
      result_ids: [],
      error: null,
    }));
    let finishFirst!: (value: unknown) => void;
    const submitBatch = vi.fn().mockResolvedValue({ batch_id: batchId, jobs });
    const runBatchJob = vi.fn().mockImplementation(() =>
      new Promise((resolve) => { finishFirst = resolve; }));
    const cancelJob = vi.fn().mockResolvedValue({});
    const bridge = api({
      getSnapshot: vi.fn().mockResolvedValue(study),
      submitBatch,
      runBatchJob,
      cancelJob,
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Results", "Study");
    fireEvent.click(screen.getByLabelText("Include Specimen in batch"));
    fireEvent.click(screen.getByLabelText("Include Second in batch"));
    fireEvent.click(screen.getByRole("button", { name: "Run selected sources sequentially" }));

    await waitFor(() => expect(submitBatch).toHaveBeenCalledOnce());
    expect(submitBatch.mock.calls[0][0]).toHaveLength(2);
    await waitFor(() => expect(runBatchJob).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Stop batch" }));
    expect(cancelJob).toHaveBeenCalledWith(jobs[0].id);
    finishFirst({ job: { ...jobs[0], state: "cancelled" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop batch" })).toBeNull());
    expect(runBatchJob).toHaveBeenCalledTimes(1);
  });

  it("pauses source refinement while resuming a durable batch and retains the viewer", async () => {
    const batchId = "8".repeat(32);
    const job: ResearchJob = {
      id: "1".padStart(32, "0"),
      operation: "run_recipe",
      request: { source_id: snapshot.sources[0].id, selection: {}, recipe: {} },
      request_key: `loci-batch:${batchId}:initial:00000`,
      request_hash: "a".repeat(64),
      state: "queued",
      created_at: "2026-09-08T00:00:00Z",
      updated_at: "2026-09-08T00:00:00Z",
      progress: 0,
      cancel_requested: false,
      result_ids: [],
      error: null,
    };
    const queuedStudy: ResearchSnapshot = { ...snapshot, jobs: [job] };
    let finishResume!: () => void;
    let rejectTile!: (error: Error) => void;
    let delayed = false;
    let main!: HTMLElement;
    const resumeBatch = vi.fn(() => new Promise<ResearchBatchReceipt>((resolve) => {
      expect(main).toHaveAttribute("inert");
      finishResume = () => resolve({ batch_id: batchId, jobs: [job] });
    }));
    const runBatchJob = vi.fn().mockResolvedValue({
      job: { ...job, state: "succeeded", progress: 1 },
    });
    const bridge = api({
      getSnapshot: vi.fn().mockResolvedValue(queuedStudy),
      resumeBatch,
      runBatchJob,
    });
    const original = bridge.execute;
    bridge.execute = vi.fn(async (operation, request) => {
      if (operation === "viewer_tile" && !request.overview && !delayed) {
        delayed = true;
        return new Promise((_, reject) => { rejectTile = reject; });
      }
      return original(operation, request);
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    main = await screen.findByRole("main", { name: "Research workspace" });
    const viewer = await screen.findByLabelText("Image viewer: Specimen");
    await waitFor(() => expect(delayed).toBe(true));
    const previousCamera = viewer.getAttribute("data-camera");
    await openTool("Results", "Study");
    const resume = await screen.findByRole("button", { name: "Resume batch" });

    fireEvent.click(resume);
    await waitFor(() => expect(resumeBatch).toHaveBeenCalledWith(batchId));
    expect(main).toHaveAttribute("inert");
    expect(resume).toBeDisabled();
    rejectTile(new Error("Wait for the study to finish opening."));
    await Promise.resolve();
    finishResume();

    await waitFor(() => expect(runBatchJob).toHaveBeenCalledWith(batchId, job.id));
    await waitFor(() => expect(main).not.toHaveAttribute("inert"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Image viewer: Specimen")).toBe(viewer);
    expect(viewer).toHaveAttribute("data-camera", previousCamera);
    await waitFor(() => expect(resume).toBeEnabled());
  });

  it("releases study controls after a failed preview without submitting a batch", async () => {
    const execute = vi.fn(
      (operation: string, request: Record<string, unknown>) => {
        if (operation === "view")
          return Promise.resolve({
            image: "data:image/png;base64,view",
            selection: request.selection,
          });
        if (operation === "preview_recipe")
          return Promise.reject(
            new Error("The exact source no longer matches"),
          );
        return Promise.resolve({});
      },
    );
    render(<ResearchWorkbench api={api({ execute })} onBack={vi.fn()} />);
    await openTool("Results", "Study");
    fireEvent.click(screen.getByLabelText("Include Specimen in batch"));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The exact source no longer matches",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled(),
    );
    expect(
      screen.getByRole("button", { name: "Run selected sources sequentially" }),
    ).toBeEnabled();
    expect(
      execute.mock.calls.filter(([operation]) => operation === "run_recipe"),
    ).toHaveLength(0);
  });

  it("records per-source batch failure and sends reviewed study comparison ids", async () => {
    const second = structuredClone(snapshot.sources[0]);
    second.id = "f".repeat(32);
    second.name = "Second";
    const study = structuredClone(snapshot);
    study.sources.push(second);
    study.results[0].review = { disposition: "reviewed" };
    const bridge = api({
      getSnapshot: vi.fn().mockResolvedValue(study),
      execute: vi.fn((operation: string, request: Record<string, unknown>) => {
        if (operation === "view")
          return Promise.resolve({ image: "data:image/png;base64,view" });
        if (operation === "preview_recipe")
          return Promise.resolve({ object_count: 4 });
        if (operation === "run_recipe")
          return request.source_id === second.id
            ? Promise.reject(new Error("selection is outside source"))
            : Promise.resolve({ result: { id: "9".repeat(32) } });
        if (operation === "study_summary")
          return Promise.resolve({
            summaries: [
              {
                n_objects: 4,
                n_images: 2,
                n_biological_replicates: 1,
                mean: 2,
                sd: 0,
              },
            ],
          });
        return Promise.resolve({});
      }),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Results", "Study");
    fireEvent.click(screen.getByLabelText("Include Specimen in batch"));
    fireEvent.click(screen.getByLabelText("Include Second in batch"));
    fireEvent.click(screen.getByText("Run selected sources sequentially"));
    expect(await screen.findByText(/Second: failed/)).toBeVisible();
    fireEvent.click(screen.getByLabelText("Compare " + "c".repeat(32)));
    fireEvent.click(screen.getByText("Summarize selected revisions"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith("study_summary", {
        result_ids: ["c".repeat(32)],
        value: "measure",
      }),
    );
    expect(await screen.findByText(/n biological replicates: 1/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Batch export contents"), {
      target: { value: "summary-only" },
    });
    fireEvent.click(screen.getByText("Export selected reviewed results"));
    await waitFor(() => expect(bridge.exportBatch).toHaveBeenCalledWith([{
      source_id: snapshot.sources[0].id,
      source_sha256: snapshot.sources[0].sha256,
      result_id: "c".repeat(32),
      revision_hash: "d".repeat(64),
    }], { mode: "summary-only" }));
  });
  it("compares two exact reviewed run groups and renders the reproducibility receipt", async () => {
    const secondSource = {
      ...structuredClone(snapshot.sources[0]),
      id: "f".repeat(32),
      name: "Second specimen",
      sha256: "1".repeat(64),
    };
    const result = (
      id: string,
      sourceId: string,
      revision: string,
      disposition: "reviewed" | "excluded" | "pending",
    ) => ({
      ...structuredClone(snapshot.results[0]),
      id,
      source_id: sourceId,
      revision_hash: revision,
      review: { disposition },
    });
    const runA = [
      result("2".repeat(32), snapshot.sources[0].id, "a".repeat(64), "reviewed"),
      result("3".repeat(32), secondSource.id, "b".repeat(64), "reviewed"),
    ];
    const runB = [
      result("4".repeat(32), snapshot.sources[0].id, "c".repeat(64), "excluded"),
      result("5".repeat(32), secondSource.id, "d".repeat(64), "reviewed"),
    ];
    const pending = result(
      "6".repeat(32),
      snapshot.sources[0].id,
      "e".repeat(64),
      "pending",
    );
    const study = {
      ...structuredClone(snapshot),
      sources: [structuredClone(snapshot.sources[0]), secondSource],
      results: [...runA, ...runB, pending],
    };
    const comparison = {
      schema: "loci.study-run-comparison/v1",
      value: "measure",
      unit: "pixel^2",
      method: "7".repeat(64),
      run_scope: "same-grid",
      independent_n_basis:
        "biological replicate means; objects and images are correlated",
      left: {
        bindings: runA.map((item) => ({
          result_id: item.id,
          revision_hash: item.revision_hash,
          source_id: item.source_id,
          source_sha256:
            item.source_id === secondSource.id
              ? secondSource.sha256
              : snapshot.sources[0].sha256,
          review: { disposition: "reviewed" },
        })),
      },
      right: {
        bindings: runB.map((item) => ({
          result_id: item.id,
          revision_hash: item.revision_hash,
          source_id: item.source_id,
          source_sha256:
            item.source_id === secondSource.id
              ? secondSource.sha256
              : snapshot.sources[0].sha256,
          review: item.review,
        })),
      },
      comparisons: [
        {
          condition: "control",
          left_mean: 6,
          right_mean: 8,
          difference: 2,
          left_n_biological_replicates: 2,
          right_n_biological_replicates: 1,
        },
      ],
      p_values: null,
      interpretation:
        "descriptive run comparison; no hypothesis tests on correlated objects",
      receipt_sha256: "9".repeat(64),
    };
    const bridge = api({
      getSnapshot: vi.fn().mockResolvedValue(study),
      execute: vi.fn((operation: string) =>
        operation === "view"
          ? Promise.resolve({ image: "data:image/png;base64,view" })
          : operation === "study_compare"
            ? Promise.resolve(comparison)
            : Promise.resolve({}),
      ),
    });
    const mounted = render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Results", "Study");
    for (const item of runA)
      fireEvent.click(screen.getByLabelText(`Include ${item.id} in run A`));
    for (const item of runB)
      fireEvent.click(screen.getByLabelText(`Include ${item.id} in run B`));
    expect(
      screen.getByLabelText(`Include ${pending.id} in run A`),
    ).toBeDisabled();
    fireEvent.click(screen.getByText("Compare run A with run B"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith("study_compare", {
        left_result_ids: runA.map((item) => item.id),
        right_result_ids: runB.map((item) => item.id),
        value: "measure",
      }),
    );
    const table = await screen.findByLabelText("Study run comparison");
    expect(table).toHaveTextContent("control");
    expect(table).toHaveTextContent("6");
    expect(table).toHaveTextContent("8");
    expect(table).toHaveTextContent("2");
    expect(
      screen.getByText(/receipt SHA-256: 9999999999999999/),
    ).toBeVisible();
    expect(screen.getByLabelText("Run A exact revision bindings")).toHaveTextContent(
      `Result ${runA[0].id}; revision ${runA[0].revision_hash}`,
    );
    expect(screen.getByLabelText("Run B exact revision bindings")).toHaveTextContent(
      "excluded",
    );
    fireEvent.click(screen.getByLabelText(`Mark ${runA[0].id} excluded`));
    await waitFor(() =>
      expect(bridge.reviewResult).toHaveBeenCalledWith(
        runA[0].id,
        runA[0].revision_hash,
        "excluded",
      ),
    );
    mounted.unmount();

    const reopenedStudy = {
      ...study,
      comparisons: [
        {
          id: "9".repeat(32),
          revision: 1,
          updated_at: "2026-09-07T00:00:00+00:00",
          data: {
            request: {
              left_result_ids: runA.map((item) => item.id),
              right_result_ids: runB.map((item) => item.id),
              value: "measure",
            },
            receipt: comparison,
          },
        },
      ],
    };
    render(
      <ResearchWorkbench
        api={api({ getSnapshot: vi.fn().mockResolvedValue(reopenedStudy) })}
        onBack={vi.fn()}
      />,
    );
    await openTool("Results", "Study");
    expect(await screen.findByLabelText("Study run comparison")).toBeVisible();
    expect(screen.getByLabelText(`Include ${runA[0].id} in run A`)).toBeChecked();
    expect(screen.getByLabelText(`Include ${runB[0].id} in run B`)).toBeChecked();
  });
  it("renders the initial correction plane when the child reports its unchanged XY view on mount", async () => {
    const execute = vi.fn((operation: string, request: Record<string, unknown>) => {
      if (operation === "view") return Promise.resolve({ image: "data:image/png;base64,source" });
      if (operation === "result") return Promise.resolve({ measurements: [] });
      if (operation === "result_view") {
        const axis = (request.axis as "x" | "y" | "z") ?? "z";
        const index = Number(request.index ?? 1);
        return Promise.resolve({
          ...resultView(snapshot.results[0], axis, index),
          image: `data:image/png;base64,${axis}${index}`,
        });
      }
      if (operation === "correction_info") return Promise.resolve({
        result_id: snapshot.results[0].id,
        revision_hash: snapshot.results[0].revision_hash,
        label_sha256: "1".repeat(64),
        shape: [3, 48, 64],
        label_ids: [1, 2],
        parent_id: null,
        measurement_channels: [
          { index: 0, name: "Raw 1", basis: "raw-source-channel-values" },
        ],
        derived_measurement_arrays: null,
      });
      return Promise.resolve({});
    });
    render(<ResearchWorkbench api={api({ execute })} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Annotate", "Correction");
    await screen.findByText(/Exact label SHA-256/);
    const image = await screen.findByAltText("Exact selected result revision");
    expect(image).toHaveAttribute("src", "data:image/png;base64,z0");
    expect(screen.queryByText("Loading exact correction plane…")).not.toBeInTheDocument();
    expect(execute).toHaveBeenCalledWith("result_view", {
      result_id: snapshot.results[0].id,
      axis: "z",
      index: 0,
      labels: true,
    });
  });

  it("renders the requested correction axis and index before mapping native plane pixels", async () => {
    const child = {
      ...snapshot.results[0],
      id: "e".repeat(32),
      revision_hash: "f".repeat(64),
      kind: "corrected-labels",
      parent_id: snapshot.results[0].id,
      review: null,
    };
    let resolveOlder!: (value: unknown) => void;
    const execute = vi.fn(
      (operation: string, request: Record<string, unknown>) => {
        if (operation === "view")
          return Promise.resolve({ image: "data:image/png;base64,source" });
        if (operation === "result")
          return Promise.resolve({ measurements: [] });
        if (operation === "correction_info")
          return Promise.resolve({
            result_id: snapshot.results[0].id,
            revision_hash: snapshot.results[0].revision_hash,
            label_sha256: "1".repeat(64),
            shape: [3, 48, 64],
            label_ids: [1, 2],
            parent_id: null,
            measurement_channels: [
              { index: 0, name: "Raw 1", basis: "raw-source-channel-values" },
            ],
            derived_measurement_arrays: null,
          });
        if (operation === "result_view") {
          const axis = (request.axis as "x" | "y" | "z") ?? "z";
          const index = Number(request.index ?? 1);
          if (axis === "y" && index === 0)
            return new Promise((resolve) => {
              resolveOlder = resolve;
            });
          return Promise.resolve({
            ...resultView(snapshot.results[0], axis, index),
            image: `data:image/png;base64,${axis}${index}`,
          });
        }
        if (operation === "correct_result")
          return Promise.resolve({ result: child });
        if (operation === "select_result")
          return Promise.resolve({
            result: child,
            selection: {
              id: snapshot.sources[0].id,
              revision: 1,
              data: { result_id: child.id, revision_hash: child.revision_hash },
            },
          });
        return Promise.resolve({});
      },
    );
    render(<ResearchWorkbench api={api({ execute })} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Annotate", "Correction");
    await screen.findByText(/Exact label SHA-256/);
    fireEvent.change(screen.getByLabelText("Correction plane"), {
      target: { value: "XZ" },
    });
    fireEvent.change(screen.getByLabelText("Correction plane index"), {
      target: { value: "2" },
    });
    const image = await screen.findByAltText("Exact selected result revision");
    expect(image).toHaveAttribute("src", "data:image/png;base64,y2");
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 126,
      height: 100,
    } as DOMRect);
    fireEvent.pointerDown(image, { clientX: 63, clientY: 50 });
    fireEvent.click(screen.getByText("Commit brush"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "correct_result",
        expect.objectContaining({
          operations: [
            expect.objectContaining({
              plane: "XZ",
              index: 2,
              points: [{ u: 32, v: 1 }],
            }),
          ],
        }),
      ),
    );
    resolveOlder({
      ...resultView(snapshot.results[0], "y", 0),
      image: "data:image/png;base64,stale",
    });
    await waitFor(() =>
      expect(image).toHaveAttribute("src", "data:image/png;base64,y2"),
    );
  });

  it("uses an explicit valid projection range, deletes it for 2D, and starts fitted", async () => {
    const execute = vi.fn((operation: string) =>
      operation === "view"
        ? Promise.resolve({ image: "data:image/png;base64,view" })
        : Promise.resolve({}),
    );
    render(<ResearchWorkbench api={api({ execute })} onBack={vi.fn()} />);
    const sourceImage = await screen.findByLabelText("Image viewer: Specimen");
    await waitFor(() => expect(
      JSON.parse(sourceImage.getAttribute("data-camera")!).scale,
    ).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    await waitFor(() => expect(
      JSON.parse(sourceImage.getAttribute("data-camera")!).scale,
    ).toBeCloseTo(1 / window.devicePixelRatio));
    fireEvent.change(screen.getByLabelText("Display scope"), {
      target: { value: "max" },
    });
    await waitFor(() => expect(execute).toHaveBeenCalledWith("view",
      expect.objectContaining({ projection: "max",
        selection: expect.objectContaining({ z: 0, z_stop: 3 }) })));
    expect(screen.getByText("Z 1–3 · display projection")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Display scope"), {
      target: { value: "plane" },
    });
    expect(screen.queryByText(/display projection/)).not.toBeInTheDocument();
    await openTool("Analyze", "Analyze");
    fireEvent.click(screen.getByText("Run recipe"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "run_recipe",
        expect.objectContaining({
          selection: expect.not.objectContaining({ z_stop: expect.anything() }),
        }),
      ),
    );
  });

  it("ignores delayed correction information after switching sources", async () => {
    const second = {
      ...snapshot.sources[0],
      id: "9".repeat(32),
      name: "Other source",
    };
    const changed = { ...snapshot, sources: [...snapshot.sources, second] };
    let resolveInfo!: (value: unknown) => void;
    const execute = vi.fn(
      (operation: string, request: Record<string, unknown>) => {
        if (operation === "view")
          return Promise.resolve({ image: "data:image/png;base64,view" });
        if (operation === "result")
          return Promise.resolve({ measurements: [] });
        if (operation === "result_view")
          return Promise.resolve(
            resultView(
              snapshot.results[0],
              (request.axis as "x" | "y" | "z") ?? "z",
              Number(request.index ?? 1),
            ),
          );
        if (operation === "correction_info")
          return new Promise((resolve) => {
            resolveInfo = resolve;
          });
        return Promise.resolve({});
      },
    );
    render(
      <ResearchWorkbench
        api={api({ getSnapshot: vi.fn().mockResolvedValue(changed), execute })}
        onBack={vi.fn()}
      />,
    );
    await selectHistoryResult();
    await openTool("Annotate", "Correction");
    fireEvent.click(screen.getByText("Other source"));
    resolveInfo({
      result_id: snapshot.results[0].id,
      revision_hash: snapshot.results[0].revision_hash,
      label_sha256: "1".repeat(64),
      shape: [3, 48, 64],
      label_ids: [1],
      parent_id: null,
      measurement_channels: [
        { index: 0, name: "Raw 1", basis: "raw-source-channel-values" },
      ],
      derived_measurement_arrays: null,
    });
    expect(
      await screen.findByText("Select an exact segmented result first."),
    ).toBeVisible();
    expect(screen.queryByText(/Exact label SHA-256/)).not.toBeInTheDocument();
  });
  it("maps correction canvas points through the actual result image and binds an immutable child to its SHA", async () => {
    const child: ResearchSnapshot["results"][number] = {
      ...snapshot.results[0],
      id: "e".repeat(32),
      kind: "corrected-labels",
      revision_hash: "f".repeat(64),
      parent_id: snapshot.results[0].id,
      review: null,
    };
    const bridge = api({
      execute: vi.fn((operation: string, request: Record<string, unknown>) => {
        if (operation === "view")
          return Promise.resolve({ image: "data:image/png;base64,view" });
        if (operation === "result")
          return Promise.resolve({ measurements: [] });
        if (operation === "result_view") {
          const target =
            request.result_id === child.id ? child : snapshot.results[0];
          return Promise.resolve(
            resultView(
              target,
              (request.axis as "x" | "y" | "z") ?? "z",
              Number(request.index ?? 1),
            ),
          );
        }
        if (operation === "correction_info")
          return Promise.resolve({
            result_id: snapshot.results[0].id,
            revision_hash: snapshot.results[0].revision_hash,
            label_sha256: "1".repeat(64),
            shape: [3, 48, 64],
            label_ids: [1, 2],
            parent_id: null,
            measurement_channels: [
              { index: 0, name: "Raw 1", basis: "raw-source-channel-values" },
            ],
            derived_measurement_arrays: null,
          });
        if (operation === "correct_result")
          return Promise.resolve({ result: child, measurements: [] });
        if (operation === "select_result")
          return Promise.resolve({
            result: child,
            selection: {
              id: snapshot.sources[0].id,
              revision: 1,
              data: { result_id: child.id, revision_hash: child.revision_hash },
            },
          });
        return Promise.resolve({});
      }),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Annotate", "Correction");
    await screen.findByText(/Exact label SHA-256/);
    const image = screen.getByAltText("Exact selected result revision");
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      width: 128,
      height: 96,
    } as DOMRect);
    fireEvent.pointerDown(image, { clientX: 164, clientY: 98 });
    expect(await screen.findByText(/1 drawn points/)).toBeVisible();
    fireEvent.click(screen.getByText("Commit brush"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith(
        "correct_result",
        expect.objectContaining({
          result_id: "c".repeat(32),
          revision_hash: "d".repeat(64),
          operations: [
            expect.objectContaining({
              expected_input_sha256: "1".repeat(64),
              points: [{ u: 32, v: 24 }],
            }),
          ],
        }),
      ),
    );
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith(
        "result",
        expect.objectContaining({ result_id: child.id }),
      ),
    );
  });

  it("fits a non-square plane without letterboxing its pixel bounds and maps voxel centers", async () => {
    let notifyResize!: () => void;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const child: ResearchSnapshot["results"][number] = {
      ...snapshot.results[0],
      id: "8".repeat(32),
      kind: "corrected-labels",
      revision_hash: "9".repeat(64),
      parent_id: snapshot.results[0].id,
      review: null,
    };
    const bridge = api({
      execute: vi.fn((operation: string, request: Record<string, unknown>) => {
        if (operation === "view")
          return Promise.resolve({ image: "data:image/png;base64,view" });
        if (operation === "result") return Promise.resolve({ measurements: [] });
        if (operation === "result_view") {
          const target = request.result_id === child.id ? child : snapshot.results[0];
          return Promise.resolve(
            resultView(
              target,
              (request.axis as "x" | "y" | "z") ?? "z",
              Number(request.index ?? 0),
              [3, 20, 100],
            ),
          );
        }
        if (operation === "correction_info")
          return Promise.resolve({
            result_id: snapshot.results[0].id,
            revision_hash: snapshot.results[0].revision_hash,
            label_sha256: "1".repeat(64),
            shape: [3, 20, 100],
            label_ids: [1],
            parent_id: null,
            measurement_channels: [
              { index: 0, name: "Raw 1", basis: "raw-source-channel-values" },
            ],
            derived_measurement_arrays: null,
          });
        if (operation === "correct_result")
          return Promise.resolve({ result: child, measurements: [] });
        if (operation === "select_result")
          return Promise.resolve({
            result: child,
            selection: {
              id: snapshot.sources[0].id,
              revision: 1,
              data: { result_id: child.id, revision_hash: child.revision_hash },
            },
          });
        return Promise.resolve({});
      }),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Annotate", "Correction");
    await screen.findByText(/Exact label SHA-256/);
    const image = screen.getByAltText("Exact selected result revision");
    const frame = image.closest(".research-image-frame") as HTMLElement;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 200,
    } as DOMRect);
    notifyResize();
    await waitFor(() => {
      // The declared Y spacing is twice X spacing: 100 × 20 pixels are 100 × 40 physical units.
      expect(image.parentElement).toHaveStyle({ width: "190px", height: "76px" });
    });
    vi.stubGlobal("devicePixelRatio", 2);
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    await waitFor(() => expect(image.parentElement).toHaveStyle({ width: "50px", height: "20px" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 5,
      top: 62,
      width: 190,
      height: 76,
    } as DOMRect);
    fireEvent.pointerDown(image, { clientX: 100, clientY: 100 });
    expect(screen.getByLabelText("Correction drawing preview")).toHaveAttribute(
      "viewBox",
      "-0.5 -0.5 100 20",
    );
    fireEvent.click(screen.getByText("Commit brush"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith(
        "correct_result",
        expect.objectContaining({
          operations: [expect.objectContaining({ points: [{ u: 50, v: 10 }] })],
        }),
      ),
    );
  });
  it("keeps a verified 2D result on the source camera and removes it on source return", async () => {
    const active = structuredClone(snapshot);
    const source = active.sources[0];
    source.source_kind = "native";
    const planeGeometry = { axes: "YX", unit: "pixel", frame: "image",
      affine: [[1, 0, 0, 10], [0, 1, 0, 20], [0, 0, 1, 0], [0, 0, 0, 1]] };
    const result = active.results[0];
    result.source_sha256 = source.sha256;
    result.selection = { x: 10, y: 20, width: 12, height: 8, z: 0, t: 0, c: 0, level: 0 };
    result.geometry = planeGeometry;
    result.arrays = { image: { shape: [8, 12], dtype: "float64" } };
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active), execute: vi.fn(async (operation) => {
      if (operation === "result") return { measurements: [{ label: 1, centroid_index: [2.5, 3.25] }] };
      if (operation === "result_view") return { ...resultView(result, "z", 0, [8, 12]),
        image: "data:image/png;base64,result#viewer-12x8", geometry: planeGeometry };
      return {};
    }) });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    const viewer = await screen.findByLabelText("Image viewer: Specimen");
    await waitFor(() => expect(canvasContext.drawImage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const camera = viewer.getAttribute("data-camera");
    await selectHistoryResult();
    await waitFor(() => expect(viewer).toHaveAttribute("data-result-overlay", `${result.id}:${result.revision_hash}`));
    expect(viewer).toHaveAttribute("data-camera", camera);
    expect(screen.queryByAltText("Exact selected result revision")).toBeNull();
    expect(screen.getByText("Result on source · Z 1, T 1")).toBeVisible();
    await waitFor(() => expect(canvasContext.drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: "data:image/png;base64,result#viewer-12x8" }),
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)));
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(viewer).not.toHaveAttribute("data-result-overlay");
    expect(viewer).toHaveAttribute("data-camera", camera);
  });
  it("keeps the same source canvas and camera while a new exact 2D correction plane loads", async () => {
    const active = structuredClone(snapshot);
    const source = active.sources[0];
    source.source_kind = "native";
    const planeGeometry = { axes: "YX", unit: "pixel", frame: "image",
      affine: [[1, 0, 0, 10], [0, 1, 0, 20], [0, 0, 1, 0], [0, 0, 0, 1]] };
    const original = active.results[0];
    original.source_sha256 = source.sha256;
    original.selection = { x: 10, y: 20, width: 12, height: 8, z: 0, t: 0, c: 0, level: 0 };
    original.geometry = planeGeometry;
    original.arrays = { image: { shape: [8, 12], dtype: "float64" } };
    const child = {
      ...structuredClone(original),
      id: "e".repeat(32),
      kind: "corrected-labels",
      revision_hash: "f".repeat(64),
      parent_id: original.id,
      review: null,
    };
    active.results.push(child);
    let resolveChild!: (value: unknown) => void;
    const childView = new Promise((resolve) => { resolveChild = resolve; });
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active), execute: vi.fn(
      (operation: string, request: Record<string, unknown>) => {
        const target = request.result_id === child.id ? child : original;
        if (operation === "result") return Promise.resolve({ measurements: [] });
        if (operation === "result_view") {
          if (target.id === child.id) return childView;
          return Promise.resolve({ ...resultView(target, "z", 0, [8, 12]),
            image: "data:image/png;base64,original#viewer-12x8", geometry: planeGeometry });
        }
        if (operation === "correction_info") return Promise.resolve({
          result_id: target.id,
          revision_hash: target.revision_hash,
          label_sha256: "1".repeat(64),
          shape: [8, 12],
          label_ids: [1],
          parent_id: target.parent_id ?? null,
          measurement_channels: [{ index: 0, name: "Raw 1", basis: "raw-source-channel-values" }],
          derived_measurement_arrays: null,
        });
        return Promise.resolve({});
      }),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    const viewer = await screen.findByLabelText("Image viewer: Specimen");
    await selectHistoryResult();
    await waitFor(() => expect(viewer).toHaveAttribute("data-result-overlay",
      `${original.id}:${original.revision_hash}`));
    await openTool("Annotate", "Correction");
    await screen.findByText(/Exact label SHA-256/);
    await waitFor(() => expect(viewer).toHaveAttribute("data-result-overlay",
      `${original.id}:${original.revision_hash}`));
    const canvas = screen.getByLabelText("Source image and bound annotations");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const camera = viewer.getAttribute("data-camera");

    fireEvent.click(screen.getByRole("button", { name: /corrected-labels/ }));
    expect(await screen.findByText("Loading result…")).toBeVisible();
    expect(screen.getByLabelText("Image viewer: Specimen")).toBe(viewer);
    expect(screen.getByLabelText("Source image and bound annotations")).toBe(canvas);
    expect(viewer).toHaveAttribute("data-camera", camera);
    expect(viewer).not.toHaveAttribute("data-result-overlay");
    expect(screen.queryByAltText("Exact selected result revision")).not.toBeInTheDocument();

    resolveChild({ ...resultView(child, "z", 0, [8, 12]),
      image: "data:image/png;base64,child#viewer-12x8", geometry: planeGeometry });
    await waitFor(() => expect(viewer).toHaveAttribute("data-result-overlay",
      `${child.id}:${child.revision_hash}`));
    expect(screen.getByLabelText("Image viewer: Specimen")).toBe(viewer);
    expect(screen.getByLabelText("Source image and bound annotations")).toBe(canvas);
    expect(viewer).toHaveAttribute("data-camera", camera);
    expect(screen.queryByText("Loading result…")).not.toBeInTheDocument();
  });
  it("shows correction binding failures and clears an in-progress draft when the source changes", async () => {
    const second = structuredClone(snapshot.sources[0]);
    second.id = "f".repeat(32);
    second.name = "Other";
    const changed = structuredClone(snapshot);
    changed.sources.push(second);
    const bridge = api({
      getSnapshot: vi.fn().mockResolvedValue(changed),
      execute: vi.fn((operation: string, request: Record<string, unknown>) => {
        if (operation === "view")
          return Promise.resolve({ image: "data:image/png;base64,view" });
        if (operation === "result")
          return Promise.resolve({ measurements: [] });
        if (operation === "result_view")
          return Promise.resolve(
            resultView(
              snapshot.results[0],
              (request.axis as "x" | "y" | "z") ?? "z",
              Number(request.index ?? 1),
            ),
          );
        if (operation === "correction_info")
          return Promise.reject(new Error("Exact revision is stale"));
        return Promise.resolve({});
      }),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Annotate", "Correction");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Exact revision is stale",
    );
    fireEvent.click(screen.getByText("Other"));
    expect(
      await screen.findByText("Select an exact segmented result first."),
    ).toBeVisible();
  });
  it("persists immutable undo and redo selections with advancing cursor revisions", async () => {
    const revised = structuredClone(snapshot);
    revised.results.push({
      id: "e".repeat(32),
      source_id: "a".repeat(32),
      kind: "corrected-labels",
      created_at: "later",
      revision_hash: "f".repeat(64),
      object_count: 1,
      parent_id: "c".repeat(32),
    });
    revised.selections = [
      {
        id: "a".repeat(32),
        revision: 2,
        data: { result_id: "e".repeat(32), revision_hash: "f".repeat(64) },
      },
    ];
    let currentSnapshot = revised;
    const bridge = api({
      getSnapshot: vi.fn(() => Promise.resolve(currentSnapshot)),
      execute: vi.fn((operation: string, request: Record<string, unknown>) => {
        if (operation === "view")
          return Promise.resolve({ image: "data:image/png;base64,view" });
        if (operation === "result")
          return Promise.resolve({ measurements: [] });
        const target = revised.results.find(
          (item) => item.id === request.result_id,
        );
        if (operation === "result_view" && target)
          return Promise.resolve({
            ...resultView(
              target,
              (request.axis as "x" | "y" | "z") ?? "z",
              Number(request.index ?? 0),
            ),
          });
        if (operation === "correction_info" && target)
          return Promise.resolve({
            result_id: target.id,
            revision_hash: target.revision_hash,
            label_sha256: "1".repeat(64),
            shape: [3, 48, 64],
            label_ids: [1],
            parent_id: target.parent_id ?? null,
            measurement_channels: [
              { index: 0, name: "Raw 1", basis: "raw-source-channel-values" },
            ],
            derived_measurement_arrays: null,
          });
        if (operation === "select_result" && target) {
          const prior = currentSnapshot.selections[0];
          const selection = {
            id: revised.sources[0].id,
            revision: prior.revision + 1,
            data: { result_id: target.id, revision_hash: target.revision_hash },
          };
          currentSnapshot = { ...currentSnapshot, selections: [selection] };
          return Promise.resolve({ result: target, selection });
        }
        return Promise.resolve({});
      }),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await selectHistoryResult(/corrected-labels/);
    await openTool("Annotate", "Correction");
    fireEvent.click(await screen.findByText("Undo revision"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith("select_result", {
        result_id: "c".repeat(32),
        revision_hash: "d".repeat(64),
        expected_revision: 2,
      }),
    );
    fireEvent.click(await screen.findByText("Redo revision"));
    await waitFor(() =>
      expect(bridge.execute).toHaveBeenCalledWith("select_result", {
        result_id: "e".repeat(32),
        revision_hash: "f".repeat(64),
        expected_revision: 3,
      }),
    );
  });

  it("opens an exact temporal frame from another source without leaving source and result state split", async () => {
    const secondSource = {
      ...snapshot.sources[0],
      id: "7".repeat(32),
      name: "Later frame",
      sha256: "8".repeat(64),
    };
    const first = {
      ...snapshot.results[0],
      arrays: {
        image: { shape: [3, 48, 64], dtype: "float64" },
        labels: { shape: [3, 48, 64], dtype: "uint32" },
      },
    };
    const second = {
      ...first,
      id: "9".repeat(32),
      source_id: secondSource.id,
      revision_hash: "a".repeat(64),
    };
    const changed: ResearchSnapshot = {
      ...snapshot,
      sources: [snapshot.sources[0], secondSource],
      results: [first, second],
    };
    const execute = vi.fn((operation: string, request: Record<string, unknown>) => {
      if (operation === "view")
        return Promise.resolve({ image: "data:image/png;base64,source" });
      if (operation === "result") return Promise.resolve({ measurements: [] });
      if (operation === "result_view") {
        const target = changed.results.find((item) => item.id === request.result_id)!;
        return Promise.resolve(resultView(target));
      }
      return Promise.resolve({});
    });
    render(
      <ResearchWorkbench
        api={api({ getSnapshot: vi.fn().mockResolvedValue(changed), execute })}
        onBack={vi.fn()}
      />,
    );
    await openTool("Analyze", "Temporal");
    fireEvent.click(screen.getAllByText("Open")[1]);
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "result_view",
        expect.objectContaining({ result_id: second.id, axis: "z", labels: true }),
      ),
    );
    expect(await screen.findByAltText("Exact selected result revision")).toBeVisible();
    expect(screen.getByRole("button", { name: /Later frame/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Later frame");
  });

  it("renders the modern Job Center with status, progress, and cancellation", async () => {
    const cancelJob = vi.fn().mockResolvedValue({});
    const jobsSnapshot: ResearchSnapshot = {
      ...snapshot,
      jobs: [
        {
          id: "job-running-12345678",
          operation: "run_recipe",
          request: {},
          request_key: "key-1",
          request_hash: "hash-1",
          state: "running",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          progress: 0.65,
          cancel_requested: false,
          result_ids: [],
          error: null,
        },
        {
          id: "job-completed-abcdef01",
          operation: "classical_run",
          request: {},
          request_key: "key-2",
          request_hash: "hash-2",
          state: "succeeded",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          progress: 1,
          cancel_requested: false,
          result_ids: ["res-1"],
          error: null,
        },
      ],
    };
    render(
      <ResearchWorkbench
        api={api({ getSnapshot: vi.fn().mockResolvedValue(jobsSnapshot), cancelJob })}
        onBack={vi.fn()}
      />,
    );
    // Active jobs badge is rendered in the footer
    const jobsTrigger = await screen.findByRole("button", { name: /Jobs/ });
    expect(jobsTrigger).toHaveTextContent("1");

    // Open Job Center
    fireEvent.click(jobsTrigger);
    const jobCenter = await screen.findByRole("region", { name: "Job center" });
    expect(jobCenter).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Job Center" })).toBeInTheDocument();

    // Check operation labels and short IDs
    expect(screen.getByText("Analysis")).toBeInTheDocument();
    expect(screen.getByText("Classical segmentation")).toBeInTheDocument();
    expect(screen.getByText("#job-runn")).toBeInTheDocument();
    expect(screen.getByText("#job-comp")).toBeInTheDocument();

    // Check progress bar for running job
    expect(screen.getByText("65%")).toBeInTheDocument();
    const progressBar = screen.getByRole("progressbar");
    expect(progressBar).toHaveAttribute("aria-valuenow", "65");

    // Cancel the running job
    const cancelButton = screen.getByRole("button", { name: /Cancel/ });
    fireEvent.click(cancelButton);
    expect(cancelJob).toHaveBeenCalledWith("job-running-12345678");

    // Close Job Center
    fireEvent.click(screen.getByRole("button", { name: "Close Job Center" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Job center" })).not.toBeInTheDocument());
  });
});
