import { useEffect, useLayoutEffect, useState } from "react";
import type { SettingsWindowApi, SettingsWindowNavigation } from "../shared/settings-window-api";
import SettingsDialog from "./SettingsDialog";
import UserGuideDialog from "./UserGuideDialog";
import { useUserPreferences } from "./use-user-preferences";

export function NativeSettingsWindow({ api }: { api: SettingsWindowApi }) {
  const [preferences, changePreferences, saveError] = useUserPreferences();
  const [route, setRoute] = useState<SettingsWindowNavigation | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    document.documentElement.classList.add("settings-window-root");
    document.title = "Loci Settings";
    return () => document.documentElement.classList.remove("settings-window-root");
  }, []);
  useEffect(() => {
    let active = true;
    let latest = -1;
    const navigate = (next: SettingsWindowNavigation) => {
      if (!active || next.revision <= latest) return;
      latest = next.revision;
      setError("");
      setGuide(null);
      setRoute(next);
    };
    const stop = api.onNavigate(navigate);
    void api.getNavigation().then(navigate).catch(() => {
      if (active && latest < 0) setError("Settings could not load. Close the window and open Settings again.");
    });
    return () => { active = false; stop(); };
  }, [api]);
  const close = () => { void api.close().catch(() => setError("Settings could not close. Use the window close button.")); };
  return <>
    {(error || saveError) && <div className="error-banner" role="alert">{error || saveError}</div>}
    {route && <div hidden={guide !== null} inert={guide !== null}>
      <SettingsDialog standalone preferences={preferences} computeApi={api} initialPage={route.page} navigationRevision={route.revision}
        onChange={changePreferences} onClose={close} onOpenGuide={section => setGuide(section ?? "")}
        onQuit={() => { void api.requestQuit().catch(() => setError("Loci could not open the quit request.")); }} />
    </div>}
    {guide !== null && <UserGuideDialog initialSection={guide || undefined} onClose={() => setGuide(null)} />}
  </>;
}
