import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  sameDisplayTarget, type DisplayInspectorAction, type DisplayInspectorBinding,
  type DisplayInspectorLifecycle, type DisplayInspectorSnapshot, type DisplayInspectorTarget,
} from "../shared/display-inspector-api";
import type { PreprocessInspectorEdit, PreprocessInspectorSnapshot } from "../shared/preprocess-inspector-api";
import type { PanelOpenOptions } from "../shared/panel-open-options";

type Closed = (reason: DisplayInspectorLifecycle["reason"], binding: DisplayInspectorBinding) => void;
type Candidate<Snapshot, Edit> = {
  target: DisplayInspectorTarget | null;
  snapshot: Snapshot | null;
  apply: (edit: Edit) => boolean;
  onClosed: Closed;
};

export function useDisplayInspectorOwner(
  display: Candidate<DisplayInspectorSnapshot, DisplayInspectorAction>,
  preprocess: Candidate<PreprocessInspectorSnapshot, PreprocessInspectorEdit>,
  onError: (error: string) => void,
) {
  const api = window.lociDisplayInspectorOwner;
  const live = useRef({ display, preprocess, onError });
  const session = useRef<DisplayInspectorLifecycle | null>(null);
  const [lifecycle, setLifecycle] = useState<DisplayInspectorLifecycle | null>(null);
  const subscription = useRef(0);
  const pendingOpen = useRef(false);
  const applyingPreprocess = useRef(false);
  const currentCandidate = (kind: DisplayInspectorTarget["kind"]) => kind ? live.current.preprocess : live.current.display;

  useLayoutEffect(() => { live.current = { display, preprocess, onError }; });
  useLayoutEffect(() => {
    if (!api) return;
    subscription.current++;
    const onLifecycle = api.onLifecycle((next) => {
      const { binding, status } = next;
      const candidate = currentCandidate(binding.kind);
      if (status === "closed") {
        if (session.current?.binding.generation !== binding.generation) return;
        session.current = null;
        setLifecycle(null);
        candidate.onClosed(next.reason, binding);
      } else if (!sameDisplayTarget(binding, candidate.target)) {
        void api.revoke(binding).catch(() => {});
      } else {
        session.current = next;
        setLifecycle(next);
      }
    });
    const onEdit = api.onEdit(({ binding, action }) => {
      const candidate = currentCandidate(binding.kind);
      if (session.current?.status !== "open" || binding.generation !== session.current.binding.generation ||
          !sameDisplayTarget(binding, candidate.target)) return;
      const isPreprocess = action.kind === "preprocess";
      if (isPreprocess !== (binding.kind === "preprocess")) return;
      // Native IPC has no React input boundary. Commit each edit before the next
      // intent, then acknowledge the exact, current owner state to Preprocess.
      let accepted = false;
      applyingPreprocess.current = isPreprocess;
      try {
        flushSync(() => {
          accepted = action.kind === "preprocess" ? live.current.preprocess.apply(action.edit)
            : live.current.display.apply(action);
        });
      } finally {
        applyingPreprocess.current = false;
      }
      const updated = currentCandidate(binding.kind);
      if (!updated.snapshot || !sameDisplayTarget(binding, updated.target)) return;
      if (action.kind === "preprocess") void api.publish(binding, updated.snapshot, !accepted, action.request).catch(() => {});
      else if (!accepted) void api.publish(binding, updated.snapshot, true).catch(() => {});
    });
    return () => {
      subscription.current++;
      onLifecycle();
      onEdit();
      if (session.current) void api.revoke(session.current.binding).catch(() => {});
      session.current = null;
    };
  }, [api]);

  const active = lifecycle?.binding.kind === "preprocess" ? preprocess : display;
  useLayoutEffect(() => {
    const current = session.current;
    if (!api || !current) return;
    const { binding } = current;
    const { target, snapshot } = currentCandidate(binding.kind);
    if (!snapshot || !sameDisplayTarget(binding, target)) {
      // Fence queued edits immediately and let native close the old window.
      session.current = null;
      setLifecycle(null);
      // Native knows whether the retiring editor had an unacknowledged edit.
      const subscribed = subscription.current;
      const closed = (reason: "revoked" | "unavailable") => {
        if (subscription.current === subscribed) currentCandidate(binding.kind).onClosed(reason, binding);
      };
      void api.revoke(binding).then((reason) => closed(reason ?? "revoked"), () => closed("unavailable"));
    } else if (!applyingPreprocess.current) {
      void api.publish(binding, snapshot).catch(() => {});
    }
  }, [api, active.target, active.snapshot, lifecycle?.binding.generation]);

  const open = (kind: DisplayInspectorTarget["kind"], options?: PanelOpenOptions) => {
    const { target, snapshot } = currentCandidate(kind);
    if (!api || !target || !snapshot || pendingOpen.current || session.current) return;
    pendingOpen.current = true;
    const subscribed = subscription.current;
    const opening = options ? api.open(target, snapshot, options) : api.open(target, snapshot);
    void opening.then((binding) => {
      if (subscribed !== subscription.current || !sameDisplayTarget(binding, currentCandidate(kind).target))
        return api.revoke(binding);
    }).catch(() => {
      if (subscribed === subscription.current && sameDisplayTarget(target, currentCandidate(kind).target))
        live.current.onError(kind ? "Could not open the Preprocess inspector." : "Could not open the Display inspector.");
    }).finally(() => { pendingOpen.current = false; });
  };
  const binding = lifecycle && sameDisplayTarget(lifecycle.binding, active.target) ? lifecycle.binding : null;
  const focus = () => { if (api && binding) void api.focus(binding).catch(() => {}); };
  const dock = () => { if (api && binding) void api.dock(binding).catch(() => {}); };
  return { available: Boolean(api),
    detached: Boolean(binding && lifecycle?.status === "open"), binding, open, focus, dock };
}
