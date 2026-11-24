import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PanelRight } from "lucide-react";
import { sameDisplayTarget, type DisplayInspectorAction, type DisplayInspectorApi, type DisplayInspectorState } from "../shared/display-inspector-api";
import { DetachedPreprocessInspector } from "./DetachedPreprocessInspector";
import { SourceDisplayPanel } from "./SourceDisplayPanel";
import { useUserPreferences } from "./use-user-preferences";
import "./DetachedDisplayInspector.css";

export function DetachedDisplayInspector({ api }: { api: DisplayInspectorApi }) {
  useUserPreferences();
  const [state, setState] = useState<DisplayInspectorState | null>(null);
  const [error, setError] = useState("");
  const dockButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let mounted = true;
    const receive = (next: DisplayInspectorState) => {
      if (!mounted || next.snapshot.source.id !== next.binding.sourceId || next.snapshot.source.sha256 !== next.binding.sourceSha256) return;
      setState((previous) => {
        if (!previous) return next;
        return next.binding.generation === previous.binding.generation && sameDisplayTarget(next.binding, previous.binding) &&
          next.sequence > previous.sequence ? next : previous;
      });
    };
    const unsubscribe = api.onState(receive);
    void api.state().then(receive).catch(() => { if (mounted) setError("The inspector is unavailable. Close this window to return to the workspace."); });
    return () => { mounted = false; unsubscribe(); };
  }, [api]);
  const binding = state?.binding;
  const windowTitle = binding && (binding.kind === "preprocess" ? "Loci · Preprocess" : "Loci · Display");
  useLayoutEffect(() => {
    if (windowTitle) document.title = windowTitle;
  }, [windowTitle]);
  const restoreDrafts = state?.rejectedSequence;
  const controls = useMemo(() => {
    const send = (action: DisplayInspectorAction) => {
      if (binding) {
        setError("");
        void api.edit(binding, action).catch(() => {
          if (action.kind !== "compare")
            setError("The Display inspector could not apply this change. Dock Display and try again.");
        });
      }
    };
    return {
      send,
      inspector: {
        restoreDrafts,
        onChannelEdit: (channel, edit) => send({ kind: "channel", channel, edit }),
        onPlane: (axis, value) => send({ kind: "plane", axis, value }),
        onProjection: (value) => send({ kind: "projection", value }),
      } satisfies NonNullable<React.ComponentProps<typeof SourceDisplayPanel>["inspector"]>,
    };
  // IPC snapshots clone the binding. Keep playback callbacks stable across plane changes.
  }, [api, binding?.generation, restoreDrafts]);
  useLayoutEffect(() => { dockButton.current?.focus(); }, [binding?.generation]);

  const dock = () => {
    if (binding) void api.dock(binding).catch(() => setError("Close this window to dock Display."));
  };
  if (state?.snapshot.kind === "preprocess")
    return <DetachedPreprocessInspector key={state.binding.generation} api={api} state={state} snapshot={state.snapshot} />;
  const snapshot = state?.snapshot;
  const rejected = state?.rejectedSequence !== undefined && state.rejectedSequence === state.sequence;
  return <main className="display-inspector-window" aria-label={snapshot ? "Display inspector" : "Image inspector"}>
    <header className="display-inspector-heading">
      <div>
        <h1>{snapshot ? "Display" : "Image inspector"}</h1>
        {snapshot && <p title={snapshot.source.name}>{snapshot.source.name}</p>}
      </div>
      {binding && <button ref={dockButton} type="button" onClick={dock}><PanelRight aria-hidden="true" />Dock Display</button>}
    </header>
    <div className="display-inspector-body" aria-busy={!snapshot && !error}>
      {(error || rejected) && <p role="alert" className="display-inspector-message">
        {error || "The display changed before this edit could apply. Review the current values and try again."}
      </p>}
      {snapshot ? <SourceDisplayPanel
        {...snapshot}
        inspector={controls.inspector}
        onAuto={(channel) => controls.send({ kind: "auto", channel,
          plane: { t: snapshot.selection.t, z: snapshot.selection.z, c: snapshot.selection.c } })}
        onReset={() => controls.send({ kind: "reset" })}
        onCompare={(active) => controls.send({ kind: "compare", active })}
      /> : !error && <p className="display-inspector-message" role="status">Opening inspector…</p>}
    </div>
  </main>;
}
