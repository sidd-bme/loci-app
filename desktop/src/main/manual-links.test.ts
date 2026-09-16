import { describe, expect, it } from "vitest";
import { isLociManualLink } from "./manual-links";

describe("bundled manual documentation links", () => {
  it("allows documentation and anchors, but rejects alternate origins and routes", () => {
    expect(isLociManualLink("https://github.com/sidd-bme/Loci/blob/main/docs/CAPABILITY_MATRIX.md#learned-analysis-routes")).toBe(true);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://github.com.evil.test/sidd-bme/Loci/blob/main/docs/README.md",
      "https://user:secret@github.com/sidd-bme/Loci/blob/main/docs/README.md", "https://github.com/sidd-bme/Loci/blob/main/docs/../README.md",
      "https://github.com/sidd-bme/Loci/blob/main/docs/README.md?token=private", "https://github.com/sidd-bme/Other/blob/main/docs/README.md"])
      expect(isLociManualLink(url)).toBe(false);
  });
});
