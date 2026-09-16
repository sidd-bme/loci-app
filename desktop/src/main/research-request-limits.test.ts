import { describe, expect, it } from "vitest";
import { assertResearchRequestBound } from "./research-request-limits";

describe("research request byte limits", () => {
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
});
