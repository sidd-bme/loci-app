from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import asdict
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import zarr
from numcodecs import Blosc, GZip, Zlib

import loci_engine.ome_zarr as ome_zarr_module
from loci_engine.ome_zarr import (
    OMEZarrBudgetError,
    OMEZarrError,
    OMEZarrPlaneRequest,
    OMEZarrSession,
    OMEZarrSourceChangedError,
    OMEZarrUnsupportedError,
)


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")


def _directory_link(link: Path, target: Path) -> None:
    if os.name == "nt":
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            check=True,
            capture_output=True,
        )
    else:
        link.symlink_to(target, target_is_directory=True)


def _file_link(link: Path, target: Path) -> None:
    if os.name == "nt":
        os.link(target, link)
    else:
        link.symlink_to(target)


def _axes(names: str) -> list[dict[str, str]]:
    output = []
    for name in names:
        axis_type = "time" if name == "t" else "channel" if name == "c" else "space"
        axis = {"name": name, "type": axis_type}
        if name == "t":
            axis["unit"] = "second"
        elif name in "zyx":
            axis["unit"] = "micrometer"
        output.append(axis)
    return output


def _store(
    tmp_path: Path,
    *,
    names: str = "tczyx",
    shapes: tuple[tuple[int, ...], ...] = ((2, 3, 4, 11, 13),),
    chunks: tuple[int, ...] = (1, 1, 2, 5, 6),
    dtype: str = "<u2",
    compressor: object = None,
    separator: str = ".",
    order: str = "C",
    fill_value: object = 0,
    write: bool = True,
    image_group: str = "",
    shared_transforms: list[dict[str, object]] | None = None,
) -> tuple[Path, list[np.ndarray]]:
    root = tmp_path / "image.ome.zarr"
    root.mkdir(parents=True)
    _write_json(root / ".zgroup", {"zarr_format": 2})
    group = root
    if image_group:
        for part in Path(image_group).parts:
            group = group / part
            group.mkdir()
            _write_json(group / ".zgroup", {"zarr_format": 2})
    datasets: list[dict[str, object]] = []
    arrays: list[np.ndarray] = []
    for level, shape in enumerate(shapes):
        scale = [1.0] * len(names)
        scale[names.index("y")] = 0.5 * (2**level)
        scale[names.index("x")] = 0.25 * (2**level)
        if "z" in names:
            scale[names.index("z")] = 2.0
        translation = [0.0] * len(names)
        translation[names.index("y")] = 20.0
        translation[names.index("x")] = 30.0
        datasets.append(
            {
                "path": str(level),
                "coordinateTransformations": [
                    {"type": "scale", "scale": scale},
                    {"type": "translation", "translation": translation},
                ],
            }
        )
        level_chunks = tuple(min(a, b) for a, b in zip(chunks, shape, strict=True))
        array = zarr.open_array(
            str(group / str(level)),
            mode="w",
            shape=shape,
            chunks=level_chunks,
            dtype=dtype,
            compressor=compressor,
            fill_value=fill_value,
            dimension_separator=separator,
            order=order,
            zarr_format=2,
        )
        values = np.arange(math_prod(shape), dtype=np.dtype(dtype)).reshape(shape)
        if write:
            array[:] = values
        arrays.append(values)
    multiscale: dict[str, object] = {
        "version": "0.4",
        "name": "synthetic",
        "axes": _axes(names),
        "datasets": datasets,
    }
    if shared_transforms is not None:
        multiscale["coordinateTransformations"] = shared_transforms
    _write_json(group / ".zattrs", {"multiscales": [multiscale]})
    return root, arrays


def math_prod(values: tuple[int, ...]) -> int:
    result = 1
    for value in values:
        result *= value
    return result


def _zarray(root: Path, relative: str = "0") -> dict[str, Any]:
    return json.loads((root / relative / ".zarray").read_text(encoding="utf-8"))


def test_reads_cross_chunk_tczyx_plane_and_preserves_coordinate_provenance(
    tmp_path: Path,
) -> None:
    root, arrays = _store(
        tmp_path,
        compressor=Blosc(cname="zstd", clevel=5),
        shapes=((2, 3, 4, 11, 13), (2, 3, 4, 6, 7)),
        shared_transforms=[
            {"type": "scale", "scale": [2, 1, 1, 10, 10]},
            {"type": "translation", "translation": [5, 0, 0, 100, 200]},
        ],
    )
    with OMEZarrSession(root) as session:
        metadata = session.metadata
        plane = session.read_plane(
            OMEZarrPlaneRequest(level=0, t=1, c=2, z=3, x=4, y=3, width=7, height=6)
        )

    np.testing.assert_array_equal(plane.values, arrays[0][1, 2, 3, 3:9, 4:11])
    assert plane.values.shape == (6, 7)
    assert not plane.values.flags.writeable
    assert metadata.canonical_axes == "TCZYX"
    assert metadata.levels[0].canonical_shape_tczyx == (2, 3, 4, 11, 13)
    assert metadata.levels[0].canonical_chunks_tczyx == (1, 1, 2, 5, 6)
    # Dataset transforms are applied first; the shared transform then scales
    # Y/X coordinates by ten and adds its translation.
    assert metadata.levels[0].scale_tczyx == (2, 1, 2, 5, 2.5)
    assert metadata.levels[0].translation_tczyx == (5, 0, 0, 300, 500)
    assert metadata.levels[0].micrometres_per_pixel_xy == (2.5, 5)
    assert metadata.levels[0].origin_micrometres_xy == (500, 300)
    assert plane.pixel_extent_xyxy == (4, 3, 11, 9)
    assert plane.physical_extent_xyxy == (510, 315, 527.5, 345)
    assert plane.physical_unit_xy == ("micrometer", "micrometer")
    assert plane.micrometre_extent_xyxy == plane.physical_extent_xyxy
    assert plane.source_session_inventory_sha256 == metadata.session_inventory_sha256
    assert "image.ome.zarr" not in json.dumps(asdict(metadata))


@pytest.mark.parametrize(
    ("compressor", "codec_id"),
    [
        (None, "none"),
        (Blosc(cname="lz4", clevel=1), "blosc"),
        (Zlib(level=3), "zlib"),
        (GZip(level=4), "gzip"),
    ],
)
@pytest.mark.parametrize("separator", [".", "/"])
def test_audited_compressors_and_both_v2_chunk_key_layouts(
    tmp_path: Path, compressor: object, codec_id: str, separator: str
) -> None:
    root, arrays = _store(tmp_path, compressor=compressor, separator=separator)
    with OMEZarrSession(root) as session:
        plane = session.read_plane(OMEZarrPlaneRequest(t=1, c=1, z=2, x=2, y=1, width=8, height=7))
        assert session.metadata.levels[0].codec.id == codec_id
    np.testing.assert_array_equal(plane.values, arrays[0][1, 1, 2, 1:8, 2:10])


def test_fortran_order_chunk_layout(tmp_path: Path) -> None:
    root, arrays = _store(
        tmp_path,
        names="zyx",
        shapes=((3, 8, 9),),
        chunks=(2, 5, 6),
        compressor=Zlib(level=1),
        order="F",
    )
    with OMEZarrSession(root) as session:
        plane = session.read_plane(OMEZarrPlaneRequest(z=2, x=2, y=1, width=6, height=6))
    np.testing.assert_array_equal(plane.values, arrays[0][2, 1:7, 2:8])


@pytest.mark.parametrize(
    ("names", "shape", "chunks", "selection"),
    [
        ("yx", (9, 10), (4, 6), (slice(2, 8), slice(3, 9))),
        ("cyx", (3, 9, 10), (1, 4, 6), (2, slice(2, 8), slice(3, 9))),
        ("tzyx", (2, 4, 9, 10), (1, 2, 4, 6), (1, 3, slice(2, 8), slice(3, 9))),
    ],
)
def test_canonicalizes_supported_axis_subsets(
    tmp_path: Path,
    names: str,
    shape: tuple[int, ...],
    chunks: tuple[int, ...],
    selection: tuple[object, ...],
) -> None:
    root, arrays = _store(tmp_path, names=names, shapes=(shape,), chunks=chunks)
    request = OMEZarrPlaneRequest(
        t=1 if "t" in names else 0,
        c=2 if "c" in names else 0,
        z=3 if "z" in names else 0,
        x=3,
        y=2,
        width=6,
        height=6,
    )
    with OMEZarrSession(root) as session:
        plane = session.read_plane(request)
        canonical_shape = session.metadata.levels[0].canonical_shape_tczyx
    np.testing.assert_array_equal(plane.values, arrays[0][selection])
    assert canonical_shape == tuple(
        shape[names.index(axis)] if axis in names else 1 for axis in "tczyx"
    )


def test_uninitialized_chunk_uses_finite_fill_and_null_fill_fails(tmp_path: Path) -> None:
    root, _ = _store(
        tmp_path, names="yx", shapes=((8, 9),), chunks=(4, 5), fill_value=7, write=False
    )
    with OMEZarrSession(root) as session:
        plane = session.read_plane(OMEZarrPlaneRequest(x=1, y=1, width=7, height=6))
    np.testing.assert_array_equal(plane.values, np.full((6, 7), 7, dtype=np.uint16))

    metadata = _zarray(root)
    metadata["fill_value"] = None
    _write_json(root / "0" / ".zarray", metadata)
    with (
        OMEZarrSession(root) as session,
        pytest.raises(OMEZarrUnsupportedError, match="uninitialized"),
    ):
        session.read_plane(OMEZarrPlaneRequest(width=2, height=2))


def test_memory_and_bounds_are_rejected_before_chunk_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, _ = _store(
        tmp_path,
        chunks=(1, 1, 4, 11, 13),
        dtype="<f8",
    )
    with OMEZarrSession(root) as session:
        decoded = 0
        original = session._decode_chunk

        def count(*args: object, **kwargs: object) -> np.ndarray:
            nonlocal decoded
            decoded += 1
            return original(*args, **kwargs)

        monkeypatch.setattr(session, "_decode_chunk", count)
        with pytest.raises(OMEZarrBudgetError, match="No chunks were decoded") as error:
            session.read_plane(
                OMEZarrPlaneRequest(t=1, c=2, z=3, width=13, height=11, budget_bytes=1024)
            )
        assert error.value.required_bytes > 1024
        with pytest.raises(OMEZarrError, match="outside"):
            session.read_plane(OMEZarrPlaneRequest(x=12, y=0, width=2, height=1))
        assert decoded == 0


def test_inventory_rejects_symlinks_and_detects_add_replace_and_request_mismatch(
    tmp_path: Path,
) -> None:
    root, _ = _store(tmp_path)
    linked = tmp_path / "linked.ome.zarr"
    _directory_link(linked, root)
    try:
        with pytest.raises(OMEZarrError, match="non-symlink|resolve to itself"):
            OMEZarrSession(linked)
    finally:
        if os.name == "nt":
            linked.rmdir()
        else:
            linked.unlink()

    external = tmp_path / "external"
    external.write_bytes(b"x")
    _file_link(root / "external-link", external)
    with pytest.raises(OMEZarrUnsupportedError, match="symlinks|linked files"):
        OMEZarrSession(root)
    (root / "external-link").unlink()

    with OMEZarrSession(root) as session:
        digest = session.metadata.session_inventory_sha256
        with pytest.raises(OMEZarrSourceChangedError, match="different"):
            session.read_plane(
                OMEZarrPlaneRequest(
                    width=1,
                    height=1,
                    expected_session_inventory_sha256="0" * 64,
                )
            )
        (root / "added").write_bytes(b"new")
        with pytest.raises(OMEZarrSourceChangedError, match="changed"):
            session.read_plane(
                OMEZarrPlaneRequest(width=1, height=1, expected_session_inventory_sha256=digest)
            )


def test_strict_manifest_is_content_stable_and_expected_hash_is_enforced(tmp_path: Path) -> None:
    root, _ = _store(tmp_path, compressor=Zlib(level=1))
    with OMEZarrSession(root) as session:
        first = session.verify_strict()
        second = session.verify_strict()
        assert session.metadata.strict_content_manifest_sha256 == first.content_manifest_sha256
    assert first == second
    assert first.file_count > 3
    with OMEZarrSession(
        root, expected_content_manifest_sha256=first.content_manifest_sha256
    ) as verified:
        assert verified.metadata.strict_content_manifest_sha256 == first.content_manifest_sha256
    with pytest.raises(OMEZarrSourceChangedError, match="expected"):
        OMEZarrSession(root, expected_content_manifest_sha256="0" * 64)


@pytest.mark.skipif(os.name != "nt", reason="NTFS ctime behavior")
def test_windows_identity_ignores_unstable_ctime_but_hash_still_detects_tampering(
    tmp_path: Path,
) -> None:
    root, _ = _store(tmp_path, compressor=Zlib(level=1))
    with OMEZarrSession(root) as initial:
        expected = initial.verify_strict().content_manifest_sha256
    chunk = next(path for path in (root / "0").iterdir() if not path.name.startswith("."))
    status = chunk.stat()
    identity = ome_zarr_module._entry_identity(status, "file")
    assert identity.ctime_ns == 0
    payload = bytearray(chunk.read_bytes())
    payload[-1] ^= 1
    chunk.write_bytes(payload)
    os.utime(chunk, ns=(status.st_atime_ns, status.st_mtime_ns))
    with pytest.raises(OMEZarrSourceChangedError, match="expected"):
        OMEZarrSession(root, expected_content_manifest_sha256=expected)


@pytest.mark.skipif(os.name != "nt", reason="Windows binary descriptor behavior")
def test_windows_lstat_identity_and_binary_helpers_are_byte_exact(tmp_path: Path) -> None:
    root, _ = _store(tmp_path / "store")
    entries = ome_zarr_module._inventory(root)
    chunk = next(path for path in (root / "0").iterdir() if not path.name.startswith("."))
    for path in (root / ".zattrs", chunk):
        relative = path.relative_to(root).as_posix()
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0))
        try:
            opened = ome_zarr_module._entry_identity(os.fstat(descriptor), "file")
        finally:
            os.close(descriptor)
        assert ome_zarr_module._entry_identity(path.lstat(), "file") == opened
        assert entries[relative] == opened

    payload_path = root / "binary-control-bytes"
    payload = b"line-1\r\nline-2\x1aafter-control-z\r\n"
    payload_path.write_bytes(payload)
    entries = ome_zarr_module._inventory(root)
    assert ome_zarr_module._open_verified_file(
        root, payload_path.name, entries, maximum=len(payload)
    ) == payload
    assert ome_zarr_module._verified_file_sha256(root, payload_path.name, entries) == (
        hashlib.sha256(payload).hexdigest()
    )


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda metadata: metadata.update(compressor={"id": "pickle"}), "compressor"),
        (lambda metadata: metadata.update(filters=[{"id": "delta"}]), "filters"),
        (lambda metadata: metadata.update(dtype="|O8"), "dtypes"),
        (lambda metadata: metadata.update(zarr_format=3), "Zarr storage format 2"),
        (lambda metadata: metadata.update(dimension_separator="-"), "dimension_separator"),
    ],
)
def test_codec_dtype_and_zarr_version_preflight_rejects_unsupported_metadata(
    tmp_path: Path, mutation: object, message: str
) -> None:
    root, _ = _store(tmp_path)
    metadata = _zarray(root)
    mutation(metadata)  # type: ignore[operator]
    _write_json(root / "0" / ".zarray", metadata)
    with pytest.raises(OMEZarrError, match=message):
        OMEZarrSession(root)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda attrs: attrs["multiscales"][0].update(version="0.5"), "version 0.4"),
        (
            lambda attrs: attrs["multiscales"][0].update(
                axes=[{"name": "row", "type": "space"}, {"name": "x", "type": "space"}]
            ),
            "explicitly named",
        ),
        (
            lambda attrs: attrs["multiscales"][0]["datasets"][0].update(
                coordinateTransformations=[{"type": "translation", "translation": [0] * 5}]
            ),
            "scale",
        ),
        (
            lambda attrs: attrs["multiscales"][0]["datasets"][0].update(path="../outside"),
            "contained relative",
        ),
    ],
)
def test_ngff_version_axes_transforms_and_paths_fail_closed(
    tmp_path: Path, change: object, message: str
) -> None:
    root, _ = _store(tmp_path)
    attrs = json.loads((root / ".zattrs").read_text(encoding="utf-8"))
    change(attrs)  # type: ignore[operator]
    _write_json(root / ".zattrs", attrs)
    with pytest.raises(OMEZarrError, match=message):
        OMEZarrSession(root)


def test_collection_requires_explicit_image_group_and_nested_group_reads(tmp_path: Path) -> None:
    root, arrays = _store(tmp_path, image_group="0")
    _write_json(root / ".zattrs", {"bioformats2raw.layout": 3})
    with pytest.raises(OMEZarrUnsupportedError, match="select one image_group"):
        OMEZarrSession(root)
    with OMEZarrSession(root, image_group="0") as session:
        plane = session.read_plane(OMEZarrPlaneRequest(t=1, c=2, z=3, x=1, y=2, width=4, height=3))
    np.testing.assert_array_equal(plane.values, arrays[0][1, 2, 3, 2:5, 1:5])


def test_multiple_multiscales_require_selection(tmp_path: Path) -> None:
    root, _ = _store(tmp_path)
    attrs = json.loads((root / ".zattrs").read_text(encoding="utf-8"))
    attrs["multiscales"].append(attrs["multiscales"][0])
    _write_json(root / ".zattrs", attrs)
    with pytest.raises(OMEZarrUnsupportedError, match="multiple multiscales"):
        OMEZarrSession(root)
    with OMEZarrSession(root, multiscale_index=1) as session:
        assert len(session.metadata.levels) == 1


def test_nonfinite_requested_values_and_corrupt_chunks_are_rejected(tmp_path: Path) -> None:
    root, _ = _store(
        tmp_path,
        names="yx",
        shapes=((4, 4),),
        chunks=(4, 4),
        dtype="<f4",
        compressor=Zlib(level=1),
    )
    array = zarr.open_array(str(root / "0"), mode="r+", zarr_format=2)
    array[1, 1] = np.nan
    with OMEZarrSession(root) as session, pytest.raises(OMEZarrError, match="non-finite"):
        session.read_plane(OMEZarrPlaneRequest(width=4, height=4))

    chunk = root / "0" / "0.0"
    chunk.write_bytes(b"not-zlib")
    with OMEZarrSession(root) as session, pytest.raises(OMEZarrError, match="decoded safely"):
        session.read_plane(OMEZarrPlaneRequest(width=4, height=4))


def test_zlib_expansion_beyond_declared_chunk_is_rejected(tmp_path: Path) -> None:
    root, _ = _store(
        tmp_path,
        names="yx",
        shapes=((4, 4),),
        chunks=(4, 4),
        dtype="<u2",
        compressor=Zlib(level=9),
    )
    (root / "0" / "0.0").write_bytes(Zlib(level=9).encode(b"x" * (1024 * 1024)))
    with OMEZarrSession(root) as session, pytest.raises(OMEZarrError, match="decoded safely"):
        session.read_plane(OMEZarrPlaneRequest(width=4, height=4))


def test_depth_entry_metadata_and_decoded_chunk_limits_are_enforced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, _ = _store(tmp_path)
    monkeypatch.setattr(ome_zarr_module, "MAX_STORE_DEPTH", 1)
    with pytest.raises(OMEZarrError, match="directory depth"):
        OMEZarrSession(root)

    monkeypatch.setattr(ome_zarr_module, "MAX_STORE_DEPTH", 32)
    monkeypatch.setattr(ome_zarr_module, "MAX_STORE_ENTRIES", 2)
    with pytest.raises(OMEZarrUnsupportedError, match="entry count"):
        OMEZarrSession(root)

    monkeypatch.setattr(ome_zarr_module, "MAX_STORE_ENTRIES", 250_000)
    monkeypatch.setattr(ome_zarr_module, "MAX_METADATA_BYTES", 8)
    with pytest.raises(OMEZarrUnsupportedError, match="size limit"):
        OMEZarrSession(root)

    monkeypatch.setattr(ome_zarr_module, "MAX_METADATA_BYTES", 1024 * 1024)
    monkeypatch.setattr(ome_zarr_module, "MAX_DECODED_CHUNK_BYTES", 1)
    with pytest.raises(OMEZarrUnsupportedError, match="decoded-chunk limit"):
        OMEZarrSession(root)


@pytest.mark.parametrize(
    ("relative", "text", "message"),
    [
        (".zgroup", '{"zarr_format":2,"zarr_format":2}', "duplicate JSON key"),
        (".zattrs", '{"multiscales":NaN}', "non-standard constant"),
    ],
)
def test_json_duplicates_and_non_standard_constants_are_rejected(
    tmp_path: Path, relative: str, text: str, message: str
) -> None:
    root, _ = _store(tmp_path)
    (root / relative).write_text(text, encoding="utf-8")
    with pytest.raises(OMEZarrError, match=message):
        OMEZarrSession(root)


def test_content_manifest_algorithm_is_relative_and_content_bound(tmp_path: Path) -> None:
    first_root, _ = _store(tmp_path / "first")
    second_root, _ = _store(tmp_path / "second")
    with OMEZarrSession(first_root) as first, OMEZarrSession(second_root) as second:
        assert first.metadata.session_inventory_sha256 != second.metadata.session_inventory_sha256
        assert (
            first.verify_strict().content_manifest_sha256
            == second.verify_strict().content_manifest_sha256
        )
    chunk = second_root / "0" / "0.0.0.0.0"
    original = chunk.read_bytes()
    chunk.write_bytes(bytes([original[0] ^ 1]) + original[1:])
    with OMEZarrSession(second_root) as changed:
        assert (
            changed.verify_strict().content_manifest_sha256
            != first.verify_strict().content_manifest_sha256
        )


def test_independent_ome_zarr_py_v04_writer_fixture() -> None:
    source = Path("/tmp/loci-release-run/ome-zarr/independent-v04-20260907.ome.zarr")
    if not source.is_dir():
        pytest.skip("independently written OME-Zarr 0.4 fixture is not present")
    with OMEZarrSession(
        source,
        expected_content_manifest_sha256=(
            "07f5934993b6f89fe0873e854a3c0e95fab25d81f0d9167b317ce4a24ad085fd"
        ),
    ) as session:
        plane = session.read_plane(
            OMEZarrPlaneRequest(level=0, t=1, c=2, z=3, x=5, y=6, width=17, height=13)
        )
    assert session.metadata.levels[0].canonical_shape_tczyx == (2, 3, 4, 32, 40)
    assert session.metadata.levels[1].canonical_shape_tczyx == (2, 3, 4, 16, 20)
    assert hashlib.sha256(plane.values.tobytes()).hexdigest() == (
        "b9d67b7752bc2271d8bca9e0b66f499f22fc0c109e8c18b17cbdba4cd6747409"
    )
