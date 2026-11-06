// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench from "./ResearchWorkbench";
import type {
  ResearchDesktopApi,
  ResearchJob,
  ResearchResult,
  ResearchSelection,
  ResearchSnapshot,
  ResearchSource,
} from "../shared/research-contracts";

const hash = "a".repeat(64);
const sourceId = "b".repeat(32);
const secondSourceId = "f".repeat(32);
const previewJobId = "c".repeat(32);
const runJobId = "1".repeat(32);
const previewId = "d".repeat(32);
const resultId = "e".repeat(32);
const pngDataUrl = "data:image/png;base64,AAAA";

const defaultSelection: ResearchSelection = {
  x: 0,
  y: 0,
  width: 1024,
  height: 1024,
  c: 0,
  z: 0,
  t: 0,
  level: 0,
};

const source: ResearchSource = {
  id: sourceId,
  sha256: hash,
  name: "Specimen RGB",
  source_kind: "native",
  metadata: {
    selected_series: 0,
    dimensions: { x: 1024, y: 1024, c: 1, s: 3, z: 1, t: 1 },
    levels: [{ index: 0, dimensions: { x: 1024, y: 1024, c: 1, s: 3, z: 1, t: 1 } }],
    sample_semantics: "RGB",
    channel_dtypes: ["uint8"],
    channel_names: ["RGB"],
  },
};

const secondSource: ResearchSource = {
  ...structuredClone(source),
  id: secondSourceId,
  name: "Second Specimen",
};

function makeSnapshot({
  projectId = "study-1",
  title = "Study 1",
  sources = [source],
  results = [],
  jobs = [],
}: {
  projectId?: string;
  title?: string;
  sources?: ResearchSource[];
  results?: ResearchResult[];
  jobs?: ResearchJob[];
} = {}): ResearchSnapshot {
  return {
    project: {
      project_id: projectId,
      title,
      first_study: { example_id: "", source_id: "", source_sha256: "" },
    },
    sources,
    results,
    jobs,
    samples: [],
    recipes: [],
    displays: [],
    selections: [],
    operations: {
      view: { mutates: false, summary: "view" },
      volume_view: { mutates: false, summary: "volume" },
      preview_recipe: { mutates: false, summary: "preview" },
      run_recipe: { mutates: true, summary: "run" },
      result: { mutates: false, summary: "result" },
      sample: { mutates: true, summary: "sample" },
    },
    workspace: { revision: 1, closed_sources: [], hidden_results: [] },
  };
}

const mockCatalogue = {
  profiles: [{
    profile: {
      schema: "loci.tissue-model-profile/v1",
      id: "puma-tissue-cpu",
      contract_sha256: hash,
      model: { sha256: hash, bytes: 123, conversion_receipt_sha256: hash },
      input: { rgb_policy: "puma-first-three-samples", maximum_context_edge: 1024 },
      runtime: { device: "cpu" },
      resources: { minimum_working_bytes: 2 * 1024 ** 3, maximum_working_bytes: 8 * 1024 ** 3 },
      selected_compartment: { class_id: 4, name: "epidermis" },
    },
    store: {
      schema: "loci.puma-store-status/v1",
      profile_id: "puma-tissue-cpu",
      profile_contract_sha256: hash,
      weights_sha256: hash,
      weights_bytes: 123,
      conversion_receipt_sha256: hash,
      state: "verified",
      provisioned: true,
      files_verified: true,
      runtime_compatibility: "not-established",
      scientific_qualification: "not-established",
      model_execution_performed: false,
      execution_authority: false,
    },
    runtime: {
      status: "metadata-matches-unverified",
      runtime_import_verified: false,
      technical_compatibility_verified: false,
      missing: [],
      mismatched: [],
      expected: { torch: "fixture" },
    },
  }],
};

function makeCompletedJob(
  id: string,
  operation: string,
  taskRequest: unknown,
  resultIds: string[] = [],
  targetSourceId = sourceId,
): ResearchJob {
  return {
    id,
    operation,
    state: "succeeded",
    cancel_requested: false,
    result_ids: resultIds,
    request_key: `key-${id.slice(0, 6)}`,
    request_hash: hash,
    created_at: "2026-10-31T05:00:00Z",
    updated_at: "2026-10-31T05:00:01Z",
    progress: 1,
    error: null,
    request: { source_id: targetSourceId, task_request: taskRequest },
  };
}

function makePreviewResponse(request: Record<string, unknown>) {
  return {
    preview_id: previewId,
    preview_hash: hash,
    adopted: false,
    region_count: 2,
    selected_class: 4,
    entity_type: "tissue-region",
    scientific_review: "pending",
    overlay_png: pngDataUrl,
    context_selection: request.context_selection,
    output_selection: request.output_selection,
    job: makeCompletedJob(previewJobId, "tissue_model_preview", request),
  };
}

function makeTissueResult(): ResearchResult {
  return {
    id: resultId,
    revision_hash: hash,
    source_id: sourceId,
    source_sha256: hash,
    kind: "tissue-model-regions",
    created_at: "2026-10-31T05:00:02Z",
    object_count: 2,
    selection: defaultSelection,
    geometry: {
      axes: "YX",
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      unit: "pixel",
    },
    tissue_model: {
      schema: "loci.puma-tissue-result/v1",
      label_semantics: "original_selected_compartment",
      preview: { preview_id: previewId, preview_hash: hash },
    },
    arrays: {
      image: { dtype: "float32", shape: [1024, 1024], sha256: hash },
      labels: { dtype: "uint32", shape: [1024, 1024], sha256: hash },
      class_labels: { dtype: "uint8", shape: [1024, 1024], sha256: hash },
      probabilities: { dtype: "float32", shape: [6, 1024, 1024], sha256: hash },
    },
  };
}

function baseExecuteResponse(op: string, req: Record<string, unknown> = {}) {
  const activeSourceId = typeof req.source_id === "string" ? req.source_id : sourceId;
  if (op === "tissue_model_profiles") return mockCatalogue;
  if (op === "viewer_defaults") {
    return {
      source_id: activeSourceId,
      source_sha256: hash,
      basis: "Source acquisition range",
      channels: [{
        channel: 0,
        low: 0,
        high: 255,
        gamma: 1,
        color: "#ffffff",
        opacity: 1,
        visible: true,
      }],
    };
  }
  if (op === "source_annotations") {
    return { source_id: activeSourceId, source_sha256: hash, annotations: [] };
  }
  if (op === "source_view") {
    return { source_id: activeSourceId, source_sha256: hash, revision: 0, state: null };
  }
  if (op === "save_source_view") {
    return {
      source_id: activeSourceId,
      source_sha256: hash,
      revision: Number(req.expected_revision ?? 0) + 1,
      state: req.state ?? null,
    };
  }
  if (op === "view") {
    return { image: pngDataUrl };
  }
  if (op === "result") {
    const res = makeTissueResult();
    return {
      result: res,
      measurements: [
        { label: 1, area_px: 120, intensity: {} },
        { label: 2, area_px: 80, intensity: {} },
      ],
    };
  }
  if (op === "result_view") {
    return {
      image: pngDataUrl,
      shape: [1024, 1024],
      result_id: resultId,
      revision_hash: hash,
      axis: req.axis ?? "z",
      index: req.index ?? 0,
      label_field: req.label_field ?? "compartments",
      label_field_basis: "original-model",
      geometry: makeTissueResult().geometry,
    };
  }
  return {};
}

async function openEpidermisModelAndDeclareStain() {
  await screen.findByRole("button", { name: /Specimen RGB/ });
  fireEvent.click(screen.getByRole("button", { name: "Search all tools" }));
  const search = screen.getByRole("combobox", { name: "Search all tools" });
  fireEvent.change(search, { target: { value: "Epidermis" } });
  fireEvent.click(await screen.findByRole("option", { name: "Epidermis model" }));
  await screen.findByText("Exact file identities verified");
  fireEvent.change(screen.getByLabelText("Tissue preparation"), {
    target: { value: "hematoxylin-eosin" },
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Preview candidate mask" })).toBeEnabled();
  });
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    ellipse: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 1024;
      naturalHeight = 1024;
      private value = "";
      set src(value: string) {
        this.value = value;
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

describe("ResearchWorkbench tissue operation lifecycle", () => {
  it("starts with empty jobs, enables polling on busy, displays running state, and recovers cleanly after cancellation", async () => {
    let currentSnapshot = makeSnapshot({ jobs: [] });
    let rejectPreview!: (error: Error) => void;
    let previewShouldBlock = true;

    const getSnapshot = vi.fn(async () => currentSnapshot);
    const cancelJob = vi.fn(async () => {});
    const execute = vi.fn(async (op: string, req: Record<string, unknown> = {}) => {
      if (op === "tissue_model_preview") {
        if (previewShouldBlock) {
          return await new Promise<unknown>((_resolve, reject) => {
            rejectPreview = reject;
          });
        }
        return makePreviewResponse(req);
      }
      return baseExecuteResponse(op, req);
    });

    const api = {
      getSnapshot,
      cancelJob,
      execute,
      reviewResult: vi.fn(async () => {}),
      exportResult: vi.fn(async () => {}),
    } as unknown as ResearchDesktopApi;

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    await openEpidermisModelAndDeclareStain();

    expect(currentSnapshot.jobs).toHaveLength(0);

    // Start in-flight preview; busy === "tissue-model" enables snapshot polling
    fireEvent.click(screen.getByRole("button", { name: "Preview candidate mask" }));
    expect(screen.getByRole("button", { name: "Computing preview…" })).toBeDisabled();

    const runningJob: ResearchJob = {
      id: previewJobId,
      operation: "tissue_model_preview",
      state: "running",
      cancel_requested: false,
      result_ids: [],
      request_key: "key-preview-1",
      request_hash: hash,
      created_at: "2026-10-31T05:00:00Z",
      updated_at: "2026-10-31T05:00:00Z",
      progress: 0,
      error: null,
      request: { source_id: sourceId },
    };
    currentSnapshot = makeSnapshot({ jobs: [runningJob] });

    // Open Job Center and wait for polling to surface the running preview job
    fireEvent.click(screen.getByRole("button", { name: /Jobs/ }));
    await waitFor(() => {
      expect(screen.getByText(/tissue model preview/i)).toBeInTheDocument();
    }, { timeout: 3000 });
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(cancelBtn).toBeEnabled();

    // Cancel the running job and settle the cancelled in-flight RPC
    fireEvent.click(cancelBtn);
    expect(cancelJob).toHaveBeenCalledWith(previewJobId);

    const cancelledJob: ResearchJob = {
      ...runningJob,
      state: "cancelled",
      cancel_requested: true,
    };
    currentSnapshot = makeSnapshot({ jobs: [cancelledJob] });
    await act(async () => {
      rejectPreview(new Error("Tissue model preview was cancelled."));
    });

    // Panel recovers from cancellation: no preview adopted, Create remains disabled, Preview re-enables
    expect(await screen.findByRole("alert")).toHaveTextContent("Tissue model preview was cancelled.");
    expect(screen.queryByAltText("Exact source-region preview with candidate epidermis overlay")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create result from preview" })).toBeDisabled();
    const recoveredPreviewBtn = screen.getByRole("button", { name: "Preview candidate mask" });
    expect(recoveredPreviewBtn).toBeEnabled();

    // Subsequent preview after cancellation succeeds cleanly
    previewShouldBlock = false;
    fireEvent.click(recoveredPreviewBtn);
    expect(await screen.findByAltText("Exact source-region preview with candidate epidermis overlay")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create result from preview" })).toBeEnabled();
  });

  it("completes preview and durable adoption, refreshing snapshot and loading the published tissue result", async () => {
    let currentSnapshot = makeSnapshot({ jobs: [], results: [] });
    const getSnapshot = vi.fn(async () => currentSnapshot);
    const execute = vi.fn(async (op: string, req: Record<string, unknown> = {}) => {
      if (op === "tissue_model_preview") {
        const response = makePreviewResponse(req);
        currentSnapshot = makeSnapshot({ jobs: [response.job], results: [] });
        return response;
      }
      if (op === "tissue_model_run") {
        const adoptedResult = makeTissueResult();
        const runJob = makeCompletedJob(runJobId, "tissue_model_run", req, [adoptedResult.id]);
        currentSnapshot = makeSnapshot({
          jobs: [...currentSnapshot.jobs, runJob],
          results: [adoptedResult],
        });
        return {
          adopted: true,
          result: adoptedResult,
          region_count: 2,
          job: runJob,
        };
      }
      return baseExecuteResponse(op, req);
    });

    const api = {
      getSnapshot,
      execute,
      reviewResult: vi.fn(async () => {}),
      exportResult: vi.fn(async () => {}),
    } as unknown as ResearchDesktopApi;

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    await openEpidermisModelAndDeclareStain();

    // 1. Run preview to completion; onBusyChange(false) refreshes snapshot
    fireEvent.click(screen.getByRole("button", { name: "Preview candidate mask" }));
    expect(await screen.findByAltText("Exact source-region preview with candidate epidermis overlay")).toBeInTheDocument();
    const createBtn = screen.getByRole("button", { name: "Create result from preview" });
    expect(createBtn).toBeEnabled();

    // Verify Job Center shows the completed preview job from the completion refresh
    fireEvent.click(screen.getByRole("button", { name: /Jobs/ }));
    await waitFor(() => {
      expect(screen.getByText(/tissue model preview/i)).toBeInTheDocument();
    });

    // 2. Adopt preview into a durable result; onPublished refreshes snapshot and loads the result
    fireEvent.click(createBtn);
    expect(await screen.findByRole("heading", { name: "Saved epidermis candidate" })).toBeInTheDocument();
    expect(screen.getByText(/2 tissue regions · revision aaaaaaaa/)).toBeInTheDocument();
    expect(execute).toHaveBeenCalledWith("tissue_model_run", {
      preview_id: previewId,
      preview_hash: hash,
    });
    expect(execute).toHaveBeenCalledWith("result", expect.objectContaining({ result_id: resultId }));
  });

  it("adopts a delayed completion snapshot refresh after a tissue preview finishes", async () => {
    const initial = makeSnapshot({ jobs: [], results: [] });
    let resolveDelayedRefresh!: (value: ResearchSnapshot) => void;
    let interceptCompletionRefresh = false;
    let completedSnapshot: ResearchSnapshot = initial;

    const getSnapshot = vi.fn(() => {
      if (interceptCompletionRefresh) {
        return new Promise<ResearchSnapshot>((resolve) => {
          resolveDelayedRefresh = resolve;
        });
      }
      return Promise.resolve(initial);
    });

    const execute = vi.fn(async (op: string, req: Record<string, unknown> = {}) => {
      if (op === "tissue_model_preview") {
        const response = makePreviewResponse(req);
        completedSnapshot = makeSnapshot({ jobs: [response.job], results: [] });
        interceptCompletionRefresh = true;
        return response;
      }
      return baseExecuteResponse(op, req);
    });

    const api = {
      getSnapshot,
      execute,
      reviewResult: vi.fn(async () => {}),
      exportResult: vi.fn(async () => {}),
    } as unknown as ResearchDesktopApi;

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    await openEpidermisModelAndDeclareStain();

    fireEvent.click(screen.getByRole("button", { name: "Preview candidate mask" }));
    expect(await screen.findByAltText("Exact source-region preview with candidate epidermis overlay")).toBeInTheDocument();
    await waitFor(() => expect(resolveDelayedRefresh).toBeTypeOf("function"));

    // Open Job Center while completion refresh is still in-flight: job not yet present
    fireEvent.click(screen.getByRole("button", { name: /Jobs/ }));
    expect(screen.queryByText(/tissue model preview/i)).not.toBeInTheDocument();

    // Resolve the delayed completion refresh and verify the snapshot updates
    interceptCompletionRefresh = false;
    await act(async () => {
      resolveDelayedRefresh(completedSnapshot);
    });
    await waitFor(() => {
      expect(screen.getByText(/tissue model preview/i)).toBeInTheDocument();
    });
  });

  it("rejects stale tissue completion and delayed snapshot refresh after switching studies", async () => {
    const study1Snapshot = makeSnapshot({
      projectId: "study-1",
      title: "Study 1",
      sources: [source],
      jobs: [],
      results: [],
    });
    const study2Snapshot = makeSnapshot({
      projectId: "study-2",
      title: "Study 2",
      sources: [secondSource],
      jobs: [],
      results: [],
    });

    let activeStudySnapshot = study1Snapshot;
    let interceptStudy1CompletionRefresh = false;
    let resolveStaleStudy1Refresh!: (value: ResearchSnapshot) => void;
    let staleStudy1CompletedSnapshot!: ResearchSnapshot;

    const getSnapshot = vi.fn(() => {
      if (interceptStudy1CompletionRefresh) {
        interceptStudy1CompletionRefresh = false;
        return new Promise<ResearchSnapshot>((resolve) => {
          resolveStaleStudy1Refresh = resolve;
        });
      }
      return Promise.resolve(activeStudySnapshot);
    });

    const execute = vi.fn(async (op: string, req: Record<string, unknown> = {}) => {
      if (op === "tissue_model_preview") {
        const response = makePreviewResponse(req);
        staleStudy1CompletedSnapshot = makeSnapshot({
          projectId: "study-1",
          title: "Study 1",
          sources: [source],
          jobs: [response.job],
          results: [makeTissueResult()],
        });
        interceptStudy1CompletionRefresh = true;
        return response;
      }
      return baseExecuteResponse(op, req);
    });

    const openStudy = vi.fn(async () => {
      activeStudySnapshot = study2Snapshot;
      return study2Snapshot;
    });

    const api = {
      getSnapshot,
      execute,
      openStudy,
      reviewResult: vi.fn(async () => {}),
      exportResult: vi.fn(async () => {}),
    } as unknown as ResearchDesktopApi;

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    await openEpidermisModelAndDeclareStain();

    // Complete a real tissue preview on Study 1 whose completion getSnapshot() remains in-flight
    fireEvent.click(screen.getByRole("button", { name: "Preview candidate mask" }));
    expect(await screen.findByAltText("Exact source-region preview with candidate epidermis overlay")).toBeInTheDocument();
    await waitFor(() => expect(resolveStaleStudy1Refresh).toBeTypeOf("function"));

    // Switch to Study 2 BEFORE Study 1's completion refresh resolves
    fireEvent.click(screen.getByText("File"));
    fireEvent.click(screen.getByRole("button", { name: "Open study" }));
    await waitFor(() => expect(openStudy).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(screen.getByLabelText("Active image")).toHaveTextContent("Second Specimen");
    });

    // Now resolve the stale Study 1 completion snapshot
    await act(async () => {
      resolveStaleStudy1Refresh(staleStudy1CompletedSnapshot);
    });

    // Study 2 must remain intact and reject Study 1's stale job and result
    expect(screen.getByLabelText("Active image")).toHaveTextContent("Second Specimen");
    expect(screen.queryByRole("heading", { name: "Saved epidermis candidate" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Jobs/ }));
    expect(screen.queryByText(/tissue model preview/i)).not.toBeInTheDocument();
  });
});
