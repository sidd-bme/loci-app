export interface ControlledMethodMetric {
  id: string;
  kind: "measurement" | "prediction";
  unit: string;
  description: string;
}

export interface ControlledMethodInfo {
  method_id: string;
  manifest_sha256: string;
  module_sha256: string;
  manifest: {
    schema: "loci.controlled-method/v1";
    id: string;
    version: string;
    abi: string;
    module: { sha256: string; bytes: number };
    rights: { license: string; source: string; use_basis: string };
    metrics: ControlledMethodMetric[];
  };
  rights_status: "not-reviewed" | "approved" | "revoked";
  runtime: { available: boolean; execution_available: boolean; reason?: string; execution_reason?: string; qualification: string };
}

export interface ControlledMethodBinding {
  method_id: string;
  manifest_sha256: string;
  module_sha256: string;
  result_id: string;
  revision_hash: string;
  raw_channels: number[];
  working_bytes: number;
}
export type ControlledMethodInputBinding = ControlledMethodBinding & { preflight_hash: string };
export interface ControlledMethodRightsReview {
  method_id: string;
  manifest_sha256: string;
  module_sha256: string;
  decision: "approved" | "revoked";
  reviewer: string;
  evidence: string;
}

export function checkedMethodInput(value: unknown): ControlledMethodInputBinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose an exact controlled-method input.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "manifest_sha256,method_id,module_sha256,preflight_hash,raw_channels,result_id,revision_hash,working_bytes" ||
      ![v.method_id, v.result_id].every(x => typeof x === "string" && /^[a-f0-9]{32}$/u.test(x)) ||
      ![v.manifest_sha256, v.module_sha256, v.preflight_hash, v.revision_hash].every(x => typeof x === "string" && /^[a-f0-9]{64}$/u.test(x)) ||
      !Number.isSafeInteger(v.working_bytes) || Number(v.working_bytes) < 1024 ** 2 || Number(v.working_bytes) > 8 * 1024 ** 3 ||
      !Array.isArray(v.raw_channels) || v.raw_channels.length < 1 || v.raw_channels.length > 8 ||
      v.raw_channels.some(c => !Number.isSafeInteger(c) || c < 0 || c > 255) || new Set(v.raw_channels).size !== v.raw_channels.length)
    throw new Error("Controlled-method inputs require exact hashes, unique ordered channels and a bounded memory budget.");
  return structuredClone(value) as ControlledMethodInputBinding;
}

export function checkedMethodRights(value: unknown): ControlledMethodRightsReview {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose an exact method and record the rights evidence.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "decision,evidence,manifest_sha256,method_id,module_sha256,reviewer" ||
      typeof v.method_id !== "string" || !/^[a-f0-9]{32}$/u.test(v.method_id) ||
      ![v.manifest_sha256, v.module_sha256].every(x => typeof x === "string" && /^[a-f0-9]{64}$/u.test(x)) ||
      !["approved", "revoked"].includes(String(v.decision)) ||
      typeof v.reviewer !== "string" || !v.reviewer.trim() || v.reviewer.length > 256 ||
      typeof v.evidence !== "string" || !v.evidence.trim() || v.evidence.length > 8192)
    throw new Error("Record a reviewer, evidence and an explicit rights decision for this exact method.");
  return structuredClone(value) as ControlledMethodRightsReview;
}
