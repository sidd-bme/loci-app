import { useState } from "react";
import type { ResearchDesktopApi, ResearchSnapshot, ResearchSource, ResearchWorkspaceChange } from "../shared/research-contracts";

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
      <small>Original files and scientific history are kept. Closed images and cleared results can be restored here.</small>
      {workspace.closed_sources.length > 0 && <div className="workspace-restorable"><span>Closed images</span>
        {workspace.closed_sources.map((item) => <button key={item.id} disabled={disabled} title={item.name}
          aria-label={`Reopen ${item.name}`} onClick={() => void change({ expected_revision: workspace.revision,
            sources: [{ id: item.id, sha256: item.sha256, visible: true }], results: [] }, "Image reopened.")}>{item.name}</button>)}
      </div>}
      {hidden.length > 0 && <div className="workspace-restorable"><span>Cleared results for this image</span>
        {hidden.map((item) => <button key={item.id} disabled={disabled} title={`Restore exact revision ${item.revision_hash}`}
          aria-label={`Restore result ${item.id}`} onClick={() => void change({ expected_revision: workspace.revision,
            sources: [], results: [{ id: item.id, revision_hash: item.revision_hash, visible: true }] }, "Result restored.")}>{item.kind}<small>{item.object_count} objects · {item.revision_hash.slice(0, 8)}</small></button>)}
      </div>}
    </div></details>
    {undo && <div className="workspace-change-receipt" role="status"><span>{undo.message}</span>
      <button disabled={disabled || workspace.revision !== undo.request.expected_revision} onClick={() => void change(undo.request, "", true)}>Undo</button></div>}
  </div>;
}
