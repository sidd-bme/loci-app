// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  RelativePathAllocator,
  refreshedSourceGrant,
  relativePathKey,
  reserveUniqueRelativePath,
} from "./source-grants";

describe("refreshedSourceGrant", () => {
  it("drops a stale fingerprint when the same path is explicitly re-imported", () => {
    const allocateSourceId = vi.fn(() => "new-source-id");
    const candidate = {
      path: "/lab/day-2/field-01.tif",
      relativePath: "experiment/day-2/field-01.tif",
    };

    const original = refreshedSourceGrant(candidate, undefined, allocateSourceId);
    original.expectedSha256 = "a".repeat(64);
    const reimported = refreshedSourceGrant(candidate, original.sourceId, allocateSourceId);

    expect(reimported.sourceId).toBe(original.sourceId);
    expect(reimported.expectedSha256).toBeUndefined();
    expect(reimported.name).toBe("field-01.tif");
    expect(allocateSourceId).toHaveBeenCalledOnce();
  });
});

describe("reserveUniqueRelativePath", () => {
  it("suffixes colliding image names while preserving their parent folders", () => {
    const used = new Set([relativePathKey("experiment/day-2/field.tif")]);

    expect(reserveUniqueRelativePath("experiment/day-2/field.tif", used)).toBe(
      "experiment/day-2/field_2.tif",
    );
    expect(reserveUniqueRelativePath("experiment/day-2/FIELD.tif", used)).toBe(
      "experiment/day-2/FIELD_3.tif",
    );
  });

  it("rejects a relative path that could escape the mirrored tree", () => {
    expect(() => reserveUniqueRelativePath("../field.tif", new Set())).toThrow(
      /folder structure/i,
    );
  });
});

describe("RelativePathAllocator", () => {
  it("keeps case-distinct source parents separate on case-insensitive destinations", () => {
    const allocator = new RelativePathAllocator();

    expect(allocator.reserve("Plate/day/field.tif", "/source/Plate/day/field.tif")).toBe(
      "Plate/day/field.tif",
    );
    expect(allocator.reserve("plate/day/field.tif", "/source/plate/day/field.tif")).toBe(
      "plate_2/day/field.tif",
    );
    expect(allocator.reserve("plate/day/other.tif", "/source/plate/day/other.tif")).toBe(
      "plate_2/day/other.tif",
    );
  });

  it("keeps canonically equivalent Unicode source parents separate", () => {
    const allocator = new RelativePathAllocator();
    const composed = "Caf\u00e9";
    const decomposed = "Cafe\u0301";

    expect(allocator.reserve(`${composed}/field.tif`, `/source/${composed}/field.tif`)).toBe(
      `${composed}/field.tif`,
    );
    expect(allocator.reserve(`${decomposed}/field.tif`, `/source/${decomposed}/field.tif`)).toBe(
      `${composed}_2/field.tif`,
    );
  });

  it("updates an overlapping re-import from a flat path to its folder hierarchy", () => {
    const allocator = new RelativePathAllocator();
    const sourcePath = "/lab/experiment/day-2/field-01.tif";
    const flatPath = allocator.reserve("field-01.tif", sourcePath);
    const original = refreshedSourceGrant(
      { path: sourcePath, relativePath: flatPath },
      undefined,
      () => "source-1",
    );

    const nestedPath = allocator.reserve("experiment/day-2/field-01.tif", sourcePath);
    const reimported = refreshedSourceGrant(
      { path: sourcePath, relativePath: nestedPath },
      original.sourceId,
      () => "unused",
    );

    expect(flatPath).toBe("field-01.tif");
    expect(reimported.sourceId).toBe("source-1");
    expect(reimported.relativePath).toBe("experiment/day-2/field-01.tif");
  });

  it("keeps folder context when the same source is later imported individually", () => {
    const allocator = new RelativePathAllocator();
    const sourcePath = "/lab/experiment/day-2/field-01.tif";

    expect(allocator.reserve("experiment/day-2/field-01.tif", sourcePath)).toBe(
      "experiment/day-2/field-01.tif",
    );
    expect(allocator.reserve("field-01.tif", sourcePath)).toBe(
      "experiment/day-2/field-01.tif",
    );
  });
});
