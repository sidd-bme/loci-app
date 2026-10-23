import {
  ArchiveRestore,
  ArrowLeftRight,
  Boxes,
  ChevronDown,
  ChevronRight,
  Database,
  FilePlus2,
  FolderOpen,
  ImagePlus,
  ScanLine,
  Search,
  X,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ManagedSessionState, ManagedSessionSummary, ResearchDesktopApi, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import BrandMark from "./BrandMark";
import "./WorkbenchChrome.css";

export type WorkbenchTab = "Display" | "Annotate" | "Epidermis" | "Process" | "Analyze" | "Workflow" | "Quantify" | "Population" | "Correction" |
  "Temporal" | "Registration" | "Agent" | "Remote" | "Model" | "Study" | "Portability" | "Vendor import" | "Info";
type Group = "View" | "Annotate" | "Analyze" | "Results";
const tabId = (tab: WorkbenchTab) => tab.replaceAll(" ", "-");
const ADVANCED_LABELS: Partial<Record<Group, string>> = {
  View: "Import & conversion", Analyze: "Connections", Results: "Portable results",
};
const TOOLS: Array<{ tab: WorkbenchTab; label: string; group: Group; advanced?: boolean; keywords?: string }> = [
  { tab: "Display", label: "Image & channels", group: "View" },
  { tab: "Annotate", label: "Draw & measure", group: "Annotate" },
  { tab: "Epidermis", label: "Epidermal thickness", group: "Annotate", keywords: "histology skin rete ridge transect" },
  { tab: "Correction", label: "Edit labels & ROIs", group: "Annotate" },
  { tab: "Analyze", label: "Segment & measure", group: "Analyze" },
  { tab: "Process", label: "Preprocess", group: "Analyze" },
  { tab: "Workflow", label: "Workflow builder", group: "Analyze", keywords: "pipeline automation nodes batch recipe" },
  { tab: "Model", label: "Use a model", group: "Analyze" },
  { tab: "Quantify", label: "Fluorescence & field assay", group: "Analyze", keywords: "fluorescence signal nuclei background intensity puncta association perinuclear nuclear ring enrichment" },
  { tab: "Temporal", label: "Track over time", group: "Analyze" },
  { tab: "Registration", label: "Register & resample", group: "Analyze" },
  { tab: "Info", label: "Review & export", group: "Results" },
  { tab: "Population", label: "Statistics & objects", group: "Results", keywords: "explore objects population scatter histogram filter area intensity measurements" },
  { tab: "Study", label: "Study & batch", group: "Results" },
  { tab: "Portability", label: "Import & share results", group: "Results", advanced: true },
  { tab: "Agent", label: "Connect an assistant", group: "Analyze", advanced: true },
  { tab: "Remote", label: "Remote compute", group: "Analyze", advanced: true },
  { tab: "Vendor import", label: "Convert vendor images", group: "View", advanced: true },
];
const TOOL_HELP: Record<WorkbenchTab, string> = {
  Workflow: "Build, preview and run a saved analysis workflow with exact review checkpoints.",
  Display: "Adjust display ranges, colour and channel visibility without changing source values.",
  Annotate: "Draw points, lines and regions on the source image; calibrated lengths use recorded geometry.",
  Epidermis: "Measure manual histology transects with explicit boundaries, calibration and reviewer records.",
  Correction: "Correct labels in the selected segmentation result, then review the new revision.",
  Analyze: "Choose a method, preview its settings, and create objects with measurements.",
  Process: "Build an ordered preprocessing recipe and preview its effect on a declared region.",
  Model: "Run an explicitly provisioned model with its recorded runtime, settings and validation limits.",
  Quantify: "Measure regional fluorescence, puncta and channel association in declared scalar channels.",
  Temporal: "Associate reviewed objects across time and inspect ambiguous links before export.",
  Registration: "Estimate a transform or resample onto a declared grid while preserving source geometry.",
  Population: "Explore all objects in one exact result with linked measurements, distributions and image selection.",
  Info: "Inspect provenance, record a review decision and export the selected result revision.",
  Study: "Organise sources and replicate metadata, reuse recipes and run recoverable batches.",
  Portability: "Import or export portable result bundles with source and revision bindings.",
  Agent: "Prepare explicitly granted local analysis tools for an assistant connection.",
  Remote: "Connect a configured compute host and review data-transfer consent before submitting work.",
  "Vendor import": "Inspect a supported vendor source and convert it with an explicitly installed decoder.",
};

export function WorkbenchTools({ tab, onTab, source, hasResult, hasStudyResults = hasResult }: {
  tab: WorkbenchTab; onTab: (tab: WorkbenchTab) => void; source: ResearchSource | null; hasResult: boolean; hasStudyResults?: boolean;
}) {
  const [search, setSearch] = useState<string | null>(null);
  const [activeSearchTab, setActiveSearchTab] = useState<WorkbenchTab | null>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const lastTools = useRef<Partial<Record<Group, WorkbenchTab>>>({});
  const group = TOOLS.find((tool) => tool.tab === tab)?.group ?? "View";
  useEffect(() => { lastTools.current[group] = tab; }, [group, tab]);
  const reason = (target: WorkbenchTab) => {
    if (target === "Vendor import" || target === "Portability" || target === "Remote") return null;
    if (!source) return "Open an image first";
    if (target === "Correction" && !hasResult) return "Select a segmentation result to edit labels";
    if (target === "Temporal" && !hasStudyResults && (source.metadata.dimensions?.t ?? 1) < 2) return "Tracking needs a time series or timed result set";
    if (target === "Quantify" && ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "")) return "These methods need declared scalar channels";
    return null;
  };
  const visible = TOOLS.filter((tool) => `${tool.label} ${tool.tab} ${tool.keywords ?? ""}`.toLowerCase().includes((search ?? "").trim().toLowerCase()));
  const enabledSearchTools = visible.filter((tool) => !reason(tool.tab));
  const activeSearchTool = enabledSearchTools.find((tool) => tool.tab === activeSearchTab);
  const groupTools = TOOLS.filter((tool) => tool.group === group);
  useEffect(() => {
    if (search !== null && activeSearchTool) document.getElementById(`${searchId}-${tabId(activeSearchTool.tab)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [search, searchId, activeSearchTool]);
  const closeSearch = () => {
    setSearch(null);
    setActiveSearchTab(null);
    searchToggleRef.current?.focus();
  };
  const selectTool = (next: WorkbenchTab) => {
    if (reason(next)) return;
    const selectedGroup = TOOLS.find((tool) => tool.tab === next)!.group;
    lastTools.current[selectedGroup] = next;
    onTab(next);
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!enabledSearchTools.length) return;
      const current = enabledSearchTools.findIndex((tool) => tool.tab === activeSearchTool?.tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? enabledSearchTools.length - 1
        : current < 0 ? (event.key === "ArrowDown" ? 0 : enabledSearchTools.length - 1)
        : (current + (event.key === "ArrowDown" ? 1 : -1) + enabledSearchTools.length) % enabledSearchTools.length;
      setActiveSearchTab(enabledSearchTools[next].tab);
      searchInputRef.current?.focus();
    } else if (event.key === "Enter") {
      const selected = activeSearchTool ?? enabledSearchTools[0];
      if (!selected) return;
      event.preventDefault();
      selectTool(selected.tab);
      closeSearch();
    }
  };
  return <div className="workbench-tools">
    <nav className="task-groups" aria-label="Task groups">
      {(["View", "Annotate", "Analyze", "Results"] as Group[]).map((item) => <button key={item}
        aria-pressed={group === item} className={group === item ? "active" : ""}
        onClick={() => {
          const remembered = lastTools.current[item];
          const next = remembered && !reason(remembered) ? remembered
            : TOOLS.find((tool) => tool.group === item && !tool.advanced)!.tab;
          onTab(next);
          setSearch(null);
          setActiveSearchTab(null);
        }}>{item}</button>)}
    </nav>
    <div className="task-tool-row">
      {search === null ? <ToolSelect
        label={`${group} tool`}
        value={tab}
        tools={groupTools.map((tool) => ({ ...tool, reason: reason(tool.tab) }))}
        secondaryLabel={ADVANCED_LABELS[group]}
        onChange={selectTool}
      /> : <input ref={searchInputRef} autoFocus role="combobox" aria-label="Search all tools" aria-autocomplete="list"
        aria-expanded="true" aria-controls={searchId}
        aria-activedescendant={activeSearchTool ? `${searchId}-${tabId(activeSearchTool.tab)}` : undefined}
        placeholder="Find a tool…" value={search}
        onChange={(event) => { setSearch(event.target.value); setActiveSearchTab(null); }}
        onKeyDown={onSearchKeyDown}
      />}
      <button ref={searchToggleRef} aria-label={search === null ? "Search all tools" : "Close tool search"} title="Find tools across all task groups" onClick={() => {
        if (search === null) { setSearch(""); setActiveSearchTab(null); } else closeSearch();
      }}>{search === null ? <Search /> : <X />}</button>
    </div>
    {search !== null && <>
      <div id={searchId} className="tool-search-results" role="listbox" aria-label="All tools" onKeyDown={onSearchKeyDown}>
        {visible.map((tool) => <button key={tool.tab} id={`${searchId}-${tabId(tool.tab)}`} type="button" role="option" tabIndex={-1} aria-label={tool.label}
          aria-selected={tool.tab === tab} aria-disabled={Boolean(reason(tool.tab))} disabled={Boolean(reason(tool.tab))}
          className={tool.tab === activeSearchTool?.tab ? "is-active" : ""}
          title={reason(tool.tab) ?? TOOL_HELP[tool.tab]} onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => !reason(tool.tab) && setActiveSearchTab(tool.tab)}
          onClick={() => { selectTool(tool.tab); closeSearch(); }}>
          <span>{tool.label}</span><small>{reason(tool.tab) ?? tool.group}</small>
        </button>)}
      </div>
      {!visible.length && <div className="tool-search-empty" role="status">
        <p>No tools match “{search.trim()}”.</p>
        <button type="button" onClick={() => { setSearch(""); setActiveSearchTab(null); searchInputRef.current?.focus(); }}>Clear search</button>
      </div>}
    </>}
  </div>;
}

type ToolSelectItem = { tab: WorkbenchTab; label: string; reason: string | null; advanced?: boolean };
type PopupPosition = { left: number; top: number; width: number; maxHeight: number; placement: "above" | "below" };

function ToolSelect({ label, value, tools, secondaryLabel, onChange }: {
  label: string; value: WorkbenchTab; tools: ToolSelectItem[]; secondaryLabel?: string; onChange: (tab: WorkbenchTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(value);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const selectId = useId();
  const selected = tools.find((tool) => tool.tab === value) ?? tools[0];
  const enabledTools = tools.filter((tool) => !tool.reason);

  useEffect(() => { setActiveTab(value); setOpen(false); }, [value]);
  useEffect(() => {
    if (open) document.getElementById(`${selectId}-${tabId(activeTab)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeTab, open, selectId]);
  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    return () => document.removeEventListener("pointerdown", closeFromOutside, true);
  }, [open]);
  // Reopening after a resize must never paint with the previous anchor position.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gutter = 8;
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const below = viewportHeight - rect.bottom - gutter;
      const above = rect.top - gutter;
      const placement = below >= 152 || below >= above ? "below" : "above";
      const available = Math.max(0, placement === "below" ? below : above);
      const maxWidth = Math.max(120, viewportWidth - 2 * gutter);
      const width = Math.min(maxWidth, Math.min(320, Math.max(rect.width, 176)));
      const left = Math.max(gutter, Math.min(rect.left, viewportWidth - width - gutter));
      const maxHeight = Math.min(280, Math.max(60, available));
      setPosition({
        left: Math.round(left),
        top: Math.round(placement === "below" ? rect.bottom + 4 : rect.top - 4),
        width: Math.round(width),
        maxHeight: Math.round(maxHeight),
        placement,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open]);

  const select = (next: WorkbenchTab) => {
    const item = tools.find((tool) => tool.tab === next);
    if (!item || item.reason) return;
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };
  const move = (direction: 1 | -1) => {
    if (!enabledTools.length) return;
    const current = enabledTools.findIndex((tool) => tool.tab === activeTab);
    const next = current < 0 ? (direction === 1 ? 0 : enabledTools.length - 1)
      : (current + direction + enabledTools.length) % enabledTools.length;
    setActiveTab(enabledTools[next].tab);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) setOpen(true);
      const endpoint = enabledTools[event.key === "Home" ? 0 : enabledTools.length - 1];
      if (endpoint) setActiveTab(endpoint.tab);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      select(activeTab);
    }
  };
  const renderOption = (tool: ToolSelectItem) => <button
    key={tool.tab} id={`${selectId}-${tabId(tool.tab)}`} type="button" role="option" tabIndex={-1}
    aria-selected={tool.tab === value} aria-disabled={Boolean(tool.reason)}
    className={tool.tab === activeTab ? "is-active" : ""} disabled={Boolean(tool.reason)}
    title={tool.reason ?? TOOL_HELP[tool.tab]} onMouseDown={(event) => event.preventDefault()}
    onMouseEnter={() => !tool.reason && setActiveTab(tool.tab)} onClick={() => select(tool.tab)}
  ><span>{tool.label}</span>{tool.reason && <small>{tool.reason}</small>}</button>;
  return <div className="workbench-tool-select">
    <button
      ref={triggerRef}
      type="button"
      role="combobox"
      className="workbench-tool-select__trigger"
      aria-label={label}
      aria-haspopup="listbox"
      aria-controls={open ? selectId : undefined}
      aria-activedescendant={open ? `${selectId}-${tabId(activeTab)}` : undefined}
      aria-expanded={open}
      onClick={() => setOpen((shown) => !shown)}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!popupRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    ><span>{selected?.label}</span><ChevronDown aria-hidden="true" /></button>
    {open && position && <div
      ref={popupRef}
      id={selectId}
      className={`workbench-tool-select__popup is-${position.placement}`}
      role="listbox"
      aria-label={label}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >{tools.filter((tool) => !tool.advanced).map(renderOption)}
      {tools.some((tool) => tool.advanced) && <div role="group" aria-label={secondaryLabel ?? "More tools"}>
        <div className="workbench-tool-select__section" aria-hidden="true">{secondaryLabel ?? "More tools"}</div>
        {tools.filter((tool) => tool.advanced).map(renderOption)}
      </div>}
    </div>}
  </div>;
}

function WelcomeEmblem() {
  const sequence = useRef(0);
  const [pulses, setPulses] = useState<Array<{ id: number }>>([]);
  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!preference) return;
    const clearPropagation = () => {
      if (preference.matches || document.documentElement.dataset.motion === "reduced") setPulses([]);
    };
    const observer = new MutationObserver(clearPropagation);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    preference.addEventListener?.("change", clearPropagation);
    return () => { observer.disconnect(); preference.removeEventListener?.("change", clearPropagation); };
  }, []);
  return <button className="welcome-emblem" aria-label="Activate the Loci optical phase pulse" onClick={() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced") {
      setPulses([]);
      return;
    }
    const pulse = { id: ++sequence.current };
    setPulses((old) => [...old.slice(-5), pulse]);
  }}>
    <BrandMark />
    {pulses.map((pulse) => <span key={pulse.id} className="welcome-phase-pulse" aria-hidden="true"
      data-pulse-id={pulse.id}
      onAnimationEnd={() => setPulses((old) => old.filter((item) => item.id !== pulse.id))} />)}
  </button>;
}

function updatedLabel(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "short",
  }).format(date)}`;
}

export function ImageWelcome({ api, onOpen, onStudy, onLegacy, onEmptyStudy, onConvert, onExample, state, onRecovery, onError,
  dragActive = false, busy = false }: {
  api: ResearchDesktopApi; onOpen: (kind?: "files" | "folder" | "dicom" | "ome_zarr") => void;
  onStudy: () => void; onLegacy: () => void; state: ManagedSessionState;
  onEmptyStudy?: () => void;
  onExample?: () => void;
  onConvert?: () => void;
  onRecovery: (snapshot: ResearchSnapshot | null) => void; onError: (message: string) => void;
  dragActive?: boolean; busy?: boolean;
}) {
  const [recent, setRecent] = useState<ManagedSessionSummary[]>([]);
  const [undo, setUndo] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [showAllRecent, setShowAllRecent] = useState(false);

  useEffect(() => {
    void api.recoveryList?.().then(setRecent).catch((error) => onError(error.message));
  }, [api, state, undo, onError]);
  const keep = async (sessionId: string) => {
    try { if (api.recoveryKeep) onRecovery(await api.recoveryKeep(sessionId)); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not reopen this session."); }
  };
  const visibleRecent = showAllRecent ? recent : recent.slice(0, 5);
  return <div className={`image-welcome${dragActive ? " is-drag-active" : ""}`} aria-busy={busy || undefined}>
    <div className="welcome-heading"><WelcomeEmblem /></div>
    <h1>{dragActive ? "Drop to open" : "Open data"}</h1>
    {dragActive && <p role="status">Release to let Loci validate and open the selected files.</p>}
    {state.status === "recoverable" && <div className="session-recovery" role="status">
      <strong>{state.title} is unavailable</strong>
      <p>{state.reason?.includes("unsafe") ? "This location cannot be opened safely. Choose the original study or an intact copy." : "The study may have moved or its drive may be disconnected."}</p>
      <button disabled={busy} onClick={onStudy}><FolderOpen /> Locate study</button>
      <span>Opening new images keeps the previous session available for recovery.</span>
    </div>}
    <div className="welcome-main-actions">
      <button aria-label="Open images" className="welcome-open" disabled={busy} onClick={() => onOpen()}><ImagePlus /><span>Open images</span></button>
      <button aria-label="Open folder" disabled={busy} onClick={() => onOpen("folder")}><FolderOpen /><span>Open folder</span></button>
      <button aria-label="Open study" disabled={busy} onClick={onStudy}><Database /><span>Open study</span></button>
    </div>
    <div className="welcome-secondary-actions">
      {onExample && <button disabled={busy} onClick={onExample}>Try a synthetic example</button>}
      <button aria-label="More opening options" className="welcome-options-toggle" disabled={busy} aria-expanded={optionsOpen} aria-controls="welcome-opening-options" onClick={() => setOptionsOpen((open) => !open)}>More sources <ChevronDown /></button>
    </div>
    <div className={`welcome-options-reveal${optionsOpen ? " is-open" : ""}`} id="welcome-opening-options" inert={!optionsOpen}>
      <div><div className="welcome-options-content">
        <button className="welcome-source-option" aria-label="DICOM series" disabled={busy} onClick={() => onOpen("dicom")}><ScanLine /><span><strong>DICOM series</strong><small>Medical image series</small></span></button>
        <button className="welcome-source-option" aria-label="OME-Zarr store" disabled={busy} onClick={() => onOpen("ome_zarr")}><Boxes /><span><strong>OME-Zarr store</strong><small>Multiscale array store</small></span></button>
        <button className="welcome-source-option" aria-label="Open .loci-project" disabled={busy} onClick={onLegacy}><ArchiveRestore /><span><strong>Loci project</strong><small>Import an earlier workspace</small></span></button>
        {onConvert && <button className="welcome-source-option" aria-label="Convert vendor image format" disabled={busy} onClick={onConvert}><ArrowLeftRight /><span><strong>Convert image format</strong><small>Bio-Formats: CZI, ND2, LIF…</small></span></button>}
        {onEmptyStudy && <button className="welcome-source-option" aria-label="New empty study" disabled={busy} onClick={onEmptyStudy}><FilePlus2 /><span><strong>New empty study</strong><small>Start without importing data</small></span></button>}
      </div></div>
    </div>
    <div className="welcome-researcher-panels">
      <section className="recent-sessions" aria-labelledby="recent-work-heading">
        <header><h2 id="recent-work-heading">Recent work</h2>{recent.length > 5 && <button disabled={busy} onClick={() => setShowAllRecent((shown) => !shown)}>{showAllRecent ? "Show fewer" : "View all"}<ChevronRight /></button>}</header>
        {recent.length === 0 ? <div className="recent-empty">No recent work yet</div>
          : <div className="recent-list">{visibleRecent.map((item) => <div key={item.sessionId}>
            <button aria-label={item.title} disabled={busy || item.status !== "ready"} onClick={() => void keep(item.sessionId)}><span>{item.title}</span><small>{item.storage === "managed" ? "Autosaved session" : "Saved study"}{item.status === "recoverable" ? " · unavailable" : ""}</small></button>
            {updatedLabel(item.updatedAt) && <time dateTime={item.updatedAt}>{updatedLabel(item.updatedAt)}</time>}
            {item.canDiscard && <button className="recent-discard" disabled={busy} aria-label={`Discard ${item.title}`} title="Move this managed session aside; undo is available" onClick={() => {
              void api.recoveryDiscard?.(item.sessionId).then((receipt) => setUndo(receipt.undoToken)).catch((error) => onError(error.message));
            }}><X /></button>}
          </div>)}</div>}
      </section>
    </div>
    {undo && <div role="status">Session discarded. <button disabled={busy} onClick={() => {
      void api.recoveryUndo?.(undo).then(async () => { setUndo(null); onRecovery(await api.getSnapshot()); }).catch((error) => onError(error.message));
    }}>Undo</button></div>}
  </div>;
}
