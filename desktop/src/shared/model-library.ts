import {
  CELLPOSE_MODEL_REVISION,
  CELLPOSE_RUNTIME_VERSION,
  CELLPOSE_SAM_SHA256,
  CELLPOSE_SAM_SIZE_BYTES,
  CELLPOSE_SAM_V2_SHA256,
  CELLPOSE_SAM_V2_SIZE_BYTES,
} from "./model-registry";
import { NUCLEI_MODEL_INSTALL } from "./nuclei-model-install";

export type ModelLibraryId =
  | "cellpose-sam-v2"
  | "micro-sam-vit-b-lm"
  | "stardist-2d-versatile-fluo"
  | "bioimageio-nuclei-boundary-onnx"
  | "puma-tissue-cpu";

export type ModelLibraryLinkId =
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
  | "optional-local-profile"
  | "external-native-handoff"
  | "external-label-return"
  | "optional-local-onnx"
  | "optional-local-tissue";

export type ModelLibraryVerificationKind =
  | "unvalidated-checkpoint-hash-verified"
  | "external-unverified-handoff-grid-checked"
  | "external-unverified-grid-checked"
  | "reference-tensor-verified-unvalidated"
  | "unvalidated-candidate-files-verified";

export type ModelLibraryWorkbenchRouteKind =
  | "segment-cellpose-v2"
  | "labels-usam-handoff"
  | "labels-import"
  | "onnx-model-package"
  | "tissue-epidermis";

export type ModelLibraryPublicationStatus =
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

export const MODEL_LIBRARY_OFFICIAL_LINKS: Readonly<Record<ModelLibraryLinkId, string>> =
  deepFreeze({
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
