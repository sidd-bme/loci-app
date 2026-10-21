/** Annotation bytes need more room than ordinary task settings, while remaining
 * below the durable project's 16 MiB JSON record bound. */
export function assertResearchRequestBound(operation: string, request: object): void {
  const reportJson = (request as { report_json?: unknown }).report_json;
  if (operation === "intensity_save" && reportJson !== undefined &&
      (typeof reportJson !== "string" || Buffer.byteLength(reportJson, "utf8") > 8 * 1024 ** 2))
    throw new Error("Intensity report snapshot exceeds its 8 MiB byte limit.");
  const maximum = operation === "roi_import" ? 12 * 1024 ** 2 :
    operation === "intensity_save" ? (reportJson === undefined ? 8 : 16) * 1024 ** 2 + 1024 :
    operation === "sample_sheet_preview" || operation === "sample_sheet_apply" ? 4 * 1024 ** 2 : 1024 ** 2;
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > maximum)
    throw new Error(`Research request exceeds the ${maximum / 1024 ** 2} MiB byte limit.`);
}
