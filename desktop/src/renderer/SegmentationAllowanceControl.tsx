import { useEffect, useState } from "react";
import type { ResearchDesktopApi } from "../shared/research-contracts";
import { memorySize, RECIPE_BUDGETS, type RecipeResources } from "../shared/recipe-resources";

export interface SegmentationAllowanceControlProps {
  api: ResearchDesktopApi;
  workingBytes: number;
  onWorkingBytesChange: (bytes: number) => void;
  busy: boolean;
  accessibleName: string;
  note?: string;
}

export function SegmentationAllowanceControl({
  api,
  workingBytes,
  onWorkingBytesChange,
  busy,
  accessibleName,
  note,
}: SegmentationAllowanceControlProps) {
  const [resources, setResources] = useState<RecipeResources | null>(null);
  const [capacityError, setCapacityError] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!api.recipeResources) {
      setCapacityError("Hardware recommendation unavailable.");
      return;
    }
    void api.recipeResources().then(
      (value) => {
        if (!cancelled) setResources(value);
      },
      () => {
        if (!cancelled) setCapacityError("Hardware recommendation unavailable.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const options = [...new Set([...RECIPE_BUDGETS, workingBytes])].sort((a, b) => a - b);

  return (
    <section className="recipe-resources" aria-label="Segmentation resources">
      <label>
        Memory allowance
        <select
          aria-label={accessibleName}
          value={workingBytes}
          disabled={busy}
          onChange={(event) => onWorkingBytesChange(Number(event.target.value))}
        >
          {options.map((bytes) => (
            <option key={bytes} value={bytes}>
              {memorySize(bytes)}
              {bytes === resources?.recommended_working_bytes ? " · recommended" : ""}
            </option>
          ))}
        </select>
      </label>
      {resources ? (
        <div className="recipe-resources-recommendation">
          <small>
            {memorySize(resources.total_memory_bytes)} installed ·{" "}
            {memorySize(resources.recommended_working_bytes)} recommended
          </small>
          {workingBytes !== resources.recommended_working_bytes && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onWorkingBytesChange(resources.recommended_working_bytes)}
            >
              Use recommended
            </button>
          )}
        </div>
      ) : (
        <small>{capacityError || "Checking installed memory…"}</small>
      )}
      {resources && workingBytes > resources.recommended_working_bytes && (
        <p className="recipe-resources-warning">
          Above the {memorySize(resources.recommended_working_bytes)} recommendation; runs may exhaust memory.
        </p>
      )}
      {note && <small>{note}</small>}
    </section>
  );
}
