import type { ResearchDesktopApi } from "../shared/research-contracts";
import { checkedSpatialDensityPage, type SpatialDensityAggregation, type SpatialDensityDonor, type SpatialDensityInput, type SpatialDensityTarget, type SpatialDensityViewSummary } from "../shared/spatial-density-contracts";

/** A plot never silently treats the preview's first page as the complete study. */
export async function readDensityPlot(api: Pick<ResearchDesktopApi, "execute">, target: SpatialDensityTarget,
  summary: SpatialDensityViewSummary, current: () => boolean): Promise<SpatialDensityAggregation | null> {
  const output = { ...summary.aggregation };
  for (const table of ["input_snapshots", "donor_rows", "condition_rows", "paired_rows", "paired_summary"] as const) {
    if (!current()) return null;
    if (output[table].length === summary.tables[table].total) continue;
    const all: unknown[] = [];
    let offset = 0;
    do {
      const response = await api.execute("spatial_density_query", { ...target, table, offset, limit: 100 });
      if (!current()) return null;
      const page = checkedSpatialDensityPage(response, summary, table, offset, 100);
      all.push(...page.rows);
      if (page.next_offset === null) break;
      offset = page.next_offset;
    } while (all.length < summary.tables[table].total);
    if (all.length !== summary.tables[table].total) throw new Error("The donor plot is incomplete. Reopen the report and retry.");
    (output[table] as unknown[]) = all;
  }
  if (new Set(output.input_snapshots.map((f) => f.result.id)).size !== output.input_snapshots.length)
    throw new Error("The donor plot contains repeated field bindings. Reopen the report and retry.");
  return output;
}

export type DensityPlotMode = "density" | "paired-difference";
export interface DensityPlotPoint {
  key: string; donor: string; condition: string; value: number;
  fields: SpatialDensityInput[];
}
export interface DensityPlotData {
  points: DensityPlotPoint[];
  groups: string[];
  connections: Array<{ from: string; to: string; donor: string }>;
  undefinedDonors: Array<{ donor: string; condition: string }>;
  means: Array<{ group: string; value: number; n: number }>;
  domain: [number, number];
  axisLabel: string;
}
const identity = (condition: string, donor: string) => JSON.stringify([condition, donor]);
const order = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Display geometry uses saved endpoints; it does not re-estimate biological statistics. */
export function densityPlotData(a: SpatialDensityAggregation, study: string, bandIndex: number, mode: DensityPlotMode): DensityPlotData {
  if (!Number.isSafeInteger(bandIndex) || bandIndex < 0 || bandIndex + 1 >= a.contract.band_edges.length)
    throw new Error("Choose a saved distance band for the plot.");
  const donors = a.donor_rows.filter((r) => r.study === study && r.band_index === bandIndex);
  const byKey = new Map<string, SpatialDensityDonor>();
  const inputs = new Map(a.input_snapshots.map((f) => [f.result.id, f]));
  for (const donor of donors) {
    const key = identity(donor.condition, donor.biological_replicate);
    if (byKey.has(key) || donor.density !== null && (!Number.isFinite(donor.density) || donor.density < 0) ||
        new Set(donor.field_result_ids).size !== donor.n_fields || donor.field_result_ids.length !== donor.n_fields ||
        donor.field_result_ids.some((id) => {
          const field = inputs.get(id), metadata = field?.sample?.data;
          return !field || metadata?.study !== study || metadata.condition !== donor.condition ||
            metadata.biological_replicate !== donor.biological_replicate;
        })) throw new Error("The donor plot does not match its exact saved field bindings.");
    byKey.set(key, donor);
  }
  const points: DensityPlotPoint[] = [], undefinedDonors: DensityPlotData["undefinedDonors"] = [];
  const connections: DensityPlotData["connections"] = [], means: DensityPlotData["means"] = [];
  const fieldInputs = (rows: SpatialDensityDonor[]) => [...new Set(rows.flatMap((r) => r.field_result_ids))].map((id) => inputs.get(id)!);
  let groups: string[], axisLabel: string;
  if (mode === "density") {
    groups = [...new Set(donors.map((r) => r.condition))].sort(order);
    if (a.condition_pair) groups = [...a.condition_pair.filter((c) => groups.includes(c)), ...groups.filter((c) => !a.condition_pair!.includes(c))];
    for (const r of donors) {
      const donor = r.biological_replicate;
      if (r.density === null) undefinedDonors.push({ donor, condition: r.condition });
      else points.push({ key: identity(r.condition, donor), donor, condition: r.condition, value: r.density, fields: fieldInputs([r]) });
    }
    for (const r of a.condition_rows.filter((r) => r.study === study && r.band_index === bandIndex)) {
      if (r.mean !== null) {
        if (!groups.includes(r.condition) || !Number.isFinite(r.mean) || r.mean < 0 || r.n !== points.filter((p) => p.condition === r.condition).length)
          throw new Error("The saved condition mean does not match the plotted donor scope.");
        means.push({ group: r.condition, value: r.mean, n: r.n });
      }
    }
    if (a.condition_pair) for (const r of a.paired_rows.filter((r) => r.study === study && r.band_index === bandIndex)) {
      const left = byKey.get(identity(r.left_condition, r.biological_replicate)), right = byKey.get(identity(r.right_condition, r.biological_replicate));
      if (!left || !right || r.left_density !== left.density || r.right_density !== right.density)
        throw new Error("The saved pairing does not match the plotted donor endpoints.");
      if (left.density !== null && right.density !== null) connections.push({ from: identity(left.condition, r.biological_replicate), to: identity(right.condition, r.biological_replicate), donor: r.biological_replicate });
    }
    axisLabel = "Donor density";
  } else {
    if (!a.condition_pair) throw new Error("This report has no declared paired comparison.");
    const group = `${a.condition_pair[1]} − ${a.condition_pair[0]}`;
    groups = [group]; axisLabel = "Within-donor density difference";
    const seen = new Set<string>();
    for (const r of a.paired_rows.filter((r) => r.study === study && r.band_index === bandIndex)) {
      const donor = r.biological_replicate, left = byKey.get(identity(r.left_condition, donor)), right = byKey.get(identity(r.right_condition, donor));
      if (seen.has(donor) || !left || !right || r.left_condition !== a.condition_pair[0] || r.right_condition !== a.condition_pair[1] ||
          left.density !== r.left_density || right.density !== r.right_density || r.difference !== null && !Number.isFinite(r.difference))
        throw new Error("The saved paired difference does not match its donor endpoints.");
      seen.add(donor);
      if (r.difference === null) undefinedDonors.push({ donor, condition: group });
      else points.push({ key: identity(group, donor), donor, condition: group, value: r.difference, fields: fieldInputs([left, right]) });
    }
    for (const r of a.paired_summary.filter((r) => r.study === study && r.band_index === bandIndex)) {
      if (r.mean !== null) {
        if (!Number.isFinite(r.mean) || r.n !== points.length) throw new Error("The paired summary does not match the plotted donors.");
        means.push({ group, value: r.mean, n: r.n });
      }
    }
  }
  points.sort((a, b) => groups.indexOf(a.condition) - groups.indexOf(b.condition) || order(a.donor, b.donor));
  undefinedDonors.sort((a, b) => order(a.condition, b.condition) || order(a.donor, b.donor));
  const values = points.map((p) => p.value).concat(means.map((m) => m.value), 0);
  const min = Math.min(...values), max = Math.max(...values);
  // Domains are presentation only. Never turn undefined donor densities into zero.
  const span = max - min, padding = span > 0 ? span * 0.08 : 1;
  const domain: [number, number] = [min < 0 ? min - padding : 0, max + padding];
  if (!domain.every(Number.isFinite) || domain[1] <= domain[0]) throw new Error("The saved values exceed the supported plot range.");
  return { points, groups, connections, undefinedDonors, means, domain, axisLabel };
}
