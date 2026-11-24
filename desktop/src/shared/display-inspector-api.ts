import type { PanelOpenOptions } from "./panel-open-options";
import type { ResearchSelection, ResearchSource } from "./research-contracts";
import type { PreprocessInspectorEdit, PreprocessInspectorSnapshot } from "./preprocess-inspector-api";

export type DisplayProjection = "plane" | "max" | "mean";
export type SourceInterpretation = "auto" | "generic" | "histology" | "fluorescence" | "volume" | "medical";

export type DisplayChannel = {
  channel: number;
  low?: number;
  high?: number;
  gamma: number;
  visible: boolean;
  color: string;
  opacity?: number;
};
export type ChannelEdit =
  | { field: "visible"; value: boolean }
  | { field: "color"; value: string }
  | { field: "low" | "high" | "window" | "level" | "gamma" | "opacity"; value: number };

export type DisplayInspectorTarget = {
  kind?: "preprocess";
  sourceId: string;
  sourceSha256: string;
  studyGeneration: number;
  documentGeneration: number;
};
export type DisplayInspectorBinding = DisplayInspectorTarget & { generation: number };

export type DisplayInspectorSnapshot = {
  kind?: never;
  source: Pick<ResearchSource, "id" | "sha256" | "name" | "source_kind"> & {
    metadata: Pick<ResearchSource["metadata"], "dimensions" | "axes" | "sample_semantics" |
      "physical_calibration" | "palette" | "channel_names" | "channel_dtypes">;
  };
  selection: ResearchSelection;
  channels: DisplayChannel[];
  projection: DisplayProjection;
  interpretation: SourceInterpretation;
  rgbMapping: [number, number, number] | null;
  viewReady: boolean;
};

export type DisplayInspectorAction =
  | { kind: "channel"; channel: number; edit: ChannelEdit }
  | { kind: "plane"; axis: "z" | "t" | "c"; value: number }
  | { kind: "projection"; value: DisplayProjection }
  | { kind: "auto"; channel?: number; plane: Pick<ResearchSelection, "t" | "c" | "z"> }
  | { kind: "reset" }
  | { kind: "compare"; active: boolean };

export type InspectorAction = DisplayInspectorAction | { kind: "preprocess"; request: number; edit: PreprocessInspectorEdit };
export type InspectorSnapshot = DisplayInspectorSnapshot | PreprocessInspectorSnapshot;

export type DisplayInspectorState = {
  binding: DisplayInspectorBinding;
  sequence: number;
  rejectedSequence?: number;
  acknowledgedRequest?: number;
  dockRequested?: boolean;
  snapshot: InspectorSnapshot;
};
export type DisplayInspectorLifecycle = {
  binding: DisplayInspectorBinding;
  status: "opening" | "open" | "closed";
  reason?: "dock" | "native-close" | "unavailable" | "display-removed" | "revoked";
};

export const DISPLAY_INSPECTOR_IPC = "loci-display-inspector:";

export interface DisplayInspectorApi {
  state(): Promise<DisplayInspectorState>;
  edit(binding: DisplayInspectorBinding, action: InspectorAction): Promise<void>;
  dock(binding: DisplayInspectorBinding, interrupted?: true): Promise<void>;
  onState(listener: (state: DisplayInspectorState) => void): () => void;
}

export interface DisplayInspectorOwnerApi {
  open(target: DisplayInspectorTarget, snapshot: InspectorSnapshot, options?: PanelOpenOptions): Promise<DisplayInspectorBinding>;
  publish(binding: DisplayInspectorBinding, snapshot: InspectorSnapshot, rejected?: boolean, request?: number): Promise<void>;
  focus(binding: DisplayInspectorBinding): Promise<void>;
  dock(binding: DisplayInspectorBinding): Promise<void>;
  revoke(binding: DisplayInspectorBinding): Promise<void | "unavailable">;
  onLifecycle(listener: (value: DisplayInspectorLifecycle) => void): () => void;
  onEdit(listener: (value: { binding: DisplayInspectorBinding; action: InspectorAction }) => void): () => void;
}

export function sameDisplayTarget(a: DisplayInspectorTarget | null, b: DisplayInspectorTarget | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.sourceId === b.sourceId && a.sourceSha256 === b.sourceSha256 &&
    a.studyGeneration === b.studyGeneration && a.documentGeneration === b.documentGeneration;
}

declare global {
  interface Window {
    lociDisplayInspector?: DisplayInspectorApi;
    lociDisplayInspectorOwner?: DisplayInspectorOwnerApi;
  }
}
