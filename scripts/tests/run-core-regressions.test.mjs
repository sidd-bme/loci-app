import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("parseArgs accepts explicit source checks and rejects invalid selections and typos", () => {
  assert.deepEqual(parseArgs(["--mode=source", "--checks=desktop-checks"]).checks, ["desktop-checks"]);
  assert.deepEqual(parseArgs(["--checks", "engine-checks,desktop-checks", "--mode", "source"]).checks,
    ["engine-checks", "desktop-checks"]);
  for (const args of [
    ["--checks="], ["--checks"], ["--checks=desktop-checks,"],
    ["--checks=desktop-check"], ["--checks=desktop-checks,desktop-checks"],
    ["--checks=desktop-checks", "--checks=engine-checks"],
    ["--cheks=engine-checks"], ["--output-root"],
  ]) {
    assert.throws(() => parseArgs(["--mode=source", ...args]));
  }
  assert.throws(() => parseArgs(["--mode=packaged", "--checks=desktop-checks"]), /only supported/);
});

test("runCoreRegressions rejects invalid selections even when called without the parser", async (t) => {
  const tmp = await createTempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  for (const options of [
    { mode: "source", checks: [] },
    { mode: "source", checks: ["unknown"] },
    { mode: "source", checks: ["engine-checks", "engine-checks"] },
    { mode: "source", checks: "engine-checks" },
    { mode: "packaged", checks: ["desktop-checks"] },
  ]) {
    const report = await runCoreRegressions({ ...options, outputRoot: tmp }, {
      executor: async () => { assert.fail("Invalid selections must not execute commands"); },
    });
    assert.equal(report.overall_status, "failed");
    assert.equal(report.prerequisites.checks.status, "missing");
  }
});

for (const selected of ["desktop-checks", "engine-checks"]) {
  test(`source subset ${selected} records omissions and partial success in the persisted receipt`, async (t) => {
    const tmp = await createTempDir();
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const executed = [];
    const report = await runCoreRegressions({ mode: "source", checks: [selected], outputRoot: tmp }, {
      env: { PATH: "/test/path", CUSTOM_SETTING: "preserved" },
      executor: async (command, args, options) => {
        executed.push({ command, args, ...options });
        return { code: 0, stdout: "Passed", stderr: "", durationMs: 7 };
      },
    });
    assert.equal(report.overall_status, "partial-passed");
    assert.equal(report.scope, "partial");
    assert.deepEqual(report.requested_checks, [selected]);
    assert.deepEqual(report.summary, { total: 2, passed: 1, failed: 0, skipped: 0, not_run: 1 });
    assert.deepEqual(report.checks.find(check => check.id !== selected).reason, "not-requested");
    assert.equal(report.checks.find(check => check.id !== selected).status, "not-run");
    assert.equal(executed.length, selected === "desktop-checks" ? 1 : 2);
    assert.ok(executed.every(call => path.basename(call.cwd) === (selected === "desktop-checks" ? "desktop" : "engine")));
    assert.ok(executed.every(call => call.env.PATH === "/test/path" && call.env.CUSTOM_SETTING === "preserved"));
    assert.ok(executed.every(call => call.env.VITEST_MAX_WORKERS === "1"));
    const result = report.checks.find(check => check.id === selected);
    assert.equal(result.duration_ms, executed.length * 7);
    assert.equal(result.commands.length, executed.length);
    if (selected === "desktop-checks") assert.equal(result.vitest_max_workers, "1");
    else {
      assert.deepEqual(executed.map(call => call.args), [
        ["run", "--frozen", "--no-sync", "ruff", "check", "."],
        ["run", "--frozen", "--no-sync", "pytest", "--durations=15"],
      ]);
      assert.deepEqual(result.commands.map(command => command.phase), ["pre-command", "command"]);
      assert.deepEqual(result.commands.map(command => command.duration_ms), [7, 7]);
    }
    const receipt = JSON.parse(await readFile(report.receipt_path, "utf8"));
    assert.equal(receipt.overall_status, "partial-passed");
    assert.equal(receipt.summary.not_run, 1);
  });
}

test("source runner preserves explicit worker override and reports the effective value", async (t) => {
  const tmp = await createTempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const env = { VITEST_MAX_WORKERS: "3", CUSTOM_SETTING: "keep" };
  const report = await runCoreRegressions({ mode: "source", checks: ["desktop-checks"], outputRoot: tmp }, {
    env,
    executor: async (command, args, options) => {
      assert.deepEqual(options.env, env);
      return { code: 0, stdout: "", stderr: "", durationMs: 3 };
    },
  });
  assert.equal(report.checks[0].vitest_max_workers, "3");
  assert.deepEqual(env, { VITEST_MAX_WORKERS: "3", CUSTOM_SETTING: "keep" });
});

for (const failPrecommand of [true, false]) {
  test(`partial engine failure records ${failPrecommand ? "pre-command" : "pytest"} timing and fails closed`, async (t) => {
    const tmp = await createTempDir();
    t.after(() => rm(tmp, { recursive: true, force: true }));
    let calls = 0;
    const report = await runCoreRegressions({ mode: "source", checks: ["engine-checks"], outputRoot: tmp }, {
      executor: async () => {
        calls++;
        return { code: failPrecommand || calls === 2 ? 1 : 0, stdout: "", stderr: "failure", durationMs: calls * 5 };
      },
    });
    assert.equal(report.overall_status, "failed");
    assert.equal(report.checks[1].status, "failed");
    assert.equal(report.checks[1].duration_ms, failPrecommand ? 5 : 15);
    assert.equal(report.checks[1].commands.length, failPrecommand ? 1 : 2);
    assert.equal(calls, failPrecommand ? 1 : 2);
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.not_run, 1);
  });
}

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
  assert.equal(report1.summary.not_run, 4);
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
  assert.equal(report.scope, "full");
  assert.deepEqual(report.requested_checks, ["desktop-checks", "engine-checks"]);
  assert.equal(report.checks[1].duration_ms, 30); // Ruff and Pytest both count
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
    if (args[0].includes("external-label-adoption")) filename = "external-label-adoption-receipt.json";
    if (args[0].includes("correction-effect")) filename = "correction-effect-receipt.json";

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
  assert.equal(report.summary.passed, 5);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.not_run, 0);
  assert.deepEqual(report.checks.map(check => check.id), [
    "journey-1-workbench", "journey-2-refresh", "journey-3-field-assay", "journey-4-external-labels",
    "journey-5-correction-effect",
  ]);
  assert.match(report.checks[3].receipt_path, /external-label-adoption-receipt\.json$/);
  assert.match(report.checks[4].receipt_path, /correction-effect-receipt\.json$/);
});

for (const failure of ["missing", "identity-mismatched"]) {
  test(`fourth external-label journey fails closed for a ${failure} receipt after three passing journeys`, async (t) => {
    const tmp = await createTempDir();
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const fakeApp = path.join(tmp, "Fake.app");
    await mkdir(path.join(fakeApp, "Contents/MacOS"), { recursive: true });
    await mkdir(path.join(fakeApp, "Contents/Resources/loci-engine"), { recursive: true });
    await writeFile(path.join(fakeApp, "Contents/MacOS/Loci"), "fake-exe");
    await writeFile(path.join(fakeApp, "Contents/Resources/loci-engine/loci-engine"), "fake-worker");
    await writeFile(path.join(fakeApp, "Contents/Resources/app.asar"), "fake-asar");
    const appVerification = await verifyAppBundle(fakeApp);
    const invoked = [];
    const mockExecutor = async (command, args, options) => {
      assert.equal(command, "node");
      const script = path.basename(args[0]);
      invoked.push(script);
      const external = script === "external-label-adoption.qa.mjs";
      if (!(external && failure === "missing")) {
        const filename = {
          "research-workbench.qa.mjs": "qa-report.json",
          "workbench-refresh.qa.mjs": "workbench-refresh-receipt.json",
          "field-assay-workflow.qa.mjs": "qa-receipt.json",
          "external-label-adoption.qa.mjs": "external-label-adoption-receipt.json",
        }[script];
        assert.ok(filename, "Unexpected packaged journey");
        await writeFile(path.join(options.env.LOCI_QA_OUTPUT_ROOT, filename), JSON.stringify({
          status: "passed", started_at: new Date().toISOString(),
          build: {
            executable_sha256: appVerification.identities.executableSha256,
            worker_sha256: external ? "another-worker" : appVerification.identities.workerSha256,
            asar_sha256: appVerification.identities.asarSha256,
          },
          assertions: { synthetic_numerical_and_privacy_checks: true },
        }));
      }
      return { code: 0, stdout: "Mock journey", stderr: "", durationMs: 1 };
    };
    const report = await runCoreRegressions({ mode: "packaged", app: fakeApp, outputRoot: tmp },
      { executor: mockExecutor, generateFixtures: async () => {} });
    assert.equal(invoked.length, 4);
    assert.equal(invoked[3], "external-label-adoption.qa.mjs");
    assert.equal(report.overall_status, "failed");
    assert.equal(report.summary.total, 5);
    assert.equal(report.summary.passed, 3);
    assert.equal(report.summary.failed, 1);
    assert.deepEqual(report.checks.map(check => check.status), ["passed", "passed", "passed", "failed", "not-run"]);
    assert.equal(report.checks[3].id, "journey-4-external-labels");
    assert.match(report.checks[3].error, failure === "missing"
      ? /Receipt external-label-adoption-receipt\.json was not found/
      : /Build identity mismatch in receipt: Worker hash mismatch/);
  });
}

for (const failure of ["missing", "identity-mismatched", "assertion-failed", "stale"]) {
  test(`fifth correction-effect journey fails closed for a ${failure} receipt after four passing journeys`, async (t) => {
    const tmp = await createTempDir();
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const fakeApp = path.join(tmp, "Fake.app");
    await mkdir(path.join(fakeApp, "Contents/MacOS"), { recursive: true });
    await mkdir(path.join(fakeApp, "Contents/Resources/loci-engine"), { recursive: true });
    await writeFile(path.join(fakeApp, "Contents/MacOS/Loci"), "fake-exe");
    await writeFile(path.join(fakeApp, "Contents/Resources/loci-engine/loci-engine"), "fake-worker");
    await writeFile(path.join(fakeApp, "Contents/Resources/app.asar"), "fake-asar");
    const verification = await verifyAppBundle(fakeApp);
    const invoked = [];
    const mockExecutor = async (command, args, options) => {
      assert.equal(command, "node");
      const script = path.basename(args[0]);
      invoked.push(script);
      const correction = script === "correction-effect.qa.mjs";
      if (!(correction && failure === "missing")) {
        const filename = {
          "research-workbench.qa.mjs": "qa-report.json",
          "workbench-refresh.qa.mjs": "workbench-refresh-receipt.json",
          "field-assay-workflow.qa.mjs": "qa-receipt.json",
          "external-label-adoption.qa.mjs": "external-label-adoption-receipt.json",
          "correction-effect.qa.mjs": "correction-effect-receipt.json",
        }[script];
        assert.ok(filename, "Unexpected packaged journey");
        await writeFile(path.join(options.env.LOCI_QA_OUTPUT_ROOT, filename), JSON.stringify({
          status: "passed", started_at: correction && failure === "stale" ? "2000-01-01T00:00:00Z" : new Date().toISOString(),
          build: {
            executable_sha256: verification.identities.executableSha256,
            worker_sha256: correction && failure === "identity-mismatched" ? "another-worker" : verification.identities.workerSha256,
            asar_sha256: verification.identities.asarSha256,
          },
          assertions: { independent_paired_oracle: !(correction && failure === "assertion-failed") },
        }));
      }
      return { code: 0, stdout: "Mock journey", stderr: "", durationMs: 1 };
    };
    const report = await runCoreRegressions({ mode: "packaged", app: fakeApp, outputRoot: tmp },
      { executor: mockExecutor, generateFixtures: async () => {} });
    assert.equal(invoked.length, 5);
    assert.equal(invoked[4], "correction-effect.qa.mjs");
    assert.equal(report.overall_status, "failed");
    assert.equal(report.summary.total, 5);
    assert.equal(report.summary.passed, 4);
    assert.equal(report.summary.failed, 1);
    assert.deepEqual(report.checks.map(check => check.status), ["passed", "passed", "passed", "passed", "failed"]);
    assert.equal(report.checks[4].id, "journey-5-correction-effect");
    assert.match(report.checks[4].error, {
      missing: /Receipt correction-effect-receipt\.json was not found/,
      "identity-mismatched": /Build identity mismatch in receipt: Worker hash mismatch/,
      "assertion-failed": /Receipt explicitly recorded failure/,
      stale: /Stale receipt detected: receipt started_at/,
    }[failure]);
  });
}
