"""Bounded rectangular C/Z/T selections from the explicitly provisioned reader."""

from __future__ import annotations

import hashlib
import math
import tempfile
import time
from itertools import product
from pathlib import Path
from typing import Any

import numpy as np
import tifffile

from .native_image import (
    MAX_NATIVE_READ_BUDGET_BYTES,
    NativeImageError,
    NativeImageSession,
    NativeSelection,
)
from .vendor_acquisition import Acquisition, verify_acquisition
from .vendor_conversion import (
    VENDOR_READERS,
    VendorConversionError,
    VendorConversionRequest,
    _calibration_snapshot,
    _expected_calibration,
    _java_prefix,
    _run_bounded,
    _Runtime,
)

# Fixed application source. Java source-file mode uses the selected local JDK.
# Keep this literal in the engine module so the frozen worker carries the same adapter.
_READER = """
import java.io.*;
import java.nio.file.*;
import loci.formats.FormatTools;
import loci.formats.ImageReader;

class LociScalarBox {
    public static void main(String[] args) throws Exception {
        String source = args[0];
        int series = Integer.parseInt(args[1]);
        int firstC = Integer.parseInt(args[2]);
        int stopC = Integer.parseInt(args[3]);
        int firstZ = Integer.parseInt(args[4]);
        int stopZ = Integer.parseInt(args[5]);
        int firstT = Integer.parseInt(args[6]);
        int stopT = Integer.parseInt(args[7]);
        int x = Integer.parseInt(args[8]);
        int y = Integer.parseInt(args[9]);
        int width = Integer.parseInt(args[10]);
        int height = Integer.parseInt(args[11]);
        ImageReader reader = new ImageReader();
        try {
            reader.setGroupFiles(false);
            reader.setOriginalMetadataPopulated(false);
            reader.setId(source);
            if (!reader.getReader().getClass().getName().equals(args[15]))
                throw new IOException("Unexpected vendor reader.");
            reader.setSeries(series);
            for (String file : reader.getUsedFiles()) {
                if (!Files.isSameFile(Path.of(source), Path.of(file)))
                    throw new IOException("Companion files are unsupported.");
            }
            String grid = reader.getSizeX() + "," + reader.getSizeY() + ","
                + reader.getEffectiveSizeC() + "," + reader.getSizeZ() + "," + reader.getSizeT();
            String type = FormatTools.getPixelTypeString(reader.getPixelType());
            if (!grid.equals(args[12]) || !type.equals(args[13])
                    || reader.getRGBChannelCount() != 1
                    || !reader.getDimensionOrder().equals(args[14]))
                throw new IOException("Reader grid differs from inspected scalar series.");
            int planeBytes = Math.multiplyExact(Math.multiplyExact(width, height),
                FormatTools.getBytesPerPixel(reader.getPixelType()));
            byte[] buffer = new byte[planeBytes];
            try (OutputStream out = Files.newOutputStream(Path.of("planes.raw"),
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                for (int t = firstT; t < stopT; t++)
                    for (int c = firstC; c < stopC; c++)
                        for (int z = firstZ; z < stopZ; z++) {
                            byte[] data = reader.openBytes(reader.getIndex(z, c, t),
                                buffer, x, y, width, height);
                            if (data.length != planeBytes)
                                throw new IOException("Truncated plane.");
                            out.write(data);
                        }
            }
            System.out.println("LOCI_BYTE_ORDER=" + (reader.isLittleEndian() ? "LE" : "BE"));
        } finally {
            reader.close();
        }
    }
}
"""


def _read_box(runtime, request, series, crop, scratch, expected_bytes):
    end = request.end_exclusive
    reader = scratch / "LociScalarBox.java"
    reader.write_text(_READER, encoding="ascii")
    raw = scratch / "planes.raw"
    dims = series["dimensions"]
    bounds = (request.c, end.c, request.z, end.z, request.t, end.t, *crop)
    dtype = np.dtype(series["dtype"])
    command = _java_prefix(runtime.java, runtime.jar, request.heap_mib, scratch) + [
        str(reader),
        str(runtime.source),
        str(request.series),
        *map(str, bounds),
        ",".join(str(dims[a]) for a in "xyczt"),
        {"float32": "float", "float64": "double"}.get(dtype.name, dtype.name),
        series["dimension_order"],
        VENDOR_READERS[runtime.source.suffix.lower()],
    ]
    result = _run_bounded(
        command,
        cwd=scratch,
        timeout_seconds=request.timeout_seconds,
        watched_output=raw,
        max_output_bytes=expected_bytes,
    )
    if result.returncode:
        if b"UnsatisfiedLinkError" in result.stderr and b"ome.jxrlib.JXRJNI" in result.stderr:
            raise VendorConversionError(
                "The selected Java runtime cannot decode JPEG-XR with this reader."
            )
        if b"Unexpected vendor reader." in result.stderr:
            raise VendorConversionError(
                "The detected reader differs from the selected vendor format."
            )
        raise VendorConversionError(
            "Bio-Formats could not read this scalar selection. Range conversion requires "
            "a source-file-capable JDK (11 or newer) and a standalone vendor series."
        )
    markers = [line for line in result.stdout.splitlines() if line.startswith(b"LOCI_BYTE_ORDER=")]
    if markers not in ([b"LOCI_BYTE_ORDER=LE"], [b"LOCI_BYTE_ORDER=BE"]) or (
        not raw.is_file() or raw.stat().st_size != expected_bytes
    ):
        raise VendorConversionError("The reader returned an incomplete scalar stack.")
    return raw, dtype.newbyteorder("<" if markers == [b"LOCI_BYTE_ORDER=LE"] else ">")


def convert_stack(
    runtime: _Runtime,
    request: VendorConversionRequest,
    series: dict[str, Any],
    crop: tuple[int, int, int, int],
    shape: list[int],
    stage: Path,
    output: Path,
    acquisition: Acquisition,
):
    end = request.end_exclusive
    assert end is not None
    declared = series["declared_channel_names"][request.c : end.c]
    names = [name or f"Channel {i + 1}" for i, name in enumerate(declared)]
    metadata = {"axes": "TCZYX", "Channel": [{"Name": name} if name else {} for name in declared]}
    metadata.update(acquisition.writer_metadata(shape))
    for axis, item in (series["calibration"] or {}).items():
        metadata["PhysicalSize" + axis.upper()] = item["value"]
        metadata["PhysicalSize" + axis.upper() + "Unit"] = item["unit"]
    expected_calibration = _expected_calibration(series)
    deadline = time.monotonic() + request.timeout_seconds
    total_bytes = math.prod(shape) * np.dtype(series["dtype"]).itemsize
    with tempfile.TemporaryDirectory(dir=stage) as scratch:
        raw, dtype = _read_box(runtime, request, series, crop, Path(scratch), total_bytes)
        source = np.memmap(raw, dtype=dtype, mode="r", shape=tuple(shape))
        try:
            # Contiguous, uncompressed storage allows native memory-mapped region reads.
            tifffile.imwrite(
                output,
                source,
                ome=True,
                metadata=metadata,
                photometric="minisblack",
                byteorder=dtype.byteorder if dtype.itemsize > 1 else "<",
            )
            if output.stat().st_size > request.max_output_bytes:
                raise VendorConversionError(
                    "The converted artifact exceeded its output-size limit."
                )
            return _verify_stack(
                output, source, shape, names, expected_calibration, deadline, acquisition
            )
        except VendorConversionError:
            raise
        except (OSError, ValueError, NativeImageError) as exc:
            raise VendorConversionError(
                "Could not write or reopen the bounded OME-TIFF stack."
            ) from exc
        finally:
            del source


def _verify_stack(output, source, shape, names, expected_calibration, deadline, acquisition):
    pixel_digest = hashlib.sha256()
    minimum, maximum = math.inf, -math.inf
    with NativeImageSession(output) as session:
        meta = session.metadata
        observed = [getattr(meta.dimensions, axis) for axis in "tczyx"]
        if (
            observed != shape
            or meta.dimensions.s != 1
            or (
                list(meta.channel_names) != names or set(meta.channel_dtypes) != {source.dtype.name}
            )
        ):
            raise VendorConversionError("Reopened scalar grid, channels or dtype changed.")
        calibration = _calibration_snapshot(meta)
        if calibration != expected_calibration:
            raise VendorConversionError("Reopened spatial calibration differs from inspection.")
        acquisition_proof = verify_acquisition(output, meta, acquisition)
        little = source.dtype.newbyteorder("<")
        for t, c, z in product(range(shape[0]), range(shape[1]), range(shape[2])):
            rows = max(1, (4 << 20) // (shape[4] * little.itemsize))
            for y in range(0, shape[3], rows):
                if time.monotonic() > deadline:
                    raise VendorConversionError("Verification exceeded the conversion time limit.")
                height = min(rows, shape[3] - y)
                try:
                    decoded = session.read_region(
                        NativeSelection(
                            0,
                            y,
                            shape[4],
                            height,
                            t=t,
                            c=c,
                            z=z,
                            budget_bytes=MAX_NATIVE_READ_BUDGET_BYTES,
                        )
                    ).pixels
                except NativeImageError as exc:
                    raise VendorConversionError(
                        "Reopened pixels failed native finite-value or layout checks."
                    ) from exc
                block = decoded.astype(little, copy=False)
                original = source[t, c, z, y : y + height].astype(little, copy=False)
                if not np.array_equal(block.view("u1"), original.view("u1")):
                    raise VendorConversionError("Reopened plane differs from Bio-Formats bytes.")
                pixel_digest.update(np.ascontiguousarray(block))
                minimum = min(minimum, float(decoded.min()))
                maximum = max(maximum, float(decoded.max()))
        digest = session.verify_strict().sha256
    return (
        digest,
        pixel_digest.hexdigest(),
        calibration,
        {
            "minimum": minimum,
            "maximum": maximum,
            "all_finite": True,
            "planes_verified": math.prod(shape[:3]),
            "pixel_check": "exact Bio-Formats openBytes, TCZYX little-endian",
        },
        acquisition_proof,
    )
