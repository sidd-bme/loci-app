import path from "node:path";
import { assertResearchRequestBound } from "./research-request-limits";
import {
  checkedStatisticsFigureRequest, statisticsFigurePixels,
  type StatisticsFigureExportRequest, type StatisticsFigureExportReceipt,
} from "../shared/statistics-figure-contracts";
const BINDINGS = ["source_id", "source_sha256", "result_id", "revision_hash", "query_sha256", "membership_sha256"] as const;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function assertStatisticsFigurePopulation(value: unknown, request: StatisticsFigureExportRequest): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The engine did not verify the statistics population.");
  const population = value as Record<string, unknown>;
  if (population.schema !== "loci.population/v1" || BINDINGS.some((key) => population[key] !== request[key]) || canonical(population.query) !== canonical(request.query))
    throw new Error("The statistics source, result, query or membership changed. Refresh the statistics before exporting.");
}
export function checkedStatisticsFigureReceipt(value: unknown, request: StatisticsFigureExportRequest, destination: string): StatisticsFigureExportReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The engine did not confirm statistics figure publication.");
  const receipt = value as Record<string, unknown>;
  const expectedKeys = ["schema_version", "basename", "width_mm", "height_mm", "width_px", "height_px", "dpi", "artifacts", ...BINDINGS];
  if (Object.keys(receipt).sort().join(",") !== expectedKeys.sort().join(",") || receipt.schema_version !== "loci.statistics-figure-receipt/v1" || receipt.basename !== path.basename(destination) || BINDINGS.some((key) => receipt[key] !== request[key]))
    throw new Error("Invalid statistics figure publication receipt.");
  const [width, height] = statisticsFigurePixels(request.width_mm, request.height_mm);
  if (receipt.width_mm !== request.width_mm || receipt.height_mm !== request.height_mm || receipt.width_px !== width || receipt.height_px !== height || receipt.dpi !== 600)
    throw new Error("Statistics figure receipt dimensions disagree with the request.");
  const artifacts = receipt.artifacts as Record<string, unknown> | null;
  if (!artifacts || Array.isArray(artifacts) || Object.keys(artifacts).sort().join(",") !== "figure.png,figure.svg,manifest.json") throw new Error("Statistics figure artifacts are incomplete.");
  const limits = { "figure.svg": 4 * 1024 * 1024, "figure.png": 32 * 1024 * 1024, "manifest.json": 1024 * 1024 };
  for (const name of Object.keys(limits) as Array<keyof typeof limits>) {
    const artifact = artifacts[name] as Record<string, unknown> | null;
    if (!artifact || Array.isArray(artifact) || Object.keys(artifact).sort().join(",") !== "sha256,size_bytes" || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !Number.isSafeInteger(artifact.size_bytes) || Number(artifact.size_bytes) < 1 || Number(artifact.size_bytes) > limits[name]) throw new Error("Invalid statistics figure artifact identity.");
  }
  return value as StatisticsFigureExportReceipt;
}
export async function exportStatisticsFigureBundle(options: {
  request: unknown; applicationVersion: string;
  verifyPopulation: (request: StatisticsFigureExportRequest) => Promise<unknown>;
  pickDestination: () => Promise<string | null>;
  publish: (request: StatisticsFigureExportRequest, destination: string, applicationVersion: string) => Promise<unknown>;
}): Promise<StatisticsFigureExportReceipt | null> {
  if (options.request !== null && typeof options.request === "object") assertResearchRequestBound("export-statistics-figure", options.request);
  const request = checkedStatisticsFigureRequest(options.request);
  assertStatisticsFigurePopulation(await options.verifyPopulation(request), request);
  const destination = await options.pickDestination();
  if (destination === null) return null;
  if (!path.isAbsolute(destination) || /[\u0000-\u001f\u007f]/u.test(path.basename(destination)) || !destination.toLowerCase().endsWith(".loci-figure")) throw new Error("Choose a statistics figure bundle destination.");
  assertStatisticsFigurePopulation(await options.verifyPopulation(request), request);
  return checkedStatisticsFigureReceipt(await options.publish(request, destination, options.applicationVersion), request, destination);
}
