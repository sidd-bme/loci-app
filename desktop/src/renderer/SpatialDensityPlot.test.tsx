// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpatialDensityAggregation, SpatialDensityInput } from "../shared/spatial-density-contracts";
import { SpatialDensityPlot } from "./SpatialDensityPlot";

afterEach(cleanup);

function data(): SpatialDensityAggregation {
  const fields = [0, 1, 2].map((index) => ({
    result: { id: String(index + 1).repeat(32), revision_hash: String(index + 1).repeat(64), source_id: String(index + 1).repeat(32),
      source_sha256: String(index + 1).repeat(64), selection: { t: 0, z: index === 2 ? 1 : 0 } },
    sample: { id: String(index + 1).repeat(32), revision: 1, data: { study: index === 2 ? "Other" : "Study", sample: `Field ${index + 1}`, condition: index === 1 ? "Treated" : "Control", biological_replicate: "D1" } },
    phenotype: null,
  })) as SpatialDensityInput[];
  return {
    schema: "loci.spatial-density-aggregation/v2", rules: {}, contract: { distance_unit: "um", area_unit: "um^2", band_edges: [0, 100, 300], exclude_crop_border: false, rules: {} },
    phenotype_name: "CD3-positive", stratum: { t: 0, z: 0 }, condition_pair: ["Control", "Treated"], input_snapshots: fields,
    donor_rows: fields.map((f, i) => ({ study: f.sample!.data.study, condition: f.sample!.data.condition, biological_replicate: "D1", band_index: 0,
      object_count: [0, 2, 6][i], sampled_area: 10, density: [0, 0.2, 0.6][i], density_status: "defined", field_result_ids: [f.result.id], n_fields: 1 })),
    condition_rows: [], field_rows: [], paired_rows: [{ study: "Study", biological_replicate: "D1", band_index: 0, left_condition: "Control", right_condition: "Treated", left_density: 0, right_density: 0.2, difference: 0.2, status: "defined" }],
    paired_summary: [], unmatched_donors: [], exclusion_audit: [],
  };
}
const show = (aggregation = data(), disabled = false) => {
  const onInspect = vi.fn();
  const view = render(<SpatialDensityPlot aggregation={aggregation} reportHash={"a".repeat(64)} onInspect={onInspect} disabled={disabled} />);
  const study = screen.queryByLabelText("Donor plot study");
  if (study) fireEvent.change(study, { target: { value: "Study" } });
  return { onInspect, ...view };
};
describe("donor plot inspection", () => {
  it("opens the exact field behind a clicked donor and retains zero values", () => {
    const { onInspect, container } = show();
    const point = screen.getByRole("button", { name: /Inspect donor D1, Control: 0 / });
    expect(point).toHaveAttribute("data-value", "0");
    fireEvent.click(point);
    const fields = screen.getByRole("region", { name: "Fields for donor D1" });
    expect(within(fields).getByText("1 contributing fields in this saved endpoint.")).toBeInTheDocument();
    fireEvent.click(within(fields).getByRole("button", { name: `Inspect donor field ${"1".repeat(32)}` }));
    expect(onInspect).toHaveBeenCalledWith(data().input_snapshots[0]);
    expect(container.querySelector(".density-plot-section")).toHaveAttribute("data-report-hash", "a".repeat(64));
  });
  it("supports keyboard point selection and paired-difference field drilldown", () => {
    show();
    fireEvent.change(screen.getByLabelText("Donor plot measure"), { target: { value: "paired-difference" } });
    const point = screen.getByRole("button", { name: /Inspect donor D1, Treated − Control/ });
    fireEvent.keyDown(point, { key: "Enter" });
    expect(screen.getByText("2 contributing fields in this saved endpoint.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Fields for donor D1" })).getAllByRole("button")).toHaveLength(2);
  });
  it("clears the selected donor when the study or band changes", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Inspect donor D1, Control/ }));
    fireEvent.change(screen.getByLabelText("Donor plot study"), { target: { value: "Other" } });
    expect(screen.queryByRole("region", { name: "Fields for donor D1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inspect donor D1, Control/ })).toHaveAttribute("data-value", "0.6");
    fireEvent.change(screen.getByLabelText("Donor plot distance band"), { target: { value: "1" } });
    expect(screen.getByText("No defined donor values in this study and distance band.")).toBeInTheDocument();
  });
  it("provides the same exact selection through an accessible donor list", () => {
    show();
    fireEvent.change(screen.getByLabelText("Inspect plotted donor"), { target: { value: JSON.stringify(["Treated", "D1"]) } });
    expect(screen.getByRole("region", { name: "Fields for donor D1" })).toHaveTextContent("Field 2");
  });
  it("does not navigate during disabled interaction", () => {
    const { onInspect } = show(data(), true);
    const point = screen.getByRole("button", { name: /Inspect donor D1, Control/ });
    expect(point).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(point); fireEvent.keyDown(point, { key: " " });
    expect(screen.queryByRole("region", { name: "Fields for donor D1" })).not.toBeInTheDocument();
    expect(onInspect).not.toHaveBeenCalled();
  });
  it("reports invalid exact bindings instead of rendering a misleading chart", () => {
    const a = data(); a.donor_rows[0].field_result_ids = ["f".repeat(32)];
    const { container } = show(a);
    expect(screen.getByRole("alert")).toHaveTextContent("exact saved field bindings");
    expect(container.querySelector("svg")).toBeNull();
  });
});
