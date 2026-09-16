import { appendFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const canonicalRepositoryRoot = path.resolve(scriptDirectory, "..", "..");

export function packagingPaths(repositoryRoot = canonicalRepositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const builds = path.join(root, ".loci", "builds");
  return {
    repositoryRoot: root,
    desktopRoot: path.join(root, "desktop"),
    builds,
    currentApp: path.join(builds, "current", "Loci.app"),
    staging: path.join(builds, "staging"),
    lock: path.join(builds, "package-local.lock"),
    logs: path.join(builds, "logs"),
  };
}

export function assertSafePaths(paths) {
  const expected = packagingPaths(paths.repositoryRoot);
  for (const key of ["desktopRoot", "builds", "currentApp", "staging", "lock", "logs"]) {
    if (path.resolve(paths[key]) !== expected[key]) {
      throw new Error(`Refusing non-canonical packaging path for ${key}: ${paths[key]}`);
    }
  }
  if (paths.staging === path.dirname(paths.currentApp) || paths.staging === paths.currentApp) {
    throw new Error("The staging package path overlaps the current Loci application.");
  }
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureDirectoryNoSymlink(target) {
  try {
    await mkdir(target);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const entry = await lstat(target);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Refusing packaging path that is not a real directory: ${target}`);
  }
}

export async function ensureSafeBuildDirectories(paths) {
  await ensureDirectoryNoSymlink(path.join(paths.repositoryRoot, ".loci"));
  await ensureDirectoryNoSymlink(paths.builds);
  for (const target of [paths.logs, paths.lock]) {
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw new Error(`Refusing symbolic link in the packaging path: ${target}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function acquirePackageLock(paths, owner = {}) {
  const identity = {
    ...owner,
    token: randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
  };
  await ensureSafeBuildDirectories(paths);
  try {
    await mkdir(paths.lock);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if ((await lstat(paths.lock)).isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in the packaging path: ${paths.lock}`);
    }
    let recordedOwner = "owner information unavailable";
    try {
      recordedOwner = (await readFile(path.join(paths.lock, "owner.json"), "utf8")).trim();
    } catch {}
    throw new Error(
      `Local packaging is already locked at ${paths.lock}. Wait for that attempt to finish; ` +
        `do not remove the lock automatically. Recorded owner: ${recordedOwner}`,
    );
  }
  try {
    await writeFile(path.join(paths.lock, "owner.json"), `${JSON.stringify(identity, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await rm(paths.lock, { recursive: true });
    throw error;
  }
  return identity;
}

export async function releasePackageLock(paths, identity) {
  let recorded;
  try {
    recorded = JSON.parse(await readFile(path.join(paths.lock, "owner.json"), "utf8"));
  } catch {
    return false;
  }
  if (recorded.token !== identity.token) return false;
  await rm(paths.lock, { recursive: true });
  return true;
}

export async function packageLocalMac({
  repositoryRoot = canonicalRepositoryRoot,
  packageApi,
  env = process.env,
  owner,
  platform = process.platform,
} = {}) {
  const paths = packagingPaths(repositoryRoot);
  assertSafePaths(paths);
  if (platform !== "darwin") {
    throw new Error("Canonical local Loci packaging supports macOS only.");
  }
  if (env.LOCI_MAC_SIGN_MODE && env.LOCI_MAC_SIGN_MODE !== "adhoc-local") {
    throw new Error(`Unsupported LOCI_MAC_SIGN_MODE: ${env.LOCI_MAC_SIGN_MODE}`);
  }

  const identity = await acquirePackageLock(paths, owner);
  const logName = `package-local-${identity.startedAt.replaceAll(":", "-")}-${identity.token}.log`;
  const logPath = path.join(paths.logs, logName);
  const previousSignMode = env.LOCI_MAC_SIGN_MODE;
  try {
    await ensureDirectoryNoSymlink(paths.logs);
    await appendFile(logPath, `started ${JSON.stringify(identity)}\n`);
    if (await pathExists(paths.staging)) {
      throw new Error(
        `Staging is occupied at ${paths.staging}. Preserve or move that candidate before packaging again.`,
      );
    }
    env.LOCI_MAC_SIGN_MODE = "adhoc-local";
    if (typeof packageApi !== "function") {
      ({ api: { package: packageApi } } = await import("@electron-forge/core"));
    }
    const result = await packageApi({
      dir: paths.desktopRoot,
      platform: "darwin",
      arch: "arm64",
      outDir: paths.staging,
    });
    await appendFile(logPath, "completed\n");
    return { paths, logPath, result };
  } catch (error) {
    await appendFile(logPath, `failed ${error instanceof Error ? error.stack : String(error)}\n`).catch(
      () => {},
    );
    throw error;
  } finally {
    if (previousSignMode === undefined) delete env.LOCI_MAC_SIGN_MODE;
    else env.LOCI_MAC_SIGN_MODE = previousSignMode;
    await releasePackageLock(paths, identity);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  packageLocalMac()
    .then(({ paths, logPath }) => {
      console.log(`Staged Loci package under ${paths.staging}`);
      console.log(`Packaging log: ${logPath}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
