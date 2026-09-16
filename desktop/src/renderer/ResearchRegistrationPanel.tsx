import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ResearchDesktopApi,
  ResearchResult,
  ResearchSnapshot,
} from "../shared/research-contracts";

type Report = <T>(
  work: () => Promise<T>,
  fallback: string,
) => Promise<T | undefined>;
type Method = "translation_phase_correlation" | "sitk_rigid";
type OutputSpec = {
  array: string;
  output_name: string;
  kind: "scalar" | "labels";
  interpolation: "linear" | "nearest";
  default_value: number;
};
export type RegistrationReceipt = {
  schema: "loci.registration-preview/v1";
  fixed: { result_id: string; revision_hash: string; array: string };
  moving: { result_id: string; revision_hash: string; array: string };
  method: Method;
  settings: Record<string, unknown>;
  outputs: OutputSpec[];
  working_bytes: number;
  transform: {
    moving_to_fixed: { direction: string; homogeneous_matrix: number[][] };
    fixed_to_moving: { direction: string; homogeneous_matrix: number[][] };
  };
  output_grid: {
    shape: number[];
    geometry: { axes: string; affine: number[][]; unit: string; frame?: string };
  };
  quality: Record<string, unknown>;
  meaning: string;
};
type PendingPreview = {
  preview: RegistrationReceipt;
  preview_json: string;
  preview_sha256: string;
};

const WORKING_BYTES = 512 * 1024 ** 2;

function resultLabel(result: ResearchResult, snapshot: ResearchSnapshot): string {
  const source = snapshot.sources.find((item) => item.id === result.source_id);
  return `${source?.name ?? "Source"} · ${result.kind} · ${result.id.slice(0, 8)}…`;
}

function scalarArrays(result: ResearchResult | undefined): string[] {
  const axes = result?.geometry?.axes;
  if (axes !== "YX" && axes !== "ZYX") return [];
  return Object.entries(result?.arrays ?? {}).flatMap(([name, descriptor]) => {
    const shape = descriptor.shape;
    const dtype = descriptor.dtype;
    const labelLikeInteger = /label/i.test(name) &&
      typeof dtype === "string" && /^(?:u?int|bool)/i.test(dtype);
    return Array.isArray(shape) &&
      shape.length === axes.length &&
      shape.every((size) => Number.isSafeInteger(size) && size > 0) &&
      typeof dtype === "string" &&
      /^(?:u?int|float|bool)/i.test(dtype) &&
      !labelLikeInteger
      ? [name]
      : [];
  });
}

function canonicalEqual(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (Array.isArray(first) || Array.isArray(second))
    return Array.isArray(first) && Array.isArray(second) &&
      first.length === second.length &&
      first.every((item, index) => canonicalEqual(item, second[index]));
  if (!first || !second || typeof first !== "object" || typeof second !== "object")
    return false;
  const firstRecord = first as Record<string, unknown>;
  const secondRecord = second as Record<string, unknown>;
  const firstKeys = Object.keys(firstRecord).sort();
  const secondKeys = Object.keys(secondRecord).sort();
  return canonicalEqual(firstKeys, secondKeys) &&
    firstKeys.every((key) => canonicalEqual(firstRecord[key], secondRecord[key]));
}

function resolvedSettings(
  method: Method,
  requested: Record<string, unknown>,
): Record<string, unknown> {
  return method === "translation_phase_correlation"
    ? { ...requested, threads: 1, seed: 0 }
    : {
        metric: "mean_squares",
        optimizer: "regular_step_gradient_descent",
        ...requested,
        shrink_factors: [4, 2, 1],
        smoothing_sigmas_physical: [2, 1, 0],
        sampling: "all",
        threads: 1,
        seed: 0,
      };
}

function hasMatchingLabels(result: ResearchResult | undefined, array: string): boolean {
  const scalarShape = result?.arrays?.[array]?.shape;
  const labelShape = result?.arrays?.labels?.shape;
  return Boolean(
    scalarShape &&
      labelShape &&
      scalarShape.length === labelShape.length &&
      scalarShape.every((size, index) => size === labelShape[index]),
  );
}

function parseVector(value: string, integer: boolean): number[] | null {
  const entries = value.split(",").map((item) => Number(item.trim()));
  if (
    !entries.length ||
    entries.some(
      (item) => !Number.isFinite(item) || (integer && !Number.isSafeInteger(item)),
    )
  )
    return null;
  return entries;
}

function arraySpacing(result: ResearchResult | undefined, dimensions: number): number[] {
  const affine = result?.geometry?.affine;
  if (
    !affine ||
    affine.length < 3 ||
    affine.some((row) => !Array.isArray(row) || row.length < 3)
  )
    return Array.from({ length: dimensions }, () => 1);
  const xyz = [0, 1, 2].map((column) =>
    Math.hypot(affine[0][column], affine[1][column], affine[2][column]),
  );
  return xyz.slice(0, dimensions).reverse();
}

function outputSpecs(
  moving: ResearchResult,
  scalarArray: string,
  interpolation: "linear" | "nearest",
  includeLabels: boolean,
): OutputSpec[] {
  const output: OutputSpec[] = [
    {
      array: scalarArray,
      output_name: "image",
      kind: "scalar",
      interpolation,
      default_value: 0,
    },
  ];
  if (includeLabels && moving.arrays?.labels)
    output.push({
      array: "labels",
      output_name: "labels",
      kind: "labels",
      interpolation: "nearest",
      default_value: 0,
    });
  return output;
}

function validResult(value: unknown, parent: ResearchResult): ResearchResult {
  if (!value || typeof value !== "object")
    throw new Error("Registration returned no immutable derived result.");
  const result = value as ResearchResult;
  if (
    typeof result.id !== "string" ||
    result.id === parent.id ||
    result.parent_id !== parent.id ||
    result.source_id !== parent.source_id ||
    typeof result.revision_hash !== "string" ||
    !["registered-derived", "resampled-derived"].includes(result.kind)
  )
    throw new Error("Registration returned an invalid derived result revision.");
  return result;
}

function validPreview(
  value: unknown,
  fixed: ResearchResult,
  moving: ResearchResult,
  fixedArray: string,
  movingArray: string,
  method: Method,
  expectedSettings: Record<string, unknown>,
  expectedOutputs: OutputSpec[],
  expectedWorkingBytes: number,
): PendingPreview {
  if (!value || typeof value !== "object")
    throw new Error("Registration preview returned no exact receipt.");
  const output = value as Partial<PendingPreview>;
  const preview = output.preview;
  if (
    !preview ||
    preview.schema !== "loci.registration-preview/v1" ||
    output.preview_sha256 === undefined ||
    typeof output.preview_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(output.preview_sha256) ||
    typeof output.preview_json !== "string" ||
    output.preview_json.length > 1024 ** 2 ||
    preview.fixed?.result_id !== fixed.id ||
    preview.fixed.revision_hash !== fixed.revision_hash ||
    preview.fixed.array !== fixedArray ||
    preview.moving?.result_id !== moving.id ||
    preview.moving.revision_hash !== moving.revision_hash ||
    preview.moving.array !== movingArray ||
    preview.method !== method ||
    !canonicalEqual(preview.settings, expectedSettings) ||
    !canonicalEqual(preview.outputs, expectedOutputs) ||
    preview.working_bytes !== expectedWorkingBytes ||
    !Array.isArray(preview.transform?.moving_to_fixed?.homogeneous_matrix) ||
    !Array.isArray(preview.output_grid?.shape) ||
    !preview.quality ||
    typeof preview.quality !== "object"
  )
    throw new Error("Registration preview did not match the exact selected inputs.");
  if (!canonicalEqual(JSON.parse(output.preview_json), preview))
    throw new Error("The displayed registration differs from its exact preview bytes.");
  return {
    preview,
    preview_json: output.preview_json,
    preview_sha256: output.preview_sha256,
  };
}

export function ResearchRegistrationPanel({
  api,
  snapshot,
  report,
  busy,
  onBusyChange,
  onOpenResult,
  onPublished,
}: {
  api: ResearchDesktopApi;
  snapshot: ResearchSnapshot;
  report: Report;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onOpenResult: (result: ResearchResult) => Promise<void>;
  onPublished: (result: ResearchResult) => Promise<void>;
}): React.JSX.Element {
  const results = snapshot.results.filter((result) => scalarArrays(result).length > 0);
  const [mode, setMode] = useState<"register" | "grid">("register");
  const [fixedId, setFixedId] = useState(results[0]?.id ?? "");
  const [movingId, setMovingId] = useState(results[1]?.id ?? results[0]?.id ?? "");
  const fixed = results.find((result) => result.id === fixedId);
  const moving = results.find((result) => result.id === movingId);
  const fixedChoices = scalarArrays(fixed);
  const movingChoices = scalarArrays(moving);
  const [fixedArray, setFixedArray] = useState("image");
  const [movingArray, setMovingArray] = useState("image");
  const [method, setMethod] = useState<Method>("translation_phase_correlation");
  const [upsample, setUpsample] = useState("20");
  const [minimumCorrelation, setMinimumCorrelation] = useState("0.25");
  const [iterations, setIterations] = useState("200");
  const [learningRate, setLearningRate] = useState("1");
  const [minimumStep, setMinimumStep] = useState("0.0001");
  const [rigidCorrelation, setRigidCorrelation] = useState("0.25");
  const [minimumOverlap, setMinimumOverlap] = useState("0.25");
  const [scalarInterpolation, setScalarInterpolation] = useState<"linear" | "nearest">(
    "linear",
  );
  const [includeLabels, setIncludeLabels] = useState(false);
  const [workingBytes, setWorkingBytes] = useState(WORKING_BYTES);
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const [parentId, setParentId] = useState(results[0]?.id ?? "");
  const parent = results.find((result) => result.id === parentId);
  const parentChoices = scalarArrays(parent);
  const [parentArray, setParentArray] = useState("image");
  const [gridStart, setGridStart] = useState("");
  const [gridShape, setGridShape] = useState("");
  const [gridSpacing, setGridSpacing] = useState("");
  const [gridInterpolation, setGridInterpolation] = useState<"linear" | "nearest">(
    "linear",
  );
  const [gridLabels, setGridLabels] = useState(false);
  const previewGeneration = useRef(0);

  useEffect(() => {
    if (!fixedChoices.includes(fixedArray)) setFixedArray(fixedChoices[0] ?? "");
  }, [fixedArray, fixedChoices]);
  useEffect(() => {
    if (!movingChoices.includes(movingArray)) setMovingArray(movingChoices[0] ?? "");
  }, [movingArray, movingChoices]);
  useEffect(() => {
    if (!hasMatchingLabels(moving, movingArray)) setIncludeLabels(false);
  }, [moving?.id, movingArray]);
  useEffect(() => {
    previewGeneration.current += 1;
    setPending(null);
  }, [
    fixedId,
    movingId,
    fixedArray,
    movingArray,
    method,
    upsample,
    minimumCorrelation,
    iterations,
    learningRate,
    minimumStep,
    rigidCorrelation,
    minimumOverlap,
    scalarInterpolation,
    includeLabels,
    workingBytes,
  ]);
  useEffect(() => {
    if (!parent) return;
    const choices = scalarArrays(parent);
    const selected = choices.includes(parentArray) ? parentArray : (choices[0] ?? "");
    setParentArray(selected);
    const shape = parent.arrays?.[selected]?.shape ?? [];
    setGridStart(shape.map(() => 0).join(", "));
    setGridShape(shape.join(", "));
    setGridSpacing(arraySpacing(parent, shape.length).join(", "));
    setGridLabels(false);
  }, [parentArray, parentId]);

  const registrationSettings = useMemo<Record<string, unknown>>(
    () =>
      method === "translation_phase_correlation"
        ? {
            upsample_factor: Number(upsample),
            min_normalized_correlation: Number(minimumCorrelation),
          }
        : {
            iterations: Number(iterations),
            learning_rate: Number(learningRate),
            minimum_step: Number(minimumStep),
            min_correlation: Number(rigidCorrelation),
            min_overlap: Number(minimumOverlap),
          },
    [
      iterations,
      learningRate,
      method,
      minimumCorrelation,
      minimumOverlap,
      minimumStep,
      rigidCorrelation,
      upsample,
    ],
  );
  const numericSettingsValid =
    Object.values(registrationSettings).every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ) &&
    (method === "translation_phase_correlation"
      ? Number.isSafeInteger(Number(upsample)) &&
        Number(upsample) >= 1 &&
        Number(upsample) <= 200 &&
        Number(minimumCorrelation) >= -1 &&
        Number(minimumCorrelation) <= 1
      : Number.isSafeInteger(Number(iterations)) &&
        Number(iterations) >= 1 &&
        Number(iterations) <= 1000 &&
        Number(learningRate) >= 0.000001 &&
        Number(learningRate) <= 100 &&
        Number(minimumStep) >= 0.000000001 &&
        Number(minimumStep) <= 10 &&
        Number(rigidCorrelation) >= -1 &&
        Number(rigidCorrelation) <= 1 &&
        Number(minimumOverlap) >= 0.01 &&
        Number(minimumOverlap) <= 1);
  const canPreview = Boolean(
    !busy &&
      fixed &&
      moving &&
      fixed.id !== moving.id &&
      fixedArray &&
      movingArray &&
      numericSettingsValid,
  );

  const preview = async () => {
    if (!canPreview || !fixed || !moving) return;
    const generation = ++previewGeneration.current;
    const expectedOutputs = outputSpecs(
      moving,
      movingArray,
      scalarInterpolation,
      includeLabels,
    );
    onBusyChange(true);
    try {
      const output = await report(async () => {
        const request = {
          fixed: {
            result_id: fixed.id,
            revision_hash: fixed.revision_hash,
            array: fixedArray,
          },
          moving: {
            result_id: moving.id,
            revision_hash: moving.revision_hash,
            array: movingArray,
          },
          method,
          settings: registrationSettings,
          outputs: expectedOutputs,
          working_bytes: workingBytes,
        };
        return validPreview(
          await api.execute("registration_preview", request),
          fixed,
          moving,
          fixedArray,
          movingArray,
          method,
          resolvedSettings(method, registrationSettings),
          expectedOutputs,
          workingBytes,
        );
      }, "Could not estimate this exact registration preview.");
      if (output && generation === previewGeneration.current) setPending(output);
    } finally {
      onBusyChange(false);
    }
  };

  const adopt = async () => {
    if (!pending || !moving || busy) return;
    onBusyChange(true);
    try {
      const output = await report(async () => {
        const value = (await api.execute("registration_run", {
          preview_json: pending.preview_json,
          preview_sha256: pending.preview_sha256,
        })) as { result?: unknown; adopted?: unknown };
        if (value.adopted !== true)
          throw new Error("The exact registration preview was not adopted.");
        return validResult(value.result, moving);
      }, "Could not adopt the exact registration receipt.");
      if (output) {
        setPending(null);
        await onPublished(output);
      }
    } finally {
      onBusyChange(false);
    }
  };

  const parsedStart = parseVector(gridStart, true);
  const parsedShape = parseVector(gridShape, true);
  const parsedSpacing = parseVector(gridSpacing, false);
  const parentShape = parent?.arrays?.[parentArray]?.shape ?? [];
  const parentSpacing = arraySpacing(parent, parentShape.length);
  const gridValid = Boolean(
    !busy &&
      parent &&
      parentArray &&
      parsedStart &&
      parsedShape &&
      parsedSpacing &&
      parsedStart.length === parentShape.length &&
      parsedShape.length === parentShape.length &&
      parsedSpacing.length === parentShape.length &&
      parsedStart.every((value, index) => value >= 0 && value < parentShape[index]) &&
      parsedShape.every((value) => value >= 1) &&
      parsedSpacing.every((value) => value > 0) &&
      parsedShape.every(
        (value, index) =>
          parsedStart[index] +
            ((value - 1) * parsedSpacing[index]) / parentSpacing[index] <=
          parentShape[index] - 1 + 1e-9,
      ),
  );
  const runGrid = async () => {
    if (!gridValid || !parent || !parsedStart || !parsedShape || !parsedSpacing) return;
    onBusyChange(true);
    try {
      const output = await report(async () => {
        const value = (await api.execute("resample_grid", {
          parent: {
            result_id: parent.id,
            revision_hash: parent.revision_hash,
            array: parentArray,
          },
          grid: { start: parsedStart, shape: parsedShape, spacing: parsedSpacing },
          outputs: outputSpecs(parent, parentArray, gridInterpolation, gridLabels),
          working_bytes: workingBytes,
        })) as { result?: unknown; adopted?: unknown };
        if (value.adopted !== true)
          throw new Error("The declared output grid was not published.");
        return validResult(value.result, parent);
      }, "Could not publish this bounded physical output grid.");
      if (output) await onPublished(output);
    } finally {
      onBusyChange(false);
    }
  };

  return (
    <div className="research-panel research-registration">
      <h2>Registration & physical grids</h2>
      <div className="research-mode-tabs" role="tablist" aria-label="Registration mode">
        <button
          role="tab"
          aria-selected={mode === "register"}
          className={mode === "register" ? "active" : ""}
          onClick={() => setMode("register")}
        >
          Register
        </button>
        <button
          role="tab"
          aria-selected={mode === "grid"}
          className={mode === "grid" ? "active" : ""}
          onClick={() => setMode("grid")}
        >
          Resample grid
        </button>
      </div>
      {mode === "register" ? (
        <>
          <p>
            Estimate a technical transform between exact immutable result arrays. Preview
            quality does not establish anatomical, biological, or clinical correctness.
          </p>
          <label>
            Fixed result
            <select
              aria-label="Registration fixed result"
              value={fixedId}
              onChange={(event) => setFixedId(event.target.value)}
            >
              <option value="">Choose fixed…</option>
              {results.map((result) => (
                <option key={result.id} value={result.id}>{resultLabel(result, snapshot)}</option>
              ))}
            </select>
          </label>
          <label>
            Fixed scalar array
            <select
              aria-label="Registration fixed array"
              value={fixedArray}
              onChange={(event) => setFixedArray(event.target.value)}
            >
              {fixedChoices.map((array) => <option key={array}>{array}</option>)}
            </select>
          </label>
          <button disabled={!fixed || busy} onClick={() => fixed && void onOpenResult(fixed)}>
            Open fixed result
          </button>
          <label>
            Moving result
            <select
              aria-label="Registration moving result"
              value={movingId}
              onChange={(event) => setMovingId(event.target.value)}
            >
              <option value="">Choose moving…</option>
              {results.map((result) => (
                <option key={result.id} value={result.id}>{resultLabel(result, snapshot)}</option>
              ))}
            </select>
          </label>
          <label>
            Moving scalar array
            <select
              aria-label="Registration moving array"
              value={movingArray}
              onChange={(event) => setMovingArray(event.target.value)}
            >
              {movingChoices.map((array) => <option key={array}>{array}</option>)}
            </select>
          </label>
          <button disabled={!moving || busy} onClick={() => moving && void onOpenResult(moving)}>
            Open moving result
          </button>
          <label>
            Method
            <select
              aria-label="Registration method"
              value={method}
              onChange={(event) => setMethod(event.target.value as Method)}
            >
              <option value="translation_phase_correlation">Phase-correlation translation</option>
              <option value="sitk_rigid">SimpleITK rigid</option>
            </select>
          </label>
          <div className="research-grid">
            {method === "translation_phase_correlation" ? (
              <>
                <label>
                  Upsample factor
                  <input
                    aria-label="Registration upsample factor"
                    type="number"
                    min="1"
                    max="200"
                    value={upsample}
                    onChange={(event) => setUpsample(event.target.value)}
                  />
                </label>
                <label>
                  Minimum normalized correlation
                  <input
                    aria-label="Registration minimum normalized correlation"
                    type="number"
                    min="-1"
                    max="1"
                    step="any"
                    value={minimumCorrelation}
                    onChange={(event) => setMinimumCorrelation(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Iterations
                  <input aria-label="Rigid iterations" type="number" min="1" max="1000" value={iterations} onChange={(event) => setIterations(event.target.value)} />
                </label>
                <label>
                  Learning rate
                  <input aria-label="Rigid learning rate" type="number" min="0.000001" step="any" value={learningRate} onChange={(event) => setLearningRate(event.target.value)} />
                </label>
                <label>
                  Minimum step
                  <input aria-label="Rigid minimum step" type="number" min="0.000000001" step="any" value={minimumStep} onChange={(event) => setMinimumStep(event.target.value)} />
                </label>
                <label>
                  Minimum correlation
                  <input aria-label="Rigid minimum correlation" type="number" min="-1" max="1" step="any" value={rigidCorrelation} onChange={(event) => setRigidCorrelation(event.target.value)} />
                </label>
                <label>
                  Minimum overlap
                  <input aria-label="Rigid minimum overlap" type="number" min="0.01" max="1" step="any" value={minimumOverlap} onChange={(event) => setMinimumOverlap(event.target.value)} />
                </label>
              </>
            )}
          </div>
          <label>
            Scalar interpolation
            <select aria-label="Registration scalar interpolation" value={scalarInterpolation} onChange={(event) => setScalarInterpolation(event.target.value as "linear" | "nearest")}>
              <option value="linear">Linear</option>
              <option value="nearest">Nearest</option>
            </select>
          </label>
          <label className="research-check">
            <input
              type="checkbox"
              aria-label="Include moving labels"
              checked={includeLabels}
              disabled={!hasMatchingLabels(moving, movingArray)}
              onChange={(event) => setIncludeLabels(event.target.checked)}
            />
            Resample the moving labels array with nearest-neighbour interpolation.
          </label>
          <label>
            Working-memory budget
            <select
              aria-label="Registration working-memory budget"
              value={workingBytes}
              onChange={(event) => setWorkingBytes(Number(event.target.value))}
            >
              {[512 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 3, 4 * 1024 ** 3].map(
                (value) => (
                  <option key={value} value={value}>
                    {value / 1024 ** 3} GiB
                  </option>
                ),
              )}
            </select>
          </label>
          <div className="research-actions">
            <button disabled={!canPreview} onClick={() => void preview()}>
              Preview exact registration
            </button>
            <button className="research-primary" disabled={busy || !pending} onClick={() => void adopt()}>
              Adopt this exact receipt
            </button>
          </div>
          {pending && (
            <section aria-label="Exact registration preview">
              <p>
                Receipt {pending.preview_sha256.slice(0, 12)}… · {pending.preview.meaning}
              </p>
              <h3>Moving XYZ world → fixed XYZ world</h3>
              <table className="research-matrix">
                <tbody>
                  {pending.preview.transform.moving_to_fixed.homogeneous_matrix.map((row, index) => (
                    <tr key={index}>{row.map((value, column) => <td key={column}>{value}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              <p>
                Output grid {pending.preview.output_grid.geometry.axes} [{pending.preview.output_grid.shape.join(", ")}] · {pending.preview.output_grid.geometry.unit}
              </p>
              <h3>Measured technical quality</h3>
              <dl className="research-kv">
                {Object.entries(pending.preview.quality).map(([key, value]) => (
                  <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>
                ))}
              </dl>
            </section>
          )}
        </>
      ) : (
        <>
          <p>
            Create an immutable derived result on a declared crop, shape, and physical
            spacing within the parent world grid. Array-axis order remains explicit.
          </p>
          <label>
            Parent exact result
            <select aria-label="Grid parent result" value={parentId} onChange={(event) => setParentId(event.target.value)}>
              <option value="">Choose parent…</option>
              {results.map((result) => <option key={result.id} value={result.id}>{resultLabel(result, snapshot)}</option>)}
            </select>
          </label>
          <label>
            Parent scalar array
            <select aria-label="Grid parent array" value={parentArray} onChange={(event) => setParentArray(event.target.value)}>
              {parentChoices.map((array) => <option key={array}>{array}</option>)}
            </select>
          </label>
          <button disabled={!parent || busy} onClick={() => parent && void onOpenResult(parent)}>
            Open parent result
          </button>
          <p>
            Grid vectors follow {parent?.geometry?.axes ?? "the parent array axes"}; spacing is in {parent?.geometry?.unit ?? "the declared physical unit"}.
          </p>
          <label>
            Crop start
            <input aria-label="Grid crop start" value={gridStart} onChange={(event) => setGridStart(event.target.value)} />
          </label>
          <label>
            Output shape
            <input aria-label="Grid output shape" value={gridShape} onChange={(event) => setGridShape(event.target.value)} />
          </label>
          <label>
            Physical spacing
            <input aria-label="Grid physical spacing" value={gridSpacing} onChange={(event) => setGridSpacing(event.target.value)} />
          </label>
          <label>
            Scalar interpolation
            <select aria-label="Grid scalar interpolation" value={gridInterpolation} onChange={(event) => setGridInterpolation(event.target.value as "linear" | "nearest")}>
              <option value="linear">Linear</option>
              <option value="nearest">Nearest</option>
            </select>
          </label>
          <label className="research-check">
            <input type="checkbox" aria-label="Include parent labels" checked={gridLabels} disabled={!hasMatchingLabels(parent, parentArray)} onChange={(event) => setGridLabels(event.target.checked)} />
            Resample the parent labels array as exact nearest-neighbour labels.
          </label>
          <label>
            Working-memory budget
            <select
              aria-label="Grid working-memory budget"
              value={workingBytes}
              onChange={(event) => setWorkingBytes(Number(event.target.value))}
            >
              {[512 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 3, 4 * 1024 ** 3].map(
                (value) => (
                  <option key={value} value={value}>
                    {value / 1024 ** 3} GiB
                  </option>
                ),
              )}
            </select>
          </label>
          {!gridValid && <p role="alert">Start, shape, and positive spacing must match the parent array axes and remain within its declared grid.</p>}
          <p className="research-derived-notice">
            Publishing creates an immutable resampled-derived child. Scalar measurements are REGISTERED-DERIVED values on the output grid.
          </p>
          <button className="research-primary" disabled={!gridValid} onClick={() => void runGrid()}>
            Publish declared output grid
          </button>
        </>
      )}
    </div>
  );
}
