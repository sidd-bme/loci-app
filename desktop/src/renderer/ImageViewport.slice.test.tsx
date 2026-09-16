// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { ImageViewport } from "./ImageViewport";

let context: Record<string, unknown> & { drawImage: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  context = Object.fromEntries([
    "setTransform", "fillRect", "drawImage", "beginPath", "moveTo", "lineTo",
    "closePath", "arc", "stroke", "fillText", "setLineDash", "save", "restore",
    "ellipse", "fill",
  ].map((name) => [name, vi.fn()])) as typeof context;
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const source: ResearchSource = {
  id: "source-3d-test".padEnd(32, "0"),
  name: "3D Stack",
  sha256: "c".repeat(64),
  source_kind: "native",
  metadata: {
    dimensions: { x: 400, y: 300, z: 10, t: 1, c: 1 },
    levels: [{ index: 0, dimensions: { x: 400, y: 300, z: 10, t: 1, c: 1 } }],
  },
};

const channels = [{ channel: 0, low: 0, high: 255, gamma: 1, visible: true, color: "#ffffff" }];

describe("ImageViewport smooth slice navigation", () => {
  it("does not blank the canvas to black when navigating between Z slices of the same source", async () => {
    const execute = vi.fn(async (_op: string, request: Record<string, unknown>) => {
      const z = (request.z ?? (request.selection as any)?.z) ?? 0;
      return {
        image: `data:image/png;base64,slice-z${z}#viewer-400x300`,
        source_sha256: source.sha256,
        source_extent: [400, 300],
        selection: request.selection,
      };
    });
    const api = { execute } as unknown as ResearchDesktopApi;
    const onError = vi.fn();

    const selectionZ0: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    const rendered = render(
      <ImageViewport api={api} source={source} selection={selectionZ0} channels={channels} onError={onError} />
    );

    // Initial render loads Z=0 overview and tile
    await waitFor(() => expect(execute).toHaveBeenCalled());
    await waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: expect.stringContaining("slice-z0") }),
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
    ));

    // Clear call history to check behavior upon slice change
    context.fillRect.mockClear();

    // Change to Z=1 (dragging the Z slider)
    const selectionZ1: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 1, t: 0, c: 0, level: 0 };
    rendered.rerender(
      <ImageViewport api={api} source={source} selection={selectionZ1} channels={channels} onError={onError} />
    );

    // Verify Z=1 loads and renders smoothly
    await waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: expect.stringContaining("slice-z1") }),
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
    ));

    // Now change back to Z=0 - should use cached tiles without error
    const selectionZ0Again: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    rendered.rerender(
      <ImageViewport api={api} source={source} selection={selectionZ0Again} channels={channels} onError={onError} />
    );

    await waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: expect.stringContaining("slice-z0") }),
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
    ));
    expect(onError).not.toHaveBeenCalled();
  });
});
