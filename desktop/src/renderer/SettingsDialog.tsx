import { ArrowLeft, ArrowRight, BookOpen, Boxes, Check, ChevronRight, Eye, Palette, Power, Save, Search, Server, Waypoints, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

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
  computeApi?: Pick<ResearchDesktopApi, "computeTargets">;
  initialPage?: SettingsPage;
  standalone?: boolean;
  navigationRevision?: number;
}

export type SettingsPage = "appearance" | "viewing" | "saving" | "capabilities" | "compute" | "guide" | "agents";
const pages = {
  appearance: { label: "Appearance", icon: Palette },
  viewing: { label: "Viewing & help", icon: Eye },
  saving: { label: "Saving & export", icon: Save },
  agents: { label: "External agents", icon: Waypoints },
  capabilities: { label: "Capabilities", icon: Boxes },
  compute: { label: "Compute", icon: Server },
  guide: { label: "User guide", icon: BookOpen },
} satisfies Record<SettingsPage, { label: string; icon: typeof Palette }>;

const pageGroups: Array<{ label: string; pages: SettingsPage[] }> = [
  { label: "Workbench", pages: ["appearance", "viewing", "saving"] },
  { label: "Environment", pages: ["agents", "compute"] },
  { label: "Reference", pages: ["capabilities", "guide"] },
];

const themeOptions: Array<{ id: LociTheme; label: string; note: string }> = [
  { id: "black", label: "Black", note: "True black · neutral controls" },
  { id: "graphite", label: "Graphite", note: "Warm neutral · mineral teal" },
  { id: "midnight", label: "Midnight", note: "Cool slate · spectral blue" },
  { id: "paper", label: "Paper", note: "Soft light · deep teal" },
  { id: "aurora", label: "Aurora", note: "Indigo · lilac" },
  { id: "ember", label: "Ember", note: "Warm charcoal · apricot" },
  { id: "lagoon", label: "Lagoon", note: "Cool porcelain · ocean blue" },
  { id: "fiji", label: "FIJI", note: "Classic ImageJ · slate blue" },
];

const settingIndex: Array<{ page: SettingsPage; target: string; title: string; description: string; keywords?: string }> = [
  { page: "appearance", target: "theme", title: "Application theme", description: "Choose a palette for the workbench.", keywords: `${themeOptions.map(theme => theme.label).join(" ")} dark light colors colours` },
  { page: "appearance", target: "font", title: "Interface font", description: "Choose System, Arial or Verdana." },
  { page: "appearance", target: "density", title: "Workbench density", description: "Compact tools or more space between controls.", keywords: "comfortable spacing accessibility" },
  { page: "appearance", target: "text", title: "Interface text size", description: "Standard or large text across the workspace.", keywords: "readability accessibility" },
  { page: "appearance", target: "motion", title: "Motion", description: "Follow system settings or reduce interface transitions.", keywords: "animation accessibility" },
  { page: "viewing", target: "scale-bar", title: "Viewer scale bar", description: "Show distance when the image has physical calibration.", keywords: "viewer distance measurement" },
  { page: "viewing", target: "navigator", title: "Overview navigator", description: "Show the full extent of large images.", keywords: "viewer navigation minimap" },
  { page: "viewing", target: "guidance", title: "Contextual guidance", description: "Explanations beside unfamiliar controls.", keywords: "help tooltips" },
  { page: "saving", target: "dpi", title: "Rendered figure resolution", description: "Default PNG and TIFF metadata resolution, 72–1200 DPI.", keywords: "export print image" },
  { page: "agents", target: "agent-follow", title: "Follow agent by default", description: "Initial view-following behavior in a new workspace.", keywords: "assistant codex sessions" },
  { page: "agents", target: "agent-activity", title: "Expand activity records", description: "Show provenance when activity entries first appear.", keywords: "audit evidence assistant history" },
  { page: "capabilities", target: "capabilities", title: "Supported capabilities", description: "Source formats, dimensions and configured analysis options.", keywords: "2d 3d volume mpr medical microscopy pathology models limits" },
  { page: "compute", target: "compute", title: "Compute targets", description: "Configured local and remote execution resources.", keywords: "cluster ssh scheduler runtime cpu gpu" },
  { page: "guide", target: "guide", title: "Offline user guide", description: "Viewing, analysis, review, recovery and export.", keywords: "manual instructions documentation" },
];

function moveChoice(event: React.KeyboardEvent<HTMLElement>, selector: string, activate = true): void {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)].filter(item => !item.disabled);
  if (!choices.length) return;
  const current = choices.indexOf(document.activeElement as HTMLButtonElement);
  const backwards = event.key === "ArrowLeft" || event.key === "ArrowUp";
  const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : current === -1 ? (backwards ? choices.length - 1 : 0) :
    (current + (backwards ? choices.length - 1 : 1)) % choices.length;
  event.preventDefault();
  choices[next].focus();
  choices[next].scrollIntoView?.({ block: "nearest", inline: "nearest" });
  if (activate) choices[next].click();
}

function PageHeading({ children, id, note }: { children: ReactNode; id?: string; note?: string }): React.JSX.Element {
  return <header className="settings-pane-heading"><h2 id={id}>{children}</h2>{note && <p>{note}</p>}</header>;
}

function PreferenceGroup({ title, children, target }: { title: string; children: ReactNode; target?: string }): React.JSX.Element {
  const heading = useId();
  return <section className="settings-group" aria-labelledby={heading} data-setting={target}>
    <h3 id={heading}>{title}</h3><div className="settings-list">{children}</div>
  </section>;
}

function ChoiceButton({ checked, label, onClick }: { checked: boolean; label: string; onClick: () => void }): React.JSX.Element {
  return <button className="settings-choice" type="button" role="radio" aria-label={label} aria-checked={checked}
    tabIndex={checked ? 0 : -1} onClick={onClick}>{label}</button>;
}

function ChoiceRow({ label, name = label, note, target, children }: {
  label: string; name?: string; note: string; target: string; children: ReactNode;
}): React.JSX.Element {
  const description = useId();
  return <div className="settings-row settings-choice-row" data-setting={target}>
    <span className="settings-row-copy"><strong>{label}</strong><small id={description}>{note}</small></span>
    <div className="settings-choices" role="radiogroup" aria-label={name} aria-describedby={description}
      onKeyDown={event => moveChoice(event, "[role='radio']")}>{children}</div>
  </div>;
}

function ToggleRow({ checked, label, note, onChange, target }: {
  checked: boolean; label: string; note: string; onChange: (checked: boolean) => void; target: string;
}): React.JSX.Element {
  const noteId = useId();
  return <label className="settings-row settings-toggle-row" data-setting={target}>
    <span className="settings-row-copy"><strong>{label}</strong><small id={noteId}>{note}</small></span>
    <span className="settings-toggle-control"><input type="checkbox" role="switch" aria-label={label} aria-describedby={noteId} checked={checked}
      onChange={event => onChange(event.target.checked)} />
      <span className="settings-switch" aria-hidden="true" /></span>
  </label>;
}

function ThemeChoices({ value, onChange }: { value: LociTheme; onChange: (theme: LociTheme) => void }): React.JSX.Element {
  const heading = useId();
  return <section className="settings-group settings-theme-group" aria-labelledby={heading} data-setting="theme">
    <div className="settings-theme-heading">
      <h3 id={heading}>Theme</h3>
      <select className="interface-field" aria-label="Application theme" value={value}
        onChange={event => onChange(event.target.value as LociTheme)}>
        {themeOptions.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </div>
    <div className="settings-theme-grid" role="radiogroup" aria-label="Theme previews" onKeyDown={event => moveChoice(event, "[role='radio']")}>
      {themeOptions.map(({ id, label, note }) => <button type="button" key={id} className="settings-theme-option"
        role="radio" aria-label={label} aria-checked={value === id} title={note} tabIndex={value === id ? 0 : -1} onClick={() => onChange(id)}>
        <span className="settings-theme-preview" data-preview-theme={id} aria-hidden="true">
          <span className="settings-preview-toolbar"><i /><i /><i /></span>
          <span className="settings-preview-sources"><i /><i /><i /></span>
          <span className="settings-preview-canvas"><i /><i /><i /></span>
          <span className="settings-preview-inspector"><i /><i /><i /><i /></span>
        </span>
        <span className="settings-theme-name">{label}{value === id && <Check size={14} strokeWidth={2.25} aria-hidden="true" />}</span>
      </button>)}
    </div>
  </section>;
}

type NavigationState = { pages: SettingsPage[]; index: number };

export default function SettingsDialog({ preferences, onChange, onClose, onQuit, onOpenGuide, computeApi,
  initialPage = "appearance", standalone = false, navigationRevision = 0 }: SettingsDialogProps): React.JSX.Element {
  const [history, setHistory] = useState<NavigationState>({ pages: [initialPage], index: 0 });
  const page = history.pages[history.index];
  const [query, setQuery] = useState("");
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [horizontalNav, setHorizontalNav] = useState(() => window.matchMedia?.("(max-width: 480px)").matches ?? false);
  const pane = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLUListElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const queryRef = useRef(query);
  const onCloseRef = useRef(onClose);
  const settingsTitleId = useId();
  const paneId = useId();
  const searchTitleId = useId();
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = terms.length ? settingIndex.filter(item => terms.every(term =>
    `${item.title} ${item.description} ${item.keywords ?? ""}`.toLowerCase().includes(term))) : [];
  const navigate = (nextPage: SettingsPage, target: string | null = null) => {
    setHistory(current => current.pages[current.index] === nextPage ? current :
      { pages: [...current.pages.slice(0, current.index + 1), nextPage], index: current.index + 1 });
    setQuery("");
    setFocusTarget(target);
  };
  const moveHistory = (direction: -1 | 1) => {
    setQuery("");
    setFocusTarget(null);
    setHistory(current => ({ ...current, index: Math.max(0, Math.min(current.index + direction, current.pages.length - 1)) }));
  };
  const goToSetting = (item: (typeof settingIndex)[number]) => navigate(item.page, item.target);
  const activeLabel = pages[page].label;
  const tabId = (id: SettingsPage) => `${paneId}-${id}`;

  const [dpiDraft, setDpiDraft] = useState(String(preferences.figureDpi));
  const [dpiError, setDpiError] = useState(false);
  const dpiDirty = useRef(false);
  const dpiHelpId = useId();
  const dpiErrorId = useId();
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { queryRef.current = query; }, [query]);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 480px)");
    const update = () => setHorizontalNav(media?.matches ?? false);
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    setHistory(current => current.pages[current.index] === initialPage ? current : { pages: [initialPage], index: 0 });
    setQuery("");
    setFocusTarget(null);
  }, [initialPage, navigationRevision]);
  const searching = terms.length > 0;
  useEffect(() => {
    if (pane.current) pane.current.scrollTop = 0;
    dialog.current?.querySelector<HTMLElement>("[role='tab'][aria-selected='true']")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [page, searching]);
  useEffect(() => {
    if (!focusTarget || terms.length) return;
    const target = pane.current?.querySelector<HTMLElement>(`[data-setting="${focusTarget}"]`);
    target?.scrollIntoView?.({ block: "nearest" });
    const control = target?.querySelector<HTMLElement>("input:not(:disabled),select:not(:disabled),button:not(:disabled):not([tabindex='-1']),[tabindex='0']");
    (control ?? pane.current)?.focus();
    setFocusTarget(null);
  }, [page, focusTarget, terms.length]);
  useEffect(() => { if (!dpiDirty.current) setDpiDraft(String(preferences.figureDpi)); }, [preferences.figureDpi]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (standalone) dialog.current?.querySelector<HTMLElement>("[role='tab'][aria-selected='true']")?.focus();
    else closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const shell = dialog.current;
      if (!shell || shell.closest("[hidden], [inert]")) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        if (queryRef.current) { setQuery(""); searchInput.current?.focus(); }
        else onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const focusable = [...shell.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]:not([tabindex='-1'])",
      )].filter(item => item.tabIndex >= 0 && !item.closest("[hidden], [inert]") &&
        (!item.closest("details:not([open])") || Boolean(item.closest("summary"))));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, [standalone]);
  const setTheme = (theme: LociTheme) => { if (theme !== preferences.theme) onChange({ ...preferences, theme }); };
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

  return <section ref={dialog} className={`settings-shell${standalone ? " settings-shell--standalone" : ""}`} role="dialog"
    aria-modal={standalone ? undefined : true} aria-labelledby={settingsTitleId}>
    <header className="settings-chrome">
      <div role="group" aria-label="Settings history">
        <button type="button" className="settings-icon-button" aria-label={history.index ? "Previous settings page" : "Back to workspace"}
          title={history.index ? "Previous settings page" : "Back to workspace"} onClick={() => history.index ? moveHistory(-1) : onCloseRef.current()}>
          <ArrowLeft size={17} aria-hidden="true" /></button>
        <button type="button" className="settings-icon-button" aria-label="Next settings page" title="Next settings page"
          disabled={history.index === history.pages.length - 1} onClick={() => moveHistory(1)}><ArrowRight size={17} aria-hidden="true" /></button>
      </div>
      <button ref={closeButton} className="settings-icon-button" type="button" aria-label="Close settings" title="Close settings (Esc)"
        onClick={() => onCloseRef.current()}><X size={17} aria-hidden="true" /></button>
    </header>
    <div className="settings-layout">
      <aside className="settings-sidebar">
        <div className="settings-sidebar-heading">
          <h1 id={settingsTitleId}>Settings</h1>
          <label className="settings-search"><Search size={16} aria-hidden="true" />
            <input ref={searchInput} type="search" aria-label="Search settings" placeholder="Find a setting…" value={query}
              onChange={event => setQuery(event.target.value)} onKeyDown={event => {
                if (event.key === "Enter" && matches[0]) { event.preventDefault(); goToSetting(matches[0]); }
                else if (["ArrowDown", "ArrowUp"].includes(event.key) && matches.length) {
                  event.preventDefault();
                  const results = searchResults.current?.querySelectorAll<HTMLButtonElement>("button");
                  results?.[event.key === "ArrowDown" ? 0 : results.length - 1]?.focus();
                }
              }} />
            {query && <button type="button" className="settings-icon-button" aria-label="Clear settings search" onClick={() => {
              setQuery(""); searchInput.current?.focus();
            }}><X size={14} aria-hidden="true" /></button>}
          </label>
        </div>
        <nav className="settings-nav" aria-label="Settings categories" role="tablist" aria-orientation={horizontalNav ? "horizontal" : "vertical"}
          onKeyDown={event => moveChoice(event, "[role='tab']")}>
          {pageGroups.map(group => <div key={group.label} role="group" aria-label={group.label} className="settings-nav-group">
            <p aria-hidden="true">{group.label}</p>
            {group.pages.map(id => {
              const { label, icon: Icon } = pages[id];
              return <button key={id} type="button" role="tab" id={tabId(id)} aria-label={label}
                aria-selected={!terms.length && page === id} aria-controls={paneId} tabIndex={page === id ? 0 : -1}
                onClick={() => navigate(id)}><Icon size={17} strokeWidth={1.65} aria-hidden="true" />{label}</button>;
            })}
          </div>)}
        </nav>
      </aside>
      <div ref={pane} className="settings-pane" role="tabpanel" id={paneId}
        aria-labelledby={terms.length ? searchTitleId : tabId(page)} tabIndex={0}>
        <div className="settings-content">
          {terms.length > 0 ? <div className="settings-search-results">
            <PageHeading id={searchTitleId}>Search settings</PageHeading>
            <p role="status">{matches.length ? `${matches.length} matching ${matches.length === 1 ? "setting" : "settings"}` :
              "No matching settings. Try a shorter search or browse the categories."}</p>
            {!!matches.length && <ul ref={searchResults} onKeyDown={event => moveChoice(event, "button", false)}>
              {matches.map(item => <li key={`${item.page}:${item.title}`}>
                <button type="button" onClick={() => goToSetting(item)}>
                  <span><strong>{item.title}</strong><small>{item.description}</small></span>
                  <span className="settings-search-category">{pages[item.page].label}<ChevronRight size={15} aria-hidden="true" /></span>
                </button>
              </li>)}
            </ul>}
          </div> : <>
            <PageHeading note={page === "agents" ? "Choose how agent work appears in your workspace." : undefined}>{activeLabel}</PageHeading>
            {page === "appearance" && <>
              <ThemeChoices value={preferences.theme} onChange={setTheme} />
              <PreferenceGroup title="Interface">
                <label className="settings-row" data-setting="font">
                  <span className="settings-row-copy"><strong>Interface font</strong><small>Choose a font for application controls and text.</small></span>
                  <select className="interface-field" aria-label="Interface font" value={preferences.font ?? "system"}
                    onChange={event => onChange({ ...preferences, font: event.target.value as UserPreferences["font"] })}>
                    <option value="system">System</option><option value="arial">Arial</option><option value="verdana">Verdana</option>
                  </select>
                </label>
                <ChoiceRow label="Workbench density" note="Adjust tool sizes and spacing around the image." target="density">
                  <ChoiceButton checked={preferences.density === "compact"} label="Compact" onClick={() => onChange({ ...preferences, density: "compact" })} />
                  <ChoiceButton checked={preferences.density === "comfortable"} label="Comfortable" onClick={() => onChange({ ...preferences, density: "comfortable" })} />
                </ChoiceRow>
                <ChoiceRow label="Interface text" name="Interface text size" note="Adjust text size across the workspace." target="text">
                  <ChoiceButton checked={preferences.textSize === "standard"} label="Standard" onClick={() => setTextSize("standard")} />
                  <ChoiceButton checked={preferences.textSize === "large"} label="Large" onClick={() => setTextSize("large")} />
                </ChoiceRow>
                <ChoiceRow label="Motion" note="Follow the system motion preference or limit transitions." target="motion">
                  <ChoiceButton checked={preferences.motion === "system"} label="Follow system" onClick={() => onChange({ ...preferences, motion: "system" })} />
                  <ChoiceButton checked={preferences.motion === "reduced"} label="Reduce motion" onClick={() => onChange({ ...preferences, motion: "reduced" })} />
                </ChoiceRow>
              </PreferenceGroup>
            </>}
            {page === "viewing" && <>
              <PreferenceGroup title="Image viewer">
                <ToggleRow checked={preferences.viewer.showScaleBar} label="Viewer scale bar" target="scale-bar"
                  note="Show distance when the image has physical calibration." onChange={value => setViewer("showScaleBar", value)} />
                <ToggleRow checked={preferences.viewer.showNavigator} label="Overview navigator" target="navigator"
                  note="Show the full extent of large images." onChange={value => setViewer("showNavigator", value)} />
              </PreferenceGroup>
              <PreferenceGroup title="On-screen help">
                <ToggleRow checked={preferences.viewer.contextualHelp} label="Contextual guidance" target="guidance"
                  note="Show explanations beside unfamiliar controls." onChange={value => setViewer("contextualHelp", value)} />
              </PreferenceGroup>
            </>}
            {page === "saving" && <>
              <PreferenceGroup title="Figure export">
                <div className="settings-row settings-number-field" data-setting="dpi">
                  <label className="settings-row-copy" htmlFor={dpiHelpId + "-input"}>
                    <strong>Rendered figure resolution</strong><small id={dpiHelpId}>PNG and TIFF metadata · 72–1200 DPI</small>
                  </label>
                  <input className="interface-field" id={dpiHelpId + "-input"} aria-label="Default figure DPI" type="text"
                    inputMode="numeric" value={dpiDraft} aria-invalid={dpiError} aria-describedby={dpiError ? `${dpiHelpId} ${dpiErrorId}` : dpiHelpId}
                    onChange={event => { dpiDirty.current = true; setDpiDraft(event.target.value); setDpiError(false); }}
                    onBlur={commitDpi} onKeyDown={event => {
                      if (event.key === "Enter") { event.preventDefault(); commitDpi(); }
                      if (event.key === "Escape" && dpiDirty.current) {
                        event.preventDefault(); event.stopPropagation();
                        dpiDirty.current = false; setDpiDraft(String(preferences.figureDpi)); setDpiError(false);
                      }
                    }} />
                  {dpiError && <p className="settings-field-error" id={dpiErrorId} role="alert">
                    Enter a whole number from 72 to 1200. Escape restores {preferences.figureDpi} DPI.
                  </p>}
                </div>
              </PreferenceGroup>
              <PreferenceGroup title="Study files">
                <dl className="settings-explainers">
                  <div><dt>Rendered figures</dt><dd>PNG8 and TIFF16 use the current display. Scale bars and channel keys sit outside source pixels.</dd></div>
                  <div><dt>Derived results</dt><dd>Measurements, labels, tables and method records use the reviewed result revision.</dd></div>
                  <div><dt>Recoverable local sessions</dt><dd>Unsaved work stays local. Save as names a study without copying source images.</dd></div>
                </dl>
              </PreferenceGroup>
            </>}
            {page === "agents" && <>
              <PreferenceGroup title="Workspace defaults">
                <ToggleRow checked={preferences.agent.followByDefault} label="Follow agent by default" target="agent-follow"
                  note="New workspaces follow inspected views. Change the current session in the agent drawer."
                  onChange={value => onChange({ ...preferences, agent: { ...preferences.agent, followByDefault: value } })} />
                <ToggleRow checked={preferences.agent.expandActivityDetails} label="Expand activity records" target="agent-activity"
                  note="New activity entries open with their provenance visible."
                  onChange={value => onChange({ ...preferences, agent: { ...preferences.agent, expandActivityDetails: value } })} />
              </PreferenceGroup>
              <p className="settings-boundary-note">Access to sources, actions and result review is granted per connection in the workspace.</p>
              <button type="button" className="button button-link settings-guide-link" disabled={!onOpenGuide} onClick={() => onOpenGuide?.("work-with-external-agents")}>
                Read the agent workflow<ChevronRight size={15} aria-hidden="true" />
              </button>
            </>}
            {page === "capabilities" && <div data-setting="capabilities"><CapabilityOverview /></div>}
            {page === "compute" && <div data-setting="compute"><ComputeSettings api={computeApi} /></div>}
            {page === "guide" && <>
              <PreferenceGroup title="Offline guide" target="guide">
                <div className="settings-row settings-guide-intro"><span className="settings-row-copy"><strong>Using Loci</strong>
                  <small>Viewing, analysis, review, recovery and export.</small></span>
                  <button className="button button-primary" type="button" disabled={!onOpenGuide} onClick={() => onOpenGuide?.()}>Open user guide</button>
                </div>
              </PreferenceGroup>
              <PreferenceGroup title="Topics">
                <nav className="settings-guide-topics" aria-label="Guide topics">{[
                  ["read-the-workspace", "Find your way around"], ["work-with-external-agents", "Work with an external agent"],
                  ["compose-and-reuse-workflows", "Reuse and continue workflows"], ["inspect-scalar-volumes-and-mpr", "Inspect volumes and linked slices"],
                  ["review-batch-and-export-results", "Review and export exact results"],
                ].map(([id, label]) => <button key={id} type="button" disabled={!onOpenGuide} onClick={() => onOpenGuide?.(id)}>{label}<ChevronRight size={15} aria-hidden="true" /></button>)}</nav>
              </PreferenceGroup>
            </>}
          </>}
        </div>
      </div>
    </div>
    <footer className="settings-footer"><button className="button button-quiet button-danger-quiet" type="button" onClick={onQuit}>
      <Power size={14} aria-hidden="true" />Quit Loci</button>
      <button className="button button-quiet" type="button" onClick={() => onCloseRef.current()}>Done</button>
    </footer>
  </section>;
}
