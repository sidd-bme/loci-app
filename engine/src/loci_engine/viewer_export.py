"""Full-resolution, non-destructive exports of viewer display adjustments."""

from __future__ import annotations

import hashlib
import os
import secrets
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Any

import numpy as np
import tifffile
from PIL import Image

from .export import (
    _DIRECTORY_OPEN_FLAGS,
    _assert_root_identity,
    _fsync_directory,
    _NamedBinaryStream,
    _rename_noreplace,
    _sync_stream,
    _validated_root_identity,
)
from .models import SourceMetadata, ViewerDisplaySettings, ViewerExportFormat
from .render import (
    DISPLAY_NORMALIZATION_SCRATCH_BYTES,
    _alpha_float,
    _display_bounds,
    _display_float,
)

_VIEW_SUFFIXES: dict[ViewerExportFormat, frozenset[str]] = {
    "png": frozenset({".png"}),
    "tiff": frozenset({".tif", ".tiff"}),
}
_VIEW_FILE_CREATE_FLAGS = (
    os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
)
MAX_VIEWER_RENDER_WORKING_BYTES = 768 * 1024 * 1024


def _validated_filename(value: object, export_format: ViewerExportFormat) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value in {".", ".."}
        or "/" in value
        or "\\" in value
        or Path(value).name != value
    ):
        raise ValueError("Viewer export filename must be a plain filename")
    if Path(value).suffix.lower() not in _VIEW_SUFFIXES[export_format]:
        raise ValueError(f"Viewer export filename does not match {export_format} format")
    return value


def _apply_scalar_adjustments(values: np.ndarray, settings: ViewerDisplaySettings) -> None:
    """Apply gamma, midpoint contrast, and brightness to a float array in place."""

    np.power(values, 1.0 / float(settings.gamma), out=values)
    values -= 0.5
    values *= float(settings.contrast) / 100.0
    values += 0.5 + float(settings.brightness) / 100.0
    np.clip(values, 0.0, 1.0, out=values)


def _apply_display_window(values: np.ndarray, settings: ViewerDisplaySettings) -> None:
    """Map the explicit normalized black/white interval to the display range in place."""

    values -= float(settings.black_point)
    values /= float(settings.white_point - settings.black_point)
    np.clip(values, 0.0, 1.0, out=values)


def _render_display_float(
    image: np.ndarray,
    settings: ViewerDisplaySettings,
    display_bounds: tuple[float, float],
) -> tuple[np.ndarray, np.ndarray | None]:
    """Return adjusted RGB or neutral grayscale values plus optional source alpha."""

    source = np.asarray(image)
    if source.ndim == 2 or (source.ndim == 3 and source.shape[-1] == 1):
        grayscale = _display_float(
            source if source.ndim == 2 else source[..., 0],
            display_bounds=display_bounds,
        )
        _apply_display_window(grayscale, settings)
        _apply_scalar_adjustments(grayscale, settings)
        if settings.red and settings.green and settings.blue:
            return grayscale, None
        rgb = np.repeat(grayscale[..., np.newaxis], 3, axis=-1)
    elif source.ndim == 3 and source.shape[-1] in {3, 4}:
        rgb = _display_float(source[..., :3], display_bounds=display_bounds)
    else:
        raise ValueError("A viewer export requires a 2D grayscale, RGB, or RGBA image")

    saturation = float(settings.saturation) / 100.0
    if saturation != 1.0:
        # SVG/CSS saturation uses these sRGB luminance weights. Matching them
        # keeps saved output aligned with the GPU-backed viewer preview. Einsum
        # produces one declared scratch plane rather than chained full-frame
        # multiply/add temporaries that would escape the memory estimate.
        luminance = np.einsum(
            "...c,c->...",
            rgb,
            np.array([0.213, 0.715, 0.072], dtype=np.float32),
            optimize=False,
        )
        for index in range(3):
            rgb[..., index] -= luminance
            rgb[..., index] *= saturation
            rgb[..., index] += luminance
        del luminance

    # SVG filter primitives clamp their output before the following primitive.
    # Match Chromium before applying the gamma component transfer so negative
    # oversaturation values cannot become positive again under an even exponent.
    np.clip(rgb, 0.0, 1.0, out=rgb)

    _apply_display_window(rgb, settings)
    _apply_scalar_adjustments(rgb, settings)
    for index, enabled in enumerate((settings.red, settings.green, settings.blue)):
        if not enabled:
            rgb[..., index] = 0.0

    alpha = _alpha_float(source[..., 3]) if source.ndim == 3 and source.shape[-1] == 4 else None
    return rgb, alpha


def render_adjusted_view(
    image: np.ndarray,
    settings: ViewerDisplaySettings,
    *,
    bit_depth: int,
) -> np.ndarray:
    """Render through saturation, window, gamma, contrast/brightness, and RGB masks."""

    settings.validate()
    if bit_depth not in {8, 16}:
        raise ValueError("Viewer export bit depth must be 8 or 16")
    source = np.asarray(image)
    height, width = source.shape[:2]
    channels = 1 if source.ndim == 2 else int(source.shape[-1])
    color_channels = 3 if channels in {3, 4} else 1
    if channels == 1 and (
        settings.saturation != 100 or not (settings.red and settings.green and settings.blue)
    ):
        raise ValueError("Saturation and RGB component masks apply only to RGB or RGBA sources")
    pixel_count = int(height) * int(width)
    estimated_working_bytes = int(source.nbytes)
    direct_display_conversion = (
        source.dtype == np.uint8
        or np.issubdtype(source.dtype, np.bool_)
        or (color_channels == 3 and np.issubdtype(source.dtype, np.unsignedinteger))
    )
    if direct_display_conversion:
        float_planes = color_channels
        mask_bytes = 0
    else:
        # Robust windowing may coexist with a converted float plane, finite
        # mask, compacted finite values, np.where output, and percentile work.
        float_planes = color_channels * 4
        mask_bytes = pixel_count * color_channels
    estimated_working_bytes += pixel_count * float_planes * np.dtype(np.float32).itemsize
    estimated_working_bytes += mask_bytes
    estimated_working_bytes += DISPLAY_NORMALIZATION_SCRATCH_BYTES
    if channels == 4:
        alpha_planes = 1 if np.issubdtype(source.dtype, np.integer) else 2
        estimated_working_bytes += pixel_count * alpha_planes * np.dtype(np.float32).itemsize
    if color_channels == 3 and settings.saturation != 100:
        estimated_working_bytes += pixel_count * np.dtype(np.float32).itemsize
    estimated_working_bytes += pixel_count * channels * (bit_depth // 8)
    if estimated_working_bytes > MAX_VIEWER_RENDER_WORKING_BYTES:
        raise ValueError(
            "This image can be opened safely but its rendered export would exceed Loci's "
            f"{MAX_VIEWER_RENDER_WORKING_BYTES // (1024 * 1024)} MiB working-memory guard. "
            "Export a cropped or downsampled copy."
        )

    display, alpha = _render_display_float(
        image,
        settings,
        _display_bounds(source),
    )
    maximum = 255 if bit_depth == 8 else 65_535
    dtype = np.uint8 if bit_depth == 8 else np.uint16
    display *= maximum
    np.rint(display, out=display)
    if alpha is not None:
        alpha *= maximum
        np.rint(alpha, out=alpha)
        pixels = np.empty((*display.shape[:2], 4), dtype=dtype)
        np.copyto(pixels[..., :3], display, casting="unsafe")
        np.copyto(pixels[..., 3], alpha, casting="unsafe")
        return pixels
    return display.astype(dtype)


def _write_rendered_stream(
    stream: Any,
    filename: str,
    export_format: ViewerExportFormat,
    pixels: np.ndarray,
) -> None:
    if export_format == "png":
        Image.fromarray(pixels).save(
            stream,
            format="PNG",
            optimize=True,
            compress_level=9,
        )
    else:
        channels = 1 if pixels.ndim == 2 else int(pixels.shape[-1])
        kwargs: dict[str, object] = {
            "photometric": "minisblack" if channels == 1 else "rgb",
            "metadata": {"axes": "YX" if channels == 1 else "YXS"},
        }
        if channels == 4:
            kwargs["extrasamples"] = "unassalpha"
        tifffile.imwrite(_NamedBinaryStream(stream, filename), pixels, **kwargs)
    _sync_stream(stream)


def _sha256_stream(stream: Any) -> str:
    stream.flush()
    stream.seek(0)
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    stream.seek(0, os.SEEK_END)
    return digest.hexdigest()


def _receipt(
    *,
    destination: Path,
    export_format: ViewerExportFormat,
    pixels: np.ndarray,
    metadata: SourceMetadata,
    output_sha256: str,
    byte_length: int,
    settings: ViewerDisplaySettings,
) -> dict[str, object]:
    return {
        "path": str(destination),
        "format": export_format,
        "width": int(pixels.shape[1]),
        "height": int(pixels.shape[0]),
        "channels": 1 if pixels.ndim == 2 else int(pixels.shape[-1]),
        "dtype": str(pixels.dtype),
        "byte_length": byte_length,
        "source_sha256": metadata.sha256,
        "output_sha256": output_sha256,
        "settings": settings.to_dict(),
    }


def export_adjusted_view(
    image: np.ndarray,
    metadata: SourceMetadata,
    directory_value: str | Path,
    directory_identity: object,
    filename_value: object,
    export_format: ViewerExportFormat,
    settings: ViewerDisplaySettings,
) -> dict[str, object]:
    """Publish one rendered view atomically, refusing source writes and replacement."""

    if metadata.access_mode != "full":
        raise ValueError(
            metadata.view_only_reason or "Rendered export is unavailable for this overview source."
        )
    if export_format not in _VIEW_SUFFIXES:
        raise ValueError("Viewer export format must be png or tiff")
    filename = _validated_filename(filename_value, export_format)
    expected_identity = _validated_root_identity(directory_identity)
    directory = Path(directory_value).expanduser().resolve(strict=True)
    if not directory.is_dir():
        raise NotADirectoryError(f"Viewer export directory is not a directory: {directory}")
    destination = directory / filename
    if destination == Path(metadata.path).expanduser().resolve():
        raise ValueError("Viewer export cannot replace the imported source image")

    bit_depth = 8 if export_format == "png" else 16
    pixels = render_adjusted_view(image, settings, bit_depth=bit_depth)

    if all(function in os.supports_dir_fd for function in (os.open, os.rename, os.stat, os.unlink)):
        directory_descriptor = os.open(directory, _DIRECTORY_OPEN_FLAGS)
        temporary_name = f".loci-view-{secrets.token_hex(16)}.tmp"
        published = False
        try:
            _assert_root_identity(os.fstat(directory_descriptor), expected_identity)
            try:
                os.stat(filename, dir_fd=directory_descriptor, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise FileExistsError(f"Viewer export already exists: {filename}")

            descriptor = os.open(
                temporary_name,
                _VIEW_FILE_CREATE_FLAGS,
                0o600,
                dir_fd=directory_descriptor,
            )
            with os.fdopen(descriptor, "w+b") as stream:
                _write_rendered_stream(stream, filename, export_format, pixels)
                output_sha256 = _sha256_stream(stream)
                byte_length = int(os.fstat(stream.fileno()).st_size)

            _assert_root_identity(os.fstat(directory_descriptor), expected_identity)
            _rename_noreplace(
                temporary_name,
                filename,
                src_dir_fd=directory_descriptor,
                dst_dir_fd=directory_descriptor,
            )
            published = True
            os.fsync(directory_descriptor)
        finally:
            if not published:
                with suppress(FileNotFoundError):
                    os.unlink(temporary_name, dir_fd=directory_descriptor)
            os.close(directory_descriptor)
    else:
        _assert_root_identity(directory.stat(), expected_identity)
        if destination.exists() or destination.is_symlink():
            raise FileExistsError(f"Viewer export already exists: {filename}")
        descriptor, temporary_value = tempfile.mkstemp(
            prefix=".loci-view-",
            suffix=".tmp",
            dir=directory,
        )
        temporary = Path(temporary_value)
        published = False
        try:
            with os.fdopen(descriptor, "w+b") as stream:
                _write_rendered_stream(stream, filename, export_format, pixels)
                output_sha256 = _sha256_stream(stream)
                byte_length = int(os.fstat(stream.fileno()).st_size)
            _assert_root_identity(directory.stat(), expected_identity)
            _rename_noreplace(temporary, destination)
            published = True
            _fsync_directory(directory)
        finally:
            if not published:
                temporary.unlink(missing_ok=True)

    return _receipt(
        destination=destination,
        export_format=export_format,
        pixels=pixels,
        metadata=metadata,
        output_sha256=output_sha256,
        byte_length=byte_length,
        settings=settings,
    )
