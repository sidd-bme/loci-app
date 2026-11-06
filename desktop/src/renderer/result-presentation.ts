import type { ResearchResult } from "../shared/research-contracts";

/** object_count counts measured rows, not annotation instances or report inputs. */
export function resultSummary(result: ResearchResult, localized = true): string {
  if (result.kind === "annotation-reference") return "Frozen reference";
  if (result.kind === "annotation-agreement") return "Agreement report";
  if (result.object_count == null) return "Object count unavailable";
  const count = localized ? result.object_count.toLocaleString() : String(result.object_count);
  return `${count} ${result.object_count === 1 ? "object" : "objects"}`;
}

/** A retained parent records derivation; only label corrections imply an edit. */
export function resultParentRelation(result: ResearchResult): string {
  return result.kind === "corrected-labels" || result.kind === "large-corrected-labels"
    || result.tissue_model?.label_semantics === "edited_selected_compartment"
    ? "Edited from" : "Derived from";
}
