import type { CellposeProfileId } from "../shared/contracts";

const CELLPOSE_MODEL_REVISION = "7c61431b5fbb078f3296754bd15d9f51b320f837";

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
