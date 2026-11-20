import { describe, expect, it } from "vitest";
import { MODEL_LIBRARY_ENTRIES } from "../../shared/model-library";
import {
  buildModelZooExampleRegistry,
  isSafeLocalAssetUrl,
  parseModelZooExampleCredit,
} from "./examples";
import {
  countModelZooEntries,
  filterModelZooEntries,
  tokenizeModelZooQuery,
} from "./search";

const validPredictionCredit = {
  modelId: "puma-tissue-cpu",
  modelVersion: "0.1.0 · nnU-Net PlainConvUNet, fold 4",
  kind: "prediction",
  subject:
    "H&E-stained primary melanoma, training region 004. The overlay highlights predicted epidermis.",
  attribution:
    "Mark Schuiveling, University Medical Center Utrecht, with Willeke Blokx and Gerben E. Breimer.",
  imageLicense: "CC0-1.0",
  sourceUrl: "https://zenodo.org/records/15050523",
  publicationUrl: "https://doi.org/10.1093/gigascience/giaf011",
  displayTransform:
    "Full native 1024 × 1024 field, series 0. No colour adjustment.",
  predictionOrigin:
    "Loci CPU inference on the published PUMA training image using fold 4 of the nnU-Net tissue baseline.",
  sourceShapeYX: [1024, 1024],
  cropYXHW: [0, 0, 1024, 1024],
  outputClassKey: { "4": "tissue_epidermis" },
};

const validInputOnlyCredit = {
  modelId: "micro-sam-vit-b-lm",
  modelVersion: "micro-sam v2.0.1 · diplomatic-bug 1.2",
  kind: "input-only",
  subject: "2D fluorescence light microscopy reference field.",
  attribution: "Example Microscopy Dataset Authors",
  imageLicense: "CC-BY-4.0",
  sourceUrl: "https://bioimage.io/#/artifacts/diplomatic-bug/v0",
  publicationUrl: "https://doi.org/10.1038/s41592-024-02580-4",
  displayTransform: "16-bit scalar plane scaled 1–99.8% percentile.",
  predictionOrigin: null,
};

describe("Model Zoo example asset contract", () => {
  it("validates prediction and input-only credit.json records and preserves optional metadata", () => {
    const parsedPrediction = parseModelZooExampleCredit(
      validPredictionCredit,
      "puma-tissue-cpu",
    );
    expect(parsedPrediction).not.toBeNull();
    expect(parsedPrediction?.kind).toBe("prediction");
    expect(parsedPrediction?.predictionOrigin).toContain("fold 4");
    expect(parsedPrediction?.extraMetadata).toMatchObject({
      sourceShapeYX: [1024, 1024],
      cropYXHW: [0, 0, 1024, 1024],
      outputClassKey: { "4": "tissue_epidermis" },
    });

    const parsedInputOnly = parseModelZooExampleCredit(
      validInputOnlyCredit,
      "micro-sam-vit-b-lm",
    );
    expect(parsedInputOnly).not.toBeNull();
    expect(parsedInputOnly?.kind).toBe("input-only");
    expect(parsedInputOnly?.predictionOrigin).toBeNull();
  });

  it("rejects mismatched IDs, missing mandatory keys, invalid predictionOrigin, and remote media URLs", () => {
    expect(
      parseModelZooExampleCredit(validPredictionCredit, "cellpose-sam-v2"),
    ).toBeNull();
    expect(
      parseModelZooExampleCredit(
        { ...validPredictionCredit, predictionOrigin: null },
        "puma-tissue-cpu",
      ),
    ).toBeNull();
    expect(
      parseModelZooExampleCredit(
        { ...validInputOnlyCredit, predictionOrigin: "unexpected" },
        "micro-sam-vit-b-lm",
      ),
    ).toBeNull();
    expect(
      parseModelZooExampleCredit(
        { ...validPredictionCredit, attribution: "   " },
        "puma-tissue-cpu",
      ),
    ).toBeNull();
    expect(
      parseModelZooExampleCredit(
        { ...validPredictionCredit, kind: "synthetic" },
        "puma-tissue-cpu",
      ),
    ).toBeNull();

    expect(isSafeLocalAssetUrl("/assets/thumbnail-123.webp")).toBe(true);
    expect(isSafeLocalAssetUrl("./examples/puma-tissue-cpu/original.webp")).toBe(
      true,
    );
    expect(isSafeLocalAssetUrl("data:image/webp;base64,UklGR")).toBe(true);
    expect(isSafeLocalAssetUrl("https://example.org/specimen.webp")).toBe(false);
    expect(isSafeLocalAssetUrl("http://localhost:8080/specimen.webp")).toBe(
      false,
    );
    expect(isSafeLocalAssetUrl("//cdn.example.org/specimen.webp")).toBe(false);
    expect(isSafeLocalAssetUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLocalAssetUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
  });

  it("builds the registry fail-closed: requires overlay.webp for prediction pairs and drops overlay for input-only", () => {
    const registry = buildModelZooExampleRegistry(
      {
        "./examples/puma-tissue-cpu/credit.json": validPredictionCredit,
        "./examples/micro-sam-vit-b-lm/credit.json": validInputOnlyCredit,
        "./examples/cellpose-sam-v2/credit.json": {
          ...validPredictionCredit,
          modelId: "cellpose-sam-v2",
        },
        "./examples/unknown-model/credit.json": {
          ...validInputOnlyCredit,
          modelId: "unknown-model",
        },
      },
      {
        "./examples/puma-tissue-cpu/thumbnail.webp": "/assets/puma-thumb.webp",
        "./examples/puma-tissue-cpu/original.webp": "/assets/puma-orig.webp",
        "./examples/puma-tissue-cpu/overlay.webp": "/assets/puma-over.webp",
        "./examples/puma-tissue-cpu/prediction.png": "/assets/puma-pred.png",
        "./examples/micro-sam-vit-b-lm/thumbnail.webp": "/assets/usam-thumb.webp",
        "./examples/micro-sam-vit-b-lm/original.webp": "/assets/usam-orig.webp",
        // Unexpected overlay file on an input-only entry must never be exposed
        "./examples/micro-sam-vit-b-lm/overlay.webp": "/assets/usam-unused.webp",
        // cellpose-sam-v2 is missing overlay.webp so prediction pair must be rejected
        "./examples/cellpose-sam-v2/thumbnail.webp": "/assets/cp-thumb.webp",
        "./examples/cellpose-sam-v2/original.webp": "/assets/cp-orig.webp",
        // Remote URLs are rejected
        "./examples/stardist-2d-versatile-fluo/thumbnail.webp":
          "https://evil.example/thumb.webp",
      },
    );

    expect(Object.keys(registry).sort()).toEqual([
      "micro-sam-vit-b-lm",
      "puma-tissue-cpu",
    ]);

    const puma = registry["puma-tissue-cpu"];
    expect(puma?.kind).toBe("prediction");
    expect(puma?.thumbnailUrl).toBe("/assets/puma-thumb.webp");
    expect(puma?.originalUrl).toBe("/assets/puma-orig.webp");
    expect(puma?.overlayUrl).toBe("/assets/puma-over.webp");

    const usam = registry["micro-sam-vit-b-lm"];
    expect(usam?.kind).toBe("input-only");
    expect(usam?.overlayUrl).toBeNull();

    expect(registry["cellpose-sam-v2"]).toBeUndefined();
  });
});

describe("Model Zoo search and filter helpers", () => {
  it("tokenizes queries and filters by execution group and multi-token scientific terms", () => {
    expect(tokenizeModelZooQuery("  H&E   PlainConvUNet  ")).toEqual([
      "h&e",
      "plainconvunet",
    ]);

    const pumaMatches = filterModelZooEntries(
      MODEL_LIBRARY_ENTRIES,
      "all",
      "PlainConvUNet fold 4",
    );
    expect(pumaMatches.map((entry) => entry.id)).toEqual(["puma-tissue-cpu"]);

    const nucleiAll = filterModelZooEntries(
      MODEL_LIBRARY_ENTRIES,
      "all",
      "nuclei",
    );
    expect(nucleiAll.map((entry) => entry.id)).toEqual([
      "micro-sam-vit-b-lm",
      "stardist-2d-versatile-fluo",
      "bioimageio-nuclei-boundary-onnx",
    ]);

    const nucleiLocal = filterModelZooEntries(
      MODEL_LIBRARY_ENTRIES,
      "local",
      "nuclei",
    );
    expect(nucleiLocal.map((entry) => entry.id)).toEqual([
      "bioimageio-nuclei-boundary-onnx",
    ]);

    const counts = countModelZooEntries(MODEL_LIBRARY_ENTRIES, "nuclei");
    expect(counts).toEqual({ all: 3, local: 1, external: 2 });

    expect(
      filterModelZooEntries(MODEL_LIBRARY_ENTRIES, "all", "no-such-stain-999"),
    ).toEqual([]);
  });
});
