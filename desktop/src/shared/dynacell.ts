/** The publisher's WTC-11 iPSC Phase3D → Nuclei UNeXt2 profile. */
export const DYNACELL_NUCLEUS = Object.freeze({
  id: "dynacell-ipsc-nucleus",
  url: "https://dynacell.s3.us-west-2.amazonaws.com/v1/models/ipsc/nucleus/unext2/epoch=80-step=25272.ckpt",
  sha256: "58b222f92978b50647d547e5fd69edaafa2d2c5854fbc7f7324e9bcf8835051d",
  sizeBytes: 386_093_992,
});

export type VirtualStainInstallState = "missing" | "installing" | "ready" | "damaged" | "unsupported";

export interface VirtualStainRequest {
  source_id: string;
  source_sha256: string;
  channel: number;
  timepoint: number;
  phase_confirmed: true;
}

export function isVirtualStainRequest(value: unknown): value is VirtualStainRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(",") === "channel,phase_confirmed,source_id,source_sha256,timepoint" &&
    typeof v.source_id === "string" && /^[a-f0-9]{32}$/u.test(v.source_id) &&
    typeof v.source_sha256 === "string" && /^[a-f0-9]{64}$/u.test(v.source_sha256) &&
    v.phase_confirmed === true && typeof v.channel === "number" && Number.isSafeInteger(v.channel) && v.channel >= 0 &&
    typeof v.timepoint === "number" && Number.isSafeInteger(v.timepoint) && v.timepoint >= 0;
}
