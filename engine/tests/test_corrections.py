from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import tifffile
from PIL import Image, ImageDraw

from loci_engine.models import SegmentationSettings, SourceMetadata
from loci_engine.results import RESULT_CACHE, ResultCache
from loci_engine.segment import SegmentationOutput, rebuild_output_from_labels, segment_image
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


def _correct(method: str, params: dict[str, object]) -> dict[str, object]:
    response = handle_request({"id": method, "method": method, "params": params})
    assert "error" not in response
    return response["result"]


def _cache_labels(
    cache: ResultCache,
    labels: np.ndarray,
) -> str:
    height, width = labels.shape
    settings = SegmentationSettings(
        image_mode="fluorescence",
        expected_diameter_px=20,
        min_area_px=4,
    )
    template = SegmentationOutput(
        labels=np.zeros_like(labels, dtype=np.int32),
        normalized=np.zeros(labels.shape, dtype=np.float32),
        count=0,
        confluence_percent=0.0,
        measurements=[],
        resolved_polarity="bright",
        threshold=0.5,
    )
    output = rebuild_output_from_labels(template, np.asarray(labels, dtype=np.int32))
    result, _ = cache.add(
        source=SourceMetadata(
            path="/topology.png",
            name="topology.png",
            width=width,
            height=height,
            channels=1,
            dtype="uint8",
            format="PNG",
            page_count=1,
            sha256="b" * 64,
        ),
        settings=settings,
        output=output,
    )
    return result.result_id


@pytest.fixture(autouse=True)
def _clear_result_cache() -> None:
    RESULT_CACHE.clear()
    yield
    RESULT_CACHE.clear()


def test_delete_instance_recomputes_full_result_and_export_consistently(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    segmented = _segment(source_path)

    corrected = _correct(
        "delete_instance",
        {"result_id": segmented["result_id"], "x": 65, "y": 65},
    )

    assert corrected["result_id"] == segmented["result_id"]
    assert corrected["cell_count"] == 5
    assert corrected["metrics"]["count"] == 5
    assert corrected["metrics"]["confluence_percent"] < segmented["metrics"]["confluence_percent"]
    assert [row["cell_id"] for row in corrected["measurements"]] == [1, 2, 3, 4, 5]
    assert corrected["corrections"]["revision"] == 1
    assert corrected["corrections"]["has_manual_edits"] is True
    assert corrected["corrections"]["can_undo"] is True
    operation = corrected["corrections"]["applied_operations"][0]
    assert operation["type"] == "delete_instance"
    assert operation["source_coordinate"] == {"x": 65, "y": 65}
    assert operation["target_cell_id_at_apply"] in range(1, 7)
    assert operation["affected_area_px"] > 1_000

    cached = RESULT_CACHE.get(segmented["result_id"])
    assert int(cached.output.labels[65, 65]) == 0
    assert set(np.unique(cached.output.labels)) == {0, 1, 2, 3, 4, 5}
    export_response = handle_request(
        {
            "id": "export",
            "method": "export",
            "params": {
                "result_id": segmented["result_id"],
                "directory": str(tmp_path),
                "basename": "corrected",
                "options": {"labels_tiff": True, "analysis_json": True},
            },
        }
    )["result"]
    labels = tifffile.imread(export_response["files"]["labels"])
    analysis = json.loads(Path(export_response["files"]["analysis"]).read_text())
    assert int(labels.max()) == 5
    assert analysis["metrics"] == corrected["metrics"]
    assert analysis["measurements"] == corrected["measurements"]
    assert analysis["corrections"] == corrected["corrections"]
    assert export_response["cell_count"] == 5


def test_add_polygon_undo_and_redo_are_recomputed_and_provenance_recorded(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    segmented = _segment(source_path)
    result_id = segmented["result_id"]
    points = [
        {"x": 340, "y": 30},
        {"x": 390, "y": 30},
        {"x": 390, "y": 80},
        {"x": 340, "y": 80},
    ]

    added = _correct("add_polygon", {"result_id": result_id, "points": points})
    assert added["cell_count"] == 7
    assert added["measurements"][-1]["area_px"] == 2_601
    assert added["corrections"]["can_undo"] is True
    assert added["corrections"]["can_redo"] is False
    assert added["corrections"]["events"][0]["action"] == "apply"

    undone = _correct("undo_correction", {"result_id": result_id})
    assert undone["cell_count"] == 6
    assert undone["corrections"]["has_manual_edits"] is False
    assert undone["corrections"]["can_undo"] is False
    assert undone["corrections"]["can_redo"] is True

    redone = _correct("redo_correction", {"result_id": result_id})
    assert redone["cell_count"] == 7
    assert redone["corrections"]["revision"] == 3
    assert [event["action"] for event in redone["corrections"]["events"]] == [
        "apply",
        "undo",
        "redo",
    ]
    assert redone["corrections"]["applied_operations"][0]["source_polygon"] == [
        {"x": 340.0, "y": 30.0},
        {"x": 390.0, "y": 30.0},
        {"x": 390.0, "y": 80.0},
        {"x": 340.0, "y": 80.0},
    ]


def test_split_instance_is_deterministic_replayable_and_export_consistent(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    segmented = _segment(source_path)
    result_id = segmented["result_id"]
    points = [{"x": 65, "y": 30}, {"x": 65, "y": 100}]

    split = _correct(
        "split_instance",
        {"result_id": result_id, "x": 55, "y": 65, "points": points},
    )

    assert split["cell_count"] == 7
    assert split["metrics"]["count"] == 7
    operation = split["corrections"]["applied_operations"][0]
    assert operation["type"] == "split_instance"
    assert operation["source_coordinate"] == {"x": 55, "y": 65}
    assert operation["source_polyline"] == [
        {"x": 65.0, "y": 30.0},
        {"x": 65.0, "y": 100.0},
    ]
    assert operation["affected_area_px"] > 0
    labels_after_split = RESULT_CACHE.get(result_id).output.labels.copy()
    assert labels_after_split[65, 55] != 0
    assert labels_after_split[65, 75] != 0
    assert labels_after_split[65, 55] != labels_after_split[65, 75]
    assert labels_after_split[65, 65] == 0

    undone = _correct("undo_correction", {"result_id": result_id})
    assert undone["cell_count"] == 6
    redone = _correct("redo_correction", {"result_id": result_id})
    assert redone["cell_count"] == 7
    assert np.array_equal(RESULT_CACHE.get(result_id).output.labels, labels_after_split)

    export_response = handle_request(
        {
            "id": "export-split",
            "method": "export",
            "params": {
                "result_id": result_id,
                "directory": str(tmp_path),
                "basename": "split",
                "options": {"labels_tiff": True, "analysis_json": True},
            },
        }
    )["result"]
    labels = tifffile.imread(export_response["files"]["labels"])
    analysis = json.loads(Path(export_response["files"]["analysis"]).read_text())
    assert np.array_equal(labels, labels_after_split)
    assert analysis["metrics"] == redone["metrics"]
    assert analysis["quality"] == redone["quality"]
    assert analysis["corrections"] == redone["corrections"]


def test_merge_instances_requires_two_adjacent_objects_and_replays_exactly() -> None:
    labels = np.zeros((64, 80), dtype=np.int32)
    labels[10:30, 10:30] = 1
    labels[10:30, 30:50] = 2
    labels[40:55, 60:75] = 3
    result_id = _cache_labels(RESULT_CACHE, labels)

    merged = _correct(
        "merge_instances",
        {"result_id": result_id, "x": 15, "y": 15, "other_x": 35, "other_y": 15},
    )

    assert merged["cell_count"] == 2
    operation = merged["corrections"]["applied_operations"][0]
    assert operation["type"] == "merge_instances"
    assert operation["source_coordinates"] == [
        {"x": 15, "y": 15},
        {"x": 35, "y": 15},
    ]
    assert operation["target_cell_ids_at_apply"] == [1, 2]
    merged_labels = RESULT_CACHE.get(result_id).output.labels.copy()
    assert merged_labels[15, 15] == merged_labels[15, 35] != 0

    _correct("undo_correction", {"result_id": result_id})
    redone = _correct("redo_correction", {"result_id": result_id})
    assert redone["cell_count"] == 2
    assert np.array_equal(RESULT_CACHE.get(result_id).output.labels, merged_labels)


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"x": 15, "y": 15, "other_x": 20, "other_y": 20}, "two distinct"),
        ({"x": 15, "y": 15, "other_x": 65, "other_y": 45}, "touching or immediately"),
        ({"x": 1, "y": 1, "other_x": 35, "other_y": 15}, "not inside"),
    ],
)
def test_merge_rejections_are_atomic(params: dict[str, object], message: str) -> None:
    labels = np.zeros((64, 80), dtype=np.int32)
    labels[10:30, 10:30] = 1
    labels[10:30, 30:50] = 2
    labels[40:55, 60:75] = 3
    result_id = _cache_labels(RESULT_CACHE, labels)

    response = handle_request(
        {
            "id": "invalid-merge",
            "method": "merge_instances",
            "params": {"result_id": result_id, **params},
        }
    )

    assert message in response["error"]["message"]
    cached = RESULT_CACHE.get(result_id)
    assert cached.output.count == 3
    assert cached.correction_revision == 0
    assert np.array_equal(cached.output.labels, labels)


def test_replace_boundary_changes_only_target_and_round_trips_history(tmp_path: Path) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    segmented = _segment(source_path)
    result_id = segmented["result_id"]
    polygon = [
        {"x": 48, "y": 48},
        {"x": 82, "y": 48},
        {"x": 82, "y": 82},
        {"x": 48, "y": 82},
    ]

    replaced = _correct(
        "replace_instance_boundary",
        {"result_id": result_id, "x": 65, "y": 65, "points": polygon},
    )

    assert replaced["cell_count"] == segmented["cell_count"]
    assert any(row["area_px"] == 1_225 for row in replaced["measurements"])
    operation = replaced["corrections"]["applied_operations"][0]
    assert operation["type"] == "replace_instance_boundary"
    assert operation["source_coordinate"] == {"x": 65, "y": 65}
    assert operation["source_polygon"] == [
        {"x": 48.0, "y": 48.0},
        {"x": 82.0, "y": 48.0},
        {"x": 82.0, "y": 82.0},
        {"x": 48.0, "y": 82.0},
    ]
    replaced_labels = RESULT_CACHE.get(result_id).output.labels.copy()

    _correct("undo_correction", {"result_id": result_id})
    redone = _correct("redo_correction", {"result_id": result_id})
    assert redone["metrics"] == replaced["metrics"]
    assert np.array_equal(RESULT_CACHE.get(result_id).output.labels, replaced_labels)


def test_paint_stroke_expands_one_instance_or_creates_one_and_replays_exactly() -> None:
    labels = np.zeros((64, 80), dtype=np.int32)
    labels[10:30, 10:30] = 1
    result_id = _cache_labels(RESULT_CACHE, labels)

    expanded = _correct(
        "paint_stroke",
        {
            "result_id": result_id,
            "points": [{"x": 29, "y": 20}, {"x": 38, "y": 20}],
            "radius_px": 2,
        },
    )
    assert expanded["cell_count"] == 1
    paint = expanded["corrections"]["applied_operations"][0]
    assert paint["type"] == "paint_stroke"
    assert paint["brush_radius_px"] == 2
    assert paint["target_cell_id_at_apply"] == 1
    assert paint["affected_area_px"] > 0
    assert RESULT_CACHE.get(result_id).output.labels[20, 37] == 1

    created = _correct(
        "paint_stroke",
        {
            "result_id": result_id,
            "points": [{"x": 65, "y": 45}],
            "radius_px": 3,
        },
    )
    assert created["cell_count"] == 2
    assert created["corrections"]["applied_operations"][-1]["affected_area_px"] == 29
    expected = RESULT_CACHE.get(result_id).output.labels.copy()
    _correct("undo_correction", {"result_id": result_id})
    redone = _correct("redo_correction", {"result_id": result_id})
    assert redone["cell_count"] == 2
    assert np.array_equal(RESULT_CACHE.get(result_id).output.labels, expected)


def test_paint_stroke_refuses_implicit_merge_atomically() -> None:
    labels = np.zeros((48, 72), dtype=np.int32)
    labels[10:30, 8:26] = 1
    labels[10:30, 34:52] = 2
    result_id = _cache_labels(RESULT_CACHE, labels)

    response = handle_request(
        {
            "id": "paint-crossing",
            "method": "paint_stroke",
            "params": {
                "result_id": result_id,
                "points": [{"x": 24, "y": 20}, {"x": 36, "y": 20}],
                "radius_px": 2,
            },
        }
    )

    assert response["error"]["type"] == "ValueError"
    assert "more than one instance" in response["error"]["message"]
    assert RESULT_CACHE.get(result_id).correction_revision == 0
    assert np.array_equal(RESULT_CACHE.get(result_id).output.labels, labels)


def test_erase_stroke_splits_and_relabels_deterministically_with_undo_redo() -> None:
    labels = np.zeros((56, 72), dtype=np.int32)
    labels[10:46, 10:60] = 1
    result_id = _cache_labels(RESULT_CACHE, labels)

    erased = _correct(
        "erase_stroke",
        {
            "result_id": result_id,
            "points": [{"x": 35, "y": 5}, {"x": 35, "y": 50}],
            "radius_px": 1,
        },
    )

    assert erased["cell_count"] == 2
    operation = erased["corrections"]["applied_operations"][0]
    assert operation["type"] == "erase_stroke"
    assert operation["brush_radius_px"] == 1
    assert operation["affected_area_px"] > 0
    expected = RESULT_CACHE.get(result_id).output.labels.copy()
    assert expected[25, 35] == 0
    assert expected[25, 20] != 0
    assert expected[25, 50] != 0
    assert expected[25, 20] != expected[25, 50]
    assert expected[25, 20] == 1
    assert expected[25, 50] == 2

    _correct("undo_correction", {"result_id": result_id})
    assert RESULT_CACHE.get(result_id).output.count == 1
    _correct("redo_correction", {"result_id": result_id})
    assert np.array_equal(RESULT_CACHE.get(result_id).output.labels, expected)


def test_erase_stroke_removes_an_instance_when_no_foreground_remains() -> None:
    labels = np.zeros((32, 40), dtype=np.int32)
    labels[14:17, 18:21] = 1
    result_id = _cache_labels(RESULT_CACHE, labels)

    erased = _correct(
        "erase_stroke",
        {
            "result_id": result_id,
            "points": [{"x": 19, "y": 15}],
            "radius_px": 2,
        },
    )

    assert erased["cell_count"] == 0
    assert erased["corrections"]["applied_operations"][0]["affected_area_px"] == 9
    assert not np.any(RESULT_CACHE.get(result_id).output.labels)


def test_editable_boundary_and_vertex_move_are_distinct_auditable_operations() -> None:
    labels = np.zeros((64, 80), dtype=np.int32)
    labels[16:44, 20:56] = 1
    result_id = _cache_labels(RESULT_CACHE, labels)

    boundary = _correct(
        "get_instance_boundary",
        {"result_id": result_id, "x": 30, "y": 30},
    )
    assert boundary["result_id"] == result_id
    assert boundary["cell_id"] == 1
    assert 3 <= len(boundary["vertices"]) <= 96
    vertices = [dict(point) for point in boundary["vertices"]]
    moved_index = min(
        range(len(vertices)),
        key=lambda index: float(vertices[index]["x"]) + float(vertices[index]["y"]),
    )
    vertices[moved_index]["x"] = max(0.0, float(vertices[moved_index]["x"]) - 3)
    vertices[moved_index]["y"] = max(0.0, float(vertices[moved_index]["y"]) - 3)

    moved = _correct(
        "move_boundary_vertex",
        {
            "result_id": result_id,
            "x": 30,
            "y": 30,
            "points": vertices,
        },
    )
    assert moved["cell_count"] == 1
    operation = moved["corrections"]["applied_operations"][0]
    assert operation["type"] == "move_boundary_vertex"
    assert operation["source_coordinate"] == {"x": 30, "y": 30}
    assert operation["affected_area_px"] > 0
    expected = RESULT_CACHE.get(result_id).output.labels.copy()
    _correct("undo_correction", {"result_id": result_id})
    _correct("redo_correction", {"result_id": result_id})
    assert np.array_equal(RESULT_CACHE.get(result_id).output.labels, expected)


def test_vertex_move_refuses_multiple_changed_handles_atomically() -> None:
    labels = np.zeros((64, 80), dtype=np.int32)
    labels[16:44, 20:56] = 1
    result_id = _cache_labels(RESULT_CACHE, labels)
    boundary = _correct(
        "get_instance_boundary",
        {"result_id": result_id, "x": 30, "y": 30},
    )
    vertices = [dict(point) for point in boundary["vertices"]]
    vertices[0]["x"] = min(79.0, float(vertices[0]["x"]) + 1)
    vertices[1]["x"] = min(79.0, float(vertices[1]["x"]) + 1)

    response = handle_request(
        {
            "id": "multi-vertex",
            "method": "move_boundary_vertex",
            "params": {
                "result_id": result_id,
                "x": 30,
                "y": 30,
                "points": vertices,
            },
        }
    )

    assert response["error"]["type"] == "ValueError"
    assert "exactly one vertex" in response["error"]["message"]
    assert RESULT_CACHE.get(result_id).correction_revision == 0
    assert np.array_equal(RESULT_CACHE.get(result_id).output.labels, labels)


def test_deleting_all_instances_recomputes_structural_quality(tmp_path: Path) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]

    result: dict[str, object] = {}
    for x, y in ((65, 65), (154, 76), (268, 66), (95, 199), (213, 194), (341, 207)):
        result = _correct("delete_instance", {"result_id": result_id, "x": x, "y": y})

    assert result["cell_count"] == 0
    assert result["metrics"]["confluence_percent"] == 0.0
    assert result["measurements"] == []
    assert result["quality"]["status"] == "invalid"
    assert {flag["code"] for flag in result["quality"]["flags"]} == {"no_instances"}


@pytest.mark.parametrize(
    ("method", "params", "error_type", "message"),
    [
        ("delete_instance", {"x": True, "y": 65}, "TypeError", "x must be an integer"),
        ("delete_instance", {"x": 420, "y": 65}, "ValueError", "between 0 and 419"),
        ("delete_instance", {"x": 10, "y": 10}, "ValueError", "not inside"),
        (
            "add_polygon",
            {"points": [{"x": 1, "y": 1}, {"x": 2, "y": 2}]},
            "ValueError",
            "at least three",
        ),
        (
            "add_polygon",
            {
                "points": [
                    {"x": 30, "y": 30},
                    {"x": 100, "y": 100},
                    {"x": 30, "y": 100},
                    {"x": 100, "y": 30},
                ]
            },
            "ValueError",
            "self-intersect",
        ),
        (
            "add_polygon",
            {
                "points": [
                    {"x": 45, "y": 45},
                    {"x": 85, "y": 45},
                    {"x": 85, "y": 85},
                ]
            },
            "ValueError",
            "overlaps an existing instance",
        ),
        (
            "split_instance",
            {"x": 55, "y": 65, "points": [{"x": 50, "y": 65}, {"x": 55, "y": 65}]},
            "ValueError",
            "exactly two connected components",
        ),
        (
            "split_instance",
            {"x": 55, "y": 65, "points": [{"x": 30, "y": 65}, {"x": 310, "y": 65}]},
            "ValueError",
            "exactly the selected instance",
        ),
        (
            "replace_instance_boundary",
            {
                "x": 65,
                "y": 65,
                "points": [
                    {"x": 340, "y": 30},
                    {"x": 390, "y": 30},
                    {"x": 390, "y": 80},
                    {"x": 340, "y": 80},
                ],
            },
            "ValueError",
            "must overlap the selected instance",
        ),
        (
            "replace_instance_boundary",
            {
                "x": 65,
                "y": 65,
                "points": [
                    {"x": 40, "y": 35},
                    {"x": 185, "y": 35},
                    {"x": 185, "y": 110},
                    {"x": 40, "y": 110},
                ],
            },
            "ValueError",
            "only the selected instance",
        ),
        (
            "paint_stroke",
            {"points": [{"x": 65, "y": 65}], "radius_px": True},
            "TypeError",
            "radius_px must be an integer",
        ),
        (
            "erase_stroke",
            {"points": [], "radius_px": 4},
            "ValueError",
            "at least one source point",
        ),
        (
            "move_boundary_vertex",
            {
                "x": 65,
                "y": 65,
                "points": [
                    {"x": 40, "y": 40},
                    {"x": 90, "y": 90},
                    {"x": 40, "y": 90},
                    {"x": 90, "y": 40},
                ],
            },
            "ValueError",
            "self-intersect",
        ),
    ],
)
def test_worker_strictly_validates_manual_corrections(
    tmp_path: Path,
    method: str,
    params: dict[str, object],
    error_type: str,
    message: str,
) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]

    response = handle_request(
        {
            "id": "invalid",
            "method": method,
            "params": {"result_id": result_id, **params},
        }
    )

    assert response["error"]["type"] == error_type
    assert message in response["error"]["message"]
    assert RESULT_CACHE.get(result_id).output.count == 6


def test_correction_operation_polygon_and_event_bounds_are_enforced() -> None:
    settings = SegmentationSettings(
        image_mode="fluorescence",
        expected_diameter_px=48,
        min_area_px=250,
    )
    output = segment_image(_synthetic_cells(), settings)
    cache = ResultCache(
        max_correction_operations=1,
        max_correction_events=2,
        max_polygon_points=4,
    )
    result, _ = cache.add(
        source=SourceMetadata(
            path="/cells.png",
            name="cells.png",
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
    polygon = [
        {"x": 340, "y": 30},
        {"x": 390, "y": 30},
        {"x": 390, "y": 80},
        {"x": 340, "y": 80},
    ]

    cache.add_polygon(result.result_id, points=polygon)
    with pytest.raises(ValueError, match="at most 1 corrections"):
        cache.delete_instance(result.result_id, x=65, y=65)
    cache.undo_correction(result.result_id)
    redone, _ = cache.redo_correction(result.result_id)
    assert redone.corrections_dict()["event_count"] == 3
    assert redone.corrections_dict()["events_truncated"] is True
    assert len(redone.corrections_dict()["events"]) == 2

    cache.undo_correction(result.result_id)
    with pytest.raises(ValueError, match="at most 4 points"):
        cache.add_polygon(result.result_id, points=[*polygon, {"x": 360, "y": 90}])


def test_discard_result_idempotently_releases_cached_arrays(tmp_path: Path) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]

    first = _correct("discard_result", {"result_id": result_id})
    second = _correct("discard_result", {"result_id": result_id})

    assert first == {"result_id": result_id, "discarded": True}
    assert second == {"result_id": result_id, "discarded": False}
    export = handle_request(
        {
            "id": "export",
            "method": "export",
            "params": {"result_id": result_id, "directory": str(tmp_path)},
        }
    )
    assert export["error"]["type"] == "KeyError"
    assert "Run segmentation again" in export["error"]["message"]


def test_correction_workers_reject_unknown_parameters(tmp_path: Path) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]

    response = handle_request(
        {
            "id": "delete",
            "method": "delete_instance",
            "params": {"result_id": result_id, "x": 65, "y": 65, "zoom": 2},
        }
    )

    assert response["error"]["type"] == "ValueError"
    assert "Unknown delete_instance parameters: zoom" in response["error"]["message"]

    boundary_response = handle_request(
        {
            "id": "boundary",
            "method": "get_instance_boundary",
            "params": {"result_id": result_id, "x": 65, "y": 65, "max_vertices": 4000},
        }
    )
    assert boundary_response["error"]["type"] == "ValueError"
    assert boundary_response["error"]["message"] == (
        "Unknown get_instance_boundary parameters: max_vertices"
    )


@pytest.mark.parametrize(
    ("method", "params"),
    [
        (
            "split_instance",
            {
                "x": 55,
                "y": 65,
                "points": [{"x": 65, "y": 30}, {"x": 65, "y": 100}],
            },
        ),
        (
            "merge_instances",
            {"x": 55, "y": 65, "other_x": 154, "other_y": 76},
        ),
        (
            "replace_instance_boundary",
            {
                "x": 65,
                "y": 65,
                "points": [
                    {"x": 48, "y": 48},
                    {"x": 82, "y": 48},
                    {"x": 82, "y": 82},
                    {"x": 48, "y": 82},
                ],
            },
        ),
        (
            "paint_stroke",
            {"points": [{"x": 65, "y": 65}], "radius_px": 2},
        ),
        (
            "erase_stroke",
            {"points": [{"x": 65, "y": 65}], "radius_px": 2},
        ),
        (
            "move_boundary_vertex",
            {
                "x": 65,
                "y": 65,
                "points": [
                    {"x": 48, "y": 48},
                    {"x": 82, "y": 48},
                    {"x": 82, "y": 82},
                    {"x": 48, "y": 82},
                ],
            },
        ),
    ],
)
def test_new_correction_workers_reject_unknown_parameters(
    tmp_path: Path,
    method: str,
    params: dict[str, object],
) -> None:
    source_path = tmp_path / "cells.png"
    Image.fromarray(_synthetic_cells()).save(source_path)
    result_id = _segment(source_path)["result_id"]

    response = handle_request(
        {
            "id": "unknown",
            "method": method,
            "params": {"result_id": result_id, **params, "brush_size": 3},
        }
    )

    assert response["error"]["type"] == "ValueError"
    assert response["error"]["message"] == f"Unknown {method} parameters: brush_size"
    assert RESULT_CACHE.get(result_id).output.count == 6
