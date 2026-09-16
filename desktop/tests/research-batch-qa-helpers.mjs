import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function assertNoAbsolutePaths(value, location = "manifest") {
  if (typeof value === "string") {
    assert.ok(!path.posix.isAbsolute(value) && !WINDOWS_ABSOLUTE.test(value),
      `${location} contains an absolute local path`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAbsolutePaths(item, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      assertNoAbsolutePaths(item, `${location}.${key}`);
  }
}

async function regularFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries)
    assert.ok(!entry.isSymbolicLink(), `Export contains symbolic link: ${entry.name}`);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

async function oneRootManifest(directory) {
  const names = (await regularFiles(directory)).filter((name) =>
    /^loci_batch_manifest_.*\.json$/u.test(name));
  assert.equal(names.length, 1, `Expected one aggregate batch manifest in ${path.basename(directory)}`);
  const value = JSON.parse(await fs.readFile(path.join(directory, names[0]), "utf8"));
  assertNoAbsolutePaths(value);
  return { name: names[0], value };
}

function referenceFor(referenceLabels, sourceId) {
  if (typeof referenceLabels === "string") return referenceLabels;
  if (referenceLabels instanceof Map) return referenceLabels.get(sourceId);
  return referenceLabels?.[sourceId];
}

/**
 * Verify the image-first reviewed-batch publications produced by the real app.
 * The aggregate manifest is the commit marker; every per-image manifest and
 * full label array is independently checked rather than trusting UI receipts.
 */
export async function verifyResearchBatchExports({
  outputRoot,
  summaryOnlyRoot,
  expected,
  referenceLabels,
  python,
}) {
  assert.ok(path.isAbsolute(outputRoot), "Reviewed batch output root must be absolute");
  assert.ok(path.isAbsolute(summaryOnlyRoot), "Summary-only output root must be absolute");
  assert.ok(typeof python === "string" && path.isAbsolute(python),
    "Reference Python must be an explicit absolute executable");
  assert.ok(Array.isArray(expected) && expected.length === 11,
    "The core reviewed batch must bind exactly 11 source/result revisions");

  const aggregate = await oneRootManifest(outputRoot);
  assert.equal(aggregate.value.schema, "loci.research-batch-export/v1");
  assert.equal(aggregate.value.status, "completed");
  assert.equal(aggregate.value.exported_count, expected.length);
  assert.equal(aggregate.value.outputs.length, expected.length);
  assert.equal(aggregate.value.selected_results.length, expected.length);

  const expectedBySource = new Map(expected.map((item) => [item.sourceId, item]));
  assert.equal(expectedBySource.size, expected.length, "Expected sources must be unique");
  const observedSources = new Set();
  const labelChecks = [];
  for (const output of aggregate.value.outputs) {
    const declared = expectedBySource.get(output.source_id);
    assert.ok(declared, `Unexpected exported source: ${output.source_id}`);
    assert.ok(!observedSources.has(output.source_id), `Duplicate exported source: ${output.source_id}`);
    observedSources.add(output.source_id);
    assert.equal(output.source_relative_path, declared.name);
    assert.equal(output.result_id, declared.resultId);
    assert.equal(output.revision_hash, declared.revisionHash);

    const bundle = path.resolve(outputRoot, output.output_directory);
    assert.ok(bundle.startsWith(`${path.resolve(outputRoot)}${path.sep}`),
      "Mirrored bundle escaped its selected output root");
    const relativeParent = path.dirname(declared.name);
    assert.equal(path.dirname(output.output_directory).split(path.sep).join("/"),
      relativeParent === "." ? "." : relativeParent.split(path.sep).join("/"));
    assert.equal((await fs.lstat(bundle)).isDirectory(), true);

    const bundleManifestPath = path.join(bundle, "manifest.json");
    assert.equal(await sha256(bundleManifestPath), output.manifest_sha256);
    const bundleManifest = JSON.parse(await fs.readFile(bundleManifestPath, "utf8"));
    assertNoAbsolutePaths(bundleManifest, `bundle ${declared.name}`);
    assert.equal(bundleManifest.schema, "loci.export-manifest/v1");
    assert.equal(bundleManifest.result_id, declared.resultId);
    assert.equal(bundleManifest.revision_hash, declared.revisionHash);
    assert.deepEqual(bundleManifest.files, output.files);

    const listedNames = [];
    for (const file of bundleManifest.files) {
      assert.ok(file && typeof file.name === "string" && path.basename(file.name) === file.name,
        "Bundle manifest contains a non-local artifact name");
      const artifact = path.join(bundle, file.name);
      const stat = await fs.lstat(artifact);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Invalid bundle artifact: ${file.name}`);
      assert.equal(stat.size, file.size_bytes, `Artifact size mismatch: ${file.name}`);
      assert.equal(await sha256(artifact), file.sha256, `Artifact hash mismatch: ${file.name}`);
      listedNames.push(file.name);
    }
    assert.deepEqual(await regularFiles(bundle), [...listedNames, "manifest.json"].sort(),
      `Bundle contains undeclared files for ${declared.name}`);

    const marker = JSON.parse(await fs.readFile(path.join(bundle, "loci-export.json"), "utf8"));
    assert.deepEqual(marker, {
      schema: "loci.export-marker/v1",
      bundle_kind: "loci-export",
      result_id: declared.resultId,
      revision_hash: declared.revisionHash,
    });
    const result = JSON.parse(await fs.readFile(path.join(bundle, "result.json"), "utf8"));
    assertNoAbsolutePaths(result, `result receipt ${declared.name}`);
    assert.equal(result.result.id, declared.resultId);
    assert.equal(result.result.revision_hash, declared.revisionHash);
    assert.equal(result.result.source_id, declared.sourceId);
    assert.equal(result.source.id, declared.sourceId);

    const reference = referenceFor(referenceLabels, declared.sourceId);
    assert.ok(typeof reference === "string" && path.isAbsolute(reference),
      `Missing predeclared reference labels for ${declared.sourceId}`);
    labelChecks.push({
      sourceId: declared.sourceId,
      reference,
      npy: path.join(bundle, "labels.npy"),
      ome: path.join(bundle, "labels.ome.tif"),
    });
  }
  assert.equal(observedSources.size, expected.length);

  const labelReceipt = JSON.parse((await run(python, ["-c", `
import json,sys,numpy as np,tifffile
checks=json.loads(sys.argv[1]); out=[]
for item in checks:
    ref=np.load(item['reference'],allow_pickle=False)
    got=np.load(item['npy'],allow_pickle=False)
    ome=tifffile.imread(item['ome'])
    np.testing.assert_array_equal(got,ref)
    np.testing.assert_array_equal(ome,ref)
    out.append({'source_id':item['sourceId'],'shape':list(got.shape),'all_pixels_equal':True,'ome_equal':True})
print(json.dumps(out,separators=(',',':')))
`, JSON.stringify(labelChecks)])).stdout);
  assert.equal(labelReceipt.length, expected.length);

  const summaryEntries = await fs.readdir(summaryOnlyRoot, { withFileTypes: true });
  assert.ok(summaryEntries.every((entry) => entry.isFile() && !entry.isSymbolicLink()),
    "Summary-only export must not contain per-image directories or links");
  assert.equal(summaryEntries.length, 2,
    "Summary-only export must contain exactly its CSV and commit manifest");
  const summary = await oneRootManifest(summaryOnlyRoot);
  assert.equal(summary.value.schema, "loci.research-batch-export/v1");
  assert.equal(summary.value.status, "completed");
  assert.equal(summary.value.exported_count, 0);
  assert.deepEqual(summary.value.outputs, []);
  assert.equal(summary.value.selected_results.length, 2);
  assert.ok(typeof summary.value.count_summary === "string");
  const summaryNames = summaryEntries.map((entry) => entry.name).sort();
  assert.deepEqual(summaryNames, [summary.name, summary.value.count_summary].sort());
  const csv = await fs.readFile(path.join(summaryOnlyRoot, summary.value.count_summary), "utf8");
  const rows = csv.trimEnd().split("\n");
  assert.equal(rows[0], "image_name,cell_count");
  assert.equal(rows.length, 3, "Summary-only CSV must contain exactly two selected images");
  assert.ok(rows.some((row) => row.startsWith("'=formula")),
    "Formula-prefixed source name was not neutralized in summary-only CSV");

  return {
    aggregateManifest: aggregate.name,
    summaryManifest: summary.name,
    exportedCount: aggregate.value.exported_count,
    labelChecks: labelReceipt,
    summaryRows: rows.length - 1,
    formulaNeutralized: true,
  };
}
