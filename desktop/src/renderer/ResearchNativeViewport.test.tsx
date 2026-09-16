// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchLevel,
  ResearchSelection,
  ResearchSource,
} from "../shared/research-contracts";
import {
  clampNativeSelection,
  mapSelectionToLevel,
  MAX_WHOLE_SLIDE_RGB_VIEW_PIXELS,
  maxNativeViewPixels,
  ResearchNativeViewport,
  zoomNativeSelection,
} from "./ResearchNativeViewport";

afterEach(cleanup);

const levels: ResearchLevel[] = [
  { index: 0, dimensions: { x: 1000, y: 500, z: 1, c: 3, t: 1 } },
  { index: 1, dimensions: { x: 401, y: 201, z: 1, c: 3, t: 1 } },
];
const source: ResearchSource = {
  id: "a".repeat(32),
  name: "Slide",
  sha256: "b".repeat(64),
  source_kind: "whole_slide",
  metadata: {
    dimensions: levels[0].dimensions,
    levels,
    ...({
      whole_slide: {
        levels: [
          { index: 0, downsample: 1 },
          { index: 1, downsample: 2.5 },
        ],
      },
    } as Record<string, unknown>),
  },
};
const selection: ResearchSelection = {
  x: 100,
  y: 50,
  width: 400,
  height: 200,
  z: 0,
  c: 0,
  t: 0,
  level: 0,
};
const channels = [{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }];

function bridge(execute = vi.fn(async (_operation: string, request: Record<string, unknown>) => ({
  image: "data:image/png;base64,view",
  selection: request.selection,
}))): ResearchDesktopApi {
  return {
    createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(),
    execute, reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
  } as unknown as ResearchDesktopApi;
}

function Harness({ api = bridge(), initial = selection }: {
  api?: ResearchDesktopApi;
  initial?: ResearchSelection;
}) {
  const [current, setCurrent] = useState(initial);
  return <ResearchNativeViewport
    api={api}
    source={source}
    selection={current}
    levels={levels}
    channels={channels}
    projection="plane"
    imageScale="actual"
    onSelection={setCurrent}
    onError={vi.fn()}
  />;
}

describe("native coordinate helpers", () => {
  it("omits an absent Z extent so the exact scope survives JSON transport", () => {
    const resolved = clampNativeSelection({ ...selection, z_stop: undefined }, levels[0].dimensions);
    expect(resolved).not.toHaveProperty("z_stop");
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
    expect(clampNativeSelection(
      { ...selection, z_stop: 1 }, levels[0].dimensions,
    )).toHaveProperty("z_stop", 1);
  });

  it("uses actual OpenSlide downsamples and dimension ratios without losing nonzero origins", () => {
    const fromCoarse = { ...selection, x: 3, y: 5, width: 12, height: 8, level: 1 };
    expect(mapSelectionToLevel(fromCoarse, levels[1], levels[0], source.metadata)).toMatchObject({
      level: 0, x: 8, y: 13, width: 30, height: 20,
    });

    const ratioSource = { ...source, metadata: { dimensions: levels[0].dimensions, levels } };
    expect(mapSelectionToLevel(
      { ...selection, x: 10, y: 7, width: 20, height: 11, level: 1 },
      levels[1], levels[0], ratioSource.metadata,
    )).toMatchObject({ level: 0, x: 25, y: 17, width: 50, height: 28 });
  });

  it("keeps the requested zoom anchor and clamps the bounded crop at source edges", () => {
    expect(zoomNativeSelection(selection, levels[0].dimensions, 0.5, 0.25, 0.75)).toMatchObject({
      x: 150, y: 125, width: 200, height: 100,
    });
    expect(zoomNativeSelection(
      { ...selection, x: 900, y: 400, width: 100, height: 100 },
      levels[0].dimensions, 2, 1, 1,
    )).toMatchObject({ x: 800, y: 300, width: 200, height: 200 });
  });

  it("keeps whole-slide RGB regions within the exact reader budget without limiting scalar views", () => {
    const dimensions = { x: 5000, y: 4000, z: 1, c: 1, t: 1 };
    const rgbSource: ResearchSource = {
      ...source,
      metadata: {
        dimensions,
        levels: [{ index: 0, dimensions }],
        sample_semantics: "RGB",
      },
    };
    const maxPixels = maxNativeViewPixels(rgbSource);
    expect(maxPixels).toBe(MAX_WHOLE_SLIDE_RGB_VIEW_PIXELS);
    const clamped = clampNativeSelection(
      { ...selection, x: 1000, y: 800, width: 2048, height: 2048 },
      dimensions,
      maxPixels,
    );
    expect(clamped).toMatchObject({ width: 1448, height: 1448 });
    expect(clamped.width * clamped.height).toBeLessThanOrEqual(
      MAX_WHOLE_SLIDE_RGB_VIEW_PIXELS,
    );
    expect(clampNativeSelection(
      { ...selection, width: 2048, height: 1024 },
      dimensions,
      maxPixels,
    )).toMatchObject({ width: 2048, height: 1024 });

    const zoomed = zoomNativeSelection(
      { ...selection, x: 1000, y: 800, width: 1280, height: 1280 },
      dimensions,
      1.25,
      0.5,
      0.5,
      maxPixels,
    );
    expect(zoomed).toMatchObject({ x: 916, y: 716, width: 1448, height: 1448 });
    expect(zoomed.width * zoomed.height).toBeLessThanOrEqual(maxPixels!);

    const scalarSource = {
      ...rgbSource,
      metadata: { ...rgbSource.metadata, sample_semantics: "scalar" as const },
    };
    expect(maxNativeViewPixels(scalarSource)).toBeUndefined();
    expect(clampNativeSelection(
      { ...selection, width: 2048, height: 2048 },
      dimensions,
    )).toMatchObject({ width: 2048, height: 2048 });
  });
});

describe("ResearchNativeViewport", () => {
  it("never sends an oversized whole-slide RGB selection to the view operation", async () => {
    const dimensions = { x: 5000, y: 4000, z: 1, c: 1, t: 1 };
    const rgbSource: ResearchSource = {
      ...source,
      metadata: {
        dimensions,
        levels: [{ index: 0, dimensions }],
        sample_semantics: "RGB",
      },
    };
    const execute = vi.fn(async (_operation: string, request: Record<string, unknown>) => ({
      image: "data:image/png;base64,view",
      selection: request.selection,
    }));
    render(<ResearchNativeViewport
      api={bridge(execute)}
      source={rgbSource}
      selection={{ ...selection, x: 1000, y: 800, width: 2048, height: 2048 }}
      levels={rgbSource.metadata.levels!}
      channels={channels}
      projection="plane"
      imageScale="actual"
      onSelection={vi.fn()}
      onError={vi.fn()}
    />);
    await screen.findByAltText("Bounded native image region");
    expect(execute).toHaveBeenCalledWith("view", expect.objectContaining({
      selection: expect.objectContaining({ width: 1448, height: 1448 }),
    }));
    expect(screen.getByLabelText("Native viewport scope")).toHaveTextContent(
      "X [1000, 2448) · Y [800, 2248)",
    );
  });

  it("shows a live captured drag then commits source-native pan coordinates", async () => {
    render(<Harness />);
    const image = await screen.findByAltText("Bounded native image region");
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 400, height: 200,
    } as DOMRect);
    const viewport = screen.getByLabelText("Native source viewport");
    expect(viewport).toHaveAccessibleDescription(/Shift \+ arrow: one native pixel/);
    expect(viewport).toHaveAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Plus = -");
    Object.assign(viewport, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.pointerDown(viewport, { pointerId: 7, button: 0, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 7, clientX: 240, clientY: 80 });
    expect(image).toHaveStyle({ transform: "translate3d(40px, -20px, 0)" });
    fireEvent.pointerUp(viewport, { pointerId: 7, clientX: 240, clientY: 80 });
    expect(await screen.findByLabelText("Native viewport scope")).toHaveTextContent(
      "X [60, 460) · Y [70, 270)",
    );
    expect(viewport.setPointerCapture).toHaveBeenCalledWith(7);
  });

  it("anchors wheel and keyboard zoom while keeping the declared level", async () => {
    render(<Harness />);
    const image = await screen.findByAltText("Bounded native image region");
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 10, top: 20, width: 400, height: 200,
    } as DOMRect);
    const viewport = screen.getByLabelText("Native source viewport");
    fireEvent.wheel(viewport, { deltaY: -1, clientX: 110, clientY: 170 });
    expect(await screen.findByLabelText("Native viewport scope")).toHaveTextContent(
      "Level 0 · X [120, 440) · Y [80, 240)",
    );
    await screen.findByAltText("Bounded native image region");
    fireEvent.keyDown(viewport, { key: "+" });
    expect(await screen.findByLabelText("Native viewport scope")).toHaveTextContent(
      "Level 0 · X [152, 408) · Y [96, 224)",
    );
    fireEvent.keyDown(viewport, { key: "ArrowRight", shiftKey: true });
    expect(await screen.findByLabelText("Native viewport scope")).toHaveTextContent("X [153, 409)");
  });

  it("maps an explicit resolution switch through the physical field", async () => {
    const execute = vi.fn(async (_operation: string, request: Record<string, unknown>) => ({
      image: "data:image/png;base64,view",
      selection: request.selection,
    }));
    render(<Harness api={bridge(execute)} initial={{ ...selection, x: 40, y: 20, width: 80, height: 40 }} />);
    await screen.findByAltText("Bounded native image region");
    fireEvent.change(screen.getByLabelText("Pyramid level"), { target: { value: "1" } });
    await waitFor(() => expect(execute).toHaveBeenLastCalledWith("view", expect.objectContaining({
      selection: expect.objectContaining({ level: 1, x: 16, y: 8, width: 32, height: 16 }),
    })));
  });

  it("clears an old tile immediately and discards its delayed response", async () => {
    let resolveFirst!: (value: unknown) => void;
    const execute = vi.fn()
      .mockImplementationOnce((_operation: string, request: Record<string, unknown>) =>
        new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async (_operation: string, request: Record<string, unknown>) => ({
        image: "data:image/png;base64,new", selection: request.selection,
      }));
    const api = bridge(execute);
    const onError = vi.fn();
    const common = { api, source, levels, channels, projection: "plane" as const,
      imageScale: "actual" as const, onSelection: vi.fn(), onError };
    const rendered = render(<ResearchNativeViewport {...common} selection={selection} />);
    expect(await screen.findByText("Loading exact native region…")).toBeVisible();
    rendered.rerender(<ResearchNativeViewport {...common} selection={{ ...selection, x: 120 }} />);
    expect(await screen.findByAltText("Bounded native image region")).toHaveAttribute(
      "src", "data:image/png;base64,new",
    );
    await act(async () => {
      resolveFirst({ image: "data:image/png;base64,old", selection });
      await Promise.resolve();
    });
    expect(screen.getByAltText("Bounded native image region")).toHaveAttribute(
      "src", "data:image/png;base64,new",
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not clear unrelated operation errors or emit a late error after leaving the viewport", async () => {
    let reject!: (error: Error) => void;
    const api = bridge(vi.fn(() => new Promise((_resolve, fail) => { reject = fail; })));
    const onError = vi.fn();
    const rendered = render(<ResearchNativeViewport api={api} source={source} levels={levels}
      selection={selection} channels={channels} projection="plane" imageScale="fit"
      onSelection={vi.fn()} onError={onError} />);
    expect(await screen.findByText("Loading exact native region…")).toBeVisible();
    rendered.unmount();
    await act(async () => { reject(new Error("Late source decode error")); });
    expect(onError).not.toHaveBeenCalled();
  });
});
