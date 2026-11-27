// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createHash, webcrypto } from "node:crypto";
import type { ResearchAgentApprovalRecord } from "../shared/research-contracts";
import wire from "./__fixtures__/agent-sessions-snapshot.json";
import { waitFor, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPreviewComparison, type SharedTaskPreview } from "./AgentPreviewComparison";

afterEach(cleanup);
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=";
const selection = { x: 1, y: 2, width: 10, height: 12, t: 0, c: 1, z: 2, level: 0 };
const sourceId = "a".repeat(32);
const sourceHash = "b".repeat(64);
const output = () => ({ image: png, object_count: 12, adopted: false,
  workflow: { id: "workflow-one", revision: 3, definition_sha256: "f".repeat(64) }, target_node_id: "process-2",
  provenance: { selection: { ...selection }, recipe: { steps: [{ operation: "gaussian", sigma: 1 }] }, recipe_sha256: "e".repeat(64) } });
const preview = (overrides: Partial<SharedTaskPreview> = {}): SharedTaskPreview => ({
  schema: "loci.task-preview/v1", job_id: "c".repeat(32), operation: "workflow_preview", request_sha256: "d".repeat(64),
  source_id: sourceId, source_sha256: sourceHash, created_at: "2026-10-27T01:02:03Z", adopted: false,
  output_sha256: "e".repeat(64), output: output(), ...overrides,
});

describe("AgentPreviewComparison", () => {
  it("requires the exact painted overlay and a fresh inspection for each pending request", async () => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const digest = createHash("sha256").update(Buffer.from(png.split(",")[1], "base64")).digest("hex");
      const receipt = { schema: "loci.model-preview/v1", id: "preview-a", preview_sha256: "7".repeat(64),
        source: { id: sourceId, sha256: sourceHash, selection: { x: 7, y: 11, width: 696, height: 520, z: 2, t: 4, level: 0 },
          channel_mapping: [{source_channel: 3}], display: { png_sha256: digest } }, output: { object_count: 66 } };
      const model = preview({ operation: "model_preview", output: { adopted: false, overlay_png: png, preview: receipt } });
      const approval = { ...wire.approvals[0], operation: "submit_action", action_name: "model_run", state: "pending",
        source_id: sourceId, source_sha256: sourceHash, expires_at: new Date(Date.now() + 60000).toISOString(),
        parameters_summary: { preview_job_id: model.job_id, preview_id: receipt.id, preview_sha256: receipt.preview_sha256 } } as ResearchAgentApprovalRecord;
      const onDecision = vi.fn().mockResolvedValue(undefined);
      const props = { preview: model, approval, onDecision, sourceLabel: "Source", onClose: vi.fn() };
      const view = render(<AgentPreviewComparison {...props} />);
      const check = () => screen.getByRole("checkbox", { name: "I inspected this model preview" });
      const allow = () => screen.getByRole("button", { name: "Approve submit_action" });
      const image = await screen.findByRole("img", { name: "Source with predicted model labels" });
      expect(screen.getByText("66 predicted objects · green outlines")).toBeVisible();
      expect(screen.getByText("696 × 520 px at (7, 11) · Input C 3 · Z 2 · T 4 (zero-based)")).toBeVisible();
      expect(check()).toBeDisabled();
      Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 1 }, naturalHeight: { value: 1 } });
      vi.spyOn(image, "getBoundingClientRect").mockReturnValue({ width: 48, height: 48 } as DOMRect);
      fireEvent.load(image);
      await waitFor(() => expect(check()).toBeEnabled());
      expect(allow()).toBeDisabled();
      fireEvent.click(check());
      fireEvent.click(allow());
      expect(onDecision).toHaveBeenCalledExactlyOnceWith({ action: "approve_request", approval_id: approval.id,
        inspected_preview: { preview_id: receipt.id, preview_sha256: receipt.preview_sha256, preview_job_id: model.job_id } });
      view.rerender(<AgentPreviewComparison {...props} approval={{ ...approval, id: "another-request" }} />);
      expect(check()).not.toBeChecked();
      expect(allow()).toBeDisabled();
      view.rerender(<AgentPreviewComparison {...props} preview={{ ...model, output_sha256: "8".repeat(64),
        output: { ...model.output, preview: { ...receipt, source: { ...receipt.source, channel_mapping: [] } } } }} />);
      expect(screen.getByText(/source region or model input channel could not be verified/)).toBeVisible();
      expect(check()).toBeDisabled();
      view.rerender(<AgentPreviewComparison {...props} preview={{ ...model, output_sha256: "9".repeat(64),
        output: { ...model.output, preview: { ...receipt, source: { ...receipt.source, display: { png_sha256: sourceHash } } } } }} />);
      await screen.findByText("The exact source-bound model preview is unavailable.");
      expect(screen.queryByRole("img")).toBeNull();
      expect(check()).toBeDisabled();
      expect(screen.getByRole("button", { name: "Deny submit_action" })).toBeEnabled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("compares two exact previews while keeping a pinned reference immutable", () => {
    const first = preview();
    const { rerender } = render(<AgentPreviewComparison preview={first} sourceLabel="Source" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin current preview" }));
    expect(screen.getByText(/Reference pinned. Open another preview/)).toBeVisible();
    first.output.object_count = 999;
    const second = preview({ job_id: "f".repeat(32), output_sha256: "1".repeat(64), output: { ...output(), object_count: 19 } });
    rerender(<AgentPreviewComparison preview={second} sourceLabel="Source" onClose={vi.fn()} />);
    const reference = screen.getByRole("region", { name: "Pinned reference" });
    const current = screen.getByRole("region", { name: "Current preview" });
    expect(within(reference).getByText("12")).toBeVisible();
    expect(within(current).getByText("19")).toBeVisible();
    expect(screen.queryByText("999")).not.toBeInTheDocument();
    expect(screen.getByText("Same recorded source and selection. Preview settings may differ.")).toBeVisible();
    fireEvent.click(within(reference).getByText("Exact preview identity and settings"));
    expect(within(reference).getByText(first.job_id)).toBeVisible();
    expect(within(reference).getByText("workflow-one")).toBeVisible();
    expect(within(reference).getByText("process-2")).toBeVisible();
    expect(within(reference).getByText(sourceHash)).toBeVisible();
    expect(screen.queryByRole("button", { name: /adopt|save|approve/i })).not.toBeInTheDocument();
  });

  it.each(["id", "hash"])("resets the reference when the source %s changes", (field) => {
    const { rerender } = render(<AgentPreviewComparison preview={preview()} sourceLabel="Source" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin current preview" }));
    const next = preview(field === "id" ? { source_id: "other-source" } : { source_sha256: "1".repeat(64) });
    rerender(<AgentPreviewComparison preview={next} sourceLabel="Different source" onClose={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Pinned reference" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin current preview" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear pinned reference" })).not.toBeInTheDocument();
  });

  it.each(["https://example.com/private.png", "data:image/svg+xml,<svg/>", "data:image/png;base64,invalid", "data:image/png;base64,iVBORw0KGgo="])("refuses malformed or remote image data: %s", (image) => {
    render(<AgentPreviewComparison preview={preview({ output: { ...output(), image, label_image: "https://example.com/labels.png" } })} sourceLabel="Source" onClose={vi.fn()} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin current preview" })).toBeDisabled();
    expect(screen.getAllByText(/valid PNG preview data was not provided/)).toHaveLength(2);
  });

  it("shows unavailable after a PNG decoding error without rerunning", () => {
    render(<AgentPreviewComparison preview={preview()} sourceLabel="Source" onClose={vi.fn()} />);
    fireEvent.error(screen.getByRole("img", { name: "Current preview image" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/valid PNG preview data was not provided/)).toBeVisible();
  });

  it("selects bounded multi-cell output and labels different scopes explicitly", () => {
    const cell = (index: number) => ({ image: png, label_image: png, region_index: index, configuration_index: index,
      object_count: index + 1, receipt: { selection: { ...selection, x: index * 20 },
        effective_recipe: { segmentation: { threshold: 100 + index } }, receipt_sha256: "9".repeat(64) },
      size_summary: { measure_kind: "area", measure_unit: "um^2", mean: index + 2, total: 10, border_object_count: 0 } });
    render(<AgentPreviewComparison preview={preview({ operation: "exploration_compare", output: { adopted: false, cells: [cell(0), cell(1)] } })} sourceLabel="Source" onClose={vi.fn()} />);
    expect(screen.getAllByRole("img")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Pin current preview" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Preview cell" }), { target: { value: "1" } });
    expect(screen.getAllByRole("img")).toHaveLength(4);
    expect(screen.getByText(/Distinct scopes · these previews use different recorded selections/)).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Current preview" })).getByText("mean area (um^2)")).toBeVisible();
  });

  it("rejects oversized or malformed comparison cells without rendering images", () => {
    const { rerender } = render(<AgentPreviewComparison preview={preview({ output: { cells: Array(33).fill({ image: png }) } })} sourceLabel="Source" onClose={vi.fn()} />);
    expect(screen.getByText(/Preview unavailable · the recorded output is missing or unsupported/)).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    rerender(<AgentPreviewComparison preview={preview({ output: { cells: [null] } })} sourceLabel="Source" onClose={vi.fn()} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("supports focusable pin controls, close and Escape without propagating stage shortcuts", () => {
    const onClose = vi.fn();
    const onStageKey = vi.fn();
    render(<div onKeyDown={onStageKey}><AgentPreviewComparison preview={preview()} sourceLabel="Source" onClose={onClose} /></div>);
    expect(screen.getByRole("button", { name: "Close preview comparison" })).toHaveFocus();
    const pin = screen.getByRole("button", { name: "Pin current preview" });
    pin.focus();
    expect(pin).toHaveFocus();
    fireEvent.click(pin);
    const clear = screen.getByRole("button", { name: "Clear pinned reference" });
    clear.focus();
    fireEvent.keyDown(clear, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onStageKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close preview comparison" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders nothing when closed and clears a pinned preview before reopening", () => {
    const { rerender, container } = render(<AgentPreviewComparison preview={preview()} sourceLabel="Source" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin current preview" }));
    rerender(<AgentPreviewComparison preview={null} sourceLabel="Source" onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AgentPreviewComparison preview={preview()} sourceLabel="Source" onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Pin current preview" })).toBeVisible();
  });
});
