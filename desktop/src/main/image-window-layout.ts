import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ImageWindowPresentation } from "../shared/image-window-api";
import { HEX_32_PATTERN, HEX_64_PATTERN } from "../shared/image-view-contracts";

export interface ImageWindowBounds { x: number; y: number; width: number; height: number }
export interface ImageLayoutView {
  sourceId: string;
  sourceSha256: string;
  bounds: ImageWindowBounds;
  display: ImageWindowPresentation | null;
}
export interface ImageLayout { schema: "loci.image-layout/v1"; views: ImageLayoutView[]; pinnedIndex: number | null }

/** Keep native handles and canonical paths out of the on-disk layout descriptor. */
export function imageLayoutKey(documentIdentity: string): string {
  return createHash("sha256").update(documentIdentity).digest("hex");
}
export function visibleImageBounds(bounds: ImageWindowBounds, displays: ImageWindowBounds[]): ImageWindowBounds {
  const display = displays.find((area) => Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x) >= 160 &&
    Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y) >= 120) ?? displays[0];
  if (!display) throw new Error("No display is available for an image window.");
  const width = Math.min(Math.max(720, bounds.width), display.width);
  const height = Math.min(Math.max(480, bounds.height), display.height);
  return { width, height, x: Math.max(display.x, Math.min(bounds.x, display.x + display.width - width)),
    y: Math.max(display.y, Math.min(bounds.y, display.y + display.height - height)) };
}
export function validateImageLayout(value: unknown): ImageLayout {
  const layout = value as ImageLayout;
  if (!layout || layout.schema !== "loci.image-layout/v1" || !Array.isArray(layout.views) || layout.views.length > 2 ||
    (layout.pinnedIndex !== null && (!Number.isSafeInteger(layout.pinnedIndex) || layout.pinnedIndex < 0 || layout.pinnedIndex >= layout.views.length)))
    throw new Error("The saved image-window layout is invalid.");
  for (const view of layout.views) {
    if (!view || typeof view.sourceId !== "string" || typeof view.sourceSha256 !== "string" || !HEX_32_PATTERN.test(view.sourceId) || !HEX_64_PATTERN.test(view.sourceSha256) || !view.bounds ||
      !Object.values(view.bounds).every((n) => typeof n === "number" && Number.isSafeInteger(n)) ||
      ![view.bounds.x, view.bounds.y, view.bounds.width, view.bounds.height].every(Number.isFinite) ||
      view.bounds.width < 1 || view.bounds.height < 1 || view.bounds.width > 16384 || view.bounds.height > 16384)
      throw new Error("The saved image-window binding or bounds are invalid.");
  }
  return layout;
}
export function displayForLayout(presentation: ImageWindowPresentation | null): ImageWindowPresentation | null {
  // Drafts and annotations are not layout records. The engine restores committed annotations.
  return presentation ? { ...structuredClone(presentation), tool: "navigate", draft: [], annotations: [] } : null;
}
export class ImageWindowLayoutStore {
  private writes = Promise.resolve();
  constructor(private readonly directory: string) {}
  async read(documentIdentity: string): Promise<ImageLayout | null> {
    const file = path.join(this.directory, `${imageLayoutKey(documentIdentity)}.json`);
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid saved image layout file.");
    return validateImageLayout(JSON.parse(await fs.readFile(file, "utf8")));
  }
  write(documentIdentity: string, layout: ImageLayout): Promise<void> {
    const content = JSON.stringify(validateImageLayout(layout));
    if (Buffer.byteLength(content) > 1024 * 1024) return Promise.reject(new Error("The image layout exceeds its size limit."));
    const file = path.join(this.directory, `${imageLayoutKey(documentIdentity)}.json`);
    const write = async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    };
    const next = this.writes.then(write, write);
    this.writes = next;
    return next;
  }
}
