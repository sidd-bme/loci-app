// @vitest-environment node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NUCLEI_MODEL_INSTALL } from "../shared/nuclei-model-install";
import adapterText from "./nuclei-model-package.json?raw";
import { nucleiModelFiles, withNucleiModelPackage } from "./nuclei-model-download";
import { downloadModelArtifact } from "./model-download";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-model-install-test-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("binds the published adapter and both reference tensors to the installed gallery package", () => {
  const adapter = JSON.parse(adapterText);
  const files = [adapter.model, adapter.reference.input, adapter.reference.output,
    { source: "loci-model.json", sha256: createHash("sha256").update(adapterText).digest("hex") }];
  const inventory = files.map(({ source, sha256 }) => `${source}\0${sha256}\n`).sort();
  expect(createHash("sha256").update(inventory.join("")).digest("hex")).toBe(NUCLEI_MODEL_INSTALL.packageSha256);
  expect(nucleiModelFiles.reduce((n, file) => n + file.sizeBytes, 0)).toBe(NUCLEI_MODEL_INSTALL.downloadBytes);
  expect(nucleiModelFiles.find((file) => file.id === adapter.model.source)?.sha256).toBe(adapter.model.sha256);
  expect(nucleiModelFiles.find((file) => file.id === adapter.reference.input.source)?.sha256).toBe(adapter.reference.input.sha256);
  expect(nucleiModelFiles.find((file) => file.id === adapter.reference.output.source)?.sha256).toBe(adapter.reference.output.sha256);
});

it("refuses substituted input bytes and cleans up before the study importer can run", async () => {
  const adopt = vi.fn();
  const badDownload: typeof downloadModelArtifact = (id, registry, filename, options) =>
    downloadModelArtifact(id, registry, filename, { ...options, transport: async () => ({
      statusCode: 200, headers: {}, body: Readable.from([Buffer.alloc(nucleiModelFiles[0].sizeBytes)]),
    }) });
  await expect(withNucleiModelPackage(root, new AbortController().signal, adopt, badDownload))
    .rejects.toThrow("SHA-256 verification");
  expect(adopt).not.toHaveBeenCalled();
  expect(await fs.readdir(root)).toEqual([]);
});

it("removes verified earlier downloads if a later transfer fails", async () => {
  const download: typeof downloadModelArtifact = async (id, _registry, filename) => {
    if (id === "weights.onnx") throw new Error("Publisher unavailable");
    await fs.writeFile(filename, "earlier test transfer");
    return { artifactId: id, path: filename, sha256: "", sizeBytes: 21 };
  };
  const adopt = vi.fn();
  await expect(withNucleiModelPackage(root, new AbortController().signal, adopt, download))
    .rejects.toThrow("Publisher unavailable");
  expect(adopt).not.toHaveBeenCalled();
  expect(await fs.readdir(root)).toEqual([]);
});

it("cancels before issuing any network request or creating a staging directory", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn(), adopt = vi.fn();
  await expect(withNucleiModelPackage(root, controller.signal, adopt, fetch)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(adopt).not.toHaveBeenCalled();
  expect(await fs.readdir(root)).toEqual([]);
});
