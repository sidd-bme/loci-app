import { screen, type BrowserWindow, type Point, type Rectangle } from "electron";

const invalid = () => new Error("Invalid panel placement.");
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
// Keep untrusted input well inside the native coordinate range, including off-display drops.
const isScreenCoordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 1_000_000;

function checkDropPoint(value: unknown): Point {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 2 ||
      !Object.hasOwn(value, "x") || !Object.hasOwn(value, "y") ||
      !isScreenCoordinate(value.x) || !isScreenCoordinate(value.y)) throw invalid();
  return { x: value.x, y: value.y };
}

/** Bind placement to an explicit release or sample the legacy native pointer before any async work. */
export function preparePanelDrop(options: unknown): ((child: BrowserWindow) => void) | undefined {
  if (options === undefined) return;
  if (!isRecord(options) || Reflect.ownKeys(options).some(key => key !== "atPointer" && key !== "dropPoint")) throw invalid();
  const { atPointer, dropPoint } = options;
  const explicit = Object.hasOwn(options, "dropPoint");
  if (atPointer === undefined && !explicit) return;
  if (atPointer !== true || !Object.hasOwn(options, "atPointer")) throw invalid();

  const released = explicit ? checkDropPoint(dropPoint) : undefined;
  let pointer: Point;
  try { pointer = released ?? screen.getCursorScreenPoint(); }
  catch { return; }
  if (!Number.isFinite(pointer?.x) || !Number.isFinite(pointer?.y)) return;
  return child => {
    // Resolve the receiving display just before use, in case one was disconnected while opening.
    let workArea: Rectangle;
    try { ({ workArea } = screen.getDisplayNearestPoint(pointer)); }
    catch { return; }
    if (!workArea || ![workArea.x, workArea.y, workArea.width, workArea.height].every(Number.isFinite) ||
        workArea.width <= 0 || workArea.height <= 0) return;
    const bounds = child.getBounds();
    const width = Math.min(bounds.width, workArea.width), height = Math.min(bounds.height, workArea.height);
    const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, pointer.x - Math.min(96, Math.round(width / 2))));
    const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, pointer.y - 18));
    try { child.setBounds({ x, y, width, height }); }
    catch { /* Platforms that reject programmatic positioning retain the normal window placement. */ }
  };
}
