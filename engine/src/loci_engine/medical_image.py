"""Bounded scalar medical-image I/O with explicit LPS physical geometry.

This module deliberately supports a small research interchange profile:
single-file NIfTI/NRRD and explicitly selected conventional single-frame CT or
MR DICOM series. It does not expose DICOM metadata dictionaries, infer clinical
meaning, de-identify data, or discover files recursively.
"""

from __future__ import annotations

import hashlib
import math
import os
import shutil
import uuid
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

import numpy as np

from .quantitative import Geometry

try:
    import SimpleITK as sitk
except ImportError:  # pragma: no cover - exercised only by an incorrectly provisioned runtime
    sitk = None


DEFAULT_MAX_DECODED_BYTES = 512 * 1024 * 1024
MAX_DECODED_BYTES = 8 * 1024**3
DEFAULT_MAX_DICOM_FILES = 4096
MAX_HEADER_BYTES = 1024 * 1024

_CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2"
_MR_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.4"
_SUPPORTED_SOP_CLASSES = {"CT": _CT_IMAGE_STORAGE, "MR": _MR_IMAGE_STORAGE}


class MedicalImageError(ValueError):
    """An actionable, path-redacted medical I/O refusal."""


@dataclass(frozen=True)
class MedicalInspection:
    """Renderer-safe source facts; no path or identifying DICOM tag is retained."""

    format: str
    shape: tuple[int, ...]
    dtype: str
    geometry: Geometry
    source_identity: str
    runtime_identity: str
    file_count: int
    encoded_bytes: int
    estimated_decoded_bytes: int
    series: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": self.format,
            "shape": self.shape,
            "dtype": self.dtype,
            "geometry": self.geometry.to_dict(),
            "source_identity": self.source_identity,
            "runtime_identity": self.runtime_identity,
            "file_count": self.file_count,
            "encoded_bytes": self.encoded_bytes,
            "estimated_decoded_bytes": self.estimated_decoded_bytes,
            "series": None if self.series is None else dict(self.series),
        }


@dataclass(frozen=True)
class MedicalVolume:
    """A finite scalar array with exact source identity and physical geometry."""

    array: np.ndarray
    geometry: Geometry
    format: str
    source_identity: str
    runtime_identity: str
    series: dict[str, Any] | None = None


@dataclass(frozen=True)
class DicomSeriesCandidate:
    """A path-redacted discovery result whose exact files can be selected locally."""

    selection_id: str
    file_count: int
    modality: str | None
    supported: bool
    refusal: str | None
    _selected_files: tuple[Path, ...] = field(repr=False)

    def selected_files(self) -> tuple[Path, ...]:
        """Return the exact non-recursive files for an explicit local selection."""
        return self._selected_files

    def to_dict(self) -> dict[str, Any]:
        return {
            "selection_id": self.selection_id,
            "file_count": self.file_count,
            "modality": self.modality,
            "supported": self.supported,
            "refusal": self.refusal,
        }


@dataclass(frozen=True)
class _DicomHeader:
    path: Path
    series_uid: str
    sop_instance_uid: str
    frame_uid: str | None
    modality: str
    sop_class_uid: str
    size_xy: tuple[int, int]
    position: tuple[float, float, float]
    direction_x: tuple[float, float, float]
    direction_y: tuple[float, float, float]
    spacing_yx: tuple[float, float]
    slope: float
    intercept: float
    photometric: str


@dataclass(frozen=True)
class _DicomPlan:
    files: tuple[Path, ...]
    shape: tuple[int, int, int]
    geometry: Geometry
    series: dict[str, Any]


def _require_sitk() -> Any:
    if sitk is None:
        raise MedicalImageError(
            "Medical image support is not provisioned; install the locked SimpleITK capability"
        )
    return sitk


def _runtime_identity() -> str:
    library = _require_sitk()
    return f"SimpleITK/{library.Version_VersionString()} ITK/{library.Version_ITKVersionString()}"


def _bounded_positive_integer(value: int, name: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise MedicalImageError(f"{name} must be an integer between 1 and {maximum}")
    return value


def _safe_file(path: str | os.PathLike[str]) -> Path:
    candidate = Path(path).expanduser()
    try:
        resolved = candidate.resolve(strict=True)
        if not resolved.is_file():
            raise MedicalImageError("The selected medical source is not a regular file")
    except MedicalImageError:
        raise
    except (OSError, RuntimeError):
        raise MedicalImageError("The selected medical source cannot be accessed") from None
    return resolved


def _hash_files(files: Sequence[Path]) -> tuple[str, int]:
    aggregate = hashlib.sha256(b"Loci medical source identity v1\0")
    total = 0
    for path in files:
        digest = hashlib.sha256()
        try:
            before = path.stat()
            with path.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    digest.update(chunk)
                    total += len(chunk)
            after = path.stat()
        except OSError:
            raise MedicalImageError(
                "The selected medical source changed or became unreadable"
            ) from None
        before_key = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        after_key = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        if before_key != after_key:
            raise MedicalImageError("The selected medical source changed while it was inspected")
        aggregate.update(before.st_size.to_bytes(16, "big"))
        aggregate.update(digest.digest())
    return f"sha256:{aggregate.hexdigest()}", total


def _source_format(path: Path) -> str:
    lower = path.name.lower()
    if lower.endswith((".hdr", ".img", ".hdr.gz", ".img.gz")):
        raise MedicalImageError(
            "Paired Analyze/NIfTI sidecars are unsupported; select a contained .nii or .nii.gz file"
        )
    if lower.endswith((".nii", ".nii.gz")):
        return "nifti"
    if lower.endswith((".nrrd", ".nhdr")):
        return "nrrd"
    raise MedicalImageError(
        "Unsupported medical source; select .nii, .nii.gz, .nrrd, .nhdr, "
        "or an explicit DICOM series"
    )


def _read_nrrd_header(path: Path) -> tuple[dict[str, str], Path | None]:
    try:
        with path.open("rb") as handle:
            block = handle.read(MAX_HEADER_BYTES + 5)
    except OSError:
        raise MedicalImageError("The selected NRRD header cannot be read") from None
    marker = block.find(b"\n\n")
    marker_crlf = block.find(b"\r\n\r\n")
    ends = [value for value in (marker, marker_crlf) if value >= 0]
    if ends and min(ends) <= MAX_HEADER_BYTES:
        header_bytes = block[: min(ends)]
    elif path.suffix.lower() == ".nhdr" and len(block) <= MAX_HEADER_BYTES:
        header_bytes = block
    elif len(block) > MAX_HEADER_BYTES:
        raise MedicalImageError("The NRRD header exceeds the supported 1 MiB limit")
    else:
        raise MedicalImageError("The NRRD header is missing its terminating blank line")
    try:
        text = header_bytes.decode("ascii")
    except UnicodeDecodeError:
        raise MedicalImageError("The NRRD header must be ASCII") from None
    if not text.startswith("NRRD"):
        raise MedicalImageError("The selected file does not contain a NRRD header")
    fields: dict[str, str] = {}
    for line in text.splitlines()[1:]:
        if not line or line.startswith("#") or ":=" in line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip().lower()] = value.strip()

    data_file = fields.get("data file") or fields.get("datafile")
    if data_file is None:
        if path.suffix.lower() == ".nhdr":
            raise MedicalImageError("A detached .nhdr must name one contained data file")
        return fields, None

    lowered = data_file.lower()
    windows_path = PureWindowsPath(data_file)
    normalized = data_file.replace("\\", "/")
    posix_path = PurePosixPath(normalized)
    if (
        lowered == "list"
        or lowered.startswith("list ")
        or "%" in data_file
        or bool(windows_path.drive)
        or windows_path.is_absolute()
        or posix_path.is_absolute()
        or ".." in posix_path.parts
        or not data_file
    ):
        raise MedicalImageError(
            "NRRD detached LIST, pattern, absolute, and parent-traversal data routes "
            "are unsupported"
        )
    try:
        root = path.parent.resolve(strict=True)
        sidecar = (root / Path(*posix_path.parts)).resolve(strict=True)
        sidecar.relative_to(root)
    except (OSError, RuntimeError, ValueError):
        raise MedicalImageError(
            "The NRRD detached data file is missing or leaves its header folder"
        ) from None
    if not sidecar.is_file():
        raise MedicalImageError("The NRRD detached data target is not a regular file")
    return fields, sidecar


def _file_plan(path: Path) -> tuple[str, tuple[Path, ...], bool]:
    format_name = _source_format(path)
    compressed_or_eager = path.name.lower().endswith(".gz")
    files = [path]
    if format_name == "nrrd":
        fields, sidecar = _read_nrrd_header(path)
        try:
            dimension = int(fields.get("dimension", ""))
        except ValueError:
            dimension = 0
        if dimension != 3:
            raise MedicalImageError("NRRD medical import requires a three-dimensional volume")
        space = fields.get("space", "").strip().lower()
        if space not in {
            "left-posterior-superior",
            "right-anterior-superior",
            "lps",
            "ras",
        }:
            raise MedicalImageError(
                "NRRD medical import requires an explicit LPS or RAS anatomical space"
            )
        space_units = fields.get("space units")
        units = tuple(part.strip(' "').lower() for part in (space_units or "").split())
        if len(units) != 3 or any(
            unit not in {"mm", "millimeter", "millimeters"} for unit in units
        ):
            raise MedicalImageError(
                "NRRD medical import requires explicit millimetre spatial units"
            )
        encoding = fields.get("encoding", "raw").strip().lower()
        compressed_or_eager = encoding != "raw"
        if sidecar is not None:
            files.append(sidecar)
    return format_name, tuple(files), compressed_or_eager


def _declare_nrrd_mm_units(path: Path) -> None:
    """Insert a standard NRRD space-units field using bounded streaming I/O."""
    replacement = path.with_name(f".{path.stem}.{uuid.uuid4().hex}.units.nrrd")
    try:
        with path.open("rb") as source:
            block = source.read(MAX_HEADER_BYTES + 5)
            markers = [
                (block.find(b"\r\n\r\n"), b"\r\n"),
                (block.find(b"\n\n"), b"\n"),
            ]
            markers = [(offset, newline) for offset, newline in markers if offset >= 0]
            if not markers:
                raise MedicalImageError("Written NRRD is missing its bounded header terminator")
            offset, newline = min(markers, key=lambda item: item[0])
            if offset > MAX_HEADER_BYTES:
                raise MedicalImageError("Written NRRD header exceeds the supported 1 MiB limit")
            separator_size = len(newline) * 2
            source.seek(offset + separator_size)
            with replacement.open("xb") as destination:
                destination.write(block[:offset])
                destination.write(newline)
                destination.write(b'space units: "mm" "mm" "mm"')
                destination.write(newline * 2)
                shutil.copyfileobj(source, destination, length=1024 * 1024)
                destination.flush()
                os.fsync(destination.fileno())
        os.replace(replacement, path)
    except MedicalImageError:
        raise
    except Exception:
        raise MedicalImageError("Written NRRD units could not be recorded safely") from None
    finally:
        with suppress(OSError):
            replacement.unlink(missing_ok=True)


def _pixel_dtype(pixel_id: int) -> np.dtype[Any]:
    library = _require_sitk()
    mapping = {
        library.sitkUInt8: np.dtype("uint8"),
        library.sitkUInt16: np.dtype("uint16"),
        library.sitkUInt32: np.dtype("uint32"),
        library.sitkUInt64: np.dtype("uint64"),
        library.sitkInt8: np.dtype("int8"),
        library.sitkInt16: np.dtype("int16"),
        library.sitkInt32: np.dtype("int32"),
        library.sitkInt64: np.dtype("int64"),
        library.sitkFloat32: np.dtype("float32"),
        library.sitkFloat64: np.dtype("float64"),
    }
    if pixel_id not in mapping:
        raise MedicalImageError(
            "Only real scalar integer and floating-point medical pixels are supported"
        )
    return mapping[pixel_id]


def _geometry_from_image_info(image: Any) -> Geometry:
    dimension = int(image.GetDimension())
    if dimension not in {2, 3}:
        raise MedicalImageError(
            "Only two- and three-dimensional scalar medical images are supported"
        )
    spacing = np.asarray(image.GetSpacing(), dtype=np.float64)
    origin = np.asarray(image.GetOrigin(), dtype=np.float64)
    direction = np.asarray(image.GetDirection(), dtype=np.float64).reshape(dimension, dimension)
    if (
        spacing.shape != (dimension,)
        or origin.shape != (dimension,)
        or not np.isfinite(spacing).all()
        or not np.isfinite(origin).all()
        or not np.isfinite(direction).all()
        or np.any(spacing <= 0)
    ):
        raise MedicalImageError("The medical source has invalid or non-finite physical geometry")
    matrix = np.eye(4, dtype=np.float64)
    matrix[:dimension, :dimension] = direction @ np.diag(spacing)
    matrix[:dimension, 3] = origin
    try:
        return Geometry(
            "YX" if dimension == 2 else "ZYX",
            tuple(tuple(float(v) for v in row) for row in matrix),
            unit="mm",
            frame="LPS",
        )
    except ValueError:
        raise MedicalImageError(
            "The medical source has singular or unsupported physical geometry"
        ) from None


def _nifti_header_integer(reader: Any, key: str) -> int:
    if not reader.HasMetaDataKey(key):
        raise MedicalImageError(f"NIfTI {key} metadata is missing")
    try:
        return int(reader.GetMetaData(key).strip())
    except (TypeError, ValueError):
        raise MedicalImageError(f"NIfTI {key} metadata is malformed") from None


def _validate_nifti_spatial_metadata(reader: Any) -> None:
    units = _nifti_header_integer(reader, "xyzt_units")
    spatial_units = units & 0b111
    if not 0 <= units <= 255 or spatial_units not in {1, 2, 3}:
        raise MedicalImageError(
            "NIfTI spatial units must explicitly be metres, millimetres, or microns"
        )
    qform_code = _nifti_header_integer(reader, "qform_code")
    sform_code = _nifti_header_integer(reader, "sform_code")
    if qform_code not in range(6) or sform_code not in range(6):
        raise MedicalImageError("NIfTI qform or sform transform code is unsupported")
    if qform_code == 0 and sform_code == 0:
        raise MedicalImageError(
            "NIfTI requires a qform or sform anatomical transform; both are unknown"
        )


def _inspect_file(path: Path) -> tuple[MedicalInspection, bool]:
    library = _require_sitk()
    format_name, source_files, eager = _file_plan(path)
    reader = library.ImageFileReader()
    reader.SetFileName(str(path))
    reader.SetImageIO("NiftiImageIO" if format_name == "nifti" else "NrrdImageIO")
    reader.LoadPrivateTagsOff()
    try:
        reader.ReadImageInformation()
        if format_name == "nifti":
            _validate_nifti_spatial_metadata(reader)
        dimension = int(reader.GetDimension())
        if dimension not in {2, 3}:
            raise MedicalImageError("Only two- and three-dimensional medical images are supported")
        if int(reader.GetNumberOfComponents()) != 1:
            raise MedicalImageError(
                "Vector, RGB, and multi-component medical images are unsupported"
            )
        size_xyz = tuple(int(value) for value in reader.GetSize())
        if any(value < 1 for value in size_xyz):
            raise MedicalImageError("The medical source has an empty spatial dimension")
        dtype = _pixel_dtype(int(reader.GetPixelID()))
        geometry = _geometry_from_image_info(reader)
    except MedicalImageError:
        raise
    except Exception:
        raise MedicalImageError(
            f"The selected {format_name.upper()} header could not be interpreted"
        ) from None
    source_identity, encoded_bytes = _hash_files(source_files)
    shape = tuple(reversed(size_xyz))
    decoded = math.prod(shape) * dtype.itemsize
    return (
        MedicalInspection(
            format=format_name,
            shape=shape,
            dtype=dtype.name,
            geometry=geometry,
            source_identity=source_identity,
            runtime_identity=_runtime_identity(),
            file_count=len(source_files),
            encoded_bytes=encoded_bytes,
            estimated_decoded_bytes=decoded,
        ),
        eager,
    )


def _metadata(reader: Any, key: str, *, required: bool = True) -> str | None:
    if reader.HasMetaDataKey(key):
        value = reader.GetMetaData(key).strip()
        if value:
            return value
    if required:
        raise MedicalImageError("A required DICOM series attribute is missing")
    return None


def _dicom_numbers(value: str | None, count: int, name: str) -> tuple[float, ...]:
    try:
        numbers = tuple(float(part.strip()) for part in (value or "").split("\\"))
    except ValueError:
        raise MedicalImageError(f"DICOM {name} is malformed") from None
    if len(numbers) != count or not all(math.isfinite(number) for number in numbers):
        raise MedicalImageError(f"DICOM {name} must contain {count} finite numbers")
    return numbers


def _read_dicom_header(path: Path) -> _DicomHeader:
    library = _require_sitk()
    reader = library.ImageFileReader()
    reader.SetFileName(str(path))
    reader.SetImageIO("GDCMImageIO")
    reader.LoadPrivateTagsOff()
    try:
        reader.ReadImageInformation()
        dimension = int(reader.GetDimension())
        size = tuple(int(value) for value in reader.GetSize())
        if dimension not in {2, 3} or (dimension == 3 and size[2] != 1):
            raise MedicalImageError("Only conventional single-frame DICOM images are supported")
        if int(reader.GetNumberOfComponents()) != 1:
            raise MedicalImageError("Only scalar DICOM CT/MR images are supported")
        number_of_frames = _metadata(reader, "0028|0008", required=False)
        if number_of_frames is not None and int(number_of_frames) != 1:
            raise MedicalImageError("Enhanced or multiframe DICOM is unsupported")
        modality = _metadata(reader, "0008|0060")
        sop_class = _metadata(reader, "0008|0016")
        if modality not in _SUPPORTED_SOP_CLASSES or sop_class != _SUPPORTED_SOP_CLASSES[modality]:
            raise MedicalImageError(
                "Only conventional CT Image Storage and MR Image Storage are supported"
            )
        samples = _metadata(reader, "0028|0002", required=False)
        if samples is not None and int(samples) != 1:
            raise MedicalImageError("Only one-sample scalar DICOM pixels are supported")
        photometric = _metadata(reader, "0028|0004")
        if photometric not in {"MONOCHROME1", "MONOCHROME2"}:
            raise MedicalImageError("Only MONOCHROME1 or MONOCHROME2 DICOM pixels are supported")
        position = _dicom_numbers(_metadata(reader, "0020|0032"), 3, "Image Position Patient")
        orientation = _dicom_numbers(_metadata(reader, "0020|0037"), 6, "Image Orientation Patient")
        spacing = _dicom_numbers(_metadata(reader, "0028|0030"), 2, "Pixel Spacing")
        if any(value <= 0 for value in spacing):
            raise MedicalImageError("DICOM Pixel Spacing must be positive")
        slope = float(_metadata(reader, "0028|1053", required=False) or "1")
        intercept = float(_metadata(reader, "0028|1052", required=False) or "0")
        if not math.isfinite(slope) or slope == 0 or not math.isfinite(intercept):
            raise MedicalImageError("DICOM rescale slope/intercept is invalid")
        if len(size) not in {2, 3} or any(value < 1 for value in size):
            raise MedicalImageError("DICOM rows and columns must be nonempty")
        return _DicomHeader(
            path=path,
            series_uid=_metadata(reader, "0020|000e") or "",
            sop_instance_uid=_metadata(reader, "0008|0018") or "",
            frame_uid=_metadata(reader, "0020|0052", required=False),
            modality=modality or "",
            sop_class_uid=sop_class or "",
            size_xy=(size[0], size[1]),
            position=(position[0], position[1], position[2]),
            direction_x=(orientation[0], orientation[1], orientation[2]),
            direction_y=(orientation[3], orientation[4], orientation[5]),
            spacing_yx=(spacing[0], spacing[1]),
            slope=slope,
            intercept=intercept,
            photometric=photometric or "",
        )
    except MedicalImageError:
        raise
    except (TypeError, ValueError):
        raise MedicalImageError("A required DICOM scalar attribute is malformed") from None
    except Exception:
        raise MedicalImageError("A selected file is not a supported readable DICOM image") from None


def _dicom_plan(source: Sequence[str | os.PathLike[str]]) -> _DicomPlan:
    if isinstance(source, (str, bytes, os.PathLike)):
        raise MedicalImageError("DICOM import requires an explicit selected file list")
    if not source:
        raise MedicalImageError("The selected DICOM series is empty")
    if len(source) > DEFAULT_MAX_DICOM_FILES:
        raise MedicalImageError(
            f"A DICOM selection may contain at most {DEFAULT_MAX_DICOM_FILES} files"
        )
    paths = tuple(_safe_file(item) for item in source)
    if len(set(paths)) != len(paths):
        raise MedicalImageError("The selected DICOM series contains duplicate files")
    headers = [_read_dicom_header(path) for path in paths]
    if len(headers) < 2:
        raise MedicalImageError("A DICOM image series needs at least two positioned slices")
    first = headers[0]
    if any(header.series_uid != first.series_uid for header in headers):
        raise MedicalImageError("The selected DICOM files contain mixed Series Instance UIDs")
    if any(header.modality != first.modality for header in headers):
        raise MedicalImageError("The selected DICOM files contain mixed modalities")
    if any(header.sop_class_uid != first.sop_class_uid for header in headers):
        raise MedicalImageError("The selected DICOM files contain mixed SOP classes")
    if any(header.size_xy != first.size_xy for header in headers):
        raise MedicalImageError("The selected DICOM files contain mixed rows or columns")
    if any(header.photometric != first.photometric for header in headers):
        raise MedicalImageError(
            "The selected DICOM files contain mixed photometric interpretations"
        )
    if len({header.sop_instance_uid for header in headers}) != len(headers):
        raise MedicalImageError("The selected DICOM series contains duplicate SOP instances")
    frame_uids = {header.frame_uid for header in headers}
    if len(frame_uids) != 1:
        raise MedicalImageError("The selected DICOM files contain mixed frames of reference")
    if any(
        not np.allclose(header.spacing_yx, first.spacing_yx, atol=1e-6, rtol=1e-6)
        for header in headers
    ):
        raise MedicalImageError("The selected DICOM files contain mixed pixel spacing")
    if any(
        not np.allclose(header.direction_x, first.direction_x, atol=1e-6, rtol=0)
        or not np.allclose(header.direction_y, first.direction_y, atol=1e-6, rtol=0)
        for header in headers
    ):
        raise MedicalImageError("The selected DICOM files contain mixed image orientations")
    if any(
        not math.isclose(header.slope, first.slope, abs_tol=1e-12, rel_tol=1e-12)
        or not math.isclose(header.intercept, first.intercept, abs_tol=1e-12, rel_tol=1e-12)
        for header in headers
    ):
        raise MedicalImageError("Per-slice DICOM rescale changes are unsupported")

    direction_x = np.asarray(first.direction_x, dtype=np.float64)
    direction_y = np.asarray(first.direction_y, dtype=np.float64)
    if (
        not math.isclose(float(np.linalg.norm(direction_x)), 1.0, abs_tol=1e-5, rel_tol=0)
        or not math.isclose(float(np.linalg.norm(direction_y)), 1.0, abs_tol=1e-5, rel_tol=0)
        or not math.isclose(float(direction_x @ direction_y), 0.0, abs_tol=1e-5, rel_tol=0)
    ):
        raise MedicalImageError("DICOM direction cosines must be orthonormal")
    direction_z = np.cross(direction_x, direction_y)
    origin = np.asarray(first.position, dtype=np.float64)
    positioned: list[tuple[float, _DicomHeader]] = []
    for header in headers:
        delta = np.asarray(header.position, dtype=np.float64) - origin
        if abs(float(delta @ direction_x)) > 1e-3 or abs(float(delta @ direction_y)) > 1e-3:
            raise MedicalImageError(
                "Tilted or laterally shifted DICOM slice stacks are unsupported"
            )
        positioned.append((float(np.asarray(header.position) @ direction_z), header))
    positioned.sort(key=lambda item: item[0])
    locations = np.asarray([item[0] for item in positioned], dtype=np.float64)
    steps = np.diff(locations)
    if np.any(steps <= 1e-6):
        raise MedicalImageError("The selected DICOM series contains duplicate slice positions")
    slice_spacing = float(np.median(steps))
    if not np.allclose(steps, slice_spacing, atol=max(1e-3, slice_spacing * 1e-4), rtol=0):
        raise MedicalImageError("The selected DICOM series has irregular slice spacing")
    sorted_headers = [item[1] for item in positioned]
    first_position = np.asarray(sorted_headers[0].position, dtype=np.float64)
    spacing_y, spacing_x = first.spacing_yx
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, 0] = direction_x * spacing_x
    matrix[:3, 1] = direction_y * spacing_y
    matrix[:3, 2] = direction_z * slice_spacing
    matrix[:3, 3] = first_position
    geometry = Geometry(
        "ZYX",
        tuple(tuple(float(value) for value in row) for row in matrix),
        unit="mm",
        frame="LPS",
    )
    shape = (len(sorted_headers), first.size_xy[1], first.size_xy[0])
    series = {
        "modality": first.modality,
        "slice_count": len(sorted_headers),
        "photometric_interpretation": first.photometric,
        "rescale_slope": first.slope,
        "rescale_intercept": first.intercept,
        "rescale_applied": not math.isclose(first.slope, 1.0)
        or not math.isclose(first.intercept, 0.0),
        "output_dtype": "float64",
    }
    return _DicomPlan(tuple(header.path for header in sorted_headers), shape, geometry, series)


def enumerate_dicom_series(
    directory: str | os.PathLike[str], *, max_files: int = DEFAULT_MAX_DICOM_FILES
) -> tuple[DicomSeriesCandidate, ...]:
    """Discover immediate DICOM series without returning paths or identifying tags.

    Discovery is deliberately non-recursive. Call ``selected_files`` on one
    returned candidate and pass that exact tuple to :func:`inspect_medical` or
    :func:`read_medical` after the user selects it.
    """
    library = _require_sitk()
    limit = _bounded_positive_integer(max_files, "max_files", DEFAULT_MAX_DICOM_FILES)
    try:
        root = Path(directory).expanduser().resolve(strict=True)
        if not root.is_dir():
            raise MedicalImageError("The selected DICOM discovery source is not a directory")
        immediate_files = [item for item in root.iterdir() if item.is_file()]
    except MedicalImageError:
        raise
    except (OSError, RuntimeError):
        raise MedicalImageError("The selected DICOM directory cannot be enumerated") from None
    if len(immediate_files) > limit:
        raise MedicalImageError(f"The DICOM directory exceeds the explicit {limit}-file limit")
    try:
        series_ids = tuple(library.ImageSeriesReader.GetGDCMSeriesIDs(str(root), True))
    except Exception:
        raise MedicalImageError("The DICOM directory could not be safely enumerated") from None
    candidates: list[DicomSeriesCandidate] = []
    for index, series_id in enumerate(series_ids):
        files: tuple[Path, ...] = ()
        try:
            names = library.ImageSeriesReader.GetGDCMSeriesFileNames(
                str(root), series_id, True, False, False
            )
            files = tuple(_safe_file(name) for name in names)
            if not files or len(files) > limit:
                raise MedicalImageError("The DICOM candidate is empty or exceeds the file limit")
            if any(path.parent != root for path in files):
                raise MedicalImageError("A DICOM candidate leaves the selected directory")
            plan = _dicom_plan(files)
            modality = str(plan.series["modality"])
            supported = True
            refusal = None
        except MedicalImageError as error:
            modality = None
            supported = False
            refusal = str(error)
        candidates.append(
            DicomSeriesCandidate(
                selection_id=f"series-{index + 1}",
                file_count=len(files),
                modality=modality,
                supported=supported,
                refusal=refusal,
                _selected_files=files,
            )
        )
    return tuple(candidates)


def inspect_medical(
    source: str | os.PathLike[str] | Sequence[str | os.PathLike[str]],
) -> MedicalInspection:
    """Inspect one NIfTI/NRRD file or an exact DICOM file selection without decoding pixels."""
    if isinstance(source, (str, os.PathLike)):
        inspection, _ = _inspect_file(_safe_file(source))
        return inspection
    plan = _dicom_plan(source)
    identity, encoded_bytes = _hash_files(plan.files)
    decoded = math.prod(plan.shape) * np.dtype("float64").itemsize
    return MedicalInspection(
        format="dicom-series",
        shape=plan.shape,
        dtype="float64",
        geometry=plan.geometry,
        source_identity=identity,
        runtime_identity=_runtime_identity(),
        file_count=len(plan.files),
        encoded_bytes=encoded_bytes,
        estimated_decoded_bytes=decoded,
        series=dict(plan.series),
    )


def _normalize_region(
    region: tuple[slice, ...] | None, shape: tuple[int, ...]
) -> tuple[tuple[int, ...], tuple[int, ...], tuple[slice, ...]]:
    if region is None:
        starts = (0,) * len(shape)
        sizes = shape
        return starts, sizes, tuple(slice(0, size) for size in shape)
    if not isinstance(region, tuple) or len(region) != len(shape):
        raise MedicalImageError("A medical region must provide one slice for each YX or ZYX axis")
    starts: list[int] = []
    sizes: list[int] = []
    normalized: list[slice] = []
    for selection, length in zip(region, shape, strict=True):
        if not isinstance(selection, slice) or selection.step not in {None, 1}:
            raise MedicalImageError("Medical regions require contiguous unit-step slices")
        start, stop, step = selection.indices(length)
        if step != 1 or stop <= start:
            raise MedicalImageError("Medical regions must select at least one voxel on every axis")
        starts.append(start)
        sizes.append(stop - start)
        normalized.append(slice(start, stop))
    return tuple(starts), tuple(sizes), tuple(normalized)


def _check_memory(size: int, limit: int, *, eager: bool) -> None:
    _bounded_positive_integer(limit, "max_decoded_bytes", MAX_DECODED_BYTES)
    if size > limit:
        scope = "whole compressed/series source" if eager else "selected region"
        raise MedicalImageError(
            f"The {scope} needs {size} decoded bytes, above the {limit}-byte limit; "
            "choose a smaller uncompressed source or region, or explicitly raise the bounded limit"
        )


def read_medical(
    source: str | os.PathLike[str] | Sequence[str | os.PathLike[str]],
    *,
    region: tuple[slice, ...] | None = None,
    expected_identity: str | MedicalInspection | None = None,
    max_decoded_bytes: int = DEFAULT_MAX_DECODED_BYTES,
) -> MedicalVolume:
    """Read a finite scalar array, enforcing identity and memory bounds before pixel decode."""
    library = _require_sitk()
    inspection = inspect_medical(source)
    expected = (
        expected_identity.source_identity
        if isinstance(expected_identity, MedicalInspection)
        else expected_identity
    )
    if expected is not None and expected != inspection.source_identity:
        raise MedicalImageError(
            "The medical source identity no longer matches the inspected source"
        )
    starts, sizes, normalized = _normalize_region(region, inspection.shape)

    if inspection.format == "dicom-series":
        plan = _dicom_plan(source)  # type: ignore[arg-type]
        selected_bytes = math.prod(sizes) * np.dtype("float64").itemsize
        _check_memory(inspection.estimated_decoded_bytes, max_decoded_bytes, eager=True)
        reader = library.ImageSeriesReader()
        reader.SetFileNames([str(path) for path in plan.files])
        reader.SetOutputPixelType(library.sitkFloat64)
        reader.MetaDataDictionaryArrayUpdateOff()
        reader.LoadPrivateTagsOff()
        reader.ForceOrthogonalDirectionOn()
        try:
            image = reader.Execute()
            array = library.GetArrayFromImage(image)
        except Exception:
            raise MedicalImageError(
                "The selected DICOM series failed during bounded pixel decode"
            ) from None
        decoded_geometry = _geometry_from_image_info(image)
        if tuple(array.shape) != inspection.shape or not np.allclose(
            np.asarray(decoded_geometry.affine),
            np.asarray(inspection.geometry.affine),
            atol=1e-5,
            rtol=1e-7,
        ):
            raise MedicalImageError(
                "Decoded DICOM geometry disagrees with the validated selected series"
            )
        if region is not None:
            array = np.asarray(array[normalized]).copy()
            geometry = inspection.geometry.cropped(starts)
        else:
            geometry = decoded_geometry
        _check_memory(selected_bytes, max_decoded_bytes, eager=False)
        source_files = plan.files
    else:
        path = _safe_file(source)  # type: ignore[arg-type]
        _, source_files, eager = _file_plan(path)
        selected_bytes = math.prod(sizes) * np.dtype(inspection.dtype).itemsize
        guarded_bytes = inspection.estimated_decoded_bytes if eager else selected_bytes
        _check_memory(guarded_bytes, max_decoded_bytes, eager=eager)
        reader = library.ImageFileReader()
        reader.SetFileName(str(path))
        reader.SetImageIO("NiftiImageIO" if inspection.format == "nifti" else "NrrdImageIO")
        reader.LoadPrivateTagsOff()
        try:
            reader.ReadImageInformation()
            reader.SetExtractIndex(list(reversed(starts)))
            reader.SetExtractSize(list(reversed(sizes)))
            image = reader.Execute()
            array = library.GetArrayFromImage(image)
        except Exception:
            raise MedicalImageError(
                f"The selected {inspection.format.upper()} source failed during bounded "
                "pixel decode"
            ) from None
        geometry = _geometry_from_image_info(image)

    array = np.asarray(array)
    if tuple(array.shape) != sizes:
        raise MedicalImageError(
            "The decoded medical array shape disagrees with its inspected geometry"
        )
    if array.dtype.kind not in "uif" or array.dtype.itemsize > 8:
        raise MedicalImageError("The decoded medical pixels have an unsupported scalar dtype")
    if not np.isfinite(array).all():
        raise MedicalImageError("Non-finite medical image voxels are unsupported")
    identity_after, _ = _hash_files(source_files)
    if identity_after != inspection.source_identity:
        raise MedicalImageError(
            "The medical source changed during pixel decode; the result was rejected"
        )
    return MedicalVolume(
        array=array,
        geometry=geometry,
        format=inspection.format,
        source_identity=inspection.source_identity,
        runtime_identity=inspection.runtime_identity,
        series=None if inspection.series is None else dict(inspection.series),
    )


def _lps_geometry(geometry: Geometry) -> Geometry:
    if geometry.unit != "mm" or geometry.frame not in {"LPS", "RAS"}:
        raise MedicalImageError("Medical export requires millimetre LPS or RAS geometry")
    matrix = np.asarray(geometry.affine, dtype=np.float64)
    if geometry.frame == "RAS":
        matrix = np.diag([-1.0, -1.0, 1.0, 1.0]) @ matrix
    return Geometry(
        geometry.axes,
        tuple(tuple(float(value) for value in row) for row in matrix),
        unit="mm",
        frame="LPS",
    )


def _image_from_array(array: np.ndarray, geometry: Geometry) -> Any:
    library = _require_sitk()
    lps = _lps_geometry(geometry)
    values = np.asarray(array)
    dimension = values.ndim
    matrix = np.asarray(lps.affine, dtype=np.float64)
    basis = matrix[:dimension, :dimension]
    spacing = np.linalg.norm(basis, axis=0)
    direction = basis / spacing
    if not np.allclose(direction.T @ direction, np.eye(dimension), atol=1e-7, rtol=0):
        raise MedicalImageError("Medical export requires an orthogonal grid; resample shear first")
    if dimension == 2 and (
        not np.allclose(matrix[2, :2], 0, atol=1e-12, rtol=0)
        or not math.isclose(float(matrix[2, 3]), 0.0, abs_tol=1e-12, rel_tol=0)
    ):
        raise MedicalImageError("A 2D medical export cannot preserve an out-of-plane 3D embedding")
    try:
        image = library.GetImageFromArray(values)
        image.SetSpacing(tuple(float(value) for value in spacing))
        image.SetDirection(tuple(float(value) for value in direction.ravel()))
        image.SetOrigin(tuple(float(value) for value in matrix[:dimension, 3]))
    except Exception:
        raise MedicalImageError(
            "The scalar array dtype or geometry cannot be represented for export"
        ) from None
    return image


def export_medical(
    destination: str | os.PathLike[str],
    array: np.ndarray,
    geometry: Geometry,
    *,
    labels: bool = False,
    overwrite: bool = False,
    max_decoded_bytes: int = DEFAULT_MAX_DECODED_BYTES,
) -> MedicalInspection:
    """Atomically export a derived scalar image or unsigned labelmap as NIfTI/NRRD."""
    library = _require_sitk()
    if not isinstance(overwrite, bool) or not isinstance(labels, bool):
        raise MedicalImageError("labels and overwrite must be explicit booleans")
    output = Path(destination).expanduser()
    format_name = _source_format(output)
    if format_name not in {"nifti", "nrrd"} or output.suffix.lower() == ".nhdr":
        raise MedicalImageError("Medical export supports embedded .nii, .nii.gz, or .nrrd only")
    try:
        parent = output.parent.resolve(strict=True)
    except (OSError, RuntimeError):
        raise MedicalImageError("The medical export parent directory does not exist") from None
    target = parent / output.name
    if target.is_symlink():
        raise MedicalImageError("Medical export refuses a symbolic-link destination")
    if target.exists() and not overwrite:
        raise MedicalImageError("The medical export destination already exists")

    values = np.asarray(array)
    if values.ndim not in {2, 3} or any(size < 1 for size in values.shape):
        raise MedicalImageError("Medical export requires a nonempty scalar YX or ZYX array")
    if values.ndim != len(geometry.axes):
        raise MedicalImageError("The export array and geometry axes disagree")
    if format_name == "nrrd" and values.ndim != 3:
        raise MedicalImageError("NRRD medical export requires a three-dimensional LPS/RAS volume")
    if values.dtype.kind not in "uif" or values.dtype.itemsize > 8 or values.dtype == np.float16:
        raise MedicalImageError(
            "Medical export supports real scalar integer or float32/float64 arrays"
        )
    if labels and (values.dtype.kind != "u" or values.dtype.itemsize > 4):
        raise MedicalImageError("Medical label export requires uint8, uint16, or uint32 labels")
    if not np.isfinite(values).all():
        raise MedicalImageError("Non-finite derived medical voxels cannot be exported")
    _check_memory(values.nbytes, max_decoded_bytes, eager=False)
    lps = _lps_geometry(geometry)
    image = _image_from_array(values, lps)

    lower = target.name.lower()
    suffix = ".nii.gz" if lower.endswith(".nii.gz") else target.suffix.lower()
    stem = target.name[: -len(suffix)]
    temporary = parent / f".{stem}.{uuid.uuid4().hex}.tmp{suffix}"
    try:
        library.WriteImage(image, str(temporary), suffix in {".nii.gz", ".nrrd"})
        if suffix == ".nrrd":
            _declare_nrrd_mm_units(temporary)
        written, _ = _inspect_file(temporary.resolve(strict=True))
        if (
            written.format != format_name
            or written.shape != tuple(values.shape)
            or written.dtype != values.dtype.name
            or written.geometry.axes != lps.axes
            or written.geometry.unit != "mm"
            or written.geometry.frame != "LPS"
            or not np.allclose(
                np.asarray(written.geometry.affine), np.asarray(lps.affine), atol=1e-5, rtol=1e-7
            )
        ):
            raise MedicalImageError(
                "Medical export geometry or dtype failed its pre-publication check"
            )
        # Windows rejects fsync on a read-only CRT descriptor.
        with temporary.open("rb+") as handle:
            os.fsync(handle.fileno())
        if overwrite:
            os.replace(temporary, target)
        else:
            os.link(temporary, target)
        try:
            directory_fd = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
        return written
    except MedicalImageError:
        raise
    except FileExistsError:
        raise MedicalImageError("The medical export destination already exists") from None
    except Exception:
        raise MedicalImageError("The medical export could not be written atomically") from None
    finally:
        with suppress(OSError):
            temporary.unlink(missing_ok=True)


__all__ = [
    "DEFAULT_MAX_DECODED_BYTES",
    "DicomSeriesCandidate",
    "MedicalImageError",
    "MedicalInspection",
    "MedicalVolume",
    "enumerate_dicom_series",
    "export_medical",
    "inspect_medical",
    "read_medical",
]
