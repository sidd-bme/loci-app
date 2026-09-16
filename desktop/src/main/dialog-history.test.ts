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

  it("keeps microscopy and export locations separate", async () => {
    const imports = path.join(root, "images");
    const exports = path.join(root, "exports");
    await Promise.all([imports, exports].map((directory) =>
      fs.mkdir(directory, { recursive: true })));

    await Promise.all([
      rememberDialogDirectory("import", imports),
      rememberDialogDirectory("export", exports),
    ]);

    const [canonicalImports, canonicalExports] = await Promise.all([
      fs.realpath(imports),
      fs.realpath(exports),
    ]);
    await expect(rememberedDialogDirectory("import")).resolves.toBe(canonicalImports);
    await expect(rememberedDialogDirectory("export")).resolves.toBe(canonicalExports);
    const stored = JSON.parse(await fs.readFile(path.join(root, "dialog-history.json"), "utf8"));
    expect(stored).toEqual({
      import: canonicalImports,
      export: canonicalExports,
    });
    expect((await fs.stat(path.join(root, "dialog-history.json"))).mode & 0o077).toBe(0);
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
