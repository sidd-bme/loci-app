import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const screen = vi.hoisted(() => ({ getCursorScreenPoint: vi.fn(), getDisplayNearestPoint: vi.fn() }));
vi.mock("electron", () => ({ screen }));
import { preparePanelDrop } from "./panel-drop-position";

const workArea = { x: -1440, y: -980, width: 1440, height: 900 };
const pointer = { x: -640, y: -700 };
const legacyOptions = { atPointer: true } as const;
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
  preparePanelDrop(legacyOptions)?.(window);
  expect(screen.getDisplayNearestPoint).toHaveBeenCalledExactlyOnceWith(pointer);
  expect(setBounds).toHaveBeenCalledExactlyOnceWith({ x: -736, y: -720, width: 368, height: 640 });
});

it("captures the pointer before a native async open and clamps both axes to that display's work area", () => {
  const { window, setBounds } = panel(800, 700);
  const place = preparePanelDrop(legacyOptions)!;
  screen.getCursorScreenPoint.mockReturnValue({ x: 150, y: 35 });
  place(window);
  expect(screen.getCursorScreenPoint).toHaveBeenCalledOnce();
  expect(setBounds).toHaveBeenCalledExactlyOnceWith({ x: -800, y: -780, width: 800, height: 700 });
});

it("shrinks a child larger than the receiving work area", () => {
  const { window, setBounds } = panel(1800, 1200);
  preparePanelDrop(legacyOptions)?.(window);
  expect(setBounds).toHaveBeenCalledExactlyOnceWith(workArea);
});

it("copies the explicit release and clamps off-display coordinates without sampling the OS cursor", () => {
  const { window, setBounds } = panel(368, 640);
  const dropPoint = { x: -1600, y: -1070 };
  const place = preparePanelDrop({ atPointer: true, dropPoint })!;
  dropPoint.x = pointer.x;
  dropPoint.y = pointer.y;
  place(window);
  expect(screen.getCursorScreenPoint).not.toHaveBeenCalled();
  expect(screen.getDisplayNearestPoint).toHaveBeenCalledExactlyOnceWith({ x: -1600, y: -1070 });
  expect(setBounds).toHaveBeenCalledExactlyOnceWith({ x: -1440, y: -980, width: 368, height: 640 });
});

it("parses only the supported placement shapes and bounds coordinates before calling Electron", () => {
  expect(preparePanelDrop(undefined)).toBeUndefined();
  expect(preparePanelDrop({})).toBeUndefined();
  expect(preparePanelDrop({ atPointer: undefined })).toBeUndefined();
  for (const options of [
    { atPointer: false }, { atPointer: "true" }, { atPointer: true, x: 21 }, { windowId: 4 }, null, [],
    new Date(0), Object.create({ atPointer: true }),
    { dropPoint: { x: 20, y: 5 } }, { atPointer: true, dropPoint: undefined }, { atPointer: true, dropPoint: null },
    { atPointer: true, dropPoint: [20, 5] }, { atPointer: true, dropPoint: { x: 20 } },
    { atPointer: true, dropPoint: { x: 20, y: 5, windowId: 4 } },
    ...[Infinity, NaN, 1.5, "3", 1_000_001].map(x => ({ atPointer: true, dropPoint: { x, y: 0 } })),
  ]) {
    expect(() => preparePanelDrop(options)).toThrow("Invalid panel placement");
  }
  expect(screen.getCursorScreenPoint).not.toHaveBeenCalled();
  expect(screen.getDisplayNearestPoint).not.toHaveBeenCalled();
});

it("uses the available monitor at time of placement and leaves preferred bounds if position data is missing", () => {
  const { window, setBounds } = panel(368, 640);
  screen.getCursorScreenPoint.mockImplementationOnce(() => { throw new Error("No cursor position"); });
  preparePanelDrop(legacyOptions)?.(window);
  expect(setBounds).not.toHaveBeenCalled();
  const place = preparePanelDrop(legacyOptions)!;
  screen.getDisplayNearestPoint.mockReturnValueOnce({ workArea: null });
  place(window);
  expect(setBounds).not.toHaveBeenCalled();
  screen.getDisplayNearestPoint.mockReturnValue({ workArea: { x: 0, y: 0, width: 1200, height: 900 } });
  place(window);
  expect(setBounds).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0, width: 368, height: 640 });
});
