import { useCallback, useEffect, useImperativeHandle, useState, type Ref } from "react";
import type { LociDesktopApi } from "../shared/contracts";
import type { ResearchDesktopApi } from "../shared/research-contracts";
import SettingsDialog, { type SettingsPage } from "./SettingsDialog";
import UserGuideDialog from "./UserGuideDialog";
import type { UserPreferences } from "./preferences";

export type WorkspaceSettingsHandle = {
  open(page?: SettingsPage): void;
  isOpen(): boolean;
};

/** Keep opening and closing Settings out of the image workbench's render path. */
export default function WorkspaceSettings({ ref, api, computeApi, preferences, onChange, preferenceError }: {
  ref: Ref<WorkspaceSettingsHandle>;
  api?: LociDesktopApi;
  computeApi?: Pick<ResearchDesktopApi, "computeTargets">;
  preferences: UserPreferences;
  onChange: (next: UserPreferences) => void;
  preferenceError: string;
}) {
  const [route, setRoute] = useState<{ page: SettingsPage; revision: number } | null>(null);
  const [guide, setGuide] = useState<{ sectionId?: string } | null>(null);

  const open = useCallback((page?: SettingsPage) => {
    setGuide(null);
    setRoute(current => current && !page ? current : {
      page: page ?? "appearance", revision: (current?.revision ?? 0) + 1,
    });
  }, []);
  const openGuide = useCallback((sectionId?: string) => setGuide({ sectionId }), []);
  useImperativeHandle(ref, () => ({ open, isOpen: () => route !== null || guide !== null }), [open, route, guide]);

  useEffect(() => api?.onSettingsRequested(open), [api, open]);
  useEffect(() => api?.onGuideRequested?.(() => openGuide()), [api, openGuide]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        open();
      } else if (event.key === "F1") {
        event.preventDefault();
        openGuide();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [open, openGuide]);

  return <>
    {route && <SettingsDialog active={!guide} preferences={preferences} computeApi={computeApi}
      onComputeStudyChanged={api?.onComputeStudyChanged}
      initialPage={route.page} navigationRevision={route.revision} preferenceError={preferenceError}
      onChange={onChange} onClose={() => setRoute(null)} onOpenGuide={openGuide}
      onQuit={() => api?.requestQuit()} />}
    {guide && <UserGuideDialog initialSection={guide.sectionId} onClose={() => setGuide(null)} />}
  </>;
}
