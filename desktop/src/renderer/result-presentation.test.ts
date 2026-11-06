import { describe, expect, it } from "vitest";
import type { ResearchResult } from "../shared/research-contracts";
import { resultParentRelation, resultSummary } from "./result-presentation";

function result(kind: string, object_count = 0): ResearchResult {
  return { id: "result", source_id: "source", revision_hash: "revision", created_at: "2026-11-06", kind, object_count };
}

describe("result presentation", () => {
  it("uses report identity regardless of measured-row count or absent optional report metadata", () => {
    for (const count of [0, 1, 20]) {
      expect(resultSummary(result("annotation-reference", count))).toBe("Frozen reference");
      expect(resultSummary(result("annotation-agreement", count), false)).toBe("Agreement report");
    }
  });

  it("keeps zero counts, singular/plural and unformatted accessible counts for measured results", () => {
    for (const kind of ["segmentation", "corrected-labels", "large-corrected-labels", "controlled-method"]) {
      expect(resultSummary(result(kind))).toBe("0 objects");
      expect(resultSummary(result(kind, 1))).toBe("1 object");
      expect(resultSummary(result(kind, 2000))).toBe(`${(2000).toLocaleString()} objects`);
      expect(resultSummary(result(kind, 2000), false)).toBe("2000 objects");
    }
  });

  it("does not invent a count when legacy summary metadata omits it", () => {
    const incomplete = { ...result("segmentation"), object_count: undefined } as unknown as ResearchResult;
    expect(resultSummary(incomplete)).toBe("Object count unavailable");
  });

  it("reserves Edited from for explicit correction provenance", () => {
    for (const kind of ["annotation-reference", "annotation-agreement", "controlled-method", "perinuclear-enrichment"])
      expect(resultParentRelation(result(kind))).toBe("Derived from");
    for (const kind of ["corrected-labels", "large-corrected-labels"])
      expect(resultParentRelation(result(kind))).toBe("Edited from");
    expect(resultParentRelation({ ...result("tissue-region-mask"), tissue_model: {
      schema: "loci.puma-tissue-result/v1", label_semantics: "edited_selected_compartment",
      preview: { preview_id: "preview", preview_hash: "hash" },
    } })).toBe("Edited from");
  });
});
