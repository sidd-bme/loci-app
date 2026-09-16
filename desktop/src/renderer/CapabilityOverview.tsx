const capabilities = [
  { name: "Native 2D imaging", status: "Included", tone: "ready",
    note: "Full-image fit, source-grid regions, native pyramid levels, channels, Z/T selection, and display provenance." },
  { name: "Large microscopy & pathology", status: "Included", tone: "ready",
    note: "Bounded tiled TIFF, OME-TIFF, IMS, SVS, and NDPI routes with declared pyramid, calibration, and ICC handling where present." },
  { name: "Volumes, time & medical imaging", status: "Included", tone: "ready",
    note: "Raw-volume and linked MPR viewing for supported scalar stacks, plus bounded time-series, NIfTI, NRRD, and conventional CT/MR DICOM subsets." },
  { name: "Learned analysis", status: "Provisioned", tone: "optional",
    note: "Managed ONNX and Cellpose routes appear only after an exact compatible model and runtime are explicitly supplied and validated." },
  { name: "Remote compute", status: "Configured as needed", tone: "optional",
    note: "SSH with direct, PBS, or Slurm execution is available only for an explicitly configured site and pinned remote runtime." },
] as const;

export default function CapabilityOverview(): React.JSX.Element {
  return <div><div className="capability-list">{capabilities.map((capability) =>
    <div className="capability-row" key={capability.name}><div><strong>{capability.name}</strong>
      <small>{capability.note}</small></div>
      <span className={`capability-status is-${capability.tone}`}>{capability.status}</span></div>)}</div>
    <p className="capability-footnote">Opening a source never downloads a model, runtime, or decoder. These are implemented engineering routes, not universal reader coverage, biological validation, clinical validation, or release clearance.</p></div>;
}
