/** Local commands only; source paths and scientific state never travel here. */
export type WorkbenchCommand = "open-images" | "open-folder" | "open-study" | "save-study";

const listeners = new Set<(command: WorkbenchCommand) => void>();

export function dispatchWorkbenchCommand(command: WorkbenchCommand): boolean {
  const active = [...listeners];
  for (const listener of active) listener(command);
  return active.length > 0;
}

export function subscribeWorkbenchCommands(listener: (command: WorkbenchCommand) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
