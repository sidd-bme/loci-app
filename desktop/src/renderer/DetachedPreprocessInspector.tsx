import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PanelRight } from "lucide-react";
import type { DisplayInspectorApi, DisplayInspectorState } from "../shared/display-inspector-api";
import type { PreprocessInspectorEdit, PreprocessInspectorSnapshot } from "../shared/preprocess-inspector-api";
import { PreprocessingPanel, PreprocessingScopeControl } from "./PreprocessingPanel";

type VersionedEdit = Extract<PreprocessInspectorEdit, { revision: number }>["kind"];

export function DetachedPreprocessInspector({ api, state, snapshot }: {
  api: DisplayInspectorApi;
  state: DisplayInspectorState;
  snapshot: PreprocessInspectorSnapshot;
}) {
  const { binding, acknowledgedRequest = 0, dockRequested } = state;
  const request = useRef(0);
  const dockButton = useRef<HTMLButtonElement>(null);
  const docking = useRef(false);
  const [sent, setSent] = useState(0);
  const [text, setText] = useState<{ id: number; text: string; request: number }>();
  const [interrupted, setInterrupted] = useState(false);
  const [dockError, setDockError] = useState(false);
  const pending = acknowledgedRequest < sent;
  const dock = useCallback(() => {
    if (docking.current || (!interrupted && request.current > acknowledgedRequest)) return;
    docking.current = true;
    const closing = interrupted ? api.dock(binding, true) : api.dock(binding);
    void closing.catch(() => {
      docking.current = false;
      setDockError(true);
    });
  }, [api, binding, acknowledgedRequest, interrupted]);

  useLayoutEffect(() => { dockButton.current?.focus(); }, []);
  useEffect(() => { if (dockRequested && (!pending || interrupted)) dock(); }, [dockRequested, pending, interrupted, dock]);

  const send = (edit: PreprocessInspectorEdit) => {
    if (interrupted || dockRequested || docking.current ||
        ((edit.kind === "preview" || edit.kind === "restore-numbers") && request.current > acknowledgedRequest)) return;
    const next = ++request.current;
    setSent(next);
    if (edit.kind === "draft") setText({ id: edit.id, text: edit.text, request: next });
    if (edit.kind === "revert") setText(undefined);
    void api.edit(binding, { kind: "preprocess", request: next, edit }).catch(() => setInterrupted(true));
  };
  const sendVersioned = (kind: VersionedEdit) => send({ kind, revision: snapshot.revision });
  const rejected = state.rejectedSequence !== undefined && state.rejectedSequence === state.sequence;
  const notice = interrupted ? "This edit could not sync. Dock Preprocess to review the applied numbers."
    : dockError ? "Could not return Preprocess to the workspace. Try Dock Preprocess again."
    : rejected ? "The image scope or pipeline changed. Review the current settings and try again." : "";

  return <main className="display-inspector-window" aria-label="Preprocess inspector">
    <header className="display-inspector-heading">
      <div>
        <h1>Preprocess</h1>
        <p title={snapshot.source.name}>{snapshot.source.name}</p>
      </div>
      <button ref={dockButton} type="button" disabled={pending && !interrupted} onClick={dock}>
        <PanelRight aria-hidden="true" />Dock Preprocess
      </button>
    </header>
    <div className="display-inspector-body">
      {notice && <p role="alert" className="display-inspector-message">{notice}</p>}
      <fieldset className="detached-preprocess-controls" disabled={interrupted || dockRequested} aria-label="Preprocess controls">
        <PreprocessingScopeControl
          selection={snapshot.selection}
          dimensions={snapshot.dimensions}
          drawing={snapshot.drawing}
          onSelectWholeImage={() => sendVersioned("whole")}
          onStartDrawRegion={() => sendVersioned("draw")}
          onCancelDrawRegion={() => sendVersioned("cancel-draw")}
        />
        <PreprocessingPanel
          editor={snapshot.editor}
          spatialUnit={snapshot.spatialUnit}
          onEdit={send}
          onPreview={() => sendVersioned("preview")}
          previewDisabled={snapshot.previewDisabled || pending || snapshot.restoreNumbers === true}
          restoreNumbers={snapshot.restoreNumbers ? { disabled: pending, onRestore: () => sendVersioned("restore-numbers") } : undefined}
          pendingText={text && text.request > acknowledgedRequest ? text : undefined}
        />
      </fieldset>
    </div>
  </main>;
}
