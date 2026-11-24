import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  sameStudyNavigatorTarget,
  type StudyNavigatorAction,
  type StudyNavigatorBinding,
  type StudyNavigatorLifecycle,
  type StudyNavigatorOpenOptions,
  type StudyNavigatorSnapshot,
  type StudyNavigatorTarget,
} from "../shared/study-navigator-api";

type Candidate = {
  target: StudyNavigatorTarget | null;
  snapshot: StudyNavigatorSnapshot | null;
  apply: (action: StudyNavigatorAction) => boolean;
  onClosed: (reason: StudyNavigatorLifecycle["reason"], binding: StudyNavigatorBinding) => void;
};

export function useStudyNavigatorOwner(candidate: Candidate, onError: (error: string) => void) {
  const api = window.lociStudyNavigatorOwner;
  const live = useRef({ candidate, onError });
  const session = useRef<StudyNavigatorLifecycle | null>(null);
  const [lifecycle, setLifecycle] = useState<StudyNavigatorLifecycle | null>(null);
  const subscription = useRef(0);
  const pendingOpen = useRef(false);

  useLayoutEffect(() => {
    live.current = { candidate, onError };
  });

  useLayoutEffect(() => {
    if (!api) return;
    subscription.current++;
    const onLifecycle = api.onLifecycle((next) => {
      const { binding, status } = next;
      if (status === "closed") {
        if (session.current?.binding.generation !== binding.generation) return;
        session.current = null;
        setLifecycle(null);
        live.current.candidate.onClosed(next.reason, binding);
      } else if (!sameStudyNavigatorTarget(binding, live.current.candidate.target)) {
        void api.revoke(binding).catch(() => {});
      } else {
        session.current = next;
        setLifecycle(next);
      }
    });
    const onAction = api.onAction(({ binding, action }) => {
      if (
        session.current?.status !== "open" ||
        binding.generation !== session.current.binding.generation ||
        !sameStudyNavigatorTarget(binding, live.current.candidate.target)
      ) {
        return;
      }
      let accepted = false;
      flushSync(() => {
        accepted = live.current.candidate.apply(action);
      });
      const updated = live.current.candidate;
      if (!accepted && updated.snapshot && sameStudyNavigatorTarget(binding, updated.target)) {
        void api.publish(binding, updated.snapshot, true).catch(() => {});
      }
    });
    return () => {
      subscription.current++;
      onLifecycle();
      onAction();
      if (session.current) void api.revoke(session.current.binding).catch(() => {});
      session.current = null;
    };
  }, [api]);

  useLayoutEffect(() => {
    const current = session.current;
    if (!api || !current) return;
    const { binding } = current;
    const { target, snapshot } = live.current.candidate;
    if (!snapshot || !sameStudyNavigatorTarget(binding, target)) {
      session.current = null;
      setLifecycle(null);
      const subscribed = subscription.current;
      void api.revoke(binding).finally(() => {
        if (subscription.current === subscribed) live.current.candidate.onClosed("revoked", binding);
      });
    } else {
      void api.publish(binding, snapshot).catch(() => {});
    }
  }, [api, candidate.target, candidate.snapshot, lifecycle?.binding.generation]);

  const open = (options?: StudyNavigatorOpenOptions) => {
    const { target, snapshot } = live.current.candidate;
    if (!api || !target || !snapshot || pendingOpen.current || session.current) return;
    pendingOpen.current = true;
    const subscribed = subscription.current;
    void api
      .open(target, snapshot, options)
      .then((binding) => {
        if (subscribed !== subscription.current || !sameStudyNavigatorTarget(binding, live.current.candidate.target)) {
          return api.revoke(binding);
        }
      })
      .catch(() => {
        if (subscribed === subscription.current && sameStudyNavigatorTarget(target, live.current.candidate.target)) {
          live.current.onError("Could not open the Images navigator.");
        }
      })
      .finally(() => {
        pendingOpen.current = false;
      });
  };

  const binding = lifecycle && sameStudyNavigatorTarget(lifecycle.binding, candidate.target) ? lifecycle.binding : null;
  const focus = () => {
    if (api && binding) void api.focus(binding).catch(() => {});
  };
  const dock = () => {
    if (api && binding) void api.dock(binding).catch(() => {});
  };

  return {
    available: Boolean(api),
    detached: Boolean(binding && lifecycle?.status === "open"),
    binding,
    open,
    focus,
    dock,
  };
}
