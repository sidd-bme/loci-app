import { Maximize, Minus, Plus, RotateCcw, Scan } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { boundedCamera, fitCamera, imageExtent, screenToSource, sourceLevels,
  sourceToScreen, visibleTiles, zoomCamera, type Camera, type Tile } from "./viewer-camera";
import { sourcePointToResultPixel, type ResolvedResultPlaneOverlay } from "./result-plane-overlay";
import type { CorrectionPreview } from "./ResearchCorrectionPanel";
import "./ImageViewport.css";

export type ViewerChannel = {
  channel: number; low?: number; high?: number; gamma: number;
  visible: boolean; color: string; opacity?: number;
};
export type ImagePoint = { x: number; y: number };
export type AnnotationTool = "navigate" | "point" | "line" | "polygon" | "freehand" | "rectangle" | "transect";
export type EpidermalTransectMetadata = {
  schema: "loci.epidermal-transect/v1";
  class: "suprapapillary" | "ridge-base" | "custom";
  upper_boundary: string;
  lower_boundary: string;
  orientation_rule: string;
  exclusions: string;
  review: {
    status: "approved" | "unverified";
    reviewer: string | null;
  };
};
export type ImageAnnotation = {
  id: string; kind: "point" | "line" | "polygon" | "rectangle";
  points: ImagePoint[]; label: string; color: string; z: number; t: number;
  transect?: EpidermalTransectMetadata;
};
type CachedTile = { tile: Tile; image: HTMLImageElement; bytes: number };
const CACHE_BYTES = 64 * 1024 ** 2;
const OVERVIEW_KEY = "overview";

function loadedImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!uri.startsWith("data:image/png;base64,")) return reject(new Error("Invalid image response"));
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode the image view"));
    image.src = uri;
  });
}

export function ImageViewport({ api, source, selection, channels, projection = "plane",
  onError, onPoint, annotations = [], draft = [], drawingMode = "navigate", onDraftChange,
  showRegion = false, overrideImage = null,
  resultOverlay = null, onResultPoint, resultDrawing = null, resultCentroid = null,
  initialCamera = null, controlledCamera = null, onCamera, onViewReady, onRegion, paused = false,
  showScaleBar = true, showNavigator = true, requestLane, overlayRight = 0,
  onObjectClick,
}: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection;
  channels: ViewerChannel[]; projection?: "plane" | "max" | "mean";
  onError: (message: string) => void; onPoint?: (point: ImagePoint) => void;
  annotations?: ImageAnnotation[]; draft?: ImagePoint[]; showRegion?: boolean;
  drawingMode?: AnnotationTool; onDraftChange?: (points: ImagePoint[]) => void;
  overrideImage?: string | null;
  resultOverlay?: ResolvedResultPlaneOverlay | null;
  onResultPoint?: (point: { u: number; v: number }) => void;
  resultDrawing?: (CorrectionPreview & { points: Array<{ u: number; v: number }> }) | null;
  resultCentroid?: { u: number; v: number } | null;
  initialCamera?: Camera | null; controlledCamera?: Camera | null;
  onCamera?: (camera: Camera) => void;
  onViewReady?: (key: string) => void;
  onRegion?: (region: { x: number; y: number; width: number; height: number }) => void;
  paused?: boolean;
  showScaleBar?: boolean; showNavigator?: boolean;
  /** Stable main-process scheduling identity for this viewport instance. */
  requestLane?: string;
  /** Right overlay inset (e.g. translucent inspector sidebar) for visible centering */
  overlayRight?: number;
  /** Called on click when navigating to pick objects */
  onObjectClick?: (point: { x: number; y: number }) => void;
}) {
  const generatedLane = `image-viewport-${useId().replace(/[^a-z0-9_-]/giu, "").toLowerCase()}`;
  const viewerLane = requestLane ?? generatedLane;
  const extent = useMemo(() => imageExtent(source), [source]);
  const insets = useMemo(() => ({ right: overlayRight }), [overlayRight]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [camera, setCamera] = useState<Camera>(initialCamera ?? { x: extent.width / 2, y: extent.height / 2, scale: 1 });
  const [fitted, setFitted] = useState(!initialCamera);
  const [loading, setLoading] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolsPosition, setToolsPosition] = useState<{ x: number; y: number } | null>(null);
  const [navPosition, setNavPosition] = useState<{ x: number; y: number } | null>(null);
  const [navWidth, setNavWidth] = useState(130);
  const navDrag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const navResizeDrag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [regionDraft, setRegionDraft] = useState<ImagePoint[]>([]);
  const [draftClosed, setDraftClosed] = useState(false);
  const [draftLimitReached, setDraftLimitReached] = useState(false);
  const toolsDrag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const sourceScope = JSON.stringify([source.id, source.sha256, source.locator_state, channels]);
  const cache = useRef<{
    scope: string;
    sourceScope: string;
    tiles: Map<string, CachedTile>;
    recentScopes: Map<string, Map<string, CachedTile>>;
    bytes: number;
    lastRenderedScope: string;
  }>({
    scope: "",
    sourceScope: "",
    tiles: new Map(),
    recentScopes: new Map(),
    bytes: 0,
    lastRenderedScope: "",
  });
  const resultOverlayImage = useRef<{ key: string; image: HTMLImageElement } | null>(null);
  const request = useRef<{ scope: string; queue: Tile[]; overview: boolean; running: boolean; generation: number }>({ scope: "", queue: [], overview: true, running: false, generation: 0 });
  const drag = useRef<{ pointerId: number; x: number; y: number; camera: Camera; moved: boolean;
    button: number; vertex?: number; annotation?: { mode: "rectangle" | "freehand";
      start: ImagePoint; points: ImagePoint[]; previous: ImagePoint[]; lastClientX: number; lastClientY: number } } | null>(null);
  const drawFrame = useRef(0);
  const alive = useRef(true);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const dpr = window.devicePixelRatio || 1;
  const scope = JSON.stringify([source.id, source.sha256, source.locator_state, selection.t,
    selection.z, selection.c, projection, projection === "plane" ? null : selection.z_stop, channels]);
  const current = useRef({ camera, size, extent, scope, annotations, draft, regionDraft,
    draftClosed, drawingMode, selection, showRegion, resultOverlay, resultDrawing, resultCentroid });
  current.current = { camera, size, extent, scope, annotations, draft, regionDraft,
    draftClosed, drawingMode, selection, showRegion, resultOverlay, resultDrawing, resultCentroid };

  const draw = useCallback(() => {
    cancelAnimationFrame(drawFrame.current);
    drawFrame.current = requestAnimationFrame(() => {
      const surface = canvas.current;
      if (!surface) return;
      const state = current.current;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(state.size.width * ratio));
      const height = Math.max(1, Math.round(state.size.height * ratio));
      if (surface.width !== width || surface.height !== height) { surface.width = width; surface.height = height; }
      const context = surface.getContext("2d", { alpha: false });
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = "#151515";
      context.fillRect(0, 0, state.size.width, state.size.height);

      let tilesToDraw = cache.current.scope === state.scope ? [...cache.current.tiles.values()] : [];
      if (tilesToDraw.length === 0 && cache.current.sourceScope === sourceScope && cache.current.lastRenderedScope) {
        const fallback = cache.current.recentScopes.get(cache.current.lastRenderedScope);
        if (fallback) {
          tilesToDraw = [...fallback.values()];
        }
      }
      if (tilesToDraw.length === 0) return;
      if (cache.current.scope === state.scope && cache.current.tiles.size > 0) {
        cache.current.lastRenderedScope = state.scope;
      }

      context.imageSmoothingEnabled = state.camera.scale * ratio < 1;
      const tiles = tilesToDraw.sort((a, b) =>
        a.tile.key === "preview" ? 1 : b.tile.key === "preview" ? -1 :
          b.tile.sourceWidth / b.tile.width - a.tile.sourceWidth / a.tile.width);
      for (const { tile, image } of tiles) {
        const point = sourceToScreen(state.camera, state.size, state.extent, tile.left, tile.top);
        const w = tile.sourceWidth * state.camera.scale, h = tile.sourceHeight * state.camera.scale * state.extent.aspectY;
        if (point.x > state.size.width || point.y > state.size.height || point.x + w < 0 || point.y + h < 0) continue;
        context.drawImage(image, point.x, point.y, w, h);
      }
      const overlay = state.resultOverlay;
      const overlayImage = resultOverlayImage.current;
      if (overlay && overlayImage?.key === overlay.key) {
        const origin = sourceToScreen(state.camera, state.size, state.extent, overlay.left, overlay.top);
        context.save();
        context.globalAlpha = overlay.opacity;
        context.drawImage(overlayImage.image, origin.x, origin.y,
          overlay.width * state.camera.scale,
          overlay.height * state.camera.scale * state.extent.aspectY);
        context.restore();
      }
      const point = (p: ImagePoint) => sourceToScreen(state.camera, state.size, state.extent, p.x, p.y);
      const outline = (points: ImagePoint[], color: string, closed: boolean, label?: string) => {
        if (!points.length) return;
        context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 1.5;
        context.beginPath();
        points.forEach((p, i) => { const q = point(p); i ? context.lineTo(q.x, q.y) : context.moveTo(q.x, q.y); });
        if (closed) context.closePath();
        context.stroke();
        const first = point(points[0]);
        if (points.length === 1) { context.beginPath(); context.arc(first.x, first.y, 4, 0, Math.PI * 2); context.stroke(); }
        if (label) { context.font = "12px system-ui"; context.fillText(label, first.x + 7, first.y - 7); }
      };
      if (state.showRegion) {
        const level = sourceLevels(source).find((item) => item.index === state.selection.level);
        const sx = level?.sx ?? 1, sy = level?.sy ?? 1;
        const { x, y, width: w, height: h } = state.selection;
        context.setLineDash([5, 4]);
        outline([{ x: x * sx, y: y * sy }, { x: (x + w) * sx, y: y * sy },
          { x: (x + w) * sx, y: (y + h) * sy }, { x: x * sx, y: (y + h) * sy }], "#ffd36a", true, "Analysis region");
        context.setLineDash([]);
      }
      for (const item of state.annotations) if (item.z === state.selection.z && item.t === state.selection.t)
        outline(item.points, item.color, item.kind === "polygon" || item.kind === "rectangle", item.label);
      const draftPoints = state.drawingMode === "rectangle" && state.draft.length === 2
        ? [state.draft[0], { x: state.draft[1].x, y: state.draft[0].y },
          state.draft[1], { x: state.draft[0].x, y: state.draft[1].y }]
        : state.draft;
      outline(draftPoints, "#ffd36a", (state.drawingMode === "rectangle" && draftPoints.length === 4) ||
        (state.draftClosed && (state.drawingMode === "polygon" || state.drawingMode === "freehand")));
      if (state.drawingMode === "polygon" && state.draft.length && !state.draftClosed) {
        const start = point(state.draft[0]);
        context.beginPath(); context.arc(start.x, start.y, 5, 0, Math.PI * 2); context.stroke();
      }
      outline(state.regionDraft, "#ffd36a", true);
      if (overlay && overlayImage?.key === overlay.key) {
        const resultPoint = (p: { u: number; v: number }) => ({
          x: overlay.left + (p.u + 0.5) / overlay.pixelWidth * overlay.width,
          y: overlay.top + (p.v + 0.5) / overlay.pixelHeight * overlay.height,
        });
        const drawing = state.resultDrawing;
        if (drawing) {
          const points = drawing.points.map(resultPoint);
          if (drawing.kind === "polygon") outline(points, "#ffd36a", points.length >= 3);
          if (drawing.kind === "vertices") {
            context.setLineDash([4, 4]); outline(drawing.sourceVertices.map(resultPoint), "#d9c99a", true);
            context.setLineDash([]); outline(points, "#ffd36a", true);
            points.forEach((p, index) => {
              const q = point(p); context.beginPath(); context.arc(q.x, q.y, index === drawing.selectedIndex ? 5 : 3, 0, Math.PI * 2);
              context.fillStyle = index === drawing.selectedIndex ? "#ffd36a" : "#151515";
              context.strokeStyle = "#ffd36a"; context.fill(); context.stroke();
            });
          }
          if (drawing.kind === "seeds") for (const seed of [...drawing.savedSeeds, ...drawing.points])
            outline([resultPoint(seed)], "#ffd36a", false);
          if (drawing.kind === "brush") {
            outline(points, "#ffd36a", false);
            for (const p of points) {
              const q = point(p);
              context.strokeStyle = "#ffd36a"; context.fillStyle = "rgba(255,207,92,0.25)";
              context.beginPath();
              context.ellipse(q.x, q.y,
                drawing.radiusU * overlay.width / overlay.pixelWidth * state.camera.scale,
                drawing.radiusV * overlay.height / overlay.pixelHeight * state.camera.scale * state.extent.aspectY,
                0, 0, Math.PI * 2);
              context.fill(); context.stroke();
            }
          }
        }
        if (state.resultCentroid) {
          const c = point(resultPoint(state.resultCentroid));
          context.save();
          context.beginPath();
          context.arc(c.x, c.y, 9, 0, Math.PI * 2);
          context.strokeStyle = "#4fa3d1";
          context.lineWidth = 2;
          context.fillStyle = "rgba(79, 163, 209, 0.25)";
          context.fill();
          context.stroke();
          context.beginPath();
          context.arc(c.x, c.y, 3, 0, Math.PI * 2);
          context.fillStyle = "#ffffff";
          context.fill();
          context.restore();
        }
      }
    });
  }, [source]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current.generation++; cancelAnimationFrame(drawFrame.current); cache.current.tiles.clear(); };
  }, []);
  useEffect(() => {
    drag.current = null;
    setRegionDraft([]);
    setDraftClosed(false);
    setDraftLimitReached(false);
  }, [source.id, source.sha256, selection.z, selection.t, drawingMode]);
  useEffect(() => {
    if (!draft.length) {
      setDraftClosed(false);
      setDraftLimitReached(false);
    }
  }, [draft.length]);
  useEffect(() => {
    const cancelGesture = () => {
      const state = drag.current;
      drag.current = null;
      setRegionDraft([]);
      if (state?.annotation) onDraftChange?.(state.annotation.previous);
    };
    window.addEventListener("blur", cancelGesture);
    return () => window.removeEventListener("blur", cancelGesture);
  }, [onDraftChange]);
  useLayoutEffect(() => {
    if (cache.current.scope !== scope) {
      const isSameSource = cache.current.sourceScope === sourceScope && cache.current.sourceScope !== "";
      const existing = cache.current.recentScopes.get(scope);
      const newTiles = existing ? new Map(existing) : new Map();

      cache.current.scope = scope;
      cache.current.sourceScope = sourceScope;
      cache.current.tiles = newTiles;

      request.current = {
        scope,
        queue: [],
        overview: !newTiles.has(OVERVIEW_KEY),
        running: false,
        generation: request.current.generation + 1,
      };

      if (!isSameSource) {
        cache.current.recentScopes.clear();
        cache.current.bytes = 0;
        cache.current.lastRenderedScope = "";
        setPrepared(false);
        // Clear synchronously before paint: another source or channel setting can
        // never remain visible while its replacement is being decoded.
        const context = canvas.current?.getContext("2d");
        if (context && canvas.current) { context.fillStyle = "#151515"; context.fillRect(0, 0, canvas.current.width, canvas.current.height); }
      } else {
        if (newTiles.has(OVERVIEW_KEY)) {
          setPrepared(true);
        }
      }
    }
    draw();
  }, [scope, sourceScope, draw]);
  useEffect(() => { if (size.width > 0 && size.height > 0) onCamera?.(camera); }, [camera, size, onCamera]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      setSize((previous) => previous.width === bounds.width && previous.height === bounds.height ? previous : { width: bounds.width, height: bounds.height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    const changed = () => { setFullscreen(document.fullscreenElement === element); measure(); };
    document.addEventListener("fullscreenchange", changed);
    return () => { observer.disconnect(); document.removeEventListener("fullscreenchange", changed); };
  }, []);
  useLayoutEffect(() => {
    if (fitted && size.width > 0 && size.height > 0) setCamera(fitCamera(extent, size, insets));
  }, [fitted, size, extent, insets]);
  useLayoutEffect(() => {
    if (!controlledCamera || size.width <= 0 || size.height <= 0) return;
    setFitted(false);
    setCamera((previous) => {
      const next = boundedCamera(controlledCamera, extent, size, insets);
      return previous.x === next.x && previous.y === next.y && previous.scale === next.scale
        ? previous
        : next;
    });
  }, [controlledCamera?.x, controlledCamera?.y, controlledCamera?.scale, extent, size, insets]);
  useLayoutEffect(draw, [camera, size, draw, annotations, draft, draftClosed, drawingMode,
    regionDraft, showRegion, selection, resultDrawing, resultCentroid]);

  useLayoutEffect(() => {
    if (!resultOverlay || resultOverlayImage.current?.key !== resultOverlay.key)
      resultOverlayImage.current = null;
    draw();
  }, [resultOverlay?.key, draw]);
  useEffect(() => {
    if (!resultOverlay) return;
    if (resultOverlay.sourceId !== source.id || resultOverlay.sourceSha256 !== source.sha256) {
      onError("The result overlay does not match its source."); return;
    }
    let active = true;
    void loadedImage(resultOverlay.image).then((image) => {
      if (!active) return;
      if (image.naturalWidth !== resultOverlay.pixelWidth || image.naturalHeight !== resultOverlay.pixelHeight)
        throw new Error("The exact result overlay dimensions do not match its verified grid.");
      resultOverlayImage.current = { key: resultOverlay.key, image };
      draw();
    }).catch((error) => {
      if (active) onError(error instanceof Error ? error.message : "Could not show the exact result overlay.");
    });
    return () => {
      active = false;
      if (resultOverlayImage.current?.key === resultOverlay.key) resultOverlayImage.current = null;
    };
  }, [resultOverlay, source.id, source.sha256, draw, onError]);

  const plan = useMemo(() => visibleTiles(source, camera, size, dpr), [source, camera, size, dpr]);
  useLayoutEffect(() => {
    if (!paused) return;
    const previous = request.current;
    request.current = {
      scope,
      queue: plan.tiles,
      overview: !cache.current.tiles.has(OVERVIEW_KEY),
      running: false,
      generation: previous.generation + 1,
    };
    setLoading(false);
  }, [paused, plan.tiles, scope]);
  const drain = useCallback(async () => {
    const work = request.current;
    if (paused || pausedRef.current || work.running || !size.width || !size.height ||
      source.locator_state === "relink-required") return;
    work.running = true;
    const loadingTimer = setTimeout(() => {
      if (alive.current && request.current === work) setLoading(true);
    }, 150);
    try {
      while (alive.current && !pausedRef.current && request.current === work) {
        const overview = work.overview;
        const tile = overview ? { key: OVERVIEW_KEY, level: -1, x: 0, y: 0,
          width: 1024, height: 1024, left: 0, top: 0, sourceWidth: extent.width, sourceHeight: extent.height } :
          work.queue.find((item) => !cache.current.tiles.has(item.key));
        if (!tile) break;
        if (overview) work.overview = false;
        else work.queue = work.queue.filter((item) => item.key !== tile.key);
        const native = { ...selection, level: tile.level, x: tile.x, y: tile.y, width: tile.width, height: tile.height };
        // Z is a level-zero plane selection, mapped independently of XY camera.
        const level = source.metadata.levels?.find((item) => item.index === tile.level);
        if (level && source.metadata.dimensions) {
          const zScale = level.dimensions.z / source.metadata.dimensions.z;
          native.z = Math.min(level.dimensions.z - 1, Math.floor(selection.z * zScale));
          if (native.z_stop !== undefined) native.z_stop = Math.max(native.z + 1, Math.min(level.dimensions.z, Math.ceil(native.z_stop * zScale)));
        }
        if (projection === "plane") delete native.z_stop;
        const output = await api.execute("viewer_tile", overview ? {
          source_id: source.id, overview: true, t: selection.t, z: selection.z, c: selection.c,
          channels, max_edge: 1024, ...(projection === "plane" ? {} : { projection, z_stop: selection.z_stop }),
        } : { source_id: source.id, selection: native, channels,
          ...(projection === "plane" ? {} : { projection }) }, { viewer_lane: viewerLane }) as {
            image: string; source_sha256: string; selection?: ResearchSelection;
            source_extent?: number[]; width?: number; height?: number;
          };
        if (!alive.current || pausedRef.current || request.current !== work || cache.current.scope !== scope) break;
        if (output.source_sha256 !== source.sha256) throw new Error("The source changed. Reopen it before continuing.");
        if (!overview && (!output.selection || Object.entries(native).some(([key, value]) => output.selection?.[key as keyof ResearchSelection] !== value)))
          throw new Error("The decoded tile does not match its requested coordinates.");
        if (overview && (output.source_extent?.[0] !== extent.width || output.source_extent?.[1] !== extent.height))
          throw new Error("The overview does not cover the source extent.");
        const image = await loadedImage(output.image);
        if (!alive.current || pausedRef.current || request.current !== work) break;
        if (!overview && (image.naturalWidth !== tile.width || image.naturalHeight !== tile.height)) throw new Error("The decoded tile dimensions are inconsistent.");
        const bytes = image.naturalWidth * image.naturalHeight * 4;
        if (bytes > 8 * 1024 ** 2) throw new Error("The image response exceeds its display budget.");
        const stored = { ...tile, width: image.naturalWidth, height: image.naturalHeight };
        cache.current.tiles.set(tile.key, { tile: stored, image, bytes });
        if (!cache.current.recentScopes.has(scope)) {
          cache.current.recentScopes.set(scope, new Map());
        }
        cache.current.recentScopes.get(scope)!.set(tile.key, { tile: stored, image, bytes });
        cache.current.bytes += bytes;
        while (cache.current.bytes > CACHE_BYTES && cache.current.recentScopes.size > 1) {
          const oldestScope = [...cache.current.recentScopes.keys()].find((s) => s !== scope);
          if (!oldestScope) break;
          const oldestMap = cache.current.recentScopes.get(oldestScope)!;
          for (const item of oldestMap.values()) {
            cache.current.bytes -= item.bytes;
          }
          cache.current.recentScopes.delete(oldestScope);
        }
        if (frame.current) frame.current.dataset.cacheBytes = String(cache.current.bytes);
        if (overview) {
          setPrepared(true);
          onViewReady?.(`${source.id}:${source.sha256}:${selection.t}:${selection.z}`);
        }
        draw();
      }
    } catch (error) {
      if (alive.current && !pausedRef.current && request.current === work)
        onError(error instanceof Error ? error.message : "Could not load this view.");
    } finally {
      clearTimeout(loadingTimer);
      work.running = false;
      if (alive.current && request.current === work) setLoading(false);
    }
  }, [api, channels, draw, extent, onError, onViewReady, paused, projection, scope, selection, size, source, viewerLane]);
  useEffect(() => {
    request.current.queue = plan.tiles;
    void drain();
  }, [plan, drain]);
  // A preview is an explicitly scoped derived overlay; its rectangle follows
  // the declared analysis region, while the camera and source tiles stay put.
  useEffect(() => {
    if (!overrideImage) { cache.current.tiles.delete("preview"); draw(); return; }
    let active = true;
    const level = sourceLevels(source).find((item) => item.index === selection.level);
    void loadedImage(overrideImage).then((image) => {
      if (!active || cache.current.scope !== scope) return;
      cache.current.tiles.set("preview", { image, bytes: 0, tile: { key: "preview", level: selection.level,
        x: selection.x, y: selection.y, width: selection.width, height: selection.height,
        left: selection.x * (level?.sx ?? 1), top: selection.y * (level?.sy ?? 1),
        sourceWidth: selection.width * (level?.sx ?? 1), sourceHeight: selection.height * (level?.sy ?? 1) } });
      draw();
    }).catch(() => { if (active) onError("Could not show the analysis preview."); });
    return () => { active = false; cache.current.tiles.delete("preview"); };
  }, [overrideImage, scope, selection, source, draw, onError]);

  const changeZoom = (factor: number, x?: number, y?: number) => {
    setFitted(false); setCamera((old) => zoomCamera(old, extent, size, factor, x, y, insets));
  };
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); setFitted(false);
      if (event.ctrlKey || !event.deltaX && Math.abs(event.deltaY) >= 40) {
        const bounds = element.getBoundingClientRect();
        const factor = Math.exp(-Math.max(-150, Math.min(150, event.deltaY)) * (event.ctrlKey ? 0.015 : 0.004));
        setCamera((old) => zoomCamera(old, extent, size, factor, event.clientX - bounds.left, event.clientY - bounds.top, insets));
      } else setCamera((old) => boundedCamera({ ...old, x: old.x + event.deltaX / old.scale,
        y: old.y + event.deltaY / (old.scale * extent.aspectY) }, extent, size, insets));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [extent, size, insets]);
  const first = screenToSource(camera, size, extent, 0, 0);
  const last = screenToSource(camera, size, extent, size.width, size.height);
  const calibration = source.metadata.physical_calibration;
  const affine = source.metadata.geometry?.affine;
  const spacingX = affine ? Math.hypot(...affine.slice(0, 3).map((row) => row[0])) : calibration?.spacing?.at(-1);
  const spacingUnit = source.metadata.geometry?.unit ?? calibration?.unit;
  const scaleLength = spacingX ? 100 * spacingX / camera.scale : null;
  const niceScale = scaleLength && Number.isFinite(scaleLength) ?
    [1, 2, 5, 10].map((n) => n * 10 ** Math.floor(Math.log10(scaleLength))).filter((n) => n <= scaleLength).at(-1) : null;
  const freehandPointLimit = Math.max(0, Math.min(2048,
    10_000 - annotations.reduce((total, annotation) => total + annotation.points.length, 0)));
  const pointerSourcePoint = (element: HTMLDivElement, activeCamera: Camera, clientX: number, clientY: number) => {
    const bounds = element.getBoundingClientRect();
    return screenToSource(activeCamera, size, extent, clientX - bounds.left, clientY - bounds.top);
  };
  const pointInsideSource = (point: ImagePoint) =>
    point.x >= 0 && point.y >= 0 && point.x < extent.width && point.y < extent.height;
  const cancelPointerInteraction = (pointerId: number) => {
    const state = drag.current;
    if (!state || state.pointerId !== pointerId) return;
    drag.current = null;
    setRegionDraft([]);
    if (state.annotation) onDraftChange?.(state.annotation.previous);
  };

  return <div className={`image-viewport ${fullscreen ? "is-fullscreen" : ""}`} ref={frame}
    tabIndex={0} aria-label={`Image viewer: ${source.name}`} data-viewer-source={source.id}
    data-result-overlay={resultOverlay?.key}
    data-camera={JSON.stringify(camera)} data-auto-level={plan.level} data-cache-bytes={cache.current.bytes}
    data-prepared={prepared ? "true" : "false"}
    onContextMenu={(event) => event.preventDefault()}
    onPointerDown={(event) => {
      if (event.target !== canvas.current) return;
      event.preventDefault();
      frame.current?.focus();
      if (drag.current) return;
      if (event.button === 0 && draftClosed && (drawingMode === "polygon" || drawingMode === "freehand")) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        camera, moved: false, button: event.button };
      if (event.button === 0 && resultDrawing?.kind === "vertices" && resultOverlay) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const distances = resultDrawing.points.map((p) => {
          const q = sourceToScreen(camera, size, extent,
            resultOverlay.left + (p.u + 0.5) / resultOverlay.pixelWidth * resultOverlay.width,
            resultOverlay.top + (p.v + 0.5) / resultOverlay.pixelHeight * resultOverlay.height);
          return Math.hypot(q.x - event.clientX + bounds.left, q.y - event.clientY + bounds.top);
        });
        const closest = Math.min(...distances);
        if (closest <= 10) {
          const index = distances.indexOf(closest); drag.current.vertex = index;
          resultDrawing.onSelectVertex(index);
        }
      }
      if (event.button === 0 && prepared && cache.current.scope === scope && onDraftChange &&
        (drawingMode === "rectangle" || drawingMode === "freehand")) {
        const point = pointerSourcePoint(event.currentTarget, camera, event.clientX, event.clientY);
        if (!pointInsideSource(point)) return;
        const points = drawingMode === "freehand" && freehandPointLimit >= 3 ? [point] : [];
        drag.current.annotation = { mode: drawingMode, start: point, points,
          previous: draft, lastClientX: event.clientX, lastClientY: event.clientY };
        if (drawingMode === "freehand") {
          setDraftClosed(false); setDraftLimitReached(freehandPointLimit < 3); onDraftChange(points);
        }
      }
    }} onPointerMove={(event) => {
      const state = drag.current; if (!state || state.pointerId !== event.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - state.x, dy = event.clientY - state.y;
      state.moved ||= Math.hypot(dx, dy) > 3;
      if (resultDrawing?.kind === "vertices" && resultOverlay && state.button === 0) {
        if (state.vertex !== undefined) {
          const bounds = event.currentTarget.getBoundingClientRect();
          const p = screenToSource(state.camera, size, extent, event.clientX - bounds.left, event.clientY - bounds.top);
          const uv = sourcePointToResultPixel(resultOverlay, p);
          if (uv) resultDrawing.onMoveVertex(state.vertex, uv);
        }
        return;
      }
      if (state.annotation?.mode === "rectangle" && state.button === 0) {
        if (!state.moved) return;
        const point = pointerSourcePoint(event.currentTarget, state.camera, event.clientX, event.clientY);
        onDraftChange?.([state.annotation.start, {
          x: Math.max(0, Math.min(extent.width, point.x)),
          y: Math.max(0, Math.min(extent.height, point.y)),
        }]);
        return;
      }
      if (state.annotation?.mode === "freehand" && state.button === 0) {
        if (Math.hypot(event.clientX - state.annotation.lastClientX,
          event.clientY - state.annotation.lastClientY) < 2.5) return;
        if (state.annotation.points.length >= freehandPointLimit) {
          setDraftLimitReached(true); return;
        }
        const point = pointerSourcePoint(event.currentTarget, state.camera, event.clientX, event.clientY);
        const bounded = { x: Math.max(0, Math.min(extent.width, point.x)),
          y: Math.max(0, Math.min(extent.height, point.y)) };
        state.annotation.lastClientX = event.clientX; state.annotation.lastClientY = event.clientY;
        state.annotation.points = [...state.annotation.points, bounded];
        onDraftChange?.(state.annotation.points);
        return;
      }
      if (onRegion && state.button === 0) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const a = screenToSource(state.camera, size, extent, state.x - bounds.left, state.y - bounds.top);
        const b = screenToSource(state.camera, size, extent, event.clientX - bounds.left, event.clientY - bounds.top);
        setRegionDraft([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]); return;
      }
      if ((onPoint || onResultPoint) && state.button === 0) return;
      setFitted(false); setCamera(boundedCamera({ ...state.camera,
        x: state.camera.x - dx / state.camera.scale,
        y: state.camera.y - dy / (state.camera.scale * extent.aspectY) }, extent, size, insets));
    }} onPointerUp={(event) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      event.preventDefault(); drag.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      if (resultDrawing?.kind === "vertices" && state?.button === 0) return;
      if (state && state.moved && state.button === 0 && onRegion) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const a = screenToSource(state.camera, size, extent, state.x - bounds.left, state.y - bounds.top);
        const b = screenToSource(state.camera, size, extent, event.clientX - bounds.left, event.clientY - bounds.top);
        const x = Math.max(0, Math.floor(Math.min(a.x, b.x))), y = Math.max(0, Math.floor(Math.min(a.y, b.y)));
        const right = Math.min(extent.width, Math.ceil(Math.max(a.x, b.x))), bottom = Math.min(extent.height, Math.ceil(Math.max(a.y, b.y)));
        if (right > x && bottom > y) onRegion({ x, y, width: right - x, height: bottom - y });
        setRegionDraft([]); return;
      }
      if (state.annotation?.mode === "rectangle" && state.button === 0 && state.moved) {
        const point = pointerSourcePoint(event.currentTarget, state.camera, event.clientX, event.clientY);
        const end = { x: Math.max(0, Math.min(extent.width, point.x)),
          y: Math.max(0, Math.min(extent.height, point.y)) };
        if (end.x !== state.annotation.start.x && end.y !== state.annotation.start.y)
          onDraftChange?.([state.annotation.start, end]);
        else onDraftChange?.(state.annotation.previous);
        return;
      }
      if (state.annotation?.mode === "freehand" && state.button === 0) {
        let points = state.annotation.points;
        if (points.length && Math.hypot(event.clientX - state.annotation.lastClientX,
          event.clientY - state.annotation.lastClientY) >= 2.5) {
          if (points.length < freehandPointLimit) {
            const point = pointerSourcePoint(event.currentTarget, state.camera, event.clientX, event.clientY);
            points = [...points, { x: Math.max(0, Math.min(extent.width, point.x)),
              y: Math.max(0, Math.min(extent.height, point.y)) }];
            onDraftChange?.(points);
          } else setDraftLimitReached(true);
        }
        if (points.length >= 3) setDraftClosed(true);
        else onDraftChange?.(state.annotation.previous);
        return;
      }
      if (!state || state.moved || state.button !== 0) return;
      const point = pointerSourcePoint(event.currentTarget, state.camera, event.clientX, event.clientY);
      if (onResultPoint && resultOverlay) {
        const resultPoint = sourcePointToResultPixel(resultOverlay, point);
        if (resultPoint) onResultPoint(resultPoint);
        return;
      }
      if (onObjectClick && drawingMode === "navigate") {
        onObjectClick(point);
      }
      if (!onPoint && !onResultPoint) return;
      if (drawingMode === "polygon" && draft.length >= 3) {
        const start = sourceToScreen(state.camera, size, extent, draft[0].x, draft[0].y);
        const bounds = event.currentTarget.getBoundingClientRect();
        if (Math.hypot(start.x - event.clientX + bounds.left,
          start.y - event.clientY + bounds.top) <= 10) {
          setDraftClosed(true); return;
        }
      }
      if (onPoint && prepared && cache.current.scope === scope && point.x >= 0 && point.y >= 0 && point.x < extent.width && point.y < extent.height) onPoint(point);
    }} onPointerCancel={(event) => cancelPointerInteraction(event.pointerId)}
    onLostPointerCapture={(event) => cancelPointerInteraction(event.pointerId)}
    onDoubleClick={(event) => {
      if (event.target !== canvas.current || drawingMode !== "polygon" || draft.length < 3) return;
      event.preventDefault(); event.stopPropagation();
      const a = sourceToScreen(camera, size, extent, draft.at(-2)!.x, draft.at(-2)!.y);
      const b = sourceToScreen(camera, size, extent, draft.at(-1)!.x, draft.at(-1)!.y);
      const points = Math.hypot(a.x - b.x, a.y - b.y) <= 1 ? draft.slice(0, -1) : draft;
      if (points.length < 3) return;
      if (points.length !== draft.length) onDraftChange?.(points);
      setDraftClosed(true);
    }}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Escape" && draft.length) {
        event.preventDefault(); event.stopPropagation();
        const activePointer = drag.current?.pointerId;
        drag.current = null; setRegionDraft([]);
        if (activePointer !== undefined && event.currentTarget.hasPointerCapture?.(activePointer))
          event.currentTarget.releasePointerCapture?.(activePointer);
        onDraftChange?.([]); setDraftClosed(false);
        setDraftLimitReached(false); return;
      }
      if (event.key === "Enter" && drawingMode === "polygon" && draft.length >= 3) {
        event.preventDefault(); event.stopPropagation(); setDraftClosed(true); return;
      }
      if (["+", "=", "-", "f", "0", "1", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) event.preventDefault();
      if (event.key === "+" || event.key === "=") changeZoom(1.25);
      else if (event.key === "-") changeZoom(0.8);
      else if (event.key === "f" || event.key === "0") { setFitted(true); setCamera(fitCamera(extent, size, insets)); }
      else if (event.key === "1") { setFitted(false); setCamera((old) => ({ ...old, scale: 1 / dpr })); }
      else if (event.key.startsWith("Arrow")) {
        const step = event.shiftKey ? 1 : 80 / camera.scale;
        setFitted(false); setCamera((old) => boundedCamera({ ...old,
          x: old.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
          y: old.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) }, extent, size, insets));
      }
    }}>
    <canvas ref={canvas} aria-label="Source image and bound annotations" />
    {source.locator_state === "relink-required" && <div className="image-view-unavailable" role="status">
      This source needs an exact local copy. Open Portability from tool search to relink it.
    </div>}
    <div className="image-view-tools" aria-label="Image navigation"
      style={toolsPosition ? { left: toolsPosition.x, top: toolsPosition.y, transform: "none" } : undefined}>
      <button aria-label="Move navigation toolbar" title="Drag to move; arrow keys move the toolbar" className="toolbar-handle"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const bounds = event.currentTarget.parentElement!.getBoundingClientRect(), parent = frame.current!.getBoundingClientRect();
          toolsDrag.current = { x: event.clientX, y: event.clientY, left: bounds.left - parent.left, top: bounds.top - parent.top };
        }} onPointerMove={(event) => {
          const start = toolsDrag.current; if (!start) return;
          const width = event.currentTarget.parentElement!.offsetWidth;
          setToolsPosition({ x: Math.max(0, Math.min(size.width - width, start.left + event.clientX - start.x)),
            y: Math.max(0, Math.min(size.height - 42, start.top + event.clientY - start.y)) });
        }} onPointerUp={() => { toolsDrag.current = null; }} onPointerCancel={() => { toolsDrag.current = null; }}
        onKeyDown={(event) => {
          if (!event.key.startsWith("Arrow")) return; event.preventDefault();
          const bounds = event.currentTarget.parentElement!.getBoundingClientRect(), parent = frame.current!.getBoundingClientRect();
          setToolsPosition({ x: Math.max(0, Math.min(size.width - bounds.width, bounds.left - parent.left + (event.key === "ArrowLeft" ? -10 : event.key === "ArrowRight" ? 10 : 0))),
            y: Math.max(0, Math.min(size.height - bounds.height, bounds.top - parent.top + (event.key === "ArrowUp" ? -10 : event.key === "ArrowDown" ? 10 : 0))) });
        }}>⠿</button>
      <button title="Fit the complete image (F)" aria-label="Fit image" onClick={() => { setFitted(true); setCamera(fitCamera(extent, size, insets)); }}><Scan /></button>
      <button title="Reset camera" aria-label="Reset camera" onClick={() => { setFitted(true); setCamera(fitCamera(extent, size, insets)); }}><RotateCcw /></button>
      <button title="One source pixel per display pixel (1)" onClick={() => { setFitted(false); setCamera((old) => ({ ...old, scale: 1 / dpr })); }}>1:1</button>
      <button title="Zoom out (−)" aria-label="Zoom out" onClick={() => changeZoom(0.8)}><Minus /></button>
      <output aria-label="Native pixel zoom" title="100% is one original pixel per physical display pixel">{Math.round(camera.scale * dpr * 100)}%</output>
      <button title="Zoom in (+)" aria-label="Zoom in" onClick={() => changeZoom(1.25)}><Plus /></button>
      <button title="Toggle fullscreen" aria-label="Toggle fullscreen" onClick={() => { void (document.fullscreenElement ? document.exitFullscreen() : frame.current?.requestFullscreen()); }}><Maximize /></button>
    </div>
    {loading && <div className="image-view-loading" role="status">{prepared ? "Refining…" : "Preparing view…"}
      {api.cancelView && <button onClick={() => {
        request.current.generation++; request.current = { scope, queue: [], overview: false, running: false, generation: request.current.generation };
        void api.cancelView!(); setLoading(false);
      }}>Cancel</button>}
    </div>}
    {draftLimitReached && <div className="image-drawing-status" role="status">
      {freehandPointLimit < 3
        ? "Freehand needs at least three available vertices. Remove saved annotations before drawing another region."
        : `Sampling stopped at the ${freehandPointLimit.toLocaleString()}-point limit; the rest of the trace was not captured. Release, then save or clear it.`}
    </div>}
    <div className="image-view-readout">
      <span>{extent.width.toLocaleString()} × {extent.height.toLocaleString()}</span>
      {camera.scale * dpr > 1.01 && <span>Beyond native · nearest pixel</span>}
      {showScaleBar && niceScale && spacingX && spacingUnit && spacingUnit !== "pixel" && <span className="image-scale-bar"><i style={{ width: niceScale / spacingX * camera.scale }} />{Number(niceScale.toPrecision(3)).toLocaleString()} {spacingUnit}</span>}
    </div>
    {showNavigator && prepared && extent.width * extent.height > 4_000_000 && (
      <div
        className="image-navigator-panel image-navigator"
        style={{
          width: navWidth,
          ...(navPosition
            ? { left: navPosition.x, top: navPosition.y, right: "auto", bottom: "auto" }
            : {}),
        }}
      >
        <div
          className="image-navigator-header"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            const panel = event.currentTarget.parentElement!;
            const bounds = panel.getBoundingClientRect();
            const parent = frame.current!.getBoundingClientRect();
            navDrag.current = {
              x: event.clientX,
              y: event.clientY,
              left: bounds.left - parent.left,
              top: bounds.top - parent.top,
            };
          }}
          onPointerMove={(event) => {
            const start = navDrag.current;
            if (!start) return;
            const maxRight = overlayRight > 0 ? size.width - overlayRight : size.width;
            const panelHeight = event.currentTarget.parentElement!.offsetHeight;
            const newX = Math.max(8, Math.min(maxRight - navWidth - 8, start.left + event.clientX - start.x));
            const newY = Math.max(8, Math.min(size.height - panelHeight - 8, start.top + event.clientY - start.y));
            setNavPosition({ x: newX, y: newY });
          }}
          onPointerUp={() => { navDrag.current = null; }}
          onPointerCancel={() => { navDrag.current = null; }}
        >
          <span className="image-navigator-handle" aria-hidden="true">⠿</span>
          <span className="image-navigator-title">Navigator</span>
          <button
            type="button"
            className="image-navigator-reset"
            title="Reset navigator position and size"
            aria-label="Reset navigator position"
            onClick={(e) => {
              e.stopPropagation();
              setNavPosition(null);
              setNavWidth(130);
            }}
          >
            ↺
          </button>
        </div>
        <div
          className="image-navigator-body"
          role="button"
          tabIndex={0}
          aria-label="Overview navigator"
          title="Click to navigate the full image"
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            setFitted(false);
            setCamera((old) => ({
              ...old,
              x: (event.clientX - bounds.left) / bounds.width * extent.width,
              y: (event.clientY - bounds.top) / bounds.height * extent.height,
            }));
          }}
          style={{ aspectRatio: `${extent.width} / ${extent.height * extent.aspectY}` }}
        >
          <img src={cache.current.tiles.get(OVERVIEW_KEY)?.image.src} alt="" />
          <i
            style={{
              left: `${Math.max(0, first.x) / extent.width * 100}%`,
              top: `${Math.max(0, first.y) / extent.height * 100}%`,
              width: `${Math.max(0, Math.min(extent.width, last.x) - Math.max(0, first.x)) / extent.width * 100}%`,
              height: `${Math.max(0, Math.min(extent.height, last.y) - Math.max(0, first.y)) / extent.height * 100}%`,
            }}
          />
        </div>
        <div
          className="image-navigator-resize-handle"
          title="Drag to resize navigator"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            event.stopPropagation();
            navResizeDrag.current = {
              startX: event.clientX,
              startWidth: navWidth,
            };
          }}
          onPointerMove={(event) => {
            const start = navResizeDrag.current;
            if (!start) return;
            const delta = event.clientX - start.startX;
            const maxAllowedWidth = overlayRight > 0 ? Math.min(320, size.width - overlayRight - 32) : 320;
            const nextWidth = Math.max(80, Math.min(maxAllowedWidth, start.startWidth + delta));
            setNavWidth(nextWidth);
          }}
          onPointerUp={() => { navResizeDrag.current = null; }}
          onPointerCancel={() => { navResizeDrag.current = null; }}
        />
      </div>
    )}
  </div>;
}
