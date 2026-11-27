import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const codexBundleId = "com.openai.codex";
const codexSigningRequirement = `identifier "${codexBundleId}" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"`;
const lookup = `function run(args) {
  ObjC.import("AppKit");
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(args[0]);
  if (url.isNil()) return;
  const bundle = $.NSBundle.bundleWithURL(url);
  const urlTypes = ObjC.deepUnwrap(bundle.objectForInfoDictionaryKey("CFBundleURLTypes"));
  if (urlTypes?.some(type => type.CFBundleURLSchemes?.includes("codex")))
    return JSON.stringify(ObjC.unwrap(url.path));
}`;

/** Query Launch Services without opening an app, then verify the installed bundle. */
export async function findCodexDesktop(verifyResources = false): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", lookup, codexBundleId], { timeout: 5_000, maxBuffer: 32_768 });
    if (!stdout.trim()) return null;
    const found: unknown = JSON.parse(stdout);
    if (typeof found !== "string" || !path.isAbsolute(found)) return null;
    const bundle = await fs.realpath(found);
    if (path.extname(bundle) !== ".app" || !(await fs.lstat(bundle)).isDirectory()) return null;
    const verification = verifyResources ? "--strict" : "--ignore-resources";
    await run("/usr/bin/codesign", ["--verify", verification, `-R=${codexSigningRequirement}`, bundle], { timeout: 15_000, maxBuffer: 32_768 });
    return bundle;
  } catch {
    return null;
  }
}

/** The Codex CLI uses this URL on macOS, but its app command can install the host. */
export async function openCodexDesktop(bundle: string, workspace: string): Promise<void> {
  const query = new URLSearchParams({ path: workspace });
  try {
    await run("/usr/bin/open", ["-a", bundle, `codex://threads/new?${query}`], { timeout: 10_000, maxBuffer: 32_768 });
  } catch {
    throw new Error("Could not open this workspace in Codex. Use the setup folder or terminal command.");
  }
}
