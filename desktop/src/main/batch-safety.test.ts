// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalizeBatchRoot,
  containedBatchDirectoryPath,
  createContainedBatchDirectory,
  isLociExportBundleDirectory,
  sanitizeBatchFailureMessage,
} from "./batch-safety";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-batch-safety-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("batch path safety", () => {
  it("resolves a mirrored directory without creating it in the main process", async () => {
    const root = await canonicalizeBatchRoot(await temporaryRoot());
    const directory = containedBatchDirectoryPath(root, "experiment/day-2/field-01.tif");

    expect(directory).toBe(path.join(root, "experiment", "day-2"));
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an escaping mirrored relative path before filesystem access", async () => {
    const root = await canonicalizeBatchRoot(await temporaryRoot());

    expect(() => containedBatchDirectoryPath(root, "../../outside/field.tif")).toThrow(
      /invalid/i,
    );
  });

  it("creates a mirrored directory beneath the canonical destination", async () => {
    const root = await canonicalizeBatchRoot(await temporaryRoot());
    const directory = await createContainedBatchDirectory(
      root,
      "experiment/day-2/field-01.tif",
    );

    expect(directory).toBe(path.join(root, "experiment", "day-2"));
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
  });

  it("rejects an existing symlink without creating content through it", async () => {
    const root = await canonicalizeBatchRoot(await temporaryRoot());
    const outside = await temporaryRoot();
    await fs.symlink(outside, path.join(root, "experiment"), process.platform === "win32" ? "junction" : "dir");

    await expect(createContainedBatchDirectory(
      root,
      "experiment/day-2/field-01.tif",
    )).rejects.toThrow(/symbolic link/i);
    await expect(fs.stat(path.join(outside, "day-2"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognizes a marker-backed export when only one artifact was selected", async () => {
    const root = await temporaryRoot();
    const bundle = path.join(root, "field-01_loci");
    await fs.mkdir(bundle);
    await Promise.all([
      fs.writeFile(
        path.join(bundle, "field-01_summary.csv"),
        "image_name,cell_count\nfield-01.tif,42\n",
      ),
      fs.writeFile(path.join(bundle, "loci-export.json"), JSON.stringify({
        bundle_kind: "loci-export",
        artifacts: {
          summary: { filename: "field-01_summary.csv" },
        },
      })),
    ]);

    expect(await isLociExportBundleDirectory(bundle)).toBe(true);
  });

  it("does not trust a malformed export marker", async () => {
    const root = await temporaryRoot();
    const bundle = path.join(root, "field-01_loci");
    await fs.mkdir(bundle);
    await Promise.all([
      fs.writeFile(path.join(bundle, "field-01_overlay.png"), "overlay"),
      fs.writeFile(path.join(bundle, "loci-export.json"), '{"bundle_kind":'),
    ]);

    expect(await isLociExportBundleDirectory(bundle)).toBe(false);
  });

  it("falls back safely when an export marker is unreadable", async () => {
    const root = await temporaryRoot();
    const bundle = path.join(root, "field-01_loci");
    await fs.mkdir(bundle);
    await Promise.all([
      fs.writeFile(path.join(bundle, "field-01_overlay.png"), "overlay"),
      fs.writeFile(
        path.join(bundle, "loci-export.json"),
        JSON.stringify({ bundle_kind: "loci-export" }),
      ),
    ]);
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("permission denied"));

    expect(await isLociExportBundleDirectory(bundle)).toBe(false);
  });

  it("continues to recognize legacy complete export bundles", async () => {
    const root = await temporaryRoot();
    const bundle = path.join(root, "field-01_loci");
    await fs.mkdir(bundle);
    await Promise.all([
      fs.writeFile(path.join(bundle, "field-01_overlay.png"), "overlay"),
      fs.writeFile(path.join(bundle, "field-01_labels.tiff"), "labels"),
      fs.writeFile(path.join(bundle, "field-01_measurements.csv"), "measurements"),
      fs.writeFile(path.join(bundle, "field-01_analysis.json"), "analysis"),
    ]);

    expect(await isLociExportBundleDirectory(bundle)).toBe(true);
  });

  it("leaves a name-only laboratory folder importable", async () => {
    const root = await temporaryRoot();
    const ordinary = path.join(root, "experiment_loci");
    await fs.mkdir(ordinary);
    await fs.writeFile(path.join(ordinary, "field.png"), "ordinary source image");

    expect(await isLociExportBundleDirectory(ordinary)).toBe(false);
    expect(await isLociExportBundleDirectory(root)).toBe(false);
  });
});

describe("batch failure privacy", () => {
  it("removes known and otherwise quoted absolute paths", () => {
    const message = sanitizeBatchFailureMessage(
      "Permission denied at '/Volumes/Lab Data/results/day-2' while reading /Volumes/Lab Data/raw/field.tif",
      [
        { value: "/Volumes/Lab Data/raw/field.tif", replacement: "field.tif" },
        { value: "/Volumes/Lab Data/results", replacement: "<export destination>" },
      ],
    );

    expect(message).not.toContain("/Volumes/");
    expect(message).toContain("<export destination>");
    expect(message).toContain("field.tif");
  });

  it("redacts Windows paths without damaging slash-separated format names", () => {
    const message = sanitizeBatchFailureMessage(
      "TIFF/JPEG decoder failed at C:\\Users\\Researcher\\private lab\\field.tif",
      [],
    );

    expect(message).toContain("TIFF/JPEG");
    expect(message).not.toContain("Researcher");
    expect(message).toContain("<local path>");
  });
});
