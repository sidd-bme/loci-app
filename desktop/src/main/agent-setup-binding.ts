import { createHash } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";

type WorkspaceClient = "codex" | "antigravity";
const workspaceLayouts = {
  codex: { name: "codex-workspace", configDirectory: ".codex", config: "config.toml" },
  antigravity: { name: "antigravity-workspace", configDirectory: ".agents", config: "mcp_config.json" },
} as const;

interface DirectoryBinding {
  path: string;
  dev: number;
  ino: number;
}

interface AgentWorkspaceBinding {
  client: WorkspaceClient;
  directory: DirectoryBinding;
  configDirectory: DirectoryBinding;
  configSha256: string;
}

export interface AgentSetupBinding {
  folder: DirectoryBinding;
  policy: string;
  project: string;
  projectId: string;
  workspace?: AgentWorkspaceBinding;
}

export interface PublishedAgentSetupReceipt {
  policy_sha256: string;
  project_id: string;
  codex_workspace?: string;
  codex_config_filename?: string;
  antigravity_workspace?: string;
  antigravity_config_filename?: string;
  workspace_config_sha256?: string;
}

const sameIdentity = (a: Pick<Stats, "dev" | "ino">, b: Pick<Stats, "dev" | "ino">) =>
  a.dev === b.dev && a.ino === b.ino;

async function bindDirectory(directory: string): Promise<DirectoryBinding> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory()) throw new Error("The setup folder moved or changed.");
  return { path: directory, dev: stat.dev, ino: stat.ino };
}

async function checkDirectory(expected: DirectoryBinding) {
  const current = await bindDirectory(expected.path);
  if (!sameIdentity(expected, current)) throw new Error("The setup folder moved or changed.");
}

/** Paths and the expected hashes come only from the native picker and the trusted worker. */
export async function bindAgentSetup(folder: string, project: string, client: unknown, receipt: PublishedAgentSetupReceipt): Promise<AgentSetupBinding> {
  if (!/^[a-f0-9]{64}$/u.test(receipt.policy_sha256) || !/^[a-f0-9]{32}$/u.test(receipt.project_id))
    throw new Error("The setup receipt is invalid.");
  const selected = await bindDirectory(folder);
  const root = await fs.realpath(folder);
  const binding = { folder: { ...selected, path: root }, project, projectId: receipt.project_id, policy: receipt.policy_sha256 };
  await checkDirectory(binding.folder);
  if (client !== "codex" && client !== "antigravity") return binding;
  const layout = workspaceLayouts[client];
  const other = client === "codex" ? "antigravity" : "codex";
  const configSha256 = receipt.workspace_config_sha256;
  if (receipt[`${client}_workspace`] !== layout.name || receipt[`${other}_workspace`] !== undefined ||
      receipt[`${client}_config_filename`] !== `${layout.name}/${layout.configDirectory}/${layout.config}` ||
      typeof configSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(configSha256))
    throw new Error("The setup receipt does not match the selected assistant.");
  const directory = await bindDirectory(path.join(root, layout.name));
  const configDirectory = await bindDirectory(path.join(directory.path, layout.configDirectory));
  return { ...binding, workspace: { client, directory, configDirectory, configSha256 } };
}

async function checkSetupFile(filename: string, sha256: string) {
  const maxBytes = 1024 * 1024;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fail = () => new Error("The assistant setup files changed. Create a new grant to reconnect.");
  const plainPrivateFile = (stat: Stats) => stat.isFile() && stat.nlink === 1 && stat.size <= maxBytes &&
    (process.platform === "win32" || (stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600));
  const initial = await fs.lstat(filename);
  if (!plainPrivateFile(initial)) throw fail();
  const file = await fs.open(filename, flags);
  try {
    const opened = await file.stat();
    if (!sameIdentity(initial, opened) || !plainPrivateFile(opened) || opened.size !== initial.size)
      throw fail();
    const hash = createHash("sha256");
    for await (const data of file.createReadStream({ autoClose: false, start: 0, end: opened.size })) hash.update(data);
    const current = await fs.lstat(filename);
    if (!sameIdentity(opened, current) || !plainPrivateFile(current) || current.size !== opened.size ||
        current.ctimeMs !== opened.ctimeMs || hash.digest("hex") !== sha256)
      throw fail();
  } finally { await file.close(); }
}

export async function checkAgentSetup(setup: AgentSetupBinding, verifyFiles: boolean): Promise<string> {
  try {
    const { folder, workspace } = setup;
    await checkDirectory(folder);
    if (workspace) await checkDirectory(workspace.directory);
    if (verifyFiles && workspace) {
      await checkDirectory(workspace.configDirectory);
      await checkSetupFile(path.join(folder.path, "agent-policy.json"), setup.policy);
      await checkSetupFile(path.join(workspace.configDirectory.path, workspaceLayouts[workspace.client].config), workspace.configSha256);
      await checkDirectory(workspace.configDirectory);
      await checkDirectory(workspace.directory);
      await checkDirectory(folder);
    }
    return workspace?.directory.path ?? folder.path;
  } catch {
    throw new Error("The setup folder or its files moved or changed. Create a new grant to reconnect.");
  }
}
