import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ResearchSource } from "../shared/research-contracts";
import type { ViewerChannel } from "./ImageViewport";
import { ValidatedNumberInput } from "./ValidatedNumberInput";
import "./CompactChannelControls.css";

export type CompactChannelControlsProps = {
  source: ResearchSource;
  channels: ViewerChannel[];
  onChannels: (channels: ViewerChannel[]) => void;
  disabled?: boolean;
  onOpenDisplay?: () => void;
  onAuto?: (channel: number) => void;
  onSourceChannel?: (channel: number) => void;
};

/** Scalar tone selection is display-only; RGB logical C selects a source plane. */
export function CompactChannelControls(props: CompactChannelControlsProps) {
  // Remount drafts and solo history when the immutable source or channel identities change.
  const identity = JSON.stringify([props.source.id, props.source.sha256,
    props.source.metadata.sample_semantics, props.channels.map(({ channel }) =>
      [channel, props.source.metadata.channel_names?.[channel] ?? null])]);
  return <ChannelControls key={identity} {...props} />;
}

function DisplayRange({ channel, label, rgb, maximum, disabled, onRange }: {
  channel: ViewerChannel; label: string; rgb: boolean; maximum: number;
  disabled: boolean; onRange: (low: number, high: number) => void;
}) {
  const low = channel.low ?? 0, high = channel.high ?? (rgb ? maximum : 1);
  const drafts = useRef({ low: String(low), high: String(high) });
  useEffect(() => { drafts.current.low = String(low); }, [low]);
  useEffect(() => { drafts.current.high = String(high); }, [high]);
  const commit = () => {
    const a = Number(drafts.current.low), b = Number(drafts.current.high);
    if (!drafts.current.low.trim() || !drafts.current.high.trim() ||
      !Number.isFinite(a) || !Number.isFinite(b) || a >= b ||
      (rgb && (a < 0 || b > maximum))) return false;
    // Publish both limits together, including when a pair moves beyond the old range.
    onRange(a, b);
    return true;
  };
  return <div className="compact-channel-range"
    onChangeCapture={(event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      const field = event.target.getAttribute("aria-label") === `${label} low` ? "low" : "high";
      drafts.current[field] = event.target.value;
    }}
    onKeyDownCapture={(event) => {
      if (event.key !== "Escape" || !(event.target instanceof HTMLInputElement)) return;
      const field = event.target.getAttribute("aria-label") === `${label} low` ? "low" : "high";
      drafts.current[field] = String(field === "low" ? low : high);
    }}>
    <label>Low<ValidatedNumberInput label={`${label} low`} value={low} disabled={disabled}
      minimum={rgb ? 0 : undefined} maximum={rgb ? maximum : undefined}
      rejectionHint="Enter finite limits with low below high." onValue={commit} /></label>
    <label>High<ValidatedNumberInput label={`${label} high`} value={high} disabled={disabled}
      minimum={rgb ? 0 : undefined} maximum={rgb ? maximum : undefined}
      rejectionHint="Enter finite limits with low below high." onValue={commit} /></label>
  </div>;
}

function ChannelControls({ source, channels, onChannels, disabled = false, onOpenDisplay, onAuto, onSourceChannel }: CompactChannelControlsProps) {
  const rgb = source.metadata.sample_semantics === "RGB" || source.metadata.sample_semantics === "RGBA";
  const rgbMaximum = source.metadata.channel_dtypes?.[channels[0]?.channel ?? 0] === "uint16" ? 65535 : 255;
  const rgbChannelCount = source.metadata.dimensions?.c ?? 1;
  const [selected, setSelected] = useState(channels[0]?.channel);
  const [solo, setSolo] = useState<{ channel: number; visibility: Map<number, boolean> } | null>(null);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [expanded, setExpanded] = useState(true);
  const disclosureChosen = useRef(false);
  useLayoutEffect(() => {
    const element = disclosure.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const width = element.getBoundingClientRect().width;
    if (width > 0) setExpanded(width >= 640);
    const observer = new ResizeObserver(([entry]) => {
      if (!disclosureChosen.current) setExpanded(entry.contentRect.width >= 640);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const active = channels.find((item) => item.channel === selected) ?? channels[0];
  const labelFor = (channel: ViewerChannel) => rgb ? "RGB components"
    : source.metadata.channel_names?.[channel.channel] || `Channel ${channel.channel + 1}`;
  const label = active ? labelFor(active) : "Channel";
  const update = (changes: Partial<ViewerChannel>) => {
    if (!active || disabled) return;
    onChannels(channels.map((item) => item.channel === active.channel ? { ...item, ...changes } : item));
  };
  const toggleSolo = () => {
    if (!active || disabled) return;
    if (solo?.channel === active.channel) {
      onChannels(channels.map((item) => ({ ...item, visible: solo.visibility.get(item.channel) ?? item.visible })));
      setSolo(null);
    } else {
      const visibility = solo?.visibility ?? new Map(channels.map((item) => [item.channel, item.visible]));
      setSolo({ channel: active.channel, visibility });
      onChannels(channels.map((item) => ({ ...item, visible: item.channel === active.channel })));
    }
  };
  return <details className="compact-channel-controls" open={expanded} ref={disclosure}
    onKeyDown={(event) => {
      if (event.key === "Escape" && disclosure.current?.open) {
        event.preventDefault(); event.stopPropagation();
        disclosureChosen.current = true;
        setExpanded(false);
        disclosure.current.querySelector("summary")?.focus();
      }
    }}>
    <summary title="Expand or collapse display controls" onClick={(event) => {
      event.preventDefault(); disclosureChosen.current = true; setExpanded((value) => !value);
    }}>{rgb ? "Image tone" : "Display channels"}</summary>
    <div className="compact-channel-body" role="group" aria-label="Channel display controls">
      {!channels.length ? <span className="compact-channel-empty">No display channels</span> : <>
        {!rgb && <div className="compact-channel-visibility" role="group" aria-label="Channel visibility">
          {channels.map((channel) => <label key={channel.channel} title={labelFor(channel)}>
            <input type="checkbox" aria-label={`${labelFor(channel)} visible`} checked={channel.visible} disabled={disabled}
              onChange={(event) => {
                setSolo(null);
                onChannels(channels.map((item) => item.channel === channel.channel ? { ...item, visible: event.target.checked } : item));
              }} />
            <i aria-hidden="true" style={{ background: channel.color }} />
            <span>{labelFor(channel)}</span>
          </label>)}
        </div>}
        {active && <>
          <label className="compact-channel-select">{rgb && rgbChannelCount > 1 ? "Image channel" : rgb ? "Tone" : "Display channel"}<select aria-label="Display channel" value={active.channel} disabled={disabled || (rgb && (rgbChannelCount < 2 || !onSourceChannel))}
            onChange={(event) => rgb ? onSourceChannel?.(Number(event.target.value)) : setSelected(Number(event.target.value))}>
            {rgb && rgbChannelCount > 1 ? Array.from({ length: rgbChannelCount }, (_, channel) => <option key={channel} value={channel}>
              {source.metadata.channel_names?.[channel] || `Channel ${channel + 1}`}
            </option>) : (rgb ? [active] : channels).map((channel) => <option key={channel.channel} value={channel.channel}>{labelFor(channel)}</option>)}
          </select></label>
          {!rgb && channels.length > 1 && <button type="button" aria-pressed={solo?.channel === active.channel}
            disabled={disabled} onClick={toggleSolo} title={solo?.channel === active.channel ? "Restore visibility before solo" : `Show only ${label}`}>
            {solo?.channel === active.channel ? "Restore" : "Solo"}</button>}
          <DisplayRange key={active.channel} channel={active} label={label} rgb={rgb} maximum={rgbMaximum} disabled={disabled}
            onRange={(low, high) => update({ low, high })} />
          {onAuto && <button type="button" disabled={disabled} onClick={() => onAuto(active.channel)} title={`Set a full-image display range for ${label}`}>Auto</button>}
          <details className="compact-channel-lut">
            <summary>More display</summary>
            <div className="compact-channel-lut-body">
              <label>Gamma<ValidatedNumberInput key={active.channel} label={`${label} gamma`} value={active.gamma}
                minimum={0.1} maximum={10} disabled={disabled} onValue={(gamma) => { update({ gamma }); return true; }} /></label>
              {!rgb && <>
                <label>Colour<input type="color" aria-label={`${label} color`} value={active.color} disabled={disabled}
                  onChange={(event) => update({ color: event.target.value })} /></label>
                <label className="compact-channel-opacity">Opacity <output>{active.opacity ?? 1}</output>
                  <input type="range" aria-label={`${label} opacity`} min={0} max={1} step={0.01} value={active.opacity ?? 1}
                    disabled={disabled} onChange={(event) => update({ opacity: Number(event.target.value) })} /></label>
              </>}
              {rgb && <small>One tone curve for RGB components.{source.metadata.sample_semantics === "RGBA" && " Source alpha is retained."}</small>}
              {onOpenDisplay && <button type="button" disabled={disabled} onClick={onOpenDisplay}>Full display options</button>}
            </div>
          </details>
        </>}
      </>}
    </div>
  </details>;
}
