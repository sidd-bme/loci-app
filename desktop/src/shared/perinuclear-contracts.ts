import type { ResearchResult } from "./research-contracts";

export const PERINUCLEAR_EXCLUSIONS = [
  "boundary-touching-nucleus", "empty-ring", "zero-mean-ring",
] as const;
export type PerinuclearExclusion = typeof PERINUCLEAR_EXCLUSIONS[number];
export interface ResearchPerinuclearSummary {
  object_count: number;
  eligible_count: number;
  excluded_count: number;
  excluded_by_reason: Record<PerinuclearExclusion, number>;
  endpoint_defined: boolean;
  median_ratio: number | null;
  mean_ratio: number | null;
}
export interface ResearchPerinuclearRow extends Record<string, unknown> {
  label: number;
  voxel_count: number;
  intensity: Record<string, { mean: number; sum: number; min: number; max: number; std_population: number }>;
  perinuclear_ring: {
    count: number;
    sum: number;
    mean: number | null;
    nuclear_to_ring_mean_ratio: number | null;
    exclusions: PerinuclearExclusion[];
  };
}
export interface ResearchPerinuclearRequest {
  result_id: string;
  revision_hash: string;
  signal_channel: number;
  radius_px: number;
  working_bytes: number;
  control: string;
}
export const PERINUCLEAR_RULES = {
  signal_policy: "nonnegative raw selected-plane samples; reject negatives without clipping or offset",
  distance_basis: "Euclidean pixel-center distance on native YX indices; inclusive radius",
  overlap_policy: "discard every pixel claimed by more than one nucleus",
  nucleus_policy: "all positive nucleus labels block and compete, including excluded nuclei",
  boundary_policy: "exclude nuclei touching the full source image boundary",
  empty_policy: "empty ring count/sum zero and mean null; excluded ratio null",
  zero_policy: "zero-mean rings excluded; no epsilon, imputation or intensity gate",
  interpretation: "nuclear-to-perinuclear-ring enrichment proxy; not true cytoplasm",
  endpoint: "median of eligible per-object nuclear-mean / ring-mean raw signal ratios",
} as const;
export interface ResearchPerinuclearRecord extends Readonly<typeof PERINUCLEAR_RULES> {
  schema: "loci.perinuclear-enrichment/v1";
  radius_px: number;
  control: string;
  signal_channel: number;
  nucleus_result: { result_id: string; revision_hash: string };
  summary: ResearchPerinuclearSummary;
}
export interface ResearchPerinuclearResponse {
  adopted: true;
  result: ResearchResult;
  measurements: ResearchPerinuclearRow[];
  total_measurements: number;
  summary: ResearchPerinuclearSummary;
  perinuclear: ResearchPerinuclearRecord;
}
export const PERINUCLEAR_VIEWS = {
  nuclei: { label: "Nuclei (all)", basis: "original nucleus labels, including endpoint exclusions" },
  rings: { label: "Perinuclear rings (proxy)", basis: "unique perinuclear ring pixels; geometric proxy, not cytoplasm" },
  ambiguous: { label: "Shared ring pixels (excluded)", basis: "multiply claimed ring pixels discarded from every ring" },
} as const;
export type ResearchPerinuclearViewField = keyof typeof PERINUCLEAR_VIEWS;
export interface ResearchPerinuclearView {
  result_id: string;
  revision_hash: string;
  axis: "z";
  index: 0;
  shape: [number, number];
  geometry: ResearchResult["geometry"];
  image: string;
  label_image: string;
  label_field: ResearchPerinuclearViewField;
  label_field_basis: string;
}
