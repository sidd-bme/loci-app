import type { ResearchVisionRequest, ResearchVisionReceipt } from "./research-contracts";

function exact(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key))) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown, min = 0): value is number => finite(value) && Number.isSafeInteger(value) && value >= min;

export function checkedVisionChannels(value: unknown): ResearchVisionRequest["channels"] {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error("Choose 1–16 display channels.");
  const channels = value.map((item) => {
    const c = exact(item, ["channel", "low", "high", "gamma", "color", "opacity", "visible"], "display channel");
    if (!integer(c.channel) || !finite(c.low) || !finite(c.high) || c.high <= c.low ||
        !finite(c.gamma) || c.gamma < 0.1 || c.gamma > 10 || !finite(c.opacity) || c.opacity < 0 || c.opacity > 1 ||
        typeof c.visible !== "boolean" || typeof c.color !== "string" || !/^#[0-9a-f]{6}$/i.test(c.color))
      throw new Error("Choose finite display ranges, gamma, colors and opacity.");
    return c as unknown as ResearchVisionRequest["channels"][number];
  });
  if (new Set(channels.map((c) => c.channel)).size !== channels.length) throw new Error("Display channels must be unique.");
  return channels;
}

export function checkedVisionRequest(value: unknown): ResearchVisionRequest {
  if (JSON.stringify(value)?.length > 65536) throw new Error("The vision request is too large.");
  const r = exact(value, ["source_id", "selection", "channels", "projection", "max_size"], "vision handoff request");
  const selection = exact(r.selection, ["x", "y", "width", "height", "c", "t", "z", "z_stop", "level"], "vision selection");
  if (typeof r.source_id !== "string" || !/^[a-f0-9]{32}$/.test(r.source_id) ||
      !["x", "y", "c", "t", "z", "level"].every((key) => integer(selection[key])) ||
      !["width", "height"].every((key) => integer(selection[key], 1)) ||
      (selection.z_stop !== undefined && (!integer(selection.z_stop, 1) || selection.z_stop <= (selection.z as number))) ||
      !["plane", "max", "mean"].includes(String(r.projection)) ||
      !integer(r.max_size, 64) || r.max_size > 2048)
    throw new Error("Choose an exact source region and a 64–2048 pixel output limit.");
  checkedVisionChannels(r.channels);
  return structuredClone(r) as unknown as ResearchVisionRequest;
}

export function checkedVisionReceipt(value: unknown, sourceId: string, sourceSha256: string): ResearchVisionReceipt {
  const r = exact(value, ["schema", "basename", "source_id", "source_sha256", "status", "artifacts"], "vision handoff receipt");
  if (r.schema !== "loci.vision-handoff-receipt/v1" || r.status !== "provisional-visualization" ||
      r.source_id !== sourceId || r.source_sha256 !== sourceSha256 ||
      typeof r.basename !== "string" || !r.basename.endsWith(".loci-vision") || /[/\\\x00-\x1f]/.test(r.basename))
    throw new Error("The vision handoff receipt does not match this source.");
  const names = ["image.png", "context.json", "README.md", "manifest.json"];
  const artifacts = exact(r.artifacts, names, "vision artifacts");
  if (Object.keys(artifacts).length !== names.length) throw new Error("The vision handoff is incomplete.");
  for (const item of Object.values(artifacts)) {
    const a = exact(item, ["sha256", "size_bytes"], "vision artifact hash");
    if (typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256) || !integer(a.size_bytes, 1))
      throw new Error("The vision handoff hash is invalid.");
  }
  return r as unknown as ResearchVisionReceipt;
}
