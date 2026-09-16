import { useEffect, useRef, useState } from "react";
import type {
  ResearchDesktopApi,
  ResearchResult,
} from "../shared/research-contracts";
import "./ResearchInterchangePanel.css";

type Report = <T>(
  work: () => Promise<T>,
  fallback: string,
) => Promise<T | undefined>;
type Info = {
  result_id: string;
  revision_hash: string;
  measurement_channels: Array<{ index: number; name: string; basis: string }>;
};
type Format = "geojson" | "imagej";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  return btoa(binary);
}

function childFrom(value: unknown, parent: ResearchResult): ResearchResult {
  if (!value || typeof value !== "object")
    throw new Error("Annotation import returned no immutable child revision.");
  const child = (value as { result?: ResearchResult }).result;
  if (
    !child ||
    typeof child.id !== "string" ||
    child.id === parent.id ||
    child.parent_id !== parent.id ||
    child.source_id !== parent.source_id ||
    typeof child.revision_hash !== "string" ||
    child.review != null
  )
    throw new Error(
      "Annotation import did not return an unreviewed child revision.",
    );
  return child;
}

export function ResearchInterchangePanel({
  api,
  result,
  report,
  busy,
  onBusyChange,
  onResult,
}: {
  api: ResearchDesktopApi;
  result: ResearchResult | null;
  report: Report;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onResult: (result: ResearchResult) => Promise<void>;
}): React.JSX.Element {
  const [info, setInfo] = useState<Info | null>(null);
  const [format, setFormat] = useState<Format>("geojson");
  const [file, setFile] = useState<File | null>(null);
  const [channels, setChannels] = useState<number[]>([]);
  const [localBusy, setLocalBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const locked = busy || localBusy;

  useEffect(() => {
    let active = true;
    setInfo(null);
    setFile(null);
    setStatus(null);
    if (input.current) input.current.value = "";
    if (!result) return () => void (active = false);
    void api
      .execute("correction_info", {
        result_id: result.id,
        revision_hash: result.revision_hash,
      })
      .then((value) => {
        if (!active) return;
        const next = value as Info;
        if (
          !next ||
          next.result_id !== result.id ||
          next.revision_hash !== result.revision_hash ||
          !Array.isArray(next.measurement_channels)
        )
          throw new Error(
            "Annotation channels do not match the selected exact revision.",
          );
        setInfo(next);
        setChannels(
          next.measurement_channels.length
            ? [next.measurement_channels[0].index]
            : [],
        );
      })
      .catch(() => {
        if (active)
          setStatus("Could not bind annotation import to this exact revision.");
      });
    return () => {
      active = false;
    };
  }, [api, result?.id, result?.revision_hash]);

  const chooseFile = (selected: File | null) => {
    setFile(selected);
    setStatus(null);
    if (!selected) return;
    if (selected.name.toLowerCase().endsWith(".roi")) setFormat("imagej");
    else setFormat("geojson");
  };

  const submit = async () => {
    if (!result || !info || !file || locked || !channels.length) return;
    setLocalBusy(true);
    onBusyChange(true);
    try {
      const child = await report(async () => {
        if (file.size <= 0 || file.size > MAX_FILE_BYTES)
          throw new Error("Choose an annotation file no larger than 8 MiB.");
        const payload =
          format === "geojson"
            ? await file.text()
            : toBase64(await file.arrayBuffer());
        const request = {
          result_id: result.id,
          revision_hash: result.revision_hash,
          format,
          payload,
          measurement_channels: channels,
        };
        if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 12 * 1024 ** 2)
          throw new Error("Encoded annotation request exceeds 12 MiB; split the annotation collection.");
        const output = await api.execute("roi_import", request);
        return childFrom(output, result);
      }, "Annotation import failed for this exact result revision.");
      if (child) {
        setStatus(`Imported ${file.name} into a new unreviewed revision.`);
        await onResult(child);
      }
    } finally {
      setLocalBusy(false);
      onBusyChange(false);
    }
  };

  if (!result)
    return (
      <div className="research-panel research-interchange">
        <h2>Annotation import</h2>
        <p>Select an exact result before importing annotations.</p>
      </div>
    );

  return (
    <div className="research-panel research-interchange">
      <h2>Annotation import</h2>
      <p>
        Import a Loci polygon GeoJSON file or Loci-authored ImageJ ROI. The file
        must match this source, result revision, image shape, and voxel-to-world
        geometry.
      </p>
      <label>
        Annotation format
        <select
          aria-label="Annotation format"
          value={format}
          disabled={locked}
          onChange={(event) => {
            setFormat(event.target.value as Format);
            setFile(null);
            setStatus(null);
            if (input.current) input.current.value = "";
          }}
        >
          <option value="geojson">Loci polygon GeoJSON</option>
          <option value="imagej">Loci-authored ImageJ ROI</option>
        </select>
      </label>
      <label className="research-interchange-file">
        Annotation file
        <input
          ref={input}
          aria-label="Annotation file"
          type="file"
          accept={
            format === "geojson" ? ".geojson,.json,application/json" : ".roi"
          }
          disabled={locked}
          onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <p className="research-interchange-binding">
        Exact revision: <code>{result.revision_hash}</code>
      </p>
      <fieldset disabled={locked || !info}>
        <legend>Intensity measurement channels</legend>
        {info?.measurement_channels.map((channel) => (
          <label className="research-check" key={channel.index}>
            <input
              type="checkbox"
              aria-label={`Measure ${channel.name}`}
              checked={channels.includes(channel.index)}
              onChange={(event) =>
                setChannels((current) =>
                  event.target.checked
                    ? [...current, channel.index].sort((a, b) => a - b)
                    : current.filter((value) => value !== channel.index),
                )
              }
            />
            <span>{channel.name}</span>
            <small>{channel.basis}</small>
          </label>
        ))}
      </fieldset>
      <div className="research-actions">
        <button
          disabled={locked || !info || !file || !channels.length}
          onClick={() => void submit()}
        >
          Import into new revision
        </button>
      </div>
      {status && <p role="status">{status}</p>}
      <p className="research-interchange-note">
        Imported measurements are descriptive. Review the new revision before
        export or study comparison.
      </p>
    </div>
  );
}
