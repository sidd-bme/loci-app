// Independent stdio client for the packaged MCP compatibility boundary.
// Use only with an explicitly provisioned synthetic QA policy.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const supplied = process.argv.slice(2);
assert.ok(supplied.length === 3 && supplied.every(Boolean),
  "Usage: node scripts/qa-mcp-protocol.mjs ENGINE SYNTHETIC_POLICY RECEIPT");
const [executable, policyPath, receiptPath] = supplied.map((value) => resolve(value));
const policy = JSON.parse(await readFile(policyPath, "utf8"));
const child = spawn(executable, ["--cli", "mcp", "--policy", policyPath], {
  stdio: ["pipe", "pipe", "pipe"],
});
let nextId = 1;
let diagnosticBytes = 0;
let diagnostics = "";
let stdoutBytes = 0;
const pending = new Map();
let fatal;
function fail(error) {
  fatal = error;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
  pending.clear();
}
child.once("error", fail);
child.once("exit", () => { if (pending.size) fail(new Error("MCP exited before replying")); });
child.stderr.on("data", (chunk) => {
  diagnosticBytes += chunk.length;
  if (diagnosticBytes > 4096) { fail(new Error("Unbounded MCP diagnostics")); child.kill(); }
  else diagnostics += chunk.toString("utf8");
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    stdoutBytes += Buffer.byteLength(line);
    assert.ok(stdoutBytes < 4 * 1024 ** 2, "Bounded synthetic exchange exceeded its output budget");
    const message = JSON.parse(line);
    if (message.id === undefined) return; // Protocol notifications, never terminal prose.
    const item = pending.get(message.id);
    assert.ok(item, "Unexpected response ID");
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(new Error(`MCP protocol error ${message.error.code}`));
    else item.resolve(message.result);
  } catch (error) { fail(error); child.kill(); }
});
function request(method, params = {}) {
  if (fatal) return Promise.reject(fatal);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`MCP request timed out: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const startedAt = new Date().toISOString();
try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "loci-independent-stdio-qa", version: "1.0.0" },
  });
  assert.equal(initialized.protocolVersion, "2025-11-25");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list");
  assert.deepEqual(listed.tools.map((item) => item.name).sort(), [
    "analysis_context", "cancel_job", "catalog", "export_result", "inspect_source",
    "job_status", "preview_recipe", "recipe_guide", "result", "result_view", "submit_recipe", "validate_recipe",
  ]);
  for (const tool of listed.tools) {
    assert.ok(tool.description?.length > 15, `Missing useful description: ${tool.name}`);
    assert.ok(tool.annotations, `Missing behavior hints: ${tool.name}`);
  }
  const resources = await request("resources/list");
  assert.deepEqual(resources.resources.map((item) => item.uri).sort(), ["loci://context", "loci://guides/recipes"]);
  const guide = await request("tools/call", { name: "recipe_guide", arguments: {} });
  assert.ok(!guide.isError);
  assert.equal(guide.structuredContent.schema, "loci.recipe-guide/v1");
  const document = await request("resources/read", { uri: "loci://guides/recipes" });
  assert.equal(document.contents.length, 1);
  assert.deepEqual(JSON.parse(document.contents[0].text), guide.structuredContent);
  const context = await request("tools/call", { name: "analysis_context", arguments: {} });
  const granted = policy.operations.includes("analysis_context") && policy.disclosures.includes("agent_metadata");
  if (granted) {
    assert.ok(!context.isError);
    const data = context.structuredContent;
    assert.equal(data.schema, "loci.agent-context/v1");
    assert.equal(data.pagination.source_grants_count, policy.sources.length);
    const grants = new Map(policy.sources.map((item) => [item.id, item.sha256]));
    for (const source of data.source_grants) {
      assert.equal(source.source_sha256, grants.get(source.source_id));
      if (!policy.disclosures.includes("source_names")) assert.ok(!("name" in source));
      if (!policy.disclosures.includes("geometry")) assert.ok(!("permitted_scope" in source));
    }
    assert.ok(!JSON.stringify(data).includes(policy.project.path), "Context leaked the study locator");
    const resource = await request("resources/read", { uri: "loci://context" });
    assert.deepEqual(JSON.parse(resource.contents[0].text), data);
    const invalid = await request("tools/call", { name: "analysis_context", arguments: { limit: 51 } });
    assert.equal(invalid.isError, true);
  } else {
    assert.equal(context.isError, true, "Context must require both explicit grants");
  }
  const expectedError = granted
    ? "The research operation failed validation or execution. Inspect the source and settings in Loci."
    : "The operation, source scope, disclosure or resource limit is not authorized by the active policy.";
  const expectedDiagnostic = `Tool 'analysis_context' failed: 'Error executing tool analysis_context: ${expectedError}'`;
  assert.ok(["", expectedDiagnostic].includes(diagnostics.trim()),
    "Only the single intentionally triggered, sanitized tool error may reach diagnostics");
  await writeFile(receiptPath, JSON.stringify({
    schema: "loci.independent-mcp-qa/v1", status: "passed", started_at: startedAt,
    completed_at: new Date().toISOString(), protocol: initialized.protocolVersion,
    engine_sha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
    tool_count: listed.tools.length, resources: resources.resources.map((item) => item.uri),
    context: granted ? "exact-grants-and-disclosure-filtering-passed" : "denied-as-required",
    guide_tool_resource_parity: true, diagnostic_bytes: diagnosticBytes,
    diagnostics: "only-expected-sanitized-error",
    client: "independent Node.js stdio JSON-RPC client",
  }, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(receiptPath + "\n");
} finally {
  lines.close();
  child.stdin.end();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => { child.kill(); resolve(); }, 2_000)),
  ]);
}
