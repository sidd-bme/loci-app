import { type Ref, useEffect, useId, useRef, useState } from "react";
import type {
  ResearchDesktopApi,
  ResearchLabelsImportPreview,
  ResearchResult,
  ResearchSelection,
  ResearchSource,
  ResearchUsamHandoffReceipt,
  ResearchUsamHandoffRecord,
} from "../shared/research-contracts";
import {
  checkedUsamHandoffBinding,
  checkedUsamHandoffReceipt,
  checkedUsamHandoffRecords,
  sameUsamSelection,
} from "../shared/usam-handoff";

const DIGEST_RE = /^(?:(?:sha256):[a-f0-9]{64}|(?:xxh128):[a-f0-9]{32}|[a-f0-9]{64})$/iu;

function hasPathOrControlChars(value: string): boolean {
  return /[/\\\u0000-\u001f\u007f]/u.test(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.split(/[/\\]/u).includes("..");
}

export function labelsImportUnavailable(source: ResearchSource, selection: ResearchSelection): string | null {
  const dimensions = source.metadata.dimensions;
  if (source.locator_state === "relink-required") return "Relink the source before importing labels.";
  if (source.source_kind && source.source_kind !== "native") return "Choose a native scalar source image.";
  if (["rgb", "rgba"].includes(source.metadata.sample_semantics?.toLowerCase() ?? "") ||
      (dimensions?.s ?? 1) !== 1 ||
      source.metadata.palette != null ||
      source.metadata.axes?.includes("S")) {
    return "Choose a scalar source channel; RGB or palette samples cannot receive this label profile.";
  }
  if (!dimensions || selection.level !== 0 || selection.x !== 0 || selection.y !== 0 ||
      selection.width !== dimensions.x || selection.height !== dimensions.y) {
    return "Choose a full level-0 YX plane or ZYX volume without a crop.";
  }
  if (selection.z_stop !== undefined && (!Number.isSafeInteger(selection.z) || !Number.isSafeInteger(selection.z_stop) ||
      selection.z < 0 || selection.z_stop - selection.z < 2 || selection.z_stop > (dimensions.z ?? 1))) {
    return "Choose a native Z range containing at least two planes within the source.";
  }
  return null;
}

export function usamHandoffUnavailable(source: ResearchSource, selection: ResearchSelection): string | null {
  const base = labelsImportUnavailable(source, selection);
  if (base) return base;
  if (source.derivation != null) {
    return "Choose an original native scalar source; derived sources cannot export a μSAM handoff.";
  }
  return null;
}

export function checkedLabelsPreview(
  value: ResearchLabelsImportPreview,
  source: ResearchSource,
  selection: ResearchSelection,
  workingBytes: number,
): ResearchLabelsImportPreview {
  const volume = selection.z_stop !== undefined;
  const shape = volume ? [selection.z_stop! - selection.z, selection.height, selection.width] : [selection.height, selection.width];
  const middleIndex = Math.floor(shape[0] / 2);
  const middleSelection: ResearchSelection = {
    x: selection.x, y: selection.y, width: selection.width, height: selection.height,
    t: selection.t, c: selection.c, z: selection.z + middleIndex, level: selection.level,
  };
  const previewPlane = value?.preview;
  const validPreviewPlane = volume
    ? Boolean(previewPlane && previewPlane.plane === "XY" && previewPlane.index === middleIndex &&
        previewPlane.source_z === middleSelection.z && previewPlane.basis === "single-native-plane-overlay" &&
        previewPlane.selection && !Object.hasOwn(previewPlane.selection, "z_stop") &&
        sameUsamSelection(previewPlane.selection, middleSelection))
    : previewPlane === undefined;
  const validHandoff = value?.handoff === undefined ? true : (() => {
    try {
      const bound = checkedUsamHandoffBinding(value.handoff);
      return bound.exported_input_axes === (volume ? "ZYX" : "YX") &&
        bound.exported_input_shape.length === shape.length &&
        bound.exported_input_shape.every((dim, index) => dim === shape[index]);
    } catch {
      return false;
    }
  })();
  if (labelsImportUnavailable(source, selection) || !value || value.source_id !== source.id ||
      value.source_sha256 !== source.sha256 || !value.selection || !sameUsamSelection(value.selection, selection) ||
      value.working_bytes !== workingBytes || typeof value.grant_id !== "string" || !/^[a-f0-9]{32}$/u.test(value.grant_id) ||
      value.axes !== (volume ? "ZYX" : "YX") || value.profile !== (volume ? "scalar-native-zyx/v1" : "scalar-native-yx/v1") ||
      value.format !== "TIFF" || !validPreviewPlane || !validHandoff ||
      !["uint8", "uint16", "uint32"].includes(value.original_dtype) || !Array.isArray(value.shape) ||
      value.shape.length !== shape.length || value.shape.some((dimension, index) => dimension !== shape[index]) ||
      !Number.isSafeInteger(value.object_count) || value.object_count < 0 || value.object_count > 100000 ||
      typeof value.file_name !== "string" || !value.file_name || /[/\\]/u.test(value.file_name) ||
      !/^[a-f0-9]{64}$/u.test(value.file_sha256) || !/^[a-f0-9]{64}$/u.test(value.labels_sha256) ||
      value.measurement_channel?.index !== selection.c || value.measurement_channel.basis !== "raw-source-channel-values" ||
      typeof value.measurement_channel.name !== "string" || typeof value.image !== "string" || !value.image.startsWith("data:image/png;base64,") ||
      !Number.isSafeInteger(value.preview_width) || value.preview_width < 1 || value.preview_width > 1024 ||
      !Number.isSafeInteger(value.preview_height) || value.preview_height < 1 || value.preview_height > 1024) {
    throw new Error(`The label preview did not match this exact native source ${volume ? "volume" : "plane"}. Choose the TIFF again.`);
  }
  return value;
}

function handoffMatchesCurrent(item: ResearchUsamHandoffRecord, source: ResearchSource, selection: ResearchSelection): boolean {
  return item.source_id === source.id &&
    item.source_sha256 === source.sha256 &&
    sameUsamSelection(item.selection, selection);
}

export function ResearchLabelsImportPanel({ api, source, selection, workingBytes, scope, busy, onBusy, onResult, navigationIntent, usamDisclosureRef }: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection; workingBytes: number; scope: string;
  busy: boolean; onBusy: (message: string | null, owner: string) => void;
  onResult: (result: ResearchResult, measurements: Array<Record<string, unknown>> | undefined, isCurrent: () => boolean) => Promise<void>;
  navigationIntent?: () => number;
  usamDisclosureRef?: Ref<HTMLDetailsElement>;
}) {
  const binding = JSON.stringify([scope, source.id, source.sha256, selection, workingBytes]);
  const liveBinding = useRef(binding);
  liveBinding.current = binding;
  const request = useRef(0);
  const handoffQuery = useRef(0);
  const ownerId = useId();
  const mounted = useRef(true);
  const [preview, setPreview] = useState<{ binding: string; data: ResearchLabelsImportPreview } | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [producerName, setProducerName] = useState("");
  const [producerVersion, setProducerVersion] = useState("");
  const [producerModel, setProducerModel] = useState("");
  const [producerMode, setProducerMode] = useState("");
  const [producerCheckpoint, setProducerCheckpoint] = useState("");
  const [producerDigest, setProducerDigest] = useState("");
  const [usamOpen, setUsamOpen] = useState(false);
  const [handoffReceipt, setHandoffReceipt] = useState<{ binding: string; data: ResearchUsamHandoffReceipt } | null>(null);
  const [handoffs, setHandoffs] = useState<{ scope: string; items: ResearchUsamHandoffRecord[] }>({ scope, items: [] });
  const [selectedHandoffId, setSelectedHandoffId] = useState("");

  const clearProducer = () => {
    setProducerModel("");
    setProducerMode("");
    setProducerCheckpoint("");
    setProducerDigest("");
    setProducerName("");
    setProducerVersion("");
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current++; handoffQuery.current++; };
  }, []);
  useEffect(() => {
    setPreview(null);
    setError(null);
    setHandoffReceipt(null);
    clearProducer();
  }, [binding]);

  const currentHandoffs = handoffs.scope === scope ? handoffs.items : [];
  useEffect(() => {
    if (!usamOpen || !api.listUsamHandoffs || busy || pendingAction !== null) return;
    const token = ++handoffQuery.current;
    const capturedScope = scope;
    const capturedBinding = binding;
    const intent = navigationIntent?.();
    void api.listUsamHandoffs().then((raw) => {
      if (!mounted.current || handoffQuery.current !== token || liveBinding.current !== capturedBinding || navigationIntent?.() !== intent) return;
      const items = checkedUsamHandoffRecords(raw);
      setHandoffs({ scope: capturedScope, items });
      const matching = items.find((item) => handoffMatchesCurrent(item, source, selection));
      setSelectedHandoffId((prev) => {
        if (prev && items.some((item) => item.handoff_id === prev)) return prev;
        return matching?.handoff_id ?? items[0]?.handoff_id ?? "";
      });
    }).catch(() => {});
  }, [usamOpen, scope, binding, busy, pendingAction]);

  const checked = preview?.binding === binding ? preview.data : null;
  const activeReceipt = handoffReceipt?.binding === binding ? handoffReceipt.data : null;

  const trimmedName = producerName.trim();
  const trimmedVersion = producerVersion.trim();
  const trimmedModel = producerModel.trim();
  const trimmedMode = producerMode.trim();
  const trimmedCheckpoint = producerCheckpoint.trim();
  const trimmedDigest = producerDigest.trim();
  const hasSecondaryProducerDetail = Boolean(trimmedVersion || trimmedModel || trimmedMode || trimmedCheckpoint || trimmedDigest);
  const textFields = [
    { value: producerName, max: 128 },
    { value: producerVersion, max: 128 },
    { value: producerModel, max: 128 },
    { value: producerMode, max: 64 },
    { value: producerCheckpoint, max: 128 },
  ];
  const producerError = hasSecondaryProducerDetail && !trimmedName
    ? "Enter a producer name with external tool/model details, or leave them blank."
    : textFields.some((entry) => hasPathOrControlChars(entry.value) || entry.value.length > entry.max) ||
        hasPathOrControlChars(producerDigest) || producerDigest.length > 128
      ? "Use producer and model metadata without file paths or control characters."
      : trimmedDigest && !DIGEST_RE.test(trimmedDigest)
        ? "Enter a checkpoint digest as sha256:<64 hex>, xxh128:<32 hex>, or 64 hex characters."
        : null;

  const reason = labelsImportUnavailable(source, selection);
  const usamReason = usamHandoffUnavailable(source, selection);
  const pending = pendingAction !== null;
  const locked = busy || pending;
  const currentRequest = (token: number, captured: string) =>
    mounted.current && request.current === token && liveBinding.current === captured;

  const buildTargetSelection = (): ResearchSelection => ({
    x: selection.x, y: selection.y, width: selection.width, height: selection.height,
    t: selection.t, c: selection.c, z: selection.z, level: selection.level,
    ...(selection.z_stop !== undefined ? { z_stop: selection.z_stop } : {}),
  });

  const choose = async (options?: { handoffId?: string; useManifest?: boolean }) => {
    if (!api.labelsImportPreview || locked || reason) return;
    const token = ++request.current;
    const captured = binding;
    const intent = navigationIntent?.();
    const isCurrent = () => currentRequest(token, captured) && navigationIntent?.() === intent;
    const owner = `${ownerId}:${token}`;
    setPendingAction("checking"); setError(null); setPreview(null); onBusy("Checking label TIFF", owner);
    clearProducer();
    try {
      const value = await api.labelsImportPreview({
        source_id: source.id,
        source_sha256: source.sha256,
        selection: buildTargetSelection(),
        working_bytes: workingBytes,
        ...(options?.handoffId ? { handoff_id: options.handoffId } : {}),
        ...(options?.useManifest ? { use_handoff_manifest: true } : {}),
      });
      if (isCurrent() && value) {
        const checkedValue = checkedLabelsPreview(value, source, selection, workingBytes);
        if (options?.handoffId && checkedValue.handoff?.handoff_id !== options.handoffId) {
          throw new Error("The label preview did not preserve the selected μSAM handoff.");
        }
        if ((options?.handoffId || options?.useManifest) && !checkedValue.handoff) {
          throw new Error("The bound μSAM return did not retain its handoff identity.");
        }
        setPreview({ binding: captured, data: checkedValue });

      }
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : "Could not check the selected label TIFF.");
    } finally { if (mounted.current) setPendingAction(null); onBusy(null, owner); }
  };

  const exportUsam = async () => {
    if (!api.exportUsamHandoff || locked || usamReason) return;
    const token = ++request.current;
    const captured = binding;
    const capturedScope = scope;
    const intent = navigationIntent?.();
    const isCurrent = () => currentRequest(token, captured) && navigationIntent?.() === intent;
    const owner = `${ownerId}:${token}`;
    setPendingAction("exporting"); setError(null); onBusy("Exporting μSAM handoff", owner);
    try {
      const target = buildTargetSelection();
      const rawReceipt = await api.exportUsamHandoff({
        source_id: source.id,
        source_sha256: source.sha256,
        selection: target,
        working_bytes: workingBytes,
      });
      if (isCurrent() && rawReceipt) {
        const receipt = checkedUsamHandoffReceipt(rawReceipt, source.id, source.sha256, target);
        setHandoffReceipt({ binding: captured, data: receipt });
        if (api.listUsamHandoffs) {
          try {
            const rawList = await api.listUsamHandoffs();
            if (isCurrent()) {
              const items = checkedUsamHandoffRecords(rawList);
              setHandoffs({ scope: capturedScope, items });
              setSelectedHandoffId(receipt.handoff_id);
            }
          } catch {
            if (isCurrent()) setSelectedHandoffId(receipt.handoff_id);
          }
        }
      }
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : "Could not export the μSAM handoff.");
    } finally { if (mounted.current) setPendingAction(null); onBusy(null, owner); }
  };

  const adopt = async () => {
    if (!checked || locked || reason || producerError) return;
    const token = ++request.current;
    const captured = binding;
    const intent = navigationIntent?.();
    const isCurrent = () => currentRequest(token, captured) && navigationIntent?.() === intent;
    const owner = `${ownerId}:${token}`;
    setPendingAction("importing"); setError(null); onBusy("Importing labels", owner);
    try {
      const producerPayload = trimmedName
        ? {
            name: trimmedName,
            ...(trimmedVersion ? { version: trimmedVersion } : {}),
            ...(trimmedModel ? { model: trimmedModel } : {}),
            ...(trimmedMode ? { mode: trimmedMode } : {}),
            ...(trimmedCheckpoint ? { checkpoint: trimmedCheckpoint } : {}),
            ...(trimmedDigest ? { checkpoint_digest: trimmedDigest } : {}),
          }
        : undefined;
      const output = await api.execute("labels_import", {
        source_id: checked.source_id,
        source_sha256: checked.source_sha256,
        grant_id: checked.grant_id,
        alignment: checked.profile === "scalar-native-zyx/v1" ? "same-native-zyx-grid" : "same-native-yx-grid",
        ...(producerPayload ? { producer: producerPayload } : {}),
      }) as { result?: ResearchResult; measurements?: Array<Record<string, unknown>> };
      const result = output?.result;
      if (!result || result.source_id !== source.id || result.source_sha256 !== source.sha256 || !result.selection ||
          !sameUsamSelection(result.selection, selection) || result.review != null ||
          !/^[a-f0-9]{32}$/u.test(result.id) || !/^[a-f0-9]{64}$/u.test(result.revision_hash)) {
        throw new Error(`Label import did not return an unreviewed result for the checked native ${checked.axes === "ZYX" ? "volume" : "plane"}.`);
      }
      if (isCurrent()) {
        await onResult(result, output.measurements, isCurrent);
        if (isCurrent()) {
          setPreview(null);
          clearProducer();
        }
      }
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : "Could not import the checked labels.");
    } finally { if (mounted.current) setPendingAction(null); onBusy(null, owner); }
  };

  const selectedHandoff = currentHandoffs.find((item) => item.handoff_id === selectedHandoffId) ?? null;
  const selectedHandoffMatches = selectedHandoff ? handoffMatchesCurrent(selectedHandoff, source, selection) : false;
  const externalModelFields = (
    <div className="research-grid">
      <label>Model (optional)<input aria-label="Model (optional)" maxLength={128} value={producerModel} disabled={locked} placeholder="e.g. hvit_t_cells" onChange={(event) => setProducerModel(event.target.value)} /></label>
      <label>Mode (optional)<input aria-label="Mode (optional)" maxLength={64} value={producerMode} disabled={locked} placeholder="e.g. ais-sparse or interactive" onChange={(event) => setProducerMode(event.target.value)} /></label>
      <label>Checkpoint (optional)<input aria-label="Checkpoint (optional)" maxLength={128} value={producerCheckpoint} disabled={locked} placeholder="Declared checkpoint name" onChange={(event) => setProducerCheckpoint(event.target.value)} /></label>
      <label>Checkpoint digest (optional)<input aria-label="Checkpoint digest (optional)" maxLength={128} value={producerDigest} disabled={locked} placeholder="xxh128:... or sha256:..." onChange={(event) => setProducerDigest(event.target.value)} /></label>
    </div>
  );

  return <section className="research-label-import research-panel" aria-label="Import external labels">
    <h3>External labels</h3>
    <button type="button" disabled={locked || Boolean(reason) || !api.labelsImportPreview} onClick={() => void choose()}>Import labels</button>
    <details ref={usamDisclosureRef} open={usamOpen} onToggle={(event) => setUsamOpen(event.currentTarget.open)}>
      <summary>μSAM (standalone)</summary>
      <p>Export the selected channel at full resolution. Run μSAM separately, then return its labels to this study.</p>
      <div className="research-actions">
        <button type="button" disabled={locked || Boolean(usamReason) || !api.exportUsamHandoff} onClick={() => void exportUsam()}>Export native TIFF for μSAM</button>
        {api.labelsImportPreview && (
          <button type="button" disabled={locked || Boolean(reason)} onClick={() => void choose({ useManifest: true })}>Return labels with manifest…</button>
        )}
      </div>
      {usamReason && !reason && <p>{usamReason}</p>}
      {activeReceipt && (
        <div role="status">
          <p>Exported <strong>{activeReceipt.basename}</strong> · {activeReceipt.input.shape.join(" × ")} {activeReceipt.input.axes} · {activeReceipt.input.dtype}.</p>
          <p>Open <code>input.tif</code> in standalone μSAM. The folder’s README explains how to save {activeReceipt.input.axes} labels.</p>
        </div>
      )}
      {currentHandoffs.length > 0 && (
        <div className="research-grid">
          <label>
            Saved μSAM handoff
            <select aria-label="Saved μSAM handoff" value={selectedHandoffId} disabled={locked} onChange={(event) => setSelectedHandoffId(event.target.value)}>
              {currentHandoffs.map((item) => {
                const match = handoffMatchesCurrent(item, source, selection);
                const zText = item.selection.z_stop !== undefined ? `${item.selection.z}–${item.selection.z_stop - 1}` : `${item.selection.z}`;
                return (
                  <option key={item.handoff_id} value={item.handoff_id}>
                    {`${item.handoff_id.slice(0, 8)} · ${item.source_name} · ${item.input.shape.join("×")} ${item.input.axes} (T${item.selection.t}/C${item.selection.c}/Z${zText})${match ? " · current view" : ""}`}
                  </option>
                );
              })}
            </select>
          </label>
          <button type="button" disabled={locked || Boolean(reason) || !api.labelsImportPreview || !selectedHandoff || !selectedHandoffMatches}
            onClick={() => selectedHandoff && void choose({ handoffId: selectedHandoff.handoff_id })}>
            Return labels for selected handoff
          </button>
          {selectedHandoff && !selectedHandoffMatches && (
            <p>Select the source, time, channel and Z range used for this export.</p>
          )}
        </div>
      )}
    </details>
    {reason && <p>{reason}</p>}
    {pending && <p role="status">{pendingAction === "exporting" ? "Exporting μSAM handoff…" : checked ? "Importing labels…" : "Checking label TIFF…"}</p>}
    {error && <p role="alert">{error}</p>}
    {checked && <>
      <img className="research-label-import-preview" src={checked.image}
        alt={checked.axes === "ZYX" ? `Checked label overlay on the volume’s middle XY plane, source Z ${checked.preview!.source_z}` : "Checked label overlay on the selected source plane"}
        width={checked.preview_width} height={checked.preview_height} />
      {checked.axes === "ZYX" && <p>Preview: middle XY plane only · source Z {checked.preview!.source_z} · plane {checked.preview!.index + 1} of {checked.shape[0]}.</p>}
      <dl className="research-label-import-metadata">
        <div><dt>Label file</dt><dd>{checked.file_name}</dd></div>
        <div><dt>Objects</dt><dd>{checked.object_count.toLocaleString()}{checked.object_count === 0 ? " · empty population" : ""}</dd></div>
        <div><dt>Input</dt><dd>{checked.original_dtype} · {checked.shape.join(" × ")} {checked.axes}</dd></div>
        <div><dt>Source grid</dt><dd>{source.name} · native level 0 · T {selection.t} / C {selection.c} / Z {selection.z}{selection.z_stop !== undefined ? `–${selection.z_stop - 1} inclusive` : ""}</dd></div>
        <div><dt>Measurement channel</dt><dd>{checked.measurement_channel.name} · raw source values</dd></div>
        {checked.handoff && (
          <>
            <div><dt>Verified Loci export</dt><dd>Handoff {checked.handoff.handoff_id.slice(0, 8)} · {checked.handoff.exported_input_dtype} · {checked.handoff.exported_input_shape.join(" × ")} {checked.handoff.exported_input_axes}</dd></div>
            <div><dt>Mask origin</dt><dd>Declared by the researcher. Model validation is unknown.</dd></div>
          </>
        )}
      </dl>
      <div className="research-grid">
        <label>Producer name (optional)<input aria-label="Producer name (optional)" maxLength={128} value={producerName} disabled={locked} placeholder="Unknown" onChange={(event) => setProducerName(event.target.value)} /></label>
        <label>Producer version (optional)<input aria-label="Producer version (optional)" maxLength={128} value={producerVersion} disabled={locked} placeholder="Unknown" onChange={(event) => setProducerVersion(event.target.value)} /></label>
      </div>
      <details>
          <summary>External model details (optional, user-declared)</summary>
          {externalModelFields}
      </details>
      <p>Import declares that these labels use this source {checked.axes === "ZYX" ? "volume’s same native ZYX" : "plane’s same native YX"} grid. Upstream settings and validation are unknown.</p>
      {producerError && <p role="alert">{producerError}</p>}
      <div className="research-actions"><button type="button" disabled={locked || Boolean(producerError)} onClick={() => void adopt()}>Import on this {checked.axes === "ZYX" ? "volume" : "plane"}</button>
        <button type="button" disabled={locked} onClick={() => {
          setPreview(null);
          clearProducer();
        }}>Discard preview</button></div>
    </>}
  </section>;
}
