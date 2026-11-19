// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkedLabelsBinding,
  checkedUsamHandoffBinding,
  checkedUsamHandoffReceipt,
  checkedUsamHandoffRecords,
} from "./usam-handoff";

const id = "a".repeat(32);
const sha = "b".repeat(64);
const selection = { x: 0, y: 0, width: 16, height: 12, t: 0, c: 0, z: 0, level: 0 };

describe("μSAM handoff shared validators", () => {
  it("validates plane and volume bindings while rejecting paths and conflicting handoff options", () => {
    const valid = checkedLabelsBinding({
      source_id: id,
      source_sha256: sha,
      selection,
      working_bytes: 64 * 1024 ** 2,
      handoff_id: "c".repeat(32),
    });
    expect(valid.handoff_id).toBe("c".repeat(32));
    expect(checkedLabelsBinding({
      source_id: id,
      source_sha256: sha,
      selection: { ...selection, z: 1, z_stop: 4 },
      working_bytes: 64 * 1024 ** 2,
      use_handoff_manifest: true,
    }).use_handoff_manifest).toBe(true);

    expect(() => checkedLabelsBinding({
      source_id: id, source_sha256: sha, selection, working_bytes: 64 * 1024 ** 2,
      handoff_id: "c".repeat(32), use_handoff_manifest: true,
    })).toThrow(/Invalid label-import/);
    expect(() => checkedLabelsBinding({
      source_id: id, source_sha256: sha, selection, working_bytes: 64 * 1024 ** 2,
      handoff_id: "c".repeat(32),
    }, { allowHandoff: false })).toThrow(/Invalid label-import/);
    expect(() => checkedLabelsBinding({
      source_id: id, source_sha256: sha, selection: { ...selection, z_stop: 1 }, working_bytes: 64 * 1024 ** 2,
    })).toThrow(/at least two/);
  });

  it("validates handoff receipt, study records, and binding provenance without paths", () => {
    const receipt = {
      schema: "loci.usam-handoff-receipt/v1",
      basename: "Loci-uSAM-plane",
      handoff_id: "c".repeat(32),
      manifest_sha256: sha,
      export_origin: "verified-loci-native-export",
      source_id: id,
      source_sha256: sha,
      selection,
      measurement_channel: { index: 0, name: "1: Ch1", basis: "raw-source-channel-values" },
      geometry: { axes: "YX", frame: "image", unit: "pixel", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
      calibration: { status: "unknown", unit: "pixel", axes: "YX", spacing: null },
      input: {
        file_name: "input.tif",
        file_sha256: sha,
        file_size_bytes: 256,
        array_sha256: sha,
        dtype: "uint16",
        shape: [12, 16],
        axes: "YX",
        compression: "deflate",
        value_preservation: "exact-original-native-scalar-samples",
      },
      label_profile: {
        profile: "scalar-native-yx/v1",
        alignment: "same-native-yx-grid",
        axes: "YX",
        shape: [12, 16],
        allowed_dtypes: ["uint8", "uint16", "uint32"],
        background_value: 0,
        format: "TIFF",
      },
      validation: "not-established",
      artifacts: {
        "input.tif": { sha256: sha, size_bytes: 256 },
        "manifest.json": { sha256: sha, size_bytes: 512 },
        "README.md": { sha256: sha, size_bytes: 1024 },
      },
    };
    expect(checkedUsamHandoffReceipt(receipt, id, sha, selection)).toEqual(receipt);
    expect(() => checkedUsamHandoffReceipt({ ...receipt, basename: "/private/bundle" }, id, sha, selection)).toThrow();
    expect(() => checkedUsamHandoffReceipt({ ...receipt, validation: "validated" }, id, sha, selection)).toThrow();

    for (const override of [
      { geometry: { ...receipt.geometry, private_locator: "/hidden/image.tif" } },
      { measurement_channel: { ...receipt.measurement_channel, index: 7 } },
      { input: { ...receipt.input, file_sha256: "d".repeat(64) } },
      { calibration: { status: "known", unit: "um", axes: "YX", spacing: [1, 1] } },
      { label_profile: { ...receipt.label_profile, shape: [16, 12] } },
    ]) {
      expect(() => checkedUsamHandoffReceipt({ ...receipt, ...override }, id, sha, selection)).toThrow();
    }

    const record = {
      schema: "loci.usam-handoff/v1",
      handoff_id: "c".repeat(32),
      export_origin: "verified-loci-native-export",
      source_id: id,
      source_sha256: sha,
      source_name: "sample.ome.tif",
      selection,
      measurement_channel: receipt.measurement_channel,
      geometry: receipt.geometry,
      calibration: receipt.calibration,
      input: receipt.input,
      label_profile: receipt.label_profile,
      upstream_reference: { tool: "micro-sam", version: "2.0.1", commit: "d45ab70ece93a9eb3ca1e237b9067767b0a18263" },
      validation: "not-established",
      manifest_sha256: sha,
    };
    expect(checkedUsamHandoffRecords({ handoffs: [record] })).toEqual([record]);
    expect(() => checkedUsamHandoffRecords({ handoffs: [{ ...record, source_name: "/tmp/sample.tif" }] })).toThrow();

    const binding = {
      schema: "loci.usam-handoff-binding/v1",
      handoff_id: "c".repeat(32),
      manifest_sha256: sha,
      export_identity_basis: "verified-loci-study-handoff",
      binding_source: "manifest-and-study-handoff",
      exported_input_file_sha256: sha,
      exported_input_array_sha256: sha,
      exported_input_dtype: "uint16",
      exported_input_shape: [12, 16],
      exported_input_axes: "YX",
      mask_origin_verified_by_loci: false,
      model_validation: "unknown",
    };
    expect(checkedUsamHandoffBinding(binding)).toEqual(binding);
    expect(() => checkedUsamHandoffBinding({ ...binding, mask_origin_verified_by_loci: true })).toThrow();
    expect(() => checkedUsamHandoffBinding({ ...binding, model_validation: "validated" })).toThrow();
  });
});
