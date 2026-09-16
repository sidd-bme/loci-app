import path from "node:path";

import type {
  ViewerDisplaySettings,
  ViewerExportFormat,
  ViewerExportOptions,
} from "../shared/contracts";

const SETTINGS_KEYS: Array<keyof ViewerDisplaySettings> = [
  "blackPoint",
  "whitePoint",
  "brightness",
  "contrast",
  "gamma",
  "saturation",
  "red",
  "green",
  "blue",
];

function finiteNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function validatedViewerExportOptions(value: unknown): ViewerExportOptions {
  const candidate = value as Partial<ViewerExportOptions> | null;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).some((key) => !["format", "settings"].includes(key)) ||
    !["png", "tiff"].includes(String(candidate.format)) ||
    !candidate.settings ||
    typeof candidate.settings !== "object" ||
    Array.isArray(candidate.settings) ||
    Object.keys(candidate.settings).some(
      (key) => !SETTINGS_KEYS.includes(key as keyof ViewerDisplaySettings),
    ) ||
    SETTINGS_KEYS.some((key) => !(key in candidate.settings!))
  ) {
    throw new Error("The viewer export selection is invalid.");
  }
  const settings = candidate.settings as ViewerDisplaySettings;
  for (const key of ["red", "green", "blue"] as const) {
    if (typeof settings[key] !== "boolean") {
      throw new Error(`${key} channel visibility must be a boolean.`);
    }
  }
  const blackPoint = finiteNumberInRange(settings.blackPoint, 0, 1, "Black point");
  const whitePoint = finiteNumberInRange(settings.whitePoint, 0, 1, "White point");
  if (blackPoint >= whitePoint) {
    throw new Error("Black point must be lower than white point.");
  }
  return {
    format: candidate.format as ViewerExportFormat,
    settings: {
      blackPoint,
      whitePoint,
      brightness: finiteNumberInRange(settings.brightness, -50, 50, "Brightness"),
      contrast: finiteNumberInRange(settings.contrast, 0, 200, "Contrast"),
      gamma: finiteNumberInRange(settings.gamma, 0.2, 3, "Gamma"),
      saturation: finiteNumberInRange(settings.saturation, 0, 200, "Saturation"),
      red: settings.red,
      green: settings.green,
      blue: settings.blue,
    },
  };
}

export function suggestedViewerExportFilename(
  sourceName: string,
  format: ViewerExportFormat,
): string {
  const sourceStem = path.parse(sourceName).name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80) || "image";
  return `${sourceStem}_loci_view.${format === "png" ? "png" : "tiff"}`;
}

export interface ViewerExportTarget {
  path: string;
  directory: string;
  filename: string;
  format: ViewerExportFormat;
}

export function resolvedViewerExportTarget(
  selectedPath: string,
  preferredFormat: ViewerExportFormat,
): ViewerExportTarget {
  if (typeof selectedPath !== "string" || !path.isAbsolute(selectedPath)) {
    throw new Error("The viewer export destination is invalid.");
  }
  const selectedExtension = path.extname(selectedPath).toLowerCase();
  const format = selectedExtension === ".png"
    ? "png"
    : [".tif", ".tiff"].includes(selectedExtension)
      ? "tiff"
      : selectedExtension
        ? null
        : preferredFormat;
  if (!format) {
    throw new Error("Save the rendered view as a PNG, TIF, or TIFF file.");
  }
  const resolvedPath = selectedExtension
    ? selectedPath
    : `${selectedPath}.${format === "png" ? "png" : "tiff"}`;
  return {
    path: resolvedPath,
    directory: path.dirname(resolvedPath),
    filename: path.basename(resolvedPath),
    format,
  };
}
