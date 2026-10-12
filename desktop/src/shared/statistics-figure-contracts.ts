/** Renderer supplies identities and bounded options; trusted engine owns all data/artwork. */
export type StatisticsFigureQuery = {
  x_metric: string | null; y_metric: string | null;
  filters: Array<{ metric: string; min?: number; max?: number }>;
  sort: { metric: string; direction: "asc" | "desc" } | null;
  offset: number; limit: number; plot_limit: number; bins: number; selected_label: number | null;
};
export type StatisticsFigureDomain = { mode: "full" } |
  { mode: "current"; x: [number, number]; y: [number, number] };
export type StatisticsFigureExportRequest = {
  schema_version: "loci.statistics-figure-request/v1";
  source_id: string; source_sha256: string; result_id: string; revision_hash: string;
  query: StatisticsFigureQuery; query_sha256: string; membership_sha256: string;
  chart: "histogram" | "scatter"; domain: StatisticsFigureDomain;
  width_mm: number; height_mm: number; preset: "publication-monochrome";
};
export type StatisticsFigureArtifact = { sha256: string; size_bytes: number };
export type StatisticsFigureExportReceipt = {
  schema_version: "loci.statistics-figure-receipt/v1"; basename: string;
  width_mm: number; height_mm: number; width_px: number; height_px: number; dpi: 600;
  source_id: string; source_sha256: string; result_id: string; revision_hash: string;
  query_sha256: string; membership_sha256: string;
  artifacts: Record<"figure.svg" | "figure.png" | "manifest.json", StatisticsFigureArtifact>;
};
export const STATISTICS_FIGURE_DPI = 600;
export const STATISTICS_FIGURE_MAX_EDGE = 8192;
export const STATISTICS_FIGURE_MAX_PIXELS = 16_000_000;
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[a-f0-9]{32}$/u;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid statistics figure record.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) throw new Error("Unsupported statistics figure fields.");
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Statistics figure numbers must be finite.");
  return value;
}
function integer(value: unknown, low: number, high: number): void {
  const number = finite(value);
  if (!Number.isSafeInteger(number) || number < low || number > high) throw new Error("Statistics figure integer is out of bounds.");
}
function metric(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  // Intensity identifiers are hex encoded UTF-8 source channel names.
  if (typeof value !== "string" || !value.length || value.length > 560 || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error("Invalid statistics metric identity.");
}
export function statisticsFigurePixels(widthMm: number, heightMm: number): [number, number] {
  if (finite(widthMm) < 40 || widthMm > 300 || finite(heightMm) < 40 || heightMm > 300)
    throw new Error("Choose statistics figure dimensions between 40 and 300 mm.");
  const dimensions: [number, number] = [Math.round(widthMm / 25.4 * 600), Math.round(heightMm / 25.4 * 600)];
  if (dimensions.some((edge) => edge > STATISTICS_FIGURE_MAX_EDGE) || dimensions[0] * dimensions[1] > STATISTICS_FIGURE_MAX_PIXELS)
    throw new Error("Statistics figure exceeds the bounded raster allocation.");
  return dimensions;
}
export function checkedStatisticsFigureRequest(value: unknown): StatisticsFigureExportRequest {
  const request = object(value);
  keys(request, ["schema_version", "source_id", "source_sha256", "result_id", "revision_hash", "query", "query_sha256", "membership_sha256", "chart", "domain", "width_mm", "height_mm", "preset"]);
  if (request.schema_version !== "loci.statistics-figure-request/v1" || request.preset !== "publication-monochrome" || !["histogram", "scatter"].includes(String(request.chart)))
    throw new Error("Unsupported statistics figure options.");
  for (const key of ["source_id", "result_id"]) if (typeof request[key] !== "string" || !ID.test(request[key] as string)) throw new Error("Invalid statistics figure identity.");
  for (const key of ["source_sha256", "revision_hash", "query_sha256", "membership_sha256"]) if (typeof request[key] !== "string" || !HASH.test(request[key] as string)) throw new Error("Invalid statistics figure hash.");
  statisticsFigurePixels(request.width_mm as number, request.height_mm as number);
  const query = object(request.query);
  keys(query, ["x_metric", "y_metric", "filters", "sort", "offset", "limit", "plot_limit", "bins", "selected_label"]);
  metric(query.x_metric, true); metric(query.y_metric, true);
  if (!Array.isArray(query.filters) || query.filters.length > 8) throw new Error("Invalid statistics filters.");
  for (const item of query.filters) {
    const filter = object(item);
    keys(filter, ["metric", ...(Object.hasOwn(filter, "min") ? ["min"] : []), ...(Object.hasOwn(filter, "max") ? ["max"] : [])]);
    metric(filter.metric);
    if (!Object.hasOwn(filter, "min") && !Object.hasOwn(filter, "max")) throw new Error("Statistics filter needs a bound.");
    if (Object.hasOwn(filter, "min")) finite(filter.min);
    if (Object.hasOwn(filter, "max")) finite(filter.max);
    if (Object.hasOwn(filter, "min") && Object.hasOwn(filter, "max") && Number(filter.min) > Number(filter.max)) throw new Error("Unordered statistics filter.");
  }
  if (query.sort !== null) {
    const sort = object(query.sort); keys(sort, ["metric", "direction"]); metric(sort.metric);
    if (sort.direction !== "asc" && sort.direction !== "desc") throw new Error("Invalid statistics sort.");
  }
  integer(query.offset, 0, 100000); integer(query.limit, 1, 200); integer(query.plot_limit, 1, 2000); integer(query.bins, 1, 64);
  if (query.selected_label !== null) integer(query.selected_label, 1, 0xffffffff);
  const domain = object(request.domain);
  if (domain.mode === "full") keys(domain, ["mode"]);
  else if (domain.mode === "current") {
    keys(domain, ["mode", "x", "y"]);
    for (const axis of ["x", "y"]) {
      const extent = domain[axis];
      if (!Array.isArray(extent) || extent.length !== 2 || finite(extent[0]) > finite(extent[1])) throw new Error("Invalid statistics figure domain.");
    }
  } else throw new Error("Invalid statistics figure domain mode.");
  return value as StatisticsFigureExportRequest;
}
