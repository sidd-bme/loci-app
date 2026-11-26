import { useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchSource } from "../shared/research-contracts";
import type { VirtualStainInstallState, VirtualStainRequest } from "../shared/dynacell";
import { sanitizeRendererError } from "./ContextHelp";

function unavailableReason(source: ResearchSource, channel: number) {
  const { format, dimensions, physical_calibration: calibration, sample_semantics, channel_dtypes } = source.metadata;
  if (source.locator_state === "relink-required") return "Relink this image before running a prediction.";
  if (format !== "OME-TIFF" || sample_semantics !== "none" || !dimensions ||
      dimensions.x !== 512 || dimensions.y !== 512 || dimensions.z < 15 || dimensions.z > 40) {
    return "Choose a scalar OME-TIFF with 512 × 512 pixels and 15–40 native Z sections.";
  }
  if (channel < 0) return "Select the reconstructed phase channel.";
  if (source.metadata.channel_names?.[channel] !== "Phase3D") return "Choose the channel recorded as Phase3D in the OME metadata.";
  if (channel_dtypes?.[channel] !== "float32") return "The selected phase channel must contain float32 data.";
  const expected = [0.29, 0.108, 0.108];
  if (!calibration || !["µm", "μm", "um", "micrometer", "micrometers", "micrometre", "micrometres"].includes(calibration.unit ?? "") ||
      calibration.spacing?.length !== 3 || !expected.every((value, i) => Math.abs(calibration.spacing![i] - value) <= 0.0005)) {
    return "This model needs native spacing of 0.290 µm in Z and 0.108 µm in X and Y.";
  }
  return null;
}

interface Props {
  api: ResearchDesktopApi;
  source: ResearchSource;
  timepoint: number;
  busy: boolean;
  onRun: (request: VirtualStainRequest) => Promise<void>;
}

export function VirtualStainPanel({ api, source, timepoint, busy, onRun }: Props) {
  const count = source.metadata.dimensions?.c ?? 0;
  const names = source.metadata.channel_names ?? [];
  const [channel, setChannel] = useState(() => count === 1 ? 0 : names.findIndex(name => name === "Phase3D"));
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<VirtualStainInstallState | "checking">("checking");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const installOwner = useRef(false);
  const [check, setCheck] = useState(0);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let current = true, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await api.dynacellStatus?.();
        if (!current || !next || installOwner.current) return;
        setState(next);
        if (next === "installing") timer = setTimeout(() => { void read(); }, 1000);
      } catch {
        if (current) setError("Loci could not verify the local checkpoint. Check access to the model folder and retry.");
      }
    };
    void read();
    return () => { current = false; clearTimeout(timer); };
  }, [api, check]);
  const install = async (from: "local" | "publisher") => {
    if (installOwner.current || !api.installDynacell) return;
    installOwner.current = true;
    setError(null);
    setState("installing");
    try { await api.installDynacell(from); }
    catch (e) { if (mounted.current) setError(sanitizeRendererError(e instanceof Error ? e.message : "Checkpoint verification failed.")); }
    finally {
      installOwner.current = false;
      if (mounted.current) { setState("checking"); setCheck(value => value + 1); }
    }
  };
  const reason = unavailableReason(source, channel);
  const ready = state === "ready";
  const predict = async () => {
    if (reason || !confirmed || !ready || busy || running) return;
    setRunning(true);
    try {
      await onRun({ source_id: source.id, source_sha256: source.sha256, channel, timepoint, phase_confirmed: true });
    } finally { if (mounted.current) setRunning(false); }
  };
  if (state === "unsupported") return <section className="research-panel" aria-label="DynaCell virtual stain">
    <h2>Virtual nuclear stain</h2>
    <p>Local prediction currently requires macOS or Linux for atomic OME-TIFF publication. You can open an existing prediction in this workbench.</p>
  </section>;
  return <section className="research-panel" aria-label="DynaCell virtual stain">
    <h2>Virtual nuclear stain</h2>
    <p>DynaCell predicts nuclear structure from a 3D phase image. The output keeps the original phase beside the normalized prediction.</p>
    <fieldset>
      <legend>iPSC nuclear model</legend>
      <p role="status">{ready ? "Verified checkpoint available offline" : state === "installing" ? "Installing and verifying the checkpoint…" :
        state === "damaged" ? "The installed checkpoint failed verification." : state === "checking" ? "Checking the local checkpoint…" : "368 MiB download from Biohub. Runs locally on CPU."}</p>
      {error && <p role="alert">{error}</p>}
      {!ready && state !== "installing" && <div className="research-actions">
        <button disabled={!api.installDynacell || busy || state === "checking"} onClick={() => void install("publisher")}>{state === "damaged" ? "Repair checkpoint" : "Install from Biohub"}</button>
        <button disabled={!api.installDynacell || busy || state === "checking"} onClick={() => void install("local")}>Import checkpoint…</button>
        {error && <button onClick={() => { setError(null); setCheck(n => n + 1); }}>Check again</button>}
      </div>}
      {state === "installing" && api.cancelDynacellInstall && <button onClick={() => {
        void api.cancelDynacellInstall!().catch(() => { if (mounted.current) setError("Cancellation could not be requested."); });
      }}>Cancel installation</button>}
    </fieldset>
    <label>Reconstructed phase channel<select value={channel} disabled={busy} onChange={e => { setChannel(Number(e.target.value)); setConfirmed(false); }}>
      {channel < 0 && <option value={-1}>Select a channel</option>}
      {Array.from({ length: count }, (_, i) => <option key={i} value={i}>{names[i] || `Channel ${i + 1}`}</option>)}
    </select></label>
    {(source.metadata.dimensions?.t ?? 1) > 1 && <p>Selected time point {timepoint + 1} of {source.metadata.dimensions!.t}.</p>}
    {reason ? <p role="status">{reason}</p> : <label className="research-check"><input type="checkbox" checked={confirmed} disabled={busy}
      onChange={e => setConfirmed(e.target.checked)} />This channel is reconstructed Phase3D from unperturbed WTC-11 iPSCs.</label>}
    <button className="research-primary" disabled={!api.runVirtualStain || !ready || !confirmed || Boolean(reason) || busy || running}
      onClick={() => void predict()}>{running ? "Predicting nuclear stain…" : "Predict nuclear stain…"}</button>
    <p>Choose a new folder for the OME-TIFF and its provenance. Use measured fluorescence for intensity quantitation.</p>
  </section>;
}
