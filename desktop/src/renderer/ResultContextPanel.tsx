import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchResultCliRecipe, ResearchResultContext, ResearchResultContextField } from "../shared/research-contracts";
import "./ResultContextPanel.css";

const CLI_RECIPE_ROUTE = "native-2d-level0-cpu-components-run-recipe";
const SHA256_RE = /^[a-f0-9]{64}$/u;
const CLI_RECIPE_COMMANDS = [
  'loci execute --project "$LOCI_STUDY" recipe_preflight --request @recipe.json --json',
  'loci submit --project "$LOCI_STUDY" --operation run_recipe --request @recipe.json --request-key "$NEW_KEY" --run --json',
].join("\n");

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validateContext(value: unknown, result: ResearchResult): ResearchResultContext {
  const context = value as ResearchResultContext;
  const replayStatus = context?.replay?.status;
  const cliStatus = context?.cli_recipe?.status;
  if (
    !isPlainRecord(context) ||
    context.schema !== "loci.result-context/v1" ||
    context.result_id !== result.id ||
    context.revision_hash !== result.revision_hash ||
    context.source_id !== result.source_id ||
    context.source_sha256 !== result.source_sha256 ||
    ![context.settings, context.runtime, context.model, context.importer, context.correction, context.parents, context.unavailable].every(Array.isArray) ||
    !isPlainRecord(context.replay) ||
    (replayStatus !== "available" && replayStatus !== "unsupported") ||
    (context.cli_recipe !== undefined &&
      (!isPlainRecord(context.cli_recipe) || (cliStatus !== "available" && cliStatus !== "unsupported")))
  ) {
    throw new Error("Analysis details do not match the selected result.");
  }
  return context;
}

function hasCliRecipe(context: ResearchResultContext | undefined): context is ResearchResultContext & {
  cli_recipe: ResearchResultCliRecipe & { status: "available"; route: typeof CLI_RECIPE_ROUTE; operation: "run_recipe"; recipe_sha256: string };
  replay: { status: "available"; operation: "run_recipe"; request: Record<string, unknown>; reason: string | null };
} {
  const cli = context?.cli_recipe;
  const request = context?.replay?.request;
  return Boolean(
    context &&
    cli &&
    cli.status === "available" &&
    cli.route === CLI_RECIPE_ROUTE &&
    cli.operation === "run_recipe" &&
    typeof cli.recipe_sha256 === "string" &&
    SHA256_RE.test(cli.recipe_sha256) &&
    context.replay.status === "available" &&
    context.replay.operation === "run_recipe" &&
    isPlainRecord(request) &&
    Object.keys(request).sort().join(",") === "recipe,selection,source_id" &&
    request.source_id === context.source_id &&
    isPlainRecord(request.selection) &&
    isPlainRecord(request.recipe)
  );
}

const label = (name: string) => name.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
const valueText = (value: ResearchResultContextField["value"]): string => value === null ? "Not recorded"
  : Array.isArray(value) ? value.map(valueText).join(", ") : typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
const technical = (field: ResearchResultContextField) => /sha256|hash|fingerprint|digest|^id$/u.test(field.name)
  || (typeof field.value === "string" && /^[a-f0-9]{32,}$/u.test(field.value));

function Fields({ fields }: { fields: ResearchResultContextField[] }) {
  if (!fields.length) return null;
  return <dl className="result-context-fields">{fields.map((field, index) => {
    const step = /(?:processing|steps)\[(\d+)\]/u.exec(field.source);
    return <div key={`${field.source}:${index}`}><dt title={field.source}>{step ? `Step ${Number(step[1]) + 1} · ` : ""}{label(field.name)}</dt>
      <dd>{valueText(field.value)}</dd></div>;
  })}</dl>;
}

export function ResultContextPanel({ api, result }: { api: ResearchDesktopApi; result: ResearchResult }) {
  const [open, setOpen] = useState(false);
  const [response, setResponse] = useState<{ key: string; context?: ResearchResultContext; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [cliCopyBusy, setCliCopyBusy] = useState(false);
  const [cliCopied, setCliCopied] = useState(false);
  const [cliCopyError, setCliCopyError] = useState<string | null>(null);
  const key = `${result.id}:${result.revision_hash}:${result.source_id}:${result.source_sha256}`;
  const mountedRef = useRef(true);
  const selectionKeyRef = useRef(key);
  const openRef = useRef(open);
  const copyTokenRef = useRef(0);
  selectionKeyRef.current = key;
  openRef.current = open;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    copyTokenRef.current += 1;
    setCopied(false); setCopyError(null);
    setCliCopyBusy(false); setCliCopied(false); setCliCopyError(null);
    if (!open) return;
    void api.execute("describe_result", { result_id: result.id, revision_hash: result.revision_hash }).then((value) => {
      if (!current) return;
      const context = validateContext(value, result);
      setResponse({ key, context });
    }).catch((error: unknown) => {
      if (current) setResponse({ key, error: error instanceof Error ? error.message : "Could not load analysis details." });
    });
    return () => {
      current = false;
      copyTokenRef.current += 1;
    };
  }, [api, key, open, result.id, result.revision_hash, result.source_id, result.source_sha256]);
  const current = response?.key === key ? response : null;
  const context = current?.context;
  const channelName = (index: number) => context?.channels.names?.find((entry) => entry.index === index)?.name ?? `Channel ${index + 1}`;
  const isCopyStillValid = (copyKey: string, token: number) =>
    mountedRef.current && openRef.current && selectionKeyRef.current === copyKey && copyTokenRef.current === token;
  const copyRequest = async () => {
    if (!context || context.replay.status !== "available" || !context.replay.operation || !context.replay.request) return;
    const copyKey = key;
    const token = ++copyTokenRef.current;
    setCliCopyBusy(false);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(JSON.stringify({ operation: context.replay.operation, request: context.replay.request }, null, 2));
      if (!isCopyStillValid(copyKey, token)) return;
      setCopied(true); setCopyError(null);
      setCliCopied(false); setCliCopyError(null);
    } catch {
      if (!isCopyStillValid(copyKey, token)) return;
      setCopied(false);
      setCopyError("Could not copy the analysis request.");
    }
  };
  const copyCliRecipe = async () => {
    if (!hasCliRecipe(context) || cliCopyBusy) return;
    const copyKey = key;
    const token = ++copyTokenRef.current;
    setCliCopyBusy(true); setCliCopied(false); setCliCopyError(null); setCopyError(null);
    let fresh: ResearchResultContext;
    try {
      const value = await api.execute("describe_result", { result_id: result.id, revision_hash: result.revision_hash });
      if (!isCopyStillValid(copyKey, token)) return;
      fresh = validateContext(value, result);
      setResponse({ key: copyKey, context: fresh });
    } catch (error: unknown) {
      if (!isCopyStillValid(copyKey, token)) return;
      setCliCopyBusy(false); setCopied(false); setCliCopied(false);
      setResponse({ key: copyKey, error: error instanceof Error ? error.message : "Could not verify the result before copying." });
      return;
    }
    if (!hasCliRecipe(fresh)) {
      setCliCopyBusy(false); setCliCopied(false);
      if (fresh.replay.status !== "available") setCopied(false);
      setCliCopyError(fresh.cli_recipe?.reason ?? "This result is not eligible for CLI recipe copy.");
      return;
    }
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(JSON.stringify(fresh.replay.request, null, 2));
      if (!isCopyStillValid(copyKey, token)) return;
      setCliCopied(true); setCopied(false); setCliCopyError(null); setCliCopyBusy(false);
    } catch {
      if (!isCopyStillValid(copyKey, token)) return;
      setCliCopied(false); setCliCopyError("Could not copy the CLI recipe JSON."); setCliCopyBusy(false);
    }
  };
  const cliRecipeAvailable = hasCliRecipe(context);
  return <details className="result-context" onToggle={(event) => {
    const nextOpen = event.currentTarget.open;
    if (!nextOpen) copyTokenRef.current += 1;
    setOpen(nextOpen);
  }}>
    <summary>Analysis details</summary>
    {open && <div className="result-context-body">
      {!current && <p role="status">Loading analysis details…</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {context && <>
        <dl className="result-context-fields">
          <div><dt>Method</dt><dd>{context.producing_method_label}</dd></div>
          {context.channels.segmentation !== null && <div><dt>Segmentation channel</dt><dd>{channelName(context.channels.segmentation)}</dd></div>}
          {context.channels.measurement && <div><dt>Measurement channels</dt><dd>{context.channels.measurement.map(channelName).join(", ")}</dd></div>}
          {context.measurement_basis && <div><dt>Measurements</dt><dd>{context.measurement_basis.replaceAll("-", " ")}</dd></div>}
          {context.selection && <div><dt>Region</dt><dd>{context.selection.width} × {context.selection.height}{context.selection.z_stop !== undefined ? ` × ${context.selection.z_stop - context.selection.z}` : ""}; X {context.selection.x}, Y {context.selection.y}; T {context.selection.t + 1}, Z {context.selection.z + 1}</dd></div>}
          {context.calibration && <div><dt>Coordinates</dt><dd>{context.calibration.axes} · {context.calibration.unit} · {context.calibration.frame}</dd></div>}
        </dl>
        {context.settings.length > 0 && <section><h3>Recorded settings</h3><Fields fields={context.settings.filter((field) => !technical(field))} /></section>}
        {context.correction.length > 0 && <section><h3>Correction</h3><Fields fields={context.correction.filter((field) => !technical(field))} /></section>}
        {context.importer.length > 0 && <section><h3>Imported labels</h3><Fields fields={context.importer.filter((field) => !technical(field))} /></section>}
        {context.model.length > 0 && <section><h3>Model</h3><Fields fields={context.model.filter((field) => !technical(field))} /></section>}
        {context.parents.length > 0 && <section><h3>Previous steps</h3><ol>{context.parents.map((parent) => <li key={parent.result_id}>{parent.method_label}</li>)}</ol></section>}
        {context.replay.status === "available" && <div className="result-context-actions">
          <button type="button" onClick={() => void copyRequest()}>{copied ? "Request copied" : "Copy analysis request"}</button>
          {cliRecipeAvailable && <button type="button" disabled={cliCopyBusy} aria-busy={cliCopyBusy || undefined} onClick={() => void copyCliRecipe()}>{cliCopyBusy ? "Verifying recipe…" : cliCopied ? "CLI recipe copied" : "Copy CLI recipe JSON"}</button>}
        </div>}
        {cliCopied && <p role="status">Copied recipe.json request for the verified result.</p>}
        {copyError && <p role="alert">{copyError}</p>}
        {cliCopyError && <p role="alert">{cliCopyError}</p>}
        {cliRecipeAvailable && <details className="result-context-cli"><summary>Run from CLI</summary>
          <p>Save the copied JSON as <code>recipe.json</code>, then validate and run it in this same saved study with the same registered source. If this workspace is an unsaved managed session, use <strong>Save study…</strong> first so <code>$LOCI_STUDY</code> points to a <code>.loci-study</code> directory. Choose a fresh <code>$NEW_KEY</code> for an intentional new run (reuse the same key only to retry the same job). Copying makes no analysis, review, or job changes.</p>
          <pre className="result-context-command"><code>{CLI_RECIPE_COMMANDS}</code></pre>
          <p className="result-context-note">For the packaged macOS app, add <code>Loci.app/Contents/Resources/bin</code> to <code>PATH</code> (or run <code>Loci.app/Contents/Resources/bin/loci</code>). Preflight reports normalized settings and allocation estimates; fresh source-byte verification belongs to the verified result and engine path.</p>
        </details>}
        <details><summary>Technical record</summary>
          <dl className="result-context-fields"><div><dt>Result</dt><dd>{context.result_id}</dd></div>
            <div><dt>Revision</dt><dd>{context.revision_hash}</dd></div><div><dt>Source fingerprint</dt><dd>{context.source_sha256}</dd></div>
            {cliRecipeAvailable && <div><dt>Recipe SHA-256</dt><dd>{context.cli_recipe.recipe_sha256}</dd></div>}
            {context.engine_version && <div><dt>Loci engine</dt><dd>{context.engine_version}</dd></div>}</dl>
          <Fields fields={[...context.settings, ...context.correction, ...context.importer, ...context.model].filter(technical)} />
          <Fields fields={context.runtime} />
          {context.unavailable.length > 0 && <p>Not recorded: {context.unavailable.join(", ")}</p>}
          {context.replay.status === "unsupported" && <p>{context.replay.reason}</p>}
          {context.cli_recipe?.status === "unsupported" && context.cli_recipe.reason && context.cli_recipe.reason !== context.replay.reason && <p>CLI recipe copy unavailable: {context.cli_recipe.reason}</p>}
        </details>
      </>}
    </div>}
  </details>;
}
