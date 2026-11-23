from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pytest
from test_ome_zarr import _directory_link, _store

from loci_engine import ome_zarr
from loci_engine.viewer_volume import build_volume_payload
from loci_engine.worker import dispatch, handle_request
from loci_engine.zarr_adapter import ZarrAdapter

_METHOD = "research_zarr_opening_overview"


def _pyramid(path: Path):
    return _store(
        path,
        shapes=((1, 2, 4, 200, 208), (1, 2, 4, 100, 104)),
        chunks=(1, 1, 1, 64, 64),
        dtype=">u2",
    )


def test_opening_overview_matches_verified_volume_without_registered_authority(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, arrays = _pyramid(tmp_path)
    session = ZarrAdapter(str(root))
    try:
        proven = build_volume_payload(
            session, source_id="1" * 32, channel_indices=[0], target_long_axis=96
        )["context"]
    finally:
        session.close()

    contents = {path: path.stat().st_mtime_ns for path in root.rglob("*")}
    calls = 0
    inventory = ome_zarr._inventory

    def count_inventory(*args, **kwargs):
        nonlocal calls
        calls += 1
        return inventory(*args, **kwargs)

    def no_verified_authority(*args, **kwargs):
        pytest.fail("opening overview crossed a content verification or study boundary")

    monkeypatch.setattr(ome_zarr, "_inventory", count_inventory)
    monkeypatch.setattr(ome_zarr, "_content_manifest", no_verified_authority)
    monkeypatch.setattr(ZarrAdapter, "__init__", no_verified_authority)
    read_only = [root, *contents] if os.name != "nt" else []
    modes = {path: path.stat().st_mode & 0o777 for path in read_only}
    try:
        for path in read_only:
            path.chmod(0o555 if path.is_dir() else 0o444)
        result = dispatch(_METHOD, {"path": str(root), "opening_id": "selection-42"})
        assert all(path.stat().st_mode & 0o222 == 0 for path in read_only)
    finally:
        for path in read_only:
            path.chmod(modes[path])

    assert {path: path.stat().st_mtime_ns for path in root.rglob("*")} == contents
    assert calls == 2
    assert result["schema_version"] == "loci.volume-opening-preview/v1"
    assert result["opening_id"] == "selection-42"
    assert len(result["source_inventory_sha256"]) == 64
    assert result["source_inventory_sha256"] != proven["source_sha256"]
    encoded = json.dumps(result)
    for secret in (str(root), "source_sha256", "source_id", proven["source_sha256"], '"focus"'):
        assert secret not in encoded

    context = result["context"]
    for key in (
        "level",
        "dimensions_xyz",
        "source_dimensions_xyz",
        "origin_xyz",
        "spacing_xyz",
        "direction_3x3",
        "affine_4x4",
        "scalar_type",
        "source_dtypes",
        "data_base64",
        "data_sha256",
        "components",
        "byte_length",
        "unit",
        "frame",
    ):
        assert context[key] == proven[key]
    assert context["level"] == 1
    assert context["source_dtypes"] == [">u2"]
    assert context["scalar_type"] == "uint16"
    assert context["dimensions_xyz"] == [96, 92, 2]
    raw = base64.b64decode(context["data_base64"], validate=True)
    assert hashlib.sha256(raw).hexdigest() == context["data_sha256"]
    voxels = np.frombuffer(raw, dtype="<u2").reshape((2, 92, 96))
    assert voxels[0, 0, 0] == arrays[1][0, 0, 0, 0, 0]
    assert voxels[-1, -1, -1] == arrays[1][0, 0, -1, -1, -1]


def test_opening_overview_refuses_changed_inventory_after_a_plane(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, _ = _pyramid(tmp_path)
    original = ome_zarr._LocalZarrReader._read_plane

    def add_unexpected_file(self, request, **kwargs):
        plane = original(self, request, **kwargs)
        (root / "unexpected").touch()
        return plane

    monkeypatch.setattr(ome_zarr._LocalZarrReader, "_read_plane", add_unexpected_file)
    with pytest.raises(ValueError, match="store changed during"):
        dispatch(_METHOD, {"path": str(root), "opening_id": "opening"})


@pytest.mark.skipif(os.name == "nt", reason="Requires a directory symlink")
def test_opening_overview_rechecks_root_after_final_walk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, _ = _pyramid(tmp_path / "source")
    moved = tmp_path / "moved.ome.zarr"
    original = ome_zarr._inventory
    walks = 0

    def move_before_last_walk(path):
        nonlocal walks
        walks += 1
        if walks == 2:
            root.rename(moved)
            root.symlink_to(moved, target_is_directory=True)
        return original(path)

    monkeypatch.setattr(ome_zarr, "_inventory", move_before_last_walk)
    with pytest.raises(ValueError, match="store changed during"):
        dispatch(_METHOD, {"path": str(root), "opening_id": "root-swap"})


def test_opening_overview_refuses_links_and_unavailable_sources(tmp_path: Path) -> None:
    root, _ = _pyramid(tmp_path / "pyramid")
    linked_root = tmp_path / "linked.ome.zarr"
    _directory_link(linked_root, root)
    try:
        with pytest.raises(ValueError, match="Opening overview is unavailable"):
            dispatch(_METHOD, {"path": str(linked_root), "opening_id": "link"})
    finally:
        if os.name == "nt":
            linked_root.rmdir()
        else:
            linked_root.unlink()

    first_chunk = next(path for path in (root / "1").iterdir() if not path.name.startswith("."))
    os.link(first_chunk, root / "linked-chunk")
    with pytest.raises(ValueError, match="Opening overview is unavailable"):
        dispatch(_METHOD, {"path": str(root), "opening_id": "link"})

    single, _ = _store(tmp_path / "single")
    reply = handle_request(
        {
            "id": 1,
            "method": _METHOD,
            "params": {
                "path": str(single),
                "opening_id": "single",
            },
        }
    )
    assert "result" not in reply
    assert str(single) not in json.dumps(reply)


@pytest.mark.parametrize(
    "params",
    [
        {"path": "/explicit/store", "opening_id": "token", "project": "/study"},
        {"path": ["file"], "opening_id": "token"},
        {"path": "relative", "opening_id": "token"},
        {"path": "/explicit/store", "opening_id": "not a token"},
    ],
)
def test_opening_overview_validates_trusted_picker_parameters(params: dict) -> None:
    with pytest.raises(ValueError, match="Opening overview"):
        dispatch(_METHOD, params)
