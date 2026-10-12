import { useEffect, useState } from "react";
import type { ResearchDesktopApi, ResearchRecipe, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { memorySize, RECIPE_BUDGETS, type RecipeResources } from "../shared/recipe-resources";

interface Estimate { key: string; bytes?: number; error?: string }
export function RecipeResourcePanel({ api, source, selection, recipe, onBudget, busy }: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection;
  recipe: ResearchRecipe; onBudget: (bytes: number) => void; busy: boolean;
}) {
  const [resources, setResources] = useState<RecipeResources | null>(null);
  const [capacityError, setCapacityError] = useState("");
  const [retry, setRetry] = useState(0);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const key = JSON.stringify({ source_id: source.id, source_sha256: source.sha256, selection, recipe });
  useEffect(() => {
    let cancelled = false;
    if (!api.recipeResources) { setCapacityError("Hardware recommendation unavailable."); return; }
    void api.recipeResources().then((value) => {
      if (!cancelled) setResources(value);
    }, () => { if (!cancelled) setCapacityError("Hardware recommendation unavailable."); });
    return () => { cancelled = true; };
  }, [api]);
  useEffect(() => {
    let cancelled = false;
    // Debounce edits without occupying the analysis job or discarding its errors.
    const timer = setTimeout(() => {
      const { source_sha256, ...request } = JSON.parse(key);
      void api.execute("recipe_preflight", request).then((value) => {
        if (cancelled) return;
        const result = value as Record<string, unknown> | null;
        const bytes = result?.estimated_working_bytes;
        if (!result || result.source_id !== request.source_id || result.source_sha256 !== source_sha256 ||
            result.working_bytes !== request.recipe.working_bytes ||
            result.maximum_working_bytes !== RECIPE_BUDGETS.at(-1) ||
            result.estimate_basis !== "loci.recipe-working-bytes/v1" ||
            typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 ||
            result.within_budget !== (bytes <= request.recipe.working_bytes)) {
          setEstimate({ key, error: "Estimate does not match this recipe. Try checking again." });
          return;
        }
        setEstimate({ key, bytes });
      }, (error: unknown) => {
        if (!cancelled) setEstimate({ key, error: error instanceof Error ? error.message : "Could not estimate this recipe." });
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, key, retry]);
  const current = estimate?.key === key ? estimate : null;
  const overBudget = current?.bytes !== undefined && current.bytes > recipe.working_bytes;
  const options = [...new Set([...RECIPE_BUDGETS, recipe.working_bytes])].sort((a, b) => a - b);
  return <section className="recipe-resources" aria-label="Recipe resources">
    <div className="recipe-resources-estimate" role="status" aria-live="polite">
      <span>Estimated working memory</span>
      <strong>{current?.bytes !== undefined ? memorySize(current.bytes) : current?.error ? "Unavailable" : "Checking…"}</strong>
    </div>
    {current?.error && <><p className="recipe-resources-warning">{current.error}</p>
      <button disabled={busy} onClick={() => { setEstimate(null); setRetry((value) => value + 1); }}>Recheck estimate</button></>}
    <label>Memory allowance
      <select aria-label="Recipe memory allowance" value={recipe.working_bytes} disabled={busy}
        onChange={(event) => onBudget(Number(event.target.value))}>
        {options.map((bytes) => <option key={bytes} value={bytes}>{memorySize(bytes)}{bytes === resources?.recommended_working_bytes ? " · recommended" : ""}</option>)}
      </select>
    </label>
    {resources ? <div className="recipe-resources-recommendation">
      <small>{memorySize(resources.total_memory_bytes)} installed · {memorySize(resources.recommended_working_bytes)} recommended</small>
      {recipe.working_bytes !== resources.recommended_working_bytes && <button disabled={busy}
        onClick={() => onBudget(resources.recommended_working_bytes)}>Use recommended</button>}
    </div> : <small>{capacityError || "Checking installed memory…"}</small>}
    {overBudget && <p className="recipe-resources-warning">{current.bytes! > RECIPE_BUDGETS.at(-1)!
      ? "This recipe exceeds the supported 8 GiB allowance. Select a smaller region."
      : "Choose a larger allowance to run this region, or select a smaller region."}</p>}
    {resources && recipe.working_bytes > resources.recommended_working_bytes && <p className="recipe-resources-warning">
      Above this computer’s recommended allowance.
    </p>}
  </section>;
}
