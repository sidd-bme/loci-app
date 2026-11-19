import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { SettingsWindowNavigation } from "../shared/settings-window-api";
import { sanitizedWorkerErrorMessage } from "./worker-client";

type WindowEntry = {
  window: BrowserWindow;
  loaded: Promise<void>;
  route: SettingsWindowNavigation;
};

export class SettingsWindowCoordinator {
  private current: WindowEntry | null = null;
  private revision = 0;

  constructor(
    private readonly create: () => { window: BrowserWindow; load: () => Promise<void> },
    private readonly compute: (operation: unknown, request: unknown) => Promise<unknown>,
    private readonly notifyTargetsChanged: () => void,
    private readonly requestQuit: () => void,
  ) {}

  async open(page?: unknown): Promise<void> {
    if (page !== undefined && page !== "appearance" && page !== "compute") throw new Error("Unknown Settings page.");
    let entry = this.current;
    let requestedRoute: SettingsWindowNavigation | null = null;
    if (!entry || entry.window.isDestroyed()) {
      const { window, load } = this.create();
      // Install the route and sender before navigation creates the renderer.
      entry = { window, route: { page: page ?? "appearance", revision: ++this.revision }, loaded: Promise.resolve().then(load) };
      this.current = entry;
      window.once("closed", () => { if (this.current?.window === window) this.current = null; });
    } else if (page !== undefined) {
      entry.route = { page, revision: ++this.revision };
      requestedRoute = entry.route;
    }
    try { await entry.loaded; }
    catch {
      if (this.current === entry) {
        this.current = null;
        if (!entry.window.isDestroyed()) entry.window.destroy();
      }
      throw new Error("The Settings window could not be opened.");
    }
    if (this.current !== entry || entry.window.isDestroyed()) return;
    if (requestedRoute && entry.route === requestedRoute) entry.window.webContents.send("loci-settings:navigate", requestedRoute);
    if (entry.window.isMinimized()) entry.window.restore();
    entry.window.show();
    entry.window.focus();
  }

  registerIpc(): void {
    const handle = (channel: string, operation: (entry: WindowEntry, args: unknown[]) => unknown) => {
      ipcMain.handle("loci-settings:" + channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        const entry = this.current;
        if (!entry || entry.window.isDestroyed() || entry.window.webContents.isDestroyed() ||
            event.sender !== entry.window.webContents || !event.senderFrame ||
            event.senderFrame !== entry.window.webContents.mainFrame) throw new Error("This request requires the active Settings window.");
        try { return await operation(entry, args); }
        catch (error) { throw new Error(sanitizedWorkerErrorMessage(error instanceof Error ? error.message : error)); }
      });
    };
    handle("navigation", (entry) => entry.route);
    handle("close", (entry) => { entry.window.close(); });
    handle("quit", () => { this.requestQuit(); });
    handle("compute-targets", async (_entry, [operation, request]) => {
      if (operation === "use") throw new Error("Apply compute targets from the study workspace.");
      const response = await this.compute(operation, request);
      if (operation !== "list") this.notifyTargetsChanged();
      return response;
    });
  }
}
