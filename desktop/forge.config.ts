import {
  constants as fsConstants,
  accessSync,
  cpSync,
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { HookFunctionArgs, PackagerOsxSignOptions } from "@electron/packager";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { captureDevelopmentBuildIdentity, readDevelopmentBuildConfig, selectBuildChannel, writeDevelopmentBuildIdentity } from "./build-identity.ts";
import { BUILD_IDENTITY_SCHEMA } from "./src/main/build-identity.ts";

type FailClosedOsxSignOptions = PackagerOsxSignOptions & {
  continueOnError: false;
};

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const productName = "Loci";
const defaultEngineResource = path.resolve(configDirectory, "..", "engine", "dist", "loci-engine");
const sourceEngineResource = path.resolve(process.env.LOCI_ENGINE_RESOURCE ?? defaultEngineResource);
const entitlementsDirectory = path.resolve(configDirectory, "assets", "entitlements");
const emptyEntitlements = path.join(entitlementsDirectory, "empty.plist");
const jitEntitlements = path.join(entitlementsDirectory, "jit.plist");
const pluginEntitlements = path.join(entitlementsDirectory, "plugin.plist");

const packagingRequested =
  process.argv.some((argument) => argument === "package" || argument === "make") ||
  /^(?:package|make)(?::|$)/.test(process.env.npm_lifecycle_event ?? "");

function targetPlatform(): NodeJS.Platform | "mas" {
  const equalsArgument = process.argv.find((argument) => argument.startsWith("--platform="));
  if (equalsArgument) return equalsArgument.slice("--platform=".length) as NodeJS.Platform | "mas";

  const platformIndex = process.argv.indexOf("--platform");
  if (platformIndex >= 0 && process.argv[platformIndex + 1]) {
    return process.argv[platformIndex + 1] as NodeJS.Platform | "mas";
  }
  return process.platform;
}

function engineExecutableName(platform: NodeJS.Platform | "mas"): string {
  return platform === "win32" ? "loci-engine.exe" : "loci-engine";
}

function removeFinderMetadata(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      removeFinderMetadata(entryPath);
    } else if (entry.isFile() && entry.name === ".DS_Store") {
      unlinkSync(entryPath);
    }
  }
}

function validateEngineResource(resourcePath: string, platform: NodeJS.Platform | "mas"): void {
  if (!existsSync(resourcePath) || !statSync(resourcePath).isDirectory()) {
    throw new Error(
      `The packaged Loci engine directory is missing: ${resourcePath}. Run the platform build-engine script before packaging.`,
    );
  }

  const executable = path.join(resourcePath, engineExecutableName(platform));
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`The packaged Loci engine executable is missing: ${executable}.`);
  }
  if (platform !== "win32") {
    try {
      accessSync(executable, fsConstants.X_OK);
    } catch {
      throw new Error(
        `The packaged Loci engine is not executable: ${executable}. Rebuild it with ../scripts/build-engine.sh.`,
      );
    }
  }
}

const macSignMode = process.env.LOCI_MAC_SIGN_MODE;
const windowsPackageMode = process.env.LOCI_WINDOWS_PACKAGE_MODE;
const lifecycleEvent = process.env.npm_lifecycle_event ?? "";
const windowsUnsignedLocal =
  windowsPackageMode === "unsigned-local" || /^(?:package|make):windows:local$/.test(lifecycleEvent);
const localPackaging = macSignMode === "adhoc-local" || windowsUnsignedLocal;
const buildChannel = selectBuildChannel(process.env, localPackaging);
const developmentBuildConfig = buildChannel === "development" ? readDevelopmentBuildConfig(configDirectory) : undefined;
const developmentIdentity = packagingRequested && developmentBuildConfig
  ? captureDevelopmentBuildIdentity(path.resolve(configDirectory, ".."), developmentBuildConfig,
      JSON.parse(readFileSync(path.join(configDirectory, "package.json"), "utf8")).version)
  : undefined;

if (macSignMode && macSignMode !== "adhoc-local") {
  throw new Error(`Unsupported LOCI_MAC_SIGN_MODE: ${macSignMode}`);
}
if (windowsPackageMode && windowsPackageMode !== "unsigned-local") {
  throw new Error(`Unsupported LOCI_WINDOWS_PACKAGE_MODE: ${windowsPackageMode}`);
}

function verifyWindowsX64Executable(executable: string): void {
  const content = readFileSync(executable);
  if (content.length < 0x40 || content[0] !== 0x4d || content[1] !== 0x5a) {
    throw new Error(`The packaged Loci Windows engine is not a PE executable: ${executable}`);
  }
  const peOffset = content.readUInt32LE(0x3c);
  if (
    peOffset + 6 > content.length ||
    content.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0"
  ) {
    throw new Error(`The packaged Loci Windows engine has an invalid PE header: ${executable}`);
  }
  const machine = content.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) {
    throw new Error(
      `The packaged Loci Windows engine has machine 0x${machine.toString(16)}, expected AMD64.`,
    );
  }
}

const packagingPlatform = targetPlatform();
if (packagingRequested) {
  validateEngineResource(sourceEngineResource, packagingPlatform);
  if (
    (packagingPlatform === "darwin" || packagingPlatform === "mas") &&
    macSignMode !== "adhoc-local"
  ) {
    throw new Error(
      "Unsigned macOS packages are disabled. Use `npm run package:mac:local` for local QA; " +
        "the public Developer ID release configuration is not available yet.",
    );
  }
  if (packagingPlatform === "win32") {
    if (!windowsUnsignedLocal) {
      throw new Error(
        "Windows packages are unsigned qualification artifacts. Use `npm run package:windows:local` " +
          "or `npm run make:windows:local`; a signed public Windows release is not configured.",
      );
    }
    verifyWindowsX64Executable(
      path.join(sourceEngineResource, engineExecutableName(packagingPlatform)),
    );
  }
}

let temporaryEngineResourceRoot: string | undefined;

function containedPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function engineResourceLinks(root: string): Map<string, string> {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The engine resource must be a plain directory.");
  }
  const canonicalRoot = realpathSync(root);
  const links = new Map<string, string>();
  const directoryEdges = new Map<string, string[]>();
  const visit = (directory: string) => {
    const edges: string[] = [];
    directoryEdges.set(realpathSync(directory), edges);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(entryPath);
        if (path.isAbsolute(target)) throw new Error(`Engine resource link must be relative: ${entryPath}`);
        let resolved: string;
        try { resolved = realpathSync(entryPath); }
        catch { throw new Error(`Engine resource link is dangling or cyclic: ${entryPath}`); }
        if (!containedPath(canonicalRoot, resolved)) {
          throw new Error(`Engine resource link escapes its resource directory: ${entryPath}`);
        }
        if (statSync(resolved).isDirectory()) edges.push(resolved);
        links.set(path.relative(root, entryPath), target);
      } else if (entry.isDirectory()) { edges.push(realpathSync(entryPath)); visit(entryPath); }
      else if (!entry.isFile()) throw new Error(`Unsupported engine resource entry: ${entryPath}`);
    }
  };
  visit(root);
  const visited = new Set<string>(), active = new Set<string>();
  const checkCycles = (directory: string) => {
    if (active.has(directory)) throw new Error(`Engine resource directory links are cyclic: ${directory}`);
    if (visited.has(directory)) return;
    active.add(directory);
    for (const target of directoryEdges.get(directory) ?? []) checkCycles(target);
    active.delete(directory); visited.add(directory);
  };
  checkCycles(canonicalRoot);
  return links;
}

/** Copy the frozen worker without converting relative links into source-machine paths. */
export function copyEngineResource(source: string, destination: string): void {
  const sourceLinks = engineResourceLinks(source);
  const parent = lstatSync(path.dirname(destination));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("The engine resource destination parent must be a plain directory.");
  }
  // Exclusive creation rejects existing directories, files and dangling links.
  // Retain any partial copy on failure for inspection by the packaging owner.
  mkdirSync(destination);
  // Node 24.22 correctly rejects cpSync onto an existing directory with
  // errorOnExist. Keep our exclusive root and copy only its absent children.
  for (const name of readdirSync(source)) {
    cpSync(path.join(source, name), path.join(destination, name), {
      recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true,
    });
  }
  const copiedLinks = engineResourceLinks(destination);
  if (sourceLinks.size !== copiedLinks.size ||
      [...sourceLinks].some(([name, target]) => copiedLinks.get(name) !== target)) {
    throw new Error("The copied engine resource does not preserve its exact relative links.");
  }
}

function canonicalEngineResource(): string {
  engineResourceLinks(sourceEngineResource);
  if (path.basename(sourceEngineResource) === "loci-engine") return sourceEngineResource;
  temporaryEngineResourceRoot = mkdtempSync(path.join(os.tmpdir(), "loci-engine-resource-"));
  const destination = path.join(temporaryEngineResourceRoot, "loci-engine");
  copyEngineResource(sourceEngineResource, destination);
  return destination;
}

const packagedEngineResource = packagingRequested
  ? canonicalEngineResource()
  : sourceEngineResource;

process.once("exit", () => {
  if (temporaryEngineResourceRoot) {
    rmSync(temporaryEngineResourceRoot, { recursive: true, force: true });
  }
});

function copyPackagedEngineResource({ buildPath, platform }: HookFunctionArgs): void {
  const resources = platform === "darwin" || platform === "mas"
    ? path.join(buildPath, `${productName}.app`, "Contents", "Resources")
    : path.join(buildPath, "resources");
  if (!containedPath(realpathSync(buildPath), realpathSync(resources))) {
    throw new Error("The engine resource destination escapes the packaging directory.");
  }
  copyEngineResource(packagedEngineResource, path.join(resources, "loci-engine"));
}

const localAdHocSign: FailClosedOsxSignOptions = {
  continueOnError: false,
  identity: "-",
  identityValidation: false,
  optionsForFile: (filePath) => {
    let entitlements = emptyEntitlements;
    if (filePath.includes("(Plugin).app")) {
      entitlements = pluginEntitlements;
    } else if (filePath.endsWith(".app") || filePath.includes(`${path.sep}MacOS${path.sep}`)) {
      // Chromium's V8 processes need JIT permission. Libraries, frameworks,
      // and the packaged Python worker receive the explicit empty profile.
      entitlements = jitEntitlements;
    }
    return {
      entitlements,
      hardenedRuntime: false,
      timestamp: "none",
    };
  },
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  strictVerify: true,
};

const inheritedPrivacyKeys = [
  "NSAppTransportSecurity",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSLocationAlwaysAndWhenInUseUsageDescription",
  "NSLocationAlwaysUsageDescription",
  "NSLocationUsageDescription",
  "NSLocationWhenInUseUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSPrintingUsageDescription",
  "NSUSBUsageDescription",
] as const;

function hardenPackagedResources({ buildPath, platform, arch }: HookFunctionArgs): void {
  try {
    if ((platform === "darwin" || platform === "mas") && macSignMode !== "adhoc-local") {
      throw new Error(
        "Unsigned macOS packages are disabled. The public Developer ID release configuration is not available yet.",
      );
    }
    const packagedExecutable =
      platform === "darwin" || platform === "mas"
        ? path.join(
            buildPath,
            `${productName}.app`,
            "Contents",
            "Resources",
            "loci-engine",
            engineExecutableName(platform),
          )
        : path.join(
            buildPath,
            "resources",
            "loci-engine",
            engineExecutableName(platform as NodeJS.Platform),
          );
    if (!existsSync(packagedExecutable) || !statSync(packagedExecutable).isFile()) {
      throw new Error(
        `Packaging stopped because the bundled Loci engine is missing: ${packagedExecutable}`,
      );
    }
    if (platform === "darwin" || platform === "mas") {
      const requiredArchitecture = arch === "x64" ? "x86_64" : arch;
      try {
        execFileSync("/usr/bin/lipo", [packagedExecutable, "-verify_arch", requiredArchitecture], {
          stdio: "pipe",
        });
      } catch {
        throw new Error(
          `Packaging stopped because the bundled Loci engine does not contain the ${requiredArchitecture} architecture.`,
        );
      }
    }

    if (platform === "darwin" || platform === "mas") {
      removeFinderMetadata(path.join(buildPath, `${productName}.app`));

      const infoPlist = path.join(buildPath, `${productName}.app`, "Contents", "Info.plist");
      for (const key of inheritedPrivacyKeys) {
        try {
          execFileSync("/usr/bin/plutil", ["-remove", key, infoPlist], { stdio: "pipe" });
        } catch {
          // `plutil` reports a missing key with different text across macOS
          // releases. Removal is intentionally idempotent; the authoritative
          // fail-closed scan below still rejects any key that remains.
        }
      }

      const sanitized = execFileSync("/usr/bin/plutil", ["-p", infoPlist], {
        encoding: "utf8",
      });
      const inheritedKey = inheritedPrivacyKeys.find((key) => sanitized.includes(`\"${key}\"`));
      if (inheritedKey) {
        throw new Error(`Packaging stopped because ${inheritedKey} remains in Info.plist.`);
      }

    }
    if (platform === "win32") {
      if (arch !== "x64") {
        throw new Error("Packaging stopped because the supported Windows architecture is x64.");
      }
      verifyWindowsX64Executable(packagedExecutable);
    }

    const resourcesDirectory =
      platform === "darwin" || platform === "mas"
        ? path.join(buildPath, `${productName}.app`, "Contents", "Resources")
        : path.join(buildPath, "resources");
    const noticesDirectory = path.join(resourcesDirectory, "notices");
    if (developmentBuildConfig) {
      if (!developmentIdentity) throw new Error("Requested development package identity was not captured.");
      writeDevelopmentBuildIdentity(resourcesDirectory, developmentIdentity);
    }
    if (platform === "darwin" || platform === "mas") {
      // macOS volumes commonly fold case: MacOS/loci would replace MacOS/Loci.
      const desktopExecutable = path.join(resourcesDirectory, "..", "MacOS", productName);
      const desktopBytes = readFileSync(desktopExecutable);
      const cliDirectory = path.join(resourcesDirectory, "bin");
      mkdirSync(cliDirectory, { recursive: true });
      const cliLauncher = path.join(cliDirectory, "loci");
      copyFileSync(path.resolve(configDirectory, "assets", "loci-cli"), cliLauncher);
      chmodSync(cliLauncher, 0o755);
      if (!readFileSync(desktopExecutable).equals(desktopBytes)) {
        throw new Error("CLI installation changed the desktop executable");
      }
    }
    mkdirSync(noticesDirectory, { recursive: true });
    const noticeSources = [
      [path.resolve(configDirectory, "..", "LICENSE"), "LOCI_LICENSE"],
      [path.resolve(configDirectory, "..", "NOTICE"), "LOCI_NOTICE"],
      [path.resolve(configDirectory, "..", "THIRD_PARTY_NOTICES.md"), "THIRD_PARTY_NOTICES.md"],
      [path.resolve(configDirectory, "..", "scripts", "upstream_licences", "flatbuffers-25.12.19", "LICENSE"), "FLATBUFFERS_25.12.19_LICENSE"],
      [path.join(buildPath, "LICENSE"), "ELECTRON_LICENSE"],
      [path.join(buildPath, "LICENSES.chromium.html"), "LICENSES.chromium.html"],
    ] as const;
    for (const [source, filename] of noticeSources) {
      if (!existsSync(source)) {
        throw new Error(`Packaging stopped because a required notice is missing: ${source}`);
      }
      copyFileSync(source, path.join(noticesDirectory, filename));
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

const config: ForgeConfig = {
  buildIdentifier:
    macSignMode === "adhoc-local"
      ? "local-adhoc"
      : windowsUnsignedLocal
        ? "local-unsigned"
        : undefined,
  packagerConfig: {
    asar: true,
    appBundleId: "science.loci.desktop",
    appCategoryType: "public.app-category.education",
    executableName: "Loci",
    // The current audited artwork has a macOS ICNS only. The unsigned Windows
    // qualification package uses Electron's default icon until an ICO is added.
    icon: packagingPlatform === "win32" ? undefined : path.resolve(configDirectory, "assets", "Loci"),
    name: productName,
    // CFBundleVersion is a numeric development counter; appVersion stays 0.2.0.
    buildVersion: developmentBuildConfig ? `${developmentBuildConfig.buildNumber}.0.0` : undefined,
    sanitizePackageJson: [(packageJson) => {
      if (packageJson.lociBuildIdentity !== undefined) throw new Error("Source package already has a build identity marker.");
      return developmentBuildConfig ? { ...packageJson, lociBuildIdentity: BUILD_IDENTITY_SCHEMA } : packageJson;
    }],
    osxSign: macSignMode === "adhoc-local" ? localAdHocSign : undefined,
    // Packager 20's native copy resolves relative symlinks to source paths.
    // An empty list still executes its resource hooks; own this exact copy.
    extraResource: [],
    beforeCopyExtraResources: [copyPackagedEngineResource],
    afterCopyExtraResources: [hardenPackagedResources],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel(
      {
        name: "Loci",
        authors: "Loci contributors",
        description: "Local biological image viewing, segmentation, and counting for research labs",
        noMsi: true,
      },
      ["win32"],
    ),
    new MakerZIP({}, ["darwin", "win32"]),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
