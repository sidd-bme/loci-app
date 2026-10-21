import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeAboutIdentity } from "./about-identity";
import { BUILD_IDENTITY_FILE, BUILD_IDENTITY_SCHEMA, parseDevelopmentBuildConfig, parseDevelopmentBuildIdentity } from "./build-identity";

const identity = {
  schema: BUILD_IDENTITY_SCHEMA, channel: "development", buildNumber: 1, bundleVersion: "1.0.0",
  compatibilityVersion: "0.2.0", sourceRevision: "a".repeat(40), sourceTree: "b".repeat(40), sourceDirty: false,
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(marker: unknown = BUILD_IDENTITY_SCHEMA) {
  const root = mkdtempSync(path.join(os.tmpdir(), "loci-about-test-"));
  roots.push(root);
  const appPath = path.join(root, "app"), resourcesPath = path.join(root, "resources");
  mkdirSync(appPath); mkdirSync(resourcesPath);
  writeFileSync(path.join(appPath, "package.json"), JSON.stringify({ version: "0.2.0", lociBuildIdentity: marker }));
  return { isPackaged: true, appPath, resourcesPath, compatibilityVersion: "0.2.0" };
}

describe("development build identity validation", () => {
  it("accepts the bounded numeric counter and exact public-safe source fields", () => {
    expect(parseDevelopmentBuildConfig({ schema: "loci.development-build-config/v1", channel: "development", buildNumber: 1 }).buildNumber).toBe(1);
    expect(parseDevelopmentBuildIdentity(identity)).toEqual(identity);
    expect(parseDevelopmentBuildIdentity({ ...identity, buildNumber: 9999, bundleVersion: "9999.0.0" }).buildNumber).toBe(9999);
  });
  it("rejects invalid versions, unknown fields, missing or fabricated source identity and non-boolean dirty state", () => {
    for (const patch of [
      { schema: "future" }, { channel: "release" }, { buildNumber: 0 }, { buildNumber: -1 },
      { buildNumber: 1.5 }, { buildNumber: 10000 }, { buildNumber: "1" }, { buildNumber: NaN },
      { bundleVersion: "0.2.0" }, { compatibilityVersion: "0.2.0-dev" }, { sourceRevision: "unknown" },
      { sourceRevision: "a".repeat(12) }, { sourceTree: "" }, { sourceDirty: "false" }, { privatePath: "/private" },
    ]) expect(() => parseDevelopmentBuildIdentity({ ...identity, ...patch })).toThrow();
    for (const buildNumber of [0, 10000, 1.1, "1", null]) {
      expect(() => parseDevelopmentBuildConfig({ schema: "loci.development-build-config/v1", channel: "development", buildNumber })).toThrow();
    }
  });
});

describe("native About identity", () => {
  it("shows an unreleased numbered build, exact source prefix and clean/dirty distinction", () => {
    const options = fixture();
    const file = path.join(options.resourcesPath, BUILD_IDENTITY_FILE);
    writeFileSync(file, JSON.stringify(identity));
    const about = nativeAboutIdentity(options)!;
    expect(about.applicationVersion).toBe("0.2.0 · Development build 1 · Unreleased");
    expect(about.version).toBe(`Source ${"a".repeat(12)}`);
    expect(about.credits).toContain(`Source revision: ${"a".repeat(40)}`);
    expect(about.credits).toContain(`Commit tree: ${"b".repeat(40)}`);
    writeFileSync(file, JSON.stringify({ ...identity, sourceDirty: true }));
    expect(nativeAboutIdentity(options)!.version).toContain("modified source");
    expect(nativeAboutIdentity(options)!.credits).toContain("Working tree: modified");
  });
  it("leaves release About behavior intact and labels unpackaged development without a source claim", () => {
    const options = fixture(undefined);
    // Explicitly omit the marker (the helper's default creates a development package).
    writeFileSync(path.join(options.appPath, "package.json"), '{"version":"0.2.0"}');
    expect(nativeAboutIdentity(options)).toBeUndefined();
    expect(nativeAboutIdentity({ ...options, isPackaged: false })).toEqual({
      applicationName: "Loci", applicationVersion: "0.2.0 · Unpackaged development", version: "Source identity not recorded",
    });
  });
  it("fails closed for missing, malformed, mismatched, oversized and symlinked packaged metadata", () => {
    const options = fixture();
    const file = path.join(options.resourcesPath, BUILD_IDENTITY_FILE);
    expect(() => nativeAboutIdentity(options)).toThrow();
    for (const content of ["{", JSON.stringify({ ...identity, sourceRevision: "unknown" }),
      JSON.stringify({ ...identity, compatibilityVersion: "0.3.0" }), " ".repeat(16_385)]) {
      writeFileSync(file, content);
      expect(() => nativeAboutIdentity(options)).toThrow();
    }
    rmSync(file);
    const external = path.join(options.appPath, "identity.json");
    writeFileSync(external, JSON.stringify(identity)); symlinkSync(external, file);
    expect(() => nativeAboutIdentity(options)).toThrow();
  });
  it("rejects unknown package markers and development resources in an unmarked release package", () => {
    const options = fixture("future");
    expect(() => nativeAboutIdentity(options)).toThrow(/Unsupported/);
    writeFileSync(path.join(options.appPath, "package.json"), '{"version":"0.2.0"}');
    writeFileSync(path.join(options.resourcesPath, BUILD_IDENTITY_FILE), JSON.stringify(identity));
    expect(() => nativeAboutIdentity(options)).toThrow(/Unexpected/);
  });
});
