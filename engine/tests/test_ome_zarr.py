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


def test_plane_reader_and_iter_verified_planes_bind_inventory_at_boundaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, arrays = _store(
        tmp_path,
        compressor=Blosc(cname="lz4", clevel=1),
        shapes=((2, 3, 4, 11, 13), (2, 3, 4, 6, 7)),
        separator="/",
    )
    requests = [
        OMEZarrPlaneRequest(level=0, t=t, c=c, z=z, x=2, y=1, width=9, height=8)
        for t in range(2)
        for c in range(3)
        for z in range(4)
    ]
    inventory_calls = 0
    open_calls = 0
    original_inventory = ome_zarr_module._inventory
    original_open = ome_zarr_module._open_verified_file

    def counted_inventory(*args: Any, **kwargs: Any):
        nonlocal inventory_calls
        inventory_calls += 1
        return original_inventory(*args, **kwargs)

    def counted_open(*args: Any, **kwargs: Any):
        nonlocal open_calls
        open_calls += 1
        return original_open(*args, **kwargs)

    with OMEZarrSession(root) as session:
        monkeypatch.setattr(ome_zarr_module, "_inventory", counted_inventory)
        monkeypatch.setattr(ome_zarr_module, "_open_verified_file", counted_open)

        with session.plane_reader() as read_plane:
            batch_planes = [read_plane(req) for req in requests]
        assert inventory_calls == 2
        assert open_calls > 0
        expected_open_calls = open_calls

        inventory_calls = 0
        open_calls = 0
        iter_planes = list(session.iter_verified_planes(requests))
        assert inventory_calls == 2
        assert open_calls == expected_open_calls

        # Individual read_plane retains before-and-after inventory checks on every call.
        inventory_calls = 0
        single_plane = session.read_plane(requests[0])
        assert inventory_calls == 2
        np.testing.assert_array_equal(single_plane.values, batch_planes[0].values)
        assert single_plane.estimated_peak_bytes == batch_planes[0].estimated_peak_bytes
        assert single_plane.pixel_extent_xyxy == batch_planes[0].pixel_extent_xyxy
        assert single_plane.physical_extent_xyxy == batch_planes[0].physical_extent_xyxy
        assert single_plane.integrity_mode == batch_planes[0].integrity_mode

    for req, batch, streamed in zip(requests, batch_planes, iter_planes, strict=True):
        expected = arrays[0][req.t, req.c, req.z, 1:9, 2:11]
        np.testing.assert_array_equal(batch.values, expected)
        np.testing.assert_array_equal(streamed.values, expected)
        assert not batch.values.flags.writeable
        assert not streamed.values.flags.writeable


def test_plane_reader_rejects_stale_closed_handles_budget_and_bounds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, arrays = _store(tmp_path, chunks=(1, 1, 4, 11, 13), dtype="<f8")
    req = OMEZarrPlaneRequest(t=1, c=2, z=3, width=5, height=4)
    with OMEZarrSession(root) as session:
        with session.plane_reader() as read_plane:
            plane = read_plane(req)
            np.testing.assert_array_equal(plane.values, arrays[0][1, 2, 3, :4, :5])
        with pytest.raises(OMEZarrError, match="closed"):
            read_plane(req)

        decoded = 0
        original_decode = session._decode_chunk

        def counted_decode(*args: Any, **kwargs: Any) -> np.ndarray:
            nonlocal decoded
            decoded += 1
            return original_decode(*args, **kwargs)

        monkeypatch.setattr(session, "_decode_chunk", counted_decode)
        with (
            pytest.raises(OMEZarrBudgetError, match="No chunks were decoded"),
            session.plane_reader() as aborted_reader,
        ):
            aborted_reader(
                OMEZarrPlaneRequest(t=1, c=2, z=3, width=13, height=11, budget_bytes=1024)
            )
        assert decoded == 0
        with pytest.raises(OMEZarrError, match="closed"):
            aborted_reader(req)

        with pytest.raises(OMEZarrError, match="outside"), session.plane_reader() as bad_bounds:
            bad_bounds(OMEZarrPlaneRequest(x=12, y=0, width=2, height=1))
        assert decoded == 0


def test_plane_reader_detects_pre_mid_post_mutations_links_and_root_swap(tmp_path: Path) -> None:
    # 1. Mutation before entering fails before yielding or decoding.
    root_pre, _ = _store(tmp_path / "pre")
    with OMEZarrSession(root_pre) as session:
        (root_pre / "added").write_bytes(b"new")
        with pytest.raises(OMEZarrSourceChangedError, match="changed"), session.plane_reader():
            pytest.fail("plane_reader must fail before yielding when store changed")

    # 2. Mid-transaction mutation of an unread chunk fails immediately on verified open,
    # and even if caught and reverted, the transaction refuses to succeed.
    root_mid, _ = _store(tmp_path / "mid")
    with OMEZarrSession(root_mid) as session:
        target_chunk = root_mid / "0" / "1.2.1.0.0"
        original_bytes = target_chunk.read_bytes()
        original_stat = target_chunk.stat()
        with pytest.raises(OMEZarrSourceChangedError), session.plane_reader() as read_plane:
            read_plane(OMEZarrPlaneRequest(t=0, c=0, z=0, width=4, height=4))
            target_chunk.write_bytes(bytes([original_bytes[0] ^ 1]) + original_bytes[1:])
            with pytest.raises(OMEZarrSourceChangedError):
                read_plane(OMEZarrPlaneRequest(t=1, c=2, z=2, width=4, height=4))
            # Even restoring original bytes and mtime must not allow clean completion.
            target_chunk.write_bytes(original_bytes)
            os.utime(target_chunk, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))

    # 3. Extra file, symlink, or hardlink introduced mid-transaction fails on exit.
    root_post, _ = _store(tmp_path / "post")
    with (
        OMEZarrSession(root_post) as session,
        pytest.raises(OMEZarrSourceChangedError, match="changed"),
        session.plane_reader() as read_plane,
    ):
        read_plane(OMEZarrPlaneRequest(t=0, c=0, z=0, width=4, height=4))
        (root_post / "stray").write_bytes(b"extra")

    root_link, _ = _store(tmp_path / "link")
    external = tmp_path / "outside.bin"
    external.write_bytes(b"secret")
    with (
        OMEZarrSession(root_link) as session,
        pytest.raises(OMEZarrUnsupportedError, match="symlinks|linked files"),
        session.plane_reader() as read_plane,
    ):
        read_plane(OMEZarrPlaneRequest(t=0, c=0, z=0, width=4, height=4))
        _file_link(root_link / "injected-link", external)

    root_hardlink, _ = _store(tmp_path / "hardlink")
    chunk = root_hardlink / "0" / "0.0.0.0.0"
    with (
        OMEZarrSession(root_hardlink) as session,
        pytest.raises(OMEZarrSourceChangedError),
        session.plane_reader() as read_plane,
    ):
        os.link(chunk, tmp_path / "external-hardlink")
        read_plane(OMEZarrPlaneRequest(t=0, c=0, z=0, width=4, height=4))

    # 4. Uninitialized chunk materialized mid-transaction fails on exit.
    root_sparse, _ = _store(
        tmp_path / "sparse", names="yx", shapes=((8, 9),), chunks=(4, 5), fill_value=3, write=False
    )
    with (
        OMEZarrSession(root_sparse) as session,
        pytest.raises(OMEZarrSourceChangedError, match="changed"),
        session.plane_reader() as read_plane,
    ):
        plane = read_plane(OMEZarrPlaneRequest(width=4, height=4))
        assert int(plane.values[0, 0]) == 3
        (root_sparse / "0" / "0.0").write_bytes(b"\x00" * 40)

    # 5. iter_verified_planes fails before completion if store mutates mid-stream.
    root_iter, _ = _store(tmp_path / "iter")
    with OMEZarrSession(root_iter) as session:
        stream = session.iter_verified_planes(
            [
                OMEZarrPlaneRequest(t=0, c=0, z=0, width=4, height=4),
                OMEZarrPlaneRequest(t=0, c=0, z=1, width=4, height=4),
            ]
        )
        next(stream)
        (root_iter / "stray").write_bytes(b"x")
        next(stream)
        with pytest.raises(OMEZarrSourceChangedError, match="changed"):
            next(stream)

    # 6. Replacing the store root with a symlink to a moved copy (same child inodes) fails.
    if os.name != "nt":
        root_swap, _ = _store(tmp_path / "swap")
        moved = tmp_path / "swap-moved.ome.zarr"
        with OMEZarrSession(root_swap) as session:
            root_swap.rename(moved)
            root_swap.symlink_to(moved, target_is_directory=True)
            with pytest.raises(OMEZarrSourceChangedError, match="changed"):
                session.read_plane(OMEZarrPlaneRequest(width=2, height=2))
            with (
                pytest.raises(OMEZarrSourceChangedError, match="changed"),
                session.plane_reader(),
            ):
                pytest.fail("root symlink swap must be rejected")
            with pytest.raises(OMEZarrSourceChangedError, match="changed"):
                session.verify_strict()


def test_strict_open_hashes_once_and_explicit_verify_strict_always_rehashes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, _ = _store(tmp_path, compressor=Zlib(level=1))
    manifest_calls = 0
    inventory_calls = 0
    original_manifest = ome_zarr_module._content_manifest
    original_inventory = ome_zarr_module._inventory

    def counted_manifest(*args: Any, **kwargs: Any):
        nonlocal manifest_calls
        manifest_calls += 1
        return original_manifest(*args, **kwargs)

    def counted_inventory(*args: Any, **kwargs: Any):
        nonlocal inventory_calls
        inventory_calls += 1
        return original_inventory(*args, **kwargs)

    monkeypatch.setattr(ome_zarr_module, "_content_manifest", counted_manifest)
    monkeypatch.setattr(ome_zarr_module, "_inventory", counted_inventory)

    with OMEZarrSession(root, strict=True) as first:
        receipt = first.opening_receipt
        assert receipt is not None
        assert first.metadata.strict_content_manifest_sha256 == receipt.content_manifest_sha256
    assert manifest_calls == 1
    assert inventory_calls == 2

    manifest_calls = 0
    inventory_calls = 0
    with OMEZarrSession(
        root, expected_content_manifest_sha256=receipt.content_manifest_sha256
    ) as verified:
        assert verified.opening_receipt == receipt
        assert verified.metadata.strict_content_manifest_sha256 == receipt.content_manifest_sha256
        assert manifest_calls == 1
        assert inventory_calls == 2

        # Explicit verify_strict always performs a fresh full manifest hash from disk.
        fresh = verified.verify_strict()
        assert fresh == receipt
        assert manifest_calls == 2
        assert inventory_calls == 4

    # Tampering bytes with preserved mtime is still detected on explicit verify_strict and reopen.
    chunk = root / "0" / "0.0.0.0.0"
    st = chunk.stat()
    raw = chunk.read_bytes()
    chunk.write_bytes(bytes([raw[0] ^ 1]) + raw[1:])
    os.utime(chunk, ns=(st.st_atime_ns, st.st_mtime_ns))
    with pytest.raises(OMEZarrSourceChangedError, match="expected"):
        OMEZarrSession(root, expected_content_manifest_sha256=receipt.content_manifest_sha256)
    with pytest.raises(OMEZarrError, match="boolean"):
        OMEZarrSession(root, strict="yes")  # type: ignore[arg-type]


def test_parallel_content_manifest_preserves_order_after_out_of_order_reads(
    tmp_path: Path, monkeypatch
) -> None:
    from threading import Event

    root, _ = _store(tmp_path)
    with OMEZarrSession(root, strict=True) as sequential:
        expected = sequential.opening_receipt
    assert expected is not None

    group_hashed = Event()
    hash_file = ome_zarr_module._verified_file_sha256

    def out_of_order(root, relative, entries):
        if relative == ".zattrs" and not group_hashed.wait(timeout=5):
            pytest.fail("the next file in the manifest did not run independently")
        digest = hash_file(root, relative, entries)
        if relative == ".zgroup":
            group_hashed.set()
        return digest

    monkeypatch.setattr(ome_zarr_module, "_MANIFEST_MIN_PARALLEL_ENTRIES", 0)
    monkeypatch.setattr(ome_zarr_module, "_MANIFEST_MIN_PARALLEL_BYTES", 0)
    monkeypatch.setattr(ome_zarr_module, "_MANIFEST_HASH_BATCH_FILES", 1)
    monkeypatch.setattr(ome_zarr_module, "_verified_file_sha256", out_of_order)
    with OMEZarrSession(root, strict=True) as parallel:
        assert parallel.opening_receipt == expected


def test_parallel_content_manifest_still_verifies_inventory_after_hashing(
    tmp_path: Path, monkeypatch
) -> None:
    root, _ = _store(tmp_path)
    hash_file = ome_zarr_module._verified_file_sha256

    def add_file_during_hash(root, relative, entries):
        digest = hash_file(root, relative, entries)
        if relative == ".zgroup":
            (root / "added").write_bytes(b"unexpected entry")
        return digest

    monkeypatch.setattr(ome_zarr_module, "_MANIFEST_MIN_PARALLEL_ENTRIES", 0)
    monkeypatch.setattr(ome_zarr_module, "_MANIFEST_MIN_PARALLEL_BYTES", 0)
    monkeypatch.setattr(ome_zarr_module, "_verified_file_sha256", add_file_during_hash)
    with pytest.raises(OMEZarrSourceChangedError, match="changed after"):
        OMEZarrSession(root, strict=True)


@pytest.mark.parametrize("strict", [False, True])
def test_open_rejects_mutation_after_metadata_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, strict: bool
) -> None:
    root, _ = _store(tmp_path)
    metadata_digest = ome_zarr_module._inventory_digest

    def mutate_after_metadata(entries):
        result = metadata_digest(entries)
        (root / "added-after-metadata").touch()
        return result

    monkeypatch.setattr(ome_zarr_module, "_inventory_digest", mutate_after_metadata)
    with pytest.raises(OMEZarrSourceChangedError, match="changed"):
        OMEZarrSession(root, strict=strict)
