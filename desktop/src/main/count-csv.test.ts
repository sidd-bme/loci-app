import { describe, expect, it } from "vitest";

import { csvCell, serializeCountSummaryCsv, spreadsheetSafeText } from "./count-csv";

describe("count CSV safety", () => {
  it.each(["=1+1.png", "+cmd.png", "-2.png", "@SUM.png", "\tformula.png", "\rformula.png", "\nformula.png"])(
    "neutralizes spreadsheet formula prefix in %j",
    (value) => {
      expect(spreadsheetSafeText(value)).toBe(`'${value}`);
      expect(csvCell(value)).toContain(`'${value}`);
    },
  );

  it("preserves regular text and numeric cells", () => {
    expect(spreadsheetSafeText("plate-01.png")).toBe("plate-01.png");
    expect(csvCell("plate-01.png")).toBe("plate-01.png");
    expect(csvCell(-1)).toBe("-1");
  });

  it("retains correct CSV quoting after neutralization", () => {
    expect(csvCell('=SUM(1,2) "plate".png')).toBe('"\'=SUM(1,2) ""plate"".png"');
    expect(
      serializeCountSummaryCsv([
        { imageName: "=SUM(1,2).png", cellCount: 6 },
        { imageName: "nested/plate-01.png", cellCount: 12 },
      ]),
    ).toBe('image_name,cell_count\n"\'=SUM(1,2).png",6\nnested/plate-01.png,12\n');
  });
});
