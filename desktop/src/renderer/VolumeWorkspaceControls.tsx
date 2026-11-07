import { Crosshair, Pencil, X } from "lucide-react";
import { useId } from "react";
import "./VolumeWorkspaceControls.css";

export type VolumeWorkspaceReadiness = "raw-only" | "loading" | "ready" | "stale" | "unavailable";

export interface VolumeWorkspaceControlsProps {
  resultName?: string | null;
  revisionShort?: string | null;
  selectedObject: number | null;
  readiness: VolumeWorkspaceReadiness;
  busy?: boolean;
  error?: string | null;
  labelsVisible: boolean;
  labelOpacity: number;
  selectedOnly: boolean;
  selectionHiddenReason?: string | null;
  canCorrect?: boolean;
  correctionReason?: string | null;
  canLocate?: boolean;
  onVisibilityChange: (visible: boolean) => void;
  onOpacityChange: (opacity: number) => void;
  onSelectedOnlyChange: (selectedOnly: boolean) => void;
  onLocateObject: () => void;
  onCorrectObject: () => void;
  onClearSelection: () => void;
}

const readinessMessage: Record<VolumeWorkspaceReadiness, string | null> = {
  "raw-only": "Choose a label result to inspect objects alongside the raw volume.",
  loading: "Loading labels for this result…",
  ready: null,
  stale: "Labels no longer match the selected result. Load its current revision to continue.",
  unavailable: "Labels are unavailable for this volume.",
};

/** Controlled chrome only: scene identity, picking and mutation authority belong to the caller. */
export function VolumeWorkspaceControls({
  resultName, revisionShort, selectedObject, readiness, busy = false, error,
  labelsVisible, labelOpacity, selectedOnly, selectionHiddenReason,
  canCorrect = false, correctionReason, canLocate = false,
  onVisibilityChange, onOpacityChange, onSelectedOnlyChange,
  onLocateObject, onCorrectObject, onClearSelection,
}: VolumeWorkspaceControlsProps) {
  const statusId = useId();
  const correctionId = useId();
  const selected = selectedObject !== null;
  const ready = readiness === "ready" && !error;
  const locked = !ready || busy;
  const status = error || readinessMessage[readiness] || (busy ? "Updating volume workspace…" : null);
  const hiddenReason = selected ? selectionHiddenReason || (!labelsVisible ? "Labels are hidden." : null) : null;
  const opacity = Number.isFinite(labelOpacity) ? Math.round(labelOpacity * 100) : 0;

  return <section className="volume-workspace-controls" aria-label="Volume labels and selection" aria-busy={busy || readiness === "loading"}>
    <div className="volume-workspace-controls-row">
      <div className="volume-workspace-layer" role="group" aria-label="Label display">
        <label className="volume-workspace-toggle"><input type="checkbox" checked={labelsVisible} disabled={locked}
          aria-describedby={status ? statusId : undefined} onChange={(event) => onVisibilityChange(event.target.checked)} />Labels</label>
        <label className="volume-workspace-opacity">Opacity<input type="range" min={0} max={100} step={5}
          aria-label="Label opacity" value={opacity} disabled={locked || !labelsVisible}
          onChange={(event) => onOpacityChange(Number(event.target.value) / 100)} /><output>{opacity}%</output></label>
        <label className="volume-workspace-toggle"><input type="checkbox" checked={selectedOnly} disabled={locked || !selected || !labelsVisible}
          onChange={(event) => onSelectedOnlyChange(event.target.checked)} />Selected only</label>
      </div>
      {selected && <div className="volume-workspace-selection" role="group" aria-label={`Selected object ${selectedObject}`}>
        <strong>Object {selectedObject}</strong>
        <button type="button" disabled={locked || !canLocate} onClick={onLocateObject}><Crosshair aria-hidden="true" />Locate object</button>
        <button type="button" disabled={locked || !canCorrect} aria-describedby={correctionReason ? correctionId : undefined}
          onClick={onCorrectObject}><Pencil aria-hidden="true" />Correct</button>
        <button type="button" className="volume-workspace-clear" aria-label="Clear object selection" title="Clear object selection"
          disabled={busy} onClick={onClearSelection}><X aria-hidden="true" /></button>
      </div>}
    </div>
    {(resultName || revisionShort) && <p className="volume-workspace-result">{resultName}{resultName && revisionShort ? " · " : ""}{revisionShort ? `rev ${revisionShort}` : ""}</p>}
    {status && <p id={statusId} className={error ? "volume-workspace-message is-error" : "volume-workspace-message"}
      role={error ? "alert" : "status"}>{status}</p>}
    {!status && !selected && <p className="volume-workspace-message">Select a label in the image or object table.</p>}
    {hiddenReason && <p className="volume-workspace-message" role="status">{hiddenReason}</p>}
    {selected && correctionReason && <p id={correctionId} className="volume-workspace-message">{correctionReason}</p>}
  </section>;
}
