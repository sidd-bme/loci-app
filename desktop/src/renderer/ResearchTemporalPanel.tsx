import { useMemo, useState } from "react";
import type {
  ResearchDesktopApi,
  ResearchResult,
  ResearchSnapshot,
} from "../shared/research-contracts";

type Report = <T>(
  work: () => Promise<T>,
  fallback: string,
) => Promise<T | undefined>;

type DraftFrame =
  | { key: string; kind: "observed"; resultId: string; time: string }
  | {
      key: string;
      kind: "missing";
      frameId: string;
      time: string;
      reason: string;
    };

type Detection = {
  label: string;
  centroid_world_xyz: number[];
  measure: number;
};
type TrackFrame = { frame_id: string; time_s: number; detections: Detection[] };
type TrackEdge = {
  source_frame_id: string;
  source_label: string;
  target_frame_id: string;
  target_label: string;
  cost: number;
  gap: number;
  identity_uncertain: boolean;
  provenance: "automatic" | "manual";
};
type TrackHypothesis = {
  kind: string;
  frame_id: string;
  label: string;
  candidate_frame_id: string;
  candidate_labels: string[];
  reason: string;
};
type TrajectoryPoint = {
  frame_id: string;
  label: string;
  time_s: number;
  centroid_world_xyz: number[];
  measure: number;
  speed: number | null;
  displacement: number;
  path_length: number;
  gap_before: number | null;
};
export type TrackingGraph = {
  frames: TrackFrame[];
  edges: TrackEdge[];
  hypotheses: TrackHypothesis[];
  trajectories: TrajectoryPoint[][];
};
type TrackingRecord = {
  result: ResearchResult;
  tracking: TrackingGraph;
  inputs?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
  units?: { position?: string; time?: string; speed?: string };
};

const WORKING_BYTES = 512 * 1024 ** 2;

function finite(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function verifiedElapsedTime(
  result: ResearchResult,
  snapshot: ResearchSnapshot,
): number | null {
  const direct = result.selection?.elapsed_time_s;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const t = result.selection?.t;
  const timing = snapshot.sources.find((item) => item.id === result.source_id)
    ?.metadata.timing;
  if (!Number.isSafeInteger(t) || t! < 0 || timing?.interval_unit !== "s") return null;
  const value = timing.elapsed_times?.[t!];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Only the explicit OME cadence route declares a uniform acquisition grid.
  // Never fill a missing per-plane time from another source's average interval.
  const interval = timing.uniform_interval;
  if (timing.source !== "ome-time-increment" || typeof interval !== "number" ||
    !Number.isFinite(interval) || interval <= 0) return null;
  const elapsed = t! * interval;
  return Number.isFinite(elapsed) ? elapsed : null;
}

function validResult(value: unknown, parent?: ResearchResult): ResearchResult {
  if (!value || typeof value !== "object")
    throw new Error("Temporal processing returned no immutable result.");
  const result = value as ResearchResult;
  if (
    typeof result.id !== "string" ||
    typeof result.revision_hash !== "string" ||
    typeof result.source_id !== "string" ||
    (parent && (result.id === parent.id || result.parent_id !== parent.id))
  )
    throw new Error("Temporal processing returned an invalid result revision.");
  return result;
}

function validTracking(value: unknown): TrackingGraph {
  if (!value || typeof value !== "object")
    throw new Error("The engine returned no temporal observation graph.");
  const graph = value as Partial<TrackingGraph>;
  if (
    !Array.isArray(graph.frames) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.hypotheses) ||
    !Array.isArray(graph.trajectories)
  )
    throw new Error("The temporal observation graph is incomplete.");
  return graph as TrackingGraph;
}

function frameName(frameId: string, snapshot: ResearchSnapshot): string {
  const result = snapshot.results.find((item) => item.id === frameId);
  if (!result) return frameId;
  const source = snapshot.sources.find((item) => item.id === result.source_id);
  return `${source?.name ?? "Source"} · ${result.kind} · ${result.id.slice(0, 8)}…`;
}

function acquisitionKey(result: ResearchResult): string {
  const selection = result.selection;
  if (!selection) return result.id;
  return JSON.stringify([
    result.source_id,
    selection.t,
    selection.z,
    selection.x,
    selection.y,
    selection.width,
    selection.height,
    selection.level,
  ]);
}

export function ResearchTemporalPanel({
  api,
  snapshot,
  report,
  busy,
  onBusyChange,
  onOpenResult,
  onPublished,
}: {
  api: ResearchDesktopApi;
  snapshot: ResearchSnapshot;
  report: Report;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onOpenResult: (result: ResearchResult) => Promise<void>;
  onPublished: (result: ResearchResult) => Promise<void>;
}): React.JSX.Element {
  const candidates = snapshot.results.filter(
    (result) =>
      result.kind !== "temporal-tracking" &&
      Boolean(result.arrays?.image && result.arrays?.labels),
  );
  const trackingResults = snapshot.results.filter(
    (result) => result.kind === "temporal-tracking",
  );
  const [frames, setFrames] = useState<DraftFrame[]>([]);
  const [declaration, setDeclaration] = useState(
    "Elapsed times are actual seconds; manual entries replace unavailable verified metadata.",
  );
  const [secondsConfirmed, setSecondsConfirmed] = useState(false);
  const [maxDistance, setMaxDistance] = useState("10");
  const [maxGap, setMaxGap] = useState("0");
  const [ambiguityDistance, setAmbiguityDistance] = useState("0.000000001");
  const [registration, setRegistration] = useState<"none" | "translation">("none");
  const [upsample, setUpsample] = useState("20");
  const [minimumCorrelation, setMinimumCorrelation] = useState("0.25");
  const [record, setRecord] = useState<TrackingRecord | null>(null);
  const [inspectId, setInspectId] = useState(trackingResults[0]?.id ?? "");
  const [removeEdge, setRemoveEdge] = useState("");
  const [sourceNode, setSourceNode] = useState("");
  const [targetNode, setTargetNode] = useState("");
  const [uncertain, setUncertain] = useState(true);
  const [editMode, setEditMode] = useState<"remove" | "add">("remove");

  const nodes = useMemo(
    () =>
      record?.tracking.frames.flatMap((frame, frameIndex) =>
        frame.detections.map((detection) => ({
          value: JSON.stringify([frame.frame_id, detection.label]),
          frameId: frame.frame_id,
          frameIndex,
          label: detection.label,
          text: `${frameName(frame.frame_id, snapshot)} · object ${detection.label}`,
        })),
      ) ?? [],
    [record, snapshot],
  );
  const source = nodes.find((node) => node.value === sourceNode);
  const target = nodes.find((node) => node.value === targetNode);
  const addValid = Boolean(source && target && source.frameIndex < target.frameIndex);
  const parsedTimes = frames.map((frame) => finite(frame.time));
  const observedCount = frames.filter((frame) => frame.kind === "observed").length;
  const missingComplete = frames.every(
    (frame) =>
      frame.kind === "observed" || Boolean(frame.frameId.trim() && frame.reason.trim()),
  );
  const timesValid =
    parsedTimes.every((time) => time !== null) &&
    parsedTimes.every((time, index) => index === 0 || time! > parsedTimes[index - 1]!);
  const settingsValid =
    finite(maxDistance) !== null &&
    finite(maxDistance)! >= 0 &&
    Number.isSafeInteger(Number(maxGap)) &&
    Number(maxGap) >= 0 &&
    Number(maxGap) <= 1000 &&
    finite(ambiguityDistance) !== null &&
    finite(ambiguityDistance)! >= 0 &&
    (registration === "none" ||
      (Number.isSafeInteger(Number(upsample)) &&
        Number(upsample) >= 1 &&
        Number(upsample) <= 200 &&
        finite(minimumCorrelation) !== null &&
        finite(minimumCorrelation)! >= -1 &&
        finite(minimumCorrelation)! <= 1));
  const canTrack =
    !busy &&
    observedCount >= 2 &&
    frames.length >= 2 &&
    timesValid &&
    missingComplete &&
    secondsConfirmed &&
    Boolean(declaration.trim()) &&
    settingsValid;

  const addObserved = (result: ResearchResult) => {
    if (frames.some((frame) => frame.kind === "observed" && frame.resultId === result.id))
      return;
    const known = verifiedElapsedTime(result, snapshot);
    setFrames((old) => {
      const replacement = old.findIndex((frame) => {
        if (frame.kind !== "observed") return false;
        const prior = snapshot.results.find((item) => item.id === frame.resultId);
        return prior ? acquisitionKey(prior) === acquisitionKey(result) : false;
      });
      const next: DraftFrame = {
        key: `observed-${result.id}`,
        kind: "observed",
        resultId: result.id,
        time:
          known === null
            ? replacement >= 0
              ? old[replacement].time
              : ""
            : String(known),
      };
      if (replacement < 0) return [...old, next];
      return old.map((frame, index) => (index === replacement ? next : frame));
    });
  };
  const move = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= frames.length) return;
    const next = [...frames];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setFrames(next);
  };
  const patchFrame = (key: string, patch: Partial<DraftFrame>) =>
    setFrames((old) =>
      old.map((frame) =>
        frame.key === key ? ({ ...frame, ...patch } as DraftFrame) : frame,
      ),
    );

  const track = async () => {
    if (!canTrack) return;
    onBusyChange(true);
    try {
      const output = await report(async () => {
        const value = (await api.execute("track_results", {
          frames: frames.map((frame, index) => {
            const time_s = parsedTimes[index]!;
            if (frame.kind === "missing")
              return {
                frame_id: frame.frameId.trim(),
                time_s,
                missing_reason: frame.reason.trim(),
              };
            const result = snapshot.results.find((item) => item.id === frame.resultId)!;
            return {
              result_id: result.id,
              revision_hash: result.revision_hash,
              time_s,
            };
          }),
          time_declaration: declaration.trim(),
          max_distance: finite(maxDistance),
          max_gap_frames: Number(maxGap),
          ambiguity_distance: finite(ambiguityDistance),
          registration:
            registration === "none"
              ? { method: "none" }
              : {
                  method: "translation",
                  upsample_factor: Number(upsample),
                  min_normalized_correlation: finite(minimumCorrelation),
                },
          working_bytes: WORKING_BYTES,
        })) as Partial<TrackingRecord>;
        return {
          ...value,
          result: validResult(value.result),
          tracking: validTracking(value.tracking),
        } as TrackingRecord;
      }, "Could not create an exact temporal observation graph.");
      if (output) {
        setRecord(output);
        setInspectId(output.result.id);
        await onPublished(output.result);
      }
    } finally {
      onBusyChange(false);
    }
  };

  const inspect = async () => {
    const result = snapshot.results.find((item) => item.id === inspectId);
    if (!result || busy) return;
    onBusyChange(true);
    try {
      const output = await report(async () => {
        const value = (await api.execute("tracking_result", {
          result_id: result.id,
          revision_hash: result.revision_hash,
        })) as Partial<TrackingRecord>;
        if (value.result?.id !== result.id || value.result.revision_hash !== result.revision_hash)
          throw new Error("Tracking inspection did not match the exact selected revision.");
        return { ...value, result, tracking: validTracking(value.tracking) } as TrackingRecord;
      }, "Could not inspect the exact tracking result.");
      if (output) setRecord(output);
    } finally {
      onBusyChange(false);
    }
  };

  const correct = async () => {
    if (!record || busy) return;
    let change: Record<string, unknown> | null = null;
    if (editMode === "remove") {
      const edge = record.tracking.edges[Number(removeEdge)];
      if (edge)
        change = {
          op: "remove",
          source_frame_id: edge.source_frame_id,
          source_label: edge.source_label,
          target_frame_id: edge.target_frame_id,
          target_label: edge.target_label,
        };
    } else if (source && target && addValid) {
      change = {
        op: "add",
        source_frame_id: source.frameId,
        source_label: source.label,
        target_frame_id: target.frameId,
        target_label: target.label,
        identity_uncertain: uncertain,
      };
    }
    if (!change) return;
    onBusyChange(true);
    try {
      const parent = record.result;
      const output = await report(async () => {
        const value = (await api.execute("correct_tracks", {
          result_id: parent.id,
          revision_hash: parent.revision_hash,
          changes: [change],
        })) as Partial<TrackingRecord>;
        return {
          ...value,
          result: validResult(value.result, parent),
          tracking: validTracking(value.tracking),
        } as TrackingRecord;
      }, "Could not publish this exact association correction.");
      if (output) {
        setRecord(output);
        setInspectId(output.result.id);
        setRemoveEdge("");
        await onPublished(output.result);
      }
    } finally {
      onBusyChange(false);
    }
  };

  return (
    <div className="research-panel research-temporal">
      <h2>Temporal observation graph</h2>
      <p>
        Choose exact label-result revisions in acquisition order. Times are actual seconds;
        absent observations must be explicit records. Associations describe observations,
        not biological lineage or identity.
      </p>
      <h3>Available exact frames</h3>
      <div className="research-compact-list">
        {candidates.map((result) => (
          <div key={result.id}>
            <button disabled={busy} onClick={() => void onOpenResult(result)}>
              Open
            </button>
            <span>{frameName(result.id, snapshot)}</span>
            <button
              disabled={
                busy ||
                frames.some(
                  (frame) => frame.kind === "observed" && frame.resultId === result.id,
                )
              }
              onClick={() => addObserved(result)}
            >
              Add frame
            </button>
          </div>
        ))}
      </div>
      <button
        disabled={busy}
        onClick={() =>
          setFrames((old) => [
            ...old,
            {
              key: `missing-${Date.now()}-${old.length}`,
              kind: "missing",
              frameId: `missing-${old.length + 1}`,
              time: "",
              reason: "",
            },
          ])
        }
      >
        Add missing observation
      </button>
      <ol className="research-frame-list">
        {frames.map((frame, index) => {
          const result =
            frame.kind === "observed"
              ? snapshot.results.find((item) => item.id === frame.resultId)
              : null;
          const known = result ? verifiedElapsedTime(result, snapshot) : null;
          return (
            <li key={frame.key}>
              <strong>
                {frame.kind === "observed"
                  ? frameName(frame.resultId, snapshot)
                  : "Missing observation"}
              </strong>
              <div className="research-actions">
                <button disabled={busy || index === 0} onClick={() => move(index, -1)}>
                  Earlier
                </button>
                <button
                  disabled={busy || index === frames.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Later
                </button>
                <button
                  disabled={busy}
                  onClick={() => setFrames((old) => old.filter((item) => item.key !== frame.key))}
                >
                  Remove
                </button>
              </div>
              {frame.kind === "missing" && (
                <>
                  <label>
                    Missing frame ID
                    <input
                      aria-label={`Missing frame ID ${index + 1}`}
                      value={frame.frameId}
                      onChange={(event) => patchFrame(frame.key, { frameId: event.target.value })}
                    />
                  </label>
                  <label>
                    Missing reason
                    <input
                      aria-label={`Missing frame reason ${index + 1}`}
                      value={frame.reason}
                      onChange={(event) => patchFrame(frame.key, { reason: event.target.value })}
                    />
                  </label>
                </>
              )}
              <label>
                Elapsed time (s)
                <input
                  aria-label={`Frame ${index + 1} elapsed seconds`}
                  type="number"
                  step="any"
                  value={frame.time}
                  onChange={(event) => patchFrame(frame.key, { time: event.target.value })}
                />
              </label>
              {known !== null && <small>Prefilled from verified metadata: {known} s</small>}
            </li>
          );
        })}
      </ol>
      {frames.length > 0 && !timesValid && (
        <p role="alert">Every frame needs a finite time, strictly increasing in this order.</p>
      )}
      {!missingComplete && (
        <p role="alert">Every missing observation needs a unique ID and explicit reason.</p>
      )}
      <label>
        Time calibration declaration
        <textarea
          aria-label="Time calibration declaration"
          value={declaration}
          onChange={(event) => setDeclaration(event.target.value)}
        />
      </label>
      <label className="research-check">
        <input
          type="checkbox"
          aria-label="Confirm actual elapsed seconds"
          checked={secondsConfirmed}
          onChange={(event) => setSecondsConfirmed(event.target.checked)}
        />
        I confirm each time_s value is an actual elapsed time in seconds.
      </label>
      <div className="research-grid">
        <label>
          Maximum physical distance
          <input
            aria-label="Tracking maximum physical distance"
            type="number"
            min="0"
            step="any"
            value={maxDistance}
            onChange={(event) => setMaxDistance(event.target.value)}
          />
        </label>
        <label>
          Maximum missing-frame gap
          <input
            aria-label="Tracking maximum gap frames"
            type="number"
            min="0"
            max="1000"
            step="1"
            value={maxGap}
            onChange={(event) => setMaxGap(event.target.value)}
          />
        </label>
        <label>
          Ambiguity distance
          <input
            aria-label="Tracking ambiguity distance"
            type="number"
            min="0"
            step="any"
            value={ambiguityDistance}
            onChange={(event) => setAmbiguityDistance(event.target.value)}
          />
        </label>
        <label>
          Drift adjustment
          <select
            aria-label="Tracking drift adjustment"
            value={registration}
            onChange={(event) => setRegistration(event.target.value as "none" | "translation")}
          >
            <option value="none">None</option>
            <option value="translation">Phase-correlation translation</option>
          </select>
        </label>
        {registration === "translation" && (
          <>
            <label>
              Translation upsample factor
              <input
                aria-label="Tracking translation upsample factor"
                type="number"
                min="1"
                max="200"
                value={upsample}
                onChange={(event) => setUpsample(event.target.value)}
              />
            </label>
            <label>
              Minimum normalized correlation
              <input
                aria-label="Tracking minimum normalized correlation"
                type="number"
                min="-1"
                max="1"
                step="any"
                value={minimumCorrelation}
                onChange={(event) => setMinimumCorrelation(event.target.value)}
              />
            </label>
          </>
        )}
      </div>
      <button className="research-primary" disabled={!canTrack} onClick={() => void track()}>
        Create temporal graph
      </button>

      <h3>Inspect exact temporal revision</h3>
      <div className="research-actions">
        <select
          aria-label="Tracking result revision"
          value={inspectId}
          onChange={(event) => setInspectId(event.target.value)}
        >
          <option value="">Choose result…</option>
          {trackingResults.map((result) => (
            <option key={result.id} value={result.id}>
              {result.id.slice(0, 8)}… · {result.object_count} measurements
            </option>
          ))}
        </select>
        <button disabled={busy || !inspectId} onClick={() => void inspect()}>
          Inspect graph
        </button>
      </div>
      {record && (
        <>
          <p>
            Exact revision {record.result.id.slice(0, 8)}… · positions in{" "}
            {record.units?.position ?? "declared physical units"}; time in seconds.
          </p>
          <h3>Observed associations</h3>
          <table className="research-result-table">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Distance</th>
                <th>Gap</th>
                <th>Uncertain</th>
              </tr>
            </thead>
            <tbody>
              {record.tracking.edges.map((edge, index) => (
                <tr key={`${edge.source_frame_id}-${edge.source_label}-${index}`}>
                  <td>{frameName(edge.source_frame_id, snapshot)} / {edge.source_label}</td>
                  <td>{frameName(edge.target_frame_id, snapshot)} / {edge.target_label}</td>
                  <td>{edge.cost}</td>
                  <td>{edge.gap}</td>
                  <td>{edge.identity_uncertain ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Unresolved automatic hypotheses</h3>
          {record.tracking.hypotheses.length ? (
            <ul>
              {record.tracking.hypotheses.map((hypothesis, index) => (
                <li key={`${hypothesis.kind}-${index}`}>
                  <strong>{hypothesis.kind}</strong>: {hypothesis.frame_id.slice(0, 8)}:
                  {hypothesis.label} → {hypothesis.candidate_frame_id.slice(0, 8)} candidates{" "}
                  {hypothesis.candidate_labels.join(", ")} ({hypothesis.reason}). This remains an unresolved
                  automatic hypothesis until an explicit edge edit is published.
                </li>
              ))}
            </ul>
          ) : (
            <p>No automatic ambiguity hypotheses were recorded.</p>
          )}
          <h3>Trajectories</h3>
          <table className="research-result-table">
            <thead>
              <tr>
                <th>Track</th>
                <th>Frame</th>
                <th>Object</th>
                <th>Time (s)</th>
                <th>XYZ</th>
                <th>Speed</th>
              </tr>
            </thead>
            <tbody>
              {record.tracking.trajectories.flatMap((trajectory, trackIndex) =>
                trajectory.map((point, pointIndex) => (
                  <tr key={`${trackIndex}-${pointIndex}-${point.frame_id}-${point.label}`}>
                    <td>{trackIndex + 1}</td>
                    <td>{frameName(point.frame_id, snapshot)}</td>
                    <td>{point.label}</td>
                    <td>{point.time_s}</td>
                    <td>{point.centroid_world_xyz.join(", ")}</td>
                    <td>{point.speed ?? "—"}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <h3>Publish one exact association edit</h3>
          <label>
            Edit
            <select
              aria-label="Track edit operation"
              value={editMode}
              onChange={(event) => setEditMode(event.target.value as "remove" | "add")}
            >
              <option value="remove">Remove an existing edge</option>
              <option value="add">Add an observed association</option>
            </select>
          </label>
          {editMode === "remove" ? (
            <label>
              Existing association
              <select
                aria-label="Association to remove"
                value={removeEdge}
                onChange={(event) => setRemoveEdge(event.target.value)}
              >
                <option value="">Choose edge…</option>
                {record.tracking.edges.map((edge, index) => (
                  <option key={index} value={index}>
                    {edge.source_frame_id.slice(0, 8)}:{edge.source_label} →{" "}
                    {edge.target_frame_id.slice(0, 8)}:{edge.target_label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                Source observation
                <select
                  aria-label="Association source observation"
                  value={sourceNode}
                  onChange={(event) => setSourceNode(event.target.value)}
                >
                  <option value="">Choose source…</option>
                  {nodes.map((node) => (
                    <option key={`source-${node.value}`} value={node.value}>{node.text}</option>
                  ))}
                </select>
              </label>
              <label>
                Later target observation
                <select
                  aria-label="Association target observation"
                  value={targetNode}
                  onChange={(event) => setTargetNode(event.target.value)}
                >
                  <option value="">Choose target…</option>
                  {nodes.map((node) => (
                    <option key={`target-${node.value}`} value={node.value}>{node.text}</option>
                  ))}
                </select>
              </label>
              <label className="research-check">
                <input
                  type="checkbox"
                  aria-label="Manual association identity uncertain"
                  checked={uncertain}
                  onChange={(event) => setUncertain(event.target.checked)}
                />
                This manual identity association is uncertain.
              </label>
            </>
          )}
          <button
            disabled={
              busy || (editMode === "remove" ? removeEdge === "" : !addValid)
            }
            onClick={() => void correct()}
          >
            Publish corrected graph revision
          </button>
        </>
      )}
    </div>
  );
}
