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
import ResearchWorkbench from "./ResearchWorkbench";
import { dropPanelOutside, panelDropPoint } from "./panel-pointer.test-utils";
import type { DisplayInspectorBinding, DisplayInspectorOwnerApi } from "../shared/display-inspector-api";
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
      if (this.matches(".image-viewport > canvas")) {
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
        channel_names: ["DAPI", "Signal-Alexa555"],
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
        channel_names: ["DAPI", "Signal-Alexa555"],
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
            selection: { t: request.t ?? 0, z: request.z ?? 0, c: request.c ?? 0, z_stop: request.z_stop ?? null },
            projection: request.projection ?? null,
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
  it("keeps a palette source's selected C through tone edits, reset, reopen and comparison", async () => {
    const snapshot = structuredClone(twoSourceSnapshot);
    const rgb = snapshot.sources[0];
    rgb.metadata = { ...rgb.metadata, sample_semantics: "RGB", channel_dtypes: ["uint16", "uint16"],
      dimensions: { ...rgb.metadata.dimensions!, c: 2, s: 3 },
      palette: { stored_index_dtype: "uint8", lookup_dtype: "uint16", lookup_policy: "actual-IFD-ColorMap", expansion: "exact-RGB-lookup-no-normalization" } };
    let saved: { source_id: string; source_sha256: string; revision: number; state: any } = {
      source_id: rgb.id, source_sha256: rgb.sha256, revision: 0, state: null,
    };
    let finishInitialLoad!: () => void;
    let initialLoad = true;
    const initialSavedView = new Promise<void>((resolve) => { finishInitialLoad = resolve; });
    const api = mockApi(snapshot);
    const execute = vi.mocked(api.execute);
    execute.mockImplementation(async (operation, request) => {
      if (request.source_id === rgb.id) {
        if (operation === "viewer_defaults") return { source_id: rgb.id, source_sha256: rgb.sha256, basis: "Native RGB",
          channels: [{ channel: request.c ?? 0, low: 0, high: 65535, gamma: 1, color: "#ffffff", opacity: 1, visible: true }] };
        if (operation === "source_view") {
          if (initialLoad) await initialSavedView;
          return structuredClone(saved);
        }
        if (operation === "save_source_view") {
          expect(request.expected_revision).toBe(saved.revision);
          saved = { ...saved, revision: saved.revision + 1, state: structuredClone(request.state) };
          expect(saved.state.channels).toHaveLength(1);
          expect(saved.state.channels[0].channel).toBe(saved.state.selection.c);
          return structuredClone(saved);
        }
      }
      return viewerContractResponse(operation, request, snapshot) ?? {};
    });
    const view = render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    const imageChannel = await screen.findByRole("combobox", { name: "Image channel" });
    expect(imageChannel).toBeDisabled();
    // A programmatic event must not bypass the same initialization boundary.
    fireEvent.change(imageChannel, { target: { value: "1" } });
    expect(execute.mock.calls.some(([operation]) => operation === "save_source_view")).toBe(false);
    await act(async () => { initialLoad = false; finishInitialLoad(); });
    await waitFor(() => expect(imageChannel).toBeEnabled());
    expect(imageChannel).toHaveValue("0");
    fireEvent.change(imageChannel, { target: { value: "1" } });
    await waitFor(() => expect(execute.mock.calls.some(([operation, request]) => operation === "viewer_tile" &&
      request.source_id === rgb.id && ((request.selection as { c?: number })?.c ?? request.c) === 1 &&
      (request.channels as Array<{ channel: number }>)[0].channel === 1)).toBe(true));
    fireEvent.change(screen.getByLabelText("RGB gamma"), { target: { value: "1.4" } });
    fireEvent.blur(screen.getByLabelText("RGB gamma"));
    await waitFor(() => expect(saved.state?.channels[0]).toEqual(expect.objectContaining({ channel: 1, gamma: 1.4 })));
    view.unmount();
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Image channel" })).toHaveValue("1"));
    expect(screen.getByLabelText("RGB gamma")).toHaveValue("1.4");
    fireEvent.click(screen.getByRole("button", { name: "Reset display" }));
    await waitFor(() => expect(saved.state?.channels[0]).toEqual(expect.objectContaining({ channel: 1, gamma: 1 })));
    fireEvent.click(screen.getByRole("button", { name: "Compare A/B" }));
    await waitFor(() => expect(screen.getByLabelText("Pane A channel view")).toHaveValue("1"));
    expect(within(screen.getByLabelText("Pane A channel view")).queryByText("All visible")).toBeNull();
    fireEvent.change(screen.getByLabelText("Pane A channel view"), { target: { value: "0" } });
    await waitFor(() => expect(screen.getByLabelText("Pane A channel view")).toHaveValue("0"));
    expect(saved.state.selection.c).toBe(1);
  });

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

  it("keeps the initiating linked camera when an unequal receiving pane clamps its view", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    expect(window.devicePixelRatio).toBe(2);
    const dimensions = { x: 320, y: 256, z: 1, t: 1, c: 2 };
    const snapshot = structuredClone(twoSourceSnapshot);
    for (const source of snapshot.sources) {
      source.metadata.dimensions = dimensions;
      source.metadata.levels = [{ index: 0, dimensions }];
    }

    // Pane A admits the explicit 1:1 camera at scale 0.5. Pane B has a
    // larger local fit and a minimum scale of 0.6. Its local constraint
    // must not replace Pane A's camera when it observes the linked update.
    let paneAWidth = 240, paneBWidth = 1000;
    const boundsMock = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    const defaultBounds = boundsMock.getMockImplementation()!;
    boundsMock.mockImplementation(function (this: HTMLElement) {
      const pane = this.closest(".research-ab-pane");
      if (!this.matches(".image-viewport > canvas") || !pane) {
        return defaultBounds.call(this);
      }
      const first = pane.querySelector("strong")?.textContent === "Pane A";
      const width = first ? paneAWidth : paneBWidth;
      const height = first ? 200 : 900;
      return {
        left: 0, top: 0, right: width, bottom: height,
        width, height, x: 0, y: 0, toJSON: () => ({}),
      } as DOMRect;
    });

    const api = mockApi(snapshot);
    const execute = vi.mocked(api.execute);
    const defaultExecute = execute.getMockImplementation()!;
    let holdRepin = false;
    let releaseRepin: () => void = () => { throw new Error("Repin reply was not held"); };
    const repinGate = new Promise<void>((resolve) => { releaseRepin = resolve; });
    execute.mockImplementation(async (operation, request, options) => {
      const response = await defaultExecute(operation, request, options);
      if (holdRepin && operation === "source_view" && request.source_id === snapshot.sources[0].id) {
        await repinGate;
      }
      return response;
    });

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Compare A/B" }));
    const link = await screen.findByLabelText("Link pan and zoom");
    await waitFor(() => {
      for (const source of snapshot.sources) {
        expect(screen.getByLabelText(`Image viewer: ${source.name}`)).toHaveAttribute("data-prepared", "true");
      }
    });

    holdRepin = true;
    fireEvent.change(screen.getByLabelText("Pinned Source B"), {
      target: { value: snapshot.sources[0].id },
    });
    expect(link).toBeDisabled();
    expect(screen.queryByLabelText(`Image viewer: ${snapshot.sources[1].name}`)).toBeNull();
    await act(async () => { releaseRepin(); });
    await waitFor(() => expect(link).toBeEnabled());
    const [a, b] = screen.getAllByLabelText(`Image viewer: ${snapshot.sources[0].name}`);
    await waitFor(() => {
      expect(a).toHaveAttribute("data-prepared", "true");
      expect(b).toHaveAttribute("data-prepared", "true");
    });
    const camera = (pane: HTMLElement) => JSON.parse(pane.getAttribute("data-camera")!);
    expect(a.querySelector("canvas")?.getBoundingClientRect().width).toBe(240);
    expect(b.querySelector("canvas")?.getBoundingClientRect().width).toBe(1000);
    fireEvent.click(link);
    expect(link).toBeChecked();
    fireEvent.keyDown(a, { key: "1" });
    await waitFor(() => expect(camera(a).scale).toBe(0.5));

    paneBWidth = 1100;
    act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
    await waitFor(() => expect(camera(b).scale).toBeCloseTo(0.66));
    expect(camera(a).scale).toBe(0.5);

    // Batch real viewport keyboard handlers to check updates do not replay an
    // observed camera from the other pane or lose user input under batching.
    act(() => {
      for (let zoom = 0; zoom < 4; zoom++) fireEvent.keyDown(a, { key: "+" });
    });
    await waitFor(() => {
      expect(camera(a).scale).toBe(0.5 * 1.25 ** 4);
      expect(camera(b)).toEqual(camera(a));
    });
    act(() => {
      for (let zoom = 0; zoom < 2; zoom++) fireEvent.keyDown(b, { key: "+" });
    });
    await waitFor(() => {
      expect(camera(b).scale).toBe(0.5 * 1.25 ** 6);
      expect(camera(a)).toEqual(camera(b));
    });

    fireEvent.click(within(a).getByRole("button", { name: "Fit image" }));
    const fit = camera(a);
    paneAWidth = 180;
    act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
    expect(camera(a)).toEqual(fit);
    expect(camera(b)).toEqual(fit);
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
    fireEvent.blur(timeA);
    fireEvent.change(zA, { target: { value: "3" } });
    fireEvent.blur(zA);
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
    await waitFor(() => expect(screen.getByLabelText("Pane A time")).toHaveValue("2"));
    expect(screen.getByLabelText("Pane A Z")).toHaveValue("3");
    expect(screen.getByLabelText("Pane A channel view")).toHaveValue("1");
    expect(screen.getByLabelText("Pane B time")).toHaveValue("1");
    expect(screen.getByLabelText("Pane B Z")).toHaveValue("1");
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

  it("keeps display sampling independent across A/B linked panes and persistent across annotation-tool switches", async () => {
    type TrackedDraw = { smooth: unknown };
    type TrackedContext = Record<string, unknown> & {
      imageSmoothingEnabled?: boolean;
      drawImage: ReturnType<typeof vi.fn>;
      drawCalls: TrackedDraw[];
    };
    const contexts = new Map<HTMLCanvasElement, TrackedContext>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      let tracked = contexts.get(this);
      if (!tracked) {
        const drawCalls: TrackedDraw[] = [];
        tracked = {
          ...Object.fromEntries(
            [
              "setTransform", "fillRect", "beginPath", "moveTo", "lineTo",
              "closePath", "arc", "stroke", "fillText", "setLineDash",
              "save", "restore", "ellipse", "fill", "clearRect", "rect", "clip",
            ].map((name) => [name, vi.fn()]),
          ),
          canvas: this, drawCalls,
          drawImage: vi.fn(() => {
            drawCalls.push({ smooth: tracked!.imageSmoothingEnabled });
          }),
        };
        contexts.set(this, tracked);
      }
      return tracked as unknown as CanvasRenderingContext2D;
    });

    const api = mockApi();
    const execute = vi.mocked(api.execute);
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    const mainViewer = await screen.findByLabelText("Image viewer: Field_01_Untreated");
    await waitFor(() => expect(mainViewer).toHaveAttribute("data-prepared", "true"));
    const mainCanvas = mainViewer.querySelector("canvas")!;
    const mainCtx = contexts.get(mainCanvas)!;
    await waitFor(() => expect(mainCtx.drawCalls.length).toBeGreaterThan(0));

    const mainSampling = within(mainViewer).getByRole("group", { name: "Display sampling" });
    const mainReadout = within(mainViewer).getByLabelText("Image dimensions and display sampling");
    expect(within(mainSampling).getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
    expect(within(mainReadout).getByText("Reduced · smoothed")).toBeVisible();
    expect(mainCtx.drawCalls.at(-1)?.smooth).toBe(true);

    const tileRequestsBeforeManual = execute.mock.calls.filter(([op]) => op === "viewer_tile").length;
    const mainCameraBefore = mainViewer.getAttribute("data-camera");
    const mainDrawsBefore = mainCtx.drawCalls.length;
    fireEvent.click(within(mainSampling).getByRole("button", { name: "Nearest pixel" }));
    expect(within(mainSampling).getByRole("button", { name: "Nearest pixel" })).toHaveAttribute("aria-pressed", "true");
    expect(within(mainReadout).getByText("Reduced · nearest pixel")).toBeVisible();
    await waitFor(() => expect(mainCtx.drawCalls.length).toBeGreaterThan(mainDrawsBefore));
    expect(mainCtx.drawCalls.at(-1)?.smooth).toBe(false);
    expect(mainViewer.getAttribute("data-camera")).toBe(mainCameraBefore);
    expect(execute.mock.calls.filter(([op]) => op === "viewer_tile")).toHaveLength(tileRequestsBeforeManual);

    // Switching annotation tools remounts the docked ImageViewport, while session sampling persists.
    const navigation = screen.getByRole("navigation", { name: "Task groups" });
    fireEvent.click(within(navigation).getByRole("button", { name: "Annotate" }));
    for (const toolName of ["Distance", "Polygon", "Point"]) {
      fireEvent.click(await screen.findByRole("button", { name: toolName }));
      const activeViewer = await screen.findByLabelText("Image viewer: Field_01_Untreated");
      await waitFor(() => expect(activeViewer).toHaveAttribute("data-prepared", "true"));
      const activeCanvas = activeViewer.querySelector("canvas")!;
      const activeCtx = contexts.get(activeCanvas)!;
      await waitFor(() => expect(activeCtx.drawCalls.length).toBeGreaterThan(0));
      expect(within(activeViewer).getByRole("button", { name: "Nearest pixel" })).toHaveAttribute("aria-pressed", "true");
      expect(within(activeViewer).getByText("Reduced · nearest pixel")).toBeVisible();
      expect(activeCtx.drawCalls.at(-1)?.smooth).toBe(false);
      expect(activeViewer.getAttribute("data-camera")).toBe(mainCameraBefore);
    }

    // Enter A/B comparison and link both panes on the same immutable source.
    fireEvent.click(screen.getByRole("button", { name: "Compare A/B" }));
    fireEvent.change(await screen.findByLabelText("Pinned Source B"), {
      target: { value: "a".repeat(32) },
    });

    const linkCheckbox = screen.getByLabelText("Link pan and zoom") as HTMLInputElement;
    await waitFor(() => expect(linkCheckbox).toBeEnabled());
    await waitFor(() => {
      const viewers = screen.getAllByLabelText("Image viewer: Field_01_Untreated");
      expect(viewers).toHaveLength(2);
      expect(viewers[0]).toHaveAttribute("data-prepared", "true");
      expect(viewers[1]).toHaveAttribute("data-prepared", "true");
    });

    fireEvent.click(linkCheckbox);
    expect(linkCheckbox.checked).toBe(true);

    const [paneA, paneB] = screen.getAllByLabelText("Image viewer: Field_01_Untreated");
    const canvasA = paneA.querySelector("canvas")!;
    const canvasB = paneB.querySelector("canvas")!;
    const ctxA = contexts.get(canvasA)!;
    const ctxB = contexts.get(canvasB)!;
    await waitFor(() => {
      expect(ctxA.drawCalls.length).toBeGreaterThan(0);
      expect(ctxB.drawCalls.length).toBeGreaterThan(0);
    });

    const samplingA = within(paneA).getByRole("group", { name: "Display sampling" });
    const samplingB = within(paneB).getByRole("group", { name: "Display sampling" });
    expect(within(samplingA).getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
    expect(within(samplingB).getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");

    // Set Pane A to Nearest pixel while Pane B stays on Auto.
    const abTilesBefore = execute.mock.calls.filter(([op]) => op === "viewer_tile").length;
    const drawsABefore = ctxA.drawCalls.length;
    const drawsBBefore = ctxB.drawCalls.length;
    fireEvent.click(within(samplingA).getByRole("button", { name: "Nearest pixel" }));
    expect(within(samplingA).getByRole("button", { name: "Nearest pixel" })).toHaveAttribute("aria-pressed", "true");
    expect(within(samplingB).getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(ctxA.drawCalls.length).toBeGreaterThan(drawsABefore));
    expect(ctxA.drawCalls.at(-1)?.smooth).toBe(false);
    expect(ctxB.drawCalls.length).toBe(drawsBBefore);
    expect(ctxB.drawCalls.at(-1)?.smooth).toBe(true);
    expect(within(paneA).getByText("Reduced · nearest pixel")).toBeVisible();
    expect(within(paneB).getByText("Reduced · smoothed")).toBeVisible();
    expect(execute.mock.calls.filter(([op]) => op === "viewer_tile")).toHaveLength(abTilesBefore);

    // Linked 1:1 updates both cameras; Pane B (Auto) uses nearest pixel at 1:1, then override Pane B to Smooth.
    fireEvent.click(within(paneA).getByRole("button", { name: "1:1" }));
    await waitFor(() => {
      expect(JSON.parse(paneA.getAttribute("data-camera")!).scale).toBe(1);
      expect(JSON.parse(paneB.getAttribute("data-camera")!)).toEqual(JSON.parse(paneA.getAttribute("data-camera")!));
      expect(ctxA.drawCalls.at(-1)?.smooth).toBe(false);
      expect(ctxB.drawCalls.at(-1)?.smooth).toBe(false);
    });

    const drawsBAtNative = ctxB.drawCalls.length;
    fireEvent.click(within(samplingB).getByRole("button", { name: "Smooth" }));
    expect(within(samplingB).getByRole("button", { name: "Smooth" })).toHaveAttribute("aria-pressed", "true");
    expect(within(samplingA).getByRole("button", { name: "Nearest pixel" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(ctxB.drawCalls.length).toBeGreaterThan(drawsBAtNative));
    expect(ctxB.drawCalls.at(-1)?.smooth).toBe(true);
    expect(ctxA.drawCalls.at(-1)?.smooth).toBe(false);
    expect(within(within(paneB).getByLabelText("Image dimensions and display sampling")).getByText("Smoothed")).toBeVisible();
    expect(within(within(paneA).getByLabelText("Image dimensions and display sampling")).getByText("Nearest pixel")).toBeVisible();

    // Linked zoom in keeps cameras locked and preserves independent sampling per pane.
    fireEvent.click(within(paneA).getByRole("button", { name: "Zoom in" }));
    await waitFor(() => {
      const cameraA = JSON.parse(paneA.getAttribute("data-camera")!);
      const cameraB = JSON.parse(paneB.getAttribute("data-camera")!);
      expect(cameraA.scale).toBeGreaterThan(1);
      expect(cameraB).toEqual(cameraA);
      expect(ctxA.drawCalls.at(-1)?.smooth).toBe(false);
      expect(ctxB.drawCalls.at(-1)?.smooth).toBe(true);
    });
    expect(within(paneA).getByText("Beyond native · nearest pixel")).toBeVisible();
    expect(within(paneB).getByText("Beyond native · smoothed")).toBeVisible();

    // Exit A/B and verify main workbench pane retains its Nearest pixel choice.
    fireEvent.click(screen.getByRole("button", { name: "Exit A/B" }));
    const restoredMain = await screen.findByLabelText("Image viewer: Field_01_Untreated");
    await waitFor(() => expect(restoredMain).toHaveAttribute("data-prepared", "true"));
    expect(within(restoredMain).getByRole("button", { name: "Nearest pixel" })).toHaveAttribute("aria-pressed", "true");
    expect(within(restoredMain).getByText("Reduced · nearest pixel")).toBeVisible();
    const restoredCtx = contexts.get(restoredMain.querySelector("canvas")!)!;
    await waitFor(() => expect(restoredCtx.drawCalls.at(-1)?.smooth).toBe(false));
  });
});

describe("detachable Display in the loaded workbench", () => {
  async function displayWorkbench() {
    const snapshot = structuredClone(twoSourceSnapshot);
    const source = snapshot.sources[0];
    source.source_kind = "medical";
    source.metadata.dimensions!.z = 5;
    source.metadata.levels![0].dimensions.z = 5;
    source.metadata.physical_calibration = { spacing: [4, 2, 2], unit: "µm" };
    const api = mockApi(snapshot);
    let lifecycle!: Parameters<DisplayInspectorOwnerApi["onLifecycle"]>[0];
    let edit!: Parameters<DisplayInspectorOwnerApi["onEdit"]>[0];
    let binding!: DisplayInspectorBinding;
    let generation = 0;
    const native: DisplayInspectorOwnerApi = {
      open: vi.fn(async (target) => {
        binding = { ...target, generation: ++generation };
        lifecycle({ status: "opening", binding });
        lifecycle({ status: "open", binding });
        return binding;
      }),
      onLifecycle: (listener) => { lifecycle = listener; return () => {}; },
      onEdit: (listener) => { edit = listener; return () => {}; },
      focus: vi.fn(async () => {}), dock: vi.fn(async () => {}), revoke: vi.fn(async () => {}),
      publish: vi.fn(async () => {}),
    };
    vi.stubGlobal("lociDisplayInspectorOwner", native);
    const onBack = vi.fn();
    const view = render(<ResearchWorkbench api={api} onBack={onBack} />);
    const tools = () => view.container.querySelector<HTMLElement>("#research-tools-pane")!;
    const detachButton = () => within(tools()).getByRole("button", { name: "Detach Display" });
    const stage = () => view.container.querySelector<HTMLElement>("#research-image-stage");
    await waitFor(() => expect(detachButton()).toBeEnabled());
    const close = () => act(() => lifecycle({ binding, status: "closed", reason: "native-close" }));
    const apply = (action: Parameters<typeof edit>[0]["action"]) => act(() => edit({ binding, action }));
    const open = () => act(async () => { fireEvent.click(detachButton()); });
    return {
      api, native, source, otherSource: snapshot.sources[1],
      tools, stage, detachButton, open, close, apply, binding: () => binding,
      hide: () => view.rerender(<ResearchWorkbench api={api} onBack={onBack} visible={false} />),
    };
  }

  it("keeps one viewport and one source view store across native edits and redocking", async () => {
    const workbench = await displayWorkbench();
    const { api, native, source, tools, detachButton, close, apply } = workbench;
    const stage = workbench.stage()!;
    const canvas = stage.querySelector("canvas");
    expect(canvas).not.toBeNull();
    await workbench.open();
    expect(within(stage).getByRole("button", { name: "Focus Display inspector" })).toBeVisible();
    expect(tools()).toHaveAttribute("hidden");
    expect(workbench.stage()?.querySelector("canvas")).toBe(canvas);
    const initial = vi.mocked(native.open).mock.calls[0][1];
    expect(initial.source).toEqual(expect.objectContaining({ id: source.id, sha256: source.sha256 }));
    if (initial.kind) throw new Error("Expected the Display snapshot");
    expect(initial.source.metadata.physical_calibration).toEqual(source.metadata.physical_calibration);
    apply({ kind: "channel", channel: 0, edit: { field: "color", value: "#a1b2c3" } });
    apply({ kind: "channel", channel: 0, edit: { field: "opacity", value: 0.27 } });
    apply({ kind: "channel", channel: 0, edit: { field: "level", value: 200 } });
    apply({ kind: "channel", channel: 0, edit: { field: "window", value: 126 } });
    apply({ kind: "projection", value: "max" });
    apply({ kind: "projection", value: "plane" });
    apply({ kind: "plane", axis: "z", value: 3 });
    const last = vi.mocked(native.publish).mock.calls.at(-1)![1];
    if (last.kind) throw new Error("Expected the Display snapshot");
    expect(last.channels[0]).toEqual(expect.objectContaining({ color: "#a1b2c3", opacity: 0.27, low: 137, high: 263 }));
    expect(last.selection).toEqual(expect.objectContaining({ z: 3 }));
    expect(last.selection.z_stop).toBeUndefined();

    apply({ kind: "channel", channel: 0, edit: { field: "high", value: 136 } });
    expect(native.publish).toHaveBeenLastCalledWith(workbench.binding(), last, true);
    apply({ kind: "compare", active: true });
    close();
    expect(detachButton()).toHaveFocus();
    expect(workbench.stage()?.querySelector("canvas")).toBe(canvas);
    const display = within(tools());
    expect(display.getByLabelText("Z plane")).toHaveValue("3");
    const channel = display.getByRole("checkbox", { name: "Channel 1 visible" }).closest("details")!;
    channel.open = true;
    expect(within(channel).getByLabelText("Channel 1 color")).toHaveValue("#a1b2c3");
    expect(within(channel).getByLabelText("Channel 1 opacity")).toHaveValue("0.27");
    expect(within(channel).getByLabelText("Channel 1 window")).toHaveValue("126");
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith("save_source_view", expect.objectContaining({
      source_id: source.id,
      source_sha256: source.sha256,
      state: expect.objectContaining({
        selection: expect.objectContaining({ z: 3 }),
        channels: expect.arrayContaining([expect.objectContaining({ channel: 0, opacity: 0.27 })]),
      }),
    })));
  });

  it("fences retired Display edits after a source switch or workbench hide", async () => {
    const { native, source, otherSource, stage, detachButton, open, apply, binding, hide } = await displayWorkbench();
    await act(async () => { dropPanelOutside(detachButton().parentElement!); });
    const focusInspector = () => within(stage()!).queryByRole("button", { name: "Focus Display inspector" });
    expect(focusInspector()).toBeVisible();
    expect(native.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceId: source.id, sourceSha256: source.sha256 }), expect.anything(),
      { atPointer: true, dropPoint: panelDropPoint },
    );
    const firstBinding = binding();
    fireEvent.click(screen.getByLabelText(otherSource.name));
    await waitFor(() => expect(native.revoke).toHaveBeenLastCalledWith(firstBinding));
    const beforeStaleEdit = vi.mocked(native.publish).mock.calls.length;
    apply({ kind: "reset" });
    expect(native.publish).toHaveBeenCalledTimes(beforeStaleEdit);
    expect(focusInspector()).toBeNull();

    await waitFor(() => expect(detachButton()).toBeEnabled());
    await open();
    expect(focusInspector()).toBeVisible();
    const detachedBinding = binding();
    expect(detachedBinding).toMatchObject({ sourceId: otherSource.id, sourceSha256: otherSource.sha256 });
    hide();
    await waitFor(() => expect(native.revoke).toHaveBeenLastCalledWith(detachedBinding));
    const publications = vi.mocked(native.publish).mock.calls.length;
    apply({ kind: "plane", axis: "z", value: 1 });
    expect(native.publish).toHaveBeenCalledTimes(publications);
    expect(stage()).toBeNull();
  });
});
