import { screen, type BrowserWindow, type Point, type Rectangle } from "electron";

export function wantsPanelAtPointer(options: unknown): boolean {
  if (options === undefined) return false;
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some(key => key !== "atPointer")) throw new Error("Invalid panel placement.");
  const { atPointer } = options as { atPointer?: unknown };
  if (atPointer !== undefined && atPointer !== true) throw new Error("Invalid panel placement.");
  return atPointer === true;
}

/** Capture the native drop position before an asynchronous open can move past it. */
export function capturePanelDropPosition(): (child: BrowserWindow) => void {
  let pointer: Point;
  try { pointer = screen.getCursorScreenPoint(); }
  catch { return () => {}; }
  if (!Number.isFinite(pointer?.x) || !Number.isFinite(pointer?.y)) return () => {};
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

export function placePanelAtPointer(child: BrowserWindow): void {
  capturePanelDropPosition()(child);
}
