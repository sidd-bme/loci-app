import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  captureFolderImportFailure, closeWithConfirmedQuit, researchSourceButtonSelector,
  researchSourceNameSelector, reopenStudyFromEmptyState, waitForRenderedSources,
} from "./public-hardening-qa-helpers.mjs";

test("source lookup tolerates nested rows and excludes unrelated buttons", async () => {
  const dom = new JSDOM(`<aside class="research-sources"><button>Open folder</button>
    <div class="research-sources-list"><button data-source-id="a"><span class="research-source-name-row"><span class="research-source-name">same.tif</span></span></button>
    <button data-source-id="b"><span class="research-source-name-row"><span class="research-source-name">same.tif</span></span></button></div></aside>`);
  const priorDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    assert.equal(document.querySelectorAll(researchSourceButtonSelector).length, 2);
    const page = {
      async waitForFunction(predicate, argument, options) {
        assert.equal(options.timeout, 1234);
        assert.deepEqual(argument, { selector: researchSourceNameSelector, count: 2 });
        assert.equal(predicate(argument), true);
        assert.equal(predicate({ ...argument, count: 3 }), false);
      },
      locator(selector) { return { async count() { return document.querySelectorAll(selector).length; } }; },
    };
    assert.equal(await waitForRenderedSources(page, 2, 1234), 2);
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    dom.window.close();
  }
});

test("cold reopen uses the study picker only when the empty landing is visible", async () => {
  for (const empty of [true, false]) {
    let clicks = 0;
    const page = {
      locator(selector) { assert.equal(selector, "main.image-first-empty"); return { async isVisible() { return empty; } }; },
      getByRole(role, options) {
        assert.equal(role, "button"); assert.deepEqual(options, { name: "Open study", exact: true });
        return { async click() { clicks++; } };
      },
    };
    await reopenStudyFromEmptyState(page);
    assert.equal(clicks, empty ? 1 : 0);
  }
});

test("folder failure diagnostics continue after a screenshot failure", async () => {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loci-folder-diagnostics-"));
  const snapshot = { sources: [{ id: "authorized-fixture" }], results: [] };
  try {
    await captureFolderImportFailure({ async firstWindow() { return {
      isClosed() { return false; },
      async screenshot() { throw new Error("screenshot unavailable"); },
      async content() { return "<main>Import failed</main>"; },
      async evaluate() { return snapshot; },
    }; } }, runRoot);
    assert.equal(await fs.readFile(path.join(runRoot, "failure-page.html"), "utf8"), "<main>Import failed</main>");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(runRoot, "failure-snapshot.json"), "utf8")), snapshot);
    await captureFolderImportFailure({ async firstWindow() { return { isClosed() { return true; } }; } }, runRoot);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test("confirmed quit retains its failure if fallback close also fails", async () => {
  const primary = new Error("quit confirmation failed");
  let forcedClose = 0;
  await assert.rejects(closeWithConfirmedQuit({
    async evaluate() { throw primary; },
    async close() { forcedClose++; throw new Error("fallback failed"); },
  }), (error) => error === primary);
  assert.equal(forcedClose, 1);
});

test("confirmed quit observes the close event and uses fallback on event failure", async () => {
  for (const fail of [false, true]) {
    let evaluations = 0, forcedClose = 0;
    const eventFailure = new Error("close event failed");
    const app = {
      async evaluate() { evaluations++; },
      waitForEvent(name, options) {
        assert.equal(name, "close"); assert.equal(options.timeout, 15_000);
        return fail ? Promise.reject(eventFailure) : Promise.resolve();
      },
      async close() { forcedClose++; },
    };
    if (fail) await assert.rejects(closeWithConfirmedQuit(app), (error) => error === eventFailure);
    else await closeWithConfirmedQuit(app);
    assert.equal(evaluations, 2); assert.equal(forcedClose, fail ? 1 : 0);
  }
});
