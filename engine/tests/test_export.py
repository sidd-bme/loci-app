from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import tifffile
from PIL import Image, ImageDraw

import loci_engine.export as export_module
from loci_engine.export import export_analysis, sanitize_basename
from loci_engine.models import SegmentationSettings, SourceMetadata
from loci_engine.results import RESULT_CACHE, ResultCache
from loci_engine.segment import segment_image
from loci_engine.worker import handle_request


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


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _root_identity(path: Path) -> dict[str, str]:
    stat = path.stat()
    return {"device": str(stat.st_dev), "inode": str(stat.st_ino)}


def _segment(path: Path) -> dict[str, object]:
    response = handle_request(
        {
            "id": "segment",
            "method": "segment",
            "params": {
                "path": str(path),
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


def _set_cached_source_name(result_id: str, name: str) -> None:
    cached = RESULT_CACHE.get(result_id)
    RESULT_CACHE.restore(replace(cached, source=replace(cached.source, name=name)))


def _create_directory_link(link: Path, target: Path) -> None:
    if os.name == "nt":
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            check=True,
            capture_output=True,
            text=True,
        )
    else:
        link.symlink_to(target, target_is_directory=True)


def _export(
    result_id: str,
    directory: Path,
    basename: str = "sample",
    *,
    options: dict[str, bool] | None = None,
    allowed_root: Path | None = None,
) -> dict[str, object]:
    params: dict[str, object] = {
        "result_id": result_id,
        "directory": str(directory),
        "basename": basename,
    }
    if options is not None:
        params["options"] = options
    if allowed_root is not None:
        params["allowed_root"] = str(allowed_root)
        params["allowed_root_identity"] = _root_identity(allowed_root)
    response = handle_request(
        {
            "id": "export",
            "method": "export",
            "params": params,
        }
    )
    assert "error" not in response
    return response["result"]


@pytest.fixture(autouse=True)
def _clear_result_cache() -> None:
    RESULT_CACHE.clear()
    yield
    RESULT_CACHE.clear()


def test_exports_complete_traceable_bundle_without_touching_source(tmp_path: Path) -> None:
    source_path = tmp_path / "source cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    source_hash = _sha256(source_path)
    source_stat = source_path.stat()

    segmentation = _segment(source_path)
    result_id = segmentation["result_id"]
    assert isinstance(result_id, str)
    assert re.fullmatch(r"[A-Za-z0-9_-]{32}", result_id)
    exported = _export(result_id, tmp_path, basename="Culture day 3")

    files = {key: Path(value) for key, value in exported["files"].items()}
    assert set(files) == {"overlay", "labels", "measurements", "analysis", "marker"}
    assert exported["bundle_name"] == "Culture_day_3_loci"
    assert Path(exported["directory"]) == tmp_path / "Culture_day_3_loci"
    assert all(path.parent == tmp_path / "Culture_day_3_loci" for path in files.values())
    assert all(path.is_file() for path in files.values())

    with Image.open(files["overlay"]) as overlay:
        assert overlay.size == (420, 300)
        assert overlay.mode == "RGB"

    labels = tifffile.imread(files["labels"])
    assert labels.shape == (300, 420)
    assert np.issubdtype(labels.dtype, np.unsignedinteger)
    assert int(labels.max()) == 6

    with files["measurements"].open(encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream))
    assert len(rows) == 6
    assert [int(row["cell_id"]) for row in rows] == list(range(1, 7))

    analysis_text = files["analysis"].read_text(encoding="utf-8")
    analysis = json.loads(analysis_text)
    assert analysis["schema_version"] == "1.0"
    assert analysis["result_id"] == result_id
    assert "path" not in analysis["source"]
    assert str(source_path.resolve()) not in analysis_text
    assert analysis["source"]["name"] == source_path.name
    assert analysis["source"]["sha256"] == source_hash
    assert analysis["engine"] == {"id": "loci-classical", "version": "0.1.0"}
    assert analysis["profile"] == {
        "id": "loci-classical",
        "name": "Loci Adaptive Watershed",
        "version": "0.1.0",
        "backend_kind": "classical",
        "model": {
            "format": "builtin-algorithm",
            "artifact_id": None,
            "sha256": None,
        },
        "preprocessing": {
            "channel_conversion": "grayscale-luminance",
            "intensity_normalization": "per-image-percentile-1-99",
            "resize_policy": "none",
            "max_edge_px": None,
            "output_grid": "source-resolution",
        },
    }
    assert analysis["settings"] == segmentation["settings"]
    assert analysis["metrics"] == segmentation["metrics"]
    assert analysis["metrics"]["count"] == 6
    assert analysis["quality"] == {
        "status": "nominal",
        "scope": "structural_sanity_only",
        "flags": [],
    }
    assert len(analysis["measurements"]) == 6
    assert analysis["corrections"] == {
        "revision": 0,
        "has_manual_edits": False,
        "can_undo": False,
        "can_redo": False,
        "applied_operations": [],
        "events": [],
        "event_count": 0,
        "events_truncated": False,
    }
    assert analysis["created_at"]
    assert analysis["export"]["exported_at"]
    for key in ("overlay", "labels", "measurements"):
        artifact = analysis["export"]["artifacts"][key]
        assert artifact["filename"] == files[key].name
        assert artifact["sha256"] == _sha256(files[key])

    marker = json.loads(files["marker"].read_text(encoding="utf-8"))
    assert marker["bundle_kind"] == "loci-export"
    assert marker["bundle_name"] == exported["bundle_name"]
    assert marker["result_id"] == result_id
    assert marker["source_sha256"] == source_hash
    assert marker["cell_count"] == 6
    assert set(marker["artifacts"]) == {"overlay", "labels", "measurements", "analysis"}
    for key, artifact in marker["artifacts"].items():
        assert artifact["filename"] == files[key].name
        assert artifact["sha256"] == _sha256(files[key])
    assert exported["cell_count"] == 6
    assert exported["options"] == {
        "overlay_png": True,
        "labels_tiff": True,
        "measurements_csv": True,
        "summary_csv": False,
        "analysis_json": True,
    }

    assert _sha256(source_path) == source_hash
    assert source_path.stat().st_mtime_ns == source_stat.st_mtime_ns
    assert not list(tmp_path.glob(".loci-export-*"))


def test_export_sanitizes_names_and_never_overwrites_a_bundle(tmp_path: Path) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]

    first = _export(result_id, tmp_path, basename="CON")
    first_files = {key: Path(value) for key, value in first["files"].items()}
    first_hashes = {key: _sha256(path) for key, path in first_files.items()}
    second = _export(result_id, tmp_path, basename="CON")
    second_files = {key: Path(value) for key, value in second["files"].items()}

    assert first["bundle_name"] == "loci-CON_loci"
    assert second["bundle_name"] == "loci-CON_2_loci"
    assert first_files["overlay"].name == "loci-CON_overlay.png"
    assert second_files["overlay"].name == "loci-CON_2_overlay.png"
    assert first_hashes == {key: _sha256(path) for key, path in first_files.items()}
    assert set(first_files.values()).isdisjoint(second_files.values())
    assert sanitize_basename("../../ : ") == "loci-analysis"
    assert sanitize_basename("CON.notes") == "loci-CON.notes"


def test_export_refuses_to_replace_bundle_created_during_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]
    original_publish = export_module._rename_noreplace
    raced = False

    def create_intervening_bundle(
        source: str | Path,
        destination: str | Path,
        **kwargs: object,
    ) -> None:
        nonlocal raced
        target = Path(destination)
        if not raced:
            target.mkdir()
            (target / "belongs-to-another-process.txt").write_text(
                "do not replace",
                encoding="utf-8",
            )
            raced = True
        original_publish(source, destination, **kwargs)

    monkeypatch.setattr(export_module, "_rename_noreplace", create_intervening_bundle)
    response = handle_request(
        {
            "id": "export-race",
            "method": "export",
            "params": {
                "result_id": result_id,
                "directory": str(tmp_path),
                "basename": "race",
            },
        }
    )

    assert response["error"]["type"] == "FileExistsError"
    intervening = tmp_path / "race_loci"
    assert raced is True
    assert (intervening / "belongs-to-another-process.txt").read_text() == "do not replace"
    assert not list(tmp_path.glob(".race_loci.staging-*"))
    assert not (tmp_path / ".race_loci.lock").exists()


@pytest.mark.parametrize(
    ("option", "artifact", "suffix"),
    [
        ("overlay_png", "overlay", "_overlay.png"),
        ("labels_tiff", "labels", "_labels.tiff"),
        ("measurements_csv", "measurements", "_measurements.csv"),
        ("summary_csv", "summary", "_summary.csv"),
        ("analysis_json", "analysis", "_analysis.json"),
    ],
)
def test_export_can_publish_each_artifact_independently_with_a_bundle_marker(
    tmp_path: Path,
    option: str,
    artifact: str,
    suffix: str,
) -> None:
    source_path = tmp_path / "cells.png"
    export_directory = tmp_path / "exports"
    export_directory.mkdir()
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]

    exported = _export(
        result_id,
        export_directory,
        basename=option,
        options={option: True},
    )

    files = {key: Path(value) for key, value in exported["files"].items()}
    assert set(files) == {artifact, "marker"}
    assert files[artifact].name.endswith(suffix)
    assert files["marker"].name == "loci-export.json"
    marker = json.loads(files["marker"].read_text(encoding="utf-8"))
    assert set(marker["artifacts"]) == {artifact}
    assert marker["artifacts"][artifact]["sha256"] == _sha256(files[artifact])
    assert exported["options"] == {
        key: key == option
        for key in (
            "overlay_png",
            "labels_tiff",
            "measurements_csv",
            "summary_csv",
            "analysis_json",
        )
    }

    if artifact == "summary":
        with files["summary"].open(encoding="utf-8", newline="") as stream:
            assert list(csv.DictReader(stream)) == [
                {"image_name": source_path.name, "cell_count": "6"}
            ]
    if artifact == "analysis":
        analysis = json.loads(files["analysis"].read_text(encoding="utf-8"))
        assert analysis["export"]["artifacts"] == {}


@pytest.mark.parametrize(
    "source_name",
    [
        "=1+1.png",
        "+cmd.png",
        "-2.png",
        "@SUM.png",
        "\tformula.png",
        "\rformula.png",
        "\nformula.png",
    ],
)
def test_summary_csv_neutralizes_spreadsheet_formula_prefixes(
    tmp_path: Path,
    source_name: str,
) -> None:
    source_path = tmp_path / "valid-source.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]
    _set_cached_source_name(result_id, source_name)

    exported = _export(
        result_id,
        tmp_path,
        basename="safe-summary",
        options={"summary_csv": True},
    )

    summary_path = Path(exported["files"]["summary"])
    with summary_path.open(encoding="utf-8", newline="") as stream:
        assert list(csv.DictReader(stream)) == [
            {"image_name": f"'{source_name}", "cell_count": "6"}
        ]


def test_summary_csv_preserves_quoting_after_formula_neutralization(tmp_path: Path) -> None:
    source_name = '=SUM(1,2) "plate".png'
    source_path = tmp_path / "valid-source.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]
    _set_cached_source_name(result_id, source_name)

    exported = _export(
        result_id,
        tmp_path,
        basename="quoted-summary",
        options={"summary_csv": True},
    )

    summary_path = Path(exported["files"]["summary"])
    with summary_path.open(encoding="utf-8", newline="") as stream:
        assert list(csv.DictReader(stream)) == [
            {"image_name": f"'{source_name}", "cell_count": "6"}
        ]
    assert summary_path.read_text(encoding="utf-8").splitlines()[1] == (
        '"\'=SUM(1,2) ""plate"".png",6'
    )


@pytest.mark.parametrize(
    ("options", "error_type", "message"),
    [
        ({}, "ValueError", "at least one"),
        ({"summary_csv": False}, "ValueError", "at least one"),
        ({"summary_csv": 1}, "TypeError", "must be a boolean"),
        ({"unknown": True}, "ValueError", "Unknown export options"),
        ([], "TypeError", "must be an object"),
    ],
)
def test_worker_rejects_invalid_export_options_without_publishing(
    tmp_path: Path,
    options: object,
    error_type: str,
    message: str,
) -> None:
    source_path = tmp_path / "cells.png"
    export_directory = tmp_path / "exports"
    export_directory.mkdir()
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]

    response = handle_request(
        {
            "id": "export",
            "method": "export",
            "params": {
                "result_id": result_id,
                "directory": str(export_directory),
                "options": options,
            },
        }
    )

    assert response["error"]["type"] == error_type
    assert message in response["error"]["message"]
    assert list(export_directory.iterdir()) == []


def test_concurrent_exports_reserve_distinct_bundles(tmp_path: Path) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(_export, result_id, tmp_path, "Concurrent culture") for _ in range(2)
        ]
        exports = [future.result() for future in futures]

    bundles = [set(exported["files"].values()) for exported in exports]
    assert bundles[0].isdisjoint(bundles[1])
    assert all(Path(file_path).stat().st_size > 0 for bundle in bundles for file_path in bundle)
    assert {exported["bundle_name"] for exported in exports} == {
        "Concurrent_culture_loci",
        "Concurrent_culture_2_loci",
    }
    assert not [path for path in tmp_path.iterdir() if path.name.startswith(".")]


def test_failed_export_leaves_no_partial_or_staging_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = tmp_path / "cells.png"
    export_directory = tmp_path / "exports"
    export_directory.mkdir()
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]
    cached = RESULT_CACHE.get(result_id)

    def fail_analysis(*args: object, **kwargs: object) -> None:
        raise RuntimeError("simulated write failure")

    monkeypatch.setattr(export_module, "_write_analysis", fail_analysis)
    with pytest.raises(RuntimeError, match="simulated write failure"):
        export_analysis(cached, export_directory, basename="failed")

    assert list(export_directory.iterdir()) == []


def test_failed_staging_reservation_releases_its_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = tmp_path / "cells.png"
    export_directory = tmp_path / "exports"
    export_directory.mkdir()
    Image.fromarray(_synthetic_cells()).save(source_path)
    cached = RESULT_CACHE.get(_segment(source_path)["result_id"])

    def fail_staging(*args: object, **kwargs: object) -> str:
        raise OSError("simulated staging failure")

    monkeypatch.setattr(export_module.tempfile, "mkdtemp", fail_staging)
    with pytest.raises(OSError, match="simulated staging failure"):
        export_analysis(cached, export_directory, basename="failed")

    assert list(export_directory.iterdir()) == []


def test_batch_export_rejects_symlink_swap_before_engine_write(tmp_path: Path) -> None:
    source_path = tmp_path / "cells.png"
    allowed_root = tmp_path / "batch"
    outside = tmp_path / "outside"
    allowed_root.mkdir()
    outside.mkdir()
    Image.fromarray(_synthetic_cells()).save(source_path)
    cached = RESULT_CACHE.get(_segment(source_path)["result_id"])
    swapped = allowed_root / "experiment"
    _create_directory_link(swapped, outside)
    try:
        with pytest.raises(RuntimeError if os.name == "nt" else OSError):
            export_analysis(
                cached,
                swapped / "day-1",
                basename="field",
                allowed_root=allowed_root,
                allowed_root_identity=_root_identity(allowed_root),
            )

        assert list(outside.iterdir()) == []
        assert [path.name for path in allowed_root.iterdir()] == ["experiment"]
    finally:
        if swapped.exists():
            if os.name == "nt":
                swapped.rmdir()
            else:
                swapped.unlink()


def test_batch_export_publishes_nested_bundle_with_engine_enforced_root(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "cells.png"
    allowed_root = tmp_path / "batch"
    destination = allowed_root / "experiment" / "day-2"
    allowed_root.mkdir()
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]

    exported = _export(
        result_id,
        destination,
        basename="field",
        allowed_root=allowed_root,
    )

    bundle = destination / "field_loci"
    assert Path(exported["directory"]) == bundle
    assert set(Path(value).parent for value in exported["files"].values()) == {bundle}
    assert all(Path(value).is_file() for value in exported["files"].values())
    assert not [
        path
        for path in allowed_root.iterdir()
        if path.name.startswith(".loci-export-")
    ]


@pytest.mark.skipif(os.name == "nt", reason="Windows prevents renaming the held directory")
def test_batch_export_detects_destination_swap_before_atomic_publish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = tmp_path / "cells.png"
    allowed_root = tmp_path / "batch"
    destination = allowed_root / "experiment"
    outside = tmp_path / "outside"
    moved_destination = outside / "moved-experiment"
    attacker_destination = outside / "attacker"
    destination.mkdir(parents=True)
    outside.mkdir()
    attacker_destination.mkdir()
    Image.fromarray(_synthetic_cells()).save(source_path)
    cached = RESULT_CACHE.get(_segment(source_path)["result_id"])
    original_write_json = export_module._write_json_at
    swapped = False

    def write_then_swap(
        filename: str,
        staging_descriptor: int,
        value: object,
    ) -> None:
        nonlocal swapped
        original_write_json(filename, staging_descriptor, value)
        if filename == "loci-export.json" and not swapped:
            destination.rename(moved_destination)
            destination.symlink_to(attacker_destination, target_is_directory=True)
            swapped = True

    monkeypatch.setattr(export_module, "_write_json_at", write_then_swap)
    with pytest.raises(OSError):
        export_analysis(
            cached,
            destination,
            basename="field",
            allowed_root=allowed_root,
            allowed_root_identity=_root_identity(allowed_root),
        )

    assert swapped is True
    assert not list(moved_destination.glob("*_loci"))
    assert not list(attacker_destination.glob("*_loci"))
    assert not [
        path
        for path in allowed_root.iterdir()
        if path.name.startswith(".loci-export-")
    ]


def test_batch_export_rejects_lexical_path_outside_allowed_root(tmp_path: Path) -> None:
    source_path = tmp_path / "cells.png"
    allowed_root = tmp_path / "batch"
    outside = tmp_path / "outside"
    allowed_root.mkdir()
    outside.mkdir()
    Image.fromarray(_synthetic_cells()).save(source_path)
    cached = RESULT_CACHE.get(_segment(source_path)["result_id"])

    with pytest.raises(ValueError, match="outside its allowed root"):
        export_analysis(
            cached,
            outside,
            basename="field",
            allowed_root=allowed_root,
            allowed_root_identity=_root_identity(allowed_root),
        )

    assert list(outside.iterdir()) == []


def test_worker_atomically_publishes_batch_summary_and_manifest(tmp_path: Path) -> None:
    allowed_root = tmp_path / "batch"
    allowed_root.mkdir()
    files = {
        "loci_count_summary_test.csv": "image_name,cell_count\nfield.tif,42\n",
        "loci_batch_manifest_test.json": '{"status":"completed"}\n',
    }

    response = handle_request(
        {
            "id": "batch-metadata",
            "method": "publish_batch_metadata",
            "params": {
                "allowed_root": str(allowed_root),
                "allowed_root_identity": _root_identity(allowed_root),
                "files": files,
            },
        }
    )

    assert "error" not in response
    assert response["result"]["files"] == {
        filename: str(allowed_root / filename) for filename in files
    }
    assert {path.name for path in allowed_root.iterdir()} == set(files)
    for filename, content in files.items():
        assert (allowed_root / filename).read_text(encoding="utf-8") == content


def test_batch_manifest_is_not_visible_when_commit_publication_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    allowed_root = tmp_path / "batch"
    allowed_root.mkdir()
    summary_name = "loci_count_summary_test.csv"
    manifest_name = "loci_batch_manifest_test.json"
    original_rename = export_module._rename_noreplace
    publish_count = 0

    def fail_manifest_publish(*args: object, **kwargs: object) -> None:
        nonlocal publish_count
        publish_count += 1
        if publish_count == 2:
            raise OSError("simulated manifest publication failure")
        original_rename(*args, **kwargs)

    monkeypatch.setattr(export_module, "_rename_noreplace", fail_manifest_publish)
    response = handle_request(
        {
            "id": "batch-metadata",
            "method": "publish_batch_metadata",
            "params": {
                "allowed_root": str(allowed_root),
                "allowed_root_identity": _root_identity(allowed_root),
                # Deliberately pass the manifest first: the engine must not
                # trust caller/object ordering for commit-marker publication.
                "files": {
                    manifest_name: '{"status":"completed"}\n',
                    summary_name: "image_name,cell_count\nfield.tif,42\n",
                },
            },
        }
    )

    assert response["error"]["type"] == "OSError"
    assert publish_count == 2
    assert not (allowed_root / manifest_name).exists()
    # The manifest is the commit marker. A summary already made visible before
    # the failure is intentionally left as an uncommitted orphan: deleting it
    # by pathname could remove another process's intervening replacement.
    assert (allowed_root / summary_name).read_text() == (
        "image_name,cell_count\nfield.tif,42\n"
    )
    assert {path.name for path in allowed_root.iterdir()} == {summary_name}


def test_batch_metadata_refuses_to_replace_raced_manifest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    allowed_root = tmp_path / "batch"
    allowed_root.mkdir()
    summary_name = "loci_count_summary_test.csv"
    manifest_name = "loci_batch_manifest_test.json"
    original_publish = export_module._rename_noreplace

    def create_intervening_manifest(
        source: str | Path,
        destination: str | Path,
        **kwargs: object,
    ) -> None:
        if Path(destination).name == manifest_name:
            destination_fd = kwargs.get("dst_dir_fd")
            if isinstance(destination_fd, int):
                descriptor = os.open(
                    manifest_name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                    dir_fd=destination_fd,
                )
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    stream.write("belongs to another process\n")
                    stream.flush()
                    os.fsync(stream.fileno())
            else:
                (allowed_root / manifest_name).write_text(
                    "belongs to another process\n",
                    encoding="utf-8",
                )
        original_publish(source, destination, **kwargs)

    monkeypatch.setattr(export_module, "_rename_noreplace", create_intervening_manifest)
    response = handle_request(
        {
            "id": "batch-metadata-race",
            "method": "publish_batch_metadata",
            "params": {
                "allowed_root": str(allowed_root),
                "allowed_root_identity": _root_identity(allowed_root),
                "files": {
                    summary_name: "image_name,cell_count\nfield.tif,42\n",
                    manifest_name: '{"status":"completed"}\n',
                },
            },
        }
    )

    assert response["error"]["type"] == "FileExistsError"
    assert (allowed_root / summary_name).read_text() == (
        "image_name,cell_count\nfield.tif,42\n"
    )
    assert (allowed_root / manifest_name).read_text() == "belongs to another process\n"
    assert not list(allowed_root.glob(".*.tmp"))


def test_batch_metadata_rejects_path_components_without_writing(tmp_path: Path) -> None:
    allowed_root = tmp_path / "batch"
    outside = tmp_path / "outside.json"
    allowed_root.mkdir()

    response = handle_request(
        {
            "id": "batch-metadata",
            "method": "publish_batch_metadata",
            "params": {
                "allowed_root": str(allowed_root),
                "allowed_root_identity": _root_identity(allowed_root),
                "files": {"../outside.json": "unsafe"},
            },
        }
    )

    assert response["error"]["type"] == "ValueError"
    assert not outside.exists()
    assert list(allowed_root.iterdir()) == []


@pytest.mark.skipif(os.name == "nt", reason="symlink creation may require elevation on Windows")
def test_batch_root_identity_rejects_root_symlink_swap(tmp_path: Path) -> None:
    allowed_root = tmp_path / "batch"
    moved_root = tmp_path / "moved-batch"
    outside = tmp_path / "outside"
    allowed_root.mkdir()
    outside.mkdir()
    identity = _root_identity(allowed_root)
    allowed_root.rename(moved_root)
    allowed_root.symlink_to(outside, target_is_directory=True)

    response = handle_request(
        {
            "id": "batch-metadata",
            "method": "publish_batch_metadata",
            "params": {
                "allowed_root": str(allowed_root),
                "allowed_root_identity": identity,
                "files": {"loci_batch_manifest_test.json": "{}\n"},
            },
        }
    )

    assert response["error"]["type"] == "RuntimeError"
    assert "changed" in response["error"]["message"]
    assert list(outside.iterdir()) == []
    assert list(moved_root.iterdir()) == []


def test_worker_rejects_unknown_or_expired_result_id(tmp_path: Path) -> None:
    response = handle_request(
        {
            "id": "export",
            "method": "export",
            "params": {
                "result_id": "not-a-real-result",
                "directory": str(tmp_path),
            },
        }
    )

    assert response["error"]["type"] == "KeyError"
    assert "Run segmentation again" in response["error"]["message"]
    assert list(tmp_path.iterdir()) == []


def test_cache_reports_superseded_and_capacity_evictions(tmp_path: Path) -> None:
    source = _synthetic_cells().copy()
    paths: list[Path] = []
    result_ids: list[str] = []
    for index in range(9):
        path = tmp_path / f"cells-{index}.png"
        varied = source.copy()
        varied[0, 0] = index
        Image.fromarray(varied).save(path)
        paths.append(path)
        result = _segment(path)
        result_ids.append(result["result_id"])
        if index < 8:
            assert result["evicted_result_ids"] == []

    assert result_ids[0] in result["evicted_result_ids"]
    replacement = _segment(paths[-1])
    assert result_ids[-1] in replacement["evicted_result_ids"]


def test_cache_keeps_byte_identical_files_at_distinct_paths(tmp_path: Path) -> None:
    first_path = tmp_path / "first" / "cells.png"
    second_path = tmp_path / "second" / "cells.png"
    first_path.parent.mkdir()
    second_path.parent.mkdir()
    Image.fromarray(_synthetic_cells()).save(first_path)
    second_path.write_bytes(first_path.read_bytes())

    first = _segment(first_path)
    second = _segment(second_path)

    assert second["evicted_result_ids"] == []
    assert _export(first["result_id"], tmp_path, "first")["bundle_name"] == "first_loci"
    replacement = _segment(second_path)
    assert replacement["evicted_result_ids"] == [second["result_id"]]


def test_cache_enforces_a_decoded_byte_budget() -> None:
    settings = SegmentationSettings(
        image_mode="fluorescence",
        expected_diameter_px=48,
        min_area_px=250,
    )
    output = segment_image(_synthetic_cells(), settings)
    cache = ResultCache(max_entries=8, max_bytes=1)

    first, first_evictions = cache.add(
        source=SourceMetadata(
            path="/first.png",
            name="first.png",
            width=420,
            height=300,
            channels=1,
            dtype="uint8",
            format="PNG",
            page_count=1,
            sha256="a" * 64,
        ),
        settings=settings,
        output=output,
    )
    second, second_evictions = cache.add(
        source=SourceMetadata(
            path="/second.png",
            name="second.png",
            width=420,
            height=300,
            channels=1,
            dtype="uint8",
            format="PNG",
            page_count=1,
            sha256="b" * 64,
        ),
        settings=settings,
        output=output,
    )

    assert first_evictions == []
    assert second_evictions == [first.result_id]
    assert cache.get(second.result_id) is second


def test_structural_qc_invalidates_extreme_foreground_coverage(tmp_path: Path) -> None:
    source_path = tmp_path / "inverse.png"
    image = np.full((200, 300), 238, dtype=np.uint8)
    image[80:120, 120:180] = 24
    Image.fromarray(image).save(source_path)

    response = handle_request(
        {
            "id": "segment",
            "method": "segment",
            "params": {
                "path": str(source_path),
                "settings": {
                    "image_mode": "brightfield",
                    "polarity": "bright",
                    "expected_diameter_px": 30,
                    "min_area_px": 20,
                },
            },
        }
    )["result"]

    assert response["quality"]["status"] == "invalid"
    assert "foreground_coverage_extreme" in {flag["code"] for flag in response["quality"]["flags"]}
