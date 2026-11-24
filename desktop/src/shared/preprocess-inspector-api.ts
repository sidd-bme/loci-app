import type { ResearchDimensions, ResearchSelection } from "./research-contracts";

export const PREPROCESS_OPS = ["gaussian", "median", "subtract_background", "subtract_constant", "opening", "closing"] as const;
export const MAX_PREPROCESS_DRAFT_LENGTH = 128;

export type PreprocessOp = typeof PREPROCESS_OPS[number];
export type StepParameter = "sigma" | "radius" | "value";
export type PreprocessDraft = { text: string; error: string };

export type PreprocessRow = {
  id: number;
  op: string;
  parameter: StepParameter | null;
  value: number;
  draft?: PreprocessDraft;
  clipNegative?: boolean;
};

export type PreprocessEditorView = {
  rows: PreprocessRow[];
  selected: number | null;
  focus: ({ kind: "input" | "toggle"; id: number } | { kind: "add" }) & { revision: number } | null;
};

export type PreprocessEditorEdit =
  | { kind: "add"; op: PreprocessOp }
  | { kind: "select" | "remove" | "revert"; id: number }
  | { kind: "draft"; id: number; text: string }
  | { kind: "clip"; id: number; checked: boolean }
  | { kind: "move"; id: number; delta: -1 | 1 };

export type PreprocessInspectorEdit = PreprocessEditorEdit
  | { kind: "preview" | "whole" | "draw" | "cancel-draw" | "restore-numbers"; revision: number };

export type PreprocessInspectorSnapshot = {
  kind: "preprocess";
  source: { id: string; sha256: string; name: string };
  dimensions: ResearchDimensions;
  selection: ResearchSelection;
  spatialUnit: string;
  drawing: boolean;
  revision: number;
  editor: PreprocessEditorView;
  previewDisabled: boolean;
  restoreNumbers?: boolean;
};
