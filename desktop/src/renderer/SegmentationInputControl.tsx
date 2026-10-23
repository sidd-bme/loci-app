import type { ResearchSelection } from "../shared/research-contracts";

export function SegmentationInputControl({ channelCount, channelNames, selection, disabled, onChange }: {
  channelCount: number; channelNames?: string[]; selection: ResearchSelection; disabled: boolean;
  onChange: (channel: number) => void;
}) {
  return <div className="research-segmentation-input">
    <label>Segmentation input<select aria-label="Segmentation input" disabled={disabled} value={selection.c}
      onChange={(event) => {
        if (disabled) return;
        const value = event.target.value;
        const channel = /^\d+$/.test(value) ? Number(value) : NaN;
        if (Number.isSafeInteger(channel) && channel >= 0 && channel < channelCount) onChange(channel);
      }}>
      {Array.from({ length: channelCount }, (_, index) => <option key={index} value={index}>
        {index + 1}: {channelNames?.[index]?.trim() || `Channel ${index + 1}`}
      </option>)}
    </select></label>
    <small>Raw source channel · T {selection.t + 1} · {selection.z_stop === undefined
      ? `Z ${selection.z + 1}` : `Z ${selection.z + 1}–${selection.z_stop}`}</small>
  </div>;
}
