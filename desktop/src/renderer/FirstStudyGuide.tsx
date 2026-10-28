export type FirstStudyTab = "Display" | "Analyze" | "Population" | "Info";
/** Guidance for the exact authored source binding. Navigation never runs or configures analysis. */
export function FirstStudyGuide({ onNavigate, hasResult }: { onNavigate: (tab: FirstStudyTab) => void; hasResult: boolean }) {
  return <details className="research-panel first-study-guide" open>
    <summary>Practice: inspect, measure and export</summary>
    <p>Three authored rectangles, not cells. The 256 × 256 scalar image has authored 0.5 µm X/Y spacing.</p>
    <ol>
      <li><button type="button" onClick={() => onNavigate("Display")}>Inspect image</button> Check the full 256 × 256 image, Channel 1, Z 1 and T 1 at native level 0.</li>
      <li><button type="button" onClick={() => onNavigate("Analyze")}>Segment &amp; measure</button> Choose Whole image, Classical methods, Components, Threshold 50, Above threshold and Minimum object area 1. Measure Channel 1. Keep preprocessing empty, then Run recipe.</li>
      <li><button type="button" disabled={!hasResult} onClick={() => onNavigate("Population")}>Inspect objects</button> Select rows to inspect their labels.{!hasResult && " Run the recipe first."}</li>
      <li><button type="button" disabled={!hasResult} onClick={() => onNavigate("Info")}>Review &amp; export</button> Inspect the selected revision, then Mark reviewed and Export result. Save study… to reopen it later.{!hasResult && " A result is required."}</li>
    </ol>
    <details><summary>Expected example results</summary>
      <p>With the settings above, expect 3 objects: 320, 768 and 512 pixels; areas 80, 192 and 128 µm². Mean scalar intensities are 100, 150 and 200.</p>
      <p>In Annotate → Edit labels &amp; ROIs, deleting label 1 creates a new revision with 2 objects. Undo revision restores the original; Redo revision returns to the correction.</p>
    </details>
    <p>Every correction needs its own human review. Source pixels stay unchanged. Save As preserves a source outside the discardable session. The offline user guide (F1) includes these instructions.</p>
  </details>;
}
