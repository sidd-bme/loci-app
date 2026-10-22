import { useId, useRef, type ReactNode } from "react";
import { Columns2, Image } from "lucide-react";

export type StudySection = "samples" | "intensity" | "batch" | "corrections";
const labels: Record<StudySection, string> = {
  samples: "Samples", intensity: "Intensity", batch: "Batch", corrections: "Corrections",
};

/** Hidden panels stay mounted: switching study tasks must not discard drafts. */
export function StudyWorkspace({ active, section, onSection, focused, onToggleFocus, sourceName,
  samples, intensity, batch, corrections }: {
  active: boolean;
  section: StudySection;
  onSection: (section: StudySection) => void;
  focused: boolean;
  onToggleFocus: () => void;
  sourceName?: string;
  samples: ReactNode;
  intensity: ReactNode;
  batch: ReactNode;
  corrections?: ReactNode;
}) {
  const id = useId();
  const buttons = useRef<Partial<Record<StudySection, HTMLButtonElement | null>>>({});
  const sections: StudySection[] = corrections ? ["samples", "intensity", "batch", "corrections"] : ["samples", "intensity", "batch"];
  const selected = sections.includes(section) ? section : "samples";
  const panels = { samples, intensity, batch, corrections };
  return <section className="study-workspace-host" hidden={!active} aria-label="Study workspace">
    <div className="study-workspace-toolbar">
      <span className="study-linked-source" title={sourceName ?? "No image selected"}>
        <Image aria-hidden="true" /><span>Linked image: <strong>{sourceName ?? "No image selected"}</strong></span>
      </span>
      <button type="button" aria-pressed={focused} onClick={onToggleFocus}>
        <Columns2 aria-hidden="true" />{focused ? "Show image" : "Focus study"}
      </button>
    </div>
    <div className="study-section-tabs" role="tablist" aria-label="Study sections">
      {sections.map((name, index) => <button key={name} ref={(node) => { buttons.current[name] = node; }}
        type="button" role="tab" id={`${id}-tab-${name}`} aria-controls={`${id}-panel-${name}`}
        aria-selected={selected === name} tabIndex={selected === name ? 0 : -1}
        onClick={() => onSection(name)} onKeyDown={(event) => {
          const next = event.key === "ArrowRight" ? sections[(index + 1) % sections.length] :
            event.key === "ArrowLeft" ? sections[(index + sections.length - 1) % sections.length] :
            event.key === "Home" ? sections[0] : event.key === "End" ? sections.at(-1) : null;
          if (!next) return;
          event.preventDefault(); onSection(next); buttons.current[next]?.focus();
        }}>{labels[name]}</button>)}
    </div>
    <div className="study-workspace-body">
      {sections.map((name) => <div key={name} id={`${id}-panel-${name}`} role="tabpanel"
        aria-labelledby={`${id}-tab-${name}`} tabIndex={0} hidden={selected !== name}>
        {panels[name]}
      </div>)}
    </div>
  </section>;
}
