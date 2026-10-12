/** Advisory capacity policy; neither a reservation nor a process-RSS limit. */
export const RECIPE_BUDGETS = [256 * 1024 ** 2, 512 * 1024 ** 2,
  1024 ** 3, 2 * 1024 ** 3, 4 * 1024 ** 3, 8 * 1024 ** 3];
export interface RecipeResources {
  total_memory_bytes: number;
  recommended_working_bytes: number;
  maximum_working_bytes: number;
  recommendation_basis: "quarter-installed-memory/v1";
}
export function recipeResources(totalMemory: number): RecipeResources {
  if (!Number.isSafeInteger(totalMemory) || totalMemory <= 0)
    throw new Error("Installed memory could not be determined.");
  const recommended = RECIPE_BUDGETS.filter((bytes) => bytes <= totalMemory / 4).at(-1)
    ?? RECIPE_BUDGETS[0];
  return { total_memory_bytes: totalMemory, recommended_working_bytes: recommended,
    maximum_working_bytes: RECIPE_BUDGETS.at(-1)!,
    recommendation_basis: "quarter-installed-memory/v1" };
}
export function memorySize(bytes: number): string {
  const unit = bytes >= 1024 ** 3 ? "GiB" : "MiB";
  const value = bytes / (unit === "GiB" ? 1024 ** 3 : 1024 ** 2);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
}
