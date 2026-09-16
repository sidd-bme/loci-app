import { useEffect, useId, useState } from "react";
import { Eye, EyeOff, Palette, X } from "lucide-react";
import type {
  BatchChannelColorsResponse,
  ResearchDesktopApi,
  ResearchSource,
} from "../shared/research-contracts";
import type { ViewerChannel } from "./ImageViewport";

export interface BatchChannelColorsDialogProps {
  open: boolean;
  onClose: () => void;
  api: Pick<ResearchDesktopApi, "execute">;
  activeSource: ResearchSource;
  sources: ResearchSource[];
  selectedSourceIds: string[];
  activeChannels: ViewerChannel[];
  onBeforeRequest?: () => Promise<void>;
  onApplied?: (response: BatchChannelColorsResponse, activeChannels: ViewerChannel[] | null) => void;
}

const PRESETS: Record<string, string[]> = {
  "fluorescence-4": ["#0000ff", "#00ff00", "#ff0000", "#00ffff"], // DAPI / GFP / TRITC / Cy5
  "fluorescence-far-red": ["#0000ff", "#00ff00", "#ff0000", "#ff00ff"], // DAPI / GFP / TRITC / Far-Red
  "rgb-primary": ["#ff0000", "#00ff00", "#0000ff"], // Red / Green / Blue
  "cmy-subtractive": ["#00ffff", "#ffff00", "#ff00ff"], // Cyan / Yellow / Magenta
  "greyscale": ["#ffffff", "#ffffff", "#ffffff", "#ffffff"],
};

export function BatchChannelColorsDialog({
  open,
  onClose,
  api,
  activeSource,
  sources,
  selectedSourceIds,
  activeChannels,
  onBeforeRequest,
  onApplied,
}: BatchChannelColorsDialogProps) {
  const dialogId = useId();
  const [colorMap, setColorMap] = useState<Record<string, string>>({});
  const [preset, setPreset] = useState<string>("custom");
  const [scope, setScope] = useState<"selected" | "all">("selected");
  const [mappingMode, setMappingMode] = useState<"auto" | "index" | "name">("auto");
  const [showPreview, setShowPreview] = useState(false);
  const [previewRecords, setPreviewRecords] = useState<BatchChannelColorsResponse["affected_sources"] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [previewBinding, setPreviewBinding] = useState<{
    requestKey: string;
    response: BatchChannelColorsResponse;
  } | null>(null);

  const targetSourceIds = scope === "all" ? sources.map((source) => source.id)
    : selectedSourceIds.length > 0 ? selectedSourceIds : [activeSource.id];

  // Initialize colors from active channels with smart auto-mapping (both index and metadata name)
  useEffect(() => {
    if (!open) return;
    const initial: Record<string, string> = {};
    activeChannels.forEach((ch) => {
      const hex = ch.color || "#ffffff";
      initial[String(ch.channel)] = hex;
      const chName = activeSource.metadata?.channel_names?.[ch.channel];
      if (chName) {
        initial[chName] = hex;
      }
    });
    setColorMap(initial);
    setPreset("custom");
    setScope("selected");
    setMappingMode("auto");
    setShowPreview(false);
    setPreviewRecords(null);
    setPreviewError(null);
    setResultMessage(null);
    setPreviewBinding(null);
  // The dialog is mounted anew for each opening. Do not reset its result when
  // onApplied updates the parent channel array while the dialog is still open.
  }, [open, activeSource.id, activeSource.sha256]);

  if (!open) return null;
  const requestedColorMap = mappingMode === "auto" ? colorMap : Object.fromEntries(
    activeChannels.flatMap((channel) => {
      const key = mappingMode === "index" ? String(channel.channel)
        : activeSource.metadata.channel_names?.[channel.channel];
      return key ? [[key, colorMap[String(channel.channel)] ?? channel.color ?? "#ffffff"]] : [];
    }),
  );

  const applyPreset = (presetKey: string) => {
    setPreset(presetKey);
    if (presetKey === "custom" || !PRESETS[presetKey]) return;
    setPreviewBinding(null);
    const palette = PRESETS[presetKey];
    setColorMap((prev) => {
      const next: Record<string, string> = { ...prev };
      activeChannels.forEach((ch, idx) => {
        const hex = palette[idx % palette.length];
        next[String(ch.channel)] = hex;
        const chName = activeSource.metadata?.channel_names?.[ch.channel];
        if (chName) next[chName] = hex;
      });
      return next;
    });
  };

  const handleColorChange = (channelIndex: number, hex: string) => {
    setPreset("custom");
    setPreviewBinding(null);
    setColorMap((prev) => {
      const next: Record<string, string> = { ...prev, [String(channelIndex)]: hex };
      const chName = activeSource.metadata?.channel_names?.[channelIndex];
      if (chName) next[chName] = hex;
      return next;
    });
  };

  const runPreview = async () => {
    setBusy(true);
    setPreviewError(null);
    setResultMessage(null);

    try {
      await onBeforeRequest?.();
      const resp = (await api.execute("batch_channel_colors", {
        source_ids: targetSourceIds,
        preview_only: true,
        mapping_mode: mappingMode,
        color_map: requestedColorMap,
      })) as BatchChannelColorsResponse;

      setPreviewRecords(resp.affected_sources);
      setPreviewBinding({ requestKey: JSON.stringify([targetSourceIds, colorMap, mappingMode]), response: resp });
      setShowPreview(true);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to generate preview");
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    setBusy(true);
    setPreviewError(null);
    setResultMessage(null);

    try {
      await onBeforeRequest?.();
      const requestKey = JSON.stringify([targetSourceIds, colorMap, mappingMode]);
      const preflight = previewBinding?.requestKey === requestKey
        ? previewBinding.response
        : (await api.execute("batch_channel_colors", {
            source_ids: targetSourceIds,
            preview_only: true,
            mapping_mode: mappingMode,
            color_map: requestedColorMap,
          })) as BatchChannelColorsResponse;
      const resp = (await api.execute("batch_channel_colors", {
        source_ids: targetSourceIds,
        preview_only: false,
        mapping_mode: mappingMode,
        color_map: requestedColorMap,
        expected_revisions: preflight.new_revisions,
      })) as BatchChannelColorsResponse;

      // If active source was updated, update local channels state
      const activeAffected = resp.affected_sources.find(
        (s) => s.source_id === activeSource.id && s.status === "applied"
      );
      let updatedChannels: ViewerChannel[] | null = null;
      if (activeAffected) {
        const colorLookup = new Map(activeAffected.changes.map((c) => [c.channel, c.new_color]));
        updatedChannels = activeChannels.map((ch) =>
          colorLookup.has(ch.channel) ? { ...ch, color: colorLookup.get(ch.channel)! } : ch
        );
      }
      onApplied?.(resp, updatedChannels);

      setResultMessage(
        `Applied channel colors to ${resp.applied_count} image(s)${
          resp.skipped_count > 0 ? ` (${resp.skipped_count} skipped)` : ""
        }.`
      );
      setPreviewRecords(resp.affected_sources);
      setTimeout(() => {
        onClose();
      }, 900);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to apply channel colors");
    } finally {
      setBusy(false);
    }
  };

  const actionLabel =
    targetSourceIds.length === 1
      ? "Apply colour to 1 image"
      : `Apply colour to all ${targetSourceIds.length} images`;

  return (
    <div
      className="research-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${dialogId}-title`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="research-modal-card"
        style={{
          maxWidth: "460px",
          width: "92%",
          maxHeight: "88vh",
          overflowY: "auto",
          padding: "16px 18px",
          background: "var(--graphite-900, #141414)",
          border: "1px solid var(--graphite-divider, #2d2d2d)",
          borderRadius: "10px",
          boxShadow: "0 16px 40px rgba(0, 0, 0, 0.6)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingBottom: "10px",
            borderBottom: "1px solid var(--graphite-divider, #2d2d2d)",
            marginBottom: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Palette size={16} style={{ color: "var(--mineral, #76c5b2)" }} />
            <h2 id={`${dialogId}-title`} style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>
              Apply channel colours
            </h2>
            <span
              style={{
                fontSize: "0.72rem",
                fontWeight: 600,
                color: "var(--mineral, #76c5b2)",
                background: "color-mix(in srgb, var(--mineral, #76c5b2) 15%, transparent)",
                padding: "2px 8px",
                borderRadius: "10px",
                border: "1px solid color-mix(in srgb, var(--mineral, #76c5b2) 30%, transparent)",
              }}
            >
              {targetSourceIds.length} {scope === "all" ? "loaded" : "selected"}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--ink-muted, #888)",
              padding: "4px",
              borderRadius: "4px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Notifications */}
        {resultMessage && (
          <div
            role="status"
            style={{
              padding: "6px 10px",
              background: "rgba(118, 197, 178, 0.15)",
              border: "1px solid var(--mineral, #76c5b2)",
              borderRadius: "6px",
              marginBottom: "10px",
              fontSize: "0.8rem",
              color: "var(--mineral, #76c5b2)",
            }}
          >
            {resultMessage}
          </div>
        )}

        {previewError && (
          <div
            role="alert"
            style={{
              padding: "6px 10px",
              background: "rgba(244, 125, 125, 0.15)",
              border: "1px solid #f47d7d",
              borderRadius: "6px",
              marginBottom: "10px",
              fontSize: "0.8rem",
              color: "#f47d7d",
            }}
          >
            {previewError}
          </div>
        )}

        <div className="batch-color-scope">
          <label>Apply to<select aria-label="Target images" value={scope} disabled={busy}
            onChange={(event) => { setScope(event.target.value as typeof scope); setPreviewBinding(null); setPreviewRecords(null); }}>
            <option value="selected">Selected images</option><option value="all">All loaded images</option>
          </select></label>
          <label>Match channels<select aria-label="Channel mapping" value={mappingMode} disabled={busy}
            onChange={(event) => { setMappingMode(event.target.value as typeof mappingMode); setPreviewBinding(null); setPreviewRecords(null); }}>
            <option value="auto">Name, then index</option><option value="name">Channel name</option><option value="index">Channel index</option>
          </select></label>
        </div>
        {/* Preset Selector */}
        <div style={{ marginBottom: "12px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "6px",
            }}
          >
            <span style={{ fontSize: "0.8rem", color: "var(--ink-muted, #888)", fontWeight: 500 }}>
              Palette preset
            </span>
            <select
              aria-label="Palette preset"
              value={preset}
              onChange={(e) => applyPreset(e.target.value)}
              style={{
                fontSize: "0.82rem",
                padding: "4px 28px 4px 10px",
                background: "var(--graphite-850, #1b1b1b)",
                color: "var(--ink, #e0e0e0)",
                border: "1px solid var(--graphite-divider, #333)",
                borderRadius: "5px",
                cursor: "pointer",
                appearance: "none",
                WebkitAppearance: "none",
                backgroundImage:
                  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E\")",
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 8px center",
                backgroundSize: "10px 10px",
                outline: "none",
              }}
            >
              <option value="custom">Custom</option>
              <option value="fluorescence-4">DAPI / GFP / TRITC / Cy5</option>
              <option value="fluorescence-far-red">Blue / Green / Red / Far-Red</option>
              <option value="rgb-primary">RGB Primary (Red / Green / Blue)</option>
              <option value="cmy-subtractive">CMY (Cyan / Yellow / Magenta)</option>
              <option value="greyscale">Greyscale (White)</option>
            </select>
          </div>
        </div>

        {/* Channels List */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            marginBottom: "14px",
          }}
        >
          {activeChannels.map((ch) => {
            const rawName = activeSource.metadata?.channel_names?.[ch.channel];
            const displayName = rawName ? `Ch ${ch.channel + 1} · ${rawName}` : `Channel ${ch.channel + 1}`;
            const color = colorMap[String(ch.channel)] || ch.color || "#ffffff";

            return (
              <div
                key={ch.channel}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "5px 10px",
                  background: "var(--graphite-850, #1a1a1a)",
                  borderRadius: "6px",
                  border: "1px solid var(--graphite-divider, #282828)",
                }}
              >
                <span
                  style={{
                    fontSize: "0.82rem",
                    fontWeight: 500,
                    color: "var(--ink, #e0e0e0)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "210px",
                  }}
                  title={displayName}
                >
                  {displayName}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    type="color"
                    aria-label={`Color for ${displayName}`}
                    value={color}
                    onChange={(e) => handleColorChange(ch.channel, e.target.value)}
                    style={{
                      width: "24px",
                      height: "22px",
                      padding: 0,
                      border: "1px solid rgba(255, 255, 255, 0.2)",
                      borderRadius: "4px",
                      cursor: "pointer",
                      background: "none",
                    }}
                  />
                  <input
                    type="text"
                    aria-label={`Hex code for ${displayName}`}
                    value={color}
                    maxLength={7}
                    onChange={(e) => handleColorChange(ch.channel, e.target.value)}
                    style={{
                      width: "70px",
                      padding: "2px 5px",
                      fontSize: "0.76rem",
                      background: "var(--graphite-900, #121212)",
                      color: "var(--ink, #e0e0e0)",
                      border: "1px solid var(--graphite-divider, #333)",
                      borderRadius: "4px",
                      fontFamily: "monospace",
                      textAlign: "center",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Action Controls */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            borderTop: "1px solid var(--graphite-divider, #2d2d2d)",
            paddingTop: "12px",
          }}
        >
          <button
            type="button"
            onClick={() => (showPreview ? setShowPreview(false) : void runPreview())}
            disabled={busy}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              padding: "5px 10px",
              fontSize: "0.78rem",
              background: "transparent",
              border: "1px solid var(--graphite-divider, #333)",
              borderRadius: "5px",
              color: "var(--ink-muted, #aaa)",
              cursor: "pointer",
            }}
          >
            {showPreview ? <EyeOff size={13} /> : <Eye size={13} />}
            <span>{showPreview ? "Hide preview" : "Preview"}</span>
          </button>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "5px 12px",
                fontSize: "0.82rem",
                background: "transparent",
                border: "1px solid var(--graphite-divider, #333)",
                borderRadius: "5px",
                color: "var(--ink, #ccc)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="research-primary"
              disabled={busy || targetSourceIds.length === 0}
              onClick={() => void runApply()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "5px 15px",
                fontSize: "0.82rem",
                fontWeight: 600,
                cursor: "pointer",
                borderRadius: "5px",
                background: "var(--mineral, #76c5b2)",
                color: "#0b1c16",
                border: "none",
              }}
            >
              <span>{busy ? "Applying…" : actionLabel}</span>
            </button>
          </div>
        </div>

        {/* Optional Collapsible Preview */}
        {showPreview && previewRecords && (
          <div
            style={{
              marginTop: "12px",
              paddingTop: "10px",
              borderTop: "1px solid var(--graphite-divider, #2d2d2d)",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.76rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--graphite-divider, #333)", textAlign: "left" }}>
                  <th style={{ padding: "4px 6px" }}>Image</th>
                  <th style={{ padding: "4px 6px" }}>Status</th>
                  <th style={{ padding: "4px 6px" }}>Changes</th>
                </tr>
              </thead>
              <tbody>
                {previewRecords.map((rec) => (
                  <tr key={rec.source_id} style={{ borderBottom: "1px solid var(--graphite-divider, #222)" }}>
                    <td style={{ padding: "4px 6px", color: "var(--ink, #ccc)" }}>{rec.source_name}</td>
                    <td style={{ padding: "4px 6px" }}>
                      <span
                        style={{
                          padding: "1px 5px",
                          borderRadius: "3px",
                          fontSize: "0.7rem",
                          fontWeight: 600,
                          background:
                            rec.status === "skipped"
                              ? "rgba(244, 125, 125, 0.2)"
                              : "rgba(118, 197, 178, 0.2)",
                          color: rec.status === "skipped" ? "#f47d7d" : "var(--mineral, #76c5b2)",
                        }}
                      >
                        {rec.status.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      {rec.status === "skipped" ? (
                        <span style={{ color: "#f47d7d" }}>{rec.reason}</span>
                      ) : rec.changes.length === 0 ? (
                        <span style={{ color: "var(--ink-muted, #777)" }}>No change</span>
                      ) : (
                        rec.changes.map((c) => (
                          <div key={c.channel} style={{ display: "flex", alignItems: "center", gap: "4px", margin: "1px 0" }}>
                            <span>{c.channel_name || `Ch ${c.channel + 1}`}:</span>
                            <span style={{ display: "inline-block", width: "9px", height: "9px", background: c.new_color, borderRadius: "2px" }} />
                            <span>{c.new_color}</span>
                          </div>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
