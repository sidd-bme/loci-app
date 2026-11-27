import {
  MODEL_LIBRARY_TASK_LABELS,
  type ModelLibraryEntry,
  type ModelLibraryFilterGroup,
  type ModelLibraryTaskFilter,
} from "../../shared/model-library";
import type { ModelZooExampleRegistry } from "./examples";

function entrySearchHaystack(
  entry: Readonly<ModelLibraryEntry>,
  examples?: ModelZooExampleRegistry,
): string {
  const example = examples?.[entry.id];
  return [
    entry.id,
    entry.title,
    entry.subtitle,
    entry.summary,
    entry.cardSummary,
    entry.target,
    entry.modalitySummary,
    entry.taskCategory,
    MODEL_LIBRARY_TASK_LABELS[entry.taskCategory],
    entry.taskLabel,
    entry.modalityTags.join(" "),
    entry.filterGroup,
    entry.executionMode,
    entry.executionBadge,
    entry.executionShortLabel,
    entry.publisherBadge,
    entry.workbenchRoute.actionLabel,
    entry.workbenchRoute.inspectorLocation,
    entry.artifact.artifactId,
    entry.artifact.fileName,
    entry.artifact.version,
    entry.citation.authors,
    entry.citation.venue,
    entry.citation.doi,
    entry.primaryLink.label,
    entry.primaryLink.hostLabel,
    entry.searchTerms.join(" "),
    example?.credit.subject ?? "",
    example?.credit.attribution ?? "",
    example?.credit.modelVersion ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function tokenizeModelZooQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

export function matchesModelZooQuery(
  entry: Readonly<ModelLibraryEntry>,
  query: string,
  examples?: ModelZooExampleRegistry,
): boolean {
  const tokens = tokenizeModelZooQuery(query);
  if (tokens.length === 0) return true;
  const haystack = entrySearchHaystack(entry, examples);
  return tokens.every((token) => haystack.includes(token));
}

export function filterModelZooEntries(
  entries: readonly Readonly<ModelLibraryEntry>[],
  filterGroup: ModelLibraryFilterGroup,
  query: string,
  examples?: ModelZooExampleRegistry,
  taskFilter: ModelLibraryTaskFilter = "all",
): ReadonlyArray<Readonly<ModelLibraryEntry>> {
  return entries.filter((entry) => {
    if (filterGroup !== "all" && entry.filterGroup !== filterGroup) {
      return false;
    }
    if (taskFilter !== "all" && entry.taskCategory !== taskFilter) {
      return false;
    }
    return matchesModelZooQuery(entry, query, examples);
  });
}

export interface ModelZooFilterCounts {
  readonly all: number;
  readonly local: number;
  readonly external: number;
}

export function countModelZooEntries(
  entries: readonly Readonly<ModelLibraryEntry>[],
  query: string,
  examples?: ModelZooExampleRegistry,
  taskFilter: ModelLibraryTaskFilter = "all",
): ModelZooFilterCounts {
  let all = 0;
  let local = 0;
  let external = 0;
  for (const entry of entries) {
    if (taskFilter !== "all" && entry.taskCategory !== taskFilter) continue;
    if (!matchesModelZooQuery(entry, query, examples)) continue;
    all += 1;
    if (entry.filterGroup === "local") local += 1;
    else external += 1;
  }
  return { all, local, external };
}
