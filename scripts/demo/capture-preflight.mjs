#!/usr/bin/env node
/**
 * Read-only gate before a human records the final Loci product-demo clips.
 * It deliberately neither launches the application nor creates a capture folder.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const manifestPath = join(import.meta.dirname, "demo-manifest.json");
const expected = {
  phase: "f5f1565e990650a87cabf7e6e8db1fd6da40b430b5fab52e3f598314d428cf76",
  kidney: "83f9df040b58d0d4ee175730e3087216bb313cb4d450c59ac5d612525c6c9564",
  svs: "ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7",
  ndpi: "edf4a1ccf395c7000ae93ad3b44c07d97043810e00be0c1d167dd09bbe436e46"
};
const usage = `Usage:
  node scripts/demo/capture-preflight.mjs \\
    --app /absolute/path/Loci.app \\
    --receipt /absolute/path/to/passed-public-visual-qa-report.json \\
    --fixture-root /absolute/path/to/public-fixtures \\
    --wsi /absolute/path/to/CMU-1-Small-Region.svs \\
    --capture-dir /absolute/path/to/new-capture-directory \\
    [--ndpi /absolute/path/to/CMU-1.ndpi]
`;

function fail(message) { throw new Error(`capture-preflight: ${message}`); }
function digest(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function within(file, directory) {
  const relation = relative(directory, file);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") { process.stdout.write(usage); process.exit(0); }
    if (!["--app", "--receipt", "--fixture-root", "--wsi", "--capture-dir", "--ndpi"].includes(flag)) fail(`Unknown argument ${flag}.`);
    const value = argv[++index];
    if (!value || !isAbsolute(value)) fail(`${flag} requires an absolute path.`);
    result[flag.slice(2).replaceAll("-", "_")] = resolve(value);
  }
  for (const key of ["app", "receipt", "fixture_root", "wsi", "capture_dir"])
    if (!result[key]) fail(`Missing --${key.replaceAll("_", "-")}.`);
  return result;
}

const options = parse(process.argv.slice(2));
for (const [key, file] of Object.entries({ app: options.app, receipt: options.receipt, fixture_root: options.fixture_root, wsi: options.wsi })) {
  if (!existsSync(file)) fail(`${key} does not exist.`);
}
if (!statSync(options.app).isDirectory() || !options.app.endsWith(".app")) fail("--app must be a Loci.app directory.");
if (existsSync(options.capture_dir)) fail("--capture-dir must be a new path; this command will not overwrite media.");
if (within(options.capture_dir, root)) fail("--capture-dir must be outside the repository.");

const receipt = JSON.parse(readFileSync(options.receipt, "utf8"));
if (receipt.status !== "passed" || !/image-first-public-visual-packaged-qa\/v1$/.test(receipt.schema ?? ""))
  fail("Receipt must be a passed packaged public-visual QA report.");
if (receipt.build?.mode !== "packaged-binary") fail("Receipt does not identify a packaged application.");
const appAsar = join(options.app, "Contents", "Resources", "app.asar");
const appExecutable = join(options.app, "Contents", "MacOS", "Loci");
const appWorker = join(options.app, "Contents", "Resources", "loci-engine", "loci-engine");
for (const file of [appAsar, appExecutable, appWorker]) if (!existsSync(file)) fail(`Packaged artifact is missing: ${file}`);
const binding = {
  application_artifact: digest(appAsar), executable: digest(appExecutable), worker: digest(appWorker)
};
if (binding.application_artifact !== receipt.build.application_artifact_sha256 ||
    binding.executable !== receipt.build.executable_sha256 || binding.worker !== receipt.build.worker_sha256)
  fail("The selected app does not match the public-visual QA receipt.");

const fixtures = {
  phase: join(options.fixture_root, "Phase cell.ome.tiff"),
  kidney: join(options.fixture_root, "Kidney fluorescence.ome.tiff"),
  svs: options.wsi,
  ...(options.ndpi ? { ndpi: options.ndpi } : {})
};
for (const [key, file] of Object.entries(fixtures)) {
  if (!existsSync(file) || !statSync(file).isFile()) fail(`Fixture is absent: ${key}.`);
  if (digest(file) !== expected[key]) fail(`Fixture identity does not match the approved ${key} hash.`);
}
if (receipt.fixtures?.phase?.sha256 !== expected.phase || receipt.fixtures?.kidney?.sha256 !== expected.kidney || receipt.fixtures?.wsi?.sha256 !== expected.svs)
  fail("The receipt does not bind the approved phase, kidney, and SVS fixtures.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schema !== "loci.product-demo/v1") fail("Demo manifest schema changed.");

process.stdout.write(`${JSON.stringify({
  schema: "loci.product-demo-capture-preflight/v1", status: "ready-for-human-recording",
  app: { path: options.app, ...binding }, receipt: { path: options.receipt, sha256: digest(options.receipt), schema: receipt.schema },
  fixtures: Object.fromEntries(Object.entries(fixtures).map(([key, file]) => [key, { path: file, sha256: expected[key] }])),
  capture_directory: options.capture_dir, manifest: { path: manifestPath, sha256: digest(manifestPath), segments: manifest.segments.length },
  constraints: ["Do not launch this script as proof of recording.", "Record only real final-app clips at 1600x900 CSS or 1920x1080 CSS.", "Use the existing public-visual QA action sequence for fixture opening and public-state cleanup.", "Keep protected data, filesystem paths, dialogs, tooltips, and account names out of every frame."]
}, null, 2)}\n`);
