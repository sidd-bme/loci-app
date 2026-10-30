"""Independent union-area and scheduled-interval oracles on generated masks."""

import copy
import hashlib
import io

import numpy as np
import pytest

from loci_engine.quantitative import Geometry
from loci_engine.research_project import canonical_json
from loci_engine.wound_closure import FILLED_AREA, measure_wound_closure


def digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def rehash(result):
    result["revision_hash"] = digest({k: v for k, v in result.items() if k != "revision_hash"})
    return result


def observed(
    index,
    labels,
    selected=None,
    *,
    source=100,
    t=None,
    unit="um",
    spacing=(2, 3),
    semantics=FILLED_AREA,
):
    labels = np.asarray(labels)
    stream = io.BytesIO()
    np.save(stream, labels, allow_pickle=False)
    encoded = stream.getvalue()
    result = rehash(
        {
            "schema": "loci.research-result/v1",
            "id": f"{index:032x}",
            "kind": "external-labels",
            "source_id": f"{source:032x}",
            "source_sha256": f"{source:064x}",
            "arrays": {
                "labels": {
                    "sha256": hashlib.sha256(encoded).hexdigest(),
                    "bytes": len(encoded),
                    "shape": list(labels.shape),
                    "dtype": str(labels.dtype),
                }
            },
            "provenance": {
                "geometry": Geometry.diagonal(spacing, unit).to_dict(),
                "selection": {
                    "x": 4,
                    "y": 8,
                    "width": labels.shape[-1],
                    "height": labels.shape[-2],
                    "t": index if t is None else t,
                    "z": 0,
                    "c": 0,
                    "level": 0,
                },
                "mask_semantics": semantics,
                "method": {"kind": "explicit-test-mask", "scientific_validation": "unvalidated"},
            },
        }
    )
    return {
        "frame_id": f"frame-{index}",
        "specimen_id": "Declared specimen",
        "sequence_id": "Sequence A",
        "result": result,
        "labels": labels,
        "selected_labels": selected
        if selected is not None
        else sorted(int(v) for v in np.unique(labels) if v > 0),
        "mask_semantics": semantics,
    }


def missing(index, reason="Not acquired"):
    return {
        "frame_id": f"frame-{index}",
        "specimen_id": "Declared specimen",
        "sequence_id": "Sequence A",
        "missing_reason": reason,
    }


def measure(frames, times=None, **kwargs):
    return measure_wound_closure(
        frames,
        times if times is not None else list(range(len(frames))),
        specimen_id="Declared specimen",
        sequence_id="Sequence A",
        area_declaration="Generated filled wound label union, not a boundary trace",
        grid_declaration="Same declared specimen field and native grid; no registration applied",
        **kwargs,
    )


def simple():
    return [
        observed(1, np.array([[1, 1, 2], [1, 0, 2]], np.uint32), selected=[1, 2]),
        observed(2, np.array([[5, 5, 0], [0, 0, 8]], np.uint32), selected=[5]),
    ]


def test_union_area_anisotropy_and_independent_interval_arithmetic():
    frames = simple()
    report = measure(frames, [10, 30])
    assert [f["selected_pixel_count"] for f in report["frames"]] == [5, 2]
    assert [f["excluded_positive_pixel_count"] for f in report["frames"]] == [0, 1]
    assert [f["area"] for f in report["frames"]] == [30, 12]
    assert report["frames"][1]["area_fraction"] == pytest.approx(0.4)
    assert report["frames"][1]["closure_fraction"] == pytest.approx(0.6)
    assert report["intervals"][0]["area_change_rate"] == pytest.approx(-18 / 20)
    assert report["intervals"][0]["closure_change_rate"] == pytest.approx(0.6 / 20)
    assert report["area_unit"] == "um^2" and report["time_unit"] == "s"
    assert report["record_sha256"] == digest(
        {k: v for k, v in report.items() if k != "record_sha256"}
    )
    assert report["input_snapshots"][0]["result"] == frames[0]["result"]
    assert all("labels" not in snapshot for snapshot in report["input_snapshots"])


def test_growth_is_negative_closure_and_zero_area_can_be_complete_closure():
    masks = [
        np.array([[1, 0], [0, 0]], np.uint8),
        np.ones((2, 2), np.uint8),
        np.zeros((2, 2), np.uint8),
    ]
    report = measure([observed(i + 1, a) for i, a in enumerate(masks)])
    assert [f["closure_fraction"] for f in report["frames"]] == [0, -3, 1]
    assert report["intervals"][0]["closure_change_rate"] == -3
    assert report["intervals"][1]["closure_change_rate"] == 4


def test_missing_slots_remain_explicit_and_slopes_never_bridge_gaps():
    frames = simple()
    frames = [
        frames[0],
        missing(10, "Acquisition failed"),
        frames[1],
        observed(3, frames[1]["labels"]),
    ]
    report = measure(frames, [0, 2, 5, 9])
    assert report["frames"][1]["area"] is None
    assert report["frames"][1]["missing_reason"] == "Acquisition failed"
    assert [r["status"] for r in report["intervals"]] == [
        "missing_endpoint",
        "missing_endpoint",
        "defined",
    ]
    assert [r["area_change_rate"] for r in report["intervals"]] == [None, None, 6 / 4]
    assert report["input_snapshots"][1]["missing_reason"] == "Acquisition failed"


@pytest.mark.parametrize("baseline", ["missing", "zero", "empty_selection"])
def test_missing_or_zero_baseline_fails_closed(baseline):
    frames = simple()
    if baseline == "missing":
        frames[0] = missing(1)
    elif baseline == "zero":
        frames[0] = observed(1, np.zeros((2, 3), np.uint32))
    else:
        frames[0]["selected_labels"] = []
    with pytest.raises(ValueError, match="baseline"):
        measure(frames)


@pytest.mark.parametrize(
    "semantics", ["boundary", "skeleton", "boundary-only", "cell-instance-labels", None]
)
def test_boundary_skeleton_and_unspecified_inputs_are_never_filled_or_counted(semantics):
    frames = simple()
    frames[1]["mask_semantics"] = semantics
    with pytest.raises(ValueError, match="filled-wound-area"):
        measure(frames)


def test_upstream_boundary_semantics_cannot_be_overridden_by_caller():
    frames = simple()
    frames[1]["result"]["provenance"]["mask_semantics"] = "boundary-only"
    rehash(frames[1]["result"])
    with pytest.raises(ValueError, match="Boundary/skeleton"):
        measure(frames)


@pytest.mark.parametrize(
    "change",
    ["specimen", "sequence", "shape", "crop", "spacing", "origin", "unit", "channel", "z", "level"],
)
def test_changed_identity_grid_calibration_and_field_of_view_refused(change):
    frames = simple()
    frame = frames[1]
    if change == "specimen":
        frame["specimen_id"] = "Other specimen"
    elif change == "sequence":
        frame["sequence_id"] = "Other sequence"
    elif change == "shape":
        frames[1] = observed(2, np.ones((3, 3), np.uint32))
    else:
        p = frame["result"]["provenance"]
        if change == "crop":
            p["selection"]["x"] += 1
        elif change == "spacing":
            p["geometry"] = Geometry.diagonal((1, 3), "um").to_dict()
        elif change == "origin":
            affine = [list(row) for row in p["geometry"]["affine"]]
            affine[0][-1] += 1
            p["geometry"]["affine"] = affine
        elif change == "unit":
            p["geometry"]["unit"] = "mm"
        else:
            p["selection"][{"channel": "c", "z": "z", "level": "level"}[change]] += 1
        rehash(frame["result"])
    with pytest.raises(ValueError, match="same specimen|field of view|calibration"):
        measure(frames)


@pytest.mark.parametrize(
    "times", [[0, 0], [1, 0], [0], [False, 1], [0, float("nan")], [0, float("inf")], [0, 10**400]]
)
def test_times_are_explicit_finite_strictly_ordered_seconds(times):
    with pytest.raises(ValueError):
        measure(simple(), times)


@pytest.mark.parametrize(
    "attack",
    [
        "bytes",
        "hash",
        "dtype",
        "shape",
        "revision",
        "result_id",
        "source",
        "missing_scope",
        "unknown_label",
        "duplicate_label",
        "background_label",
        "boolean_label",
    ],
)
def test_tampered_exact_binding_and_ambiguous_membership_fail_closed(attack):
    frames = simple()
    f, r = frames[1], frames[1]["result"]
    d = r["arrays"]["labels"]
    if attack == "bytes":
        f["labels"] = f["labels"].copy()
        f["labels"][0, 0] = 99
    elif attack == "hash":
        d["sha256"] = "f" * 64
        rehash(r)
    elif attack == "dtype":
        d["dtype"] = "uint16"
        rehash(r)
    elif attack == "shape":
        d["shape"] = [1, 6]
        rehash(r)
    elif attack == "revision":
        r["revision_hash"] = "f" * 64
    elif attack == "result_id":
        r["id"] = "Not an exact identity"
        rehash(r)
    elif attack == "source":
        r["source_sha256"] = "f" * 64
        rehash(r)
    elif attack == "missing_scope":
        del r["provenance"]["selection"]["x"]
        rehash(r)
    elif attack == "unknown_label":
        f["selected_labels"] = [99]
    elif attack == "duplicate_label":
        f["selected_labels"] = [5, 5]
    elif attack == "background_label":
        f["selected_labels"] = [0]
    else:
        f["selected_labels"] = [True]
    with pytest.raises(ValueError):
        measure(frames)


def test_same_acquisition_or_result_revision_is_not_a_new_time_observation():
    frames = simple()
    frames[1]["result"]["provenance"]["selection"]["t"] = frames[0]["result"]["provenance"][
        "selection"
    ]["t"]
    rehash(frames[1]["result"])
    with pytest.raises(ValueError, match="separate time observations"):
        measure(frames)


def test_distinct_source_files_can_share_explicit_declared_sequence_grid():
    a = np.array([[1, 1], [0, 0]], np.uint16)
    report = measure([observed(1, a, source=101), observed(2, a, source=102)])
    assert report["frames"][1]["closure_fraction"] == 0


def test_uncalibrated_pixels_are_explicit_and_relative_closure_is_dimensionless():
    a = np.array([[1, 1], [0, 0]], np.uint16)
    b = np.array([[1, 0], [0, 0]], np.uint16)
    report = measure(
        [observed(1, a, unit="pixel", spacing=(1, 1)), observed(2, b, unit="pixel", spacing=(1, 1))]
    )
    assert report["area_unit"] == "pixel^2"
    assert report["calibration_status"] == "uncalibrated-pixel-area"
    assert report["frames"][1]["closure_fraction"] == 0.5


def test_fortran_arrays_bind_their_exact_canonical_artifact_and_inputs_are_immutable():
    frames = [
        observed(1, np.asfortranarray([[1, 1], [0, 0]], dtype=np.uint32)),
        observed(2, np.asfortranarray([[1, 0], [0, 0]], dtype=np.uint32)),
    ]
    before_arrays = [f["labels"].copy() for f in frames]
    before_records = [copy.deepcopy(f["result"]) for f in frames]
    report = measure(frames)
    for i, frame in enumerate(frames):
        np.testing.assert_array_equal(frame["labels"], before_arrays[i])
        assert frame["result"] == before_records[i]
    report["input_snapshots"][0]["result"]["id"] = "f" * 32
    assert frames[0]["result"]["id"] == before_records[0]["id"]


def test_budget_refusal_precedes_hashing_and_array_scans(monkeypatch):
    import loci_engine.wound_closure as module

    a = np.ones((256, 256), np.uint32)
    frames = [observed(1, a), observed(2, a)]
    monkeypatch.setattr(
        module, "_artifact", lambda *args: pytest.fail("must refuse before artifact scan")
    )
    with pytest.raises(ValueError, match="aggregate working-memory"):
        measure(frames, working_bytes=1024**2)


def test_tiny_interval_overflow_fails_instead_of_publishing_nonfinite_slope():
    with pytest.raises(ValueError, match="finite"):
        measure(simple(), [0, 1e-320])


def test_baseline_followed_only_by_missing_frames_preserves_unobserved_outcome():
    frames = simple()
    report = measure([frames[0], missing(10), missing(20)], [0, 1, 5])
    assert [r["closure_fraction"] for r in report["frames"]] == [0, None, None]
    assert all(interval["area_change_rate"] is None for interval in report["intervals"])


def test_sparse_uint32_labels_are_not_relabelled_or_truncated():
    a = np.array([[1, 4_000_000_000], [0, 0]], np.uint32)
    frames = [observed(1, a, selected=[1, 4_000_000_000]), observed(2, a, selected=[4_000_000_000])]
    report = measure(frames)
    assert report["frames"][1]["closure_fraction"] == 0.5
    assert report["input_snapshots"][1]["selected_labels"] == [4_000_000_000]


def test_label_population_limit_is_checked_before_python_membership_allocation():
    a = np.ones((320, 320), np.uint32)
    b = np.arange(1, a.size + 1, dtype=np.uint32).reshape(a.shape)
    with pytest.raises(ValueError, match="bounded label population"):
        measure([observed(1, a), observed(2, b, selected=[1])], working_bytes=16 * 1024**2)
