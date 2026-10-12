import { describe, expect, it } from "vitest";
import { connected, finiteDraft, reconnectProcess, workflowFromRecipe } from "./workflow-editor";
import type { ResearchRecipe } from "../shared/research-contracts";
const recipe: ResearchRecipe = { steps: [{ op: "gaussian", sigma: .5 }, { op: "median", radius: 2 }], segmentation: { method: "components", threshold: 4 }, measurement_channels: [0, 2], gates: [{ name: "positive", channel: "3: marker", statistic: "mean", threshold: 50, control: "negative control" }], working_bytes: 512 * 1024 ** 2 };
describe("Typed linear workflow editing", () => {
  it("copies every recipe setting without shared mutation and reconnects process order", () => {
    const definition = workflowFromRecipe(recipe);
    expect(definition.nodes.find((node) => node.type === "segment")?.settings).toEqual(recipe.segmentation);
    expect(definition.nodes.find((node) => node.type === "measure")?.settings).toEqual({ measurement_channels: [0, 2], gates: recipe.gates });
    const moved = reconnectProcess(definition, "process-1", "source");
    expect(moved.nodes.map((node) => node.id)).toEqual(["source", "process-1", "process-0", "segment", "measure", "review", "export"]);
    expect(moved.edges).toEqual(connected(definition, moved.nodes).edges);
    moved.nodes[1].settings.radius = 3;
    expect(recipe.steps[1].radius).toBe(2);
  });
  it("rejects incompatible image links and invalid numeric drafts", () => {
    const definition = workflowFromRecipe(recipe);
    expect(() => reconnectProcess(definition, "process-0", "measure")).toThrow(/image input/);
    expect(() => reconnectProcess(definition, "process-0", "process-0")).toThrow();
    for (const value of ["", " ", "Infinity", "NaN", "2x"]) expect(() => finiteDraft(value)).toThrow();
    expect(() => finiteDraft("1.5", true)).toThrow();
    expect(() => finiteDraft("-1", false, 0)).toThrow();
    expect(finiteDraft("0.00001")).toBe(.00001);
  });
});
