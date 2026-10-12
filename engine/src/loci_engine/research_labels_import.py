"""Trusted, exact native-grid adoption of an external scalar TIFF label plane.

Only this trusted picker/CLI boundary accepts a path. Durable requests contain an
opaque private grant identity; adopted revisions depend only on canonical arrays.
"""

from __future__ import annotations

import copy
import hashlib
import stat
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import tifffile

from .native_image import NativeImageSession, NativeSelection, _ome_details, _read_tiff_segments
from .quantitative import MAX_OBJECTS, exact_keys, integer, measure_objects
from .research_project import (
    MAX_ARTIFACT_BYTES,
    canonical_json,
    checked_id,
    checked_text,
)
from .working_result import _sha256_file_stable

if TYPE_CHECKING:
    from .workbench import Workbench

PROFILE = "scalar-native-yx/v1"
ALIGNMENT = "same-native-yx-grid"
REQUEST_KEYS = {"source_id", "source_sha256", "grant_id", "alignment", "producer"}


def _digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _identity(path: Path) -> list[int]:
    # Reject links in every component, including a directory selected via a link.
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("Label input must be an absolute plain file without symlinks")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Label input must be a regular file")
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def _verify_input_identity(path: Path, record: dict[str, Any]) -> None:
    before = _identity(path)
    digest, size = _sha256_file_stable(path, reject_symlink=True)
    if (
        before != record["private_file_identity"]
        or _identity(path) != before
        or digest != record["file_sha256"]
        or size != record["file_size_bytes"]
    ):
        raise ValueError("External label input changed during identity verification")


def _source_binding(
    workbench: Workbench, source_id: str, source_sha256: str, selection: Any
) -> dict[str, Any]:
    source = workbench.project.source(checked_id(source_id), verify=True)
    if source["sha256"] != source_sha256:
        raise ValueError("Import source fingerprint differs from the captured source")
    if source.get("source_kind") != "native":
        raise ValueError("Label import requires a scalar native image source")
    if not isinstance(selection, dict) or not {"t", "c", "z", "level"} <= selection.keys():
        raise ValueError("Label import requires explicit T/C/Z and native level zero")
    if "z_stop" in selection:
        raise ValueError("Label import requires one native plane, not a volume")
    session = workbench._session(source_id)
    session.verify_strict()
    metadata = session.metadata
    if metadata.dimensions.s != 1:
        raise ValueError("RGB samples cannot supply the scalar import measurement channel")
    dims = metadata.levels[0].dimensions
    resolved = workbench.selection(
        source_id, {"x": 0, "y": 0, "width": dims.x, "height": dims.y, **selection}
    )
    if (
        resolved["level"] != 0
        or resolved["x"] != 0
        or resolved["y"] != 0
        or resolved["width"] != dims.x
        or resolved["height"] != dims.y
    ):
        raise ValueError("Label import requires the complete native level-zero YX grid")
    geometry = workbench._native_geometry(session, resolved, False)
    declarations = workbench.channel_metadata(source_id)
    channel = resolved["c"]
    return {
        "source_id": source_id,
        "source_sha256": source_sha256,
        "selection": resolved,
        "geometry": geometry.to_dict(),
        "channel_metadata": declarations,
        "measurement_channel": {
            "index": channel,
            "name": f"{channel + 1}: {declarations['channels'][channel]['name']}",
            "basis": "raw-source-channel-values",
        },
    }


def _calibration(tif: tifffile.TiffFile, session: NativeImageSession, geometry: Any) -> dict:
    """OME spacing is supported; unfamiliar spatial declarations fail closed."""
    page = tif.pages[0]
    # GeoTIFF, proprietary spatial tags and TIFF positional coordinates do not
    # have a supported microscopy mapping in this initial profile.
    if any(code in page.tags for code in (286, 287, 33550, 33922, 34264, 34735, 34736, 34737)):
        raise ValueError("External label spatial TIFF metadata is unsupported")
    imagej = tif.imagej_metadata or {}
    if any(key.lower() in {"unit", "spacing", "xorigin", "yorigin", "zorigin"} for key in imagej):
        raise ValueError("ImageJ microscopic calibration is unsupported in this label profile")
    for shaped in tif.shaped_metadata or ():
        if shaped and any(
            any(
                word in key.lower()
                for word in (
                    "spacing",
                    "origin",
                    "affine",
                    "physical",
                    "unit",
                    "transform",
                    "offset",
                    "resolution",
                    "scale",
                )
            )
            for key in shaped
        ):
            raise ValueError("External label spatial metadata is unsupported")
    description = page.description or ""
    if description and not (tif.is_ome or tif.is_shaped or tif.is_imagej):
        # Unknown descriptions may encode spatial mappings the importer cannot
        # honour. Do not silently strip them from the alignment declaration.
        raise ValueError("Unknown external label description metadata is unsupported")
    calibration = None
    if tif.is_ome:
        _, calibration, _, positions, _, _ = _ome_details(tif, 0, session.metadata.dimensions)
        if positions:
            raise ValueError("External label plane-position metadata is unsupported")
    if calibration is not None:
        if calibration.axes != "YX":
            raise ValueError("External labels support only planar microscopic YX calibration")
        spacing = dict(zip(calibration.axes, calibration.spacing, strict=True))
        affine = np.asarray(geometry.affine)
        source_spacing = {
            "Y": float(np.linalg.norm(affine[:3, 1])),
            "X": float(np.linalg.norm(affine[:3, 0])),
        }
        if ("um" if calibration.unit in {"µm", "μm"} else calibration.unit) != geometry.unit or any(
            not np.isclose(spacing[axis], source_spacing[axis], rtol=1e-9, atol=0) for axis in "YX"
        ):
            raise ValueError("External microscopic calibration disagrees with the source grid")
    return {
        "microscopic_calibration": "verified-OME-spacing" if calibration else "unknown",
        "print_resolution": "ignored-as-microscopic-calibration",
        "geometry_authority": "registered-source-native-grid",
    }


def _read_labels(
    path: Path,
    binding: dict[str, Any],
    working_bytes: int,
    *,
    expected: dict[str, Any] | None = None,
) -> tuple[np.ndarray, dict[str, Any]]:
    before = _identity(path)
    if "\\" in path.name or any(ord(char) < 32 or ord(char) == 127 for char in path.name):
        raise ValueError("Label filename must be a safe portable basename")
    if not 1 <= before[2] <= min(MAX_ARTIFACT_BYTES, working_bytes):
        raise ValueError("Label input bytes exceed the bounded import allowance")
    if expected is not None and before != expected["private_file_identity"]:
        raise ValueError("External label file was replaced or changed after preview")
    digest, _ = _sha256_file_stable(path, reject_symlink=True)
    if expected is not None and digest != expected["file_sha256"]:
        raise ValueError("External label file fingerprint changed after preview")
    selection = binding["selection"]
    pixels = selection["width"] * selection["height"]
    # load_scalar's 96 bytes/pixel plus label decode/canonical arrays, compact
    # measurement arrays and preview working arrays coexist. Bound their sum.
    estimated = pixels * 192 + before[2]
    if estimated > working_bytes or pixels * 8 + 4096 > MAX_ARTIFACT_BYTES:
        raise ValueError("Combined label import arrays exceed working or export artifact bounds")
    from .workbench import geometry_from_dict

    with tifffile.TiffFile(path) as tif:
        if len(tif.series) != 1 or len(tif.pages) != 1:
            raise ValueError("Labels require one TIFF series and one page")
        series, page = tif.series[0], tif.pages[0]
        if len(series.levels) != 1 or series.axes != "YX" or len(series.pages) != 1:
            raise ValueError("Labels require exactly one native YX TIFF level")
        dtype = np.dtype(series.dtype)
        if dtype.kind != "u" or dtype.itemsize not in {1, 2, 4}:
            raise ValueError("Labels must use uint8, uint16 or uint32 samples")
        if (
            page.samplesperpixel != 1
            or page.photometric
            not in {tifffile.PHOTOMETRIC.MINISBLACK, tifffile.PHOTOMETRIC.MINISWHITE}
            or int(page.tags["Orientation"].value if "Orientation" in page.tags else 1) != 1
        ):
            raise ValueError("Labels require scalar samples and TIFF Orientation 1")
        shape = list(series.shape)
        if shape != [selection["height"], selection["width"]]:
            raise ValueError("Label dimensions disagree with the complete source YX grid")
        with NativeImageSession(path, expected_sha256=digest) as session:
            calibration = _calibration(tif, session, geometry_from_dict(binding["geometry"]))
            # Session segment decoding enforces file ranges, coverage, layout,
            # decoded strip/tile bounds and before/after file identity checks.
            session.validate_source()
            pixels_array, _, _ = _read_tiff_segments(
                tif,
                session.metadata,
                NativeSelection(
                    x=0,
                    y=0,
                    width=shape[1],
                    height=shape[0],
                    t=0,
                    c=0,
                    z=0,
                    level=0,
                    expected_sha256=digest,
                    budget_bytes=min(working_bytes, 512 * 1024**2),
                ),
            )
            session.validate_source()
            labels = np.ascontiguousarray(pixels_array, dtype=np.uint32)
            session.verify_strict()
    unique = np.unique(labels)
    count = int(np.count_nonzero(unique))
    if count > MAX_OBJECTS:
        raise ValueError("Too many objects for bounded external label import")
    # Measurement rows contain Python dictionaries, lists, strings, bounding
    # slices and a centroid KD-tree. Pixel buffers alone do not bound them.
    estimated += count * 8192
    if estimated > working_bytes:
        raise ValueError("Combined object measurement allocations exceed the import budget")
    if _identity(path) != before:
        raise ValueError("External label file changed during validation")
    record = {
        "file_name": checked_text(path.name, "Label filename"),
        "file_sha256": digest,
        "file_size_bytes": before[2],
        "original_dtype": str(dtype),
        "shape": shape,
        "axes": "YX",
        "object_count": count,
        "labels_sha256": hashlib.sha256(labels.tobytes()).hexdigest(),
        "canonical_dtype": "uint32",
        "conversion": "value-preserving-unsigned-to-uint32; IDs unchanged",
        "format": "TIFF",
        "profile": PROFILE,
        "estimated_working_bytes": estimated,
        "calibration_handling": calibration,
        "private_file_identity": before,
    }
    return labels, record


def _grant(workbench: Workbench, grant_id: str) -> dict[str, Any]:
    grant_id = checked_id(grant_id)
    envelope = next(
        (
            item
            for item in workbench.project.documents("labels_import_grant")
            if item["id"] == grant_id
        ),
        None,
    )
    if envelope is None or envelope["revision"] != 1:
        raise ValueError("Label import requires its exact private preview grant")
    grant = envelope["data"]
    integrity = grant.get("integrity_sha256")
    if integrity != _digest({k: v for k, v in grant.items() if k != "integrity_sha256"}):
        raise ValueError("Label preview grant integrity changed")
    return grant


def validate_request(workbench: Workbench, request: dict[str, Any]) -> dict[str, Any]:
    exact_keys(request, REQUEST_KEYS, "external label adoption")
    if not {"source_id", "source_sha256", "grant_id", "alignment"} <= request.keys():
        raise ValueError("External label adoption requires complete bindings and alignment")
    if request["alignment"] != ALIGNMENT:
        raise ValueError("Declare alignment on the same native YX grid")
    producer = request.get("producer")
    if producer is not None:
        exact_keys(producer, {"name", "version"}, "declared external producer")
        checked_text(producer.get("name"), "Declared producer name", 128)
        if producer.get("version") is not None:
            checked_text(producer["version"], "Declared producer version", 128)
        # Portable methods must not receive path-like declarations.
        for value in producer.values():
            if isinstance(value, str) and (
                "/" in value
                or "\\" in value
                or any(ord(char) < 32 or ord(char) == 127 for char in value)
            ):
                raise ValueError("Producer identity must not contain filesystem paths")
    grant = _grant(workbench, request["grant_id"])
    if (
        request["source_id"] != grant["source_id"]
        or request["source_sha256"] != grant["source_sha256"]
    ):
        raise ValueError("Label preview grant belongs to a different source fingerprint")
    return grant


def create_import_grant(
    workbench: Workbench,
    path: str,
    source_id: str,
    source_sha256: str,
    selection: dict[str, Any],
    working_bytes: int = 512 * 1024**2,
) -> dict[str, Any]:
    """Create a path-redacted receipt, including path-redacted I/O errors."""
    try:
        return _create_import_grant(
            workbench, path, source_id, source_sha256, selection, working_bytes
        )
    except OSError as exc:
        raise ValueError(
            "The selected label or source input is unavailable for verification"
        ) from exc


def _create_import_grant(
    workbench: Workbench,
    path: str,
    source_id: str,
    source_sha256: str,
    selection: dict[str, Any],
    working_bytes: int = 512 * 1024**2,
) -> dict[str, Any]:
    working_bytes = integer(working_bytes, "working-memory budget", 1024**2, 8 * 1024**3)
    binding = _source_binding(workbench, source_id, source_sha256, selection)
    labels, input_record = _read_labels(Path(path), binding, working_bytes)
    image, _, _ = workbench.load_scalar(
        source_id, binding["selection"], working_bytes=working_bytes
    )
    from .workbench import _png, display_scalar

    stride = max(1, int(np.ceil(max(image.shape) / 1024)))
    preview_labels = labels[::stride, ::stride]
    rgb, _ = display_scalar(image[::stride, ::stride], working_bytes=working_bytes)
    tint = np.stack(
        [(preview_labels.astype(np.uint64) * n % 223 + 32) / 255 for n in (67, 97, 137)], axis=-1
    )
    rgb = np.where((preview_labels > 0)[..., None], 0.6 * rgb + 0.4 * tint, rgb)
    # Revalidate source/channel declarations and input identities after preview.
    if _source_binding(workbench, source_id, source_sha256, binding["selection"]) != binding:
        raise ValueError("Source grid or channel declaration changed during label preview")
    _verify_input_identity(Path(path), input_record)
    grant = {
        "schema": "loci.labels-import-grant/v1",
        **binding,
        **input_record,
        "working_bytes": working_bytes,
        "private_path": str(Path(path)),
        "private_project_id": workbench.project.meta["project_id"],
    }
    grant["integrity_sha256"] = _digest(grant)
    grant_id = uuid.uuid4().hex
    workbench.project.put_document("labels_import_grant", grant_id, grant, expected_revision=0)
    public = {
        k: copy.deepcopy(v)
        for k, v in grant.items()
        if not k.startswith("private_") and k not in {"integrity_sha256", "channel_metadata"}
    }
    return {
        **public,
        "grant_id": grant_id,
        "image": _png(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8)),
        "preview_width": rgb.shape[1],
        "preview_height": rgb.shape[0],
    }


def import_labels(
    workbench: Workbench,
    request: dict[str, Any],
    *,
    job_id: str | None = None,
    publication_guard: Callable[[], None] | None = None,
) -> dict[str, Any]:
    grant = validate_request(workbench, request)
    if grant["private_project_id"] != workbench.project.meta["project_id"]:
        raise ValueError("Label preview grant belongs to a different study")
    binding_keys = {
        "source_id",
        "source_sha256",
        "selection",
        "geometry",
        "channel_metadata",
        "measurement_channel",
    }
    binding = {key: grant[key] for key in binding_keys}
    current = _source_binding(
        workbench, grant["source_id"], grant["source_sha256"], grant["selection"]
    )
    if canonical_json(current) != canonical_json(binding):
        raise ValueError("Source grid or channel declaration changed after label preview")
    labels, input_record = _read_labels(
        Path(grant["private_path"]), binding, grant["working_bytes"], expected=grant
    )
    if any(input_record[key] != grant[key] for key in input_record):
        raise ValueError("Label preview input validation changed")
    image, geometry, selection = workbench.load_scalar(
        grant["source_id"], grant["selection"], working_bytes=grant["working_bytes"]
    )
    rows = measure_objects(
        labels,
        geometry,
        {grant["measurement_channel"]["name"]: image},
        working_bytes=grant["working_bytes"],
    )
    from .workbench import result_summary, runtime_record

    external = {
        key: copy.deepcopy(value)
        for key, value in input_record.items()
        if not key.startswith("private_")
    }
    producer = request.get("producer")
    external.update(
        {
            "schema": "loci.external-labels/v1",
            "alignment": ALIGNMENT,
            "producer": {"name": producer["name"], "version": producer.get("version")}
            if producer is not None
            else None,
            "producer_identity_basis": "user-declared" if producer else "unknown",
            "upstream_settings": None,
            "upstream_model": None,
            "upstream_runtime": None,
            "upstream_validation": "unknown",
            "source_sha256": grant["source_sha256"],
            "source_selection": selection,
            "source_geometry": geometry.to_dict(),
            "measurement_channel": grant["measurement_channel"],
            "importer": {"name": "Loci scalar TIFF label importer", "runtime": runtime_record()},
        }
    )
    provenance = {
        "geometry": geometry.to_dict(),
        "selection": selection,
        "channel_metadata": grant["channel_metadata"],
        "measurement_channels": [selection["c"]],
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
        "measurements": rows,
        "external_labels": external,
        "working_bytes": grant["working_bytes"],
        "estimated_working_bytes": grant["estimated_working_bytes"],
        "runtime": runtime_record(),
    }
    if job_id:
        provenance["job_id"] = job_id

    def guard() -> None:
        if publication_guard is not None:
            publication_guard()
        if job_id and workbench.project.job(job_id)["cancel_requested"]:
            raise ValueError("Label adoption was cancelled before publication")
        if _grant(workbench, request["grant_id"]) != grant:
            raise ValueError("Label preview grant changed before publication")
        if canonical_json(
            _source_binding(workbench, grant["source_id"], grant["source_sha256"], selection)
        ) != canonical_json(binding):
            raise ValueError("Source grid or channel declaration changed before publication")
        _verify_input_identity(Path(grant["private_path"]), grant)

    result = workbench.project.save_result(
        source_id=grant["source_id"],
        kind="external-labels",
        arrays={"image": image, "labels": labels},
        provenance=provenance,
        job_id=job_id,
        publication_guard=guard,
    )
    return {"result": result_summary(result), "measurements": rows[:1000]}
