/** Mirrors loci.volume-view/v1 in engine/volume_view_state.py. Display-only state. */
export type VolumePane = "volume" | "axial" | "coronal" | "sagittal";
export type VolumeVec3 = [number, number, number];
export interface VolumeResultBinding {
  result_id: string;
  revision_hash: string;
  label_sha256: string;
}
export interface VolumeViewState {
  t: number;
  channels: number[];
  result: VolumeResultBinding | null;
  selected_object: (VolumeResultBinding & { label_id: number }) | null;
  representation: {
    mode: "volume" | "mpr";
    extent: "context" | "focus";
    render_mode: "blend" | "normal_shading" | "mip" | "average" | "minip";
    quality: number;
  };
  camera: {
    projection: "parallel" | "perspective";
    position_xyz: VolumeVec3;
    focal_point_xyz: VolumeVec3;
    view_up_xyz: VolumeVec3;
    clipping_range: [number, number];
    view_angle_degrees: number;
    parallel_scale: number | null;
    frame: string;
    unit: string;
  } | null;
  crosshair_source_xyz: VolumeVec3;
  clipping: { enabled: boolean; axis: "x" | "y" | "z"; position_percent: number };
  refinement: { target_long_axis: number; focus_region_xyzxyz: [number, number, number, number, number, number] | null };
  layout: { mode: "four" | "single"; expanded_pane: VolumePane | null; pane_order: VolumePane[]; col_split: number; row_split: number };
  labels: { visible: boolean; opacity: number; selected_only: boolean };
}
export interface VolumeViewDocument {
  schema: "loci.volume-view/v1";
  source_id: string;
  source_sha256: string;
  geometry_sha256: string;
  revision: number;
  display_revision: number;
  state: VolumeViewState | null;
}
export interface VolumeLiveToken {
  view_id: string;
  renderer_generation: number;
  live_epoch: number;
  revision: number;
  display_revision: number;
}
export interface VolumeSceneSnapshot {
  state: VolumeViewState;
  liveEpoch: number;
  rendererGeneration: number;
  busy: boolean;
  available: boolean;
}
export interface VolumeSceneCapture {
  image: string;
  manifest: Record<string, unknown>;
  width: number;
  height: number;
}
export interface VolumeSceneAdapter {
  snapshot(): VolumeSceneSnapshot | null;
  /** Resolve only when the exact target is rendered. Preserve live epoch/generation. */
  apply(state: VolumeViewState): Promise<void>;
  capture(panes: VolumePane[], maxSize: number): Promise<VolumeSceneCapture>;
  /** Prevent new gestures; must not clear an existing busy gesture or change tokens. */
  lock(locked: boolean): void;
}
