/** Display coordinates only. These helpers never build a population filter. */
export type NumericDomain = [number, number];
export type ChartView = { x: NumericDomain; y: NumericDomain };
export const fullChartView = (): ChartView => ({ x: [0, 1], y: [0, 1] });
const MIN_VIEW_SPAN = 1e-7;

export function populationNumber(value: number): string {
  const magnitude = Math.abs(value);
  return value.toLocaleString(undefined, {
    maximumSignificantDigits: 6,
    ...((magnitude >= 1e7 || (magnitude > 0 && magnitude < 0.001)) ? { notation: "scientific" as const } : {}),
  });
}

export function domainValue([low, high]: NumericDomain, position: number): number {
  if (position <= 0 || low === high) return low;
  if (position >= 1) return high;
  const span = high - low;
  return Number.isFinite(span) ? low + span * position : low * (1 - position) + high * position;
}

export function domainFraction(value: number, [low, high]: NumericDomain): number {
  if (low === high) return 0.5;
  const span = high - low;
  if (Number.isFinite(span)) return (value - low) / span;
  const scale = Math.max(Math.abs(low), Math.abs(high));
  return (value / scale - low / scale) / (high / scale - low / scale);
}

export function viewedDomain(domain: NumericDomain, view: NumericDomain): NumericDomain {
  return [domainValue(domain, view[0]), domainValue(domain, view[1])];
}

export function displayedFraction(value: number, domain: NumericDomain, view: NumericDomain): number {
  return (domainFraction(value, domain) - view[0]) / (view[1] - view[0]);
}

export function boundedView(low: number, span: number): NumericDomain {
  const size = Math.min(1, Math.max(MIN_VIEW_SPAN, span));
  const start = Math.min(1 - size, Math.max(0, low));
  return [start, start + size];
}

function meaningfulView(candidate: NumericDomain, old: NumericDomain, domain: NumericDomain): NumericDomain {
  // Constant data is centered, never given an invented measurement range.
  if (domain[0] === domain[1]) return [0, 1];
  const values = viewedDomain(domain, candidate);
  return values[0] < values[1] ? candidate : old;
}

export function zoomChartView(view: ChartView, factor: number, domains: ChartView, histogram: boolean,
  anchor: [number, number] = [0.5, 0.5]): ChartView {
  const zoom = (range: NumericDomain, domain: NumericDomain, pivot: number): NumericDomain => {
    const span = range[1] - range[0];
    const nextSpan = Math.min(1, Math.max(MIN_VIEW_SPAN, span * factor));
    return meaningfulView(boundedView(range[0] + (span - nextSpan) * pivot, nextSpan), range, domain);
  };
  return { x: zoom(view.x, domains.x, anchor[0]), y: histogram ? [0, 1] : zoom(view.y, domains.y, anchor[1]) };
}

export function panChartView(view: ChartView, dx: number, dy: number, domains: ChartView, histogram: boolean): ChartView {
  const pan = (range: NumericDomain, domain: NumericDomain, distance: number) =>
    meaningfulView(boundedView(range[0] + distance * (range[1] - range[0]), range[1] - range[0]), range, domain);
  return { x: pan(view.x, domains.x, dx), y: histogram ? [0, 1] : pan(view.y, domains.y, dy) };
}

export function chartTicks(domain: NumericDomain, view: NumericDomain, count = 4, integer = false): Array<{ value: number; position: number }> {
  if (domain[0] === domain[1]) return [{ value: domain[0], position: 0.5 }];
  const visible = viewedDomain(domain, view);
  const result: Array<{ value: number; position: number }> = [];
  for (let index = 0; index <= count; index++) {
    const raw = domainValue(visible, index / count);
    const value = integer ? Math.round(raw) : raw;
    if (!Number.isFinite(value) || result.some((tick) => tick.value === value)) continue;
    const position = displayedFraction(value, domain, view);
    if (position >= -1e-9 && position <= 1 + 1e-9) result.push({ value, position });
  }
  return result;
}

export const isFullChartView = (view: ChartView): boolean =>
  view.x[0] === 0 && view.x[1] === 1 && view.y[0] === 0 && view.y[1] === 1;
