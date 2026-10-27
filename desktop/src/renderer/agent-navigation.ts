import type { ResearchAgentTargetReference, ResearchSelection, ResearchSnapshot } from "../shared/research-contracts";
import { fitCamera, imageExtent, sourceLevels, type Camera, type ViewportSize } from "./viewer-camera";

/** Resolve recorded identities again at activation, never from display labels. */
export function agentSourceTarget(snapshot: ResearchSnapshot, target: ResearchAgentTargetReference) {
  const sourceId = target.kind === "source" ? target.id : target.source_id;
  const sha = target.kind === "source" ? target.sha256 : target.source_sha256;
  const source = snapshot.sources.find((item) => item.id === sourceId);
  if (!source || !sha || source.sha256 !== sha || source.locator_state === "relink-required")
    throw new Error("The recorded agent source is unavailable or its fingerprint changed.");
  return source;
}

export function agentResultTarget(snapshot: ResearchSnapshot, target: ResearchAgentTargetReference) {
  if (target.kind !== "result") throw new Error("This activity does not identify a result.");
  const result = snapshot.results.find((item) => item.id === target.id);
  if (!result || result.revision_hash !== target.revision_hash || result.source_id !== target.source_id ||
      result.source_sha256 !== target.source_sha256)
    throw new Error("The recorded agent result is unavailable or its exact revision changed.");
  agentSourceTarget(snapshot, target);
  return result;
}

/** A reported region sets the display camera; it never becomes an analysis ROI. */
export function agentSourceView(snapshot: ResearchSnapshot, target: ResearchAgentTargetReference, size: ViewportSize): {
  selection: Pick<ResearchSelection, "t" | "c" | "z">; camera: Camera;
} | null {
  const source = agentSourceTarget(snapshot, target);
  if (!target.selection) return null;
  const selection = target.selection;
  const d = source.metadata.dimensions;
  const level = sourceLevels(source).find((item) => item.index === selection.level);
  if (!d || !level || ![selection.x, selection.y, selection.width, selection.height, selection.t,
    selection.c, selection.z, selection.level].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    selection.width < 1 || selection.height < 1 || selection.x + selection.width > level.dimensions.x ||
    selection.y + selection.height > level.dimensions.y || selection.t >= (d.t ?? 1) ||
    selection.c >= (d.c ?? 1) || selection.z >= (d.z ?? 1) ||
    (selection.z_stop !== undefined && (!Number.isSafeInteger(selection.z_stop) ||
      selection.z_stop <= selection.z || selection.z_stop > (d.z ?? 1))))
    throw new Error("The recorded agent selection is outside the verified source grid.");
  const extent = imageExtent(source);
  const width = selection.width * level.sx, height = selection.height * level.sy;
  const fitted = fitCamera({ ...extent, width, height }, size);
  return { selection: { t: selection.t, c: selection.c, z: selection.z }, camera: {
    x: selection.x * level.sx + width / 2, y: selection.y * level.sy + height / 2, scale: fitted.scale,
  } };
}

/** Events are consumed even while editing, so old activity never interrupts later. */
export class AgentSourceActivityTracker {
  private scope: string | null = null;
  private seen = new Set<string>();
  observe(snapshot: ResearchSnapshot | null, scope: string): ResearchAgentTargetReference | null {
    const events = snapshot?.agent_sessions?.events ?? [];
    if (scope !== this.scope) {
      this.scope = scope; this.seen = new Set(events.map((event) => event.id)); return null;
    }
    let newest: ResearchAgentTargetReference | null = null;
    for (const event of [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))) {
      if (this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      if (event.operation !== "source_image" || event.kind !== "operation_inspected") continue;
      const target = event.targets?.find((item) => item.kind === "source" && item.selection);
      if (target && snapshot) {
        try { agentSourceTarget(snapshot, target); newest = target; } catch { /* Historical stale target remains inspectable, never followed. */ }
      }
    }
    // Bound transient tracking to the same finite retained event history.
    this.seen = new Set(events.filter((event) => this.seen.has(event.id)).map((event) => event.id));
    return newest;
  }
}
