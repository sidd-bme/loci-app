// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { ImageViewport } from "./ImageViewport";

let context: Record<string, unknown> & {
  drawImage: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
};

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
    naturalWidth = 400;
    naturalHeight = 300;
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
  id: "source-nav-test".padEnd(32, "0"),
  name: "Navigation Stack",
  sha256: "d".repeat(64),
  source_kind: "native",
  metadata: {
    dimensions: { x: 400, y: 300, z: 20, t: 1, c: 1 },
    levels: [{ index: 0, dimensions: { x: 400, y: 300, z: 20, t: 1, c: 1 } }],
  },
};

const channels = [{ channel: 0, low: 0, high: 255, gamma: 1, visible: true, color: "#ffffff" }];

describe("ImageViewport plane navigation contract", () => {
  it("deferred fake decoder: rapidly selects Z planes and proves only latest matching receipt paints/readies", async () => {
    type Resolver = (receipt: unknown) => void;
    const pendingResolvers = new Map<number, Resolver>();

    const execute = vi.fn((_op: string, request: Record<string, unknown>) => {
      const z = Number(request.z ?? (request.selection as ResearchSelection)?.z ?? 0);
      return new Promise((resolve) => {
        pendingResolvers.set(z, resolve);
      });
    });
    const api = { execute } as unknown as ResearchDesktopApi;
    const onViewReady = vi.fn();
    const onError = vi.fn();

    const selectionZ0: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    const { container, rerender } = render(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionZ0}
        channels={channels}
        onViewReady={onViewReady}
        onError={onError}
      />
    );

    const viewport = container.querySelector(".image-viewport") as HTMLElement;
    expect(viewport.dataset.prepared).toBe("false");

    // Resolve Z=0
    expect(pendingResolvers.has(0)).toBe(true);
    await act(async () => {
      pendingResolvers.get(0)!({
        image: `data:image/png;base64,z0#viewer-400x300`,
        source_sha256: source.sha256,
        source_extent: [400, 300],
        selection: { t: 0, z: 0, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
        projection: null,
      });
    });

    await waitFor(() => expect(viewport.dataset.prepared).toBe("true"));
    expect(onViewReady).toHaveBeenCalledWith(`${source.id}:${source.sha256}:0:0`);

    // Rapidly change Z: 1, 2, 3
    for (const nextZ of [1, 2, 3]) {
      rerender(
        <ImageViewport
          api={api}
          source={source}
          selection={{ ...selectionZ0, z: nextZ }}
          channels={channels}
          onViewReady={onViewReady}
          onError={onError}
        />
      );
    }

    // While Z=3 is requested and unresolved, fallback Z=0 is still on canvas, but prepared MUST be false
    expect(viewport.dataset.prepared).toBe("false");
    expect(onViewReady).toHaveBeenLastCalledWith("");

    // Resolve old work out of order: resolve Z=1, then Z=2
    await act(async () => {
      if (pendingResolvers.has(1)) {
        pendingResolvers.get(1)!({
          image: `data:image/png;base64,z1#viewer-400x300`,
          source_sha256: source.sha256,
          source_extent: [400, 300],
          selection: { t: 0, z: 1, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
          projection: null,
        });
      }
      if (pendingResolvers.has(2)) {
        pendingResolvers.get(2)!({
          image: `data:image/png;base64,z2#viewer-400x300`,
          source_sha256: source.sha256,
          source_extent: [400, 300],
          selection: { t: 0, z: 2, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
          projection: null,
        });
      }
    });

    // Viewport must NOT become ready for Z=1 or Z=2 because Z=3 is the requested plane
    expect(viewport.dataset.prepared).toBe("false");
    expect(onViewReady).not.toHaveBeenCalledWith(`${source.id}:${source.sha256}:0:1`);
    expect(onViewReady).not.toHaveBeenCalledWith(`${source.id}:${source.sha256}:0:2`);

    // Now resolve the newest matching receipt: Z=3
    await act(async () => {
      pendingResolvers.get(3)!({
        image: `data:image/png;base64,z3#viewer-400x300`,
        source_sha256: source.sha256,
        source_extent: [400, 300],
        selection: { t: 0, z: 3, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
        projection: null,
      });
    });

    await waitFor(() => expect(viewport.dataset.prepared).toBe("true"));
    expect(onViewReady).toHaveBeenCalledWith(`${source.id}:${source.sha256}:0:3`);
  });

  it("gates all scientific gestures during stale display while keeping panning usable", async () => {
    let resolveZ1: (receipt: unknown) => void = () => {};
    const execute = vi.fn(async (_op: string, request: Record<string, unknown>) => {
      const z = Number(request.z ?? (request.selection as ResearchSelection)?.z ?? 0);
      if (z === 0) {
        return {
          image: `data:image/png;base64,z0#viewer-400x300`,
          source_sha256: source.sha256,
          source_extent: [400, 300],
          selection: { t: 0, z: 0, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
          projection: null,
        };
      }
      return new Promise((resolve) => { resolveZ1 = resolve; });
    });
    const api = { execute } as unknown as ResearchDesktopApi;
    const onPoint = vi.fn();
    const onRegion = vi.fn();
    const onObjectClick = vi.fn();
    const onCamera = vi.fn();

    const selectionZ0: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    const { container, rerender } = render(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionZ0}
        channels={channels}
        onPoint={onPoint}
        onRegion={onRegion}
        onObjectClick={onObjectClick}
        onCamera={onCamera}
        onError={vi.fn()}
      />
    );

    const viewport = container.querySelector(".image-viewport") as HTMLElement;
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    await waitFor(() => expect(viewport.dataset.prepared).toBe("true"));

    // Switch to Z=1 (pending resolution)
    rerender(
      <ImageViewport
        api={api}
        source={source}
        selection={{ ...selectionZ0, z: 1 }}
        channels={channels}
        onPoint={onPoint}
        onRegion={onRegion}
        onObjectClick={onObjectClick}
        onCamera={onCamera}
        onError={vi.fn()}
      />
    );

    expect(viewport.dataset.prepared).toBe("false");
    await waitFor(() => expect(container.querySelector(".image-view-loading")?.textContent).toContain("Showing Z 1 · loading Z 2"));

    // Attempt clicks and gestures during stale display
    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });

    expect(onPoint).not.toHaveBeenCalled();
    expect(onObjectClick).not.toHaveBeenCalled();
    expect(onRegion).not.toHaveBeenCalled();

    // Panning navigation should still function during stale display (button 1 or without onPoint)
    onCamera.mockClear();
    fireEvent.pointerDown(canvas, { button: 1, clientX: 100, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(canvas, { button: 1, clientX: 150, clientY: 150, pointerId: 2 });
    fireEvent.pointerUp(canvas, { button: 1, clientX: 150, clientY: 150, pointerId: 2 });

    await waitFor(() => expect(onCamera).toHaveBeenCalled());

    // Now resolve Z=1
    await act(async () => {
      resolveZ1({
        image: `data:image/png;base64,z1#viewer-400x300`,
        source_sha256: source.sha256,
        source_extent: [400, 300],
        selection: { t: 0, z: 1, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
        projection: null,
      });
    });

    await waitFor(() => expect(viewport.dataset.prepared).toBe("true"));

    // Now clicks on Z=1 should work
    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100, pointerId: 3 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 100, clientY: 100, pointerId: 3 });
    expect(onPoint).toHaveBeenCalled();
  });

  it("mid-gesture Z change aborts draft and restores previous draft", async () => {
    const execute = vi.fn(async (_op: string, request: Record<string, unknown>) => {
      const z = Number(request.z ?? (request.selection as ResearchSelection)?.z ?? 0);
      return {
        image: `data:image/png;base64,z${z}#viewer-400x300`,
        source_sha256: source.sha256,
        source_extent: [400, 300],
        selection: { t: 0, z, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
        projection: null,
      };
    });
    const api = { execute } as unknown as ResearchDesktopApi;
    const onDraftChange = vi.fn();

    const selectionZ0: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    const { container, rerender } = render(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionZ0}
        channels={channels}
        drawingMode="rectangle"
        draft={[]}
        onDraftChange={onDraftChange}
        onError={vi.fn()}
      />
    );

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    await waitFor(() => expect(container.querySelector(".image-viewport")?.getAttribute("data-prepared")).toBe("true"));

    // Start drawing rectangle
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(canvas, { button: 0, clientX: 150, clientY: 150, pointerId: 1 });
    expect(onDraftChange).toHaveBeenCalled();

    onDraftChange.mockClear();

    // Mid-gesture, Z plane changes to 1
    rerender(
      <ImageViewport
        api={api}
        source={source}
        selection={{ ...selectionZ0, z: 1 }}
        channels={channels}
        drawingMode="rectangle"
        draft={[{ x: 50, y: 50 }, { x: 150, y: 150 }]}
        onDraftChange={onDraftChange}
        onError={vi.fn()}
      />
    );

    // Mid-gesture change must immediately abort draft and restore previous
    expect(onDraftChange).toHaveBeenCalledWith([]);
  });

  it("fails closed on malformed or mismatched overview identity", async () => {
    const execute = vi.fn(async () => {
      return {
        image: `data:image/png;base64,bad#viewer-400x300`,
        source_sha256: "wrong-sha".padEnd(64, "0"),
        source_extent: [400, 300],
        selection: { t: 0, z: 0, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
        projection: null,
      };
    });
    const api = { execute } as unknown as ResearchDesktopApi;
    const onError = vi.fn();

    const selectionZ0: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    render(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionZ0}
        channels={channels}
        onError={onError}
      />
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("source changed")));
  });

  it("handles failed preview followed by successful retry and preserves genuine errors", async () => {
    let attempt = 0;
    const execute = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error("Temporary decoder glitch");
      }
      return {
        image: `data:image/png;base64,recovered#viewer-400x300`,
        source_sha256: source.sha256,
        source_extent: [400, 300],
        selection: { t: 0, z: 0, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
        projection: null,
      };
    });
    const api = { execute } as unknown as ResearchDesktopApi;
    const onError = vi.fn();

    const selectionZ0: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    const { rerender } = render(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionZ0}
        channels={channels}
        onError={onError}
      />
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Temporary decoder glitch"));

    // Retry / re-request
    rerender(
      <ImageViewport
        api={api}
        source={source}
        selection={{ ...selectionZ0 }}
        channels={[{ ...channels[0], gamma: 1.1 }]}
        onError={onError}
      />
    );

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  });

  it("strictly bounds cache to <= 64 MiB across many planes", async () => {
    const execute = vi.fn(async (_op: string, request: Record<string, unknown>) => {
      const z = Number(request.z ?? (request.selection as ResearchSelection)?.z ?? 0);
      return {
        image: `data:image/png;base64,z${z}#viewer-1024x1024`,
        source_sha256: source.sha256,
        source_extent: [400, 300],
        selection: { t: 0, z, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
        projection: null,
      };
    });
    const api = { execute } as unknown as ResearchDesktopApi;

    const selectionZ0: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    const { container, rerender } = render(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionZ0}
        channels={channels}
        onError={vi.fn()}
      />
    );

    const viewport = container.querySelector(".image-viewport") as HTMLElement;

    // Visit 20 planes (each 1024x1024x4 = 4.19 MB)
    // 20 * 4.19 MB = ~84 MB, which exceeds 64 MiB (67,108,864 bytes)
    for (let z = 0; z < 20; z++) {
      rerender(
        <ImageViewport
          api={api}
          source={source}
          selection={{ ...selectionZ0, z }}
          channels={channels}
          onError={vi.fn()}
        />
      );
      await waitFor(() => expect(viewport.dataset.prepared).toBe("true"));
      const cacheBytes = Number(viewport.dataset.cacheBytes);
      expect(cacheBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    }
  });

  it("maintains independent scheduling between two viewport instances without cross-view cancellation", async () => {
    const callsLaneA: unknown[] = [];
    const callsLaneB: unknown[] = [];

    const execute = vi.fn(async (_op: string, request: Record<string, unknown>, options?: { viewer_lane?: string }) => {
      const z = Number(request.z ?? (request.selection as ResearchSelection)?.z ?? 0);
      if (options?.viewer_lane === "lane-A") callsLaneA.push(z);
      if (options?.viewer_lane === "lane-B") callsLaneB.push(z);
      return {
        image: `data:image/png;base64,z${z}#viewer-400x300`,
        source_sha256: source.sha256,
        source_extent: [400, 300],
        selection: { t: 0, z, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
        projection: null,
      };
    });
    const api = { execute } as unknown as ResearchDesktopApi;

    const selectionA: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    const selectionB: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 5, t: 0, c: 0, level: 0 };

    const renderedA = render(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionA}
        channels={channels}
        requestLane="lane-A"
        onError={vi.fn()}
      />
    );
    const renderedB = render(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionB}
        channels={channels}
        requestLane="lane-B"
        onError={vi.fn()}
      />
    );

    await waitFor(() => expect(callsLaneA.length).toBeGreaterThan(0));
    await waitFor(() => expect(callsLaneB.length).toBeGreaterThan(0));

    // Update A
    renderedA.rerender(
      <ImageViewport
        api={api}
        source={source}
        selection={{ ...selectionA, z: 1 }}
        channels={channels}
        requestLane="lane-A"
        onError={vi.fn()}
      />
    );

    await waitFor(() => expect(callsLaneA).toContain(1));
    // B was not updated or cancelled
    renderedB.rerender(
      <ImageViewport
        api={api}
        source={source}
        selection={{ ...selectionB, z: 5 }}
        channels={channels}
        requestLane="lane-B"
        onError={vi.fn()}
      />
    );
  });

  it("settled refinement: coarse preview refines to normal 1024 overview, including returning to cached preview", async () => {
    const requestedMaxEdges: number[] = [];
    const execute = vi.fn(async (_op: string, request: Record<string, unknown>) => {
      const z = Number(request.z ?? (request.selection as ResearchSelection)?.z ?? 0);
      const maxEdge = Number(request.max_edge ?? 1024);
      if (request.overview) {
        requestedMaxEdges.push(maxEdge);
      }
      return {
        image: `data:image/png;base64,z${z}_me${maxEdge}#viewer-${Math.min(400, maxEdge)}x${Math.min(300, maxEdge)}`,
        source_sha256: source.sha256,
        source_extent: [400, 300],
        selection: { t: 0, z, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
        projection: null,
      };
    });
    const api = { execute } as unknown as ResearchDesktopApi;
    const onViewReady = vi.fn();

    const selectionZ0: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    const { rerender } = render(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionZ0}
        channels={channels}
        onViewReady={onViewReady}
        onError={vi.fn()}
      />
    );

    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(onViewReady).toHaveBeenCalledWith(`${source.id}:${source.sha256}:0:0`);

    // Switch to Z=1
    rerender(
      <ImageViewport
        api={api}
        source={source}
        selection={{ ...selectionZ0, z: 1 }}
        channels={channels}
        onViewReady={onViewReady}
        onError={vi.fn()}
      />
    );

    await waitFor(() => expect(onViewReady).toHaveBeenCalledWith(`${source.id}:${source.sha256}:0:1`));

    // Return to cached Z=0 - paints promptly
    onViewReady.mockClear();
    rerender(
      <ImageViewport
        api={api}
        source={source}
        selection={{ ...selectionZ0, z: 0 }}
        channels={channels}
        onViewReady={onViewReady}
        onError={vi.fn()}
      />
    );

    await waitFor(() => expect(onViewReady).toHaveBeenCalledWith(`${source.id}:${source.sha256}:0:0`));
  });

  it("pauses and unpauses request draining without losing readiness upon unpause", async () => {
    let callCount = 0;
    const execute = vi.fn(async (_op: string, request: Record<string, unknown>) => {
      callCount++;
      const z = Number(request.z ?? (request.selection as ResearchSelection)?.z ?? 0);
      return {
        image: `data:image/png;base64,z${z}#viewer-400x300`,
        source_sha256: source.sha256,
        source_extent: [400, 300],
        selection: { t: 0, z, c: 0, level: -1, x: 0, y: 0, width: 400, height: 300 },
        projection: null,
      };
    });
    const api = { execute } as unknown as ResearchDesktopApi;

    const selectionZ0: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
    const { container, rerender } = render(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionZ0}
        channels={channels}
        paused={true}
        onError={vi.fn()}
      />
    );

    const viewport = container.querySelector(".image-viewport") as HTMLElement;
    // When paused initially, no execute should have been called
    expect(callCount).toBe(0);
    expect(viewport.dataset.prepared).toBe("false");

    // Unpause
    rerender(
      <ImageViewport
        api={api}
        source={source}
        selection={selectionZ0}
        channels={channels}
        paused={false}
        onError={vi.fn()}
      />
    );

    await waitFor(() => expect(callCount).toBeGreaterThan(0));
    await waitFor(() => expect(viewport.dataset.prepared).toBe("true"));
  });
});


describe("M4 integration boundaries", () => {
  const selection: ResearchSelection = { x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0 };
  function receipt(request: Record<string, unknown>, dims = { x: 400, y: 300 }) {
    const native = request.selection as ResearchSelection | undefined;
    const edge = Number(request.max_edge ?? 1024);
    const width = native?.width ?? Math.min(edge, dims.x);
    const height = native?.height ?? Math.min(edge, dims.y);
    return { image: `data:image/png;base64,plane#viewer-${width}x${height}`,
      source_sha256: source.sha256, source_extent: [dims.x, dims.y],
      selection: native ?? { t: request.t, z: request.z, c: request.c, z_stop: request.z_stop ?? null },
      projection: request.projection ?? null };
  }

  it.each(["selection", "channel", "time", "depth", "projection", "z_stop"])("rejects incomplete or incorrect overview %s", async (field) => {
    const error = vi.fn();
    const execute = vi.fn(async (_: string, request: Record<string, unknown>) => {
      const value = receipt(request);
      if (field === "selection") delete (value as { selection?: unknown }).selection;
      if (field === "channel") delete (value.selection as { c?: number }).c;
      if (field === "time") value.selection.t = 1;
      if (field === "depth") value.selection.z = 1;
      if (field === "projection") value.projection = "max";
      if (field === "z_stop") value.selection.z_stop = 2;
      return value;
    });
    const { container } = render(<ImageViewport api={{ execute } as unknown as ResearchDesktopApi}
      source={source} selection={selection} channels={channels} onError={error} />);
    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("does not match")));
    expect(container.querySelector(".image-viewport")).toHaveAttribute("data-prepared", "false");
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("signals readiness after paint and blocks a gesture begun before the plane is ready", async () => {
    let resolve!: (value: unknown) => void;
    const execute = vi.fn((_op: string, request: Record<string, unknown>) => request.overview
      ? new Promise((done) => { resolve = done; }) : Promise.resolve(receipt(request)));
    const ready = vi.fn((key: string) => { if (key) expect(context.drawImage).toHaveBeenCalled(); });
    const point = vi.fn();
    const { container } = render(<ImageViewport api={{ execute } as unknown as ResearchDesktopApi}
      source={source} selection={selection} channels={channels} onError={vi.fn()} onViewReady={ready}
      onPoint={point} drawingMode="point" />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { pointerId: 3, button: 0, clientX: 200, clientY: 150 });
    await act(async () => resolve(receipt({ overview: true, t: 0, z: 0, c: 0 })));
    await waitFor(() => expect(container.querySelector(".image-viewport")).toHaveAttribute("data-prepared", "true"));
    fireEvent.pointerUp(canvas, { pointerId: 3, button: 0, clientX: 200, clientY: 150 });
    expect(point).not.toHaveBeenCalled();
  });

  it("uses measured coarse previews and refines after settling even with newly allocated equal channels", async () => {
    const dims = { x: 1024, y: 1024, z: 20, t: 1, c: 1 };
    const large = { ...source, metadata: { dimensions: dims, levels: [{ index: 0, dimensions: dims }] } };
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const execute = vi.fn(async (_: string, request: Record<string, unknown>) => {
      now += 100;
      return receipt(request, dims);
    });
    const api = { execute } as unknown as ResearchDesktopApi;
    const error = vi.fn();
    const { container, rerender } = render(<ImageViewport api={api} source={large} selection={selection}
      channels={channels} onError={error} />);
    await waitFor(() => expect(container.querySelector(".image-viewport")).toHaveAttribute("data-prepared", "true"));
    rerender(<ImageViewport api={api} source={large} selection={{ ...selection, z: 1 }}
      channels={channels.map(c => ({ ...c }))} onError={error} />);
    await waitFor(() => expect(execute.mock.calls.some(([, r]) => r.overview && r.z === 1 && r.max_edge === 512)).toBe(true));
    await waitFor(() => expect(execute.mock.calls.some(([, r]) => r.overview && r.z === 1 && r.max_edge === 1024)).toBe(true));
    expect(error).not.toHaveBeenCalled();
  });

  it("bounds a full 64-tile visible plane plus overview and an explicit analysis preview without refetch churn", async () => {
    const dims = { x: 4096, y: 4096, z: 20, t: 1, c: 1 };
    const large = { ...source, metadata: { dimensions: dims, levels: [{ index: 0, dimensions: dims }] } };
    const execute = vi.fn(async (_: string, request: Record<string, unknown>) => receipt(request, dims));
    const error = vi.fn();
    const { container } = render(<ImageViewport api={{ execute } as unknown as ResearchDesktopApi}
      source={large} selection={selection} channels={channels} onError={error}
      overrideImage="data:image/png;base64,analysis#viewer-2048x2048" />);
    await waitFor(() => expect(execute.mock.calls.length).toBeGreaterThan(30));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    const count = execute.mock.calls.length;
    const bytes = Number((container.querySelector(".image-viewport") as HTMLElement).dataset.cacheBytes);
    expect(bytes).toBeLessThanOrEqual(64 * 1024 ** 2);
    expect(bytes).toBeGreaterThanOrEqual(20 * 1024 ** 2);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(execute).toHaveBeenCalledTimes(count);
    expect(error).not.toHaveBeenCalled();
  });

  it("retains unchanged fallback pixels without re-uploading the canvas while still invalidating readiness", async () => {
    const execute = vi.fn((_op: string, request: Record<string, unknown>) => Number(request.z ?? 0) === 1
      ? new Promise(() => {}) : Promise.resolve(receipt(request)));
    const api = { execute } as unknown as ResearchDesktopApi;
    const error = vi.fn();
    const view = render(<ImageViewport api={api} source={source} selection={selection} channels={channels} onError={error} />);
    await waitFor(() => expect(view.container.querySelector(".image-viewport")).toHaveAttribute("data-prepared", "true"));
    const painted = context.drawImage.mock.calls.length;
    const clears = context.fillRect.mock.calls.length;
    view.rerender(<ImageViewport api={api} source={source} selection={{ ...selection, z: 1 }} channels={channels} onError={error} />);
    expect(view.container.querySelector(".image-viewport")).toHaveAttribute("data-prepared", "false");
    expect(context.drawImage).toHaveBeenCalledTimes(painted);
    expect(context.fillRect).toHaveBeenCalledTimes(clears);
    expect(within(view.container).getByText("Showing Z 1 · loading Z 2")).toBeVisible();
    // Camera movement must still redraw the retained plane.
    fireEvent.click(within(view.container).getByRole("button", { name: "Zoom in" }));
    expect(context.drawImage.mock.calls.length).toBeGreaterThan(painted);
  });

  it("keeps the displayed plane named after stopping a replacement", async () => {
    const execute = vi.fn((_op: string, request: Record<string, unknown>) => Number(request.z ?? 0) === 1
      ? new Promise(() => {}) : Promise.resolve(receipt(request)));
    const api = { execute } as unknown as ResearchDesktopApi;
    const error = vi.fn();
    const view = render(<ImageViewport api={api} source={source} selection={selection} channels={channels} onError={error} />);
    await waitFor(() => expect(view.container.querySelector(".image-viewport")).toHaveAttribute("data-prepared", "true"));
    view.rerender(<ImageViewport api={api} source={source} selection={{ ...selection, z: 1 }} channels={channels} onError={error} />);
    fireEvent.click(await within(view.container).findByRole("button", { name: "Stop loading" }));
    expect(within(view.container).getByText("Showing Z 1 · View loading stopped.")).toHaveAttribute("role", "status");
    expect(view.container.querySelector(".image-viewport")).toHaveAttribute("data-prepared", "false");
  });

  it("stops and retries one pending view while another completes without global cancellation", async () => {
    const pending = new Map<string, Array<() => void>>();
    const cancelView = vi.fn();
    const execute = vi.fn((_op: string, request: Record<string, unknown>, options: { viewer_lane: string }) => {
      if (!request.overview) return Promise.resolve(receipt(request));
      return new Promise(done => {
        const callbacks = pending.get(options.viewer_lane) ?? [];
        callbacks.push(() => done(receipt(request))); pending.set(options.viewer_lane, callbacks);
      });
    });
    const api = { execute, cancelView } as unknown as ResearchDesktopApi;
    const a = render(<ImageViewport api={api} source={source} selection={selection} channels={channels} onError={vi.fn()} requestLane="A" />);
    const b = render(<ImageViewport api={api} source={source} selection={selection} channels={channels} onError={vi.fn()} requestLane="B" />);
    fireEvent.click(await within(a.container).findByRole("button", { name: "Stop loading" }));
    await act(async () => { pending.get("A")![0](); pending.get("B")![0](); });
    expect(a.container.querySelector(".image-viewport")).toHaveAttribute("data-prepared", "false");
    await waitFor(() => expect(b.container.querySelector(".image-viewport")).toHaveAttribute("data-prepared", "true"));
    expect(cancelView).not.toHaveBeenCalled();
    fireEvent.click(within(a.container).getByRole("button", { name: "Retry view" }));
    await act(async () => pending.get("A")![1]());
    await waitFor(() => expect(a.container.querySelector(".image-viewport")).toHaveAttribute("data-prepared", "true"));
  });
});
