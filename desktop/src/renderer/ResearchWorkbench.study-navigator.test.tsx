// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench from "./ResearchWorkbench";
import type { DisplayInspectorBinding, DisplayInspectorOwnerApi } from "../shared/display-inspector-api";
import type {
  StudyNavigatorAction,
  StudyNavigatorBinding,
  StudyNavigatorOwnerApi,
  StudyNavigatorSnapshot,
} from "../shared/study-navigator-api";
import type { ResearchDesktopApi, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const canvasContext = Object.fromEntries(
    [
      "setTransform", "fillRect", "drawImage", "beginPath", "moveTo",
      "lineTo", "closePath", "arc", "stroke", "fillText", "setLineDash", "save", "restore", "ellipse", "fill",
    ].map((name) => [name, vi.fn()]),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches(".image-viewport > canvas")) {
      return {
        left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, x: 0, y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return {
      left: 10, top: 40, right: 200, bottom: 72, width: 190, height: 32, x: 10, y: 40,
      toJSON: () => ({}),
    } as DOMRect;
  });
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
        queueMicrotask(() => this.onload?.());
      }
      get src() {
        return this.value;
      }
    },
  );
  if (!HTMLElement.prototype.setPointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
  }
  if (!HTMLElement.prototype.hasPointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => true),
    });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sourceA: ResearchSource = {
  id: "a".repeat(32),
  sha256: "1".repeat(64),
  name: "kidney_fluorescence.ome.tif",
  size_bytes: 12_582_912,
  source_kind: "native",
  derivation: { private_internal: "must-not-leak" },
  relink_hint: { selection_kind: "file", file_count: 1 },
  metadata: {
    format: "OME-TIFF",
    dimensions: { t: 1, c: 3, z: 16, y: 512, x: 512 },
    channel_names: ["DAPI", "Actin", "Tubulin"],
    channel_dtypes: ["uint16", "uint16", "uint16"],
    physical_calibration: { spacing: [0.32, 0.32, 1.0], unit: "µm" },
    timing: { source: "ome", elapsed_times: [0] },
  },
};

const sourceB: ResearchSource = {
  id: "b".repeat(32),
  sha256: "2".repeat(64),
  name: "cellseg_volume.tif",
  size_bytes: 4_194_304,
  source_kind: "native",
  metadata: {
    dimensions: { t: 1, c: 1, z: 8, y: 256, x: 256 },
    channel_dtypes: ["uint8"],
  },
};

function makeStudy(sources = [sourceA, sourceB], projectId = "study-kidney", title = "Kidney study"): ResearchSnapshot {
  return {
    project: { title, project_id: projectId },
    sources,
    results: [
      {
        id: "res-1",
        source_id: sourceA.id,
        source_sha256: sourceA.sha256,
        kind: "components",
        created_at: "2026-11-24T10:00:00Z",
        revision_hash: "f".repeat(64),
        object_count: 42,
      },
    ],
    workspace: { revision: 0, closed_sources: [], hidden_results: [] },
    samples: [],
    recipes: [],
    displays: [],
    selections: [],
    jobs: [],
    operations: {},
  };
}

function createBridge(study: ResearchSnapshot, overrides: Partial<ResearchDesktopApi> = {}): ResearchDesktopApi {
  return {
    getSnapshot: vi.fn(async () => study),
    openStudy: vi.fn(async () => null),
    createStudy: vi.fn(async () => null),
    addSources: vi.fn(async () => study),
    openImages: vi.fn(async () => study),
    reviewResult: vi.fn(async () => study),
    exportResult: vi.fn(async () => ({})),
    cancelJob: vi.fn(async () => ({})),
    reorderSources: vi.fn(async ({ sources }: { expected_revision: number; sources: Array<{ id: string; sha256: string }> }) => ({
      ...study,
      sources: sources
        .map((ref) => study.sources.find((item) => item.id === ref.id && item.sha256 === ref.sha256)!)
        .filter(Boolean),
    })),
    updateWorkspace: vi.fn(async () => ({
      ...study,
      workspace: { revision: 1, closed_sources: [], hidden_results: [] },
    })),
    execute: vi.fn(async (operation, request) => {
      const matched = study.sources.find((item) => item.id === request.source_id);
      if (!matched) return {};
      if (operation === "viewer_defaults") {
        const count = matched.metadata.dimensions?.c ?? 1;
        return {
          source_id: matched.id,
          source_sha256: matched.sha256,
          basis: "Source acquisition range",
          channels: Array.from({ length: count }, (_, channel) => ({
            channel, low: 0, high: 255, gamma: 1, visible: true, color: "#ffffff", opacity: 1,
          })),
        };
      }
      if (operation === "source_view") {
        return { source_id: matched.id, source_sha256: matched.sha256, revision: 0, state: null };
      }
      if (operation === "save_source_view") {
        return {
          source_id: matched.id,
          source_sha256: matched.sha256,
          revision: Number(request.expected_revision ?? 0) + 1,
          state: request.state,
        };
      }
      if (operation === "viewer_tile") {
        const dims = matched.metadata.dimensions!;
        const selection = request.selection as { width?: number; height?: number } | undefined;
        const width = request.overview ? Math.min(1024, dims.x) : Number(selection?.width ?? 64);
        const height = request.overview ? Math.min(1024, dims.y) : Number(selection?.height ?? 48);
        return {
          image: `data:image/png;base64,viewer#viewer-${width}x${height}`,
          source_sha256: matched.sha256,
          ...(request.overview
            ? {
                source_extent: [dims.x, dims.y],
                selection: { t: request.t ?? 0, z: request.z ?? 0, c: request.c ?? 0, z_stop: request.z_stop ?? null },
                projection: request.projection ?? null,
                width,
                height,
              }
            : { selection: request.selection }),
        };
      }
      if (operation === "source_annotations") {
        return {
          source_id: matched.id,
          source_sha256: matched.sha256,
          revision: 0,
          annotations: [],
          can_undo: false,
          can_redo: false,
        };
      }
      return {};
    }),
    ...overrides,
  };
}

function stubNavigatorOwner() {
  let lifecycle!: Parameters<StudyNavigatorOwnerApi["onLifecycle"]>[0];
  let action!: Parameters<StudyNavigatorOwnerApi["onAction"]>[0];
  let generation = 0;
  let currentBinding: StudyNavigatorBinding | null = null;
  let lastSnapshot: StudyNavigatorSnapshot | null = null;
  const native: StudyNavigatorOwnerApi = {
    open: vi.fn(async (target, snapshot) => {
      lastSnapshot = snapshot;
      const binding: StudyNavigatorBinding = { ...target, generation: ++generation };
      currentBinding = binding;
      lifecycle({ status: "opening", binding });
      lifecycle({ status: "open", binding });
      return binding;
    }),
    publish: vi.fn(async (_binding, snapshot) => {
      lastSnapshot = snapshot;
    }),
    focus: vi.fn(async () => {}),
    dock: vi.fn(async (binding) => {
      lifecycle({ status: "closed", binding, reason: "dock" });
    }),
    revoke: vi.fn(async (binding) => {
      lifecycle({ status: "closed", binding, reason: "revoked" });
    }),
    onLifecycle: (listener) => {
      lifecycle = listener;
      return () => {};
    },
    onAction: (listener) => {
      action = listener;
      return () => {};
    },
  };
  vi.stubGlobal("lociStudyNavigatorOwner", native);
  return {
    native,
    binding: () => currentBinding!,
    lastSnapshot: () => lastSnapshot!,
    send: (intent: StudyNavigatorAction) => act(() => action({ binding: currentBinding!, action: intent })),
    closeWith: (reason: "dock" | "native-close" | "display-removed" | "unavailable") =>
      act(() => lifecycle({ binding: currentBinding!, status: "closed", reason })),
  };
}

function stubDisplayOwner() {
  let lifecycle!: Parameters<DisplayInspectorOwnerApi["onLifecycle"]>[0];
  let generation = 0;
  let currentBinding: DisplayInspectorBinding | null = null;
  const native: DisplayInspectorOwnerApi = {
    open: vi.fn(async (target) => {
      const binding: DisplayInspectorBinding = { ...target, generation: ++generation };
      currentBinding = binding;
      lifecycle({ status: "opening", binding });
      lifecycle({ status: "open", binding });
      return binding;
    }),
    publish: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    dock: vi.fn(async (binding) => {
      lifecycle({ status: "closed", binding, reason: "dock" });
    }),
    revoke: vi.fn(async (binding) => {
      lifecycle({ status: "closed", binding, reason: "revoked" });
    }),
    onLifecycle: (listener) => {
      lifecycle = listener;
      return () => {};
    },
    onEdit: () => () => {},
  };
  vi.stubGlobal("lociDisplayInspectorOwner", native);
  return { native, binding: () => currentBinding! };
}

describe("ResearchWorkbench detachable Images navigator", () => {
  it("detaches by button, trims DTOs, switches active image through original handlers, preserves main actions/results, and restores focus on dock", async () => {
    const study = makeStudy();
    const bridge = createBridge(study);
    const nav = stubNavigatorOwner();

    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    const detachButton = await screen.findByRole("button", { name: "Detach Images" });
    expect(detachButton).toBeEnabled();

    fireEvent.click(detachButton);

    await waitFor(() => expect(nav.native.open).toHaveBeenCalledOnce());
    const [openTarget, openSnapshot, openOptions] = vi.mocked(nav.native.open).mock.calls[0];
    expect(openTarget).toEqual({ projectId: "study-kidney", studyGeneration: 0, documentGeneration: 0 });
    expect(openOptions).toBeUndefined();
    expect(openSnapshot.activeSourceId).toBe(sourceA.id);
    expect(openSnapshot.resultCounts).toEqual({ [sourceA.id]: 1, [sourceB.id]: 0 });
    // Outgoing source DTO is trimmed to renderer-safe fields
    expect(openSnapshot.sources[0]).not.toHaveProperty("derivation");
    expect(openSnapshot.sources[0]).not.toHaveProperty("relink_hint");
    expect(openSnapshot.sources[0].metadata).not.toHaveProperty("timing");

    // Main window retains Add/Remove, Layers & results, and Manage images & results
    expect(screen.getByRole("button", { name: "Add images" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove selected images" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Original image" })).toBeVisible();
    expect(screen.getByText(/42 objects/)).toBeVisible();
    expect(screen.getByText("Manage images & results")).toBeVisible();
    expect(screen.getByRole("button", { name: "Focus Images navigator" })).toBeVisible();

    // Activate second image from detached navigator
    nav.send({
      kind: "activate",
      sourceId: sourceB.id,
      sourceSha256: sourceB.sha256,
      modifier: "none",
      visibleSourceIds: [sourceA.id, sourceB.id],
    });
    await waitFor(() => {
      expect(screen.getByLabelText(`Image viewer: ${sourceB.name}`)).toBeInTheDocument();
      expect(nav.lastSnapshot().activeSourceId).toBe(sourceB.id);
      expect(nav.lastSnapshot().activeSourceSha256).toBe(sourceB.sha256);
    });

    // Reorder sources from detached navigator
    nav.send({
      kind: "reorder",
      order: [
        { sourceId: sourceB.id, sourceSha256: sourceB.sha256 },
        { sourceId: sourceA.id, sourceSha256: sourceA.sha256 },
      ],
    });
    await waitFor(() => expect(bridge.reorderSources).toHaveBeenCalledOnce());

    // Hide left rail, then dock: rail reopens and focus returns to Detach Images
    fireEvent.click(screen.getByRole("button", { name: "Hide image list" }));
    expect(document.getElementById("research-image-list")).toHaveAttribute("hidden");
    nav.closeWith("dock");
    await waitFor(() => {
      expect(document.getElementById("research-image-list")).not.toHaveAttribute("hidden");
      expect(screen.getByRole("button", { name: "Detach Images" })).toHaveFocus();
    });
  });

  it("supports physical drag of the Images header outside the window while keeping header Add/Remove buttons interactive", async () => {
    const study = makeStudy();
    const bridge = createBridge(study);
    const nav = stubNavigatorOwner();

    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    await screen.findByRole("button", { name: "Detach Images" });

    // Clicking Add images inside the grabbable header must NOT trigger drag detach
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add images" }), {
      isPrimary: true,
      button: 0,
      pointerId: 1,
      clientX: 160,
      clientY: 50,
    });
    fireEvent.pointerUp(window, { pointerId: 1, button: 0, clientX: -40, clientY: 50 });
    expect(nav.native.open).not.toHaveBeenCalled();

    // Dragging the passive Images header title outside the window opens atPointer
    const heading = screen.getByRole("heading", { name: /Images\s*\(2\)/ });
    fireEvent.pointerDown(heading, { isPrimary: true, button: 0, pointerId: 2, clientX: 40, clientY: 50 });
    fireEvent.pointerMove(window, { pointerId: 2, buttons: 1, clientX: -60, clientY: 50 });
    fireEvent.pointerUp(window, { pointerId: 2, button: 0, clientX: -60, clientY: 50 });

    await waitFor(() =>
      expect(nav.native.open).toHaveBeenCalledWith(
        { projectId: "study-kidney", studyGeneration: 0, documentGeneration: 0 },
        expect.objectContaining({ activeSourceId: sourceA.id }),
        { atPointer: true },
      ),
    );
  });

  it("coexists with a detached right Display inspector and revokes cleanly on study replacement", async () => {
    const study = makeStudy();
    const replacementStudy = makeStudy([sourceB], "study-replacement", "Replacement study");
    const bridge = createBridge(study, {
      openStudy: vi.fn(async () => replacementStudy),
    });
    const nav = stubNavigatorOwner();
    const display = stubDisplayOwner();

    render(<ResearchWorkbench api={bridge} onBack={vi.fn()} />);
    const viewport = await screen.findByLabelText(`Image viewer: ${sourceA.name}`);
    await waitFor(() => expect(viewport).toHaveAttribute("data-prepared", "true"));

    // Detach both right Display inspector and left Images navigator simultaneously
    fireEvent.click(screen.getByRole("button", { name: "Detach Display" }));
    fireEvent.click(screen.getByRole("button", { name: "Detach Images" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Focus Display inspector" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Focus Images navigator" })).toBeVisible();
    });

    // Switching active image via detached Images navigator keeps Images open while Display revokes for the old source
    nav.send({
      kind: "activate",
      sourceId: sourceB.id,
      sourceSha256: sourceB.sha256,
      modifier: "none",
    });
    await waitFor(() => {
      expect(display.native.revoke).toHaveBeenCalledWith(display.binding());
      expect(nav.native.revoke).not.toHaveBeenCalled();
      expect(screen.getByLabelText(`Image viewer: ${sourceB.name}`)).toBeInTheDocument();
    });

    // Replacing the study revokes the detached Images navigator
    const oldBinding = nav.binding();
    const fileMenu = screen.getByText("File").closest("details")!;
    fireEvent.click(within(fileMenu).getByRole("button", { name: "Open study" }));
    await waitFor(() => expect(nav.native.revoke).toHaveBeenCalledWith(oldBinding));
  });
});
