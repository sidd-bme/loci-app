import {
  ArchiveRestore,
  ArrowLeftRight,
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  FilePlus2,
  FolderOpen,
  ImagePlus,
  Lightbulb,
  ScanLine,
  Search,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ManagedSessionState, ManagedSessionSummary, ResearchDesktopApi, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import BrandMark from "./BrandMark";
import "./WorkbenchChrome.css";

export type WorkbenchTab = "Display" | "Annotate" | "Epidermis" | "Process" | "Analyze" | "Quantify" | "Correction" |
  "Temporal" | "Registration" | "Agent" | "Remote" | "Model" | "Study" | "Portability" | "Vendor import" | "Info";
type Group = "View" | "Annotate" | "Analyze" | "Results";
const TOOLS: Array<{ tab: WorkbenchTab; label: string; group: Group; advanced?: boolean; keywords?: string }> = [
  { tab: "Display", label: "Image & channels", group: "View" },
  { tab: "Annotate", label: "Draw & measure", group: "Annotate" },
  { tab: "Epidermis", label: "Epidermal thickness", group: "Annotate", keywords: "histology skin rete ridge transect" },
  { tab: "Correction", label: "Edit labels & ROIs", group: "Annotate" },
  { tab: "Analyze", label: "Segment & measure", group: "Analyze" },
  { tab: "Process", label: "Preprocess", group: "Analyze" },
  { tab: "Model", label: "Use a model", group: "Analyze" },
  { tab: "Quantify", label: "Fluorescence & field assay", group: "Analyze", keywords: "IL4R siRNA puncta association knockdown" },
  { tab: "Temporal", label: "Track over time", group: "Analyze" },
  { tab: "Registration", label: "Register & resample", group: "Analyze" },
  { tab: "Info", label: "Review & export", group: "Results" },
  { tab: "Study", label: "Study & batch", group: "Results" },
  { tab: "Portability", label: "Import & share results", group: "Results", advanced: true },
  { tab: "Agent", label: "Connect an assistant", group: "Analyze", advanced: true },
  { tab: "Remote", label: "Remote compute", group: "Analyze", advanced: true },
  { tab: "Vendor import", label: "Convert vendor images", group: "View", advanced: true },
];
const TOOL_HELP: Record<WorkbenchTab, string> = {
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
  const group = TOOLS.find((tool) => tool.tab === tab)?.group ?? "View";
  const reason = (target: WorkbenchTab) => {
    if (target === "Vendor import" || target === "Portability" || target === "Remote") return null;
    if (!source) return "Open an image first";
    if (target === "Correction" && !hasResult) return "Select a segmentation result to edit labels";
    if (target === "Temporal" && !hasStudyResults && (source.metadata.dimensions?.t ?? 1) < 2) return "Tracking needs a time series or timed result set";
    if (target === "Quantify" && ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "")) return "These methods need declared scalar channels";
    return null;
  };
  const visible = TOOLS.filter((tool) => search !== null ? `${tool.label} ${tool.tab} ${tool.keywords ?? ""}`.toLowerCase().includes(search.toLowerCase()) : tool.group === group && !tool.advanced);
  const groupTools = TOOLS.filter((tool) => tool.group === group && (!tool.advanced || tool.tab === tab));
  return <div className="workbench-tools">
    <nav className="task-groups" aria-label="Task groups">
      {(["View", "Annotate", "Analyze", "Results"] as Group[]).map((item) => <button key={item}
        aria-pressed={group === item} className={group === item ? "active" : ""}
        onClick={() => { onTab(TOOLS.find((tool) => tool.group === item)!.tab); setSearch(null); }}>{item}</button>)}
    </nav>
    <div className="task-tool-row">
      {search === null ? <ToolSelect
        label={`${group} tool`}
        value={tab}
        tools={groupTools.map((tool) => ({ ...tool, reason: reason(tool.tab) }))}
        onChange={onTab}
      /> : <input autoFocus aria-label="Search all tools" placeholder="Find a tool…" value={search} onChange={(event) => setSearch(event.target.value)} />}
      <button aria-label={search === null ? "Search all tools" : "Close tool search"} title="Find advanced tools, models, remote compute and assistant connections" onClick={() => setSearch(search === null ? "" : null)}>{search === null ? <Search /> : <X />}</button>
    </div>
    {search !== null && <div className="tool-search-results" role="list" aria-label="All tools">
      {visible.map((tool) => <div key={tool.tab} role="listitem"><button disabled={Boolean(reason(tool.tab))}
        title={reason(tool.tab) ?? TOOL_HELP[tool.tab]} onClick={() => { onTab(tool.tab); setSearch(null); }}>{tool.label}</button>
        {reason(tool.tab) && <small>{reason(tool.tab)}</small>}</div>)}
    </div>}
  </div>;
}

type ToolSelectItem = { tab: WorkbenchTab; label: string; reason: string | null };
type PopupPosition = { left: number; top: number; width: number; maxHeight: number; placement: "above" | "below" };

function ToolSelect({ label, value, tools, onChange }: {
  label: string; value: WorkbenchTab; tools: ToolSelectItem[]; onChange: (tab: WorkbenchTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(value);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const selectId = useId();
  const selected = tools.find((tool) => tool.tab === value) ?? tools[0];
  const enabledTools = tools.filter((tool) => !tool.reason);

  useEffect(() => setActiveTab(value), [value]);
  useEffect(() => {
    if (open) document.getElementById(`${selectId}-${activeTab}`)?.scrollIntoView?.({ block: "nearest" });
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
  useEffect(() => {
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
      const width = Math.min(320, Math.max(rect.width, 176));
      const left = Math.max(gutter, Math.min(rect.left, viewportWidth - width - gutter));
      setPosition({
        left,
        top: placement === "below" ? rect.bottom + 4 : rect.top - 4,
        width,
        maxHeight: Math.min(280, available),
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
    const current = Math.max(0, enabledTools.findIndex((tool) => tool.tab === activeTab));
    setActiveTab(enabledTools[(current + direction + enabledTools.length) % enabledTools.length].tab);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
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
  return <div className="workbench-tool-select">
    <button
      ref={triggerRef}
      type="button"
      role="combobox"
      className="workbench-tool-select__trigger"
      aria-label={label}
      aria-haspopup="listbox"
      aria-controls={open ? selectId : undefined}
      aria-activedescendant={open ? `${selectId}-${activeTab}` : undefined}
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
    >{tools.map((tool) => <button
      key={tool.tab}
      id={`${selectId}-${tool.tab}`}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={tool.tab === value}
      aria-disabled={Boolean(tool.reason)}
      className={tool.tab === activeTab ? "is-active" : ""}
      disabled={Boolean(tool.reason)}
      title={tool.reason ?? TOOL_HELP[tool.tab]}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => !tool.reason && setActiveTab(tool.tab)}
      onClick={() => select(tool.tab)}
    ><span>{tool.label}</span>{tool.reason && <small>{tool.reason}</small>}</button>)}</div>}
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

const WELCOME_TIPS = [
  {
    title: "Drag and drop to open",
    detail: "Drop images, a folder, or a saved study anywhere in this window.",
    action: "Choose images",
    kind: "files" as const,
  },
  {
    title: "Inspect a DICOM series",
    detail: "Select one conventional CT or MR series explicitly; Loci validates the series before opening it.",
    action: "Choose DICOM files",
    kind: "dicom" as const,
  },
  {
    title: "Open local multiscale data",
    detail: "Choose a local OME-NGFF 0.4 Zarr v2 store and select the image group when it is ambiguous.",
    action: "Choose OME-Zarr store",
    kind: "ome_zarr" as const,
  },
  {
    title: "Resume a saved study",
    detail: "Open a .loci-study directory to restore its source-bound workspace and review state.",
    action: "Choose study",
    kind: "study" as const,
  },
];

function updatedLabel(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "short",
  }).format(date)}`;
}

export function ImageWelcome({ api, onOpen, onStudy, onLegacy, onEmptyStudy, onConvert, state, onRecovery, onError,
  dragActive = false, busy = false }: {
  api: ResearchDesktopApi; onOpen: (kind?: "files" | "folder" | "dicom" | "ome_zarr") => void;
  onStudy: () => void; onLegacy: () => void; state: ManagedSessionState;
  onEmptyStudy?: () => void;
  onConvert?: () => void;
  onRecovery: (snapshot: ResearchSnapshot | null) => void; onError: (message: string) => void;
  dragActive?: boolean; busy?: boolean;
}) {
  const [recent, setRecent] = useState<ManagedSessionSummary[]>([]);
  const [undo, setUndo] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [tipIndex, setTipIndex] = useState(0);
  const [tipsPaused, setTipsPaused] = useState(false);

  useEffect(() => {
    if (tipsPaused || busy) return;
    const interval = window.setInterval(() => {
      setTipIndex((index) => (index + 1) % WELCOME_TIPS.length);
    }, 7000);
    return () => window.clearInterval(interval);
  }, [tipsPaused, busy]);

  useEffect(() => {
    void api.recoveryList?.().then(setRecent).catch((error) => onError(error.message));
  }, [api, state, undo, onError]);
  const keep = async (sessionId: string) => {
    try { if (api.recoveryKeep) onRecovery(await api.recoveryKeep(sessionId)); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not reopen this session."); }
  };
  const showTip = (offset: number) => setTipIndex((index) =>
    (index + offset + WELCOME_TIPS.length) % WELCOME_TIPS.length);
  const useTip = () => {
    const kind = WELCOME_TIPS[tipIndex].kind;
    if (kind === "study") onStudy();
    else onOpen(kind);
  };
  const visibleRecent = showAllRecent ? recent : recent.slice(0, 5);
  const formatShortcuts: Array<{ label: string; title: string; action: () => void }> = [
    { label: "TIFF", title: "Open TIFF or BigTIFF images", action: () => onOpen() },
    { label: "OME-TIFF", title: "Open OME-TIFF images", action: () => onOpen() },
    { label: "PNG", title: "Open PNG images", action: () => onOpen() },
    { label: "JPEG", title: "Open JPEG images", action: () => onOpen() },
    { label: "DICOM", title: "Open a conventional CT or MR DICOM series", action: () => onOpen("dicom") },
    { label: "OME-Zarr", title: "Open a local OME-NGFF 0.4 Zarr v2 store", action: () => onOpen("ome_zarr") },
    ...(onConvert ? [{ label: "Convert", title: "Convert proprietary vendor formats (CZI, ND2, LIF) to OME-TIFF / OME-Zarr", action: () => onConvert() }] : []),
  ];
  return <div className={`image-welcome${dragActive ? " is-drag-active" : ""}`} aria-busy={busy || undefined}>
    <div className="welcome-heading"><WelcomeEmblem /></div>
    <h1>{dragActive ? "Drop to open" : "Open data"}</h1>
    <p>{dragActive
      ? "Release to let Loci validate and open the selected files."
      : "Explore, annotate, quantify and analyse biomedical images locally."}</p>
    {state.status === "recoverable" && <div className="session-recovery" role="status">
      <strong>{state.title} is unavailable</strong>
      <p>{state.reason?.includes("unsafe") ? "This location cannot be opened safely. Choose the original study or an intact copy." : "The study may have moved or its drive may be disconnected."}</p>
      <button disabled={busy} onClick={onStudy}><FolderOpen /> Locate study</button>
      <span>Opening new images keeps the previous session available for recovery.</span>
    </div>}
    <div className="welcome-main-actions">
      <button aria-label="Open images" className="welcome-open" disabled={busy} onClick={() => onOpen()}><ImagePlus /><span><strong>Open images</strong><small>TIFF, OME-TIFF, PNG or JPEG</small></span></button>
      <button aria-label="Open folder" disabled={busy} onClick={() => onOpen("folder")}><FolderOpen /><span><strong>Open folder</strong><small>Discover a local collection</small></span></button>
      <button aria-label="Open study" disabled={busy} onClick={onStudy}><Database /><span><strong>Open study</strong><small>Resume a .loci-study</small></span></button>
    </div>
    <span className="welcome-drop">or drop images, a folder, or a saved study here</span>
    <div className="welcome-formats">
      <div className="welcome-options-heading"><span aria-hidden="true" /><button aria-label="More opening options" className="welcome-options-toggle" disabled={busy} aria-expanded={optionsOpen} aria-controls="welcome-opening-options" onClick={() => setOptionsOpen((open) => !open)}>More sources <ChevronDown /></button><span aria-hidden="true" /></div>
      <div className={`welcome-options-reveal${optionsOpen ? " is-open" : ""}`} id="welcome-opening-options" inert={!optionsOpen}>
        <div><div className="welcome-options-content">
          <button className="welcome-source-option" aria-label="DICOM series" disabled={busy} onClick={() => onOpen("dicom")}><ScanLine /><span><strong>DICOM series</strong><small>Medical image series</small></span></button>
          <button className="welcome-source-option" aria-label="OME-Zarr store" disabled={busy} onClick={() => onOpen("ome_zarr")}><Boxes /><span><strong>OME-Zarr store</strong><small>Multiscale array store</small></span></button>
          <button className="welcome-source-option" aria-label="Open .loci-project" disabled={busy} onClick={onLegacy}><ArchiveRestore /><span><strong>Loci project</strong><small>Import an earlier workspace</small></span></button>
          {onConvert && <button className="welcome-source-option" aria-label="Convert vendor image format" disabled={busy} onClick={onConvert}><ArrowLeftRight /><span><strong>Convert image format</strong><small>Bio-Formats: CZI, ND2, LIF…</small></span></button>}
          {onEmptyStudy && <button className="welcome-source-option" aria-label="New empty study" disabled={busy} onClick={onEmptyStudy}><FilePlus2 /><span><strong>New empty study</strong><small>Start without importing data</small></span></button>}
        </div></div>
      </div>
    </div>
    <div className="welcome-researcher-panels">
      <section className="recent-sessions" aria-labelledby="recent-work-heading">
        <header><h2 id="recent-work-heading">Recent work</h2>{recent.length > 5 && <button disabled={busy} onClick={() => setShowAllRecent((shown) => !shown)}>{showAllRecent ? "Show fewer" : "View all"}<ChevronRight /></button>}</header>
        {recent.length === 0 ? <div className="recent-empty"><ArchiveRestore /><span><strong>No recent work yet</strong><small>Opened sessions and saved studies will appear here.</small></span></div>
          : <div className="recent-list">{visibleRecent.map((item) => <div key={item.sessionId}>
            <button aria-label={item.title} disabled={busy || item.status !== "ready"} onClick={() => void keep(item.sessionId)}><span>{item.title}</span><small>{item.storage === "managed" ? "Autosaved session" : "Saved study"}{item.status === "recoverable" ? " · unavailable" : ""}</small></button>
            {updatedLabel(item.updatedAt) && <time dateTime={item.updatedAt}>{updatedLabel(item.updatedAt)}</time>}
            {item.canDiscard && <button disabled={busy} aria-label={`Discard ${item.title}`} title="Move this managed session aside; undo is available" onClick={() => {
              void api.recoveryDiscard?.(item.sessionId).then((receipt) => setUndo(receipt.undoToken)).catch((error) => onError(error.message));
            }}><X /></button>}
          </div>)}</div>}
      </section>
      <section className="welcome-tips" role="region" aria-label="Research tips" tabIndex={0}
        onPointerEnter={() => setTipsPaused(true)}
        onPointerLeave={() => setTipsPaused(false)}
        onFocusCapture={() => setTipsPaused(true)}
        onBlurCapture={() => setTipsPaused(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") { event.preventDefault(); showTip(-1); }
          if (event.key === "ArrowRight") { event.preventDefault(); showTip(1); }
          if (event.key === "Home") { event.preventDefault(); setTipIndex(0); }
          if (event.key === "End") { event.preventDefault(); setTipIndex(WELCOME_TIPS.length - 1); }
        }}>
        <header><h2><Lightbulb /> Research tip</h2><div><span>{tipIndex + 1} / {WELCOME_TIPS.length}</span><button aria-label="Previous tip" onClick={() => showTip(-1)}><ChevronLeft /></button><button aria-label="Next tip" onClick={() => showTip(1)}><ChevronRight /></button></div></header>
        <div className="welcome-tip-content" aria-live="polite"><strong>{WELCOME_TIPS[tipIndex].title}</strong><p>{WELCOME_TIPS[tipIndex].detail}</p><button disabled={busy} onClick={useTip}>{WELCOME_TIPS[tipIndex].action}</button></div>
        <div className="welcome-format-shortcuts" aria-label="Supported source shortcuts">{formatShortcuts.map((format) => <button key={format.label} disabled={busy} title={format.title} onClick={format.action}>{format.label}</button>)}</div>
      </section>
    </div>
    {undo && <div role="status">Session discarded. <button disabled={busy} onClick={() => {
      void api.recoveryUndo?.(undo).then(async () => { setUndo(null); onRecovery(await api.getSnapshot()); }).catch((error) => onError(error.message));
    }}>Undo</button></div>}
  </div>;
}
