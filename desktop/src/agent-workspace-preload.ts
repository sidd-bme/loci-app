import type { IpcRenderer } from "electron";
import type { AgentWorkspaceApi } from "./shared/agent-workspace-api";

/** The detached agent surface has no general study or filesystem API. */
export function createAgentWorkspaceApi(ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): AgentWorkspaceApi {
  const listen = <T,>(channel: string, listener: (value: T) => void): (() => void) => {
    const receive = (_event: unknown, value: T) => listener(value);
    ipc.on(channel, receive);
    return () => { ipc.removeListener(channel, receive); };
  };
  const prefix = "loci-agent-workspace:";
  return {
    state: () => ipc.invoke(prefix + "state"),
    open: (presentation) => ipc.invoke(prefix + "open", presentation),
    focus: () => ipc.invoke(prefix + "focus"),
    restore: () => ipc.invoke(prefix + "restore"),
    dock: (binding) => ipc.invoke(prefix + "dock", binding),
    publish: (binding, state) => ipc.invoke(prefix + "publish", binding, state),
    updatePresentation: (binding, presentation) => ipc.invoke(prefix + "presentation", binding, presentation),
    control: (binding, request) => ipc.invoke(prefix + "control", binding, request),
    navigate: (binding, request) => ipc.invoke(prefix + "navigate", binding, request),
    setFollow: (binding, follow) => ipc.invoke(prefix + "follow", binding, follow),
    complete: (binding, completion) => ipc.invoke(prefix + "complete", binding, completion),
    flushed: (binding, flushId, presentation) => ipc.invoke(prefix + "flushed", binding, flushId, presentation),
    onState: (listener) => listen(prefix + "state-changed", listener),
    onCommand: (listener) => listen(prefix + "command", listener),
    onFlush: (listener) => listen(prefix + "flush", listener),
  };
}
