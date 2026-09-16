import { ArrowDownUp, ChevronRight } from "lucide-react";
import React from "react";

export type ReviewFilter = "all" | "unreviewed" | "flagged" | "reviewed" | "excluded";
export type ReviewSort = "source" | "flagged" | "count-ascending" | "count-descending";

export interface ReviewSummary {
  total: number;
  processed: number;
  unreviewed: number;
  flagged: number;
  reviewed: number;
  excluded: number;
}

export interface ReviewInspectorProps {
  summary: ReviewSummary;
  filter: ReviewFilter;
  sort: ReviewSort;
  onFilterChange: (filter: ReviewFilter) => void;
  onSortChange: (sort: ReviewSort) => void;
  onNextUnreviewed: () => void;
  canGoToNext: boolean;
}

const filters: Array<{ id: ReviewFilter; label: string; count: keyof ReviewSummary }> = [
  { id: "all", label: "All", count: "total" },
  { id: "unreviewed", label: "Unreviewed", count: "unreviewed" },
  { id: "flagged", label: "Flagged", count: "flagged" },
  { id: "reviewed", label: "Reviewed", count: "reviewed" },
  { id: "excluded", label: "Excluded", count: "excluded" },
];

export default function ReviewInspector({
  summary,
  filter,
  sort,
  onFilterChange,
  onSortChange,
  onNextUnreviewed,
  canGoToNext,
}: ReviewInspectorProps): React.JSX.Element {
  return (
    <div className="review-inspector">
      <section className="panel-section review-summary" aria-labelledby="review-summary-title">
        <div className="section-heading">
          <h3 id="review-summary-title">Review</h3>
          <span>{summary.processed.toLocaleString()} processed</span>
        </div>
        <div className="review-summary-grid">
          <span><strong>{summary.unreviewed.toLocaleString()}</strong>Unreviewed</span>
          <span><strong>{summary.flagged.toLocaleString()}</strong>Flagged</span>
          <span><strong>{summary.reviewed.toLocaleString()}</strong>Reviewed</span>
          <span><strong>{summary.excluded.toLocaleString()}</strong>Excluded</span>
        </div>
        <button
          type="button"
          className="button review-next-button"
          onClick={onNextUnreviewed}
          disabled={!canGoToNext}
        >
          Next unreviewed
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </section>

      <section className="panel-section" aria-labelledby="review-filter-title">
        <div className="section-heading"><h3 id="review-filter-title">Show</h3></div>
        <div className="review-filter-list" role="radiogroup" aria-label="Review filter">
          {filters.map((candidate) => (
            <button
              type="button"
              role="radio"
              aria-checked={filter === candidate.id}
              className={filter === candidate.id ? "is-active" : ""}
              key={candidate.id}
              onClick={() => onFilterChange(candidate.id)}
            >
              <span>{candidate.label}</span>
              <span>{summary[candidate.count].toLocaleString()}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel-section" aria-label="Review order">
        <label className="field-label" id="review-sort-title" htmlFor="review-sort">
          <span><ArrowDownUp size={13} aria-hidden="true" /> Sort results</span>
        </label>
        <select id="review-sort" value={sort} onChange={(event) => onSortChange(event.target.value as ReviewSort)}>
          <option value="source">Source order</option>
          <option value="flagged">Flagged first</option>
          <option value="count-ascending">Cell count · low to high</option>
          <option value="count-descending">Cell count · high to low</option>
        </select>
        <p className="field-help">
          Count outliers are descriptive triage within acquisition folders, not a biological or accuracy judgment.
        </p>
      </section>
    </div>
  );
}
