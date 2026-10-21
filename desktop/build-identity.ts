import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BUILD_IDENTITY_FILE,
  BUILD_IDENTITY_SCHEMA,
  parseDevelopmentBuildConfig,
  parseDevelopmentBuildIdentity,
  type DevelopmentBuildConfig,
  type DevelopmentBuildIdentity,
} from "./src/main/build-identity.ts";

export function selectBuildChannel(env: NodeJS.ProcessEnv, localPackaging: boolean): "development" | "release" {
  const channel = env.LOCI_BUILD_CHANNEL ?? (localPackaging ? "development" : "release");
  if (channel !== "development" && channel !== "release") throw new Error("Unsupported LOCI_BUILD_CHANNEL.");
  if (channel === "development" && !localPackaging) {
    throw new Error("Development build identity requires an explicit local packaging lifecycle.");
  }
  return channel;
}

export function readDevelopmentBuildConfig(desktopRoot: string): DevelopmentBuildConfig {
  return parseDevelopmentBuildConfig(JSON.parse(readFileSync(path.join(desktopRoot, "development-build.json"), "utf8")));
}

export function captureDevelopmentBuildIdentity(
  repositoryRoot: string,
  config: DevelopmentBuildConfig,
  compatibilityVersion: string,
): DevelopmentBuildIdentity {
  const checked = parseDevelopmentBuildConfig(config);
  const git = (...args: string[]) => execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    // Commit tree and dirty flag are distinct. This is not a hash of dirty bytes.
    const sourceRevision = git("rev-parse", "--verify", "HEAD");
    const sourceTree = git("rev-parse", "--verify", "HEAD^{tree}");
    const sourceDirty = git("status", "--porcelain=v1", "--untracked-files=normal").length > 0;
    if (git("rev-parse", "--verify", "HEAD") !== sourceRevision) {
      throw new Error("Source revision changed while recording identity.");
    }
    return parseDevelopmentBuildIdentity({ schema: BUILD_IDENTITY_SCHEMA, channel: checked.channel,
      buildNumber: checked.buildNumber, bundleVersion: `${checked.buildNumber}.0.0`, compatibilityVersion,
      sourceRevision, sourceTree, sourceDirty });
  } catch {
    throw new Error("Cannot capture development build source identity; a stable Git checkout with a valid HEAD is required.");
  }
}

export function writeDevelopmentBuildIdentity(resourcesDirectory: string, identity: DevelopmentBuildIdentity): void {
  const checked = parseDevelopmentBuildIdentity(identity);
  writeFileSync(path.join(resourcesDirectory, BUILD_IDENTITY_FILE), `${JSON.stringify(checked, null, 2)}\n`,
    { flag: "wx", mode: 0o644 });
}
