// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchAgentSessionsSnapshot,
  ResearchDesktopApi,
  ResearchSnapshot,
} from "../shared/research-contracts";
import { AgentSessionIndicator } from "./AgentSessionIndicator";
import engineFixture from "./__fixtures__/agent-sessions-snapshot.json";

// Captured from test_agent_sessions.session_fixture and the real snapshot boundary.
// The engine contract test verifies these record keys against fresh runtime output.
const wire = engineFixture as ResearchAgentSessionsSnapshot;

afterEach(cleanup);

function makeSnapshot(
  agentSessions: Partial<ResearchAgentSessionsSnapshot>,
): ResearchSnapshot {
  return {
    project: { title: "Study", project_id: "e".repeat(32) },
    sources: [
      {
        id: "a".repeat(32),
        name: "Fluorescence nuclei",
        sha256: "b".repeat(64),
        metadata: { dimensions: { t: 1, c: 2, z: 1, y: 32, x: 32 } },
      },
    ],
    results: [],
    samples: [],
    recipes: [],
    displays: [],
    selections: [],
    jobs: [
      {
        id: "9".repeat(32),
        operation: "run_recipe",
        request: {},
        request_key: "key-1",
        request_hash: "8".repeat(64),
        state: "running",
        created_at: "2026-10-25T10:00:00Z",
        updated_at: "2026-10-25T10:00:00Z",
        progress: 0.5,
        cancel_requested: false,
        result_ids: [],
        error: null,
      },
    ],
    operations: {},
    agent_sessions: {
      schema: "loci.agent-sessions/v1",
      status: "configuration_ready",
      connected_count: 0,
      pending_approval_count: 0,
      policies: [
        {
          ...wire.policies[0],
          policy_sha256: "d".repeat(64),
          project_id: "e".repeat(32),
          schema: "loci.agent-policy/v5",
          permission_mode: "ask_approval",
          created_at: "2026-10-25T10:00:00Z",
          updated_at: "2026-10-25T10:00:00Z",
          revoked: false,
          bundle_name: "Loci agent access",
          client_id: "codex",

          operations: ["inspect_source", "submit_recipe"],
          actions: [],
          disclosures: ["geometry", "measurements", "previews"],
          source_ids: ["a".repeat(32)],
          state: "configuration_ready",
        },
      ],
      sessions: [],
      approvals: [],
      events: [],
      capability_map: wire.capability_map,
      ...agentSessions,
    },
  };
}

function makeApi(
  controlAgentSession: NonNullable<ResearchDesktopApi["controlAgentSession"]> = vi.fn(),
): ResearchDesktopApi {
  return {
    createStudy: vi.fn(),
    openStudy: vi.fn(),
    getSnapshot: vi.fn(),
    addSources: vi.fn(),
    execute: vi.fn(),
    controlAgentSession,
    reviewResult: vi.fn(),
    exportResult: vi.fn(),
    cancelJob: vi.fn(),
  };
}

describe("AgentSessionIndicator", () => {
  it("renders a real engine snapshot, its approval target, event log and capability map", async () => {
    const control = vi.fn().mockResolvedValue(null);
    render(<AgentSessionIndicator api={makeApi(control)} snapshot={makeSnapshot(wire)}
      followAgent={false} onFollowAgentChange={vi.fn()} onSnapshot={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Agent session status" }));
    expect(screen.getByText("1 connected session")).toBeVisible();
    expect(screen.getByText(wire.approvals[0].summary)).toBeVisible();
    expect(screen.getByText(`${wire.approvals[0].result_id!.slice(0, 8)} · rev ${wire.approvals[0].revision_hash!.slice(0, 8)}`)).toBeVisible();
    fireEvent.click(screen.getByLabelText("Approve review_result"));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ action: "approve_request", approval_id: wire.approvals[0].id }));
    expect(screen.getByText(wire.events[0].summary)).toBeInTheDocument();
    expect(screen.getByText(wire.capability_map.entries[0].summary)).toBeInTheDocument();
  });

  it("never displays a generated bundle as a connected client", () => {
    const snapshot = makeSnapshot({
      status: "configuration_ready",
      connected_count: 0,
    });
    render(
      <AgentSessionIndicator
        api={makeApi()}
        snapshot={snapshot}
        followAgent={false}
        onFollowAgentChange={vi.fn()}
        onSnapshot={vi.fn()}
        onError={vi.fn()}
      />,
    );
    const pill = screen.getByRole("button", { name: "Agent session status" });
    expect(pill).toHaveTextContent("Agent bundle ready · Not connected");
    fireEvent.click(pill);
    expect(
      screen.getByText("No MCP client is currently connected."),
    ).toBeVisible();
    expect(screen.getByText("codex (not connected)")).toBeVisible();
    expect(screen.queryByText("Stop active job")).not.toBeInTheDocument();
  });

  it("handles live approval decisions, permission mode switching, and session controls", async () => {
    const approvalId = "1".repeat(32);
    const sessionId = "2".repeat(32);
    const policyHash = "d".repeat(64);
    const snapshot = makeSnapshot({
      status: "awaiting_approval",
      connected_count: 1,
      pending_approval_count: 1,
      policies: [
        {
          ...wire.policies[0],
          policy_sha256: policyHash,
          project_id: "e".repeat(32),
          schema: "loci.agent-policy/v5",
          permission_mode: "ask_approval",
          created_at: "2026-10-25T10:00:00Z",
          updated_at: "2026-10-25T10:00:00Z",
          revoked: false,
          bundle_name: "Loci agent access",
          client_id: "codex",

          operations: ["inspect_source", "submit_recipe"],
          actions: ["correct_result"],
          disclosures: ["geometry", "measurements", "previews"],
          source_ids: ["a".repeat(32)],
          state: "awaiting_approval",
        },
      ],
      sessions: [
        {
          ...wire.sessions[0],
          session_id: sessionId,
          policy_sha256: policyHash,
          project_id: "e".repeat(32),

          client_id: "codex-cli",
          client_version: "1.0.0",
          permission_mode: "ask_approval",
          state: "awaiting_approval",
          current_operation: "submit_recipe",
          active_job_id: "9".repeat(32),
          last_error: null,
          started_at: "2026-10-25T10:00:00Z",
          last_heartbeat_at: "2026-10-25T10:00:05Z",
          ended_at: null,
        },
      ],
      approvals: [
        {
          ...wire.approvals[0],
          id: approvalId,
          session_id: sessionId,
          policy_sha256: policyHash,
          project_id: "e".repeat(32),
          operation: "submit_recipe",
          action_name: "submit_recipe",
          request_hash: "7".repeat(64),
          source_id: "a".repeat(32),
          source_sha256: "b".repeat(64),
          result_id: null,
          revision_hash: null,
          display_revision: null,
          destination_name: null,
          summary: "Run classical segmentation on Fluorescence nuclei",
          parameters_summary: { threshold: 12 },
          state: "pending",
          decided_by: null,
          decision_reason: null,
          created_at: "2026-10-25T10:00:02Z",
          decided_at: null,
          consumed_at: null,
          expires_at: "2026-10-25T10:15:02Z",
        },
      ],
    });
    snapshot.jobs[0].owner = { policy_sha256: policyHash, session_id: sessionId };
    const controlAgentSession = vi.fn().mockResolvedValue(snapshot);
    const onSnapshot = vi.fn();
    const onFollowAgentChange = vi.fn();
    render(
      <AgentSessionIndicator
        api={makeApi(controlAgentSession)}
        snapshot={snapshot}
        followAgent={false}
        onFollowAgentChange={onFollowAgentChange}
        onSnapshot={onSnapshot}
        onError={vi.fn()}
      />,
    );

    const pill = screen.getByRole("button", { name: "Agent session status" });
    expect(pill).toHaveTextContent("Approval needed (1)");
    fireEvent.click(pill);

    expect(
      screen.getByText("Run classical segmentation on Fluorescence nuclei"),
    ).toBeVisible();
    expect(screen.getByText("codex-cli 1.0.0")).toBeVisible();
    expect(screen.queryByText("Process")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Approve submit_recipe"));
    await waitFor(() =>
      expect(controlAgentSession).toHaveBeenCalledWith({
        action: "approve_request",
        approval_id: approvalId,
      }),
    );

    fireEvent.change(screen.getByLabelText("Agent permission mode"), {
      target: { value: "full_access" },
    });
    await waitFor(() =>
      expect(controlAgentSession).toHaveBeenCalledWith({
        action: "set_permission_mode",
        policy_sha256: policyHash,
        permission_mode: "full_access",
      }),
    );

    fireEvent.click(screen.getByText("Pause access"));
    await waitFor(() =>
      expect(controlAgentSession).toHaveBeenCalledWith({
        action: "pause_session",
        policy_sha256: policyHash,
      }),
    );

    fireEvent.click(screen.getByText("Stop active job"));
    await waitFor(() =>
      expect(controlAgentSession).toHaveBeenCalledWith({
        action: "stop_job",
        session_id: sessionId,
        job_id: "9".repeat(32),
      }),
    );

    fireEvent.click(screen.getByLabelText("Follow agent"));
    expect(onFollowAgentChange).toHaveBeenCalledWith(true);
  });

  it("dismisses from the keyboard and restores focus to the status control", () => {
    render(<AgentSessionIndicator api={makeApi()} snapshot={makeSnapshot({})}
      followAgent={false} onFollowAgentChange={vi.fn()} onSnapshot={vi.fn()} onError={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Agent session status" });
    fireEvent.click(trigger);
    const close = screen.getByRole("button", { name: "Close agent session drawer" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByLabelText("Agent session and approvals")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("marks stale connection state unavailable when refresh fails", () => {
    render(<AgentSessionIndicator api={makeApi()} snapshot={makeSnapshot({ status: "connected_idle", connected_count: 1 })}
      refreshError="Worker is unavailable. Retrying automatically." followAgent={false}
      onFollowAgentChange={vi.fn()} onSnapshot={vi.fn()} onError={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Agent session status" });
    expect(trigger).toHaveTextContent("Agent status unavailable");
    expect(trigger).not.toHaveTextContent("connected · Idle");
    fireEvent.click(trigger);
    expect(screen.getByRole("alert")).toHaveTextContent("last received state");
  });

  it("never offers a human or another policy's job as this session's active job", () => {
    const snapshot = makeSnapshot({ status: "connected_idle", connected_count: 1,
      sessions: [{ ...wire.sessions[0], session_id: "2".repeat(32), policy_sha256: "d".repeat(64), project_id: "e".repeat(32),
         client_id: "codex", client_version: null, permission_mode: "full_access", state: "connected_idle",
        current_operation: null, active_job_id: "9".repeat(32), last_error: null,
        started_at: "2026-10-25T10:00:00Z", last_heartbeat_at: "2026-10-25T10:00:00Z", ended_at: null }],
    });
    snapshot.jobs.push({ ...snapshot.jobs[0], id: "8".repeat(32),
      owner: { policy_sha256: "f".repeat(64), session_id: "3".repeat(32) } });
    render(<AgentSessionIndicator api={makeApi()} snapshot={snapshot} followAgent={false}
      onFollowAgentChange={vi.fn()} onSnapshot={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Agent session status" }));
    expect(screen.queryByText("Stop active job")).not.toBeInTheDocument();
  });
});
