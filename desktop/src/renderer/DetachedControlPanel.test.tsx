// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ImageWindowApi,
  ImageWindowInteraction,
  ImageWindowPresentation,
  ImageWindowState,
} from "../shared/image-window-api";
import type { ImageViewTargetSnapshot } from "../shared/image-view-contracts";
import type { ResearchDesktopApi, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { DEFAULT_PREFERENCES } from "./preferences";
import { DetachedControlPanel } from "./DetachedControlPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const source: ResearchSource = {
  id: "a".repeat(32),
  name: "Shared stack",
  sha256: "1".repeat(64),
  metadata: {
    format: "OME-TIFF",
    dimensions: { x: 128, y: 96, z: 3, t: 2, c: 1 },
    levels: [{ index: 0, dimensions: { x: 128, y: 96, z: 3, t: 2, c: 1 } }],
    channel_names: ["Signal"],
  },
};

const targets: ImageViewTargetSnapshot[] = ["a", "b"].map((suffix, index) => ({
  viewId: `view-${suffix}`,
  sessionEpoch: "epoch-a",
  generation: 1,
  sourceId: source.id,
  sourceSha256: source.sha256,
  resultId: null,
  resultRevisionHash: null,
}));

const snapshot: ResearchSnapshot = {
  project: { title: "Detached study" },
  sources: [source],
  results: [],
  samples: [],
  recipes: [],
  displays: [],
  selections: [],
  jobs: [],
  operations: {},
};

function defaults() {
  return [{ channel: 0, low: 0, high: 4095, gamma: 1, visible: true, color: "#ffffff" }];
}

function setupApi(options: {
  initialPresentation?: ImageWindowPresentation;
  annotationConflict?: boolean;
  source?: ResearchSource;
  channels?: ImageWindowPresentation["channels"];
  savedState?: { interpretation?: string; camera?: unknown };
} = {}) {
  const activeSource = options.source ?? source;
  const activeTargets = targets.map((target) => ({
    ...target,
    sourceId: activeSource.id,
    sourceSha256: activeSource.sha256,
  }));
  const activeSnapshot: ResearchSnapshot = { ...snapshot, sources: [activeSource] };
  let stateListener: ((state: ImageWindowState) => void) | undefined;
  let interactionListener: ((event: { target: ImageViewTargetSnapshot; interaction: ImageWindowInteraction }) => void) | undefined;
  const state: ImageWindowState = {
    role: "control",
    views: activeTargets.map((target, index) => ({
      target,
      source: activeSource,
      label: `View ${index + 1}`,
      status: "ready",
      ...(index === 0 && options.initialPresentation ? { initialPresentation: options.initialPresentation } : {}),
    })),
    target: activeTargets[0],
    pinned: false,
  };
  const execute = vi.fn(async (_target: ImageViewTargetSnapshot, operation: string) => {
    if (operation === "viewer_defaults") {
      return { source_id: activeSource.id, source_sha256: activeSource.sha256,
        channels: options.channels ?? defaults() };
    }
    if (operation === "source_view") {
      return { source_id: activeSource.id, source_sha256: activeSource.sha256, revision: 4,
        state: options.savedState ?? null };
    }
    if (operation === "source_annotations") {
      return { source_id: activeSource.id, source_sha256: activeSource.sha256, revision: 2,
        annotations: [], can_undo: false, can_redo: false };
    }
    if (operation === "annotate_source" && options.annotationConflict) {
      throw new Error("Annotation revision conflict. Reload annotations before retrying.");
    }
    return {};
  });
  const api = {
    state: vi.fn(async () => state),
    onState: vi.fn((listener) => { stateListener = listener; return () => {}; }),
    onInteraction: vi.fn((listener) => { interactionListener = listener; return () => {}; }),
    onPresentation: vi.fn(() => () => {}),
    execute,
    publish: vi.fn(async () => {}),
    open: vi.fn(),
    restore: vi.fn(),
    close: vi.fn(),
    closeAll: vi.fn(),
    reopen: vi.fn(),
    pin: vi.fn(),
    focus: vi.fn(),
    fullscreen: vi.fn(),
    presentation: vi.fn(),
    interact: vi.fn(),
    cancel: vi.fn(),
  } as unknown as ImageWindowApi;
  const researchApi = {
    getSnapshot: vi.fn(async () => activeSnapshot),
    saveAs: vi.fn(async () => activeSnapshot),
  } as unknown as ResearchDesktopApi;
  return {
    api,
    researchApi,
    targets: activeTargets,
    emitState: (target: ImageViewTargetSnapshot) => stateListener?.({ ...state, target }),
    emitInteraction: (target: ImageViewTargetSnapshot, interaction: ImageWindowInteraction) =>
      interactionListener?.({ target, interaction }),
  };
}

describe("DetachedControlPanel", () => {
  it("retains the final drawing event when camera updates arrive in the same React batch", async () => {
    const { api, researchApi, emitInteraction } = setupApi();
    render(<DetachedControlPanel api={api} researchApi={researchApi} preferences={DEFAULT_PREFERENCES} onReturn={() => {}} />);
    await waitFor(() => expect(api.publish).toHaveBeenCalled());
    const points = [{ x: 10, y: 10 }, { x: 30, y: 30 }];
    act(() => {
      emitInteraction(targets[0], { kind: "draft", plane: { t: 0, z: 1 }, points });
      emitInteraction(targets[0], { kind: "camera", camera: { x: 60, y: 40, scale: 2 } });
    });
    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([target, value]) =>
      target.viewId === targets[0].viewId && JSON.stringify(value.draft) === JSON.stringify(points) && value.camera?.scale === 2)).toBe(true));
  });

  it("keeps the newer focused target when the startup snapshot arrives late", async () => {
    const { api, researchApi, emitState } = setupApi();
    const stale = await api.state();
    let resolveState!: (value: ImageWindowState) => void;
    vi.mocked(api.state).mockImplementation(() => new Promise((resolve) => { resolveState = resolve; }));
    render(<DetachedControlPanel api={api} researchApi={researchApi} preferences={DEFAULT_PREFERENCES} onReturn={() => {}} />);
    act(() => emitState(targets[1]));
    await act(async () => resolveState(stale));
    await waitFor(() => expect(screen.getByRole("region", { name: "Controls for View 2" })).toBeVisible());
    expect(screen.queryByRole("region", { name: "Controls for View 1" })).not.toBeInTheDocument();
  });

  it("keeps same-source controller drafts independent and publishes through the matching target", async () => {
    const { api, researchApi, emitInteraction } = setupApi();
    render(<DetachedControlPanel api={api} researchApi={researchApi}
      preferences={DEFAULT_PREFERENCES} onReturn={vi.fn()} />);

    await waitFor(() => {
      const publishedTargets = vi.mocked(api.publish).mock.calls.map(([target]) => target.viewId);
      expect(publishedTargets).toContain("view-a");
      expect(publishedTargets).toContain("view-b");
    });
    act(() => emitInteraction(targets[1], { kind: "draft", plane: { t: 0, z: 1 }, points: [{ x: 21, y: 22 }] }));

    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([publishedTarget, value]) =>
      publishedTarget.viewId === "view-b" && value.draft[0]?.x === 21)).toBe(true));
    expect(vi.mocked(api.publish).mock.calls.some(([publishedTarget, value]) =>
      publishedTarget.viewId === "view-a" && value.draft[0]?.x === 21)).toBe(false);
    expect(vi.mocked(api.execute).mock.calls.some(([, operation]) => operation === "save_source_view")).toBe(false);

    const annotationLoads = vi.mocked(api.execute).mock.calls.filter(([, operation]) => operation === "source_annotations");
    expect(annotationLoads.map(([boundTarget]) => boundTarget.viewId).sort()).toEqual(["view-a", "view-b"]);
    const hydrationCalls = vi.mocked(api.execute).mock.calls.filter(([, operation]) =>
      operation === "viewer_defaults" || operation === "source_view");
    expect(hydrationCalls.every((call) => call.length === 3)).toBe(true);
  });

  it("adopts restored local display state only after source verification and resets drafts and annotations", async () => {
    const initialPresentation: ImageWindowPresentation = {
      mode: "volume",
      selection: { x: 0, y: 0, width: 128, height: 96, t: 1, c: 0, z: 2, level: 0 },
      channels: [{ channel: 0, low: 12, high: 1200, gamma: 1.4, visible: true, color: "#00ff00" }],
      projection: "plane",
      tool: "polygon",
      draft: [{ x: 30, y: 31 }],
      annotations: [{ id: "restored", kind: "point", points: [{ x: 4, y: 5 }],
        label: "stale", color: "#ffffff", z: 0, t: 0 }],
      camera: { x: 64, y: 48, scale: 2 },
      showScaleBar: false,
      showNavigator: false,
    };
    const { api, researchApi } = setupApi({ initialPresentation });
    render(<DetachedControlPanel api={api} researchApi={researchApi}
      preferences={DEFAULT_PREFERENCES} onReturn={vi.fn()} />);

    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([publishedTarget, value]) =>
      publishedTarget.viewId === "view-a" && value.mode === "volume" && value.selection.t === 1 &&
      value.channels[0].low === 12 && value.camera?.scale === 2)).toBe(true));
    const restoredPublish = vi.mocked(api.publish).mock.calls.find(([publishedTarget, value]) =>
      publishedTarget.viewId === "view-a" && value.mode === "volume")?.[1];
    expect(restoredPublish?.tool).toBe("navigate");
    expect(restoredPublish?.draft).toEqual([]);
    expect(restoredPublish?.annotations).toEqual([]);
    expect(vi.mocked(api.execute).mock.calls.some(([boundTarget, operation]) =>
      boundTarget.viewId === "view-a" && operation === "viewer_defaults")).toBe(true);
    expect(vi.mocked(api.execute).mock.calls.some(([boundTarget, operation]) =>
      boundTarget.viewId === "view-a" && operation === "source_view")).toBe(true);
  });

  it("keeps an explicit plane and null camera over older saved volume settings", async () => {
    const initialPresentation: ImageWindowPresentation = {
      mode: "plane",
      selection: { x: 0, y: 0, width: 128, height: 96, t: 0, c: 0, z: 1, level: 0 },
      channels: defaults(),
      projection: "plane",
      tool: "navigate",
      draft: [],
      annotations: [],
      camera: null,
      showScaleBar: true,
      showNavigator: true,
    };
    const { api, researchApi } = setupApi({ initialPresentation, savedState: {
      interpretation: "volume", camera: { x: 20, y: 30, scale: 2 },
    } });
    render(<DetachedControlPanel api={api} researchApi={researchApi}
      preferences={DEFAULT_PREFERENCES} onReturn={vi.fn()} />);

    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([target, value]) =>
      target.viewId === "view-a" && value.mode === "plane" && value.camera === null)).toBe(true));
    expect(screen.getByRole("button", { name: "2D", pressed: true })).toBeInTheDocument();
  });

  it("targets native window actions without changing study state", async () => {
    const { api, researchApi } = setupApi();
    render(<DetachedControlPanel api={api} researchApi={researchApi}
      preferences={DEFAULT_PREFERENCES} onReturn={vi.fn()} />);

    const viewCard = await within(screen.getByLabelText("Detached image windows")).findByText("View 2");
    const article = viewCard.closest("article")!;
    fireEvent.click(article.querySelector<HTMLButtonElement>(".detached-view-summary")!);
    fireEvent.click(Array.from(article.querySelectorAll("button")).find((button) => button.textContent?.includes("Full screen"))!);

    expect(api.focus).toHaveBeenCalledWith(targets[1]);
    expect(api.fullscreen).toHaveBeenCalledWith(targets[1], true);
    expect(researchApi.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("shows annotation conflicts and preserves the unsaved draft across explicit reload", async () => {
    const { api, researchApi, emitInteraction } = setupApi({ annotationConflict: true });
    render(<DetachedControlPanel api={api} researchApi={researchApi}
      preferences={DEFAULT_PREFERENCES} onReturn={vi.fn()} />);

    await screen.findByRole("button", { name: "Point" });
    fireEvent.click(screen.getByRole("button", { name: "Point" }));
    act(() => emitInteraction(targets[0], { kind: "draft", plane: { t: 0, z: 1 }, points: [{ x: 18, y: 19 }] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save annotation" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));

    const reload = await screen.findByRole("button", { name: "Reload annotations" });
    expect(screen.getByRole("alert")).toHaveTextContent("revision conflict");
    fireEvent.click(reload);
    await screen.findByText(/unsaved draft was preserved/i);
    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([publishedTarget, value]) =>
      publishedTarget.viewId === "view-a" && value.draft[0]?.x === 18)).toBe(true));
  });

  it("treats declared RGB samples as one tone channel without scalar or 3D controls", async () => {
    const rgbSource: ResearchSource = {
      ...source,
      id: "b".repeat(32),
      sha256: "2".repeat(64),
      name: "Colour slide",
      metadata: {
        ...source.metadata,
        dimensions: { x: 128, y: 96, z: 1, t: 1, c: 3 },
        levels: [{ index: 0, dimensions: { x: 128, y: 96, z: 1, t: 1, c: 3 } }],
        sample_semantics: "RGB",
        channel_names: undefined,
      },
    };
    const tone = [{ channel: 0, low: 0, high: 255, gamma: 1, visible: true, color: "#ffffff" }];
    const { api, researchApi } = setupApi({ source: rgbSource, channels: tone });
    render(<DetachedControlPanel api={api} researchApi={researchApi}
      preferences={DEFAULT_PREFERENCES} onReturn={vi.fn()} />);

    const controls = await screen.findByRole("region", { name: "Controls for View 1" });
    expect(await within(controls).findByLabelText("RGB black point")).toBeInTheDocument();
    expect(within(controls).getByLabelText("RGB white point")).toBeInTheDocument();
    expect(within(controls).getByLabelText("RGB gamma")).toBeInTheDocument();
    expect(within(controls).queryByLabelText("View 1 channel 1 visible")).not.toBeInTheDocument();
    expect(within(controls).queryByRole("button", { name: "3D" })).not.toBeInTheDocument();
    expect(within(controls).queryByLabelText("View 1 Z")).not.toBeInTheDocument();
    expect(within(controls).queryByLabelText("View 1 projection")).not.toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([, presentation]) =>
      presentation.channels.length === 1 && presentation.channels[0].channel === 0)).toBe(true));
  });

  it("edits medical window and level through exact low/high conversions", async () => {
    const medicalSource: ResearchSource = {
      ...source,
      id: "c".repeat(32),
      sha256: "3".repeat(64),
      source_kind: "medical",
      metadata: {
        shape: [4, 96, 128],
        geometry: { axes: "ZYX", unit: "mm", frame: "LPS", affine: [[0.7, 0, 0, 10], [0, 0.8, 0, 20], [0, 0, 2.5, 30], [0, 0, 0, 1]] },
      },
    };
    const { api, researchApi } = setupApi({
      source: medicalSource,
      channels: [{ channel: 0, low: 0, high: 400, gamma: 1, visible: true, color: "#ffffff" }],
    });
    render(<DetachedControlPanel api={api} researchApi={researchApi}
      preferences={DEFAULT_PREFERENCES} onReturn={vi.fn()} />);

    const controls = await screen.findByRole("region", { name: "Controls for View 1" });
    const windowInput = await within(controls).findByLabelText("View 1 channel 1 window");
    fireEvent.change(windowInput, { target: { value: "200" } });
    fireEvent.blur(windowInput);
    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([, presentation]) =>
      presentation.channels[0].low === 100 && presentation.channels[0].high === 300)).toBe(true));

    const levelInput = within(controls).getByLabelText("View 1 channel 1 level");
    fireEvent.change(levelInput, { target: { value: "50" } });
    fireEvent.blur(levelInput);
    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([, presentation]) =>
      presentation.channels[0].low === -50 && presentation.channels[0].high === 150)).toBe(true));
    expect(within(controls).getByText("LPS")).toBeInTheDocument();
    expect(within(controls).getByText("0.7 × 0.8 × 2.5 mm")).toBeInTheDocument();
  });

  it("keeps scalar channel colour, visibility, range, gamma, and opacity controls", async () => {
    const scalarSource: ResearchSource = {
      ...source,
      id: "d".repeat(32),
      sha256: "4".repeat(64),
      metadata: {
        ...source.metadata,
        dimensions: { x: 128, y: 96, z: 1, t: 1, c: 2 },
        levels: [{ index: 0, dimensions: { x: 128, y: 96, z: 1, t: 1, c: 2 } }],
        channel_names: ["Signal A", "Signal B"],
        sample_semantics: "scalar",
      },
    };
    const scalarChannels = [
      { channel: 0, low: 0, high: 100, gamma: 1, visible: true, color: "#ff0000", opacity: 1 },
      { channel: 1, low: 5, high: 500, gamma: 1.2, visible: true, color: "#00ff00", opacity: 0.8 },
    ];
    const { api, researchApi } = setupApi({ source: scalarSource, channels: scalarChannels });
    render(<DetachedControlPanel api={api} researchApi={researchApi}
      preferences={DEFAULT_PREFERENCES} onReturn={vi.fn()} />);

    expect(await screen.findByLabelText("View 1 channel 2 visible")).toBeChecked();
    expect(screen.getByLabelText("View 1 channel 2 color")).toBeInTheDocument();
    expect(screen.getByLabelText("View 1 channel 2 low")).toBeInTheDocument();
    expect(screen.getByLabelText("View 1 channel 2 high")).toBeInTheDocument();
    expect(screen.getByLabelText("View 1 channel 2 gamma")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("View 1 channel 2 opacity"), { target: { value: "0.35" } });
    expect(screen.getByLabelText("View 1 channel 2 opacity value")).toHaveTextContent("0.35");
    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([, presentation]) =>
      presentation.channels[1].opacity === 0.35)).toBe(true));
  });

  it("publishes an explicit per-view interpretation", async () => {
    const { api, researchApi } = setupApi();
    render(<DetachedControlPanel api={api} researchApi={researchApi}
      preferences={DEFAULT_PREFERENCES} onReturn={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("View 1 Open as"), { target: { value: "fluorescence" } });
    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([target, presentation]) =>
      target.viewId === "view-a" && presentation.interpretation === "fluorescence")).toBe(true));
    expect(screen.getByText(/not marker or fluorophore declarations/i)).toBeInTheDocument();
  });

  it("merges a volume-display channel subset without losing a simultaneous draft", async () => {
    const scalarSource: ResearchSource = {
      ...source,
      id: "e".repeat(32),
      sha256: "5".repeat(64),
      metadata: {
        ...source.metadata,
        dimensions: { x: 128, y: 96, z: 3, t: 1, c: 2 },
        levels: [{ index: 0, dimensions: { x: 128, y: 96, z: 3, t: 1, c: 2 } }],
        channel_names: ["A", "B"],
      },
    };
    const scalarChannels = [
      { channel: 0, low: 0, high: 100, gamma: 1, visible: true, color: "#ff0000", opacity: 1 },
      { channel: 1, low: 10, high: 500, gamma: 1, visible: true, color: "#00ff00", opacity: 0.7 },
    ];
    const { api, researchApi, targets: activeTargets, emitInteraction } = setupApi({
      source: scalarSource,
      channels: scalarChannels,
    });
    render(<DetachedControlPanel api={api} researchApi={researchApi}
      preferences={DEFAULT_PREFERENCES} onReturn={vi.fn()} />);
    await waitFor(() => expect(api.publish).toHaveBeenCalled());

    act(() => {
      emitInteraction(activeTargets[0], {
        kind: "draft",
        plane: { t: 0, z: 1 },
        points: [{ x: 31, y: 32 }],
      });
      emitInteraction(activeTargets[0], {
        kind: "volume-display",
        channels: [{ channel: 0, low: 20, high: 80, gamma: 1.4, visible: true, color: "#0000ff", opacity: 0.5 }],
        renderMode: "mip",
        quality: 80,
      });
    });

    await waitFor(() => expect(vi.mocked(api.publish).mock.calls.some(([target, presentation]) =>
      target.viewId === "view-a" && presentation.draft[0]?.x === 31 &&
      presentation.volumeDisplay?.renderMode === "mip" && presentation.volumeDisplay.quality === 80 &&
      presentation.channels[0].low === 20 && presentation.channels[0].opacity === 0.5 &&
      presentation.channels[1].low === 10 && presentation.channels[1].opacity === 0.7)).toBe(true));
  });
});
