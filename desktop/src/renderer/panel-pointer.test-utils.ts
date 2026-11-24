import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

export function installPanelPointerCapture(element: HTMLElement) {
  const pointers = new Set<number>();
  const capture = vi.fn((id: number) => { pointers.add(id); });
  const release = vi.fn((id: number) => { pointers.delete(id); });
  Object.assign(element, { setPointerCapture: capture, releasePointerCapture: release,
    hasPointerCapture: (id: number) => pointers.has(id) });
  return { capture, release };
}

export function panelPointer(target: EventTarget, type: string, options: MouseEventInit & { pointerId?: number; isPrimary?: boolean } = {}) {
  const { pointerId = 7, isPrimary = true, ...mouse } = options;
  return fireEvent(target as Element, Object.assign(new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: 80, clientY: 60, button: 0,
    buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0,
    ...mouse,
  }), { pointerId, isPrimary }));
}

export function dropPanelOutside(grip: HTMLElement) {
  installPanelPointerCapture(grip);
  panelPointer(grip, "pointerdown");
  panelPointer(window, "pointermove", { clientX: -20 });
  panelPointer(window, "pointerup", { clientX: -20 });
}
