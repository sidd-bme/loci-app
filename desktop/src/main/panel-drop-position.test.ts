import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const screen = vi.hoisted(() => ({ getCursorScreenPoint: vi.fn(), getDisplayNearestPoint: vi.fn() }));
vi.mock("electron", () => ({ screen }));
import { capturePanelDropPosition, placePanelAtPointer, wantsPanelAtPointer } from "./panel-drop-position";

const workArea = { x: -1440, y: -980, width: 1440, height: 900 };
const pointer = { x: -640, y: -700 };
beforeEach(() => {
  screen.getCursorScreenPoint.mockReset().mockReturnValue(pointer);
  screen.getDisplayNearestPoint.mockReset().mockReturnValue({ workArea });
});

function panel(width: number, height: number) {
  const setBounds = vi.fn();
  const window = { getBounds: () => ({ x: 20, y: 30, width, height }), setBounds } as unknown as BrowserWindow;
  return { window, setBounds };
}

it("anchors the preferred size at the OS cursor on a negative-origin display", () => {
  const { window, setBounds } = panel(368, 640);
  placePanelAtPointer(window);
  expect(screen.getDisplayNearestPoint).toHaveBeenCalledExactlyOnceWith(pointer);
  expect(setBounds).toHaveBeenCalledExactlyOnceWith({ x: -736, y: -720, width: 368, height: 640 });
});

it("captures the pointer before a native async open and clamps both axes to that display's work area", () => {
  const { window, setBounds } = panel(800, 700);
  const place = capturePanelDropPosition();
  screen.getCursorScreenPoint.mockReturnValue({ x: 150, y: 35 });
  place(window);
  expect(screen.getCursorScreenPoint).toHaveBeenCalledOnce();
  expect(setBounds).toHaveBeenCalledExactlyOnceWith({ x: -800, y: -780, width: 800, height: 700 });
});

it("shrinks a child larger than the receiving work area and ignores ordinary opens", () => {
  const { window, setBounds } = panel(1800, 1200);
  placePanelAtPointer(window);
  expect(setBounds).toHaveBeenCalledExactlyOnceWith(workArea);
  expect(wantsPanelAtPointer(undefined)).toBe(false);
  expect(wantsPanelAtPointer({})).toBe(false);
  expect(wantsPanelAtPointer({ atPointer: true })).toBe(true);
  for (const invalid of [{ atPointer: false }, { atPointer: "true" }, { atPointer: true, x: 21 }, { windowId: 4 }, null]) {
    expect(() => wantsPanelAtPointer(invalid)).toThrow("Invalid panel placement");
  }
});

it("uses the available monitor at time of placement and leaves preferred bounds if position data is missing", () => {
  const { window, setBounds } = panel(368, 640);
  screen.getCursorScreenPoint.mockImplementationOnce(() => { throw new Error("No cursor position"); });
  placePanelAtPointer(window);
  expect(setBounds).not.toHaveBeenCalled();
  const place = capturePanelDropPosition();
  screen.getDisplayNearestPoint.mockReturnValueOnce({ workArea: null });
  place(window);
  expect(setBounds).not.toHaveBeenCalled();
  screen.getDisplayNearestPoint.mockReturnValue({ workArea: { x: 0, y: 0, width: 1200, height: 900 } });
  place(window);
  expect(setBounds).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0, width: 368, height: 640 });
});
