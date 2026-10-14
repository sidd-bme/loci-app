import { useState } from "react";
import type { ResearchDesktopApi, ResearchSnapshot, ResearchSource, ResearchWorkspaceChange } from "../shared/research-contracts";

import { resultTitle } from "./result-title";

/** Closing/clearing changes the working list; original files and history remain. */
export function WorkspaceRecordActions({ api, snapshot, source, busy, onBusy, onChange, onError }: {
  api: Pick<ResearchDesktopApi, "updateWorkspace">; snapshot: ResearchSnapshot; source: ResearchSource | null; busy: boolean;
  onBusy: (value: string | null) => void; onChange: (snapshot: ResearchSnapshot) => void;
  onError: (message: string) => void;
}) {
  const [undo, setUndo] = useState<{ request: ResearchWorkspaceChange; message: string } | null>(null);
  const [working, setWorking] = useState(false);
  const workspace = snapshot.workspace ?? { revision: 0, closed_sources: [], hidden_results: [] };
  const results = snapshot.results.filter((item) => item.source_id === source?.id);
  const hidden = workspace.hidden_results.filter((item) => item.source_id === source?.id);
  const disabled = busy || working || !api.updateWorkspace;
  const change = async (request: ResearchWorkspaceChange, message: string, isUndo = false) => {
    if (disabled || !api.updateWorkspace) return;
    setWorking(true); onBusy("Updating working list");
    try {
      const next = await api.updateWorkspace(request);
      if (!next.workspace || next.workspace.revision !== request.expected_revision + 1)
        throw new Error("The saved working list did not match this change. Reopen the study to verify it.");
      onChange(next);
      setUndo(isUndo ? null : { message, request: { expected_revision: next.workspace.revision,
        sources: request.sources.map((item) => ({ ...item, visible: !item.visible })),
        results: request.results.map((item) => ({ ...item, visible: !item.visible })) } });
    } catch (error) { onError(error instanceof Error ? error.message : "Could not update the working list."); }
    finally { setWorking(false); onBusy(null); }
  };
  return <div className="workspace-record-actions">
    <details><summary>Manage images & results</summary><div>
      {source && <>
        <button disabled={disabled} onClick={() => void change({ expected_revision: workspace.revision,
          sources: [{ id: source.id, sha256: source.sha256, visible: false }], results: [] }, "Image closed.")}>Close image</button>
        <button disabled={disabled || !results.length} onClick={() => void change({ expected_revision: workspace.revision,
          sources: [], results: results.map((item) => ({ id: item.id, revision_hash: item.revision_hash, visible: false })) }, "Results cleared from the working list.")}>Clear image results</button>
      </>}
      <small>Close or clear from this list; restore here when needed. Original files and history are kept.</small>
      {workspace.closed_sources.length > 0 && <div className="workspace-restorable"><span>Closed images</span>
        {workspace.closed_sources.map((item) => <button key={item.id} disabled={disabled} title={item.name}
          aria-label={`Reopen ${item.name}`} onClick={() => void change({ expected_revision: workspace.revision,
            sources: [{ id: item.id, sha256: item.sha256, visible: true }], results: [] }, "Image reopened.")}>{item.name}</button>)}
      </div>}
      {hidden.length > 0 && <div className="workspace-restorable"><span>Cleared results for this image</span>
        {hidden.map((item, index) => <button key={item.id} disabled={disabled}
          aria-label={`Restore ${source?.name ?? "image"} · ${resultTitle(item)} · ${item.object_count} objects · Run ${index + 1}`} onClick={() => void change({ expected_revision: workspace.revision,
            sources: [], results: [{ id: item.id, revision_hash: item.revision_hash, visible: true }] }, "Result restored.")}>{resultTitle(item)}<small>{item.object_count} objects · Run {index + 1}</small></button>)}
        <details><summary>Technical record</summary><div>{hidden.map((item, index) => <p key={item.id}>Run {index + 1} · {resultTitle(item)}<br />Result <code style={{ overflowWrap: "anywhere" }}>{item.id}</code><br />Revision <code style={{ overflowWrap: "anywhere" }}>{item.revision_hash}</code></p>)}</div></details>
      </div>}
    </div></details>
    {undo && <div className="workspace-change-receipt" role="status"><span>{undo.message}</span>
      <button disabled={disabled || workspace.revision !== undo.request.expected_revision} onClick={() => void change(undo.request, "", true)}>Undo</button></div>}
  </div>;
}
