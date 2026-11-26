import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { downloadModelArtifact, type PinnedModelArtifact } from "./model-download";
import adapterText from "./nuclei-model-package.json?raw";

// BioImage.IO's v0 ONNX descriptor pins these exact references and Pape's
// unchanged Zenodo 6647674 graph. Its float32 test tensor matches the adapter.
const publisher = "https://hypha.aicell.io/bioimage-io/artifacts/affable-shark/files/new-dir/";
export const nucleiModelFiles: readonly PinnedModelArtifact[] = [
  { id: "reference-input-float32.npy", source: "test_input_0.npy", sizeBytes: 262_272,
    sha256: "c29bd6e16e3f7856217b407ba948222b1c2a0da41922a0f79297e25588614fe2" },
  { id: "test_output_0.npy", source: "test_output_0.npy", sizeBytes: 524_416,
    sha256: "510181f38930e59e4fd8ecc03d6ea7c980eb6609759655f2d4a41fe36108d5f5" },
  { id: "weights.onnx", source: "weights.onnx", sizeBytes: 115_839_324,
    sha256: "df913b85947f5132bcdaf81d91af0963f60d44f4caf8a4fec672d96a2f327b44" },
].map(({ source, ...entry }) => ({ ...entry, url: `${publisher}${source}?version=v0` }));

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** The callback is the engine's existing reference test and atomic study import. */
export async function withNucleiModelPackage<T>(
  tempRoot: string, signal: AbortSignal, adopt: (directory: string) => Promise<T>,
  download = downloadModelArtifact,
): Promise<T> {
  signal.throwIfAborted();
  const root = await fs.realpath(tempRoot);
  const directory = await fs.mkdtemp(path.join(root, "loci-nuclei-model-"));
  const identity = await fs.lstat(directory);
  const owned = new Map<string, Stats>();
  const record = async (file: string) => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("A model package file changed during assembly.");
    owned.set(file, stat);
  };
  try {
    for (const entry of nucleiModelFiles) {
      const file = path.join(directory, entry.id);
      await download(entry.id, nucleiModelFiles, file, { signal });
      await record(file);
    }
    const manifest = path.join(directory, "loci-model.json");
    const handle = await fs.open(manifest, "wx", 0o600);
    try {
      owned.set(manifest, await handle.stat());
      await handle.writeFile(adapterText);
    } finally { await handle.close(); }
    signal.throwIfAborted();
    return await adopt(directory);
  } finally {
    // Never recursively remove a directory that another process could replace.
    const current = await fs.lstat(directory);
    if (current.isDirectory() && sameFile(identity, current)) {
      for (const [file, stat] of owned) {
        const found = await fs.lstat(file).catch(() => undefined);
        if (found?.isFile() && sameFile(found, stat)) await fs.unlink(file);
      }
      await fs.rmdir(directory);
    }
  }
}
