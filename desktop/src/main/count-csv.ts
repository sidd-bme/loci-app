const SPREADSHEET_FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r", "\n"]);

export interface CountSummaryRow {
  imageName: string;
  cellCount: number;
}

/** Neutralize user-controlled text that spreadsheet apps could treat as a formula. */
export function spreadsheetSafeText(value: string): string {
  return value && SPREADSHEET_FORMULA_PREFIXES.has(value[0]) ? `'${value}` : value;
}

export function csvCell(value: string | number): string {
  const text = typeof value === "string" ? spreadsheetSafeText(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCountSummaryCsv(rows: readonly CountSummaryRow[]): string {
  return [
    "image_name,cell_count",
    ...rows.map((row) => `${csvCell(row.imageName)},${csvCell(row.cellCount)}`),
  ].join("\n") + "\n";
}
