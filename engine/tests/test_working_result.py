from __future__ import annotations

import hashlib
import io
import json
import stat
import zipfile
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

import numpy as np
import pytest
import tifffile
from PIL import Image, ImageDraw

import loci_engine.cellpose_backend as cellpose_backend
from loci_engine.models import SegmentationSettings, SourceMetadata
from loci_engine.profiles import CELLPOSE_PROFILE_ID
from loci_engine.results import RESULT_CACHE, ResultCache
from loci_engine.segment import SegmentationOutput, rebuild_output_from_labels
from loci_engine.worker import handle_request
from loci_engine.working_result import (
    _runtime_from_record,
    publish_working_result,
    restore_working_result,
)


def _synthetic_cells() -> np.ndarray:
    image = Image.new("L", (420, 300), color=18)
    draw = ImageDraw.Draw(image)
    for bounds in (
        (42, 42, 88, 88),
        (128, 50, 180, 102),
        (240, 38, 296, 94),
        (70, 174, 120, 224),
        (185, 166, 241, 222),
        (316, 182, 366, 232),
    ):
        draw.ellipse(bounds, fill=235)
    return np.asarray(image)


def _segment(source_path: Path) -> dict[str, object]:
    response = handle_request(
        {
            "id": "segment",
            "method": "segment",
            "params": {
                "path": str(source_path),
                "settings": {
                    "image_mode": "fluorescence",
                    "expected_diameter_px": 48,
                    "min_area_px": 250,
                },
            },
        }
    )
    assert "error" not in response
    return response["result"]


def _request(method: str, params: dict[str, object]) -> dict[str, object]:
    response = handle_request({"id": method, "method": method, "params": params})
    assert "error" not in response
    return response["result"]


def _private_directory(path: Path) -> Path:
    path.mkdir(mode=0o700)
    path.chmod(0o700)
    return path


def _publish_corrected_pack(
    tmp_path: Path,
) -> tuple[Path, Path, dict[str, object], str, str]:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    segmented = _segment(source_path)
    result_id = segmented["result_id"]
    _request(
        "delete_instance",
        {"result_id": result_id, "x": 65, "y": 65},
    )
    _request(
        "add_polygon",
        {
            "result_id": result_id,
            "points": [
                {"x": 340, "y": 30},
                {"x": 390, "y": 30},
                {"x": 390, "y": 80},
                {"x": 340, "y": 80},
            ],
        },
    )
    _request("undo_correction", {"result_id": result_id})
    pack_directory = _private_directory(tmp_path / "working")
    receipt = _request(
        "publish_working_result",
        {"result_id": result_id, "directory": str(pack_directory)},
    )
    return (
        source_path,
        pack_directory / receipt["pack"]["basename"],
        receipt,
        result_id,
        segmented["source"]["sha256"],
    )


@pytest.fixture(autouse=True)
def _clear_result_cache() -> None:
    RESULT_CACHE.clear()
    yield
    RESULT_CACHE.clear()


def test_working_result_round_trip_preserves_full_history_and_export_parity(
    tmp_path: Path,
) -> None:
    source_path, pack_path, receipt, original_result_id, source_hash = _publish_corrected_pack(
        tmp_path
    )
    original = RESULT_CACHE.get(original_result_id)
    original_labels = original.output.labels.copy()
    original_provenance = original.provenance_dict()

    export_before = _request(
        "export",
        {
            "result_id": original_result_id,
            "directory": str(tmp_path),
            "basename": "before-recovery",
            "options": {
                "labels_tiff": True,
                "measurements_csv": True,
                "analysis_json": True,
            },
        },
    )
    before_labels = tifffile.imread(export_before["files"]["labels"])
    before_measurements = Path(export_before["files"]["measurements"]).read_bytes()

    RESULT_CACHE.clear()
    restored = _request(
        "restore_working_result",
        {
            "pack_path": str(pack_path),
            "source_path": str(source_path),
            "expected_sha256": source_hash,
        },
    )

    assert restored["result_id"] == original_result_id
    assert restored["cell_count"] == 5
    assert restored["corrections"]["revision"] == 3
    assert restored["corrections"]["can_undo"] is True
    assert restored["corrections"]["can_redo"] is True
    assert restored["preview_data_url"].startswith("data:image/png;base64,")
    assert restored["overlay_data_url"].startswith("data:image/png;base64,")
    assert restored["working_result_pack"]["sha256"] == receipt["pack"]["sha256"]
    recovered = RESULT_CACHE.get(original_result_id)
    assert np.array_equal(recovered.output.labels, original_labels)
    assert recovered.provenance_dict() == original_provenance

    export_after = _request(
        "export",
        {
            "result_id": original_result_id,
            "directory": str(tmp_path),
            "basename": "after-recovery",
            "options": {
                "labels_tiff": True,
                "measurements_csv": True,
                "analysis_json": True,
            },
        },
    )
    assert np.array_equal(tifffile.imread(export_after["files"]["labels"]), before_labels)
    assert Path(export_after["files"]["measurements"]).read_bytes() == before_measurements
    after_analysis = json.loads(Path(export_after["files"]["analysis"]).read_text())
    before_analysis = json.loads(Path(export_before["files"]["analysis"]).read_text())
    after_analysis.pop("export")
    before_analysis.pop("export")
    assert after_analysis == before_analysis

    redone = _request("redo_correction", {"result_id": original_result_id})
    assert redone["cell_count"] == 6
    undone = _request("undo_correction", {"result_id": original_result_id})
    assert undone["cell_count"] == 5
    assert np.array_equal(RESULT_CACHE.get(original_result_id).output.labels, original_labels)


def test_publish_receipt_is_path_free_and_refuses_overwrite(tmp_path: Path) -> None:
    source_path, pack_path, receipt, result_id, _ = _publish_corrected_pack(tmp_path)
    original_bytes = pack_path.read_bytes()
    serialized = json.dumps(receipt)

    assert str(tmp_path) not in serialized
    assert str(source_path) not in serialized
    assert source_path.name not in serialized
    assert receipt["pack"]["media_type"] == "application/vnd.loci.working-result+zip"
    assert receipt["pack"]["size_bytes"] == len(original_bytes)
    assert receipt["pack"]["sha256"] == hashlib.sha256(original_bytes).hexdigest()
    assert {artifact["artifact_id"] for artifact in receipt["artifacts"]} == {
        "current-labels",
        "base-labels",
        "normalized-display",
    }

    duplicate = handle_request(
        {
            "id": "duplicate",
            "method": "publish_working_result",
            "params": {
                "result_id": result_id,
                "directory": str(pack_path.parent),
            },
        }
    )
    assert duplicate["error"]["type"] == "FileExistsError"
    assert pack_path.read_bytes() == original_bytes


def test_publish_rejects_out_of_range_normalized_display_before_writing(tmp_path: Path) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    segmented = _segment(source_path)
    cached = RESULT_CACHE.get(segmented["result_id"])
    invalid_output = replace(
        cached.output,
        normalized=np.full(cached.output.labels.shape, 1.0000001, dtype=np.float32),
    )
    invalid = replace(cached, output=invalid_output)
    pack_directory = _private_directory(tmp_path / "invalid-working")

    with pytest.raises(ValueError, match="finite values from 0 to 1"):
        publish_working_result(invalid, str(pack_directory))

    assert list(pack_directory.iterdir()) == []


def test_rgb_float32_endpoint_round_trips_through_working_result(tmp_path: Path) -> None:
    rng = np.random.default_rng(20260907)
    image = None
    for _ in range(8):
        image = rng.integers(0, 256, size=(73, 91, 3), dtype=np.uint8)
    assert image is not None
    source_path = tmp_path / "rgb-rounding.png"
    Image.fromarray(image).save(source_path)
    segmented = _segment(source_path)
    result_id = segmented["result_id"]
    source_hash = segmented["source"]["sha256"]
    pack_directory = _private_directory(tmp_path / "rounding-working")
    receipt = _request(
        "publish_working_result",
        {"result_id": result_id, "directory": str(pack_directory)},
    )

    RESULT_CACHE.clear()
    restored = _request(
        "restore_working_result",
        {
            "pack_path": str(pack_directory / receipt["pack"]["basename"]),
            "source_path": str(source_path),
            "expected_sha256": source_hash,
        },
    )

    assert restored["result_id"] == result_id
    cached = RESULT_CACHE.get(result_id)
    assert np.all(np.isfinite(cached.output.normalized))
    assert float(cached.output.normalized.min()) >= 0.0
    assert float(cached.output.normalized.max()) <= 1.0


def test_restore_repairs_only_the_legacy_float32_upper_endpoint(tmp_path: Path) -> None:
    source_path, pack_path, _, result_id, source_hash = _publish_corrected_pack(tmp_path)
    with zipfile.ZipFile(pack_path, "r") as source_archive:
        entries = {info.filename: source_archive.read(info) for info in source_archive.infolist()}

    def rewritten_pack(name: str, endpoint: np.float32) -> Path:
        normalized = np.load(io.BytesIO(entries["normalized-display.npy"]), allow_pickle=False)
        normalized[0, 0] = endpoint
        buffer = io.BytesIO()
        np.save(buffer, normalized, allow_pickle=False)
        changed = {**entries, "normalized-display.npy": buffer.getvalue()}
        manifest = json.loads(changed["manifest.json"])
        artifact = manifest["artifacts"]["normalized-display"]
        artifact["size_bytes"] = len(changed["normalized-display.npy"])
        artifact["sha256"] = hashlib.sha256(changed["normalized-display.npy"]).hexdigest()
        changed["manifest.json"] = json.dumps(
            manifest,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        rewritten = pack_path.with_name(name)
        with zipfile.ZipFile(rewritten, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for entry_name, payload in changed.items():
                archive.writestr(entry_name, payload)
        return rewritten

    one_ulp_high = np.nextafter(np.float32(1.0), np.float32(np.inf))
    legacy_pack = rewritten_pack("legacy-endpoint.loci-result", one_ulp_high)
    restored, _, _ = restore_working_result(
        str(legacy_pack),
        str(source_path),
        source_hash,
        cache=ResultCache(),
    )
    assert restored.result_id == result_id
    assert float(restored.output.normalized.max()) <= 1.0

    two_ulps_high = np.nextafter(one_ulp_high, np.float32(np.inf))
    invalid_pack = rewritten_pack("invalid-endpoint.loci-result", two_ulps_high)
    with pytest.raises(ValueError, match="finite values from 0 to 1"):
        restore_working_result(
            str(invalid_pack),
            str(source_path),
            source_hash,
            cache=ResultCache(),
        )


def test_restore_into_fresh_cache_preserves_undo_and_redo_state(tmp_path: Path) -> None:
    source_path, pack_path, receipt, _, source_hash = _publish_corrected_pack(tmp_path)
    fresh_cache = ResultCache()

    restored, evicted, pack = restore_working_result(
        str(pack_path),
        str(source_path),
        source_hash,
        cache=fresh_cache,
    )

    assert evicted == []
    assert pack["sha256"] == receipt["pack"]["sha256"]
    assert restored.correction_revision == 3
    assert len(restored.applied_corrections) == 1
    assert len(restored.redo_corrections) == 1
    redone, _ = fresh_cache.redo_correction(restored.result_id)
    assert redone.output.count == 6
    undone, _ = fresh_cache.undo_correction(restored.result_id)
    assert undone.output.count == 5


def test_archived_profile_validation_cannot_populate_an_executable_cache(tmp_path: Path) -> None:
    source_path, pack_path, _, _, source_hash = _publish_corrected_pack(tmp_path)
    with pytest.raises(ValueError, match="cannot be restored into an executable result cache"):
        restore_working_result(
            str(pack_path),
            str(source_path),
            source_hash,
            cache=ResultCache(),
            require_installed_profile=False,
        )


def test_uncorrected_working_result_restores_without_synthetic_history(tmp_path: Path) -> None:
    source_path = tmp_path / "uncorrected.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    segmented = _segment(source_path)
    pack_directory = _private_directory(tmp_path / "uncorrected-working")
    receipt = _request(
        "publish_working_result",
        {"result_id": segmented["result_id"], "directory": str(pack_directory)},
    )
    pack_path = pack_directory / receipt["pack"]["basename"]
    RESULT_CACHE.clear()

    restored = _request(
        "restore_working_result",
        {
            "pack_path": str(pack_path),
            "source_path": str(source_path),
            "expected_sha256": segmented["source"]["sha256"],
        },
    )

    assert restored["cell_count"] == 6
    assert restored["corrections"]["revision"] == 0
    assert restored["corrections"]["has_manual_edits"] is False
    assert restored["corrections"]["can_undo"] is False
    assert restored["corrections"]["can_redo"] is False
    assert RESULT_CACHE.get(segmented["result_id"]).base_output is None


def test_split_correction_geometry_round_trips_through_pack(tmp_path: Path) -> None:
    source_path = tmp_path / "split.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    segmented = _segment(source_path)
    split = _request(
        "split_instance",
        {
            "result_id": segmented["result_id"],
            "x": 55,
            "y": 65,
            "points": [{"x": 65, "y": 30}, {"x": 65, "y": 100}],
        },
    )
    expected_labels = RESULT_CACHE.get(segmented["result_id"]).output.labels.copy()
    pack_directory = _private_directory(tmp_path / "split-working")
    receipt = _request(
        "publish_working_result",
        {"result_id": segmented["result_id"], "directory": str(pack_directory)},
    )
    RESULT_CACHE.clear()

    restored = _request(
        "restore_working_result",
        {
            "pack_path": str(pack_directory / receipt["pack"]["basename"]),
            "source_path": str(source_path),
            "expected_sha256": segmented["source"]["sha256"],
        },
    )

    assert restored["cell_count"] == split["cell_count"] == 7
    assert np.array_equal(RESULT_CACHE.get(segmented["result_id"]).output.labels, expected_labels)
    undone = _request("undo_correction", {"result_id": segmented["result_id"]})
    assert undone["cell_count"] == 6


def test_mixed_advanced_correction_stacks_replay_after_restore(tmp_path: Path) -> None:
    source_path = tmp_path / "topology.png"
    source_pixels = np.zeros((64, 80), dtype=np.uint8)
    Image.fromarray(source_pixels).save(source_path)
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    labels = np.zeros(source_pixels.shape, dtype=np.int32)
    labels[10:30, 10:30] = 1
    labels[10:30, 30:50] = 2
    labels[40:55, 60:75] = 3
    prototype = SegmentationOutput(
        labels=np.zeros_like(labels),
        normalized=np.zeros(labels.shape, dtype=np.float32),
        count=0,
        confluence_percent=0.0,
        measurements=[],
        resolved_polarity="bright",
        threshold=0.5,
    )
    output = rebuild_output_from_labels(prototype, labels)
    cached, _ = RESULT_CACHE.add(
        source=SourceMetadata(
            path=str(source_path),
            name=source_path.name,
            width=80,
            height=64,
            channels=1,
            dtype="uint8",
            format="PNG",
            page_count=1,
            sha256=source_hash,
        ),
        settings=SegmentationSettings(
            image_mode="fluorescence",
            expected_diameter_px=20,
            min_area_px=4,
        ),
        output=output,
    )
    result_id = cached.result_id
    _request(
        "merge_instances",
        {"result_id": result_id, "x": 15, "y": 15, "other_x": 35, "other_y": 15},
    )
    _request(
        "replace_instance_boundary",
        {
            "result_id": result_id,
            "x": 15,
            "y": 15,
            "points": [
                {"x": 8, "y": 8},
                {"x": 52, "y": 8},
                {"x": 52, "y": 32},
                {"x": 8, "y": 32},
            ],
        },
    )
    _request(
        "split_instance",
        {
            "result_id": result_id,
            "x": 15,
            "y": 15,
            "points": [{"x": 30, "y": 5}, {"x": 30, "y": 35}],
        },
    )
    split_labels = RESULT_CACHE.get(result_id).output.labels.copy()
    split_provenance = RESULT_CACHE.get(result_id).provenance_dict()
    undone = _request("undo_correction", {"result_id": result_id})
    labels_before_publication = RESULT_CACHE.get(result_id).output.labels.copy()
    provenance_before_publication = RESULT_CACHE.get(result_id).provenance_dict()
    assert undone["cell_count"] == 2
    assert undone["corrections"]["can_redo"] is True

    pack_directory = _private_directory(tmp_path / "advanced-working")
    receipt = _request(
        "publish_working_result",
        {"result_id": result_id, "directory": str(pack_directory)},
    )
    RESULT_CACHE.clear()
    restored = _request(
        "restore_working_result",
        {
            "pack_path": str(pack_directory / receipt["pack"]["basename"]),
            "source_path": str(source_path),
            "expected_sha256": source_hash,
        },
    )

    recovered = RESULT_CACHE.get(result_id)
    assert restored["cell_count"] == 2
    assert restored["corrections"]["revision"] == 4
    assert restored["corrections"]["can_redo"] is True
    assert np.array_equal(recovered.output.labels, labels_before_publication)
    assert recovered.provenance_dict() == provenance_before_publication

    redone = _request("redo_correction", {"result_id": result_id})
    assert redone["cell_count"] == 3
    assert np.array_equal(RESULT_CACHE.get(result_id).output.labels, split_labels)
    redone_provenance = RESULT_CACHE.get(result_id).provenance_dict()
    assert redone_provenance["metrics"] == split_provenance["metrics"]
    assert redone_provenance["quality"] == split_provenance["quality"]
    assert redone_provenance["measurements"] == split_provenance["measurements"]


def test_brush_eraser_and_vertex_history_survives_working_pack_restore(tmp_path: Path) -> None:
    source_path = tmp_path / "editor.png"
    source_pixels = np.zeros((72, 96), dtype=np.uint8)
    Image.fromarray(source_pixels).save(source_path)
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    labels = np.zeros(source_pixels.shape, dtype=np.int32)
    labels[18:50, 20:58] = 1
    prototype = SegmentationOutput(
        labels=np.zeros_like(labels),
        normalized=np.zeros(labels.shape, dtype=np.float32),
        count=0,
        confluence_percent=0.0,
        measurements=[],
        resolved_polarity="bright",
        threshold=0.5,
    )
    cached, _ = RESULT_CACHE.add(
        source=SourceMetadata(
            path=str(source_path),
            name=source_path.name,
            width=96,
            height=72,
            channels=1,
            dtype="uint8",
            format="PNG",
            page_count=1,
            sha256=source_hash,
        ),
        settings=SegmentationSettings(
            image_mode="fluorescence",
            expected_diameter_px=20,
            min_area_px=4,
        ),
        output=rebuild_output_from_labels(prototype, labels),
    )
    result_id = cached.result_id
    _request(
        "paint_stroke",
        {
            "result_id": result_id,
            "points": [{"x": 57, "y": 34}, {"x": 65, "y": 34}],
            "radius_px": 2,
        },
    )
    _request(
        "erase_stroke",
        {
            "result_id": result_id,
            "points": [{"x": 38, "y": 14}, {"x": 38, "y": 54}],
            "radius_px": 1,
        },
    )
    boundary = _request(
        "get_instance_boundary",
        {"result_id": result_id, "x": 28, "y": 30},
    )
    vertices = [dict(point) for point in boundary["vertices"]]
    vertices[0]["x"] = min(95.0, float(vertices[0]["x"]) + 1)
    vertices[0]["y"] = min(71.0, float(vertices[0]["y"]) + 1)
    _request(
        "move_boundary_vertex",
        {
            "result_id": result_id,
            "x": 28,
            "y": 30,
            "points": vertices,
        },
    )
    expected_labels = RESULT_CACHE.get(result_id).output.labels.copy()
    expected_provenance = RESULT_CACHE.get(result_id).provenance_dict()
    pack_directory = _private_directory(tmp_path / "editor-working")
    receipt = _request(
        "publish_working_result",
        {"result_id": result_id, "directory": str(pack_directory)},
    )
    RESULT_CACHE.clear()

    restored = _request(
        "restore_working_result",
        {
            "pack_path": str(pack_directory / receipt["pack"]["basename"]),
            "source_path": str(source_path),
            "expected_sha256": source_hash,
        },
    )

    assert restored["corrections"]["revision"] == 3
    assert [operation["type"] for operation in restored["corrections"]["applied_operations"]] == [
        "paint_stroke",
        "erase_stroke",
        "move_boundary_vertex",
    ]
    assert np.array_equal(RESULT_CACHE.get(result_id).output.labels, expected_labels)
    assert RESULT_CACHE.get(result_id).provenance_dict() == expected_provenance


def test_corrupt_artifact_rejects_without_mutating_fresh_cache(tmp_path: Path) -> None:
    source_path, pack_path, _, result_id, source_hash = _publish_corrected_pack(tmp_path)
    corrupt_path = pack_path.with_name("corrupt.loci-result")
    with zipfile.ZipFile(pack_path, "r") as source_archive:
        entries = {info.filename: source_archive.read(info) for info in source_archive.infolist()}
    labels = bytearray(entries["current-labels.npy"])
    labels[-1] ^= 0x01
    entries["current-labels.npy"] = bytes(labels)
    with zipfile.ZipFile(corrupt_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)
    fresh_cache = ResultCache()

    with pytest.raises(ValueError, match="SHA-256 verification"):
        restore_working_result(
            str(corrupt_path),
            str(source_path),
            source_hash,
            cache=fresh_cache,
        )
    with pytest.raises(KeyError, match="Unknown or expired"):
        fresh_cache.get(result_id)


def test_self_consistent_wrong_array_dtype_is_rejected(tmp_path: Path) -> None:
    source_path, pack_path, _, _, source_hash = _publish_corrected_pack(tmp_path)
    wrong_dtype_path = pack_path.with_name("wrong-dtype.loci-result")
    with zipfile.ZipFile(pack_path, "r") as source_archive:
        entries = {info.filename: source_archive.read(info) for info in source_archive.infolist()}
    original_labels = np.load(io.BytesIO(entries["current-labels.npy"]), allow_pickle=False)
    buffer = io.BytesIO()
    np.save(buffer, original_labels.astype(np.float32), allow_pickle=False)
    entries["current-labels.npy"] = buffer.getvalue()
    manifest = json.loads(entries["manifest.json"])
    artifact = manifest["artifacts"]["current-labels"]
    artifact["size_bytes"] = len(entries["current-labels.npy"])
    artifact["sha256"] = hashlib.sha256(entries["current-labels.npy"]).hexdigest()
    entries["manifest.json"] = json.dumps(
        manifest,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    with zipfile.ZipFile(wrong_dtype_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)

    with pytest.raises(ValueError, match="unsupported dtype"):
        restore_working_result(
            str(wrong_dtype_path),
            str(source_path),
            source_hash,
            cache=ResultCache(),
        )


def test_restore_rejects_pack_and_internal_symlinks(tmp_path: Path) -> None:
    source_path, pack_path, _, _, source_hash = _publish_corrected_pack(tmp_path)
    linked_pack = pack_path.with_name("linked.loci-result")
    linked_pack.symlink_to(pack_path)

    with pytest.raises(ValueError, match="regular file, not a link"):
        restore_working_result(
            str(linked_pack),
            str(source_path),
            source_hash,
            cache=ResultCache(),
        )

    internal_link_pack = pack_path.with_name("internal-link.loci-result")
    with zipfile.ZipFile(pack_path, "r") as source_archive:
        entries = {info.filename: source_archive.read(info) for info in source_archive.infolist()}
    with zipfile.ZipFile(internal_link_pack, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries.items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (
                (stat.S_IFLNK | 0o777) << 16
                if name == "current-labels.npy"
                else (stat.S_IFREG | 0o600) << 16
            )
            archive.writestr(info, payload)
    with pytest.raises(ValueError, match="must not be a symbolic link"):
        restore_working_result(
            str(internal_link_pack),
            str(source_path),
            source_hash,
            cache=ResultCache(),
        )


def test_restore_rejects_source_substitution_and_source_symlink(tmp_path: Path) -> None:
    source_path, pack_path, _, _, source_hash = _publish_corrected_pack(tmp_path)
    substituted = tmp_path / "substituted.png"
    changed = _synthetic_cells().copy()
    changed[0, 0] = 255
    Image.fromarray(changed).save(substituted)

    with pytest.raises(ValueError, match="does not match expected_sha256"):
        restore_working_result(
            str(pack_path),
            str(substituted),
            source_hash,
            cache=ResultCache(),
        )

    substituted_hash = hashlib.sha256(substituted.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match="different source fingerprint"):
        restore_working_result(
            str(pack_path),
            str(substituted),
            substituted_hash,
            cache=ResultCache(),
        )

    source_link = tmp_path / "source-link.png"
    source_link.symlink_to(source_path)
    with pytest.raises(ValueError, match="regular file, not a symbolic link"):
        restore_working_result(
            str(pack_path),
            str(source_link),
            source_hash,
            cache=ResultCache(),
        )


@pytest.mark.parametrize("method", ["publish_working_result", "restore_working_result"])
def test_working_result_worker_methods_reject_unknown_parameters(
    tmp_path: Path,
    method: str,
) -> None:
    source_path, pack_path, _, result_id, source_hash = _publish_corrected_pack(tmp_path)
    params: dict[str, object] = (
        {"result_id": result_id, "directory": str(pack_path.parent)}
        if method == "publish_working_result"
        else {
            "pack_path": str(pack_path),
            "source_path": str(source_path),
            "expected_sha256": source_hash,
        }
    )
    response = handle_request(
        {
            "id": "unknown",
            "method": method,
            "params": {**params, "overwrite": True},
        }
    )

    assert response["error"]["type"] == "ValueError"
    assert response["error"]["message"] == f"Unknown {method} parameters: overwrite"


def _cellpose_runtime(
    memory_preflight: dict[str, object],
    *,
    requested_device: str,
    resolved_device: str,
    fallback_reason: str | None,
) -> dict[str, object]:
    spec = cellpose_backend.resolve_cellpose_model_spec(CELLPOSE_PROFILE_ID)
    return {
        "package": {
            "name": "cellpose",
            "version": cellpose_backend.CELLPOSE_PACKAGE_VERSION,
        },
        "model": {"artifact_id": spec.artifact_id, "sha256": spec.sha256},
        "profile_id": CELLPOSE_PROFILE_ID,
        "preprocessing_mode": "huggingface-space-uint8",
        "requested_device": requested_device,
        "resolved_device": resolved_device,
        "fallback_reason": fallback_reason,
        "memory_preflight": memory_preflight,
        "inference_scale": 1.0,
    }


def _cellpose_profile_stub() -> SimpleNamespace:
    spec = cellpose_backend.resolve_cellpose_model_spec(CELLPOSE_PROFILE_ID)
    return SimpleNamespace(
        backend_kind="cellpose",
        version=cellpose_backend.CELLPOSE_PACKAGE_VERSION,
        id=CELLPOSE_PROFILE_ID,
        model=SimpleNamespace(artifact_id=spec.artifact_id, sha256=spec.sha256),
    )


_MEMORY_POLICY = "cellpose-checkpoint-x2-plus-batch-32MiB-plane-64B-reserve-256MiB/v1"


@pytest.mark.parametrize(
    ("requested", "resolved", "fallback", "observations"),
    [
        ("cpu", "cpu", None, []),
        (
            "mps",
            "mps",
            None,
            [
                {
                    "device": "mps",
                    "available_bytes": 900,
                    "recommended_bytes": 1_000,
                    "driver_allocated_bytes": 100,
                    "host_available_bytes": 950,
                    "basis": ("minimum-of-metal-working-set-headroom-and-reclaimable-host-memory"),
                    "available": True,
                }
            ],
        ),
        (
            "cuda",
            "cuda",
            None,
            [
                {
                    "device": "cuda",
                    "available_bytes": 800,
                    "total_bytes": 1_000,
                    "basis": "cuda-mem-get-info",
                    "available": True,
                }
            ],
        ),
        (
            "mps",
            "cpu",
            "MPS is unavailable; Loci used CPU.",
            [{"device": "mps", "available": False}],
        ),
        (
            "auto",
            "cpu",
            "MPS inference failed with RuntimeError; Loci retried on CPU.",
            [
                {
                    "device": "mps",
                    "available_bytes": 900,
                    "recommended_bytes": 1_000,
                    "driver_allocated_bytes": 100,
                    "host_available_bytes": 950,
                    "basis": ("minimum-of-metal-working-set-headroom-and-reclaimable-host-memory"),
                    "available": True,
                }
            ],
        ),
    ],
    ids=("cpu", "mps", "cuda", "unavailable-fallback", "inference-fallback"),
)
def test_cellpose_runtime_accepts_bounded_current_memory_preflight_records(
    requested: str,
    resolved: str,
    fallback: str | None,
    observations: list[dict[str, object]],
) -> None:
    memory_preflight = {
        "required_bytes": 500,
        "observations": observations,
        "reservation": False,
        "estimate_policy": _MEMORY_POLICY,
    }
    runtime = _cellpose_runtime(
        memory_preflight,
        requested_device=requested,
        resolved_device=resolved,
        fallback_reason=fallback,
    )

    assert _runtime_from_record(runtime, profile=_cellpose_profile_stub()) == runtime


def test_legacy_cellpose_runtime_preserves_unrecorded_preflight_omission() -> None:
    runtime = _cellpose_runtime(
        {
            "required_bytes": 500,
            "observations": [],
            "reservation": False,
            "estimate_policy": _MEMORY_POLICY,
        },
        requested_device="cpu",
        resolved_device="cpu",
        fallback_reason=None,
    )
    runtime.pop("memory_preflight")

    restored = _runtime_from_record(runtime, profile=_cellpose_profile_stub())

    assert restored == runtime
    assert "memory_preflight" not in restored


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("required_bytes", True, "required_bytes must be an integer"),
        ("required_bytes", 2**53, "at most"),
        ("reservation", True, "reservation must be false"),
        ("estimate_policy", "unknown", "estimate_policy is unsupported"),
        ("unexpected", 1, "invalid fields"),
        ("observations", [{"device": "cpu", "available": True}], "device is unsupported"),
        ("observations", [], "observations do not match the requested device"),
    ],
)
def test_cellpose_runtime_rejects_malformed_or_inconsistent_memory_preflight(
    field: str,
    value: object,
    message: str,
) -> None:
    memory_preflight: dict[str, object] = {
        "required_bytes": 500,
        "observations": [
            {
                "device": "cuda",
                "available_bytes": 800,
                "total_bytes": 1_000,
                "basis": "cuda-mem-get-info",
                "available": True,
            }
        ],
        "reservation": False,
        "estimate_policy": _MEMORY_POLICY,
    }
    memory_preflight[field] = value
    runtime = _cellpose_runtime(
        memory_preflight,
        requested_device="cuda",
        resolved_device="cuda",
        fallback_reason=None,
    )

    with pytest.raises((TypeError, ValueError), match=message):
        _runtime_from_record(runtime, profile=_cellpose_profile_stub())


def test_cellpose_runtime_rejects_auto_observations_after_a_selected_device() -> None:
    observations = [
        {
            "device": "mps",
            "available_bytes": 900,
            "recommended_bytes": 1_000,
            "driver_allocated_bytes": 100,
            "host_available_bytes": 950,
            "basis": "minimum-of-metal-working-set-headroom-and-reclaimable-host-memory",
            "available": True,
        },
        {
            "device": "cuda",
            "available_bytes": 800,
            "total_bytes": 1_000,
            "basis": "cuda-mem-get-info",
            "available": True,
        },
    ]
    runtime = _cellpose_runtime(
        {
            "required_bytes": 500,
            "observations": observations,
            "reservation": False,
            "estimate_policy": _MEMORY_POLICY,
        },
        requested_device="auto",
        resolved_device="cuda",
        fallback_reason=None,
    )

    with pytest.raises(ValueError, match="continued after selecting"):
        _runtime_from_record(runtime, profile=_cellpose_profile_stub())


class _WorkingResultFakeTorch:
    def __init__(self) -> None:
        self.backends = SimpleNamespace(mps=SimpleNamespace(is_available=lambda: True))
        self.mps = SimpleNamespace(
            recommended_max_memory=lambda: 16 * 1024**3,
            driver_allocated_memory=lambda: 0,
        )
        self.cuda = SimpleNamespace(is_available=lambda: False)

    @staticmethod
    def device(name: str) -> str:
        return name


class _WorkingResultFakeModels:
    class CellposeModel:
        def __init__(self, *, device: str, **_kwargs: object) -> None:
            self.device = device

        def eval(self, image: np.ndarray, **_kwargs: object) -> tuple[np.ndarray, list, list]:
            assert self.device == "mps"
            labels = np.zeros(image.shape[:2], dtype=np.int32)
            labels[4:12, 5:14] = 1
            return labels, [], []

    @staticmethod
    def cache_model_path(_name: str) -> None:
        pytest.fail("Cellpose download fallback must not be called")


def _rewrite_pack_manifest(source: Path, destination: Path, mutate: object) -> Path:
    with zipfile.ZipFile(source, "r") as archive:
        payloads = {name: archive.read(name) for name in archive.namelist()}
    manifest = json.loads(payloads["manifest.json"])
    mutate(manifest)
    payloads["manifest.json"] = json.dumps(
        manifest,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in payloads.items():
            archive.writestr(name, payload)
    return destination


def test_mocked_cellpose_publish_restore_preserves_current_and_legacy_runtime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    content = b"working-result-cellpose-checkpoint"
    original_spec = cellpose_backend.resolve_cellpose_model_spec(CELLPOSE_PROFILE_ID)
    spec = replace(
        original_spec,
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
    )
    specs = dict(cellpose_backend.CELLPOSE_MODEL_SPECS)
    specs[CELLPOSE_PROFILE_ID] = spec
    monkeypatch.setattr(
        cellpose_backend,
        "CELLPOSE_MODEL_SPECS",
        MappingProxyType(specs),
    )
    monkeypatch.setenv(cellpose_backend.MODEL_HOME_ENV, str(tmp_path / "models"))
    model_path = cellpose_backend.managed_model_path(spec)
    model_path.parent.mkdir(parents=True)
    model_path.write_bytes(content)
    monkeypatch.setattr(
        cellpose_backend,
        "_installed_cellpose_version",
        lambda: cellpose_backend.CELLPOSE_PACKAGE_VERSION,
    )
    monkeypatch.setattr(
        cellpose_backend,
        "_import_runtime",
        lambda: (_WorkingResultFakeModels(), _WorkingResultFakeTorch()),
    )
    monkeypatch.setattr(
        "loci_engine.compute_resources.available_host_memory",
        lambda: 16 * 1024**3,
    )
    cellpose_backend.clear_model_cache()
    source_path = tmp_path / "cellpose-source.png"
    Image.fromarray(_synthetic_cells()).save(source_path)

    segmented = _request(
        "segment",
        {
            "path": str(source_path),
            "profile_id": CELLPOSE_PROFILE_ID,
            "settings": {"device": "mps"},
        },
    )
    original = RESULT_CACHE.get(segmented["result_id"])
    original_runtime = original.runtime
    assert original_runtime is not None
    pack_directory = _private_directory(tmp_path / "cellpose-working")
    receipt = _request(
        "publish_working_result",
        {"result_id": original.result_id, "directory": str(pack_directory)},
    )
    pack_path = pack_directory / receipt["pack"]["basename"]

    RESULT_CACHE.clear()
    restored, _, _ = restore_working_result(
        str(pack_path),
        str(source_path),
        segmented["source"]["sha256"],
        cache=RESULT_CACHE,
    )
    assert restored.runtime == original_runtime
    assert restored.provenance_dict() == original.provenance_dict()

    legacy_path = _rewrite_pack_manifest(
        pack_path,
        tmp_path / "legacy-cellpose.loci-result",
        lambda manifest: manifest["runtime"].pop("memory_preflight"),
    )
    RESULT_CACHE.clear()
    legacy, _, _ = restore_working_result(
        str(legacy_path),
        str(source_path),
        segmented["source"]["sha256"],
        cache=RESULT_CACHE,
    )
    expected_legacy_runtime = {
        key: value for key, value in original_runtime.items() if key != "memory_preflight"
    }
    assert legacy.runtime == expected_legacy_runtime

    republished_directory = _private_directory(tmp_path / "legacy-republished")
    republished = _request(
        "publish_working_result",
        {"result_id": legacy.result_id, "directory": str(republished_directory)},
    )
    RESULT_CACHE.clear()
    reopened_legacy, _, _ = restore_working_result(
        str(republished_directory / republished["pack"]["basename"]),
        str(source_path),
        segmented["source"]["sha256"],
        cache=RESULT_CACHE,
    )
    assert reopened_legacy.runtime == expected_legacy_runtime
