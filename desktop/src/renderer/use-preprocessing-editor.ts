import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { MAX_PREPROCESS_DRAFT_LENGTH, type PreprocessDraft, type PreprocessEditorEdit,
  type PreprocessEditorView, type PreprocessOp, type PreprocessRow, type StepParameter } from "../shared/preprocess-inspector-api";
import type { ResearchRecipe } from "../shared/research-contracts";

export const MAX_PROCESSING_STEPS = 32;

type Step = ResearchRecipe["steps"][number];
type Draft = PreprocessDraft & { applied: number };
type Focus = NonNullable<PreprocessEditorView["focus"]>;
type EditorState = {
  scope: string;
  selected?: number | null;
  drafts: Record<number, Draft>;
  focus: Focus | null;
};

function stepParameterFor(step: Step): StepParameter | null {
  const op = String(step.op ?? "");
  if (op === "flatfield") return null;
  if ("sigma" in step || op === "gaussian" || op === "subtract_background") return "sigma";
  if ("radius" in step || op === "median" || op === "opening" || op === "closing") return "radius";
  return "value" in step || op === "subtract_constant" ? "value" : null;
}

function supportsClipNegative(op: string): boolean {
  return op === "subtract_background" || op === "subtract_constant" || op === "flatfield";
}

export function parameterBoundsHint(parameter: StepParameter): string {
  return parameter === "value" ? "Enter a finite value from -1000000000000000 to 1000000000000000."
    : "Enter a finite value from 0 to 1000000.";
}

function numberDraft(parameter: StepParameter, text: string, applied: number): Draft {
  const [minimum, maximum] = parameter === "value" ? [-1e15, 1e15] : [0, 1e6];
  const parsed = Number(text);
  return text.trim() && Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? { text, applied: parsed, error: "" }
    : { text, applied, error: parameterBoundsHint(parameter) };
}

function defaultStepFor(op: PreprocessOp): Step {
  if (op === "gaussian" || op === "subtract_background") return { op, sigma: 1 };
  if (op === "subtract_constant") return { op, value: 0 };
  return { op, radius: 1 };
}

/** The workbench owns drafts and row identity across both presentations. */
export function usePreprocessingEditor(
  recipe: ResearchRecipe,
  setRecipe: Dispatch<SetStateAction<ResearchRecipe>>,
  numberKey: string,
) {
  const identity = useRef(new WeakMap<Step, { id: number; explicitClip: boolean }>());
  const nextId = useRef(1);
  const focusRevision = useRef(0);
  const idFor = (step: Step) => {
    const existing = identity.current.get(step);
    if (existing) return existing;
    const created = { id: nextId.current++, explicitClip: Object.hasOwn(step, "clip_negative") };
    identity.current.set(step, created);
    return created;
  };
  const [state, setState] = useState<EditorState>(() => ({ scope: numberKey, drafts: {}, focus: null }));

  const view = useMemo<PreprocessEditorView>(() => {
    const rows = recipe.steps.map((step): PreprocessRow => {
      const { id } = idFor(step);
      const parameter = stepParameterFor(step);
      const value = parameter ? Number(step[parameter]) : NaN;
      const draft = state.drafts[id];
      const op = String(step.op ?? "");
      return { id, op, parameter, value,
        ...(draft && Object.is(draft.applied, value) ? { draft: { text: draft.text, error: draft.error } } : {}),
        ...(supportsClipNegative(op) ? { clipNegative: Boolean(step.clip_negative) } : {}) };
    });
    const selected = state.selected === undefined ? rows[0]?.id ?? null
      : rows.some((row) => row.id === state.selected) ? state.selected : null;
    return { rows, selected, focus: state.focus };
  }, [recipe.steps, state]);

  // Retire drafts when the numeric scope changes or the owner replaces a row.
  if (state.scope !== numberKey) {
    setState({ scope: numberKey, drafts: {}, focus: null });
  } else if (Object.keys(state.drafts).some((id) => !view.rows.some((row) => row.id === Number(id)))) {
    setState({ ...state, drafts: Object.fromEntries(Object.entries(state.drafts)
      .filter(([id]) => view.rows.some((row) => row.id === Number(id)))) });
  }

  const apply = (edit: PreprocessEditorEdit): boolean => {
    if (edit.kind === "add") {
      if (recipe.steps.length >= MAX_PROCESSING_STEPS) return false;
      const step = defaultStepFor(edit.op);
      const { id } = idFor(step);
      const focus: Focus = { kind: "input", id, revision: ++focusRevision.current };
      setRecipe((previous) => ({ ...previous, steps: [...previous.steps, step] }));
      setState((previous) => ({ ...previous, selected: id, focus }));
      return true;
    }
    const index = view.rows.findIndex((row) => row.id === edit.id);
    if (index < 0) return false;
    const row = view.rows[index];
    const original = recipe.steps[index];
    const updateStep = (updated: Step) => {
      identity.current.set(updated, idFor(original));
      setRecipe((previous) => ({ ...previous, steps: previous.steps.map((step) => step === original ? updated : step) }));
    };
    const removeDraft = (previous: EditorState) => {
      const { [row.id]: _removed, ...drafts } = previous.drafts;
      return drafts;
    };
    switch (edit.kind) {
      case "select":
        setState((previous) => ({ ...previous, selected: view.selected === row.id ? null : row.id }));
        return true;
      case "draft": {
        if (!row.parameter || edit.text.length > MAX_PREPROCESS_DRAFT_LENGTH) return false;
        const draft = numberDraft(row.parameter, edit.text, row.value);
        if (!draft.error && !Object.is(draft.applied, row.value)) updateStep({ ...original, [row.parameter]: draft.applied });
        setState((previous) => ({ ...previous, drafts: { ...previous.drafts, [row.id]: draft } }));
        return true;
      }
      case "revert":
        setState((previous) => ({ ...previous, drafts: removeDraft(previous) }));
        return true;
      case "clip": {
        if (row.clipNegative === undefined) return false;
        if (edit.checked || idFor(original).explicitClip) updateStep({ ...original, clip_negative: edit.checked });
        else {
          const { clip_negative: _omitted, ...withoutClip } = original;
          updateStep(withoutClip);
        }
        return true;
      }
      case "move": {
        const to = index + edit.delta;
        if (to < 0 || to >= recipe.steps.length) return false;
        setRecipe((previous) => {
          const from = previous.steps.indexOf(original);
          const target = from + edit.delta;
          if (from < 0 || target < 0 || target >= previous.steps.length) return previous;
          const steps = [...previous.steps];
          [steps[from], steps[target]] = [steps[target], steps[from]];
          return { ...previous, steps };
        });
        if (to === 0 || to === recipe.steps.length - 1) {
          const focus: Focus = { kind: "toggle", id: row.id, revision: ++focusRevision.current };
          setState((previous) => ({ ...previous, focus }));
        }
        return true;
      }
      case "remove": {
        const neighbor = view.rows[index + 1] ?? view.rows[index - 1];
        const revision = ++focusRevision.current;
        const focus: Focus = neighbor ? { kind: "toggle", id: neighbor.id, revision } : { kind: "add", revision };
        setRecipe((previous) => ({ ...previous, steps: previous.steps.filter((step) => step !== original) }));
        setState((previous) => ({ ...previous, drafts: removeDraft(previous),
          selected: view.selected === row.id ? null : view.selected, focus }));
        return true;
      }
    }
  };
  return { view, apply, valid: !view.rows.some((row) => row.draft?.error) };
}
