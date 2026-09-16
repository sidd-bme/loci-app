import {
  MODEL_MANIFEST_SCHEMA,
  VALIDATION_REPORT_SCHEMA,
  type ModelManifest,
  type ValidationReport,
} from "./foundation-contracts";
import {
  FoundationValidationError,
  validateModelManifest,
  validateValidationReport,
} from "./foundation-validation";
import type { CellposeSettings } from "./contracts";

export const CELLPOSE_RUNTIME_VERSION = "4.2.1.1" as const;
export const CELLPOSE_MODEL_REVISION =
  "7c61431b5fbb078f3296754bd15d9f51b320f837" as const;
export const CELLPOSE_SAM_SHA256 =
  "e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2" as const;
export const CELLPOSE_SAM_SIZE_BYTES = 1_233_587_898 as const;
export const CELLPOSE_SAM_V2_SHA256 =
  "0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667" as const;
export const CELLPOSE_SAM_V2_SIZE_BYTES = 1_233_586_851 as const;
export const CELLPOSE_WEBSITE_COMPATIBILITY_SETTINGS: Readonly<CellposeSettings> =
  Object.freeze({
    max_edge_px: 1000,
    diameter_px: 0,
    flow_threshold: 0.4,
    cellprob_threshold: 0,
    min_size_px: 15,
    max_size_fraction: 0.4,
    niter: 250,
    batch_size: 8,
    resample: true,
    augment: false,
    tile_overlap: 0.1,
    normalize: true,
    percentile_low: 1,
    percentile_high: 99,
    tile_norm_blocksize: 0,
    sharpen_radius: 0,
    smooth_radius: 0,
    invert: false,
    device: "auto",
  });
export const CELLPOSE_WEBSITE_COMPATIBILITY_SETTINGS_SHA256 =
  "94bd17aee3e1b4b2d6667721e74d7d5cbc9c16f4f8407d45fb6a81c21e3bceaf" as const;

const CELLPOSE_CODE_LICENSE = "BSD-3-Clause";
const CELLPOSE_CHECKPOINT_LICENSE =
  "BSD-3-Clause repository declaration; CC-BY-NC training-data lineage caveat";
const CELLPOSE_TRAINING_LINEAGE =
  "MouseLand declares the checkpoint repository BSD-3-Clause and also states that official Cellpose models were trained on CC-BY-NC datasets. Loci does not treat the checkpoint as cleared for bundling, redistribution, paid inference, or commercial fine-tuning without written rights-holder clarification.";
const CELLPOSE_FAILURE_MODES = [
  "Morphology alone cannot establish whether a segmented cell is alive.",
  "Performance can shift with cell type, optics, focus, density, staining, and acquisition settings.",
  "Dense touching clusters may merge or split incorrectly and require boundary review.",
  "Higher-bit-depth and floating-point inputs use a dynamic-range-preserving path and are not claimed to reproduce the public Space pixel path.",
];

const WEBSITE_COMPATIBILITY_REPORT_ID =
  "cellpose-sam-website-compatibility-2026-08-30";

const MODEL_MANIFEST_DEFINITIONS: readonly ModelManifest[] = [
  {
    schemaVersion: MODEL_MANIFEST_SCHEMA,
    modelId: "loci-classical",
    name: "Loci Adaptive Watershed",
    version: "0.1.0",
    artifact: {
      sha256: null,
      sizeBytes: null,
      bundled: false,
      sourceUrl: null,
    },
    runtime: {
      backend: "loci-engine:adaptive-watershed",
      requiredVersion: "0.1.0",
    },
    intendedDomain: {
      summary:
        "Deterministic 2D morphology baseline for visible cell-like instances in routine microscopy. Experimental technical QA only; it is not validated for biological accuracy or viability.",
      modalities: ["2D brightfield microscopy", "2D fluorescence microscopy"],
      organisms: ["not biologically constrained or validated"],
      channels: ["single intensity plane or RGB converted to intensity"],
      pixelSize: null,
    },
    preprocessing: [
      "Profile-selected grayscale conversion and polarity handling.",
      "Bounded smoothing and thresholding controlled by the recorded analysis settings.",
    ],
    postprocessing: [
      "Morphological cleanup, optional watershed splitting, and minimum-area filtering.",
      "Labels are restored on the source pixel grid before review and export.",
    ],
    rights: {
      codeLicense: "Apache-2.0",
      checkpointLicense: "Not applicable; this profile has no learned checkpoint.",
      redistribution: "permitted",
      commercialUse: "permitted",
      trainingDataLineage: "Not applicable; deterministic image processing with no training data.",
    },
    evidenceStatus: "experimental",
    validationReportIds: [],
    knownFailureModes: [
      "Threshold-based morphology can miss low-contrast instances or include debris.",
      "Touching cells may remain merged or be over-split.",
      "Performance is sensitive to acquisition conditions and user-selected scale settings.",
      "Morphology alone cannot establish viability or biological cell identity.",
    ],
  },
  {
    schemaVersion: MODEL_MANIFEST_SCHEMA,
    modelId: "cellpose-sam",
    name: "Cellpose-SAM · Website compatible",
    version: CELLPOSE_RUNTIME_VERSION,
    artifact: {
      sha256: CELLPOSE_SAM_SHA256,
      sizeBytes: CELLPOSE_SAM_SIZE_BYTES,
      bundled: false,
      sourceUrl: `https://huggingface.co/mouseland/cellpose-sam/blob/${CELLPOSE_MODEL_REVISION}/cpsam`,
    },
    runtime: {
      backend: "cellpose",
      requiredVersion: `cellpose==${CELLPOSE_RUNTIME_VERSION}`,
    },
    intendedDomain: {
      summary:
        "Optional interoperability profile for visible 2D cell-like instances. Experimental evidence supports close behavior to the audited public Cellpose Space on one routine uint8 image; it does not establish biological accuracy, broad-domain performance, or viability.",
      modalities: ["routine 2D microscopy; technical compatibility evidence only"],
      organisms: ["not constrained by the available compatibility evidence"],
      channels: ["grayscale or RGB converted by the pinned profile"],
      pixelSize: null,
    },
    preprocessing: [
      "Routine uint8 inputs use the audited Space-compatible OpenCV uint8 resize path with a 1,000 px maximum edge.",
      "Other dtypes preserve dynamic range and are not claimed to be pixel-equivalent to the public Space.",
      "Cellpose percentile normalization defaults to the recorded 1st and 99th percentiles.",
    ],
    postprocessing: [
      "Pinned defaults use 250 dynamics iterations, flow threshold 0.4, cell-probability threshold 0.0, and minimum size 15 px.",
      "Integer instance labels are restored to the source grid with nearest-neighbour interpolation.",
    ],
    rights: {
      codeLicense: CELLPOSE_CODE_LICENSE,
      checkpointLicense: CELLPOSE_CHECKPOINT_LICENSE,
      redistribution: "unknown",
      commercialUse: "restricted",
      trainingDataLineage: CELLPOSE_TRAINING_LINEAGE,
    },
    evidenceStatus: "experimental",
    validationReportIds: [WEBSITE_COMPATIBILITY_REPORT_ID],
    knownFailureModes: [...CELLPOSE_FAILURE_MODES],
  },
  {
    schemaVersion: MODEL_MANIFEST_SCHEMA,
    modelId: "cellpose-sam-v2",
    name: "Cellpose-SAM v2",
    version: CELLPOSE_RUNTIME_VERSION,
    artifact: {
      sha256: CELLPOSE_SAM_V2_SHA256,
      sizeBytes: CELLPOSE_SAM_V2_SIZE_BYTES,
      bundled: false,
      sourceUrl: `https://huggingface.co/mouseland/cellpose-sam/blob/${CELLPOSE_MODEL_REVISION}/cpsam_v2`,
    },
    runtime: {
      backend: "cellpose",
      requiredVersion: `cellpose==${CELLPOSE_RUNTIME_VERSION}`,
    },
    intendedDomain: {
      summary:
        "Optional generalist Cellpose-SAM v2 profile for visible 2D cell-like instances. This exact checkpoint is unvalidated in Loci and must not be described as better, recommended, or suitable for a biological domain until it passes locked evaluation.",
      modalities: ["2D microscopy; no Loci-validated domain"],
      organisms: ["not validated"],
      channels: ["grayscale or RGB converted by the pinned profile"],
      pixelSize: null,
    },
    preprocessing: [
      "Routine uint8 inputs use the audited Space-compatible OpenCV uint8 resize path with a 1,000 px maximum edge.",
      "Other dtypes preserve dynamic range and are not claimed to be pixel-equivalent to the public Space.",
      "Cellpose percentile normalization defaults to the recorded 1st and 99th percentiles.",
    ],
    postprocessing: [
      "Initial defaults match the public control values but are not a tuned or validated v2 profile.",
      "Integer instance labels are restored to the source grid with nearest-neighbour interpolation.",
    ],
    rights: {
      codeLicense: CELLPOSE_CODE_LICENSE,
      checkpointLicense: CELLPOSE_CHECKPOINT_LICENSE,
      redistribution: "unknown",
      commercialUse: "restricted",
      trainingDataLineage: CELLPOSE_TRAINING_LINEAGE,
    },
    evidenceStatus: "unvalidated",
    validationReportIds: [],
    knownFailureModes: [
      ...CELLPOSE_FAILURE_MODES,
      "A higher or lower instance count than another profile is not evidence of better biological accuracy.",
    ],
  },
];

const VALIDATION_REPORT_DEFINITIONS: readonly ValidationReport[] = [
  {
    schemaVersion: VALIDATION_REPORT_SCHEMA,
    reportId: WEBSITE_COMPATIBILITY_REPORT_ID,
    modelId: "cellpose-sam",
    modelSha256: CELLPOSE_SAM_SHA256,
    createdAt: "2026-08-30T00:00:00.000Z",
    evidenceStatus: "experimental",
    declaredDomain:
      "Technical reproduction of the audited Cellpose Space behavior on one supplied dense-cell uint8 image with the original cpsam checkpoint.",
    dataset: {
      name: "Audited Cellpose Space compatibility fixture",
      version: "2026-08-30",
      splitPolicy:
        "Fixed one-image technical reproduction; no fitting, threshold tuning, biological test split, or accuracy claim.",
      unitOfIndependence: "one supplied image; no biological independence claim",
      sampleCount: 1,
    },
    frozenConfigurationSha256: CELLPOSE_WEBSITE_COMPATIBILITY_SETTINGS_SHA256,
    metrics: [
      {
        id: "absolute-instance-count-difference",
        value: 4,
        unit: "instances",
        higherIsBetter: false,
      },
      {
        id: "foreground-iou",
        value: 0.986,
        unit: "fraction",
        higherIsBetter: true,
      },
    ],
    gates: [],
    strata: [],
    knownFailureModes: [
      "The reference output is a model-generated pseudo-label, not researcher-adjudicated ground truth.",
      "The Space and Loci use different pinned Cellpose code revisions, so bitwise identity is not claimed.",
      "One uint8 image cannot establish performance across cell types, densities, optics, or dtypes.",
    ],
    claimBoundary:
      "Close website-compatible behavior only: the supplied Space mask had 4,990 instances and the locked Loci reproduction had 4,994 with foreground IoU 0.986. This is not biological validation, an accuracy estimate, or evidence that segmented instances are live cells.",
  },
];

export interface ModelEvidenceRegistry {
  readonly models: readonly Readonly<ModelManifest>[];
  readonly validationReports: readonly Readonly<ValidationReport>[];
  getModel(modelId: string): Readonly<ModelManifest> | undefined;
  getValidationReport(reportId: string): Readonly<ValidationReport> | undefined;
}

function registryFail(
  code: "duplicate-id" | "broken-reference" | "invalid-value",
  path: string,
  message: string,
): never {
  throw new FoundationValidationError(code, path, message);
}

function sameSha256(left: string | null, right: string | null): boolean {
  return left === null || right === null
    ? left === right
    : left.toLowerCase() === right.toLowerCase();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((child) => deepFreeze(child));
  }
  return value;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Build a fail-closed registry after validating every document independently and
 * then validating all cross-document provenance links.
 */
export function createModelEvidenceRegistry(
  modelDefinitions: readonly unknown[],
  reportDefinitions: readonly unknown[],
): ModelEvidenceRegistry {
  const models = modelDefinitions.map((definition) =>
    validateModelManifest(definition),
  );
  const validationReports = reportDefinitions.map((definition) =>
    validateValidationReport(definition),
  );

  const modelById = new Map<string, ModelManifest>();
  models.forEach((model, index) => {
    if (modelById.has(model.modelId)) {
      registryFail(
        "duplicate-id",
        `$registry.models[${index}].modelId`,
        `Duplicate model identifier ${model.modelId}.`,
      );
    }
    modelById.set(model.modelId, model);
  });

  const reportById = new Map<string, ValidationReport>();
  validationReports.forEach((report, index) => {
    if (reportById.has(report.reportId)) {
      registryFail(
        "duplicate-id",
        `$registry.validationReports[${index}].reportId`,
        `Duplicate validation report identifier ${report.reportId}.`,
      );
    }
    reportById.set(report.reportId, report);
  });

  const reportOwners = new Map<string, string>();
  models.forEach((model, modelIndex) => {
    model.validationReportIds.forEach((reportId, reportIndex) => {
      const path = `$registry.models[${modelIndex}].validationReportIds[${reportIndex}]`;
      const report = reportById.get(reportId);
      if (!report) {
        registryFail(
          "broken-reference",
          path,
          `Model ${model.modelId} references unknown validation report ${reportId}.`,
        );
      }
      const existingOwner = reportOwners.get(reportId);
      if (existingOwner) {
        registryFail(
          "broken-reference",
          path,
          `Validation report ${reportId} is already owned by model ${existingOwner}.`,
        );
      }
      reportOwners.set(reportId, model.modelId);
      if (report.modelId !== model.modelId) {
        registryFail(
          "broken-reference",
          path,
          `Validation report ${reportId} belongs to model ${report.modelId}, not ${model.modelId}.`,
        );
      }
      if (!sameSha256(report.modelSha256, model.artifact.sha256)) {
        registryFail(
          "invalid-value",
          path,
          `Validation report ${reportId} does not match the registered model artifact digest.`,
        );
      }
      if (report.evidenceStatus !== model.evidenceStatus) {
        registryFail(
          "invalid-value",
          path,
          `Validation report ${reportId} and model ${model.modelId} declare different evidence states.`,
        );
      }
    });
  });

  validationReports.forEach((report, reportIndex) => {
    if (!modelById.has(report.modelId)) {
      registryFail(
        "broken-reference",
        `$registry.validationReports[${reportIndex}].modelId`,
        `Validation report ${report.reportId} references unknown model ${report.modelId}.`,
      );
    }
    if (!reportOwners.has(report.reportId)) {
      registryFail(
        "broken-reference",
        `$registry.validationReports[${reportIndex}].reportId`,
        `Validation report ${report.reportId} is not cited by its model manifest.`,
      );
    }
  });

  const frozenModels = deepFreeze(jsonClone(models));
  const frozenReports = deepFreeze(jsonClone(validationReports));
  const frozenModelById = new Map(frozenModels.map((model) => [model.modelId, model]));
  const frozenReportById = new Map(
    frozenReports.map((report) => [report.reportId, report]),
  );

  return Object.freeze({
    models: frozenModels,
    validationReports: frozenReports,
    getModel: (modelId: string) => frozenModelById.get(modelId),
    getValidationReport: (reportId: string) => frozenReportById.get(reportId),
  });
}

export const MODEL_EVIDENCE_REGISTRY = createModelEvidenceRegistry(
  MODEL_MANIFEST_DEFINITIONS,
  VALIDATION_REPORT_DEFINITIONS,
);

export const CANONICAL_MODEL_MANIFESTS = MODEL_EVIDENCE_REGISTRY.models;
export const CANONICAL_VALIDATION_REPORTS =
  MODEL_EVIDENCE_REGISTRY.validationReports;
