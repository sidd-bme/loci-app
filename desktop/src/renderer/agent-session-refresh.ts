import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ResearchResult, ResearchSnapshot } from "../shared/research-contracts";

/** One request at a time, scoped to the open document and the snapshot it read. */
export function useWorkspaceSnapshotPolling({
  snapshot, scope, enabled, suspended, interval, getSnapshot, setSnapshot, onError,
}: {
  snapshot: ResearchSnapshot | null;
  scope: string;
  enabled: boolean;
  suspended: boolean;
  interval: number;
  getSnapshot: () => Promise<ResearchSnapshot | null>;
  setSnapshot: Dispatch<SetStateAction<ResearchSnapshot | null>>;
  onError: (error: unknown | null) => void;
}): void {
  const latest = useRef({ snapshot, scope, suspended, getSnapshot, setSnapshot, onError });
  latest.current = { snapshot, scope, suspended, getSnapshot, setSnapshot, onError };
  const inFlight = useRef(false);
  useEffect(() => {
    if (!enabled || suspended) return;
    let active = true;
    const timer = window.setInterval(() => {
      const started = latest.current;
      if (!active || inFlight.current || started.suspended || !started.snapshot) return;
      const expected = started.snapshot;
      inFlight.current = true;
      void started.getSnapshot().then((next) => {
        if (!active || latest.current.suspended || latest.current.scope !== started.scope) return;
        if (next && next.project.project_id === expected.project.project_id) {
          // A command or another refresh may have published newer state while this was pending.
          started.setSnapshot((current) => current === expected ? next : current);
          latest.current.onError(null);
        }
      }).catch((error: unknown) => {
        if (active && !latest.current.suspended && latest.current.scope === started.scope)
          latest.current.onError(error);
      }).finally(() => { inFlight.current = false; });
    }, interval);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled, suspended, interval, scope]);
}

/** Only newly published results explicitly attributed to an agent session are eligible. */
export class AgentResultTracker {
  private scope: string | null = null;
  private seen = new Set<string>();

  observe(snapshot: ResearchSnapshot | null, scope: string): ResearchResult | null {
    if (scope !== this.scope) {
      this.scope = scope;
      this.seen = new Set(snapshot?.results.map((result) => result.id) ?? []);
      return null;
    }
    if (!snapshot) return null;
    const attributed = new Set(snapshot.agent_sessions?.sessions.flatMap(
      (session) => session.recent_result_ids ?? [],
    ) ?? []);
    let newest: ResearchResult | null = null;
    for (const result of snapshot.results) {
      if (!attributed.has(result.id)) continue;
      if (!this.seen.has(result.id) && snapshot.sources.some(
        (source) => source.id === result.source_id && source.sha256 === result.source_sha256,
      )) newest = result;
      this.seen.add(result.id);
    }
    return newest;
  }
}
