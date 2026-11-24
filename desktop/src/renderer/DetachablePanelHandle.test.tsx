// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DetachablePanelHandle } from "./DetachablePanelHandle";
import { installPanelPointerCapture, panelPointer } from "./panel-pointer.test-utils";

afterEach(cleanup);

function mount(disabled = false) {
  const onDetach = vi.fn(), onDropOutside = vi.fn();
  const content = (disable: boolean) => <DetachablePanelHandle
    label="Detach Display" onDetach={onDetach} onDropOutside={onDropOutside} disabled={disable} />;
  const view = render(content(disabled));
  const grip = screen.getByRole("button", { name: "Detach Display" });
  const capture = installPanelPointerCapture(grip);
  vi.spyOn(grip, "getBoundingClientRect").mockReturnValue({ left: 60, right: 140, top: 50, bottom: 84 } as DOMRect);
  return { grip, onDetach, onDropOutside, capture, view, content };
}

it("keeps ordinary activation and commits a captured drag exactly once on outside release", () => {
  const { grip, onDetach, onDropOutside, capture } = mount();
  grip.focus();
  expect(grip).toHaveFocus();
  fireEvent.click(grip, { detail: 0 }); // Native button keyboard activation emits click without a pointer count.
  panelPointer(grip, "pointerdown");
  panelPointer(window, "pointerup");
  fireEvent.click(grip, { detail: 1 });
  expect(onDetach).toHaveBeenCalledTimes(2);

  panelPointer(grip, "pointerdown");
  expect(capture.capture).toHaveBeenLastCalledWith(7);
  panelPointer(window, "pointermove", { clientX: 120 });
  expect(grip).toHaveAttribute("data-drag-state", "inside");
  // A focused input may blur when the pointer first focuses the button.
  fireEvent.blur(grip);
  panelPointer(window, "pointermove", { clientX: -25 });
  expect(grip).toHaveAttribute("data-drag-state", "outside");
  expect(onDropOutside).not.toHaveBeenCalled();
  panelPointer(window, "pointerup", { pointerId: 99, clientX: -25 });
  expect(onDropOutside).not.toHaveBeenCalled();
  panelPointer(window, "pointerup", { clientX: -25 });
  fireEvent.click(grip, { detail: 1 });
  expect(onDropOutside).toHaveBeenCalledOnce();
  expect(onDetach).toHaveBeenCalledTimes(2);
  expect(capture.release).toHaveBeenLastCalledWith(7);
  expect(grip).not.toHaveAttribute("data-drag-state");
  fireEvent.click(grip, { detail: 0 });
  expect(onDetach).toHaveBeenCalledTimes(3);
});

it("uses the release when macOS sends a zero-button move across the window edge", () => {
  const { grip, onDetach, onDropOutside } = mount();
  panelPointer(grip, "pointerdown", { clientX: 126, clientY: 65 });
  panelPointer(grip, "pointermove", { clientX: -32, clientY: 65, buttons: 0, button: -1 });
  expect(onDropOutside).not.toHaveBeenCalled();
  panelPointer(document.documentElement, "pointerup", { clientX: -32, clientY: 65, screenX: 168, screenY: 232 });
  fireEvent.click(grip, { detail: 1 });
  expect(onDropOutside).toHaveBeenCalledExactlyOnceWith({ x: 168, y: 232 });
  expect(onDetach).not.toHaveBeenCalled();
});

it("discards an unfinished grab when the same pointer starts a new press", () => {
  const { grip, onDropOutside } = mount();
  panelPointer(grip, "pointerdown");
  panelPointer(window, "pointermove", { clientX: -32, buttons: 0, button: -1 });
  panelPointer(document.body, "pointerdown", { clientX: 240 });
  panelPointer(document.body, "pointerup", { clientX: -32 });
  expect(onDropOutside).not.toHaveBeenCalled();
  panelPointer(grip, "pointerdown");
  panelPointer(window, "pointerup", { clientX: -20 });
  expect(onDropOutside).toHaveBeenCalledOnce();
});

it("ignores a short edge crossing, re-entry, secondary buttons and non-primary pointers", () => {
  const { grip, onDetach, onDropOutside } = mount();
  panelPointer(grip, "pointerdown", { clientX: 3 });
  panelPointer(window, "pointerup", { clientX: -2 });
  fireEvent.click(grip, { detail: 1 });
  panelPointer(grip, "pointerdown");
  panelPointer(window, "pointermove", { clientX: -20 });
  panelPointer(window, "pointermove", { clientX: 80 });
  expect(grip).toHaveAttribute("data-drag-state", "inside");
  panelPointer(window, "pointerup");
  fireEvent.click(grip, { detail: 1 });
  for (const options of [{ button: 2, buttons: 2 }, { isPrimary: false }]) {
    panelPointer(grip, "pointerdown", options);
    panelPointer(window, "pointermove", { clientY: -40 });
    panelPointer(window, "pointerup", { clientY: -40 });
  }
  expect(onDropOutside).not.toHaveBeenCalled();
  expect(onDetach).not.toHaveBeenCalled();
});

it.each(["Escape", "pointercancel", "lostpointercapture", "blur", "disable", "unmount"])(
  "cancels the held gesture on %s", (reason) => {
    const { grip, onDetach, onDropOutside, capture, view, content } = mount();
    panelPointer(grip, "pointerdown");
    panelPointer(window, "pointermove", { clientX: -20 });
    if (reason === "Escape") expect(fireEvent.keyDown(grip, { key: "Escape" })).toBe(false);
    else if (reason === "blur") fireEvent.blur(window);
    else if (reason === "disable") view.rerender(content(true));
    else if (reason === "unmount") view.unmount();
    else panelPointer(grip, reason);
    panelPointer(window, "pointerup", { clientX: -20 });
    fireEvent.click(grip, { detail: 1 });
    expect(onDropOutside).not.toHaveBeenCalled();
    expect(onDetach).not.toHaveBeenCalled();
    expect(capture.release).toHaveBeenCalledExactlyOnceWith(7);
    if (reason === "unmount") expect(grip).not.toBeInTheDocument();
    else expect(grip).not.toHaveAttribute("data-drag-state");
  },
);

it("grabs a passive header without intercepting its controls", () => {
  const onDetach = vi.fn(), onDropOutside = vi.fn(), onOther = vi.fn();
  function Panel() {
    const header = useRef<HTMLElement>(null);
    return <header ref={header}>
      <h2>Display</h2><button onClick={onOther}><span>Tab</span></button><input type="range" />
      <DetachablePanelHandle label="Detach Display" onDetach={onDetach} onDropOutside={onDropOutside} grabArea={header} />
    </header>;
  }
  render(<Panel />);
  const header = screen.getByRole("banner");
  const { capture } = installPanelPointerCapture(header);
  for (const control of [screen.getByText("Tab"), screen.getByRole("slider")]) {
    panelPointer(control, "pointerdown");
    panelPointer(window, "pointermove", { clientX: -20 });
    panelPointer(window, "pointerup", { clientX: -20 });
  }
  expect(capture).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Tab"));
  expect(onOther).toHaveBeenCalledOnce();
  panelPointer(screen.getByRole("heading"), "pointerdown");
  panelPointer(window, "pointermove", { clientY: window.innerHeight + 25 });
  panelPointer(window, "pointerup", { clientY: window.innerHeight + 25 });
  expect(capture).toHaveBeenCalledExactlyOnceWith(7);
  expect(onDropOutside).toHaveBeenCalledOnce();
  expect(onDetach).not.toHaveBeenCalled();
});
