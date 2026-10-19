/** A single vector path keeps complete group selection bounded at 100,000 objects. */
export function GroupCentroidOverlay({ points, width, height }: { points: Array<{ u: number; v: number }>; width: number; height: number }) {
  if (!points.length || width <= 0 || height <= 0) return null;
  return <svg viewBox={`-0.5 -0.5 ${width} ${height}`} aria-label={`${points.length} highlighted group object centroids`} data-group-highlight-count={points.length} className="group-centroid-overlay" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
    <path d={points.map(({ u, v }) => `M${u - 3} ${v}h6M${u} ${v - 3}v6`).join("")} fill="none" stroke="#ffd36a" strokeWidth="2" vectorEffect="non-scaling-stroke" />
  </svg>;
}
