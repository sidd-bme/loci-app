import { useCallback, useLayoutEffect, useState } from "react";
import { applyAppearancePreferences, loadPreferences, PREFERENCES_STORAGE_KEY, savePreferences, type UserPreferences } from "./preferences";

/** Only a user's edit writes to storage. Other windows adopt the latest saved value. */
export function useUserPreferences() {
  const [preferences, setPreferences] = useState(loadPreferences);
  const [saveError, setSaveError] = useState("");

  useLayoutEffect(() => {
    const refresh = () => setPreferences(loadPreferences());
    const changed = (event: StorageEvent) => {
      if ((event.key === null || event.key === PREFERENCES_STORAGE_KEY) &&
          (!event.storageArea || event.storageArea === window.localStorage)) refresh();
    };
    window.addEventListener("storage", changed);
    refresh();
    return () => window.removeEventListener("storage", changed);
  }, []);
  useLayoutEffect(() => applyAppearancePreferences(preferences), [preferences]);

  const change = useCallback((next: UserPreferences) => {
    try {
      savePreferences(next);
      setPreferences(next);
      setSaveError("");
    } catch {
      setSaveError("Loci could not save this preference on this device.");
    }
  }, []);
  return [preferences, change, saveError] as const;
}
