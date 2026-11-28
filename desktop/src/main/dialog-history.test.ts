// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => process.env.LOCI_DIALOG_HISTORY_TEST_ROOT,
  },
}));

import {
  rememberedDialogDirectory,
  rememberDialogDirectory,
} from "./dialog-history";

let root: string;

describe("dialog history", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-dialog-history-"));
    process.env.LOCI_DIALOG_HISTORY_TEST_ROOT = root;
  });

  afterEach(async () => {
    delete process.env.LOCI_DIALOG_HISTORY_TEST_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps image-open history separate from existing import and export locations", async () => {
    const imports = path.join(root, "imports");
    const exports = path.join(root, "exports");
    const images = path.join(root, "images");
    await Promise.all([imports, exports, images].map((directory) =>
      fs.mkdir(directory, { recursive: true })));

    await Promise.all([
      rememberDialogDirectory("import", imports),
      rememberDialogDirectory("export", exports),
    ]);
    await expect(rememberedDialogDirectory("imageOpen")).resolves.toBeUndefined();
    await rememberDialogDirectory("imageOpen", images);

    const [canonicalImports, canonicalExports, canonicalImages] = await Promise.all([
      fs.realpath(imports),
      fs.realpath(exports),
      fs.realpath(images),
    ]);
    await expect(rememberedDialogDirectory("import")).resolves.toBe(canonicalImports);
    await expect(rememberedDialogDirectory("export")).resolves.toBe(canonicalExports);
    await expect(rememberedDialogDirectory("imageOpen")).resolves.toBe(canonicalImages);
    const stored = JSON.parse(await fs.readFile(path.join(root, "dialog-history.json"), "utf8"));
    expect(stored).toEqual({
      import: canonicalImports,
      export: canonicalExports,
      imageOpen: canonicalImages,
    });
    expect((await fs.stat(path.join(root, "dialog-history.json"))).mode & 0o077).toBe(0);
  });

  it("ignores malformed history, invalid fields and paths pointing at files", async () => {
    const history = path.join(root, "dialog-history.json");
    for (const contents of ["{", '{"imageOpen":5}', '{"imageOpen":"relative/path"}', JSON.stringify({ imageOpen: history })]) {
      await fs.writeFile(history, contents);
      await expect(rememberedDialogDirectory("imageOpen")).resolves.toBeUndefined();
    }
  });

  it("does not return a removed or relative directory", async () => {
    const removed = path.join(root, "removed");
    await fs.mkdir(removed);
    await rememberDialogDirectory("import", removed);
    await fs.rmdir(removed);
    await expect(rememberedDialogDirectory("import")).resolves.toBeUndefined();

    await fs.writeFile(
      path.join(root, "dialog-history.json"),
      `${JSON.stringify({ import: "relative/path" })}\n`,
    );
    await expect(rememberedDialogDirectory("import")).resolves.toBeUndefined();
  });
});
