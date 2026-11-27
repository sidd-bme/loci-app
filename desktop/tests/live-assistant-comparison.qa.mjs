/** Opt-in companion for live-assistant-study.qa.mjs.
 * Use LOCI_QA_ONNX_PACKAGE with the exact local verified BioImage.IO package.
 * The primary journey owns the Sidecar loader, isolated study, SDK and receipt.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { TWO_GIB, noUiError, packageIdentity, requiredPath, waitFor } from "./research-model-workbench.qa.mjs";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const packageId = "nuclei-segmentation-boundary-model";
const version = "0.1.0-publication-20261015-r2";
const packageSha = "774aa0c53566c9f995af02c905863c0ca86b71460f93c3a11fe101b11c5ba582";
const modelSha = "df913b85947f5132bcdaf81d91af0963f60d44f4caf8a4fec672d96a2f327b44";
const metadataSha = "e77c15651c117ded7a9eb73b643c889c4abb41d40024a1294438b767fa6d622d";
export const modelPickerTitle = "Import a local model package";
const binding = ({ id, revision_hash }) => ({ result_id: id, revision_hash });
const execute = (page, operation, request = {}) =>
  page.evaluate(({ operation, request }) => window.lociResearch.execute(operation, request), { operation, request });

export function assertPolicyRefusal(reply) {
  assert.equal(reply.is_error, true);
  assert.ok(reply.content.some((part) => part.type === "text" &&
    part.text.endsWith("The operation, source scope, disclosure or resource limit is not authorized by the active policy.")),
  "Expected the public MCP authorization error");
}

export async function comparisonPreflight() {
  if (!process.env.LOCI_QA_ONNX_PACKAGE) return null;
  const directory = await fs.realpath(requiredPath("LOCI_QA_ONNX_PACKAGE"));
  const pinned = await packageIdentity(directory);
  assert.equal(pinned.package_sha256, packageSha, "Use the registered ONNX package with its exact reference tensors");
  return { directory, package_sha256: pinned.package_sha256 };
}

export async function verifyComparisonPackage(config) {
  assert.equal((await packageIdentity(config.directory)).package_sha256, config.package_sha256, "Original model package changed");
}

export async function importComparisonModel({ page, checkpoint }) {
  await selectWorkbenchTool(page, "Model");
  assert.deepEqual((await execute(page, "model_list")).models, []);
  await page.getByRole("heading", { name: "No model packages in this study.", exact: true }).waitFor();
  await checkpoint("model-01-native-import-prerequisite");
  const resources = page.locator("details.research-model-resources");
  if (!(await resources.evaluate((details) => details.open))) await resources.locator(":scope > summary").click();
  await resources.getByLabel("Model working memory", { exact: true }).selectOption(String(TWO_GIB));
  await page.getByRole("button", { name: "Import model package…", exact: true }).click();
  const { models } = await waitFor(page, () => execute(page, "model_list"), (value) => value.models.length === 1,
    "qualified installed ONNX package", 120_000);
  const [model] = models;
  assert.equal(model.package.id, packageId);
  assert.equal(model.package.version, version);
  assert.equal(model.package.package_sha256, packageSha);
  assert.equal(model.package.model.sha256, modelSha);
  assert.equal(model.package.metadata_sha256, metadataSha);
  assert.equal(model.reference_qualification.compatible, true);
  assert.equal(model.reference_qualification.comparison.mismatched_elements, 0);
  assert.equal(model.import_working_bytes, TWO_GIB);
  await page.getByLabel("Model package", { exact: true }).waitFor();
  await checkpoint("model-02-verified-local-registration");
  return model;
}

export function comparisonRequest(sourceId, approvedSelection, model) {
  const { c, z_stop: stop, ...selection } = approvedSelection;
  assert.equal(c, 0);
  assert.equal(stop, undefined);
  const [channel] = model.package.input.channels;
  assert.equal(channel.source_index, 0);
  return {
    model_id: model.model_id, source_id: sourceId, selection,
    channel_mapping: [{ model_input_index: 0, model_channel: channel.name, source_channel: 0 }],
    scale: { mode: "source" },
    postprocessing: { probability_channel: 0, threshold: 0.5, method: "components", min_size: 1,
      split_height: null, exclude_border: false },
    measurement_channels: [0],
    display: { source_channel: 0, low: 140, high: 900, gamma: 1, color: "#ffffff" },
    working_bytes: TWO_GIB,
  };
}

export async function runScopedModel({ page, source, model, approvedSelection, sdk, checkpoint, snapshot, record, submitAction, hashText }) {
  const discovered = await sdk.call("inspect_action", { operation: "model_list", request: {} });
  assert.equal(discovered.models.length, 1);
  const [registered] = discovered.models;
  assert.equal(registered.model_id, model.model_id);
  assert.equal(registered.package.package_sha256, packageSha);
  assert.equal(registered.agent_execution.model_package_granted, true);
  assert.equal(registered.agent_execution.runtime_granted, true);
  assert.equal(registered.agent_execution.adoption_requires_human_visual_review, true);
  const request = comparisonRequest(source.id, approvedSelection, model);
  const ungrantedChannel = { ...request, channel_mapping: [{ ...request.channel_mapping[0], source_channel: 1 }] };
  const beforeRefusal = await snapshot();
  const refusal = await sdk.callResponse("submit_action", {
    operation: "model_preview", request: ungrantedChannel, request_key: "onnx-ungranted-channel",
  }, true);
  assertPolicyRefusal(refusal);
  const afterRefusal = await snapshot();
  assert.deepEqual(afterRefusal.jobs.map(({ id }) => id), beforeRefusal.jobs.map(({ id }) => id));
  assert.deepEqual(afterRefusal.agent_sessions.approvals.map(({ id }) => id),
    beforeRefusal.agent_sessions.approvals.map(({ id }) => id));
  const previewJob = await submitAction("model_preview", request, "onnx-preview");
  assert.deepEqual(previewJob.result_ids, [], "Preview published a durable result");
  const reply = await sdk.callResponse("inspect_action", { operation: "task_preview_get", request: { job_id: previewJob.id } });
  const cached = reply.structured_content.preview;
  const preview = cached.output.preview;
  const image = reply.structured_content.image_transport.images.find((part) => part.json_pointer === "/preview/output/overlay_png");
  assert.ok(image, "MCP must deliver a native image block for the retained overlay");
  assert.equal(reply.content[image.content_index].type, "image");
  assert.equal(reply.content[image.content_index].sha256, image.sha256);
  assert.equal(cached.source_sha256, source.sha256);
  assert.equal(cached.job_id, previewJob.id);
  assert.equal(cached.operation, "model_preview");
  assert.equal(cached.adopted, false);
  assert.equal(preview.package.package_sha256, packageSha);
  assert.equal(preview.source.id, source.id);
  assert.deepEqual(preview.source.selection, request.selection);
  assert.equal(preview.source.display.png_sha256, image.sha256);
  const previewBinding = { preview_id: preview.id, preview_sha256: preview.preview_sha256 };
  const adoption = await submitAction("model_run", previewBinding, "onnx-adopt", async ({ card, originalApprove, pending }) => {
    assert.equal(pending.explicit_approval_required, true);
    assert.equal(pending.parameters_summary.preview_job_id, previewJob.id);
    assert.equal(pending.parameters_summary.preview_id, preview.id);
    assert.equal(pending.parameters_summary.preview_sha256, preview.preview_sha256);
    assert.equal(pending.parameters_summary.png_sha256, image.sha256);
    assert.equal(pending.parameters_summary.review_requirement, "visual-preview-inspection-required");
    if (await originalApprove.count()) assert.equal(await originalApprove.isDisabled(), true, "Adoption allowed before visual inspection");
    await card.getByRole("button", { name: "Inspect model preview", exact: true }).click();
    const displayedPreview = page.getByRole("region", { name: "Agent preview comparison", exact: true });
    const picture = displayedPreview.getByRole("img", { name: "Source with predicted model labels", exact: true });
    await picture.waitFor();
    assert.equal(await picture.getAttribute("data-preview-job"), previewJob.id);
    const displayedSha = await waitFor(page, async () => {
      const url = await picture.evaluate((img) => img.complete && img.naturalWidth > 0 ? img.src : null);
      return url?.startsWith("data:image/png;base64,") && hashText(Buffer.from(url.split(",", 2)[1], "base64"));
    }, (sha) => sha === image.sha256, "exact retained preview in the image stage", 15_000);
    assert.equal(displayedSha, image.sha256);
    const region = preview.source.selection;
    const channel = preview.source.channel_mapping[0].source_channel;
    await displayedPreview.getByText(`${region.width} × ${region.height} px at (${region.x}, ${region.y}) · Input C ${channel} · Z ${region.z} · T ${region.t} (zero-based)`, { exact: true }).waitFor();
    await displayedPreview.getByText(`${preview.output.object_count} predicted objects · green outlines`, { exact: true }).waitFor();
    await checkpoint("model-04-exact-preview-rendered");
    const confirm = displayedPreview.getByRole("checkbox", { name: "I inspected this model preview", exact: true });
    const approve = displayedPreview.getByRole("button", { name: "Approve submit_action", exact: true });
    assert.equal(await confirm.isChecked(), false);
    assert.equal(await approve.isDisabled(), true, "Adoption allowed before visual attestation");
    await confirm.check();
    return approve;
  });
  assert.equal(adoption.result_ids.length, 1);
  const id = adoption.result_ids[0];
  const result = (await snapshot()).results.find((item) => item.id === id);
  const retained = await sdk.call("result", { result_id: id, limit: 1 });
  assert.equal(result.kind, "model-segmentation");
  assert.equal(result.source_sha256, source.sha256);
  assert.deepEqual(result.selection, { ...request.selection, c: 0 });
  assert.equal(retained.result.revision_hash, result.revision_hash);
  assert.equal(retained.result.review, null);
  assert.deepEqual((await sdk.call("review_history", { result_id: id })).events, []);
  assert.equal(retained.provenance.model_preview.id, preview.id);
  assert.equal(retained.provenance.model_preview.sha256, preview.preview_sha256);
  assert.equal(retained.provenance.model.package_sha256, packageSha);
  assert.equal(retained.provenance.measurement_basis, "raw-selected-source-channel-values-on-model-label-grid");
  const evidence = await record("verified-onnx-adoption.json", {
    source_sha256: source.sha256,
    model: { id: model.model_id, package_sha256: packageSha, runtime: registered.agent_execution.runtime_policy_identity },
    scope: request, ungranted_channel: { channel: 1, rejected: true, job_created: false, approval_created: false },
    preview: { job_id: previewJob.id, ...previewBinding, image_sha256: image.sha256, output_sha256: cached.output_sha256 },
    adoption: { job_id: adoption.id, ...binding(result), labels_sha256: result.arrays.labels.sha256,
      objects: retained.total_rows, scientific_review: retained.result.review },
  });
  return { result, evidence };
}

export async function compareSavedMethods({ source, classical, prediction, submitAction, snapshot, record }) {
  const request = {
    ...binding(prediction), reference: binding(classical), semantics: "instances", iou_thresholds: [0.5],
    reference_declaration: "Classical prediction on the full native BBBC039 plane. Neither mask establishes ground truth.",
    working_bytes: 64 * 1024 ** 2,
  };
  const completed = await submitAction("annotation_evaluation_run", request, "model-comparison");
  assert.equal(completed.result_ids.length, 1);
  const state = await snapshot();
  const result = state.results.find((item) => item.id === completed.result_ids[0]);
  assert.equal(result.kind, "annotation-agreement");
  assert.equal(result.source_id, source.id);
  assert.deepEqual(result.annotation_evaluation.inputs, {
    prediction: { ...binding(prediction), labels_sha256: prediction.arrays.labels.sha256 },
    reference: { ...binding(classical), labels_sha256: classical.arrays.labels.sha256 },
  });
  const comparison = await record("prediction-disagreement.json", {
    source_id: source.id, source_sha256: source.sha256, job_id: completed.id,
    ...binding(result), evidence: result.annotation_evaluation,
  });
  return { result, comparison };
}

export async function inspectSavedDifferences({ page, source, result, checkpoint, record }) {
  const agreement = page.getByRole("region", { name: "Saved annotation agreement", exact: true });
  await agreement.getByRole("heading", { name: "Saved prediction disagreement", exact: true }).waitFor();
  const stepper = agreement.getByRole("region", { name: "Show me the differences", exact: true });
  const categories = stepper.getByRole("group", { name: "Difference category" });
  const scores = result.annotation_evaluation.metrics.instances.scores;
  assert.equal(scores.length, 1);
  const [score] = scores;
  assert.ok(score.unmatched_prediction_count + score.unmatched_reference_count > 0 && score.matches_count > 0,
    "Pinned fixture must exercise both a disagreement and a matched pair");

  const locate = async (table, role, label) => {
    const expected = await execute(page, "annotation_evaluation_get", { ...binding(result), table: "locate", role, label });
    assert.deepEqual(expected.target, result.annotation_evaluation.inputs[role]);
    assert.deepEqual(expected.point_index.toReversed(), expected.source_point_xy);
    const readout = stepper.locator(`.annotation-difference-readout[data-agreement-id="${result.id}"][data-agreement-revision="${result.revision_hash}"][data-difference-table="${table}"][data-target-role="${role}"][data-target-label="${label}"]`);
    await readout.waitFor();
    assert.equal(await readout.getAttribute("data-target-result-id"), expected.target.result_id);
    assert.equal(await readout.getAttribute("data-target-revision"), expected.target.revision_hash);
    assert.equal(await readout.getAttribute("data-point-index"), expected.point_index.join(","));
    assert.equal(await readout.getAttribute("data-source-point-xy"), expected.source_point_xy.join(","));
    await page.locator(`.research-sources [data-result-id="${expected.target.result_id}"][aria-pressed="true"]`).waitFor();
    const viewerSelector = `[data-viewer-source="${source.id}"][data-result-overlay="${expected.target.result_id}:${expected.target.revision_hash}"][data-prepared="true"]`;
    const [x, y] = expected.source_point_xy.map((value) => value + 0.5);
    const handle = await page.waitForFunction(({ selector, x, y }) => {
      const camera = document.querySelector(selector)?.dataset.camera;
      if (!camera) return false;
      const state = JSON.parse(camera);
      return Math.abs(state.x - x) < 1e-5 && Math.abs(state.y - y) < 1e-5 && state.scale >= 1.5 ? state : false;
    }, { selector: viewerSelector, x, y });
    const camera = await handle.jsonValue();
    await handle.dispose();
    return { ...expected, camera, overlay: await page.locator(viewerSelector).getAttribute("data-result-overlay") };
  };

  await stepper.getByRole("button", { name: "Show me the differences", exact: true }).click();
  const unmatched = score.unmatched_prediction_count > 0 ? "unmatched_prediction" : "unmatched_reference";
  const unmatchedRole = unmatched === "unmatched_prediction" ? "prediction" : "reference";
  const row = (table) => execute(page, "annotation_evaluation_get", {
    ...binding(result), table, threshold_index: 0, offset: 0, limit: 1,
  });
  await categories.getByRole("button", { name: unmatchedRole === "prediction" ? /^Only in prediction a / : /^Only in prediction b / }).click();
  const first = await locate(unmatched, unmatchedRole, (await row(unmatched)).rows[0]);
  await checkpoint("model-unmatched-source-object");
  await categories.getByRole("button", { name: /^Matched \(/ }).click();
  const pair = (await row("matches")).rows[0];
  const sides = stepper.getByRole("group", { name: "Matched object overlay side" });
  const matchedA = await locate("matches", "prediction", pair.prediction_label);
  await sides.getByRole("button", { name: "Prediction B", exact: true }).click();
  const matchedB = await locate("matches", "reference", pair.reference_label);
  await checkpoint("model-matched-source-object");
  await stepper.getByRole("button", { name: "Return to agreement", exact: true }).click();
  await page.locator(`.research-sources [data-result-id="${result.id}"][aria-pressed="true"]`).waitFor();
  await noUiError(page, "return to saved disagreement");
  return record("located-source-objects.json", { unmatched: first, pair, matched: [matchedA, matchedB] });
}
