import React, { useEffect, useId, useRef, useState } from "react";
import type { ModelLibraryEntry } from "../../shared/model-library";
import type { ModelZooResolvedExample } from "./examples";

export type ComparisonViewMode = "compare" | "overlay" | "original";

interface ImageDimensions {
  width: number;
  height: number;
}

export interface ModelZooComparisonProps {
  entry: Readonly<ModelLibraryEntry>;
  example: Readonly<ModelZooResolvedExample> | null;
  reducedMotion: boolean;
}

const VIEW_MODES: ReadonlyArray<{
  readonly id: ComparisonViewMode;
  readonly label: string;
}> = [
  { id: "compare", label: "Compare" },
  { id: "overlay", label: "Overlay" },
  { id: "original", label: "Original" },
];

function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export default function ModelZooComparison({
  entry,
  example,
  reducedMotion,
}: ModelZooComparisonProps): React.JSX.Element {
  const sliderId = useId();
  const [viewMode, setViewMode] = useState<ComparisonViewMode>("compare");
  const [split, setSplit] = useState(50);
  const [originalDims, setOriginalDims] = useState<ImageDimensions | null>(null);
  const [overlayDims, setOverlayDims] = useState<ImageDimensions | null>(null);
  const [originalError, setOriginalError] = useState(false);
  const [overlayError, setOverlayError] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    setViewMode("compare");
    setSplit(50);
    setOriginalDims(null);
    setOverlayDims(null);
    setOriginalError(false);
    setOverlayError(false);
    draggingRef.current = false;
  }, [entry.id, example?.originalUrl, example?.overlayUrl]);

  if (!example) {
    return (
      <figure
        className="model-zoo-detail-stage"
        data-example-kind="unavailable"
      >
        <div className="model-zoo-detail-stage__viewport model-zoo-detail-stage__viewport--empty">
          <div className="model-zoo-stage-empty" role="status">
            <strong>No bundled example</strong>
            <span>
              {entry.target} · {entry.modalitySummary}
            </span>
          </div>
        </div>
      </figure>
    );
  }

  const isPrediction = example.kind === "prediction";
  const geometryMismatch =
    isPrediction &&
    originalDims !== null &&
    overlayDims !== null &&
    (originalDims.width !== overlayDims.width ||
      originalDims.height !== overlayDims.height);

  const canCompare = isPrediction && !geometryMismatch && !overlayError && !originalError;
  const activeDims = originalDims ?? overlayDims;
  const frameStyle: React.CSSProperties | undefined = activeDims
    ? {
        aspectRatio: `${activeDims.width} / ${activeDims.height}`,
        width:
          activeDims.width >= 240
            ? `min(100%, ${activeDims.width}px, calc(var(--zoo-stage-max-h, 460px) * ${activeDims.width / activeDims.height}))`
            : `min(100%, calc(var(--zoo-stage-max-h, 460px) * ${activeDims.width / activeDims.height}))`,
      }
    : undefined;

  const updateSplitFromClientX = (clientX: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = ((clientX - rect.left) / rect.width) * 100;
    setSplit(clampSplit(ratio));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canCompare || viewMode !== "compare") return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    draggingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateSplitFromClientX(event.clientX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !canCompare || viewMode !== "compare") return;
    updateSplitFromClientX(event.clientX);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onModeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      ![
        "ArrowRight",
        "ArrowDown",
        "ArrowLeft",
        "ArrowUp",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      return;
    }
    const radios = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='radio']"),
    ];
    if (!radios.length) return;
    const current = radios.indexOf(document.activeElement as HTMLButtonElement);
    const backwards = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? radios.length - 1
          : current === -1
            ? 0
            : (current + (backwards ? radios.length - 1 : 1)) % radios.length;
    event.preventDefault();
    radios[next].focus();
    radios[next].click();
  };

  const overlayClipPath =
    viewMode === "overlay"
      ? "inset(0 0 0 0)"
      : viewMode === "original"
        ? "inset(0 0 0 100%)"
        : `inset(0 0 0 ${split}%)`;

  const alignedGeometryAttr =
    isPrediction &&
    originalDims &&
    overlayDims &&
    !geometryMismatch
      ? `${originalDims.width}x${originalDims.height}`
      : undefined;

  return (
    <figure
      className="model-zoo-detail-stage"
      data-example-kind={example.kind}
      data-view-mode={canCompare ? viewMode : "original"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-aligned-geometry={alignedGeometryAttr}
    >
      <div className="model-zoo-detail-stage__viewport">
        {originalError ? (
          <div className="model-zoo-stage-empty" role="status">
            <strong>Example image could not be decoded</strong>
            <span>{example.credit.subject}</span>
          </div>
        ) : (
          <div
            ref={frameRef}
            className={`model-zoo-compare__frame${
              canCompare && viewMode === "compare"
                ? " model-zoo-compare__frame--interactive"
                : ""
            }`}
            style={frameStyle}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            <img
              src={example.originalUrl}
              alt={
                isPrediction
                  ? `Original reference input for ${entry.title}: ${example.credit.subject}`
                  : `Reference input image for ${entry.title}: ${example.credit.subject}`
              }
              decoding="async"
              draggable={false}
              className="model-zoo-compare__img model-zoo-compare__img--original"
              data-layer="original"
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                if (naturalWidth > 0 && naturalHeight > 0) {
                  setOriginalDims({ width: naturalWidth, height: naturalHeight });
                }
              }}
              onError={() => setOriginalError(true)}
            />

            {isPrediction && !overlayError && !geometryMismatch && (
              <img
                src={example.overlayUrl}
                alt={`Model prediction overlay for ${entry.title}: ${example.credit.subject}`}
                decoding="async"
                draggable={false}
                className="model-zoo-compare__img model-zoo-compare__img--overlay"
                data-layer="overlay"
                style={{
                  clipPath: overlayClipPath,
                  opacity: viewMode === "original" ? 0 : 1,
                }}
                onLoad={(event) => {
                  const { naturalWidth, naturalHeight } = event.currentTarget;
                  if (naturalWidth > 0 && naturalHeight > 0) {
                    setOverlayDims({ width: naturalWidth, height: naturalHeight });
                  }
                }}
                onError={() => setOverlayError(true)}
              />
            )}

            {canCompare && viewMode === "compare" && (
              <div
                className="model-zoo-compare__divider"
                style={{ left: `${split}%` }}
                aria-hidden="true"
              >
                <span className="model-zoo-compare__handle" />
              </div>
            )}
          </div>
        )}
      </div>

      {geometryMismatch && originalDims && overlayDims && (
        <div className="model-zoo-compare__notice" role="status">
          Original ({originalDims.width} × {originalDims.height} px) and overlay (
          {overlayDims.width} × {overlayDims.height} px) dimensions do not match.
          Showing original input only.
        </div>
      )}

      {isPrediction && overlayError && !originalError && (
        <div className="model-zoo-compare__notice" role="status">
          Prediction overlay could not be decoded. Showing original input only.
        </div>
      )}

      {canCompare && (
        <div className="model-zoo-compare__controls">
          <div
            className="model-zoo-compare__modes"
            role="radiogroup"
            aria-label="Example view mode"
            onKeyDown={onModeKeyDown}
          >
            {VIEW_MODES.map((option) => {
              const checked = viewMode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  className="model-zoo-compare__mode-btn"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => setViewMode(option.id)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {viewMode === "compare" && (
            <div className="model-zoo-compare__slider-group">
              <label htmlFor={sliderId} className="model-zoo-compare__slider-label">
                <span>Original</span>
                <span className="model-zoo-compare__slider-readout">
                  {split}% / {100 - split}%
                </span>
                <span>Overlay</span>
              </label>
              <input
                id={sliderId}
                type="range"
                min={0}
                max={100}
                step={1}
                value={split}
                className="model-zoo-compare__slider"
                aria-label="Original and overlay comparison split"
                aria-valuetext={`${split}% original, ${100 - split}% overlay`}
                onChange={(event) => setSplit(clampSplit(Number(event.target.value)))}
              />
            </div>
          )}
        </div>
      )}

      <figcaption className="model-zoo-detail-stage__caption">
        <div className="model-zoo-detail-stage__caption-top">
          <span className="model-zoo-detail-stage__kind">
            {isPrediction ? "Aligned original & prediction overlay" : "Reference input only"}
          </span>
          {activeDims && (
            <span className="model-zoo-detail-stage__dims">
              {activeDims.width} × {activeDims.height} px
            </span>
          )}
        </div>
        <p className="model-zoo-detail-stage__subject">{example.credit.subject}</p>
        <p className="model-zoo-detail-stage__transform">
          {example.credit.displayTransform}
        </p>
      </figcaption>
    </figure>
  );
}
