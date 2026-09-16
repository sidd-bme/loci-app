export type LociTheme = "graphite" | "midnight" | "paper" | "aurora" | "ember" | "lagoon" | "fiji";
export type InterfaceTextSize = "standard" | "large";

export interface ExportPreferences {
  overlay: boolean;
  labels: boolean;
  analysis: boolean;
  instanceMeasurements: boolean;
  summary: boolean;
}

export interface UserPreferences {
  theme: LociTheme;
  textSize: InterfaceTextSize;
  font?: "system" | "arial" | "verdana";
  motion: "system" | "reduced";
  viewer: { showScaleBar: boolean; showNavigator: boolean; contextualHelp: boolean };
  figureDpi: number;
  export: ExportPreferences;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: "graphite",
  textSize: "standard",
  font: "system",
  motion: "system",
  viewer: { showScaleBar: true, showNavigator: true, contextualHelp: true },
  figureDpi: 300,
  export: {
    overlay: true,
    labels: true,
    analysis: true,
    instanceMeasurements: true,
    summary: false,
  },
};

const STORAGE_KEY = "loci.preferences.v1";
const themes = new Set<LociTheme>(["graphite", "midnight", "paper", "aurora", "ember", "lagoon", "fiji"]);
const textSizes = new Set<InterfaceTextSize>(["standard", "large"]);

export function normalizePreferences(value: unknown): UserPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return structuredClone(DEFAULT_PREFERENCES);
  }
  const candidate = value as Record<string, unknown>;
  const rawExport = candidate.export && typeof candidate.export === "object"
    ? candidate.export as Record<string, unknown>
    : {};
  const rawViewer = candidate.viewer && typeof candidate.viewer === "object" && !Array.isArray(candidate.viewer)
    ? candidate.viewer as Record<string, unknown> : {};
  const exportPreferences: ExportPreferences = {
    overlay: typeof rawExport.overlay === "boolean"
      ? rawExport.overlay
      : DEFAULT_PREFERENCES.export.overlay,
    labels: typeof rawExport.labels === "boolean"
      ? rawExport.labels
      : DEFAULT_PREFERENCES.export.labels,
    analysis: typeof rawExport.analysis === "boolean"
      ? rawExport.analysis
      : DEFAULT_PREFERENCES.export.analysis,
    instanceMeasurements: typeof rawExport.instanceMeasurements === "boolean"
      ? rawExport.instanceMeasurements
      : DEFAULT_PREFERENCES.export.instanceMeasurements,
    summary: typeof rawExport.summary === "boolean"
      ? rawExport.summary
      : DEFAULT_PREFERENCES.export.summary,
  };
  if (!Object.values(exportPreferences).some(Boolean)) {
    exportPreferences.summary = true;
  }
  return {
    theme: typeof candidate.theme === "string" && themes.has(candidate.theme as LociTheme)
      ? candidate.theme as LociTheme
      : DEFAULT_PREFERENCES.theme,
    textSize:
      typeof candidate.textSize === "string" && textSizes.has(candidate.textSize as InterfaceTextSize)
        ? candidate.textSize as InterfaceTextSize
        : DEFAULT_PREFERENCES.textSize,
    font: candidate.font === "arial" || candidate.font === "verdana" ? candidate.font : "system",
    export: exportPreferences,
    motion: candidate.motion === "reduced" ? "reduced" : "system",
    viewer: {
      showScaleBar: typeof rawViewer.showScaleBar === "boolean" ? rawViewer.showScaleBar : true,
      showNavigator: typeof rawViewer.showNavigator === "boolean" ? rawViewer.showNavigator : true,
      contextualHelp: typeof rawViewer.contextualHelp === "boolean" ? rawViewer.contextualHelp : true,
    },
    figureDpi: typeof candidate.figureDpi === "number" && Number.isInteger(candidate.figureDpi) && candidate.figureDpi >= 72 && candidate.figureDpi <= 1200
      ? candidate.figureDpi : 300,
  };
}

export function loadPreferences(storage: Pick<Storage, "getItem"> = window.localStorage): UserPreferences {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? normalizePreferences(JSON.parse(raw)) : structuredClone(DEFAULT_PREFERENCES);
  } catch {
    return structuredClone(DEFAULT_PREFERENCES);
  }
}

export function savePreferences(
  preferences: UserPreferences,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(normalizePreferences(preferences)));
}
