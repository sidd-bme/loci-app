// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ResearchSource } from "../shared/research-contracts";
import { SourceTree } from "./SourceTree";

afterEach(cleanup);
const image = (id: string, path?: string): ResearchSource => ({ id, name: `${id}.tif`, sha256: id.repeat(64), metadata: {},
  ...(path ? { browser_location: { relative_path: path, root: null } } : {}) });
const sources = [image("first", "FBS/first.tif"), image("second", "FBS/second.tif"), image("third", "SFM/third.tif")];
function setup(items = sources, active = items[0].id) {
  const onActivate = vi.fn(), onReorder = vi.fn(), onToggleSelection = vi.fn();
  const props = { sources: items, activeSourceId: active, selectedSourceIds: [active], onActivate, onReorder,
    onToggleSelection, reorderDisabled: false, dimensions: () => ({ c: 1, z: 1 }) };
  return { ...render(<SourceTree {...props} />), props, onActivate, onReorder };
}

it("renders compact folder controls, counts and exact source identity with full path tooltips", () => {
  const { container } = setup();
  expect(screen.getByRole("button", { name: "Folder tree" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("tree", { name: "Study images" })).toHaveAttribute("aria-multiselectable", "true");
  const folder = screen.getByRole("treeitem", { name: "FBS" });
  expect(folder).toHaveAttribute("aria-description", "2 images");
  const ownedGroup = document.getElementById(folder.getAttribute("aria-owns")!);
  expect(ownedGroup).toHaveAttribute("role", "group");
  expect(ownedGroup!.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
  const leaf = container.querySelector('button[data-source-id="first"]')!;
  expect(leaf).toHaveClass("research-source-item", "selected");
  expect(leaf).toHaveAttribute("aria-current", "true");
  expect(leaf).toHaveAttribute("title", "FBS/first.tif");
  fireEvent.click(folder);
  expect(screen.queryByRole("treeitem", { name: "first.tif" })).not.toBeInTheDocument();
  expect(onTreeImageCount(folder)).toBe("2");
  expect(folder).not.toHaveAttribute("aria-owns");
  expect(ownedGroup).not.toBeInTheDocument();
});
function onTreeImageCount(element: HTMLElement) { return element.querySelector(".source-browser__count")?.textContent; }

it("filters by folder and filename, retains ancestors and reveals the active source without activating another image", () => {
  const { onActivate } = setup();
  const search = screen.getByRole("searchbox", { name: "Search images and folders" });
  fireEvent.change(search, { target: { value: "THIRD" } });
  expect(screen.getByRole("treeitem", { name: "SFM" })).toBeVisible();
  expect(screen.getByRole("treeitem", { name: "third.tif" })).toBeVisible();
  expect(screen.queryByRole("treeitem", { name: "FBS" })).not.toBeInTheDocument();
  expect(onActivate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reveal current image" }));
  expect(search).toHaveValue("");
  expect(screen.getByRole("treeitem", { name: "first.tif" })).toHaveAttribute("aria-current", "true");
  fireEvent.change(search, { target: { value: "FBS" } });
  expect(within(screen.getByRole("tree")).getAllByRole("treeitem")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Clear image search" }));
  expect(search).toHaveValue("");
});

it("navigates tree focus with arrows, Home/End and typeahead without loading images", () => {
  const { onActivate, props } = setup();
  const first = screen.getByRole("treeitem", { name: "first.tif" }); first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(screen.getByRole("treeitem", { name: "second.tif" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  const folder = screen.getByRole("treeitem", { name: "FBS" }); expect(folder).toHaveFocus();
  fireEvent.keyDown(folder, { key: "ArrowLeft" }); expect(folder).toHaveAttribute("aria-expanded", "false");
  fireEvent.keyDown(folder, { key: "ArrowRight" }); expect(folder).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(folder, { key: "ArrowRight" }); expect(screen.getByRole("treeitem", { name: "first.tif" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" }); expect(folder).toHaveFocus();
  fireEvent.keyDown(folder, { key: "End" }); expect(screen.getByRole("treeitem", { name: "third.tif" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "f" }); expect(folder).toHaveFocus();
  expect(onActivate).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("treeitem", { name: "first.tif" }), { key: " " });
  expect(props.onToggleSelection).toHaveBeenCalledWith(sources[0]);
  expect(onActivate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("treeitem", { name: "first.tif" }), { metaKey: true });
  expect(onActivate).toHaveBeenCalledWith(sources[0], expect.objectContaining({ metaKey: true }), sources.map(source => source.id));
});

it("reveals an externally activated hidden source after expansion commits and does not reopen a later manual collapse", () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const { props, rerender } = setup();
  fireEvent.click(screen.getByRole("treeitem", { name: "SFM" }));
  expect(screen.queryByRole("treeitem", { name: "third.tif" })).not.toBeInTheDocument();
  scroll.mockClear();
  rerender(<SourceTree {...props} activeSourceId="third" />);
  expect(screen.getByRole("treeitem", { name: "third.tif" })).toHaveAttribute("aria-current", "true");
  expect(scroll).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("treeitem", { name: "SFM" }));
  rerender(<SourceTree {...props} activeSourceId="third" selectedSourceIds={["third"]} />);
  expect(screen.queryByRole("treeitem", { name: "third.tif" })).not.toBeInTheDocument();
  expect(scroll).toHaveBeenCalledOnce();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("retains flat ordering and disables reordering while any search filter is active", () => {
  const { onReorder } = setup([image("first"), image("second"), image("third")]);
  const first = screen.getByRole("button", { name: /first.tif/ });
  fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
  expect(onReorder.mock.calls[0][0].map((source: ResearchSource) => source.id)).toEqual(["second", "first", "third"]);
  onReorder.mockClear();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "first" } });
  fireEvent.keyDown(screen.getByRole("button", { name: /first.tif/ }), { key: "ArrowDown", altKey: true });
  fireEvent.pointerDown(screen.getByRole("button", { name: /first.tif/ }), { button: 0, clientX: 10, clientY: 10 });
  fireEvent(window, new MouseEvent("pointermove", { clientX: 10, clientY: 90 }));
  fireEvent(window, new MouseEvent("pointerup", { clientX: 10, clientY: 90 }));
  expect(onReorder).not.toHaveBeenCalled();
});

it("aborts pointer cancellation and view changes without persisting a reorder or leaving drag styles", () => {
  const { container, onReorder } = setup([image("first"), image("second"), image("third")]);
  const rows = [...container.querySelectorAll<HTMLButtonElement>("button[data-source-id]")];
  rows.forEach((row, index) => { row.getBoundingClientRect = () => ({ top: index * 32, bottom: index * 32 + 30,
    left: 0, right: 200, width: 200, height: 30, x: 0, y: index * 32, toJSON: () => ({}) }); });
  const drag = () => {
    fireEvent.pointerDown(rows[0], { button: 0, clientX: 10, clientY: 15 });
    fireEvent(window, new MouseEvent("pointermove", { clientX: 10, clientY: 40 }));
    fireEvent(window, new MouseEvent("pointermove", { clientX: 10, clientY: 90 }));
    expect(rows[0]).toHaveClass("is-ghost");
  };
  drag(); fireEvent(window, new MouseEvent("pointercancel"));
  expect(rows[0]).not.toHaveClass("is-ghost"); expect(onReorder).not.toHaveBeenCalled();
  expect(document.body.style.cursor).toBe(""); expect(document.body.style.userSelect).toBe("");
  drag(); fireEvent.click(screen.getByRole("button", { name: "Folder tree" }));
  fireEvent(window, new MouseEvent("pointerup", { clientY: 90 }));
  expect(onReorder).not.toHaveBeenCalled(); expect(document.body.style.cursor).toBe("");
});
