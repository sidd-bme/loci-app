import { useMemo } from "react";
import { FolderOpen } from "lucide-react";
import type { ResearchSource } from "../shared/research-contracts";
import { buildSourceBrowser, sourceDisplayPath, type SourceBrowserNode } from "./source-browser";
import "./SourceTree.css";

export function BatchSourcePicker({ sources, selectedSourceIds, onSelection, busy, previewSourceId, previewDisabled, onPreview }: {
  sources: ResearchSource[]; selectedSourceIds: string[]; onSelection: (ids: string[]) => void; busy: boolean;
  previewSourceId: string | null; previewDisabled: boolean; onPreview: (id: string) => void;
}) {
  const nodes = useMemo(() => buildSourceBrowser(sources), [sources]);
  const selected = new Set(selectedSourceIds);
  const choose = (ids: string[], included: boolean) => {
    const next = new Set(selected);
    for (const id of ids) included ? next.add(id) : next.delete(id);
    // Keep execution order tied to the working list, including after group selection.
    onSelection(sources.filter(source => next.has(source.id)).map(source => source.id));
  };
  const render = (items: SourceBrowserNode[], depth = 0): React.ReactNode => items.map(node => {
    const indentation = Math.min(depth, 3) * 12;
    if (node.kind === "folder") {
      const count = node.sourceIds.filter(id => selected.has(id)).length;
      return <fieldset className="batch-source-picker__folder" key={node.id}>
        <legend><label title={node.path} style={{ paddingInlineStart: indentation }}><input type="checkbox" aria-label={`Include folder ${node.path} in batch`}
          disabled={busy} checked={count === node.sourceIds.length}
          ref={element => { if (element) element.indeterminate = count > 0 && count < node.sourceIds.length; }}
          onChange={event => choose(node.sourceIds, event.target.checked)} />
          <FolderOpen size={14} aria-hidden="true" /><span>{node.label}</span>
          <small>{count}/{node.sourceIds.length}</small></label></legend>
        {render(node.children, depth + 1)}
      </fieldset>;
    }
    const path = sourceDisplayPath(node.source, sources);
    return <div className="batch-source-picker__image" key={node.id} style={{ paddingInlineStart: indentation }}>
      <label className="research-check" title={path}><input type="checkbox" aria-label={`Include ${path} in batch`}
        disabled={busy} checked={selected.has(node.source.id)} onChange={event => choose([node.source.id], event.target.checked)} />
        <span>{node.label}</span></label>
      <button type="button" disabled={busy || previewDisabled} onClick={() => onPreview(node.source.id)}
        aria-description={`Preview ${path}`} title={`Preview ${path}`}>{previewSourceId === node.source.id ? "Previewing…" : "Preview"}</button>
    </div>;
  });
  return <div className="batch-source-picker" role="group" aria-label="Batch images">
    <div className="batch-source-picker__actions">
      <span>{sources.filter(source => selected.has(source.id)).length} of {sources.length} selected</span>
      <button type="button" aria-label="Select all batch images" disabled={busy || !sources.length}
        onClick={() => onSelection(sources.map(source => source.id))}>Select all</button>
      <button type="button" aria-label="Clear batch image selection" disabled={busy || !selectedSourceIds.length}
        onClick={() => onSelection([])}>Clear</button>
    </div>
    {render(nodes)}
  </div>;
}
