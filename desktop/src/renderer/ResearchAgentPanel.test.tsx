// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchAgentAccessReceipt,
  ResearchDesktopApi,
  ResearchRecipe,
  ResearchSelection,
  ResearchSnapshot,
  ResearchSource,
} from "../shared/research-contracts";
import { ResearchAgentPanel } from "./ResearchAgentPanel";

afterEach(cleanup);

const source: ResearchSource = {
  id: "a".repeat(32),
  name: "Untrusted source name",
  sha256: "b".repeat(64),
  metadata: { dimensions: { t: 1, c: 2, z: 4, y: 32, x: 32 } },
};
const selection: ResearchSelection = {
  x: 2, y: 3, width: 20, height: 18, t: 0, c: 1, z: 1, z_stop: 3, level: 0,
};
const recipe: ResearchRecipe = {
  steps: [{ op: "subtract_background", sigma: 2, clip_negative: true }],
  segmentation: { method: "components", threshold: 12, polarity: "bright", min_size: 4, exclude_border: false },
  measurement_channels: [0, 1],
  gates: [],
  working_bytes: 512 * 1024 ** 2,
};
const validation = {
  source_id: source.id,
  selection: { c: 1, height: 18, level: 0, t: 0, width: 20, x: 2, y: 3, z: 1, z_stop: 3 },
  recipe_sha256: "c".repeat(64),
  estimated_working_bytes: 123456,
  resolved_device: "cpu",
  scientific_validation: "unvalidated-research-method",
};
const receipt: ResearchAgentAccessReceipt = {
  schema: "loci.agent-policy/v1",
  policy_sha256: "d".repeat(64),
  project_id: "e".repeat(32),
  recipe_sha256: validation.recipe_sha256,
  policy_filename: "agent-policy.json",
  config_filename: "mcp-config.json",
  disclosures: ["measurements", "previews"],
  operations: [
    "cancel_job", "inspect_source", "job_status", "preview_recipe", "result", "result_view",
    "submit_recipe", "validate_recipe",
  ],
  source_id: source.id,
  selection: validation.selection,
};

function bridge(
  execute: ResearchDesktopApi["execute"],
  createAgentAccess: NonNullable<ResearchDesktopApi["createAgentAccess"]> = vi.fn(),
): ResearchDesktopApi {
  return {
    createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(),
    execute, createAgentAccess, reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
  };
}

function renderPanel(
  api: ResearchDesktopApi,
  currentSource = source,
  currentSelection = selection,
  currentRecipe = recipe,
) {
  const props = {
    api, source: currentSource, selection: currentSelection, recipe: currentRecipe,
    report: async <T,>(work: () => Promise<T>) => work(),
    busy: false, onBusyChange: vi.fn(),
  };
  const rendered = render(<ResearchAgentPanel {...props} />);
  fireEvent.click(screen.getByText("Customize permissions"));
  return { ...rendered, props };
}

describe("ResearchAgentPanel", () => {
  it("requires explicit graph access and retains existing native action grants", async () => {
    // Native destination cancellation still exposes the exact requested scope.
    const createAgentAccess = vi.fn().mockResolvedValue(null);
    const api = bridge(vi.fn().mockResolvedValue(validation), createAgentAccess);
    const { props, rerender } = renderPanel(api);
    fireEvent.change(screen.getByLabelText("Assistant access level"), { target: { value: "inspect" } });
    fireEvent.click(screen.getByLabelText("Allow durable recipe runs and result reads"));
    const graph = screen.getByLabelText("Compose reusable workflows from granted actions");
    expect(graph).not.toBeChecked();
    fireEvent.click(graph);
    await waitFor(() => expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    await waitFor(() => expect(createAgentAccess).toHaveBeenCalledWith(expect.objectContaining({
      allow_workflow_graph: true, allow_run: true, actions: [],
      delegation: expect.objectContaining({ result_scope: "granted-sources" }),
    })));
    rerender(<ResearchAgentPanel {...props} source={{ ...source, id: "e".repeat(32) }} />);
    expect(screen.getByLabelText("Compose reusable workflows from granted actions")).not.toBeChecked();
  });
  it("refuses automatic/manual validation and access creation while numeric configuration is unfinished", async () => {
    const execute = vi.fn().mockResolvedValue(validation);
    const createAgentAccess = vi.fn();
    const props = { api: bridge(execute, createAgentAccess), source, selection, recipe,
      report: async <T,>(work: () => Promise<T>) => work(), busy: false, onBusyChange: vi.fn() };
    const { rerender } = render(<ResearchAgentPanel {...props} configurationValid={false} />);
    fireEvent.change(screen.getByLabelText("Assistant access level"), { target: { value: "inspect" } });
    fireEvent.click(screen.getByText("Customize permissions"));
    const validate = screen.getByText("Validate exact scope and recipe");
    expect(validate).toBeDisabled();
    fireEvent.click(validate);
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    expect(execute).not.toHaveBeenCalled();
    expect(createAgentAccess).not.toHaveBeenCalled();
    rerender(<ResearchAgentPanel {...props} configurationValid />);
    await waitFor(() => expect(execute).toHaveBeenCalledExactlyOnceWith("validate_recipe", expect.objectContaining({ recipe })));
    expect(screen.getByLabelText("Assistant access level")).toHaveValue("inspect");
    await waitFor(() => expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeEnabled());
    rerender(<ResearchAgentPanel {...props} configurationValid={false} />);
    expect(screen.getByText("Validate exact scope and recipe")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("grants the full explicit study snapshot and invalidates the receipt when it changes", async () => {
    const second = { ...source, id: "2".repeat(32), sha256: "3".repeat(64), name: "Second source" };
    const operations: ResearchSnapshot["operations"] = {
      classical_run: { summary: "Run classical segmentation", mutates: true, agent_execution: "task" },
      correction_info: { summary: "Inspect labels for correction", mutates: false, agent_execution: "read" },
      correct_result: { summary: "Correct labels", mutates: true, agent_execution: "task" },
    };
    const createAgentAccess = vi.fn(async (request) => ({
      ...receipt, schema: "loci.agent-policy/v4", plugin_filename: "plugin/plugin.json",
      delegation: { id: "f".repeat(32), client_id: request.delegation.client_id,
        expires_at: request.delegation.expires_at, result_scope: request.delegation.result_scope },
      actions: request.actions, sources: request.source_scope.sources, export_scope: "directory",
      disclosures: request.disclosures,
      operations: ["inspect_source", "validate_recipe", "analysis_context", "preview_recipe", "submit_recipe",
        "job_status", "cancel_job", "result", "result_view", "export_result", "source_image", "source_display",
        "set_source_display", "review_history", "study_results", "review_result", "validate_action", "inspect_action", "submit_action"],
    })) as NonNullable<ResearchDesktopApi["createAgentAccess"]>;
    const api = bridge(vi.fn().mockResolvedValue(validation), createAgentAccess);
    const props = { api, source, selection, recipe, operations, studySources: [source, second],
      report: async <T,>(work: () => Promise<T>) => work(), busy: false, onBusyChange: vi.fn() };
    const { rerender } = render(<ResearchAgentPanel {...props} />);
    fireEvent.change(screen.getByLabelText("Assistant access level"), { target: { value: "full" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeEnabled());
    expect(createAgentAccess).not.toHaveBeenCalled();
    expect(screen.getByText(/all 2 current sources/)).toBeVisible();
    fireEvent.click(screen.getByText("Customize permissions"));
    fireEvent.click(screen.getByText("Included actions (3)"));
    expect(screen.getByText("Run classical segmentation")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    await screen.findByLabelText("Created agent access receipt");
    expect(createAgentAccess).toHaveBeenCalledWith(expect.objectContaining({
      allow_run: true, allow_export: true, export_names: [], export_scope: "directory",
      actions: ["classical_run", "correct_result", "correction_info"],
      delegation: { client_id: "codex", expires_at: null, result_scope: "granted-sources", allow_review: true },
      source_scope: { mode: "study-sources", sources: [source, second].map(({ id, sha256 }) => ({ id, sha256 })) },
    }));
    rerender(<ResearchAgentPanel {...props} configurationValid={false} />);
    expect(screen.getByLabelText("Created agent access receipt")).toBeVisible();
    expect(screen.getByLabelText("Assistant access level")).toHaveValue("full");
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
    rerender(<ResearchAgentPanel {...props} studySources={[source, second, { ...second, id: "4".repeat(32) }]} />);
    await waitFor(() => expect(screen.queryByLabelText("Created agent access receipt")).not.toBeInTheDocument());
    expect(createAgentAccess).toHaveBeenCalledTimes(1);
  });

  it("keeps task actions out of Inspect and invalidates a receipt when the action catalogue changes", async () => {
    const operations: ResearchSnapshot["operations"] = {
      classical_run: { summary: "Run classical segmentation", mutates: true, agent_execution: "task" },
      correction_info: { summary: "Inspect labels", mutates: false, agent_execution: "read" },
    };
    const createAgentAccess = vi.fn(async (request) => ({
      ...receipt, schema: "loci.agent-policy/v4", plugin_filename: "plugin/plugin.json",
      delegation: { id: "f".repeat(32), client_id: request.delegation.client_id,
        expires_at: request.delegation.expires_at, result_scope: request.delegation.result_scope },
      actions: request.actions, sources: [{ id: source.id, sha256: source.sha256 }], export_scope: "listed",
      disclosures: request.disclosures,
      operations: ["inspect_source", "validate_recipe", "analysis_context", "result", "result_view",
        "source_image", "review_history", "study_results", "validate_action", "inspect_action"],
    })) as NonNullable<ResearchDesktopApi["createAgentAccess"]>;
    const props = { api: bridge(vi.fn().mockResolvedValue(validation), createAgentAccess), source, selection, recipe,
      operations, report: async <T,>(work: () => Promise<T>) => work(), busy: false, onBusyChange: vi.fn() };
    const { rerender } = render(<ResearchAgentPanel {...props} />);
    fireEvent.change(screen.getByLabelText("Assistant access level"), { target: { value: "inspect" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    await screen.findByLabelText("Created agent access receipt");
    expect(createAgentAccess).toHaveBeenCalledWith(expect.objectContaining({
      actions: ["correction_info"], allow_run: false, allow_export: false,
      delegation: expect.objectContaining({ allow_review: false }),
    }));
    rerender(<ResearchAgentPanel {...props} operations={{ classical_run: operations.classical_run }} />);
    await waitFor(() => expect(screen.queryByLabelText("Created agent access receipt")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
    expect(createAgentAccess).toHaveBeenCalledTimes(1);
  });

  it("rejects a full-study receipt that omits a granted source", async () => {
    const second = { ...source, id: "2".repeat(32), sha256: "3".repeat(64) };
    const errors: string[] = [];
    const createAgentAccess = vi.fn(async (request) => ({
      ...receipt, schema: "loci.agent-policy/v4", plugin_filename: "plugin/plugin.json",
      delegation: { id: "f".repeat(32), client_id: "codex", expires_at: null, result_scope: "granted-sources" },
      actions: request.actions, sources: [{ id: source.id, sha256: source.sha256 }], export_scope: "directory",
      disclosures: request.disclosures,
      operations: ["inspect_source", "validate_recipe", "analysis_context", "preview_recipe", "submit_recipe",
        "job_status", "cancel_job", "result", "result_view", "export_result", "source_image", "source_display",
        "set_source_display", "review_history", "study_results", "review_result", "validate_action", "inspect_action"],
    })) as NonNullable<ResearchDesktopApi["createAgentAccess"]>;
    render(<ResearchAgentPanel api={bridge(vi.fn().mockResolvedValue(validation), createAgentAccess)}
      source={source} selection={selection} recipe={recipe} studySources={[source, second]}
      operations={{ correction_info: { summary: "Inspect labels", mutates: false, agent_execution: "read" } }}
      report={async <T,>(work: () => Promise<T>) => { try { return await work(); } catch (error) { errors.push(String(error)); return undefined; } }}
      busy={false} onBusyChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Assistant access level"), { target: { value: "full" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    await waitFor(() => expect(errors).toEqual([expect.stringContaining("receipt did not match")]));
    expect(screen.queryByLabelText("Created agent access receipt")).not.toBeInTheDocument();
  });

  it("grants named agent approval independently of execution and verifies its receipt", async () => {
    const createAgentAccess = vi.fn(async (request) => ({
      ...receipt, schema: "loci.agent-policy/v4", plugin_filename: "plugin/plugin.json",
      delegation: { id: "f".repeat(32), client_id: request.delegation.client_id,
        expires_at: request.delegation.expires_at, result_scope: request.delegation.result_scope },
      actions: [], sources: [{ id: source.id, sha256: source.sha256 }], export_scope: "listed",
      disclosures: ["agent_metadata"],
      operations: ["inspect_source", "validate_recipe", "analysis_context", "result", "review_history", "review_result", "study_results"],
    })) as NonNullable<ResearchDesktopApi["createAgentAccess"]>;
    renderPanel(bridge(vi.fn().mockResolvedValue(validation), createAgentAccess));
    fireEvent.click(screen.getByLabelText("Allow the assistant to approve or exclude result revisions"));
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Disclose agent_metadata"));
    fireEvent.change(screen.getByLabelText("Agent access expiry"), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    await screen.findByLabelText("Created agent access receipt");
    expect(createAgentAccess).toHaveBeenCalledWith(expect.objectContaining({
      allow_run: false,
      delegation: { client_id: "codex", expires_at: expect.any(String), result_scope: "pinned-recipes", allow_review: true },
    }));
    fireEvent.change(screen.getByLabelText("Assistant client"), { target: { value: "claude" } });
    expect(screen.queryByLabelText("Created agent access receipt")).not.toBeInTheDocument();
  });

  it("starts every disclosure and operation grant denied", () => {
    renderPanel(bridge(vi.fn()));
    for (const disclosure of ["geometry", "source_names", "previews", "measurements", "provenance", "agent_metadata"])
      expect(screen.getByLabelText(`Disclose ${disclosure}`)).not.toBeChecked();
    expect(screen.getByLabelText("Allow display-only recipe previews")).not.toBeChecked();
    expect(screen.getByLabelText("Allow durable recipe runs and result reads")).not.toBeChecked();
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
  });

  it("shows context access only with the explicit metadata disclosure", async () => {
    const execute = vi.fn().mockResolvedValue(validation);
    const contextReceipt = {
      ...receipt, disclosures: ["agent_metadata"],
      operations: ["analysis_context", "inspect_source", "validate_recipe"],
    };
    const createAgentAccess = vi.fn().mockResolvedValue(contextReceipt);
    renderPanel(bridge(execute, createAgentAccess));
    expect(screen.queryByText(/static\).*analysis_context/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Disclose agent_metadata"));
    expect(screen.getByText(/static\).*analysis_context/)).toBeVisible();
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    expect(await screen.findByLabelText("Created agent access receipt"))
      .toHaveTextContent("analysis_context");
    expect(createAgentAccess).toHaveBeenCalledWith(expect.objectContaining({
      disclosures: ["agent_metadata"], allow_preview: false, allow_run: false,
    }));
    fireEvent.click(screen.getByLabelText("Disclose agent_metadata"));
    expect(screen.queryByText(/static\).*analysis_context/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Created agent access receipt")).not.toBeInTheDocument();
  });

  it("creates access from the unchanged validated scope with exact grants and limits", async () => {
    const execute = vi.fn().mockResolvedValue(validation);
    const createAgentAccess = vi.fn().mockResolvedValue(receipt);
    renderPanel(bridge(execute, createAgentAccess));
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    const validationCard = await screen.findByLabelText("Exact recipe validation");
    expect(validationCard).toHaveTextContent("Scope and settings checked");
    expect(within(validationCard).getByText(validation.recipe_sha256)).not.toBeVisible();
    expect(within(validationCard).getByText(/unvalidated-research-method/)).not.toBeVisible();
    fireEvent.click(screen.getByLabelText("Allow display-only recipe previews"));
    fireEvent.click(screen.getByLabelText("Allow durable recipe runs and result reads"));
    fireEvent.click(screen.getByLabelText("Disclose previews"));
    fireEvent.click(screen.getByLabelText("Disclose measurements"));
    fireEvent.change(screen.getByLabelText("Agent CPU seconds"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("Agent memory MiB"), { target: { value: "512" } });
    fireEvent.change(screen.getByLabelText("Agent concurrency"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    await waitFor(() => expect(createAgentAccess).toHaveBeenCalledWith({
      source_id: source.id,
      selection,
      recipe,
      allow_preview: true,
      allow_run: true,
      allow_export: false,
      export_names: [],
      disclosures: ["previews", "measurements"],
      limits: { cpu_seconds: 60, memory_bytes: 512 * 1024 ** 2, concurrency: 2 },
    }));
    expect(await screen.findByLabelText("Created agent access receipt")).toHaveTextContent("agent-policy.json");
    const ready = screen.getByLabelText("Created agent access receipt");
    expect(ready).not.toHaveTextContent("/Users/");
    const policyHash = within(ready).getByText(receipt.policy_sha256);
    expect(policyHash).not.toBeVisible();
    fireEvent.click(within(ready).getByText("Technical record"));
    expect(policyHash).toBeVisible();
  });

  it("rejects invalid limits and unsupported reference-bound recipes", async () => {
    const execute = vi.fn().mockResolvedValue(validation);
    const { rerender, props } = renderPanel(bridge(execute));
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    fireEvent.change(screen.getByLabelText("Agent memory MiB"), { target: { value: "63" } });
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
    expect(screen.getByText(/Use integer limits/)).toBeVisible();

    const referenceRecipe: ResearchRecipe = {
      ...recipe,
      references: { flatfield: { source_id: source.id, selection } },
    };
    rerender(<ResearchAgentPanel {...props} recipe={referenceRecipe} />);
    expect(screen.getByText(/currently reject flat-field and dark-field references/)).toBeVisible();
    expect(screen.getByText("Validate exact scope and recipe")).toBeDisabled();
  });

  it("requires every export disclosure and an exact safe directory name", async () => {
    const execute = vi.fn().mockResolvedValue(validation);
    const exportReceipt: ResearchAgentAccessReceipt = {
      ...receipt,
      disclosures: ["geometry", "measurements", "previews", "provenance", "source_names"],
      operations: [
        "cancel_job", "export_result", "inspect_source", "job_status", "result", "result_view",
        "submit_recipe", "validate_recipe",
      ],
    };
    const createAgentAccess = vi.fn().mockResolvedValue(exportReceipt);
    renderPanel(bridge(execute, createAgentAccess));
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    fireEvent.click(screen.getByLabelText("Allow durable recipe runs and result reads"));
    fireEvent.click(screen.getByLabelText("Allow exact reviewed-result export"));
    fireEvent.change(screen.getByLabelText("Exact export names"), {
      target: { value: "experiment-01-reviewed" },
    });
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
    for (const category of ["geometry", "source_names", "previews", "measurements", "provenance"])
      fireEvent.click(screen.getByLabelText(`Disclose ${category}`));
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    await waitFor(() => expect(createAgentAccess).toHaveBeenCalledWith(expect.objectContaining({
      allow_run: true,
      allow_export: true,
      export_names: ["experiment-01-reviewed"],
      disclosures: ["geometry", "source_names", "previews", "measurements", "provenance"],
    })));
  });

  it("clears validation and all proposed grants when the exact source changes", async () => {
    const execute = vi.fn().mockResolvedValue(validation);
    const { rerender, props } = renderPanel(bridge(execute));
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    fireEvent.click(screen.getByLabelText("Allow durable recipe runs and result reads"));
    fireEvent.click(screen.getByLabelText("Disclose provenance"));

    const nextSource = { ...source, id: "f".repeat(32), sha256: "1".repeat(64), name: "Other source" };
    rerender(<ResearchAgentPanel {...props} source={nextSource} />);
    await waitFor(() => expect(screen.queryByLabelText("Exact recipe validation")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Allow durable recipe runs and result reads")).not.toBeChecked();
    expect(screen.getByLabelText("Disclose provenance")).not.toBeChecked();
    expect(screen.queryByLabelText("Confirm exact agent policy")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
  });

  it("requires validation and a new grant click after the displayed crop changes", async () => {
    const execute = vi.fn().mockResolvedValue(validation);
    const createAgentAccess = vi.fn().mockResolvedValue(null);
    const { rerender, props } = renderPanel(bridge(execute, createAgentAccess));
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    await waitFor(() => expect(createAgentAccess).toHaveBeenCalledTimes(1));

    const nextSelection = { ...selection, x: 4 };
    execute.mockResolvedValue({ ...validation, selection: nextSelection });
    rerender(<ResearchAgentPanel {...props} selection={nextSelection} />);
    expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeDisabled();
    expect(createAgentAccess).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    expect(createAgentAccess).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    await waitFor(() => expect(createAgentAccess).toHaveBeenCalledTimes(2));
    expect(createAgentAccess).toHaveBeenLastCalledWith(expect.objectContaining({ selection: nextSelection }));
  });

  it("does not present an earlier access receipt as the changed policy", async () => {
    let finishGrant!: (value: ResearchAgentAccessReceipt) => void;
    const createAgentAccess = vi.fn(() => new Promise<ResearchAgentAccessReceipt>((resolve) => { finishGrant = resolve; }));
    renderPanel(bridge(vi.fn().mockResolvedValue(validation), createAgentAccess));
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    fireEvent.click(screen.getByLabelText("Allow display-only recipe previews"));
    fireEvent.click(screen.getByLabelText("Allow durable recipe runs and result reads"));
    fireEvent.click(screen.getByLabelText("Disclose previews"));
    fireEvent.click(screen.getByLabelText("Disclose measurements"));
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    fireEvent.click(screen.getByLabelText("Disclose geometry"));
    finishGrant(receipt);
    await waitFor(() => expect(screen.getByRole("button", { name: /Grant selected access/ })).toBeEnabled());
    expect(screen.queryByLabelText("Created agent access receipt")).not.toBeInTheDocument();
    expect(createAgentAccess).toHaveBeenCalledTimes(1);
  });
  it("requires explicit image channels, disclosures and numeric experiment bounds before a v3 grant", async () => {
    const v3Receipt = { ...receipt, schema: "loci.agent-policy/v3" as const, plugin_filename: "plugin/plugin.json",
      disclosures: ["geometry", "provenance", "agent_metadata", "previews"],
      operations: ["inspect_source", "validate_recipe", "analysis_context", "preview_recipe",
        "source_image", "source_display", "set_source_display", "export_vision_handoff"] };
    const createAgentAccess = vi.fn().mockResolvedValue(v3Receipt);
    renderPanel(bridge(vi.fn().mockResolvedValue(validation), createAgentAccess));
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    fireEvent.click(screen.getByLabelText("Allow source images for vision analysis"));
    fireEvent.click(screen.getByLabelText("Allow reversible channel display changes"));
    fireEvent.click(screen.getByLabelText("Allow bounded recipe exploration"));
    fireEvent.click(screen.getByLabelText("Allow display-only recipe previews"));
    const grant = screen.getByRole("button", { name: /Grant selected access/ });
    expect(grant).toBeDisabled();
    for (const name of v3Receipt.disclosures) fireEvent.click(screen.getByLabelText(`Disclose ${name}`));
    fireEvent.click(screen.getByLabelText("Grant display channel 1"));
    fireEvent.change(screen.getByLabelText("Minimum size lower bound"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Minimum size upper bound"), { target: { value: "3" } });
    expect(grant).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Minimum size upper bound"), { target: { value: "8" } });
    expect(grant).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Allow local vision handoff export"));
    expect(grant).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Exact vision handoff names"), { target: { value: "candidate.loci-vision" } });
    expect(grant).toBeEnabled();
    fireEvent.click(grant);
    await screen.findByLabelText("Created agent access receipt");
    expect(createAgentAccess).toHaveBeenCalledWith(expect.objectContaining({
      allow_run: false, allow_export: false, interactive: { allow_image: true, allow_display: true,
        allow_handoff: true, channels: [0], handoff_names: ["candidate.loci-vision"],
        parameters: { min_size: { min: 0, max: 8 } } },
    }));
    fireEvent.click(screen.getByLabelText("Grant display channel 2"));
    expect(screen.queryByLabelText("Created agent access receipt")).not.toBeInTheDocument();
  });

  it.each([
    { schema: "loci.agent-policy/v1", permission_mode: "ask_approval" },
    { schema: "loci.agent-policy/v5", permission_mode: undefined },
    { schema: "loci.agent-policy/v5", permission_mode: "full_access" },
  ] as const)("rejects a receipt that cannot confirm the requested approval mode: %j", async (returnedMode) => {
    const errors: string[] = [];
    const onCreated = vi.fn();
    render(<ResearchAgentPanel api={bridge(vi.fn().mockResolvedValue(validation), vi.fn().mockResolvedValue({ ...receipt, ...returnedMode }))}
      source={source} selection={selection} recipe={recipe} busy={false} onBusyChange={vi.fn()} onCreated={onCreated}
      report={async <T,>(work: () => Promise<T>) => {
        try { return await work(); } catch (error) { errors.push((error as Error).message); return undefined; }
      }} />);
    fireEvent.change(screen.getByLabelText("Session permission mode"), { target: { value: "ask_approval" } });
    fireEvent.click(screen.getByText("Customize permissions"));
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    fireEvent.click(screen.getByLabelText("Allow display-only recipe previews"));
    fireEvent.click(screen.getByLabelText("Allow durable recipe runs and result reads"));
    fireEvent.click(screen.getByLabelText("Disclose previews"));
    fireEvent.click(screen.getByLabelText("Disclose measurements"));
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    await waitFor(() => expect(errors).toEqual([expect.stringContaining("receipt did not match")]));
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Created agent access receipt")).not.toBeInTheDocument();
  });

  it("supports explicit permission_mode selection and shows bundle ready as not connected", async () => {
    const v5Receipt: ResearchAgentAccessReceipt = {
      ...receipt,
      schema: "loci.agent-policy/v5",
      permission_mode: "ask_approval",
    };
    const createAgentAccess = vi.fn().mockResolvedValue(v5Receipt);
    const onCreated = vi.fn();
    render(
      <ResearchAgentPanel
        api={bridge(vi.fn().mockResolvedValue(validation), createAgentAccess)}
        source={source}
        selection={selection}
        recipe={recipe}
        report={async <T,>(work: () => Promise<T>) => work()}
        busy={false}
        onBusyChange={vi.fn()}
        onCreated={onCreated}
      />,
    );
    fireEvent.change(screen.getByLabelText("Session permission mode"), {
      target: { value: "ask_approval" },
    });
    fireEvent.click(screen.getByText("Customize permissions"));
    fireEvent.click(screen.getByText("Validate exact scope and recipe"));
    await screen.findByLabelText("Exact recipe validation");
    fireEvent.click(screen.getByLabelText("Allow display-only recipe previews"));
    fireEvent.click(screen.getByLabelText("Allow durable recipe runs and result reads"));
    fireEvent.click(screen.getByLabelText("Disclose previews"));
    fireEvent.click(screen.getByLabelText("Disclose measurements"));
    fireEvent.click(screen.getByRole("button", { name: /Grant selected access/ }));
    const readyCard = await screen.findByLabelText("Created agent access receipt");
    expect(createAgentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ permission_mode: "ask_approval" }),
    );
    expect(readyCard).toHaveTextContent("not connected yet");
    expect(readyCard).toHaveTextContent("Bundle ready · Waiting for MCP client connection");
    expect(onCreated).toHaveBeenCalledOnce();
  });

});

it("points file-based vision clients to Agent and keeps source fingerprints in a closed record", () => {
  renderPanel(bridge(vi.fn()));
  fireEvent.change(screen.getByLabelText("Assistant client"), { target: { value: "web" } });
  expect(screen.getByText(/Agent → Export vision handoff/)).toBeVisible();
  expect(screen.queryByText(/Display → Export vision handoff/)).not.toBeInTheDocument();
  const scope = screen.getByLabelText("Exact agent source and scope");
  const fingerprint = within(scope).getByText(source.sha256);
  expect(fingerprint).not.toBeVisible();
  fireEvent.click(within(scope).getByText("Technical record"));
  expect(fingerprint).toBeVisible();
});
