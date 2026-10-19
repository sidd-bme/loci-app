// Invalidate same-window consumers after an application target changes. No
// settings or execution state travels through this signal; consumers reread it.
const changes = new EventTarget();

export function notifyComputeTargetsChanged(): void {
  changes.dispatchEvent(new Event("change"));
}

export function subscribeComputeTargetsChanged(listener: () => void): () => void {
  changes.addEventListener("change", listener);
  return () => changes.removeEventListener("change", listener);
}
