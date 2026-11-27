// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchAgentSessionsSnapshot, ResearchSnapshot } from "../shared/research-contracts";
import { AgentWorkspaceSurface, EMPTY_AGENT_PRESENTATION, type AgentWorkspacePresentation } from "./AgentWorkspaceSurface";
import engineFixture from "./__fixtures__/agent-sessions-snapshot.json";

afterEach(cleanup);
const wire = engineFixture as ResearchAgentSessionsSnapshot;
function snapshot(): ResearchSnapshot {
  return { project: { project_id: "e".repeat(32), title: "Shared study" }, sources: [], results: [], samples: [],
    recipes: [], displays: [], selections: [], jobs: [], operations: {}, agent_sessions: structuredClone(wire) };
}
const base = { followAgent: false, onFollowAgentChange: vi.fn(), onError: vi.fn() };

describe("Shared agent workspace surface", () => {
  it("provides an empty setup entry without claiming a connection or issuing a command", () => {
    const value = snapshot(); delete value.agent_sessions;
    const configure = vi.fn(), control = vi.fn();
    render(<AgentWorkspaceSurface {...base} snapshot={value} onConfigureAccess={configure} onControl={control} host="detached" />);
    expect(screen.getByRole("heading", { name: "Agent workspace" })).toBeVisible();
    expect(screen.getByText("Shared study")).toBeVisible();
    expect(screen.getByText("No active agent")).toBeVisible();
    fireEvent.click(within(screen.getByRole("region", { name: "No agent plan" })).getByRole("button", { name: "Connect an assistant" }));
    expect(configure).toHaveBeenCalledOnce();
    expect(control).not.toHaveBeenCalled();
  });

  it("blocks every permission-changing control when the snapshot is stale", () => {
    const control = vi.fn();
    render(<AgentWorkspaceSurface {...base} snapshot={snapshot()} onControl={control} refreshError="Connection to the study is unavailable." />);
    expect(screen.getByRole("button", { name: `Approve ${wire.approvals[0].operation}` })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Follow agent" })).toBeDisabled();
    fireEvent.click(screen.getByText("Connection and permissions"));
    expect(screen.getByRole("combobox", { name: "Agent permission mode" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke access" })).toBeDisabled();
    expect(control).not.toHaveBeenCalled();
  });

  it.each(["docked", "detached"] as const)("keeps the exact pending decision available in any %s section", async (host) => {
    const control = vi.fn().mockResolvedValue(true);
    render(<AgentWorkspaceSurface {...base} snapshot={snapshot()} onControl={control} host={host} />);
    const approvalName = `Approve ${wire.approvals[0].operation}`;
    for (const name of ["Plan & evidence", "Activity", "Approvals", "Overview"]) {
      const section = screen.getByRole("button", { name });
      fireEvent.click(section);
      expect(section).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: approvalName })).toBeVisible();
    }
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    expect(screen.getByRole("heading", { name: "Pending approvals (1)" })).toHaveFocus();
    const approval = screen.getByRole("region", { name: "Pending agent approvals" });
    expect(within(approval).getByText(`${wire.approvals[0].client_id} (declared identity)`, { selector: ".agent-approval-card > dl > dd" })).toBeVisible();
    expect(within(approval).getByText(wire.approvals[0].operation)).toBeVisible();
    expect(within(approval).getByText(/subject to scope and revision checks/)).toBeVisible();
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(within(approval).getByRole("button", { name: `Deny ${wire.approvals[0].operation}` }));
    await waitFor(() => expect(control).toHaveBeenCalledExactlyOnceWith({ action: "deny_request", approval_id: wire.approvals[0].id }));
  });

  it("opens existing permission settings without changing the declared mode or scope", () => {
    const control = vi.fn();
    render(<AgentWorkspaceSurface {...base} snapshot={snapshot()} onControl={control} />);
    expect(screen.getByText(wire.sessions[0].client_id)).toBeVisible();
    const chip = screen.getByRole("button", { name: "Connection and permissions, Ask for approval" });
    fireEvent.click(chip);
    expect(screen.getByText("Connection and permissions")).toHaveFocus();
    expect(screen.getByRole("combobox", { name: "Agent permission mode" })).toHaveValue("ask_approval");
    expect(control).not.toHaveBeenCalled();
  });

  it("expires acknowledgments after the command finishes and retains errors", () => {
    vi.useFakeTimers();
    try {
      const feedback = { kind: "status", message: "Approval decision recorded." } as const;
      const props = { ...base, snapshot: snapshot() };
      const view = render(<AgentWorkspaceSurface {...props} feedback={feedback} commandBusy />);
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.getByText(feedback.message)).toBeVisible();
      view.rerender(<AgentWorkspaceSurface {...props} feedback={feedback} />);
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.queryByText(feedback.message)).not.toBeInTheDocument();
      view.rerender(<AgentWorkspaceSurface {...props} feedback={{ kind: "error", message: "Approval is unavailable." }} />);
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.getByRole("alert")).toHaveTextContent("Approval is unavailable.");
    } finally { vi.useRealTimers(); }
  });

  it("retains unsaved plan edits while changing sections and remounting into another host", async () => {
    const value = snapshot();
    value.agent_sessions!.tasks = [{ id: "task-a", revision: 3, policy_sha256: wire.policies[0].policy_sha256,
      session_id: wire.sessions[0].session_id, client_id: "Codex", created_at: "2026-11-07", updated_at: "2026-11-07", updated_by: "agent",
      goal: "Inspect the source", state: "active", stale: false, targets: [], assessments: [],
      steps: [{ id: "step-a", title: "Inspect source", state: "planned", note: "", targets: [] }] }];
    const control = vi.fn().mockResolvedValue(true);
    function Host() {
      const [presentation, setPresentation] = useState<AgentWorkspacePresentation>(EMPTY_AGENT_PRESENTATION);
      const [detached, setDetached] = useState(false);
      return <><button onClick={() => setDetached(current => !current)}>Move host</button>
        <AgentWorkspaceSurface key={String(detached)} {...base} snapshot={value} onControl={control}
          host={detached ? "detached" : "docked"} presentation={presentation} onPresentationChange={setPresentation} /></>;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "My exact unsaved plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.queryByRole("textbox", { name: "Goal" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move host" }));
    fireEvent.click(screen.getByRole("button", { name: "Plan & evidence" }));
    expect(screen.getByLabelText("Goal")).toHaveValue("My exact unsaved plan");
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect(control).toHaveBeenCalledWith({ action: "edit_task", task_id: "task-a", expected_revision: 3,
      goal: "My exact unsaved plan", steps: [{ id: "step-a", title: "Inspect source" }] });
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit agent plan" })).not.toBeInTheDocument());
  });

  it("reports command rejection without manufacturing approval or execution state", async () => {
    const report = vi.fn(), control = vi.fn().mockRejectedValue(new Error("The request expired."));
    render(<AgentWorkspaceSurface {...base} onError={report} snapshot={snapshot()} onControl={control} />);
    fireEvent.click(screen.getByRole("button", { name: `Approve ${wire.approvals[0].operation}` }));
    await waitFor(() => expect(report).toHaveBeenCalledWith("The request expired."));
    expect(screen.getByRole("button", { name: `Approve ${wire.approvals[0].operation}` })).toBeEnabled();
    expect(screen.getByText("Single-use approval")).toBeVisible();
  });
});
