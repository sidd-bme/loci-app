import { contextBridge, ipcRenderer } from "electron";
import { createAgentWorkspaceApi } from "./agent-workspace-preload";

contextBridge.exposeInMainWorld("lociAgentWorkspace", createAgentWorkspaceApi(ipcRenderer));
