import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  acquirePackageLock,
  assertSafePaths,
  packageLocalMac,
  packagingPaths,
  releasePackageLock,
} from "./package-local.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "loci-package-local-test-"));
  await mkdir(path.join(root, "desktop"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, paths: packagingPaths(root) };
}

test("derives and enforces repository-local canonical paths", async (t) => {
  const { root, paths } = await fixture(t);
  assert.equal(paths.staging, path.join(root, ".loci", "builds", "staging"));
  assert.equal(paths.currentApp, path.join(root, ".loci", "builds", "current", "Loci.app"));
  assert.doesNotThrow(() => assertSafePaths(paths));
  assert.throws(
    () => assertSafePaths({ ...paths, staging: path.dirname(paths.currentApp) }),
    /non-canonical packaging path/,
  );
});

test("refuses occupied staging without invoking Forge or changing current", async (t) => {
  const { root, paths } = await fixture(t);
  await mkdir(paths.staging, { recursive: true });
  await mkdir(path.dirname(paths.currentApp), { recursive: true });
  await writeFile(paths.currentApp, "current sentinel");
  let called = false;
  await assert.rejects(
    packageLocalMac({
      repositoryRoot: root,
      packageApi: async () => (called = true),
      platform: "darwin",
    }),
    /Staging is occupied/,
  );
  assert.equal(called, false);
  assert.equal(await readFile(paths.currentApp, "utf8"), "current sentinel");
});

test("passes the canonical arm64 request and ad-hoc signing mode to Forge", async (t) => {
  const { root, paths } = await fixture(t);
  const env = {};
  let request;
  const forgeResult = [{ platform: "darwin", arch: "arm64", packagedPath: path.join(paths.staging, "Loci-darwin-arm64") }];
  const result = await packageLocalMac({
    repositoryRoot: root,
    env,
    platform: "darwin",
    packageApi: async (value) => {
      request = value;
      assert.equal(env.LOCI_MAC_SIGN_MODE, "adhoc-local");
      await mkdir(value.outDir, { recursive: true });
      return forgeResult;
    },
  });
  assert.equal(result.result, forgeResult);
  assert.deepEqual(request, {
    dir: path.join(root, "desktop"),
    platform: "darwin",
    arch: "arm64",
    outDir: paths.staging,
  });
  assert.equal(env.LOCI_MAC_SIGN_MODE, undefined);
});

const runNode = promisify(execFile);
const forgeConfigUrl = new URL("../forge.config.ts", import.meta.url).href;

async function inspectForgeConfig(code, signMode = "adhoc-local") {
  return runNode(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, LOCI_MAC_SIGN_MODE: signMode, LOCI_WINDOWS_PACKAGE_MODE: "", npm_lifecycle_event: "test:packaging" },
  });
}

test("loads the ESM Forge config with fail-closed ad-hoc signing options", async () => {
  const { stdout } = await inspectForgeConfig(`
    import assert from 'node:assert/strict';
    const {default: config} = await import(${JSON.stringify(forgeConfigUrl)});
    const sign = config.packagerConfig.osxSign;
    assert.equal(sign.identity, '-');
    assert.equal(sign.continueOnError, false);
    assert.equal(sign.strictVerify, true);
    assert.equal(sign.preAutoEntitlements, false);
    const worker = sign.optionsForFile('/Loci.app/Contents/Resources/loci-engine/loci-engine');
    const desktop = sign.optionsForFile('/Loci.app/Contents/MacOS/Loci');
    assert.match(worker.entitlements, /assets[/\\\\]entitlements[/\\\\]empty\\.plist$/);
    assert.match(desktop.entitlements, /assets[/\\\\]entitlements[/\\\\]jit\\.plist$/);
    assert.equal(worker.hardenedRuntime, false);
    assert.equal(worker.timestamp, 'none');
    const {api} = await import('@electron-forge/core');
    assert.equal(typeof api.package, 'function');
    console.log('ESM config and packaging API verified');
  `);
  assert.match(stdout, /ESM config and packaging API verified/);
});

test("the Packager 20 resource hook rejects a missing worker through its object contract", async (t) => {
  const { root } = await fixture(t);
  const { stdout } = await inspectForgeConfig(`
    import assert from 'node:assert/strict';
    const {default: config} = await import(${JSON.stringify(forgeConfigUrl)});
    const hook = config.packagerConfig.afterCopyExtraResources[0];
    assert.throws(() => hook({ buildPath: ${JSON.stringify(root)}, electronVersion: '44.0.0', platform: 'darwin', arch: 'arm64' }),
      /bundled Loci engine is missing/);
    console.log('Missing worker rejected');
  `);
  assert.match(stdout, /Missing worker rejected/);
});

test("ESM config still rejects unsupported signing modes and unsigned macOS resources", async () => {
  await assert.rejects(inspectForgeConfig(`await import(${JSON.stringify(forgeConfigUrl)});`, "unsupported"),
    /Unsupported LOCI_MAC_SIGN_MODE/);
  const { stdout } = await inspectForgeConfig(`
    import assert from 'node:assert/strict';
    const {default: config} = await import(${JSON.stringify(forgeConfigUrl)});
    assert.throws(() => config.packagerConfig.afterCopyExtraResources[0]({ buildPath: '.', electronVersion: '44.0.0', platform: 'darwin', arch: 'arm64' }),
      /Unsigned macOS packages are disabled/);
    console.log('Unsigned resources rejected');
  `, "");
  assert.match(stdout, /Unsigned resources rejected/);
});

test("retains failed staging and logs while releasing its own lock", async (t) => {
  const { root, paths } = await fixture(t);
  await assert.rejects(
    packageLocalMac({
      repositoryRoot: root,
      platform: "darwin",
      packageApi: async ({ outDir }) => {
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, "partial.txt"), "inspect me");
        throw new Error("mock packaging failure");
      },
    }),
    /mock packaging failure/,
  );
  assert.equal(await readFile(path.join(paths.staging, "partial.txt"), "utf8"), "inspect me");
  const logs = await readdir(paths.logs);
  assert.equal(logs.length, 1);
  assert.match(await readFile(path.join(paths.logs, logs[0]), "utf8"), /mock packaging failure/);
  await assert.rejects(readFile(path.join(paths.lock, "owner.json")), /ENOENT/);
});

test("does not remove a lock whose ownership token changed", async (t) => {
  const { paths } = await fixture(t);
  const owner = await acquirePackageLock(paths);
  await writeFile(path.join(paths.lock, "owner.json"), '{"token":"another-attempt"}\n');
  assert.equal(await releasePackageLock(paths, owner), false);
  assert.match(await readFile(path.join(paths.lock, "owner.json"), "utf8"), /another-attempt/);
});

test("refuses a concurrent packaging lock without stealing it", async (t) => {
  const { paths } = await fixture(t);
  const owner = await acquirePackageLock(paths, { purpose: "first test attempt" });
  await assert.rejects(acquirePackageLock(paths), /already locked.*first test attempt/s);
  assert.equal(JSON.parse(await readFile(path.join(paths.lock, "owner.json"), "utf8")).token, owner.token);
});

test("refuses symlinked .loci and builds ancestors before writing outside", async (t) => {
  for (const relativeLink of [".loci", path.join(".loci", "builds")]) {
    await t.test(relativeLink, async (child) => {
      const { root } = await fixture(child);
      const outside = await mkdtemp(path.join(os.tmpdir(), "loci-package-outside-test-"));
      child.after(() => rm(outside, { recursive: true, force: true }));
      const link = path.join(root, relativeLink);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(outside, link);
      let called = false;
      await assert.rejects(
        packageLocalMac({
          repositoryRoot: root,
          packageApi: async () => (called = true),
          platform: "darwin",
        }),
        /not a real directory/,
      );
      assert.equal(called, false);
      assert.deepEqual(await readdir(outside), []);
    });
  }
});

test("refuses a symlinked packaging lock without reading through it", async (t) => {
  const { paths } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "loci-package-lock-target-test-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(paths.builds, { recursive: true });
  await writeFile(path.join(outside, "owner.json"), '{"token":"outside"}\n');
  await symlink(outside, paths.lock);
  await assert.rejects(acquirePackageLock(paths), /symbolic link/);
  assert.match(await readFile(path.join(outside, "owner.json"), "utf8"), /outside/);
});
