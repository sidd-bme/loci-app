// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { ImageViewport } from "./ImageViewport";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

let context: Record<string, unknown> & { drawImage: ReturnType<typeof vi.fn> };

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
  id: "a".repeat(32), name: "Paused source", sha256: "b".repeat(64), source_kind: "native",
  metadata: {
    dimensions: { x: 400, y: 300, z: 1, t: 1, c: 1 },
    levels: [{ index: 0, dimensions: { x: 400, y: 300, z: 1, t: 1, c: 1 } }],
  },
};
const selection: ResearchSelection = {
  x: 0, y: 0, width: 400, height: 300, z: 0, t: 0, c: 0, level: 0,
};
const channels = [{ channel: 0, low: 0, high: 255, gamma: 1, visible: true, color: "#ffffff" }];

function successfulResponse(request: Record<string, unknown>) {
  if (request.overview) return {
    image: "data:image/png;base64,overview#viewer-400x300",
    source_sha256: source.sha256,
    source_extent: [400, 300],
  };
  const tile = request.selection as ResearchSelection;
  return {
    image: `data:image/png;base64,tile#viewer-${tile.width}x${tile.height}`,
    source_sha256: source.sha256,
    selection: tile,
  };
}

function apiWithDeferredFirstTile(pending: Deferred<unknown>) {
  let tileAttempts = 0;
  const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
    if (operation !== "viewer_tile") throw new Error("Unexpected operation");
    if (request.overview) return successfulResponse(request);
    tileAttempts += 1;
    if (tileAttempts === 1) return pending.promise;
    return successfulResponse(request);
  });
  return {
    api: {
      createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(), execute,
      reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
    } as ResearchDesktopApi,
    execute,
  };
}

describe("ImageViewport request pause", () => {
  it("assigns separate stable scheduling lanes to concurrent viewport instances", async () => {
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>,
      _options?: { viewer_lane?: string }) => {
      if (operation !== "viewer_tile") throw new Error("Unexpected operation");
      return successfulResponse(request);
    });
    const api = {
      createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(), execute,
      reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
    } as ResearchDesktopApi;
    const onError = vi.fn();

    render(<>
      <ImageViewport api={api} source={source} selection={selection}
        channels={channels} onError={onError} />
      <ImageViewport api={api} source={source} selection={selection}
        channels={channels} onError={onError} />
    </>);

    await waitFor(() => expect(execute.mock.calls.length).toBeGreaterThanOrEqual(4));
    const lanes = new Set(execute.mock.calls.map(([, , options]) =>
      (options as { viewer_lane: string }).viewer_lane));
    expect(lanes.size).toBe(2);
    expect([...lanes]).toEqual(expect.arrayContaining([
      expect.stringMatching(/^image-viewport-/),
    ]));
    expect(onError).not.toHaveBeenCalled();
  });

  it("replays an overview that was pending when pause invalidated its request generation", async () => {
    const pending = deferred<unknown>();
    let calls = 0;
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      if (operation !== "viewer_tile") throw new Error("Unexpected operation");
      calls += 1;
      if (calls === 1) return pending.promise;
      return successfulResponse(request);
    });
    const api = {
      createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(), execute,
      reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
    } as ResearchDesktopApi;
    const onError = vi.fn();
    const view = (paused: boolean) => <ImageViewport api={api} source={source}
      selection={selection} channels={channels} paused={paused} onError={onError} />;
    const rendered = render(view(false));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect((execute.mock.calls[0][1] as Record<string, unknown>).overview).toBe(true);
    rendered.rerender(view(true));
    await act(async () => {
      pending.reject(new Error("late paused overview failure"));
      await Promise.resolve();
    });
    expect(onError).not.toHaveBeenCalled();

    rendered.rerender(view(false));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect((execute.mock.calls[1][1] as Record<string, unknown>).overview).toBe(true);
    expect((execute.mock.calls[2][1] as Record<string, unknown>).overview).toBeUndefined();
    await waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: expect.stringContaining("tile#viewer-") }),
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
    ));
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a deferred tile %s while paused and requests that tile again after resume",
    async (settlement) => {
      const pending = deferred<unknown>();
      const { api, execute } = apiWithDeferredFirstTile(pending);
      const onError = vi.fn();
      const view = (paused: boolean) => <ImageViewport api={api} source={source}
        selection={selection} channels={channels} paused={paused} onError={onError} />;
      const rendered = render(view(false));

      await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      expect((execute.mock.calls[1][1] as Record<string, unknown>).overview).toBeUndefined();
      context.drawImage.mockClear();
      rendered.rerender(view(true));

      await act(async () => {
        if (settlement === "resolve")
          pending.resolve(successfulResponse(execute.mock.calls[1][1] as Record<string, unknown>));
        else pending.reject(new Error("late paused tile failure"));
        await Promise.resolve();
      });

      expect(onError).not.toHaveBeenCalled();
      expect(context.drawImage).not.toHaveBeenCalledWith(
        expect.objectContaining({ src: expect.stringContaining("tile#viewer-") }),
        expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
      );
      expect(execute).toHaveBeenCalledTimes(2);

      rendered.rerender(view(false));
      await waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
      expect((execute.mock.calls[2][1] as Record<string, unknown>).overview).toBeUndefined();
      await waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(
        expect.objectContaining({ src: expect.stringContaining("tile#viewer-") }),
        expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
      ));
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("reports a tile failure when requests are not paused", async () => {
    const onError = vi.fn();
    const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
      if (operation !== "viewer_tile") throw new Error("Unexpected operation");
      if (request.overview) return successfulResponse(request);
      throw new Error("active tile failure");
    });
    const api = {
      createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(), execute,
      reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
    } as ResearchDesktopApi;

    render(<ImageViewport api={api} source={source} selection={selection}
      channels={channels} onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith("active tile failure"));
  });
});
