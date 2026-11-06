import { BookOpen, Boxes, Check, ChevronRight, Eye, Palette, Power, Save, Search, Server, Waypoints, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { InterfaceTextSize, LociTheme, UserPreferences } from "./preferences";
import CapabilityOverview from "./CapabilityOverview";
import ComputeSettings from "./ComputeSettings";
import type { ResearchDesktopApi } from "../shared/research-contracts";
import "./SettingsDialog.css";

interface SettingsDialogProps {
  preferences: UserPreferences;
  onChange: (preferences: UserPreferences) => void;
  onClose: () => void;
  onQuit: () => void;
  onOpenGuide?: (sectionId?: string) => void;
  computeApi?: ResearchDesktopApi;
  initialPage?: SettingsPage;
}

export type SettingsPage = "appearance" | "viewing" | "saving" | "capabilities" | "compute" | "guide" | "agents";
const pages: Array<{ id: SettingsPage; label: string; icon: typeof Palette }> = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "viewing", label: "Viewing & help", icon: Eye },
  { id: "saving", label: "Saving & export", icon: Save },
  { id: "agents", label: "External agents", icon: Waypoints },
  { id: "capabilities", label: "Capabilities", icon: Boxes },
  { id: "compute", label: "Compute", icon: Server },
  { id: "guide", label: "User guide", icon: BookOpen },
];
const themeOptions: Array<{ id: LociTheme; label: string; note: string }> = [
  { id: "graphite", label: "Graphite", note: "Warm neutral · mineral teal" },
  { id: "midnight", label: "Midnight", note: "Cool slate · spectral blue" },
  { id: "paper", label: "Paper", note: "Soft light · deep teal" },
  { id: "aurora", label: "Aurora", note: "Indigo · lilac" },
  { id: "ember", label: "Ember", note: "Warm charcoal · apricot" },
  { id: "lagoon", label: "Lagoon", note: "Cool porcelain · ocean blue" },
  { id: "fiji", label: "FIJI", note: "Classic Java/ImageJ · Retro 2000s" },
];

const settingIndex: Array<{ page: SettingsPage; target: string; title: string; description: string; keywords?: string }> = [
  { page: "appearance", target: "theme", title: "Application theme", description: "Seven palettes for the workbench interface.", keywords: "graphite midnight paper aurora ember lagoon fiji dark light colors colours" },
  { page: "appearance", target: "font", title: "Interface font", description: "System, Arial or Verdana. No font download." },
  { page: "appearance", target: "text", title: "Interface text size", description: "Standard or large text across the workspace.", keywords: "readability accessibility" },
  { page: "appearance", target: "motion", title: "Motion", description: "Follow system settings or reduce interface transitions.", keywords: "animation accessibility" },
  { page: "viewing", target: "viewer", title: "Scale bar and navigator", description: "Calibrated scale bars and a large-image overview.", keywords: "viewer navigation" },
  { page: "viewing", target: "guidance", title: "Contextual guidance", description: "Explanations beside unfamiliar controls.", keywords: "help tooltips" },
  { page: "saving", target: "dpi", title: "Rendered figure resolution", description: "Default PNG and TIFF metadata resolution, 72–1200 DPI.", keywords: "export print image" },
  { page: "agents", target: "agent-follow", title: "Follow agent by default", description: "Initial view-following behavior in a new workspace.", keywords: "assistant codex sessions" },
  { page: "agents", target: "agent-activity", title: "Expand activity records", description: "Show provenance when activity entries first appear.", keywords: "audit evidence assistant history" },
  { page: "capabilities", target: "capabilities", title: "Supported capabilities", description: "Source formats, dimensions and configured analysis options.", keywords: "2d 3d volume mpr medical microscopy pathology models limits" },
  { page: "compute", target: "compute", title: "Compute targets", description: "Configured local and remote execution resources.", keywords: "cluster ssh scheduler runtime cpu gpu" },
  { page: "guide", target: "guide", title: "Offline user guide", description: "Viewing, analysis, review, recovery and export.", keywords: "manual instructions documentation" },
];
function categorySummary(page: SettingsPage, preferences: UserPreferences): string {
  if (page === "appearance") return `${themeOptions.find(item => item.id === preferences.theme)?.label ?? preferences.theme} · ${preferences.textSize === "large" ? "Large text" : "Standard text"}`;
  if (page === "viewing") return preferences.viewer.contextualHelp ? "Guidance on" : "Guidance off";
  if (page === "saving") return `${preferences.figureDpi} DPI figures`;
  if (page === "agents") return preferences.agent.followByDefault ? "Follow by default" : "Follow off by default";
  if (page === "capabilities") return "Formats and limits";
  if (page === "compute") return "Local and remote";
  return "Available offline";
}

function moveChoice(event: React.KeyboardEvent<HTMLElement>, selector: string): void {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)];
  if (!choices.length) return;
  const current = choices.indexOf(document.activeElement as HTMLButtonElement);
  const backwards = event.key === "ArrowLeft" || event.key === "ArrowUp";
  const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 :
    (Math.max(0, current) + (backwards ? choices.length - 1 : 1)) % choices.length;
  event.preventDefault(); choices[next].focus(); choices[next].click();
}

function ChoiceButton({ checked, label, note, onClick }: {
  checked: boolean; label: string; note?: string; onClick: () => void;
}): React.JSX.Element {
  return <button className={`settings-choice ${checked ? "is-selected" : ""}`} type="button"
    role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1} onClick={onClick}>
    <span className="settings-choice-copy"><strong>{label}</strong>{note && <span>{note}</span>}</span>
    {checked && <Check size={15} aria-hidden="true" />}
  </button>;
}

function ToggleRow({ checked, label, note, onChange, target }: {
  checked: boolean; label: string; note: string; onChange: (checked: boolean) => void; target?: string;
}): React.JSX.Element {
  return <label className="settings-toggle-row" data-setting={target}><span><strong>{label}</strong><small>{note}</small></span>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span className="settings-checkbox" aria-hidden="true" /></label>;
}

export default function SettingsDialog({ preferences, onChange, onClose, onQuit, onOpenGuide, computeApi, initialPage }:
  SettingsDialogProps): React.JSX.Element {
  const [page, setPage] = useState<SettingsPage>(initialPage ?? "appearance");
  const [query, setQuery] = useState("");
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = settingIndex.filter(item => terms.every(term => `${item.title} ${item.description} ${item.keywords ?? ""}`.toLowerCase().includes(term)));
  useEffect(() => {
    if (!focusTarget || terms.length) return;
    const target = pane.current?.querySelector<HTMLElement>(`[data-setting="${focusTarget}"]`);
    target?.scrollIntoView?.({ block: "nearest" });
    const control = target?.querySelector<HTMLElement>("input,select,button,[tabindex='0']");
    (control ?? pane.current)?.focus();
    setFocusTarget(null);
  }, [page, focusTarget, terms.length]);
  const [dpiDraft, setDpiDraft] = useState(String(preferences.figureDpi));
  const [dpiError, setDpiError] = useState(false);
  const dpiDirty = useRef(false);
  const dpiHelpId = useId();
  const dpiErrorId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!dpiDirty.current) setDpiDraft(String(preferences.figureDpi));
  }, [preferences.figureDpi]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
      ) ?? [])].filter((item) => item.tabIndex >= 0).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, []);
  const setTheme = (theme: LociTheme) => onChange({ ...preferences, theme });
  const setTextSize = (textSize: InterfaceTextSize) => onChange({ ...preferences, textSize });
  const setViewer = (key: keyof UserPreferences["viewer"], value: boolean) => onChange({
    ...preferences, viewer: { ...preferences.viewer, [key]: value },
  });
  const commitDpi = () => {
    if (!dpiDirty.current) return;
    const dpi = Number(dpiDraft);
    if (dpiDraft.trim() && Number.isInteger(dpi) && dpi >= 72 && dpi <= 1200) {
      dpiDirty.current = false;
      setDpiError(false);
      setDpiDraft(String(dpi));
      onChange({ ...preferences, figureDpi: dpi });
    } else setDpiError(true);
  };
  const activeLabel = pages.find((item) => item.id === page)!.label;
  return <div className="modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onCloseRef.current();
  }}>
    <section ref={dialog} className="settings-dialog settings-shell" role="dialog" aria-modal="true"
      aria-labelledby="settings-title">
      <header className="dialog-header settings-header"><div>
        <h2 id="settings-title">Settings</h2></div>
        <label className="settings-search"><Search size={16} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="Search settings" placeholder="Find a setting…" value={query}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} />
          {query && <button type="button" aria-label="Clear settings search" onClick={() => { setQuery(""); searchInput.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}
        </label>
        <button ref={closeButton} className="button button-quiet icon-button" type="button"
          aria-label="Close settings" onClick={() => onCloseRef.current()}><X size={16} /></button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings categories" role="tablist"
          aria-orientation="vertical" onKeyDown={(event) => moveChoice(event, "[role='tab']")}>
          {pages.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab"
            id={`settings-tab-${id}`} aria-label={label} aria-selected={!terms.length && page === id} aria-controls="settings-active-panel"
            tabIndex={page === id ? 0 : -1} onClick={() => { setPage(id); setQuery(""); }}>
            <Icon size={17} strokeWidth={1.5} aria-hidden="true" /><span><strong>{label}</strong><small>{categorySummary(id, preferences)}</small></span></button>)}
        </nav>
        <div ref={pane} className="settings-pane" role="tabpanel" id="settings-active-panel"
          aria-labelledby={terms.length ? "settings-search-title" : `settings-tab-${page}`} tabIndex={0}>
          {terms.length > 0 ? <div className="settings-search-results"><div className="settings-pane-heading"><h3 id="settings-search-title">Search settings</h3>
            <p role="status">{matches.length ? `${matches.length} matching ${matches.length === 1 ? "setting" : "settings"}` : "No matching settings. Try a tool, display option or format."}</p></div>
            <ul>{matches.map(item => <li key={`${item.page}:${item.title}`}><button type="button" onClick={() => { setPage(item.page); setQuery(""); setFocusTarget(item.target); }}>
              <span><strong>{item.title}</strong><span>{item.description}</span><small>{pages.find(page => page.id === item.page)?.label}</small></span><ChevronRight size={16} aria-hidden="true" />
            </button></li>)}</ul></div> : <>
          {page === "appearance" && <>
            <div className="settings-pane-heading"><h3>{activeLabel}</h3></div>
            <label className="settings-select-row" data-setting="theme"><span>Theme<small>{themeOptions.find(item => item.id === preferences.theme)?.note}</small></span>
              <select aria-label="Application theme" value={preferences.theme}
                onChange={(event) => setTheme(event.target.value as LociTheme)}>
                {themeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <label className="settings-select-row" data-setting="font">Interface font
              <select aria-label="Interface font" value={preferences.font ?? "system"}
                onChange={(event) => onChange({ ...preferences, font: event.target.value as UserPreferences["font"] })}>
                <option value="system">System</option><option value="arial">Arial</option><option value="verdana">Verdana</option>
              </select>
            </label>
            <fieldset data-setting="text"><legend>Interface text</legend><div className="inline-choice-group" role="radiogroup"
              aria-label="Interface text size" onKeyDown={(event) => moveChoice(event, "[role='radio']")}>
              <ChoiceButton checked={preferences.textSize === "standard"} label="Standard"
                onClick={() => setTextSize("standard")} />
              <ChoiceButton checked={preferences.textSize === "large"} label="Large"
                onClick={() => setTextSize("large")} />
            </div></fieldset>
            <fieldset data-setting="motion"><legend>Motion</legend><div className="inline-choice-group" role="radiogroup"
              aria-label="Interface motion" onKeyDown={(event) => moveChoice(event, "[role='radio']")}>
              <ChoiceButton checked={preferences.motion === "system"} label="Follow system"
                note="Use system preference" onClick={() => onChange({ ...preferences, motion: "system" })} />
              <ChoiceButton checked={preferences.motion === "reduced"} label="Reduce motion"
                note="Limit transitions" onClick={() => onChange({ ...preferences, motion: "reduced" })} />
            </div></fieldset>
          </>}
          {page === "viewing" && <><div className="settings-pane-heading"><h3>{activeLabel}</h3></div><div className="settings-list" data-setting="viewer">
            <ToggleRow checked={preferences.viewer.showScaleBar} label="Viewer scale bar"
              note="Requires physical calibration."
              onChange={(value) => setViewer("showScaleBar", value)} />
            <ToggleRow checked={preferences.viewer.showNavigator} label="Overview navigator"
              note="Full-image overview for large sources."
              onChange={(value) => setViewer("showNavigator", value)} />
            <ToggleRow checked={preferences.viewer.contextualHelp} label="Contextual guidance" target="guidance"
              note="Explanations beside unfamiliar controls."
              onChange={(value) => setViewer("contextualHelp", value)} />
          </div></>}
          {page === "saving" && <><div className="settings-pane-heading"><h3>{activeLabel}</h3></div>
            <div className="settings-number-field" data-setting="dpi"><label htmlFor={dpiHelpId + "-input"}>
              <strong>Rendered figure resolution</strong>
              <small id={dpiHelpId}>PNG and TIFF metadata · 72–1200 DPI</small></label>
              <input id={dpiHelpId + "-input"} aria-label="Default figure DPI" type="text"
                inputMode="numeric" value={dpiDraft} aria-invalid={dpiError}
                aria-describedby={dpiError ? `${dpiHelpId} ${dpiErrorId}` : dpiHelpId}
                onChange={(event) => {
                  dpiDirty.current = true;
                  setDpiDraft(event.target.value);
                  setDpiError(false);
                }} onBlur={commitDpi} onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); commitDpi(); }
                  if (event.key === "Escape" && dpiDirty.current) {
                    event.preventDefault(); event.stopPropagation();
                    dpiDirty.current = false;
                    setDpiDraft(String(preferences.figureDpi)); setDpiError(false);
                  }
                }} />
              {dpiError && <p className="settings-field-error" id={dpiErrorId} role="alert">
                Enter a whole number from 72 to 1200. Escape restores {preferences.figureDpi} DPI.
              </p>}
            </div>
            <dl className="settings-explainers"><div><dt>Rendered figures</dt>
              <dd>PNG8 and TIFF16 use the current display; scale bars and channel keys sit outside source pixels.</dd></div>
              <div><dt>Derived results</dt><dd>Measurements, labels, tables and method records use the reviewed result revision.</dd></div>
              <div><dt>Recoverable local sessions</dt><dd>Unsaved work stays local. Save as names a study without copying source images.</dd></div></dl>
          </>}
          {page === "agents" && <><div className="settings-pane-heading"><h3>External agents</h3><p>Choose how agent work appears in your workspace.</p></div>
            <div className="settings-list" data-setting="agent-defaults">
              <ToggleRow checked={preferences.agent.followByDefault} label="Follow agent by default" target="agent-follow"
                note="New workspaces follow inspected views. Change the current session in the agent drawer."
                onChange={value => onChange({ ...preferences, agent: { ...preferences.agent, followByDefault: value } })} />
              <ToggleRow checked={preferences.agent.expandActivityDetails} label="Expand activity records" target="agent-activity"
                note="Newly shown entries include their provenance. Each record can still be collapsed."
                onChange={value => onChange({ ...preferences, agent: { ...preferences.agent, expandActivityDetails: value } })} />
            </div>
            <p className="settings-boundary-note">Access to sources, actions and result review is granted per connection in the workspace.</p>
            <button type="button" className="settings-guide-link" disabled={!onOpenGuide} onClick={() => onOpenGuide?.("work-with-external-agents")}>Read the agent workflow<ChevronRight size={15} aria-hidden="true" /></button>
          </>}
          {page === "capabilities" && <><div className="settings-pane-heading" data-setting="capabilities"><h3>{activeLabel}</h3></div><CapabilityOverview /></>}
          {page === "compute" && <><div className="settings-pane-heading" data-setting="compute"><h3>{activeLabel}</h3></div><ComputeSettings api={computeApi} /></>}
          {page === "guide" && <><div className="settings-pane-heading" data-setting="guide"><h3>{activeLabel}</h3>
            <p>Viewing, analysis, review, recovery and export.</p></div>
            <div className="settings-guide-card"><BookOpen size={22} /><div><strong>Using Loci</strong>
              <p>Bundled offline manual.</p></div>
              <button className="button button-primary" type="button" disabled={!onOpenGuide}
                onClick={() => onOpenGuide?.()}>Open user guide</button></div>
            <nav className="settings-guide-topics" aria-label="Guide topics">{[
              ["read-the-workspace", "Find your way around"], ["work-with-external-agents", "Work with an external agent"],
              ["compose-and-reuse-workflows", "Reuse and continue workflows"], ["inspect-scalar-volumes-and-mpr", "Inspect volumes and linked slices"],
              ["review-batch-and-export-results", "Review and export exact results"],
            ].map(([id, label]) => <button key={id} type="button" disabled={!onOpenGuide} onClick={() => onOpenGuide?.(id)}>{label}<ChevronRight size={15} aria-hidden="true" /></button>)}</nav>
          </>}
          </>}
        </div>
      </div>
      <footer className="dialog-footer"><button className="button button-quiet button-danger-quiet"
        type="button" onClick={onQuit}><Power size={14} />Quit Loci</button>
        <button className="button button-primary" type="button" onClick={() => onCloseRef.current()}>Done</button></footer>
    </section>
  </div>;
}
