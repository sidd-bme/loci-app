import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicSurfaceProblems, validatePaths } from "../check-public-surface.mjs";

const inspect = (files) => publicSurfaceProblems(Object.keys(files), (path) => files[path]);

test("rejects development paths while retaining product agent interfaces and release tools", () => {
  for (const path of [".agents/skills/README.md", ".codex/config.toml", ".github/development/AGENTS.md", "AGENTS.md", "desktop/AGENTS.md", "docs/GEMINI.md", "engine/CLAUDE.md", "docs/ADR-0001-desktop.md", "docs/PROJECT_STATE.md", "docs/ROADMAP.md", "docs/PRODUCT_FOUNDATION.md", "docs/RESEARCH_DECISIONS_2026-09.md", "docs/workflows/epidermal_thickness_model_feasibility.md", "scripts/dev_snapshot.py", "scripts/tests/test_dev_snapshot.py"]) {
    assert.equal(inspect({ [path]: "" }).length, 1, path);
  }
  assert.deepEqual(inspect({ "docs/AGENT_ACCESS.md": "Product MCP access", "docs/RELEASE_CONTRACT.md": "Atomic publication", "scripts/build-engine.sh": "", "scripts/release_evidence.py": "" }), []);
});

test("rejects private repository and workstation paths only in documentation", () => {
  for (const reference of ["https://github.com/sidd-bme/Loci/blob/main/README.md", "https://github.com/sidd-bme/Loci.git", "/Volumes/sid/Loci", "/Users/researcher/Loci"]) {
    assert.match(inspect({ "docs/BUILDING.md": reference })[0], /private repository or local checkout/);
  }
  assert.deepEqual(inspect({ "README.md": "https://github.com/sidd-bme/loci-app https://github.com/sidd-bme/Loci-film /Applications/Loci.app", "engine/tests/test_source.py": "/Volumes/private/example.tif", "docs/QUANTIFICATION.md": "Biological validation remains separate from structural checks." }), []);
});

test("rejects links to removed planning material", () => {
  assert.match(inspect({ "docs/README.md": "See [state](PROJECT_STATE.md)." }).join("\n"), /development coordination/);
});

test("checks links against the proposed public file set even while removed originals exist", () => {
  const files = { "README.md": "[manual](docs/USING_LOCI.md#open-images) ![capture](docs/media/capture.png) [website](https://example.org) [licence](LICENSE)", "docs/USING_LOCI.md": "[home](../README.md) [here](#open-images)", "docs/media/capture.png": "", "LICENSE": "" };
  assert.deepEqual(inspect(files), []);
  delete files["docs/media/capture.png"];
  assert.match(inspect(files)[0], /link is not in the public file set/);
  assert.match(inspect({ "README.md": "[outside](../secret.md)" })[0], /link leaves repository/);
});

test("malformed path lists and unreadable documentation fail closed", () => {
  for (const paths of [null, {}, ["../private.md"], ["/private.md"], ["docs\\private.md"], ["docs/./private.md"], ["docs//private.md"], [1]]) assert.throws(() => validatePaths(paths));
  assert.throws(() => publicSurfaceProblems(["docs/MISSING.md"], () => { throw new Error("Missing file"); }), /Missing file/);
});

test("guards the two runtime manual routes including escaped allowlist regex", () => {
  const renderer = "desktop/src/renderer/UserGuideDialog.tsx";
  const main = "desktop/src/main/manual-links.ts";
  assert.match(inspect({ [renderer]: "https://github.com/sidd-bme/Loci/blob/main/docs/" })[0], /private repository manual route/);
  assert.match(inspect({ [main]: String.raw`/^\/sidd-bme\/Loci\/blob\/main\/docs\//` })[0], /private repository manual route/);
  assert.deepEqual(inspect({ [renderer]: "https://github.com/sidd-bme/loci-app/blob/main/docs/", [main]: String.raw`/^\/sidd-bme\/loci-app\/blob\/main\/docs\//`, "desktop/src/main/manual-links.test.ts": "https://github.com/sidd-bme/Loci/blob/main/docs/" }), []);
});

test("default CLI checks staged blobs even when working-tree documentation is clean", () => {
  const root = mkdtempSync(join(tmpdir(), "loci-public-surface-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(join(root, "README.md"), "https://github.com/sidd-bme/Loci/blob/main/docs/README.md");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    writeFileSync(join(root, "README.md"), "https://github.com/sidd-bme/loci-app");
    const script = fileURLToPath(new URL("../check-public-surface.mjs", import.meta.url));
    const staged = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(staged.status, 1);
    assert.match(staged.stderr, /private repository or local checkout/);
    const proposed = join(root, "proposed.json");
    writeFileSync(proposed, JSON.stringify(["README.md"]));
    const working = spawnSync(process.execPath, [script, "--paths-file", proposed], { cwd: root, encoding: "utf8" });
    assert.equal(working.status, 0, working.stderr);
    assert.match(working.stdout, /proposed working-tree contents/);
    execFileSync("git", ["add", "README.md"], { cwd: root });
    const clean = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /Git index contents/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
