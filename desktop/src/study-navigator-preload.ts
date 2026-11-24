import { contextBridge, ipcRenderer } from "electron";
import { createStudyNavigatorApi } from "./study-navigator-bridge";

contextBridge.exposeInMainWorld("lociStudyNavigator", createStudyNavigatorApi(ipcRenderer));
