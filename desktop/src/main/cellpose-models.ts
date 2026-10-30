import type { CellposeProfileId } from "../shared/contracts";
import type { PinnedModelArtifact } from "./model-download";

const CELLPOSE_MODEL_REVISION = "7c61431b5fbb078f3296754bd15d9f51b320f837";

// Official revision metadata, independently matched to the engine's immutable
// checkpoint registry. Adding a CDN origin requires another source review.
export const CELLPOSE_DOWNLOADS: readonly PinnedModelArtifact[] = [
  { id: "cpsam", sha256: "e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2", sizeBytes: 1_233_587_898 },
  { id: "cpsam_v2", sha256: "0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667", sizeBytes: 1_233_586_851 },
].map((artifact) => ({ ...artifact,
  url: `https://huggingface.co/mouseland/cellpose-sam/resolve/${CELLPOSE_MODEL_REVISION}/${artifact.id}`,
  redirectOrigins: ["https://us.aws.cdn.hf.co"],
}));

export const CELLPOSE_MODELS = {
  "cellpose-sam": {
    artifactId: "cpsam",
    label: "Cellpose-SAM website-compatible",
    page: `https://huggingface.co/mouseland/cellpose-sam/blob/${CELLPOSE_MODEL_REVISION}/cpsam`,
  },
  "cellpose-sam-v2": {
    artifactId: "cpsam_v2",
    label: "Cellpose-SAM v2",
    page: `https://huggingface.co/mouseland/cellpose-sam/blob/${CELLPOSE_MODEL_REVISION}/cpsam_v2`,
  },
} as const satisfies Record<CellposeProfileId, {
  artifactId: string;
  label: string;
  page: string;
}>;

export function requireCellposeProfileId(value: unknown): CellposeProfileId {
  if (typeof value !== "string" || !Object.hasOwn(CELLPOSE_MODELS, value)) {
    throw new Error("The Cellpose model selection is invalid.");
  }
  return value as CellposeProfileId;
}

export function assertCellposeStatusMatches(
  requestedProfileId: CellposeProfileId,
  responseProfileId: CellposeProfileId,
  responseArtifactId: string,
): void {
  if (
    responseProfileId !== requestedProfileId ||
    responseArtifactId !== CELLPOSE_MODELS[requestedProfileId].artifactId
  ) {
    throw new Error("The Cellpose runtime returned status for a different model.");
  }
}
