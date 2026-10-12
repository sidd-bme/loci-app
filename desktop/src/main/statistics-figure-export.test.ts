// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { exportStatisticsFigureBundle, checkedStatisticsFigureReceipt } from "./statistics-figure-export";
import type { StatisticsFigureExportRequest } from "../shared/statistics-figure-contracts";
const request: StatisticsFigureExportRequest = { schema_version: "loci.statistics-figure-request/v1", source_id: "a".repeat(32), source_sha256: "b".repeat(64), result_id: "c".repeat(32), revision_hash: "d".repeat(64), query_sha256: "e".repeat(64), membership_sha256: "f".repeat(64), query: { x_metric: "measure", y_metric: "voxel_count", filters: [], sort: null, offset: 0, limit: 25, plot_limit: 500, bins: 16, selected_label: null }, chart: "histogram", domain: { mode: "full" }, width_mm: 85, height_mm: 65, preset: "publication-monochrome" };
const population = { schema: "loci.population/v1", ...request };
const receipt = { schema_version: "loci.statistics-figure-receipt/v1", basename: "Statistics.loci-figure", source_id: request.source_id, source_sha256: request.source_sha256, result_id: request.result_id, revision_hash: request.revision_hash, query_sha256: request.query_sha256, membership_sha256: request.membership_sha256, width_mm: 85, height_mm: 65, width_px: 2008, height_px: 1535, dpi: 600, artifacts: Object.fromEntries(["figure.svg", "figure.png", "manifest.json"].map((name) => [name, { sha256: "a".repeat(64), size_bytes: 12 }])) };
function options() {
  return { request, applicationVersion: "0.1.0", verifyPopulation: vi.fn().mockResolvedValue(population), pickDestination: vi.fn().mockResolvedValue("/tmp/Statistics.loci-figure"), publish: vi.fn().mockResolvedValue(receipt) };
}
describe("trusted statistics export orchestration", () => {
  it("rejects oversized requests before any query or destination picker", async () => {
    const opts = options();
    await expect(exportStatisticsFigureBundle({ ...opts, request: { ...request, payload: "x".repeat(1024 ** 2) } })).rejects.toThrow(/byte limit/);
    expect(opts.verifyPopulation).not.toHaveBeenCalled(); expect(opts.pickDestination).not.toHaveBeenCalled(); expect(opts.publish).not.toHaveBeenCalled();
  });
  it("verifies both sides of native picker and publishes only trusted options", async () => {
    const opts = options();
    await expect(exportStatisticsFigureBundle(opts)).resolves.toEqual(receipt);
    expect(opts.verifyPopulation).toHaveBeenCalledTimes(2);
    expect(opts.publish).toHaveBeenCalledExactlyOnceWith(request, "/tmp/Statistics.loci-figure", "0.1.0");
  });
  it.each(["source_sha256", "revision_hash", "query_sha256", "membership_sha256"])("rejects stale %s after picker without publication", async (key) => {
    const opts = options(); opts.verifyPopulation.mockResolvedValueOnce(population).mockResolvedValueOnce({ ...population, [key]: "9".repeat(64) });
    await expect(exportStatisticsFigureBundle(opts)).rejects.toThrow(/changed/);
    expect(opts.publish).not.toHaveBeenCalled();
  });
  it("rejects before picker and makes cancel side-effect free", async () => {
    const opts = options(); opts.verifyPopulation.mockResolvedValueOnce({ ...population, query: { ...request.query, bins: 32 } });
    await expect(exportStatisticsFigureBundle(opts)).rejects.toThrow(/changed/);
    expect(opts.pickDestination).not.toHaveBeenCalled();
    const canceled = options(); canceled.pickDestination.mockResolvedValueOnce(null);
    await expect(exportStatisticsFigureBundle(canceled)).resolves.toBeNull();
    expect(canceled.verifyPopulation).toHaveBeenCalledTimes(1); expect(canceled.publish).not.toHaveBeenCalled();
  });
  it("rejects incomplete, unbound and path-leaking publication receipts", () => {
    for (const patch of [{ artifacts: {} }, { path: "/private/study" }, { basename: "/private/Statistics.loci-figure" }, { width_px: 20 }, { revision_hash: "1".repeat(64) }]) {
      expect(() => checkedStatisticsFigureReceipt({ ...receipt, ...patch }, request, "/tmp/Statistics.loci-figure")).toThrow();
    }
  });
});
