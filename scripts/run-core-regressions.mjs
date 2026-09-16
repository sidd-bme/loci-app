#!/usr/bin/env node
/**
 * Loci Core Regression Runner
 *
 * Orchestrates sequential verification checks for:
 *   - Source mode (--mode=source): Desktop TypeScript typecheck, packaging tests, Vitest suite,
 *     Python engine Ruff lint, and Pytest suite.
 *   - Packaged mode (--mode=packaged): Packaged UI journeys 1 (research-workbench),
 *     2 (workbench-refresh), and 3 (field-assay-workflow) on a specified macOS .app candidate,
 *     verifying build identities, invocation timestamps, and generated QA receipts.
 *
 * Enforces:
 *   - Explicit mode selection (--mode=source | --mode=packaged)
 *   - Explicit app bundle path for packaged mode (--app=/path/to/Loci.app)
 *   - Isolated execution environments and output directories
 *   - Strict receipt validation (timestamps, hashes, and assertion outcomes)
 *   - Fail-closed exit codes (non-zero on any prerequisite failure, command error, or receipt mismatch)
 *   - Safe operations: no dependency installs, asset downloads, app promotions, or study mutations
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_MAPPINGS = {
  "desktop-checks": {
    obligations: ["J7", "I9", "I14"],
    description: "Desktop TypeScript typecheck, packaging security unit tests, and full Vitest suite",
  },
  "engine-checks": {
    obligations: ["J1", "J2", "J4", "J8", "J10"],
    description: "Python engine Ruff lint and Pytest suite (numerical invariants, geometry, segmentation, formats)",
  },
  "journey-1-workbench": {
    obligations: ["J1", "J3", "J4", "J7", "J10"],
    description: "Packaged Journey 1: 2D objects, 3D volume, H-DAB, medical oblique, corrections, review, export, and clean reopen",
  },
  "journey-2-refresh": {
    obligations: ["I1", "I2", "I6"],
    description: "Packaged Journey 2: Source reordering, worker refresh, batch palettes/undo, A/B comparison pan/zoom guardrails, Save study",
  },
  "journey-3-field-assay": {
    obligations: ["J1", "J2", "I8"],
    description: "Packaged Journey 3: Fluorescence field assay, background subtraction, signed integrals, review gates, immutable provenance",
  },
};

export async function fileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function parseArgs(args) {
  const options = {
    mode: null,
    app: process.env.LOCI_PACKAGED_APP || null,
    outputRoot: process.env.LOCI_QA_OUTPUT_ROOT || null,
    continueOnError: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice(7);
    } else if (arg === "--mode" && i + 1 < args.length) {
      options.mode = args[++i];
    } else if (arg.startsWith("--app=")) {
      options.app = arg.slice(6);
    } else if (arg === "--app" && i + 1 < args.length) {
      options.app = args[++i];
    } else if (arg.startsWith("--output-root=")) {
      options.outputRoot = arg.slice(14);
    } else if (arg === "--output-root" && i + 1 < args.length) {
      options.outputRoot = args[++i];
    } else if (arg === "--continue-on-error") {
      options.continueOnError = true;
    }
  }
  return options;
}

export async function verifyAppBundle(appPath) {
  const resolved = path.resolve(appPath);
  const executable = path.join(resolved, "Contents", "MacOS", "Loci");
  const worker = path.join(resolved, "Contents", "Resources", "loci-engine", "loci-engine");
  const asar = path.join(resolved, "Contents", "Resources", "app.asar");

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return { valid: false, error: `App bundle path is not a directory: ${resolved}` };
    }
    await Promise.all([
      fs.access(executable),
      fs.access(worker),
      fs.access(asar),
    ]);
  } catch (err) {
    return {
      valid: false,
      error: `App bundle components missing or inaccessible in ${resolved}: ${err.message}`,
    };
  }

  const [executableSha256, workerSha256, asarSha256] = await Promise.all([
    fileSha256(executable),
    fileSha256(worker),
    fileSha256(asar),
  ]);

  return {
    valid: true,
    paths: { appPath: resolved, executable, worker, asar },
    identities: { executableSha256, workerSha256, asarSha256 },
  };
}

export function verifyBuildIdentities(receiptIdentities, expectedIdentities) {
  if (!receiptIdentities) {
    return { valid: false, reason: "Receipt does not contain build identity metadata" };
  }
  const exe = receiptIdentities.executable ?? receiptIdentities.executable_sha256;
  const worker = receiptIdentities.worker ?? receiptIdentities.worker_sha256;
  const asar = receiptIdentities.application_artifact ?? receiptIdentities.main_artifact_sha256 ?? receiptIdentities.asar_sha256;

  if (exe !== expectedIdentities.executableSha256) {
    return {
      valid: false,
      reason: `Executable hash mismatch: expected ${expectedIdentities.executableSha256}, got ${exe}`,
    };
  }
  if (worker !== expectedIdentities.workerSha256) {
    return {
      valid: false,
      reason: `Worker hash mismatch: expected ${expectedIdentities.workerSha256}, got ${worker}`,
    };
  }
  if (asar !== expectedIdentities.asarSha256) {
    return {
      valid: false,
      reason: `app.asar hash mismatch: expected ${expectedIdentities.asarSha256}, got ${asar}`,
    };
  }
  return { valid: true };
}

export async function findReceipt(searchDir, filename) {
  try {
    const entries = await fs.readdir(searchDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(searchDir, entry.name);
      if (entry.isFile() && entry.name === filename) {
        const content = await fs.readFile(fullPath, "utf8");
        return { path: fullPath, data: JSON.parse(content) };
      }
      if (entry.isDirectory()) {
        const found = await findReceipt(fullPath, filename);
        if (found) return found;
      }
    }
  } catch {
    // ignore search errors
  }
  return null;
}

export async function defaultExecutor(command, args, options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.live) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.live) process.stderr.write(chunk);
    });
    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("error", (err) => {
      resolve({
        code: -1,
        stdout,
        stderr: stderr + "\n" + err.message,
        durationMs: Date.now() - startedAt,
        error: err,
      });
    });
  });
}

export async function runCoreRegressions(options, dependencies = {}) {
  const executor = dependencies.executor || defaultExecutor;
  const projectRoot = dependencies.projectRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  const report = {
    schema: "loci.core-regressions-receipt/v1",
    mode: options.mode,
    started_at: startedAt,
    completed_at: null,
    overall_status: "not-run",
    project_root: projectRoot,
    checks: [],
    prerequisites: {},
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      not_run: 0,
    },
  };

  // Determine output directory
  const defaultEvidenceRoot = path.join(projectRoot, ".loci", "evidence", startedAt.slice(0, 10), "core-regressions");
  const outputRoot = path.resolve(options.outputRoot || path.join(defaultEvidenceRoot, startedAt.replaceAll(/[:.]/g, "-")));
  const logsDir = path.join(outputRoot, "logs");
  await fs.mkdir(logsDir, { recursive: true });
  report.output_root = outputRoot;

  const failRunner = (reason, prerequisiteKey = null) => {
    report.completed_at = new Date().toISOString();
    report.overall_status = "failed";
    if (prerequisiteKey) {
      report.prerequisites[prerequisiteKey] = { status: "missing", error: reason };
    }
    report.error = reason;
    return report;
  };

  if (options.mode !== "source" && options.mode !== "packaged") {
    return failRunner(
      `Invalid or missing --mode argument: expected 'source' or 'packaged', got '${options.mode}'`,
      "mode",
    );
  }

  if (options.mode === "source") {
    report.prerequisites.mode = { status: "valid", mode: "source" };

    const checks = [
      {
        id: "desktop-checks",
        name: "Desktop Verification (Typecheck, Packaging, Vitest)",
        cwd: path.join(projectRoot, "desktop"),
        command: "npm",
        args: ["run", "check"],
        obligations: CONTRACT_MAPPINGS["desktop-checks"].obligations,
      },
      {
        id: "engine-checks",
        name: "Python Engine Verification (Ruff lint & Pytest)",
        cwd: path.join(projectRoot, "engine"),
        command: "uv",
        args: ["run", "pytest"],
        preCommands: [
          { command: "uv", args: ["run", "ruff", "check", "."] },
        ],
        obligations: CONTRACT_MAPPINGS["engine-checks"].obligations,
      },
    ];

    report.summary.total = checks.length;
    let shouldHalt = false;

    for (const check of checks) {
      if (shouldHalt) {
        report.checks.push({
          id: check.id,
          name: check.name,
          status: "not-run",
          obligations: check.obligations,
        });
        report.summary.not_run++;
        continue;
      }

      console.log(`\n▶ [SOURCE CHECK] ${check.name}...`);
      const checkResult = {
        id: check.id,
        name: check.name,
        status: "running",
        obligations: check.obligations,
        started_at: new Date().toISOString(),
      };

      let failed = false;
      let checkLog = "";

      if (check.preCommands) {
        for (const pre of check.preCommands) {
          const res = await executor(pre.command, pre.args, { cwd: check.cwd, live: true });
          checkLog += `\n--- PRE-COMMAND: ${pre.command} ${pre.args.join(" ")} (exit ${res.code}) ---\n${res.stdout}\n${res.stderr}\n`;
          if (res.code !== 0) {
            failed = true;
            checkResult.error = `Pre-command ${pre.command} ${pre.args.join(" ")} failed with exit code ${res.code}`;
            break;
          }
        }
      }

      if (!failed) {
        const res = await executor(check.command, check.args, { cwd: check.cwd, live: true });
        checkLog += `\n--- COMMAND: ${check.command} ${check.args.join(" ")} (exit ${res.code}) ---\n${res.stdout}\n${res.stderr}\n`;
        checkResult.duration_ms = res.durationMs;
        if (res.code !== 0) {
          failed = true;
          checkResult.error = `Command ${check.command} ${check.args.join(" ")} failed with exit code ${res.code}`;
        }
      }

      const logFile = path.join(logsDir, `${check.id}.log`);
      await fs.writeFile(logFile, checkLog);
      checkResult.log_file = logFile;
      checkResult.completed_at = new Date().toISOString();

      if (failed) {
        checkResult.status = "failed";
        report.summary.failed++;
        console.error(`✖ [FAIL] ${check.name}: ${checkResult.error}`);
        if (!options.continueOnError) shouldHalt = true;
      } else {
        checkResult.status = "passed";
        report.summary.passed++;
        console.log(`✔ [PASS] ${check.name}`);
      }

      report.checks.push(checkResult);
    }
  } else if (options.mode === "packaged") {
    if (!options.app) {
      return failRunner("Missing required --app argument for packaged mode", "app");
    }

    const appVerification = await verifyAppBundle(options.app);
    if (!appVerification.valid) {
      return failRunner(appVerification.error, "app");
    }

    report.prerequisites.app = {
      status: "valid",
      path: appVerification.paths.appPath,
      identities: appVerification.identities,
    };

    const packagedChecks = [
      {
        id: "journey-1-workbench",
        name: "Journey 1: 2D & 3D Objects, Review, Export and Reopen",
        script: path.join(projectRoot, "desktop", "tests", "research-workbench.qa.mjs"),
        receiptFilename: "qa-report.json",
        obligations: CONTRACT_MAPPINGS["journey-1-workbench"].obligations,
      },
      {
        id: "journey-2-refresh",
        name: "Journey 2: Source Reorder, Worker Refresh, Batch Palettes and Undo",
        script: path.join(projectRoot, "desktop", "tests", "workbench-refresh.qa.mjs"),
        receiptFilename: "workbench-refresh-receipt.json",
        obligations: CONTRACT_MAPPINGS["journey-2-refresh"].obligations,
      },
      {
        id: "journey-3-field-assay",
        name: "Journey 3: Field Assay Quantification, Scientific Guardrails and Review Gates",
        script: path.join(projectRoot, "desktop", "tests", "field-assay-workflow.qa.mjs"),
        receiptFilename: "qa-receipt.json",
        obligations: CONTRACT_MAPPINGS["journey-3-field-assay"].obligations,
      },
    ];

    report.summary.total = packagedChecks.length;
    let shouldHalt = false;

    for (const check of packagedChecks) {
      if (shouldHalt) {
        report.checks.push({
          id: check.id,
          name: check.name,
          status: "not-run",
          obligations: check.obligations,
        });
        report.summary.not_run++;
        continue;
      }

      console.log(`\n▶ [PACKAGED JOURNEY] ${check.name}...`);
      const checkOutputDir = path.join(outputRoot, check.id);
      await fs.mkdir(checkOutputDir, { recursive: true });

      const checkResult = {
        id: check.id,
        name: check.name,
        status: "running",
        obligations: check.obligations,
        started_at: new Date().toISOString(),
      };

      const fixtureDir = process.env.LOCI_QA_RESEARCH_FIXTURES || path.join(checkOutputDir, "fixtures");
      if (check.id === "journey-1-workbench") {
        await fs.mkdir(fixtureDir, { recursive: true });
        const manifestPath = path.join(fixtureDir, "manifest.json");
        let hasFixtures = false;
        try {
          await fs.access(manifestPath);
          hasFixtures = true;
        } catch {}
        if (!hasFixtures) {
          if (dependencies.generateFixtures) {
            await dependencies.generateFixtures(fixtureDir);
          } else {
            console.log(`Generating deterministic synthetic fixtures in ${fixtureDir}...`);
            const pythonExe = path.join(projectRoot, "engine", ".venv", "bin", "python");
            const genRes = await executor(pythonExe, [
              path.join(projectRoot, "scripts", "create_research_qa_fixtures.py"),
              "--root",
              fixtureDir,
            ], { cwd: projectRoot, env: process.env, live: false });
            if (genRes.code !== 0) {
              checkResult.status = "failed";
              checkResult.error = `Failed to generate QA fixtures: ${genRes.stderr || genRes.stdout}`;
              report.summary.failed++;
              if (!options.continueOnError) shouldHalt = true;
              report.checks.push(checkResult);
              continue;
            }
          }
        }
      }

      const env = {
        ...process.env,
        LOCI_PACKAGED_APP: appVerification.paths.appPath,
        LOCI_QA_OUTPUT_ROOT: checkOutputDir,
        LOCI_QA_RESEARCH_FIXTURES: fixtureDir,
      };

      const res = await executor("node", [check.script], {
        cwd: projectRoot,
        env,
        live: true,
      });

      checkResult.duration_ms = res.durationMs;
      const logFile = path.join(logsDir, `${check.id}.log`);
      await fs.writeFile(logFile, `--- STDOUT ---\n${res.stdout}\n--- STDERR ---\n${res.stderr}\n`);
      checkResult.log_file = logFile;

      if (res.code !== 0) {
        checkResult.status = "failed";
        checkResult.error = `Subprocess exited with nonzero exit code ${res.code}`;
        report.summary.failed++;
        console.error(`✖ [FAIL] ${check.name}: Process exit code ${res.code}`);
        if (!options.continueOnError) shouldHalt = true;
      } else {
        // Subprocess exited 0. Verify the generated receipt!
        const foundReceipt = await findReceipt(checkOutputDir, check.receiptFilename);
        if (!foundReceipt) {
          checkResult.status = "failed";
          checkResult.error = `Receipt ${check.receiptFilename} was not found in ${checkOutputDir}`;
          report.summary.failed++;
          console.error(`✖ [FAIL] ${check.name}: ${checkResult.error}`);
          if (!options.continueOnError) shouldHalt = true;
        } else {
          checkResult.receipt_path = foundReceipt.path;
          const receiptData = foundReceipt.data;

          // Verify receipt timestamp
          const receiptStarted = new Date(receiptData.started_at || receiptData.timing?.started_at || 0).getTime();
          const invocationStart = startTime - 5000;
          if (receiptStarted < invocationStart) {
            checkResult.status = "failed";
            checkResult.error = `Stale receipt detected: receipt started_at (${receiptData.started_at}) predates invocation start (${startedAt})`;
            report.summary.failed++;
            console.error(`✖ [FAIL] ${check.name}: ${checkResult.error}`);
            if (!options.continueOnError) shouldHalt = true;
          } else {
            // Verify build identities
            const receiptBuild = receiptData.build || receiptData.identities;
            const buildMatch = verifyBuildIdentities(receiptBuild, appVerification.identities);
            if (!buildMatch.valid) {
              checkResult.status = "failed";
              checkResult.error = `Build identity mismatch in receipt: ${buildMatch.reason}`;
              report.summary.failed++;
              console.error(`✖ [FAIL] ${check.name}: ${checkResult.error}`);
              if (!options.continueOnError) shouldHalt = true;
            } else {
              // Verify receipt assertion status
              const hasFailure = receiptData.status === "failed" ||
                (receiptData.assertions && Object.values(receiptData.assertions).some((v) => v === false));
              if (hasFailure) {
                checkResult.status = "failed";
                checkResult.error = `Receipt explicitly recorded failure: status=${receiptData.status}`;
                report.summary.failed++;
                console.error(`✖ [FAIL] ${check.name}: ${checkResult.error}`);
                if (!options.continueOnError) shouldHalt = true;
              } else {
                checkResult.status = "passed";
                report.summary.passed++;
                console.log(`✔ [PASS] ${check.name}`);
              }
            }
          }
        }
      }

      checkResult.completed_at = new Date().toISOString();
      report.checks.push(checkResult);
    }
  }

  report.completed_at = new Date().toISOString();
  report.duration_ms = Date.now() - startTime;
  report.overall_status = (report.summary.failed === 0 && report.summary.total > 0 && report.summary.passed === report.summary.total)
    ? "passed"
    : "failed";

  const receiptPath = path.join(outputRoot, "core-regression-receipt.json");
  await fs.writeFile(receiptPath, JSON.stringify(report, null, 2) + "\n");
  report.receipt_path = receiptPath;

  console.log("\n=======================================================");
  console.log(`Loci Core Regressions Finished: OVERALL ${report.overall_status.toUpperCase()}`);
  console.log(`Passed: ${report.summary.passed}/${report.summary.total} | Failed: ${report.summary.failed} | Not Run: ${report.summary.not_run}`);
  console.log(`Receipt: ${receiptPath}`);
  console.log("=======================================================\n");

  return report;
}

export async function main(cliArgs = process.argv.slice(2)) {
  const options = parseArgs(cliArgs);
  if (options.help) {
    console.log(`Usage: node scripts/run-core-regressions.mjs --mode=[source|packaged] [options]

Modes:
  --mode=source        Run desktop typecheck/tests and python engine lint/tests
  --mode=packaged      Run packaged journeys against candidate .app

Options:
  --app=/path/to/app   Required for --mode=packaged. Path to Loci.app bundle
  --output-root=DIR    Directory to store test receipts and logs
  --continue-on-error  Continue remaining checks if a check fails (overall status still fails)
  --help, -h           Show this help message
`);
    process.exit(0);
  }

  try {
    const report = await runCoreRegressions(options);
    process.exit(report.overall_status === "passed" ? 0 : 1);
  } catch (err) {
    console.error("Fatal error executing core regressions:", err);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
