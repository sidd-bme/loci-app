import type { ResearchResult } from "../shared/research-contracts";

const labels: Record<string, string> = {
  "external-labels": "Imported labels", "corrected-labels": "Corrected segmentation", "large-corrected-labels": "Corrected segmentation",
  "large-segmentation": "Threshold segmentation",
  "large-components": "Threshold segmentation",
  "adaptive-segmentation": "Adaptive watershed segmentation", "cellpose-segmentation": "Cellpose segmentation",
  "model-segmentation": "Model segmentation", "cell-segmentation": "Cell segmentation",
  processed: "Image processing", "annotated-result": "Annotated result", puncta: "Puncta detection",
  "declared-stain-analysis": "Declared stain analysis", "tissue-region-mask": "Tissue region mask",
  "puncta-quantification": "Puncta detection", "nucleus-cell-association": "Nucleus-cell association",
  "field-assay": "Fluorescence field assay",
  tracking: "Object tracking", "temporal-tracking": "Object tracking",
  registration: "Image registration", "registered-derived": "Registered image", "resampled-derived": "Resampled image", colocalisation: "Colocalisation measurement",
  segmentation: "Segmentation",
};

export function resultTitle(result: ResearchResult): string {
  return (result as ResearchResult & { method_label?: string }).method_label ??
    (Object.hasOwn(labels, result.kind) ? labels[result.kind] : "Analysis result");
}
