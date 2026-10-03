/** Only the repository documentation linked by the bundled manual opens externally. */
export function isLociManualLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port &&
      !url.username && !url.password && !url.search &&
      /^\/sidd-bme\/loci-app\/blob\/main\/docs\/[A-Za-z0-9_.-]+\.md$/.test(url.pathname);
  } catch { return false; }
}
