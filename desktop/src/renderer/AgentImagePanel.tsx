import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { checkedVisionReceipt, checkedVisionRequest } from "../shared/vision-handoff";
import type { ViewerChannel } from "./ImageViewport";

export function AgentImagePanel({ api, source, selection, channels, projection, following, followBusy,
  onFollowing, onError }: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection; channels: ViewerChannel[];
  projection: "plane" | "max" | "mean"; following: boolean; followBusy: boolean;
  onFollowing: (active: boolean) => void; onError: (error: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState("");
  const generation = useRef(0);
  useEffect(() => { generation.current++; setReceipt(""); setBusy(false); return () => { generation.current++; }; }, [source.id, source.sha256]);
  const tooLarge = selection.width > 2048 || selection.height > 2048;
  const exportImage = async () => {
    if (!api.exportVisionHandoff || busy || tooLarge) return;
    const token = generation.current;
    setBusy(true); setReceipt("");
    try {
      const { z_stop, ...plane } = selection;
      const request = checkedVisionRequest({ source_id: source.id,
        selection: projection === "plane" ? plane : { ...plane, z_stop },
        channels: channels.filter((c) => c.visible).map((c) => ({ ...c, opacity: c.opacity ?? 1 })),
        projection, max_size: 1536 });
      const output = await api.exportVisionHandoff(request, source.sha256);
      if (output && generation.current === token) {
        const result = checkedVisionReceipt(output, source.id, source.sha256);
        setReceipt(`Saved ${result.basename}. Upload image.png and context.json to your chosen assistant.`);
      }
    } catch (error) { if (generation.current === token) onError(error instanceof Error ? error.message : "Could not export the vision handoff."); }
    finally { if (generation.current === token) setBusy(false); }
  };
  return <section className="research-panel source-agent-controls" aria-label="Vision assistant tools">
    <h3>Vision assistant</h3>
    <button disabled={busy || tooLarge || !api.exportVisionHandoff || !channels.some((c) => c.visible)} onClick={() => void exportImage()}>
      {busy ? "Exporting image and context…" : "Export vision handoff"}
    </button>
    {tooLarge && <p role="status">Choose an analysis region no larger than 2048 × 2048 pixels, or a suitable pyramid level, before exporting.</p>}
    {receipt && <p role="status">{receipt}</p>}
    <label className="research-check"><input type="checkbox" checked={following} disabled={followBusy}
      onChange={(event) => onFollowing(event.target.checked)} /> Follow assistant display</label>
    {following && <p role="status">Following saved channel settings. Turn this off to edit display locally.</p>}
    <details><summary>Image scope and connection</summary>
      <p>Export the analysis region with its current colors and contrast, up to 1536 pixels. The bundle records the source, crop, projection and display settings.</p>
      <p>Upload image.png and context.json in ChatGPT or another vision client. You choose whether to upload these local files. Visual suggestions remain provisional.</p>
      <p>Grant display access in Connect an assistant, then follow its channel colors, ranges and visibility here.</p>
    </details>
  </section>;
}
