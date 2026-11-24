import type { IpcRenderer } from "electron";
import {
  STUDY_NAVIGATOR_IPC as prefix,
  type StudyNavigatorApi,
  type StudyNavigatorOwnerApi,
} from "./shared/study-navigator-api";

type NavigatorIpc = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

function subscribe<T>(ipc: NavigatorIpc, channel: string, listener: (value: T) => void): () => void {
  const receive = (_event: unknown, value: T) => listener(value);
  ipc.on(prefix + channel, receive);
  return () => {
    ipc.removeListener(prefix + channel, receive);
  };
}

export function createStudyNavigatorApi(ipc: NavigatorIpc): StudyNavigatorApi {
  return {
    state: () => ipc.invoke(prefix + "state"),
    act: (binding, action) => ipc.invoke(prefix + "act", binding, action),
    dock: (binding) => ipc.invoke(prefix + "dock", binding),
    onState: (listener) => subscribe(ipc, "state-changed", listener),
  };
}

export function createStudyNavigatorOwnerApi(ipc: NavigatorIpc): StudyNavigatorOwnerApi {
  return {
    open: (target, snapshot, options) => options === undefined
      ? ipc.invoke(prefix + "open", target, snapshot)
      : ipc.invoke(prefix + "open", target, snapshot, options),
    publish: (binding, snapshot, rejected) => rejected === undefined
      ? ipc.invoke(prefix + "publish", binding, snapshot)
      : ipc.invoke(prefix + "publish", binding, snapshot, rejected),
    focus: (binding) => ipc.invoke(prefix + "focus", binding),
    dock: (binding) => ipc.invoke(prefix + "dock", binding),
    revoke: (binding) => ipc.invoke(prefix + "revoke", binding),
    onLifecycle: (listener) => subscribe(ipc, "lifecycle", listener),
    onAction: (listener) => subscribe(ipc, "owner-action", listener),
  };
}
