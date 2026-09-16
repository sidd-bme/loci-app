// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InspectorResizeHandle, loadInspectorWidth } from "./InspectorResizeHandle";
afterEach(() => { cleanup(); localStorage.clear(); });
it("resizes accessibly within viewport bounds and restores the saved width", () => {
  const onChange = vi.fn();
  render(<InspectorResizeHandle width={304} onChange={onChange} />);
  const handle = screen.getByRole("separator", { name: "Resize tools panel" });
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(onChange).toHaveBeenLastCalledWith(320); expect(loadInspectorWidth()).toBe(320);
  fireEvent.keyDown(handle, { key: "End" });
  expect(onChange.mock.lastCall![0]).toBeLessThanOrEqual(window.innerWidth * .45);
  fireEvent.keyDown(handle, { key: "Home" });
  expect(onChange).toHaveBeenLastCalledWith(280);
  fireEvent.doubleClick(handle); expect(loadInspectorWidth()).toBe(304);
});
it("ignores invalid stored widths", () => {
  localStorage.setItem("loci.inspector-width.v1", "99999"); expect(loadInspectorWidth()).toBe(304);
  localStorage.setItem("loci.inspector-width.v1", "NaN"); expect(loadInspectorWidth()).toBe(304);
});
it("applies is-dragging class while dragging with pointer", () => {
  const onChange = vi.fn();
  render(<InspectorResizeHandle width={304} onChange={onChange} />);
  const handle = screen.getByRole("separator", { name: "Resize tools panel" });
  expect(handle).not.toHaveClass("is-dragging");
  fireEvent.pointerDown(handle, { clientX: 500, button: 0 });
  expect(handle).toHaveClass("is-dragging");
  fireEvent.pointerMove(window, { clientX: 480 });
  expect(handle).toHaveClass("is-dragging");
  fireEvent.pointerUp(window);
  expect(handle).not.toHaveClass("is-dragging");
});

