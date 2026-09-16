/** Annotation bytes need more room than ordinary task settings, while remaining
 * below the durable project's 16 MiB JSON record bound. */
export function assertResearchRequestBound(operation: string, request: object): void {
  const maximum = operation === "roi_import" ? 12 * 1024 ** 2 : 1024 ** 2;
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > maximum)
    throw new Error(`Research request exceeds the ${maximum / 1024 ** 2} MiB byte limit.`);
}
