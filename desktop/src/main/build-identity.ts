export const BUILD_IDENTITY_SCHEMA = "loci.development-build/v1";
export const BUILD_IDENTITY_FILE = "loci-build-identity.json";

export interface DevelopmentBuildConfig {
  schema: "loci.development-build-config/v1";
  channel: "development";
  buildNumber: number;
}

export interface DevelopmentBuildIdentity {
  schema: typeof BUILD_IDENTITY_SCHEMA;
  channel: "development";
  buildNumber: number;
  bundleVersion: string;
  compatibilityVersion: string;
  sourceRevision: string;
  sourceTree: string;
  sourceDirty: boolean;
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.sort().join(",")) {
    throw new Error("Malformed Loci development build identity.");
  }
  return value as Record<string, unknown>;
}

function validBuildNumber(value: unknown): value is number {
  // Apple's first CFBundleVersion component has at most four digits.
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 9999;
}

export function parseDevelopmentBuildConfig(value: unknown): DevelopmentBuildConfig {
  const raw = exactObject(value, ["schema", "channel", "buildNumber"]);
  if (raw.schema !== "loci.development-build-config/v1" || raw.channel !== "development" ||
      !validBuildNumber(raw.buildNumber)) throw new Error("Malformed Loci development build configuration.");
  return raw as unknown as DevelopmentBuildConfig;
}

export function parseDevelopmentBuildIdentity(value: unknown): DevelopmentBuildIdentity {
  const raw = exactObject(value, ["schema", "channel", "buildNumber", "bundleVersion",
    "compatibilityVersion", "sourceRevision", "sourceTree", "sourceDirty"]);
  if (raw.schema !== BUILD_IDENTITY_SCHEMA || raw.channel !== "development" ||
      !validBuildNumber(raw.buildNumber) || raw.bundleVersion !== `${raw.buildNumber}.0.0` ||
      typeof raw.compatibilityVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.compatibilityVersion) ||
      typeof raw.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(raw.sourceRevision) ||
      typeof raw.sourceTree !== "string" || !/^[a-f0-9]{40}$/.test(raw.sourceTree) ||
      typeof raw.sourceDirty !== "boolean") throw new Error("Malformed Loci development build identity.");
  return raw as unknown as DevelopmentBuildIdentity;
}
