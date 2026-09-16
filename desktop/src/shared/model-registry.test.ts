import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  ModelManifest,
  ValidationReport,
} from "./foundation-contracts";
import { FoundationValidationError } from "./foundation-validation";
import {
  CANONICAL_MODEL_MANIFESTS,
  CANONICAL_VALIDATION_REPORTS,
  CELLPOSE_SAM_SHA256,
  CELLPOSE_SAM_SIZE_BYTES,
  CELLPOSE_SAM_V2_SHA256,
  CELLPOSE_SAM_V2_SIZE_BYTES,
  CELLPOSE_WEBSITE_COMPATIBILITY_SETTINGS,
  CELLPOSE_WEBSITE_COMPATIBILITY_SETTINGS_SHA256,
  MODEL_EVIDENCE_REGISTRY,
  createModelEvidenceRegistry,
} from "./model-registry";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(item[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function definitions(): {
  models: ModelManifest[];
  reports: ValidationReport[];
} {
  return {
    models: clone(CANONICAL_MODEL_MANIFESTS) as ModelManifest[],
    reports: clone(CANONICAL_VALIDATION_REPORTS) as ValidationReport[],
  };
}

describe("canonical model evidence registry", () => {
  it("registers three conservative model identities and one compatibility report", () => {
    expect(CANONICAL_MODEL_MANIFESTS.map((model) => model.modelId)).toEqual([
      "loci-classical",
      "cellpose-sam",
      "cellpose-sam-v2",
    ]);
    expect(CANONICAL_MODEL_MANIFESTS.map((model) => model.evidenceStatus)).toEqual([
      "experimental",
      "experimental",
      "unvalidated",
    ]);
    expect(CANONICAL_VALIDATION_REPORTS).toHaveLength(1);

    const website = MODEL_EVIDENCE_REGISTRY.getModel("cellpose-sam");
    const v2 = MODEL_EVIDENCE_REGISTRY.getModel("cellpose-sam-v2");
    expect(website?.artifact).toMatchObject({
      sha256: CELLPOSE_SAM_SHA256,
      sizeBytes: CELLPOSE_SAM_SIZE_BYTES,
      bundled: false,
    });
    expect(v2?.artifact).toMatchObject({
      sha256: CELLPOSE_SAM_V2_SHA256,
      sizeBytes: CELLPOSE_SAM_V2_SIZE_BYTES,
      bundled: false,
    });
    expect(website?.rights.commercialUse).toBe("restricted");
    expect(website?.rights.redistribution).toBe("unknown");
    expect(website?.intendedDomain.summary).toContain("does not establish biological accuracy");
    expect(v2?.intendedDomain.summary).toContain("must not be described as better");

    const reportId = website?.validationReportIds[0] ?? "";
    const report = MODEL_EVIDENCE_REGISTRY.getValidationReport(reportId);
    expect(report).toMatchObject({
      modelId: "cellpose-sam",
      modelSha256: CELLPOSE_SAM_SHA256,
      evidenceStatus: "experimental",
      frozenConfigurationSha256: CELLPOSE_WEBSITE_COMPATIBILITY_SETTINGS_SHA256,
    });
    expect(report?.claimBoundary).toContain("not biological validation");
    expect(report?.gates).toEqual([]);
    expect(
      createHash("sha256")
        .update(stableJson(CELLPOSE_WEBSITE_COMPATIBILITY_SETTINGS))
        .digest("hex"),
    ).toBe(CELLPOSE_WEBSITE_COMPATIBILITY_SETTINGS_SHA256);
  });

  it("deep-freezes the canonical documents", () => {
    const model = MODEL_EVIDENCE_REGISTRY.getModel("cellpose-sam");
    expect(Object.isFrozen(CANONICAL_MODEL_MANIFESTS)).toBe(true);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model?.artifact)).toBe(true);
    expect(Object.isFrozen(model?.knownFailureModes)).toBe(true);
  });

  it("runs the existing strict document validator for every definition", () => {
    const { models, reports } = definitions();
    delete (models[0] as Partial<ModelManifest>).name;
    expect(() => createModelEvidenceRegistry(models, reports)).toThrowError(
      FoundationValidationError,
    );
  });

  it("rejects duplicate model and validation-report identifiers", () => {
    const first = definitions();
    first.models.push(clone(first.models[0]));
    expect(() => createModelEvidenceRegistry(first.models, first.reports)).toThrow(
      /Duplicate model identifier loci-classical/,
    );

    const second = definitions();
    second.reports.push(clone(second.reports[0]));
    expect(() => createModelEvidenceRegistry(second.models, second.reports)).toThrow(
      /Duplicate validation report identifier/,
    );
  });

  it("rejects unknown, multiply-owned, and orphaned report references", () => {
    const unknown = definitions();
    unknown.models[1].validationReportIds = ["missing-report"];
    expect(() => createModelEvidenceRegistry(unknown.models, unknown.reports)).toThrow(
      /references unknown validation report missing-report/,
    );

    const multiplyOwned = definitions();
    multiplyOwned.models[2].validationReportIds = [multiplyOwned.reports[0].reportId];
    expect(() =>
      createModelEvidenceRegistry(multiplyOwned.models, multiplyOwned.reports),
    ).toThrow(/already owned by model cellpose-sam/);

    const orphaned = definitions();
    orphaned.models[1].validationReportIds = [];
    expect(() => createModelEvidenceRegistry(orphaned.models, orphaned.reports)).toThrow(
      /is not cited by its model manifest/,
    );
  });

  it("rejects report model, artifact, and evidence-state mismatches", () => {
    const wrongModel = definitions();
    wrongModel.reports[0].modelId = "cellpose-sam-v2";
    expect(() => createModelEvidenceRegistry(wrongModel.models, wrongModel.reports)).toThrow(
      /belongs to model cellpose-sam-v2, not cellpose-sam/,
    );

    const wrongHash = definitions();
    wrongHash.reports[0].modelSha256 = "f".repeat(64);
    expect(() => createModelEvidenceRegistry(wrongHash.models, wrongHash.reports)).toThrow(
      /does not match the registered model artifact digest/,
    );

    const wrongEvidence = definitions();
    wrongEvidence.reports[0].evidenceStatus = "unvalidated";
    expect(() =>
      createModelEvidenceRegistry(wrongEvidence.models, wrongEvidence.reports),
    ).toThrow(/declare different evidence states/);
  });

  it("returns undefined for unknown lookup identifiers", () => {
    expect(MODEL_EVIDENCE_REGISTRY.getModel("unknown")).toBeUndefined();
    expect(MODEL_EVIDENCE_REGISTRY.getValidationReport("unknown")).toBeUndefined();
  });
});
