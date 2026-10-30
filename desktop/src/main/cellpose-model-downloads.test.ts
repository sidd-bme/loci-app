// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CellposeStatus } from "../shared/contracts";
import { CellposeModelDownloads } from "./cellpose-model-downloads";
import { CELLPOSE_DOWNLOADS } from "./cellpose-models";
import type { downloadModelArtifact } from "./model-download";

let root: string;
const status = { profileId: "cellpose-sam", model: { artifactId: "cpsam", verified: true } } as CellposeStatus;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "loci-install-"))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function fixture() {
  const download = vi.fn<typeof downloadModelArtifact>(async (id, registry, target, { signal } = {}) => {
    if (signal?.aborted) throw new Error("abort");
    const spec = registry.find((entry) => entry.id === id)!;
    await fs.writeFile(target, "verified test double", { mode: 0o600 });
    return { artifactId: id, path: target, sha256: spec.sha256, sizeBytes: spec.sizeBytes };
  });
  const adopt = vi.fn().mockResolvedValue(status);
  const installer = new CellposeModelDownloads(async () => root, adopt, download);
  return { installer, download, adopt };
}

describe("explicit managed Cellpose downloads", () => {
  it("pins artifact identity and hands verified private bytes to the existing importer", async () => {
    const { installer, download, adopt } = fixture();
    adopt.mockImplementation(async (profile, filename) => {
      expect(profile).toBe("cellpose-sam");
      expect(await fs.readFile(filename, "utf8")).toBe("verified test double");
      return status;
    });
    await expect(installer.install("cellpose-sam")).resolves.toEqual(status);
    expect(download).toHaveBeenCalledWith("cpsam", CELLPOSE_DOWNLOADS, expect.any(String), { signal: expect.any(AbortSignal) });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects unknown profiles before network or filesystem work", async () => {
    const { installer, download, adopt } = fixture();
    await expect(installer.install("https://example.test/model")).rejects.toThrow("selection is invalid");
    expect(download).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled();
  });

  it("refuses concurrent downloads and cancellation of a different profile", async () => {
    const { installer, download, adopt } = fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    download.mockImplementation((_id, _registry, _file, { signal } = {}) => new Promise((_resolve, reject) => {
      entered(); signal!.addEventListener("abort", () => reject(new Error("cancel")), { once: true });
    }));
    const pending = installer.install("cellpose-sam");
    const rejected = expect(pending).rejects.toThrow("cancelled. No checkpoint was imported");
    await started;
    await expect(installer.install("cellpose-sam-v2")).rejects.toThrow("active model download");
    expect(installer.cancel("cellpose-sam-v2")).toBe(false);
    expect(installer.cancel("cellpose-sam")).toBe(true);
    await rejected;
    expect(adopt).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("does not claim cancellation after atomic import has begun", async () => {
    const { installer, adopt } = fixture();
    adopt.mockImplementation(async () => {
      expect(installer.cancel("cellpose-sam")).toBe(false);
      return status;
    });
    await installer.install("cellpose-sam");
  });

  it("sanitizes network/import failures and removes only owned temporary files", async () => {
    const { installer, download, adopt } = fixture();
    download.mockRejectedValueOnce(new Error("/private/source?secret=x"));
    await expect(installer.install("cellpose-sam")).rejects.toThrow("Retry, or import");
    expect(adopt).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
    adopt.mockRejectedValueOnce(new Error("/private/checkpoint"));
    await expect(installer.install("cellpose-sam")).rejects.toThrow("Retry, or import");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a mismatched importer receipt", async () => {
    const { installer, adopt } = fixture();
    adopt.mockResolvedValue({ ...status, profileId: "cellpose-sam-v2" });
    await expect(installer.install("cellpose-sam")).rejects.toThrow("could not be downloaded and verified");
  });

  it("retains unowned files rather than recursively removing a changed download directory", async () => {
    const { installer, adopt } = fixture();
    adopt.mockImplementation(async (_profile, filename) => {
      await fs.writeFile(path.join(path.dirname(filename), "unowned"), "retain");
      return status;
    });
    await installer.install("cellpose-sam");
    const [directory] = await fs.readdir(root);
    expect(await fs.readdir(path.join(root, directory))).toEqual(["unowned"]);
  });
});
