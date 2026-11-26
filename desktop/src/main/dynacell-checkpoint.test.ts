// @vitest-environment node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DynacellCheckpoint } from "./dynacell-checkpoint";

const bytes = Buffer.from("fixed local fixture");
let root: string, source: string, store: DynacellCheckpoint;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "loci-dynacell-")));
  source = path.join(root, "upstream.ckpt");
  await fs.writeFile(source, bytes);
  store = new DynacellCheckpoint(() => root, {
    id: "test", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://example.invalid/explicit-test",
  });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("installs the exact picked bytes, detects damage, and repairs only from verified bytes", async () => {
  expect(await store.status()).toBe("missing");
  await store.install(source);
  const installed = await store.pathForRun();
  expect(await store.status()).toBe("ready");
  expect(await fs.readFile(installed)).toEqual(bytes);
  await fs.writeFile(installed, Buffer.alloc(bytes.length));
  expect(await store.status()).toBe("damaged");
  const wrong = path.join(root, "wrong.ckpt");
  await fs.writeFile(wrong, Buffer.alloc(bytes.length, 3));
  await expect(store.install(wrong)).rejects.toThrow(/SHA-256/);
  expect(await fs.readFile(installed)).toEqual(Buffer.alloc(bytes.length));
  await store.install(source);
  expect(await store.status()).toBe("ready");
  expect(await fs.readdir(path.dirname(installed))).toEqual(["nucleus.ckpt"]);
});

it("refuses a linked local checkpoint before publication", async () => {
  const link = path.join(root, "linked.ckpt");
  await fs.symlink(source, link);
  await expect(store.install(link)).rejects.toThrow();
  expect(await store.status()).toBe("missing");
  expect(await fs.readFile(source)).toEqual(bytes);
});
