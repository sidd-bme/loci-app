import { promises as fs } from "node:fs";
import path from "node:path";
import type { CellposeProfileId, CellposeStatus } from "../shared/contracts";
import { downloadModelArtifact } from "./model-download";
import { CELLPOSE_DOWNLOADS, CELLPOSE_MODELS, requireCellposeProfileId } from "./cellpose-models";

/** A main-process-only explicit installation. Never installs a Python runtime. */
export class CellposeModelDownloads {
  private active: { profile: CellposeProfileId; abort: AbortController; importing: boolean } | null = null;

  constructor(private readonly directory: (profile: CellposeProfileId) => Promise<string>,
    private readonly adopt: (profile: CellposeProfileId, filename: string) => Promise<CellposeStatus>,
    private readonly download = downloadModelArtifact) {}

  cancel(profileValue: unknown): boolean {
    const profile = requireCellposeProfileId(profileValue);
    if (!this.active || this.active.profile !== profile || this.active.importing) return false;
    this.active.abort.abort();
    return true;
  }

  async install(profileValue: unknown): Promise<CellposeStatus> {
    const profile = requireCellposeProfileId(profileValue);
    if (this.active) throw new Error("Finish or cancel the active model download first.");
    const active = { profile, abort: new AbortController(), importing: false };
    this.active = active;
    let directory: string | undefined;
    let directoryIdentity: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    let artifact: { path: string; dev: number; ino: number } | undefined;
    try {
      const root = await fs.realpath(await this.directory(profile));
      directory = await fs.mkdtemp(path.join(root, ".download-"));
      await fs.chmod(directory, 0o700);
      directoryIdentity = await fs.lstat(directory);
      const downloaded = await this.download(CELLPOSE_MODELS[profile].artifactId, CELLPOSE_DOWNLOADS,
        path.join(directory, "checkpoint"), { signal: active.abort.signal });
      const stat = await fs.lstat(downloaded.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error();
      artifact = { path: downloaded.path, dev: stat.dev, ino: stat.ino };
      if (active.abort.signal.aborted) throw new Error();
      // Import is the existing atomic, exact-hash adoption boundary. Once it
      // begins cancellation cannot truthfully promise to prevent installation.
      active.importing = true;
      const status = await this.adopt(profile, downloaded.path);
      if (status.profileId !== profile || status.model.artifactId !== CELLPOSE_MODELS[profile].artifactId ||
          !status.model.verified) throw new Error();
      return status;
    } catch {
      throw new Error(active.abort.signal.aborted
        ? "Model download cancelled. No checkpoint was imported."
        : "The model could not be downloaded and verified. Retry, or import the exact checkpoint locally.");
    } finally {
      // Remove only our identified file and empty temporary directory. Never
      // recurse across a path substituted by another process.
      try {
        if (directory && directoryIdentity) {
          const current = await fs.lstat(directory);
          if (current.isDirectory() && !current.isSymbolicLink() && current.dev === directoryIdentity.dev && current.ino === directoryIdentity.ino) {
            if (artifact) {
              const file = await fs.lstat(artifact.path);
              if (file.isFile() && !file.isSymbolicLink() && file.dev === artifact.dev && file.ino === artifact.ino) await fs.unlink(artifact.path);
            }
            await fs.rmdir(directory);
          }
        }
      } catch { /* A substituted/nonempty directory remains intact for recovery. */ }
      if (this.active === active) this.active = null;
    }
  }
}
