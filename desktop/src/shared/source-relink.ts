import type { ResearchSource } from "./research-contracts";

/** The picker route follows declared source identity, never filename appearance. */
export function sourceRelinkKind(source: ResearchSource): "file" | "dicom" | "ome_zarr" {
  if (source.source_kind === "ome_zarr") return "ome_zarr";
  if (source.source_kind === "medical" && source.relink_hint?.selection_kind === "series") return "dicom";
  return "file";
}
