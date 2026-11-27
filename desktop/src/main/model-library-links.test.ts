// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  MODEL_LIBRARY_OFFICIAL_LINKS,
  openModelLibraryLink,
  requireModelLibraryLinkId,
  resolveModelLibraryLinkUrl,
  type ModelLibraryLinkId,
} from "./model-library-links";

describe("main-process fixed-ID model library link dispatcher", () => {
  it("opens each registered fixed-ID link with its exact pinned HTTPS URL", async () => {
    const keys = Object.keys(MODEL_LIBRARY_OFFICIAL_LINKS) as ModelLibraryLinkId[];
    expect(keys.length).toBe(48);
    expect(MODEL_LIBRARY_OFFICIAL_LINKS["care-planaria-scenario"]).toBe(
      "https://csbdeep.bioimagecomputing.com/scenarios/denoisingplanaria/",
    );
    expect(MODEL_LIBRARY_OFFICIAL_LINKS["organoidtracker-organoid-weights"]).toBe(
      "https://doi.org/10.5281/zenodo.18479952",
    );
    expect(MODEL_LIBRARY_OFFICIAL_LINKS["cellpose-github-repo"]).toBe(
      "https://github.com/MouseLand/cellpose",
    );
    expect(MODEL_LIBRARY_OFFICIAL_LINKS["stardist-github-repo"]).toBe(
      "https://github.com/stardist/stardist",
    );
    expect(MODEL_LIBRARY_OFFICIAL_LINKS["puma-baseline-repo"]).toBe(
      "https://github.com/tueimage/PUMA-challenge-baseline-track1/tree/211782054387f0d28e170ed565cdfb6e8b53d1a7",
    );
    expect(MODEL_LIBRARY_OFFICIAL_LINKS["micro-sam-bioimageio-card"]).toBe(
      "https://bioimage.io/#/artifacts/diplomatic-bug/v0",
    );
    expect(MODEL_LIBRARY_OFFICIAL_LINKS["micro-sam-upstream-registry"]).toBe(
      "https://github.com/computational-cell-analytics/micro-sam/blob/d45ab70ece93a9eb3ca1e237b9067767b0a18263/micro_sam/v1/util.py",
    );
    expect(Object.values(MODEL_LIBRARY_OFFICIAL_LINKS)).not.toContain(
      "https://doi.org/10.5281/zenodo.10524791",
    );

    for (const key of keys) {
      const openExternal = vi.fn(async () => undefined);
      const resolved = await openModelLibraryLink(key, openExternal);
      expect(resolved).toBe(MODEL_LIBRARY_OFFICIAL_LINKS[key]);
      expect(openExternal).toHaveBeenCalledExactlyOnceWith(MODEL_LIBRARY_OFFICIAL_LINKS[key]);
    }
  });

  it("rejects raw URLs, prototype properties, and unallowlisted identifiers before calling openExternal", async () => {
    const openExternal = vi.fn(async () => undefined);
    const rejectedInputs: unknown[] = [
      "",
      "   ",
      null,
      undefined,
      42,
      {},
      ["cellpose-sam-v2-checkpoint"],
      "__proto__",
      "constructor",
      "toString",
      "valueOf",
      "micro-sam-weights-zenodo",
      "https://doi.org/10.5281/zenodo.10524791",
      "cellpose-sam-v2-checkpoint?extra=1",
      "../cellpose-sam-v2-checkpoint",
      // Even an allowlisted destination passed as a raw URL must be rejected:
      MODEL_LIBRARY_OFFICIAL_LINKS["cellpose-sam-v2-checkpoint"],
      "https://bioimage.io/#/models",
      "https://evil.example/cpsam_v2",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ];

    for (const candidate of rejectedInputs) {
      expect(() => requireModelLibraryLinkId(candidate)).toThrow(
        "Choose a registered official model-library source.",
      );
      expect(() => resolveModelLibraryLinkUrl(candidate)).toThrow(
        "Choose a registered official model-library source.",
      );
      await expect(openModelLibraryLink(candidate, openExternal)).rejects.toThrow(
        "Choose a registered official model-library source.",
      );
    }
    expect(openExternal).not.toHaveBeenCalled();
  });
});
