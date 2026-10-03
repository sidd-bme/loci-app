import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Inspect tracked source, not ignored maintainer files or image/data payloads.
const developmentPath = /^(?:\.agents\/|\.codex\/|\.github\/development\/|docs\/ADR-\d|docs\/(?:PRODUCT_FOUNDATION|PROJECT_STATE|RESEARCH_DECISIONS[^/]*|ROADMAP)\.md$|docs\/workflows\/epidermal_thickness_model_feasibility\.md$|scripts\/(?:dev_snapshot\.py|tests\/test_dev_snapshot\.py)$)/;
const agentEntrypoint = /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/i;
const manualRoutingPaths = new Set(["desktop/src/renderer/UserGuideDialog.tsx", "desktop/src/main/manual-links.ts"]);
const privateManualRoute = /(?:github\.com\/sidd-bme\/Loci(?:[/.?#\s]|$)|\/sidd-bme\/Loci\/blob\/)/i;
const documentationPath = /^(?:[^/]+\.md|docs\/.*\.md)$/i;
const privateReference = /https?:\/\/github\.com\/sidd-bme\/Loci(?:\.git)?(?=[/#?\s)"'`]|$)|\/(?:Volumes|Users)\/[^\s)"'`]+/i;
const developmentReference = /(?:\.agents\/|\.codex\/|\.github\/development\/|\bADR-\d{4}|\b(?:PROJECT_STATE|PRODUCT_FOUNDATION|ROADMAP|RESEARCH_DECISIONS[^/\s]*)\.md\b)/;

export function validatePaths(paths) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || !part))) {
    throw new Error("Expected a JSON array of repository-relative file paths");
  }
  return new Set(paths);
}

export function publicSurfaceProblems(paths, readText) {
  const tracked = validatePaths(paths);
  const problems = [];
  for (const path of [...tracked].sort()) {
    if (developmentPath.test(path) || agentEntrypoint.test(path)) {
      problems.push(`${path}: development-only path is tracked`);
      continue;
    }
    if (manualRoutingPaths.has(path)) {
      // The main allowlist uses escaped slashes in its regular expression.
      if (privateManualRoute.test(readText(path).replaceAll("\\/", "/"))) {
        problems.push(`${path}: private repository manual route`);
      }
      continue;
    }
    if (!documentationPath.test(path)) continue;
    const text = readText(path);
    for (const [index, line] of text.split("\n").entries()) {
      if (privateReference.test(line)) problems.push(`${path}:${index + 1}: private repository or local checkout reference`);
      if (developmentReference.test(line)) problems.push(`${path}:${index + 1}: development coordination or planning reference`);
    }
    for (const match of text.matchAll(/\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
      const destination = target.split(/[?#]/)[0];
      if (!destination) continue;
      const absolute = resolve("/public", dirname(path), decodeURIComponent(destination));
      if (!absolute.startsWith("/public/")) {
        problems.push(`${path}: link leaves repository: ${target}`);
        continue;
      }
      const relative = absolute.slice("/public/".length);
      if (!tracked.has(relative)) problems.push(`${path}: link is not in the public file set: ${target}`);
    }
  }
  return problems;
}

export function checkPublicSurface(root, paths) {
  return publicSurfaceProblems(paths, (path) => readFileSync(resolve(root, path), "utf8"));
}

export function checkPublicIndex(root) {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const problems = publicSurfaceProblems(paths, (path) => execFileSync("git", ["show", `:${path}`], { cwd: root, encoding: "utf8" }));
  return { paths, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--paths-file")) {
      throw new Error("Usage: node scripts/check-public-surface.mjs [--paths-file proposed-files.json]");
    }
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const { paths, problems } = args.length
      ? (() => {
        const paths = JSON.parse(readFileSync(args[1], "utf8"));
        return { paths, problems: checkPublicSurface(root, paths) };
      })()
      : checkPublicIndex(root);
    if (problems.length) throw new Error(problems.join("\n"));
    console.log(`Public surface passed (${validatePaths(paths).size} files; ${args.length ? "proposed working-tree contents" : "Git index contents"})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
