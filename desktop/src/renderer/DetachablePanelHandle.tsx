import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from "react";
import type { PanelDropPoint } from "../shared/panel-open-options";
import "./DetachablePanelHandle.css";

const dragSlop = 8;
const interactive = [
  "button", "a", "input", "select", "textarea", "label", "summary", "canvas", "[tabindex]",
  "[contenteditable]", "[draggable='true']", "[data-panel-drag-ignore]",
  "[role='button']", "[role='tab']", "[role='slider']", "[role='separator']",
  "[role='checkbox']", "[role='switch']", "[role='combobox']", "[role='listbox']",
].join(",");

type PanelHandleProps = {
  label: string;
  onDetach: () => void;
  onDropOutside: (point: PanelDropPoint) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  iconOnly?: boolean;
  grabArea?: RefObject<HTMLElement | null>;
  ref?: Ref<HTMLButtonElement>;
};

type DragState = "inside" | "outside";
const inContent = ({ clientX, clientY }: PointerEvent) =>
  clientX >= 0 && clientX < window.innerWidth && clientY >= 0 && clientY < window.innerHeight;

/** A click or keyboard action opens normally. A captured drag commits on an outside release. */
export function DetachablePanelHandle({ label, onDetach, onDropOutside, disabled, className, title,
  iconOnly, grabArea, ref }: PanelHandleProps) {
  const button = useRef<HTMLButtonElement>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const drop = useRef(onDropOutside);
  const [dragState, setDragState] = useState<DragState | null>(null);
  useImperativeHandle(ref, () => button.current!, []);
  useLayoutEffect(() => {
    drop.current = onDropOutside;
    if (disabled) cancelDrag.current?.();
  }, [onDropOutside, disabled]);

  const start = useCallback((event: PointerEvent, origin: HTMLElement) => {
    if (event.defaultPrevented || !event.isPrimary || event.button !== 0 || cancelDrag.current) return;
    suppressClick.current = false;
    const { clientX: startX, clientY: startY, pointerId } = event;
    try { origin.setPointerCapture(pointerId); }
    catch { return; }
    let moved = false;
    let state: DragState | null = null;
    const crossesSlop = (next: PointerEvent) => Math.hypot(next.clientX - startX, next.clientY - startY) >= dragSlop;

    const finish = (consumeClick: boolean) => {
      cancelDrag.current = null;
      suppressClick.current = consumeClick;
      setDragState(null);
      origin.removeAttribute("data-panel-grab-state");
      events.abort();
      if (origin.hasPointerCapture(pointerId)) origin.releasePointerCapture(pointerId);
    };
    const cancel = () => finish(true);
    const events = new AbortController();
    const listeners = { capture: true, signal: events.signal };
    cancelDrag.current = cancel;
    window.addEventListener("pointerdown", next => {
      if (next.pointerId === pointerId) cancel();
    }, listeners);
    window.addEventListener("pointermove", next => {
      // macOS can deliver a zero-button move just before the matching outside release.
      if (next.pointerId !== pointerId || !(next.buttons & 1)) return;
      moved ||= crossesSlop(next);
      if (!moved) return;
      const nextState = inContent(next) ? "inside" : "outside";
      if (state !== nextState) {
        state = nextState;
        origin.dataset.panelGrabState = state;
        setDragState(state);
      }
    }, listeners);
    window.addEventListener("pointerup", end => {
      if (end.pointerId !== pointerId) return;
      moved ||= crossesSlop(end);
      const outside = !inContent(end);
      const hit = origin.getBoundingClientRect();
      const insideOrigin = end.clientX >= hit.left && end.clientX < hit.right && end.clientY >= hit.top && end.clientY < hit.bottom;
      const shouldDrop = moved && outside && end.button === 0;
      finish(moved || outside || !insideOrigin || end.button !== 0);
      if (shouldDrop) drop.current({ x: Math.round(end.screenX), y: Math.round(end.screenY) });
    }, listeners);
    for (const type of ["pointercancel", "lostpointercapture"] as const) {
      window.addEventListener(type, next => { if (next.pointerId === pointerId) cancel(); }, listeners);
    }
    window.addEventListener("keydown", key => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopImmediatePropagation();
      cancel();
    }, listeners);
    window.addEventListener("blur", cancel, { signal: events.signal });
  }, []);
  useLayoutEffect(() => () => cancelDrag.current?.(), []);
  useEffect(() => {
    const header = grabArea?.current;
    if (!header || disabled) return;
    // The existing header may contain ordinary controls. Only its passive surface can grab the panel.
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest(interactive);
      if (control && header.contains(control)) return;
      start(event, header);
    };
    header.classList.add("detachable-panel-grab-area");
    header.addEventListener("pointerdown", handlePointerDown);
    return () => {
      header.removeEventListener("pointerdown", handlePointerDown);
      header.classList.remove("detachable-panel-grab-area");
    };
  }, [disabled, grabArea, start]);

  return <button ref={button} type="button" className={`detachable-panel-handle${className ? ` ${className}` : ""}`}
    disabled={disabled} aria-label={label} title={title ?? "Drag outside the window or click to detach"}
    data-drag-state={dragState ?? undefined}
    onPointerDown={event => { if (!disabled) start(event.nativeEvent, event.currentTarget); }}
    onClick={event => {
      if (cancelDrag.current || (event.detail > 0 && suppressClick.current)) {
        event.preventDefault();
        return;
      }
      onDetach();
    }}>
    <GripVertical aria-hidden="true" size={15} />
    {!iconOnly && <span>{label}</span>}
  </button>;
}
