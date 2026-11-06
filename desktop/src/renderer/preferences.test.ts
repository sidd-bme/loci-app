import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, loadPreferences, normalizePreferences, savePreferences } from "./preferences";

describe("workbench preferences", () => {
  it("migrates and strictly persists display-only agent defaults", () => {
    expect(normalizePreferences({}).agent).toEqual({ followByDefault: false, expandActivityDetails: false });
    expect(normalizePreferences({ agent: { followByDefault: "true", expandActivityDetails: 1, allowReview: true } }).agent)
      .toEqual(DEFAULT_PREFERENCES.agent);
    expect(normalizePreferences({ agent: [true, true] }).agent).toEqual(DEFAULT_PREFERENCES.agent);
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const preferences = normalizePreferences({ agent: { followByDefault: true, expandActivityDetails: true, allowReview: true } });
    savePreferences(preferences, storage);
    expect(loadPreferences(storage)).toEqual(preferences);
    expect(loadPreferences(storage).agent).toEqual({ followByDefault: true, expandActivityDetails: true });
  });
  it("migrates existing appearance/export choices and adds safe viewer defaults", () => {
    const updated = normalizePreferences({ theme: "paper", textSize: "large", export: { summary: true, overlay: false } });
    expect(updated).toMatchObject({ theme: "paper", textSize: "large", figureDpi: 300, motion: "system",
      viewer: { showNavigator: true, showScaleBar: true, contextualHelp: true }, export: { summary: true, overlay: false } });
  });
  it("roundtrips every theme and actual viewer preference without changing exports", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    for (const theme of ["graphite", "midnight", "paper", "aurora", "ember", "lagoon", "fiji"]) {
      const value = normalizePreferences({ ...DEFAULT_PREFERENCES, theme, font: "verdana", motion: "reduced", figureDpi: 600,
        viewer: { showScaleBar: false, showNavigator: false, contextualHelp: false } });
      savePreferences(value, storage); expect(loadPreferences(storage)).toEqual(value);
    }
  });
  it("rejects malformed preferences without granting a new runtime or changing scientific state", () => {
    expect(normalizePreferences({ theme: "unknown", font: "unavailable", motion: "always", figureDpi: Infinity, viewer: { showScaleBar: "false" } })).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences({ figureDpi: 300.5 }).figureDpi).toBe(300);
    expect(loadPreferences({ getItem: () => "{bad" })).toEqual(DEFAULT_PREFERENCES);
  });
});
