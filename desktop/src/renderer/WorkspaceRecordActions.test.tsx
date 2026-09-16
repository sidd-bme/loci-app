// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchResult, ResearchSnapshot, ResearchSource, ResearchWorkspaceChange } from "../shared/research-contracts";
import { WorkspaceRecordActions } from "./WorkspaceRecordActions";

afterEach(cleanup);
const source: ResearchSource = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Source.tif", metadata: {} };
const result = { id: "c".repeat(32), source_id: source.id, revision_hash: "d".repeat(64), kind: "segmentation", object_count: 36 } as ResearchResult;
const initial: ResearchSnapshot = { project: { title: "Study" }, sources: [source], results: [result],
  samples: [], recipes: [], displays: [], selections: [], jobs: [], operations: {},
  workspace: { revision: 0, closed_sources: [], hidden_results: [] } };
function mount(busy = false) {
  const onError = vi.fn(), onBusy = vi.fn(), onChange = vi.fn();
  const api = { updateWorkspace: vi.fn(async (request: ResearchWorkspaceChange) => {
    const closed = request.sources.some((item) => !item.visible);
    const hidden = request.results.some((item) => !item.visible);
    return { ...initial, sources: closed ? [] : [source], results: closed || hidden ? [] : [result],
      workspace: { revision: request.expected_revision + 1, closed_sources: closed ? [source] : [], hidden_results: hidden ? [result] : [] } };
  }) };
  const props = { api, snapshot: initial, source, busy, onBusy, onChange, onError };
  const view = render(<WorkspaceRecordActions {...props} />);
  fireEvent.click(screen.getByText("Manage images & results"));
  return { ...view, props, api, onChange, onError, onBusy };
}
describe("durable working list actions", () => {
  it("clears exact results and undo restores only those exact bindings", async () => {
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Clear image results" }));
    await waitFor(() => expect(view.onChange).toHaveBeenCalledTimes(1));
    expect(view.api.updateWorkspace).toHaveBeenCalledWith({ expected_revision: 0, sources: [],
      results: [{ id: result.id, revision_hash: result.revision_hash, visible: false }] });
    const next = view.onChange.mock.calls[0][0];
    view.rerender(<WorkspaceRecordActions {...view.props} snapshot={next} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(view.onChange).toHaveBeenCalledTimes(2));
    expect(view.api.updateWorkspace).toHaveBeenLastCalledWith({ expected_revision: 1, sources: [],
      results: [{ id: result.id, revision_hash: result.revision_hash, visible: true }] });
    expect(view.onError).not.toHaveBeenCalled();
  });
  it("closes and restores an image without requesting filesystem deletion", async () => {
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Close image" }));
    await waitFor(() => expect(view.onChange).toHaveBeenCalledTimes(1));
    expect(view.api.updateWorkspace).toHaveBeenCalledWith({ expected_revision: 0, results: [],
      sources: [{ id: source.id, sha256: source.sha256, visible: false }] });
    view.rerender(<WorkspaceRecordActions {...view.props} source={null} snapshot={view.onChange.mock.calls[0][0]} />);
    fireEvent.click(screen.getByRole("button", { name: `Reopen ${source.name}` }));
    await waitFor(() => expect(view.onChange).toHaveBeenCalledTimes(2));
    expect(view.api.updateWorkspace).toHaveBeenLastCalledWith({ expected_revision: 1, results: [],
      sources: [{ id: source.id, sha256: source.sha256, visible: true }] });
  });
  it("blocks actions while a job is busy and retains the old working list on failure", async () => {
    const view = mount(true);
    fireEvent.click(screen.getByRole("button", { name: "Close image" }));
    expect(view.api.updateWorkspace).not.toHaveBeenCalled();
    view.rerender(<WorkspaceRecordActions {...view.props} busy={false} />);
    view.api.updateWorkspace.mockRejectedValueOnce(new Error("Workspace changed"));
    fireEvent.click(screen.getByRole("button", { name: "Clear image results" }));
    await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Workspace changed"));
    expect(view.onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(view.onBusy).toHaveBeenLastCalledWith(null);
  });
});
