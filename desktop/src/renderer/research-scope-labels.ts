import type { ResearchSelection, ResearchSource } from "../shared/research-contracts";

/** Presentation only: persisted C/Z/T remain zero-based. X/Y are pixel offsets. */
export function sourceChannelLabel(source: ResearchSource, channel: number): string {
  return source.metadata.channel_names?.[channel]?.trim() || `Channel ${channel + 1}`;
}

export function researcherScopeLabel(source: ResearchSource, selection: ResearchSelection): string {
  const dimensions = source.metadata.dimensions;
  const whole = selection.x === 0 && selection.y === 0 && selection.width === dimensions?.x && selection.height === dimensions?.y;
  const region = whole ? "Whole image" : `Region: X ${selection.x}, Y ${selection.y}`;
  const z = selection.z_stop === undefined ? `Z ${selection.z + 1}` : `Z ${selection.z + 1}–${selection.z_stop}`;
  return `${region} · ${selection.width} × ${selection.height} px · ${sourceChannelLabel(source, selection.c)} · ${z} · T ${selection.t + 1}`;
}
