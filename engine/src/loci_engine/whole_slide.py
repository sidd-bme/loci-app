"""Bounded OpenSlide access and declared brightfield region analysis.

OpenSlide coordinates are always level-0 ``(x, y)`` coordinates. Region sizes
are pixels at the selected pyramid level. Source-device RGB is retained as the
analysis array; an embedded ICC profile, when present and usable, is applied
only to the separate display array.
"""

from __future__ import annotations

import hashlib
import hmac
import importlib
import io
import math
import re
import stat
from dataclasses import dataclass, replace
from pathlib import Path
from types import ModuleType
from typing import Any, Literal

import numpy as np
from PIL import Image, ImageCms, features
from scipy import ndimage as ndi
from skimage.color import hdx_from_rgb, hed_from_rgb, rgb2gray, separate_stains
from skimage.draw import polygon2mask
from skimage.filters import threshold_otsu

from .native_image import srgb_output_profile_bytes

DEFAULT_REGION_BUDGET_BYTES = 64 * 1024 * 1024
MAX_REGION_BUDGET_BYTES = 512 * 1024 * 1024
DEFAULT_OPENSLIDE_CACHE_BYTES = 64 * 1024 * 1024
MAX_POLYGON_POINTS = 1024
_SHA256 = re.compile(r"[0-9a-f]{64}")


class WholeSlideError(ValueError):
    """Raised when a slide or request cannot be handled safely."""


class WholeSlideDependencyError(WholeSlideError):
    """Raised when the maintained OpenSlide binding/runtime is unavailable."""


class WholeSlideUnsupportedError(WholeSlideError):
    """Raised when a source is not a supported SVS or NDPI slide."""


class WholeSlideSourceChangedError(RuntimeError):
    """Raised when source identity or bytes differ from the opened session."""


class WholeSlideBudgetError(WholeSlideError):
    """Raised before decoding when a request exceeds its memory budget."""

    def __init__(self, required_bytes: int, budget_bytes: int) -> None:
        self.required_bytes = required_bytes
        self.budget_bytes = budget_bytes
        super().__init__(
            f"The requested region can require {required_bytes / (1024 * 1024):,.1f} MiB, "
            f"above its {budget_bytes / (1024 * 1024):,.1f} MiB memory budget. "
            "No pixels were decoded."
        )


@dataclass(frozen=True, slots=True)
class WholeSlideLevel:
    index: int
    dimensions_xy: tuple[int, int]
    downsample: float
    micrometres_per_pixel_xy: tuple[float, float] | None


@dataclass(frozen=True, slots=True)
class ICCProvenance:
    source_status: Literal["embedded-usable", "missing"]
    source_icc_sha256: str | None
    source_icc_bytes: int | None
    display_space: Literal["sRGB", "uncharacterized-source-RGB"]
    transform: Literal["Pillow-ImageCms-source-to-sRGB", "none"]
    rendering_intent: int | None
    output_icc_sha256: str | None
    pillow_version: str
    littlecms_version: str | None


@dataclass(frozen=True, slots=True)
class WholeSlideMetadata:
    format: Literal["SVS", "NDPI"]
    vendor: Literal["aperio", "hamamatsu"]
    level0_dimensions_xy: tuple[int, int]
    levels: tuple[WholeSlideLevel, ...]
    micrometres_per_pixel_xy: tuple[float, float] | None
    calibration_status: Literal["declared-mpp", "missing"]
    icc: ICCProvenance
    sha256: str
    source_size_bytes: int
    decoder: str
    decoder_version: str
    decoder_library_version: str
    decoder_cache_bytes: int


@dataclass(frozen=True, slots=True)
class WholeSlideRegionRequest:
    """A rectangle with level-0 origin and selected-level pixel size."""

    level0_x: int
    level0_y: int
    level: int
    width: int
    height: int
    budget_bytes: int = DEFAULT_REGION_BUDGET_BYTES
    expected_sha256: str | None = None
    color_manage_display: bool = True


@dataclass(frozen=True, slots=True)
class WholeSlideRegion:
    analysis_rgb: np.ndarray
    display_rgb: np.ndarray
    request: WholeSlideRegionRequest
    level_downsample: float
    level0_extent_xyxy: tuple[float, float, float, float]
    micrometres_per_pixel_xy: tuple[float, float] | None
    display_color: ICCProvenance
    transparent_pixel_count: int
    sha256: str
    integrity_mode: Literal["stat-verified-session"]
    estimated_peak_bytes: int


@dataclass(frozen=True, slots=True)
class WholeSlideIntegrityReceipt:
    sha256: str
    integrity_mode: Literal["full-sha256"] = "full-sha256"


@dataclass(frozen=True, slots=True)
class StainDeconvolution:
    values: np.ndarray
    components: tuple[str, str, str]
    basis_name: Literal["H&E", "H-DAB"]
    rgb_separation_matrix: tuple[tuple[float, float, float], ...]
    input_color_space: Literal["source-device-RGB"]
    method: Literal["skimage.color.separate_stains"]
    scientific_validation: Literal["unvalidated-research-method"]
    source_sha256: str
    level0_extent_xyxy: tuple[float, float, float, float]
    level: int
    level_downsample: float


@dataclass(frozen=True, slots=True)
class TissueMaskResult:
    mask: np.ndarray
    threshold: float
    threshold_method: Literal["otsu-dark-luminance"]
    closing_radius_pixels: int
    minimum_component_pixels: int
    input_color_space: Literal["source-device-RGB"]
    scientific_validation: Literal["unvalidated-research-method"]
    source_sha256: str
    level0_extent_xyxy: tuple[float, float, float, float]
    level: int
    level_downsample: float


@dataclass(frozen=True, slots=True)
class PolygonROIAnalysis:
    polygon_level0_xy: tuple[tuple[float, float], ...]
    centroid_level0_xy: tuple[float, float]
    area_level0_pixels_squared: float
    centroid_micrometres_xy: tuple[float, float] | None
    area_micrometres_squared: float | None
    micrometres_per_level0_pixel_xy: tuple[float, float] | None
    sampled_pixel_count: int
    mean_analysis_rgb: tuple[float, float, float]
    tissue_fraction: float | None
    source_sha256: str
    sample_level: int
    sample_level_downsample: float
    sample_region_level0_extent_xyxy: tuple[float, float, float, float]

    def to_geojson(
        self, *, coordinate_space: Literal["level0-pixel", "physical-micrometre"]
    ) -> dict[str, Any]:
        """Return one path-free GeoJSON Feature with an explicit coordinate basis."""

        if coordinate_space == "physical-micrometre":
            if (
                self.centroid_micrometres_xy is None
                or self.area_micrometres_squared is None
                or self.micrometres_per_level0_pixel_xy is None
            ):
                raise WholeSlideError(
                    "Physical GeoJSON requires declared slide micrometre calibration."
                )
            scale_x, scale_y = self.micrometres_per_level0_pixel_xy
            polygon = [(x * scale_x, y * scale_y) for x, y in self.polygon_level0_xy]
            centroid = self.centroid_micrometres_xy
            area = self.area_micrometres_squared
            area_unit = "um^2"
        elif coordinate_space == "level0-pixel":
            polygon = list(self.polygon_level0_xy)
            centroid = self.centroid_level0_xy
            area = self.area_level0_pixels_squared
            area_unit = "level0-pixel^2"
        else:
            raise WholeSlideError("Unknown GeoJSON coordinate space.")
        ring = [[float(x), float(y)] for x, y in (*polygon, polygon[0])]
        return {
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [ring]},
            "properties": {
                "coordinate_space": coordinate_space,
                "axis_order": "XY",
                "centroid_xy": [float(centroid[0]), float(centroid[1])],
                "area": float(area),
                "area_unit": area_unit,
                "sampled_pixel_count": self.sampled_pixel_count,
                "source_sha256": self.source_sha256,
                "sample_level": self.sample_level,
                "sample_level_downsample": self.sample_level_downsample,
                "sample_region_level0_extent_xyxy": list(self.sample_region_level0_extent_xyxy),
            },
        }


@dataclass(frozen=True, slots=True)
class _FileIdentity:
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int


def _load_openslide() -> ModuleType:
    try:
        return importlib.import_module("openslide")
    except (ImportError, OSError) as exc:
        raise WholeSlideDependencyError(
            "Whole-slide access requires the maintained openslide-python binding and "
            "OpenSlide native runtime."
        ) from exc


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_identity(path: Path) -> _FileIdentity:
    try:
        status = path.stat(follow_symlinks=False)
    except OSError as exc:
        raise WholeSlideSourceChangedError(
            "The whole-slide source is no longer accessible."
        ) from exc
    if stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode):
        raise WholeSlideSourceChangedError(
            "The whole-slide source must remain a regular non-symlink file."
        )
    return _FileIdentity(
        int(status.st_dev),
        int(status.st_ino),
        int(status.st_size),
        int(status.st_mtime_ns),
        int(status.st_ctime_ns),
    )


def _stable_sha256(path: Path, expected: str | None) -> tuple[str, _FileIdentity]:
    if expected is not None and (not isinstance(expected, str) or not _SHA256.fullmatch(expected)):
        raise WholeSlideError("expected_sha256 must be 64 lowercase hexadecimal characters.")
    before = _file_identity(path)
    digest = _sha256(path)
    after = _file_identity(path)
    if before != after:
        raise WholeSlideSourceChangedError("The whole-slide source changed while it was hashed.")
    if expected is not None and not hmac.compare_digest(digest, expected):
        raise WholeSlideSourceChangedError(
            "The whole-slide source does not match the expected full SHA-256 fingerprint."
        )
    return digest, after


def _positive_finite(value: Any, name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise WholeSlideError(f"{name} must be a finite positive number.") from exc
    if not math.isfinite(number) or number <= 0:
        raise WholeSlideError(f"{name} must be a finite positive number.")
    return number


def _freeze(array: np.ndarray) -> np.ndarray:
    output = np.ascontiguousarray(array)
    output.setflags(write=False)
    return output


def _working_budget(value: Any, name: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1024 <= value <= MAX_REGION_BUDGET_BYTES
    ):
        raise WholeSlideError(f"{name} must be an integer from 1024 bytes through 512 MiB.")
    return value


def _validated_analysis_rgb(region: Any) -> np.ndarray:
    if not isinstance(region, WholeSlideRegion):
        raise WholeSlideError("Analysis requires a bounded WholeSlideRegion.")
    array = np.asarray(region.analysis_rgb)
    if (
        array.ndim != 3
        or array.shape != (region.request.height, region.request.width, 3)
        or array.dtype != np.uint8
    ):
        raise WholeSlideError("The region analysis RGB layout is invalid or unsupported.")
    if not _SHA256.fullmatch(region.sha256):
        raise WholeSlideError("The region source fingerprint is invalid.")
    _positive_finite(region.level_downsample, "region level downsample")
    extent = np.asarray(region.level0_extent_xyxy, dtype=np.float64)
    if extent.shape != (4,) or not np.isfinite(extent).all():
        raise WholeSlideError("The region level-0 extent is malformed.")
    if extent[2] <= extent[0] or extent[3] <= extent[1]:
        raise WholeSlideError("The region level-0 extent must be positive.")
    return array


def _icc_bytes(profile: Any) -> bytes:
    try:
        value = profile.tobytes()
    except Exception as exc:
        raise WholeSlideError("The embedded ICC profile is malformed or unreadable.") from exc
    if not isinstance(value, bytes) or not value:
        raise WholeSlideError("The embedded ICC profile is malformed or empty.")
    return value


def _missing_icc() -> ICCProvenance:
    return ICCProvenance(
        source_status="missing",
        source_icc_sha256=None,
        source_icc_bytes=None,
        display_space="uncharacterized-source-RGB",
        transform="none",
        rendering_intent=None,
        output_icc_sha256=None,
        pillow_version=Image.__version__,
        littlecms_version=features.version_module("littlecms2"),
    )


def _polygon_geometry(points: tuple[tuple[float, float], ...]) -> tuple[float, float, float]:
    cross = np.asarray(
        [
            x0 * y1 - x1 * y0
            for (x0, y0), (x1, y1) in zip(points, (*points[1:], points[0]), strict=True)
        ],
        dtype=np.float64,
    )
    signed_twice_area = float(cross.sum())
    if abs(signed_twice_area) < 1e-12:
        raise WholeSlideError("The polygon must enclose a non-zero area.")
    xs = np.asarray(
        [point[0] + points[(index + 1) % len(points)][0] for index, point in enumerate(points)]
    )
    ys = np.asarray(
        [point[1] + points[(index + 1) % len(points)][1] for index, point in enumerate(points)]
    )
    return (
        abs(signed_twice_area) / 2,
        float((xs * cross).sum() / (3 * signed_twice_area)),
        float((ys * cross).sum() / (3 * signed_twice_area)),
    )


def _orientation(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_cross(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    d: tuple[float, float],
) -> bool:
    values = (
        _orientation(a, b, c),
        _orientation(a, b, d),
        _orientation(c, d, a),
        _orientation(c, d, b),
    )
    if values[0] * values[1] < 0 and values[2] * values[3] < 0:
        return True
    for orientation, point, start, end in (
        (values[0], c, a, b),
        (values[1], d, a, b),
        (values[2], a, c, d),
        (values[3], b, c, d),
    ):
        if abs(orientation) <= 1e-12 and all(
            min(first, second) <= value <= max(first, second)
            for value, first, second in zip(point, start, end, strict=True)
        ):
            return True
    return False


def _validate_polygon(points_value: Any) -> tuple[tuple[float, float], ...]:
    if not isinstance(points_value, (tuple, list)) or not (
        3 <= len(points_value) <= MAX_POLYGON_POINTS
    ):
        raise WholeSlideError(f"A polygon requires 3 to {MAX_POLYGON_POINTS} XY points.")
    points: list[tuple[float, float]] = []
    for value in points_value:
        if not isinstance(value, (tuple, list)) or len(value) != 2:
            raise WholeSlideError("Polygon points must be finite XY pairs.")
        x, y = value
        if isinstance(x, bool) or isinstance(y, bool):
            raise WholeSlideError("Polygon points must be finite XY pairs.")
        try:
            point = (float(x), float(y))
        except (TypeError, ValueError) as exc:
            raise WholeSlideError("Polygon points must be finite XY pairs.") from exc
        if not all(math.isfinite(v) and v >= 0 for v in point):
            raise WholeSlideError("Polygon points must be finite non-negative XY pairs.")
        points.append(point)
    if len(set(points)) != len(points):
        raise WholeSlideError("A polygon cannot repeat vertices.")
    count = len(points)
    for first in range(count):
        a, b = points[first], points[(first + 1) % count]
        for second in range(first + 1, count):
            if second in {first, (first + 1) % count} or (second + 1) % count == first:
                continue
            c, d = points[second], points[(second + 1) % count]
            if _segments_cross(a, b, c, d):
                raise WholeSlideError("The polygon cannot self-intersect.")
    result = tuple(points)
    _polygon_geometry(result)
    return result


class WholeSlideSession:
    """One read-only SVS/NDPI OpenSlide handle with bounded region operations."""

    __slots__ = (
        "_closed",
        "_display_transform",
        "_identity",
        "_metadata",
        "_path",
        "_slide",
    )

    def __init__(
        self,
        path: str | Path,
        *,
        expected_sha256: str | None = None,
        cache_bytes: int = DEFAULT_OPENSLIDE_CACHE_BYTES,
    ) -> None:
        selected = Path(path).expanduser()
        if not selected.is_absolute():
            raise WholeSlideError("The whole-slide source path must be absolute.")
        cache_bytes = _working_budget(cache_bytes, "cache_bytes")
        self._path = selected
        self._closed = False
        self._display_transform = None
        digest, self._identity = _stable_sha256(selected, expected_sha256)
        openslide = _load_openslide()
        try:
            detected = openslide.OpenSlide.detect_format(str(selected))
        except Exception as exc:
            raise WholeSlideUnsupportedError(
                "OpenSlide could not inspect this source safely."
            ) from exc
        extension = selected.suffix.lower()
        accepted = {("aperio", ".svs"): "SVS", ("hamamatsu", ".ndpi"): "NDPI"}
        format_name = accepted.get((detected, extension))
        if format_name is None:
            raise WholeSlideUnsupportedError(
                "This bounded reader accepts content-detected Aperio SVS and Hamamatsu NDPI only."
            )
        try:
            slide = openslide.OpenSlide(str(selected))
        except Exception as exc:
            raise WholeSlideUnsupportedError(
                "OpenSlide could not open this SVS/NDPI source."
            ) from exc
        self._slide = slide
        try:
            try:
                slide.set_cache(openslide.OpenSlideCache(cache_bytes))
            except Exception as exc:
                raise WholeSlideDependencyError(
                    "This whole-slide reader requires OpenSlide 4 cache controls."
                ) from exc
            dimensions = tuple(int(v) for v in slide.dimensions)
            level_dimensions = tuple(tuple(int(v) for v in pair) for pair in slide.level_dimensions)
            downsamples = tuple(
                _positive_finite(v, "level downsample") for v in slide.level_downsamples
            )
            if len(dimensions) != 2 or any(v <= 0 for v in dimensions):
                raise WholeSlideError("The slide declares invalid level-0 dimensions.")
            if not level_dimensions or len(level_dimensions) != len(downsamples):
                raise WholeSlideError("The slide declares inconsistent pyramid metadata.")
            if level_dimensions[0] != dimensions or not math.isclose(
                downsamples[0], 1.0, rel_tol=0, abs_tol=1e-12
            ):
                raise WholeSlideError("The slide declares an invalid level-0 pyramid mapping.")
            if any(
                len(pair) != 2 or any(value <= 0 for value in pair) for pair in level_dimensions
            ):
                raise WholeSlideError("The slide declares invalid pyramid dimensions.")
            if any(
                current <= previous
                for previous, current in zip(downsamples, downsamples[1:], strict=False)
            ):
                raise WholeSlideError(
                    "The slide pyramid downsample factors must increase strictly."
                )
            properties = slide.properties
            mpp_x_raw = properties.get(getattr(openslide, "PROPERTY_NAME_MPP_X", "openslide.mpp-x"))
            mpp_y_raw = properties.get(getattr(openslide, "PROPERTY_NAME_MPP_Y", "openslide.mpp-y"))
            if mpp_x_raw is None and mpp_y_raw is None:
                mpp = None
            elif mpp_x_raw is None or mpp_y_raw is None:
                raise WholeSlideError("The slide declares incomplete X/Y micrometre calibration.")
            else:
                mpp = (
                    _positive_finite(mpp_x_raw, "openslide.mpp-x"),
                    _positive_finite(mpp_y_raw, "openslide.mpp-y"),
                )
            try:
                source_profile = slide.color_profile
                if source_profile is None:
                    icc = _missing_icc()
                else:
                    source_bytes = _icc_bytes(source_profile)
                    output_bytes = srgb_output_profile_bytes()
                    output_profile = ImageCms.ImageCmsProfile(io.BytesIO(output_bytes))
                    intent = int(ImageCms.getDefaultIntent(source_profile))
                    self._display_transform = ImageCms.buildTransform(
                        source_profile, output_profile, "RGBA", "RGBA", intent, 0
                    )
                    icc = ICCProvenance(
                        source_status="embedded-usable",
                        source_icc_sha256=hashlib.sha256(source_bytes).hexdigest(),
                        source_icc_bytes=len(source_bytes),
                        display_space="sRGB",
                        transform="Pillow-ImageCms-source-to-sRGB",
                        rendering_intent=intent,
                        output_icc_sha256=hashlib.sha256(output_bytes).hexdigest(),
                        pillow_version=Image.__version__,
                        littlecms_version=features.version_module("littlecms2"),
                    )
            except WholeSlideError:
                raise
            except Exception as exc:
                raise WholeSlideError(
                    "The embedded ICC profile cannot define a usable display transform."
                ) from exc
            levels = tuple(
                WholeSlideLevel(
                    index=index,
                    dimensions_xy=pair,
                    downsample=downsample,
                    micrometres_per_pixel_xy=(
                        (mpp[0] * downsample, mpp[1] * downsample) if mpp else None
                    ),
                )
                for index, (pair, downsample) in enumerate(
                    zip(level_dimensions, downsamples, strict=True)
                )
            )
            self._metadata = WholeSlideMetadata(
                format=format_name,
                vendor=detected,
                level0_dimensions_xy=dimensions,
                levels=levels,
                micrometres_per_pixel_xy=mpp,
                calibration_status="declared-mpp" if mpp else "missing",
                icc=icc,
                sha256=digest,
                source_size_bytes=self._identity.size,
                decoder="OpenSlide",
                decoder_version=str(getattr(openslide, "__version__", "unknown")),
                decoder_library_version=str(getattr(openslide, "__library_version__", "unknown")),
                decoder_cache_bytes=cache_bytes,
            )
            self._validate_identity()
        except Exception:
            slide.close()
            self._closed = True
            raise

    @property
    def metadata(self) -> WholeSlideMetadata:
        self._ensure_open()
        return self._metadata

    def _ensure_open(self) -> None:
        if self._closed:
            raise WholeSlideError("This whole-slide session is closed.")

    def _validate_identity(self) -> None:
        self._ensure_open()
        if _file_identity(self._path) != self._identity:
            raise WholeSlideSourceChangedError(
                "The whole-slide source identity or stat metadata changed during the session."
            )

    def validate_source(self) -> None:
        """Verify the slide still has its opening path and stat identity."""

        self._validate_identity()

    def read_region(self, request: WholeSlideRegionRequest) -> WholeSlideRegion:
        self._ensure_open()
        if not isinstance(request, WholeSlideRegionRequest):
            raise WholeSlideError("read_region requires a WholeSlideRegionRequest.")
        for name in ("level0_x", "level0_y", "level"):
            value = getattr(request, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise WholeSlideError(f"{name} must be a non-negative integer.")
        for name in ("width", "height", "budget_bytes"):
            value = getattr(request, name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise WholeSlideError(f"{name} must be a positive integer.")
        if request.level >= len(self._metadata.levels):
            raise WholeSlideError("The requested pyramid level is outside the slide.")
        _working_budget(request.budget_bytes, "budget_bytes")
        if not isinstance(request.color_manage_display, bool):
            raise WholeSlideError("color_manage_display must be boolean.")
        if request.expected_sha256 is not None:
            if not _SHA256.fullmatch(request.expected_sha256):
                raise WholeSlideError(
                    "expected_sha256 must be 64 lowercase hexadecimal characters."
                )
            if not hmac.compare_digest(request.expected_sha256, self._metadata.sha256):
                raise WholeSlideSourceChangedError(
                    "The region fingerprint differs from the opened slide fingerprint."
                )
        level = self._metadata.levels[request.level]
        if request.width > level.dimensions_xy[0] or request.height > level.dimensions_xy[1]:
            raise WholeSlideError("The requested rectangle is larger than the selected level.")
        end_x = request.level0_x + request.width * level.downsample
        end_y = request.level0_y + request.height * level.downsample
        level0_width, level0_height = self._metadata.level0_dimensions_xy
        if end_x > level0_width + 1e-9 or end_y > level0_height + 1e-9:
            raise WholeSlideError("The requested rectangle extends outside level-0 slide bounds.")
        pixels = request.width * request.height
        # RGBA decoder image, analysis RGB, display copy and transform scratch.
        peak = pixels * (32 if request.color_manage_display else 16)
        if peak > request.budget_bytes:
            raise WholeSlideBudgetError(peak, request.budget_bytes)
        self._validate_identity()
        try:
            rgba = self._slide.read_region(
                (request.level0_x, request.level0_y), request.level, (request.width, request.height)
            )
        except Exception as exc:
            self._validate_identity()
            self.close()
            raise WholeSlideError("OpenSlide failed while decoding the requested region.") from exc
        self._validate_identity()
        if rgba.mode != "RGBA" or rgba.size != (request.width, request.height):
            raise WholeSlideError("OpenSlide returned an unexpected region layout.")
        raw_rgba = np.asarray(rgba, dtype=np.uint8)
        transparent = int(np.count_nonzero(raw_rgba[..., 3] != 255))
        analysis = _freeze(np.asarray(rgba.convert("RGB"), dtype=np.uint8))
        display = analysis
        display_color = self._metadata.icc
        if request.color_manage_display and self._display_transform is not None:
            try:
                converted = ImageCms.applyTransform(rgba.copy(), self._display_transform)
            except Exception as exc:
                self.close()
                raise WholeSlideError("The ICC display transform failed for this region.") from exc
            display = _freeze(np.asarray(converted.convert("RGB"), dtype=np.uint8))
        elif (
            not request.color_manage_display
            and self._metadata.icc.source_status == "embedded-usable"
        ):
            display_color = replace(
                self._metadata.icc,
                display_space="uncharacterized-source-RGB",
                transform="none",
                rendering_intent=None,
                output_icc_sha256=None,
            )
        return WholeSlideRegion(
            analysis_rgb=analysis,
            display_rgb=display,
            request=request,
            level_downsample=level.downsample,
            level0_extent_xyxy=(float(request.level0_x), float(request.level0_y), end_x, end_y),
            micrometres_per_pixel_xy=level.micrometres_per_pixel_xy,
            display_color=display_color,
            transparent_pixel_count=transparent,
            sha256=self._metadata.sha256,
            integrity_mode="stat-verified-session",
            estimated_peak_bytes=peak,
        )

    def verify_strict(self) -> WholeSlideIntegrityReceipt:
        self._validate_identity()
        digest, identity = _stable_sha256(self._path, self._metadata.sha256)
        if identity != self._identity:
            raise WholeSlideSourceChangedError(
                "The whole-slide source changed during strict verification."
            )
        return WholeSlideIntegrityReceipt(digest)

    def close(self) -> None:
        if not self._closed:
            self._slide.close()
            self._closed = True

    def __enter__(self) -> WholeSlideSession:
        self._ensure_open()
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        self.close()


def deconvolve_stains(
    region: WholeSlideRegion,
    *,
    declared_basis: Literal["H&E", "H-DAB"],
    working_bytes: int = DEFAULT_REGION_BUDGET_BYTES,
) -> StainDeconvolution:
    """Unmix explicitly declared stains from unmodified source-device RGB."""

    bases = {
        "H&E": (
            hed_from_rgb,
            ("hematoxylin-basis", "eosin-basis", "HED-third-DAB-basis"),
        ),
        "H-DAB": (
            hdx_from_rgb,
            ("hematoxylin-basis", "DAB-basis", "HDX-complementary-basis"),
        ),
    }
    if declared_basis not in bases:
        raise WholeSlideError("declared_basis must explicitly be H&E or H-DAB.")
    _working_budget(working_bytes, "working_bytes")
    analysis_rgb = _validated_analysis_rgb(region)
    pixels = analysis_rgb.shape[0] * analysis_rgb.shape[1]
    required = pixels * 96
    if required > working_bytes:
        raise WholeSlideBudgetError(required, working_bytes)
    matrix, components = bases[declared_basis]
    values = separate_stains(analysis_rgb, matrix)
    if not np.isfinite(values).all():
        raise WholeSlideError("Stain separation produced non-finite values.")
    return StainDeconvolution(
        values=_freeze(values),
        components=components,
        basis_name=declared_basis,
        rgb_separation_matrix=tuple(tuple(float(v) for v in row) for row in matrix),
        input_color_space="source-device-RGB",
        method="skimage.color.separate_stains",
        scientific_validation="unvalidated-research-method",
        source_sha256=region.sha256,
        level0_extent_xyxy=region.level0_extent_xyxy,
        level=region.request.level,
        level_downsample=region.level_downsample,
    )


def tissue_mask_pixels(
    analysis_rgb: np.ndarray,
    *,
    closing_radius_pixels: int = 0,
    minimum_component_pixels: int = 0,
    working_bytes: int = DEFAULT_REGION_BUDGET_BYTES,
) -> tuple[np.ndarray, float, np.ndarray]:
    """Return mask, threshold and derived luminance on an explicit source RGB grid."""

    for value, name, maximum in (
        (closing_radius_pixels, "closing_radius_pixels", 64),
        (minimum_component_pixels, "minimum_component_pixels", 10_000_000),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
            raise WholeSlideError(f"{name} must be an integer between 0 and {maximum}.")
    _working_budget(working_bytes, "working_bytes")
    if (
        not isinstance(analysis_rgb, np.ndarray)
        or analysis_rgb.ndim != 3
        or analysis_rgb.shape[-1] != 3
        or analysis_rgb.dtype != np.uint8
        or min(analysis_rgb.shape[:2]) < 1
    ):
        raise WholeSlideError("Tissue masking requires nonempty 8-bit source-device RGB.")
    pixels = analysis_rgb.shape[0] * analysis_rgb.shape[1]
    required = pixels * 64
    if required > working_bytes:
        raise WholeSlideBudgetError(required, working_bytes)
    luminance = rgb2gray(analysis_rgb)
    threshold = float(threshold_otsu(luminance))
    mask = np.asarray(luminance < threshold)
    if closing_radius_pixels:
        y, x = np.ogrid[
            -closing_radius_pixels : closing_radius_pixels + 1,
            -closing_radius_pixels : closing_radius_pixels + 1,
        ]
        footprint = x * x + y * y <= closing_radius_pixels**2
        mask = ndi.binary_closing(mask, structure=footprint)
    if minimum_component_pixels:
        labels, count = ndi.label(mask)
        if count:
            sizes = np.bincount(labels.ravel())
            keep = sizes >= minimum_component_pixels
            keep[0] = False
            mask = keep[labels]
    return _freeze(mask), threshold, luminance


def tissue_mask(
    region: WholeSlideRegion,
    *,
    closing_radius_pixels: int = 0,
    minimum_component_pixels: int = 0,
    working_bytes: int = DEFAULT_REGION_BUDGET_BYTES,
) -> TissueMaskResult:
    """Return an explicit dark-luminance Otsu research mask for one bounded region."""
    mask, threshold, _ = tissue_mask_pixels(
        _validated_analysis_rgb(region),
        closing_radius_pixels=closing_radius_pixels,
        minimum_component_pixels=minimum_component_pixels,
        working_bytes=working_bytes,
    )
    return TissueMaskResult(
        mask=_freeze(mask),
        threshold=threshold,
        threshold_method="otsu-dark-luminance",
        closing_radius_pixels=closing_radius_pixels,
        minimum_component_pixels=minimum_component_pixels,
        input_color_space="source-device-RGB",
        scientific_validation="unvalidated-research-method",
        source_sha256=region.sha256,
        level0_extent_xyxy=region.level0_extent_xyxy,
        level=region.request.level,
        level_downsample=region.level_downsample,
    )


def analyze_polygon_roi(
    region: WholeSlideRegion,
    polygon_level0_xy: Any,
    *,
    tissue: TissueMaskResult | None = None,
    working_bytes: int = DEFAULT_REGION_BUDGET_BYTES,
) -> PolygonROIAnalysis:
    """Measure one level-0 XY polygon against a bounded decoded region."""

    analysis_rgb = _validated_analysis_rgb(region)
    points = _validate_polygon(polygon_level0_xy)
    _working_budget(working_bytes, "working_bytes")
    required = analysis_rgb.shape[0] * analysis_rgb.shape[1] * 40 + len(points) * 64
    if required > working_bytes:
        raise WholeSlideBudgetError(required, working_bytes)
    x0, y0, x1, y1 = region.level0_extent_xyxy
    if any(not (x0 <= x <= x1 and y0 <= y <= y1) for x, y in points):
        raise WholeSlideError("Every ROI point must lie inside the decoded region extent.")
    downsample = region.level_downsample
    vertices_yx = np.asarray(
        [[(y - y0) / downsample, (x - x0) / downsample] for x, y in points], dtype=np.float64
    )
    mask = polygon2mask(analysis_rgb.shape[:2], vertices_yx)
    sampled = int(np.count_nonzero(mask))
    if sampled == 0:
        raise WholeSlideError("The ROI does not cover any selected-level pixel centres.")
    if tissue is not None and (
        not isinstance(tissue, TissueMaskResult)
        or tissue.mask.dtype != np.bool_
        or tissue.mask.shape != mask.shape
        or tissue.source_sha256 != region.sha256
        or tissue.level0_extent_xyxy != region.level0_extent_xyxy
        or tissue.level != region.request.level
        or tissue.level_downsample != region.level_downsample
    ):
        raise WholeSlideError(
            "The tissue mask provenance or grid does not match the decoded region."
        )
    area, centroid_x, centroid_y = _polygon_geometry(points)
    calibration = region.micrometres_per_pixel_xy
    # Region calibration is at the selected level; polygon coordinates are at
    # level 0, so divide by downsample to recover level-0 calibration.
    if calibration is None:
        centroid_um = None
        area_um2 = None
    else:
        level0_mpp_x = calibration[0] / downsample
        level0_mpp_y = calibration[1] / downsample
        centroid_um = (centroid_x * level0_mpp_x, centroid_y * level0_mpp_y)
        area_um2 = area * level0_mpp_x * level0_mpp_y
    selected = analysis_rgb[mask]
    return PolygonROIAnalysis(
        polygon_level0_xy=points,
        centroid_level0_xy=(centroid_x, centroid_y),
        area_level0_pixels_squared=area,
        centroid_micrometres_xy=centroid_um,
        area_micrometres_squared=area_um2,
        micrometres_per_level0_pixel_xy=(
            (calibration[0] / downsample, calibration[1] / downsample)
            if calibration is not None
            else None
        ),
        sampled_pixel_count=sampled,
        mean_analysis_rgb=tuple(float(v) for v in selected.mean(axis=0)),
        tissue_fraction=(float(np.mean(tissue.mask[mask])) if tissue is not None else None),
        source_sha256=region.sha256,
        sample_level=region.request.level,
        sample_level_downsample=region.level_downsample,
        sample_region_level0_extent_xyxy=region.level0_extent_xyxy,
    )
