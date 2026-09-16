// @vitest-environment node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKING_RESULT_ARRAY_ARTIFACTS,
  WORKING_RESULT_ARRAY_MEDIA_TYPE,
  WORKING_RESULT_MEDIA_TYPE,
  WORKING_RESULT_SCHEMA_VERSION,
  SAVED_WORKING_RESULT_UNAVAILABLE_MESSAGE,
  validateWorkingResultReceipt,
  verifyPublishedWorkingResult,
  verifyRestorableProjectWorkingResultArtifact,
  verifyStoredWorkingResultArtifact,
  type WorkingResultReceipt,
} from "./working-result-publication";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-working-publication-"));
  temporaryRoots.push(root);
  if (process.platform !== "win32") await fs.chmod(root, 0o700);
  return root;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptFor(payload: Buffer): WorkingResultReceipt {
  return {
    schema_version: WORKING_RESULT_SCHEMA_VERSION,
    pack: {
      basename: "working-result_01-r3.loci-result",
      media_type: WORKING_RESULT_MEDIA_TYPE,
      size_bytes: payload.byteLength,
      sha256: sha256(payload),
    },
    artifacts: Object.entries(WORKING_RESULT_ARRAY_ARTIFACTS).map(
      ([artifactId, entry], index) => ({
        artifact_id: artifactId as keyof typeof WORKING_RESULT_ARRAY_ARTIFACTS,
        entry,
        media_type: WORKING_RESULT_ARRAY_MEDIA_TYPE,
        size_bytes: 128 + index,
        sha256: String(index + 1).repeat(64),
      }),
    ),
  };
}

async function validPublication(): Promise<{
  directory: string;
  packPath: string;
  payload: Buffer;
  receipt: WorkingResultReceipt;
}> {
  const directory = await temporaryRoot();
  const payload = Buffer.from("immutable recoverable Loci result pack", "utf8");
  const receipt = receiptFor(payload);
  const packPath = path.join(directory, receipt.pack.basename);
  await fs.writeFile(packPath, payload, { mode: 0o600, flag: "wx" });
  return { directory, packPath, payload, receipt };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("working-result publication verification", () => {
  it("verifies a contained immutable pack and returns a copied path-free receipt", async () => {
    const { directory, packPath, receipt } = await validPublication();
    const untrusted = {
      schema_version: receipt.schema_version,
      pack: { ...receipt.pack },
      artifacts: receipt.artifacts.map((artifact) => ({ ...artifact })),
    };

    const verified = await verifyPublishedWorkingResult(directory, untrusted);

    expect(verified.packPath).toBe(await fs.realpath(packPath));
    expect(verified.receipt).toEqual(receipt);
    expect(verified.receipt).not.toBe(untrusted);
    expect(verified.receipt.pack).not.toBe(untrusted.pack);
    expect(verified.receipt.artifacts[0]).not.toBe(untrusted.artifacts[0]);
    const serialized = JSON.stringify(verified.receipt);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain(path.dirname(directory));
  });

  it("rejects a pack whose bytes were changed after the receipt was issued", async () => {
    const { directory, packPath, payload, receipt } = await validPublication();
    const tampered = Buffer.from(payload);
    tampered[0] ^= 0xff;
    await fs.writeFile(packPath, tampered);

    await expect(verifyPublishedWorkingResult(directory, receipt)).rejects.toThrow(
      /failed publication verification/i,
    );
  });

  it("rejects a symbolic-link pack even when its target matches the receipt", async () => {
    const directory = await temporaryRoot();
    const outside = await temporaryRoot();
    const payload = Buffer.from("external pack target");
    const receipt = receiptFor(payload);
    const outsidePack = path.join(outside, "target.loci-result");
    await fs.writeFile(outsidePack, payload);
    await fs.symlink(outsidePack, path.join(directory, receipt.pack.basename), "file");

    await expect(verifyPublishedWorkingResult(directory, receipt)).rejects.toThrow(
      /does not match its receipt/i,
    );
  });

  it.each([
    "../outside.loci-result",
    "/tmp/working-result_01-r3.loci-result",
    "working-result_01-r03.loci-result",
    "working-result 01-r3.loci-result",
    "working--r3.loci-result",
    "working-result_01-r3.loci-result/child",
  ])("rejects an escaping or invalid basename: %s", (basename) => {
    const receipt = receiptFor(Buffer.from("pack"));

    expect(() => validateWorkingResultReceipt({
      ...receipt,
      pack: { ...receipt.pack, basename },
    })).toThrow(/invalid working-result receipt/i);
  });

  it("rejects duplicate, missing, and mismatched array artifacts", () => {
    const receipt = receiptFor(Buffer.from("pack"));
    const duplicate = [receipt.artifacts[0], receipt.artifacts[0], receipt.artifacts[2]];
    const missing = receipt.artifacts.slice(0, 2);
    const mismatched = receipt.artifacts.map((artifact) => ({ ...artifact }));
    mismatched[0].entry = "base-labels.npy";

    expect(() => validateWorkingResultReceipt({ ...receipt, artifacts: duplicate })).toThrow(
      /artifact provenance/i,
    );
    expect(() => validateWorkingResultReceipt({ ...receipt, artifacts: missing })).toThrow(
      /invalid working-result receipt/i,
    );
    expect(() => validateWorkingResultReceipt({ ...receipt, artifacts: mismatched })).toThrow(
      /artifact provenance/i,
    );
  });

  it("rejects extra receipt fields rather than retaining a local path", () => {
    const receipt = receiptFor(Buffer.from("pack"));

    expect(() => validateWorkingResultReceipt({
      ...receipt,
      source_path: "/Volumes/private/raw/cells.tif",
    })).toThrow(/invalid working-result receipt/i);
    expect(() => validateWorkingResultReceipt({
      ...receipt,
      pack: { ...receipt.pack, path: "/private/result.loci-result" },
    })).toThrow(/invalid working-result receipt/i);
    expect(() => validateWorkingResultReceipt({
      ...receipt,
      artifacts: receipt.artifacts.map((artifact, index) => (
        index === 0 ? { ...artifact, local_path: "/private/current.npy" } : artifact
      )),
    })).toThrow(/artifact provenance/i);
  });

  it("rejects non-absolute and symlinked publication directories", async () => {
    const { directory, receipt } = await validPublication();
    await expect(verifyPublishedWorkingResult("relative/results", receipt)).rejects.toThrow(
      /must be absolute/i,
    );
    const parent = await temporaryRoot();
    const linkedDirectory = path.join(parent, "linked");
    await fs.symlink(directory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    await expect(verifyPublishedWorkingResult(linkedDirectory, receipt)).rejects.toThrow(
      /not a real directory/i,
    );
  });

  it("revalidates a saved path-free artifact before project restore", async () => {
    const { packPath, payload, receipt } = await validPublication();
    const artifact = {
      artifactId: "working-result",
      filename: receipt.pack.basename,
      mediaType: WORKING_RESULT_MEDIA_TYPE,
      byteLength: payload.byteLength,
      sha256: sha256(payload),
    };

    await expect(verifyStoredWorkingResultArtifact(packPath, artifact)).resolves.toEqual(artifact);
    await expect(verifyStoredWorkingResultArtifact(packPath, {
      ...artifact,
      filename: "working-result_01-r2.loci-result",
    })).rejects.toThrow(/does not match its project artifact/i);
    await expect(verifyStoredWorkingResultArtifact(packPath, {
      ...artifact,
      sha256: "f".repeat(64),
    })).rejects.toThrow(/failed publication verification/i);
  });

  it("rejects a renamed older revision even when it is an internally valid pack", async () => {
    const directory = await temporaryRoot();
    const olderPayload = Buffer.from("valid revision two pack");
    const expectedPayload = Buffer.from("valid revision three pack");
    const filename = "working-result_01-r3.loci-result";
    const packPath = path.join(directory, filename);
    await fs.writeFile(packPath, olderPayload, { mode: 0o600, flag: "wx" });

    await expect(verifyStoredWorkingResultArtifact(packPath, {
      artifactId: "working-result",
      filename,
      mediaType: WORKING_RESULT_MEDIA_TYPE,
      byteLength: expectedPayload.byteLength,
      sha256: sha256(expectedPayload),
    })).rejects.toThrow(/does not match its receipt|failed publication verification/i);
  });

  it("reports missing and damaged project working copies without exposing their private path", async () => {
    const directory = await temporaryRoot();
    const privatePath = path.join(directory, "working-result_01-r0.loci-result");
    const expectedPayload = Buffer.from("expected saved working result");
    const artifact = {
      artifactId: "working-result",
      filename: path.basename(privatePath),
      mediaType: WORKING_RESULT_MEDIA_TYPE,
      byteLength: expectedPayload.byteLength,
      sha256: sha256(expectedPayload),
    };

    for (const prepare of [
      async () => undefined,
      async () => fs.writeFile(privatePath, Buffer.from("damaged saved result"), { mode: 0o600 }),
    ]) {
      await prepare();
      let caught: unknown;
      try {
        await verifyRestorableProjectWorkingResultArtifact(privatePath, artifact);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(SAVED_WORKING_RESULT_UNAVAILABLE_MESSAGE);
      expect((caught as Error).message).not.toContain(directory);
      await fs.rm(privatePath, { force: true });
    }
  });
});
