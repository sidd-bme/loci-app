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
  ResearchDesktopApi,
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
      "setTransform",
      "fillRect",
      "clearRect",
      "scale",
      "drawImage",
      "beginPath",
      "moveTo",
      "lineTo",
      "closePath",
      "arc",
      "stroke",
      "fillText",
      "setLineDash",
      "save",
      "restore",
      "ellipse",
      "fill",
    ].map((name) => [name, vi.fn()]),
  );
  canvasContext.createRadialGradient = vi.fn(() => ({
    addColorStop: vi.fn(),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createSnapshot(sourceCount = 5): ResearchSnapshot {
  const sources = Array.from({ length: sourceCount }, (_, i) => ({
    id: `src-${i + 1}`,
    sha256: `sha-${i + 1}`.repeat(8),
    name: `Image_${i + 1}.tif`,
    source_kind: "native" as const,
    metadata: {
      axes: "CZYX",
      dimensions: { t: 1, c: 2, z: 1, y: 100, x: 100, s: 1 },
      channel_dtypes: ["uint8", "uint8"],
      sample_semantics: "none",
    },
  }));

  return {
    project: {
      title: "Multi-select Test Project",
    },
    sources,
    results: [],
    jobs: [],
    samples: [],
    recipes: [],
    displays: [],
    selections: [],
    workspace: { revision: 0, closed_sources: [], hidden_results: [] },
    operations: {
      view: { mutates: false, summary: "view" },
    },
  };
}

function mockApi(snapshotToUse: ResearchSnapshot): ResearchDesktopApi {
  let currentSnapshot = snapshotToUse;
  const getSnapshot = vi.fn(async () => currentSnapshot);
  const execute = vi.fn(async (op: string) => {
    if (op === "viewer_defaults") {
      return {
        source_id: snapshotToUse.sources[0]?.id,
        source_sha256: snapshotToUse.sources[0]?.sha256,
        basis: "Source acquisition range",
        channels: [
          { channel: 0, low: 0, high: 255, gamma: 1, color: "#0000ff", opacity: 1, visible: true },
        ],
      };
    }
    if (op === "source_view") {
      return { source_id: snapshotToUse.sources[0]?.id, revision: 0, state: null };
    }
    if (op === "source_annotations") {
      return { source_id: snapshotToUse.sources[0]?.id, revision: 0, annotations: [], can_undo: false, can_redo: false };
    }
    return {};
  });

  return {
    getSnapshot,
    execute,
    reorderSources: vi.fn(async (
      change: Parameters<NonNullable<ResearchDesktopApi["reorderSources"]>>[0],
    ) => {
      const byId = new Map(currentSnapshot.sources.map((source) => [source.id, source] as const));
      currentSnapshot = {
        ...currentSnapshot,
        sources: change.sources.map(({ id }) => byId.get(id)!),
        workspace: {
          revision: change.expected_revision + 1,
          closed_sources: currentSnapshot.workspace?.closed_sources ?? [],
          hidden_results: currentSnapshot.workspace?.hidden_results ?? [],
        },
      };
      return currentSnapshot;
    }),
    updateWorkspace: vi.fn(async (change) => {
      const closedIds = new Set(
        (change.sources || []).filter((s: { visible?: boolean }) => !s.visible).map((s: { id: string }) => s.id),
      );
      const remainingSources = snapshotToUse.sources.filter((s) => !closedIds.has(s.id));
      return {
        ...snapshotToUse,
        sources: remainingSources,
        workspace: {
          revision: (change.expected_revision ?? 0) + 1,
          closed_sources: snapshotToUse.sources.filter((s) => closedIds.has(s.id)),
          hidden_results: [],
        },
      };
    }),
    sessionState: vi.fn(async () => ({
      status: "ready" as const,
      storage: "managed" as const,
      can_save_as: true,
      last_save_iso: null,
      workspace: null,
    })),
    onSnapshot: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
    logClientEvent: vi.fn(async () => {}),
  } as unknown as ResearchDesktopApi;
}

describe("ResearchWorkbench Left-Pane Multi-Select & Resizer", () => {
  it("selects a single image on plain click and updates active selection", async () => {
    const snapshot = createSnapshot(4);
    const api = mockApi(snapshot);

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Image_1\.tif/ })).toBeInTheDocument();
    });

    const img1 = screen.getByRole("button", { name: /Image_1\.tif/ });
    const img2 = screen.getByRole("button", { name: /Image_2\.tif/ });

    expect(img1).toHaveClass("selected");
    expect(img2).not.toHaveClass("selected");

    fireEvent.click(img2);
    expect(img2).toHaveClass("selected");
    expect(img1).not.toHaveClass("selected");
  });

  it("selects a range with Shift+click from the anchor", async () => {
    const snapshot = createSnapshot(5);
    const api = mockApi(snapshot);

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Image_1\.tif/ })).toBeInTheDocument();
    });

    const img1 = screen.getByRole("button", { name: /Image_1\.tif/ });
    const img3 = screen.getByRole("button", { name: /Image_3\.tif/ });
    const img4 = screen.getByRole("button", { name: /Image_4\.tif/ });
    const img5 = screen.getByRole("button", { name: /Image_5\.tif/ });

    // Plain click Image 1 to set anchor
    fireEvent.click(img1);
    expect(img1).toHaveClass("selected");

    // Shift-click Image 3 -> 1, 2, 3 selected
    fireEvent.click(img3, { shiftKey: true });
    expect(img1).toHaveClass("selected");
    expect(screen.getByRole("button", { name: /Image_2\.tif/ })).toHaveClass("selected");
    expect(img3).toHaveClass("selected");
    expect(img4).not.toHaveClass("selected");
    expect(img5).not.toHaveClass("selected");
  });

  it("toggles individual images with Cmd+click and preserves disjoint selection", async () => {
    const snapshot = createSnapshot(5);
    const api = mockApi(snapshot);

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Image_1\.tif/ })).toBeInTheDocument();
    });

    const img1 = screen.getByRole("button", { name: /Image_1\.tif/ });
    const img2 = screen.getByRole("button", { name: /Image_2\.tif/ });
    const img4 = screen.getByRole("button", { name: /Image_4\.tif/ });

    // Plain click Image 1
    fireEvent.click(img1);

    // Shift click Image 2 -> 1 and 2 selected
    fireEvent.click(img2, { shiftKey: true });
    expect(img1).toHaveClass("selected");
    expect(img2).toHaveClass("selected");

    // Cmd-click Image 4 -> 1, 2, 4 selected
    fireEvent.click(img4, { metaKey: true });
    expect(img1).toHaveClass("selected");
    expect(img2).toHaveClass("selected");
    expect(screen.getByRole("button", { name: /Image_3\.tif/ })).not.toHaveClass("selected");
    expect(img4).toHaveClass("selected");
  });

  it("adjusts panel width with arrow keys on the resizer", async () => {
    const snapshot = createSnapshot(3);
    const api = mockApi(snapshot);

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("separator", { name: "Resize image panel" })).toBeInTheDocument();
    });

    const resizer = screen.getByRole("separator", { name: "Resize image panel" });
    const main = screen.getByRole("main");
    expect(main.style.getPropertyValue("--research-sources-width")).toBe("210px");

    // Press ArrowRight to increase width
    fireEvent.keyDown(resizer, { key: "ArrowRight" });
    expect(main.style.getPropertyValue("--research-sources-width")).toBe("220px");

    // Press ArrowLeft to decrease width
    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(main.style.getPropertyValue("--research-sources-width")).toBe("210px");
  });

  it("removes selected images from workspace and supports undo", async () => {
    const snapshot = createSnapshot(3);
    const api = mockApi(snapshot);

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Image_1\.tif/ })).toBeInTheDocument();
    });

    const removeBtn = screen.getByRole("button", { name: "Remove selected images" });
    expect(removeBtn).toBeInTheDocument();

    // Select Image 2 with Cmd+click so both Image 1 and Image 2 are selected
    const img2 = screen.getByRole("button", { name: /Image_2\.tif/ });
    fireEvent.click(img2, { metaKey: true });

    // Click remove button
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(api.updateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          sources: expect.arrayContaining([
            expect.objectContaining({ id: "src-1", visible: false }),
            expect.objectContaining({ id: "src-2", visible: false }),
          ]),
        }),
      );
    });

    // Undo receipt appears
    await waitFor(() => {
      expect(screen.getByText(/Closed 2 images\./)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    });
  });

  it("displays the quiet empty workspace when all images are closed", async () => {
    const emptySnapshot: ResearchSnapshot = {
      ...createSnapshot(0),
      sources: [],
    };
    const api = mockApi(emptySnapshot);

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Active image")).toHaveTextContent("No image open");
    });
    expect(screen.getByText("Open an image to begin")).toBeInTheDocument();
    expect(screen.getByText("No image selected")).toBeInTheDocument();
  });

  it("reorders images via Alt+Arrow keyboard shortcuts", async () => {
    const snapshot = createSnapshot(3);
    const api = mockApi(snapshot);

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Image_1\.tif/ })).toBeInTheDocument();
    });

    const img1 = screen.getByRole("button", { name: /Image_1\.tif/ });

    // Press Alt+ArrowDown on Image 1 to move it below Image 2
    fireEvent.keyDown(img1, { key: "ArrowDown", altKey: true });

    // Verify Image 1 now has is-dropped class and order changed
    expect(img1).toHaveClass("is-dropped");
    const buttons = screen.getAllByRole("button").filter((b) => b.classList.contains("research-source-item"));
    expect(buttons[0]).toHaveTextContent("Image_2.tif");
    expect(buttons[1]).toHaveTextContent("Image_1.tif");
    expect(buttons[2]).toHaveTextContent("Image_3.tif");
    await waitFor(() => expect(api.reorderSources).toHaveBeenCalledWith({
      expected_revision: 0,
      sources: [
        { id: "src-2", sha256: snapshot.sources[1].sha256 },
        { id: "src-1", sha256: snapshot.sources[0].sha256 },
        { id: "src-3", sha256: snapshot.sources[2].sha256 },
      ],
    }));
  });

  it("preserves the active image and multi-selection after the persisted order returns", async () => {
    const snapshot = createSnapshot(3);
    const api = mockApi(snapshot);
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    const img1 = await screen.findByRole("button", { name: /Image_1\.tif/ });
    const img2 = screen.getByRole("button", { name: /Image_2\.tif/ });
    fireEvent.click(img2, { metaKey: true });

    fireEvent.keyDown(img1, { key: "ArrowDown", altKey: true });

    await waitFor(() => expect(api.reorderSources).toHaveBeenCalledOnce());
    expect(img1).toHaveAttribute("aria-selected", "true");
    expect(img2).toHaveAttribute("aria-selected", "true");
    expect(img2).toHaveAttribute("aria-current", "true");
    expect(img1).not.toHaveAttribute("aria-current");
  });

  it("reorders images via pointer drag and drop and sets lift/ghost states", async () => {
    const snapshot = createSnapshot(3);
    const api = mockApi(snapshot);

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Image_1\.tif/ })).toBeInTheDocument();
    });

    const img1 = screen.getByRole("button", { name: /Image_1\.tif/ });

    img1.getBoundingClientRect = () => ({
      left: 10, top: 50, right: 210, bottom: 90, width: 200, height: 40, x: 10, y: 50, toJSON: () => {},
    });

    // Pointer down on Image 1
    fireEvent.pointerDown(img1, { button: 0, clientX: 50, clientY: 70 });

    // Drag down beyond 4px threshold
    fireEvent(window, new MouseEvent("pointermove", { clientX: 50, clientY: 150 }));

    // Verify Image 1 enters ghost state
    expect(img1).toHaveClass("is-ghost");

    // Pointer up to commit drop
    fireEvent(window, new MouseEvent("pointerup", { clientX: 50, clientY: 150 }));

    await waitFor(() => {
      expect(img1).not.toHaveClass("is-ghost");
    });
  });

  it("invokes onSourcesReorder callback with the reordered array", async () => {
    const snapshot = createSnapshot(3);
    const api = mockApi(snapshot);
    const onSourcesReorder = vi.fn();

    render(<ResearchWorkbench api={api} onBack={vi.fn()} onSourcesReorder={onSourcesReorder} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Image_1\.tif/ })).toBeInTheDocument();
    });

    const img1 = screen.getByRole("button", { name: /Image_1\.tif/ });
    fireEvent.keyDown(img1, { key: "ArrowDown", altKey: true });

    expect(onSourcesReorder).toHaveBeenCalledOnce();
    expect(onSourcesReorder.mock.calls[0][0].map((s: { name: string }) => s.name)).toEqual([
      "Image_2.tif",
      "Image_1.tif",
      "Image_3.tif",
    ]);
  });
});
