import { AlertTriangle, Image as ImageIcon, Maximize2, Minimize2, PanelsTopLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ImageWindowApi,
  ImageWindowEntry,
  ImageWindowPresentation,
  ImageWindowPresentationEvent,
  ImageWindowState,
} from "../shared/image-window-api";
import type { ImageViewTargetSnapshot } from "../shared/image-view-contracts";
import type { ResearchDesktopApi } from "../shared/research-contracts";
import { ImageViewport, type ImagePoint } from "./ImageViewport";
import { RawVolumeViewport, type RawVolumeRefinementRequest, type RawVolumeResponse } from "./RawVolumeViewport";
import { rawVolumeUnavailableReason } from "./raw-volume-eligibility";
import { loadPreferences } from "./preferences";
import type { VolumeDisplayControls } from "./raw-volume-display";
import "./detached-windows.css";

const VIEW_VOLUME_BYTES = 32 * 1024 ** 2;

function targetKey(target: ImageViewTargetSnapshot | null): string {
  return target ? [target.viewId, target.sessionEpoch, target.generation, target.sourceId,
    target.sourceSha256, target.resultId ?? "", target.resultRevisionHash ?? ""].join(":") : "";
}

function sameTarget(left: ImageViewTargetSnapshot | null, right: ImageViewTargetSnapshot | null): boolean {
  return targetKey(left) === targetKey(right);
}

function safeMessage(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  return value.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    .replace(/\/?(?:Users|Volumes)\/[^\s]+/gu, "selected source").slice(0, 1000);
}

function entryForState(state: ImageWindowState | null): ImageWindowEntry | null {
  if (!state?.target) return null;
  return state.views.find((entry) => sameTarget(entry.target, state.target)) ?? null;
}

function boundViewportApi(
  api: ImageWindowApi,
  target: ImageViewTargetSnapshot,
  onCancelError: (error: unknown) => void,
): ResearchDesktopApi {
  return {
    execute: (operation, request, options) => {
      if (operation !== "viewer_tile") {
        return Promise.reject(new Error(`Detached image windows cannot run ${operation}.`));
      }
      if (request.source_id !== target.sourceId) {
        return Promise.reject(new Error("The image request does not match this window's source."));
      }
      return api.execute(target, operation, request, options);
    },
    cancelView: async () => {
      try {
        await api.cancel(target);
      } catch (caught) {
        onCancelError(caught);
      }
    },
  } as ResearchDesktopApi;
}

function targetPresentation(
  event: ImageWindowPresentationEvent | null,
  target: ImageViewTargetSnapshot | null,
): ImageWindowPresentation | null {
  return event && target && sameTarget(event.target, target) ? event.presentation : null;
}

export function DetachedImageWindow({ api }: { api: ImageWindowApi }) {
  const [windowState, setWindowState] = useState<ImageWindowState | null>(null);
  const [presentationEvent, setPresentationEvent] = useState<ImageWindowPresentationEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [volume, setVolume] = useState<RawVolumeResponse | null>(null);
  const [volumeLoading, setVolumeLoading] = useState(false);
  const [volumeError, setVolumeError] = useState<string | null>(null);
  const [pageHidden, setPageHidden] = useState(() => document.hidden);
  const stateRef = useRef<ImageWindowState | null>(null);
  const volumeToken = useRef(0);

  useEffect(() => {
    const applyAppearance = () => {
      const preferences = loadPreferences();
      Object.assign(document.documentElement.dataset, { theme: preferences.theme, textSize: preferences.textSize,
        font: preferences.font ?? "system", motion: preferences.motion });
    };
    applyAppearance();
    window.addEventListener("storage", applyAppearance);
    document.documentElement.classList.add("detached-window-root");
    return () => { document.documentElement.classList.remove("detached-window-root"); window.removeEventListener("storage", applyAppearance); };
  }, []);

  useEffect(() => {
    const changed = () => setPageHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  useEffect(() => {
    let active = true;
    let receivedState = false;
    let receivedPresentation = false;
    const adoptState = (value: ImageWindowState) => {
      if (!active) return;
      stateRef.current = value;
      setWindowState(value);
    };
    const removeState = api.onState((value) => { receivedState = true; adoptState(value); });
    const removePresentation = api.onPresentation((event) => {
      receivedPresentation = true;
      if (active) setPresentationEvent(event);
    });
    void Promise.all([api.state(), api.presentation()]).then(([state, event]) => {
      if (!active) return;
      // A native event may arrive while the initial snapshots are in flight.
      // Never replace that newer display/target with the startup response.
      if (!receivedState) adoptState(state);
      if (!receivedPresentation) setPresentationEvent(event);
    }).catch((caught) => {
      if (active) setError(safeMessage(caught, "Could not prepare this image window."));
    });
    return () => {
      active = false;
      removeState();
      removePresentation();
    };
  }, [api, loadAttempt]);

  const entry = entryForState(windowState);
  const target = entry?.target ?? null;
  const presentation = targetPresentation(presentationEvent, target);
  const reportCancelError = useCallback((caught: unknown) => {
    if (sameTarget(stateRef.current?.target ?? null, target)) {
      setError(safeMessage(caught, "Could not cancel the image request."));
    }
  }, [targetKey(target)]);
  const viewportApi = useMemo(
    () => target ? boundViewportApi(api, target, reportCancelError) : null,
    [api, targetKey(target), reportCancelError],
  );

  const runWindowAction = useCallback((action: () => Promise<unknown>, fallback: string) => {
    const actionTarget = target;
    void action().catch((caught) => {
      if (sameTarget(stateRef.current?.target ?? null, actionTarget)) {
        setError(safeMessage(caught, fallback));
      }
    });
  }, [targetKey(target)]);

  useEffect(() => {
    if (!target) return;
    const actionTarget = target;
    const leaveFullscreen = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      runWindowAction(() => api.fullscreen(actionTarget, false), "Could not leave native full screen.");
    };
    window.addEventListener("keydown", leaveFullscreen);
    return () => window.removeEventListener("keydown", leaveFullscreen);
  }, [api, targetKey(target), runWindowAction]);

  useEffect(() => {
    if (!pageHidden || !target) return;
    const hiddenTarget = target;
    api.cancel(hiddenTarget).catch((caught) => {
      if (sameTarget(stateRef.current?.target ?? null, hiddenTarget)) {
        setError(safeMessage(caught, "Could not pause hidden image work."));
      }
    });
  }, [api, pageHidden, targetKey(target)]);

  const sendInteraction = useCallback((kind: "draft" | "camera", value: ImagePoint[] | { x: number; y: number; scale: number }) => {
    if (!target || !presentation) return;
    const sentTarget = target;
    const interaction = kind === "draft"
      ? { kind, points: value as ImagePoint[], plane: { t: presentation.selection.t, z: presentation.selection.z } } as const
      : { kind, camera: value as { x: number; y: number; scale: number } } as const;
    setPresentationEvent((current) => current && sameTarget(current.target, sentTarget)
      ? {
          ...current,
          presentation: {
            ...current.presentation,
            ...(kind === "draft" ? { draft: value as ImagePoint[] }
              : { camera: value as { x: number; y: number; scale: number } }),
          },
        }
      : current);
    void api.interact(sentTarget, interaction).catch((caught) => {
      if (sameTarget(stateRef.current?.target ?? null, sentTarget)) {
        setError(safeMessage(caught, "Could not update the detached view."));
      }
    });
  }, [api, targetKey(target), presentation?.selection.t, presentation?.selection.z]);

  const onDraftChange = useCallback((points: ImagePoint[]) => sendInteraction("draft", points), [sendInteraction]);
  const lastCameraSent = useRef<{ target: string; x: number; y: number; scale: number } | null>(null);
  const onCamera = useCallback((camera: { x: number; y: number; scale: number }) => {
    const key = targetKey(target);
    const prior = lastCameraSent.current;
    if (prior?.target === key && prior.x === camera.x && prior.y === camera.y && prior.scale === camera.scale) return;
    lastCameraSent.current = { target: key, ...camera };
    sendInteraction("camera", camera);
  }, [sendInteraction, targetKey(target)]);

  const onVolumeDisplayChange = useCallback((display: VolumeDisplayControls) => {
    if (!target) return;
    const sentTarget = target;
    setPresentationEvent((current) => current && sameTarget(current.target, sentTarget) ? {
      ...current, presentation: { ...current.presentation,
        channels: current.presentation.channels.map((channel) => display.channels.find((value) => value.channel === channel.channel) ?? channel),
        volumeDisplay: { renderMode: display.renderMode, quality: display.quality } },
    } : current);
    void api.interact(sentTarget, { kind: "volume-display", ...display }).catch((caught) => {
      if (sameTarget(stateRef.current?.target ?? null, sentTarget)) setError(safeMessage(caught, "Could not synchronize volume controls."));
    });
  }, [api, targetKey(target)]);

  const requestVolume = useCallback(async (refinement?: RawVolumeRefinementRequest) => {
    if (!entry || !presentation || presentation.mode !== "volume") return;
    const unavailable = rawVolumeUnavailableReason(entry.source);
    if (unavailable) {
      setVolume(null);
      setVolumeError(unavailable);
      return;
    }
    const visibleChannels = presentation.channels.filter((channel) => channel.visible)
      .map((channel) => channel.channel);
    if (visibleChannels.length > 4) {
      setVolume(null);
      setVolumeError("Choose up to four visible channels for this volume view.");
      return;
    }
    const requestTarget = entry.target;
    const requestedTime = presentation.selection.t;
    const token = ++volumeToken.current;
    setVolumeLoading(true);
    setVolumeError(null);
    try {
      const output = await api.execute(requestTarget, "viewer_volume", {
        source_id: entry.source.id,
        t: requestedTime,
        channel_indices: visibleChannels.length ? visibleChannels : [presentation.selection.c],
        target_long_axis: refinement?.target_long_axis ?? 128,
        ...(refinement?.focus_region_xyzxyz
          ? { focus_region_xyzxyz: refinement.focus_region_xyzxyz }
          : {}),
        max_decoded_bytes: VIEW_VOLUME_BYTES,
      }, { viewer_lane: "detached-volume" }) as RawVolumeResponse;
      if (volumeToken.current !== token || !sameTarget(stateRef.current?.target ?? null, requestTarget)) return;
      if (output.context.source_id !== entry.source.id ||
        output.context.source_sha256 !== entry.source.sha256 ||
        output.context.t !== requestedTime) {
        throw new Error("The volume does not match this window's source and time point.");
      }
      setVolume(output);
    } catch (caught) {
      if (volumeToken.current === token && sameTarget(stateRef.current?.target ?? null, requestTarget)) {
        setVolumeError(safeMessage(caught, "Could not prepare the volume."));
      }
    } finally {
      if (volumeToken.current === token && sameTarget(stateRef.current?.target ?? null, requestTarget)) {
        setVolumeLoading(false);
      }
    }
  }, [api, entry, presentation]);

  const volumeChannels = presentation?.channels.filter((channel) => channel.visible)
    .map((channel) => channel.channel).join(",") ?? "";
  useEffect(() => {
    volumeToken.current += 1;
    setVolume(null);
    setVolumeError(null);
    setVolumeLoading(false);
    if (presentation?.mode === "volume" && !pageHidden) void requestVolume();
    return () => { volumeToken.current += 1; };
  }, [targetKey(target), presentation?.mode, presentation?.selection.t, volumeChannels, pageHidden]);

  if (error) {
    return <main className="detached-image-window detached-window-message" role="alert">
      <AlertTriangle aria-hidden="true" />
      <h1>Image window unavailable</h1>
      <p>{error}</p>
      <button onClick={() => {
        setError(null);
        setLoadAttempt((attempt) => attempt + 1);
      }}><RefreshCw aria-hidden="true" /> Retry view</button>
    </main>;
  }
  if (!windowState || !entry || !target) {
    return <main className="detached-image-window detached-window-message" role="status">
      <ImageIcon aria-hidden="true" />
      <h1>Preparing image window…</h1>
      <p>Waiting for a source-bound view.</p>
    </main>;
  }
  if (entry.source.id !== target.sourceId || entry.source.sha256 !== target.sourceSha256) {
    return <main className="detached-image-window detached-window-message" role="alert">
      <AlertTriangle aria-hidden="true" />
      <h1>Source identity changed</h1>
      <p>Close this window and reopen the image from the control panel.</p>
    </main>;
  }
  if (entry.status === "crashed") {
    return <main className="detached-image-window detached-window-message" role="alert">
      <AlertTriangle aria-hidden="true" />
      <h1>This image window stopped</h1>
      <p>Reopen it from the control panel.</p>
    </main>;
  }
  if (!presentation || !viewportApi) {
    return <main className="detached-image-window detached-window-message" role="status">
      <ImageIcon aria-hidden="true" />
      <h1>{entry.label}</h1>
      <p>Waiting for display settings.</p>
    </main>;
  }

  return <main className="detached-image-window" data-view-id={target.viewId}>
    <header className="detached-image-header">
      <div>
        <strong>{entry.label}</strong>
        <span>{entry.source.name}</span>
      </div>
      <div className="detached-image-window-actions">
        <span className="detached-view-identity">{presentation.mode === "volume" ? "3D volume" : "Source plane"} · {entry.source.metadata.format ?? "image"}</span>
        <button title="Show the control panel" aria-label="Show control panel"
          onClick={() => runWindowAction(() => api.focus(null), "Could not show the control panel.")}>
          <PanelsTopLeft aria-hidden="true" />
        </button>
        <button title={entry.fullscreen ? "Exit native full screen (Esc)" : "Enter native full screen"}
          aria-label={entry.fullscreen ? "Exit native full screen" : "Enter native full screen"}
          onClick={() => runWindowAction(() => api.fullscreen(target, !entry.fullscreen), "Could not change native full screen.")}>
          {entry.fullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      </div>
    </header>
    <section className="detached-image-stage" aria-label={`Detached image: ${entry.source.name}`}>
      {presentation.mode === "volume" ? <>
        <RawVolumeViewport
          externalDisplay={{ channels: presentation.channels, ...(presentation.volumeDisplay ?? { renderMode: "blend", quality: 50 }) }}
          onDisplayChange={onVolumeDisplayChange}
          volume={volume}
          loading={volumeLoading}
          error={volumeError}
          onRequestRefinement={(request) => void requestVolume(request)}
          onExportFigure={(request) => api.exportFigure(target, request)}
        />
        {volumeError && <button className="detached-stage-retry" onClick={() => void requestVolume()}>
          <RefreshCw aria-hidden="true" /> Retry volume
        </button>}
      </> : <ImageViewport
        key={targetKey(target)}
        api={viewportApi}
        source={entry.source}
        selection={presentation.selection}
        channels={presentation.channels}
        projection={presentation.projection}
        annotations={presentation.annotations}
        draft={presentation.draft}
        drawingMode={presentation.tool}
        initialCamera={presentation.camera}
        paused={pageHidden}
        showScaleBar={presentation.showScaleBar}
        showNavigator={presentation.showNavigator}
        requestLane="detached-image"
        onDraftChange={onDraftChange}
        onPoint={presentation.tool === "navigate" ? undefined : (point) => {
          const maximum = presentation.tool === "point" ? 1
            : presentation.tool === "polygon" || presentation.tool === "freehand" ? 2048 : 2;
          const points = presentation.draft.length >= maximum
            ? [point]
            : [...presentation.draft, point];
          sendInteraction("draft", points);
        }}
        onCamera={onCamera}
        onError={(message) => {
          setError(message);
          api.interact(target, { kind: "error", message }).catch((caught) => {
            if (sameTarget(stateRef.current?.target ?? null, target)) {
              setError(safeMessage(caught, "Could not report the image-window error."));
            }
          });
        }}
      />}
    </section>
  </main>;
}

export default DetachedImageWindow;
