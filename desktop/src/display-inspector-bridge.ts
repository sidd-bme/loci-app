import type { IpcRenderer } from "electron";
import { DISPLAY_INSPECTOR_IPC as prefix, type DisplayInspectorApi, type DisplayInspectorOwnerApi } from "./shared/display-inspector-api";

type InspectorIpc = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

function subscribe<T>(ipc: InspectorIpc, channel: string, listener: (value: T) => void): () => void {
  const receive = (_event: unknown, value: T) => listener(value);
  ipc.on(prefix + channel, receive);
  return () => { ipc.removeListener(prefix + channel, receive); };
}

export function createDisplayInspectorApi(ipc: InspectorIpc): DisplayInspectorApi {
  return {
    state: () => ipc.invoke(prefix + "state"),
    edit: (binding, action) => ipc.invoke(prefix + "edit", binding, action),
    dock: (binding, interrupted) => interrupted === true
      ? ipc.invoke(prefix + "dock", binding, true)
      : ipc.invoke(prefix + "dock", binding),
    onState: (listener) => subscribe(ipc, "state-changed", listener),
  };
}

export function createDisplayInspectorOwnerApi(ipc: InspectorIpc): DisplayInspectorOwnerApi {
  return {
    open: (target, snapshot, options) => options === undefined
      ? ipc.invoke(prefix + "open", target, snapshot)
      : ipc.invoke(prefix + "open", target, snapshot, options),
    publish: (binding, snapshot, rejected, request) => request === undefined
      ? ipc.invoke(prefix + "publish", binding, snapshot, rejected)
      : ipc.invoke(prefix + "publish", binding, snapshot, rejected, request),
    focus: (binding) => ipc.invoke(prefix + "focus", binding),
    dock: (binding) => ipc.invoke(prefix + "dock", binding),
    revoke: (binding) => ipc.invoke(prefix + "revoke", binding),
    onLifecycle: (listener) => subscribe(ipc, "lifecycle", listener),
    onEdit: (listener) => subscribe(ipc, "owner-edit", listener),
  };
}
