import { describe, expect, it } from "vitest";
import type { SpatialDensityAggregation, SpatialDensityDonor, SpatialDensityInput } from "../shared/spatial-density-contracts";
import { densityPlotData } from "./spatial-density-plot";

const input = (id: string, donor: string, condition: string, study = "Study") => ({
  result: { id, revision_hash: id.repeat(2), source_id: id, source_sha256: id.repeat(2), selection: { t: 0, z: 0 } },
  sample: { id, revision: 1, data: { study, sample: id, condition, biological_replicate: donor } }, phenotype: null,
} as SpatialDensityInput);
const donor = (name: string, condition: string, density: number | null, fields: string[], study = "Study", band = 0): SpatialDensityDonor => ({
  study, condition, biological_replicate: name, band_index: band, object_count: density === null ? 0 : density * 10,
  sampled_area: density === null ? 0 : 10, density, density_status: density === null ? "undefined_zero_area" : "defined", field_result_ids: fields, n_fields: fields.length,
});
function aggregation(): SpatialDensityAggregation {
  const ids = ["1", "2", "3", "4", "5", "6"].map((x) => x.repeat(32));
  return {
    schema: "loci.spatial-density-aggregation/v2", rules: {}, contract: { distance_unit: "um", area_unit: "um^2", band_edges: [0, 100, 300], rules: {}, exclude_crop_border: true },
    stratum: { t: 0, z: 0 }, phenotype_name: null, condition_pair: ["A", "B"],
    input_snapshots: [input(ids[0], "D1", "A"), input(ids[1], "D1", "A"), input(ids[2], "D1", "B"), input(ids[3], "D2", "A"), input(ids[4], "D3", "B"), input(ids[5], "D1", "A", "Other study")],
    donor_rows: [donor("D1", "A", 2, ids.slice(0, 2)), donor("D1", "B", 0.5, [ids[2]]), donor("D2", "A", 4, [ids[3]]), donor("D3", "B", null, [ids[4]]), donor("D1", "A", 99, [ids[5]], "Other study"), donor("D1", "A", 8, ids.slice(0, 2), "Study", 1)],
    condition_rows: [{ study: "Study", condition: "A", band_index: 0, mean: 3, sd: Math.sqrt(2), median: 3, n: 2, n_donors_total: 2, n_undefined_zero_area: 0 },
      { study: "Study", condition: "B", band_index: 0, mean: 0.5, sd: null, median: 0.5, n: 1, n_donors_total: 2, n_undefined_zero_area: 1 }],
    paired_rows: [{ study: "Study", biological_replicate: "D1", band_index: 0, left_condition: "A", right_condition: "B", left_density: 2, right_density: 0.5, difference: -1.5, status: "defined" }],
    paired_summary: [{ study: "Study", band_index: 0, left_condition: "A", right_condition: "B", mean: -1.5, sd: null, median: -1.5, n: 1 }],
    field_rows: [], unmatched_donors: [{ study: "Study", condition: "A", biological_replicate: "D2", reason: "missing_paired_condition" }], exclusion_audit: [],
  };
}
describe("saved donor plot endpoints", () => {
  it("plots donor densities without pooling conditions, bands or studies", () => {
    const a = aggregation(), original = structuredClone(a);
    const plotted = densityPlotData(a, "Study", 0, "density");
    expect(plotted.points.map((p) => [p.donor, p.condition, p.value, p.fields.length])).toEqual([["D1", "A", 2, 2], ["D2", "A", 4, 1], ["D1", "B", 0.5, 1]]);
    expect(plotted.means).toEqual([{ group: "A", value: 3, n: 2 }, { group: "B", value: 0.5, n: 1 }]);
    expect(plotted.undefinedDonors).toEqual([{ donor: "D3", condition: "B" }]);
    expect(plotted.connections).toHaveLength(1);
    expect(plotted.connections[0].donor).toBe("D1");
    expect(a).toEqual(original);
  });
  it("uses the saved right-minus-left difference and exact fields from both members", () => {
    const plotted = densityPlotData(aggregation(), "Study", 0, "paired-difference");
    expect(plotted.points).toHaveLength(1);
    expect(plotted.points[0].value).toBe(-1.5);
    expect(plotted.points[0].fields).toHaveLength(3);
    expect(plotted.domain[0]).toBeLessThan(-1.5);
    expect(plotted.domain[1]).toBeGreaterThanOrEqual(0);
    expect(plotted.groups).toEqual(["B − A"]);
  });
  it("keeps actual zero densities while omitting undefined values", () => {
    const a = aggregation(); a.donor_rows[1].density = 0; a.condition_rows[1].mean = 0; a.condition_rows[1].median = 0; a.paired_rows[0].right_density = 0; a.paired_rows[0].difference = -2;
    const plotted = densityPlotData(a, "Study", 0, "density");
    expect(plotted.points.find((p) => p.condition === "B")?.value).toBe(0);
    expect(plotted.undefinedDonors).toHaveLength(1);
  });
  it.each(["missing-field", "foreign-donor", "duplicate-row", "duplicate-field", "nonfinite", "wrong-pair", "wrong-mean-count"])("refuses %s evidence", (tamper) => {
    const a = aggregation();
    if (tamper === "missing-field") a.input_snapshots.shift();
    if (tamper === "foreign-donor") a.input_snapshots[0].sample!.data.biological_replicate = "D9";
    if (tamper === "duplicate-row") a.donor_rows.push(a.donor_rows[0]);
    if (tamper === "duplicate-field") a.donor_rows[0].field_result_ids[1] = a.donor_rows[0].field_result_ids[0];
    if (tamper === "nonfinite") a.donor_rows[0].density = Infinity;
    if (tamper === "wrong-pair") a.paired_rows[0].right_density = 3;
    if (tamper === "wrong-mean-count") a.condition_rows[0].n = 3;
    expect(() => densityPlotData(a, "Study", 0, "density")).toThrow();
  });
  it("refuses duplicate paired donors and absent pair declarations", () => {
    const a = aggregation(); a.paired_rows.push(a.paired_rows[0]);
    expect(() => densityPlotData(a, "Study", 0, "paired-difference")).toThrow();
    a.condition_pair = null;
    expect(() => densityPlotData(a, "Study", 0, "paired-difference")).toThrow();
  });
  it("returns an empty finite display for a band with no defined values", () => {
    const data = densityPlotData(aggregation(), "Unknown study", 0, "density");
    expect(data.points).toEqual([]); expect(data.domain).toEqual([0, 1]);
  });
});
