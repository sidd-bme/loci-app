"""Trusted desktop publication of a native DynaCell iPSC virtual nuclear stain."""

from __future__ import annotations

import hashlib
import math
import os
import platform
import re
from dataclasses import asdict
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np
import tifffile

from .export import _NamedBinaryStream
from .file_fingerprint import _sha256_file_stable
from .models import ENGINE_VERSION
from .native_image import MAX_OME_XML_BYTES, NativeImageSession, NativeSelection
from .research_project import SHA_PATTERN, canonical_json, checked_id
from .virtual_stain_bundle import publication

SCHEMA = "loci.dynacell-derived-source/v1"
WEIGHTS_SHA256 = "58b222f92978b50647d547e5fd69edaafa2d2c5854fbc7f7324e9bcf8835051d"
WEIGHTS_BYTES = 386_093_992
CHANNELS = ("Predicted nuclear stain (DynaCell)", "Phase3D")
PROFILE = {
    "schema": "loci.dynacell-prediction/v1",
    "model": "DynaCell iPSC nucleus UNeXt2",
    "weights_sha256": WEIGHTS_SHA256,
    "weights_bytes": WEIGHTS_BYTES,
    "phase_confirmation": "User confirmed native reconstructed Phase3D of healthy unperturbed iPSC",
    "axes": "CZYX",
    "dtype": "float32",
    "channels": [
        {"name": CHANNELS[0], "kind": "prediction", "units": "dimensionless target-IQR-normalized"},
        {"name": CHANNELS[1], "kind": "source", "units": "stored phase units"},
    ],
    "spatial_interpretation": "Level-zero voxel centers, local origin (0,0,0), unresampled",
    "edge_context": "Blended adjacent 15-Z windows with reduced context at field edges",
    "normalization": "Full selected ZYX phase field, float64 mean and population SD, epsilon 1e-8",
    "validation_scope": (
        "Numerical reference comparison only. Biological accuracy is unverified for this field."
    ),
}
REQUEST_FIELDS = {"source_id", "source_sha256", "channel", "timepoint", "phase_confirmed"}
IMAGE = "image.ome.tif"
SIDECAR = "provenance.json"


def _fields(value, fields):
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("Incomplete or unknown virtual stain fields")


def _hash(value):
    if not isinstance(value, str) or not SHA_PATTERN.fullmatch(value):
        raise ValueError("Invalid virtual stain fingerprint")


def _natural(value):
    return type(value) is int and 0 <= value <= 2**31 - 1


def _spacing(values):
    # Half the final decimal place in the three-decimal publisher grid (µm).
    if (
        not isinstance(values, (list, tuple))
        or len(values) != 3
        or not all(
            type(v) in (float, int) and math.isclose(v, ref, abs_tol=0.0005, rel_tol=0)
            for v, ref in zip(values, (0.290, 0.108, 0.108), strict=True)
        )
    ):
        raise ValueError("DynaCell requires native ZYX spacing of 0.290, 0.108, 0.108 µm")


def _shape(values):
    if (
        not isinstance(values, (tuple, list))
        or len(values) != 3
        or not all(_natural(v) for v in values)
        or not 15 <= values[0] <= 40
        or tuple(values[1:]) != (512, 512)
    ):
        raise ValueError("DynaCell requires native 15–40 × 512 × 512 ZYX float32 data")


def _bytes(record):
    return (canonical_json(record) + "\n").encode()


def validate_derivation(value, fingerprint, metadata):
    """Offline validation uses closed scientific fields and exact artifact bindings."""
    _fields(value, {"schema", "record", "provenance_sha256"})
    record = value["record"]
    _fields(
        record,
        {
            "profile",
            "source_id",
            "source_sha256",
            "series",
            "channel",
            "timepoint",
            "level",
            "start_zyx",
            "end_exclusive_zyx",
            "spacing_zyx_um",
            "kernel_mean_float32",
            "kernel_std_float32",
            "mean",
            "std",
            "population_voxels",
            "runtime",
            "phase_pixels_sha256",
            "prediction_pixels_sha256",
            "artifact_sha256",
        },
    )
    if (
        value["schema"] != SCHEMA
        or canonical_json(record["profile"]) != canonical_json(PROFILE)
        or hashlib.sha256(_bytes(record)).hexdigest() != value["provenance_sha256"]
        or record["artifact_sha256"] != fingerprint
    ):
        raise ValueError("Virtual stain receipt failed artifact or provenance binding")
    for field in (
        "source_sha256",
        "phase_pixels_sha256",
        "prediction_pixels_sha256",
        "artifact_sha256",
    ):
        _hash(record[field])
    checked_id(record["source_id"])
    shape = record["end_exclusive_zyx"]
    _shape(shape)
    _spacing(record["spacing_zyx_um"])
    if (
        not all(
            _natural(record[k])
            for k in ("series", "channel", "timepoint", "level", "population_voxels")
        )
        or record["level"] != 0
        or canonical_json(record["start_zyx"]) != "[0,0,0]"
        or record["population_voxels"] != math.prod(shape)
        or any(
            type(record[k]) not in (int, float) or not math.isfinite(record[k])
            for k in ("mean", "std", "kernel_mean_float32", "kernel_std_float32")
        )
        or record["kernel_mean_float32"] != float(np.float32(record["mean"]))
        or record["kernel_std_float32"] != float(np.float32(record["std"]))
        or record["kernel_std_float32"] <= 0
    ):
        raise ValueError("Invalid virtual stain selection or preprocessing population")
    runtime = record["runtime"]
    _fields(runtime, {"engine", "python", "numpy", "torch", "device"})
    if runtime["device"] != "cpu" or not all(
        isinstance(runtime[k], str) and re.fullmatch(r"[0-9][0-9A-Za-z+.\-]{0,63}", runtime[k])
        for k in ("engine", "python", "numpy", "torch")
    ):
        raise ValueError("Invalid virtual stain runtime")
    if metadata is not None:
        expected = {
            "sha256": fingerprint,
            "format": "OME-TIFF",
            "source_axes": "CZYX",
            "source_shape": [2, *shape],
            "axes": "TCZYX",
            "shape": [1, 2, *shape],
            "selected_series": 0,
            "series_count": 1,
            "sample_semantics": "none",
            "channel_names": CHANNELS,
            "channel_dtypes": ["float32", "float32"],
            "dimensions": {
                "s": 1,
                "t": 1,
                "c": 2,
                **dict(zip(("z", "y", "x"), shape, strict=True)),
            },
            "physical_calibration": {
                "axes": "ZYX",
                "unit": "µm",
                "spacing": record["spacing_zyx_um"],
            },
            "plane_positions": [],
        }
        expected["levels"] = [
            {
                "index": 0,
                "dimensions": expected["dimensions"],
                "calibration": expected["physical_calibration"],
                "origin_xyz": None,
            }
        ]
        if any(canonical_json(metadata.get(k)) != canonical_json(v) for k, v in expected.items()):
            raise ValueError("Virtual stain metadata differs from its derivation")
    return value


def validate_origin(record, source):
    """Resolve selected series, native bounds and channel against the registered parent."""
    if (
        not source
        or source["id"] != record["source_id"]
        or source["sha256"] != record["source_sha256"]
    ):
        raise ValueError("Virtual stain parent fingerprint or identity differs from its receipt")
    meta = source["metadata"]
    dims = meta.get("dimensions", {})
    channel = record["channel"]
    if (
        source.get("source_kind") != "native"
        or meta.get("format") != "OME-TIFF"
        or meta.get("selected_series") != record["series"]
        or meta.get("sample_semantics") != "none"
        or dims.get("s") != 1
        or [dims.get(k) for k in ("z", "y", "x")] != record["end_exclusive_zyx"]
        or record["timepoint"] >= dims.get("t", 0)
        or channel >= dims.get("c", 0)
        or meta.get("channel_names", [])[channel : channel + 1] != ["Phase3D"]
        or meta.get("channel_dtypes", [])[channel : channel + 1] != ["float32"]
        or meta.get("physical_calibration")
        != {"axes": "ZYX", "unit": "µm", "spacing": record["spacing_zyx_um"]}
    ):
        raise ValueError("Virtual stain parent grid or channel differs from its receipt")


def _xml(tiff):
    xml = tiff.ome_metadata
    if not xml or len(xml.encode()) > MAX_OME_XML_BYTES or "<!DOCTYPE" in xml or "<!ENTITY" in xml:
        raise ValueError("DynaCell requires bounded self-contained OME metadata")
    return ET.fromstring(xml)


def _check_geometry(path, series):
    # Reject spatial metadata that the plain output grid cannot reproduce. TIFF
    # orientation is independently enforced by the native reader on every plane.
    with tifffile.TiffFile(path) as tif:
        root = _xml(tif)
        if root.findall(".//{*}TiffData/{*}UUID"):
            raise ValueError("DynaCell requires a self-contained OME-TIFF")
        image = root.findall("{*}Image")[series]
        if (
            image.find("{*}StageLabel") is not None
            or any(
                node.tag.rsplit("}", 1)[-1] in {"Transform", "AffineTransform"}
                for node in image.iter()
            )
            or any(
                any(k.startswith("Position") for k in plane.attrib)
                for plane in image.findall(".//{*}Plane")
            )
            or any(tag in page.tags for page in tif.pages for tag in (33550, 33922, 34264))
        ):
            raise ValueError("DynaCell cannot preserve stage positions or transformed geometry")


def verify_embedded_record(path, record):
    """Bind scientific claims to the exact TIFF, even after portable relinking."""
    with tifffile.TiffFile(path) as tif:
        description = _xml(tif).findtext("{*}Image/{*}Description")
    embedded = {k: v for k, v in record.items() if k != "artifact_sha256"}
    if description != canonical_json(embedded):
        raise ValueError("Virtual stain embedded provenance differs from its registered derivation")


def _read_phase(session, request):
    m = session.metadata
    d = m.dimensions
    c, t = request["channel"], request["timepoint"]
    if (
        m.format != "OME-TIFF"
        or m.sample_semantics != "none"
        or d.s != 1
        or not (_natural(c) and c < d.c and _natural(t) and t < d.t)
        or m.channel_names[c] != "Phase3D"
        or m.channel_dtypes[c] != "float32"
    ):
        raise ValueError("Select a native scalar float32 Phase3D channel and valid timepoint")
    shape = (d.z, d.y, d.x)
    _shape(shape)
    cal = m.physical_calibration
    if (
        cal is None
        or cal.axes != "ZYX"
        or cal.unit != "µm"
        or m.plane_positions
        or m.levels[0].origin_xyz is not None
    ):
        raise ValueError("DynaCell requires an axis-aligned native calibrated ZYX grid")
    _spacing(cal.spacing)
    phase = np.empty(shape, dtype=np.float32)
    with session.region_reader() as read:
        for z in range(d.z):
            plane = read(NativeSelection(0, 0, d.x, d.y, t=t, c=c, z=z, series=m.selected_series))
            if (
                plane.axes != "YX"
                or plane.pixels.shape != shape[1:]
                or plane.pixels.dtype != phase.dtype
            ):
                raise ValueError("Phase plane differs from its native shape, axes or dtype")
            phase[z] = plane.pixels
    if not np.isfinite(phase).all():
        raise ValueError("Phase3D contains non-finite values")
    return phase


def _predict(phase, checkpoint, mean, std):
    import torch

    from .dynacell import CHECKPOINT_BYTES, CHECKPOINT_SHA256, predict_virtual_nuclei

    if (CHECKPOINT_SHA256, CHECKPOINT_BYTES) != (WEIGHTS_SHA256, WEIGHTS_BYTES):
        raise ValueError("Installed kernel and publication profile disagree on checkpoint identity")
    prediction = predict_virtual_nuclei(phase, checkpoint, mean=mean, std=std)
    return prediction, str(torch.__version__)


def _infer(session, request, checkpoint):
    phase = _read_phase(session, request)
    mean = float(phase.mean(dtype=np.float64))
    std = float(phase.std(dtype=np.float64))
    if not math.isfinite(std) or std <= 0:
        raise ValueError("Phase3D must have positive full-field standard deviation")
    phase.setflags(write=False)
    kernel_mean, kernel_std = float(np.float32(mean)), float(np.float32(std))
    if kernel_std <= 0:
        raise ValueError("Phase3D population standard deviation underflows float32")
    prediction, torch_version = _predict(phase, checkpoint, kernel_mean, kernel_std)
    if (
        not isinstance(prediction, np.ndarray)
        or prediction.shape != phase.shape
        or prediction.dtype != phase.dtype
        or not np.isfinite(prediction).all()
    ):
        raise ValueError("DynaCell returned invalid predicted values or native grid")
    record = {
        "profile": PROFILE,
        "source_id": request["source_id"],
        "source_sha256": session.metadata.sha256,
        "channel": request["channel"],
        "timepoint": request["timepoint"],
        "series": session.metadata.selected_series,
        "level": 0,
        "start_zyx": [0, 0, 0],
        "end_exclusive_zyx": list(phase.shape),
        "spacing_zyx_um": list(session.metadata.physical_calibration.spacing),
        "mean": mean,
        "std": std,
        "kernel_mean_float32": kernel_mean,
        "kernel_std_float32": kernel_std,
        "population_voxels": phase.size,
        "phase_pixels_sha256": hashlib.sha256(phase).hexdigest(),
        "prediction_pixels_sha256": hashlib.sha256(np.ascontiguousarray(prediction)).hexdigest(),
        "runtime": {
            "device": "cpu",
            "engine": ENGINE_VERSION,
            "numpy": np.__version__,
            "torch": torch_version,
            "python": platform.python_version(),
        },
    }
    return phase, prediction, record


def _write(bundle, phase, prediction, record):
    metadata = {
        "axes": "CZYX",
        "Description": canonical_json(record),
        "Channel": {"Name": list(CHANNELS)},
    }
    for axis, spacing in zip("ZYX", record["spacing_zyx_um"], strict=True):
        metadata["PhysicalSize" + axis] = spacing
        metadata["PhysicalSize" + axis + "Unit"] = "µm"
    with bundle.file(IMAGE) as stream:
        tifffile.imwrite(
            _NamedBinaryStream(stream, IMAGE),
            (plane for volume in (prediction, phase) for plane in volume),
            shape=(2, *phase.shape),
            dtype=phase.dtype,
            ome=True,
            photometric="minisblack",
            metadata=metadata,
        )
        stream.flush()
        os.fsync(stream.fileno())
        size = stream.seek(0, os.SEEK_END)
        stream.seek(0)
        record = {**record, "artifact_sha256": hashlib.file_digest(stream, "sha256").hexdigest()}
    data = _bytes(record)
    digest = hashlib.sha256(data).hexdigest()
    with bundle.file(SIDECAR) as sidecar:
        sidecar.write(data)
        sidecar.flush()
        os.fsync(sidecar.fileno())
    files = {
        IMAGE: {"sha256": record["artifact_sha256"], "size_bytes": size},
        SIDECAR: {"sha256": digest, "size_bytes": len(data)},
    }
    bundle.verify(files)
    return {"schema": SCHEMA, "record": record, "provenance_sha256": digest}, files


def run(workbench, request, destination, checkpoint):
    _fields(request, REQUEST_FIELDS)
    _hash(request["source_sha256"])
    if request["phase_confirmed"] is not True:
        raise ValueError("Confirm reconstructed Phase3D from healthy unperturbed iPSC")
    project = workbench.project
    target = Path(destination)
    weights = Path(checkpoint)
    # The kernel verifies the digest of the same bytes it deserializes.
    source = project.source(request["source_id"])
    if (
        source.get("source_kind") != "native"
        or source.get("locator_state") == "relink-required"
        or source["sha256"] != request["source_sha256"]
        or source["metadata"].get("format") != "OME-TIFF"
    ):
        raise ValueError("Select a registered native OME-TIFF matching this source fingerprint")
    path = Path(source["private_path"])
    with publication(project, target, (path, weights)) as bundle:
        if (
            not weights.is_absolute()
            or weights.resolve(strict=True) != weights
            or not weights.is_file()
            or weights.stat().st_size != WEIGHTS_BYTES
        ):
            raise ValueError("Select the fixed DynaCell checkpoint")
        if path.resolve(strict=True) != path:
            raise ValueError("Phase source location became linked")
        series = source["metadata"]["selected_series"]
        if _sha256_file_stable(path, reject_symlink=True) != (
            source["sha256"],
            source["size_bytes"],
        ):
            raise ValueError("Registered Phase3D source bytes changed")
        _check_geometry(path, series)
        with NativeImageSession(path, series=series, expected_sha256=source["sha256"]) as session:
            if canonical_json(asdict(session.metadata)) != canonical_json(source["metadata"]):
                raise ValueError("Registered native metadata differs from current Phase3D data")
            phase, prediction, record = _infer(session, request, weights)
            bundle.start()
            derivation, files = _write(bundle, phase, prediction, record)
            session.verify_strict()
            bundle.publish()

            def verify_publication():
                bundle.verify(files)
                session.validate_source()
                bundle.guard()

            image = target / IMAGE
            digest = derivation["record"]["artifact_sha256"]
            with NativeImageSession(image, expected_sha256=digest) as output:
                derived = project.register_source(
                    image,
                    digest,
                    asdict(output.metadata),
                    name=(
                        f"DynaCell predicted nuclei · {source['name'][:210]}"
                        f" · T{request['timepoint']}"
                    ),
                    derivation=derivation,
                    publication_guard=verify_publication,
                )
                bundle.registered = True
        return {"snapshot": workbench.snapshot(), "source": derived}
