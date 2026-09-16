// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextHelp } from "./ContextHelp";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("context help", () => {
  it("suppresses native bubbles and retains one tooltip across SVG children", () => {
    vi.useFakeTimers();
    render(<><button title="Fit the full image" aria-describedby="existing"><svg data-testid="icon"><path data-testid="path" /></svg></button><ContextHelp /></>);
    const button = screen.getByRole("button"), icon = screen.getByTestId("icon"), path = screen.getByTestId("path");
    expect(button).not.toHaveAttribute("title");
    fireEvent.pointerOver(icon);
    act(() => vi.advanceTimersByTime(500));
    const tooltip = screen.getByRole("tooltip");
    expect(button.getAttribute("aria-describedby")).toBe(`existing ${tooltip.id}`);
    fireEvent.pointerOut(icon, { relatedTarget: path });
    fireEvent.pointerOver(path);
    expect(screen.getByRole("tooltip")).toBe(tooltip);
    fireEvent.pointerOut(path, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(80));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).toHaveAttribute("aria-describedby", "existing");
  });

  it("supports keyboard focus and Escape without duplicating help in a status area", () => {
    vi.useFakeTimers();
    render(<><button title="Stable display range">Auto</button><ContextHelp /></>);
    const button = screen.getByRole("button");
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focusIn(button);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Stable display range");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).not.toHaveAttribute("aria-describedby");
  });

  it("clears help after clicking even when the button keeps pointer focus", () => {
    vi.useFakeTimers();
    render(<><button title="Explore the complete raw volume">3D volume</button><ContextHelp /></>);
    const button = screen.getByRole("button");
    fireEvent.pointerOver(button);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.pointerDown(button);
    fireEvent.focusIn(button);
    fireEvent.click(button);
    fireEvent.pointerOut(button, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).not.toHaveAttribute("aria-describedby");
  });

  it("keeps hover help readable over the tooltip and cancels a pending hover on exit", () => {
    vi.useFakeTimers();
    render(<><button title="Secondary explanation">Action</button><ContextHelp /></>);
    const button = screen.getByRole("button");
    fireEvent.pointerOver(button);
    fireEvent.pointerOut(button, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerOver(button);
    act(() => vi.advanceTimersByTime(500));
    const tooltip = screen.getByRole("tooltip");
    fireEvent.pointerOut(button, { relatedTarget: tooltip });
    fireEvent.pointerOver(tooltip);
    act(() => vi.advanceTimersByTime(1000));
    expect(tooltip).toBeVisible();
    fireEvent.pointerOut(tooltip, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(80));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("supports mouse hover events when a host does not dispatch pointer events", () => {
    vi.useFakeTimers();
    render(<><button title="Mouse explanation"><svg data-testid="mouse-icon" /></button><ContextHelp /></>);
    const button = screen.getByRole("button");
    fireEvent.mouseOver(screen.getByTestId("mouse-icon"));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Mouse explanation");
    fireEvent.mouseOut(button, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(80));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

it("dismisses a tip using its visible close control", () => {
  vi.useFakeTimers();
  render(<><button title="Fit explanation">Fit</button><ContextHelp /></>);
  const owner = screen.getByRole("button", { name: "Fit" });
  fireEvent.pointerOver(owner); act(() => vi.advanceTimersByTime(500));
  fireEvent.click(screen.getByRole("button", { name: "Close tip" }));
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(owner).not.toHaveAttribute("aria-describedby");
});
