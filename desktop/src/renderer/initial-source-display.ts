import type { ResearchDesktopApi, ResearchSource } from "../shared/research-contracts";
import type { ViewerChannel } from "./ImageViewport";

export interface SourceDisplayDefaults {
  source_id: string;
  source_sha256: string;
  channels: ViewerChannel[];
  basis: unknown;
}

/** Interleaved RGB has one tone curve; its logical C follows the selected plane. */
export function rgbChannelsForPlane(channels: ViewerChannel[], rgb: boolean, c: number): ViewerChannel[] {
  if (!rgb || channels.length !== 1 || channels[0].channel === c) return channels;
  return [{ ...channels[0], channel: c }];
}

/** Fill only missing scalar acquisition ranges, using the engine's bounded,
 * deterministic whole-image sample. Saved settings and RGB rendering win. */
export async function initialSourceDisplay(
  api: ResearchDesktopApi,
  source: ResearchSource,
  defaults: SourceDisplayDefaults,
  hasSavedDisplay: boolean,
  z: number,
): Promise<SourceDisplayDefaults> {
  if (defaults.source_id !== source.id || defaults.source_sha256 !== source.sha256 || !Array.isArray(defaults.channels))
    throw new Error("Display defaults do not match this source.");
  if (hasSavedDisplay || ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "")) return defaults;
  const basis = defaults.basis as { channels?: Array<{ channel: number; range: string }> } | null;
  const missing = new Set(basis?.channels?.filter((item) => ["native-dtype-range", "unit-range-fallback"].includes(item.range))
    .map((item) => item.channel) ?? []);
  if (!missing.size) return defaults;
  const auto = await api.execute("viewer_defaults", { source_id: source.id, t: 0, z, auto: true }) as SourceDisplayDefaults;
  if (auto?.source_id !== source.id || auto?.source_sha256 !== source.sha256 || !Array.isArray(auto.channels))
    throw new Error("Initial display range does not match this source.");
  const channels = defaults.channels.map((channel) => {
    if (!missing.has(channel.channel)) return channel;
    const candidates = auto.channels.filter((item) => item.channel === channel.channel);
    const sampled = candidates[0];
    if (candidates.length !== 1 || typeof sampled.low !== "number" || typeof sampled.high !== "number"
      || !Number.isFinite(sampled.low) || !Number.isFinite(sampled.high) || sampled.low >= sampled.high)
      throw new Error("Initial display range is invalid for this channel.");
    return { ...channel, low: sampled.low, high: sampled.high };
  });
  return { ...defaults, channels, basis: "Initial contrast from whole-image percentiles" };
}
