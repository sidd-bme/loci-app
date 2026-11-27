import { describe, expect, it } from "vitest";
import {
  CELLPOSE_MODEL_REVISION,
  CELLPOSE_SAM_SHA256,
  CELLPOSE_SAM_V2_SHA256,
  CELLPOSE_SAM_V2_SIZE_BYTES,
} from "./model-registry";
import { NUCLEI_MODEL_INSTALL } from "./nuclei-model-install";
import {
  BIOIMAGEIO_NUCLEI_BOUNDARY_ADAPTED_PACKAGE_SHA256,
  BIOIMAGEIO_NUCLEI_BOUNDARY_WEIGHTS_ONNX_SHA256,
  MICRO_SAM_VIT_B_LM_DECODER_PUBLISHER_XXH128,
  MICRO_SAM_VIT_B_LM_PUBLISHER_XXH128,
  MODEL_LIBRARY_ENTRIES,
  MODEL_LIBRARY_NATIVE_BASELINES,
  MODEL_LIBRARY_OFFICIAL_LINKS,
  PUMA_CONVERSION_RECEIPT_SHA256,
  PUMA_CONVERTED_WEIGHTS_SHA256,
  PUMA_ORIGINAL_FOLD4_CHECKPOINT_SHA256,
  STARDIST_2D_VERSATILE_FLUO_PUBLISHER_SHA256,
  findModelLibraryLinkIdByUrl,
  isModelLibraryId,
  isModelLibraryLinkId,
  requireModelLibraryLinkId,
  resolveModelLibraryLinkUrl,
} from "./model-library";

describe("curated model library catalog", () => {
  it("freezes curated entries, native baselines, and fixed-ID official links without schematic demo fields", () => {
    expect(Object.isFrozen(MODEL_LIBRARY_ENTRIES)).toBe(true);
    expect(Object.isFrozen(MODEL_LIBRARY_NATIVE_BASELINES)).toBe(true);
    expect(Object.isFrozen(MODEL_LIBRARY_OFFICIAL_LINKS)).toBe(true);
    expect(MODEL_LIBRARY_ENTRIES.map((entry) => entry.id)).toEqual([
      "cellpose-sam-v2",
      "micro-sam-vit-b-lm",
      "stardist-2d-versatile-fluo",
      "bioimageio-nuclei-boundary-onnx",
      "puma-tissue-cpu",
      "plantseg-ovules-ds1x",
      "mesmer-multiplex-tissue",
      "dynacell-ipsc-nucleus",
      "care-planaria-3d",
      "organoidtracker-2",
    ]);
    for (const entry of MODEL_LIBRARY_ENTRIES) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.artifact)).toBe(true);
      expect(Object.isFrozen(entry.rights)).toBe(true);
      expect(Object.isFrozen(entry.limitations)).toBe(true);
      expect(Object.isFrozen(entry.searchTerms)).toBe(true);
      expect("schematic" in entry).toBe(false);
      expect(entry.target.length).toBeGreaterThan(0);
      expect(entry.modalitySummary.length).toBeGreaterThan(0);
      expect(entry.taskLabel.length).toBeGreaterThan(0);
      expect(entry.executionShortLabel.length).toBeGreaterThan(0);
      expect(entry.cardSummary.length).toBeGreaterThan(0);
      expect(entry.publisherBadge.length).toBeGreaterThan(0);
      expect(entry.searchTerms.length).toBeGreaterThan(0);
      expect(isModelLibraryId(entry.id)).toBe(true);
    }
    expect(isModelLibraryId("unknown-model")).toBe(false);
    expect(isModelLibraryId(null)).toBe(false);
  });

  it("keeps exact artifact digests, publication status, and publisher-reported hashes distinct", () => {
    const cellposeV2 = MODEL_LIBRARY_ENTRIES.find((entry) => entry.id === "cellpose-sam-v2")!;
    expect(cellposeV2.workbenchRoute.kind).toBe("segment-cellpose-v2");
    expect(cellposeV2.artifact.sha256).toBe(CELLPOSE_SAM_V2_SHA256);
    expect(cellposeV2.artifact.digestBasis).toBe("loci-verified");
    expect(cellposeV2.artifact.sizeBytes).toBe(CELLPOSE_SAM_V2_SIZE_BYTES);
    expect(cellposeV2.artifact.companionNote).toContain(CELLPOSE_SAM_SHA256);
    expect(cellposeV2.primaryLink.url).toBe(
      `https://huggingface.co/mouseland/cellpose-sam/blob/${CELLPOSE_MODEL_REVISION}/cpsam_v2`,
    );
    expect(cellposeV2.secondaryLinks.map((link) => link.id)).toContain(
      "cellpose-sam-v1-checkpoint",
    );
    expect(cellposeV2.secondaryLinks.map((link) => link.id)).toContain(
      "cellpose-github-repo",
    );
    expect(cellposeV2.citation.publicationStatus).toBe("bioRxiv preprint (not peer-reviewed)");
    expect(cellposeV2.rights.commercialUse).toMatch(/restricted/i);

    const usam = MODEL_LIBRARY_ENTRIES.find((entry) => entry.id === "micro-sam-vit-b-lm")!;
    expect(usam.executionMode).toBe("external-native-handoff");
    expect(usam.artifact.version).toContain("d45ab70ece93a9eb3ca1e237b9067767b0a18263");
    expect(usam.artifact.version).toContain("diplomatic-bug 1.2");
    expect(usam.artifact.fileName).toBe("vit_b.pt + vit_b_decoder.pt (BioImage.IO diplomatic-bug 1.2)");
    expect(usam.artifact.sha256).toBeNull();
    expect(usam.artifact.digestBasis).toBe("external-unverified");
    expect(usam.artifact.digestBasisLabel).toContain(MICRO_SAM_VIT_B_LM_PUBLISHER_XXH128);
    expect(usam.artifact.digestBasisLabel).toContain(MICRO_SAM_VIT_B_LM_DECODER_PUBLISHER_XXH128);
    expect(usam.artifact.digestBasisLabel).toMatch(/not loaded or verified by loci/i);
    expect(usam.artifact.digestBasisLabel).toMatch(/not independently checked by loci/i);
    expect(usam.artifact.companionNote).toContain("vit_b_decoder.pt");
    expect(usam.primaryLink.id).toBe("micro-sam-bioimageio-card");
    expect(usam.primaryLink.url).toBe("https://bioimage.io/#/artifacts/diplomatic-bug/v0");
    expect(usam.secondaryLinks.map((link) => link.id)).toContain("micro-sam-upstream-registry");
    expect(usam.rights.weightsLicense).toMatch(/^CC-BY-4\.0 supplier declaration/i);
    expect(JSON.stringify(usam)).not.toContain("10524791");
    expect(JSON.stringify(usam)).not.toContain("vit_b_lm.pth");
    expect(usam.citation.doi).toBe("10.1038/s41592-024-02580-4");
    expect(usam.citation.publicationStatus).toBe("Peer-reviewed journal article");

    const stardist = MODEL_LIBRARY_ENTRIES.find((entry) => entry.id === "stardist-2d-versatile-fluo")!;
    expect(stardist.executionMode).toBe("external-label-return");
    expect(stardist.artifact.fileName).toBe("python_2D_versatile_fluo.zip");
    expect(stardist.artifact.sha256).toBe(STARDIST_2D_VERSATILE_FLUO_PUBLISHER_SHA256);
    expect(stardist.artifact.digestBasis).toBe("publisher-reported");
    expect(stardist.artifact.digestBasisLabel).toMatch(/publisher-reported/i);
    expect(stardist.artifact.digestBasisLabel).toMatch(/not independently checked by loci/i);
    expect(stardist.primaryLink.url).toBe(
      "https://github.com/stardist/stardist-models/releases/download/v0.1/python_2D_versatile_fluo.zip",
    );
    expect(stardist.secondaryLinks.map((link) => link.id)).toContain("stardist-github-repo");
    expect(stardist.secondaryLinks.map((link) => link.id)).toContain("stardist-v01-release");
    expect(stardist.citation.doi).toBe("10.1007/978-3-030-00934-2_30");
    expect(stardist.citation.publicationStatus).toBe("Peer-reviewed conference paper");

    const onnx = MODEL_LIBRARY_ENTRIES.find((entry) => entry.id === "bioimageio-nuclei-boundary-onnx")!;
    expect(onnx.executionMode).toBe("optional-local-onnx");
    expect(onnx.artifact.fileName).toContain("weights.onnx");
    expect(onnx.artifact.fileName).toContain("0.4.4");
    expect(onnx.artifact.sha256).toBe(BIOIMAGEIO_NUCLEI_BOUNDARY_WEIGHTS_ONNX_SHA256);
    expect(onnx.artifact.digestBasis).toBe("loci-verified");
    expect(onnx.artifact.companionNote).toContain("BioImage.IO 0.4.4 multi-format");
    expect(onnx.artifact.companionNote).toContain(BIOIMAGEIO_NUCLEI_BOUNDARY_ADAPTED_PACKAGE_SHA256);
    expect(onnx.artifact.companionNote).toContain(NUCLEI_MODEL_INSTALL.packageSha256);
    expect(onnx.artifact.companionNote).toMatch(/adapted ONNX-only package wrapper/i);
    expect(onnx.artifact.companionNote).toContain("docs/MODEL_PACKAGE_FORMAT.md");
    expect(onnx.summary).toMatch(/single fluorescence channel/i);
    expect(onnx.catalogInstall).toBeDefined();
    expect(Object.isFrozen(onnx.catalogInstall)).toBe(true);
    expect(onnx.catalogInstall).toMatchObject({
      packageVersion: "0.1.0-publication-20261015-r2",
      downloadBytes: NUCLEI_MODEL_INSTALL.downloadBytes,
      packageSha256: NUCLEI_MODEL_INSTALL.packageSha256,
      workingBytes: NUCLEI_MODEL_INSTALL.workingBytes,
    });
    for (const other of MODEL_LIBRARY_ENTRIES) {
      if (other.id !== "bioimageio-nuclei-boundary-onnx") {
        expect(other.catalogInstall).toBeUndefined();
      }
    }
    expect(onnx.primaryLink.id).toBe("bioimageio-nuclei-boundary-zenodo");
    expect(onnx.primaryLink.url).toBe("https://doi.org/10.5281/zenodo.6647674");
    expect(onnx.citation.doi).toBe("10.1007/978-3-319-24574-4_28");
    expect(onnx.citation.publicationStatus).toBe("Peer-reviewed conference paper");
    expect(onnx.citation.secondaryNote).toMatch(/10\.5281\/zenodo\.6647674/);
    expect(onnx.citation.secondaryNote).toMatch(/10\.1101\/2022\.06\.07\.495102/);
    expect(onnx.citation.secondaryNote).toMatch(/not peer-reviewed and not evidence of model accuracy/i);

    const puma = MODEL_LIBRARY_ENTRIES.find((entry) => entry.id === "puma-tissue-cpu")!;
    expect(puma.title).toBe("PUMA tissue nnU-Net · fold 4");
    expect(puma.executionMode).toBe("optional-local-tissue");
    expect(puma.cardSummary).toMatch(/melanoma h&e/i);
    expect(puma.cardSummary).toMatch(/fold-4 nnU-Net/i);
    expect(puma.summary).toMatch(/PlainConvUNet/i);
    expect(puma.summary).toMatch(/ensemble differs/i);
    expect(puma.summary).toMatch(/network_weights\.pth \+ conversion-receipt\.json/i);
    expect(puma.summary).toMatch(/checkpoints\.zip/i);
    expect(puma.workbenchRoute.actionLabel).toMatch(/needs converted pair/i);
    expect(puma.primaryLink.id).toBe("puma-weights-zenodo");
    expect(puma.primaryLink.label).toMatch(/2\.5 GB checkpoints\.zip/i);
    expect(puma.secondaryLinks.map((link) => link.id)).toContain("puma-baseline-repo");
    expect(resolveModelLibraryLinkUrl("puma-baseline-repo")).toBe(
      "https://github.com/tueimage/PUMA-challenge-baseline-track1/tree/211782054387f0d28e170ed565cdfb6e8b53d1a7",
    );
    expect(puma.artifact.fileName).toContain("network_weights.pth");
    expect(puma.artifact.fileName).toContain("conversion-receipt.json");
    expect(puma.artifact.sha256).toBe(PUMA_CONVERTED_WEIGHTS_SHA256);
    expect(puma.artifact.digestBasis).toBe("loci-verified");
    expect(puma.artifact.sizeBytes).toBe(185_432_060);
    expect(puma.artifact.companionNote).toContain(PUMA_CONVERSION_RECEIPT_SHA256);
    expect(puma.artifact.companionNote).toContain(PUMA_ORIGINAL_FOLD4_CHECKPOINT_SHA256);
    expect(puma.artifact.companionNote).toMatch(/inside that archive, not the zip archive itself/i);
    expect(puma.artifact.companionNote).toMatch(/no pre-converted loci bundle is published externally/i);
    expect(puma.citation.authors).toBe("Schuiveling, M., Liu, H., Eek, D. et al.");
    expect(puma.citation.doi).toBe("10.1093/gigascience/giaf011");
    expect(puma.citation.publicationStatus).toBe("Peer-reviewed journal article");
    expect(puma.rights.weightsLicense).toMatch(/MIT declared on Zenodo record 10\.5281\/zenodo\.14651631/);
    expect(puma.rights.commercialUse).toMatch(/separate human review required/i);
  });

  it("pins the DynaCell install identity and distinguishes the two external publisher checksums", () => {
    const entry = (id: string) => MODEL_LIBRARY_ENTRIES.find((model) => model.id === id)!;
    expect(entry("dynacell-ipsc-nucleus").artifact).toMatchObject({
      fileName: "epoch=80-step=25272.ckpt",
      sizeBytes: 386_093_992,
      sha256: "58b222f92978b50647d547e5fd69edaafa2d2c5854fbc7f7324e9bcf8835051d",
    });
    expect(entry("dynacell-ipsc-nucleus").citation.publicationStatus).toBe("arXiv preprint");
    expect(entry("plantseg-ovules-ds1x").artifact).toMatchObject({
      sha256: "9fd5bdb05f01b6eb284c2aac278570a5563dab5c2356d044a95e4c2df179d308",
      digestBasis: "loci-verified",
      digestBasisLabel: expect.stringContaining("1f63b96697b968f5e8085ca454b5498c"),
    });
    expect(entry("mesmer-multiplex-tissue").artifact).toMatchObject({
      sha256: null,
      digestBasis: "publisher-reported",
      digestBasisLabel: expect.stringContaining("a1dfbce2594f927b9112f23a0a1739e0"),
    });
  });

  it("distinguishes native built-in baselines, optional local profiles, and external workflows", () => {
    expect(MODEL_LIBRARY_NATIVE_BASELINES.map((item) => item.id)).toEqual([
      "classical-threshold-watershed",
      "loci-classical",
    ]);
    for (const baseline of MODEL_LIBRARY_NATIVE_BASELINES) {
      expect(baseline.executionBadge).toBe("Native built-in · always offline");
      expect(baseline.license).toBe("Apache-2.0");
    }

    const localEntries = MODEL_LIBRARY_ENTRIES.filter((entry) => entry.filterGroup === "local");
    const externalEntries = MODEL_LIBRARY_ENTRIES.filter((entry) => entry.filterGroup === "external");
    expect(localEntries.map((entry) => entry.id)).toEqual([
      "cellpose-sam-v2",
      "bioimageio-nuclei-boundary-onnx",
      "puma-tissue-cpu",
      "dynacell-ipsc-nucleus",
    ]);
    expect(externalEntries.map((entry) => entry.id)).toEqual([
      "micro-sam-vit-b-lm",
      "stardist-2d-versatile-fluo",
      "plantseg-ovules-ds1x",
      "mesmer-multiplex-tissue",
      "care-planaria-3d",
      "organoidtracker-2",
    ]);
  });

  it("records external restoration and lineage imports independently of local inference", () => {
    const care = MODEL_LIBRARY_ENTRIES.find((entry) => entry.id === "care-planaria-3d")!;
    expect(care).toMatchObject({
      taskCategory: "restore",
      executionMode: "external-restored-volume",
      artifact: { sha256: null, digestBasis: "external-unverified" },
      rights: {
        weightsLicense: expect.stringContaining("no separate checkpoint licence"),
        trainingDataLineage: expect.stringContaining("CC0 1.0"),
      },
      workbenchRoute: { kind: "open-restored-volume" },
    });
    const tracker = MODEL_LIBRARY_ENTRIES.find((entry) => entry.id === "organoidtracker-2")!;
    expect(tracker).toMatchObject({
      taskCategory: "track",
      executionMode: "external-tracking-graph",
      inputContract: expect.stringContaining("D3 nodes and links"),
      verificationDetail: expect.stringContaining("link probability and marginal probability as separate optional values"),
      artifact: { sha256: null, digestBasis: "publisher-reported" },
      workbenchRoute: { kind: "temporal-tracking" },
    });
  });

  it("maps every primary, secondary, and citation link ID to an approved HTTPS URL", () => {
    for (const entry of MODEL_LIBRARY_ENTRIES) {
      const linkIds = [
        entry.primaryLink.id,
        entry.citation.linkId,
        ...entry.secondaryLinks.map((item) => item.id),
      ];
      for (const linkId of linkIds) {
        expect(isModelLibraryLinkId(linkId)).toBe(true);
        expect(requireModelLibraryLinkId(linkId)).toBe(linkId);
        const url = resolveModelLibraryLinkUrl(linkId);
        expect(url).toMatch(/^https:\/\//);
        expect(findModelLibraryLinkIdByUrl(url)).toBe(linkId);
      }
    }

    const credits = import.meta.glob<{ sourceUrl: string; publicationUrl: string; licenseUrl: string }>(
      "../renderer/model-zoo/examples/*/credit.json", { eager: true, import: "default" },
    );
    expect(Object.keys(credits)).toHaveLength(5);
    for (const credit of Object.values(credits)) {
      for (const url of [credit.sourceUrl, credit.publicationUrl, credit.licenseUrl]) {
        const id = findModelLibraryLinkIdByUrl(url);
        expect(id).toBeTruthy();
        expect(resolveModelLibraryLinkUrl(id)).toBe(url);
      }
    }

    // Only exact registered URLs reverse-map to fixed link IDs; arbitrary URLs return null
    expect(findModelLibraryLinkIdByUrl("https://doi.org/10.1093/gigascience/giaf011")).toBe("puma-paper");
    expect(findModelLibraryLinkIdByUrl("https://doi.org/10.1093/gigascience/giaf011?ref=1")).toBeNull();
    expect(findModelLibraryLinkIdByUrl("https://example.org/image-source")).toBeNull();
    expect(findModelLibraryLinkIdByUrl("javascript:alert(1)")).toBeNull();
    expect(findModelLibraryLinkIdByUrl("")).toBeNull();
    expect(findModelLibraryLinkIdByUrl(null)).toBeNull();
  });
});
