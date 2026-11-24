import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, PanelLeft } from "lucide-react";
import {
  sameStudyNavigatorTarget,
  sourceMetadataDimensions,
  sourceSampleLayout,
  type StudyNavigatorAction,
  type StudyNavigatorApi,
  type StudyNavigatorSource,
  type StudyNavigatorState,
} from "../shared/study-navigator-api";
import { sourceDisplayPath } from "./source-browser";
import { SourceTree } from "./SourceTree";
import { useUserPreferences } from "./use-user-preferences";
import { WorkbenchFilename } from "./WorkbenchFilename";
import "./DetachedStudyNavigator.css";

function formatBytes(bytes?: number): string | null {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatCalibration(source: StudyNavigatorSource): string | null {
  const calibration = source.metadata.physical_calibration;
  if (!Array.isArray(calibration?.spacing) || !calibration.spacing.length) return null;
  if (!calibration.spacing.every((value) => Number.isFinite(value) && value > 0)) return null;
  const axes = calibration.axes?.length === calibration.spacing.length ? ` (${calibration.axes})` : "";
  const unit = calibration.unit || "(unit unrecorded)";
  return `${calibration.spacing.join(" × ")} ${unit}${axes}`;
}

function formatSourceKind(source: StudyNavigatorSource): string | null {
  if (source.metadata.format) return source.metadata.format;
  switch (source.source_kind) {
    case "ome_zarr":
      return "OME-Zarr";
    case "whole_slide":
      return "Whole slide";
    case "medical":
      return "Medical";
    default:
      return null;
  }
}

function formatDtypes(source: StudyNavigatorSource): string | null {
  const dtypes = source.metadata.channel_dtypes?.filter(Boolean) ?? [];
  if (!dtypes.length) return null;
  return Array.from(new Set(dtypes)).join(" / ");
}

function formatDimensionsSummary(
  dims: ReturnType<typeof sourceMetadataDimensions>,
  samples: ReturnType<typeof sourceSampleLayout>,
): string {
  const parts: string[] = [];
  if (dims.x !== undefined && dims.y !== undefined) {
    parts.push(`${dims.x.toLocaleString()} × ${dims.y.toLocaleString()} px`);
  } else {
    if (dims.x !== undefined) parts.push(`${dims.x.toLocaleString()} px X`);
    if (dims.y !== undefined) parts.push(`${dims.y.toLocaleString()} px Y`);
  }
  if (samples) {
    parts.push(samples.description);
    if (dims.c !== undefined && dims.c > 1 && dims.s !== undefined && dims.s > 1) parts.push(`${dims.c} C groups`);
  } else if (dims.c !== undefined) {
    parts.push(`${dims.c} C`);
  }
  if (dims.z !== undefined && dims.z > 1) parts.push(`${dims.z} Z`);
  if (dims.t !== undefined && dims.t > 1) parts.push(`${dims.t} T`);
  return parts.join(" · ");
}

function folderContext(source: StudyNavigatorSource, allSources: StudyNavigatorSource[]): string | null {
  const full = sourceDisplayPath(source, allSources);
  const slash = full.lastIndexOf("/");
  return slash > 0 ? full.slice(0, slash) : null;
}

export function DetachedStudyNavigator({ api }: { api: StudyNavigatorApi }) {
  useUserPreferences();
  const [state, setState] = useState<StudyNavigatorState | null>(null);
  const [error, setError] = useState("");
  const dockButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let mounted = true;
    const receive = (next: StudyNavigatorState) => {
      if (!mounted) return;
      setState((previous) => {
        if (!previous) return next;
        return next.binding.generation === previous.binding.generation &&
          sameStudyNavigatorTarget(next.binding, previous.binding) &&
          next.sequence > previous.sequence
          ? next
          : previous;
      });
    };
    const unsubscribe = api.onState(receive);
    void api.state().then(receive).catch(() => {
      if (mounted) setError("The Images navigator is unavailable. Close this window to return to the workspace.");
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api]);

  const binding = state?.binding;
  useLayoutEffect(() => {
    document.title = "Loci · Images";
  }, []);

  useEffect(() => {
    if (binding) dockButton.current?.focus();
  }, [binding?.generation]);

  const send = useMemo(() => {
    return (action: StudyNavigatorAction) => {
      if (!binding) return;
      setError("");
      void api.act(binding, action).catch(() => {
        setError("Could not apply this image action. Dock Images and try again.");
      });
    };
  }, [api, binding?.generation, binding?.projectId, binding?.studyGeneration, binding?.documentGeneration]);

  const dock = () => {
    if (binding) void api.dock(binding).catch(() => setError("Close this window to dock Images."));
  };

  const snapshot = state?.snapshot;
  const rejected = state?.rejectedSequence !== undefined && state.rejectedSequence === state.sequence;
  const activeSource = snapshot?.activeSourceId
    ? snapshot.sources.find((item) => item.id === snapshot.activeSourceId) ?? null
    : null;
  const activeFolder = activeSource && snapshot ? folderContext(activeSource, snapshot.sources) : null;
  const activeCalibration = activeSource ? formatCalibration(activeSource) : null;
  const activeDtype = activeSource ? formatDtypes(activeSource) : null;
  const activeFormat = activeSource ? formatSourceKind(activeSource) : null;
  const activeSize = activeSource ? formatBytes(activeSource.size_bytes) : null;
  const activeDimensions = activeSource ? sourceMetadataDimensions(activeSource.metadata) : {};
  const activeSamples = activeSource ? sourceSampleLayout(activeSource.metadata, activeDimensions.s) : null;
  const activeDimensionSummary = formatDimensionsSummary(activeDimensions, activeSamples);
  const activeChannelNames = activeSamples ? [] : activeSource?.metadata.channel_names?.filter(Boolean) ?? [];
  const activeResultCount = activeSource && snapshot?.resultCounts ? snapshot.resultCounts[activeSource.id] : undefined;
  const selectedCount = snapshot?.selectedSourceIds.length ?? 0;

  return (
    <main className="study-navigator-window" aria-label="Images navigator">
      <header className="study-navigator-heading">
        <div>
          <h1>
            Images{" "}
            {snapshot && snapshot.sources.length > 0 && (
              <span className="study-navigator-count">({snapshot.sources.length})</span>
            )}
          </h1>
          {snapshot && <p title={snapshot.studyName}>{snapshot.studyName}</p>}
        </div>
        {binding && (
          <button ref={dockButton} type="button" onClick={dock}>
            <PanelLeft aria-hidden="true" />
            Dock Images
          </button>
        )}
      </header>
      <div className="study-navigator-body" aria-busy={!snapshot && !error}>
        {(error || rejected) && (
          <p role="alert" className="study-navigator-message">
            {error || "The study changed before this action could apply. Review the current list and try again."}
          </p>
        )}
        {snapshot ? (
          <div className="study-navigator-layout">
            <section className="study-navigator-tree-pane" aria-label="Study image list">
              {snapshot.sources.length > 0 ? (
                <SourceTree
                  key={`detached-source-browser:${binding!.studyGeneration}:${binding!.documentGeneration}`}
                  sources={snapshot.sources}
                  activeSourceId={snapshot.activeSourceId}
                  selectedSourceIds={snapshot.selectedSourceIds}
                  onActivate={(source, event, rangeIds) =>
                    send({
                      kind: "activate",
                      sourceId: source.id,
                      sourceSha256: source.sha256,
                      modifier: event.metaKey || event.ctrlKey ? "toggle" : event.shiftKey ? "range" : "none",
                      visibleSourceIds: rangeIds,
                    })
                  }
                  onToggleSelection={(source) =>
                    send({ kind: "toggle-selection", sourceId: source.id, sourceSha256: source.sha256 })
                  }
                  onReorder={(nextSources) =>
                    send({
                      kind: "reorder",
                      order: nextSources.map((item) => ({ sourceId: item.id, sourceSha256: item.sha256 })),
                    })
                  }
                  reorderDisabled={snapshot.reorderDisabled || snapshot.busy}
                />
              ) : (
                <p className="study-navigator-empty" role="status">
                  No images in this study. Add images from the main window.
                </p>
              )}
            </section>
            {activeSource && (
              <section className="study-navigator-details" aria-label="Active image details">
                <div className="study-navigator-details-head">
                  <h2>Active image</h2>
                  {selectedCount > 1 && <span className="study-navigator-badge">{selectedCount} selected</span>}
                </div>
                <p className="study-navigator-active-name">
                  <WorkbenchFilename name={activeSource.name} />
                </p>
                {activeSource.locator_state === "relink-required" && (
                  <p className="study-navigator-relink" role="status">
                    <AlertTriangle size={13} aria-hidden="true" />
                    Relink required in main window
                  </p>
                )}
                <p className="study-navigator-compact-meta">
                  {activeDimensionSummary && <span>{activeDimensionSummary}</span>}
                  {activeCalibration && <span>{activeCalibration}</span>}
                  {activeDtype && <span>{activeDtype}</span>}
                  {typeof activeResultCount === "number" && activeResultCount > 0 && (
                    <span>{activeResultCount === 1 ? "1 result" : `${activeResultCount} results`}</span>
                  )}
                </p>
                <dl className="study-navigator-meta-list">
                  {activeFolder && (
                    <>
                      <dt>Folder</dt>
                      <dd title={activeFolder}>{activeFolder}</dd>
                    </>
                  )}
                  <dt>Dimensions</dt>
                  <dd>{activeDimensionSummary || "Not recorded"}</dd>
                  {activeSource.metadata.axes && (
                    <>
                      <dt>Axes</dt>
                      <dd>{activeSource.metadata.axes}</dd>
                    </>
                  )}
                  {activeCalibration && (
                    <>
                      <dt>Calibration</dt>
                      <dd>{activeCalibration}</dd>
                    </>
                  )}
                  {(activeFormat || activeDtype) && (
                    <>
                      <dt>Format</dt>
                      <dd>{[activeFormat, activeDtype].filter(Boolean).join(" · ")}</dd>
                    </>
                  )}
                  {activeChannelNames.length > 0 && (
                    <>
                      <dt>Channels</dt>
                      <dd>{activeChannelNames.join(", ")}</dd>
                    </>
                  )}
                  {activeSize && (
                    <>
                      <dt>Size</dt>
                      <dd>{activeSize}</dd>
                    </>
                  )}
                  {typeof activeResultCount === "number" && (
                    <>
                      <dt>Results</dt>
                      <dd>{activeResultCount === 0 ? "None" : activeResultCount}</dd>
                    </>
                  )}
                  <dt>Fingerprint</dt>
                  <dd className="study-navigator-mono" title={activeSource.sha256}>
                    {activeSource.sha256.slice(0, 12)}
                  </dd>
                </dl>
              </section>
            )}
          </div>
        ) : (
          !error && (
            <p className="study-navigator-message" role="status">
              Opening Images navigator…
            </p>
          )
        )}
      </div>
    </main>
  );
}
