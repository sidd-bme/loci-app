/** Ephemeral scalar display data. Bound to an opening request and the inspected inventory. */
export type VolumeOpeningPreviewPayload = {
  schema_version: "loci.volume-opening-preview/v1";
  opening_id: string;
  source_inventory_sha256: string;
  context: {
    dimensions_xyz: [number, number, number];
    native_level_dimensions_xyz: [number, number, number];
    source_dimensions_xyz: [number, number, number];
    origin_xyz: [number, number, number];
    spacing_xyz: [number, number, number];
    direction_3x3: [number, number, number, number, number, number, number, number, number];
    affine_4x4: number[][];
    unit: "pixel" | "um";
    frame: "image";
    level: number;
    t: 0;
    scalar_type: "uint8" | "int8" | "uint16" | "int16" | "uint32" | "int32" | "float32";
    source_dtypes: [string];
    encoding_basis: string;
    interleave: "voxel-major";
    components: [{
      channel_index: 0;
      name: string;
      color_rgb: [number, number, number];
      window: { low: number; high: number; gamma: number };
      opacity: number;
      visible: boolean;
      opacity_points: [number, number][];
      provenance: Record<string, string>;
    }];
    data_base64: string;
    byte_length: number;
    data_sha256: string;
  };
};

export type VolumeOpeningPreviewEvent = {
  request_id: string;
  preview: VolumeOpeningPreviewPayload | null;
};

export const VOLUME_OPENING_PREVIEW_MAX_EDGE = 96;
export const VOLUME_OPENING_PREVIEW_MAX_BYTES = VOLUME_OPENING_PREVIEW_MAX_EDGE ** 3 * 4;

export function isVolumeOpeningPreviewRequestId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
