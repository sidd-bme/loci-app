import { contextBridge, ipcRenderer } from "electron";
import type { SettingsWindowApi, SettingsWindowNavigation } from "./shared/settings-window-api";

const settings: SettingsWindowApi = {
  getNavigation: () => ipcRenderer.invoke("loci-settings:navigation"),
  onNavigate(callback) {
    const listener = (_event: Electron.IpcRendererEvent, route: SettingsWindowNavigation) => callback(route);
    ipcRenderer.on("loci-settings:navigate", listener);
    return () => { ipcRenderer.removeListener("loci-settings:navigate", listener); };
  },
  close: () => ipcRenderer.invoke("loci-settings:close"),
  requestQuit: () => ipcRenderer.invoke("loci-settings:quit"),
  computeTargets: (operation, request) => ipcRenderer.invoke("loci-settings:compute-targets", operation, request),
};
contextBridge.exposeInMainWorld("lociSettings", settings);
