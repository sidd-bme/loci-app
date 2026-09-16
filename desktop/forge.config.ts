import {
  constants as fsConstants,
  accessSync,
  cpSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { OsxSignOptions } from "@electron/packager";
import type { ForgeConfig } from "@electron-forge/shared-types";

type FailClosedOsxSignOptions = OsxSignOptions & {
  continueOnError: false;
};

const productName = "Loci";
const defaultEngineResource = path.resolve(__dirname, "..", "engine", "dist", "loci-engine");
const sourceEngineResource = path.resolve(process.env.LOCI_ENGINE_RESOURCE ?? defaultEngineResource);
const entitlementsDirectory = path.resolve(__dirname, "assets", "entitlements");
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

function canonicalEngineResource(): string {
  if (path.basename(sourceEngineResource) === "loci-engine") return sourceEngineResource;
  temporaryEngineResourceRoot = mkdtempSync(path.join(os.tmpdir(), "loci-engine-resource-"));
  const destination = path.join(temporaryEngineResourceRoot, "loci-engine");
  cpSync(sourceEngineResource, destination, { recursive: true, dereference: true });
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

function hardenPackagedResources(
  buildPath: string,
  _electronVersion: string,
  platform: string,
  arch: string,
  callback: (error?: Error | null) => void,
): void {
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
    mkdirSync(noticesDirectory, { recursive: true });
    const noticeSources = [
      [path.resolve(__dirname, "..", "LICENSE"), "LOCI_LICENSE"],
      [path.resolve(__dirname, "..", "NOTICE"), "LOCI_NOTICE"],
      [path.resolve(__dirname, "..", "THIRD_PARTY_NOTICES.md"), "THIRD_PARTY_NOTICES.md"],
      [path.resolve(__dirname, "..", "scripts", "upstream_licences", "flatbuffers-25.12.19", "LICENSE"), "FLATBUFFERS_25.12.19_LICENSE"],
      [path.join(buildPath, "LICENSE"), "ELECTRON_LICENSE"],
      [path.join(buildPath, "LICENSES.chromium.html"), "LICENSES.chromium.html"],
    ] as const;
    for (const [source, filename] of noticeSources) {
      if (!existsSync(source)) {
        throw new Error(`Packaging stopped because a required notice is missing: ${source}`);
      }
      copyFileSync(source, path.join(noticesDirectory, filename));
    }
    callback(null);
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
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
    icon: packagingPlatform === "win32" ? undefined : path.resolve(__dirname, "assets", "Loci"),
    name: productName,
    osxSign: macSignMode === "adhoc-local" ? localAdHocSign : undefined,
    extraResource: [packagedEngineResource],
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
