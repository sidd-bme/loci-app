// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
