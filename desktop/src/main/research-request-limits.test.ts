import { describe, expect, it } from "vitest";
import { assertResearchRequestBound } from "./research-request-limits";

describe("research request byte limits", () => {
  it("allows the bounded GUI PNG's base64 transport without widening scene writes", () => {
    const request = { capture: { image: 'data:image/png;base64,' + 'a'.repeat(4 * Math.ceil(8 * 1024 ** 2 / 3)), rendering: 'r'.repeat(256 * 1024) } };
    expect(() => assertResearchRequestBound("volume_view_request_complete", request)).not.toThrow();
    expect(() => assertResearchRequestBound("save_volume_view", request)).toThrow("1 MiB");
    expect(() => assertResearchRequestBound("volume_view_request_complete", { image: 'a'.repeat(12 * 1024 ** 2) })).toThrow("12 MiB");
  });
  it("accepts bounded annotation bytes without extending ordinary settings grants", () => {
    const request = { payload: "a".repeat(2 * 1024 ** 2) };
    expect(() => assertResearchRequestBound("roi_import", request)).not.toThrow();
    expect(() => assertResearchRequestBound("run_recipe", request)).toThrow("1 MiB");
    expect(() => assertResearchRequestBound("roi_import", { payload: "a".repeat(12 * 1024 ** 2) })).toThrow("12 MiB");
  });
  it("counts UTF-8 bytes rather than JavaScript characters", () => {
    const request = { text: "界".repeat(400_000) };
    expect(JSON.stringify(request).length).toBeLessThan(1024 ** 2);
    expect(() => assertResearchRequestBound("run_recipe", request)).toThrow("1 MiB");
  });
  it("bounds report snapshots and sample previews without widening ordinary operation requests", () => {
    const report = { report: "a".repeat(6 * 1024 ** 2) };
    expect(() => assertResearchRequestBound("intensity_save", report)).not.toThrow();
    expect(() => assertResearchRequestBound("run_recipe", report)).toThrow("1 MiB");
    expect(() => assertResearchRequestBound("intensity_save", { report: "a".repeat(9 * 1024 ** 2) })).toThrow(/byte limit/);
    expect(() => assertResearchRequestBound("sample_sheet_apply", { preview: "a".repeat(4 * 1024 ** 2) })).toThrow(/byte limit/);
  });
  it("bounds decoded report text separately from its escaped transport envelope", () => {
    const escaped = { report_json: '"'.repeat(6 * 1024 ** 2) };
    expect(() => assertResearchRequestBound("intensity_save", escaped)).not.toThrow();
    expect(() => assertResearchRequestBound("run_recipe", escaped)).toThrow("1 MiB");
    expect(() => assertResearchRequestBound("intensity_save", { report_json: '"'.repeat(8 * 1024 ** 2 + 1) })).toThrow("8 MiB");
    expect(() => assertResearchRequestBound("intensity_save", { report_json: "界".repeat(3 * 1024 ** 2) })).toThrow("8 MiB");
    expect(() => assertResearchRequestBound("intensity_save", { report_json: {} })).toThrow("8 MiB");
  });
});
