import { describe, expect, it } from "vitest";
import { recipeResources } from "./recipe-resources";

describe("advisory recipe capacity", () => {
  it.each([[4, 1], [8, 2], [16, 4], [32, 8], [128, 8]])(
    "recommends a bounded quarter of %i GiB without capping user choice", (installed, recommended) => {
      expect(recipeResources(installed * 1024 ** 3)).toMatchObject({
        total_memory_bytes: installed * 1024 ** 3,
        recommended_working_bytes: recommended * 1024 ** 3,
        maximum_working_bytes: 8 * 1024 ** 3,
      });
    });
  it.each([NaN, Infinity, -1, 0, 1.5])("rejects an invalid observation %s", (value) => {
    expect(() => recipeResources(value)).toThrow("Installed memory");
  });
});
