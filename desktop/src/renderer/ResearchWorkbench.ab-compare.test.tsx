// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

const twoSourceSnapshot: ResearchSnapshot = {
  project: { title: "A/B Comparison Study" },
  sources: [
    {
      id: "a".repeat(32),
      name: "Field_01_Untreated",
      sha256: "1".repeat(64),
      metadata: {
        format: "TIFF",
        dimensions: { x: 2047, y: 2046, z: 1, t: 1, c: 2 },
        levels: [{ index: 0, dimensions: { x: 2047, y: 2046, z: 1, t: 1, c: 2 } }],
        channel_names: ["DAPI", "IL4R-Alexa555"],
      },
    },
    {
      id: "b".repeat(32),
      name: "Field_02_siScramble",
      sha256: "2".repeat(64),
      metadata: {
        format: "TIFF",
        dimensions: { x: 2047, y: 2046, z: 1, t: 1, c: 2 },
        levels: [{ index: 0, dimensions: { x: 2047, y: 2046, z: 1, t: 1, c: 2 } }],
        channel_names: ["DAPI", "IL4R-Alexa555"],
      },
    },
  ],
  results: [],
  samples: [],
  recipes: [],
  displays: [],
  selections: [],
  jobs: [],
  operations: {
    view: { mutates: false, summary: "view" },
    sample: { mutates: true, summary: "sample" },
  },
};

function viewerContractResponse(
  operation: string,
  request: Record<string, unknown>,
  active: ResearchSnapshot,
) {
  const source = active.sources.find((item) => item.id === request.source_id);
  if (!source) return undefined;
  if (operation === "viewer_defaults") {
    const dimensions = source.metadata.dimensions!;
    const isPaneA = source.id === active.sources[0].id;
    return {
      source_id: source.id,
      source_sha256: source.sha256,
      basis: "Source acquisition range",
      channels: Array.from({ length: dimensions.c }, (_, channel) => ({
        channel,
        low: 0,
        high: isPaneA ? 65535 : 4095,
        gamma: 1,
        color: isPaneA
          ? (["#0000ff", "#ff0000", "#00ff00"][channel] ?? "#ffffff")
          : "#ffffff",
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
    const width = request.overview ? Math.min(1024, dimensions.x) : Number(selection?.width ?? 256);
    const height = request.overview ? Math.min(1024, dimensions.y) : Number(selection?.height ?? 256);
    return {
      image: `data:image/png;base64,viewer#viewer-${width}x${height}`,
      source_sha256: source.sha256,
      ...(request.overview
        ? {
            source_extent: [dimensions.x, dimensions.y],
            width,
            height,
          }
        : { selection: request.selection }),
    };
  }
  return undefined;
}

function mockApi(snapshotToUse = twoSourceSnapshot): ResearchDesktopApi {
  const getSnapshot = vi.fn(async () => snapshotToUse);
  const execute = vi.fn(
    async (operation: string, request: Record<string, unknown>) => {
      const viewerResponse = viewerContractResponse(
        operation,
        request,
        snapshotToUse,
      );
      if (viewerResponse !== undefined) {
        return viewerResponse;
      }
      return {};
    },
  );
  return {
    getSnapshot,
    execute,
    onSnapshot: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
    logClientEvent: vi.fn(async () => {}),
  } as unknown as ResearchDesktopApi;
}

describe("Milestone 5B: A/B Image Viewing in ResearchWorkbench", () => {
  it("renders Compare A/B toggle button when multiple sources are available", async () => {
    const api = mockApi();
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Compare A/B" })).toBeTruthy();
    });
  });

  it("toggles A/B side-by-side view with distinct pane headers and selectors", async () => {
    const api = mockApi();
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Compare A/B" })).toBeTruthy();
    });

    const compareBtn = screen.getByRole("button", { name: "Compare A/B" });
    fireEvent.click(compareBtn);

    // Toolbar and panes appear
    await waitFor(() => {
      expect(screen.getByLabelText("A/B image comparison toolbar")).toBeTruthy();
    });

    // Check Pane A and Pane B headers
    expect(screen.getByText("Pane A")).toBeTruthy();
    expect(screen.getByText("Pane B")).toBeTruthy();
    expect(screen.getAllByText("Field_01_Untreated").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Field_02_siScramble").length).toBeGreaterThan(1);

    // Check selectors for Pinned Source A and B
    const selectA = screen.getByLabelText("Pinned Source A") as HTMLSelectElement;
    const selectB = screen.getByLabelText("Pinned Source B") as HTMLSelectElement;
    expect(selectA.value).toBe("a".repeat(32));
    expect(selectB.value).toBe("b".repeat(32));
  });

  it("matches display settings from A to B with notice that raw values are unchanged", async () => {
    const api = mockApi();
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Compare A/B" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare A/B" }));

    await waitFor(() => expect(
      screen.getByRole("button", { name: /Match display \(A → B\)/i }),
    ).toBeEnabled());

    const matchBtn = screen.getByRole("button", { name: /Match display \(A → B\)/i });
    fireEvent.click(matchBtn);

    await waitFor(() => {
      expect(
        screen.getByText("Display settings matched (A → B). Raw pixel values remain unchanged."),
      ).toBeTruthy();
      const matchedRequest = vi.mocked(api.execute).mock.calls.findLast(([operation, request]) =>
        operation === "viewer_tile" && request.source_id === twoSourceSnapshot.sources[1].id &&
        (request.channels as Array<{ high: number; color: string }>)[0]?.high === 65535);
      expect(matchedRequest?.[1].channels).toEqual(expect.arrayContaining([
        expect.objectContaining({ channel: 0, high: 65535, color: "#0000ff" }),
        expect.objectContaining({ channel: 1, high: 65535, color: "#ff0000" }),
      ]));
    });
  });

  it("does not link distinct sources based on matching dimensions", async () => {
    const api = mockApi();
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Compare A/B" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare A/B" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Link pan and zoom")).toBeTruthy();
    });

    const linkCheckbox = screen.getByLabelText("Link pan and zoom") as HTMLInputElement;
    expect(linkCheckbox.disabled).toBe(true);
    expect(linkCheckbox.checked).toBe(false);
    expect(screen.getByText(/No verified transform/)).toBeVisible();
  });

  it("synchronizes a post-mount camera change only for the same immutable source", async () => {
    const api = mockApi();
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Compare A/B" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Compare A/B" }));
    fireEvent.change(await screen.findByLabelText("Pinned Source B"), {
      target: { value: "a".repeat(32) },
    });

    const linkCheckbox = screen.getByLabelText("Link pan and zoom") as HTMLInputElement;
    await waitFor(() => expect(linkCheckbox).toBeEnabled());
    await waitFor(() => expect(screen.getAllByLabelText("Image viewer: Field_01_Untreated")).toHaveLength(2));

    fireEvent.click(linkCheckbox);
    expect(linkCheckbox.checked).toBe(true);
    const viewers = screen.getAllByLabelText("Image viewer: Field_01_Untreated");
    const before = JSON.parse(viewers[1].getAttribute("data-camera")!);
    fireEvent.click(within(viewers[0]).getByRole("button", { name: "Zoom in" }));
    await waitFor(() => {
      const cameraA = JSON.parse(viewers[0].getAttribute("data-camera")!);
      const cameraB = JSON.parse(viewers[1].getAttribute("data-camera")!);
      expect(cameraA.scale).toBeGreaterThan(before.scale);
      expect(cameraB).toEqual(cameraA);
    });
  });

  it("keeps selections and channel views source-bound across incompatible panes", async () => {
    const incompatible = structuredClone(twoSourceSnapshot);
    incompatible.sources[0].metadata.dimensions = { x: 2047, y: 2046, z: 3, t: 2, c: 2 };
    incompatible.sources[0].metadata.levels = [{ index: 0, dimensions: { x: 2047, y: 2046, z: 3, t: 2, c: 2 } }];
    incompatible.sources[1].metadata.dimensions = { x: 511, y: 257, z: 1, t: 1, c: 1 };
    incompatible.sources[1].metadata.levels = [{ index: 0, dimensions: { x: 511, y: 257, z: 1, t: 1, c: 1 } }];
    incompatible.sources[1].metadata.channel_names = ["DAPI"];
    const api = mockApi(incompatible);
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Compare A/B" }));
    await waitFor(() => expect(screen.getAllByLabelText(/^Image viewer:/)).toHaveLength(2));
    const timeA = screen.getByLabelText("Pane A time") as HTMLInputElement;
    const zA = screen.getByLabelText("Pane A Z") as HTMLInputElement;
    const channelA = screen.getByLabelText("Pane A channel view") as HTMLSelectElement;
    expect(screen.queryByLabelText("Pane B time")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pane B Z")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Match display/ })).toBeDisabled();

    fireEvent.change(timeA, { target: { value: "2" } });
    fireEvent.change(zA, { target: { value: "3" } });
    fireEvent.change(channelA, { target: { value: "1" } });

    await waitFor(() => {
      const calls = vi.mocked(api.execute).mock.calls.filter(([operation]) => operation === "viewer_tile");
      expect(calls.some(([, request]) => request.source_id === incompatible.sources[0].id &&
        request.t === 1 && request.z === 2 &&
        (request.channels as Array<{ channel: number; visible: boolean }>).filter((item) => item.visible)
          .map((item) => item.channel).join(",") === "1")).toBe(true);
      expect(calls.some(([, request]) => request.source_id === incompatible.sources[1].id &&
        request.t === 0 && request.z === 0 &&
        (request.channels as Array<{ channel: number }>).length === 1)).toBe(true);
    });
  });

  it("hydrates each pane from that source's saved selection and display", async () => {
    const snapshot = structuredClone(twoSourceSnapshot);
    for (const source of snapshot.sources) {
      source.metadata.dimensions = { x: 640, y: 480, z: 3, t: 2, c: 2 };
      source.metadata.levels = [{ index: 0, dimensions: { x: 640, y: 480, z: 3, t: 2, c: 2 } }];
    }
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      const source = snapshot.sources.find((item) => item.id === request.source_id)!;
      const response = viewerContractResponse(operation, request, snapshot);
      if (operation !== "source_view") return response ?? {};
      const defaults = viewerContractResponse("viewer_defaults", request, snapshot) as {
        channels: Array<Record<string, unknown>>;
      };
      const isA = source.id === snapshot.sources[0].id;
      return {
        source_id: source.id,
        source_sha256: source.sha256,
        revision: 4,
        state: {
          interpretation: "fluorescence",
          channels: defaults.channels.map((channel, index) => ({
            ...channel,
            visible: index === (isA ? 1 : 0),
          })),
          projection: "plane",
          selection: {
            x: 0, y: 0, width: 640, height: 480, level: 0,
            t: isA ? 1 : 0, z: isA ? 2 : 0, c: isA ? 1 : 0,
          },
          camera: null,
          rgb_mapping: null,
        },
      };
    });
    const api = {
      getSnapshot: vi.fn(async () => snapshot),
      execute,
      onSnapshot: vi.fn(() => () => {}),
      onEvent: vi.fn(() => () => {}),
      logClientEvent: vi.fn(async () => {}),
    } as unknown as ResearchDesktopApi;
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Compare A/B" }));
    await waitFor(() => expect(screen.getAllByLabelText(/^Image viewer:/)).toHaveLength(2));
    expect(screen.getByLabelText("Pane A time")).toHaveValue(2);
    expect(screen.getByLabelText("Pane A Z")).toHaveValue(3);
    expect(screen.getByLabelText("Pane A channel view")).toHaveValue("1");
    expect(screen.getByLabelText("Pane B time")).toHaveValue(1);
    expect(screen.getByLabelText("Pane B Z")).toHaveValue(1);
    expect(screen.getByLabelText("Pane B channel view")).toHaveValue("0");
    await waitFor(() => {
      const calls = execute.mock.calls.filter(([operation]) => operation === "viewer_tile");
      expect(calls.some(([, request]) => request.source_id === snapshot.sources[0].id &&
        request.t === 1 && request.z === 2)).toBe(true);
      expect(calls.some(([, request]) => request.source_id === snapshot.sources[1].id &&
        request.t === 0 && request.z === 0)).toBe(true);
    });
  });

  it("discards delayed pane hydration after switching its source", async () => {
    const snapshot = structuredClone(twoSourceSnapshot);
    snapshot.sources.push({
      id: "c".repeat(32),
      name: "Field_03_Single_Channel",
      sha256: "3".repeat(64),
      metadata: {
        format: "TIFF",
        dimensions: { x: 320, y: 240, z: 1, t: 1, c: 1 },
        levels: [{ index: 0, dimensions: { x: 320, y: 240, z: 1, t: 1, c: 1 } }],
        channel_names: ["Single marker"],
      },
    });
    let releaseDefaults!: (value: unknown) => void;
    let releaseView!: (value: unknown) => void;
    const delayedDefaults = new Promise((resolve) => { releaseDefaults = resolve; });
    const delayedView = new Promise((resolve) => { releaseView = resolve; });
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      if (request.source_id === snapshot.sources[1].id && operation === "viewer_defaults") return delayedDefaults;
      if (request.source_id === snapshot.sources[1].id && operation === "source_view") return delayedView;
      return viewerContractResponse(operation, request, snapshot) ?? {};
    });
    const api = {
      getSnapshot: vi.fn(async () => snapshot),
      execute,
      onSnapshot: vi.fn(() => () => {}),
      onEvent: vi.fn(() => () => {}),
      logClientEvent: vi.fn(async () => {}),
    } as unknown as ResearchDesktopApi;
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Compare A/B" }));
    fireEvent.change(await screen.findByLabelText("Pinned Source B"), {
      target: { value: snapshot.sources[2].id },
    });
    await screen.findByLabelText("Image viewer: Field_03_Single_Channel");
    releaseDefaults({ source_id: snapshot.sources[1].id, source_sha256: snapshot.sources[1].sha256, channels: [] });
    releaseView({ source_id: snapshot.sources[1].id, source_sha256: snapshot.sources[1].sha256, revision: 0, state: null });

    await waitFor(() => {
      expect(screen.getByLabelText("Image viewer: Field_03_Single_Channel")).toBeVisible();
      expect(screen.queryByLabelText("Image viewer: Field_02_siScramble")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Pane B channel view")).toHaveTextContent("Single marker");
    });
  });

  it("exits A/B view when clicking Exit A/B button", async () => {
    const api = mockApi();
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Compare A/B" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare A/B" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Exit A/B" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Exit A/B" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("A/B image comparison toolbar")).toBeNull();
    });
  });
});
