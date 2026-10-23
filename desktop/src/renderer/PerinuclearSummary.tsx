import { PERINUCLEAR_EXCLUSIONS, type ResearchPerinuclearSummary } from "../shared/perinuclear-contracts";

export const perinuclearReason = {
  "boundary-touching-nucleus": "Nucleus touches the image border",
  "empty-ring": "Empty ring",
  "zero-mean-ring": "Zero mean ring signal",
} as const;

export function checkedPerinuclearSummary(value: unknown, objectCount: number): ResearchPerinuclearSummary {
  const summary = value as ResearchPerinuclearSummary;
  if (!summary || summary.object_count !== objectCount || !Number.isSafeInteger(objectCount) || objectCount < 0 ||
      [summary.eligible_count, summary.excluded_count].some((count) => !Number.isSafeInteger(count) || count < 0) ||
      summary.eligible_count + summary.excluded_count !== objectCount ||
      summary.endpoint_defined !== (summary.eligible_count > 0) ||
      !summary.excluded_by_reason ||
      Object.keys(summary.excluded_by_reason).length !== PERINUCLEAR_EXCLUSIONS.length ||
      PERINUCLEAR_EXCLUSIONS.some((reason) => !Number.isSafeInteger(summary.excluded_by_reason[reason]) ||
        summary.excluded_by_reason[reason] < 0 || summary.excluded_by_reason[reason] > summary.excluded_count) ||
      [summary.median_ratio, summary.mean_ratio].some((ratio) => summary.endpoint_defined
        ? typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 : ratio !== null))
    throw new Error("The perinuclear summary has inconsistent eligibility or ratio records.");
  return summary;
}

export function PerinuclearValue({ value }: { value: number | null }) {
  return <span title={value === null ? "Not defined" : (Object.is(value, -0) ? "-0" : String(value))} data-exact-value={value === null ? "null" : (Object.is(value, -0) ? "-0" : String(value))}>
    {value === null ? "Not defined" : Object.is(value, -0) ? "-0" : Number(value.toPrecision(6)).toString()}
  </span>;
}

export function PerinuclearSummary({ summary }: { summary: ResearchPerinuclearSummary }) {
  return <section aria-label="Perinuclear enrichment summary">
    <dl className="research-kv">
      <div><dt>Field median nuclear / ring ratio</dt><dd><PerinuclearValue value={summary.median_ratio} /></dd></div>
      <div><dt>Field mean nuclear / ring ratio</dt><dd><PerinuclearValue value={summary.mean_ratio} /></dd></div>
      <div><dt>Defined ratios</dt><dd>{summary.eligible_count.toLocaleString()} of {summary.object_count.toLocaleString()} nuclei</dd></div>
      <div><dt>Excluded nuclei</dt><dd>{summary.excluded_count.toLocaleString()}</dd></div>
    </dl>
    {!summary.endpoint_defined && <p role="status">No nuclei have a defined ratio in this field.</p>}
    {summary.excluded_count > 0 && <details><summary>Exclusion reasons</summary>
      <dl className="research-kv">{PERINUCLEAR_EXCLUSIONS.map((reason) => <div key={reason}>
        <dt>{perinuclearReason[reason]}</dt><dd>{summary.excluded_by_reason[reason].toLocaleString()}</dd>
      </div>)}</dl>
      <p>A nucleus can have more than one exclusion reason.</p>
    </details>}
  </section>;
}
