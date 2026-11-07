// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecipeResourcePanel } from "./RecipeResourcePanel";
import { recipeResources } from "../shared/recipe-resources";
import type { ResearchDesktopApi, ResearchRecipe, ResearchSource } from "../shared/research-contracts";

const source: ResearchSource = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Synthetic", metadata: {} };
const selection = { x: 0, y: 0, width: 3000, height: 3000, z: 0, t: 0, c: 0, level: 0 };
const recipe: ResearchRecipe = { steps: [], segmentation: null, measurement_channels: [0], gates: [], working_bytes: 512 * 1024 ** 2 };
function receipt(bytes = 936000000, budget = recipe.working_bytes) {
  return { source_id: source.id, source_sha256: source.sha256,
    estimated_working_bytes: bytes, working_bytes: budget, maximum_working_bytes: 8 * 1024 ** 3,
    within_budget: bytes <= budget, estimate_basis: "loci.recipe-working-bytes/v1" };
}
function setup(execute = vi.fn().mockResolvedValue(receipt()), value = recipe) {
  const onBudget = vi.fn();
  const api = { execute, recipeResources: vi.fn().mockResolvedValue(recipeResources(8 * 1024 ** 3)) } as unknown as ResearchDesktopApi;
  return { api, onBudget, props: { api, onBudget, recipe: value, source, selection, busy: false } };
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(201); }); }
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("recipe resources", () => {
  it("omits the recommendation action when the saved allowance already matches", async () => {
    vi.useFakeTimers();
    const recommended = 2 * 1024 ** 3;
    const { props, onBudget } = setup(vi.fn().mockResolvedValue(receipt(10400, recommended)),
      { ...recipe, working_bytes: recommended });
    const { rerender } = render(<RecipeResourcePanel {...props} />);
    await tick();
    expect(screen.getByLabelText("Recipe memory allowance")).toHaveValue(String(recommended));
    expect(screen.queryByRole("button", { name: "Use recommended" })).not.toBeInTheDocument();
    expect(onBudget).not.toHaveBeenCalled();
    rerender(<RecipeResourcePanel {...props} recipe={recipe} />);
    expect(screen.getByRole("button", { name: "Use recommended" })).toBeEnabled();
    expect(onBudget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use recommended" }));
    expect(onBudget).toHaveBeenCalledOnce();
    expect(onBudget).toHaveBeenCalledWith(recommended);
  });
  it("shows real preflight and an explicit recommendation without rewriting a saved budget", async () => {
    vi.useFakeTimers();
    const { props, onBudget, api } = setup();
    render(<RecipeResourcePanel {...props} />);
    expect(screen.getByText("Checking…")).toBeInTheDocument();
    await tick();
    expect(api.execute).toHaveBeenCalledWith("recipe_preflight", { source_id: source.id, selection, recipe });
    expect(screen.getByText(/Choose a larger allowance/)).toBeInTheDocument();
    expect(screen.getByText("892.64 MiB")).toBeInTheDocument();
    expect(onBudget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use recommended" }));
    expect(onBudget).toHaveBeenLastCalledWith(2 * 1024 ** 3);
    fireEvent.change(screen.getByLabelText("Recipe memory allowance"), { target: { value: 8 * 1024 ** 3 } });
    expect(onBudget).toHaveBeenLastCalledWith(8 * 1024 ** 3);
  });
  it("discards a late estimate after a source or recipe change", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: unknown) => void;
    const execute = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(receipt(10400, 1024 ** 3));
    const { props } = setup(execute);
    const { rerender } = render(<RecipeResourcePanel {...props} />);
    await tick();
    rerender(<RecipeResourcePanel {...props} recipe={{ ...recipe, working_bytes: 1024 ** 3 }} />);
    await tick();
    await act(async () => { resolveOld(receipt()); });
    expect(screen.queryByText(/Choose a larger allowance/)).not.toBeInTheDocument();
    expect(screen.getByText("0.01 MiB")).toBeInTheDocument();
  });
  it("retains custom saved allowances and displays hardware and estimate failures honestly", async () => {
    vi.useFakeTimers();
    const { props } = setup(vi.fn().mockRejectedValue(new Error("Invalid channel binding")), { ...recipe, working_bytes: 123456789 });
    props.api.recipeResources = vi.fn().mockRejectedValue(new Error("unavailable"));
    render(<RecipeResourcePanel {...props} />);
    await tick();
    expect(screen.getByLabelText("Recipe memory allowance")).toHaveValue("123456789");
    expect(screen.getByText("Hardware recommendation unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Invalid channel binding")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });
  it("rejects mismatched identity and does not show a false fit", async () => {
    vi.useFakeTimers();
    const { props } = setup(vi.fn().mockResolvedValue({ ...receipt(), source_sha256: "c".repeat(64) }));
    render(<RecipeResourcePanel {...props} busy />);
    await tick();
    expect(screen.getByText(/Estimate does not match/)).toBeInTheDocument();
    expect(screen.getByLabelText("Recipe memory allowance")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use recommended" })).toBeDisabled();
  });
  it("cancels a queued estimate while the native picker pins the document and retries on resume", async () => {
    vi.useFakeTimers();
    const { props, api, onBudget } = setup();
    const { rerender } = render(<RecipeResourcePanel {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    rerender(<RecipeResourcePanel {...props} suspended />);
    await tick();
    expect(api.execute).not.toHaveBeenCalled();
    rerender(<RecipeResourcePanel {...props} suspended={false} />);
    await tick();
    expect(api.execute).toHaveBeenCalledTimes(1);
    expect(api.execute).toHaveBeenCalledWith("recipe_preflight", { source_id: source.id, selection, recipe });
    expect(screen.getByText("892.64 MiB")).toBeInTheDocument();
    expect(onBudget).not.toHaveBeenCalled();
  });
  it("ignores a late successful estimate from before the picker after the resumed estimate completes", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: unknown) => void;
    const execute = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(receipt(10400));
    const { props, onBudget } = setup(execute);
    const { rerender } = render(<RecipeResourcePanel {...props} />);
    await tick();
    rerender(<RecipeResourcePanel {...props} suspended />);
    rerender(<RecipeResourcePanel {...props} suspended={false} />);
    await tick();
    await act(async () => { resolveOld(receipt()); });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(screen.getByText("0.01 MiB")).toBeInTheDocument();
    expect(screen.queryByText("892.64 MiB")).not.toBeInTheDocument();
    expect(onBudget).not.toHaveBeenCalled();
  });
  it("ignores an in-flight barrier rejection and rechecks identical bindings after the picker", async () => {
    vi.useFakeTimers();
    let rejectOld!: (reason: Error) => void;
    const execute = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValue(receipt(10400));
    const { props, onBudget } = setup(execute);
    const { rerender } = render(<RecipeResourcePanel {...props} />);
    await tick();
    rerender(<RecipeResourcePanel {...props} suspended />);
    await act(async () => { rejectOld(new Error("Wait for the study to finish opening.")); });
    await tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Wait for the study to finish opening.")).not.toBeInTheDocument();
    rerender(<RecipeResourcePanel {...props} suspended={false} />);
    await tick();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(screen.getByText("0.01 MiB")).toBeInTheDocument();
    expect(onBudget).not.toHaveBeenCalled();
  });
  it("recovers a retained error on resume without requiring a recipe change or manual recheck", async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockRejectedValueOnce(new Error("Wait for the study to finish opening."))
      .mockResolvedValue(receipt(10400));
    const { props } = setup(execute);
    const { rerender } = render(<RecipeResourcePanel {...props} />);
    await tick();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    rerender(<RecipeResourcePanel {...props} suspended />);
    rerender(<RecipeResourcePanel {...props} suspended={false} />);
    await tick();
    expect(screen.getByText("0.01 MiB")).toBeInTheDocument();
    expect(screen.queryByText("Wait for the study to finish opening.")).not.toBeInTheDocument();
    expect(execute).toHaveBeenCalledTimes(2);
  });

});
