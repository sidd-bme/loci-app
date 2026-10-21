import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AboutPanelOptionsOptions } from "electron";
import { BUILD_IDENTITY_FILE, BUILD_IDENTITY_SCHEMA, parseDevelopmentBuildIdentity } from "./build-identity";

function readBoundedJson(file: string): unknown {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) {
    throw new Error("Invalid packaged build identity resource.");
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Keep identity in the native About panel; scientific appVersion remains unchanged. */
export function nativeAboutIdentity(options: {
  isPackaged: boolean; appPath: string; resourcesPath: string; compatibilityVersion: string;
}): AboutPanelOptionsOptions | undefined {
  if (!options.isPackaged) return {
    applicationName: "Loci",
    applicationVersion: `${options.compatibilityVersion} · Unpackaged development`,
    version: "Source identity not recorded",
  };
  const packaged = readBoundedJson(path.join(options.appPath, "package.json")) as Record<string, unknown>;
  const marker = packaged.lociBuildIdentity;
  const identityPath = path.join(options.resourcesPath, BUILD_IDENTITY_FILE);
  if (marker === undefined) {
    if (existsSync(identityPath)) throw new Error("Unexpected development identity in an unmarked package.");
    return undefined;
  }
  if (marker !== BUILD_IDENTITY_SCHEMA) throw new Error("Unsupported packaged build identity marker.");
  const identity = parseDevelopmentBuildIdentity(readBoundedJson(identityPath));
  if (identity.compatibilityVersion !== options.compatibilityVersion) {
    throw new Error("Packaged build identity has a mismatched compatibility version.");
  }
  return {
    applicationName: "Loci",
    applicationVersion: `${identity.compatibilityVersion} · Development build ${identity.buildNumber} · Unreleased`,
    version: `Source ${identity.sourceRevision.slice(0, 12)}${identity.sourceDirty ? " · modified source" : ""}`,
    credits: `Source revision: ${identity.sourceRevision}\nCommit tree: ${identity.sourceTree}\n` +
      `Working tree: ${identity.sourceDirty ? "modified" : "clean"}\nBundle build: ${identity.bundleVersion}`,
  };
}
