// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
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
    render(<ImageViewport api={api()} source={source}
      selection={{ x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 }}
      channels={[{ channel: 0, low: 0, high: 255, gamma: 1, visible: true, color: "#ffffff" }]}
      initialCamera={{ x: 200, y: 150, scale: 1 }} resultOverlay={overlay}
      onError={vi.fn()} />);

    const viewport = screen.getByLabelText("Image viewer: Shared source");
    expect(viewport).toHaveAttribute("data-result-overlay", overlay.key);
    expect(viewport).toHaveAttribute("data-camera", JSON.stringify({ x: 200, y: 150, scale: 1 }));
    await waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: overlay.image }), 20, 40, 100, 80,
    ));
    expect(context.save).toHaveBeenCalled();
    expect(context.restore).toHaveBeenCalled();
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
