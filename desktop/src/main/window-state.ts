import { BrowserWindow, app, screen } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface PersistedWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
  fullscreen?: boolean;
}

export const DEFAULT_WINDOW_STATE: PersistedWindowState = {
  width: 1440,
  height: 900,
};

const statePath = () => path.join(app.getPath("userData"), "window-state.json");

function intersectsDisplay(state: PersistedWindowState): boolean {
  if (state.x === undefined || state.y === undefined) return true;
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapWidth = Math.max(
      0,
      Math.min(state.x! + state.width, workArea.x + workArea.width) - Math.max(state.x!, workArea.x),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(state.y! + state.height, workArea.y + workArea.height) - Math.max(state.y!, workArea.y),
    );
    return overlapWidth >= 160 && overlapHeight >= 120;
  });
}

export async function readWindowState(): Promise<PersistedWindowState> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(), "utf8")) as PersistedWindowState;
    if (
      !Number.isFinite(parsed.width) ||
      !Number.isFinite(parsed.height) ||
      parsed.width < 1024 ||
      parsed.height < 720 ||
      !intersectsDisplay(parsed)
    ) {
      return DEFAULT_WINDOW_STATE;
    }
    return parsed;
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
}

async function writeWindowState(state: PersistedWindowState): Promise<void> {
  const destination = statePath();
  const temporary = `${destination}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(state), "utf8");
  await fs.rename(temporary, destination);
}

export function trackWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const persist = () => {
    if (window.isDestroyed()) return;
    const bounds = window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds();
    void writeWindowState({
      ...bounds,
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
    }).catch((error) => console.error("Could not save Loci window state", error));
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 250);
  };

  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);
  window.on("enter-full-screen", schedule);
  window.on("leave-full-screen", schedule);
  window.on("close", persist);
}
