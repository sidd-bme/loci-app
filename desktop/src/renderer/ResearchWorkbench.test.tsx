// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerRequestQueue } from "../main/viewer-request-queue";
import ResearchWorkbench from "./ResearchWorkbench";
import { dispatchWorkbenchCommand } from "./workbench-commands";
import { FIRST_STUDY_SOURCE_SHA256 } from "./first-study-display";
import type {
  ResearchBatchReceipt,
  ResearchBatchTask,
  ResearchDesktopApi,
  ResearchJob,
  ResearchSelection,
  ResearchSnapshot,
} from "../shared/research-contracts";

import type { IntensityReport, SampleSheetPreview } from "../shared/intensity-contracts";
import type { ScientificExportRequest, ScientificExportPreview } from "../shared/scientific-export-contracts";

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
function resultPage(
  request: Record<string, unknown>,
  results: ResearchSnapshot["results"],
  measurements: Array<Record<string, unknown>> = [],
) {
  const result = results.find((item) => item.id === request.result_id);
  if (!result) throw new Error("Result page mock requires an exact fixture identity");
  return { result, measurements };
}
function correctionInfo(result = snapshot.results[0]) {
  return {
    result_id: result.id,
    revision_hash: result.revision_hash,
    label_sha256: "1".repeat(64),
    shape: [3, 48, 64],
    label_ids: [1, 2],
    parent_id: null,
    measurement_channels: [{ index: 0, name: "Raw 1", basis: "raw-source-channel-values" }],
    derived_measurement_arrays: null,
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
        selection: { t: request.t ?? 0, z: request.z ?? 0, c: request.c ?? 0, z_stop: request.z_stop ?? null },
        projection: request.projection ?? null,
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
        return resultPage(request, activeSnapshot.results, [{ label: 1, area: 22 }]);
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

async function selectHistoryResult(name = /^Segmentation,/i) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return button;
}
async function openTool(
  group: "View" | "Annotate" | "Analyze" | "Results",
  tool: string,
  studySection: "samples" | "intensity" | "batch" = "batch",
  toolScope?: HTMLElement,
) {
  const tools = toolScope ? within(toolScope) : screen;
  fireEvent.click(await tools.findByRole("button", { name: group }));
  const labels: Record<string, string> = { Display: "Image & channels", Annotate: "Draw & measure", Epidermis: "Epidermal thickness", Correction: "Edit labels & ROIs",
    Analyze: "Segment & measure", Process: "Preprocess", Model: "Use a model", Quantify: "Fluorescence & field assay",
    Temporal: "Track over time", Registration: "Register & resample", Info: "Review & export", Study: "Study & batch" };
  fireEvent.click(await tools.findByRole("combobox", { name: `${group} tool` }));
  fireEvent.click(await tools.findByRole("option", { name: labels[tool] }));
  if (tool === "Study") fireEvent.click(screen.getByRole("tab", { name: { samples: "Samples", intensity: "Intensity", batch: "Batch" }[studySection] }));
  if (tool === "Study") for (const details of document.querySelectorAll<HTMLDetailsElement>("details.study-analysis-section")) {
    details.open = true; fireEvent(details, new Event("toggle"));
  }
}
async function openAdvancedTool(tool: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Search all tools" }));
  fireEvent.change(await screen.findByLabelText("Search all tools"), {
    target: { value: tool },
  });
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }));
}
describe("ResearchWorkbench", () => {
  it("keeps one complete channel editor and provides a model prerequisite route without changing scientific settings", async () => {
    const bridge = api({ importModel: vi.fn() });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await screen.findByLabelText("Image viewer: Specimen");
    expect(screen.queryByRole("group", { name: "Channel display controls" })).not.toBeInTheDocument();
    await openTool("Analyze", "Model");
    expect(await screen.findByRole("heading", { name: "No model packages in this study." })).toBeVisible();
    expect(screen.queryByLabelText("Model threshold")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import model package…" })).toBeEnabled();
    fireEvent.click(screen.getByText("Package requirements"));
    expect(screen.getByText("Model files and reference tensors must be supplied locally.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Segment & measure" }));
    expect(await screen.findByLabelText("Segmentation model")).toHaveValue("classical");
    expect(bridge.importModel).not.toHaveBeenCalled();
    expect(bridge.execute).not.toHaveBeenCalledWith("run", expect.anything());
  });

  it("opens correction prerequisites and returns to methods without executing an edit", async () => {
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue({ ...snapshot, results: [] }) });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Annotate", "Correction");
    expect(await screen.findByText("Select a segmentation result to edit its labels or ROIs.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Undo revision" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Segment & measure" }));
    expect(await screen.findByLabelText("Segmentation model")).toHaveValue("classical");
    expect(bridge.execute).not.toHaveBeenCalledWith("correction_apply", expect.anything());
  });
  function exportDraftFixture(indexed = false, excluded = false) {
    const sourceB = { ...snapshot.sources[0], id: "e".repeat(32), sha256: "f".repeat(64), name: "Second specimen" };
    const resultA = { ...snapshot.results[0], source_sha256: snapshot.sources[0].sha256, review: { disposition: "reviewed" as const } };
    const resultB = { ...resultA, id: "1".repeat(32), revision_hash: "2".repeat(64), source_id: sourceB.id, source_sha256: sourceB.sha256,
      review: { disposition: excluded ? "excluded" as const : "reviewed" as const },
      ...(indexed ? { schema: "loci.research-result/v2" as const, arrays: { image: { shape: [48, 64] } } } : {}) };
    const study = { ...snapshot, project: { ...snapshot.project, project_id: "draft-study" }, sources: [snapshot.sources[0], sourceB], results: [resultA, resultB] };
    const groups = study.results.filter((entry) => !excluded || entry.id === resultA.id).map((entry, index) => ({
      id: `group-${entry.id}`, name: `Group ${index === 0 ? "A" : "B"}`, result_id: entry.id, revision_hash: entry.revision_hash,
      source_id: entry.source_id, source_sha256: entry.source_sha256, included_count: 1,
    }));
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      const exact = study.results.find((entry) => entry.id === request.result_id) ?? resultA;
      if (operation === "view") return { image: "data:image/png;base64,view" };
      if (operation === "result") return resultPage(request, study.results, [{ label: 1, area: 22 }]);
      if (operation === "result_view") return resultView(exact);
      if (operation === "population_group_list") return { groups: groups.filter((entry) => !request.result_id || entry.result_id === request.result_id) };
      if (operation === "population_query") {
        const summary = { metric: "measure", count: 1, missing_count: 0, min: 22, max: 22, mean: 22, median: 22 };
        return { schema: "loci.population/v1", result_id: exact.id, revision_hash: exact.revision_hash, source_id: exact.source_id,
          source_sha256: exact.source_sha256, metrics: [{ id: "measure", label: "Area", kind: "area", unit: "um^2" }],
          query: { ...request, x_metric: "measure", y_metric: "measure", sort: null }, total_count: 1, filtered_count: 1,
          accounting: { filter_excluded_count: 0, filter_missing_count: 0, scatter_missing_count: 0, metric_missing_counts: { measure: 0 } },
          rows: [{ label: 1, values: { measure: 22 }, centroid_index: [2, 3], index_axes: "YX" }], selected: null,
          scatter: { points: [{ label: 1, x: 22, y: 22 }], total_count: 1, displayed_count: 1, sampled: false, sampling: "all" },
          histogram: { metric: "measure", edges: [22, 22], counts: [1], finite_count: 1, missing_count: 0, endpoints: "left-closed-right-open-last-closed" },
          summaries: { x: summary, y: summary }, membership_sha256: "4".repeat(64), query_sha256: "5".repeat(64) };
      }
      if (operation === "large_result_view") return { result_id: exact.id, revision_hash: exact.revision_hash,
        image: "data:image/png;base64,result", region: request.region, shape: [48, 64], image_shape: [48, 64], step: 1 };
      return {};
    });
    const planDataExport = vi.fn(async (request: ScientificExportRequest): Promise<ScientificExportPreview> => ({ plan_json: JSON.stringify(request), plan: {
      schema: "loci.data-export-plan/v1", plan_sha256: "3".repeat(64), request, purpose: request.purpose,
      source_count: request.bindings.length, result_count: request.bindings.length, total_count: request.bindings.length,
      selected_count: request.bindings.length, measurement_count: request.bindings.length, group_count: groups.length, membership_count: groups.length,
      declared_replicate_count: 0, unassigned_source_count: request.bindings.length, mixed_units: false, units: [],
      results: request.bindings.map((binding) => ({ result_id: binding.result_id, revision_hash: binding.revision_hash, source_id: binding.source_id,
        name: binding.result_id === resultA.id ? "Result A" : "Result B", review_status: binding.result_id === resultB.id && excluded ? "excluded" : "reviewed",
        total_count: 1, selected_count: 1, measurement_count: 1, group_count: binding.group_ids.length, preview: [] })),
    } }));
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(study), execute, planDataExport,
      exportDataPackage: vi.fn(), cancelDataExport: vi.fn().mockResolvedValue({ cancelled: true }) });
    return { bridge, study, resultA, resultB, execute, planDataExport };
  }
  const exportChoice = (name: string, value: string) => fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
  const exportPanel = () => within(screen.getByRole("region", { name: "Export scientific data" }));
  const exactExportChoices = () => within(screen.getByRole("group", { name: "Exact result revisions" }));

  it("focuses Analyze without remounting invalid input drafts or changing the image scope", async () => {
    const bridge=api();
    const {container}=render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze","Analyze");
    const threshold=screen.getByLabelText("Threshold");
    const segmentation=screen.getByLabelText("Segmentation input");
    await waitFor(()=>expect(segmentation).toBeEnabled());
    fireEvent.change(segmentation,{target:{value:"1"}});
    fireEvent.change(threshold,{target:{value:"-1.2e"}});
    const canvas=container.querySelector(".research-canvas")!;
    const viewer=container.querySelector(".image-viewport")!;
    const camera=viewer.getAttribute("data-camera");
    const toggle=screen.getByRole("button",{name:"Focus panel"});
    toggle.focus(); fireEvent.click(toggle);
    expect(screen.getByRole("button",{name:"Show image"})).toBe(toggle);
    expect(toggle).toHaveFocus(); expect(toggle).toHaveAttribute("aria-pressed","true");
    expect(canvas).toHaveAttribute("hidden");
    expect(screen.getByLabelText("Threshold")).toBe(threshold);
    expect(threshold).toHaveValue("-1.2e");
    expect(segmentation).toHaveValue("1");
    expect(screen.getByRole("button",{name:"Run recipe"})).toBeDisabled();
    fireEvent.click(toggle);
    expect(canvas).not.toHaveAttribute("hidden");
    expect(container.querySelector(".image-viewport")).toBe(viewer);
    expect(viewer).toHaveAttribute("data-camera",camera);
    expect(threshold).toHaveValue("-1.2e");
    fireEvent.click(toggle);
    await openTool("View","Display");
    expect(canvas).not.toHaveAttribute("hidden");
    expect(screen.queryByRole("button",{name:"Show image"})).not.toBeInTheDocument();
    await openTool("Analyze","Analyze");
    expect(screen.getByRole("button",{name:"Focus panel"})).toHaveAttribute("aria-pressed","false");
    expect(bridge.execute).not.toHaveBeenCalledWith("run_recipe",expect.anything());
    expect(bridge.reviewResult).not.toHaveBeenCalled(); expect(bridge.exportResult).not.toHaveBeenCalled();
  });

  it("preserves the active analysis owner and exact request while focusing and returning", async () => {
    const bridge=api(); const original=bridge.execute;
    let finishRun!:()=>void;
    bridge.execute=vi.fn(async(operation,request,options)=>{
      if(operation==="run_recipe") return new Promise(resolve=>{finishRun=()=>resolve({});});
      return original(operation,request,options);
    });
    const {container}=render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze","Analyze");
    const segmentation=screen.getByLabelText("Segmentation input");
    await waitFor(()=>expect(segmentation).toBeEnabled());
    fireEvent.change(segmentation,{target:{value:"1"}});
    fireEvent.click(screen.getByRole("button",{name:"Run recipe"}));
    await waitFor(()=>expect(finishRun).toBeDefined());
    const request=vi.mocked(bridge.execute).mock.calls.find(([operation])=>operation==="run_recipe")![1];
    fireEvent.click(screen.getByRole("button",{name:"Focus panel"}));
    expect(container.querySelector(".research-canvas")).toHaveAttribute("hidden");
    expect(screen.getByLabelText("Segmentation input")).toBe(segmentation);
    expect(segmentation).toBeDisabled(); expect(segmentation).toHaveValue("1");
    expect(screen.getByRole("button",{name:"Running…"})).toBeDisabled();
    fireEvent.click(screen.getByRole("button",{name:"Show image"}));
    expect(segmentation).toBeDisabled();
    expect(vi.mocked(bridge.execute).mock.calls.filter(([operation])=>operation==="run_recipe")).toHaveLength(1);
    expect(request).toEqual(expect.objectContaining({source_id:snapshot.sources[0].id,selection:expect.objectContaining({c:1,t:0,z:1})}));
    await act(async()=>finishRun());
    await waitFor(()=>expect(screen.getByRole("button",{name:"Run recipe"})).toBeEnabled());
  });

  it("focuses Review and Export without replacing rows, draft controls or a prepared exact plan", async () => {
    const {bridge,resultA,planDataExport}=exportDraftFixture();
    const {container}=render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await selectHistoryResult(); await openTool("Results","Info");
    const review=screen.getByRole("region",{name:"Review result"});
    const canvas=container.querySelector(".research-canvas")!;
    const viewer=screen.getByAltText("Exact selected result revision");
    const imageStyle=viewer.parentElement!.getAttribute("style");
    const frame=container.querySelector(".research-image-frame")!;
    const position=[frame.scrollLeft,frame.scrollTop];
    fireEvent.click(screen.getByRole("button",{name:"Focus panel"}));
    expect(screen.getByRole("region",{name:"Review result"})).toBe(review);
    expect(screen.getByText("Quantitative summary")).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Show image"}));
    fireEvent.click(screen.getByRole("button",{name:"Export"}));
    exportChoice("Data export purpose","provisional");
    const purpose=screen.getByLabelText("Data export purpose");
    fireEvent.click(exportPanel().getByRole("button",{name:"Preview data"}));
    await waitFor(()=>expect(exportPanel().getByRole("button",{name:"Export data package…"})).toBeEnabled());
    const prepared=exportPanel().getByRole("heading",{name:"Prepared scope"});
    const bindings=exportPanel().getByLabelText("Exact prepared export bindings").textContent;
    fireEvent.click(screen.getByRole("button",{name:"Focus panel"}));
    expect(screen.getByLabelText("Data export purpose")).toBe(purpose);
    expect(purpose).toHaveValue("provisional");
    expect(exportPanel().getByRole("heading",{name:"Prepared scope"})).toBe(prepared);
    expect(exportPanel().getByLabelText("Exact prepared export bindings")).toHaveTextContent(resultA.revision_hash);
    expect(canvas).toHaveAttribute("hidden");
    fireEvent.click(screen.getByRole("button",{name:"Show image"}));
    expect(exportPanel().getByRole("heading",{name:"Prepared scope"})).toBe(prepared);
    expect(exportPanel().getByLabelText("Exact prepared export bindings").textContent).toBe(bindings);
    expect(exportPanel().getByRole("button",{name:"Export data package…"})).toBeEnabled();
    expect(screen.getByAltText("Exact selected result revision")).toBe(viewer);
    expect(viewer.parentElement).toHaveAttribute("style",imageStyle);
    expect([frame.scrollLeft,frame.scrollTop]).toEqual(position);
    expect(canvas).not.toHaveAttribute("hidden");
    expect(planDataExport).toHaveBeenCalledOnce();
    expect(bridge.cancelDataExport).not.toHaveBeenCalled();
    expect(bridge.reviewResult).not.toHaveBeenCalled();
    expect(bridge.exportResult).not.toHaveBeenCalled();
    expect(bridge.exportDataPackage).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves export draft through cross-source inspection, null recovery and tab return (indexed %s)", async (indexed) => {
    const { bridge, resultA, resultB, planDataExport, execute } = exportDraftFixture(indexed);
    const {container}=render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await screen.findByRole("main",{name:"Research workspace"});
    // Re-resolve the export subtree after navigation/remounts and scope role
    // queries to the relevant controls instead of traversing unrelated UI.
    const inspector=within(container.querySelector<HTMLElement>(".research-inspector")!);
    const sources=within(container.querySelector<HTMLElement>(".research-sources")!);
    const exportElement=()=>container.querySelector<HTMLElement>(".research-inspector .scientific-data-export")!;
    const panel=()=>within(exportElement());
    const choices=()=>within(panel().getByRole("group",{name:"Exact result revisions"}));
    const choice=(name:string,value:string)=>fireEvent.change(panel().getByRole("combobox",{name}),{target:{value}});
    const section=(name:"Review"|"Export")=>within(inspector.getByRole("group",{name:"Result sections"})).getByRole("button",{name});
    const open=(tool:"Info"|"Display")=>{
      const toolbar=within(container.querySelector<HTMLElement>(".workbench-tools")!);
      const group=tool==="Info"?"Results":"View";
      fireEvent.click(toolbar.getByRole("button",{name:group}));
      fireEvent.click(toolbar.getByRole("combobox",{name:`${group} tool`}));
      fireEvent.click(toolbar.getByRole("option",{name:tool==="Info"?"Review & export":"Image & channels"}));
    };
    const history=await sources.findByRole("button",{name:/^Segmentation,/i});
    await waitFor(()=>expect(history).toBeEnabled());
    fireEvent.click(history);
    open("Info");
    fireEvent.click(section("Export"));
    expect(exportElement()).toHaveAccessibleName("Export scientific data");
    expect(exportElement()).toBeVisible();
    choice("Data export result scope", "study");
    fireEvent.click(choices().getAllByRole("checkbox")[1]);
    choice("Data export purpose", "provisional");
    choice("Data export object scope", "groups");
    for (const letter of ["A", "B"]) fireEvent.click(await panel().findByRole("checkbox", { name: `Group ${letter} · 1 objects` }));
    fireEvent.click(panel().getByRole("button", { name: "Preview data" }));
    await waitFor(() => expect(panel().getByRole("button", { name: "Export data package…" })).toBeEnabled());
    fireEvent.click(within(panel().getByRole("group", { name: "Exact result revisions" }).querySelector<HTMLElement>(`[data-export-result-id="${resultB.id}"][data-revision-hash="${resultB.revision_hash}"]`)!).getByRole("button", { name: /^Inspect result:/ }));
    await waitFor(() => expect(document.querySelector(`[data-result-id="${resultB.id}"]`)).toHaveAttribute("aria-pressed", "true"));
    expect(document.querySelector(`[data-result-id="${resultA.id}"]`)).toBeNull();
    expect(execute).toHaveBeenCalledWith("result", expect.objectContaining({ result_id: resultB.id }));
    const assertDraft = async () => {
      const currentPanel=panel();
      expect(exportElement()).toHaveAccessibleName("Export scientific data");
      expect(exportElement()).toBeVisible();
      expect(currentPanel.getByRole("combobox", { name: "Data export result scope" })).toHaveValue("study");
      expect(currentPanel.getByRole("combobox", { name: "Data export purpose" })).toHaveValue("provisional");
      expect(currentPanel.getByRole("combobox", { name: "Data export object scope" })).toHaveValue("groups");
      for (const input of choices().getAllByRole("checkbox")) expect(input).toBeChecked();
      for (const letter of ["A", "B"]) expect(await panel().findByRole("checkbox", { name: `Group ${letter} · 1 objects` })).toBeChecked();
    };
    await assertDraft();
    if (!indexed) {
      fireEvent.click(section("Review"));
      expect(inspector.getByText("Quantitative summary")).toBeVisible();
      expect(inspector.queryByRole("region", { name: "Export scientific data" })).not.toBeInTheDocument();
      fireEvent.click(section("Export"));
      await assertDraft();
    }
    expect(panel().getByRole("button", { name: "Export data package…" })).toBeDisabled();
    fireEvent.click(sources.getByRole("button", { name: "Original image" }));
    await inspector.findByRole("group", { name: "Results on this image" });
    await assertDraft();
    fireEvent.click(inspector.getByRole("button", { name: `Select rev ${resultB.revision_hash.slice(0, 8)}` }));
    await waitFor(() => expect(document.querySelector(`[data-result-id="${resultB.id}"]`)).toHaveAttribute("aria-pressed", "true"));
    await assertDraft();
    fireEvent.click(panel().getByRole("button", { name: "Preview data" }));
    await waitFor(() => expect(panel().getByRole("button", { name: "Export data package…" })).toBeEnabled());
    expect(planDataExport.mock.calls.at(-1)![0]).toEqual({ purpose: "provisional", bindings: [resultA, resultB].map((entry) => ({
      result_id: entry.id, revision_hash: entry.revision_hash, source_id: entry.source_id, source_sha256: entry.source_sha256,
      subset: "groups", group_ids: [`group-${entry.id}`],
    })) });
    open("Display");
    open("Info");
    await assertDraft();
    expect(panel().getByRole("button", { name: "Export data package…" })).toBeDisabled();
    expect(bridge.reviewResult).not.toHaveBeenCalled();
    expect(bridge.exportDataPackage).not.toHaveBeenCalled();
  });

  it("withholds the old quantitative preview while loading another exact revision", async () => {
    const active = structuredClone(snapshot);
    const second = { ...active.results[0], id: "9".repeat(32), revision_hash: "0".repeat(64), object_count: 9 };
    active.results.push(second);
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active) });
    const original = bridge.execute;
    let releaseRows!: () => void;
    bridge.execute = vi.fn(async (operation, request, options) => {
      if (operation === "result" && request.result_id === second.id) return new Promise((resolve) => {
        releaseRows = () => resolve({ result: second, measurements: [{ label: 9, measure: 99, measure_kind: "area", measure_unit: "µm²" }] });
      });
      if (operation === "result_view" && request.result_id === second.id) return resultView(second);
      return original(operation, request, options);
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await selectHistoryResult(/^Segmentation, 1 object,/i);
    await openTool("Results", "Info");
    expect(screen.getByText("Quantitative summary")).toBeVisible();
    fireEvent.click(document.querySelector<HTMLButtonElement>(`button[data-result-id="${second.id}"]`)!);
    await waitFor(() => expect(releaseRows).toBeDefined());
    expect(screen.queryByText("Quantitative summary")).not.toBeInTheDocument();
    const review=within(screen.getByRole("region", { name: "Review result" }));
    expect(within(review.getByText("Technical identity").closest("details")!).getByText(second.revision_hash)).toBeInTheDocument();
    await act(async () => releaseRows());
    expect(await screen.findByText("Quantitative summary")).toBeVisible();
    expect(screen.getByText(/first 1 of 9 objects/)).toBeVisible();
    expect(screen.getByText("Mean Area")).toBeVisible();
    expect(screen.getByText("99", { selector: ".research-stat-value" })).toBeVisible();
  });

  it("retains export choices after a failed preview, retries exact bindings and returns new history selections to Review", async () => {
    const { bridge, resultA, resultB, planDataExport } = exportDraftFixture();
    planDataExport.mockRejectedValueOnce(new Error("Synthetic preview unavailable"));
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Results", "Info");
    expect(screen.getByText("Quantitative summary")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Export scientific data" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    exportChoice("Data export result scope", "study");
    fireEvent.click(exactExportChoices().getAllByRole("checkbox")[1]);
    exportChoice("Data export purpose", "provisional");
    fireEvent.click(exportPanel().getByRole("button", { name: "Preview data" }));
    expect(await exportPanel().findByRole("alert")).toHaveTextContent("Synthetic preview unavailable");
    expect(screen.getByRole("combobox", { name: "Data export purpose" })).toHaveValue("provisional");
    fireEvent.click(exportPanel().getByRole("button", { name: "Preview data" }));
    await waitFor(() => expect(exportPanel().getByRole("button", { name: "Export data package…" })).toBeEnabled());
    expect(planDataExport).toHaveBeenLastCalledWith({ purpose: "provisional", bindings: [resultA, resultB].map((entry) => ({
      result_id: entry.id, revision_hash: entry.revision_hash, source_id: entry.source_id, source_sha256: entry.source_sha256,
      subset: "all", group_ids: [],
    })) }, expect.any(String));
    // A direct history selection is a new review task, even after preparing an export.
    fireEvent.click(document.querySelector<HTMLButtonElement>(`button[data-result-id="${resultA.id}"]`)!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByText("Quantitative summary")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.getByRole("combobox", { name: "Data export purpose" })).toHaveValue("provisional");
    expect(exportPanel().getByRole("button", { name: "Export data package…" })).toBeDisabled();
    expect(bridge.reviewResult).not.toHaveBeenCalled();
    expect(bridge.exportDataPackage).not.toHaveBeenCalled();
  });

  it("keeps excluded review state during explicit provisional recovery and group creation navigation", async () => {
    const { bridge, resultB, study } = exportDraftFixture(false, true);
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Results", "Info");
    if (screen.queryByRole("button", { name: "Export" })) fireEvent.click(screen.getByRole("button", { name: "Export" }));
    exportChoice("Data export result scope", "study");
    fireEvent.click(exactExportChoices().getAllByRole("checkbox")[1]);
    fireEvent.click(exportPanel().getByRole("button", { name: "Preview data" }));
    await exportPanel().findByRole("alert");
    expect(exportPanel().getByRole("button", { name: /^Inspect unreviewed result: Second specimen/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Inspect pending/ })).not.toBeInTheDocument();
    fireEvent.click(exportPanel().getByRole("button", { name: "Use Provisional data for review" }));
    fireEvent.click(exportPanel().getByRole("button", { name: "Preview data" }));
    await waitFor(() => expect(exportPanel().getByRole("button", { name: "Export data package…" })).toBeEnabled());
    expect(exportPanel().getByRole("heading", { name: "Result B · excluded" })).toBeVisible();
    expect(bridge.planDataExport).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: "provisional" }), expect.any(String));
    expect(bridge.reviewResult).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("group", { name: "Exact result revisions" }).querySelector<HTMLElement>(`[data-export-result-id="${resultB.id}"][data-revision-hash="${resultB.revision_hash}"]`)!).getByRole("button", { name: /^Inspect result:/ }));
    await waitFor(() => expect(document.querySelector(`[data-result-id="${resultB.id}"]`)).toHaveAttribute("aria-pressed", "true"));
    exportChoice("Data export object scope", "groups");
    fireEvent.click(await exportPanel().findByRole("checkbox", { name: "Group A · 1 objects" }));
    fireEvent.click(await exportPanel().findByRole("button", { name: "Create group in Statistics & objects" }));
    await screen.findByRole("table", { name: "Population object table" });
    fireEvent.click(screen.getByRole("button", { name: "Review & export result" }));
    expect(screen.getByRole("combobox", { name: "Data export result scope" })).toHaveValue("study");
    expect(screen.getByRole("combobox", { name: "Data export purpose" })).toHaveValue("provisional");
    expect(screen.getByRole("combobox", { name: "Data export object scope" })).toHaveValue("groups");
    for (const input of exactExportChoices().getAllByRole("checkbox")) expect(input).toBeChecked();
    expect(await exportPanel().findByRole("checkbox", { name: "Group A · 1 objects" })).toBeChecked();
    expect(await exportPanel().findByRole("button", { name: "Create group in Statistics & objects" })).toBeEnabled();
    expect(study.results[1].review?.disposition).toBe("excluded");
    expect(bridge.reviewResult).not.toHaveBeenCalled();
  });

  it("navigates Samples to an explicit cross-source revision, preserves CSV drafts, and invalidates Apply after metadata changes", async () => {
    const first = { ...snapshot.results[0], source_sha256: snapshot.sources[0].sha256 };
    const secondSource = { ...snapshot.sources[0], id: "7".repeat(32), sha256: "8".repeat(64), name: "Second specimen" };
    const parent = { ...first, id: "1".repeat(32), revision_hash: "2".repeat(64), source_id: secondSource.id,
      source_sha256: secondSource.sha256, created_at: "2026-10-22T00:00:00Z", review: { disposition: "reviewed" } };
    const child = { ...parent, id: "3".repeat(32), revision_hash: "4".repeat(64), parent_id: parent.id,
      kind: "corrected-labels", review: { disposition: "pending" } };
    const initialSample = { study: "Study", sample: "Field B", condition: "Control", biological_replicate: "R1" };
    let current: ResearchSnapshot = { ...snapshot, project: { project_id: "9".repeat(32), title: "Study" },
      sources: [...snapshot.sources, secondSource], results: [first, parent, child],
      samples: [{ id: secondSource.id, revision: 1, data: initialSample }] };
    const csv = `source_id,study,sample,condition\n${secondSource.id},Study,Field B,Treatment\n`;
    const preview: SampleSheetPreview = { schema: "loci.sample-sheet-preview/v1", study_id: current.project.project_id!, csv_text: csv,
      preview_sha256: "a".repeat(64), bindings: {}, errors: [], can_apply: true,
      rows: [{ row_number: 2, source_id: secondSource.id, before: initialSample, after: { ...initialSample, condition: "Treatment" }, match: "matched", issues: [] }] };
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      if (operation === "view") return { image: "data:image/png;base64,view" };
      if (operation === "sample_sheet_preview") return preview;
      if (operation === "result") return resultPage(request, current.results);
      if (operation === "result_view") return resultView(current.results.find((row) => row.id === request.result_id)!);
      if (operation === "sample") {
        current = { ...current, samples: [{ id: secondSource.id, revision: 2, data: request.data as typeof initialSample }] };
        return {};
      }
      return {};
    });
    const bridge = api({ getSnapshot: vi.fn(async () => current), execute });
    const { container } = render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Results", "Study", "samples");
    const editor = screen.getByRole("textbox", { name: "Sample sheet CSV" });
    fireEvent.change(editor, { target: { value: csv } });
    fireEvent.click(screen.getByRole("button", { name: "Preview sample sheet" }));
    await screen.findByRole("region", { name: "Sample sheet before and after" });
    expect(screen.getByRole("button", { name: /^Apply (?:sample sheet|to \d+ images)$/ })).toBeEnabled();
    const sourceRow = container.querySelector<HTMLTableRowElement>(`tr[data-source-id="${secondSource.id}"]`)!;
    const resultDetails = within(sourceRow).getByText("Results (2)").closest("details")!;
    resultDetails.open = true; fireEvent(resultDetails, new Event("toggle"));
    const target = sourceRow.querySelector<HTMLElement>(`li[data-result-id="${child.id}"]`)!;
    fireEvent.click(within(target).getByRole("button", { name: "Inspect result" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("result", expect.objectContaining({ result_id: child.id })));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("result_view", expect.objectContaining({ result_id: child.id })));
    expect(screen.getByLabelText("Active image")).toHaveTextContent(secondSource.name);
    await waitFor(() => expect(container.querySelector(`button[data-result-id="${child.id}"]`)).toHaveAttribute("aria-pressed", "true"));
    expect(execute).not.toHaveBeenCalledWith("result", expect.objectContaining({ result_id: parent.id }));
    expect(bridge.reviewResult).not.toHaveBeenCalled();
    for (const operation of ["sample", "run_recipe", "sample_sheet_apply", "intensity_preview", "intensity_save", "study_correction_effect"])
      expect(execute.mock.calls.map(([name]) => name)).not.toContain(operation);
    await openTool("Results", "Study", "samples");
    expect(screen.getByRole("textbox", { name: "Sample sheet CSV" })).toBe(editor); expect(editor).toHaveValue(csv);
    expect(screen.getByRole("button", { name: /^Apply (?:sample sheet|to \d+ images)$/ })).toBeEnabled();
    fireEvent.click(within(sourceRow).getByRole("button", { name: "Edit metadata" }));
    expect(await screen.findByText("Select a result to review and export its measurements.")).toBeVisible();
    screen.getByText("Study metadata", { exact: true }).closest("details")!.open = true;
    fireEvent.change(screen.getByRole("textbox", { name: "condition" }), { target: { value: "Updated condition" } });
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("sample", expect.objectContaining({
      id: secondSource.id, source_id: secondSource.id, expected_revision: 1,
    })));
    await openTool("Results", "Study", "samples");
    expect(editor).toHaveValue(csv);
    expect(screen.getByRole("button", { name: /^Apply (?:sample sheet|to \d+ images)$/ })).toBeDisabled();
    expect(screen.getByText(/CSV or study metadata changed/)).toBeVisible();
  });

  it("rejects a Samples revision removed while its cross-source display is still loading", async () => {
    const first = { ...snapshot.results[0], source_sha256: snapshot.sources[0].sha256 };
    const secondSource = { ...snapshot.sources[0], id: "7".repeat(32), sha256: "8".repeat(64), name: "Deferred specimen" };
    const target = { ...first, id: "1".repeat(32), revision_hash: "2".repeat(64), source_id: secondSource.id,
      source_sha256: secondSource.sha256 };
    let current = { ...snapshot, sources: [...snapshot.sources, secondSource], results: [first, target] };
    let releaseDefaults!: () => void;
    const pendingDefaults = new Promise<void>((resolve) => { releaseDefaults = resolve; });
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      if (operation === "view") return { image: "data:image/png;base64,view" };
      if (operation === "result") return resultPage(request, current.results);
      if (operation === "result_view") return resultView(current.results.find((row) => row.id === request.result_id)!);
      if (operation === "sample") { current = { ...current, results: [first] }; return {}; }
      return {};
    });
    const bridge = api({ getSnapshot: vi.fn(async () => current), execute });
    const ordinaryExecute = bridge.execute;
    bridge.execute = vi.fn(async (operation, request) => {
      if (operation === "viewer_defaults" && request.source_id === secondSource.id) await pendingDefaults;
      return ordinaryExecute(operation, request);
    });
    const { container } = render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Results", "Study", "samples");
    const row = container.querySelector<HTMLTableRowElement>(`tr[data-source-id="${secondSource.id}"]`)!;
    const details = within(row).getByText("Results (1)").closest("details")!; details.open = true; fireEvent(details, new Event("toggle"));
    fireEvent.click(within(row).getByRole("button", { name: "Inspect result" }));
    await waitFor(() => expect(screen.getByLabelText("Active image")).toHaveTextContent(secondSource.name));
    expect(execute).not.toHaveBeenCalledWith("result", expect.objectContaining({ result_id: target.id }));
    screen.getByText("Study metadata", { exact: true }).closest("details")!.open = true;
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This exact result revision is no longer available");
    await act(async () => releaseDefaults());
    await waitFor(() => expect(screen.getByLabelText(`Image viewer: ${secondSource.name}`)).toHaveAttribute("data-prepared", "true"));
    expect(execute).not.toHaveBeenCalledWith("result", expect.objectContaining({ result_id: target.id }));
    expect(execute).not.toHaveBeenCalledWith("result_view", expect.objectContaining({ result_id: target.id }));
    await openTool("Results", "Study", "samples");
    expect(within(container.querySelector<HTMLTableRowElement>(`tr[data-source-id="${secondSource.id}"]`)!).getByText("No results")).toBeVisible();
  });

  it("cancels an abandoned Samples navigation and keeps ordinary exact export inspection working", async () => {
    const { bridge, study, resultA, resultB, execute } = exportDraftFixture();
    let releaseDefaults!: () => void;
    const pendingDefaults = new Promise<void>((resolve) => { releaseDefaults = resolve; });
    const ordinaryExecute = bridge.execute;
    bridge.execute = vi.fn(async (operation, request) => {
      if (operation === "viewer_defaults" && request.source_id === resultB.source_id) await pendingDefaults;
      return ordinaryExecute(operation, request);
    });
    const { container } = render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Results", "Study", "samples");
    const row = container.querySelector<HTMLTableRowElement>(`tr[data-source-id="${resultB.source_id}"]`)!;
    const details = within(row).getByText("Results (1)").closest("details")!; details.open = true; fireEvent(details, new Event("toggle"));
    fireEvent.click(within(row).getByRole("button", { name: "Inspect result" }));
    await waitFor(() => expect(screen.getByLabelText("Active image")).toHaveTextContent("Second specimen"));
    await openTool("View", "Display");
    await act(async () => releaseDefaults());
    await waitFor(() => expect(screen.getByLabelText("Image viewer: Second specimen")).toHaveAttribute("data-prepared", "true"));
    expect(execute).not.toHaveBeenCalledWith("result", expect.objectContaining({ result_id: resultB.id }));
    fireEvent.click(container.querySelector<HTMLButtonElement>(`button[data-source-id="${study.sources[0].id}"]`)!);
    await selectHistoryResult();
    await openTool("Results", "Info");
    if (screen.queryByRole("button", { name: "Export" })) fireEvent.click(screen.getByRole("button", { name: "Export" }));
    exportChoice("Data export result scope", "study");
    fireEvent.click(await exportPanel().findByRole("button", { name: /^Inspect result: Second specimen/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("result", expect.objectContaining({ result_id: resultB.id })));
    await waitFor(() => expect(container.querySelector(`button[data-result-id="${resultB.id}"]`)).toHaveAttribute("aria-pressed", "true"));
    expect(execute).toHaveBeenCalledWith("result", expect.objectContaining({ result_id: resultA.id }));
    expect(screen.queryByText(/The exact selected study revision changed/)).not.toBeInTheDocument();
  });

  it("gives Study distinct sections and retains drafts, linked image and focus across navigation", async () => {
    const bridge = api();
    const { container } = render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Results", "Study", "samples");
    expect(screen.getByRole("tablist", { name: "Study sections" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Corrections" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sample sheet" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Experiment intensity" })).not.toBeInTheDocument();
    const csv = screen.getByLabelText("Sample sheet CSV");
    fireEvent.change(csv, { target: { value: "source_id,study,sample,condition\na,Study,A,Control" } });
    fireEvent.click(screen.getByRole("tab", { name: "Intensity" }));
    const declaration = screen.getByRole("textbox", { name: "Shared channel declaration" });
    fireEvent.change(declaration, { target: { value: "Recorded channel draft" } });
    const canvas = container.querySelector(".research-canvas")!;
    expect(canvas).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Focus study" }));
    expect(canvas).not.toBeVisible();
    expect(screen.getByText("Linked image:", { exact: false })).toHaveTextContent("Specimen");
    expect(screen.getByRole("main", { name: "Research workspace" })).toHaveClass("is-study-focused");
    fireEvent.click(screen.getByRole("tab", { name: "Batch" }));
    fireEvent.change(screen.getByLabelText("Study recipe name"), { target: { value: "Batch draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Show image" }));
    expect(container.querySelector(".research-canvas")).toBe(canvas);
    expect(canvas).toBeVisible();
    await openTool("View", "Display");
    await openTool("Results", "Study", "intensity");
    expect(screen.getByRole("textbox", { name: "Shared channel declaration" })).toBe(declaration);
    expect(declaration).toHaveValue("Recorded channel draft");
    fireEvent.click(screen.getByRole("tab", { name: "Samples" }));
    expect(screen.getByLabelText("Sample sheet CSV")).toBe(csv);
    expect(csv).toHaveValue("source_id,study,sample,condition\na,Study,A,Control");
    fireEvent.click(screen.getByRole("tab", { name: "Batch" }));
    expect(screen.getByLabelText("Study recipe name")).toHaveValue("Batch draft");
    expect(bridge.submitBatch).not.toHaveBeenCalled();
    expect(bridge.reviewResult).not.toHaveBeenCalled();
    const operations = vi.mocked(bridge.execute).mock.calls.map(([operation]) => operation);
    for (const operation of ["run_recipe", "sample_sheet_apply", "intensity_preview", "intensity_save", "study_correction_effect"])
      expect(operations).not.toContain(operation);
  });

  it("opens the intensity section with the exact reviewed revision from Review & export", async () => {
    const result = { ...snapshot.results[0], source_sha256: snapshot.sources[0].sha256, review: { disposition: "reviewed" as const } };
    const study = { ...snapshot, results: [result] };
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      if (operation === "view") return { image: "data:image/png;base64,view" };
      if (operation === "result") return resultPage(request, study.results);
      if (operation === "result_view") return resultView(result);
      if (operation === "intensity_catalog") return { schema: "loci.experiment-intensity-catalog/v1", results: [{
        result_id: result.id, revision_hash: result.revision_hash, source_id: result.source_id, descriptors: [],
      }] };
      return {};
    });
    render(<ResearchWorkbench api={api({ getSnapshot: vi.fn().mockResolvedValue(study), execute })} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Results", "Info");
    expect(execute).not.toHaveBeenCalledWith("intensity_catalog", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Compare intensity in Study & batch" }));
    expect(screen.getByRole("tab", { name: "Intensity" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("checkbox", { name: /^Intensity result: Specimen/ })).toBeChecked();
    await waitFor(() => expect(execute).toHaveBeenCalledWith("intensity_catalog", { result_ids: [result.id] }));
    fireEvent.click(screen.getByRole("tab", { name: "Samples" }));
    expect(screen.queryByRole("region", { name: "Experiment intensity" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Intensity" }));
    expect(screen.getByRole("checkbox", { name: /^Intensity result: Specimen/ })).toBeChecked();
    expect(execute).not.toHaveBeenCalledWith("intensity_save", expect.anything());
  });

  it("retains an immutable intensity report across study sections and rechecks current inputs on return", async () => {
    const source = snapshot.sources[0];
    const result = { ...snapshot.results[0], source_sha256: source.sha256, review: { disposition: "reviewed" as const } };
    const sample = { study: "Study", sample: "Field", condition: "Control", biological_replicate: "R1", plate: null, well: null };
    const study = { ...snapshot, project: { ...snapshot.project, project_id: "1".repeat(32) }, results: [result],
      samples: [{ id: source.id, revision: 1, data: sample }] };
    const mean = -0.12345678901234568;
    const report: IntensityReport = { schema: "loci.experiment-intensity-report/v1", report_hash: "e".repeat(64),
      created_at: "2026-10-21T00:01:00Z", software: { engine: "0.2.0", implementation: { kind: "source", sha256: "7".repeat(64) } }, result_ids: [result.id],
      endpoint: { schema: "loci.intensity-endpoint/v1", kind: "raw-channel-intensity", statistic: "mean", unit: "source-intensity", compartment: "object" },
      declaration: { channel: "Declared stored channel", acquisition_context: "Recorded acquisition", rationale: "Recorded comparison rationale" },
      bindings: [{ result_id: result.id, source_id: source.id, revision_hash: result.revision_hash, source_sha256: source.sha256,
        descriptor: { id: "raw.mean", label: "Raw mean", kind: "intensity", statistic: "mean", unit: "source-intensity", channel: "Raw" }, source: { name: source.name } }],
      observations: [{ result_id: result.id, label: 1, value: mean, status: "value" }],
      images: [{ ...sample, result_id: result.id, source_id: source.id, revision_hash: result.revision_hash,
        object_count: 1, valid_object_count: 1, null_object_count: 0, missing_object_count: 0, mean, included: true, reason: "included" }],
      replicates: [{ condition: "Control", biological_replicate: "R1", mean, image_count: 1, valid_image_count: 1, object_count: 1, valid_object_count: 1 }],
      conditions: [{ condition: "Control", mean, sd: null, object_count: 1, valid_object_count: 1, image_count: 1, valid_image_count: 1,
        declared_replicate_count: 1, valid_replicate_count: 1, unassigned_image_count: 0 }],
      audit: [{ result_id: result.id, source_id: source.id, review_disposition: "reviewed", reason: "included" }], aggregation: {} };
    let inputsCurrent = true;
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      if (operation === "view") return { image: "data:image/png;base64,view" };
      if (operation === "result") return resultPage(request, study.results);
      if (operation === "result_view") return resultView(result);
      if (operation === "intensity_list") return { reports: [{ id: "e".repeat(32), created_at: report.created_at, endpoint: report.endpoint, declaration: report.declaration }] };
      if (operation === "intensity_get") return { report, report_id: "e".repeat(32), status: { current: inputsCurrent,
        changes: inputsCurrent ? [] : [{ result_id: result.id, reason: "changed: review" }] } };
      return {};
    });
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(study), execute, planIntensityExport: vi.fn() });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    const toolScope = (await screen.findByRole("navigation", { name: "Task groups" })).parentElement!;
    await openTool("Results", "Study", "intensity", toolScope);
    const intensity = within(screen.getByRole("region", { name: "Experiment intensity" }));
    const sections = within(screen.getByRole("tablist", { name: "Study sections" }));
    intensity.getByText(/Saved intensity reports \(/).closest("details")!.open = true;
    fireEvent.click(await intensity.findByRole("button", { name: /^Open saved intensity report 1: Declared stored channel/ }));
    const saved = await intensity.findByRole("region", { name: "Saved intensity report" });
    const reportQueries = within(saved);
    await reportQueries.findByText("Current inputs match this saved report.");
    fireEvent.click(sections.getByRole("tab", { name: "Samples" }));
    expect(saved).not.toBeVisible();
    const statusReads = execute.mock.calls.filter(([operation]) => operation === "intensity_get").length;
    inputsCurrent = false;
    await openTool("View", "Display", "batch", toolScope);
    expect(execute.mock.calls.filter(([operation]) => operation === "intensity_get")).toHaveLength(statusReads);
    await openTool("Results", "Study", "intensity", toolScope);
    expect(intensity.getByRole("region", { name: "Saved intensity report" })).toBe(saved);
    await reportQueries.findByText("Current inputs differ. Saved values remain unchanged.");
    const table = reportQueries.getByRole("table", { name: "Condition means · source-intensity units" });
    const exactValue = within(table).getByLabelText("Exact value");
    exactValue.closest("details")!.open = true;
    expect(exactValue).toHaveTextContent(String(mean));
    expect(exactValue).toBeVisible();
    expect(execute).not.toHaveBeenCalledWith("intensity_preview", expect.anything());
    expect(execute).not.toHaveBeenCalledWith("intensity_save", expect.anything());
    reportQueries.getByText(/Image means & inclusion reasons/).closest("details")!.open = true;
    fireEvent.click(reportQueries.getByRole("button", { name: /^Inspect result: Specimen/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("result_view", expect.objectContaining({
      result_id: result.id, labels: true,
    })));
    expect(saved).not.toBeVisible();
    await openTool("Results", "Study", "intensity", toolScope);
    expect(intensity.getByRole("region", { name: "Saved intensity report" })).toBe(saved);
    expect(bridge.reviewResult).not.toHaveBeenCalled();
  });

  it("opens Study from the selected correction and sends only its exact direct parent/child pair", async () => {
    const parent = { ...snapshot.results[0], source_sha256: snapshot.sources[0].sha256,
      arrays: { labels: { sha256: "1".repeat(64), shape: [3, 48, 64], dtype: "uint32" } } };
    const child = { ...parent, id: "e".repeat(32), revision_hash: "f".repeat(64), kind: "corrected-labels", parent_id: parent.id };
    const study = { ...snapshot, results: [parent, child], samples: [{ id: snapshot.sources[0].id, revision: 1,
      data: { study: "Study", sample: "Field", condition: "Control", biological_replicate: "R1" } }] };
    const execute = vi.fn((operation: string, request: Record<string, unknown>) => {
      if (operation === "view") return Promise.resolve({ image: "data:image/png;base64,view" });
      if (operation === "result") return Promise.resolve(resultPage(request, study.results));
      if (operation === "result_view") return Promise.resolve(resultView(request.result_id === child.id ? child : parent));
      return Promise.resolve({});
    });
    render(<ResearchWorkbench api={api({ getSnapshot: vi.fn().mockResolvedValue(study), execute })} onBack={vi.fn()} />);
    await selectHistoryResult(/Corrected segmentation/);
    await openTool("Results", "Info");
    fireEvent.click(screen.getByRole("button", { name: "Show experiment effect" }));
    expect(await screen.findByRole("region", { name: "Experiment effect" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Corrections" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("After correction revision")).toHaveValue(child.id);
    fireEvent.click(screen.getByRole("tab", { name: "Samples" }));
    fireEvent.click(screen.getByRole("tab", { name: "Corrections" }));
    expect(screen.getByLabelText("After correction revision")).toHaveValue(child.id);
    fireEvent.click(screen.getByRole("button", { name: "Calculate experiment effect" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("study_correction_effect", {
      before_result_ids: [parent.id], after_result_ids: [child.id], value: "measure",
    }));
  });
  it("recovers an annotation draft across task groups and incompatible tools with its exact save scope", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const execute = vi.fn(async (operation: string) => operation === "annotate_source" ? {
      source_id: snapshot.sources[0].id, source_sha256: snapshot.sources[0].sha256,
      revision: 1, annotations: [], can_undo: true, can_redo: false,
    } : {});
    const bridge = api({ execute });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Annotate", "Annotate");
    fireEvent.click(screen.getByRole("button", { name: "Distance" }));
    await waitFor(() => expect(screen.getByLabelText("Image viewer: Specimen")).toHaveAttribute("data-prepared", "true"));
    for (const coordinate of [100, 200]) {
      const canvas = screen.getByLabelText("Source image and bound annotations");
      fireEvent.pointerDown(canvas, { button: 0, clientX: coordinate, clientY: coordinate });
      fireEvent.pointerUp(canvas, { button: 0, clientX: coordinate, clientY: coordinate });
    }
    fireEvent.change(screen.getByLabelText("Annotation label"), { target: { value: "Unfinished distance" } });
    expect(screen.getByRole("button", { name: "Save annotation" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    fireEvent.click(screen.getByRole("button", { name: "Annotate" }));
    expect(screen.getByRole("button", { name: "Distance" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Save annotation" })).toBeEnabled();
    expect(screen.getByLabelText("Annotation label")).toHaveValue("Unfinished distance");
    fireEvent.click(screen.getByRole("button", { name: "Polygon" }));
    expect(screen.getByRole("button", { name: "Save annotation" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Distance" }));
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("annotate_source", expect.objectContaining({
      source_id: snapshot.sources[0].id, source_sha256: snapshot.sources[0].sha256, expected_revision: 0,
      annotation: expect.objectContaining({ kind: "line", z: 1, t: 0, label: "Unfinished distance", points: expect.arrayContaining([
        expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      ]) }),
    })));
  });

  it("recovers plane drafts without applying their points to another plane or replacement document", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const bridge = api();
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Annotate", "Annotate");
    fireEvent.click(screen.getByRole("button", { name: "Point" }));
    await waitFor(() => expect(screen.getByLabelText("Image viewer: Specimen")).toHaveAttribute("data-prepared", "true"));
    const canvas = screen.getByLabelText("Source image and bound annotations");
    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 100, clientY: 100 });
    expect(screen.getByRole("button", { name: "Save annotation" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Z plane"), { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "Save annotation" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Z plane"), { target: { value: "1" } });
    expect(screen.getByRole("button", { name: "Save annotation" })).toBeEnabled();
    fireEvent.click(screen.getByText("File"));
    fireEvent.click(screen.getByRole("button", { name: "Open study" }));
    await waitFor(() => expect(bridge.openStudy).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Point" })).toHaveAttribute("aria-pressed", "false"));
    fireEvent.click(screen.getByRole("button", { name: "Point" }));
    expect(screen.getByRole("button", { name: "Save annotation" })).toBeDisabled();
  });

  it("shows readable result and review state while rejecting contradictory review receipts", async () => {
    const active = structuredClone(snapshot);
    active.results[0].review = { disposition: "reviewed" };
    active.results.push({ ...active.results[0], id: "e".repeat(32), revision_hash: "f".repeat(64),
      review: { disposition: "reviewed", revision_hash: "stale" } as never });
    render(<ResearchWorkbench api={api({ getSnapshot: vi.fn().mockResolvedValue(active) })} onBack={vi.fn()} />);
    const first = await screen.findByRole("button", { name: /reviewed review$/ });
    expect(first).toHaveAttribute("data-review-state", "reviewed");
    expect(first).toHaveTextContent("1 object · Reviewed");
    expect(first).toHaveAttribute("data-result-id", active.results[0].id);
    expect(first).not.toHaveTextContent(active.results[0].revision_hash);
    expect(first.title).not.toContain(active.results[0].id);
    const second = screen.getByRole("button", { name: /pending review$/ });
    expect(second).toHaveAttribute("data-review-state", "pending");
  });

  it("distinguishes duplicate result rows with stable visible labels and selects exact revisions", async () => {
    const active = structuredClone(snapshot);
    const first = { ...active.results[0], created_at: "2026-10-22T04:05:06Z" };
    const second = { ...first, id: "e".repeat(32), revision_hash: "f".repeat(64) };
    const later = { ...first, id: "1".repeat(32), revision_hash: "2".repeat(64), created_at: "2026-10-22T04:05:07Z" };
    const corrected = { ...first, id: "3".repeat(32), revision_hash: "4".repeat(64), kind: "corrected-labels", parent_id: second.id };
    // Reverse the equal-time pair: ordinal identity must not depend on array order.
    active.results = [second, first, later, corrected];
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active), execute: vi.fn(async (operation, request) => {
      const exact = active.results.find((item) => item.id === request.result_id);
      if (operation === "result") return resultPage(request, active.results, [{ label: 1, area: exact === second ? 33 : 22 }]);
      if (operation === "result_view" && exact) return resultView(exact);
      return {};
    }) });
    const { container } = render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    const rows = () => [first, second, later, corrected].map((result) => container.querySelector<HTMLButtonElement>(`[data-result-id="${result.id}"]`)!);
    await waitFor(() => expect(rows()[0]).toBeEnabled());
    const [firstRow, secondRow, laterRow, correctedRow] = rows();
    expect(firstRow).toHaveTextContent("Result 1");
    expect(secondRow).toHaveTextContent("Result 2");
    expect(laterRow).toHaveTextContent("Created ");
    expect(correctedRow).not.toHaveTextContent("Created ");
    expect(correctedRow).toHaveTextContent("Edited from Segmentation · Result 2");
    expect(new Set([firstRow, secondRow, laterRow].map((row) => row.getAttribute("aria-label"))).size).toBe(3);
    for (const [index, row] of [firstRow, secondRow, laterRow].entries()) {
      const discriminator = row.querySelector(".research-result-meta")!.textContent!;
      expect(row.getAttribute("aria-label")).toContain(discriminator);
      expect(row).not.toHaveTextContent(active.results[index].id);
      expect(row).not.toHaveTextContent(active.results[index].revision_hash);
    }
    fireEvent.click(screen.getByRole("button", { name: secondRow.getAttribute("aria-label")! }));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("result", { result_id: second.id, offset: 0, limit: 200 }));
    await waitFor(() => expect(secondRow).toHaveAttribute("aria-pressed", "true"));
    expect(firstRow).toHaveAttribute("aria-pressed", "false");
    await openTool("Analyze", "Analyze");
    expect(await screen.findByText("33", { exact: true })).toBeVisible();
    expect(bridge.execute).toHaveBeenCalledWith("result_view", expect.objectContaining({ result_id: second.id }));
  });

  it("uses an ordinal when duplicate results have no valid recorded time", async () => {
    const active = structuredClone(snapshot);
    active.results.push({ ...active.results[0], id: "e".repeat(32), revision_hash: "f".repeat(64), created_at: "unavailable" });
    render(<ResearchWorkbench api={api({ getSnapshot: vi.fn().mockResolvedValue(active) })} onBack={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /^Segmentation, Result 1,/ })).toHaveTextContent("Result 1");
    expect(screen.getByRole("button", { name: /^Segmentation, Result 2,/ })).toHaveTextContent("Result 2");
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it("waits for initial restoration before a native image command and ignores duplicate commands", async () => {
    let finishRestore!: (value: ResearchSnapshot) => void;
    let finishOpen!: (value: ResearchSnapshot) => void;
    const openImages = vi.fn(() => new Promise<ResearchSnapshot>((resolve) => { finishOpen = resolve; }));
    const bridge = api({ openImages, getSnapshot: vi.fn(() => new Promise<ResearchSnapshot>((resolve) => { finishRestore = resolve; })) });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    act(() => { expect(dispatchWorkbenchCommand("open-images")).toBe(true); dispatchWorkbenchCommand("open-folder"); });
    expect(openImages).not.toHaveBeenCalled();
    await act(async () => { finishRestore(snapshot); });
    await waitFor(() => expect(openImages).toHaveBeenCalledExactlyOnceWith("files"));
    await act(async () => { finishOpen(snapshot); });
  });

  it.each(["open-folder", "open-study", "save-study"] as const)("routes native %s through the current workbench", async (command) => {
    const openImages = vi.fn().mockResolvedValue(snapshot);
    const saveAs = vi.fn().mockResolvedValue(snapshot);
    const bridge = api({ openImages, saveAs });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await screen.findAllByText("Specimen");
    act(() => { expect(dispatchWorkbenchCommand(command)).toBe(true); });
    await waitFor(() => {
      if (command === "open-folder") expect(openImages).toHaveBeenCalledExactlyOnceWith("folder");
      else if (command === "open-study") expect(bridge.openStudy).toHaveBeenCalledOnce();
      else expect(saveAs).toHaveBeenCalledOnce();
    });
  });

  it("detaches the current unsaved display state with its source fingerprint", async () => {
    const open = vi.fn().mockResolvedValue({ views: [] });
    window.lociImageWindows = { open } as unknown as NonNullable<Window["lociImageWindows"]>;
    try {
      render(<ResearchWorkbench api={api()} onBack={vi.fn()} />);
      await openTool("View", "Display");
      const opacity = await screen.findByLabelText("Channel 1 opacity");
      fireEvent.change(opacity, { target: { value: "0.37" } });
      fireEvent.click(screen.getByRole("button", { name: "Detach image" }));
      await waitFor(() => expect(open).toHaveBeenCalledWith(snapshot.sources[0].id,
        expect.objectContaining({ sourceSha256: snapshot.sources[0].sha256,
          presentation: expect.objectContaining({ channels: expect.arrayContaining([
            expect.objectContaining({ channel: 0, opacity: 0.37 }),
          ]), mode: "plane", tool: "navigate" }) })));
    } finally { delete window.lociImageWindows; }
  });

  it("returns from detached controls to the chosen source rather than the first imported image", async () => {
    const second = { ...snapshot.sources[0], id: "e".repeat(32), sha256: "f".repeat(64), name: "Return target" };
    const desktop = api({ getSnapshot: async () => ({ ...snapshot, sources: [...snapshot.sources, second] }) });
    render(<ResearchWorkbench api={desktop} initialSourceId={second.id} onBack={vi.fn()} />);
    expect(await screen.findByLabelText("Image viewer: Return target")).toBeVisible();
    expect(screen.queryByLabelText("Image viewer: Specimen")).not.toBeInTheDocument();
  });

  it("opens the dedicated epidermal measurement workflow and finds fluorescence by task name", async () => {
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
    fireEvent.change(screen.getByLabelText("Search all tools"), { target: { value: "fluorescence" } });
    expect(screen.getByRole("option", { name: /Fluorescence & field assay/ })).toBeVisible();
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
    fireEvent.click(await screen.findByText("DAPI", { selector: ".source-display summary span" }));

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
      name: /Segmentation/i,
    });
    expect(historyButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(historyButton);
    await waitFor(() =>
      expect(historyButton).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it.each(["empty", "loaded"] as const)("pauses contextual help during %s workspace error recovery and restores it after dismissal", async (state) => {
    const failure = new Error("Study destination is unavailable");
    const desktop = api(state === "empty"
      ? { getSnapshot: vi.fn().mockResolvedValue(null), openStudy: vi.fn().mockRejectedValue(failure) }
      : { saveAs: vi.fn().mockRejectedValue(failure) });
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} onOpenSettings={vi.fn()} />);
    await screen.findByRole("main", { name: state === "empty" ? "Loci workspace" : "Research workspace" });
    if (state === "loaded") {
      await waitFor(() => expect(screen.getByLabelText("Image viewer: Specimen")).toHaveAttribute("data-prepared", "true"));
    }
    const settings = screen.getByRole("button", { name: "Open settings" });
    await waitFor(() => expect(settings).toHaveAttribute("data-loci-help", "Appearance and preferences"));
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focusIn(settings);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Appearance and preferences");

    fireEvent.click(screen.getByRole("button", { name: state === "empty" ? "Open study" : "Save study" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(failure.message);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    expect(settings).not.toHaveAttribute("aria-describedby");
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(document.body, { key: "Tab" });
      fireEvent.focusIn(settings);
      fireEvent.pointerOver(settings);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: "Tab" });
      fireEvent.focusIn(settings);
      act(() => vi.advanceTimersByTime(0));
      expect(screen.getByRole("tooltip")).toHaveTextContent("Appearance and preferences");
    } finally {
      vi.useRealTimers();
    }
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

  it.each(["success", "cancel", "error"] as const)(
    "drains saved display settings and pauses refinement for result export (%s)",
    async (outcome) => {
      const reviewed = structuredClone(snapshot);
      reviewed.results[0].review = { disposition: "reviewed" };
      reviewed.sources[0].metadata.dimensions!.z = 1;
      reviewed.sources[0].metadata.levels![0].dimensions.z = 1;
      reviewed.sources[0].source_kind = "native";
      const planeGeometry = { axes: "YX", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], unit: "pixel", frame: "image" };
      reviewed.results[0].source_sha256 = reviewed.sources[0].sha256;
      reviewed.results[0].selection = { x: 0, y: 0, width: 64, height: 48, z: 0, t: 0, c: 0, level: 0 };
      reviewed.results[0].geometry = planeGeometry;
      reviewed.results[0].arrays = { image: { shape: [48, 64], dtype: "float64" } };
      let main!: HTMLElement;
      let finishWrite!: () => void;
      let finishExport!: (value: unknown) => void;
      let rejectExport!: (error: Error) => void;
      let rejectTile!: (error: Error) => void;
      let blockWrite = false;
      let blockRefinement = false;
      let pendingWrite: Record<string, unknown> | null = null;
      let pendingTile = false;
      const exportResult = vi.fn(() => {
        expect(main).toHaveAttribute("inert");
        return new Promise((resolve, reject) => { finishExport = resolve; rejectExport = reject; });
      });
      const desktop = api({ getSnapshot: vi.fn().mockResolvedValue(reviewed), exportResult });
      const original = desktop.execute;
      desktop.execute = vi.fn(async (operation, request, options) => {
        if (operation === "result_view") return {
          ...resultView(reviewed.results[0], "z", 0, [48, 64]),
          geometry: planeGeometry,
        };
        const state = request.state as { channels?: Array<{ low?: number }> } | undefined;
        if (operation === "save_source_view" && blockWrite && state?.channels?.[0]?.low === 7) {
          blockWrite = false;
          pendingWrite = structuredClone(request);
          return new Promise((resolve) => {
            finishWrite = () => resolve({ source_id: request.source_id,
              source_sha256: request.source_sha256, revision: Number(request.expected_revision) + 1,
              state: request.state });
          });
        }
        if (operation === "viewer_tile" && !request.overview && blockRefinement) {
          blockRefinement = false;
          pendingTile = true;
          return new Promise((_, reject) => { rejectTile = reject; });
        }
        return original(operation, request, options);
      });
      render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
      main = await screen.findByRole("main", { name: "Research workspace" });
      await selectHistoryResult();
      await openTool("View", "Display");
      const low = await screen.findByLabelText("Channel 1 low");
      await waitFor(() => expect(low).toHaveValue("0"));
      blockWrite = true;
      blockRefinement = true;
      fireEvent.change(low, { target: { value: "7" } });
      fireEvent.keyDown(low, { key: "Enter" });
      await waitFor(() => expect(pendingTile).toBe(true));
      await waitFor(() => expect(pendingWrite).not.toBeNull());
      const viewer = screen.getByLabelText("Image viewer: Specimen");
      const camera = viewer.getAttribute("data-camera");
      const cacheBytes = Number(viewer.getAttribute("data-cache-bytes"));
      expect(cacheBytes).toBeGreaterThan(0);
      expect(pendingWrite).toEqual(expect.objectContaining({
        source_id: reviewed.sources[0].id, source_sha256: reviewed.sources[0].sha256,
        state: expect.objectContaining({ channels: expect.arrayContaining([
          expect.objectContaining({ channel: 0, low: 7, high: 255 }),
        ]) }),
      }));
      await openTool("Results", "Info");
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      fireEvent.click(screen.getByRole("button", { name: "Export result" }));
      expect(main).toHaveAttribute("inert");
      expect(exportResult).not.toHaveBeenCalled();
      await act(async () => { finishWrite(); });
      await waitFor(() => expect(exportResult).toHaveBeenCalledExactlyOnceWith(
        reviewed.results[0].id, reviewed.results[0].revision_hash, undefined,
      ));
      await act(async () => { rejectTile(new Error("Wait for the study to finish opening.")); });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(viewer).toHaveAttribute("data-camera", camera);
      expect(Number(viewer.getAttribute("data-cache-bytes"))).toBeGreaterThanOrEqual(cacheBytes);
      await act(async () => {
        if (outcome === "error") rejectExport(new Error("Export destination unavailable"));
        else finishExport(outcome === "cancel" ? null : { exported: true });
      });
      await waitFor(() => expect(main).not.toHaveAttribute("inert"));
      if (outcome === "error") {
        expect(screen.getByRole("alert")).toHaveTextContent("Export destination unavailable");
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      } else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await openTool("View", "Display");
      expect(screen.getByLabelText("Channel 1 low")).toHaveValue("7");
      expect(screen.getByLabelText("Channel 1 high")).toHaveValue("255");
      expect(screen.getByLabelText("Image viewer: Specimen")).toBe(viewer);
      expect(viewer).toHaveAttribute("data-camera", camera);
      await waitFor(() => expect(Number(viewer.getAttribute("data-cache-bytes"))).toBeGreaterThan(cacheBytes));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(desktop.execute).not.toHaveBeenCalledWith("run_recipe", expect.anything());
    },
  );

  it("flushes a loaded pending view before closing, restores its exact revision on undo, and saves the study", async () => {
    const first = snapshot.sources[0];
    const second = { ...structuredClone(first), id: "f".repeat(32), sha256: "e".repeat(64), name: "Second" };
    let study: ResearchSnapshot = { ...structuredClone(snapshot), sources: [first, second], results: [],
      workspace: { revision: 0, closed_sources: [], hidden_results: [] } };
    const views = new Map<string, { source_id: string; source_sha256: string; revision: number; state: unknown }>(
      study.sources.map(source => [source.id, { source_id: source.id, source_sha256: source.sha256, revision: 0, state: null }]));
    let gate = false;
    let finishWrite: (() => void) | undefined;
    const events: string[] = [];
    const updateWorkspace = vi.fn(async (change) => {
      events.push("workspace");
      const closing = change.sources[0].visible === false;
      study = { ...study, sources: closing ? [second] : [first, second],
        workspace: { revision: change.expected_revision + 1, closed_sources: closing ? [first] : [], hidden_results: [] } };
      return study;
    });
    const saveAs = vi.fn(async () => { events.push("saveAs"); return study; });
    const desktop = api({ getSnapshot: vi.fn(async () => study), updateWorkspace, saveAs });
    const original = desktop.execute;
    desktop.execute = vi.fn(async (operation, request) => {
      const id = String(request.source_id);
      if (operation === "source_view") { events.push(`read:${id}`); return structuredClone(views.get(id)); }
      if (operation === "save_source_view") {
        const prior = views.get(id)!;
        expect(request.source_sha256).toBe(prior.source_sha256);
        if (request.expected_revision !== prior.revision) throw new Error("Display revision conflict");
        if (gate) { gate = false; await new Promise<void>(resolve => { finishWrite = resolve; }); }
        const saved = { ...prior, revision: prior.revision + 1, state: structuredClone(request.state) };
        views.set(id, saved); events.push(`write:${id}:${saved.revision}`); return saved;
      }
      return original(operation, request);
    });
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    await openTool("View", "Display");
    const low = await screen.findByLabelText("Channel 1 low");
    await waitFor(() => expect(low).toHaveValue("0"));
    fireEvent.change(low, { target: { value: "7" } }); fireEvent.keyDown(low, { key: "Enter" });
    gate = true;
    fireEvent.click(screen.getByRole("button", { name: "Remove selected images" }));
    try {
      await waitFor(() => expect(finishWrite).toBeDefined());
      expect(updateWorkspace).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Active image")).toHaveTextContent(first.name);
    } finally { finishWrite?.(); }
    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledOnce());
    expect(events.indexOf(`write:${first.id}:1`)).toBeLessThan(events.indexOf("workspace"));
    expect(await screen.findByLabelText("Image viewer: Second")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText("Channel 1 low")).toHaveValue("7"));
    expect(screen.getByLabelText("Image viewer: Specimen")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save study" }));
    await waitFor(() => expect(saveAs).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(updateWorkspace.mock.calls.map(([change]) => change.sources)).toEqual([
      [{ id: first.id, sha256: first.sha256, visible: false }], [{ id: first.id, sha256: first.sha256, visible: true }],
    ]);
  });

  it("retains the active source and revisioned display store when closing fails", async () => {
    const first = snapshot.sources[0];
    const second = { ...structuredClone(first), id: "f".repeat(32), name: "Second" };
    const study = { ...structuredClone(snapshot), sources: [first, second] };
    let revision = 0;
    const updateWorkspace = vi.fn(async () => { throw new Error("Workspace write refused"); });
    const saveAs = vi.fn(async () => null);
    const desktop = api({ getSnapshot: vi.fn(async () => study), updateWorkspace, saveAs });
    const original = desktop.execute;
    desktop.execute = vi.fn(async (operation, request) => {
      if (operation === "source_view") return { source_id: first.id, source_sha256: first.sha256, revision, state: null };
      if (operation === "save_source_view") {
        expect(request.source_id).toBe(first.id); expect(request.source_sha256).toBe(first.sha256);
        expect(request.expected_revision).toBe(revision);
        return { source_id: first.id, source_sha256: first.sha256, revision: ++revision, state: request.state };
      }
      return original(operation, request);
    });
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    await openTool("View", "Display");
    const low = await screen.findByLabelText("Channel 1 low");
    await waitFor(() => expect(low).toHaveValue("0"));
    // Settle the committed edit and its persistence effect before the next native action.
    fireEvent.change(low, { target: { value: "7" } });
    await act(async () => fireEvent.keyDown(low, { key: "Enter" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove selected images" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace write refused");
    expect(screen.getByLabelText("Active image")).toHaveTextContent(first.name);
    expect(screen.getByLabelText("Channel 1 low")).toHaveValue("7");
    expect(desktop.execute).toHaveBeenCalledWith("save_source_view", expect.objectContaining({
      source_id: first.id, expected_revision: 0,
      state: expect.objectContaining({ channels: expect.arrayContaining([expect.objectContaining({ low: 7 })]) }),
    }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.change(low, { target: { value: "9" } });
    await act(async () => fireEvent.keyDown(low, { key: "Enter" }));
    fireEvent.click(screen.getByRole("button", { name: "Save study" }));
    await waitFor(() => expect(saveAs).toHaveBeenCalledOnce());
    expect(desktop.execute).toHaveBeenCalledWith("save_source_view", expect.objectContaining({ source_id: first.id,
      expected_revision: revision - 1, state: expect.objectContaining({ channels: expect.arrayContaining([expect.objectContaining({ low: 9 })]) }) }));
    expect(vi.mocked(desktop.execute).mock.calls.filter(([operation]) => operation === "source_view")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a failed pending display write visible and blocks close and Save As", async () => {
    const updateWorkspace = vi.fn(async () => snapshot), saveAs = vi.fn(async () => snapshot);
    const desktop = api({ updateWorkspace, saveAs });
    const original = desktop.execute;
    desktop.execute = vi.fn(async (operation, request) => {
      if (operation === "save_source_view") throw new Error("Synthetic display write failed");
      return original(operation, request);
    });
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    await openTool("View", "Display");
    const low = await screen.findByLabelText("Channel 1 low");
    await waitFor(() => expect(low).toHaveValue("0"));
    fireEvent.change(low, { target: { value: "7" } }); fireEvent.keyDown(low, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove selected images" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic display write failed");
    expect(updateWorkspace).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Specimen");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getByRole("button", { name: "Save study" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic display write failed");
    expect(saveAs).not.toHaveBeenCalled();
  });

  it("closes during pending display preparation and ignores the abandoned read after undo", async () => {
    const first = snapshot.sources[0];
    const second = { ...structuredClone(first), id: "f".repeat(32), name: "Second" };
    let study: ResearchSnapshot = { ...structuredClone(snapshot), sources: [first, second], results: [],
      workspace: { revision: 0, closed_sources: [], hidden_results: [] } };
    let rejectDefaults!: (error: Error) => void;
    let delayed = false;
    const updateWorkspace = vi.fn(async (change) => {
      const closing = change.sources[0].visible === false;
      study = { ...study, sources: closing ? [second] : [first, second],
        workspace: { revision: change.expected_revision + 1, closed_sources: closing ? [first] : [], hidden_results: [] } };
      return study;
    });
    const saveAs = vi.fn(async () => study);
    const desktop = api({ getSnapshot: vi.fn(async () => study), updateWorkspace, saveAs });
    const original = desktop.execute;
    desktop.execute = vi.fn(async (operation, request) => {
      if (operation === "viewer_defaults" && !delayed) {
        delayed = true; return new Promise((_, reject) => { rejectDefaults = reject; });
      }
      return original(operation, request);
    });
    render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    await waitFor(() => expect(delayed).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Remove selected images" }));
    await screen.findByLabelText("Image viewer: Second");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByLabelText("Image viewer: Specimen");
    await act(async () => { rejectDefaults(new Error("Abandoned display read")); });
    fireEvent.click(screen.getByRole("button", { name: "Save study" }));
    await waitFor(() => expect(saveAs).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(updateWorkspace).toHaveBeenCalledTimes(2);
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
    expect(screen.queryByRole("button", { name: /^Specimen · Segmentation/i })).not.toBeInTheDocument();

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
    expect(await screen.findByRole("button", { name: /Segmentation/i })).toBeVisible();
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
    expect(await screen.findByRole("button", { name: /Segmentation/i })).toBeVisible();
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
    fireEvent.click(screen.getByRole("button", { name: "Add images…" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Copy colours to images…" }));
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
    fireEvent.blur(screen.getByLabelText("Width"));
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "2048" } });
    fireEvent.blur(screen.getByLabelText("Height"));
    expect(screen.getByLabelText("Width")).toHaveValue("2048");
    expect(screen.getByLabelText("Height")).toHaveValue("2048");
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

    fireEvent.click(await screen.findByText("DAPI", { selector: ".source-display summary span" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Re-import model package…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Selected package differs from this model");
    expect(bridge.importModel).toHaveBeenCalledWith(expect.any(Number), modelId);
    expect(screen.getByRole("button", { name: "Import model package…" })).toBeEnabled();
  });

  it("chooses the working-memory budget before importing a managed package", async () => {
    const bridge = api({ importModel: vi.fn().mockResolvedValue({}) });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Model");
    expect(screen.getByRole("heading", { name: "No model packages in this study." })).toBeVisible();
    fireEvent.click(screen.getByText(/Resources ·/));
    fireEvent.change(screen.getByLabelText("Model working memory"), {
      target: { value: String(2 * 1024 ** 3) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import model package…" }));
    await waitFor(() =>
      expect(bridge.importModel).toHaveBeenCalledWith(2 * 1024 ** 3, undefined),
    );
  });

  it("opens the offline example as a normal source-only study and shows bound guidance", async () => {
    const practice = {
      ...snapshot,
      project: { title: "Synthetic shapes practice", first_study: {
        example_id: "synthetic-shapes-v1", source_id: snapshot.sources[0].id, source_sha256: snapshot.sources[0].sha256,
      } },
      results: [],
    };
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(null), tryExample: vi.fn().mockResolvedValue(practice) });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try a synthetic example" }));
    expect(await screen.findByText("Practice: inspect, measure and export")).toBeVisible();
    expect(bridge.tryExample).toHaveBeenCalledWith();
    expect(bridge.execute).not.toHaveBeenCalledWith("run_recipe", expect.anything());
    expect(bridge.reviewResult).not.toHaveBeenCalled();
    expect(screen.queryByText(/segmentation ·/)).not.toBeInTheDocument();
  });

  it("defers pixel-dependent annotation setup during portable import and restores it after exact relinking", async () => {
    const available: ResearchSnapshot = { ...snapshot, results: snapshot.results.map((result) => ({ ...result, review: { disposition: "reviewed" } })) };
    const missing: ResearchSnapshot = { ...available, sources: available.sources.map((source) => ({ ...source, locator_state: "relink-required" })) };
    let current = available;
    const bridge = api({ getSnapshot: vi.fn(async () => current),
      importStudy: vi.fn(async () => { current = missing; return missing; }),
      relinkSource: vi.fn(async () => { current = available; return available; }),
    });
    const original = bridge.execute;
    const unavailableReads: string[] = [];
    const annotation = { id: "stored-point", kind: "point", points: [{ x: 10, y: 12 }],
      label: "Stored source annotation", color: "#ffd36a", z: 0, t: 0, length: null, area: null, unit: "px" };
    bridge.execute = vi.fn(async (operation, request, options) => {
      if (current === missing && ["viewer_defaults", "viewer_tile", "viewer_volume", "source_annotations"].includes(operation)) {
        unavailableReads.push(operation);
        throw new Error("Source locator is unavailable after interchange; relink an exact local copy");
      }
      if (operation === "source_annotations") return { source_id: available.sources[0].id, source_sha256: available.sources[0].sha256,
        revision: 3, annotations: [annotation], can_undo: true, can_redo: false };
      return original(operation, request, options);
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("viewer_tile", expect.anything(), expect.anything()));
    await openAdvancedTool("Import & share results");
    fireEvent.click(screen.getByRole("button", { name: "Import portable study" }));
    expect(await screen.findByText(/This source needs an exact local copy/)).toBeVisible();
    expect(unavailableReads).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(annotation.label)).not.toBeInTheDocument();
    const readsBeforeRelink = vi.mocked(bridge.execute).mock.calls.filter(([op]) => op === "viewer_defaults").length;
    const annotationsBeforeRelink = vi.mocked(bridge.execute).mock.calls.filter(([op]) => op === "source_annotations").length;
    fireEvent.click(screen.getAllByRole("button", { name: "Relink exact source" })[0]);
    await waitFor(() => expect(vi.mocked(bridge.execute).mock.calls.filter(([op]) => op === "viewer_defaults")).toHaveLength(readsBeforeRelink + 1));
    await waitFor(() => expect(Number(screen.getByLabelText("Image viewer: Specimen").getAttribute("data-cache-bytes"))).toBeGreaterThan(0));
    await openTool("Annotate", "Annotate");
    expect(await screen.findByText(annotation.label)).toBeVisible();
    expect(vi.mocked(bridge.execute).mock.calls.filter(([op]) => op === "source_annotations")).toHaveLength(annotationsBeforeRelink + 1);
    expect(screen.getByRole("button", { name: "Undo annotation" })).toBeEnabled();
    expect(current.results).toEqual(available.results);
    expect(bridge.reviewResult).not.toHaveBeenCalled();
    expect(bridge.execute).not.toHaveBeenCalledWith("annotate_source", expect.anything());
    expect(unavailableReads).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("retains annotation setup errors for an available source", async () => {
    const bridge = api();
    const original = bridge.execute;
    bridge.execute = vi.fn(async (operation, request, options) => {
      if (operation === "source_annotations") throw new Error("Source contents changed; exact original bytes are required");
      return original(operation, request, options);
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Source contents changed; exact original bytes are required");
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
    fireEvent.click(await screen.findByRole("button", { name: "Relink exact source" }));
    await waitFor(() => expect(bridge.relinkSource).toHaveBeenCalledWith(snapshot.sources[0].id, "file"));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("viewer_tile", expect.objectContaining({
      source_id: snapshot.sources[0].id,
    }), expect.objectContaining({ viewer_lane: expect.stringMatching(/^image-viewport-/) })));
    expect(await screen.findByLabelText("Image viewer: Specimen")).toBeVisible();
  });

  it.each([
    ["native", undefined, "file"],
    ["medical", { selection_kind: "series", file_count: 2 }, "dicom"],
    ["ome_zarr", undefined, "ome_zarr"],
  ])("routes direct recovery for %s and retains unavailable state after mismatch", async (kind, hint, picker) => {
    const missing = {
      ...snapshot,
      sources: snapshot.sources.map((source) => ({ ...source, source_kind: kind, relink_hint: hint, locator_state: "relink-required" })),
      results: [],
    } as ResearchSnapshot;
    const bridge = api({
      getSnapshot: vi.fn().mockResolvedValue(missing),
      relinkSource: vi.fn().mockRejectedValue(new Error("Relink rejected: selected bytes do not exactly match the source")),
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Relink exact source" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not exactly match");
    expect(bridge.relinkSource).toHaveBeenCalledWith(snapshot.sources[0].id, picker);
    expect(await screen.findByText(/This source needs an exact local copy/)).toBeVisible();
    expect(bridge.execute).not.toHaveBeenCalledWith("viewer_tile", expect.anything(), expect.anything());
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
  it("blocks empty preprocessing drafts and previews the exact restored decimal", async () => {
    const bridge = api();
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Process");
    fireEvent.click(screen.getByText("Gaussian blur", { exact: true }));
    const sigma = screen.getByLabelText("Step 1 sigma");
    fireEvent.change(sigma, { target: { value: "" } });
    expect(sigma).toHaveValue("");
    expect(screen.getByText("Preview selected crop")).toBeDisabled();
    expect(bridge.execute).not.toHaveBeenCalledWith("preview_recipe", expect.anything());
    for (const text of ["1", "1.", "1.25"]) {
      fireEvent.change(sigma, { target: { value: text } });
      expect(sigma).toHaveValue(text);
    }
    await waitFor(() => expect(screen.getByText("Preview selected crop")).toBeEnabled());
    fireEvent.click(screen.getByText("Preview selected crop"));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("preview_recipe",
      expect.objectContaining({ recipe: expect.objectContaining({ steps: [{ op: "gaussian", sigma: 1.25 }] }) })));
  });
  function markerGateBridge(twoSources = false) {
    const second = { ...snapshot.sources[0], id: "7".repeat(32), sha256: "8".repeat(64), name: "Second scalar source" };
    const study = { ...structuredClone(snapshot), sources: twoSources ? [snapshot.sources[0], second] : snapshot.sources };
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(study), execute: vi.fn(async (operation, request) => {
      const source = study.sources.find((item) => item.id === request.source_id)!;
      if (operation === "channel_metadata") return { source_id: source.id, source_sha256: source.sha256,
        original_names: ["DAPI", "Marker"], revision: 0, basis: "explicit declarations",
        channels: [0, 1].map((index) => ({ index, name: index === 0 ? "DAPI" : "Marker", marker: "", fluorophore: "", declaration: "metadata" })) };
      return {};
    }) });
    return { bridge, study, second };
  }

  async function openUnfinishedMarkerGate(bridge: ResearchDesktopApi) {
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Quantify");
    await screen.findByText(/original: DAPI/);
    fireEvent.click(screen.getByRole("button", { name: "Recipe" }));
    fireEvent.click(screen.getByRole("button", { name: "Add explicit gate" }));
    const input = screen.getByLabelText("Gate 1 threshold");
    fireEvent.change(input, { target: { value: "-7.25" } });
    fireEvent.change(input, { target: { value: "-7.25e" } });
    return input;
  }

  it("blocks an unfinished marker gate across recipe preview, run, save and batch", async () => {
    const { bridge } = markerGateBridge();
    await openUnfinishedMarkerGate(bridge);
    await openTool("Analyze", "Process");
    expect(screen.getByText("Preview selected crop")).toBeDisabled();
    fireEvent.click(screen.getByText("Preview selected crop"));
    await openTool("Analyze", "Analyze");
    expect(screen.getByRole("button", { name: "Run recipe" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    await openTool("Results", "Study");
    for (const button of [screen.getByText("Save validated recipe"), screen.getByRole("button", { name: "Preview" }), screen.getByText("Run selected sources sequentially")]) {
      expect(button).toBeDisabled(); fireEvent.click(button);
    }
    expect(vi.mocked(bridge.execute).mock.calls.filter(([operation]) => ["preview_recipe", "run_recipe", "recipe"].includes(operation))).toHaveLength(0);
  });

  it("preserves an unfinished marker gate across assistant handoff and explicit recovery", async () => {
    const { bridge } = markerGateBridge();
    const input = await openUnfinishedMarkerGate(bridge);
    await openAdvancedTool("Connect an assistant");
    expect(screen.getByText("Validate exact scope and recipe")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
    expect(vi.mocked(bridge.execute).mock.calls.filter(([operation]) => ["preview_recipe", "run_recipe", "recipe", "validate_recipe"].includes(operation))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Review marker gates" }));
    expect(screen.getByLabelText("Gate 1 threshold")).toBe(input);
    expect(input).toHaveValue("-7.25e");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("-7.25");
    fireEvent.change(input, { target: { value: "NaN" } });
    fireEvent.click(screen.getByText("Restore applied numbers"));
    expect(screen.getByLabelText("Gate 1 threshold")).toHaveValue("-7.25");
    await openTool("Analyze", "Analyze");
    await waitFor(() => expect(screen.getByRole("button", { name: "Run recipe" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("run_recipe", expect.objectContaining({
      recipe: expect.objectContaining({ gates: [expect.objectContaining({ threshold: -7.25 })] }),
    })));
  });

  it("discards only the uncommitted marker threshold on A→B→A source switches", async () => {
    const { bridge, study, second } = markerGateBridge(true);
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Quantify");
    await screen.findByText(/original: DAPI/);
    fireEvent.click(screen.getByRole("button", { name: "Recipe" }));
    fireEvent.click(screen.getByRole("button", { name: "Add explicit gate" }));
    fireEvent.change(screen.getByLabelText("Gate 1 threshold"), { target: { value: "-8.125" } });
    fireEvent.change(screen.getByLabelText("Gate 1 threshold"), { target: { value: "" } });
    expect(screen.getByLabelText("Gate 1 threshold")).toHaveValue("");
    expect(screen.getByText("Restore applied numbers")).toBeVisible();
    for (const id of [second.id, study.sources[0].id]) {
      fireEvent.click(document.querySelector<HTMLButtonElement>(`button[data-source-id="${id}"]`)!);
      await screen.findByText(/original: DAPI/);
      fireEvent.click(screen.getByRole("button", { name: "Recipe" }));
      expect(screen.getByLabelText("Gate 1 threshold")).toHaveValue("-8.125");
      expect(screen.queryByText("Restore applied numbers")).not.toBeInTheDocument();
    }
    await openTool("Analyze", "Analyze");
    await waitFor(() => expect(screen.getByRole("button", { name: "Run recipe" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("run_recipe", expect.objectContaining({
      source_id: study.sources[0].id, recipe: expect.objectContaining({ gates: [expect.objectContaining({ threshold: -8.125 })] }),
    })));
  });
  it("blocks invalid scientific drafts across study handoff until explicitly restored", async () => {
    const bridge = api();
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Analyze");
    const threshold = screen.getByLabelText("Threshold");
    fireEvent.change(threshold, { target: { value: "-1.2e" } });
    expect(threshold).toHaveValue("-1.2e");
    expect(screen.getByRole("button", { name: "Run recipe" })).toBeDisabled();
    await openTool("Results", "Study");
    expect(screen.getByText("Save validated recipe")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByText("Run selected sources sequentially")).toBeDisabled();
    fireEvent.click(screen.getByText("Restore applied numbers"));
    await waitFor(() => expect(screen.getByText("Save validated recipe")).toBeEnabled());
    await openTool("Analyze", "Analyze");
    fireEvent.change(screen.getByLabelText("Threshold"), { target: { value: "-0.123456789" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Run recipe" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("run_recipe",
      expect.objectContaining({ recipe: expect.objectContaining({ segmentation: expect.objectContaining({ threshold: -0.123456789 }) }) })));
  });
  it("previews ordered edits without adopting them and preserves the parameter", async () => {
    const bridge = api();
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Process");
    fireEvent.click(screen.getByText("Gaussian blur", { exact: true }));
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
  it.each([false, true])("persists the exact example display through the existing source-view API (saved=%s)", async (saved) => {
    const source = { ...snapshot.sources[0], sha256: FIRST_STUDY_SOURCE_SHA256,
      metadata: { ...snapshot.sources[0].metadata, dimensions: { x: 256, y: 256, z: 1, t: 1, c: 1 },
        levels: [{ index: 0, dimensions: { x: 256, y: 256, z: 1, t: 1, c: 1 } }], channel_names: ["Authored intensity"] } };
    const practice: ResearchSnapshot = { ...snapshot, sources: [source], results: [], project: {
      title: "Practice", first_study: { example_id: "synthetic-shapes-v1", source_id: source.id, source_sha256: source.sha256 },
    } };
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(practice) });
    const original = bridge.execute;
    const initial = { channel: 0, low: 0, high: 65535, gamma: 1, color: "#ffffff", opacity: 1, visible: true };
    bridge.execute = vi.fn(async (operation, request, options) => {
      if (operation === "viewer_defaults") return { source_id: source.id, source_sha256: source.sha256, channels: [initial], basis: "Native dtype range" };
      if (operation === "source_view") return { source_id: source.id, source_sha256: source.sha256, revision: 0,
        state: saved ? { interpretation: "auto", channels: [{ ...initial, low: 7, high: 125 }], projection: "plane",
          selection: { level: 0, t: 0, c: 0, z: 0, x: 0, y: 0, width: 256, height: 256 }, camera: null, rgb_mapping: null } : null };
      return original(operation, request, options);
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Channel 1 high")).toHaveValue(saved ? "125" : "200"));
    expect(screen.getByLabelText("Channel 1 low")).toHaveValue(saved ? "7" : "0");
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("save_source_view", expect.objectContaining({
      source_id: source.id, source_sha256: source.sha256, state: expect.objectContaining({
        channels: [{ ...initial, low: saved ? 7 : 0, high: saved ? 125 : 200 }],
      }),
    })));
    expect(bridge.execute).not.toHaveBeenCalledWith("run_recipe", expect.anything());
    expect(practice.results).toEqual([]);
    expect(initial.high).toBe(65535);
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
  it("keeps Z navigation available while annotating and requests the selected native plane", async () => {
    const bridge = api();
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await screen.findAllByText("Specimen");
    fireEvent.click(screen.getByRole("button", { name: "Annotate" }));
    fireEvent.click(screen.getByRole("button", { name: "Point" }));
    const slider = screen.getByLabelText("Z plane");
    expect(slider).toBeVisible();
    fireEvent.change(slider, { target: { value: "2" } });
    expect(slider).toHaveValue("2");
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("viewer_tile",
      expect.objectContaining({ overview: true, z: 2, t: 0 }), expect.anything()));
    expect(screen.getByRole("button", { name: "Save annotation" })).toBeDisabled();
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
    expect(screen.getByLabelText("condition")).toBeVisible();
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
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const exportRevision = screen.getByRole("button", { name: "Export result" });
    expect(exportRevision).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const markReviewed = screen.getByRole("button", { name: "Mark reviewed" });
    fireEvent.click(markReviewed);
    fireEvent.click(markReviewed);
    expect(reviewResult).toHaveBeenCalledOnce();
    expect(markReviewed).toBeDisabled();
    expect(screen.getByText("Review pending")).toBeVisible();

    finishReview();
    await waitFor(() => expect(screen.getByText("Reviewed", { selector: '[role="status"]' })).toBeVisible());
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(markReviewed).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.getByRole("button", { name: "Export result" })).toBeEnabled();
  });
  it("keeps primary segmentation controls before collapsed comparison and label import", async () => {
    const active = structuredClone(snapshot);
    active.sources[0].source_kind = "native";
    active.sources[0].metadata.dimensions!.z = 1;
    active.sources[0].metadata.levels![0].dimensions.z = 1;
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active) });
    const widthKey = "loci.inspector-width.v1";
    const previousWidth = localStorage.getItem(widthKey);
    localStorage.setItem(widthKey, "300");
    try { render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />); }
    finally {
      if (previousWidth === null) localStorage.removeItem(widthKey);
      else localStorage.setItem(widthKey, previousWidth);
    }
    expect(await screen.findByRole("main", { name: "Research workspace" })).toHaveStyle("--research-inspector-width: 300px");
    await openTool("Analyze", "Analyze");
    const model = screen.getByRole("combobox", { name: "Segmentation model" });
    const run = screen.getByRole("button", { name: "Run recipe" });
    const comparison = screen.getByText("Compare settings on regions", { selector: "summary" });
    const labels = screen.getByText("Import existing labels", { selector: "summary" });
    const comparisonDisclosure = comparison.closest("details")!;
    const labelsDisclosure = labels.closest("details")!;
    const setting = screen.getByLabelText("Setting 1 threshold");
    expect(model).toBeVisible();
    expect(run).toBeVisible();
    expect(model.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(run.compareDocumentPosition(comparison) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(comparison.compareDocumentPosition(labels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(comparisonDisclosure).not.toHaveAttribute("open");
    expect(labelsDisclosure).not.toHaveAttribute("open");
    expect(setting).not.toBeVisible();
    run.focus();
    expect(run).toHaveFocus();
    comparison.focus();
    expect(comparison).toHaveFocus();
    fireEvent.click(comparison);
    expect(comparisonDisclosure).toHaveAttribute("open");
    expect(setting).toBeVisible();
    expect(labelsDisclosure).not.toHaveAttribute("open");
    // Disclosure toggles preserve the optional workflow's numeric state.
    fireEvent.change(setting, { target: { value: "17" } });
    fireEvent.click(comparison);
    expect(setting).not.toBeVisible();
    fireEvent.click(comparison);
    expect(setting).toHaveValue("17");
    labels.focus();
    expect(labels).toHaveFocus();
    fireEvent.click(labels);
    expect(labelsDisclosure).toHaveAttribute("open");
    expect(model).toHaveValue("classical");
    expect(screen.getByRole("textbox", { name: "Threshold" })).toHaveValue("0");
    expect(bridge.execute).not.toHaveBeenCalledWith("run_recipe", expect.anything());
    expect(bridge.execute).not.toHaveBeenCalledWith("exploration_preview", expect.anything());
  });

  it.each([true, false])("selects Adaptive raw input independently of display with source-bound declaration names (%s)", async (matchingDeclaration) => {
    const active = structuredClone(snapshot);
    active.sources[0].source_kind = "native";
    active.sources[0].metadata.dimensions!.z = 1;
    active.sources[0].metadata.levels![0].dimensions.z = 1;
    active.sources[0].metadata.channel_names = ["Stored GFP", "Stored DNA"];
    active.channels = [{ id: active.sources[0].id, revision: 1, data: {
      source_sha256: matchingDeclaration ? active.sources[0].sha256 : "0".repeat(64), original_names: ["Stored GFP", "Stored DNA"],
      channels: ["Declared GFP", "Declared DNA"].map((name, index) => ({ index, name, marker: "", fluorophore: "", declaration: "Recorded acquisition" })),
    } }];
    const settings = { image_mode: "fluorescence", polarity: "bright", expected_diameter_px: 34, min_area_px: 80,
      sensitivity: 0, smoothing_px: 1.2, split_touching: true, exclude_border: false };
    const native = { listProfiles: vi.fn().mockResolvedValue([{ id: "loci-classical", backendKind: "classical",
      recommendedSettings: settings, settingsContract: [], validation: { summary: "Deterministic fixture" } }]) };
    const previous = Object.getOwnPropertyDescriptor(window, "loci");
    Object.defineProperty(window, "loci", { configurable: true, value: native });
    try {
      const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active) });
      const original = bridge.execute;
      bridge.execute = vi.fn(async (operation, request, options) => operation === "classical_run"
        ? { result: { ...active.results[0], kind: "adaptive-segmentation" } } : original(operation, request, options));
      render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
      await openTool("Analyze", "Analyze");
      fireEvent.change(screen.getByRole("combobox", { name: "Segmentation model" }), { target: { value: "adaptive" } });
      const input = await screen.findByRole("combobox", { name: "Segmentation input" });
      await waitFor(() => expect(input).toBeEnabled());
      expect(within(input).getAllByRole("option").map((option) => option.textContent?.trim())).toEqual(
        matchingDeclaration ? ["1: Declared GFP", "2: Declared DNA"] : ["1: Stored GFP", "2: Stored DNA"]);
      fireEvent.change(screen.getByRole("combobox", { name: "Display channel" }), { target: { value: "1" } });
      fireEvent.click(screen.getByRole("button", { name: "Solo" }));
      expect(input).toHaveValue("0");
      input.focus(); expect(input).toHaveFocus();
      fireEvent.change(input, { target: { value: "1" } });
      expect(input).toHaveValue("1");
      fireEvent.change(screen.getByRole("combobox", { name: "Display channel" }), { target: { value: "0" } });
      fireEvent.click(screen.getByRole("button", { name: "Solo" }));
      expect(input).toHaveValue("1");
      await waitFor(() => expect(screen.getByRole("button", { name: "Segment image" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Segment image" }));
      await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("classical_run", expect.objectContaining({
        source_id: active.sources[0].id, selection: expect.objectContaining({ c: 1, z: 0, t: 0 }),
        settings, measurement_channels: [1], profile_id: "loci-classical",
      })));
    } finally {
      if (previous) Object.defineProperty(window, "loci", previous);
      else Reflect.deleteProperty(window, "loci");
    }
  });

  it.each([
    { names: ["DAPI", " Marker "], labels: ["1: DAPI", "2: Marker"] },
    { names: ["", "   "], labels: ["1: Channel 1", "2: Channel 2"] },
    { names: undefined, labels: ["1: Channel 1", "2: Channel 2"] },
  ])("labels classical measurement channels from recorded names or explicit fallbacks: $labels", async ({ names, labels }) => {
    const active = structuredClone(snapshot);
    active.sources[0].metadata.channel_names = names;
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active) });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Analyze");
    const channel = screen.getByRole("combobox", { name: "Measurement channel" });
    expect(within(channel).getAllByRole("option").map((option) => ({ text: option.textContent?.trim(), value: (option as HTMLOptionElement).value })))
      .toEqual(labels.map((text, index) => ({ text, value: String(index) })));
    fireEvent.change(channel, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("run_recipe", expect.objectContaining({
      source_id: active.sources[0].id, recipe: expect.objectContaining({ measurement_channels: [1] }),
    })));
  });

  it.each([false, true])("keeps segmentation, display and measurement channels independent with exact raw plane scope (range %s)", async (range) => {
    const active = structuredClone(snapshot);
    const dimensions = { x: 64, y: 48, z: 5, t: 3, c: 3 };
    active.sources[0].metadata.dimensions = dimensions;
    active.sources[0].metadata.levels = [{ index: 0, dimensions }];
    active.sources[0].metadata.channel_names = ["Recorded structural", "Recorded signal", " "];
    const selection = { level: 0, x: 5, y: 6, width: 20, height: 10, c: 0, z: 2, t: 1, ...(range ? { z_stop: 5 } : {}) };
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active) });
    const original = bridge.execute;
    bridge.execute = vi.fn(async (operation, request, options) => {
      if (operation === "source_view") return { source_id: active.sources[0].id, source_sha256: active.sources[0].sha256, revision: 0,
        state: { interpretation: "auto", projection: "plane", selection, camera: null, rgb_mapping: null,
          channels: [0, 1, 2].map((channel) => ({ channel, visible: true, color: "#ffffff", opacity: 1, low: 0, high: 255, gamma: 1 })) } };
      return original(operation, request, options);
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Analyze");
    const segmentation = await screen.findByRole("combobox", { name: "Segmentation input" });
    await waitFor(() => expect(segmentation).toBeEnabled());
    expect(within(segmentation).getAllByRole("option").map((option) => ({ text: option.textContent?.trim(), value: (option as HTMLOptionElement).value })))
      .toEqual([{ text: "1: Recorded structural", value: "0" }, { text: "2: Recorded signal", value: "1" }, { text: "3: Channel 3", value: "2" }]);
    expect(screen.getByText(range ? "Raw source channel · T 2 · Z 3–5" : "Raw source channel · T 2 · Z 3")).toBeVisible();
    fireEvent.change(segmentation, { target: { value: "1" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Display channel" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Solo" }));
    expect(segmentation).toHaveValue("1");
    fireEvent.change(screen.getByRole("combobox", { name: "Measurement channel" }), { target: { value: "2" } });
    expect(segmentation).toHaveValue("1");
    expect(screen.getByRole("combobox", { name: "Display channel" })).toHaveValue("2");
    await openTool("Results", "Study");
    fireEvent.click(screen.getByRole("tab", { name: "Batch" }));
    fireEvent.click(screen.getByRole("button", { name: "Save validated recipe" }));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("recipe", expect.objectContaining({
      source_id: active.sources[0].id, data: expect.objectContaining({ selection: { ...selection, c: 1 },
        recipe: expect.objectContaining({ measurement_channels: [2] }) }),
    })));
    await openTool("Analyze", "Analyze");
    expect(screen.getByRole("combobox", { name: "Segmentation input" })).toHaveValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("run_recipe", expect.objectContaining({
      source_id: active.sources[0].id, selection: { ...selection, c: 1 }, recipe: expect.objectContaining({ measurement_channels: [2] }),
    })));
  });

  it("blocks segmentation input and submission while busy or source display defaults are unresolved", async () => {
    const active = structuredClone(snapshot);
    const second = { ...active.sources[0], id: "7".repeat(32), sha256: "8".repeat(64), name: "Second scalar source" };
    active.sources.push(second);
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active) });
    const original = bridge.execute;
    let releaseDefaults!: () => void;
    let releaseRun!: () => void;
    bridge.execute = vi.fn(async (operation, request, options) => {
      if (operation === "viewer_defaults" && request.source_id === second.id) {
        await new Promise<void>((resolve) => { releaseDefaults = resolve; });
      }
      if (operation === "run_recipe") return new Promise((resolve) => { releaseRun = () => resolve({}); });
      return original(operation, request, options);
    });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Analyze");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Segmentation input" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Segmentation input" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    expect(screen.getByRole("combobox", { name: "Segmentation input" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
    await act(async () => releaseRun());
    await waitFor(() => expect(screen.getByRole("button", { name: "Run recipe" })).toBeEnabled());
    fireEvent.click(document.querySelector<HTMLButtonElement>(`button[data-source-id="${second.id}"]`)!);
    await waitFor(() => expect(releaseDefaults).toBeDefined());
    expect(screen.getByRole("combobox", { name: "Segmentation input" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run recipe" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Segmentation input" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    expect(vi.mocked(bridge.execute).mock.calls.filter(([operation]) => operation === "run_recipe")).toHaveLength(1);
    await act(async () => releaseDefaults());
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Segmentation input" })).toBeEnabled());
    expect(screen.getByRole("combobox", { name: "Segmentation input" })).toHaveValue("0");
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("run_recipe", expect.objectContaining({
      source_id: second.id, selection: expect.objectContaining({ c: 0, z: 1, t: 0 }),
      recipe: expect.objectContaining({ measurement_channels: [0] }),
    })));
    await act(async () => releaseRun());
  });

  it("requires an explicit generic RGB intensity conversion without assuming histology", async () => {
    const rgb = structuredClone(snapshot);
    rgb.sources[0].metadata.sample_semantics = "RGB";
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(rgb) });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Analyze", "Analyze");
    expect(screen.queryByLabelText("Stain basis")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Measurement channel")).not.toBeInTheDocument();
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
      "0.15",
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
    expect(screen.getByLabelText("Stain minimum object size")).toHaveValue("10");
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
    expect(screen.getByText("Maximum stain coordinate > threshold", { exact: true })).toBeVisible();
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
      reference_qualification: { compatible: true, package_sha256: "9".repeat(64) },
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
    expect(screen.getByText("Reference check passed.")).toBeVisible();
    const exactRecord = screen.getByText(JSON.stringify(model.reference_qualification));
    expect(exactRecord.closest("details")).not.toHaveAttribute("open");
    expect(exactRecord).not.toBeVisible();
    fireEvent.click(exactRecord.closest("details")!.querySelector("summary")!);
    expect(exactRecord).toBeVisible();
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
    fireEvent.click(await screen.findByText("Save preview as result"));
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
    const pendingPreview = await screen.findByText("Preview ready to save as a result.");
    expect(pendingPreview).toBeVisible();
    expect(pendingPreview).toHaveAttribute("data-model-preview-id", "f".repeat(32));
    expect(pendingPreview).toHaveAttribute("data-model-preview-sha256", "1".repeat(64));
    fireEvent.change(screen.getByLabelText("Model threshold"), {
      target: { value: "0.7" },
    });
    await waitFor(() =>
      expect(screen.getByText("Save preview as result")).toBeDisabled(),
    );
  });
  it("submits exact folder batch IDs in working order with the selected recipe settings", async () => {
    const study = structuredClone(snapshot);
    const paths = ["FBS/Preview.tif", "SFM/Preview.tif", "FBS/Second.tif"];
    study.sources = paths.map((path, index) => ({ ...structuredClone(snapshot.sources[0]),
      id: String(index + 1).repeat(32), sha256: String(index + 4).repeat(64), name: path.split("/").at(-1)!,
      browser_location: { relative_path: path, root: null } }));
    study.results = [];
    const bridge = api({ getSnapshot: vi.fn(async () => study), execute: vi.fn(async () => ({ result: { id: "9".repeat(32) } })) });
    const { container } = render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
    fireEvent.change(await screen.findByLabelText("Recipe memory allowance"), { target: { value: String(2 * 1024 ** 3) } });
    fireEvent.change(screen.getByLabelText("Threshold"), { target: { value: "73" } });
    fireEvent.blur(screen.getByLabelText("Threshold"));
    await openTool("Results", "Study");
    fireEvent.click(screen.getByRole("checkbox", { name: "Include folder FBS in batch" }));
    expect(screen.getByRole("checkbox", { name: "Include SFM/Preview.tif in batch" })).not.toBeChecked();
    const selectedLeaves = container.querySelectorAll('button[data-source-id][aria-selected="true"]');
    expect([...selectedLeaves].map(leaf => leaf.getAttribute("data-source-id"))).toEqual([study.sources[0].id]);
    fireEvent.click(screen.getByRole("button", { name: "Run selected sources sequentially" }));
    await waitFor(() => expect(bridge.submitBatch).toHaveBeenCalledOnce());
    const tasks = vi.mocked(bridge.submitBatch!).mock.calls[0][0];
    expect(tasks.map(task => task.source)).toEqual([study.sources[0], study.sources[2]].map(({ id, sha256 }) => ({ id, sha256 })));
    expect(tasks.map(task => task.request.source_id)).toEqual([study.sources[0].id, study.sources[2].id]);
    for (const task of tasks) expect(task.request.recipe).toEqual(expect.objectContaining({
      working_bytes: 2 * 1024 ** 3, segmentation: expect.objectContaining({ threshold: 73 }),
    }));
    expect(tasks[0].request.recipe).toEqual(tasks[1].request.recipe);
    expect(tasks[0].request.selection).toEqual(tasks[1].request.selection);
    await waitFor(() => expect(bridge.runBatchJob).toHaveBeenCalledTimes(2));
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
  it("exports a pending review package without marking results reviewed", async () => {
    const study = structuredClone(snapshot);
    study.results[0].review = { disposition: "pending" };
    const exportReviewPackage = vi.fn().mockResolvedValue({
      schema: "loci.review-package-receipt/v1", status: "provisional-review-material",
      basename: "Synthetic RGB collection", image_count: 1,
      manifest_sha256: "e".repeat(64), summary_name: "counts.csv",
    });
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(study), exportReviewPackage });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await openTool("Results", "Study");
    fireEvent.click(screen.getByLabelText("Compare " + study.results[0].id));
    expect(screen.getByText("Export selected reviewed results")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Review package name"), {
      target: { value: "Synthetic RGB collection" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Export review package$/ }));
    await waitFor(() => expect(exportReviewPackage).toHaveBeenCalledWith([{
      source_id: study.sources[0].id, source_sha256: study.sources[0].sha256,
      result_id: study.results[0].id, revision_hash: study.results[0].revision_hash,
    }], { rootLabel: "Synthetic RGB collection" }));
    expect(await screen.findByText(/Saved 1 images and counts.csv/)).toBeVisible();
    expect(bridge.reviewResult).not.toHaveBeenCalled();
    expect(screen.getByText("Export selected reviewed results")).toBeDisabled();
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
    const receipt = screen.getByRole("region", { name: "Study run comparison receipt" });
    const technicalRecord = within(receipt).getByText("Technical record").closest("details")!;
    expect(technicalRecord).not.toHaveAttribute("open");
    fireEvent.click(within(receipt).getByText("Technical record"));
    expect(within(receipt).getByText(/Receipt: 9999999999999999/)).toBeVisible();
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
      if (operation === "result") return Promise.resolve(resultPage(request, snapshot.results));
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
    await screen.findByText(/Label fingerprint/);
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

  it("keeps a superseded history plane quiet while the current correction request waits in the real viewer queue", async () => {
    let release!: () => void;
    const decoding = new Promise<void>(resolve => { release = resolve; });
    const queue = new ViewerRequestQueue(async (operation, value) => {
      if (operation === "viewer_tile") { await decoding; return {}; }
      const request = value as Record<string, unknown>;
      return { ...resultView(snapshot.results[0], "z", Number(request.index ?? 1)),
        image: `data:image/png;base64,z${Number(request.index ?? 1)}` };
    });
    const active = queue.request("viewer_tile", {});
    const execute = vi.fn((operation: string, request: Record<string, unknown>) => {
      if (operation === "view") return Promise.resolve({ image: "data:image/png;base64,source" });
      if (operation === "result") return Promise.resolve(resultPage(request, snapshot.results));
      if (operation === "result_view") return queue.request(operation, request);
      if (operation === "correction_info") return Promise.resolve(correctionInfo());
      return Promise.resolve({});
    });
    render(<ResearchWorkbench api={api({ execute })} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Annotate", "Correction");
    await waitFor(() => expect(execute.mock.calls.filter(([operation]) => operation === "result_view")).toHaveLength(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { release(); await active; });
    expect(await screen.findByAltText("Exact selected result revision")).toHaveAttribute("src", "data:image/png;base64,z0");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["Current decoder failed.", "View superseded by a newer request."])(
    "keeps a current correction-plane failure visible: %s", async (failure) => {
      const execute = vi.fn((operation: string, request: Record<string, unknown>) => {
        if (operation === "view") return Promise.resolve({ image: "data:image/png;base64,source" });
        if (operation === "result") return Promise.resolve(resultPage(request, snapshot.results));
        if (operation === "result_view") return request.index === undefined
          ? Promise.resolve(resultView()) : Promise.reject(new Error(failure));
        if (operation === "correction_info") return Promise.resolve(correctionInfo());
        return Promise.resolve({});
      });
      render(<ResearchWorkbench api={api({ execute })} onBack={vi.fn()} />);
      await selectHistoryResult();
      await openTool("Annotate", "Correction");
      expect(await screen.findByRole("alert")).toHaveTextContent(failure);
      expect(screen.queryByAltText("Exact selected result revision")).not.toBeInTheDocument();
    },
  );

  it("keeps a current history-plane failure visible", async () => {
    const execute = vi.fn((operation: string, request: Record<string, unknown>) => {
      if (operation === "view") return Promise.resolve({ image: "data:image/png;base64,source" });
      if (operation === "result") return Promise.resolve(resultPage(request, snapshot.results));
      if (operation === "result_view") return Promise.reject(new Error("Current history decoder failed."));
      return Promise.resolve({});
    });
    render(<ResearchWorkbench api={api({ execute })} onBack={vi.fn()} />);
    await selectHistoryResult();
    expect(await screen.findByRole("alert")).toHaveTextContent("Current history decoder failed.");
  });

  it("ignores a failed correction-plane request after its effect scope is abandoned", async () => {
    let rejectPlane!: (error: Error) => void;
    const plane = new Promise((_, reject) => { rejectPlane = reject; });
    const execute = vi.fn((operation: string, request: Record<string, unknown>) => {
      if (operation === "view") return Promise.resolve({ image: "data:image/png;base64,source" });
      if (operation === "result") return Promise.resolve(resultPage(request, snapshot.results));
      if (operation === "result_view") return request.index === undefined
        ? Promise.resolve(resultView()) : plane;
      if (operation === "correction_info") return Promise.resolve(correctionInfo());
      return Promise.resolve({});
    });
    render(<ResearchWorkbench api={api({ execute })} onBack={vi.fn()} />);
    await selectHistoryResult();
    await openTool("Annotate", "Correction");
    await waitFor(() => expect(execute).toHaveBeenCalledWith("result_view", expect.objectContaining({ index: 0 })));
    await openTool("View", "Display");
    await act(async () => { rejectPlane(new Error("Abandoned correction decoder failed.")); await Promise.resolve(); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
          return Promise.resolve(resultPage(request, [...snapshot.results, child]));
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
    await screen.findByText(/Label fingerprint/);
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

  it("clears a previous recipe refusal when the researcher retries with a larger allowance", async () => {
    let attempts = 0;
    const execute = vi.fn(async (operation: string) => {
      if (operation === "run_recipe" && ++attempts === 1)
        throw new Error("Recipe estimate exceeds its allowance");
      return {};
    });
    render(<ResearchWorkbench api={api({ execute })} onBack={vi.fn()} />);
    await openTool("Analyze", "Analyze");
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Recipe estimate exceeds its allowance");
    fireEvent.change(screen.getByLabelText("Recipe memory allowance"), { target: { value: String(1024 ** 3) } });
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("run_recipe", expect.objectContaining({
      recipe: expect.objectContaining({ working_bytes: 1024 ** 3 }),
    })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
          return Promise.resolve(resultPage(request, changed.results));
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
    fireEvent.click(screen.getByRole("button", { name: "Other source" }));
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
      await screen.findByText("Select a segmentation result to edit its labels or ROIs."),
    ).toBeVisible();
    expect(screen.queryByText(/Label fingerprint/)).not.toBeInTheDocument();
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
          return Promise.resolve(resultPage(request, [...snapshot.results, child]));
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
    await screen.findByText(/Label fingerprint/);
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
        if (operation === "result") return Promise.resolve(resultPage(request, [...snapshot.results, child]));
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
    await screen.findByText(/Label fingerprint/);
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
  it.each([undefined, 0])("binds result-overlay viewing to an explicit display channel when persisted c is %s", async (persistedChannel) => {
    const active = structuredClone(snapshot);
    const source = active.sources[0];
    source.source_kind = "native";
    source.metadata.dimensions!.t = 3;
    source.metadata.levels![0].dimensions.t = 3;
    const planeGeometry = { axes: "YX", unit: "pixel", frame: "image",
      affine: [[1, 0, 0, 10], [0, 1, 0, 20], [0, 0, 1, 0], [0, 0, 0, 1]] };
    const result = active.results[0];
    result.kind = persistedChannel === undefined ? "model-segmentation" : "segmentation";
    result.source_sha256 = source.sha256;
    result.selection = { x: 10, y: 20, width: 12, height: 8, z: 0, t: 2, c: 0, level: 0 };
    // Managed model selections deliberately omit c: their input is channel-mapped.
    if (persistedChannel === undefined) delete (result.selection as Partial<ResearchSelection>).c;
    const persistedSelection = structuredClone(result.selection);
    result.geometry = planeGeometry;
    result.arrays = { image: { shape: [8, 12], dtype: "float64" } };
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active), execute: vi.fn(async (operation, request) => {
      if (operation === "result") return resultPage(request, active.results);
      if (operation === "result_view") return { ...resultView(result, "z", 0, [8, 12]),
        image: "data:image/png;base64,result#viewer-12x8", geometry: planeGeometry };
      return {};
    }) });
    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    const viewer = await screen.findByLabelText("Image viewer: Specimen");
    const channel = screen.getByLabelText("C", { exact: true });
    fireEvent.change(channel, { target: { value: "1" } });
    fireEvent.keyDown(channel, { key: "Enter" });
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("viewer_tile",
      expect.objectContaining({ overview: true, c: 1 }), expect.anything()));
    await waitFor(() => expect(viewer).toHaveAttribute("data-prepared", "true"));
    vi.mocked(bridge.execute).mockClear();
    await selectHistoryResult(persistedChannel === undefined ? /^Model segmentation,/i : /^Segmentation,/i);
    await waitFor(() => expect(viewer).toHaveAttribute("data-result-overlay", `${result.id}:${result.revision_hash}`));
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith("viewer_tile",
      expect.objectContaining({ overview: true, t: 2, z: 0, c: persistedChannel ?? 1 }), expect.anything()));
    await waitFor(() => expect(viewer).toHaveAttribute("data-prepared", "true"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(result.selection).toEqual(persistedSelection);
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
    const bridge = api({ getSnapshot: vi.fn().mockResolvedValue(active), execute: vi.fn(async (operation, request) => {
      if (operation === "result") return resultPage(request, active.results, [{ label: 1, centroid_index: [2.5, 3.25] }]);
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
        if (operation === "result") return Promise.resolve(resultPage(request, active.results));
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
    await screen.findByText(/Label fingerprint/);
    await waitFor(() => expect(viewer).toHaveAttribute("data-result-overlay",
      `${original.id}:${original.revision_hash}`));
    const canvas = screen.getByLabelText("Source image and bound annotations");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const camera = viewer.getAttribute("data-camera");

    fireEvent.click(screen.getByRole("button", { name: /Corrected segmentation/ }));
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
          return Promise.resolve(resultPage(request, changed.results));
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
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    expect(
      await screen.findByText("Select a segmentation result to edit its labels or ROIs."),
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
          return Promise.resolve(resultPage(request, revised.results));
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
    await selectHistoryResult(/Corrected segmentation/);
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
      if (operation === "result") return Promise.resolve(resultPage(request, changed.results));
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

    // Show useful operation labels while keeping exact IDs in the cancel request.
    expect(screen.getByText("Analysis")).toBeInTheDocument();
    expect(screen.getByText("Classical segmentation")).toBeInTheDocument();
    expect(screen.queryByText("#job-runn")).not.toBeInTheDocument();
    expect(screen.queryByText("#job-comp")).not.toBeInTheDocument();

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

  it("exposes task headers and analysis controls to keyboard focus", async () => {
    const desktop = api();
    const { container } = render(<ResearchWorkbench api={desktop} onBack={vi.fn()} />);
    await screen.findByLabelText("Image viewer: Specimen");

    // Verify the inspector and sticky tools header exist
    const inspector = container.querySelector(".research-inspector");
    expect(inspector).toBeInTheDocument();
    const toolsHeader = container.querySelector(".workbench-tools");
    expect(toolsHeader).toBeInTheDocument();

    // Verify task group buttons are present and keyboard accessible
    const analyzeGroup = screen.getByRole("button", { name: "Analyze" });
    expect(analyzeGroup).toBeInTheDocument();

    analyzeGroup.focus();
    expect(analyzeGroup).toHaveFocus();
    fireEvent.click(analyzeGroup);
    expect(analyzeGroup).toHaveAttribute("aria-pressed", "true");

    // Open Analyze tool dropdown
    const toolSelect = await screen.findByRole("combobox", { name: "Analyze tool" });
    expect(toolSelect).toBeInTheDocument();
    toolSelect.focus();
    expect(toolSelect).toHaveFocus();

    // Verify analysis scope control buttons are reachable and interactive
    const wholeImageBtn = screen.getByRole("button", { name: "Whole image" });
    expect(wholeImageBtn).toBeInTheDocument();
    wholeImageBtn.focus();
    expect(wholeImageBtn).toHaveFocus();
    fireEvent.click(wholeImageBtn);

    const drawRegionBtn = screen.getByRole("button", { name: "Draw region" });
    expect(drawRegionBtn).toBeInTheDocument();
    drawRegionBtn.focus();
    expect(drawRegionBtn).toHaveFocus();
  });
});
