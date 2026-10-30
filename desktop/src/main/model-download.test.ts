// @vitest-environment node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadModelArtifact,
  type ModelDownloadResponse,
  type ModelDownloadTransport,
  type PinnedModelArtifact,
} from "./model-download";

const bytes = Buffer.from("verified deterministic model bytes");
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let root: string;
let target: string;
let artifact: PinnedModelArtifact;

function response(body = Readable.from([bytes]), overrides: Partial<ModelDownloadResponse> = {}): ModelDownloadResponse {
  return { statusCode: 200, headers: {}, body, ...overrides };
}

function transportFor(value = response()) {
  return vi.fn<ModelDownloadTransport>(async () => value);
}

async function noArtifacts() {
  expect(await fs.readdir(root)).toEqual([]);
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "loci-download-test-")));
  await fs.chmod(root, 0o700);
  target = path.join(root, "checkpoint");
  artifact = { id: "exact-model", url: "https://models.example.test/revision/checkpoint",
    sha256: digest(bytes), sizeBytes: bytes.length };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("explicit pinned model download", () => {
  it("streams exact bytes into a private file, publishes once, and removes its stage", async () => {
    const transport = transportFor(response(Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]), {
      headers: { "content-length": String(bytes.length), "content-encoding": "identity" },
    }));
    const result = await downloadModelArtifact(artifact.id, [artifact], target, { transport });
    expect(result).toEqual({ artifactId: artifact.id, path: target, sha256: artifact.sha256, sizeBytes: bytes.length });
    expect(await fs.readFile(target)).toEqual(bytes);
    expect(await fs.readdir(root)).toEqual(["checkpoint"]);
    const stat = await fs.lstat(target);
    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0].href).toBe(artifact.url);
  });

  it("keeps the target absent until the complete stream passes verification", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    const body = Readable.from((async function* () {
      yield bytes.subarray(0, 5);
      started();
      await gate;
      yield bytes.subarray(5);
    })());
    const pending = downloadModelArtifact(artifact.id, [artifact], target, { transport: transportFor(response(body)) });
    await active;
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const stage = (await fs.readdir(root))[0];
    if (process.platform !== "win32") expect((await fs.stat(path.join(root, stage))).mode & 0o777).toBe(0o700);
    release();
    await pending;
    expect(await fs.readFile(target)).toEqual(bytes);
  });

  it.each(["hash", "short", "long"])("rejects a %s mismatch and removes all partial bytes", async (failure) => {
    const payload = failure === "short" ? bytes.subarray(1) : failure === "long" ? Buffer.concat([bytes, Buffer.from("extra")]) : bytes;
    if (failure === "hash") artifact.sha256 = "0".repeat(64);
    const body = Readable.from([payload]);
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport: transportFor(response(body)) })).rejects.toThrow(
      failure === "long" ? "exceeded its exact byte size" : "exact size or SHA-256",
    );
    expect(body.destroyed).toBe(true);
    await noArtifacts();
  });

  it("fails before reading a body whose declared length exceeds the pinned size", async () => {
    const read = vi.fn();
    const body = new Readable({ read });
    await expect(downloadModelArtifact(artifact.id, [artifact], target, {
      transport: transportFor(response(body, { headers: { "content-length": String(bytes.length + 1) } })),
    })).rejects.toThrow("declared a different byte size");
    expect(read).not.toHaveBeenCalled();
    expect(body.destroyed).toBe(true);
    await noArtifacts();
  });

  it("destroys an oversized stream without draining its remainder", async () => {
    let chunks = 0;
    const body = Readable.from((async function* () {
      for (let index = 0; index < 100; index++) {
        chunks++;
        yield Buffer.alloc(bytes.length + 1);
      }
    })(), { highWaterMark: 1 });
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport: transportFor(response(body)) })).rejects.toThrow("exceeded");
    // A readable may prefetch one chunk, but it must be destroyed and never
    // drained to completion after the first size violation.
    expect(body.destroyed).toBe(true);
    expect(chunks).toBeLessThan(100);
    await noArtifacts();
  });

  it.each(["before headers", "during body"])("cleans up a network failure %s without exposing its raw error", async (when) => {
    const sensitive = "network failure at https://private.example.test/token?secret=private";
    const transport = when === "before headers" ? vi.fn<ModelDownloadTransport>(async () => { throw new Error(sensitive); }) :
      transportFor(response(Readable.from((async function* () { yield bytes.subarray(0, 5); throw new Error(sensitive); })())));
    const result = downloadModelArtifact(artifact.id, [artifact], target, { transport });
    await expect(result).rejects.toThrow("The model download failed; no model was imported.");
    await noArtifacts();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("does nothing for a pre-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = transportFor();
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(transport).not.toHaveBeenCalled();
    await noArtifacts();
  });

  it("destroys a pending body and removes its partial file on cancellation", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; });
    let emitted = false;
    const body = new Readable({ read() {
      if (!emitted) { emitted = true; this.push(bytes.subarray(0, 5)); started(); }
    } });
    const pending = downloadModelArtifact(artifact.id, [artifact], target, { transport: transportFor(response(body)), signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow("cancelled");
    await active;
    controller.abort();
    await rejection;
    expect(body.destroyed).toBe(true);
    await noArtifacts();
  });

  it("preserves an existing target and does not begin a request", async () => {
    await fs.writeFile(target, "preserved");
    const transport = transportFor();
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport })).rejects.toThrow("already exists");
    expect(transport).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe("preserved");
  });

  it("never overwrites a target created while the stream is pending", async () => {
    const transport = vi.fn<ModelDownloadTransport>(async () => {
      await fs.writeFile(target, "other owner", { flag: "wx" });
      return response();
    });
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport })).rejects.toThrow("already exists");
    expect(await fs.readFile(target, "utf8")).toBe("other owner");
    expect(await fs.readdir(root)).toEqual(["checkpoint"]);
  });

  it("treats a dangling target symlink as occupied", async () => {
    if (process.platform === "win32") return;
    await fs.symlink(path.join(root, "absent-other"), target);
    const transport = transportFor();
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport })).rejects.toThrow("already exists");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a symlinked parent before any request", async () => {
    if (process.platform === "win32") return;
    await fs.mkdir(path.join(root, "real"), { mode: 0o700 });
    await fs.symlink(path.join(root, "real"), path.join(root, "redirect"));
    const transport = transportFor();
    await expect(downloadModelArtifact(artifact.id, [artifact], path.join(root, "redirect", "model"), { transport })).rejects.toThrow("unsafe");
    expect(await fs.readdir(path.join(root, "real"))).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects an ancestor symlink and does not loosen directory permissions", async () => {
    if (process.platform === "win32") return;
    await fs.mkdir(path.join(root, "real"), { mode: 0o700 });
    await fs.mkdir(path.join(root, "real", "private"), { mode: 0o700 });
    await fs.symlink(path.join(root, "real"), path.join(root, "redirect"));
    const transport = transportFor();
    await expect(downloadModelArtifact(artifact.id, [artifact], path.join(root, "redirect", "private", "model"), { transport })).rejects.toThrow("unsafe");
    await fs.chmod(root, 0o755);
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport })).rejects.toThrow("unsafe");
    expect((await fs.stat(root)).mode & 0o777).toBe(0o755);
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails closed when a same-user directory replacement removes its safe cleanup path", async () => {
    const parent = path.join(root, "private");
    const moved = path.join(root, "moved");
    await fs.mkdir(parent, { mode: 0o700 });
    const transport = vi.fn<ModelDownloadTransport>(async () => {
      await fs.rename(parent, moved);
      await fs.mkdir(parent, { mode: 0o700 });
      await fs.writeFile(path.join(parent, "other-owner"), "preserved");
      return response();
    });
    await expect(downloadModelArtifact(artifact.id, [artifact], path.join(parent, "checkpoint"), { transport })).rejects.toThrow("safely clean up");
    expect(await fs.readdir(parent)).toEqual(["other-owner"]);
    expect(await fs.readFile(path.join(parent, "other-owner"), "utf8")).toBe("preserved");
    // With no directory-relative Node filesystem API, moved temporary files
    // are reported rather than deleting unverified replacement paths.
    expect((await fs.readdir(moved)).length).toBe(1);
  });

  it("follows only bounded HTTPS redirects within reviewed origins", async () => {
    artifact.redirectOrigins = ["https://cdn.example.test"];
    const transport = vi.fn<ModelDownloadTransport>().mockResolvedValueOnce(response(Readable.from([]), {
      statusCode: 302, headers: { location: "/download" },
    })).mockResolvedValueOnce(response(Readable.from([]), {
      statusCode: 307, headers: { location: "https://cdn.example.test/exact-object?signature=ephemeral" },
    })).mockResolvedValueOnce(response());
    await downloadModelArtifact(artifact.id, [artifact], target, { transport });
    expect(transport.mock.calls.map(([url]) => url.href)).toEqual([
      artifact.url, "https://models.example.test/download", "https://cdn.example.test/exact-object?signature=ephemeral",
    ]);
    expect(await fs.readFile(target)).toEqual(bytes);
  });

  it.each(["http://models.example.test/file", "https://unknown.example.test/file", "https://user:pass@models.example.test/file"])(
    "rejects a redirect to %s", async (location) => {
      const transport = transportFor(response(Readable.from([]), { statusCode: 302, headers: { location } }));
      await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport })).rejects.toThrow();
      expect(transport).toHaveBeenCalledOnce();
      await noArtifacts();
    },
  );

  it("rejects redirect loops and does not silently retry", async () => {
    const transport = transportFor(response(Readable.from([]), { statusCode: 302, headers: { location: artifact.url } }));
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport })).rejects.toThrow("redirect loop");
    expect(transport).toHaveBeenCalledOnce();
    await noArtifacts();
  });

  it("caps redirect requests at the initial request plus three hops", async () => {
    let counter = 0;
    const transport = vi.fn<ModelDownloadTransport>(async () => response(Readable.from([]), {
      statusCode: 302, headers: { location: `/next-${++counter}` },
    }));
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport })).rejects.toThrow("redirect limit");
    expect(transport).toHaveBeenCalledTimes(4);
    await noArtifacts();
  });

  it.each([
    { statusCode: 206 }, { statusCode: 503 }, { statusCode: 302 },
    { headers: { "content-encoding": "gzip" } }, { headers: { "content-length": ["1", "2"] } },
    { headers: { "content-length": "1.0" } },
  ])("rejects unsupported response metadata without retry: %j", async (metadata) => {
    const transport = transportFor(response(Readable.from([]), metadata));
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport })).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
    await noArtifacts();
  });

  it.each(["http://models.example.test/file", "https://user:pass@models.example.test/file", "https://models.example.test/file#fragment"])(
    "rejects an unsafe registry source %s before transport", async (url) => {
      artifact.url = url;
      const transport = transportFor();
      await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport })).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      await noArtifacts();
    },
  );

  it("resolves only unique registry IDs and snapshots approved identity across awaits", async () => {
    const transport = vi.fn<ModelDownloadTransport>(async () => {
      artifact.sha256 = "0".repeat(64);
      artifact.sizeBytes = 1;
      return response();
    });
    await expect(downloadModelArtifact("unreviewed", [artifact], target, { transport })).rejects.toThrow("registered");
    await expect(downloadModelArtifact(artifact.id, [artifact, artifact], target, { transport })).rejects.toThrow("registered");
    expect(transport).not.toHaveBeenCalled();
    const result = await downloadModelArtifact(artifact.id, [artifact], target, { transport });
    expect(result.sha256).toBe(digest(bytes));
    expect(result.sizeBytes).toBe(bytes.length);
  });

  it.each([{ sizeBytes: 0 }, { sizeBytes: Infinity }, { sizeBytes: 8 * 1024 ** 3 + 1 },
    { sha256: "invalid" }, { redirectOrigins: ["https://cdn.example.test/path"] },
    { redirectOrigins: ["http://cdn.example.test"] }])("rejects unbounded registry metadata: %j", async (metadata) => {
    Object.assign(artifact, metadata);
    const transport = transportFor();
    await expect(downloadModelArtifact(artifact.id, [artifact], target, { transport })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    await noArtifacts();
  });
});
