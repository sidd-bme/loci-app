import { expect, it } from "vitest";
import type { ResearchSource } from "../shared/research-contracts";
import { buildSourceBrowser, filterSourceBrowser, sourceAncestors, sourceDisplayPath, visibleSourceRows } from "./source-browser";

const image = (id: string, relative?: string, root: { id: string; name: string } | null = null): ResearchSource => ({
  id, name: "Preview.tif", sha256: id.repeat(64), metadata: {},
  ...(relative ? { browser_location: { relative_path: relative, root } } : {}),
});

it("retains proven legacy folders, descendant counts and source order without inventing a root", () => {
  const sources = [image("a", "FBS/Day 1/Preview.tif"), image("b", "FBS/Day 1/Second.tif"), image("c", "SFM/Preview.tif"), image("d")];
  const nodes = buildSourceBrowser(sources);
  expect(nodes.map(node => node.label)).toEqual(["FBS", "SFM", "Preview.tif"]);
  expect(nodes[0]).toMatchObject({ kind: "folder", sourceIds: ["a", "b"] });
  expect(sourceAncestors(nodes, "b")).toHaveLength(2);
  expect(sourceDisplayPath(sources[0], sources)).toBe("FBS/Day 1/Preview.tif");
  expect(sourceDisplayPath(sources[3], sources)).toBe("Preview.tif");
});

it("keeps same-named explicit roots separate and disambiguates only collisions with stable suffixes", () => {
  const first = image("a", "FBS/Preview.tif", { id: "abcdef11", name: "Study images" });
  const second = image("b", "FBS/Preview.tif", { id: "abcdef22", name: "Study images" });
  const nodes = buildSourceBrowser([first, second]);
  expect(nodes).toHaveLength(2);
  expect(nodes.map(node => node.id)).toEqual(["root:abcdef11", "root:abcdef22"]);
  expect(nodes.map(node => node.label)).toEqual(["Study images · abcdef11", "Study images · abcdef22"]);
  expect(sourceDisplayPath(first, [second, first])).toBe(sourceDisplayPath(first, [first, second]));
  expect(sourceDisplayPath(first, [first])).toBe("Study images/FBS/Preview.tif");
});

it("matches filenames and folders case-insensitively while retaining matching ancestors", () => {
  const nodes = buildSourceBrowser([image("a", "FBS/Day 1/Preview.tif"), image("b", "FBS/Day 2/Other.tif"), image("c", "SFM/Other.tif")]);
  const filename = filterSourceBrowser(nodes, "PREVIEW");
  expect(visibleSourceRows(filename, new Set(), true).map(row => row.node.label)).toEqual(["FBS", "Day 1", "Preview.tif"]);
  const folder = filterSourceBrowser(nodes, "fbs");
  expect(visibleSourceRows(folder, new Set(), true).filter(row => row.node.kind === "image")).toHaveLength(2);
  expect(filterSourceBrowser(nodes, "absent")).toEqual([]);
});

it("keeps flat manually imported sources distinct by ID and ignores malformed folder hints", () => {
  const first = image("a"), second = image("b"), invalid = image("c", "/private/folder/Preview.tif");
  const nodes = buildSourceBrowser([first, second, invalid]);
  expect(nodes.every(node => node.kind === "image")).toBe(true);
  expect(nodes.map(node => node.id)).toEqual(["image:a", "image:b", "image:c"]);
  expect(sourceDisplayPath(invalid)).toBe("Preview.tif");
});

it("indexes shared root labels once per source snapshot rather than rescanning for every leaf", () => {
  let reads = 0;
  const sources = Array.from({ length: 200 }, (_, index) => {
    const source = image(String(index));
    Object.defineProperty(source, "browser_location", { get: () => {
      reads += 1;
      return { relative_path: `FBS/Image_${index}.tif`, root: { id: "shared-root", name: "Images" } };
    } });
    return source;
  });
  buildSourceBrowser(sources);
  for (const source of sources) expect(sourceDisplayPath(source, sources)).toContain("Images/FBS/Image_");
  expect(reads).toBeLessThan(sources.length * 10);
});
