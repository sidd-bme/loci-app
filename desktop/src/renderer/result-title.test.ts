import { describe, expect, it } from "vitest";
import type { ResearchResult } from "../shared/research-contracts";
import { resultTitle } from "./result-title";

const result = (kind: string, method_label?: string): ResearchResult => ({
  id: "a".repeat(32), revision_hash: "b".repeat(64), source_id: "c".repeat(32),
  source_sha256: "d".repeat(64), created_at: "2026-10-15T00:00:00Z", object_count: 2,
  kind, ...(method_label === undefined ? {} : { method_label }),
});

describe("readable result titles", () => {
  it.each([
    ["declared-stain-analysis", "Declared stain analysis"],
    ["tissue-region-mask", "Tissue region mask"],
    ["puncta-quantification", "Puncta detection"],
    ["nucleus-cell-association", "Nucleus-cell association"],
    ["field-assay", "Fluorescence field assay"],
    ["perinuclear-enrichment", "Perinuclear enrichment"],
    ["large-components", "Threshold segmentation"],
    ["adaptive-segmentation", "Adaptive watershed segmentation"],
    ["processed", "Image processing"],
    ["puncta", "Puncta detection"],
    ["colocalisation", "Colocalisation measurement"],
  ])("uses the engine vocabulary for a %s payload without a method label", (kind, title) => {
    const record = result(kind);
    const frozen = JSON.stringify(record);
    expect(resultTitle(record)).toBe(title);
    expect(JSON.stringify(record)).toBe(frozen);
  });

  it("keeps the exact producing-method projection, including compartment measurements", () => {
    expect(resultTitle(result("nucleus-cell-association", "Compartment measurements"))).toBe("Compartment measurements");
    expect(resultTitle(result("segmentation", "Watershed segmentation"))).toBe("Watershed segmentation");
  });

  it.each(["future-result-kind", "constructor", "__proto__"])("keeps unknown %s titles human readable without exposing identities", (kind) => {
    const record = result(kind);
    expect(resultTitle(record)).toBe("Analysis result");
    expect(resultTitle(record)).not.toContain(record.id);
    expect(resultTitle(record)).not.toContain(record.revision_hash);
    expect(record.kind).toBe(kind);
  });
});
