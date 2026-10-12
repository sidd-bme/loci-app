/** Optional guidance for the exact authored source binding; all actions remain normal tools. */
export function FirstStudyGuide() {
  return <details className="research-panel first-study-guide">
    <summary>Practice guide · synthetic shapes</summary>
    <p>Three authored rectangles, not cells. The 256 × 256 scalar image has authored 0.5 µm X/Y spacing.</p>
    <ol>
      <li><strong>Declare scope.</strong> In View → Image &amp; channels → Analysis region, set X/Y = 0, Width/Height = 256 and C = 0. Z/T are the single zero plane; use native level 0.</li>
      <li><strong>Run.</strong> In Analyze → Segment &amp; measure, choose Whole image, then Classical methods, Components, Threshold 50, Above threshold and Minimum object area 1. Use Channel 1 (native C=0) for raw measurement. Keep preprocessing empty; Run recipe.</li>
      <li><strong>Inspect.</strong> Expect 3 objects: 320, 768 and 512 pixels; areas 80, 192 and 128 µm². Mean scalar intensities are 100, 150 and 200. Select rows to inspect their labels.</li>
      <li><strong>Correct deliberately.</strong> In Annotate → Edit labels & ROIs, deleting label 1 creates a new revision with 2 objects. Undo revision restores the original; Redo revision returns to the correction.</li>
      <li><strong>Review and keep.</strong> In Results → Review &amp; export, inspect the selected revision, then Mark reviewed and Export revision. Save study… and reopen it from Recent work or Open study.</li>
    </ol>
    <p>Every correction needs its own human review. Source pixels stay unchanged. Save As preserves a source outside the discardable session. The offline user guide (F1) includes these instructions.</p>
  </details>;
}
