import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Plus,
  Scan,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  ResearchDimensions,
  ResearchSelection,
} from "../shared/research-contracts";
import {
  MAX_PREPROCESS_DRAFT_LENGTH,
  type PreprocessEditorEdit,
  type PreprocessEditorView,
  type PreprocessOp,
  type PreprocessRow,
  type StepParameter,
} from "../shared/preprocess-inspector-api";
import { UNVERIFIED_DISTANCE_UNIT } from "./puncta-distance-unit";
import { MAX_PROCESSING_STEPS, parameterBoundsHint } from "./use-preprocessing-editor";
import "./PreprocessingPanel.css";

export interface PreprocessStepGroup {
  id: string;
  label: string;
  ops: readonly PreprocessOp[];
}

export const PREPROCESS_STEP_GROUPS: readonly PreprocessStepGroup[] = [
  {
    id: "smoothing",
    label: "Smoothing",
    ops: ["gaussian", "median"],
  },
  {
    id: "background-intensity",
    label: "Background & intensity",
    ops: ["subtract_background", "subtract_constant"],
  },
  {
    id: "morphology",
    label: "Morphology",
    ops: ["opening", "closing"],
  },
] as const;

export const PREPROCESS_LABELS: Record<string, string> = {
  gaussian: "Gaussian blur",
  median: "Median filter",
  subtract_background: "Background subtraction",
  subtract_constant: "Subtract constant",
  opening: "Morphological opening",
  closing: "Morphological closing",
  flatfield: "Flat-field correction",
};

function intensityUnitForStep(index: number): string {
  return index === 0 ? "source intensity" : `step ${index} intensity`;
}

function parameterDisplayLabel(parameter: StepParameter): string {
  if (parameter === "sigma") return "Sigma";
  if (parameter === "radius") return "Radius";
  return "Value";
}

function formatStepIndex(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function formatCollapsedSummary({ op, parameter, value, clipNegative }: PreprocessRow, spatialUnit: string): string {
  const clipSuffix = clipNegative ? " · ≥0" : "";
  if (!parameter) return op === "flatfield" ? `references${clipSuffix}` : "";
  const formatted = Number.isFinite(value) ? String(value) : "—";
  if (parameter === "value") return `= ${formatted}${clipSuffix}`;
  const prefix = parameter === "sigma" ? "σ" : "r";
  const unit = spatialUnit === UNVERIFIED_DISTANCE_UNIT ? "" : ` ${spatialUnit}`;
  return `${prefix} ${formatted}${unit}${clipSuffix}`;
}

export function isWholeImageSelection(
  selection: ResearchSelection,
  dimensions: ResearchDimensions,
): boolean {
  return (
    selection.x === 0 &&
    selection.y === 0 &&
    selection.width === dimensions.x &&
    selection.height === dimensions.y
  );
}

export function PreprocessingScopeControl({
  selection,
  dimensions,
  drawing,
  onSelectWholeImage,
  onStartDrawRegion,
  onCancelDrawRegion,
}: {
  selection: ResearchSelection;
  dimensions: ResearchDimensions;
  drawing: boolean;
  onSelectWholeImage: () => void;
  onStartDrawRegion: () => void;
  onCancelDrawRegion: () => void;
}) {
  const wholeImage = isWholeImageSelection(selection, dimensions);
  const planeCount =
    selection.z_stop !== undefined
      ? Math.max(1, selection.z_stop - selection.z)
      : 1;
  const planeLabel = planeCount === 1 ? "1 plane" : `${planeCount} planes`;

  const axisParts: string[] = [];
  if (selection.z_stop !== undefined) {
    axisParts.push(`Z ${selection.z + 1}–${selection.z_stop}/${dimensions.z}`);
  } else if (dimensions.z > 1) {
    axisParts.push(`Z ${selection.z + 1}/${dimensions.z}`);
  }
  if (dimensions.t > 1) {
    axisParts.push(`T ${selection.t + 1}/${dimensions.t}`);
  }

  const handleScopeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && drawing) {
      event.preventDefault();
      event.stopPropagation();
      onCancelDrawRegion();
    }
  };

  return (
    <section
      className="preprocess-scope"
      aria-label="Analysis scope"
      onKeyDown={handleScopeKeyDown}
    >
      <div className="preprocess-scope-row">
        <span className="preprocess-scope-label" id="preprocess-scope-heading">
          Analysis scope
        </span>
        <div
          className="preprocess-scope-segmented"
          role="group"
          aria-labelledby="preprocess-scope-heading"
        >
          <button
            type="button"
            className="preprocess-scope-option"
            aria-pressed={wholeImage}
            onClick={onSelectWholeImage}
          >
            Whole image
          </button>
          <button
            type="button"
            className="preprocess-scope-option"
            aria-pressed={!wholeImage}
            aria-description={drawing ? "Drawing region on image" : undefined}
            data-drawing={drawing ? "true" : undefined}
            onClick={() => {
              if (drawing) {
                onCancelDrawRegion();
              } else {
                onStartDrawRegion();
              }
            }}
          >
            Region
          </button>
        </div>
      </div>
      <div className="preprocess-scope-meta">
        <span className="preprocess-scope-dimensions">
          {selection.width.toLocaleString()} × {selection.height.toLocaleString()}{" "}
          px · {planeLabel}
          {!wholeImage
            ? ` · X ${selection.x.toLocaleString()}, Y ${selection.y.toLocaleString()}`
            : ""}
        </span>
        <span className="preprocess-scope-trailing">
          {axisParts.length > 0 && (
            <span className="preprocess-scope-axes">
              {axisParts.join(" · ")}
            </span>
          )}
          {!wholeImage && !drawing && (
            <button
              type="button"
              className="preprocess-scope-inline-action"
              aria-label="Redraw region"
              onClick={onStartDrawRegion}
            >
              Redraw
            </button>
          )}
        </span>
      </div>
      {drawing && (
        <div className="preprocess-scope-drawing" role="status">
          <div className="preprocess-scope-drawing-copy">
            <span className="preprocess-scope-drawing-title">
              <span className="preprocess-scope-drawing-dot" aria-hidden="true" />
              Drawing region
            </span>
            <span>Drag a rectangle on the image. Right-drag still pans.</span>
          </div>
          <button
            type="button"
            className="preprocess-scope-cancel"
            onClick={onCancelDrawRegion}
          >
            Cancel drawing
          </button>
        </div>
      )}
    </section>
  );
}

export function PreprocessingPanel({
  editor,
  spatialUnit,
  onEdit,
  onPreview,
  previewDisabled,
  pendingText,
  restoreNumbers,
}: {
  editor: PreprocessEditorView;
  spatialUnit: string;
  onEdit: (edit: PreprocessEditorEdit) => void;
  onPreview: () => void;
  previewDisabled: boolean;
  pendingText?: { id: number; text: string };
  restoreNumbers?: { disabled: boolean; onRestore: () => void };
}) {
  const { rows, selected, focus } = editor;
  const [chooserOpen, setChooserOpen] = useState(false);
  const chooserContainerRef = useRef<HTMLDivElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const chooserOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const stepInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const stepToggleRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const lastFocusRevision = useRef(focus?.revision);

  const chooserId = useId();
  const baseErrorId = useId();
  const baseDetailsId = useId();

  // A mounted presentation can inherit the last request from the other window.
  useEffect(() => {
    if (!focus || focus.revision === lastFocusRevision.current) return;
    lastFocusRevision.current = focus.revision;
    if (focus.kind === "input") stepInputRefs.current[focus.id]?.focus();
    else if (focus.kind === "toggle") stepToggleRefs.current[focus.id]?.focus();
    else addTriggerRef.current?.focus();
  }, [focus?.revision]);

  // Dismiss chooser on outside pointerdown.
  useEffect(() => {
    if (!chooserOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        chooserContainerRef.current &&
        event.target instanceof Node &&
        !chooserContainerRef.current.contains(event.target)
      ) {
        setChooserOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [chooserOpen]);

  const closeChooserAndFocusTrigger = useCallback(() => {
    setChooserOpen(false);
    addTriggerRef.current?.focus();
  }, []);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && chooserOpen) {
      event.preventDefault();
      event.stopPropagation();
      setChooserOpen(false);
    } else if (event.key === "ArrowDown" && chooserOpen) {
      event.preventDefault();
      chooserOptionRefs.current[0]?.focus();
    } else if (event.key === "ArrowDown" && !chooserOpen) {
      event.preventDefault();
      setChooserOpen(true);
      queueMicrotask(() => chooserOptionRefs.current[0]?.focus());
    }
  };

  const handleChooserKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeChooserAndFocusTrigger();
      return;
    }
    const buttons = chooserOptionRefs.current.filter(
      (button): button is HTMLButtonElement => button !== null,
    );
    if (buttons.length === 0) return;
    const currentIndex = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = currentIndex < 0 ? 0 : (currentIndex + 1) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const previous =
        currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1;
      buttons[previous]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    }
  };

  const atStepLimit = rows.length >= MAX_PROCESSING_STEPS;
  const stepCountLabel =
    rows.length === 1 ? "1 step" : `${rows.length} steps`;

  let optionCursor = 0;

  return (
    <div className="preprocess-inspector">
      <section
        className="preprocess-pipeline"
        aria-label="Processing pipeline"
      >
        <div className="preprocess-pipeline-header">
          <span className="preprocess-pipeline-title">Processing pipeline</span>
          <span className="preprocess-pipeline-count">{stepCountLabel}</span>
        </div>

        {rows.length === 0 ? (
          <p className="preprocess-empty-help">
            No steps configured. Steps run in sequence.
          </p>
        ) : (
          <ol className="preprocess-step-list">
            {rows.map((row, index) => {
              const { id, op, parameter, value, draft, clipNegative } = row;
              const label = PREPROCESS_LABELS[op] ?? op;
              const isSelected = selected === id;
              const detailsId = `${baseDetailsId}-${id}`;
              const errorId = `${baseErrorId}-${id}`;
              const inputText = pendingText?.id === id ? pendingText.text : draft?.text ?? String(value);
              const errorText = draft?.error ?? "";
              const isInvalid = Boolean(errorText);
              const hint = parameter ? parameterBoundsHint(parameter) : "";
              const unitText = parameter === "value" ? intensityUnitForStep(index) : spatialUnit;
              const collapsedSummary = isInvalid ? "Invalid" : formatCollapsedSummary(row, spatialUnit);
              const toggleAriaLabel =
                !isSelected && collapsedSummary
                  ? `${formatStepIndex(index)} ${label}, ${collapsedSummary}`
                  : `${formatStepIndex(index)} ${label}`;

              return (
                <li
                  key={id}
                  className="preprocess-step"
                  data-selected={isSelected ? "true" : undefined}
                  data-invalid={isInvalid ? "true" : undefined}
                >
                  <div className="preprocess-step-top">
                    <button
                      ref={(element) => {
                        stepToggleRefs.current[id] = element;
                      }}
                      type="button"
                      className="preprocess-step-toggle"
                      aria-label={toggleAriaLabel}
                      aria-expanded={isSelected}
                      aria-controls={detailsId}
                      onClick={() => onEdit({ kind: "select", id })}
                    >
                      <span className="preprocess-step-number" aria-hidden="true">
                        {formatStepIndex(index)}
                      </span>
                      <span className="preprocess-step-label" aria-hidden="true">
                        {label}
                      </span>
                      {!isSelected && (
                        <span
                          className={`preprocess-step-summary${isInvalid ? " is-invalid" : ""}`}
                          aria-hidden="true"
                        >
                          {collapsedSummary}
                        </span>
                      )}
                      <span className="preprocess-step-chevron" aria-hidden="true">
                        {isSelected ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </span>
                    </button>
                  </div>

                  {isSelected && (
                    <div
                      id={detailsId}
                      className="preprocess-step-body"
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          stepToggleRefs.current[id]?.focus();
                          onEdit({ kind: "select", id });
                        }
                      }}
                    >
                      {parameter ? (
                        <div className="preprocess-param-field">
                          <label className="preprocess-param-row">
                            <span className="preprocess-param-name">
                              {parameterDisplayLabel(parameter)}
                            </span>
                            <input
                              ref={(element) => {
                                stepInputRefs.current[id] = element;
                              }}
                              className="preprocess-param-input"
                              aria-label={`Step ${index + 1} ${parameter}`}
                              aria-invalid={isInvalid}
                              aria-description={errorText || hint}
                              aria-describedby={isInvalid ? errorId : undefined}
                              inputMode="decimal"
                              value={inputText}
                              title={errorText || hint}
                              maxLength={MAX_PREPROCESS_DRAFT_LENGTH}
                              onChange={(event) => onEdit({ kind: "draft", id, text: event.target.value })}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  event.currentTarget.blur();
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  onEdit({ kind: "revert", id });
                                }
                              }}
                            />
                            <span
                              className={`preprocess-param-unit${unitText === UNVERIFIED_DISTANCE_UNIT ? " is-unverified" : ""}`}
                            >
                              {unitText}
                            </span>
                          </label>
                          {isInvalid && (
                            <small
                              id={errorId}
                              role="alert"
                              className="preprocess-param-error"
                            >
                              {errorText}
                            </small>
                          )}
                        </div>
                      ) : (
                        <p className="preprocess-step-note">
                          Flat-field and dark-field references are configured in
                          Fluorescence &amp; field assay.
                        </p>
                      )}

                      {clipNegative !== undefined && (
                        <label className="preprocess-clip-option">
                          <input
                            type="checkbox"
                            checked={clipNegative}
                            onChange={(event) =>
                              onEdit({ kind: "clip", id, checked: event.target.checked })
                            }
                          />
                          <span>Clip negative values to zero</span>
                        </label>
                      )}

                      <div className="preprocess-step-footer">
                        <div className="preprocess-step-actions">
                          <button
                            type="button"
                            className="preprocess-step-action"
                            aria-label={`Move step ${index + 1} up`}
                            title={`Move step ${index + 1} up`}
                            disabled={index === 0}
                            onClick={() => onEdit({ kind: "move", id, delta: -1 })}
                          >
                            <ArrowUp size={13} aria-hidden="true" />
                            <span>Up</span>
                          </button>
                          <button
                            type="button"
                            className="preprocess-step-action"
                            aria-label={`Move step ${index + 1} down`}
                            title={`Move step ${index + 1} down`}
                            disabled={index === rows.length - 1}
                            onClick={() => onEdit({ kind: "move", id, delta: 1 })}
                          >
                            <ArrowDown size={13} aria-hidden="true" />
                            <span>Down</span>
                          </button>
                        </div>
                        <button
                          type="button"
                          className="preprocess-step-action preprocess-step-remove"
                          aria-label={`Remove ${op}`}
                          title={`Remove step ${index + 1}: ${label}`}
                          onClick={() => onEdit({ kind: "remove", id })}
                        >
                          <X size={13} aria-hidden="true" />
                          <span>Remove</span>
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        <div className="preprocess-chooser-wrap" ref={chooserContainerRef}>
          <button
            ref={addTriggerRef}
            type="button"
            className="preprocess-add-trigger"
            aria-expanded={chooserOpen}
            aria-controls={chooserId}
            disabled={atStepLimit}
            title={
              atStepLimit
                ? `Maximum ${MAX_PROCESSING_STEPS} processing steps reached.`
                : undefined
            }
            onClick={() => setChooserOpen((open) => !open)}
            onKeyDown={handleTriggerKeyDown}
          >
            <span className="preprocess-add-trigger-label">
              <Plus size={14} aria-hidden="true" />
              <span>Add processing step</span>
            </span>
            <ChevronDown
              size={14}
              className="preprocess-add-chevron"
              aria-hidden="true"
            />
          </button>

          {chooserOpen && (
            <div
              id={chooserId}
              className="preprocess-chooser"
              onKeyDown={handleChooserKeyDown}
            >
              {PREPROCESS_STEP_GROUPS.map((group) => {
                const headingId = `${chooserId}-${group.id}`;
                return (
                  <div
                    key={group.id}
                    className="preprocess-chooser-group"
                    role="group"
                    aria-labelledby={headingId}
                  >
                    <div
                      id={headingId}
                      className="preprocess-chooser-group-label"
                    >
                      {group.label}
                    </div>
                    {group.ops.map((op) => {
                      const optionIndex = optionCursor++;
                      return (
                        <button
                          key={op}
                          ref={(element) => {
                            chooserOptionRefs.current[optionIndex] = element;
                          }}
                          type="button"
                          className="preprocess-chooser-option"
                          onClick={() => {
                            onEdit({ kind: "add", op });
                            setChooserOpen(false);
                          }}
                        >
                          <span>{PREPROCESS_LABELS[op]}</span>
                          <Plus
                            size={13}
                            className="preprocess-chooser-plus"
                            aria-hidden="true"
                          />
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <div className="preprocess-preview-section">
        {restoreNumbers && <div className="preprocess-number-recovery">
          <p role="status">Finish numeric fields before previewing or running a recipe.</p>
          <button type="button" className="preprocess-preview-btn" disabled={restoreNumbers.disabled}
            onClick={restoreNumbers.onRestore}>Restore applied numbers</button>
        </div>}
        <button
          type="button"
          className="preprocess-preview-btn"
          disabled={previewDisabled}
          onClick={onPreview}
        >
          <Scan size={14} aria-hidden="true" />
          Preview selected crop
        </button>
      </div>
    </div>
  );
}
