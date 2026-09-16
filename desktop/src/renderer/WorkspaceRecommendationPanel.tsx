import { ChevronDown, Layers3, Microscope, ScanLine } from "lucide-react";

import type {
  WorkspaceKind,
  WorkspaceRecommendation,
} from "../shared/foundation-contracts";

const workspaceCopy: Record<WorkspaceKind, {
  label: string;
  description: string;
  icon: typeof ScanLine;
}> = {
  "generic-2d": {
    label: "Generic 2D",
    description: "Safe display workspace; choose a biological task explicitly before analysis.",
    icon: ScanLine,
  },
  "pathology-2d": {
    label: "Pathology",
    description: "Large 2D display workspace selected from declared pyramid structure.",
    icon: Microscope,
  },
  "scientific-volume": {
    label: "Scientific volume",
    description: "Multichannel or volume workspace selected from declared C/Z/T structure.",
    icon: Layers3,
  },
};

interface WorkspaceRecommendationPanelProps {
  recommendation: WorkspaceRecommendation | null;
  disabled: boolean;
  onOverride: (workspace: WorkspaceKind) => void;
}

export default function WorkspaceRecommendationPanel({
  recommendation,
  disabled,
  onOverride,
}: WorkspaceRecommendationPanelProps): React.JSX.Element | null {
  if (!recommendation) return null;
  const copy = workspaceCopy[recommendation.workspace];
  const Icon = copy.icon;
  const provenance = recommendation.decision === "user-override"
    ? "Chosen for this source"
    : recommendation.decision === "structural"
      ? "Selected from image structure"
      : "Safe default";

  return (
    <section className="workspace-recommendation" aria-label="Adaptive workspace">
      <div className="workspace-recommendation-icon" aria-hidden="true">
        <Icon size={14} />
      </div>
      <div className="workspace-recommendation-copy">
        <span>{provenance}</span>
        <strong>{copy.label}</strong>
        <small>{copy.description}</small>
      </div>
      <label className="workspace-open-as">
        <span className="sr-only">Open source as</span>
        <select
          value={recommendation.workspace}
          disabled={disabled}
          aria-label="Open source as"
          onChange={(event) => onOverride(event.currentTarget.value as WorkspaceKind)}
        >
          <option value="generic-2d">Generic 2D</option>
          <option value="pathology-2d">Pathology</option>
          <option value="scientific-volume">Scientific volume</option>
        </select>
        <ChevronDown size={12} aria-hidden="true" />
      </label>
    </section>
  );
}
