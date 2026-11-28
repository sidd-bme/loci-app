import { useEffect, useState } from "react";
import { CELLPOSE_SAM_V2_SHA256 } from "../shared/model-registry";
import type { ResearchSource } from "../shared/research-contracts";
import { sourceChannelLabel } from "./research-scope-labels";

type Availability = "checking" | "ready" | "unavailable";

export function useInstalledAgentCellpose(check: boolean): Availability {
  const [availability, setAvailability] = useState<Availability>("checking");
  const native = window.loci;
  useEffect(() => {
    setAvailability("checking");
    if (!check) return;
    if (!native?.getCellposeStatus) {
      setAvailability("unavailable");
      return;
    }
    let active = true;
    void native.getCellposeStatus("cellpose-sam-v2").then(status => {
      if (!active) return;
      const ready = status.profileId === "cellpose-sam-v2" && status.ready && status.package.exact &&
        status.model.artifactId === "cpsam_v2" && status.model.present && status.model.verified &&
        status.model.expectedSha256 === CELLPOSE_SAM_V2_SHA256;
      setAvailability(ready ? "ready" : "unavailable");
    }).catch(() => { if (active) setAvailability("unavailable"); });
    return () => { active = false; };
  }, [check, native]);
  return check ? availability : "checking";
}

export function AgentCellposeGrant({ source, availability, selected, channels, unavailableReason, onSelect, onChannels, onChooseModel }: {
  source: ResearchSource;
  availability: Availability;
  selected: boolean;
  channels: number[];
  unavailableReason: string | null;
  onSelect: (enabled: boolean) => void;
  onChannels: (channels: number[]) => void;
  onChooseModel?: () => void;
}): React.JSX.Element | null {
  if (availability === "checking") return <small role="status">Checking Cellpose installation…</small>;
  if (availability === "unavailable") return onChooseModel
    ? <button type="button" onClick={onChooseModel}>Set up Cellpose in Model Zoo</button> : null;
  return <>
    <label className="research-check"><input type="checkbox" checked={selected}
      onChange={event => onSelect(event.target.checked)} />Use installed Cellpose-SAM v2</label>
    {selected && (unavailableReason ? <p role="alert">{unavailableReason}</p> : <details>
      <summary>Measure raw channels ({channels.length})</summary>
      {Array.from({ length: source.metadata.dimensions?.c ?? 1 }, (_, channel) =>
        <label key={channel} className="research-check"><input type="checkbox"
          aria-label={`Grant Cellpose measurement channel ${channel + 1}`} checked={channels.includes(channel)}
          disabled={!channels.includes(channel) && channels.length >= 32}
          onChange={event => onChannels(event.target.checked
            ? [...channels, channel].sort((a, b) => a - b) : channels.filter(item => item !== channel))} />
          {sourceChannelLabel(source, channel)}</label>)}
    </details>)}
  </>;
}
