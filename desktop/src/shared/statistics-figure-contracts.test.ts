import { describe, expect, it } from "vitest";
import { checkedStatisticsFigureRequest, statisticsFigurePixels, type StatisticsFigureExportRequest } from "./statistics-figure-contracts";
export function statisticsRequest(): StatisticsFigureExportRequest {
  return { schema_version: "loci.statistics-figure-request/v1", source_id: "a".repeat(32), source_sha256: "b".repeat(64), result_id: "c".repeat(32), revision_hash: "d".repeat(64), query_sha256: "e".repeat(64), membership_sha256: "f".repeat(64), query: { x_metric: "measure", y_metric: "voxel_count", filters: [], sort: null, offset: 0, limit: 25, plot_limit: 500, bins: 16, selected_label: null }, chart: "histogram", domain: { mode: "full" }, width_mm: 85, height_mm: 65, preset: "publication-monochrome" };
}
describe("bounded trusted statistics request", () => {
  it("uses physically sized real 600 DPI pixels", () => {
    expect(statisticsFigurePixels(85, 65)).toEqual([2008, 1535]);
    expect(statisticsFigurePixels(180, 110)).toEqual([4252, 2598]);
    expect(checkedStatisticsFigureRequest(statisticsRequest())).toEqual(statisticsRequest());
  });
  it("accepts equal finite extreme and subnormal domains without padding", () => {
    for (const n of [Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      expect(checkedStatisticsFigureRequest({ ...statisticsRequest(), domain: { mode: "current", x: [n, n], y: [0, 1] } })).toBeTruthy();
    }
  });
  it.each([
    { png_base64: "artwork" }, { data: [] }, { width_mm: 300, height_mm: 300 }, { width_mm: NaN },
    { result_id: "path" }, { membership_sha256: "bad" },
    { domain: { mode: "full", x: [0, 1] } }, { domain: { mode: "current", x: [1, 0], y: [0, 1] } },
    { domain: { mode: "current", x: [0, Infinity], y: [0, 1] } },
  ])("rejects extra artwork, invalid binding/options/domain: %j", (patch) => {
    expect(() => checkedStatisticsFigureRequest({ ...statisticsRequest(), ...patch })).toThrow();
  });
  it("rejects nested extras and missing normalized keys", () => {
    const request = statisticsRequest();
    expect(() => checkedStatisticsFigureRequest({ ...request, query: { ...request.query, data: [] } })).toThrow();
    expect(() => checkedStatisticsFigureRequest({ ...request, query: { ...request.query, filters: [{ metric: "measure", min: 0, path: "x" }] } })).toThrow();
    expect(() => checkedStatisticsFigureRequest({ ...request, query: { ...request.query, sort: undefined } })).toThrow();
  });
});
