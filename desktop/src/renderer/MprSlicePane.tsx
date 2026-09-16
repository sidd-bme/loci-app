import { ArrowLeftRight, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { RawVolumeComponent, RawVolumePayload } from "./RawVolumeViewport";
import { dot, planeGrid, planePoint, renderMpr, type MprPlane, type MprScalars, type Vec3 } from "./mpr-reslice";

type Props = {
  payload: RawVolumePayload; values: MprScalars; plane: MprPlane; crosshair: Vec3;
  transfers: RawVolumeComponent[]; expanded: boolean; onExpand: () => void;
  visible?: boolean;
  onCrosshair: (point: Vec3) => void;
  onSwap?: () => void;
};

export function MprSlicePane({ payload, values, plane, crosshair, transfers, expanded, visible = true, onExpand, onCrosshair, onSwap }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const grid = useMemo(() => planeGrid(payload, plane, crosshair), [payload, plane, crosshair]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => { const rect = stage.getBoundingClientRect(); setSize({ width: rect.width, height: rect.height }); };
    const observer = new ResizeObserver(measure); observer.observe(stage); measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visible) return;
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("The slice canvas is unavailable.");
      const pixels = renderMpr(payload, values, plane, grid, transfers);
      canvas.width = grid.width; canvas.height = grid.height;
      const frame = ctx.createImageData(grid.width, grid.height);
      frame.data.set(pixels); ctx.putImageData(frame, 0, 0); setError(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not render this slice."); }
  }, [grid, payload, plane, transfers, values, visible]);
  const horizontal = grid.uMax === grid.uMin ? 0.5 : (dot(crosshair, plane.u) - grid.uMin) / (grid.uMax - grid.uMin);
  const vertical = grid.vMax === grid.vMin ? 0.5 : (dot(crosshair, plane.v) - grid.vMin) / (grid.vMax - grid.vMin);
  // One step moves at least one context voxel even for anisotropic/oblique grids.
  const step = 1 / Math.max(...[0, 1, 2].map((col) => Math.abs(dot(plane.normal,
    payload.direction_3x3.slice(col * 3, col * 3 + 3) as Vec3)) / payload.spacing_xyz[col]));
  const aspect = Math.max(grid.uMax - grid.uMin, Math.min(...payload.spacing_xyz)) / Math.max(grid.vMax - grid.vMin, Math.min(...payload.spacing_xyz));
  const imageHeight = Math.min(size.height, size.width / aspect);
  const move = (delta: number) => onCrosshair(crosshair.map((value, axis) => value + plane.normal[axis] * step * delta) as Vec3);
  const moveRef = useRef(move); moveRef.current = move;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (event.deltaY) moveRef.current(event.deltaY > 0 ? 1 : -1);
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, []);
  const position = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width && rect.height) onCrosshair(planePoint(plane, grid,
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))));
  };
  return <section className={`mpr-pane mpr-pane-${plane.id}`} aria-label={`${plane.label} view`} data-pane={plane.id}>
    <header className="mpr-pane-header"><span className="mpr-plane-mark" /><strong>{plane.label}</strong>
      <span className="mpr-plane-position">{grid.normalPosition.toFixed(2)} {payload.unit}</span>
      {onSwap ? (
        <button
          type="button"
          className="mpr-swap"
          aria-label={`Swap ${plane.label} position`}
          title="Swap with next quadrant"
          onClick={onSwap}
        >
          <ArrowLeftRight size={13} aria-hidden="true" />
        </button>
      ) : null}
      <button type="button" className="mpr-expand" aria-label={`${expanded ? "Restore" : "Expand"} ${plane.label} view`} onClick={onExpand}>
        {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
      </button>
    </header>
    <div className="mpr-slice-stage" ref={stageRef} tabIndex={0} aria-label={`${plane.label} slice navigation`}
      onKeyDown={(event) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) {
        event.preventDefault(); move((["ArrowUp", "PageUp"].includes(event.key) ? 1 : -1) * (event.key.startsWith("Page") ? 5 : 1));
      } }}>
      <div className="mpr-slice-image" style={{ width: imageHeight * aspect, height: imageHeight }}>
        <canvas ref={canvasRef} aria-label={`${plane.label} resliced image`} onPointerDown={(event) => {
          if (event.button !== 0) return;
          stageRef.current?.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture?.(event.pointerId); position(event);
        }} onPointerMove={(event) => { if (event.buttons === 1) position(event); }} />
        <span className="mpr-crosshair-horizontal" style={{ top: `${vertical * 100}%` }} />
        <span className="mpr-crosshair-vertical" style={{ left: `${horizontal * 100}%` }} />
      </div>
      {plane.edges.map((label, index) => <span key={index} className={`mpr-orientation mpr-orientation-${index}`}>{label}</span>)}
      {error ? <p className="mpr-slice-error" role="alert">{error}</p> : null}
    </div>
    <footer className="mpr-pane-footer">Drag crosshair · scroll / ↑↓ to slice <span>Linear · level {payload.level}</span></footer>
  </section>;
}
