import { useEffect, useMemo, useState } from "react";
import type {
  ResearchDesktopApi,
  ResearchResult,
  ResearchSnapshot,
  ResearchSource,
} from "../shared/research-contracts";
import { ResearchInterchangePanel } from "./ResearchInterchangePanel";
import { sourceRelinkKind } from "../shared/source-relink";
import "./ResearchPortabilityPanel.css";

type Report = <T>(
  work: () => Promise<T>,
  fallback: string,
) => Promise<T | undefined>;

type RecipeDocument = {
  id: string;
  revision?: number;
  data?: { name?: unknown };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recipeDocument(value: unknown): RecipeDocument | null {
  const item = record(value);
  return item && typeof item.id === "string"
    ? (item as unknown as RecipeDocument)
    : null;
}

function shortHash(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value)
    ? `${value.slice(0, 12)}…`
    : null;
}

export function ResearchPortabilityPanel({
  api,
  snapshot,
  selectedSourceId,
  selectedResult,
  report,
  busy,
  onBusyChange,
  onSnapshot,
  onResult,
}: {
  api: ResearchDesktopApi;
  snapshot: ResearchSnapshot;
  selectedSourceId: string | null;
  selectedResult: ResearchResult | null;
  report: Report;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onSnapshot: (snapshot: ResearchSnapshot | null) => void;
  onResult: (result: ResearchResult) => Promise<void>;
}): React.JSX.Element {
  const availableSources = snapshot.sources.filter(
    (source) => source.locator_state !== "relink-required",
  );
  const initialSource =
    availableSources.find((source) => source.id === selectedSourceId)?.id ??
    availableSources[0]?.id ??
    "";
  const [primary, setPrimary] = useState(initialSource);
  const [flatfield, setFlatfield] = useState("");
  const [darkfield, setDarkfield] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const locked = busy || localBusy;
  const missing = snapshot.sources.filter(
    (source) => source.locator_state === "relink-required",
  );
  const recipes = useMemo(
    () => snapshot.recipes.map(recipeDocument).filter(Boolean) as RecipeDocument[],
    [snapshot.recipes],
  );

  useEffect(() => {
    if (!availableSources.some((source) => source.id === primary))
      setPrimary(initialSource);
  }, [availableSources, initialSource, primary]);

  const run = async <T,>(work: () => Promise<T>, fallback: string) => {
    setLocalBusy(true);
    onBusyChange(true);
    setStatus(null);
    try {
      return await report(work, fallback);
    } finally {
      setLocalBusy(false);
      onBusyChange(false);
    }
  };

  const exportStudy = async () => {
    if (!api.exportStudy) return;
    const output = await run(
      () => api.exportStudy!(),
      "Could not export this portable study.",
    );
    const receipt = record(output);
    if (!receipt) return;
    const digest = shortHash(receipt.archive_sha256);
    setStatus(
      `Exported ${String(receipt.export_name ?? "portable study")}${
        digest ? ` · SHA-256 ${digest}` : ""
      }${
        typeof receipt.member_count === "number"
          ? ` · ${receipt.member_count} members`
          : ""
      }.`,
    );
  };

  const relink = async (source: ResearchSource) => {
    if (!api.relinkSource) return;
    const next = await run(
      () => api.relinkSource!(source.id, sourceRelinkKind(source)),
      "The selected source did not match the archived fingerprint and size.",
    );
    if (next) {
      onSnapshot(next);
      setStatus(`Relinked ${source.name} to its verified local source.`);
    }
  };

  const exportRecipe = async (recipe: RecipeDocument) => {
    if (!api.exportRecipe || !selectedSourceId) return;
    const output = await run(
      () => api.exportRecipe!(recipe.id, selectedSourceId),
      "Could not export this recipe for the selected source.",
    );
    const receipt = record(output);
    if (!receipt) return;
    const roles = Array.isArray(receipt.roles)
      ? receipt.roles.filter((role): role is string => typeof role === "string")
      : [];
    setStatus(
      `Exported ${String(receipt.export_name ?? "recipe template")}${
        roles.length ? ` with roles ${roles.join(", ")}` : ""
      }.`,
    );
  };

  const importRecipe = async () => {
    if (!api.importRecipe || !primary) return;
    const bindings: Record<string, string> = { primary };
    if (flatfield) bindings.flatfield = flatfield;
    if (darkfield) bindings.darkfield = darkfield;
    const output = await run(
      () => api.importRecipe!(bindings),
      "Could not import this recipe with the selected source roles.",
    );
    if (!output) return;
    const next = await run(
      () => api.getSnapshot(),
      "Recipe imported, but the study could not be refreshed.",
    );
    if (next) onSnapshot(next);
    const imported = record(record(output)?.recipe);
    const name = record(imported?.data)?.name;
    setStatus(
      `Imported and revalidated ${typeof name === "string" ? name : "recipe template"}.`,
    );
  };

  const sourceOptions = (label: string, value: string, change: (id: string) => void) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        disabled={locked}
        onChange={(event) => change(event.target.value)}
      >
        {label !== "Primary source role" && <option value="">Not used</option>}
        {label === "Primary source role" && !availableSources.length && (
          <option value="">Relink a source first</option>
        )}
        {availableSources.map((source) => (
          <option key={source.id} value={source.id}>
            {source.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="research-portability">
      <section className="research-panel">
        <h2>Portable study</h2>
        <div className="research-actions">
          <button disabled={locked} onClick={() => void run(
            () => api.openStudy(), "Could not open the selected study.",
          ).then((next) => { if (next) onSnapshot(next); })}>Open study</button>
          <button disabled={locked} onClick={() => void run(
            () => api.createStudy(), "Could not create a new study.",
          ).then((next) => { if (next) onSnapshot(next); })}>Create study</button>
        </div>
        <p>Share results and settings. Original images stay separate.</p>
        <button disabled={locked || !api.exportStudy} onClick={() => void exportStudy()}>
          Export portable study
        </button>
        <button
          disabled={locked || !api.importStudy}
          onClick={() => void run(
            () => api.importStudy!(),
            "Could not import this archive into a new study directory.",
          ).then((next) => { if (next) onSnapshot(next); })}
        >
          Import portable study
        </button>
        <details><summary>Archive contents</summary><p>Includes derived records, artifacts and source fingerprints.
          Raw images, source locations, model packages, credentials and active processes are excluded.</p></details>
        {missing.length > 0 && (
          <>
            <h3>Relink imported sources</h3>
            <p>Choose the original local images to restore access.</p>
            <ul className="research-portability-list">
              {missing.map((source) => (
                <li key={source.id}>
                  <span>
                    <strong>{source.name}</strong>
                    <small>
                      {source.source_kind ?? "native"}
                      {source.relink_hint?.selection_kind === "series" &&
                      source.relink_hint.file_count
                        ? ` · ${source.relink_hint.file_count} files`
                        : ""}
                    </small>
                  </span>
                  <button disabled={locked} onClick={() => void relink(source)}>
                    Relink {sourceRelinkKind(source) === "dicom" ? "series" : "source"}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="research-panel">
        <h2>Recipe templates</h2>
        {recipes.length ? (
          <ul className="research-portability-list">
            {recipes.map((recipe) => (
              <li key={recipe.id}>
                <span>{String(recipe.data?.name ?? "Saved recipe")}</span>
                <button
                  disabled={locked || !api.exportRecipe || !selectedSourceId}
                  onClick={() => void exportRecipe(recipe)}
                >
                  Export template
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>No saved recipe is available to export.</p>
        )}
        <h3>Import and map roles</h3>
        {sourceOptions("Primary source role", primary, setPrimary)}
        {sourceOptions("Flatfield source role", flatfield, setFlatfield)}
        {sourceOptions("Darkfield source role", darkfield, setDarkfield)}
        <button
          disabled={locked || !api.importRecipe || !primary}
          onClick={() => void importRecipe()}
        >
          Choose template and import
        </button>
        <details><summary>Template source mapping</summary><p>Templates save processing settings and source roles.
          Map each declared role once; leave unused references unselected.
          Import checks the selected sources and settings.</p></details>
      </section>

      <ResearchInterchangePanel
        api={api}
        result={selectedResult}
        report={report}
        busy={locked}
        onBusyChange={onBusyChange}
        onResult={onResult}
      />
      {status && <p className="research-portability-status" role="status">{status}</p>}
    </div>
  );
}
