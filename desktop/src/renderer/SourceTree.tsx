import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRight, FileImage, Folder, FolderOpen, GripVertical, LocateFixed, Search, X } from "lucide-react";
import type { ResearchSource } from "../shared/research-contracts";
import { buildSourceBrowser, filterSourceBrowser, sourceAncestors, sourceDisplayPath, visibleSourceRows, type SourceBrowserNode } from "./source-browser";
import "./SourceTree.css";

type Activate = (source: ResearchSource, event: React.MouseEvent, rangeIds: string[]) => void;
type Props = {
  sources: ResearchSource[]; activeSourceId: string | null; selectedSourceIds: string[];
  onActivate: Activate; onReorder: (sources: ResearchSource[]) => void; reorderDisabled: boolean;
  onToggleSelection: (source: ResearchSource) => void;
  dimensions: (source: ResearchSource) => { c: number; z: number };
};

function FlatSources({ sources, allSources, activeSourceId, selectedSourceIds, onActivate, onReorder,
  reorderEnabled, dimensions }: Omit<Props, "reorderDisabled"> & { allSources: ResearchSource[]; reorderEnabled: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  type Drag = { item: ResearchSource; start: number; current: number; rect: DOMRect; rows: DOMRect[]; offset: number; y: number };
  const [drag, setDrag] = useState<Drag | null>(null);
  const liveDrag = useRef<Drag | null>(null);
  const [dropped, setDropped] = useState<string | null>(null);
  const droppedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useRef<(() => void) | null>(null);
  const dragged = useRef(false);
  const updateDrag = (next: Drag | null) => { liveDrag.current = next; setDrag(next); };
  const flash = (id: string) => {
    setDropped(id); clearTimeout(droppedTimer.current);
    droppedTimer.current = setTimeout(() => setDropped(null), 300);
  };
  useEffect(() => () => { cancel.current?.(); clearTimeout(droppedTimer.current); }, []);
  useEffect(() => { if (!reorderEnabled) cancel.current?.(); }, [reorderEnabled]);
  const pointerDown = (item: ResearchSource, index: number, event: React.PointerEvent) => {
    if (event.button !== 0 || !reorderEnabled || sources.length < 2) return;
    cancel.current?.(); dragged.current = false;
    const origin = { x: event.clientX, y: event.clientY };
    const previous = { userSelect: document.body.style.userSelect, cursor: document.body.style.cursor };
    const move = (next: PointerEvent) => {
      if (!liveDrag.current) {
        if (Math.hypot(next.clientX - origin.x, next.clientY - origin.y) <= 4) return;
        const elements = [...list.current!.querySelectorAll<HTMLButtonElement>("button[data-source-id]")];
        const rows = elements.map(element => element.getBoundingClientRect());
        const rect = rows[index];
        dragged.current = true; document.body.style.userSelect = "none"; document.body.style.cursor = "grabbing";
        updateDrag({ item, start: index, current: index, rect, rows, offset: origin.y - rect.top, y: next.clientY });
      } else {
        const current = liveDrag.current;
        const y = Math.max(current.rows[0].top, Math.min(current.rows.at(-1)!.bottom, next.clientY));
        let target = 0;
        current.rows.forEach((row, rowIndex) => { if (y > (row.top + row.bottom) / 2) target = rowIndex; });
        updateDrag({ ...current, current: target, y });
      }
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abort); window.removeEventListener("blur", abort);
      document.body.style.userSelect = previous.userSelect; document.body.style.cursor = previous.cursor;
      const current = liveDrag.current;
      cancel.current = null; updateDrag(null);
      if (!commit) dragged.current = false;
      if (commit && current && current.current !== current.start) {
        const next = [...allSources]; const [moved] = next.splice(current.start, 1);
        next.splice(current.current, 0, moved); onReorder(next); flash(item.id);
      }
    };
    const up = () => finish(true), abort = () => finish(false);
    cancel.current = abort;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort); window.addEventListener("blur", abort);
  };
  return <div className="research-sources-list" role="list" aria-label="Images in manual order" ref={list}>
    {sources.map((item, index) => {
      let shift = 0;
      if (drag) {
        const step = drag.rect.height + (drag.rows.length > 1 ? Math.abs(drag.rows[1].top - drag.rows[0].bottom) : 0);
        if (index === drag.start) shift = (drag.current - drag.start) * step;
        else if (index > drag.start && index <= drag.current) shift = -step;
        else if (index < drag.start && index >= drag.current) shift = step;
      }
      const size = dimensions(item);
      return <button key={item.id} type="button" data-source-id={item.id}
        className={`research-source-item source-browser__leaf ${selectedSourceIds.includes(item.id) ? "selected" : ""} ${activeSourceId === item.id ? "active" : ""} ${drag?.item.id === item.id ? "is-ghost" : ""} ${dropped === item.id ? "is-dropped" : ""}`}
        aria-selected={selectedSourceIds.includes(item.id)} aria-current={activeSourceId === item.id ? "true" : undefined}
        title={`${sourceDisplayPath(item, allSources)} · ${size.c} C / ${size.z} Z`}
        style={{ transform: shift ? `translateY(${shift}px)` : undefined }}
        onPointerDown={event => pointerDown(item, index, event)}
        onClick={event => { if (dragged.current) { dragged.current = false; return; } onActivate(item, event, sources.map(source => source.id)); }}
        onKeyDown={event => {
          if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault(); if (!reorderEnabled) return;
          const target = index + (event.key === "ArrowDown" ? 1 : -1);
          if (target < 0 || target >= allSources.length) return;
          const next = [...allSources]; const [moved] = next.splice(index, 1); next.splice(target, 0, moved);
          onReorder(next); flash(item.id);
        }}>
        {reorderEnabled ? <span className="research-source-drag-handle" title="Drag to reorder the working list" aria-hidden="true"><GripVertical size={13} /></span> : <FileImage size={14} aria-hidden="true" />}
        <span className="research-source-name">{item.name}</span>
        <span className="source-browser__dimensions" aria-hidden="true">{size.c}C · {size.z}Z</span>
      </button>;
    })}
    {drag && <div className="research-source-floating-card" style={{ left: drag.rect.left,
      top: Math.max(drag.rows[0].top, Math.min(drag.rows.at(-1)!.bottom - drag.rect.height, drag.y - drag.offset)), width: drag.rect.width, height: drag.rect.height }}>
      <GripVertical size={13} /><span className="research-source-name">{drag.item.name}</span>
    </div>}
  </div>;
}

export function SourceTree(props: Props) {
  const { sources, activeSourceId, selectedSourceIds, onActivate } = props;
  const treeId = useId();
  const model = useMemo(() => buildSourceBrowser(sources), [sources]);
  const [mode, setMode] = useState<"auto" | "tree" | "flat">("auto");
  const treeMode = mode === "auto" ? model.some(node => node.kind === "folder") : mode === "tree";
  const [query, setQuery] = useState("");
  const [searchCollapsed, setSearchCollapsed] = useState(new Set<string>());
  const search = (value: string) => { setQuery(value); setSearchCollapsed(new Set()); };
  const searching = Boolean(query.trim());
  const [expanded, setExpanded] = useState(() => new Set(model.filter(node => node.kind === "folder").map(node => node.id)));
  const [focused, setFocused] = useState(activeSourceId ? `image:${activeSourceId}` : model[0]?.id);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const container = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<{ id: string; focus: boolean } | null>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const ancestors = activeSourceId ? sourceAncestors(model, activeSourceId) ?? [] : [];
  const ancestorKey = JSON.stringify(ancestors);
  useEffect(() => {
    setExpanded(previous => new Set([...previous, ...JSON.parse(ancestorKey)]));
    if (activeSourceId) {
      setFocused(`image:${activeSourceId}`);
      pendingReveal.current = { id: activeSourceId, focus: false };
    }
  }, [activeSourceId, ancestorKey]);
  // A hidden active leaf mounts only after its ancestors expand. Consume this
  // request once after commit; later manual collapsing never reopens the folder.
  useEffect(() => {
    const pending = pendingReveal.current;
    if (!pending) return;
    const leaf = elements.current.get(`image:${pending.id}`) ?? container.current?.querySelector<HTMLButtonElement>(`button[data-source-id="${pending.id}"]`);
    if (!leaf) return;
    leaf.scrollIntoView?.({ block: "nearest" });
    if (pending.focus) leaf.focus();
    pendingReveal.current = null;
  });
  const filtered = useMemo(() => filterSourceBrowser(model, query), [model, query]);
  const effectiveExpanded = searching ? new Set(visibleSourceRows(filtered, new Set(), true)
    .filter(({ node }) => node.kind === "folder" && !searchCollapsed.has(node.id)).map(({ node }) => node.id)) : expanded;
  const rows = visibleSourceRows(filtered, effectiveExpanded);
  const visibleIds = rows.flatMap(({ node }) => node.kind === "image" ? [node.source.id] : []);
  const focusId = rows.some(row => row.node.id === focused) ? focused : rows[0]?.node.id;
  const focus = (id: string) => { setFocused(id); elements.current.get(id)?.focus(); };
  const toggle = (id: string) => searching ? setSearchCollapsed(previous => {
    const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next;
  }) : setExpanded(previous => {
    const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const keyDown = (node: SourceBrowserNode, event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target !== event.currentTarget) return;
    if (event.key === " " && node.kind === "image") {
      event.preventDefault(); props.onToggleSelection(node.source); return;
    }
    const index = rows.findIndex(row => row.node.id === node.id);
    if (["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Home") focus(rows[0].node.id);
      else if (event.key === "End") focus(rows.at(-1)!.node.id);
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") focus(rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))].node.id);
      else if (event.key === "ArrowRight" && node.kind === "folder") {
        if (!effectiveExpanded.has(node.id)) toggle(node.id);
        else if (rows[index + 1]?.parent === node.id) focus(rows[index + 1].node.id);
      } else if (event.key === "ArrowLeft") {
        if (node.kind === "folder" && effectiveExpanded.has(node.id)) toggle(node.id);
        else if (rows[index].parent) focus(rows[index].parent!);
      }
    } else if (event.key.length === 1 && event.key !== " ") {
      const now = Date.now();
      const letter = event.key.toLowerCase();
      const previous = now - typeahead.current.at < 700 ? typeahead.current.text : "";
      typeahead.current.text = previous === letter ? letter : previous + letter;
      typeahead.current.at = now;
      const ordered = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
      const match = ordered.find(row => row.node.label.toLowerCase().startsWith(typeahead.current.text));
      if (match) { event.preventDefault(); focus(match.node.id); }
    }
  };
  const render = (nodes: SourceBrowserNode[], level = 1): React.ReactNode => nodes.map(node => {
    const folder = node.kind === "folder";
    const open = folder && effectiveExpanded.has(node.id);
    const groupId = `${treeId}-group-${encodeURIComponent(node.id)}`;
    return <li key={node.id} role="none">
      <button type="button" role="treeitem" ref={element => { if (element) elements.current.set(node.id, element); else elements.current.delete(node.id); }}
        className={`source-browser__row ${folder ? "source-browser__folder" : `research-source-item source-browser__leaf ${selectedSourceIds.includes(node.source.id) ? "selected" : ""} ${activeSourceId === node.source.id ? "active" : ""}`}`}
        data-source-id={folder ? undefined : node.source.id} data-folder-id={folder ? node.id : undefined}
        aria-label={node.label} aria-description={folder ? `${node.sourceIds.length} images` : node.path}
        aria-level={level} aria-expanded={folder ? open : undefined}
        aria-owns={folder && open ? groupId : undefined}
        aria-selected={folder ? undefined : selectedSourceIds.includes(node.source.id)}
        aria-current={!folder && activeSourceId === node.source.id ? "true" : undefined}
        tabIndex={node.id === focusId ? 0 : -1} title={folder && node.id.startsWith("root:") && !node.id.includes("/") ? `${node.path} · Separate folder import` : node.path}
        style={{ paddingInlineStart: 6 + Math.min(level - 1, 6) * 14 }}
        onFocus={() => setFocused(node.id)} onKeyDown={event => keyDown(node, event)}
        onClick={event => { setFocused(node.id); if (folder) toggle(node.id); else onActivate(node.source, event, visibleIds); }}>
        {folder ? <><ChevronRight size={12} className={open ? "is-expanded" : ""} aria-hidden="true" />
          {open ? <FolderOpen size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />}</> : <FileImage size={14} className="source-browser__file-icon" aria-hidden="true" />}
        <span className="research-source-name">{node.label}</span>
        {folder && <span className="source-browser__count" aria-label={`${node.sourceIds.length} images`}>{node.sourceIds.length}</span>}
      </button>
      {folder && open && <ul role="group" id={groupId}>{render(node.children, level + 1)}</ul>}
    </li>;
  });
  return <div className="source-browser" ref={container}>
    <div className="source-browser__search"><Search size={14} aria-hidden="true" />
      <input type="search" aria-label="Search images and folders" placeholder="Find images or folders" value={query} onChange={event => search(event.target.value)} />
      {query && <button type="button" aria-label="Clear image search" onClick={() => search("")}><X size={13} /></button>}
    </div>
    <div className="source-browser__toolbar"><div role="group" aria-label="Image list view">
      <button type="button" aria-pressed={treeMode} onClick={() => setMode("tree")}>Folder tree</button>
      <button type="button" aria-pressed={!treeMode} onClick={() => setMode("flat")}>Flat list</button>
    </div><button type="button" aria-label="Reveal current image" title="Reveal current image" disabled={!activeSourceId} onClick={() => {
      if (activeSourceId) pendingReveal.current = { id: activeSourceId, focus: true };
      search(""); setExpanded(previous => new Set([...previous, ...ancestors]));
      if (activeSourceId) setFocused(`image:${activeSourceId}`);
    }}><LocateFixed size={14} aria-hidden="true" /></button></div>
    {treeMode ? <ul role="tree" aria-label="Study images" aria-description="Use arrow keys to browse, Space to select images, and Enter to open an image."
      aria-multiselectable="true" className="source-browser__tree">{render(filtered)}</ul>
      : <FlatSources {...props} allSources={sources} sources={sources.filter(source => sourceDisplayPath(source, sources).toLowerCase().includes(query.trim().toLowerCase()))}
        reorderEnabled={!searching && !props.reorderDisabled} />}
    {searching && <p className="source-browser__search-status" role="status">{sources.filter(source => sourceDisplayPath(source, sources).toLowerCase().includes(query.trim().toLowerCase())).length || "No"} matching images</p>}
  </div>;
}
