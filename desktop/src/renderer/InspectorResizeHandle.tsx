import { useEffect, useRef, useState } from "react";

const KEY = "loci.inspector-width.v1";
const MIN = 280;
const MAX = 560;
export function loadInspectorWidth(): number {
  try {
    const width = Number(localStorage.getItem(KEY));
    if (Number.isFinite(width) && width >= MIN && width <= MAX) return width;
  } catch { /* The current session still supports resizing without storage. */ }
  return 304;
}

export function InspectorResizeHandle({ width, onChange }: {
  width: number; onChange: (width: number) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const drag = useRef<{ x: number; width: number; current: number } | null>(null);
  const change = useRef(onChange); change.current = onChange;
  const bounded = (value: number) => Math.max(MIN, Math.min(MAX, window.innerWidth * .45, value));
  const save = (value: number) => { try { localStorage.setItem(KEY, String(value)); } catch { /* Optional UI preference. */ } };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      drag.current.current = bounded(drag.current.width + drag.current.x - event.clientX);
      change.current(drag.current.current);
    };
    const finish = () => { if (drag.current) save(drag.current.current); drag.current = null; setIsDragging(false); };
    const cancel = () => { if (drag.current) change.current(drag.current.width); drag.current = null; setIsDragging(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return <div role="separator" tabIndex={0} aria-label="Resize tools panel" aria-orientation="vertical"
    aria-valuemin={MIN} aria-valuemax={Math.max(MIN, Math.min(MAX, Math.floor(window.innerWidth * .45)))}
    aria-valuenow={Math.round(bounded(width))} className={`inspector-resize-handle ${isDragging ? "is-dragging" : ""}`}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus();
      const actual = event.currentTarget.parentElement?.getBoundingClientRect().width || bounded(width);
      drag.current = { x: event.clientX, width: actual, current: actual };
      setIsDragging(true);
    }}
    onDoubleClick={() => { onChange(304); save(304); }}
    onKeyDown={(event) => {
      const next = event.key === "ArrowLeft" ? bounded(width) + 16 : event.key === "ArrowRight" ? bounded(width) - 16 :
        event.key === "Home" ? MIN : event.key === "End" ? MAX : null;
      if (next === null) return;
      event.preventDefault(); const value = bounded(next); onChange(value); save(value);
    }} />;
}
