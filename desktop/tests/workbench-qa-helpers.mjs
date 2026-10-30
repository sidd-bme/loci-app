import assert from "node:assert/strict";

/** Poll awaited IPC snapshots; waitForFunction treats an async predicate as truthy. */
export async function waitForSnapshot(page, predicate, label, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  let snapshot;
  while (performance.now() < deadline) {
    snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
    if (predicate(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}; ${snapshot?.results?.length ?? 0} results available.`);
}

const toolGroup = {
  Display: "View", Annotate: "Annotate", Epidermis: "Annotate", Correction: "Annotate", Analyze: "Analyze",
  Process: "Analyze", Workflow: "Analyze", Model: "Analyze", Quantify: "Analyze", Temporal: "Analyze",
  Registration: "Analyze", Population: "Results", Density: "Results", Info: "Results", Study: "Results",
};
const advancedLabel = { Agent: "Connect an assistant", Remote: "Remote compute",
  Portability: "Import & share results", "Vendor import": "Convert vendor images" };
const toolLabel = { Display: "Image & channels", Annotate: "Draw & measure", Epidermis: "Epidermal thickness", Correction: "Edit labels & ROIs",
  Analyze: "Segment & measure", Process: "Preprocess", Workflow: "Workflow builder", Model: "Use a model", Quantify: "Fluorescence & field assay",
  Temporal: "Track over time", Registration: "Register & resample", Population: "Statistics & objects", Density: "Spatial donor density", Info: "Review & export", Study: "Study & batch" };

/** Exercise the same task-group and search controls available to a researcher. */
export async function selectWorkbenchTool(page, tool, studySection = "Batch") {
  // Clicking a different tool normally blurs and commits a numeric draft. Do
  // that before Escape: sending Escape into a still-focused field discards it.
  const editable = page.locator('input:focus, textarea:focus, select:focus, [contenteditable="true"]:focus');
  if (await editable.count()) await editable.press("Tab");
  // Dismiss a tip or open chooser through the same keyboard route as a user.
  // Long engine operations can leave the pointer over another control's help.
  await page.keyboard.press("Escape");
  if (advancedLabel[tool]) {
    await page.getByRole("button", { name: "Search all tools", exact: true }).click();
    await page.getByRole("combobox", { name: "Search all tools", exact: true }).fill(advancedLabel[tool]);
    await page.getByRole("option", { name: advancedLabel[tool], exact: true }).click();
  } else {
    const group = toolGroup[tool];
    assert.ok(group, `Unknown workbench tool: ${tool}`);
    await page.getByRole("navigation", { name: "Task groups" }).getByRole("button", { name: group, exact: true }).click();
    await page.getByRole("combobox", { name: `${group} tool`, exact: true }).click();
    await page.getByRole("listbox", { name: `${group} tool`, exact: true })
      .getByRole("option", { name: toolLabel[tool], exact: true }).click();
  }
  if (tool === "Display") await revealAnalysisRegion(page);
  if (tool === "Study") {
    await selectStudySection(page, studySection);
  }
}

/** Choose an ordinary result section explicitly; indexed results retain their dedicated inspector. */
export async function selectResultSection(page, section, kind = "ordinary") {
  assert.ok(["Review", "Export"].includes(section), `Unknown result section: ${section}`);
  assert.ok(["ordinary", "indexed"].includes(kind), `Unknown result interface: ${kind}`);
  const controls = page.getByRole("group", { name: "Result sections", exact: true });
  if (kind === "indexed") {
    assert.equal(await controls.count(), 0, "Indexed results must retain the dedicated inspector");
    await page.getByRole("region", { name: "Large result objects", exact: true }).waitFor({ state: "visible" });
    return;
  }
  await controls.waitFor({ state: "visible" });
  const button = controls.getByRole("button", { name: section, exact: true });
  if (await button.getAttribute("aria-pressed") !== "true") await button.click();
  assert.equal(await button.getAttribute("aria-pressed"), "true", `${section} section was not selected`);
  await page.getByRole("region", { name: section === "Review" ? "Review result" : "Export result data", exact: true }).waitFor();
}

/** Legacy batch journeys explicitly choose their task in the study workspace. */
export async function selectStudySection(page, section) {
  await page.getByRole("tablist", { name: "Study sections", exact: true })
    .getByRole("tab", { name: section, exact: true }).click();
  await page.getByRole("tabpanel", { name: section, exact: true }).waitFor();
  if (section === "Batch") for (const details of await page.locator("details.study-analysis-section").filter({ visible: true }).all()) {
    if (!(await details.evaluate((element) => element.open))) await details.locator(":scope > summary").click();
  }
}

export async function revealAnalysisRegion(page) {
  const details = page.locator("details.analysis-region-settings");
  if (await details.count() && !(await details.evaluate((element) => element.open)))
    await details.locator(":scope > summary").click();
}

export async function revealExternalLabels(page) {
  const details = page.locator("details.external-labels-disclosure");
  if (!(await details.evaluate((element) => element.open))) await details.locator(":scope > summary").click();
}

export async function createEmptyStudy(page) {
  const options = page.getByRole("button", { name: "More opening options", exact: true });
  if (await options.getAttribute("aria-expanded") !== "true") await options.click();
  await page.getByRole("button", { name: "New empty study", exact: true }).click();
}

export async function fileMenuAction(page, name) {
  const action = page.getByRole("button", { name, exact: true });
  const visible = await action.filter({ visible: true }).count();
  if (visible) return action.filter({ visible: true }).first().click();
  const menu = page.locator("details.workbench-file-menu");
  if (!(await menu.evaluate((element) => element.open))) await menu.locator(":scope > summary").click();
  await menu.getByRole("button", { name, exact: true }).click();
}

export async function setSelectionField(page, label, value) {
  const input = page.getByLabel(label, { exact: true });
  if (!(await input.count()) && ["Z", "T"].includes(label)) {
    assert.equal(Number(value), 0, `Absent ${label} axis only accepts its single zero-based plane`);
    const dimension = await page.evaluate(async (axis) => {
      const snapshot = await window.lociResearch.getSnapshot();
      const name = document.querySelector('[aria-label="Active image"]')?.textContent;
      const source = snapshot.sources.find((item) => item.name === name);
      return source?.metadata.dimensions?.[axis];
    }, label.toLowerCase());
    assert.equal(dimension, 1, `Absent ${label} control must correspond to one verified plane`);
    return;
  }
  await input.fill(String(value));
  await input.press("Enter");
}
