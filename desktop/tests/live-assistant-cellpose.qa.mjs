/** Optional packaged BBBC034 scenario driven by live-assistant-study.qa.mjs. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { assertPolicyRefusal, inspectBeforeAdoption } from "./live-assistant-comparison.qa.mjs";
import { plainFile, projectRoot, requiredPath, run, sha256, TWO_GIB, waitFor } from "./research-model-workbench.qa.mjs";
import { selectResultSection, selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const sourceHash = "70655f858882e85928f8e10472bc72e2424485beb70dc9667ccf2d50b15345a1";
const weightsHash = "0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667";
const profileId = "cellpose-sam-v2";
const region = { x: 320, y: 192, width: 256, height: 256 };

export async function cellposePreflight() {
  if (!process.env.LOCI_QA_BBBC034_SOURCE && !process.env.LOCI_QA_CELLPOSE_CHECKPOINT) return null;
  const fixture = requiredPath("LOCI_QA_BBBC034_SOURCE");
  const weights = requiredPath("LOCI_QA_CELLPOSE_CHECKPOINT");
  assert.equal((await plainFile(weights, "Offline SAM v2 checkpoint")).size, 1_233_586_851);
  assert.equal(await sha256(weights), weightsHash);
  const verifier = path.join(projectRoot, "scripts/qa/verify-cellpose-agent-export.py");
  return { fixture, weights, region, sourceHash, weightsHash, verifier };
}

export async function runAgentCellpose({ page, source, sdk, submitAction, snapshot, checkpoint,
  record, hashText, config, selection, policy, exportDir }) {
  const status = await sdk.call("inspect_action", { operation: "cellpose_model_status", request: {} });
  assert.equal(status.schema, "loci.cellpose-model-status/v1");
  assert.equal(status.ready, true);
  assert.equal(status.profile_id, profileId);
  assert.equal(status.model.sha256, weightsHash);
  assert.equal(status.package.model_verified, true);
  assert.equal(status.recommended_settings.device, "cpu");
  assert.equal(status.adoption_requires_human_visual_review, true);
  assert.deepEqual(selection, { ...region, c: 0, t: 0, z: 0, level: 0 });
  const request = { source_id: source.id, selection, profile_id: profileId,
    settings: { ...status.recommended_settings, batch_size: 1 }, measurement_channels: [1], working_bytes: TWO_GIB };
  assert.deepEqual(policy.cellpose_scope, { source_id: source.id, selection, measurement_channels: [1] });
  const context = await sdk.call("analysis_context");
  assert.deepEqual(context.cellpose_scope, policy.cellpose_scope);
  const before = await snapshot();
  assertPolicyRefusal(await sdk.callResponse("submit_action", { operation: "cellpose_preview",
    request: { ...request, measurement_channels: [2] }, request_key: "cellpose-denied-channel" }, true));
  assertPolicyRefusal(await sdk.callResponse("submit_action", { operation: "cellpose_preview",
    request: { ...request, selection: { ...selection, c: 1 } }, request_key: "cellpose-denied-inference-channel" }, true));
  const denied = await snapshot();
  assert.deepEqual(denied.jobs, before.jobs);
  assert.deepEqual(denied.agent_sessions.approvals, before.agent_sessions.approvals);
  const previewJob = await submitAction("cellpose_preview", request, "cellpose-preview");
  assert.deepEqual(previewJob.result_ids, []);
  assert.deepEqual((await snapshot()).results, []);
  const reply = await sdk.callResponse("inspect_action", { operation: "task_preview_get", request: { job_id: previewJob.id } });
  const cached = reply.structured_content.preview;
  const preview = cached.output.preview;
  assert.equal(cached.source_sha256, source.sha256);
  assert.equal(cached.job_id, previewJob.id);
  assert.equal(cached.operation, "cellpose_preview");
  assert.equal(cached.adopted, false);
  assert.equal(preview.schema, "loci.cellpose-preview/v1");
  assert.equal(preview.preview_job_id, previewJob.id);
  assert.equal(preview.id, previewJob.id);
  assert.equal(preview.package.package_sha256, weightsHash);
  assert.equal(preview.source.id, source.id);
  assert.equal(preview.source.sha256, source.sha256);
  assert.deepEqual(preview.source.selection, selection);
  assert.deepEqual(preview.source.measurement_channels, [1]);
  assert.ok(preview.output.object_count > 0, "Pinned crop must have nonempty labels");
  const image = reply.structured_content.image_transport.images.find(part => part.json_pointer === "/preview/output/overlay_png");
  assert.ok(image);
  assert.equal(reply.content[image.content_index].type, "image");
  assert.equal(reply.content[image.content_index].sha256, image.sha256);
  assert.equal(preview.source.display.png_sha256, image.sha256);
  const binding = { preview_id: preview.id, preview_sha256: preview.preview_sha256 };
  const beforeInvalidAdoption = await snapshot();
  const wrongHash = (binding.preview_sha256[0] === "0" ? "1" : "0") + binding.preview_sha256.slice(1);
  await sdk.callResponse("submit_action", { operation: "cellpose_adopt", request: { ...binding, preview_sha256: wrongHash },
    request_key: "cellpose-wrong-preview-hash" }, true);
  const rejected = await snapshot();
  assert.deepEqual(rejected.jobs, beforeInvalidAdoption.jobs);
  assert.deepEqual(rejected.agent_sessions.approvals, beforeInvalidAdoption.agent_sessions.approvals);
  const adoption = await submitAction("cellpose_adopt", binding, "cellpose-adopt", inspectBeforeAdoption({
    page, preview, previewJob, image, channel: selection.c, hashText, checkpoint,
  }));
  assert.equal(adoption.result_ids.length, 1);
  const [id] = adoption.result_ids;
  const retained = await sdk.call("result", { result_id: id, limit: 1 });
  const result = retained.result;
  assert.equal(result.kind, "cellpose-segmentation");
  assert.equal(result.source_id, source.id);
  assert.equal(result.review, null);
  assert.deepEqual((await sdk.call("review_history", { result_id: id })).events, []);
  assert.equal(retained.total_rows, preview.output.object_count);
  const expectedProvenance = { id: preview.id, revision: preview.revision, sha256: preview.preview_sha256 };
  for (const key of ["source_kind", "selected_series", "multiscale_index", "input_mapping", "input_sha256",
    "raw_channel_sha256s", "channel_metadata_sha256"]) {
    assert.ok(Object.hasOwn(preview.source, key), `Missing preview source field ${key}`);
    expectedProvenance[key] = preview.source[key];
  }
  for (const key of ["labels_sha256", "normalized_sha256", "measurements_sha256"]) {
    assert.match(preview.output[key], /^[a-f0-9]{64}$/);
    expectedProvenance[key] = preview.output[key];
  }
  assert.deepEqual(retained.provenance.cellpose_preview, expectedProvenance);
  const runtime = retained.provenance.runtime.cellpose;
  assert.equal(runtime.model.sha256, weightsHash);
  assert.equal(runtime.package.version, "4.2.1.1");
  assert.equal(runtime.resolved_device, "cpu");
  assert.equal(runtime.requested_device, "cpu");
  assert.deepEqual(retained.provenance.accepted_request.settings, request.settings);
  assert.deepEqual(retained.provenance.accepted_request.selection, request.selection);
  async function reviewAndExport(record, destination, verifierArgs = []) {
    const boundId = record.id;
    await page.locator(`.research-sources [data-result-id="${boundId}"]`).click();
    await selectWorkbenchTool(page, "Info");
    await selectResultSection(page, "Review");
    await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
    await waitForSnapshot(page, s => s?.results.find(r => r.id === boundId)?.review?.disposition === "reviewed", "native review");
    const reviewed = await page.evaluate(id => window.lociResearch.execute("result", { result_id: id }), boundId);
    assert.deepEqual(reviewed.provenance.cellpose_preview, expectedProvenance);
    assert.equal(reviewed.result.source_sha256, source.sha256);
    assert.equal(reviewed.result.revision_hash, record.revision_hash);
    await selectResultSection(page, "Export");
    await page.getByRole("button", { name: "Export result", exact: true }).click();
    const manifest = await waitFor(page, () => fs.readFile(path.join(destination, "manifest.json"), "utf8").catch(() => null),
      Boolean, "reviewed export publication", 60_000);
    for (const item of JSON.parse(manifest).files) {
      assert.equal(path.basename(item.name), item.name);
      assert.equal(await sha256(path.join(destination, item.name)), item.sha256);
    }
    const exported = JSON.parse(await fs.readFile(path.join(destination, "result.json"), "utf8"));
    assert.deepEqual(exported.result.provenance.cellpose_preview, expectedProvenance);
    assert.equal(exported.result.revision_hash, record.revision_hash);
    assert.equal(exported.review.disposition, "reviewed");
    const { stdout } = await run(config.python, [config.cellpose.verifier, config.fixture, destination, preview.output.labels_sha256,
      preview.source.input_sha256, preview.source.raw_channel_sha256s.source_channel_1, ...verifierArgs]);
    return { numerical: JSON.parse(stdout), native_record_sha256: hashText(JSON.stringify(reviewed)) };
  }
  const original = await reviewAndExport(result, exportDir);
  const numerical = original.numerical;
  assert.equal(numerical.objects, retained.total_rows);
  await checkpoint("cellpose-reviewed-export");

  // Remove the first label as a reproducible edit on a copy. This is not an accuracy label.
  const target = { result_id: id, revision_hash: result.revision_hash };
  const editable = await sdk.call("inspect_action", { operation: "correction_info", request: target });
  assert.match(editable.label_sha256, /^[a-f0-9]{64}$/u);
  const correctedJob = await submitAction("correct_result", { ...target,
    operations: [{ op: "delete", label: numerical.first_label, expected_input_sha256: editable.label_sha256 }],
  }, "cellpose-correct-one");
  assert.equal(correctedJob.result_ids.length, 1);
  const child = await sdk.call("result", { result_id: correctedJob.result_ids[0], limit: 1 });
  assert.equal(child.result.parent_id, id);
  assert.equal(child.result.kind, "corrected-labels");
  assert.equal(child.result.review, null);
  assert.equal(child.total_rows, retained.total_rows - 1);
  const corrected = await reviewAndExport(child.result, exportDir + "-corrected", [exportDir, String(numerical.first_label)]);
  assert.equal(corrected.numerical.objects, child.total_rows);
  await checkpoint("cellpose-corrected-export");
  const evidence = await record("cellpose-adoption.json", {
    source_sha256: source.sha256, weights_sha256: weightsHash, request, preview: binding,
    denied: { raw_measurement_channel: 2, inference_channel: 1, mismatched_adoption_digest: true,
      no_jobs_or_approvals_created: true },
    preview_job: previewJob.id, preview_png_sha256: image.sha256, label_digest: preview.output.labels_sha256,
    correction_job: correctedJob.id, corrected_id: child.result.id, corrected: corrected.numerical,
    adoption_job: adoption.id, result_id: id, revision_hash: result.revision_hash, numerical,
    scientific_review: "Automated exercise of the native review control",
  });
  return { result: { id, revision_hash: result.revision_hash }, evidence, numerical,
    native_record_sha256: original.native_record_sha256, corrected: { id: child.result.id, revision_hash: child.result.revision_hash,
      native_record_sha256: corrected.native_record_sha256, numerical: corrected.numerical } };
}
