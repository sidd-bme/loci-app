import {
  CELLPOSE_MODEL_REVISION,
  CELLPOSE_RUNTIME_VERSION,
  CELLPOSE_SAM_SHA256,
  CELLPOSE_SAM_SIZE_BYTES,
  CELLPOSE_SAM_V2_SHA256,
  CELLPOSE_SAM_V2_SIZE_BYTES,
} from "./model-registry";
import { NUCLEI_MODEL_INSTALL } from "./nuclei-model-install";
import { DYNACELL_NUCLEUS } from "./dynacell";

export type ModelLibraryId =
  | "plantseg-ovules-ds1x"
  | "mesmer-multiplex-tissue"
  | "dynacell-ipsc-nucleus"
  | "care-planaria-3d"
  | "organoidtracker-2"
  | "cellpose-sam-v2"
  | "micro-sam-vit-b-lm"
  | "stardist-2d-versatile-fluo"
  | "bioimageio-nuclei-boundary-onnx"
  | "puma-tissue-cpu";

export type ModelLibraryTaskCategory =
  | "segment"
  | "virtual-stain"
  | "restore"
  | "track";

export type ModelLibraryTaskFilter = "all" | ModelLibraryTaskCategory;

export type ModelLibraryLinkId =
  | "plantseg-record"
  | "plantseg-registry"
  | "plantseg-paper"
  | "mesmer-guide"
  | "mesmer-registry"
  | "mesmer-paper"
  | "dynacell-project"
  | "dynacell-checkpoint"
  | "dynacell-paper"
  | "allen-terms"
  | "care-planaria-scenario"
  | "care-planaria-fiji-demo"
  | "care-fiji-license"
  | "care-planaria-dataset"
  | "care-paper"
  | "organoidtracker-repo"
  | "organoidtracker-organoid-weights"
  | "organoidtracker-example-data"
  | "organoidtracker-paper"
  | "organoidtracker-pmc"
  | "cellpose-sam-v2-checkpoint"
  | "cellpose-sam-v1-checkpoint"
  | "cellpose-github-repo"
  | "cellpose-sam-paper"
  | "cellpose-2021-paper"
  | "micro-sam-bioimageio-card"
  | "micro-sam-upstream-registry"
  | "micro-sam-upstream-tag"
  | "micro-sam-paper"
  | "stardist-2d-versatile-fluo-zip"
  | "stardist-github-repo"
  | "stardist-v01-release"
  | "stardist-paper"
  | "bioimageio-nuclei-boundary-zenodo"
  | "unet-2015-paper"
  | "bioimageio-models-catalog"
  | "bioimageio-preprint"
  | "puma-weights-zenodo"
  | "puma-baseline-repo"
  | "puma-dataset-zenodo"
  | "puma-paper"
  | "bbbc034-field"
  | "bbbc038-fields"
  | "bbbc-collection-paper"
  | "marzec-nuclei-data"
  | "marzec-nuclei-paper"
  | "image-cc-by-4"
  | "image-cc0";

export type ModelLibraryFilterGroup = "all" | "local" | "external";

export type ModelLibraryExecutionMode =
  | "optional-local-virtual-stain"
  | "optional-local-profile"
  | "external-native-handoff"
  | "external-label-return"
  | "external-restored-volume"
  | "external-tracking-graph"
  | "optional-local-onnx"
  | "optional-local-tissue";

export type ModelLibraryVerificationKind =
  | "unvalidated-checkpoint-hash-verified"
  | "external-unverified-handoff-grid-checked"
  | "external-unverified-grid-checked"
  | "external-unverified-derived-signal"
  | "external-unverified-tracking-graph"
  | "reference-tensor-verified-unvalidated"
  | "unvalidated-candidate-files-verified";

export type ModelLibraryWorkbenchRouteKind =
  | "virtual-stain"
  | "segment-cellpose-v2"
  | "labels-usam-handoff"
  | "labels-import"
  | "onnx-model-package"
  | "tissue-epidermis"
  | "open-restored-volume"
  | "temporal-tracking";

export type ModelLibraryPublicationStatus =
  | "arXiv preprint"
  | "Peer-reviewed journal article"
  | "Peer-reviewed conference paper"
  | "bioRxiv preprint (not peer-reviewed)"
  | "Zenodo model package record";

export type ModelLibraryDigestBasis =
  | "loci-verified"
  | "publisher-reported"
  | "external-unverified";

export interface ModelLibraryLinkDescriptor {
  readonly id: ModelLibraryLinkId;
  readonly label: string;
  readonly kind: "download" | "paper" | "repository" | "catalog";
  readonly hostLabel: string;
  readonly url: string;
}

export interface ModelLibraryCitation {
  readonly authors: string;
  readonly year: number;
  readonly title: string;
  readonly venue: string;
  readonly publicationStatus: ModelLibraryPublicationStatus;
  readonly doi: string;
  readonly linkId: ModelLibraryLinkId;
  readonly secondaryNote?: string;
}

export interface ModelLibraryRightsSummary {
  readonly codeLicense: string;
  readonly weightsLicense: string;
  readonly trainingDataLineage: string;
  readonly redistribution: string;
  readonly commercialUse: string;
}

export interface ModelLibraryArtifactIdentity {
  readonly artifactId: string;
  readonly fileName: string;
  readonly version: string;
  readonly sha256: string | null;
  readonly digestBasis: ModelLibraryDigestBasis;
  readonly digestBasisLabel: string;
  readonly sizeBytes: number | null;
  readonly companionNote?: string;
  readonly runtimeRequirement: string;
}

export interface ModelLibraryCatalogInstall {
  readonly packageVersion: string;
  readonly originLabel: string;
  readonly downloadBytes: number;
  readonly packageSha256: string;
  readonly workingBytes: number;
}

export interface ModelLibraryEntry {
  readonly id: ModelLibraryId;
  readonly title: string;
  readonly subtitle: string;
  readonly taskCategory: ModelLibraryTaskCategory;
  readonly filterGroup: Exclude<ModelLibraryFilterGroup, "all">;
  readonly executionMode: ModelLibraryExecutionMode;
  readonly executionBadge: string;
  readonly executionShortLabel: string;
  readonly verificationKind: ModelLibraryVerificationKind;
  readonly verificationBadge: string;
  readonly verificationDetail: string;
  readonly target: string;
  readonly modalitySummary: string;
  readonly taskLabel: string;
  readonly modalityTags: readonly string[];
  readonly summary: string;
  readonly cardSummary: string;
  readonly publisherBadge: string;
  readonly searchTerms: readonly string[];
  readonly taskSummary: string;
  readonly inputContract: string;
  readonly lociPathway: string;
  readonly workbenchRoute: {
    readonly kind: ModelLibraryWorkbenchRouteKind;
    readonly actionLabel: string;
    readonly inspectorLocation: string;
  };
  readonly catalogInstall?: ModelLibraryCatalogInstall;
  readonly artifact: ModelLibraryArtifactIdentity;
  readonly rights: ModelLibraryRightsSummary;
  readonly limitations: readonly string[];
  readonly citation: ModelLibraryCitation;
  readonly primaryLink: ModelLibraryLinkDescriptor;
  readonly secondaryLinks: readonly ModelLibraryLinkDescriptor[];
}

export interface ModelLibraryNativeBaseline {
  readonly id: "loci-classical" | "classical-threshold-watershed";
  readonly name: string;
  readonly executionBadge: "Native built-in · always offline";
  readonly verificationBadge: string;
  readonly summary: string;
  readonly license: "Apache-2.0";
  readonly inspectorLocation: string;
}

export const MICRO_SAM_VIT_B_LM_PUBLISHER_XXH128 =
  "fe9252a29f3f4ea53c15a06de471e186" as const;
export const MICRO_SAM_VIT_B_LM_DECODER_PUBLISHER_XXH128 =
  "708b15ac620e235f90bb38612c4929ba" as const;

export const STARDIST_2D_VERSATILE_FLUO_PUBLISHER_SHA256 =
  "4ad678d0758eed6e55625f1b5ae30771e59adb79f1239e09b9772eac8846c3dd" as const;

export const BIOIMAGEIO_NUCLEI_BOUNDARY_WEIGHTS_ONNX_SHA256 =
  "df913b85947f5132bcdaf81d91af0963f60d44f4caf8a4fec672d96a2f327b44" as const;
export const BIOIMAGEIO_NUCLEI_BOUNDARY_ADAPTED_PACKAGE_SHA256 =
  "94259d554d02f43c4d5fa116f0e9e647be4be5c7ed00fb7555b141a9e9f2937b" as const;

export const PUMA_CONVERTED_WEIGHTS_SHA256 =
  "f32a81e49ff3fc60e0831fcb4e6c1bce311586151ef2257c0f1ddcf7792804ad" as const;
export const PUMA_CONVERSION_RECEIPT_SHA256 =
  "9383634f6840b382e343a9bdc8b73fa92e606ce05e251508ddb904aebe31c486" as const;
export const PUMA_ORIGINAL_FOLD4_CHECKPOINT_SHA256 =
  "938fea9f4c41a798cf0d92a6a98cb4de1fcee9342cd3bbf7d56bb5c036505faa" as const;

const ALLOWED_EXTERNAL_HOSTS = new Set([
  "deepcell.readthedocs.io",
  "biohub.github.io",
  "dynacell.s3.us-west-2.amazonaws.com",
  "www.allencell.org",
  "csbdeep.bioimagecomputing.com",
  "pmc.ncbi.nlm.nih.gov",
  "huggingface.co",
  "github.com",
  "doi.org",
  "zenodo.org",
  "bioimage.io",
  "bbbc.broadinstitute.org",
  "creativecommons.org",
]);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export const MODEL_LIBRARY_TASK_LABELS: Readonly<Record<ModelLibraryTaskCategory, string>> =
  deepFreeze({
    segment: "Segment",
    "virtual-stain": "Virtual stain",
    restore: "Restore",
    track: "Track",
  });

export const MODEL_LIBRARY_OFFICIAL_LINKS: Readonly<Record<ModelLibraryLinkId, string>> =
  deepFreeze({
    "plantseg-record": "https://zenodo.org/records/7772553",
    "plantseg-registry": "https://github.com/kreshuklab/plant-seg/blob/9d748063cc9de8d8025aaf691a11483b94a5894c/plantseg/resources/models_zoo.yaml",
    "plantseg-paper": "https://doi.org/10.7554/eLife.57613",
    "mesmer-guide": "https://deepcell.readthedocs.io/en/master/app-gallery/mesmer.html",
    "mesmer-registry": "https://github.com/vanvalenlab/deepcell-tf/blob/eb3d61975549f75ac52561fbaa9215134a39e3f1/deepcell/applications/mesmer.py",
    "mesmer-paper": "https://doi.org/10.1038/s41587-021-01094-0",
    "dynacell-project": "https://biohub.github.io/dynacell/",
    "dynacell-checkpoint": DYNACELL_NUCLEUS.url,
    "dynacell-paper": "https://doi.org/10.48550/arXiv.2611.02324",
    "allen-terms": "https://www.allencell.org/terms-of-use.html",
    "care-planaria-scenario": "https://csbdeep.bioimagecomputing.com/scenarios/denoisingplanaria/",
    "care-planaria-fiji-demo":
      "https://github.com/CSBDeep/CSBDeep_website/wiki/Fiji-Command-%E2%80%93-3D-Denoising-(Planaria)",
    "care-fiji-license": "https://github.com/CSBDeep/CSBDeep_fiji/blob/master/LICENSE.txt",
    "care-planaria-dataset": "https://doi.org/10.17617/3.FDFZOF",
    "care-paper": "https://doi.org/10.1038/s41592-018-0216-7",
    "organoidtracker-repo": "https://github.com/jvzonlab/OrganoidTracker",
    "organoidtracker-organoid-weights": "https://doi.org/10.5281/zenodo.18479952",
    "organoidtracker-example-data": "https://doi.org/10.5281/zenodo.13982844",
    "organoidtracker-paper": "https://doi.org/10.1038/s41592-025-02845-6",
    "organoidtracker-pmc": "https://pmc.ncbi.nlm.nih.gov/articles/PMC12615265/",
    "cellpose-sam-v2-checkpoint": `https://huggingface.co/mouseland/cellpose-sam/blob/${CELLPOSE_MODEL_REVISION}/cpsam_v2`,
    "cellpose-sam-v1-checkpoint": `https://huggingface.co/mouseland/cellpose-sam/blob/${CELLPOSE_MODEL_REVISION}/cpsam`,
    "cellpose-github-repo": "https://github.com/MouseLand/cellpose",
    "cellpose-sam-paper": "https://doi.org/10.1101/2025.04.28.651001",
    "cellpose-2021-paper": "https://doi.org/10.1038/s41592-020-01018-x",
    "micro-sam-bioimageio-card": "https://bioimage.io/#/artifacts/diplomatic-bug/v0",
    "micro-sam-upstream-registry":
      "https://github.com/computational-cell-analytics/micro-sam/blob/d45ab70ece93a9eb3ca1e237b9067767b0a18263/micro_sam/v1/util.py",
    "micro-sam-upstream-tag":
      "https://github.com/computational-cell-analytics/micro-sam/tree/d45ab70ece93a9eb3ca1e237b9067767b0a18263",
    "micro-sam-paper": "https://doi.org/10.1038/s41592-024-02580-4",
    "stardist-2d-versatile-fluo-zip":
      "https://github.com/stardist/stardist-models/releases/download/v0.1/python_2D_versatile_fluo.zip",
    "stardist-github-repo": "https://github.com/stardist/stardist",
    "stardist-v01-release":
      "https://github.com/stardist/stardist-models/releases/tag/v0.1",
    "stardist-paper": "https://doi.org/10.1007/978-3-030-00934-2_30",
    "bioimageio-nuclei-boundary-zenodo": "https://doi.org/10.5281/zenodo.6647674",
    "unet-2015-paper": "https://doi.org/10.1007/978-3-319-24574-4_28",
    "bioimageio-models-catalog": "https://bioimage.io/#/models",
    "bioimageio-preprint": "https://doi.org/10.1101/2022.06.07.495102",
    "puma-weights-zenodo": "https://doi.org/10.5281/zenodo.14651631",
    "puma-baseline-repo":
      "https://github.com/tueimage/PUMA-challenge-baseline-track1/tree/211782054387f0d28e170ed565cdfb6e8b53d1a7",
    "puma-dataset-zenodo": "https://doi.org/10.5281/zenodo.15050523",
    "puma-paper": "https://doi.org/10.1093/gigascience/giaf011",
    "bbbc034-field": "https://bbbc.broadinstitute.org/BBBC034",
    "bbbc038-fields": "https://bbbc.broadinstitute.org/BBBC038",
    "bbbc-collection-paper": "https://doi.org/10.1038/nmeth.2083",
    "marzec-nuclei-data": "https://doi.org/10.5281/zenodo.4462097",
    "marzec-nuclei-paper": "https://doi.org/10.1186/s12859-022-04737-4",
    "image-cc-by-4": "https://creativecommons.org/licenses/by/4.0/",
    "image-cc0": "https://creativecommons.org/publicdomain/zero/1.0/",
  });

function linkDescriptor(
  id: ModelLibraryLinkId,
  label: string,
  kind: ModelLibraryLinkDescriptor["kind"],
  hostLabel: string,
): ModelLibraryLinkDescriptor {
  return {
    id,
    label,
    kind,
    hostLabel,
    url: MODEL_LIBRARY_OFFICIAL_LINKS[id],
  };
}

export const MODEL_LIBRARY_NATIVE_BASELINES: readonly Readonly<ModelLibraryNativeBaseline>[] =
  deepFreeze([
    {
      id: "classical-threshold-watershed",
      name: "Classical threshold & watershed",
      executionBadge: "Native built-in · always offline",
      verificationBadge: "Deterministic numerical baseline",
      summary:
        "Explicit scalar threshold, connected components or watershed splitting, and raw selected-channel measurements over 2D planes or 3D Z ranges without learned weights.",
      license: "Apache-2.0",
      inspectorLocation: "Analyze → Segment & measure → Classical methods",
    },
    {
      id: "loci-classical",
      name: "Loci Adaptive Watershed",
      executionBadge: "Native built-in · always offline",
      verificationBadge: "Experimental technical QA · no checkpoint",
      summary:
        "Built-in 2D percentile normalization, smoothing, and touching-object watershed baseline for routine brightfield or fluorescence planes.",
      license: "Apache-2.0",
      inspectorLocation: "Analyze → Segment & measure → Loci Adaptive Watershed",
    },
  ]);

export const MODEL_LIBRARY_ENTRIES: readonly Readonly<ModelLibraryEntry>[] = deepFreeze([
  {
    id: "cellpose-sam-v2",
    title: "Cellpose-SAM v2",
    subtitle: `Generalist 2D cellular instance segmentation · cpsam_v2 (rev ${CELLPOSE_MODEL_REVISION.slice(0, 12)})`,
    taskCategory: "segment",
    filterGroup: "local",
    executionMode: "optional-local-profile",
    executionBadge: "Optional local profile",
    executionShortLabel: "Local · on-demand",
    verificationKind: "unvalidated-checkpoint-hash-verified",
    verificationBadge: "Unvalidated · Exact SHA-256 verified on import",
    verificationDetail:
      "Loci cryptographically verifies the 1,233,586,851-byte cpsam_v2 checkpoint before atomic adoption. This v2 checkpoint is unvalidated in Loci and is not promoted as default; the companion original cpsam profile (1,233,587,898 bytes) carries one-image experimental technical parity with the audited public Cellpose Space.",
    target: "Whole cells & cytoplasm (2D)",
    modalitySummary: "Brightfield, phase-contrast & 2D fluorescence",
    taskLabel: "2D cell instances",
    modalityTags: [
      "2D whole cells & cytoplasm",
      "Brightfield & phase-contrast",
      "2D fluorescence",
    ],
    summary:
      "Generalist 2D gradient-flow segmentation for whole cells across brightfield, phase-contrast, and fluorescence microscopy.",
    cardSummary:
      "Generalist 2D gradient-flow segmentation for whole cells across brightfield, phase-contrast, and fluorescence.",
    publisherBadge: "Hugging Face · cpsam_v2",
    searchTerms: [
      "cellpose",
      "cpsam",
      "cpsam_v2",
      "sam",
      "brightfield",
      "phase-contrast",
      "fluorescence",
      "cytoplasm",
      "whole cells",
      "gradient flow",
      "mouseland",
    ],
    taskSummary:
      "Predicts 2D horizontal/vertical spatial gradients and cell probability, integrates 250 dynamics iterations into integer instance masks on the source grid, and measures raw selected-channel intensities.",
    inputContract:
      "One native level-0 2D plane (explicit Z and T). Accepts one scalar intensity channel or interleaved RGB; routine uint8 inputs use the audited 1,000 px max-edge OpenCV resize path while higher bit depths preserve dynamic range.",
    lociPathway:
      "Provision cpsam_v2 once via verified download or local file import in Analyze → Segment & measure → Cellpose-SAM v2, run segmentation, then inspect objects and review/correct boundaries.",
    workbenchRoute: {
      kind: "segment-cellpose-v2",
      actionLabel: "Open Cellpose-SAM v2 in Analyze",
      inspectorLocation: "Analyze → Segment & measure → Cellpose-SAM v2",
    },
    artifact: {
      artifactId: "cpsam_v2",
      fileName: "cpsam_v2",
      version: `cellpose ${CELLPOSE_RUNTIME_VERSION} · Hugging Face rev ${CELLPOSE_MODEL_REVISION.slice(0, 12)}`,
      sha256: CELLPOSE_SAM_V2_SHA256,
      digestBasis: "loci-verified",
      digestBasisLabel: "Verified by Loci before atomic checkpoint adoption",
      sizeBytes: CELLPOSE_SAM_V2_SIZE_BYTES,
      companionNote: `Companion website-compatible original cpsam (${CELLPOSE_SAM_SIZE_BYTES.toLocaleString()} bytes, Loci-verified SHA-256 ${CELLPOSE_SAM_SHA256}) is separately selectable for Space reproduction.`,
      runtimeRequirement: `Separately provisioned cellpose==${CELLPOSE_RUNTIME_VERSION} Python runtime`,
    },
    rights: {
      codeLicense: "BSD-3-Clause (MouseLand/cellpose)",
      weightsLicense: "BSD-3-Clause repository declaration; CC-BY-NC training-data lineage caveat",
      trainingDataLineage:
        "MouseLand declares the Hugging Face checkpoint repository BSD-3-Clause while noting official Cellpose models were trained on CC-BY-NC datasets.",
      redistribution: "Unknown · never bundled by Loci",
      commercialUse:
        "Restricted · on hold pending written rights-holder clarification on training-data lineage",
    },
    limitations: [
      "Morphology alone never establishes cell viability, phenotype, or live/dead status.",
      "Dense touching clusters can merge or over-split and require inspection in Annotate → Edit labels & ROIs.",
      "A higher or lower instance count than original cpsam is not evidence of superior biological accuracy.",
      "Operates on a single 2D Z plane per run; volumetric stacks require plane selection or a 3D workflow.",
    ],
    citation: {
      authors: "Pachitariu, M., Rariden, M. & Stringer, C.",
      year: 2025,
      title: "Cellpose-SAM: superhuman generalization for cellular segmentation",
      venue: "bioRxiv",
      publicationStatus: "bioRxiv preprint (not peer-reviewed)",
      doi: "10.1101/2025.04.28.651001",
      linkId: "cellpose-sam-paper",
      secondaryNote:
        "Foundational peer-reviewed method: Stringer, C., Wang, T., Michaelos, M. & Pachitariu, M. (2021). Cellpose: a generalist algorithm for cellular segmentation. Nature Methods 18, 100–106 (DOI 10.1038/s41592-020-01018-x).",
    },
    primaryLink: linkDescriptor(
      "cellpose-sam-v2-checkpoint",
      "Official cpsam_v2 file card (rev 7c61431b)",
      "download",
      "huggingface.co",
    ),
    secondaryLinks: [
      linkDescriptor(
        "cellpose-github-repo",
        "MouseLand/cellpose repository",
        "repository",
        "github.com",
      ),
      linkDescriptor(
        "cellpose-sam-v1-checkpoint",
        "Original cpsam file card (rev 7c61431b)",
        "download",
        "huggingface.co",
      ),
      linkDescriptor("cellpose-sam-paper", "Cellpose-SAM preprint (DOI)", "paper", "doi.org"),
      linkDescriptor("cellpose-2021-paper", "Nature Methods 2021 (DOI)", "paper", "doi.org"),
    ],
  },
  {
    id: "micro-sam-vit-b-lm",
    title: "μSAM Light Microscopy Generalist",
    subtitle:
      "Standalone 2D/3D promptable & automatic segmentation · BioImage.IO diplomatic-bug 1.2 (vit_b.pt + vit_b_decoder.pt)",
    taskCategory: "segment",
    filterGroup: "external",
    executionMode: "external-native-handoff",
    executionBadge: "External · Native TIFF handoff",
    executionShortLabel: "External · TIFF handoff",
    verificationKind: "external-unverified-handoff-grid-checked",
    verificationBadge: "Declared external mask · Handoff & grid verified",
    verificationDetail:
      "Loci never executes micro-sam or loads its pickle checkpoints. Instead, Loci exports an immutable native scalar input.tif and manifest.json, then verifies the returned label TIFF against the study handoff, source SHA-256, channel declaration, and exact YX or ZYX pixel grid.",
    target: "Cells, nuclei & organoids (2D / 3D)",
    modalitySummary: "2D plane or 3D Z-stack light microscopy",
    taskLabel: "2D/3D prompt & auto",
    modalityTags: [
      "2D & 3D light microscopy",
      "Interactive prompt or auto-grid",
      "Cells, nuclei & organoids",
    ],
    summary:
      "Interactive promptable and automatic 2D or 3D cell and nucleus segmentation in standalone micro-sam v2.0.1 via native TIFF handoff.",
    cardSummary:
      "Promptable and automatic 2D/3D cell and nucleus segmentation in standalone micro-sam v2.0.1 via TIFF handoff.",
    publisherBadge: "BioImage.IO · diplomatic-bug",
    searchTerms: [
      "usam",
      "micro-sam",
      "microsam",
      "vit_b_lm",
      "diplomatic-bug",
      "3d",
      "2d",
      "promptable",
      "organoids",
      "tiff handoff",
      "bioimage.io",
    ],
    taskSummary:
      "Exports exact native scalar intensities (input.tif + manifest.json) for offline micro-sam segmentation, then adopts the returned unsigned uint8/uint16/uint32 YX or ZYX instance label TIFF to measure raw source intensities.",
    inputContract:
      "Full native level-0 scalar source plane (scalar-native-yx/v1) or contiguous Z range of at least 2 planes (scalar-native-zyx/v1) without crop or resampling. Returned TIFF must be scalar minisblack with explicit YX or ZYX axes and background 0.",
    lociPathway:
      "In Analyze → Segment & measure → Import existing labels → μSAM (standalone), export the native TIFF bundle, run micro-sam v2.0.1 offline with SAM1 registry model vit_b_lm (plus vit_b_decoder.pt for decoder-based segmentation), and return the label TIFF with its bound handoff manifest.",
    workbenchRoute: {
      kind: "labels-usam-handoff",
      actionLabel: "Open μSAM handoff in Analyze",
      inspectorLocation: "Analyze → Segment & measure → Import existing labels → μSAM (standalone)",
    },
    artifact: {
      artifactId: "vit_b_lm",
      fileName: "vit_b.pt + vit_b_decoder.pt (BioImage.IO diplomatic-bug 1.2)",
      version:
        "micro-sam v2.0.1 (d45ab70ece93a9eb3ca1e237b9067767b0a18263) · BioImage.IO diplomatic-bug 1.2 (v0)",
      sha256: null,
      digestBasis: "external-unverified",
      digestBasisLabel: `Not loaded or verified by Loci; upstream micro_sam/v1/util.py pins publisher-reported Pooch xxh128 digests (vit_b.pt: ${MICRO_SAM_VIT_B_LM_PUBLISHER_XXH128}; vit_b_decoder.pt: ${MICRO_SAM_VIT_B_LM_DECODER_PUBLISHER_XXH128}), not independently checked by Loci`,
      sizeBytes: null,
      companionNote: `Pinned micro-sam v2.0.1 (micro_sam/v1/util.py) maps SAM1 registry model vit_b_lm to BioImage.IO diplomatic-bug version 1.2: vit_b.pt (publisher xxh128: ${MICRO_SAM_VIT_B_LM_PUBLISHER_XXH128}) plus vit_b_decoder.pt for decoder-based automatic instance segmentation (publisher xxh128: ${MICRO_SAM_VIT_B_LM_DECODER_PUBLISHER_XXH128}). Upstream checkpoints use PyTorch pickle serialization and are fetched/checked by Pooch inside your isolated micro-sam v2.0.1 environment, not verified by Loci; record the actual checkpoint identity during label return.`,
      runtimeRequirement:
        "External Python ≥3.11 environment with micro-sam==2.0.1 (never executed inside Loci)",
    },
    rights: {
      codeLicense: "MIT (computational-cell-analytics/micro-sam)",
      weightsLicense:
        "CC-BY-4.0 supplier declaration in BioImage.IO diplomatic-bug 1.2 RDF (base Meta SAM: Apache-2.0)",
      trainingDataLineage:
        "Fine-tuned on seven light microscopy datasets listed in upstream doc/datasets/lm_v2.md (LIVECell, DeepBacs, TissueNet, PlantSeg Root, NeurIPS CellSeg, Cell Tracking Challenge, and DSB 2018); verify underlying dataset terms separately.",
      redistribution: "External download · not bundled by Loci",
      commercialUse:
        "Separate human review required (verify CC-BY-4.0 weights terms and underlying dataset licences)",
    },
    limitations: [
      "Loci does not verify how the external mask was generated (`mask_origin_verified_by_loci: false`, `model_validation: unknown`).",
      "Default imageio writers can tag 3–4 Z planes as RGB(A) or longer stacks as ambiguous QYX; use the checked tifffile writer in the exported bundle README.",
      "Interactive prompt placement and automatic IoU/stability thresholds materially change object boundaries and require overlay review before adoption.",
    ],
    citation: {
      authors: "Archit, A., Freckmann, L., Nair, S. et al.",
      year: 2025,
      title: "Segment Anything for Microscopy",
      venue: "Nature Methods 22, 579–591",
      publicationStatus: "Peer-reviewed journal article",
      doi: "10.1038/s41592-024-02580-4",
      linkId: "micro-sam-paper",
    },
    primaryLink: linkDescriptor(
      "micro-sam-bioimageio-card",
      "BioImage.IO diplomatic-bug v1.2 card",
      "catalog",
      "bioimage.io",
    ),
    secondaryLinks: [
      linkDescriptor(
        "micro-sam-upstream-registry",
        "SAM1 registry micro_sam/v1/util.py (d45ab70e)",
        "repository",
        "github.com",
      ),
      linkDescriptor(
        "micro-sam-upstream-tag",
        "Pinned micro-sam v2.0.1 tag (d45ab70e)",
        "repository",
        "github.com",
      ),
      linkDescriptor("micro-sam-paper", "Nature Methods 2025 (DOI)", "paper", "doi.org"),
    ],
  },
  {
    id: "stardist-2d-versatile-fluo",
    title: "StarDist Versatile Fluorescence Nuclei",
    subtitle: "Star-convex polygon nuclear instance detection · python_2D_versatile_fluo.zip (v0.1)",
    taskCategory: "segment",
    filterGroup: "external",
    executionMode: "external-label-return",
    executionBadge: "External · Label TIFF return",
    executionShortLabel: "External · label return",
    verificationKind: "external-unverified-grid-checked",
    verificationBadge: "Declared external mask · Native YX grid verified",
    verificationDetail:
      "Run StarDist in Python, Fiji/ImageJ, napari, or QuPath and export an unsigned integer YX label TIFF. Loci verifies exact native source dimensions, Orientation 1, scalar unsigned integer dtype, and raw measurement channel binding before adoption.",
    target: "Crowded fluorescence nuclei (2D)",
    modalitySummary: "2D fluorescence (DAPI, Hoechst & nuclear stains)",
    taskLabel: "2D nuclear polygons",
    modalityTags: [
      "2D fluorescence nuclei",
      "DAPI / Hoechst / nuclear stains",
      "Dense crowded nuclei",
    ],
    summary:
      "Star-convex polygon detection for separating crowded, touching 2D fluorescence nuclei with native YX label TIFF return.",
    cardSummary:
      "Star-convex polygon detection for crowded 2D fluorescence nuclei with native YX label TIFF return.",
    publisherBadge: "GitHub · v0.1 ZIP",
    searchTerms: [
      "stardist",
      "2d_versatile_fluo",
      "nuclei",
      "dapi",
      "hoechst",
      "star-convex",
      "polygon",
      "fiji",
      "imagej",
      "napari",
      "qupath",
    ],
    taskSummary:
      "Predicts per-pixel object probability and radial star-convex polygon distances in an external StarDist runtime; Loci adopts the resulting YX integer label TIFF and measures raw source intensities.",
    inputContract:
      "Single-page scalar YX label TIFF (uint8, uint16, or uint32; Orientation 1; 0 = background) matching the full level-0 native YX dimensions of a scalar source channel without crop or resampling.",
    lociPathway:
      "In Analyze → Segment & measure → Import existing labels, select the StarDist label TIFF, record producer 'StarDist' and model '2D_versatile_fluo', inspect the overlay preview, and confirm alignment.",
    workbenchRoute: {
      kind: "labels-import",
      actionLabel: "Open label importer in Analyze",
      inspectorLocation: "Analyze → Segment & measure → Import existing labels",
    },
    artifact: {
      artifactId: "2D_versatile_fluo",
      fileName: "python_2D_versatile_fluo.zip",
      version: "stardist-models v0.1 release · python_2D_versatile_fluo.zip",
      sha256: STARDIST_2D_VERSATILE_FLUO_PUBLISHER_SHA256,
      digestBasis: "publisher-reported",
      digestBasisLabel:
        "Publisher-reported in upstream stardist/models/__init__.py · not independently checked by Loci",
      sizeBytes: null,
      companionNote:
        "Upstream pins https://github.com/stardist/stardist-models/releases/download/v0.1/python_2D_versatile_fluo.zip. Verify the archive digest in your external StarDist environment and record it in the optional producer provenance fields during label import.",
      runtimeRequirement:
        "External StarDist Python, Fiji/ImageJ, napari, or QuPath environment",
    },
    rights: {
      codeLicense: "BSD-3-Clause (stardist/stardist)",
      weightsLicense: "BSD-3-Clause declaration (stardist/stardist-models v0.1)",
      trainingDataLineage:
        "Trained on a subset of the 2018 Data Science Bowl (BBBC038) fluorescence nuclei dataset; verify upstream dataset terms before commercial use.",
      redistribution: "External download · not bundled by Loci",
      commercialUse: "Requires independent review of DSB 2018 training-data lineage",
    },
    limitations: [
      "Star-convex polygon geometry is tailored to roundish or moderately oval nuclei and can fragment strongly elongated, curved, or branched structures.",
      "Probability (`prob_thresh`) and non-maximum suppression (`nms_thresh`) thresholds are chosen in the external tool and are not validated by Loci.",
      "Shape agreement alone does not prove coordinate registration; inspect the plane overlay before confirming adoption.",
    ],
    citation: {
      authors: "Schmidt, U., Weigert, M., Broaddus, C. & Myers, G.",
      year: 2018,
      title: "Cell Detection with Star-Convex Polygons",
      venue: "Medical Image Computing and Computer Assisted Intervention – MICCAI 2018, LNCS 11071, 265–273",
      publicationStatus: "Peer-reviewed conference paper",
      doi: "10.1007/978-3-030-00934-2_30",
      linkId: "stardist-paper",
    },
    primaryLink: linkDescriptor(
      "stardist-2d-versatile-fluo-zip",
      "python_2D_versatile_fluo.zip (v0.1)",
      "download",
      "github.com",
    ),
    secondaryLinks: [
      linkDescriptor(
        "stardist-github-repo",
        "stardist/stardist repository",
        "repository",
        "github.com",
      ),
      linkDescriptor(
        "stardist-v01-release",
        "stardist-models v0.1 release notes",
        "repository",
        "github.com",
      ),
      linkDescriptor("stardist-paper", "MICCAI 2018 paper (DOI)", "paper", "doi.org"),
    ],
  },
  {
    id: "bioimageio-nuclei-boundary-onnx",
    title: "BioImage.IO 2D Nuclei Boundary ONNX",
    subtitle: "Local CPU ONNX package · adapted from Zenodo 6647674 weights.onnx",
    taskCategory: "segment",
    filterGroup: "local",
    executionMode: "optional-local-onnx",
    executionBadge: "Optional local ONNX package",
    executionShortLabel: "Local · ONNX package",
    verificationKind: "reference-tensor-verified-unvalidated",
    verificationBadge: "Reference tensor verified · Unvalidated biology",
    verificationDetail:
      "Loci validates the ONNX operator subset, proves static graph memory bounds (2 GiB budget), and reproduces the embedded [1, 2, 224, 224] float32 reference tensors on CPUExecutionProvider (0 mismatches, max absolute error 3.45e-5 at rtol=1e-3, atol=1e-3) before import and before every run. Reference parity proves runtime compatibility only, not biological accuracy.",
    target: "Fluorescence nuclei & boundaries (2D)",
    modalitySummary: "2D scalar fluorescence (BCYX static tiles)",
    taskLabel: "2D nuclear boundaries",
    modalityTags: [
      "2D scalar fluorescence",
      "Foreground & boundary probabilities",
      "BioImage.IO 0.5 / loci.model-package/1",
    ],
    summary:
      "Find nuclei in a single fluorescence channel. Preview the outlines, correct touching objects and measure each nucleus against the original image.",
    cardSummary:
      "Maps nuclear interiors and boundaries in fluorescence images with a 2D U-Net.",
    publisherBadge: "Zenodo 6647674 · 0.4.4",
    searchTerms: [
      "bioimageio",
      "bioimage.io",
      "onnx",
      "u-net",
      "unet",
      "nuclei",
      "boundary",
      "zenodo",
      "6647674",
      "cpu",
    ],
    taskSummary:
      "Executes static BCYX float32 tiled inference with halo cropping, overlays probability and candidate label boundaries in a non-adopted preview, and requires bit-exact preview reproduction on publication.",
    inputContract:
      "One scalar fluorescence channel at the model’s declared pixel scale. Calibrated sources require an explicit scale declaration.",
    lociPathway:
      "Choose the fluorescence channel in Analyze → Use a model. Check the preview before saving the result.",
    workbenchRoute: {
      kind: "onnx-model-package",
      actionLabel: "Open Use a model in Analyze",
      inspectorLocation: "Analyze → Use a model",
    },
    catalogInstall: {
      packageVersion: "0.1.0-publication-20261015-r2",
      originLabel:
        "BioImage.IO affable-shark v0 (hypha.aicell.io · original Zenodo 6647674)",
      downloadBytes: NUCLEI_MODEL_INSTALL.downloadBytes,
      packageSha256: NUCLEI_MODEL_INSTALL.packageSha256,
      workingBytes: NUCLEI_MODEL_INSTALL.workingBytes,
    },
    artifact: {
      artifactId: "nuclei-segmentation-boundary-model",
      fileName: "weights.onnx (Zenodo 6647674 BioImage.IO 0.4.4) → Loci ONNX-only package",
      version:
        "Upstream Zenodo 6647674 (BioImage.IO 0.4.4, v0.1.0) · catalog adapter 0.1.0-publication-20261015-r2",
      sha256: BIOIMAGEIO_NUCLEI_BOUNDARY_WEIGHTS_ONNX_SHA256,
      digestBasis: "loci-verified",
      digestBasisLabel:
        "Upstream Zenodo 6647674 weights.onnx SHA-256 (verified by Loci on catalog install, local package import, and before every CPU ONNX Runtime execution)",
      sizeBytes: null,
      companionNote: `Raw Zenodo record 6647674 is a BioImage.IO 0.4.4 multi-format archive (weights.onnx, weights.pt, weights-torchscript.pt) and requires Loci-compatible ONNX-only packaging (loci.model-package/1 loci-model.json or single-weight BioImage.IO 0.5 rdf.yaml; see docs/MODEL_PACKAGE_FORMAT.md). Explicit user-click installation downloads the three pinned upstream files from the version-pinned BioImage.IO affable-shark v0 artifact (hypha.aicell.io; original Zenodo 6647674), verifies exact hashes, and installs the audited 0.1.0-publication-20261015-r2 adapted ONNX-only package wrapper (package SHA-256 ${NUCLEI_MODEL_INSTALL.packageSha256}) into the current study. Local directory import and recovery also remain available offline, including the legacy 0.1.0-zenodo-v7 adapted ONNX-only package wrapper (package SHA-256 ${BIOIMAGEIO_NUCLEI_BOUNDARY_ADAPTED_PACKAGE_SHA256}, metadata SHA-256 dfde9bd3902187e5…, reference input SHA-256 c29bd6e16e3f7856…, reference output SHA-256 510181f38930e59e…).`,
      runtimeRequirement:
        "Local engine optional ONNX extra (uv sync --extra onnx · onnxruntime CPUExecutionProvider, 2 GiB working budget)",
    },
    rights: {
      codeLicense: "Apache-2.0 (Loci bounded ONNX package adapter)",
      weightsLicense: "CC-BY-4.0 supplier declaration (Constantin Pape · Zenodo 10.5281/zenodo.6647674)",
      trainingDataLineage:
        "Supplier-declared fluorescence nuclei training set in BioImage.IO 0.4.4 RDF metadata (DSB 2018 subset); Loci records redistribution and commercial conclusions as requiring independent review.",
      redistribution: "Separate human review required · not bundled by Loci",
      commercialUse: "Separate human review required",
    },
    limitations: [
      "Passing the embedded .npy reference tensor test establishes technical runtime compatibility only, never biological or clinical validity.",
      "Raw Zenodo 6647674 uses BioImage.IO 0.4.4 with multiple weight formats and dynamic shape steps, so Loci-compatible ONNX-only packaging or adaptation must be available before import.",
      "Loci never silently resamples pixels; if source calibration differs from the package scale, you must supply an explicit compatibility override declaration.",
      "Only the audited static-shape ONNX operator subset (Conv, InstanceNormalization, Relu, MaxPool, Resize, Concat, Sigmoid, etc.) is accepted.",
    ],
    citation: {
      authors: "Ronneberger, O., Fischer, P. & Brox, T.",
      year: 2015,
      title: "U-Net: Convolutional Networks for Biomedical Image Segmentation",
      venue: "Medical Image Computing and Computer-Assisted Intervention – MICCAI 2015, LNCS 9351, 234–241",
      publicationStatus: "Peer-reviewed conference paper",
      doi: "10.1007/978-3-319-24574-4_28",
      linkId: "unet-2015-paper",
      secondaryNote:
        "Model package deposition: Pape, C. (2022), NucleiSegmentationBoundaryModel (Zenodo record 6647674, BioImage.IO 0.4.4 multi-format archive, DOI 10.5281/zenodo.6647674). Catalog specification: Ouyang, W. et al. (2022), BioImage Model Zoo, bioRxiv preprint (DOI 10.1101/2022.06.07.495102 — catalog preprint only, not peer-reviewed and not evidence of model accuracy).",
    },
    primaryLink: linkDescriptor(
      "bioimageio-nuclei-boundary-zenodo",
      "Upstream Zenodo 6647674 (0.4.4 multi-format)",
      "download",
      "doi.org",
    ),
    secondaryLinks: [
      linkDescriptor("unet-2015-paper", "U-Net MICCAI 2015 (DOI)", "paper", "doi.org"),
      linkDescriptor(
        "bioimageio-models-catalog",
        "BioImage.IO model catalog",
        "catalog",
        "bioimage.io",
      ),
      linkDescriptor(
        "bioimageio-preprint",
        "Catalog bioRxiv preprint (DOI)",
        "paper",
        "doi.org",
      ),
    ],
  },
  {
    id: "puma-tissue-cpu",
    title: "PUMA tissue nnU-Net · fold 4",
    subtitle:
      "Six-class PlainConvUNet histopathology candidate (fold 4 · class 4 epidermis) · converted network_weights.pth + conversion-receipt.json (0.1.0)",
    taskCategory: "segment",
    filterGroup: "local",
    executionMode: "optional-local-tissue",
    executionBadge: "Optional local tissue profile",
    executionShortLabel: "Local · tissue profile",
    verificationKind: "unvalidated-candidate-files-verified",
    verificationBadge: "Unvalidated research candidate · Exact converted pair verified",
    verificationDetail:
      "Code-owned loci.tissue-model-profile/v1 contract pins exact converted fold-4 PlainConvUNet network_weights.pth (185,432,060 bytes) and conversion-receipt.json SHA-256 digests (distinct from the original fold-4 checkpoint inside Zenodo 14651631 checkpoints.zip; the paper's published multi-fold ensemble differs). Catalogue discovery inspects Python 3.12 / Torch 2.13.0 / NumPy 2.4.6 / SciPy 1.18.1 metadata without importing Torch; execution re-verifies both file identities in a disposable CPU worker.",
    target: "Epidermis (class 4) within a six-class map, including background",
    modalitySummary: "2D H&E melanoma histopathology (uint8 RGB, ≤1024 px)",
    taskLabel: "Tissue compartments",
    modalityTags: [
      "2D H&E histopathology",
      "Six-class PlainConvUNet (fold 4)",
      "Class 4 epidermis extraction",
    ],
    summary:
      "Six-class PlainConvUNet (fold 4) for melanoma H&E tissue compartments on local CPU, highlighting class-4 epidermis (the paper's ensemble differs). Needs pre-converted network_weights.pth + conversion-receipt.json (no published Loci bundle; Zenodo 14651631 holds original ~2.5 GB checkpoints.zip).",
    cardSummary:
      "Labels tissue compartments in melanoma H&E. The fold-4 nnU-Net highlights predicted epidermis.",
    publisherBadge: "Zenodo 14651631 · checkpoints",
    searchTerms: [
      "puma",
      "nnunet",
      "nnu-net",
      "plainconvunet",
      "fold 4",
      "class 4",
      "h&e",
      "he",
      "histology",
      "histopathology",
      "epidermis",
      "skin",
      "tissue",
      "melanoma",
      "zenodo",
      "14651631",
    ],
    taskSummary:
      "Runs fold 4 of the six-class nnU-Net PlainConvUNet (background, stroma, blood vessel, tumor, epidermis, necrosis) over the full native RGB image context (population Z-score per channel, 512 × 512 overlapping mirror-averaged CPU tiles) and extracts class-4 epidermis regions while preserving all six original predicted tissue classes. The paper's published multi-fold ensemble differs from this single fold-4 checkpoint.",
    inputContract:
      "Complete native level-0 uint8 RGB or RGBA plane (YXRGB, maximum edge 1,024 px; RGBA discards alpha without compositing via puma-first-three-samples). Requires explicit user declaration of Hematoxylin & eosin (H&E) preparation from acquisition records.",
    lociPathway:
      "When you already have the exact pre-converted local network_weights.pth and conversion-receipt.json pair (no pre-converted Loci bundle is published externally; Zenodo 14651631 checkpoints.zip is not directly importable), open Analyze → Epidermis model, import both files, declare H&E preparation, preview the candidate mask, and inspect or correct compartment regions separately from original predictions.",
    workbenchRoute: {
      kind: "tissue-epidermis",
      actionLabel: "Open Epidermis model (needs converted pair)",
      inspectorLocation: "Analyze → Epidermis model",
    },
    artifact: {
      artifactId: "puma-fold4-network-weights",
      fileName: "network_weights.pth + conversion-receipt.json (converted from checkpoints.zip)",
      version: "puma-tissue-cpu 0.1.0 · nnU-Net PlainConvUNet fold 4 (puma-engine312-cpu-fp32-network-fp16-stitch/v1)",
      sha256: PUMA_CONVERTED_WEIGHTS_SHA256,
      digestBasis: "loci-verified",
      digestBasisLabel:
        "Exact converted network_weights.pth SHA-256 verified by Loci together with conversion-receipt.json before atomic import and CPU execution",
      sizeBytes: 185_432_060,
      companionNote: `Loci's Epidermis importer requires two exact pre-converted local files: network_weights.pth (185,432,060 bytes, SHA-256 ${PUMA_CONVERTED_WEIGHTS_SHA256}) and conversion-receipt.json (SHA-256 ${PUMA_CONVERSION_RECEIPT_SHA256}). No pre-converted Loci bundle is published externally; Zenodo record 14651631 distributes only the original ~2.5 GB checkpoints.zip archive (2,515,424,261 bytes), and ${PUMA_ORIGINAL_FOLD4_CHECKPOINT_SHA256} identifies the original fold-4 nnU-Net checkpoint file inside that archive, not the zip archive itself.`,
      runtimeRequirement:
        "Optional local CPU runtime: Python 3.12, torch==2.13.0, numpy==2.4.6, scipy==1.18.1 (2–8 GiB working budget)",
    },
    rights: {
      codeLicense: "MIT (upstream PUMA) · Apache-2.0 (architecture reference)",
      weightsLicense: "MIT declared on Zenodo record 10.5281/zenodo.14651631",
      trainingDataLineage:
        "PUMA melanoma histopathology dataset declares CC0 on Zenodo record 10.5281/zenodo.15050523; independent derivative distribution review not completed.",
      redistribution: "Not bundled by Loci · derivative distribution review not completed",
      commercialUse:
        "Separate human review required (upstream Zenodo record declares MIT and dataset CC0, but Loci has not completed a commercial or derivative-distribution review)",
    },
    limitations: [
      "Single fold-4 six-class PlainConvUNet checkpoint; the PUMA paper's published multi-fold ensemble differs and outputs are not equivalent to ensemble benchmarks.",
      "No publicly published pre-converted Loci bundle exists; the ~2.5 GB upstream Zenodo checkpoints.zip cannot be imported directly without the exact converted network_weights.pth and conversion-receipt.json pair.",
      "Produces tissue regions, not cell counts; class-4 epidermis does not identify the basal boundary, define the dermis, or establish a tissue-thickness measurement (use Annotate → Epidermal thickness for manual transects).",
      "Retained epidermis scores are uncalibrated softmax values, not validated confidence estimates.",
      "Trained on melanoma histopathology ROIs; independent accuracy across skin sites, scanners, or staining labs is not established.",
    ],
    citation: {
      authors: "Schuiveling, M., Liu, H., Eek, D. et al.",
      year: 2025,
      title:
        "A novel dataset for nuclei and tissue segmentation in melanoma with baseline nuclei segmentation and tissue segmentation benchmarks",
      venue: "GigaScience 14, giaf011",
      publicationStatus: "Peer-reviewed journal article",
      doi: "10.1093/gigascience/giaf011",
      linkId: "puma-paper",
    },
    primaryLink: linkDescriptor(
      "puma-weights-zenodo",
      "Upstream Zenodo 14651631 (2.5 GB checkpoints.zip)",
      "download",
      "doi.org",
    ),
    secondaryLinks: [
      linkDescriptor(
        "puma-baseline-repo",
        "PUMA baseline code (21178205)",
        "repository",
        "github.com",
      ),
      linkDescriptor(
        "puma-dataset-zenodo",
        "PUMA dataset 15050523 (DOI)",
        "catalog",
        "doi.org",
      ),
      linkDescriptor("puma-paper", "GigaScience 2025 (DOI)", "paper", "doi.org"),
    ],
  },
  {
    id: "plantseg-ovules-ds1x",
    title: "PlantSeg · Arabidopsis ovules",
    subtitle: "Confocal cell-wall boundaries and 3D cell instances",
    taskCategory: "segment",
    filterGroup: "external",
    executionMode: "external-label-return",
    executionBadge: "External · ZYX label TIFF",
    executionShortLabel: "External · volume labels",
    verificationKind: "external-unverified-grid-checked",
    verificationBadge: "External prediction · grid checked on import",
    verificationDetail: "Loci checks label geometry and integer IDs. Inspect alignment throughout the volume.",
    target: "Cells in fixed Arabidopsis ovules",
    modalitySummary: "3D confocal cell-wall fluorescence",
    taskLabel: "3D cell segmentation",
    modalityTags: ["plant tissue", "confocal", "cell wall", "ZYX"],
    summary: "The ds1x network predicts cell walls in an ovule stack. Watershed and graph partitioning, such as Multicut or GASP, produce the cell IDs for import.",
    cardSummary: "Separate individual plant cells in a confocal cell-wall volume.",
    publisherBadge: "Zenodo · 7772553",
    searchTerms: ["plantseg", "arabidopsis", "ovule", "3D U-Net", "Multicut", "GASP", "watershed"],
    taskSummary: "Partition a 3D boundary probability volume into labeled cells.",
    inputContract: "One scalar confocal ZYX stack. Training spacing was 0.235 × 0.075 × 0.075 µm (ZYX). Use the full native XY grid at one T/C and a matching Z range of at least two planes.",
    lociPathway: "Return the final cell IDs on the original grid as a single-series, single-level TIFF with declared ZYX axes, one unsigned scalar YX page per Z, Orientation 1 and zero background. Select the matching source volume, review the middle-plane preview and confirm alignment across Z.",
    workbenchRoute: {
      kind: "labels-import",
      actionLabel: "Open volume label importer",
      inspectorLocation: "Analyze → Segment & measure → Import existing labels",
    },
    artifact: {
      artifactId: "confocal_3D_unet_ovules_ds1x",
      fileName: "unet3d-arabidopsis-ovules-confocal-ds1x.pytorch",
      version: "Zenodo v2 · record 7772553 · ds1x",
      sha256: "9fd5bdb05f01b6eb284c2aac278570a5563dab5c2356d044a95e4c2df179d308",
      digestBasis: "loci-verified",
      digestBasisLabel: "Loci verified the checkpoint SHA-256 and Zenodo MD5 1f63b96697b968f5e8085ca454b5498c in a held-out ovule run. Review alignment when importing your own labels.",
      sizeBytes: 16_345_313,
      runtimeRequirement: "External PlantSeg with the ds1x checkpoint and corresponding model configuration",
    },
    rights: {
      codeLicense: "MIT (PlantSeg)",
      weightsLicense: "CC BY 4.0 (Zenodo record 7772553)",
      trainingDataLineage: "Arabidopsis ovule confocal stacks, BioImage Archive S-BIAD1392. The archive applies EMBL-EBI Terms of Use where an accession lists no separate licence.",
      redistribution: "External weights, attribution required. Training images excluded.",
      commercialUse: "Weight reuse requires attribution. Assess dataset rights separately.",
    },
    limitations: [
      "Different voxel spacing or faint cell walls can change split and merge errors. Check interior and peripheral cells on representative stacks.",
      "Boundary probabilities are floating-point predictions. Import only the final instance IDs as uint8, uint16 or uint32, preserving every ID.",
    ],
    citation: {
      authors: "Wolny, A., Cerrone, L. et al.", year: 2020,
      title: "Accurate and versatile 3D segmentation of plant tissues at cellular resolution",
      venue: "eLife 9, e57613", publicationStatus: "Peer-reviewed journal article",
      doi: "10.7554/eLife.57613", linkId: "plantseg-paper",
    },
    primaryLink: linkDescriptor("plantseg-record", "ds1x checkpoint and training configuration", "catalog", "zenodo.org"),
    secondaryLinks: [
      linkDescriptor("plantseg-registry", "PlantSeg model registry", "repository", "github.com"),
      linkDescriptor("plantseg-paper", "PlantSeg methods and benchmarks", "paper", "doi.org"),
    ],
  },
  {
    id: "mesmer-multiplex-tissue",
    title: "Mesmer · multiplex tissue",
    subtitle: "Whole-cell or nuclear instance labels from two aligned markers",
    taskCategory: "segment",
    filterGroup: "external",
    executionMode: "external-label-return",
    executionBadge: "External · YX label TIFF",
    executionShortLabel: "External · plane labels",
    verificationKind: "external-unverified-grid-checked",
    verificationBadge: "External prediction · grid checked on import",
    verificationDetail: "Loci checks the returned native plane. External segmentation settings and accuracy require review.",
    target: "Whole cells or nuclei in tissue sections",
    modalitySummary: "2D multiplex tissue imaging",
    taskLabel: "2D instance segmentation",
    modalityTags: ["multiplex immunofluorescence", "nuclear marker", "membrane marker"],
    summary: "Mesmer uses two aligned markers to estimate cell or nuclear boundaries in tissue sections. Choose a single compartment for each return.",
    cardSummary: "Outline whole cells or nuclei in multiplex tissue sections.",
    publisherBadge: "DeepCell · model 9",
    searchTerms: ["Mesmer", "TissueNet", "PanopticNet", "DAPI", "membrane", "cytoplasm"],
    taskSummary: "Predict cell interiors and centers, then use watershed to assign instance IDs.",
    inputContract: "Use one full native plane with two registered scalar channels in nuclear then membrane/cytoplasmic order. Supply the acquisition’s isotropic XY microns per pixel (training used 0.5 µm/pixel).",
    lociPathway: "In DeepCell, run Mesmer.predict with image_mpp and compartment='whole-cell' or 'nuclear'. Export one batch item and one compartment as a single-page scalar unsigned YX TIFF on the original grid (Orientation 1, zero background). In Loci select the matching T/Z and raw measurement channel, review the overlay and confirm.",
    workbenchRoute: {
      kind: "labels-import",
      actionLabel: "Open plane label importer",
      inspectorLocation: "Analyze → Segment & measure → Import existing labels",
    },
    artifact: {
      artifactId: "models/MultiplexSegmentation-9.tar.gz",
      fileName: "MultiplexSegmentation-9.tar.gz",
      version: "Model 9 · deepcell-tf 0.12.10",
      sha256: null,
      digestBasis: "publisher-reported",
      digestBasisLabel: "DeepCell 0.12.10 pins archive MD5 a1dfbce2594f927b9112f23a0a1739e0. External weights were not checked by Loci.",
      sizeBytes: null,
      runtimeRequirement: "External DeepCell/TensorFlow. Initial weight acquisition requires DeepCell access in that environment.",
    },
    rights: {
      codeLicense: "Modified Apache 2.0 · non-commercial academic use",
      weightsLicense: "DeepCell modified Apache licence · non-commercial academic use",
      trainingDataLineage: "TissueNet · modified Apache licence for non-commercial academic use",
      redistribution: "Weights and training images excluded from Loci.",
      commercialUse: "Separate permission from the rights holder required.",
    },
    limitations: [
      "Low signal, heterogeneous staining and defocus contributed to errors in the published evaluation. Inspect boundaries on your tissue and marker panel.",
      "Return a single compartment with uint8, uint16 or uint32 IDs that fit without truncation. A merged RGB image or a multi-compartment stack cannot be adopted as plane labels.",
    ],
    citation: {
      authors: "Greenwald, N. F. et al.", year: 2022,
      title: "Whole-cell segmentation of tissue images with human-level performance using large-scale data annotation and deep learning",
      venue: "Nature Biotechnology 40, 555–565", publicationStatus: "Peer-reviewed journal article",
      doi: "10.1038/s41587-021-01094-0", linkId: "mesmer-paper",
    },
    primaryLink: linkDescriptor("mesmer-guide", "Obtain weights and run Mesmer", "catalog", "deepcell.readthedocs.io"),
    secondaryLinks: [
      linkDescriptor("mesmer-registry", "Versioned DeepCell artifact key and digest", "repository", "github.com"),
      linkDescriptor("mesmer-paper", "Mesmer methods and tissue benchmarks", "paper", "doi.org"),
    ],
  },
  {
    id: "dynacell-ipsc-nucleus",
    title: "DynaCell · iPSC nuclear virtual stain",
    subtitle: "Reconstructed Phase3D to normalized predicted nuclear signal",
    taskCategory: "virtual-stain",
    filterGroup: "local",
    executionMode: "optional-local-virtual-stain",
    executionBadge: "Optional local · CPU",
    executionShortLabel: "Local · virtual stain",
    verificationKind: "unvalidated-checkpoint-hash-verified",
    verificationBadge: "Pinned checkpoint · research prediction",
    verificationDetail: "Checkpoint identity is pinned. Acquisition-specific fidelity requires comparison with measured fluorescence.",
    target: "Nuclei in unperturbed healthy human WTC-11 iPSCs",
    modalitySummary: "Reconstructed 3D quantitative phase",
    taskLabel: "3D virtual staining",
    modalityTags: ["label-free microscopy", "Phase3D", "WTC-11"],
    summary: "Predict a normalized nuclear signal from reconstructed Phase3D in unperturbed healthy human WTC-11 iPSCs. Compare the derived volume with measured nuclear fluorescence where available.",
    cardSummary: "Predict normalized nuclear signal from a WTC-11 iPSC phase volume.",
    publisherBadge: "DynaCell · v1",
    searchTerms: ["virtual staining", "Phase3D", "nuclei", "label-free", "UNeXt2"],
    taskSummary: "Predict a continuous nuclear signal on a 3D voxel grid.",
    inputContract: "A scalar float32 OME-TIFF of reconstructed Phase3D from unperturbed WTC-11 iPSCs. Select one time point, 15–40 Z sections of 512 × 512 pixels, sampled at 0.290 µm in Z and 0.108 µm in X and Y.",
    lociPathway: "Open the virtual stain control, provision the pinned weights and select the reconstructed phase volume for local CPU prediction.",
    workbenchRoute: {
      kind: "virtual-stain",
      actionLabel: "Open virtual stain control",
      inspectorLocation: "Analyze → Virtual nuclear stain",
    },
    artifact: {
      artifactId: "ipsc/nucleus/unext2",
      fileName: "epoch=80-step=25272.ckpt",
      version: "DynaCell v1 · iPSC nucleus UNeXt2 · epoch 80, step 25272",
      sha256: DYNACELL_NUCLEUS.sha256,
      digestBasis: "loci-verified",
      digestBasisLabel: "SHA-256 pinned in the Loci install profile for the upstream checkpoint.",
      sizeBytes: DYNACELL_NUCLEUS.sizeBytes,
      runtimeRequirement: "Optional installed weights and local CPU runtime",
    },
    rights: {
      codeLicense: "BSD-3-Clause (upstream)",
      weightsLicense: "BSD-3-Clause (upstream DynaCell weights)",
      trainingDataLineage: "WTC-11 microscopy from the Allen Institute. Allen image and derivative terms apply.",
      redistribution: "Weights provisioned separately. Allen fixture images excluded.",
      commercialUse: "Review the Allen data terms separately from the BSD model licence.",
    },
    limitations: [
      "Output is a normalized prediction. Use measured fluorescence for intensity quantitation.",
      "Interior Pearson r ranged from 0.48 to 0.77 across four publisher test fields. The median baseline had lower absolute error on one field. Bright nuclear signal was systematically underestimated in three further-field checks.",
    ],
    citation: {
      authors: "Kalinin, A. A., Zheng, D., Theodoro, T. M. et al.", year: 2026,
      title: "The DynaCell Evaluation Suite for Dynamic 3D Virtual Staining of Live Cells",
      venue: "arXiv:2611.02324, November 2026", publicationStatus: "arXiv preprint",
      doi: "10.48550/arXiv.2611.02324", linkId: "dynacell-paper",
    },
    primaryLink: linkDescriptor("dynacell-project", "DynaCell model release", "catalog", "biohub.github.io"),
    secondaryLinks: [
      linkDescriptor("dynacell-checkpoint", "iPSC nucleus checkpoint (386 MB)", "download", "dynacell.s3.us-west-2.amazonaws.com"),
      linkDescriptor("dynacell-paper", "November 2026 preprint", "paper", "doi.org"),
      linkDescriptor("allen-terms", "Allen Institute image terms", "catalog", "www.allencell.org"),
    ],
  },
  {
    id: "care-planaria-3d",
    title: "CARE · low-light 3D planaria",
    subtitle: "CSBDeep demonstration model for low-SNR 3D fluorescence",
    taskCategory: "restore",
    filterGroup: "external",
    executionMode: "external-restored-volume",
    executionBadge: "External · Open restored volume",
    executionShortLabel: "External · restored stack",
    verificationKind: "external-unverified-derived-signal",
    verificationBadge: "Derived intensity",
    verificationDetail:
      "Loci opens the output as a separate image using the native file picker. Keep the original acquisition and record the input, CARE model and settings with the output. Opening a file establishes neither model provenance nor registration to the raw image.",
    target: "Schmidtea mediterranea (planaria) nuclei",
    modalitySummary: "3D spinning-disk confocal fluorescence",
    taskLabel: "3D low-light denoising",
    modalityTags: ["3D fluorescence", "Low-SNR denoising", "Restoration"],
    summary:
      "Restore a low-light planaria stack in Fiji with the CSBDeep demo. Open the saved result as a separate image in Loci to inspect the derived signal.",
    cardSummary: "Denoise low-SNR planaria fluorescence externally and inspect the derived stack in Loci.",
    publisherBadge: "CSBDeep · planaria demo",
    searchTerms: ["CARE", "CSBDeep", "restoration", "denoise", "planarian", "flatworm", "low light", "low SNR", "Fiji", "KNIME"],
    taskSummary:
      "The demo predicts the location (μ) and scale (b) of a Laplace distribution per voxel. Fiji displays the location as the restored result. The scale describes model uncertainty in the restored intensity.",
    inputContract:
      "Use a scalar 3D fluorescence Z-stack. Export the result as a separate calibrated TIFF or OME-TIFF. Check axis order, spacing and spatial correspondence before comparing it with the acquisition.",
    lociPathway:
      "Save the Fiji result under a new filename and choose Open restored volume… to select it. Adjust the view in Image & channels. Use Register & resample if an explicit transform is needed.",
    workbenchRoute: {
      kind: "open-restored-volume",
      actionLabel: "Open restored volume…",
      inspectorLocation: "the native image picker",
    },
    artifact: {
      artifactId: "csbdeep-demo-3d-denoising-planaria",
      fileName: "model-planaria.zip",
      version: "CSBDeep Fiji Planaria demo",
      sha256: null,
      digestBasis: "external-unverified",
      digestBasisLabel: "The publisher demo page gives no checkpoint digest. Loci has no verified checkpoint for this entry.",
      sizeBytes: null,
      companionNote: "The Fiji demo downloads the model when run. Loci reads the user-selected output TIFF.",
      runtimeRequirement: "External Fiji with the CSBDeep plugin",
    },
    rights: {
      codeLicense: "BSD-2-Clause for the Fiji plugin. BSD-3-Clause for the CSBDeep Python toolbox.",
      weightsLicense: "The scenario page offers a demonstration and gives no separate checkpoint licence. Confirm terms with the publisher before reuse beyond the demo.",
      trainingDataLineage: "Paired low- and high-signal planaria nuclei stacks. The Edmond paper data record (10.17617/3.FDFZOF) declares CC0 1.0.",
      redistribution: "Loci bundles no weights or example images for this entry.",
      commercialUse: "Confirm checkpoint reuse rights with the publisher. The code and data licences apply to their respective assets.",
    },
    limitations: [
      "Restoration can suppress real dim structures or introduce features. Use the acquired signal for intensity measurements unless paired high-SNR reference data support your quantitative use.",
      "The publisher demonstrated this checkpoint on planaria nuclei. Performance on other specimens, labels and acquisition settings is unestablished.",
    ],
    citation: {
      authors: "Weigert, M., Schmidt, U., Boothe, T. et al.",
      year: 2018,
      title: "Content-aware image restoration: pushing the limits of fluorescence microscopy",
      venue: "Nature Methods 15, 1090–1097",
      publicationStatus: "Peer-reviewed journal article",
      doi: "10.1038/s41592-018-0216-7",
      linkId: "care-paper",
    },
    primaryLink: linkDescriptor(
      "care-planaria-scenario",
      "CSBDeep Planaria demo",
      "catalog",
      "csbdeep.bioimagecomputing.com",
    ),
    secondaryLinks: [
      linkDescriptor("care-planaria-fiji-demo", "Fiji instructions", "repository", "github.com"),
      linkDescriptor("care-fiji-license", "Fiji plugin licence", "repository", "github.com"),
      linkDescriptor("care-planaria-dataset", "Edmond research data", "catalog", "doi.org"),
      linkDescriptor("care-paper", "Nature Methods 2018", "paper", "doi.org"),
    ],
  },
  {
    id: "organoidtracker-2",
    title: "OrganoidTracker 2.0",
    subtitle: "3D time-lapse nuclear tracking and lineage reconstruction",
    taskCategory: "track",
    filterGroup: "external",
    executionMode: "external-tracking-graph",
    executionBadge: "External · Import .aut v1 graph",
    executionShortLabel: "External · lineage graph",
    verificationKind: "external-unverified-tracking-graph",
    verificationBadge: "Publisher model · Imported scores",
    verificationDetail:
      "Loci reads the exported graph and preserves link probability and marginal probability as separate optional values. Missing values stay missing. Loci's timed-label tracker runs independently of the imported graph.",
    target: "Dividing nuclei in mouse intestinal organoids",
    modalitySummary: "3D time-lapse confocal nuclear fluorescence (H2B-mCherry)",
    taskLabel: "Cell lineages and divisions",
    modalityTags: ["3D+t fluorescence", "Organoid lineages", ".aut v1 graph"],
    summary:
      "Track nuclear positions and divisions in OrganoidTracker. Import the exported lineage graph into Loci to inspect tracks and reported link probabilities.",
    cardSummary: "Track 3D time-lapse nuclei externally and review lineages and link uncertainty in Loci.",
    publisherBadge: "OrganoidTracker · official repository",
    searchTerms: ["organoidtracker", "tracking", "time lapse", "time-lapse", "division", "uncertainty", "confidence", "marginal probability", "D3 node-link"],
    taskSummary:
      "The external pipeline predicts nuclear centers, links and divisions, then selects tracks by min-cost flow. Marginalization estimates link probability using nearby alternative tracking solutions.",
    inputContract:
      "Select the corresponding calibrated native 3D OME-TIFF time series with uniform timing. Import a plain .aut v1 JSON file containing D3 nodes and links, with matching XYZ spacing and time interval and without image offsets.",
    lociPathway:
      "In Analyze → Track over time, set the upstream time point for the first image frame and the graph origin. Confirm the native grid and frame mapping, then use Choose .aut graph… to select the local file.",
    workbenchRoute: {
      kind: "temporal-tracking",
      actionLabel: "Open Track over time",
      inspectorLocation: "Analyze → Track over time",
    },
    artifact: {
      artifactId: "organoidtracker2-intestinal-organoid-models",
      fileName: "models_all.zip",
      version: "Intestinal organoid weights v3 · Zenodo 18479952",
      sha256: null,
      digestBasis: "publisher-reported",
      digestBasisLabel: "Zenodo reports MD5 c46ab6daae057209c20b844e2ab0c21b for the v3 archive. Loci has no verified checkpoint for this entry.",
      sizeBytes: null,
      companionNote: "The v3 archive provides TensorFlow and Keras/PyTorch variants for cell, link and division detection.",
      runtimeRequirement: "External OrganoidTracker environment",
    },
    rights: {
      codeLicense: "GPL-2.0 for the application. The repository identifies some neural network code under MIT.",
      weightsLicense: "CC-BY-4.0 for Zenodo 18479952.",
      trainingDataLineage: "Mouse intestinal organoid H2B-mCherry data, acquired at 0.32 × 0.32 × 2 µm XYZ spacing. The separate Zenodo example (13982844) declares CC-BY-4.0.",
      redistribution: "Loci bundles no OrganoidTracker software, weights or datasets.",
      commercialUse: "Follow the applicable software and attribution terms. Confirm access and reuse terms for separately requested training data.",
    },
    limitations: [
      "Scores come from OrganoidTracker. Their calibration can change with imaging conditions and specimen.",
      "The importer requires consecutive links with at most one parent and two daughters per detection. The image and graph must refer to the same native grid and time series.",
    ],
    citation: {
      authors: "Betjes, M. A., Kok, R. N. U., Tans, S. J. & van Zon, J. S.",
      year: 2025,
      title: "Cell tracking with accurate error prediction",
      venue: "Nature Methods 22, 2400–2410",
      publicationStatus: "Peer-reviewed journal article",
      doi: "10.1038/s41592-025-02845-6",
      linkId: "organoidtracker-paper",
    },
    primaryLink: linkDescriptor(
      "organoidtracker-repo",
      "OrganoidTracker repository",
      "repository",
      "github.com",
    ),
    secondaryLinks: [
      linkDescriptor("organoidtracker-organoid-weights", "Organoid weights v3", "catalog", "doi.org"),
      linkDescriptor("organoidtracker-example-data", "Organoid example and tracking data", "catalog", "doi.org"),
      linkDescriptor("organoidtracker-paper", "Nature Methods 2025", "paper", "doi.org"),
      linkDescriptor("organoidtracker-pmc", "Open-access full text", "paper", "pmc.ncbi.nlm.nih.gov"),
    ],
  },
]);

export function isModelLibraryId(value: unknown): value is ModelLibraryId {
  return (
    typeof value === "string" &&
    MODEL_LIBRARY_ENTRIES.some((entry) => entry.id === value)
  );
}

export function isModelLibraryLinkId(value: unknown): value is ModelLibraryLinkId {
  return (
    typeof value === "string" &&
    Object.hasOwn(MODEL_LIBRARY_OFFICIAL_LINKS, value)
  );
}

/**
 * Maps an exact pinned official URL back to its code-owned fixed link ID.
 * Returns null for any URL not registered in MODEL_LIBRARY_OFFICIAL_LINKS so
 * external credit addresses never become unbounded renderer-supplied shell URLs.
 */
export function findModelLibraryLinkIdByUrl(value: unknown): ModelLibraryLinkId | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  for (const [id, url] of Object.entries(MODEL_LIBRARY_OFFICIAL_LINKS)) {
    if (url === trimmed) {
      return id as ModelLibraryLinkId;
    }
  }
  return null;
}

export function requireModelLibraryLinkId(value: unknown): ModelLibraryLinkId {
  if (!isModelLibraryLinkId(value)) {
    throw new Error("Choose a registered official model-library source.");
  }
  return value;
}

export function resolveModelLibraryLinkUrl(value: unknown): string {
  const linkId = requireModelLibraryLinkId(value);
  const target = MODEL_LIBRARY_OFFICIAL_LINKS[linkId];
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error("The registered model-library URL is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)
  ) {
    throw new Error("The registered model-library URL is outside the approved origins.");
  }
  return target;
}
