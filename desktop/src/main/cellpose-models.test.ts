// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  assertCellposeStatusMatches,
  CELLPOSE_MODELS,
  requireCellposeProfileId,
} from "./cellpose-models";

describe("Cellpose model registry", () => {
  it("keeps the website-compatible and v2 profiles mapped to distinct official artifacts", () => {
    expect(CELLPOSE_MODELS[requireCellposeProfileId("cellpose-sam")]).toEqual({
      artifactId: "cpsam",
      label: "Cellpose-SAM website-compatible",
      page: "https://huggingface.co/mouseland/cellpose-sam/blob/7c61431b5fbb078f3296754bd15d9f51b320f837/cpsam",
    });
    expect(CELLPOSE_MODELS[requireCellposeProfileId("cellpose-sam-v2")]).toEqual({
      artifactId: "cpsam_v2",
      label: "Cellpose-SAM v2",
      page: "https://huggingface.co/mouseland/cellpose-sam/blob/7c61431b5fbb078f3296754bd15d9f51b320f837/cpsam_v2",
    });
  });

  it.each([undefined, null, "", "loci-classical", "toString", "constructor"])(
    "rejects an unsupported profile id (%s)",
    (profileId) => {
      expect(() => requireCellposeProfileId(profileId)).toThrow(
        "The Cellpose model selection is invalid.",
      );
    },
  );

  it("rejects a status response for another profile or artifact", () => {
    expect(() => assertCellposeStatusMatches(
      "cellpose-sam",
      "cellpose-sam-v2",
      "cpsam_v2",
    )).toThrow("status for a different model");
    expect(() => assertCellposeStatusMatches(
      "cellpose-sam",
      "cellpose-sam",
      "cpsam_v2",
    )).toThrow("status for a different model");
    expect(() => assertCellposeStatusMatches(
      "cellpose-sam",
      "cellpose-sam",
      "cpsam",
    )).not.toThrow();
  });
});
