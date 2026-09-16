// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: electronMocks.getPath },
  shell: { openPath: electronMocks.openPath },
}));

import {
  cellposeImportDialogDefaultDirectory,
  ensureCellposeModelImportDirectory,
  openCellposeModelImportDirectory,
} from "./cellpose-model-imports";

let root: string;

describe("managed Cellpose model imports", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-model-imports-"));
    electronMocks.getPath.mockReset();
    electronMocks.getPath.mockReturnValue(root);
    electronMocks.openPath.mockReset();
    electronMocks.openPath.mockResolvedValue("");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    ["cellpose-sam", "cpsam"],
    ["cellpose-sam-v2", "cpsam_v2"],
  ] as const)("creates a private per-profile folder for %s", async (profileId, artifactId) => {
    const directory = await ensureCellposeModelImportDirectory(profileId);

    expect(directory).toBe(path.join(root, "Model Imports", artifactId));
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(root, "Model Imports"))).mode & 0o077).toBe(0);
      expect((await fs.stat(directory)).mode & 0o077).toBe(0);
    }
  });

  it("tightens permissions on existing managed directories where supported", async () => {
    if (process.platform === "win32") return;
    const importsRoot = path.join(root, "Model Imports");
    const destination = path.join(importsRoot, "cpsam");
    await fs.mkdir(destination, { recursive: true, mode: 0o755 });
    await fs.chmod(importsRoot, 0o755);
    await fs.chmod(destination, 0o755);

    await ensureCellposeModelImportDirectory("cellpose-sam");

    expect((await fs.stat(importsRoot)).mode & 0o077).toBe(0);
    expect((await fs.stat(destination)).mode & 0o077).toBe(0);
  });

  it("always opens the selected profile's managed folder", async () => {
    await expect(cellposeImportDialogDefaultDirectory("cellpose-sam-v2")).resolves.toBe(
      path.join(root, "Model Imports", "cpsam_v2"),
    );
  });

  it("opens the exact profile folder and returns only an app-relative display path", async () => {
    const location = await openCellposeModelImportDirectory("cellpose-sam-v2");
    const directory = path.join(root, "Model Imports", "cpsam_v2");

    expect(electronMocks.openPath).toHaveBeenCalledWith(directory);
    expect(location).toEqual({
      profileId: "cellpose-sam-v2",
      artifactId: "cpsam_v2",
      displayPath: "Model Imports/cpsam_v2",
    });
    expect(JSON.stringify(location)).not.toContain(root);
  });

  it("does not disclose the absolute folder when the operating system cannot open it", async () => {
    electronMocks.openPath.mockResolvedValue(`Permission denied: ${root}`);

    await expect(openCellposeModelImportDirectory("cellpose-sam")).rejects.toThrow(
      "Loci could not open its managed model import folder.",
    );
  });

  it("refuses a symbolic-link model imports root", async () => {
    if (process.platform === "win32") return;
    const redirected = await fs.mkdtemp(path.join(os.tmpdir(), "loci-model-redirect-"));
    await fs.symlink(redirected, path.join(root, "Model Imports"));
    try {
      await expect(ensureCellposeModelImportDirectory("cellpose-sam")).rejects.toThrow(
        "Loci could not prepare its managed model import folder.",
      );
    } finally {
      await fs.rm(redirected, { recursive: true, force: true });
    }
  });

  it("refuses a symbolic-link profile folder", async () => {
    if (process.platform === "win32") return;
    const importsRoot = path.join(root, "Model Imports");
    const redirected = await fs.mkdtemp(path.join(os.tmpdir(), "loci-model-profile-redirect-"));
    await fs.mkdir(importsRoot);
    await fs.symlink(redirected, path.join(importsRoot, "cpsam"));
    try {
      await expect(ensureCellposeModelImportDirectory("cellpose-sam")).rejects.toThrow(
        "Loci could not prepare its managed model import folder.",
      );
    } finally {
      await fs.rm(redirected, { recursive: true, force: true });
    }
  });

  it("does not disclose an absolute path when folder preparation fails", async () => {
    const invalidUserData = path.join(root, "not-a-directory");
    await fs.writeFile(invalidUserData, "occupied");
    electronMocks.getPath.mockReturnValue(invalidUserData);

    const rejection = ensureCellposeModelImportDirectory("cellpose-sam");
    await expect(rejection).rejects.toThrow(
      "Loci could not prepare its managed model import folder.",
    );
    await expect(rejection).rejects.not.toThrow(invalidUserData);
  });
});
