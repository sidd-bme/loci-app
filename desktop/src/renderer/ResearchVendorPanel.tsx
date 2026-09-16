import { useMemo, useRef, useState } from "react";
import type {
  ResearchDesktopApi,
  ResearchSnapshot,
} from "../shared/research-contracts";
import "./ResearchVendorPanel.css";

type Report = <T>(
  work: () => Promise<T>,
  fallback: string,
) => Promise<T | undefined>;

type Dimensions = { x: number; y: number; z: number; c: number; t: number };
type VendorSeries = {
  index: number;
  dimensions: Dimensions;
  dimension_order: string;
  dtype: string;
  channel_names: string[];
  samples_per_channel: number[];
  calibration: Record<string, { value: number; unit: string }> | null;
};
type VendorInspection = {
  schema_version: "loci.vendor-inspection/v1";
  format: string;
  source_size_bytes: number;
  source_sha256: string;
  series: VendorSeries[];
  runtime: {
    bioformats_version: string;
    bioformats_jar_sha256: string;
    bioformats_jar_size_bytes: number;
    java_sha256: string;
    java_version: string;
  };
};
type VendorGrant = {
  grant_id: string;
  source_name: string;
  source_sha256: string;
  inspection: VendorInspection;
};
type VendorRequest = {
  grant_id: string;
  series: number;
  c: number;
  z: number;
  t: number;
  crop: { x: number; y: number; width: number; height: number } | null;
  heap_mib: number;
  timeout_seconds: number;
  max_output_bytes: number;
};
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
      !/^[XYZCT]{5}$/u.test(item.dimension_order) ||
      typeof item.dtype !== "string" || !(item.dtype in DTYPE_BYTES) ||
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
): VendorConversion {
  const outer = record(value);
  const snapshot = record(outer?.snapshot);
  const conversion = record(outer?.conversion);
  const artifact = record(conversion?.artifact);
  if (
    !outer || !snapshot || !record(snapshot.project) ||
    !Array.isArray(snapshot.sources) || !Array.isArray(snapshot.results) ||
    !conversion || conversion.schema_version !== "loci.vendor-conversion-receipt/v1" ||
    conversion.source_sha256 !== grant.source_sha256 ||
    conversion.bioformats_jar_sha256 !==
      grant.inspection.runtime.bioformats_jar_sha256 ||
    !artifact || typeof artifact.sha256 !== "string" || !HASH.test(artifact.sha256) ||
    typeof artifact.pixel_sha256 !== "string" || !HASH.test(artifact.pixel_sha256)
  ) throw new Error("Vendor conversion returned an invalid identity-bound receipt.");
  return outer as unknown as VendorConversion;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
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
  const selectedC = dimensions ? integer(channel, 0, dimensions.c - 1) : null;
  const selectedZ = dimensions ? integer(z, 0, dimensions.z - 1) : null;
  const selectedT = dimensions ? integer(t, 0, dimensions.t - 1) : null;
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
  const scalar = Boolean(
    series && selectedC !== null && series.samples_per_channel[selectedC] === 1,
  );
  const outputWidth = cropEnabled ? width : dimensions?.x;
  const outputHeight = cropEnabled ? height : dimensions?.y;
  const estimatedBytes = series && outputWidth && outputHeight
    ? outputWidth * outputHeight * DTYPE_BYTES[series.dtype]
    : null;
  const limitsValid = Boolean(
    heap !== null && timeout !== null && maxMiB !== null && estimatedBytes !== null &&
      estimatedBytes <= 512 * 1024 ** 2 && estimatedBytes <= maxMiB! * 1024 ** 2,
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
      crop: cropEnabled ? { x: x!, y: y!, width: width!, height: height! } : null,
      heap_mib: heap,
      timeout_seconds: timeout,
      max_output_bytes: maxMiB * 1024 ** 2,
    };
  }, [
    cropEnabled, cropValid, grant, heap, height, limitsValid, maxMiB, scalar,
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
          return value === null ? null : checkedConversion(value, exactGrant);
        },
        "Could not convert and import the exact selected vendor plane.",
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
      setStatus("Converted the exact selected plane and imported it as a derived OME-TIFF source.");
    } finally {
      if (generation === conversionGeneration.current) {
        setLocalBusy(false);
        onBusyChange(false);
      }
    }
  };

  const artifact = record(conversion?.artifact);
  return (
    <div className="research-panel research-vendor">
      <h2>Vendor image conversion</h2>
      <p>
        Convert one explicitly selected scalar plane from CZI, LIF, or ND2 into a
        derived OME-TIFF source. The vendor file remains immutable; the converted
        source carries an identity-bound receipt and enters <strong>{snapshot.project.title}</strong>.
      </p>
      <div className="research-vendor-boundary">
        <strong>Optional external reader</strong>
        <p>
          Loci never downloads or bundles Bio-Formats or Java. Choose a locally
          provisioned official Bio-Formats 8.5.0 package and Java executable in the
          native dialogs. Bio-Formats carries GPL and commercial-licence options;
          confirm the terms for your use and distribution.
        </p>
      </div>
      <button
        className="research-primary"
        disabled={disabled || !vendorApi.inspectVendor}
        onClick={() => void inspect()}
      >
        Inspect local vendor source and reader
      </button>
      {!vendorApi.inspectVendor && (
        <p role="alert">This desktop build does not provide native vendor inspection.</p>
      )}

      {grant && series && dimensions && (
        <>
          <section className="research-vendor-card" aria-label="Exact vendor inspection">
            <h3>Exact local identities</h3>
            <dl className="research-vendor-kv">
              <div><dt>Source</dt><dd>{grant.source_name}</dd></div>
              <div><dt>Format / size</dt><dd>{grant.inspection.format.toUpperCase()} · {bytes(grant.inspection.source_size_bytes)}</dd></div>
              <div><dt>Source SHA-256</dt><dd><code>{grant.source_sha256}</code></dd></div>
              <div><dt>Bio-Formats</dt><dd>{grant.inspection.runtime.bioformats_version}</dd></div>
              <div><dt>Reader SHA-256</dt><dd><code>{grant.inspection.runtime.bioformats_jar_sha256}</code></dd></div>
              <div><dt>Java</dt><dd>{grant.inspection.runtime.java_version}</dd></div>
              <div><dt>Java SHA-256</dt><dd><code>{grant.inspection.runtime.java_sha256}</code></dd></div>
            </dl>
          </section>

          <section className="research-vendor-card" aria-label="Exact vendor plane selection">
            <h3>Exact series and plane</h3>
            <label>
              Series
              <select aria-label="Vendor series" value={seriesIndex} disabled={disabled}
                onChange={(event) => chooseSeries(event.target.value)}>
                {grant.inspection.series.map((item) => (
                  <option key={item.index} value={item.index}>
                    {item.index + 1}: {item.dimensions.x}×{item.dimensions.y} · {item.dimensions.z} Z · {item.dimensions.c} C · {item.dimensions.t} T
                  </option>
                ))}
              </select>
            </label>
            <p className="research-vendor-series">
              Order {series.dimension_order} · {series.dtype} · channels {series.channel_names.join(", ")}
              {series.calibration ? ` · calibration ${Object.entries(series.calibration).map(([axis, item]) => `${axis.toUpperCase()} ${item.value} ${item.unit}`).join(", ")}` : " · no physical calibration reported"}
            </p>
            <div className="research-vendor-grid">
              <label>Channel<select aria-label="Vendor channel" value={channel} disabled={disabled}
                onChange={(event) => { conversionGeneration.current += 1; setConversion(null); setChannel(event.target.value); }}>
                {series.channel_names.map((name, index) => (
                  <option key={index} value={index}>{index}: {name} · {series.samples_per_channel[index]} sample{series.samples_per_channel[index] === 1 ? "" : "s"}</option>
                ))}
              </select></label>
              <label>Z index<input aria-label="Vendor Z index" type="number" min="0" max={dimensions.z - 1} step="1" value={z} disabled={disabled} onChange={(event) => setZ(event.target.value)} /></label>
              <label>T index<input aria-label="Vendor T index" type="number" min="0" max={dimensions.t - 1} step="1" value={t} disabled={disabled} onChange={(event) => setT(event.target.value)} /></label>
            </div>
            {!scalar && <p role="alert">The selected channel contains multiple RGB samples. Choose a scalar acquisition channel; RGB components are not biological channels.</p>}
            <label className="research-vendor-check">
              <input aria-label="Crop vendor plane" type="checkbox" checked={cropEnabled} disabled={disabled}
                onChange={(event) => setCropEnabled(event.target.checked)} />
              Convert an explicit half-open crop instead of the full plane
            </label>
            {cropEnabled && (
              <div className="research-vendor-grid">
                <label>Crop X<input aria-label="Vendor crop X" type="number" min="0" max={dimensions.x - 1} step="1" value={cropX} disabled={disabled} onChange={(event) => setCropX(event.target.value)} /></label>
                <label>Crop Y<input aria-label="Vendor crop Y" type="number" min="0" max={dimensions.y - 1} step="1" value={cropY} disabled={disabled} onChange={(event) => setCropY(event.target.value)} /></label>
                <label>Width<input aria-label="Vendor crop width" type="number" min="1" max={dimensions.x} step="1" value={cropWidth} disabled={disabled} onChange={(event) => setCropWidth(event.target.value)} /></label>
                <label>Height<input aria-label="Vendor crop height" type="number" min="1" max={dimensions.y} step="1" value={cropHeight} disabled={disabled} onChange={(event) => setCropHeight(event.target.value)} /></label>
              </div>
            )}
            {!cropValid && <p role="alert">The crop must be an integer rectangle contained within this exact series.</p>}
          </section>

          <section className="research-vendor-card" aria-label="Vendor conversion limits">
            <h3>Bounded local conversion</h3>
            <div className="research-vendor-grid">
              <label>Java heap MiB<input aria-label="Vendor heap MiB" type="number" min="256" max="4096" step="1" value={heapMiB} disabled={disabled} onChange={(event) => setHeapMiB(event.target.value)} /></label>
              <label>Timeout seconds<input aria-label="Vendor timeout seconds" type="number" min="1" max="1800" step="1" value={timeoutSeconds} disabled={disabled} onChange={(event) => setTimeoutSeconds(event.target.value)} /></label>
              <label>Maximum output MiB<input aria-label="Vendor maximum output MiB" type="number" min="1" max="1024" step="1" value={maxOutputMiB} disabled={disabled} onChange={(event) => setMaxOutputMiB(event.target.value)} /></label>
            </div>
            <p>
              Requested output: {outputWidth ?? "—"} × {outputHeight ?? "—"} {series.dtype};
              decoded plane {estimatedBytes === null ? "—" : bytes(estimatedBytes)}. No scale,
              projection, channel merge, or intensity normalization is applied.
            </p>
            {!limitsValid && <p role="alert">Use integer limits within 256–4,096 MiB heap, 1–1,800 seconds, and 1–1,024 MiB output; the decoded plane must fit both the output limit and 512 MiB decode bound.</p>}
            <button className="research-primary" disabled={disabled || !vendorApi.convertVendor || !request}
              onClick={() => void convert()}>
              Convert exact plane and import derived source
            </button>
          </section>
        </>
      )}

      {conversion && artifact && (
        <section className="research-vendor-card research-vendor-receipt" aria-label="Vendor conversion receipt">
          <h3>Imported derived source</h3>
          <p>Artifact SHA-256 <code>{shortHash(String(artifact.sha256))}</code></p>
          <p>Pixel SHA-256 <code>{shortHash(String(artifact.pixel_sha256))}</code></p>
        </section>
      )}
      {status && <p role="status" className="research-vendor-status">{status}</p>}
    </div>
  );
}
