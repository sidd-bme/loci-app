import type { RawVolumeComponent, VolumeRenderMode } from "./RawVolumeViewport";
import type { ViewerChannel } from "./ImageViewport";

/** Optional shared display settings for the detached control panel. Values remain native scalar units. */
export interface VolumeDisplayControls {
  channels: ViewerChannel[];
  renderMode: VolumeRenderMode;
  quality: number;
}

export function applyVolumeDisplayChannels(components: RawVolumeComponent[], channels: ViewerChannel[]): RawVolumeComponent[] {
  return components.map((component) => {
    const channel = channels.find((value) => value.channel === component.channel_index);
    if (!channel) throw new Error("Volume display settings are missing a source channel.");
    const low = channel.low ?? component.window.low;
    const high = channel.high ?? component.window.high;
    const opacity = channel.opacity ?? 1;
    if (![low, high, channel.gamma, opacity].every(Number.isFinite) || low >= high || channel.gamma <= 0 || opacity < 0 || opacity > 1 ||
        !/^#[a-f0-9]{6}$/iu.test(channel.color)) throw new Error("Invalid volume display range or color.");
    const color = [1, 3, 5].map((offset) => parseInt(channel.color.slice(offset, offset + 2), 16) / 255) as [number, number, number];
    return { ...component, window: { low, high, gamma: channel.gamma }, color_rgb: color, visible: channel.visible, opacity };
  });
}

export function volumeDisplayChannels(components: RawVolumeComponent[]): ViewerChannel[] {
  return components.map((component) => ({ channel: component.channel_index, ...component.window,
    color: `#${component.color_rgb.map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`,
    visible: component.visible, opacity: component.opacity }));
}
