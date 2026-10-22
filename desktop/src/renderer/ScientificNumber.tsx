import "./ScientificNumber.css";

/** Display only. Never use the compact spelling for storage, calculations or export. */
export function scientificNumber(value: number | null): { exact: string; display: string } {
  if (value === null) return { exact: "Not estimable", display: "Not estimable" };
  if (!Number.isFinite(value)) throw new Error("Scientific values must be finite or null.");
  const exact = Object.is(value, -0) ? "-0" : String(value);
  if (Number.isInteger(value)) return { exact, display: exact };
  const compact = String(Number(value.toPrecision(6)));
  return { exact, display: compact.length < exact.length ? compact : exact };
}

export function ScientificNumber({ value }: { value: number | null }) {
  const { exact, display } = scientificNumber(value);
  return exact === display ? <>{exact}</> : <details className="scientific-number">
    <summary aria-label={`Approximately ${display}; show exact value`}>≈ {display}</summary>
    <code aria-label="Exact value">{exact}</code>
  </details>;
}
