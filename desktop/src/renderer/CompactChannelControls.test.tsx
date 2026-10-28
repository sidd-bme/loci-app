// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchSource } from "../shared/research-contracts";
import type { ViewerChannel } from "./ImageViewport";
import { CompactChannelControls, type CompactChannelControlsProps } from "./CompactChannelControls";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const source: ResearchSource = {
  id: "a".repeat(32), sha256: "b".repeat(64), name: "Synthetic channels.tif", source_kind: "native",
  metadata: { axes: "CYX", dimensions: { t: 1, c: 3, z: 1, y: 32, x: 32, s: 1 },
    sample_semantics: "none", channel_names: ["Nuclei", "Marker", "Reference"], channel_dtypes: ["uint16", "uint16", "uint16"] },
};
const channelState = (): ViewerChannel[] => [0, 1, 2].map((channel) => ({
  channel, visible: channel !== 1, color: ["#0000ff", "#00ff00", "#ff0000"][channel], low: 0, high: 255, gamma: 1, opacity: 1,
}));
function mount(overrides: Partial<CompactChannelControlsProps> = {}) {
  const onChannels = vi.fn(), initial = overrides.channels ?? channelState();
  function Harness({ currentSource = source }: { currentSource?: ResearchSource }) {
    const [channels, setChannels] = useState(initial);
    return <CompactChannelControls {...overrides} source={currentSource} channels={channels}
      onChannels={(next) => { onChannels(next); setChannels(next); }} />;
  }
  return { ...render(<Harness />), onChannels, initial, Harness };
}
const low = () => screen.getByLabelText("Nuclei low");
const high = () => screen.getByLabelText("Nuclei high");
function draft(input: HTMLElement, value: string) { fireEvent.change(input, { target: { value } }); }
function select(value: number) { fireEvent.change(screen.getByRole("combobox", { name: "Display channel" }), { target: { value } }); }
function solo() { fireEvent.click(screen.getByRole("button", { name: "Solo" })); }
function restore() { fireEvent.click(screen.getByRole("button", { name: "Restore" })); }

describe("compact channel display", () => {
  it("collapses a narrow image stage by default and retains deliberate disclosure choices on resize", () => {
    let resize: ResizeObserverCallback;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {} disconnect() {}
    });
    const view = mount();
    const summary = screen.getByText("Display channels", { exact: true });
    const changeWidth = (width: number) => act(() => resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
    changeWidth(400);
    expect(summary.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    changeWidth(350);
    expect(summary.closest("details")).toHaveAttribute("open");
    fireEvent.click(summary); changeWidth(900);
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(view.onChannels).not.toHaveBeenCalled();
  });
  it("changes visibility without mutating source metadata or the supplied channels", () => {
    const original = structuredClone(source), channels = channelState(), preserved = structuredClone(channels);
    channels.forEach(Object.freeze); Object.freeze(channels);
    const view = mount({ channels });
    fireEvent.click(screen.getByRole("checkbox", { name: "Marker visible" }));
    expect(view.onChannels).toHaveBeenLastCalledWith([channels[0], { ...channels[1], visible: true }, channels[2]]);
    expect(channels).toEqual(preserved); expect(source).toEqual(original);
  });
  it("solos the locally selected display channel and restores only original visibility", () => {
    const view = mount(); select(1);
    expect(view.onChannels).not.toHaveBeenCalled(); solo();
    expect(view.onChannels.mock.lastCall![0].map((item: ViewerChannel) => item.visible)).toEqual([false, true, false]);
    draft(screen.getByLabelText("Marker high"), "400"); fireEvent.blur(screen.getByLabelText("Marker high")); restore();
    expect(view.onChannels.mock.lastCall![0]).toEqual([view.initial[0], { ...view.initial[1], high: 400 }, view.initial[2]]);
  });
  it("keeps the original snapshot when solo moves to a different channel", () => {
    const view = mount(); solo(); select(1); solo(); restore();
    expect(view.onChannels.mock.lastCall![0]).toEqual(view.initial);
  });
  it("ends solo history after manual visibility changes", () => {
    mount(); solo(); fireEvent.click(screen.getByRole("checkbox", { name: "Marker visible" }));
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Solo" })).toHaveAttribute("aria-pressed", "false");
  });
  it.each([
    { ...source, id: "c".repeat(32) }, { ...source, sha256: "d".repeat(64) },
    { ...source, metadata: { ...source.metadata, channel_names: ["Renamed", "Marker", "Reference"] } },
  ])("discards solo history and drafts for changed source/channel identity", (currentSource) => {
    const view = mount(); solo(); draft(low(), "unfinished");
    view.rerender(<view.Harness currentSource={currentSource} />);
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(`${currentSource.metadata.channel_names![0]} low`)).toHaveValue("0");
    expect(view.onChannels).toHaveBeenCalledTimes(1);
  });
  it("invalidates solo history when the channel set changes", () => {
    const onChannels = vi.fn(), channels = channelState();
    const view = render(<CompactChannelControls source={source} channels={channels} onChannels={onChannels} />); solo();
    view.rerender(<CompactChannelControls source={source} channels={channels.slice(1)} onChannels={onChannels} />);
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Display channel" })).toHaveValue("1");
  });
  it.each(["", " ", "NaN", "Infinity", "abc", "255", "300"])("retains invalid low draft %j and blocks commit", (text) => {
    const view = mount(); draft(low(), text); fireEvent.blur(low());
    expect(low()).toHaveValue(text); expect(low()).toHaveAttribute("aria-invalid", "true");
    expect(view.onChannels).not.toHaveBeenCalled(); fireEvent.keyDown(low(), { key: "Escape" });
    expect(low()).toHaveValue("0"); expect(low()).toHaveAttribute("aria-invalid", "false");
  });
  it("publishes both limits atomically when a pair moves beyond the original range", () => {
    const view = mount(); draft(low(), "300"); fireEvent.blur(low()); expect(view.onChannels).not.toHaveBeenCalled();
    draft(high(), "400"); fireEvent.blur(high());
    expect(view.onChannels).toHaveBeenCalledExactlyOnceWith([{ ...view.initial[0], low: 300, high: 400 }, view.initial[1], view.initial[2]]);
    expect(low()).toHaveValue("300"); expect(low()).toHaveAttribute("aria-invalid", "false");
  });
  it("blocks high while an empty low draft remains, then accepts after Escape restores it", () => {
    const view = mount(); draft(low(), ""); draft(high(), "400"); fireEvent.blur(high());
    expect(view.onChannels).not.toHaveBeenCalled(); expect(low()).toHaveValue("");
    fireEvent.keyDown(low(), { key: "Escape" }); fireEvent.blur(high());
    expect(view.onChannels).toHaveBeenCalledExactlyOnceWith([{ ...view.initial[0], high: 400 }, view.initial[1], view.initial[2]]);
  });
  it("preserves full precision negative native values and rejects equal high limits", () => {
    const view = mount(); draft(high(), "0"); fireEvent.blur(high()); expect(view.onChannels).not.toHaveBeenCalled();
    fireEvent.keyDown(high(), { key: "Escape" }); draft(low(), "-1.23456789012345"); fireEvent.blur(low());
    expect(view.onChannels.mock.lastCall![0][0]).toMatchObject({ low: -1.23456789012345, high: 255 });
  });
  it("commits by Enter, restores by Escape, and collapses by Escape with focus restored", () => {
    const view = mount(); low().focus(); draft(low(), "5"); fireEvent.keyDown(low(), { key: "Enter" });
    expect(view.onChannels).toHaveBeenCalledTimes(1);
    draft(low(), "invalid"); fireEvent.keyDown(low(), { key: "Escape" }); expect(low()).toHaveValue("5");
    const summary = screen.getByText("Display channels", { exact: true }); expect(summary.closest("details")).toHaveAttribute("open");
    const channelSelect = screen.getByRole("combobox", { name: "Display channel" });
    channelSelect.focus(); fireEvent.keyDown(channelSelect, { key: "Escape" });
    expect(summary.closest("details")).not.toHaveAttribute("open"); expect(summary).toHaveFocus();
  });
  it("routes Auto and full display options explicitly", () => {
    const onAuto = vi.fn(), onOpenDisplay = vi.fn(); mount({ onAuto, onOpenDisplay }); select(1);
    fireEvent.click(screen.getByRole("button", { name: "Auto" })); expect(onAuto).toHaveBeenCalledExactlyOnceWith(1);
    fireEvent.click(screen.getByText("More display")); fireEvent.click(screen.getByRole("button", { name: "Full display options" }));
    expect(onOpenDisplay).toHaveBeenCalledOnce();
  });
  it("edits only the selected channel's gamma, color and opacity", () => {
    const view = mount(); select(1); fireEvent.click(screen.getByText("More display"));
    draft(screen.getByLabelText("Marker gamma"), "2"); fireEvent.blur(screen.getByLabelText("Marker gamma"));
    fireEvent.change(screen.getByLabelText("Marker color"), { target: { value: "#123456" } });
    fireEvent.change(screen.getByRole("slider", { name: "Marker opacity" }), { target: { value: "0.42" } });
    expect(view.onChannels.mock.lastCall![0]).toEqual([view.initial[0], { ...view.initial[1], gamma: 2, color: "#123456", opacity: 0.42 }, view.initial[2]]);
  });
  it("disables mutations while leaving the native disclosure usable", () => {
    mount({ disabled: true, onAuto: vi.fn(), onOpenDisplay: vi.fn() });
    expect(screen.getByRole("checkbox", { name: "Nuclei visible" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Display channel" })).toBeDisabled(); expect(low()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Solo" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Auto" })).toBeDisabled();
    fireEvent.click(screen.getByText("More display")); expect(screen.getByLabelText("Nuclei gamma")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Full display options" })).toBeDisabled();
  });
  it("selects a logical RGB plane without treating RGB components as biological channels", () => {
    const onChannels = vi.fn(), onSourceChannel = vi.fn();
    render(<CompactChannelControls source={{ ...source, metadata: { ...source.metadata, sample_semantics: "RGB",
      dimensions: { ...source.metadata.dimensions!, c: 2, s: 3 }, channel_names: ["Plane A", "Plane B"] } }}
      channels={[{ ...channelState()[0], channel: 1 }]} onChannels={onChannels} onSourceChannel={onSourceChannel} />);
    expect(screen.getByLabelText("Display channel")).toHaveValue("1");
    fireEvent.change(screen.getByLabelText("Display channel"), { target: { value: "0" } });
    expect(onSourceChannel).toHaveBeenCalledWith(0);
    expect(onChannels).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it.each(["RGB", "RGBA"])("labels %s components without scalar or alpha edits", (sample_semantics) => {
    const onChannels = vi.fn();
    render(<CompactChannelControls source={{ ...source, metadata: { ...source.metadata, sample_semantics,
      dimensions: { ...source.metadata.dimensions!, c: 1 } } }} channels={[channelState()[0]]} onChannels={onChannels} />);
    expect(screen.getByRole("option", { name: "RGB components" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Solo" })).not.toBeInTheDocument();
    draft(screen.getByLabelText("RGB components low"), "-1"); fireEvent.blur(screen.getByLabelText("RGB components low"));
    expect(onChannels).not.toHaveBeenCalled(); fireEvent.click(screen.getByText("More display"));
    expect(screen.queryByLabelText("RGB components color")).not.toBeInTheDocument(); expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    if (sample_semantics === "RGBA") expect(screen.getByText(/Source alpha is retained/)).toBeInTheDocument();
  });
  it("handles an empty channel list without offering mutations", () => {
    mount({ channels: [] }); expect(screen.getByText("No display channels")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
