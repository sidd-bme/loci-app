// @vitest-environment node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));
import { findCodexDesktop, openCodexDesktop } from "./agent-host-handoff";

const actualPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (platform: string) => Object.defineProperty(process, "platform", { ...actualPlatform, value: platform });
let root: string;
let bundle: string;

beforeEach(async () => {
  setPlatform("darwin");
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "loci-codex-discovery-")));
  bundle = path.join(root, "ChatGPT.app");
  await fs.mkdir(bundle);
  execute.mockReset().mockImplementation((program, _args, _options, callback) => {
    callback(null, { stdout: program === "/usr/bin/osascript" ? JSON.stringify(bundle) : "" });
  });
});

afterEach(async () => {
  Object.defineProperty(process, "platform", actualPlatform);
  await fs.rm(root, { recursive: true, force: true });
});

it("queries the fixed bundle identity and verifies the developer signature before launch", async () => {
  expect(await findCodexDesktop(true)).toBe(bundle);
  expect(execute.mock.calls.map(([program]) => program)).toEqual(["/usr/bin/osascript", "/usr/bin/codesign"]);
  expect(execute.mock.calls[0][1].at(-1)).toBe("com.openai.codex");
  expect(execute.mock.calls[1][1]).toEqual([
    "--verify", "--strict",
    '-R=identifier "com.openai.codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"', bundle,
  ]);
});

it("uses no macOS tool on unsupported platforms and never dispatches on a missing or unverified bundle", async () => {
  for (const platform of ["linux", "win32"]) {
    setPlatform(platform);
    expect(await findCodexDesktop()).toBeNull();
  }
  expect(execute).not.toHaveBeenCalled();
  setPlatform("darwin");
  execute.mockImplementationOnce((_program, _args, _options, callback) => callback(null, { stdout: "" }));
  expect(await findCodexDesktop()).toBeNull();
  expect(execute.mock.calls.map(([program]) => program)).toEqual(["/usr/bin/osascript"]);
  execute.mockImplementation((program, _args, _options, callback) => {
    if (program === "/usr/bin/codesign") callback(new Error("Missing signature"));
    else callback(null, { stdout: JSON.stringify(bundle) });
  });
  expect(await findCodexDesktop()).toBeNull();
  expect(execute.mock.calls.map(([program]) => program)).not.toContain("/usr/bin/open");
});

it("dispatches only a workspace deep link with fixed executable and discrete arguments", async () => {
  const directory = path.join(root, "Researcher's study & 50% #火 $(literal)", "codex-workspace");
  await openCodexDesktop(bundle, directory);
  expect(execute).toHaveBeenCalledOnce();
  const [executable, [flag, target, uri], options] = execute.mock.calls[0];
  expect(executable).toBe("/usr/bin/open");
  expect(flag).toBe("-a");
  expect(target).toBe(bundle);
  expect(options).not.toHaveProperty("shell");
  const url = new URL(uri);
  expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("codex://threads/new");
  expect([...url.searchParams]).toEqual([["path", directory]]);

  execute.mockImplementationOnce((_program, _args, _options, callback) => callback(new Error(directory)));
  await expect(openCodexDesktop(bundle, directory)).rejects.toThrow("Could not open this workspace in Codex.");
});
