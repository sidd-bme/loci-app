import type { ImageViewTargetSnapshot } from "./image-view-contracts";
import type { ResearchExecuteOptions, ResearchSelection, ResearchSource, VolumeFigureExportRequest, VolumeFigureExportReceipt } from "./research-contracts";

/** Bounded display state. Scientific records remain in the study. */
export interface ImageWindowPresentation {
  interpretation?: "auto" | "generic" | "histology" | "fluorescence" | "volume" | "medical";
  volumeDisplay?: { renderMode: "blend" | "normal_shading" | "mip" | "average" | "minip"; quality: number };
  mode: "plane" | "volume";
  selection: ResearchSelection;
  channels: Array<{ channel: number; low?: number; high?: number; gamma: number;
    visible: boolean; color: string; opacity?: number }>;
  projection: "plane" | "max" | "mean";
  tool: "navigate" | "point" | "line" | "polygon" | "freehand" | "rectangle" | "transect";
  draft: Array<{ x: number; y: number }>;
  annotations: Array<{ id: string; kind: "point" | "line" | "polygon" | "rectangle";
    points: Array<{ x: number; y: number }>; label: string; color: string; z: number; t: number }>;
  camera: { x: number; y: number; scale: number } | null;
  showScaleBar: boolean;
  showNavigator: boolean;
}

export interface ImageWindowEntry {
  target: ImageViewTargetSnapshot;
  source: ResearchSource;
  label: string;
  status: "ready" | "crashed";
  fullscreen?: boolean;
  initialPresentation?: ImageWindowPresentation;
}

export interface ImageWindowState {
  role: "control" | "image";
  views: ImageWindowEntry[];
  target: ImageViewTargetSnapshot | null;
  pinned: boolean;
  layoutError?: string;
}

export interface ImageWindowPresentationEvent {
  target: ImageViewTargetSnapshot;
  presentation: ImageWindowPresentation;
}

export type ImageWindowInteraction =
  | { kind: "volume-display"; channels: ImageWindowPresentation["channels"]; renderMode: NonNullable<ImageWindowPresentation["volumeDisplay"]>["renderMode"]; quality: number }
  | { kind: "draft"; points: Array<{ x: number; y: number }>; plane: { t: number; z: number } }
  | { kind: "camera"; camera: { x: number; y: number; scale: number } }
  | { kind: "error"; message: string };

export interface ImageWindowApi {
  state(): Promise<ImageWindowState>;
  open(sourceId: string, seed?: { sourceSha256: string; presentation: ImageWindowPresentation }): Promise<ImageWindowState>;
  restore(): Promise<ImageWindowState>;
  close(target: ImageViewTargetSnapshot): Promise<void>;
  closeAll(): Promise<void>;
  reopen(target: ImageViewTargetSnapshot): Promise<void>;
  pin(target: ImageViewTargetSnapshot | null): Promise<void>;
  focus(target: ImageViewTargetSnapshot | null): Promise<void>;
  fullscreen(target: ImageViewTargetSnapshot, fullscreen: boolean): Promise<void>;
  publish(target: ImageViewTargetSnapshot, presentation: ImageWindowPresentation): Promise<void>;
  presentation(): Promise<ImageWindowPresentationEvent | null>;
  interact(target: ImageViewTargetSnapshot, interaction: ImageWindowInteraction): Promise<void>;
  execute(target: ImageViewTargetSnapshot, operation: string, request: unknown,
    options?: ResearchExecuteOptions): Promise<unknown>;
  cancel(target: ImageViewTargetSnapshot): Promise<void>;
  exportFigure(target: ImageViewTargetSnapshot, request: VolumeFigureExportRequest): Promise<VolumeFigureExportReceipt | null>;
  onState(listener: (state: ImageWindowState) => void): () => void;
  onPresentation(listener: (event: ImageWindowPresentationEvent) => void): () => void;
  onInteraction(listener: (event: { target: ImageViewTargetSnapshot; interaction: ImageWindowInteraction }) => void): () => void;
}

declare global {
  interface Window { lociImageWindows?: ImageWindowApi }
}
