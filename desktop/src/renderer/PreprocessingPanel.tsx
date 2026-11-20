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
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import type {
  ResearchDimensions,
  ResearchRecipe,
  ResearchSelection,
  ResearchSource,
} from "../shared/research-contracts";
import {
  punctaDistanceUnit,
  UNVERIFIED_DISTANCE_UNIT,
} from "./puncta-distance-unit";
import "./PreprocessingPanel.css";

export type PreprocessOp =
  | "gaussian"
  | "median"
  | "subtract_background"
  | "subtract_constant"
  | "opening"
  | "closing";

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

const MAX_PROCESSING_STEPS = 32;

const CLIP_NEGATIVE_OPS = new Set([
  "subtract_background",
  "subtract_constant",
  "flatfield",
]);

function supportsClipNegative(op: string): boolean {
  return CLIP_NEGATIVE_OPS.has(op);
}

function intensityUnitForStep(index: number): string {
  return index === 0 ? "source intensity" : `step ${index} intensity`;
}

type StepParameter = "sigma" | "radius" | "value";

type PendingFocusTarget =
  | { kind: "input"; id: string }
  | { kind: "toggle"; id: string }
  | { kind: "add" }
  | null;

interface StepDraft {
  text: string;
  error: string;
  committedValue: number;
}

function stepParameterFor(step: Record<string, unknown>): StepParameter | null {
  const op = String(step.op ?? "");
  if (op === "flatfield") return null;
  if ("sigma" in step || op === "gaussian" || op === "subtract_background") {
    return "sigma";
  }
  if (
    "radius" in step ||
    op === "median" ||
    op === "opening" ||
    op === "closing"
  ) {
    return "radius";
  }
  if ("value" in step || op === "subtract_constant") {
    return "value";
  }
  return null;
}

function parameterDisplayLabel(parameter: StepParameter): string {
  if (parameter === "sigma") return "Sigma";
  if (parameter === "radius") return "Radius";
  return "Value";
}

function parameterBounds(parameter: StepParameter): {
  minimum: number;
  maximum: number;
  hint: string;
} {
  if (parameter === "value") {
    return {
      minimum: -1e15,
      maximum: 1e15,
      hint: "Enter a finite value from -1000000000000000 to 1000000000000000.",
    };
  }
  return {
    minimum: 0,
    maximum: 1e6,
    hint: "Enter a finite value from 0 to 1000000.",
  };
}

function defaultStepFor(op: PreprocessOp): Record<string, unknown> {
  if (op === "gaussian" || op === "subtract_background") {
    return { op, sigma: 1 };
  }
  if (op === "subtract_constant") {
    return { op, value: 0 };
  }
  return { op, radius: 1 };
}

function formatStepIndex(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function formatCollapsedSummary(
  step: Record<string, unknown>,
  parameter: StepParameter | null,
  spatialUnit: string,
): string {
  const clipSuffix =
    supportsClipNegative(String(step.op ?? "")) && step.clip_negative === true
      ? " · ≥0"
      : "";
  if (!parameter) {
    return String(step.op) === "flatfield" ? `references${clipSuffix}` : "";
  }
  const value = Number(step[parameter]);
  const formatted = Number.isFinite(value) ? String(value) : "—";
  if (parameter === "value") {
    return `= ${formatted}${clipSuffix}`;
  }
  const prefix = parameter === "sigma" ? "σ" : "r";
  if (spatialUnit === UNVERIFIED_DISTANCE_UNIT) {
    return `${prefix} ${formatted}${clipSuffix}`;
  }
  return `${prefix} ${formatted} ${spatialUnit}${clipSuffix}`;
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
  source,
  selection,
  recipe,
  setRecipe,
  onPreview,
  busy,
  numberKey,
  onNumberValidity,
  configurationValid,
}: {
  source: ResearchSource | null;
  selection: ResearchSelection;
  recipe: ResearchRecipe;
  setRecipe: Dispatch<SetStateAction<ResearchRecipe>>;
  onPreview: () => void;
  busy: boolean;
  numberKey: string;
  onNumberValidity: (valid: boolean) => void;
  configurationValid: boolean;
}) {
  const stepIdMapRef = useRef<WeakMap<Record<string, unknown>, string>>(
    new WeakMap(),
  );
  const originalClipKeyRef = useRef<Map<string, boolean>>(new Map());
  const nextStepIdRef = useRef(1);
  const getStepId = useCallback((step: Record<string, unknown>): string => {
    const existing = stepIdMapRef.current.get(step);
    if (existing) return existing;
    const created = `preprocess-step-${nextStepIdRef.current++}`;
    stepIdMapRef.current.set(step, created);
    originalClipKeyRef.current.set(
      created,
      Object.prototype.hasOwnProperty.call(step, "clip_negative"),
    );
    return created;
  }, []);

  const stepEntries = recipe.steps.map((step, index) => ({
    id: getStepId(step),
    step,
    index,
    parameter: stepParameterFor(step),
  }));

  const [selectedStepId, setSelectedStepId] = useState<string | null>(() =>
    recipe.steps.length > 0 ? getStepId(recipe.steps[0]) : null,
  );
  const [drafts, setDrafts] = useState<Record<string, StepDraft>>({});
  const [chooserOpen, setChooserOpen] = useState(false);
  const [pendingFocusTarget, setPendingFocusTarget] =
    useState<PendingFocusTarget>(null);

  const chooserContainerRef = useRef<HTMLDivElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const chooserOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const stepInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const stepToggleRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const chooserId = useId();
  const baseErrorId = useId();
  const baseDetailsId = useId();

  const spatialUnit = useMemo(() => {
    if (!source) return UNVERIFIED_DISTANCE_UNIT;
    return punctaDistanceUnit(source, selection);
  }, [source, selection]);

  // Clear local drafts when the workbench resets numeric inputs (e.g. Restore applied numbers or source change).
  useEffect(() => {
    setDrafts({});
  }, [numberKey]);

  // Reconcile selection if the currently selected step was removed externally.
  const activeStepIdSet = useMemo(
    () => new Set(stepEntries.map((entry) => entry.id)),
    [stepEntries],
  );
  useEffect(() => {
    if (selectedStepId !== null && !activeStepIdSet.has(selectedStepId)) {
      setSelectedStepId(null);
    }
  }, [selectedStepId, activeStepIdSet]);

  // Prune drafts belonging to steps removed externally so stale errors never leak.
  useEffect(() => {
    setDrafts((previous) => {
      let changed = false;
      const next: Record<string, StepDraft> = {};
      for (const [id, draft] of Object.entries(previous)) {
        if (activeStepIdSet.has(id)) {
          next[id] = draft;
        } else {
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [activeStepIdSet]);

  // Compute live validity across ALL current steps (both expanded and collapsed).
  const hasInvalidDraft = stepEntries.some(({ id, step, parameter }) => {
    if (!parameter) return false;
    const draft = drafts[id];
    if (!draft) return false;
    const applied = Number(step[parameter]);
    if (!Object.is(draft.committedValue, applied)) return false;
    return Boolean(draft.error);
  });
  const numbersValid = !hasInvalidDraft;

  useEffect(() => {
    onNumberValidity(numbersValid);
  }, [numbersValid, onNumberValidity]);

  // Move focus cleanly after adding, removing, or boundary-reordering a step.
  useEffect(() => {
    if (!pendingFocusTarget) return;
    if (pendingFocusTarget.kind === "input") {
      stepInputRefs.current[pendingFocusTarget.id]?.focus();
    } else if (pendingFocusTarget.kind === "toggle") {
      stepToggleRefs.current[pendingFocusTarget.id]?.focus();
    } else if (pendingFocusTarget.kind === "add") {
      addTriggerRef.current?.focus();
    }
    setPendingFocusTarget(null);
  }, [pendingFocusTarget, selectedStepId, stepEntries.length]);

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

  const addStep = (op: PreprocessOp) => {
    if (recipe.steps.length >= MAX_PROCESSING_STEPS) return;
    const newStep = defaultStepFor(op);
    const newId = getStepId(newStep);
    setRecipe((old) =>
      old.steps.length >= MAX_PROCESSING_STEPS
        ? old
        : { ...old, steps: [...old.steps, newStep] },
    );
    setSelectedStepId(newId);
    setPendingFocusTarget({ kind: "input", id: newId });
    setChooserOpen(false);
  };

  const patchStep = (index: number, values: Record<string, unknown>) => {
    setRecipe((old) => {
      const target = old.steps[index];
      if (!target) return old;
      const id = getStepId(target);
      const updated = { ...target, ...values };
      stepIdMapRef.current.set(updated, id);
      return {
        ...old,
        steps: old.steps.map((item, i) => (i === index ? updated : item)),
      };
    });
  };

  const setClipNegative = (index: number, checked: boolean) => {
    setRecipe((old) => {
      const target = old.steps[index];
      if (!target) return old;
      const id = getStepId(target);
      const hadExplicitKey = originalClipKeyRef.current.get(id) ?? false;
      let updated: Record<string, unknown>;
      if (checked) {
        updated = { ...target, clip_negative: true };
      } else if (hadExplicitKey) {
        updated = { ...target, clip_negative: false };
      } else {
        const { clip_negative: _omitted, ...withoutClip } = target;
        updated = withoutClip;
      }
      stepIdMapRef.current.set(updated, id);
      return {
        ...old,
        steps: old.steps.map((item, i) => (i === index ? updated : item)),
      };
    });
  };

  const moveStep = (index: number, delta: number) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= recipe.steps.length) return;
    const movedStep = recipe.steps[index];
    const movedId = movedStep ? getStepId(movedStep) : null;
    setRecipe((old) => {
      const target = index + delta;
      if (target < 0 || target >= old.steps.length) return old;
      const steps = [...old.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...old, steps };
    });
    if (
      movedId &&
      ((delta < 0 && targetIndex === 0) ||
        (delta > 0 && targetIndex === recipe.steps.length - 1))
    ) {
      setPendingFocusTarget({ kind: "toggle", id: movedId });
    }
  };

  const removeStep = (index: number) => {
    const target = recipe.steps[index];
    const removedId = target ? getStepId(target) : null;
    const remainingCount = recipe.steps.length - 1;
    let nextFocus: PendingFocusTarget = { kind: "add" };
    if (remainingCount > 0) {
      const neighborIndex = index < recipe.steps.length - 1 ? index + 1 : index - 1;
      const neighborStep = recipe.steps[neighborIndex];
      if (neighborStep) {
        nextFocus = { kind: "toggle", id: getStepId(neighborStep) };
      }
    }
    setRecipe((old) => ({
      ...old,
      steps: old.steps.filter((_, i) => i !== index),
    }));
    if (removedId) {
      originalClipKeyRef.current.delete(removedId);
      setDrafts((previous) => {
        if (!(removedId in previous)) return previous;
        const { [removedId]: _removed, ...next } = previous;
        return next;
      });
      setSelectedStepId((current) => (current === removedId ? null : current));
    }
    setPendingFocusTarget(nextFocus);
  };

  const commitDraft = (
    stepId: string,
    index: number,
    parameter: StepParameter,
    appliedValue: number,
    rawText: string,
  ) => {
    const { minimum, maximum, hint } = parameterBounds(parameter);
    const parsed = Number(rawText);
    if (
      !rawText.trim() ||
      !Number.isFinite(parsed) ||
      parsed < minimum ||
      parsed > maximum
    ) {
      setDrafts((previous) => ({
        ...previous,
        [stepId]: {
          text: rawText,
          error: hint,
          committedValue: appliedValue,
        },
      }));
      return;
    }
    if (!Object.is(parsed, appliedValue)) {
      patchStep(index, { [parameter]: parsed });
    }
    setDrafts((previous) => ({
      ...previous,
      [stepId]: {
        text: rawText,
        error: "",
        committedValue: parsed,
      },
    }));
  };

  const revertDraft = (stepId: string) => {
    setDrafts((previous) => {
      if (!(stepId in previous)) return previous;
      const { [stepId]: _reverted, ...next } = previous;
      return next;
    });
  };

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

  const atStepLimit = recipe.steps.length >= MAX_PROCESSING_STEPS;
  const stepCountLabel =
    recipe.steps.length === 1 ? "1 step" : `${recipe.steps.length} steps`;

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

        {stepEntries.length === 0 ? (
          <p className="preprocess-empty-help">
            No steps configured. Steps run in sequence.
          </p>
        ) : (
          <ol className="preprocess-step-list">
            {stepEntries.map(({ id, step, index, parameter }) => {
              const op = String(step.op ?? "");
              const label = PREPROCESS_LABELS[op] ?? op;
              const isSelected = selectedStepId === id;
              const detailsId = `${baseDetailsId}-${id}`;
              const errorId = `${baseErrorId}-${id}`;

              const appliedValue = parameter ? Number(step[parameter]) : NaN;
              const rawDraft = drafts[id];
              const activeDraft =
                parameter &&
                rawDraft &&
                Object.is(rawDraft.committedValue, appliedValue)
                  ? rawDraft
                  : null;
              const inputText = activeDraft
                ? activeDraft.text
                : parameter
                  ? String(appliedValue)
                  : "";
              const errorText = activeDraft?.error ?? "";
              const isInvalid = Boolean(errorText);
              const bounds = parameter ? parameterBounds(parameter) : null;
              const unitText =
                parameter === "value"
                  ? intensityUnitForStep(index)
                  : parameter
                    ? spatialUnit
                    : "";
              const hasClipOption = supportsClipNegative(op);
              const collapsedSummary = isInvalid
                ? "Invalid"
                : formatCollapsedSummary(step, parameter, spatialUnit);
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
                      onClick={() =>
                        setSelectedStepId((current) =>
                          current === id ? null : id,
                        )
                      }
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
                          setSelectedStepId(null);
                          setPendingFocusTarget({ kind: "toggle", id });
                        }
                      }}
                    >
                      {parameter && bounds ? (
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
                              aria-description={errorText || bounds.hint}
                              aria-describedby={isInvalid ? errorId : undefined}
                              inputMode="decimal"
                              value={inputText}
                              title={errorText || bounds.hint}
                              onChange={(event) =>
                                commitDraft(
                                  id,
                                  index,
                                  parameter,
                                  appliedValue,
                                  event.target.value,
                                )
                              }
                              onBlur={(event) =>
                                commitDraft(
                                  id,
                                  index,
                                  parameter,
                                  appliedValue,
                                  event.target.value,
                                )
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  if (
                                    document.activeElement ===
                                    event.currentTarget
                                  ) {
                                    event.currentTarget.blur();
                                  } else {
                                    commitDraft(
                                      id,
                                      index,
                                      parameter,
                                      appliedValue,
                                      event.currentTarget.value,
                                    );
                                  }
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  revertDraft(id);
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

                      {hasClipOption && (
                        <label className="preprocess-clip-option">
                          <input
                            type="checkbox"
                            checked={Boolean(step.clip_negative)}
                            onChange={(event) =>
                              setClipNegative(index, event.target.checked)
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
                            onClick={() => moveStep(index, -1)}
                          >
                            <ArrowUp size={13} aria-hidden="true" />
                            <span>Up</span>
                          </button>
                          <button
                            type="button"
                            className="preprocess-step-action"
                            aria-label={`Move step ${index + 1} down`}
                            title={`Move step ${index + 1} down`}
                            disabled={index === stepEntries.length - 1}
                            onClick={() => moveStep(index, 1)}
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
                          onClick={() => removeStep(index)}
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
                          onClick={() => addStep(op)}
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
        <button
          type="button"
          className="preprocess-preview-btn"
          disabled={busy || !numbersValid || !configurationValid}
          onClick={onPreview}
        >
          <Scan size={14} aria-hidden="true" />
          Preview selected crop
        </button>
      </div>
    </div>
  );
}
