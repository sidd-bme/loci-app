import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseArgs,
  verifyAppBundle,
  verifyBuildIdentities,
  runCoreRegressions,
} from "../run-core-regressions.mjs";

async function createTempDir(prefix = "loci-regressions-test-") {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

test("parseArgs parses modes and flags correctly", () => {
  assert.deepEqual(parseArgs(["--mode=source"]), {
    mode: "source",
    app: null,
    outputRoot: null,
    continueOnError: false,
    help: false,
  });

  assert.deepEqual(parseArgs(["--mode", "packaged", "--app", "/path/to/Loci.app", "--continue-on-error"]), {
    mode: "packaged",
    app: "/path/to/Loci.app",
    outputRoot: null,
    continueOnError: true,
    help: false,
  });

  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("runCoreRegressions rejects invalid or missing mode", async (t) => {
  const tmp = await createTempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const res1 = await runCoreRegressions({ mode: "invalid", outputRoot: tmp });
  assert.equal(res1.overall_status, "failed");
  assert.match(res1.error, /Invalid or missing --mode/);

  const res2 = await runCoreRegressions({ mode: null, outputRoot: tmp });
  assert.equal(res2.overall_status, "failed");
  assert.match(res2.error, /Invalid or missing --mode/);
});

test("runCoreRegressions in packaged mode rejects missing or invalid --app", async (t) => {
  const tmp = await createTempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // Missing app
  const res1 = await runCoreRegressions({ mode: "packaged", app: null, outputRoot: tmp });
  assert.equal(res1.overall_status, "failed");
  assert.match(res1.error, /Missing required --app/);

  // Non-existent directory
  const res2 = await runCoreRegressions({ mode: "packaged", app: path.join(tmp, "NonExistent.app"), outputRoot: tmp });
  assert.equal(res2.overall_status, "failed");
  assert.match(res2.error, /missing or inaccessible/);
});

test("verifyBuildIdentities verifies matching and detects mismatching hashes", () => {
  const expected = {
    executableSha256: "aaa",
    workerSha256: "bbb",
    asarSha256: "ccc",
  };

  // Match with executable/worker/application_artifact
  assert.deepEqual(verifyBuildIdentities({
    executable: "aaa",
    worker: "bbb",
    application_artifact: "ccc",
  }, expected), { valid: true });

  // Match with _sha256 suffixes
  assert.deepEqual(verifyBuildIdentities({
    executable_sha256: "aaa",
    worker_sha256: "bbb",
    main_artifact_sha256: "ccc",
  }, expected), { valid: true });

  // Mismatch executable
  const badExe = verifyBuildIdentities({
    executable: "wrong",
    worker: "bbb",
    application_artifact: "ccc",
  }, expected);
  assert.equal(badExe.valid, false);
  assert.match(badExe.reason, /Executable hash mismatch/);

  // Mismatch worker
  const badWorker = verifyBuildIdentities({
    executable: "aaa",
    worker: "wrong",
    application_artifact: "ccc",
  }, expected);
  assert.equal(badWorker.valid, false);
  assert.match(badWorker.reason, /Worker hash mismatch/);

  // Mismatch asar
  const badAsar = verifyBuildIdentities({
    executable: "aaa",
    worker: "bbb",
    application_artifact: "wrong",
  }, expected);
  assert.equal(badAsar.valid, false);
  assert.match(badAsar.reason, /app.asar hash mismatch/);
});

test("runCoreRegressions in source mode handles nonzero command exit gracefully", async (t) => {
  const tmp = await createTempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // Mock executor that fails on desktop check
  const mockExecutor = async (command, args) => {
    return {
      code: 1,
      stdout: "Mock compile error",
      stderr: "Type error: variable x is undefined",
      durationMs: 42,
    };
  };

  const report = await runCoreRegressions({
    mode: "source",
    outputRoot: tmp,
  }, { executor: mockExecutor });

  assert.equal(report.overall_status, "failed");
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.not_run, 1);
  assert.equal(report.checks[0].status, "failed");
  assert.equal(report.checks[1].status, "not-run");
});

test("runCoreRegressions in packaged mode handles nonzero subprocess exit", async (t) => {
  const tmp = await createTempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // Create fake app structure
  const fakeApp = path.join(tmp, "Fake.app");
  await mkdir(path.join(fakeApp, "Contents", "MacOS"), { recursive: true });
  await mkdir(path.join(fakeApp, "Contents", "Resources", "loci-engine"), { recursive: true });
  await writeFile(path.join(fakeApp, "Contents", "MacOS", "Loci"), "fake-exe");
  await writeFile(path.join(fakeApp, "Contents", "Resources", "loci-engine", "loci-engine"), "fake-worker");
  await writeFile(path.join(fakeApp, "Contents", "Resources", "app.asar"), "fake-asar");

  const mockExecutor = async () => ({
    code: 1,
    stdout: "App crashed on startup",
    stderr: "Error: segmentation fault",
    durationMs: 120,
  });

  const report1 = await runCoreRegressions({
    mode: "packaged",
    app: fakeApp,
    outputRoot: tmp,
  }, { executor: mockExecutor, generateFixtures: async () => {} });

  assert.equal(report1.overall_status, "failed");
  assert.equal(report1.summary.failed, 1);
  assert.equal(report1.summary.not_run, 2);
  assert.equal(report1.checks[0].status, "failed");
  assert.match(report1.checks[0].error, /nonzero exit code 1/);
});

test("runCoreRegressions in packaged mode detects missing receipt file", async (t) => {
  const tmp = await createTempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // Create fake app structure
  const fakeApp = path.join(tmp, "Fake.app");
  await mkdir(path.join(fakeApp, "Contents", "MacOS"), { recursive: true });
  await mkdir(path.join(fakeApp, "Contents", "Resources", "loci-engine"), { recursive: true });
  await writeFile(path.join(fakeApp, "Contents", "MacOS", "Loci"), "fake-exe");
  await writeFile(path.join(fakeApp, "Contents", "Resources", "loci-engine", "loci-engine"), "fake-worker");
  await writeFile(path.join(fakeApp, "Contents", "Resources", "app.asar"), "fake-asar");

  // Exit 0 but write no receipt file
  const mockExecutor = async () => ({
    code: 0,
    stdout: "Finished with zero exit code but no receipt",
    stderr: "",
    durationMs: 100,
  });

  const report = await runCoreRegressions({
    mode: "packaged",
    app: fakeApp,
    outputRoot: tmp,
  }, { executor: mockExecutor, generateFixtures: async () => {} });

  assert.equal(report.overall_status, "failed");
  assert.equal(report.summary.failed, 1);
  assert.equal(report.checks[0].status, "failed");
  assert.match(report.checks[0].error, /Receipt qa-report\.json was not found/);
});

test("runCoreRegressions in packaged mode detects mismatched build identities in receipt", async (t) => {
  const tmp = await createTempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // Create fake app structure
  const fakeApp = path.join(tmp, "Fake.app");
  await mkdir(path.join(fakeApp, "Contents", "MacOS"), { recursive: true });
  await mkdir(path.join(fakeApp, "Contents", "Resources", "loci-engine"), { recursive: true });
  await writeFile(path.join(fakeApp, "Contents", "MacOS", "Loci"), "fake-exe");
  await writeFile(path.join(fakeApp, "Contents", "Resources", "loci-engine", "loci-engine"), "fake-worker");
  await writeFile(path.join(fakeApp, "Contents", "Resources", "app.asar"), "fake-asar");

  // Exit 0 and write a receipt with mismatched hashes
  const mockExecutor = async (cmd, args, opts) => {
    const checkDir = opts.env.LOCI_QA_OUTPUT_ROOT;
    const runDir = path.join(checkDir, "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "qa-report.json"), JSON.stringify({
      status: "passed",
      started_at: new Date().toISOString(),
      build: {
        executable: "wrong-executable-hash",
        worker: "wrong-worker-hash",
        application_artifact: "wrong-asar-hash",
      },
    }));
    return { code: 0, stdout: "Success", stderr: "", durationMs: 100 };
  };

  const report = await runCoreRegressions({
    mode: "packaged",
    app: fakeApp,
    outputRoot: tmp,
  }, { executor: mockExecutor, generateFixtures: async () => {} });

  assert.equal(report.overall_status, "failed");
  assert.equal(report.summary.failed, 1);
  assert.equal(report.checks[0].status, "failed");
  assert.match(report.checks[0].error, /Build identity mismatch in receipt/);
});

test("runCoreRegressions in source mode passes when all commands exit 0", async (t) => {
  const tmp = await createTempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const executed = [];
  const mockExecutor = async (command, args) => {
    executed.push(`${command} ${args.join(" ")}`);
    return { code: 0, stdout: "Passed", stderr: "", durationMs: 15 };
  };

  const report = await runCoreRegressions({
    mode: "source",
    outputRoot: tmp,
  }, { executor: mockExecutor });

  assert.equal(report.overall_status, "passed");
  assert.equal(report.summary.passed, 2);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.not_run, 0);
  assert.equal(executed.length, 3); // 1 desktop check + 1 precommand + 1 engine test
});

test("runCoreRegressions in packaged mode passes when all journeys generate matching receipts", async (t) => {
  const tmp = await createTempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // Create fake app structure
  const fakeApp = path.join(tmp, "Fake.app");
  await mkdir(path.join(fakeApp, "Contents", "MacOS"), { recursive: true });
  await mkdir(path.join(fakeApp, "Contents", "Resources", "loci-engine"), { recursive: true });
  await writeFile(path.join(fakeApp, "Contents", "MacOS", "Loci"), "fake-exe");
  await writeFile(path.join(fakeApp, "Contents", "Resources", "loci-engine", "loci-engine"), "fake-worker");
  await writeFile(path.join(fakeApp, "Contents", "Resources", "app.asar"), "fake-asar");

  const appVerification = await verifyAppBundle(fakeApp);
  assert.equal(appVerification.valid, true);

  const mockExecutor = async (cmd, args, opts) => {
    const checkDir = opts.env.LOCI_QA_OUTPUT_ROOT;
    const runDir = path.join(checkDir, "run-1");
    await mkdir(runDir, { recursive: true });

    let filename = "qa-report.json";
    if (args[0].includes("workbench-refresh")) filename = "workbench-refresh-receipt.json";
    if (args[0].includes("field-assay")) filename = "qa-receipt.json";

    await writeFile(path.join(runDir, filename), JSON.stringify({
      status: "passed",
      started_at: new Date().toISOString(),
      build: {
        executable: appVerification.identities.executableSha256,
        worker: appVerification.identities.workerSha256,
        application_artifact: appVerification.identities.asarSha256,
        executable_sha256: appVerification.identities.executableSha256,
        worker_sha256: appVerification.identities.workerSha256,
        main_artifact_sha256: appVerification.identities.asarSha256,
      },
      identities: {
        executable_sha256: appVerification.identities.executableSha256,
        worker_sha256: appVerification.identities.workerSha256,
        main_artifact_sha256: appVerification.identities.asarSha256,
      },
      assertions: { ok: true },
    }));

    return { code: 0, stdout: "Journey passed", stderr: "", durationMs: 200 };
  };

  const report = await runCoreRegressions({
    mode: "packaged",
    app: fakeApp,
    outputRoot: tmp,
  }, { executor: mockExecutor, generateFixtures: async () => {} });

  assert.equal(report.overall_status, "passed");
  assert.equal(report.summary.passed, 3);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.not_run, 0);
});
