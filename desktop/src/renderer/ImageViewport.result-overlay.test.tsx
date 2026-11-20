// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchSource } from "../shared/research-contracts";
import { ImageViewport } from "./ImageViewport";
import type { ResolvedResultPlaneOverlay } from "./result-plane-overlay";

let context: Record<string, unknown> & { globalAlpha: number; drawImage: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  context = {
    ...Object.fromEntries([
      "setTransform", "fillRect", "drawImage", "beginPath", "moveTo", "lineTo",
      "closePath", "arc", "stroke", "fillText", "setLineDash", "save", "restore", "ellipse", "fill",
    ].map((name) => [name, vi.fn()])),
    globalAlpha: 1,
  } as typeof context;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    context.canvas = this;
    return context as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const width = this.classList?.contains("image-viewport") ? 400 : 0;
      const height = this.classList?.contains("image-viewport") ? 300 : 0;
      return { left: 0, top: 0, right: width, bottom: height, width, height,
        x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    },
  );
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 1;
    naturalHeight = 1;
    private value = "";
    set src(value: string) {
      this.value = value;
      const dimensions = value.match(/#viewer-(\d+)x(\d+)$/);
      if (dimensions) {
        this.naturalWidth = Number(dimensions[1]);
        this.naturalHeight = Number(dimensions[2]);
      }
      queueMicrotask(() => this.onload?.());
    }
    get src() { return this.value; }
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const source: ResearchSource = {
  id: "a".repeat(32), name: "Shared source", sha256: "b".repeat(64), source_kind: "native",
  metadata: {
    dimensions: { x: 400, y: 300, z: 1, t: 1, c: 1 },
    levels: [{ index: 0, dimensions: { x: 400, y: 300, z: 1, t: 1, c: 1 } }],
  },
};
const overlay: ResolvedResultPlaneOverlay = {
  key: `${"c".repeat(32)}:${"d".repeat(64)}`,
  image: "data:image/png;base64,overlay#viewer-50x40",
  resultId: "c".repeat(32), revisionHash: "d".repeat(64),
  sourceId: source.id, sourceSha256: source.sha256,
  left: 20, top: 40, width: 100, height: 80,
  pixelWidth: 50, pixelHeight: 40, opacity: 0.62,
};

function api(sourceForTiles: ResearchSource = source): ResearchDesktopApi {
  const dimensions = sourceForTiles.metadata.dimensions!;
  return {
    createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(),
    execute: vi.fn(async (operation: string, request: Record<string, unknown>) => {
      if (operation !== "viewer_tile") throw new Error("Unexpected operation");
      if (request.overview) return {
        image: `data:image/png;base64,overview#viewer-${dimensions.x}x${dimensions.y}`,
        source_sha256: sourceForTiles.sha256,
        source_extent: [dimensions.x, dimensions.y],
        selection: { t: Number(request.t ?? 0), z: Number(request.z ?? 0), c: Number(request.c ?? 0), level: 0, x: 0, y: 0, width: dimensions.x, height: dimensions.y },
        projection: (request.projection as "plane" | "max" | "mean") ?? null,
      };
      const selection = request.selection as { width: number; height: number };
      return {
        image: `data:image/png;base64,tile#viewer-${selection.width}x${selection.height}`,
        source_sha256: sourceForTiles.sha256,
        selection: request.selection,
      };
    }),
    reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
  };
}

describe("ImageViewport exact result overlay", () => {
  it("draws the result crop over source tiles with the unchanged source camera", async () => {
    const rendered = vi.fn((key: string | null) => {
      if (key) expect(context.drawImage).toHaveBeenCalledWith(expect.objectContaining({ src: overlay.image }), 20, 40, 100, 80);
    });
    render(<ImageViewport api={api()} source={source}
      selection={{ x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 }}
      channels={[{ channel: 0, low: 0, high: 255, gamma: 1, visible: true, color: "#ffffff" }]}
      initialCamera={{ x: 200, y: 150, scale: 1 }} resultOverlay={overlay}
      onResultRendered={rendered} onError={vi.fn()} />);

    const viewport = screen.getByLabelText("Image viewer: Shared source");
    expect(viewport).toHaveAttribute("data-result-overlay", overlay.key);
    expect(viewport).toHaveAttribute("data-camera", JSON.stringify({ x: 200, y: 150, scale: 1 }));
    await waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: overlay.image }), 20, 40, 100, 80,
    ));
    expect(context.save).toHaveBeenCalled();
    expect(context.restore).toHaveBeenCalled();
    expect(rendered).toHaveBeenLastCalledWith(overlay.key);
  });

  it("smooths a reduced source while sampling the exact label grid with nearest pixels", async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 400, 300));
    const samples: Array<{ src: string; smooth: unknown; args: unknown[] }> = [];
    context.drawImage.mockImplementation((image: HTMLImageElement, ...args: unknown[]) => {
      samples.push({ src: image.src, smooth: context.imageSmoothingEnabled, args });
    });
    const service = api();
    const execute = vi.mocked(service.execute);
    render(<ImageViewport dockedControls api={service} source={source}
      selection={{ x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 }}
      channels={[{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }]}
      initialCamera={{ x: 200, y: 150, scale: 0.4 }} resultOverlay={overlay} onError={vi.fn()} />);
    await waitFor(() => expect(samples.some((sample) => sample.src === overlay.image)).toBe(true));
    expect(samples.filter((sample) => sample.src === overlay.image).every((sample) => sample.smooth === false)).toBe(true);
    expect(samples.some((sample) => sample.src !== overlay.image && sample.smooth === true)).toBe(true);
    const readout = screen.getByLabelText("Image dimensions and display sampling");
    expect(within(readout).getByText("Reduced · smoothed")).toBeVisible();
    expect(within(readout).getByText("Labels · nearest pixel")).toBeVisible();

    const viewer = screen.getByLabelText(`Image viewer: ${source.name}`);
    const samplingGroup = screen.getByRole("group", { name: "Display sampling" });
    const requestsBefore = execute.mock.calls.length;
    const cameraBefore = viewer.getAttribute("data-camera");
    const lastSourceAuto = samples.findLast((sample) => sample.src !== overlay.image)!;
    const lastOverlayAuto = samples.findLast((sample) => sample.src === overlay.image)!;
    const countBeforeNearest = samples.length;

    fireEvent.click(within(samplingGroup).getByRole("button", { name: "Nearest pixel" }));
    const afterNearest = samples.slice(countBeforeNearest);
    expect(afterNearest.some((sample) => sample.src !== overlay.image && sample.smooth === false)).toBe(true);
    expect(afterNearest.filter((sample) => sample.src !== overlay.image).every((sample) => sample.smooth === false)).toBe(true);
    expect(afterNearest.find((sample) => sample.src === overlay.image)).toEqual({
      src: overlay.image,
      smooth: false,
      args: lastOverlayAuto.args,
    });
    expect(afterNearest.find((sample) => sample.src !== overlay.image)?.args).toEqual(lastSourceAuto.args);
    expect(within(readout).getByText("Reduced · nearest pixel")).toBeVisible();
    expect(within(readout).getByText("Labels · nearest pixel")).toBeVisible();
    expect(execute).toHaveBeenCalledTimes(requestsBefore);
    expect(viewer.getAttribute("data-camera")).toBe(cameraBefore);

    // At 1:1 and zoomed in, manual Smooth smooths only the source while categorical labels remain nearest-pixel.
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    const countBeforeSmooth = samples.length;
    const requestsAtNative = execute.mock.calls.length;
    fireEvent.click(within(samplingGroup).getByRole("button", { name: "Smooth" }));
    const afterSmooth = samples.slice(countBeforeSmooth);
    expect(afterSmooth.some((sample) => sample.src !== overlay.image && sample.smooth === true)).toBe(true);
    expect(afterSmooth.filter((sample) => sample.src === overlay.image).every((sample) => sample.smooth === false)).toBe(true);
    expect(within(readout).getByText("Smoothed")).toBeVisible();
    expect(within(readout).getByText("Labels · nearest pixel")).toBeVisible();
    expect(execute).toHaveBeenCalledTimes(requestsAtNative);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(samples.filter((sample) => sample.src !== overlay.image).at(-1)?.smooth).toBe(true);
    expect(samples.filter((sample) => sample.src === overlay.image).at(-1)?.smooth).toBe(false);
    expect(within(readout).getByText("Beyond native · smoothed")).toBeVisible();
    expect(within(readout).getByText("Labels · nearest pixel")).toBeVisible();
  });

  it("preserves derived analysis preview sampling and result-pixel picking across manual source modes", async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 400, 300));
    const samples: Array<{ src: string; smooth: unknown }> = [];
    context.drawImage.mockImplementation((image: HTMLImageElement) => {
      samples.push({ src: image.src, smooth: context.imageSmoothingEnabled });
    });
    const previewImage = "data:image/png;base64,analysis-preview#viewer-400x300";
    const onResultPoint = vi.fn();
    render(<ImageViewport dockedControls api={api()} source={source}
      selection={{ x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 }}
      channels={[{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }]}
      initialCamera={{ x: 200, y: 150, scale: 0.4 }} overrideImage={previewImage}
      resultOverlay={overlay} onResultPoint={onResultPoint} onError={vi.fn()} />);

    await waitFor(() => expect(samples.some((sample) => sample.src === previewImage)).toBe(true));
    await waitFor(() => expect(samples.some((sample) => sample.src === overlay.image)).toBe(true));
    const samplingGroup = screen.getByRole("group", { name: "Display sampling" });

    // Switching source to Nearest pixel at reduced zoom leaves derived analysis preview auto-smoothed.
    const beforeNearest = samples.length;
    fireEvent.click(within(samplingGroup).getByRole("button", { name: "Nearest pixel" }));
    const nearestSlice = samples.slice(beforeNearest);
    expect(nearestSlice.filter((sample) => sample.src !== previewImage && sample.src !== overlay.image).at(-1)?.smooth).toBe(false);
    expect(nearestSlice.find((sample) => sample.src === previewImage)?.smooth).toBe(true);
    expect(nearestSlice.find((sample) => sample.src === overlay.image)?.smooth).toBe(false);
    expect(screen.getByText("Source · nearest pixel")).toBeVisible();
    expect(screen.getByText("Preview · smoothed")).toBeVisible();

    // Switching source to Smooth at 1:1 leaves derived analysis preview nearest-pixel (auto) and picking unchanged.
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    const beforeSmooth = samples.length;
    fireEvent.click(within(samplingGroup).getByRole("button", { name: "Smooth" }));
    const smoothSlice = samples.slice(beforeSmooth);
    expect(smoothSlice.filter((sample) => sample.src !== previewImage && sample.src !== overlay.image).at(-1)?.smooth).toBe(true);
    expect(smoothSlice.find((sample) => sample.src === previewImage)?.smooth).toBe(false);
    expect(smoothSlice.find((sample) => sample.src === overlay.image)?.smooth).toBe(false);
    expect(screen.getByText("Source · smoothed")).toBeVisible();
    expect(screen.getByText("Preview · nearest pixel")).toBeVisible();

    const canvas = screen.getByLabelText("Source image and bound annotations");
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 45, clientY: 55 });
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: 45, clientY: 55 });
    expect(onResultPoint).toHaveBeenCalledWith({ u: 12, v: 7 });
  });

  it("identifies the painted process preview and restores the source readout when it is cleared", async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 400, 300));
    const viewer = {
      dockedControls: true, api: api(), source, onError: vi.fn(),
      selection: { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 },
      channels: [{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }],
      initialCamera: { x: 200, y: 150, scale: 0.4 },
    };
    const view = render(<ImageViewport {...viewer} />);
    const controls = screen.getByRole("group", { name: "Display sampling" });
    fireEvent.click(within(controls).getByRole("button", { name: "Nearest pixel" }));
    const readout = within(screen.getByLabelText("Image dimensions and display sampling"));
    expect(readout.getByText("Reduced · nearest pixel")).toBeVisible();
    expect(readout.queryByText(/^Preview/)).toBeNull();

    view.rerender(<ImageViewport {...viewer} overrideImage="data:image/png;base64,process#viewer-400x300" />);
    expect(await readout.findByText("Preview · smoothed")).toBeVisible();
    expect(readout.getByText("Source · nearest pixel")).toBeVisible();
    expect(readout.queryByText(/^Labels/)).toBeNull();

    view.rerender(<ImageViewport {...viewer} />);
    await waitFor(() => expect(readout.queryByText(/^Preview/)).toBeNull());
    expect(readout.getByText("Reduced · nearest pixel")).toBeVisible();
  });

  it("maps a source-camera click back to the exact result pixel grid", async () => {
    const onResultPoint = vi.fn();
    render(<ImageViewport api={api()} source={source}
      selection={{ x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 }}
      channels={[{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }]}
      initialCamera={{ x: 200, y: 150, scale: 1 }} resultOverlay={overlay}
      onResultPoint={onResultPoint} onError={vi.fn()} />);
    const viewport = screen.getByLabelText("Source image and bound annotations");
    await waitFor(() => expect(context.drawImage).toHaveBeenCalled());
    fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, clientX: 45, clientY: 55 });
    fireEvent.pointerUp(viewport, { pointerId: 1, button: 0, clientX: 45, clientY: 55 });
    expect(onResultPoint).toHaveBeenCalledWith({ u: 12, v: 7 });
  });

  it("fails closed when decoded overlay dimensions differ from the verified result grid", async () => {
    const onError = vi.fn();
    render(<ImageViewport api={api()} source={source}
      selection={{ x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 }}
      channels={[{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }]}
      initialCamera={{ x: 200, y: 150, scale: 1 }}
      resultOverlay={{ ...overlay, pixelWidth: 51 }} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      "The exact result overlay dimensions do not match its verified grid.",
    ));
    expect(context.drawImage).not.toHaveBeenCalledWith(
      expect.objectContaining({ src: overlay.image }), 20, 40, 100, 80,
    );
  });

  it("keeps physical brush feedback aligned to the exact result grid", async () => {
    render(<ImageViewport api={api()} source={source}
      selection={{ x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 }}
      channels={[{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }]}
      initialCamera={{ x: 200, y: 150, scale: 1 }} resultOverlay={overlay}
      resultDrawing={{ kind: "brush", points: [{ u: 12, v: 7 }], savedSeeds: [], radiusU: 3, radiusV: 2, unit: "um" }}
      onError={vi.fn()} />);
    await waitFor(() => expect(context.ellipse).toHaveBeenCalledWith(45, 55, 6, 4, 0, 0, Math.PI * 2));
  });

  it("refuses an overlay from another source", async () => {
    const onError = vi.fn();
    render(<ImageViewport api={api()} source={source}
      selection={{ x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 }}
      channels={[{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }]}
      resultOverlay={{ ...overlay, sourceSha256: "0".repeat(64) }} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("The result overlay does not match its source."));
    expect(context.drawImage).not.toHaveBeenCalledWith(expect.objectContaining({ src: overlay.image }),
      expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("keeps tiny source and result fit, reset, and zoom cameras persistable", async () => {
    const tinySource: ResearchSource = {
      ...source,
      id: "e".repeat(32),
      name: "Tiny source",
      sha256: "f".repeat(64),
      metadata: {
        ...source.metadata,
        dimensions: { x: 8, y: 8, z: 1, t: 1, c: 1 },
        levels: [{ index: 0, dimensions: { x: 8, y: 8, z: 1, t: 1, c: 1 } }],
      },
    };
    const selection = { x: 0, y: 0, width: 8, height: 8, z: 0, t: 0, c: 0, level: 0 };
    const channels = [{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }];
    const onCamera = vi.fn();
    const props = { api: api(tinySource), source: tinySource, selection, channels, onCamera,
      onError: vi.fn() };
    const rendered = render(<ImageViewport {...props} />);
    const viewport = screen.getByLabelText("Image viewer: Tiny source");

    await waitFor(() => expect(viewport).toHaveAttribute(
      "data-camera", JSON.stringify({ x: 4, y: 4, scale: 32 }),
    ));
    fireEvent.keyDown(viewport, { key: "1" });
    await waitFor(() => expect(viewport).toHaveAttribute(
      "data-camera", JSON.stringify({ x: 4, y: 4, scale: 1 }),
    ));

    const tinyOverlay: ResolvedResultPlaneOverlay = {
      ...overlay,
      sourceId: tinySource.id,
      sourceSha256: tinySource.sha256,
      left: 0,
      top: 0,
      width: 8,
      height: 8,
      pixelWidth: 8,
      pixelHeight: 8,
      image: "data:image/png;base64,overlay#viewer-8x8",
    };
    rendered.rerender(<ImageViewport {...props} resultOverlay={tinyOverlay} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset camera" }));
    await waitFor(() => expect(viewport).toHaveAttribute(
      "data-camera", JSON.stringify({ x: 4, y: 4, scale: 32 }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit image" }));

    expect(onCamera).toHaveBeenCalledWith({ x: 4, y: 4, scale: 1 });
    expect(onCamera).toHaveBeenCalledWith({ x: 4, y: 4, scale: 32 });
    expect(onCamera.mock.calls.every(([camera]) =>
      camera.scale >= 1e-12 && camera.scale <= 64,
    )).toBe(true);
    await waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: tinyOverlay.image }), 72, 22, 256, 256,
    ));
  });

  it("drags only a selected boundary vertex in result coordinates without appending a point or panning", async () => {
    const onSelectVertex = vi.fn(), onMoveVertex = vi.fn(), onResultPoint = vi.fn();
    const points = [{ u: 12, v: 7 }, { u: 32, v: 7 }, { u: 32, v: 27 }, { u: 12, v: 27 }];
    render(<ImageViewport api={api()} source={source}
      selection={{ x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 }}
      channels={[{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }]}
      initialCamera={{ x: 200, y: 150, scale: 1 }} resultOverlay={overlay}
      resultDrawing={{ kind: "vertices", points, sourceVertices: points, selectedIndex: 0,
        savedSeeds: [], onSelectVertex, onMoveVertex }}
      onResultPoint={onResultPoint} onError={vi.fn()} />);
    const canvas = screen.getByLabelText("Source image and bound annotations");
    const viewport = screen.getByLabelText("Image viewer: Shared source");
    await waitFor(() => expect(context.arc).toHaveBeenCalledWith(45, 55, 5, 0, Math.PI * 2));
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 45, clientY: 55 });
    fireEvent.pointerMove(canvas, { pointerId: 1, button: 0, clientX: 51, clientY: 59 });
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: 51, clientY: 59 });
    expect(onSelectVertex).toHaveBeenCalledWith(0);
    expect(onMoveVertex).toHaveBeenCalledWith(0, { u: 15, v: 9 });
    expect(onResultPoint).not.toHaveBeenCalled();
    expect(viewport).toHaveAttribute("data-camera", JSON.stringify({ x: 200, y: 150, scale: 1 }));
    onMoveVertex.mockClear();
    fireEvent.pointerDown(canvas, { pointerId: 2, button: 0, clientX: 190, clientY: 190 });
    fireEvent.pointerMove(canvas, { pointerId: 2, button: 0, clientX: 210, clientY: 210 });
    fireEvent.pointerUp(canvas, { pointerId: 2, button: 0, clientX: 210, clientY: 210 });
    expect(onMoveVertex).not.toHaveBeenCalled();
    expect(onResultPoint).not.toHaveBeenCalled();
  });

});
