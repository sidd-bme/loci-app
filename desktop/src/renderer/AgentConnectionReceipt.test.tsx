// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ResearchAgentAccessReceipt, ResearchAgentSessionsSnapshot } from "../shared/research-contracts";
import { AgentConnectionReceipt } from "./AgentConnectionReceipt";
import sessionFixture from "./__fixtures__/agent-sessions-snapshot.json";

afterEach(cleanup);

const codex: ResearchAgentAccessReceipt = {
  schema: "loci.agent-policy/v5",
  policy_sha256: "a".repeat(64),
  project_id: "b".repeat(32),
  recipe_sha256: "c".repeat(64),
  source_id: "d".repeat(32),
  selection: { x: 0, y: 0, width: 8, height: 8, t: 0, c: 0, z: 0, level: 0 },
  policy_filename: "agent-policy.json",
  config_filename: "mcp-config.json",
  codex_workspace: "codex-workspace",
  codex_config_filename: "codex-workspace/.codex/config.toml",
  disclosures: [],
  operations: ["inspect_source"],
};

it("offers the native Codex handoff after discovery and leaves connection status to the journal", async () => {
  const probe = vi.fn().mockResolvedValue(true);
  let complete!: (opened: boolean) => void;
  const open = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
  render(<AgentConnectionReceipt receipt={codex} client="codex" onCanOpenHost={probe} onOpenHost={open} />);
  const button = await screen.findByRole("button", { name: "Open in Codex" });
  expect(probe).toHaveBeenCalledExactlyOnceWith(codex.policy_sha256);
  fireEvent.click(button);
  expect(open).toHaveBeenCalledExactlyOnceWith(codex.policy_sha256);
  expect(screen.getByRole("button", { name: "Opening Codex…" })).toBeDisabled();
  complete(true);
  await screen.findByText(/Continue in Codex/);
  expect(screen.getByRole("heading")).toHaveTextContent("Waiting for your assistant");
});

it("offers manual handoff when Codex disappears between discovery and dispatch", async () => {
  const probe = vi.fn().mockResolvedValue(true);
  const open = vi.fn().mockResolvedValue(false);
  const copy = vi.fn().mockResolvedValue(undefined);
  render(<AgentConnectionReceipt receipt={codex} client="codex" onCanOpenHost={probe} onOpenHost={open}
    onCopyWorkspacePath={copy} onReveal={vi.fn()} onCopyLaunch={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open in Codex" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Codex desktop is unavailable");
  expect(screen.queryByRole("button", { name: "Open in Codex" })).toBeNull();
  expect(screen.getByRole("button", { name: "Show setup folder" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Copy terminal command" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Copy workspace path" }));
  expect(copy).toHaveBeenCalledExactlyOnceWith(codex.policy_sha256);
  await screen.findByRole("button", { name: "Workspace path copied" });
});

it("guides Antigravity through its project picker and hides handoff actions after revocation", () => {
  const receipt: ResearchAgentAccessReceipt = { ...codex, codex_workspace: undefined, codex_config_filename: undefined,
    antigravity_workspace: "antigravity-workspace", antigravity_config_filename: "antigravity-workspace/.agents/mcp_config.json" };
  const scope = sessionFixture as unknown as ResearchAgentSessionsSnapshot;
  const probe = vi.fn();
  const props = { receipt, client: "antigravity", onCanOpenHost: probe, onOpenHost: vi.fn(), onCopyWorkspacePath: vi.fn() };
  const { rerender } = render(<AgentConnectionReceipt {...props} />);
  expect(screen.getByText("New Project → Add Folder")).toBeVisible();
  expect(screen.getByRole("button", { name: "Copy workspace path" })).toBeVisible();
  expect(probe).not.toHaveBeenCalled();
  rerender(<AgentConnectionReceipt {...props} sessions={{ ...scope, policies: [{ ...scope.policies[0],
    project_id: receipt.project_id, policy_sha256: receipt.policy_sha256, revoked: true }] }} />);
  expect(screen.getByRole("heading")).toHaveTextContent("Access revoked");
  expect(screen.queryByRole("button", { name: "Copy workspace path" })).toBeNull();
});
