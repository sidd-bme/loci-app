import { Minus, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { sanitizeRendererError } from "./ContextHelp";
import type {
  ResearchDesktopApi,
  ResearchDimensions,
  ResearchLevel,
  ResearchSelection,
  ResearchSource,
} from "../shared/research-contracts";
import "./ResearchNativeViewport.css";

type Channel = {
  channel: number;
  low?: number;
  high?: number;
  gamma: number;
  visible: boolean;
  color: string;
};

type Drag = {
  pointerId: number;
  clientX: number;
  clientY: number;
  selection: ResearchSelection;
  nativePerCssX: number;
  nativePerCssY: number;
};

type ViewState = {
  key: string;
  image: string | null;
  loading: boolean;
};

const MAX_VIEW_EDGE = 2048;
const WHOLE_SLIDE_VIEW_BUDGET_BYTES = 64 * 1024 ** 2;
const WHOLE_SLIDE_RGB_BYTES_PER_PIXEL = 32;
export const MAX_WHOLE_SLIDE_RGB_VIEW_PIXELS =
  WHOLE_SLIDE_VIEW_BUDGET_BYTES / WHOLE_SLIDE_RGB_BYTES_PER_PIXEL;
const PAN_FRACTION = 0.1;
const ZOOM_IN = 0.8;
const ZOOM_OUT = 1.25;

function finiteDownsample(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function openSlideDownsamples(metadata: ResearchSource["metadata"]): Map<number, number> {
  const result = new Map<number, number>();
  const wholeSlide = (metadata as Record<string, unknown>).whole_slide;
  if (!wholeSlide || typeof wholeSlide !== "object") return result;
  const levels = (wholeSlide as { levels?: unknown }).levels;
  if (!Array.isArray(levels)) return result;
  levels.forEach((candidate, position) => {
    if (!candidate || typeof candidate !== "object") return;
    const level = candidate as { index?: unknown; downsample?: unknown };
    const index = Number.isSafeInteger(level.index) ? Number(level.index) : position;
    const downsample = finiteDownsample(level.downsample);
    if (downsample !== null) result.set(index, downsample);
  });
  return result;
}

function boundedExtents(
  width: number,
  height: number,
  dimensions: ResearchDimensions,
  maxPixels?: number,
): { width: number; height: number } {
  let boundedWidth = Math.max(
    1,
    Math.min(MAX_VIEW_EDGE, dimensions.x, Math.round(width)),
  );
  let boundedHeight = Math.max(
    1,
    Math.min(MAX_VIEW_EDGE, dimensions.y, Math.round(height)),
  );
  if (maxPixels && boundedWidth * boundedHeight > maxPixels) {
    const scale = Math.sqrt(maxPixels / (boundedWidth * boundedHeight));
    boundedWidth = Math.max(1, Math.floor(boundedWidth * scale));
    boundedHeight = Math.max(1, Math.floor(boundedHeight * scale));
  }
  return { width: boundedWidth, height: boundedHeight };
}

function clampOrigin(
  origin: number,
  extent: number,
  dimension: number,
): number {
  return Math.min(Math.max(0, Math.round(origin)), dimension - extent);
}

export function maxNativeViewPixels(source: ResearchSource): number | undefined {
  return source.source_kind === "whole_slide" &&
    source.metadata.sample_semantics === "RGB"
    ? MAX_WHOLE_SLIDE_RGB_VIEW_PIXELS
    : undefined;
}

export function clampNativeSelection(
  selection: ResearchSelection,
  dimensions: ResearchDimensions,
  maxPixels?: number,
): ResearchSelection {
  const extents = boundedExtents(
    selection.width,
    selection.height,
    dimensions,
    maxPixels,
  );
  const z = Math.min(Math.max(0, Math.round(selection.z)), dimensions.z - 1);
  const zStop = selection.z_stop === undefined
    ? undefined
    : Math.min(dimensions.z, Math.max(z + 1, Math.round(selection.z_stop)));
  const { z_stop: _priorStop, ...singlePlane } = selection;
  return {
    ...singlePlane,
    x: clampOrigin(selection.x, extents.width, dimensions.x),
    y: clampOrigin(selection.y, extents.height, dimensions.y),
    width: extents.width,
    height: extents.height,
    t: Math.min(Math.max(0, Math.round(selection.t)), dimensions.t - 1),
    c: Math.min(Math.max(0, Math.round(selection.c)), dimensions.c - 1),
    z,
    ...(zStop === undefined ? {} : { z_stop: zStop }),
  };
}

function mappedEdges(
  origin: number,
  extent: number,
  scale: number,
): { origin: number; extent: number } {
  const first = Math.round(origin * scale);
  const last = Math.round((origin + extent) * scale);
  return { origin: first, extent: Math.max(1, last - first) };
}

export function mapSelectionToLevel(
  selection: ResearchSelection,
  current: ResearchLevel,
  target: ResearchLevel,
  metadata: ResearchSource["metadata"],
): ResearchSelection {
  const downsamples = openSlideDownsamples(metadata);
  const currentDownsample = downsamples.get(current.index);
  const targetDownsample = downsamples.get(target.index);
  const scaleX = currentDownsample && targetDownsample
    ? currentDownsample / targetDownsample
    : target.dimensions.x / current.dimensions.x;
  const scaleY = currentDownsample && targetDownsample
    ? currentDownsample / targetDownsample
    : target.dimensions.y / current.dimensions.y;
  const x = mappedEdges(selection.x, selection.width, scaleX);
  const y = mappedEdges(selection.y, selection.height, scaleY);
  return clampNativeSelection(
    {
      ...selection,
      level: target.index,
      x: x.origin,
      y: y.origin,
      width: x.extent,
      height: y.extent,
    },
    target.dimensions,
    downsamples.size && metadata.sample_semantics === "RGB"
      ? MAX_WHOLE_SLIDE_RGB_VIEW_PIXELS
      : undefined,
  );
}

export function zoomNativeSelection(
  selection: ResearchSelection,
  dimensions: ResearchDimensions,
  factor: number,
  anchorX = 0.5,
  anchorY = 0.5,
  maxPixels?: number,
): ResearchSelection {
  const boundedAnchorX = Math.min(1, Math.max(0, anchorX));
  const boundedAnchorY = Math.min(1, Math.max(0, anchorY));
  const { width, height } = boundedExtents(
    selection.width * factor,
    selection.height * factor,
    dimensions,
    maxPixels,
  );
  return clampNativeSelection(
    {
      ...selection,
      x: Math.round(selection.x + boundedAnchorX * (selection.width - width)),
      y: Math.round(selection.y + boundedAnchorY * (selection.height - height)),
      width,
      height,
    },
    dimensions,
    maxPixels,
  );
}

function exactSelectionMatches(
  value: unknown,
  expected: ResearchSelection,
): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const actual = value as Record<string, unknown>;
  return ["x", "y", "width", "height", "t", "c", "z", "level"].every(
    (key) => actual[key] === expected[key as keyof ResearchSelection],
  ) && actual.z_stop === expected.z_stop;
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? sanitizeRendererError(error.message)
    : "Could not render this native region.";
}

export function ResearchNativeViewport({
  api,
  source,
  selection,
  levels,
  channels,
  projection,
  imageScale,
  overrideImage,
  disabled = false,
  onSelection,
  onError,
}: {
  api: ResearchDesktopApi;
  source: ResearchSource;
  selection: ResearchSelection;
  levels: ResearchLevel[];
  channels: Channel[];
  projection: "plane" | "max" | "mean";
  imageScale: "fit" | "actual";
  overrideImage?: string | null;
  disabled?: boolean;
  onSelection: (selection: ResearchSelection) => void;
  onError: (error: string | null) => void;
}): React.JSX.Element {
  const keyboardHelpId = useId();
  const level = levels.find((candidate) => candidate.index === selection.level) ?? levels[0];
  const dimensions = level?.dimensions;
  const maxPixels = maxNativeViewPixels(source);
  const resolved = useMemo(
    () => dimensions ? clampNativeSelection(selection, dimensions, maxPixels) : selection,
    [dimensions, maxPixels, selection],
  );
  const requestSelection = useMemo(() => {
    const value = { ...resolved };
    if (projection === "plane") delete value.z_stop;
    return value;
  }, [projection, resolved]);
  const requestKey = JSON.stringify([
    source.id,
    source.sha256,
    source.locator_state,
    requestSelection,
    channels,
    projection,
  ]);
  const [view, setView] = useState<ViewState>({ key: "", image: null, loading: false });
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const requestToken = useRef(0);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<Drag | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const bounds = frame.getBoundingClientRect();
      setFrameSize((old) => old.width === bounds.width && old.height === bounds.height
        ? old
        : { width: bounds.width, height: bounds.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const token = ++requestToken.current;
    dragRef.current = null;
    setDragOffset({ x: 0, y: 0 });
    setView({ key: requestKey, image: null, loading: true });
    if (!dimensions || !channels.length || source.locator_state === "relink-required") {
      setView({ key: requestKey, image: null, loading: false });
      return;
    }
    if (
      projection !== "plane" &&
      (!Number.isSafeInteger(requestSelection.z_stop) ||
        requestSelection.z_stop! <= requestSelection.z ||
        requestSelection.z_stop! > dimensions.z)
    ) {
      setView({ key: requestKey, image: null, loading: false });
      onError(
        `Choose a Z stop greater than ${requestSelection.z} and at most ${dimensions.z} for this projection.`,
      );
      return;
    }
    void api.execute("view", {
      source_id: source.id,
      selection: requestSelection,
      channels,
      ...(projection === "plane" ? {} : { projection }),
    }).then((value) => {
      if (token !== requestToken.current) return;
      const output = value as { image?: unknown; selection?: unknown };
      if (typeof output?.image !== "string" || !exactSelectionMatches(output.selection, requestSelection))
        throw new Error("The native view response did not match the exact requested scope.");
      setView({ key: requestKey, image: output.image, loading: false });
    }).catch((error) => {
      if (token !== requestToken.current) return;
      setView({ key: requestKey, image: null, loading: false });
      onError(safeMessage(error));
    });
    return () => { requestToken.current += 1; };
  }, [api, channels, dimensions, onError, projection, requestKey, requestSelection, source.id, source.locator_state]);

  const scale = imageScale === "actual"
    ? 1
    : frameSize.width > 0 && frameSize.height > 0
      ? Math.min(
          (frameSize.width * 0.94) / Math.max(1, resolved.width),
          (frameSize.height * 0.9) / Math.max(1, resolved.height),
        )
      : 1;
  const displayedImage = overrideImage ?? (view.key === requestKey ? view.image : null);
  const loading = !overrideImage && (view.key !== requestKey || view.loading);
  const navigationDisabled = disabled || loading || !displayedImage || !dimensions;

  const commitPan = (clientX: number, clientY: number) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragOffset({ x: 0, y: 0 });
    if (!drag || !dimensions) return;
    const deltaX = clientX - drag.clientX;
    const deltaY = clientY - drag.clientY;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
    onSelection(clampNativeSelection({
      ...drag.selection,
      x: drag.selection.x - deltaX * drag.nativePerCssX,
      y: drag.selection.y - deltaY * drag.nativePerCssY,
    }, dimensions));
  };

  const zoom = (factor: number, anchorX = 0.5, anchorY = 0.5) => {
    if (navigationDisabled || !dimensions) return;
    const next = zoomNativeSelection(
      resolved,
      dimensions,
      factor,
      anchorX,
      anchorY,
      maxPixels,
    );
    if (next.x !== resolved.x || next.y !== resolved.y ||
        next.width !== resolved.width || next.height !== resolved.height)
      onSelection(next);
  };

  const scopeLabel = `Level ${resolved.level} · X [${resolved.x}, ${resolved.x + resolved.width}) · Y [${resolved.y}, ${resolved.y + resolved.height})`;
  const scaleLabel = `${Math.round(scale * 100)}% CSS scale · ${typeof window === "undefined" ? 1 : window.devicePixelRatio || 1}× display`;

  return (
    <div className="research-native-viewport">
      <div className="research-native-controls">
        <label>
          Resolution{" "}
          <select
            aria-label="Pyramid level"
            value={resolved.level}
            disabled={disabled || levels.length < 2}
            onChange={(event) => {
              if (!level) return;
              const target = levels.find((candidate) => candidate.index === Number(event.target.value));
              if (target) onSelection(mapSelectionToLevel(resolved, level, target, source.metadata));
            }}
          >
            {levels.map((candidate) => (
              <option key={candidate.index} value={candidate.index}>
                Level {candidate.index} · {candidate.dimensions.x} × {candidate.dimensions.y}
              </option>
            ))}
          </select>
        </label>
        <div className="research-native-zoom" aria-label="Native region zoom">
          <button aria-label="Zoom out" disabled={navigationDisabled} onClick={() => zoom(ZOOM_OUT)}>
            <Minus />
          </button>
          <button aria-label="Zoom in" disabled={navigationDisabled} onClick={() => zoom(ZOOM_IN)}>
            <Plus />
          </button>
        </div>
        <output aria-label="Native viewport scope" title={scopeLabel}>{scopeLabel}</output>
        <output aria-label="Native viewport scale" title={scaleLabel}>{scaleLabel}</output>
      </div>
      <div
        ref={frameRef}
        className={`research-native-stage research-image-${imageScale}${dragRef.current ? " is-dragging" : ""}`}
        role="application"
        aria-label="Native source viewport"
        aria-describedby={keyboardHelpId}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Plus = -"
        aria-busy={loading}
        tabIndex={0}
        onPointerDown={(event) => {
          if (navigationDisabled || event.button !== 0) return;
          const bounds = imageRef.current?.getBoundingClientRect();
          if (!bounds?.width || !bounds.height) return;
          dragRef.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            selection: resolved,
            nativePerCssX: resolved.width / bounds.width,
            nativePerCssY: resolved.height / bounds.height,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragOffset({ x: 0, y: 0 });
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setDragOffset({ x: event.clientX - drag.clientX, y: event.clientY - drag.clientY });
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          commitPan(event.clientX, event.clientY);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragOffset({ x: 0, y: 0 });
        }}
        onWheel={(event) => {
          if (navigationDisabled || !imageRef.current) return;
          event.preventDefault();
          const bounds = imageRef.current.getBoundingClientRect();
          const anchorX = bounds.width ? (event.clientX - bounds.left) / bounds.width : 0.5;
          const anchorY = bounds.height ? (event.clientY - bounds.top) / bounds.height : 0.5;
          zoom(event.deltaY < 0 ? ZOOM_IN : ZOOM_OUT, anchorX, anchorY);
        }}
        onKeyDown={(event) => {
          if (navigationDisabled || !dimensions) return;
          if (["+", "="].includes(event.key)) {
            event.preventDefault();
            zoom(ZOOM_IN);
            return;
          }
          if (event.key === "-") {
            event.preventDefault();
            zoom(ZOOM_OUT);
            return;
          }
          const stepX = event.shiftKey ? 1 : Math.max(1, Math.round(resolved.width * PAN_FRACTION));
          const stepY = event.shiftKey ? 1 : Math.max(1, Math.round(resolved.height * PAN_FRACTION));
          const delta = event.key === "ArrowLeft" ? [-stepX, 0]
            : event.key === "ArrowRight" ? [stepX, 0]
              : event.key === "ArrowUp" ? [0, -stepY]
                : event.key === "ArrowDown" ? [0, stepY]
                  : null;
          if (!delta) return;
          event.preventDefault();
          onSelection(clampNativeSelection({
            ...resolved,
            x: resolved.x + delta[0],
            y: resolved.y + delta[1],
          }, dimensions));
        }}
      >
        {loading ? (
          <div className="research-native-loading" role="status">Loading exact native region…</div>
        ) : displayedImage ? (
          <img
            ref={imageRef}
            src={displayedImage}
            alt="Bounded native image region"
            draggable={false}
            style={{
              width: resolved.width * scale,
              height: resolved.height * scale,
              transform: `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0)`,
            }}
          />
        ) : (
          <p>{source.locator_state === "relink-required"
            ? "This source needs an exact local copy. Open Portability to relink its verified fingerprint."
            : "The selected native region is unavailable."}</p>
        )}
      </div>
      <p id={keyboardHelpId} className="research-native-help">
        Drag to pan · Arrows: 10% of crop · Shift + arrow: one native pixel · + / − or wheel to zoom
      </p>
    </div>
  );
}
