// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { annotationDisplayLabel, ImageViewport, type AnnotationTool, type ImageAnnotation, type ImagePoint } from "./ImageViewport";

let context: Record<string, unknown> & { closePath: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  context = Object.fromEntries([
    "setTransform", "fillRect", "drawImage", "beginPath", "moveTo", "lineTo",
    "closePath", "arc", "stroke", "strokeText", "fillText", "setLineDash", "save", "restore", "ellipse", "fill",
  ].map((name) => [name, vi.fn()])) as typeof context;
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
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
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
  for (const key of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"])
    Reflect.deleteProperty(HTMLElement.prototype, key);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const source: ResearchSource = {
  id: "a".repeat(32), name: "Anisotropic source", sha256: "b".repeat(64), source_kind: "native",
  metadata: {
    dimensions: { x: 400, y: 150, z: 2, t: 2, c: 1 },
    levels: [{ index: 0, dimensions: { x: 400, y: 150, z: 2, t: 2, c: 1 } }],
    physical_calibration: { spacing: [1, 2, 1], unit: "um" },
  },
};
const selection: ResearchSelection = {
  x: 0, y: 0, width: 400, height: 150, z: 0, t: 0, c: 0, level: 0,
};
const channels = [{ channel: 0, gamma: 1, visible: true, color: "#ffffff" }];

function api(activeSource = source): ResearchDesktopApi {
  return {
    createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(),
    execute: vi.fn(async (operation: string, request: Record<string, unknown>) => {
      if (operation !== "viewer_tile") throw new Error("Unexpected operation");
      if (request.overview) return {
        image: "data:image/png;base64,overview#viewer-400x150",
        source_sha256: activeSource.sha256,
        source_extent: [400, 150],
        selection: { t: Number(request.t ?? 0), z: Number(request.z ?? 0), c: Number(request.c ?? 0), level: 0, x: 0, y: 0, width: 400, height: 150 },
        projection: (request.projection as "plane" | "max" | "mean") ?? null,
      };
      const tile = request.selection as ResearchSelection;
      return {
        image: `data:image/png;base64,tile#viewer-${tile.width}x${tile.height}`,
        source_sha256: activeSource.sha256,
        selection: tile,
      };
    }),
    reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
  };
}

function Harness({ mode, activeSource = source }: { mode: AnnotationTool; activeSource?: ResearchSource }) {
  const [draft, setDraft] = useState<ImagePoint[]>([]);
  const appendPoint = (point: ImagePoint) => setDraft((old) => {
    const maximum = mode === "point" ? 1 : mode === "polygon" || mode === "freehand" ? 2048 : 2;
    return old.length >= maximum ? [point] : [...old, point];
  });
  return <>
    <output data-testid="draft">{JSON.stringify(draft)}</output>
    <ImageViewport api={api(activeSource)} source={activeSource} selection={selection} channels={channels}
      initialCamera={{ x: 200, y: 75, scale: 1 }} drawingMode={mode} draft={draft}
      onPoint={appendPoint} onDraftChange={setDraft} onError={vi.fn()} />
  </>;
}

function readDraft(): ImagePoint[] {
  return JSON.parse(screen.getByTestId("draft").textContent ?? "[]") as ImagePoint[];
}

async function preparedCanvas() {
  const canvas = screen.getByLabelText("Source image and bound annotations");
  await waitFor(() => {
    expect(context.drawImage).toHaveBeenCalled();
    expect(document.querySelector(".image-viewport")?.getAttribute("data-prepared")).toBe("true");
  });
  return canvas;
}

function click(canvas: HTMLElement, pointerId: number, clientX: number, clientY: number) {
  fireEvent.pointerDown(canvas, { pointerId, button: 0, clientX, clientY });
  fireEvent.pointerUp(canvas, { pointerId, button: 0, clientX, clientY });
}

describe("docked source navigation", () => {
  it("retains calibrated sub-millimetre precision on the scale bar", async () => {
    const calibrated = { ...source, metadata: { ...source.metadata,
      physical_calibration: { spacing: [1, 0.000002, 0.000001], unit: "mm" } } };
    render(<ImageViewport dockedControls api={api(calibrated)} source={calibrated} selection={selection} channels={channels}
      initialCamera={{ x: 200, y: 75, scale: 1 }} onError={vi.fn()} />);
    const bar = document.querySelector(".image-scale-bar")!;
    const distance = Number(bar.textContent?.split(" ")[0]);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThanOrEqual(0.0001);
    expect(bar.textContent).toMatch(/ mm$/u);
    expect(parseFloat(bar.querySelector("i")!.style.width)).toBeCloseTo(distance / 0.000001);
  });
  it.each([360, 900])("maps points against the actual painted area at %i CSS pixels", async (width) => {
    const stageLeft = 28, stageTop = 60, stageHeight = 360;
    const fieldTop = stageTop + 36, fieldHeight = stageHeight - 36 - 28;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      const field = this instanceof HTMLCanvasElement;
      return new DOMRect(stageLeft, field ? fieldTop : stageTop, width, field ? fieldHeight : stageHeight);
    });
    const onPoint = vi.fn(), onViewportSize = vi.fn();
    render(<ImageViewport dockedControls api={api()} source={source} selection={selection} channels={channels}
      onViewportSize={onViewportSize} drawingMode="point" onPoint={onPoint} onError={vi.fn()} />);
    const canvas = await preparedCanvas();
    const viewer = screen.getByLabelText(`Image viewer: ${source.name}`);
    expect(onViewportSize).toHaveBeenCalledWith({ width, height: fieldHeight });
    const scale = Math.min(width / 400, fieldHeight / 300) * 0.96;
    expect(JSON.parse(viewer.dataset.camera!)).toEqual({ x: 200, y: 75, scale });
    expect(screen.getByText("Reduced · smoothed")).toBeVisible();
    expect(context.imageSmoothingEnabled).toBe(true);
    const x = stageLeft + width / 2 + 24 * scale, y = fieldTop + fieldHeight / 2 + 14 * 2 * scale;
    click(canvas, 1, x, y);
    expect(onPoint.mock.lastCall?.[0].x).toBeCloseTo(224);
    expect(onPoint.mock.lastCall?.[0].y).toBeCloseTo(89);
    fireEvent.wheel(canvas, { clientX: x, clientY: y, deltaY: -100 });
    click(canvas, 2, x, y);
    expect(onPoint.mock.lastCall?.[0].x).toBeCloseTo(224);
    expect(onPoint.mock.lastCall?.[0].y).toBeCloseTo(89);
    expect(screen.getByText("Beyond native · nearest pixel")).toBeVisible();
    expect(context.imageSmoothingEnabled).toBe(false);
    const toolbar = screen.getByLabelText("Image navigation");
    const before = viewer.dataset.camera;
    fireEvent.wheel(toolbar, { clientX: x, clientY: stageTop, deltaY: 100 });
    expect(viewer.dataset.camera).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Move navigation toolbar" }));
    expect(viewer).toHaveAttribute("data-toolbar-dock", "top");
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    expect(within(screen.getByLabelText("Image dimensions and display sampling")).getByText("Nearest pixel")).toBeVisible();
    expect(context.imageSmoothingEnabled).toBe(false);
  });

  it("applies the 1:1 native-pixel threshold at device pixel ratio 2 and repaints cached pixels immediately", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 400, 300));
    const drawSamples: Array<{ src: string; smooth: unknown; args: unknown[] }> = [];
    (context.drawImage as ReturnType<typeof vi.fn>).mockImplementation((image: HTMLImageElement, ...args: unknown[]) => {
      drawSamples.push({ src: image.src, smooth: context.imageSmoothingEnabled, args });
    });
    const service = api();
    const execute = vi.mocked(service.execute);
    render(<ImageViewport dockedControls api={service} source={source} selection={selection} channels={channels}
      initialCamera={{ x: 200, y: 75, scale: 0.45 }} onError={vi.fn()} />);

    await preparedCanvas();
    const viewer = screen.getByLabelText(`Image viewer: ${source.name}`);
    const canvas = screen.getByLabelText("Source image and bound annotations");
    const samplingGroup = screen.getByRole("group", { name: "Display sampling" });
    const readout = screen.getByLabelText("Image dimensions and display sampling");
    const autoBtn = within(samplingGroup).getByRole("button", { name: "Auto" });
    const nearestBtn = within(samplingGroup).getByRole("button", { name: "Nearest pixel" });
    const smoothBtn = within(samplingGroup).getByRole("button", { name: "Smooth" });

    expect(canvas.contains(samplingGroup)).toBe(false);
    expect(canvas.contains(readout)).toBe(false);
    nearestBtn.focus();
    expect(document.activeElement).toBe(nearestBtn);
    expect(autoBtn).toHaveAttribute("aria-pressed", "true");
    expect(nearestBtn).toHaveAttribute("aria-pressed", "false");
    expect(smoothBtn).toHaveAttribute("aria-pressed", "false");
    expect(within(readout).getByText("Reduced · smoothed")).toBeVisible();
    expect(drawSamples.at(-1)?.smooth).toBe(true);

    const tilesAfterInit = execute.mock.calls.length;
    const cameraAtReduced = viewer.dataset.camera;
    const drawsBeforeNearest = drawSamples.length;
    fireEvent.click(nearestBtn);
    expect(nearestBtn).toHaveAttribute("aria-pressed", "true");
    expect(drawSamples.length).toBeGreaterThan(drawsBeforeNearest);
    expect(drawSamples.at(-1)?.smooth).toBe(false);
    expect(within(readout).getByText("Reduced · nearest pixel")).toBeVisible();
    expect(viewer.dataset.camera).toBe(cameraAtReduced);
    expect(execute).toHaveBeenCalledTimes(tilesAfterInit);

    // Return to Auto and step across the exact 1:1 physical-pixel threshold (scale * dpr === 1 at scale 0.5).
    fireEvent.click(autoBtn);
    expect(drawSamples.at(-1)?.smooth).toBe(true);
    expect(within(readout).getByText("Reduced · smoothed")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    expect(JSON.parse(viewer.dataset.camera!)).toEqual({ x: 200, y: 75, scale: 0.5 });
    expect(drawSamples.at(-1)?.smooth).toBe(false);
    expect(within(readout).getByText("Nearest pixel")).toBeVisible();

    const tilesAtNative = execute.mock.calls.length;
    fireEvent.click(smoothBtn);
    expect(smoothBtn).toHaveAttribute("aria-pressed", "true");
    expect(drawSamples.at(-1)?.smooth).toBe(true);
    expect(within(readout).getByText("Smoothed")).toBeVisible();
    expect(JSON.parse(viewer.dataset.camera!)).toEqual({ x: 200, y: 75, scale: 0.5 });
    expect(execute).toHaveBeenCalledTimes(tilesAtNative);

    // Zoom beyond native (scale = 0.625, scale * dpr = 1.25 > 1.01) under Smooth, then switch back to Auto.
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(drawSamples.at(-1)?.smooth).toBe(true);
    expect(within(readout).getByText("Beyond native · smoothed")).toBeVisible();

    const tilesAboveNative = execute.mock.calls.length;
    const cameraAboveNative = viewer.dataset.camera;
    fireEvent.click(autoBtn);
    expect(drawSamples.at(-1)?.smooth).toBe(false);
    expect(within(readout).getByText("Beyond native · nearest pixel")).toBeVisible();
    expect(viewer.dataset.camera).toBe(cameraAboveNative);
    expect(execute).toHaveBeenCalledTimes(tilesAboveNative);
  });

  it("keeps coordinates, scale bar, and annotation-tool switches stable across sampling modes and leaves floating viewers untouched", async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 400, 300));
    const drawSamples: Array<{ smooth: unknown; args: unknown[] }> = [];
    (context.drawImage as ReturnType<typeof vi.fn>).mockImplementation((_image: HTMLImageElement, ...args: unknown[]) => {
      drawSamples.push({ smooth: context.imageSmoothingEnabled, args });
    });
    const onPoint = vi.fn();
    function DockedToolHarness() {
      const [mode, setMode] = useState<AnnotationTool>("point");
      const [sampling, setSampling] = useState<"auto" | "nearest" | "smooth">("auto");
      return <>
        <button type="button" onClick={() => setMode("rectangle")}>Switch to rectangle</button>
        <button type="button" onClick={() => setMode("point")}>Switch to point</button>
        <ImageViewport dockedControls api={api()} source={source} selection={selection} channels={channels}
          initialCamera={{ x: 200, y: 75, scale: 0.5 }} drawingMode={mode} onPoint={onPoint}
          displaySampling={sampling} onDisplaySamplingChange={setSampling} onError={vi.fn()} />
      </>;
    }
    const { unmount } = render(<DockedToolHarness />);
    const canvas = await preparedCanvas();
    const scaleBarWidthBefore = document.querySelector<HTMLElement>(".image-scale-bar i")!.style.width;
    const drawBoundsBefore = drawSamples.at(-1)!.args;

    click(canvas, 1, 224, 178);
    const pointAuto = onPoint.mock.lastCall?.[0];

    fireEvent.click(within(screen.getByRole("group", { name: "Display sampling" })).getByRole("button", { name: "Nearest pixel" }));
    expect(drawSamples.at(-1)?.smooth).toBe(false);
    expect(drawSamples.at(-1)?.args).toEqual(drawBoundsBefore);
    expect(document.querySelector<HTMLElement>(".image-scale-bar i")!.style.width).toBe(scaleBarWidthBefore);

    click(canvas, 2, 224, 178);
    expect(onPoint.mock.lastCall?.[0]).toEqual(pointAuto);

    fireEvent.click(screen.getByRole("button", { name: "Switch to rectangle" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to point" }));
    expect(within(screen.getByRole("group", { name: "Display sampling" })).getByRole("button", { name: "Nearest pixel" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(drawSamples.at(-1)?.smooth).toBe(false);

    unmount();
    drawSamples.length = 0;
    render(<ImageViewport api={api()} source={source} selection={selection} channels={channels}
      initialCamera={{ x: 200, y: 75, scale: 0.5 }} onError={vi.fn()} />);
    await preparedCanvas();
    expect(screen.queryByRole("group", { name: "Display sampling" })).not.toBeInTheDocument();
    expect(drawSamples.at(-1)?.smooth).toBe(true);
  });
});

describe("ImageViewport annotation labels", () => {
  const transect: NonNullable<ImageAnnotation["transect"]> = {
    schema: "loci.epidermal-transect/v1", class: "suprapapillary",
    upper_boundary: "upper", lower_boundary: "lower", orientation_rule: "manual", exclusions: "none",
    review: { status: "unverified", reviewer: null },
  };

  it.each(["suprapapillary", "ridge-base", "custom"])("hides the saved %s prefix for structured and legacy transects", (kind) => {
    const label = `[transect:${kind}] Sample A · rev: Alice [reviewed]`;
    expect(annotationDisplayLabel({ label })).toEqual({ label: "Sample A · rev: Alice [reviewed]", isTransect: true });
    expect(annotationDisplayLabel({ label, transect })).toEqual({ label: "Sample A · rev: Alice [reviewed]", isTransect: true });
  });

  it("uses a readable class fallback for an empty transect name and respects structured class", () => {
    expect(annotationDisplayLabel({ label: "[transect:ridge-base] " })).toEqual({ label: "Ridge-base transect", isTransect: true });
    expect(annotationDisplayLabel({ label: "[transect:custom]", transect })).toEqual({ label: "Suprapapillary transect", isTransect: true });
    expect(annotationDisplayLabel({ label: "Manual A", transect })).toEqual({ label: "Manual A", isTransect: true });
  });

  it.each(["Distance A", "", "[transect:unknown] A", "Note [transect:custom] A"])("preserves an ordinary label verbatim: %s", (label) => {
    expect(annotationDisplayLabel({ label })).toEqual({ label, isTransect: false });
  });

  it("paints a friendly transect label with a neutral halo without changing saved geometry or metadata", async () => {
    const annotation: ImageAnnotation = {
      id: "manual-a", kind: "line", points: [{ x: 40, y: 30 }, { x: 140, y: 90 }],
      label: "[transect:suprapapillary] Sample A", color: "#84cf91", z: 0, t: 0, transect,
    };
    const saved = structuredClone(annotation);
    const fills: Array<{ label: string; color: unknown }> = [];
    const halos: Array<{ label: string; color: unknown; width: unknown }> = [];
    context.fillText = vi.fn((label: string) => fills.push({ label, color: context.fillStyle }));
    context.strokeText = vi.fn((label: string) => halos.push({ label, color: context.strokeStyle, width: context.lineWidth }));
    render(<ImageViewport api={api()} source={source} selection={selection} channels={channels}
      initialCamera={{ x: 200, y: 75, scale: 1 }} annotations={[annotation]} onError={vi.fn()} />);
    await preparedCanvas();

    expect(context.moveTo).toHaveBeenCalledWith(40, 60);
    expect(context.lineTo).toHaveBeenCalledWith(140, 180);
    expect(context.strokeText).toHaveBeenCalledWith("Sample A", 47, 53);
    expect(context.fillText).toHaveBeenCalledWith("Sample A", 47, 53);
    expect(halos).toContainEqual({ label: "Sample A", color: "#151515", width: 3 });
    expect(fills).toContainEqual({ label: "Sample A", color: "#ffffff" });
    expect(fills.some(({ label }) => label.includes("[transect:"))).toBe(false);
    expect(annotation).toEqual(saved);
  });
});

describe("ImageViewport annotation drawing", () => {
  it("draws a dragged rectangle as a closed live shape in level-zero anisotropic coordinates", async () => {
    render(<Harness mode="rectangle" />);
    const canvas = await preparedCanvas();
    context.closePath.mockClear();

    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 40, clientY: 60 });
    fireEvent.pointerMove(canvas, { pointerId: 1, button: 0, clientX: 140, clientY: 180 });
    expect(readDraft()).toEqual([{ x: 40, y: 30 }, { x: 140, y: 90 }]);
    expect(context.closePath).toHaveBeenCalled();
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: 140, clientY: 180 });

    expect(readDraft()).toEqual([{ x: 40, y: 30 }, { x: 140, y: 90 }]);
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("closes a polygon near its first screen-space handle and clears it with Escape", async () => {
    render(<Harness mode="polygon" />);
    const canvas = await preparedCanvas();
    const viewport = screen.getByLabelText("Image viewer: Anisotropic source");
    click(canvas, 1, 50, 50);
    click(canvas, 2, 150, 50);
    click(canvas, 3, 150, 150);
    expect(readDraft()).toEqual([{ x: 50, y: 25 }, { x: 150, y: 25 }, { x: 150, y: 75 }]);

    context.closePath.mockClear();
    click(canvas, 4, 56, 54);
    expect(readDraft()).toHaveLength(3);
    expect(context.closePath).toHaveBeenCalled();

    fireEvent.keyDown(viewport, { key: "Escape" });
    expect(readDraft()).toEqual([]);
  });

  it("supports both double-click and Enter polygon closure", async () => {
    render(<Harness mode="polygon" />);
    const canvas = await preparedCanvas();
    const viewport = screen.getByLabelText("Image viewer: Anisotropic source");
    click(canvas, 1, 40, 40);
    click(canvas, 2, 120, 40);
    click(canvas, 3, 120, 120);
    context.closePath.mockClear();
    click(canvas, 7, 180, 120);
    click(canvas, 8, 180, 120);
    fireEvent.doubleClick(canvas, { clientX: 180, clientY: 120 });
    expect(readDraft()).toEqual([
      { x: 40, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 60 }, { x: 180, y: 60 },
    ]);
    expect(context.closePath).toHaveBeenCalled();

    fireEvent.keyDown(viewport, { key: "Escape" });
    click(canvas, 4, 60, 60);
    click(canvas, 5, 160, 60);
    context.closePath.mockClear();
    fireEvent.doubleClick(canvas, { clientX: 160, clientY: 60 });
    expect(readDraft()).toHaveLength(2);
    expect(context.closePath).not.toHaveBeenCalled();
    click(canvas, 6, 160, 160);
    context.closePath.mockClear();
    fireEvent.keyDown(viewport, { key: "Enter" });
    expect(context.closePath).toHaveBeenCalled();
  });

  it("samples a freehand drag into a closed bounded polygon and cancels interrupted strokes", async () => {
    render(<Harness mode="freehand" />);
    const canvas = await preparedCanvas();
    fireEvent.pointerDown(canvas, { pointerId: 7, button: 0, clientX: 40, clientY: 60 });
    fireEvent.pointerMove(canvas, { pointerId: 7, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerMove(canvas, { pointerId: 7, button: 0, clientX: 100, clientY: 140 });
    fireEvent.pointerMove(canvas, { pointerId: 7, button: 0, clientX: 40, clientY: 140 });
    fireEvent.pointerUp(canvas, { pointerId: 7, button: 0, clientX: 40, clientY: 140 });

    expect(readDraft()).toEqual([
      { x: 40, y: 30 }, { x: 100, y: 30 }, { x: 100, y: 70 }, { x: 40, y: 70 },
    ]);
    expect(context.closePath).toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText("Image viewer: Anisotropic source"), { key: "Escape" });
    fireEvent.pointerDown(canvas, { pointerId: 8, button: 0, clientX: 70, clientY: 70 });
    fireEvent.pointerMove(canvas, { pointerId: 8, button: 0, clientX: 100, clientY: 90 });
    fireEvent.keyDown(screen.getByLabelText("Image viewer: Anisotropic source"), { key: "Escape" });
    fireEvent.pointerMove(canvas, { pointerId: 8, button: 0, clientX: 130, clientY: 110 });
    fireEvent.pointerUp(canvas, { pointerId: 8, button: 0, clientX: 130, clientY: 110 });
    expect(readDraft()).toEqual([]);
  });
});
