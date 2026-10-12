// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ImageWindowLayoutStore, imageLayoutKey, visibleImageBounds, validateImageLayout, type ImageLayout } from "./image-window-layout";
const layout: ImageLayout = { schema: "loci.image-layout/v1", pinnedIndex: 0, views: [{
  sourceId: "a".repeat(32), sourceSha256: "b".repeat(64), bounds: { x: 2300, y: 100, width: 1080, height: 780 }, display: null }] };
describe("local image layout", () => {
  it("moves a disconnected monitor's window fully onto the remaining display", () => {
    const restored = visibleImageBounds(layout.views[0].bounds, [{ x: 0, y: 25, width: 1440, height: 875 }]);
    expect(restored).toEqual({ x: 360, y: 100, width: 1080, height: 780 });
    expect(visibleImageBounds({ x: -1600, y: 0, width: 2400, height: 2000 }, [{ x: -1440, y: 0, width: 1440, height: 900 }]))
      .toEqual({ x: -1440, y: 0, width: 1440, height: 900 });
  });
  it("rejects malformed identities, oversized windows and impossible pins", () => {
    expect(() => validateImageLayout({ ...layout, pinnedIndex: 2 })).toThrow();
    expect(() => validateImageLayout({ ...layout, views: [{ ...layout.views[0], sourceId: "../../source" }] })).toThrow();
    expect(() => validateImageLayout({ ...layout, views: [{ ...layout.views[0], bounds: { x: 0, y: 0, width: Infinity, height: 1 } }] })).toThrow();
  });
  it("persists separate document layouts atomically without canonical paths in records", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "loci-view-layout-"));
    try {
      const store = new ImageWindowLayoutStore(directory);
      const identity = "/local/private/research.loci-study";
      expect(await store.read(identity)).toBeNull();
      await store.write(identity, layout);
      await store.write("another-study", { ...layout, pinnedIndex: null });
      expect(await store.read(identity)).toEqual(layout);
      expect((await readdir(directory)).length).toBe(2);
      expect(await readFile(path.join(directory, `${imageLayoutKey(identity)}.json`), "utf8")).not.toContain(identity);
      await writeFile(path.join(directory, `${imageLayoutKey(identity)}.json`), "invalid json");
      await expect(store.read(identity)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true }); }
  });
});
