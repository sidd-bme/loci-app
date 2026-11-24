import type { ChannelEdit, DisplayChannel } from "../shared/display-inspector-api";

/** Apply a single edit to the latest owner channel, including its paired level. */
export function applyDisplayChannelEdit(channel: DisplayChannel, edit: ChannelEdit, rgbMaximum: number | null): DisplayChannel | null {
  const { field, value } = edit;
  if (field === "visible") return rgbMaximum === null ? { ...channel, visible: value } : null;
  if (field === "color") return rgbMaximum === null && /^#[a-f0-9]{6}$/i.test(value) ? { ...channel, color: value } : null;
  if (!Number.isFinite(value)) return null;
  if (field === "gamma") return value >= 0.1 && value <= 10 ? { ...channel, gamma: value } : null;
  if (field === "opacity") return rgbMaximum === null && value >= 0 && value <= 1 ? { ...channel, opacity: value } : null;
  let low = channel.low ?? 0;
  let high = channel.high ?? rgbMaximum ?? 1;
  if (field === "low") low = value;
  if (field === "high") high = value;
  if (field === "window") {
    const level = (high + low) / 2;
    low = level - value / 2;
    high = level + value / 2;
  }
  if (field === "level") {
    const half = (high - low) / 2;
    low = value - half;
    high = value + half;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high ||
    (rgbMaximum !== null && (low < 0 || high > rgbMaximum || field === "window" || field === "level"))) return null;
  if (field === "low") return { ...channel, low };
  if (field === "high") return { ...channel, high };
  return { ...channel, low, high };
}
