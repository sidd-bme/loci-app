import { useMemo, useRef, useState } from "react";
import type {
  ResearchDesktopApi,
  ResearchSnapshot,
  ResearchVendorGrant,
  ResearchVendorRequest,
} from "../shared/research-contracts";
import "./ResearchVendorPanel.css";

type Report = <T>(
  work: () => Promise<T>,
  fallback: string,
) => Promise<T | undefined>;

type VendorGrant = ResearchVendorGrant;
type VendorRequest = ResearchVendorRequest;
type Dimensions = VendorGrant["inspection"]["series"][number]["dimensions"];
type Scope = "series" | "range" | "plane";
type VendorConversion = {
  snapshot: ResearchSnapshot;
  conversion: Record<string, unknown>;
};
type VendorApi = ResearchDesktopApi & {
  inspectVendor?: () => Promise<VendorGrant | null>;
  convertVendor?: (request: VendorRequest) => Promise<VendorConversion | null>;
};

const HASH = /^[a-f0-9]{64}$/u;
const DTYPE_BYTES: Record<string, number> = {
  int8: 1, uint8: 1, int16: 2, uint16: 2,
  int32: 4, uint32: 4, float32: 4, float64: 8,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: string, minimum: number, maximum: number): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function safeName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !value.includes("/") && !value.includes("\\") &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

function positiveDimensions(value: unknown): value is Dimensions {
  const item = record(value);
  return Boolean(item && ["x", "y", "z", "c", "t"].every((axis) =>
    Number.isSafeInteger(item[axis]) && Number(item[axis]) > 0,
  ));
}

function checkedInspection(value: unknown): VendorGrant {
  const outer = record(value);
  const inspection = record(outer?.inspection);
  const runtime = record(inspection?.runtime);
  const series = inspection?.series;
  if (
    !outer || typeof outer.grant_id !== "string" || !outer.grant_id ||
    outer.grant_id.length > 128 || !safeName(outer.source_name) ||
    typeof outer.source_sha256 !== "string" || !HASH.test(outer.source_sha256) ||
    inspection?.schema_version !== "loci.vendor-inspection/v1" ||
    !["czi", "lif", "nd2"].includes(String(inspection.format)) ||
    inspection.source_sha256 !== outer.source_sha256 ||
    !Number.isSafeInteger(inspection.source_size_bytes) ||
    Number(inspection.source_size_bytes) <= 0 ||
    !Array.isArray(series) || !series.length ||
    !runtime || typeof runtime.bioformats_version !== "string" ||
    typeof runtime.bioformats_jar_sha256 !== "string" ||
    !HASH.test(runtime.bioformats_jar_sha256) ||
    !Number.isSafeInteger(runtime.bioformats_jar_size_bytes) ||
    typeof runtime.java_sha256 !== "string" || !HASH.test(runtime.java_sha256) ||
    typeof runtime.java_version !== "string"
  ) throw new Error("Vendor inspection returned an invalid redacted receipt.");
  for (const [position, candidate] of series.entries()) {
    const item = record(candidate);
    if (
      !item || item.index !== position || !positiveDimensions(item.dimensions) ||
      typeof item.dimension_order !== "string" ||
      !/^XY(?:CZT|CTZ|ZCT|ZTC|TCZ|TZC)$/u.test(item.dimension_order) ||
      typeof item.dtype !== "string" || !Object.hasOwn(DTYPE_BYTES, item.dtype) ||
      !Array.isArray(item.channel_names) ||
      !item.channel_names.every(safeName) ||
      !Array.isArray(item.samples_per_channel) ||
      item.channel_names.length !== item.dimensions.c ||
      item.samples_per_channel.length !== item.dimensions.c ||
      !item.samples_per_channel.every((sample) => Number.isSafeInteger(sample) && sample > 0)
    ) throw new Error("Vendor inspection returned invalid series metadata.");
  }
  return outer as unknown as VendorGrant;
}

function checkedConversion(
  value: unknown,
  grant: VendorGrant,
  request: VendorRequest,
): VendorConversion {
  const outer = record(value);
  const snapshot = record(outer?.snapshot);
  const conversion = record(outer?.conversion);
  const artifact = record(conversion?.artifact);
  if (
    !outer || !snapshot || !record(snapshot.project) ||
    !Array.isArray(snapshot.sources) || !Array.isArray(snapshot.results) ||
    !conversion || conversion.schema_version !== (request.end_exclusive ? "loci.vendor-conversion-receipt/v3" : "loci.vendor-conversion-receipt/v1") ||
    conversion.source_sha256 !== grant.source_sha256 ||
    conversion.bioformats_jar_sha256 !==
      grant.inspection.runtime.bioformats_jar_sha256 ||
    !artifact || typeof artifact.sha256 !== "string" || !HASH.test(artifact.sha256) ||
    typeof artifact.pixel_sha256 !== "string" || !HASH.test(artifact.pixel_sha256)
  ) throw new Error("Vendor conversion returned an invalid identity-bound receipt.");
  if (request.end_exclusive) {
    const selected = record(conversion.selection);
    const stop = record(selected?.end_exclusive);
    const runtime = record(conversion.runtime);
    const dims = grant.inspection.series[request.series].dimensions;
    const crop = request.crop ?? { x: 0, y: 0, width: dims.x, height: dims.y };
    const end = request.end_exclusive;
    const shape = [end.t - request.t, end.c - request.c, end.z - request.z, crop.height, crop.width];
    const acquisition = record(artifact.acquisition);
    const planes = shape[0] * shape[1] * shape[2];
    if (!acquisition || acquisition.stage_position_anchor !== "unspecified" ||
        typeof acquisition.native_plane_metadata_sha256 !== "string" || !HASH.test(acquisition.native_plane_metadata_sha256) ||
        !["planes_with_delta_t", "planes_with_stage_position"].every((key) =>
          Number.isSafeInteger(acquisition[key]) && Number(acquisition[key]) >= 0 && Number(acquisition[key]) <= planes)) {
      throw new Error("Returned stack has invalid acquisition metadata evidence.");
    }
    if (artifact.axes !== "TCZYX" || artifact.dtype !== grant.inspection.series[request.series].dtype ||
        JSON.stringify(artifact.shape) !== JSON.stringify(shape) || selected?.series !== request.series ||
        (["c", "z", "t"] as const).some((axis) => {
          return selected[axis] !== request[axis] || stop?.[axis] !== end[axis];
        }) || JSON.stringify(selected.crop_xywh) !== JSON.stringify([crop.x, crop.y, crop.width, crop.height]) ||
        runtime?.java_sha256 !== grant.inspection.runtime.java_sha256) {
      throw new Error("Returned conversion differs from the selected source range or reader.");
    }
  }
  return outer as unknown as VendorConversion;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

export function ResearchVendorPanel({
  api,
  snapshot,
  report,
  busy,
  onBusyChange,
  onSnapshot,
}: {
  api: ResearchDesktopApi;
  snapshot: ResearchSnapshot;
  report: Report;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onSnapshot: (snapshot: ResearchSnapshot) => void;
}): React.JSX.Element {
  const vendorApi = api as VendorApi;
  const [grant, setGrant] = useState<VendorGrant | null>(null);
  const grantRef = useRef<VendorGrant | null>(null);
  const [seriesIndex, setSeriesIndex] = useState("0");
  const [scope, setScope] = useState<Scope>("series");
  const [last, setLast] = useState({ c: "0", z: "0", t: "0" });
  const [channel, setChannel] = useState("0");
  const [z, setZ] = useState("0");
  const [t, setT] = useState("0");
  const [cropEnabled, setCropEnabled] = useState(false);
  const [cropX, setCropX] = useState("0");
  const [cropY, setCropY] = useState("0");
  const [cropWidth, setCropWidth] = useState("1");
  const [cropHeight, setCropHeight] = useState("1");
  const [heapMiB, setHeapMiB] = useState("768");
  const [timeoutSeconds, setTimeoutSeconds] = useState("300");
  const [maxOutputMiB, setMaxOutputMiB] = useState("512");
  const [localBusy, setLocalBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [conversion, setConversion] = useState<Record<string, unknown> | null>(null);
  const inspectionGeneration = useRef(0);
  const conversionGeneration = useRef(0);

  const series = grant?.inspection.series[Number(seriesIndex)] ?? null;
  const dimensions = series?.dimensions;
  const selectedC = dimensions ? integer(scope === "series" ? "0" : channel, 0, dimensions.c - 1) : null;
  const selectedZ = dimensions ? integer(scope === "series" ? "0" : z, 0, dimensions.z - 1) : null;
  const selectedT = dimensions ? integer(scope === "series" ? "0" : t, 0, dimensions.t - 1) : null;
  const x = dimensions ? integer(cropX, 0, dimensions.x - 1) : null;
  const y = dimensions ? integer(cropY, 0, dimensions.y - 1) : null;
  const width = dimensions ? integer(cropWidth, 1, dimensions.x) : null;
  const height = dimensions ? integer(cropHeight, 1, dimensions.y) : null;
  const heap = integer(heapMiB, 256, 4096);
  const timeout = integer(timeoutSeconds, 1, 1800);
  const maxMiB = integer(maxOutputMiB, 1, 1024);
  const cropValid = Boolean(
    !cropEnabled ||
      (dimensions && x !== null && y !== null && width !== null && height !== null &&
        x + width <= dimensions.x && y + height <= dimensions.y),
  );
  const lastIndex = (axis: "c" | "z" | "t", start: number | null) => {
    if (!dimensions || start === null) return null;
    if (scope === "series") return dimensions[axis] - 1;
    return scope === "plane" ? start : integer(last[axis], start, dimensions[axis] - 1);
  };
  const lastC = lastIndex("c", selectedC);
  const lastZ = lastIndex("z", selectedZ);
  const lastT = lastIndex("t", selectedT);
  const counts = selectedC !== null && selectedT !== null && selectedZ !== null &&
    lastC !== null && lastZ !== null && lastT !== null
    ? [lastT - selectedT + 1, lastC - selectedC + 1, lastZ - selectedZ + 1] : null;
  const planes = counts?.reduce((product, count) => product * count, 1) ?? 0;
  const scalar = Boolean(
    series && selectedC !== null && lastC !== null &&
      (scope === "plane" ? series.samples_per_channel[selectedC] === 1 : series.samples_per_channel.every((n) => n === 1)),
  );
  const outputWidth = cropEnabled ? width : dimensions?.x;
  const outputHeight = cropEnabled ? height : dimensions?.y;
  const planeBytes = series && outputWidth && outputHeight
    ? outputWidth * outputHeight * DTYPE_BYTES[series.dtype]
    : null;
  const estimatedBytes = planes && planeBytes ? planes * planeBytes : null;
  const limitsValid = Boolean(
    heap !== null && timeout !== null && maxMiB !== null && estimatedBytes !== null &&
      planes <= 4096 && planeBytes! <= 512 * 1024 ** 2 && estimatedBytes <= maxMiB! * 1024 ** 2,
  );
  const request = useMemo<VendorRequest | null>(() => {
    if (
      !grant || !series || selectedC === null || selectedZ === null || selectedT === null ||
      !cropValid || !scalar || !limitsValid || heap === null || timeout === null || maxMiB === null
    ) return null;
    return {
      grant_id: grant.grant_id,
      series: series.index,
      c: selectedC,
      z: selectedZ,
      t: selectedT,
      ...(scope !== "plane" && lastC !== null && lastT !== null && lastZ !== null
        ? { end_exclusive: { c: lastC + 1, z: lastZ + 1, t: lastT + 1 } } : {}),
      crop: cropEnabled ? { x: x!, y: y!, width: width!, height: height! } : null,
      heap_mib: heap,
      timeout_seconds: timeout,
      max_output_bytes: maxMiB * 1024 ** 2,
    };
  }, [
    scope, lastC, lastT, lastZ, cropEnabled, cropValid, grant, heap, height, limitsValid, maxMiB, scalar,
    selectedC, selectedT, selectedZ, series, timeout, width, x, y,
  ]);
  const requestFingerprint = JSON.stringify(request);
  const requestFingerprintRef = useRef(requestFingerprint);
  requestFingerprintRef.current = requestFingerprint;
  const disabled = busy || localBusy;

  const chooseSeries = (value: string) => {
    const next = grant?.inspection.series[Number(value)];
    if (!next) return;
    conversionGeneration.current += 1;
    setConversion(null);
    setScope("series");
    setLast({ c: String(next.dimensions.c - 1), z: String(next.dimensions.z - 1), t: String(next.dimensions.t - 1) });
    setSeriesIndex(value);
    setChannel("0");
    setZ("0");
    setT("0");
    setCropEnabled(false);
    setCropX("0");
    setCropY("0");
    setCropWidth(String(next.dimensions.x));
    setCropHeight(String(next.dimensions.y));
  };

  const inspect = async () => {
    if (!vendorApi.inspectVendor || disabled) return;
    const generation = ++inspectionGeneration.current;
    conversionGeneration.current += 1;
    grantRef.current = null;
    setGrant(null);
    setConversion(null);
    setStatus(null);
    setLocalBusy(true);
    onBusyChange(true);
    try {
      const output = await report(
        async () => {
          const value = await vendorApi.inspectVendor!();
          return value === null ? null : checkedInspection(value);
        },
        "Could not inspect the selected vendor source with the approved local reader.",
      );
      if (generation !== inspectionGeneration.current || output === undefined) return;
      if (output === null) {
        setStatus("Vendor inspection was cancelled; no source grant is retained.");
        return;
      }
      const next = output;
      grantRef.current = next;
      setGrant(next);
      const dims = next.inspection.series[0].dimensions;
      setScope("series");
      setLast({ c: String(dims.c - 1), z: String(dims.z - 1), t: String(dims.t - 1) });
      setSeriesIndex("0");
      setChannel("0");
      setZ("0");
      setT("0");
      setCropEnabled(false);
      setCropX("0");
      setCropY("0");
      setCropWidth(String(next.inspection.series[0].dimensions.x));
      setCropHeight(String(next.inspection.series[0].dimensions.y));
      setStatus("Exact source, Bio-Formats package, and Java runtime inspected locally.");
    } finally {
      if (generation === inspectionGeneration.current) {
        setLocalBusy(false);
        onBusyChange(false);
      }
    }
  };

  const convert = async () => {
    if (!vendorApi.convertVendor || !request || !grant || disabled) return;
    const generation = ++conversionGeneration.current;
    const fingerprint = requestFingerprint;
    const exactGrant = grant;
    setStatus(null);
    setConversion(null);
    setLocalBusy(true);
    onBusyChange(true);
    try {
      const output = await report(
        async () => {
          const value = await vendorApi.convertVendor!(request);
          return value === null ? null : checkedConversion(value, exactGrant, request);
        },
        "Could not convert and import the selected vendor data.",
      );
      if (
        generation !== conversionGeneration.current || output === undefined ||
        requestFingerprintRef.current !== fingerprint ||
        grantRef.current?.grant_id !== exactGrant.grant_id
      ) return;
      if (output === null) {
        setStatus("Vendor conversion was cancelled; no derived source was imported.");
        return;
      }
      const checked = output;
      onSnapshot(checked.snapshot);
      setConversion(checked.conversion);
      setStatus("Imported the selected data as a derived OME-TIFF source.");
    } finally {
      if (generation === conversionGeneration.current) {
        setLocalBusy(false);
        onBusyChange(false);
      }
    }
  };

  const artifact = record(conversion?.artifact);
  const studyConversions = snapshot.sources.filter((source) =>
    source.derivation?.schema === "loci.vendor-derived-source/v1",
  );
  return (
    <div className="research-panel research-vendor">
      <h2>Convert vendor images</h2>
      <p>Convert a CZI, LIF or ND2 series, range or plane to a derived OME-TIFF in <strong>{snapshot.project.title}</strong>.</p>
      <button
        className="research-primary"
        disabled={disabled || !vendorApi.inspectVendor}
        onClick={() => void inspect()}
      >
        Choose vendor image…
      </button>
      {!vendorApi.inspectVendor && (
        <p role="alert">This desktop build does not provide native vendor inspection.</p>
      )}

      {grant && series && dimensions && (
        <>
          <section className="research-vendor-card" aria-label="Exact vendor inspection">
            <h3>Source and reader</h3>
            <dl className="research-vendor-kv">
              <div><dt>Source</dt><dd>{grant.source_name}</dd></div>
              <div><dt>Format / size</dt><dd>{grant.inspection.format.toUpperCase()} · {bytes(grant.inspection.source_size_bytes)}</dd></div>
              <div><dt>Bio-Formats</dt><dd>{grant.inspection.runtime.bioformats_version}</dd></div>
              <div><dt>Java</dt><dd>{grant.inspection.runtime.java_version}</dd></div>
            </dl>
            <details><summary>Technical record</summary><dl className="research-vendor-kv">
              <div><dt>Source SHA-256</dt><dd><code>{grant.source_sha256}</code></dd></div>
              <div><dt>Reader SHA-256</dt><dd><code>{grant.inspection.runtime.bioformats_jar_sha256}</code></dd></div>
              <div><dt>Java SHA-256</dt><dd><code>{grant.inspection.runtime.java_sha256}</code></dd></div>
            </dl></details>
          </section>

          <section className="research-vendor-card" aria-label="Vendor selection">
            <h3>Conversion scope</h3>
            <label>
              Series
              <select aria-label="Vendor series" value={seriesIndex} disabled={disabled}
                onChange={(event) => chooseSeries(event.target.value)}>
                {grant.inspection.series.map((item) => (
                  <option key={item.index} value={item.index}>
                    S{item.index} · {item.dimensions.x}×{item.dimensions.y} · {item.dimensions.z} Z · {item.dimensions.c} C · {item.dimensions.t} T
                  </option>
                ))}
              </select>
            </label>
            <p className="research-vendor-series">
              Order {series.dimension_order} · {series.dtype} · channels {series.channel_names.join(", ")}
              {series.calibration ? ` · calibration ${Object.entries(series.calibration).map(([axis, item]) => `${axis.toUpperCase()} ${item.value} ${item.unit}`).join(", ")}` : " · no physical calibration reported"}
            </p>
            <label>Scope<select aria-label="Vendor scope" value={scope} disabled={disabled}
              onChange={(event) => setScope(event.target.value as Scope)}>
              <option value="series">Whole series</option>
              <option value="range">Selected C/Z/T range</option>
              <option value="plane">Single plane</option>
            </select></label>
            {scope === "range" && <p>Indices start at zero. Both endpoints are included.</p>}
            {scope !== "series" && <div className="research-vendor-grid">
              <label>{scope === "range" ? "First channel" : "Channel"}<select aria-label="Vendor channel" value={channel} disabled={disabled}
                onChange={(event) => { conversionGeneration.current += 1; setConversion(null); setChannel(event.target.value); }}>
                {series.channel_names.map((name, index) => (
                  <option key={index} value={index}>{index}: {name} · {series.samples_per_channel[index]} sample{series.samples_per_channel[index] === 1 ? "" : "s"}</option>
                ))}
              </select></label>
              <label>{scope === "range" ? "First Z" : "Z index"}<input aria-label="Vendor Z index" type="number" min="0" max={dimensions.z - 1} step="1" value={z} disabled={disabled} onChange={(event) => setZ(event.target.value)} /></label>
              <label>{scope === "range" ? "First T" : "T index"}<input aria-label="Vendor T index" type="number" min="0" max={dimensions.t - 1} step="1" value={t} disabled={disabled} onChange={(event) => setT(event.target.value)} /></label>
              {scope === "range" && (["c", "z", "t"] as const).map((axis) =>
                <label key={axis}>Last {axis.toUpperCase()}<input aria-label={`Vendor last ${axis.toUpperCase()}`}
                  type="number" min={0} max={dimensions[axis] - 1} step={1}
                  value={last[axis]} disabled={disabled}
                  onChange={(event) => setLast({ ...last, [axis]: event.target.value })} /></label>
              )}
            </div>}
            {!counts && <p role="alert">Choose ordered indices within this series.</p>}
            {counts && !scalar && <p role="alert">{scope === "plane" ? "The selection contains multiple RGB samples. Choose a scalar acquisition channel." : "Stack conversion requires a series with one scalar sample per channel."}</p>}
            <label className="research-vendor-check">
              <input aria-label="Crop vendor plane" type="checkbox" checked={cropEnabled} disabled={disabled}
                onChange={(event) => setCropEnabled(event.target.checked)} />
              Crop XY
            </label>
            {cropEnabled && (
              <div className="research-vendor-grid">
                <label>Crop X<input aria-label="Vendor crop X" type="number" min="0" max={dimensions.x - 1} step="1" value={cropX} disabled={disabled} onChange={(event) => setCropX(event.target.value)} /></label>
                <label>Crop Y<input aria-label="Vendor crop Y" type="number" min="0" max={dimensions.y - 1} step="1" value={cropY} disabled={disabled} onChange={(event) => setCropY(event.target.value)} /></label>
                <label>Width<input aria-label="Vendor crop width" type="number" min="1" max={dimensions.x} step="1" value={cropWidth} disabled={disabled} onChange={(event) => setCropWidth(event.target.value)} /></label>
                <label>Height<input aria-label="Vendor crop height" type="number" min="1" max={dimensions.y} step="1" value={cropHeight} disabled={disabled} onChange={(event) => setCropHeight(event.target.value)} /></label>
              </div>
            )}
            {!cropValid && <p role="alert">Use an integer crop within the selected series.</p>}
          </section>

          <section className="research-vendor-card" aria-label="Vendor conversion limits">
            <h3>OME-TIFF output</h3>
            <p aria-label="Vendor output preview">
              {scope === "plane" ? `YX · ${outputHeight ?? "—"} × ${outputWidth ?? "—"}` :
                `TCZYX · ${[...(counts ?? ["—", "—", "—"]), outputHeight ?? "—", outputWidth ?? "—"].join(" × ")}`}
              {" · "}{series.dtype} · {planes} planes · {estimatedBytes === null ? "—" : bytes(estimatedBytes)} decoded
            </p>
            <details><summary>Resource limits</summary>
            <div className="research-vendor-grid">
              <label>Java heap MiB<input aria-label="Vendor heap MiB" type="number" min="256" max="4096" step="1" value={heapMiB} disabled={disabled} onChange={(event) => setHeapMiB(event.target.value)} /></label>
              <label>Timeout seconds<input aria-label="Vendor timeout seconds" type="number" min="1" max="1800" step="1" value={timeoutSeconds} disabled={disabled} onChange={(event) => setTimeoutSeconds(event.target.value)} /></label>
              <label>Maximum output MiB<input aria-label="Vendor maximum output MiB" type="number" min="1" max="1024" step="1" value={maxOutputMiB} disabled={disabled} onChange={(event) => setMaxOutputMiB(event.target.value)} /></label>
            </div>
            </details>
            {counts && !limitsValid && <p role="alert">Check resource limits. Each plane must fit 512 MiB and the selection must fit the output budget and 4,096 planes.</p>}
            <button className="research-primary" disabled={disabled || !vendorApi.convertVendor || !request}
              onClick={() => void convert()}>
              {scope === "plane" ? "Convert and import plane" : "Convert and import stack"}
            </button>
          </section>
        </>
      )}
      <details><summary>Reader and conversion details</summary>
        <p>Choose a local Bio-Formats 8.5.0 package and Java executable. Whole series and C/Z/T ranges require a JDK 11 or later.
          Bio-Formats offers GPL and commercial licences; check the terms for your use.</p>
        <p>Conversion preserves scalar values without resizing, projection or channel merging.
          Stacks retain declared spacing, channel names, frame interval and per-plane times. Crops keep the original stage coordinates and units. Their pixel anchor is unspecified.
          The study retains the original indices, XY crop and reader fingerprints.</p>
      </details>

      {conversion && artifact && (
        <section className="research-vendor-card research-vendor-receipt" aria-label="Vendor conversion receipt">
          <h3>Imported derived source</h3>
          <p>{typeof artifact.filename === "string" ? artifact.filename : "Converted plane"} added to the study.</p>
          <details><summary>Technical record</summary>
            <p>Artifact SHA-256 <code>{String(artifact.sha256)}</code></p>
            <p>Pixel SHA-256 <code>{String(artifact.pixel_sha256)}</code></p>
          </details>
        </section>
      )}
      {studyConversions.length > 0 && <details aria-label="Saved vendor conversions">
        <summary>Study conversions ({studyConversions.length})</summary>
        {studyConversions.map((source) => {
          const receipt = record(source.derivation?.receipt);
          const selection = record(receipt?.selection);
          const saved = record(receipt?.artifact);
          const runtime = record(receipt?.runtime);
          const acquisition = record(saved?.acquisition);
          return <section className="research-vendor-card" key={source.id}>
            <h3>{source.name}</h3>
            <p>{String(saved?.axes)} · {Array.isArray(saved?.shape) && saved.shape.join(" × ")} · {String(saved?.dtype)}</p>
            {acquisition && <p>Planes with elapsed times · {String(acquisition.planes_with_delta_t)}. Planes with stage positions · {String(acquisition.planes_with_stage_position)}.</p>}
            <p>Source XY crop (x, y, width, height) · {Array.isArray(selection?.crop_xywh) && selection.crop_xywh.join(", ")}</p>
            <p>Bio-Formats {String(runtime?.bioformats_version)} · {String(runtime?.java_version)}</p>
            <dl className="research-vendor-kv">
              <div><dt>Original SHA-256</dt><dd><code>{String(receipt?.source_sha256)}</code></dd></div>
              <div><dt>OME-TIFF SHA-256</dt><dd><code>{source.sha256}</code></dd></div>
            </dl>
          </section>;
        })}
      </details>}
      {status && <p role="status" className="research-vendor-status">{status}</p>}
    </div>
  );
}
