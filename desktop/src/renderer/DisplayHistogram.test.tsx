// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchSource } from "../shared/research-contracts";
import { checkedHistogram, HistogramPlot, type HistogramRecord } from "./DisplayHistogram";

afterEach(cleanup);
const record: HistogramRecord = { component: 0, label: "Channel 1", units: "native scalar sample values", dtype: "uint16",
  sample_count: 100, min: 0, max: 4000, bin_range: [0, 4000], counts: [1, 49, 49, 1], percentile_1: 0, percentile_99: 3000 };
const source = { id: "a".repeat(32), sha256: "b".repeat(64) } as ResearchSource;
const response = { source_id: source.id, source_sha256: source.sha256, sample: { kind: "deterministic-native-pyramid-level", t: 0, z: 3, level: 1, viewport_dependent: false, shape: [10, 10], sample_count_per_component: 100 }, histograms: [record] };
describe("source histogram contract", () => {
  it("rejects a stale source, different plane, viewport sample, and malformed sample totals", () => {
    expect(checkedHistogram(response, source, 0, 3).histograms[0].sample_count).toBe(100);
    for (const value of [{ ...response, source_sha256: "c".repeat(64) },
      { ...response, sample: { ...response.sample, z: 2 } },
      { ...response, sample: { ...response.sample, viewport_dependent: true } },
      { ...response, histograms: [{ ...record, sample_count: 99 }] },
      { ...response, sample: { ...response.sample, shape: [10, 11] } },
      { ...response, sample: { ...response.sample, sample_count_per_component: NaN } },
      { ...response, histograms: [null] },
      { ...response, histograms: [{ ...record, counts: [NaN, 99] }] }]) {
      expect(() => checkedHistogram(value, source, 0, 3)).toThrow(/does not match/);
    }
  });
  it("requires an explicit action to change the range and keeps log counts display-only", () => {
    const onRange = vi.fn();
    render(<HistogramPlot records={[record]} low={0} high={4000} label="Channel 1" onRange={onRange} />);
    expect(onRange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Log counts" }));
    expect(onRange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("slider", { name: "Channel 1 black point" }), { target: { value: "250" } });
    expect(onRange).toHaveBeenLastCalledWith(250, 4000);
    fireEvent.click(screen.getByRole("button", { name: "Trim 1–99%" }));
    expect(onRange).toHaveBeenLastCalledWith(0, 3000);
  });
  it("declines a percentile window for a constant source", () => {
    render(<HistogramPlot records={[{ ...record, percentile_1: 20, percentile_99: 20 }]} low={0} high={4000} label="Flat image" onRange={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Trim 1–99%" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
