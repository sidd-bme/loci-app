import { contextBridge, ipcRenderer } from "electron";
import { createDisplayInspectorApi } from "./display-inspector-bridge";

contextBridge.exposeInMainWorld("lociDisplayInspector", createDisplayInspectorApi(ipcRenderer));
