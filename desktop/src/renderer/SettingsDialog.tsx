import { BookOpen, Boxes, Eye, Palette, Power, Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { InterfaceTextSize, LociTheme, UserPreferences } from "./preferences";
import CapabilityOverview from "./CapabilityOverview";
import "./SettingsDialog.css";

interface SettingsDialogProps {
  preferences: UserPreferences;
  onChange: (preferences: UserPreferences) => void;
  onClose: () => void;
  onQuit: () => void;
  onOpenGuide?: () => void;
}

type SettingsPage = "appearance" | "viewing" | "saving" | "capabilities" | "guide";
const pages: Array<{ id: SettingsPage; label: string; icon: typeof Palette }> = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "viewing", label: "Viewing & help", icon: Eye },
  { id: "saving", label: "Saving & export", icon: Save },
  { id: "capabilities", label: "Capabilities", icon: Boxes },
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

function ChoiceButton({ checked, label, note, onClick, swatch }: {
  checked: boolean; label: string; note: string; onClick: () => void; swatch?: LociTheme;
}): React.JSX.Element {
  return <button className={`settings-choice ${checked ? "is-selected" : ""}`} type="button"
    role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1} onClick={onClick}>
    {swatch && <span className={`theme-swatch is-${swatch}`} aria-hidden="true" />}
    <span className="settings-choice-copy"><strong>{label}</strong><span>{note}</span></span>
  </button>;
}

function ToggleRow({ checked, label, note, onChange }: {
  checked: boolean; label: string; note: string; onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return <label className="settings-toggle-row"><span><strong>{label}</strong><small>{note}</small></span>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span className="settings-checkbox" aria-hidden="true" /></label>;
}

export default function SettingsDialog({ preferences, onChange, onClose, onQuit, onOpenGuide }:
  SettingsDialogProps): React.JSX.Element {
  const [page, setPage] = useState<SettingsPage>("appearance");
  const [dpiDraft, setDpiDraft] = useState(String(preferences.figureDpi));
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const dpiInput = useRef<HTMLInputElement>(null);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (document.activeElement !== dpiInput.current) setDpiDraft(String(preferences.figureDpi));
  }, [preferences.figureDpi]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
      ) ?? [])].filter((item) => item.tabIndex >= 0);
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
    const dpi = Number(dpiDraft);
    if (Number.isInteger(dpi) && dpi >= 72 && dpi <= 1200) onChange({ ...preferences, figureDpi: dpi });
    else setDpiDraft(String(preferences.figureDpi));
  };
  const activeLabel = pages.find((item) => item.id === page)!.label;
  return <div className="modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onCloseRef.current();
  }}>
    <section ref={dialog} className="settings-dialog settings-shell" role="dialog" aria-modal="true"
      aria-labelledby="settings-title">
      <header className="dialog-header settings-header"><div>
        <h2 id="settings-title">Settings</h2></div>
        <button ref={closeButton} className="button button-quiet icon-button" type="button"
          aria-label="Close settings" onClick={() => onCloseRef.current()}><X size={16} /></button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings categories" role="tablist"
          aria-orientation="vertical" onKeyDown={(event) => moveChoice(event, "[role='tab']")}>
          {pages.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab"
            id={`settings-tab-${id}`} aria-selected={page === id} aria-controls="settings-active-panel"
            tabIndex={page === id ? 0 : -1} onClick={() => setPage(id)}>
            <Icon size={16} /><span>{label}</span></button>)}
        </nav>
        <div className="settings-pane" role="tabpanel" id="settings-active-panel"
          aria-labelledby={`settings-tab-${page}`} tabIndex={0}>
          {page === "appearance" && <>
            <div className="settings-pane-heading"><h3>{activeLabel}</h3><p>Adjust the workspace appearance.</p></div>
            <label className="settings-select-row">Theme
              <select aria-label="Application theme" value={preferences.theme}
                onChange={(event) => setTheme(event.target.value as LociTheme)}>
                {themeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <label className="settings-select-row">Interface font
              <select aria-label="Interface font" value={preferences.font ?? "system"}
                onChange={(event) => onChange({ ...preferences, font: event.target.value as UserPreferences["font"] })}>
                <option value="system">System</option><option value="arial">Arial</option><option value="verdana">Verdana</option>
              </select>
            </label>
            <fieldset><legend>Interface text</legend><div className="inline-choice-group" role="radiogroup"
              aria-label="Interface text size" onKeyDown={(event) => moveChoice(event, "[role='radio']")}>
              <ChoiceButton checked={preferences.textSize === "standard"} label="Standard"
                note="Balanced density" onClick={() => setTextSize("standard")} />
              <ChoiceButton checked={preferences.textSize === "large"} label="Large"
                note="Higher legibility" onClick={() => setTextSize("large")} />
            </div></fieldset>
            <fieldset><legend>Motion</legend><div className="inline-choice-group" role="radiogroup"
              aria-label="Interface motion" onKeyDown={(event) => moveChoice(event, "[role='radio']")}>
              <ChoiceButton checked={preferences.motion === "system"} label="Follow system"
                note="Use the operating system motion preference" onClick={() => onChange({ ...preferences, motion: "system" })} />
              <ChoiceButton checked={preferences.motion === "reduced"} label="Reduce motion"
                note="Minimize nonessential transitions" onClick={() => onChange({ ...preferences, motion: "reduced" })} />
            </div></fieldset>
          </>}
          {page === "viewing" && <><div className="settings-pane-heading"><h3>{activeLabel}</h3>
            <p>Control navigation aids and explanations around the image.</p></div><div className="settings-list">
            <ToggleRow checked={preferences.viewer.showScaleBar} label="Viewer scale bar"
              note="Show only when the source declares physical calibration."
              onChange={(value) => setViewer("showScaleBar", value)} />
            <ToggleRow checked={preferences.viewer.showNavigator} label="Overview navigator"
              note="Show the full-image navigator for large sources."
              onChange={(value) => setViewer("showNavigator", value)} />
            <ToggleRow checked={preferences.viewer.contextualHelp} label="Contextual guidance"
              note="Show short explanations beside unfamiliar controls."
              onChange={(value) => setViewer("contextualHelp", value)} />
          </div></>}
          {page === "saving" && <><div className="settings-pane-heading"><h3>{activeLabel}</h3>
            <p>Set publication defaults and understand what Loci saves.</p></div>
            <label className="settings-number-field"><span><strong>Rendered figure resolution</strong>
              <small>PNG and TIFF metadata; accepted range 72–1200 DPI.</small></span>
              <input ref={dpiInput} aria-label="Default figure DPI" type="number" min="72" max="1200"
                step="1" inputMode="numeric" value={dpiDraft} onChange={(event) => setDpiDraft(event.target.value)}
                onBlur={commitDpi} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
            <div className="settings-explainers"><article><strong>Rendered figures</strong>
              <p>PNG8 and TIFF16 reproduce the current display. Optional scale bars and channel keys sit in a footer outside source pixels.</p></article>
              <article><strong>Derived results</strong><p>Measurements, labels, tables, and method records export from an exact reviewed result revision.</p></article>
              <article><strong>Recoverable local sessions</strong><p>Unsaved work remains in Loci-managed local storage. Save as creates a named study without copying source images.</p></article></div>
          </>}
          {page === "capabilities" && <><div className="settings-pane-heading"><h3>{activeLabel}</h3>
            <p>Implemented routes remain bounded by source format, geometry, runtime, and review contracts.</p></div><CapabilityOverview /></>}
          {page === "guide" && <><div className="settings-pane-heading"><h3>{activeLabel}</h3>
            <p>Open the bundled manual for viewing, analysis, review, recovery, and export workflows.</p></div>
            <div className="settings-guide-card"><BookOpen size={22} /><div><strong>Using Loci</strong>
              <p>The guide is local and opens without sending source data or metadata anywhere.</p></div>
              <button className="button button-primary" type="button" disabled={!onOpenGuide}
                onClick={onOpenGuide}>Open user guide</button></div></>}
        </div>
      </div>
      <footer className="dialog-footer"><button className="button button-quiet button-danger-quiet"
        type="button" onClick={onQuit}><Power size={14} />Quit Loci</button>
        <button className="button button-primary" type="button" onClick={() => onCloseRef.current()}>Done</button></footer>
    </section>
  </div>;
}
