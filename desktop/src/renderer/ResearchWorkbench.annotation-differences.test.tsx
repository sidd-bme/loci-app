// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench from "./ResearchWorkbench";
import type {
  ResearchAgentSessionsSnapshot,
  ResearchDesktopApi,
  ResearchResult,
  ResearchSelection,
  ResearchSnapshot,
  ResearchSource,
} from "../shared/research-contracts";
import engineFixture from "./__fixtures__/agent-sessions-snapshot.json";

const capturedViewportProps: Array<{
  resultOverlay?: { key: string; left: number; top: number; width: number; height: number } | null;
  resultCentroid?: { u: number; v: number } | null;
  controlledCamera?: { x: number; y: number; scale: number } | null;
}> = [];

vi.mock("./ImageViewport", () => ({
  ImageViewport: (props: {
    source: ResearchSource;
    resultOverlay?: { key: string; left: number; top: number; width: number; height: number } | null;
    resultCentroid?: { u: number; v: number } | null;
    controlledCamera?: { x: number; y: number; scale: number } | null;
    onViewReady?: (key: string) => void;
    onResultRendered?: (key: string) => void;
  }) => {
    capturedViewportProps.push({
      resultOverlay: props.resultOverlay,
      resultCentroid: props.resultCentroid,
      controlledCamera: props.controlledCamera,
    });
    if (props.onViewReady) queueMicrotask(() => props.onViewReady!(`${props.source.id}:${props.source.sha256}:0:0`));
    if (props.resultOverlay && props.onResultRendered) {
      const key = props.resultOverlay.key;
      queueMicrotask(() => props.onResultRendered!(key));
    }
    return (
      <div
        data-testid="mock-viewport"
        data-source-id={props.source.id}
        data-result-overlay={props.resultOverlay?.key ?? ""}
        data-centroid={props.resultCentroid ? `${props.resultCentroid.u},${props.resultCentroid.v}` : ""}
        data-camera={props.controlledCamera ? `${props.controlledCamera.x},${props.controlledCamera.y},${props.controlledCamera.scale}` : ""}
      />
    );
  },
}));

const wire = engineFixture as ResearchAgentSessionsSnapshot;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=";
const SRC_A = "a".repeat(32);
const SHA_A = "a".repeat(64);
const SRC_B = "b".repeat(32);
const SHA_B = "b".repeat(64);
const PRED_ID = "c".repeat(32);
const PRED_REV = "c".repeat(64);
const PRED_LABELS_SHA = "1".repeat(64);
const REF_ID = "d".repeat(32);
const REF_REV = "d".repeat(64);
const REF_LABELS_SHA = "2".repeat(64);
const AGR_ID = "e".repeat(32);
const AGR_REV = "e".repeat(64);
const IMG_SHA = "3".repeat(64);

const dimensions = { x: 100, y: 80, z: 1, t: 1, c: 1 };
const selection: ResearchSelection = { x: 10, y: 20, width: 30, height: 24, c: 0, z: 0, t: 0, level: 0 };
const geometry = {
  axes: "YX",
  unit: "um",
  frame: "image",
  affine: [
    [2, 0, 0, 20],
    [0, 3, 0, 60],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ],
};

function makeSource(id: string, sha256: string, name: string, relink = false): ResearchSource {
  return {
    id,
    sha256,
    name,
    source_kind: "native",
    ...(relink ? { locator_state: "relink-required" as const } : {}),
    metadata: {
      axes: "YX",
      dimensions,
      levels: [{ index: 0, dimensions, calibration: { axes: "XY", spacing: [2, 3], unit: "um" } }],
      channel_names: ["DAPI"],
      channel_dtypes: ["uint16"],
      physical_calibration: { unit: "um", spacing: [2, 3] },
    },
  };
}

function makeResults(options?: { referenceKind?: string; tamperPredRevision?: boolean }) {
  const pred: ResearchResult = {
    schema: "loci.research-result/v1",
    id: PRED_ID,
    revision_hash: options?.tamperPredRevision ? "9".repeat(64) : PRED_REV,
    source_id: SRC_A,
    source_sha256: SHA_A,
    kind: "cellpose-segmentation",
    created_at: "2026-11-27T00:01:00Z",
    object_count: 3,
    selection,
    geometry,
    arrays: {
      image: { sha256: IMG_SHA, shape: [24, 30], dtype: "uint16" },
      labels: { sha256: PRED_LABELS_SHA, shape: [24, 30], dtype: "uint32" },
    },
  };
  const ref: ResearchResult = {
    schema: "loci.research-result/v1",
    id: REF_ID,
    revision_hash: REF_REV,
    source_id: SRC_A,
    source_sha256: SHA_A,
    kind: options?.referenceKind ?? "annotation-reference",
    created_at: "2026-11-27T00:01:30Z",
    object_count: 2,
    selection,
    geometry,
    arrays: {
      image: { sha256: IMG_SHA, shape: [24, 30], dtype: "uint16" },
      labels: { sha256: REF_LABELS_SHA, shape: [24, 30], dtype: "uint32" },
    },
  };
  const agreement = {
    schema: "loci.research-result/v1",
    id: AGR_ID,
    revision_hash: AGR_REV,
    parent_id: PRED_ID,
    source_id: SRC_A,
    source_sha256: SHA_A,
    kind: "annotation-agreement",
    created_at: "2026-11-27T00:02:00Z",
    object_count: 3,
    selection,
    geometry,
    arrays: {
      image: { sha256: IMG_SHA, shape: [24, 30], dtype: "uint16" },
      labels: { sha256: PRED_LABELS_SHA, shape: [24, 30], dtype: "uint32" },
      reference_labels: { sha256: REF_LABELS_SHA, shape: [24, 30], dtype: "uint32" },
    },
    annotation_evaluation: {
      schema: "loci.annotation-agreement/v1",
      semantics: "instances",
      reference_declaration: "Complete comparison crop declared reference.",
      inputs: {
        prediction: { result_id: PRED_ID, revision_hash: PRED_REV, labels_sha256: PRED_LABELS_SHA },
        reference: { result_id: REF_ID, revision_hash: REF_REV, labels_sha256: REF_LABELS_SHA },
      },
      metrics: {
        schema: "loci.annotation-agreement-kernel/v1",
        semantics: "instances",
        region: {
          prediction_pixels: 30,
          reference_pixels: 20,
          intersection_pixels: 10,
          union_pixels: 40,
          iou: 10 / 40,
          dice: 20 / 50,
          undefined_reasons: {},
        },
        instances: {
          prediction_count: 3,
          reference_count: 2,
          count_error_signed: 1,
          count_error_absolute: 1,
          count_error_relative: 0.5,
          undefined_reasons: {},
          split_reference_any_overlap: 0,
          merge_prediction_any_overlap: 0,
          scores: [
            {
              iou_threshold: 0.5,
              true_positive: 1,
              false_positive: 2,
              false_negative: 1,
              precision: 1 / 3,
              recall: 1 / 2,
              f1: 2 / 5,
              mean_matched_iou: 0.8,
              undefined_reasons: {},
              matches_count: 1,
              unmatched_reference_count: 1,
              unmatched_prediction_count: 2,
            },
          ],
        },
      },
    },
  } as ResearchResult;
  return { pred, ref, agreement };
}

function buildHarness(options?: {
  referenceKind?: string;
  tamperPredRevision?: boolean;
  offlineSource?: boolean;
  delayLocate?: boolean;
  differencePageBarrier?: Promise<void>;
}) {
  const { pred, ref, agreement } = makeResults(options);
  const srcA = makeSource(SRC_A, SHA_A, "Specimen A", options?.offlineSource);
  const srcB = makeSource(SRC_B, SHA_B, "Specimen B");
  const snapshot: ResearchSnapshot = {
    project: { title: "Difference Workflow Study", project_id: "0".repeat(32) },
    sources: [srcA, srcB],
    results: [pred, ref, agreement],
    jobs: [],
    samples: [],
    recipes: [],
    displays: [],
    selections: [],
    operations: {},
    agent_sessions: {
      ...wire,
      status: "connected_idle",
      pending_approval_count: 0,
      approvals: [],
      events: [
        {
          ...wire.events[0],
          id: "evt-agreement",
          approval_id: null,
          operation: "annotation_evaluation_run",
          kind: "task_completed",
          summary: "Saved annotation agreement ready",
          targets: [{ kind: "result", id: AGR_ID, revision_hash: AGR_REV, source_id: SRC_A, source_sha256: SHA_A }],
        },
      ],
      sessions: [
        {
          ...wire.sessions[0],
          state: "connected_idle",
          current_operation: null,
          recent_result_ids: [AGR_ID],
          active_approval_id: null,
        },
      ],
    },
  };

  let resolveDelayedLocate: ((value: unknown) => void) | null = null;
  const resultsById = new Map<string, ResearchResult>([
    [pred.id, pred],
    [ref.id, ref],
    [agreement.id, agreement],
  ]);

  const execute = vi.fn(async (op: string, req: Record<string, unknown>) => {
    if (op === "viewer_defaults") {
      const target = snapshot.sources.find((s) => s.id === req.source_id)!;
      if (target.locator_state === "relink-required") {
        throw new Error("Source file is offline and must be relinked.");
      }
      return {
        source_id: target.id,
        source_sha256: target.sha256,
        basis: "Source acquisition range",
        channels: [{ channel: 0, low: 0, high: 65535, gamma: 1, color: "#ffffff", opacity: 1, visible: true }],
      };
    }
    if (op === "source_view") {
      const target = snapshot.sources.find((s) => s.id === req.source_id)!;
      return { source_id: target.id, source_sha256: target.sha256, revision: 0, state: null };
    }
    if (op === "save_source_view") {
      const target = snapshot.sources.find((s) => s.id === req.source_id)!;
      return { source_id: target.id, source_sha256: target.sha256, revision: Number(req.expected_revision ?? 0) + 1, state: req.state };
    }
    if (op === "source_annotations") {
      const target = snapshot.sources.find((s) => s.id === req.source_id)!;
      return { source_id: target.id, source_sha256: target.sha256, revision: 0, annotations: [], can_undo: false, can_redo: false };
    }
    if (op === "result") {
      const res = resultsById.get(String(req.result_id));
      const measurements = res?.id === PRED_ID
        ? [{ label: 11, centroid_index: [4, 5], measure: 10, measure_kind: "area", measure_unit: "px" }]
        : [];
      return { result: res, measurements };
    }
    if (op === "result_view") {
      const res = resultsById.get(String(req.result_id))!;
      return {
        result_id: res.id,
        revision_hash: res.revision_hash,
        image: PNG,
        label_image: PNG,
        shape: [24, 30],
        axis: "z",
        index: 0,
        geometry,
      };
    }
    if (op === "annotation_evaluation_get") {
      if (req.table === "unmatched_prediction") {
        if (options?.differencePageBarrier) await options.differencePageBarrier;
        return { result_id: AGR_ID, revision_hash: AGR_REV, table: "unmatched_prediction", iou_threshold: 0.5, offset: 0, total: 2, rows: [11, 22] };
      }
      if (req.table === "unmatched_reference") {
        return { result_id: AGR_ID, revision_hash: AGR_REV, table: "unmatched_reference", iou_threshold: 0.5, offset: 0, total: 1, rows: [33] };
      }
      if (req.table === "matches") {
        return {
          result_id: AGR_ID,
          revision_hash: AGR_REV,
          table: "matches",
          iou_threshold: 0.5,
          offset: 0,
          total: 1,
          rows: [{ reference_label: 1, prediction_label: 2, intersection_pixels: 8, union_pixels: 10, iou: 0.8 }],
        };
      }
      if (req.table === "locate") {
        const isPred = req.role === "prediction";
        const label = Number(req.label);
        const point: [number, number] = label === 11 ? [4, 5] : label === 22 ? [10, 12] : [6, 8];
        const payload = {
          result_id: AGR_ID,
          revision_hash: AGR_REV,
          table: "locate",
          role: req.role,
          target: isPred
            ? { result_id: PRED_ID, revision_hash: PRED_REV, labels_sha256: PRED_LABELS_SHA }
            : { result_id: REF_ID, revision_hash: REF_REV, labels_sha256: REF_LABELS_SHA },
          label,
          point_index: point,
          centroid_index: [point[0] + 0.5, point[1] + 0.5],
          bbox_start: point,
          bbox_stop_exclusive: [point[0] + 2, point[1] + 2],
          pixel_count: 4,
          source_point_xy: [selection.x + point[1], selection.y + point[0]],
          source_centroid_xy: [selection.x + point[1] + 0.5, selection.y + point[0] + 0.5],
          world_point_xyz: [(selection.x + point[1]) * 2, (selection.y + point[0]) * 3],
          distance_unit: "um",
          selection,
          geometry,
        };
        if (options?.delayLocate) {
          return new Promise((resolve) => {
            resolveDelayedLocate = () => resolve(payload);
          });
        }
        return payload;
      }
    }
    return {};
  });

  const api: ResearchDesktopApi = {
    createStudy: vi.fn(async () => snapshot),
    openStudy: vi.fn(async () => snapshot),
    getSnapshot: vi.fn(async () => snapshot),
    addSources: vi.fn(async () => snapshot),
    execute,
    reviewResult: vi.fn(),
    exportResult: vi.fn(),
    cancelJob: vi.fn(),
  };

  return {
    api,
    execute,
    snapshot,
    pred,
    ref,
    agreement,
    resolveLocate() {
      resolveDelayedLocate?.(undefined);
    },
  };
}

beforeEach(() => {
  capturedViewportProps.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openInfoTab(container: HTMLElement) {
  const toolbar = within(container.querySelector<HTMLElement>(".workbench-tools")!);
  fireEvent.click(toolbar.getByRole("button", { name: "Results" }));
  fireEvent.click(toolbar.getByRole("combobox", { name: "Results tool" }));
  fireEvent.click(toolbar.getByRole("option", { name: "Review & export" }));
}

describe("Show me the differences workbench workflow", () => {
  it("opens an agent-linked agreement into Review, steps across signed differences on exact parent overlays with crop offset, and preserves comparison context", async () => {
    let releaseDifferencePage!: () => void;
    const differencePageBarrier = new Promise<void>((resolve) => { releaseDifferencePage = resolve; });
    const h = buildHarness({ differencePageBarrier });
    const { container } = render(<ResearchWorkbench api={h.api} onBack={vi.fn()} />);
    await screen.findByTestId("mock-viewport");
    fireEvent.click(await screen.findByRole("button", { name: "Agent session status" }));

    // Activate the newly committed control while React may still have passive effects pending.
    const firstClick = new MutationObserver(() => {
      const trigger = container.querySelector<HTMLButtonElement>(".annotation-difference-trigger:enabled");
      if (!trigger) return;
      firstClick.disconnect();
      trigger.click();
    });
    firstClick.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });

    fireEvent.click(await screen.findByRole("button", { name: `Open result ${AGR_ID}` }));

    // Lands directly in Info/Review with the saved annotation agreement and Show me the differences
    expect(await screen.findByRole("region", { name: "Saved annotation agreement" })).toBeVisible();
    expect(await screen.findByText("Locating…")).toBeVisible();
    expect(h.execute).toHaveBeenCalledWith("annotation_evaluation_get", expect.objectContaining({ table: "unmatched_prediction" }));
    expect(screen.getByTestId("mock-viewport").dataset.resultOverlay).toBe(`${AGR_ID}:${AGR_REV}`);
    await act(async () => releaseDifferencePage());

    // Locates first unmatched prediction (label 11 at local [4,5], crop origin (10,20) => native (15.5, 24.5))
    await waitFor(() => {
      const vp = screen.getByTestId("mock-viewport");
      expect(vp.dataset.resultOverlay).toBe(`${PRED_ID}:${PRED_REV}`);
      expect(vp.dataset.centroid).toBe("5,4");
      expect(vp.dataset.camera).toBe("15.5,24.5,1.5");
    });
    expect(screen.getByText(/Label 11/)).toBeVisible();
    expect(screen.getByText("(15, 24) px")).toBeVisible();
    expect(screen.getByText(/origin \(10, 20\)/)).toBeVisible();
    expect(screen.getByText("1 of 2")).toBeVisible();

    // Comparison context stays mounted while viewing the prediction parent so Next difference works
    fireEvent.click(screen.getByRole("button", { name: "Next difference" }));
    await waitFor(() => {
      const vp = screen.getByTestId("mock-viewport");
      expect(vp.dataset.resultOverlay).toBe(`${PRED_ID}:${PRED_REV}`);
      expect(vp.dataset.centroid).toBe("12,10");
      expect(vp.dataset.camera).toBe("22.5,30.5,1.5");
    });
    expect(screen.getByText("2 of 2")).toBeVisible();

    // Switch signed category to Only in reference -> switches overlay to the exact frozen reference parent
    fireEvent.click(screen.getByRole("button", { name: /Only in reference/ }));
    await waitFor(() => {
      const vp = screen.getByTestId("mock-viewport");
      expect(vp.dataset.resultOverlay).toBe(`${REF_ID}:${REF_REV}`);
      expect(vp.dataset.centroid).toBe("8,6");
      expect(vp.dataset.camera).toBe("18.5,26.5,1.5");
    });
    expect(screen.getByText(/Label 33/)).toBeVisible();

    // Return to agreement restores the agreement result while preserving the summary view
    fireEvent.click(screen.getByRole("button", { name: "Return to agreement" }));
    await waitFor(() => {
      expect(screen.getByTestId("mock-viewport").dataset.resultOverlay).toBe(`${AGR_ID}:${AGR_REV}`);
    });
  });

  it("refuses mismatched parent revisions without jumping on coincident label IDs", async () => {
    const h = buildHarness({ tamperPredRevision: true });
    render(<ResearchWorkbench api={h.api} onBack={vi.fn()} />);
    await screen.findByTestId("mock-viewport");

    fireEvent.click(await screen.findByRole("button", { name: "Agent session status" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open result ${AGR_ID}` }));
    expect(await screen.findByRole("region", { name: "Saved annotation agreement" })).toBeVisible();
    await waitFor(() => expect(screen.getByTestId("mock-viewport").dataset.resultOverlay).toBe(`${AGR_ID}:${AGR_REV}`));

    fireEvent.click(screen.getByRole("button", { name: "Show me the differences" }));
    const agreementRegion = screen.getByRole("region", { name: "Saved annotation agreement" });
    expect(await within(agreementRegion).findByRole("alert")).toHaveTextContent("revision is unavailable");
    // Overlay stays on agreement, never jumps to the tampered prediction parent
    expect(screen.getByTestId("mock-viewport").dataset.resultOverlay).toBe(`${AGR_ID}:${AGR_REV}`);
    expect(h.execute).not.toHaveBeenCalledWith("annotation_evaluation_get", expect.objectContaining({ table: "locate" }));
  });

  it("discards stale async locate responses when the source changes mid-navigation", async () => {
    const h = buildHarness({ delayLocate: true });
    render(<ResearchWorkbench api={h.api} onBack={vi.fn()} />);
    await screen.findByTestId("mock-viewport");

    fireEvent.click(await screen.findByRole("button", { name: "Agent session status" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open result ${AGR_ID}` }));
    expect(await screen.findByRole("region", { name: "Saved annotation agreement" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show me the differences" }));
    await waitFor(() => expect(h.execute).toHaveBeenCalledWith("annotation_evaluation_get", expect.objectContaining({ table: "locate", role: "prediction", label: 11 })));

    // Switch to Specimen B before the locate response arrives
    fireEvent.click(screen.getByRole("button", { name: /Specimen B/ }));
    await waitFor(() => expect(screen.getByTestId("mock-viewport").dataset.sourceId).toBe(SRC_B));

    // Late locate resolves: must NOT overwrite Specimen B or apply Specimen A's overlay/camera
    await act(async () => {
      h.resolveLocate();
    });
    expect(screen.getByTestId("mock-viewport").dataset.sourceId).toBe(SRC_B);
    expect(screen.getByTestId("mock-viewport").dataset.resultOverlay).toBe("");
    expect(screen.getByTestId("mock-viewport").dataset.camera).toBe("");
  });

  it("locates and highlights differences offline on a relink-required source using retained result planes", async () => {
    const h = buildHarness({ offlineSource: true, referenceKind: "adaptive-segmentation" });
    const { container } = render(<ResearchWorkbench api={h.api} onBack={vi.fn()} />);

    // Open Review & export tool and select the saved agreement on the offline source
    await waitFor(() => expect(container.querySelector(".workbench-tools")).not.toBeNull());
    openInfoTab(container);
    const selectButton = await screen.findByRole("button", { name: new RegExp(`Select rev ${AGR_REV.slice(0, 8)}`) });
    fireEvent.click(selectButton);

    expect(await screen.findByRole("region", { name: "Saved annotation agreement" })).toBeVisible();
    // Both parents are model/method predictions -> disagreement framing
    expect(screen.getByText("Saved prediction disagreement")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show me the differences" }));
    const centroidSvg = await screen.findByLabelText("Selected object centroid");
    const circle = centroidSvg.querySelector("circle");
    expect(circle).toHaveAttribute("cx", "5");
    expect(circle).toHaveAttribute("cy", "4");
    expect(screen.getByText(/Label 11/)).toBeVisible();
  });

  it("steps differences between a model-segmentation without selection.c and adaptive-segmentation in prediction disagreement mode", async () => {
    const h = buildHarness({ referenceKind: "adaptive-segmentation" });
    const { c: _omitted, ...modelSelection } = selection;
    h.pred.kind = "model-segmentation";
    h.pred.selection = modelSelection as ResearchSelection;
    h.pred.channel_mapping = [{ model_input_index: 0, model_channel: "nuclei", package_source_slot: 0, source_channel: 0 }];
    render(<ResearchWorkbench api={h.api} onBack={vi.fn()} />);
    await screen.findByTestId("mock-viewport");

    fireEvent.click(await screen.findByRole("button", { name: "Agent session status" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open result ${AGR_ID}` }));
    expect(await screen.findByRole("heading", { name: "Saved prediction disagreement" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show me the differences" }));
    await waitFor(() => {
      const vp = screen.getByTestId("mock-viewport");
      expect(vp.dataset.resultOverlay).toBe(`${PRED_ID}:${PRED_REV}`);
      expect(vp.dataset.centroid).toBe("5,4");
      expect(vp.dataset.camera).toBe("15.5,24.5,1.5");
    });

    fireEvent.click(screen.getByRole("button", { name: /Only in prediction b/i }));
    await waitFor(() => {
      const vp = screen.getByTestId("mock-viewport");
      expect(vp.dataset.resultOverlay).toBe(`${REF_ID}:${REF_REV}`);
      expect(vp.dataset.centroid).toBe("8,6");
    });

    fireEvent.click(screen.getByRole("button", { name: "Return to agreement" }));
    await waitFor(() => {
      expect(screen.getByTestId("mock-viewport").dataset.resultOverlay).toBe(`${AGR_ID}:${AGR_REV}`);
    });
  });
});
