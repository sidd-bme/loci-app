// @vitest-environment node

import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolvedViewerExportTarget,
  suggestedViewerExportFilename,
  validatedViewerExportOptions,
} from "./viewer-export";

const settings = {
  blackPoint: 0,
  whitePoint: 1,
  brightness: 0,
  contrast: 100,
  gamma: 1,
  saturation: 100,
  red: true,
  green: true,
  blue: true,
};

describe("viewer export boundary", () => {
  it("accepts a complete bounded display contract", () => {
    expect(validatedViewerExportOptions({ format: "tiff", settings })).toEqual({
      format: "tiff",
      settings,
    });
  });

  it.each([
    [{ format: "jpeg", settings }],
    [{ format: "png", settings: { ...settings, gamma: 0.19 } }],
    [{ format: "png", settings: { ...settings, red: 1 } }],
    [{ format: "png", settings: { ...settings, blackPoint: 0.8, whitePoint: 0.2 } }],
    [{ format: "png", settings: { ...settings, surprise: true } }],
    [{ format: "png", settings: { ...settings, blue: undefined } }],
  ])("rejects malformed or out-of-range contracts", (value) => {
    expect(() => validatedViewerExportOptions(value)).toThrow();
  });

  it("infers a user-typed supported extension and appends a missing one", () => {
    const base = path.resolve("/tmp", "adjusted view");
    expect(resolvedViewerExportTarget(base, "tiff")).toEqual({
      path: `${base}.tiff`,
      directory: path.dirname(base),
      filename: "adjusted view.tiff",
      format: "tiff",
    });
    expect(resolvedViewerExportTarget(`${base}.png`, "tiff").format).toBe("png");
    expect(() => resolvedViewerExportTarget(`${base}.jpg`, "png")).toThrow(
      "PNG, TIF, or TIFF",
    );
  });

  it("builds a restrained, portable default name", () => {
    expect(suggestedViewerExportFilename("Day 3 / culture?.tif", "png")).toBe(
      "culture_loci_view.png",
    );
  });
});
