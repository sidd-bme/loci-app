import { createHash } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { DYNACELL_NUCLEUS, type VirtualStainInstallState } from "../shared/dynacell";
import { downloadModelArtifact, type ModelDownloadTransport, type PinnedModelArtifact } from "./model-download";

function sameFile(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino;
}

async function existingFile(filename: string): Promise<Stats | null> {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("The model location must be an ordinary file.");
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function openRegular(filename: string) {
  return fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
}

/** Use the same bounded, hash-verifying publisher for downloaded and picker-selected bytes. */
function localTransport(filename: string): ModelDownloadTransport {
  return async () => {
    const stat = await existingFile(filename);
    if (!stat) throw new Error("The selected checkpoint is unavailable.");
    const file = await openRegular(filename);
    try {
      const opened = await file.stat();
      if (!sameFile(stat, opened) || !opened.isFile()) throw new Error("The selected checkpoint changed.");
      return { statusCode: 200, headers: { "content-length": String(opened.size) }, body: file.createReadStream() };
    } catch (error) {
      await file.close();
      throw error;
    }
  };
}

export class DynacellCheckpoint {
  private active: AbortController | null = null;
  constructor(private readonly userData: () => string, private readonly artifact: PinnedModelArtifact = DYNACELL_NUCLEUS) {}

  private async location(create: boolean): Promise<string> {
    const root = await fs.realpath(this.userData());
    const directory = path.join(root, "dynacell-ipsc-nucleus");
    if (create) {
      try { await fs.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory ||
        (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700))) {
      throw new Error("The private DynaCell model folder is unavailable.");
    }
    return path.join(directory, "nucleus.ckpt");
  }

  async status(): Promise<VirtualStainInstallState> {
    let filename: string;
    try { filename = await this.location(false); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    const stat = await existingFile(filename);
    if (!stat) return "missing";
    if (stat.size !== this.artifact.sizeBytes) return "damaged";
    const file = await openRegular(filename);
    try {
      if (!sameFile(stat, await file.stat())) throw new Error("The saved checkpoint changed.");
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false, end: this.artifact.sizeBytes - 1 })) hash.update(chunk);
      const after = await file.stat();
      return after.size === stat.size && after.ctimeMs === stat.ctimeMs && hash.digest("hex") === this.artifact.sha256 ? "ready" : "damaged";
    } finally { await file.close(); }
  }

  /** The CPU worker independently verifies the exact bytes it will deserialize. */
  async pathForRun(): Promise<string> {
    const filename = await this.location(false);
    if ((await existingFile(filename))?.size !== this.artifact.sizeBytes) throw new Error("Install the verified DynaCell checkpoint first.");
    return filename;
  }

  cancel(): boolean {
    if (!this.active) return false;
    this.active.abort();
    return true;
  }

  async install(localFile?: string): Promise<void> {
    if (this.active) throw new Error("A DynaCell installation is already in progress.");
    const controller = new AbortController();
    this.active = controller;
    try {
      const filename = await this.location(true);
      const previous = await existingFile(filename);
      if (previous && await this.status() === "ready") return;
      const parent = path.dirname(filename);
      const parentStat = await fs.lstat(parent);
      const stage = await fs.mkdtemp(path.join(parent, ".verify-"));
      const stageStat = await fs.lstat(stage);
      const candidate = path.join(stage, "verified");
      let candidateStat: Stats | null = null;
      try {
        await downloadModelArtifact(this.artifact.id, [this.artifact], candidate, {
          signal: controller.signal, transport: localFile ? localTransport(localFile) : undefined,
        });
        candidateStat = await existingFile(candidate);
        if (!candidateStat || controller.signal.aborted || await this.location(false) !== filename ||
            !sameFile(parentStat, await fs.lstat(parent)) || !sameFile(stageStat, await fs.lstat(stage))) throw new Error("The model location changed.");
        if (previous) {
          const now = await existingFile(filename);
          if (!now || !sameFile(previous, now) || previous.ctimeMs !== now.ctimeMs) throw new Error("The existing checkpoint changed during repair.");
          await fs.rename(candidate, filename);
        } else {
          await fs.link(candidate, filename);
        }
      } finally {
        if (sameFile(stageStat, await fs.lstat(stage)) && sameFile(parentStat, await fs.lstat(parent))) {
          if (candidateStat) {
            const remaining = await fs.lstat(candidate).catch(() => null);
            if (remaining && sameFile(candidateStat, remaining)) await fs.unlink(candidate);
          }
          await fs.rmdir(stage);
        }
      }
    } finally { this.active = null; }
  }
}
