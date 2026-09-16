"""Read-only image loading and source provenance."""

from __future__ import annotations

import hashlib
import hmac
import mmap
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import cv2
import numpy as np
import tifffile
from PIL import Image, UnidentifiedImageError

from .ims import UnsupportedImarisError, is_hdf5_file, load_ims_overview
from .models import SourceMetadata

# Pillow's process-global pixel heuristic conflicts with Loci's dtype/channel-
# aware decoded-memory policy. Image.open remains lazy, and every accepted
# Pillow path is preflighted through _validate_decode_budget before pixel load.
Image.MAX_IMAGE_PIXELS = None

SUPPORTED_STILL_SUFFIXES = {".tif", ".tiff", ".png", ".jpg", ".jpeg"}
SUPPORTED_SUFFIXES = SUPPORTED_STILL_SUFFIXES | {".ims"}
MAX_DECODED_SOURCE_BYTES = 512 * 1024 * 1024
MAX_TIFF_OVERVIEW_DECODED_BYTES = 64 * 1024 * 1024
# OpenCV's PNG API consumes one contiguous encoded stream. Keep that decoder
# input bounded independently from TIFF/IMS, whose readers use metadata,
# pyramids, or chunked datasets instead of materializing an encoded file.
MAX_PNG_DECODER_INPUT_BYTES = MAX_DECODED_SOURCE_BYTES + 128 * 1024 * 1024
MIN_PNG_DECODER_INPUT_BYTES = 64 * 1024 * 1024
PNG_DECODER_OVERHEAD_BYTES = 32 * 1024 * 1024


class UnsupportedImageError(ValueError):
    """Raised when an input cannot be interpreted as a supported still image."""


class DecodedImageTooLargeError(UnsupportedImageError):
    """Raised when eager decoding would exceed an explicit working-memory guard."""

    def __init__(self, required_bytes: int, limit_bytes: int) -> None:
        self.required_bytes = required_bytes
        self.limit_bytes = limit_bytes
        super().__init__(
            f"This image requires {required_bytes / (1024 * 1024):,.1f} MiB after decoding, "
            "which exceeds Loci's current "
            f"{limit_bytes // (1024 * 1024)} MiB eager-decoding safety guard. "
            "The encoded file size is not the limit. Use a cropped or downsampled copy until "
            "the tiled whole-slide reader is available."
        )


class SourceChangedError(RuntimeError):
    """Raised when source bytes do not match the imported or decoded snapshot."""


@dataclass(frozen=True, slots=True)
class _TiffLoadPlan:
    access_mode: str
    selected_level: int
    resolution_levels: int
    full_width: int
    full_height: int
    selected_width: int
    selected_height: int
    channels: int
    dtype: str
    full_decoded_bytes: int
    selected_decoded_bytes: int
    tiled: bool
    selected_level_tiled: bool

    def source_details(self) -> dict[str, object]:
        return {
            "kind": "tiff-pyramid",
            "width": self.full_width,
            "height": self.full_height,
            "channels": self.channels,
            "dtype": self.dtype,
            "resolution_levels": self.resolution_levels,
            "selected_resolution_level": self.selected_level,
            "selected_level_width": self.selected_width,
            "selected_level_height": self.selected_height,
            "full_decoded_bytes": self.full_decoded_bytes,
            "selected_decoded_bytes": self.selected_decoded_bytes,
            "tiled": self.tiled,
            "selected_level_tiled": self.selected_level_tiled,
        }


def _fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _coerce_still(array: np.ndarray) -> np.ndarray:
    array = np.asarray(array)
    if array.ndim == 2:
        return array
    if array.ndim == 3 and array.shape[-1] in {1, 3, 4}:
        return array
    raise UnsupportedImageError(
        "This image appears to be a stack or unsupported channel layout. "
        "Loci 0.1 supports single 2D grayscale, RGB, and RGBA images."
    )


def _canonical_tiff_shape(page: tifffile.TiffPage) -> tuple[int, ...]:
    shape = tuple(int(value) for value in page.shape)
    if page.planarconfig != tifffile.PLANARCONFIG.SEPARATE:
        return shape

    samples = int(page.samplesperpixel)
    if (
        page.photometric != tifffile.PHOTOMETRIC.RGB
        or samples not in {3, 4}
        or len(shape) != 3
        or shape[0] != samples
    ):
        raise UnsupportedImageError(
            "This TIFF uses an unsupported planar channel layout. Loci 0.1 supports "
            "planar RGB/RGBA TIFF images with three or four sample planes."
        )
    return shape[1], shape[2], samples


def _validate_tiff_page_metadata(
    page: tifffile.TiffPage,
) -> tuple[tifffile.PHOTOMETRIC, int, tuple[int, ...]]:
    """Validate a TIFF page and its decoded-memory footprint without running a codec."""

    photometric = page.photometric
    orientation_tag = page.tags.get("Orientation")
    orientation = int(orientation_tag.value) if orientation_tag is not None else 1
    if orientation not in range(1, 9):
        raise UnsupportedImageError(f"This image declares invalid EXIF orientation {orientation}.")
    supported_grayscale = {
        tifffile.PHOTOMETRIC.MINISBLACK,
        tifffile.PHOTOMETRIC.MINISWHITE,
    }
    if photometric not in supported_grayscale | {
        tifffile.PHOTOMETRIC.RGB,
        tifffile.PHOTOMETRIC.PALETTE,
    }:
        photometric_name = getattr(photometric, "name", str(photometric))
        raise UnsupportedImageError(
            f"This TIFF uses unsupported photometric interpretation {photometric_name}. "
            "Convert a copy to grayscale, RGB, or RGBA TIFF before importing it."
        )

    bits_value = page.bitspersample
    bits_per_sample = (
        tuple(int(value) for value in bits_value)
        if isinstance(bits_value, tuple)
        else (int(bits_value),)
    )
    dtype_bits = int(page.dtype.itemsize * 8)
    if (
        photometric != tifffile.PHOTOMETRIC.PALETTE
        and not np.issubdtype(page.dtype, np.bool_)
        and any(value != dtype_bits for value in bits_per_sample)
    ):
        declared = ", ".join(str(value) for value in bits_per_sample)
        raise UnsupportedImageError(
            f"This TIFF uses packed {declared}-bit samples in a {page.dtype} decoder type. "
            f"Convert a copy to an unpacked {dtype_bits}-bit TIFF before importing it."
        )

    canonical_shape = _canonical_tiff_shape(page)
    if photometric == tifffile.PHOTOMETRIC.PALETTE and (
        len(canonical_shape) != 2 or page.colormap is None
    ):
        raise UnsupportedImageError("This palette TIFF has an invalid colour-map layout.")

    if photometric in supported_grayscale and len(canonical_shape) != 2:
        raise UnsupportedImageError(
            "This grayscale TIFF contains extra samples that Loci cannot interpret safely."
        )
    if photometric == tifffile.PHOTOMETRIC.RGB:
        if len(canonical_shape) != 3 or canonical_shape[-1] not in {3, 4}:
            raise UnsupportedImageError("This RGB TIFF has an unsupported sample layout.")
        if canonical_shape[-1] == 4:
            extras = tuple(page.extrasamples)
            if extras != (tifffile.EXTRASAMPLE.UNASSALPHA,):
                raise UnsupportedImageError(
                    "This four-sample RGB TIFF does not declare one unassociated alpha channel. "
                    "Convert a copy to an explicit RGBA TIFF before importing it."
                )

    decoded_shape, decoded_dtype = _tiff_decoded_layout(page, canonical_shape)
    _validate_decode_budget(decoded_shape, decoded_dtype)
    return photometric, orientation, canonical_shape


def _tiff_decoded_layout(
    page: tifffile.TiffPage,
    canonical_shape: tuple[int, ...],
) -> tuple[tuple[int, ...], np.dtype[object]]:
    if page.photometric == tifffile.PHOTOMETRIC.PALETTE:
        return (*canonical_shape, 3), np.dtype(np.uint16)
    return canonical_shape, np.dtype(page.dtype)


def _decoded_byte_count(shape: tuple[int, ...], dtype: np.dtype[object]) -> int:
    decoded_bytes = int(dtype.itemsize)
    for value in shape:
        decoded_bytes *= int(value)
    return decoded_bytes


def _oriented_tiff_size(canonical_shape: tuple[int, ...], orientation: int) -> tuple[int, int]:
    height, width = canonical_shape[:2]
    if orientation in {5, 6, 7, 8}:
        return int(height), int(width)
    return int(width), int(height)


def _tiff_page_channels(page: tifffile.TiffPage, canonical_shape: tuple[int, ...]) -> int:
    if page.photometric == tifffile.PHOTOMETRIC.PALETTE:
        return 3
    return 1 if len(canonical_shape) == 2 else int(canonical_shape[-1])


def _decode_tiff_page(page: tifffile.TiffPage) -> np.ndarray:
    photometric, orientation, canonical_shape = _validate_tiff_page_metadata(page)
    supported_grayscale = {
        tifffile.PHOTOMETRIC.MINISBLACK,
        tifffile.PHOTOMETRIC.MINISWHITE,
    }

    array = page.asarray()
    if page.planarconfig == tifffile.PLANARCONFIG.SEPARATE:
        array = np.moveaxis(array, 0, -1)
    if tuple(int(value) for value in array.shape) != canonical_shape:
        raise UnsupportedImageError(
            "This TIFF decoded to an unexpected channel layout. Export it as a single-plane "
            "grayscale, RGB, or RGBA TIFF before importing it."
        )

    if photometric in supported_grayscale:
        if photometric == tifffile.PHOTOMETRIC.MINISWHITE:
            if np.issubdtype(array.dtype, np.bool_):
                array = np.logical_not(array)
            elif np.issubdtype(array.dtype, np.unsignedinteger):
                array = np.iinfo(array.dtype).max - array
            else:
                raise UnsupportedImageError(
                    "This MINISWHITE TIFF uses an unsupported signed or floating sample type."
                )
        return _apply_exif_orientation(array, orientation)

    if photometric == tifffile.PHOTOMETRIC.PALETTE:
        if not np.issubdtype(array.dtype, np.unsignedinteger):
            raise UnsupportedImageError("This palette TIFF uses unsupported signed indices.")
        colormap = np.asarray(page.colormap)
        maximum_index = int(array.max(initial=0))
        if colormap.ndim != 2 or colormap.shape[0] != 3 or maximum_index >= colormap.shape[1]:
            raise UnsupportedImageError("This palette TIFF contains invalid colour-map indices.")
        rgb = np.ascontiguousarray(np.moveaxis(colormap[:, array], 0, -1))
        return _apply_exif_orientation(rgb, orientation)

    return _apply_exif_orientation(array, orientation)


def _validate_still_frame_count(image: Image.Image, image_format: str) -> None:
    frame_count = int(getattr(image, "n_frames", 1))
    if frame_count != 1:
        unit = "pages" if image_format == "TIFF" else "frames"
        raise UnsupportedImageError(
            f"This {image_format} contains {frame_count} {unit}. Loci 0.1 accepts one still "
            "image per file; export the intended frame as a separate TIFF, PNG, or JPEG."
        )


def _decode_pillow_still(image: Image.Image, image_format: str) -> np.ndarray:
    _validate_still_frame_count(image, image_format)
    if image.mode == "P":
        target_mode = "RGBA" if "transparency" in image.info else "RGB"
        image = image.convert(target_mode)
    elif image.mode == "LA":
        image = image.convert("RGBA")
    elif image.mode == "CMYK":
        image = image.convert("RGB")
    return np.asarray(image)


def _apply_exif_orientation(array: np.ndarray, orientation: int) -> np.ndarray:
    """Apply the TIFF/EXIF orientation to decoded pixels without changing the source."""

    if orientation == 1:
        return array
    if orientation == 2:
        transformed = np.fliplr(array)
    elif orientation == 3:
        transformed = np.rot90(array, 2)
    elif orientation == 4:
        transformed = np.flipud(array)
    elif orientation == 5:
        transformed = np.swapaxes(array, 0, 1)
    elif orientation == 6:
        transformed = np.rot90(array, 3)
    elif orientation == 7:
        transformed = np.flip(np.swapaxes(array, 0, 1), axis=(0, 1))
    elif orientation == 8:
        transformed = np.rot90(array, 1)
    else:
        raise UnsupportedImageError(f"This image declares invalid EXIF orientation {orientation}.")
    return np.ascontiguousarray(transformed)


def _decode_png(path: Path) -> np.ndarray:
    """Decode PNG without discarding 16-bit RGB/RGBA samples."""

    # Revalidate the bounded decoder input immediately before mapping it. The
    # caller's preflight performed the same check before source hashing.
    with path.open("rb") as stream:
        decode_shape, decode_dtype = _png_decode_layout_from_stream(stream, path)
        _validate_decode_budget(decode_shape, decode_dtype)
        encoded_bytes = int(os.fstat(stream.fileno()).st_size)
        encoded_map = mmap.mmap(
            stream.fileno(),
            encoded_bytes,
            access=mmap.ACCESS_READ,
        )
        try:
            encoded = np.frombuffer(encoded_map, dtype=np.uint8)
            try:
                array = cv2.imdecode(encoded, cv2.IMREAD_UNCHANGED)
            finally:
                # Release the exported mmap buffer before closing the mapping.
                del encoded
        finally:
            encoded_map.close()
    if array is None:
        raise UnsupportedImageError(f"Loci could not decode '{path.name}'.")
    if array.ndim == 3 and array.shape[-1] == 3:
        array = cv2.cvtColor(array, cv2.COLOR_BGR2RGB)
    elif array.ndim == 3 and array.shape[-1] == 4:
        array = cv2.cvtColor(array, cv2.COLOR_BGRA2RGBA)
    return array


def _validate_decode_budget(shape: tuple[int, ...], dtype: np.dtype[object]) -> None:
    if len(shape) < 2:
        raise UnsupportedImageError("This image does not contain a 2D pixel plane.")
    if any(int(value) <= 0 for value in shape):
        raise UnsupportedImageError("This image declares an invalid empty pixel plane.")
    if not (
        np.issubdtype(dtype, np.bool_)
        or np.issubdtype(dtype, np.integer)
        or np.issubdtype(dtype, np.floating)
    ):
        raise UnsupportedImageError(
            f"This image uses unsupported {dtype} samples. Convert a copy to a real-valued "
            "boolean, integer, or floating-point image before importing it."
        )
    if np.issubdtype(dtype, np.integer) and dtype.itemsize > 4:
        raise UnsupportedImageError(
            f"This image uses unsupported 64-bit integer samples ({dtype}). Loci cannot "
            "preserve a narrow intensity range at that offset in its current display basis. "
            "Convert a copy to a 32-bit integer or floating-point image with a documented "
            "value mapping before importing it."
        )
    if np.issubdtype(dtype, np.floating) and dtype.itemsize > 8:
        raise UnsupportedImageError(
            f"This image uses unsupported floating-point samples wider than 64 bits ({dtype}). "
            "Convert a copy to a 32-bit or 64-bit floating-point image with a documented "
            "value mapping before importing it."
        )
    decoded_bytes = _decoded_byte_count(shape, dtype)
    if decoded_bytes > MAX_DECODED_SOURCE_BYTES:
        raise DecodedImageTooLargeError(decoded_bytes, MAX_DECODED_SOURCE_BYTES)


def _png_decode_layout_from_stream(
    stream: BinaryIO,
    path: Path,
) -> tuple[tuple[int, ...], np.dtype[object]]:
    """Validate one opened PNG descriptor before any ancillary-chunk parsing."""

    stream.seek(0)
    header = stream.read(29)
    if len(header) != 29 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise UnsupportedImageError(f"Loci could not decode '{path.name}'.")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    bit_depth = int(header[24])
    colour_type = int(header[25])
    # OpenCV expands indexed and grayscale-alpha PNGs to displayed colour.
    channels_by_colour_type = {0: 1, 2: 3, 3: 4, 4: 4, 6: 4}
    channels = channels_by_colour_type.get(colour_type)
    if channels is None or bit_depth not in {1, 2, 4, 8, 16}:
        raise UnsupportedImageError("This PNG declares an unsupported colour layout.")
    dtype = np.dtype(np.uint16 if bit_depth == 16 else np.uint8)
    shape = (height, width) if channels == 1 else (height, width, channels)
    _validate_png_decoder_input(
        path,
        _decoded_byte_count(shape, dtype),
        encoded_bytes=int(os.fstat(stream.fileno()).st_size),
    )
    return shape, dtype


def _stream_has_png_signature(stream: BinaryIO) -> bool:
    stream.seek(0)
    signature = stream.read(8)
    stream.seek(0)
    return signature == b"\x89PNG\r\n\x1a\n"


def _png_decode_layout(path: Path) -> tuple[tuple[int, ...], np.dtype[object]]:
    """Return OpenCV's expected decoded PNG layout from a bounded file descriptor."""

    with path.open("rb") as stream:
        return _png_decode_layout_from_stream(stream, path)


def _validate_png_decoder_input(
    path: Path,
    decoded_bytes: int,
    *,
    encoded_bytes: int | None = None,
) -> None:
    """Bound the single-stream PNG decoder without constraining TIFF or IMS files."""

    if encoded_bytes is None:
        encoded_bytes = int(path.stat().st_size)
    decoder_input_limit = min(
        MAX_PNG_DECODER_INPUT_BYTES,
        max(
            MIN_PNG_DECODER_INPUT_BYTES,
            decoded_bytes + PNG_DECODER_OVERHEAD_BYTES,
        ),
    )
    if encoded_bytes > decoder_input_limit:
        raise UnsupportedImageError(
            f"This PNG is {encoded_bytes / (1024 * 1024):,.1f} MiB encoded, above Loci's "
            f"{decoder_input_limit // (1024 * 1024)} MiB PNG-decoder input guard for its "
            f"{decoded_bytes / (1024 * 1024):,.1f} MiB pixel plane. "
            "PNG decoding requires one contiguous encoded stream; oversized ancillary or "
            "trailing payloads are not passed to the decoder. Remove that metadata or convert "
            "a copy to tiled TIFF. This PNG-specific guard does not limit TIFF or IMS files."
        )


def _pillow_decode_layout(image: Image.Image) -> tuple[tuple[int, ...], np.dtype[object]]:
    """Return the post-conversion layout used by ``_decode_pillow_still``."""

    mode_layouts: dict[str, tuple[int, np.dtype[object]]] = {
        "1": (1, np.dtype(np.bool_)),
        "L": (1, np.dtype(np.uint8)),
        "P": (4 if "transparency" in image.info else 3, np.dtype(np.uint8)),
        "LA": (4, np.dtype(np.uint8)),
        "RGB": (3, np.dtype(np.uint8)),
        "RGBA": (4, np.dtype(np.uint8)),
        "CMYK": (3, np.dtype(np.uint8)),
        "I": (1, np.dtype(np.int32)),
        "F": (1, np.dtype(np.float32)),
        "I;16": (1, np.dtype(np.uint16)),
        "I;16B": (1, np.dtype(np.uint16)),
        "I;16L": (1, np.dtype(np.uint16)),
    }
    layout = mode_layouts.get(image.mode)
    if layout is None:
        # Pillow remains the decoder authority for uncommon still modes, but
        # assume four float32 planes for the pre-decode safety decision.
        channels, dtype = 4, np.dtype(np.float32)
    else:
        channels, dtype = layout
    shape = (int(image.height), int(image.width))
    if channels != 1:
        shape = (*shape, channels)
    return shape, dtype


def _select_tiff_load_plan(tif: tifffile.TiffFile) -> _TiffLoadPlan:
    """Choose full pixels or one real pyramid level without decoding the root plane."""

    page_count = len(tif.pages)
    if page_count != 1:
        raise UnsupportedImageError(
            f"This TIFF contains {page_count} pages. "
            "Loci 0.1 accepts single-plane TIFF images only."
        )

    root = tif.pages[0]
    try:
        _root_photometric, root_orientation, root_shape = _validate_tiff_page_metadata(root)
    except DecodedImageTooLargeError as oversized:
        root_orientation_tag = root.tags.get("Orientation")
        root_orientation = (
            int(root_orientation_tag.value) if root_orientation_tag is not None else 1
        )
        root_shape = _canonical_tiff_shape(root)
        root_decoded_shape, root_decoded_dtype = _tiff_decoded_layout(root, root_shape)
        root_width, root_height = _oriented_tiff_size(root_shape, root_orientation)
        root_channels = _tiff_page_channels(root, root_shape)

        try:
            levels = tuple(tif.series[0].levels)
        except (IndexError, tifffile.TiffFileError):
            raise oversized from None
        if len(levels) <= 1 or len(levels[0].pages) != 1:
            raise oversized
        level_zero = levels[0].pages[0]
        if int(level_zero.offset) != int(root.offset):
            raise oversized

        for level_index, level in enumerate(levels[1:], start=1):
            if len(level.pages) != 1:
                continue
            page = level.pages[0]
            try:
                candidate_photometric, candidate_orientation, candidate_shape = (
                    _validate_tiff_page_metadata(page)
                )
            except UnsupportedImageError:
                continue
            if (
                candidate_photometric != root.photometric
                or candidate_orientation != root_orientation
            ):
                continue
            if candidate_photometric == tifffile.PHOTOMETRIC.PALETTE and not np.array_equal(
                np.asarray(page.colormap),
                np.asarray(root.colormap),
            ):
                # Palette indices have no stable colour meaning unless every
                # selected level uses the root plane's exact colour map.
                continue
            candidate_decoded_shape, candidate_dtype = _tiff_decoded_layout(page, candidate_shape)
            candidate_channels = _tiff_page_channels(page, candidate_shape)
            if candidate_dtype != root_decoded_dtype or candidate_channels != root_channels:
                continue
            candidate_width, candidate_height = _oriented_tiff_size(
                candidate_shape, candidate_orientation
            )
            if candidate_width >= root_width or candidate_height >= root_height:
                continue
            aspect_ratio_delta = abs(
                (candidate_width / candidate_height) - (root_width / root_height)
            ) / (root_width / root_height)
            if aspect_ratio_delta > 0.02:
                continue
            candidate_decoded_bytes = _decoded_byte_count(candidate_decoded_shape, candidate_dtype)
            if candidate_decoded_bytes > MAX_TIFF_OVERVIEW_DECODED_BYTES:
                continue
            return _TiffLoadPlan(
                access_mode="overview",
                selected_level=level_index,
                resolution_levels=len(levels),
                full_width=root_width,
                full_height=root_height,
                selected_width=candidate_width,
                selected_height=candidate_height,
                channels=root_channels,
                dtype=str(root_decoded_dtype),
                full_decoded_bytes=oversized.required_bytes,
                selected_decoded_bytes=candidate_decoded_bytes,
                tiled=bool(root.is_tiled),
                selected_level_tiled=bool(page.is_tiled),
            )

        raise UnsupportedImageError(
            f"This pyramidal TIFF requires {oversized.required_bytes / (1024 * 1024):,.1f} MiB "
            "at full resolution, and none of its compatible reduced-resolution levels fit "
            f"Loci's {MAX_TIFF_OVERVIEW_DECODED_BYTES // (1024 * 1024)} MiB overview guard. "
            "Use a cropped or downsampled copy until native tiled access is available."
        ) from oversized

    root_decoded_shape, root_decoded_dtype = _tiff_decoded_layout(root, root_shape)
    root_width, root_height = _oriented_tiff_size(root_shape, root_orientation)
    decoded_bytes = _decoded_byte_count(root_decoded_shape, root_decoded_dtype)
    return _TiffLoadPlan(
        access_mode="full",
        selected_level=0,
        resolution_levels=1,
        full_width=root_width,
        full_height=root_height,
        selected_width=root_width,
        selected_height=root_height,
        channels=_tiff_page_channels(root, root_shape),
        dtype=str(root_decoded_dtype),
        full_decoded_bytes=decoded_bytes,
        selected_decoded_bytes=decoded_bytes,
        tiled=bool(root.is_tiled),
        selected_level_tiled=bool(root.is_tiled),
    )


def _preflight_decode(path: Path) -> _TiffLoadPlan | None:
    """Reject unsupported or over-budget sources before hashing or pixel decoding."""

    if path.suffix.lower() in {".tif", ".tiff"}:
        with tifffile.TiffFile(path) as tif:
            return _select_tiff_load_plan(tif)

    with path.open("rb") as stream:
        if _stream_has_png_signature(stream):
            decode_shape, decode_dtype = _png_decode_layout_from_stream(stream, path)
            _validate_decode_budget(decode_shape, decode_dtype)
            stream.seek(0)
            with Image.open(stream) as image:
                image_format = image.format or "PNG"
                _validate_still_frame_count(image, image_format)
        else:
            with Image.open(stream) as image:
                image_format = image.format or path.suffix.lstrip(".").upper()
                _validate_still_frame_count(image, image_format)
                decode_shape, decode_dtype = _pillow_decode_layout(image)
                _validate_decode_budget(decode_shape, decode_dtype)
    return None


def load_image(
    path_value: str | Path,
    *,
    expected_sha256: str | None = None,
) -> tuple[np.ndarray, SourceMetadata]:
    """Load the first and only supported still plane without changing the source."""

    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Image does not exist: {path}")
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise UnsupportedImageError(
            f"Unsupported file type '{path.suffix or '(none)'}'. Choose TIFF, PNG, JPEG, or IMS."
        )
    if expected_sha256 is not None:
        if not isinstance(expected_sha256, str) or not re.fullmatch(
            r"[0-9a-fA-F]{64}", expected_sha256
        ):
            raise ValueError("expected_sha256 must be a 64-character hexadecimal digest")
        expected_sha256 = expected_sha256.lower()

    is_ims = path.suffix.lower() == ".ims"
    tiff_plan: _TiffLoadPlan | None = None
    if is_ims:
        if not is_hdf5_file(path):
            raise UnsupportedImageError(
                "This .ims file is not a modern HDF5-backed Imaris 5.5+ dataset. "
                "Older IMS variants are not supported yet."
            )
    else:
        try:
            tiff_plan = _preflight_decode(path)
        except (UnidentifiedImageError, tifffile.TiffFileError) as exc:
            raise UnsupportedImageError(f"Loci could not decode '{path.name}'.") from exc

    fingerprint_before = _fingerprint(path)
    if expected_sha256 is not None and not hmac.compare_digest(fingerprint_before, expected_sha256):
        raise SourceChangedError(
            "The source file changed after it was imported. Re-import it before analysis."
        )

    page_count = 1
    volume = None
    try:
        if is_ims:
            array, volume = load_ims_overview(path)
            image_format = "IMS"
        elif path.suffix.lower() in {".tif", ".tiff"}:
            with tifffile.TiffFile(path) as tif:
                page_count = len(tif.pages)
                tiff_plan = _select_tiff_load_plan(tif)
                if tiff_plan.selected_level == 0:
                    page = tif.pages[0]
                else:
                    page = tif.series[0].levels[tiff_plan.selected_level].pages[0]
                array = _decode_tiff_page(page)
            image_format = "TIFF"
        else:
            with path.open("rb") as stream:
                is_png_content = _stream_has_png_signature(stream)
                if is_png_content:
                    # Guard the exact descriptor before Pillow parses ancillary
                    # chunks. OpenCV repeats the guard on its own exact descriptor.
                    decode_shape, decode_dtype = _png_decode_layout_from_stream(stream, path)
                    _validate_decode_budget(decode_shape, decode_dtype)
                    stream.seek(0)
                    with Image.open(stream) as image:
                        image_format = image.format or "PNG"
                        _validate_still_frame_count(image, image_format)
                        orientation = int(image.getexif().get(274, 1))
                else:
                    with Image.open(stream) as image:
                        image_format = image.format or path.suffix.lstrip(".").upper()
                        decode_shape, decode_dtype = _pillow_decode_layout(image)
                        _validate_decode_budget(decode_shape, decode_dtype)
                        orientation = int(image.getexif().get(274, 1))
                        array = _decode_pillow_still(image, image_format)
                        array = _apply_exif_orientation(array, orientation)
            if is_png_content:
                array = _decode_png(path)
                array = _apply_exif_orientation(array, orientation)
    except UnsupportedImarisError as exc:
        raise UnsupportedImageError(str(exc)) from exc
    except (UnidentifiedImageError, tifffile.TiffFileError) as exc:
        raise UnsupportedImageError(f"Loci could not decode '{path.name}'.") from exc

    fingerprint_after = _fingerprint(path)
    if not hmac.compare_digest(fingerprint_before, fingerprint_after):
        raise SourceChangedError(
            "The source file changed while Loci was reading it. Wait for the file copy to "
            "finish, then re-import it."
        )

    array = _coerce_still(array)
    _validate_decode_budget(tuple(int(value) for value in array.shape), array.dtype)
    height, width = array.shape[:2]
    channels = 1 if array.ndim == 2 else int(array.shape[-1])
    native_dtype = str(array.dtype)
    if volume is not None:
        native_dtypes = set(volume.channel_dtypes)
        native_dtype = next(iter(native_dtypes)) if len(native_dtypes) == 1 else "mixed"
    elif tiff_plan is not None:
        native_dtype = tiff_plan.dtype
    tiff_overview = tiff_plan is not None and tiff_plan.access_mode == "overview"
    tiff_view_only_reason = None
    if tiff_overview:
        tiff_view_only_reason = (
            "This pyramidal TIFF exceeds Loci's full-resolution eager-decode guard and is "
            f"opened from existing level {tiff_plan.selected_level + 1} of "
            f"{tiff_plan.resolution_levels} "
            f"({tiff_plan.selected_width:,} × {tiff_plan.selected_height:,} px from "
            f"{tiff_plan.full_width:,} × {tiff_plan.full_height:,} px). Segmentation, "
            "corrections, training, and rendered export remain disabled until native tiled "
            "access is available."
        )
    metadata = SourceMetadata(
        path=str(path),
        name=path.name,
        width=(
            volume.width
            if volume is not None
            else tiff_plan.full_width
            if tiff_overview
            else int(width)
        ),
        height=(
            volume.height
            if volume is not None
            else tiff_plan.full_height
            if tiff_overview
            else int(height)
        ),
        channels=(
            volume.channels
            if volume is not None
            else tiff_plan.channels
            if tiff_overview
            else channels
        ),
        dtype=native_dtype,
        format=image_format,
        page_count=page_count,
        sha256=fingerprint_after,
        color_model=(
            "intensity"
            if volume is not None and volume.composite_mode == "single-channel"
            else "channel-composite"
            if volume is not None
            else "interleaved-rgb"
            if channels in {3, 4}
            else "intensity"
        ),
        access_mode="overview" if volume is not None or tiff_overview else "full",
        view_only_reason=(
            "Modern IMS is currently opened as one bounded central-Z pyramid overview. "
            "For multiple channels, Loci generates an overview composite using valid "
            "declared base colours and stored histogram ranges when present, otherwise "
            "explicitly recorded bounded fallbacks; it does not recreate the saved Imaris "
            "display state. "
            "Native planes, 3D navigation, analysis, and rendered export are not enabled yet."
            if volume is not None
            else tiff_view_only_reason
        ),
        source_details=(
            volume.to_dict()
            if volume is not None
            else tiff_plan.source_details()
            if tiff_overview
            else None
        ),
    )
    return array, metadata
