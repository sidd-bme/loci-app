import { useEffect, useId, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchLabelsImportPreview, ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";

export function labelsImportUnavailable(source: ResearchSource, selection: ResearchSelection): string | null {
  const dimensions = source.metadata.dimensions;
  if (source.locator_state === "relink-required") return "Relink the source before importing labels.";
  if (source.source_kind && source.source_kind !== "native") return "Choose a native scalar source image.";
  if (["rgb", "rgba"].includes(source.metadata.sample_semantics?.toLowerCase() ?? "") || (dimensions?.s ?? 1) !== 1 || source.metadata.axes?.includes("S"))
    return "Choose a scalar source channel; RGB samples cannot receive this label profile.";
  if (!dimensions || selection.level !== 0 || selection.z_stop !== undefined || selection.x !== 0 || selection.y !== 0 ||
      selection.width !== dimensions.x || selection.height !== dimensions.y)
    return "Choose one full level-0 YX plane without a crop or volume selection.";
  return null;
}

function sameSelection(left: ResearchSelection, right: ResearchSelection): boolean {
  return ["x", "y", "width", "height", "t", "c", "z", "level", "z_stop"].every((key) =>
    left[key as keyof ResearchSelection] === right[key as keyof ResearchSelection]);
}

export function checkedLabelsPreview(value: ResearchLabelsImportPreview, source: ResearchSource, selection: ResearchSelection, workingBytes: number): ResearchLabelsImportPreview {
  if (!value || value.source_id !== source.id || value.source_sha256 !== source.sha256 || !value.selection || !sameSelection(value.selection, selection) ||
      value.working_bytes !== workingBytes || typeof value.grant_id !== "string" || !/^[a-f0-9]{32}$/u.test(value.grant_id) ||
      value.axes !== "YX" || value.profile !== "scalar-native-yx/v1" || value.format !== "TIFF" ||
      !["uint8", "uint16", "uint32"].includes(value.original_dtype) || !Array.isArray(value.shape) ||
      value.shape.length !== 2 || value.shape[0] !== selection.height || value.shape[1] !== selection.width ||
      !Number.isSafeInteger(value.object_count) || value.object_count < 0 || value.object_count > 100000 ||
      typeof value.file_name !== "string" || !value.file_name || /[/\\]/u.test(value.file_name) ||
      !/^[a-f0-9]{64}$/u.test(value.file_sha256) || !/^[a-f0-9]{64}$/u.test(value.labels_sha256) ||
      value.measurement_channel?.index !== selection.c || value.measurement_channel.basis !== "raw-source-channel-values" ||
      typeof value.measurement_channel.name !== "string" || typeof value.image !== "string" || !value.image.startsWith("data:image/png;base64,") ||
      !Number.isSafeInteger(value.preview_width) || value.preview_width < 1 || value.preview_width > 1024 ||
      !Number.isSafeInteger(value.preview_height) || value.preview_height < 1 || value.preview_height > 1024)
    throw new Error("The label preview did not match this exact native source plane. Choose the TIFF again.");
  return value;
}

export function ResearchLabelsImportPanel({ api, source, selection, workingBytes, scope, busy, onBusy, onResult, navigationIntent }: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection; workingBytes: number; scope: string;
  busy: boolean; onBusy: (message: string | null, owner: string) => void;
  onResult: (result: ResearchResult, measurements: Array<Record<string, unknown>> | undefined, isCurrent: () => boolean) => Promise<void>;
  navigationIntent?: () => number;
}) {
  const binding = JSON.stringify([scope, source.id, source.sha256, selection, workingBytes]);
  const liveBinding = useRef(binding);
  liveBinding.current = binding;
  const request = useRef(0);
  const ownerId = useId();
  const mounted = useRef(true);
  const [preview, setPreview] = useState<{ binding: string; data: ResearchLabelsImportPreview } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [producerName, setProducerName] = useState("");
  const [producerVersion, setProducerVersion] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  useEffect(() => { setPreview(null); setError(null); }, [binding]);
  const checked = preview?.binding === binding ? preview.data : null;
  const producerError = producerVersion.trim() && !producerName.trim() ? "Enter a producer name with the version, or leave both unknown." :
    [producerName, producerVersion].some((value) => /[/\\\u0000-\u001f\u007f]/u.test(value) || value.length > 128)
      ? "Use a producer name and version without file paths or control characters." : null;
  const reason = labelsImportUnavailable(source, selection);
  const locked = busy || pending;
  const currentRequest = (token: number, captured: string) => mounted.current && request.current === token && liveBinding.current === captured;
  const choose = async () => {
    if (!api.labelsImportPreview || locked || reason) return;
    const token = ++request.current;
    const captured = binding;
    const intent = navigationIntent?.();
    const isCurrent = () => currentRequest(token, captured) && navigationIntent?.() === intent;
    const owner = `${ownerId}:${token}`;
    setPending(true); setError(null); setPreview(null); onBusy("Checking label TIFF", owner);
    try {
      // The workbench represents returning from a volume with z_stop: undefined.
      // Send only the explicit plane fields, while rejecting any defined slab above.
      const plane: ResearchSelection = { x: selection.x, y: selection.y, width: selection.width, height: selection.height,
        t: selection.t, c: selection.c, z: selection.z, level: selection.level };
      const value = await api.labelsImportPreview({ source_id: source.id, source_sha256: source.sha256, selection: plane, working_bytes: workingBytes });
      if (isCurrent() && value) setPreview({ binding: captured, data: checkedLabelsPreview(value, source, selection, workingBytes) });
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : "Could not check the selected label TIFF.");
    } finally { if (mounted.current) setPending(false); onBusy(null, owner); }
  };
  const adopt = async () => {
    if (!checked || locked || reason || producerError) return;
    const token = ++request.current;
    const captured = binding;
    const intent = navigationIntent?.();
    const isCurrent = () => currentRequest(token, captured) && navigationIntent?.() === intent;
    const owner = `${ownerId}:${token}`;
    setPending(true); setError(null); onBusy("Importing labels", owner);
    try {
      const output = await api.execute("labels_import", {
        source_id: checked.source_id, source_sha256: checked.source_sha256, grant_id: checked.grant_id,
        alignment: "same-native-yx-grid",
        ...(producerName.trim() ? { producer: { name: producerName.trim(), ...(producerVersion.trim() ? { version: producerVersion.trim() } : {}) } } : {}),
      }) as { result?: ResearchResult; measurements?: Array<Record<string, unknown>> };
      const result = output?.result;
      if (!result || result.source_id !== source.id || result.source_sha256 !== source.sha256 || !result.selection ||
          !sameSelection(result.selection, selection) || result.review != null || !/^[a-f0-9]{32}$/u.test(result.id) || !/^[a-f0-9]{64}$/u.test(result.revision_hash))
        throw new Error("Label import did not return an unreviewed result for the checked native plane.");
      if (isCurrent()) {
        await onResult(result, output.measurements, isCurrent);
        if (isCurrent()) setPreview(null);
      }
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : "Could not import the checked labels.");
    } finally { if (mounted.current) setPending(false); onBusy(null, owner); }
  };
  return <section className="research-label-import research-panel" aria-label="Import external labels">
    <h3>External labels</h3>
    <button type="button" disabled={locked || Boolean(reason) || !api.labelsImportPreview} onClick={() => void choose()}>Import labels</button>
    {reason && <p>{reason}</p>}
    {pending && <p role="status">{checked ? "Importing labels…" : "Checking label TIFF…"}</p>}
    {error && <p role="alert">{error}</p>}
    {checked && <>
      <img className="research-label-import-preview" src={checked.image} alt="Checked label overlay on the selected source plane" width={checked.preview_width} height={checked.preview_height} />
      <dl className="research-label-import-metadata">
        <div><dt>Label file</dt><dd>{checked.file_name}</dd></div>
        <div><dt>Objects</dt><dd>{checked.object_count.toLocaleString()}{checked.object_count === 0 ? " · empty population" : ""}</dd></div>
        <div><dt>Input</dt><dd>{checked.original_dtype} · {checked.shape.join(" × ")} YX</dd></div>
        <div><dt>Source grid</dt><dd>{source.name} · native level 0 · T {selection.t} / C {selection.c} / Z {selection.z}</dd></div>
        <div><dt>Measurement channel</dt><dd>{checked.measurement_channel.name} · raw source values</dd></div>
      </dl>
      <div className="research-grid">
        <label>Producer name (optional)<input aria-label="Producer name (optional)" maxLength={128} value={producerName} disabled={locked} placeholder="Unknown" onChange={(event) => setProducerName(event.target.value)} /></label>
        <label>Producer version (optional)<input aria-label="Producer version (optional)" maxLength={128} value={producerVersion} disabled={locked} placeholder="Unknown" onChange={(event) => setProducerVersion(event.target.value)} /></label>
      </div>
      <p>Import declares that these labels use this source plane’s same native YX grid. Upstream settings and validation are unknown.</p>
      {producerError && <p role="alert">{producerError}</p>}
      <div className="research-actions"><button type="button" disabled={locked || Boolean(producerError)} onClick={() => void adopt()}>Import on this plane</button>
        <button type="button" disabled={locked} onClick={() => setPreview(null)}>Discard preview</button></div>
    </>}
  </section>;
}
