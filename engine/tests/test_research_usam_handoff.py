"""Focused tests for offline standalone μSAM interchange and bound return."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import sqlite3
import stat
import zipfile
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import pytest
import tifffile

from loci_engine import cli
from loci_engine.research_export import export_research_result
from loci_engine.research_interchange import (
    _zip_info,
    export_project,
    import_project,
    relink_interchanged_source,
)
from loci_engine.research_jobs import run_job, submit_job
from loci_engine.research_labels_import import (
    ALIGNMENT,
    VOLUME_ALIGNMENT,
    create_import_grant,
)
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_rpc import dispatch_research
from loci_engine.research_session import clone_study
from loci_engine.research_usam_handoff import (
    MAX_MANIFEST_BYTES,
    UPSTREAM_REFERENCE,
    export_usam_handoff,
    list_usam_handoffs,
    validate_usam_handoff_manifest,
)
from loci_engine.workbench import Workbench


def _make_2d_source(path: Path, dtype: str = "uint16") -> np.ndarray:
    y, x = np.indices((13, 29))
    raw = (1000 + 37 * y + 11 * x).astype(dtype)
    if dtype == "float32":
        raw = (raw / 13.0).astype(np.float32)
    tifffile.imwrite(
        path,
        np.stack([raw, raw + 50]),
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "CYX",
            "PhysicalSizeX": 0.4,
            "PhysicalSizeY": 0.8,
            "Channel": {"Name": ["Nuclei", "Marker"]},
        },
    )
    return raw


def _make_3d_source(path: Path, *, offset: int = 0) -> np.ndarray:
    t, c, z, y, x = np.indices((2, 2, 7, 13, 23))
    raw = (20000 * t + 4000 * c + 300 * z + 19 * y + 7 * x + offset).astype(np.uint16)
    tifffile.imwrite(
        path,
        raw,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "TCZYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 1.25,
            "PhysicalSizeZ": 2.5,
            "Channel": {"Name": ["DNA", "Marker"]},
        },
    )
    return raw


@pytest.fixture
def usam_study(tmp_path: Path):
    study_path = tmp_path / "usam.loci-study"
    wb = Workbench(ResearchProject.create(study_path, "uSAM interchange"))
    src2d_path = tmp_path / "plane-raw.ome.tif"
    raw2d = _make_2d_source(src2d_path, "uint16")
    src2d = wb.import_native(str(src2d_path))

    src3d_path = tmp_path / "vol-raw.ome.tif"
    raw3d = _make_3d_source(src3d_path)
    src3d = wb.import_native(str(src3d_path))

    src3d_twin_path = tmp_path / "vol-twin.ome.tif"
    raw3d_twin = _make_3d_source(src3d_twin_path, offset=77)
    src3d_twin = wb.import_native(str(src3d_twin_path))

    yield wb, study_path, src2d, raw2d, src3d, raw3d, src3d_twin, raw3d_twin
    wb.close()


def test_2d_nonsymmetric_raw_export_bound_return_provenance_and_reopen(usam_study, tmp_path: Path):
    wb, study_path, src2d, raw2d, *_ = usam_study
    selection = {"t": 0, "c": 1, "z": 0, "level": 0}
    expected_raw = raw2d + 50
    dest = tmp_path / "handoff-2d"

    receipt = export_usam_handoff(
        wb, src2d["id"], src2d["sha256"], selection, dest, working_bytes=64 * 1024**2
    )
    assert receipt["schema"] == "loci.usam-handoff-receipt/v1"
    assert receipt["export_origin"] == "verified-loci-native-export"
    assert receipt["validation"] == "not-established"
    assert receipt["basename"] == "handoff-2d"
    assert receipt["input"]["dtype"] == "uint16"
    assert receipt["input"]["shape"] == [13, 29]
    assert receipt["input"]["axes"] == "YX"
    assert receipt["calibration"] == {
        "status": "known",
        "unit": "um",
        "axes": "YX",
        "spacing": [0.8, 0.4],
    }
    assert str(tmp_path) not in canonical_json(receipt)

    with tifffile.TiffFile(dest / "input.tif") as tif:
        assert len(tif.series) == 1
        assert tif.series[0].axes == "YX"
        assert tif.series[0].shape == (13, 29)
        assert np.dtype(tif.series[0].dtype) == np.uint16
        assert tif.pages[0].samplesperpixel == 1
        exported_arr = tif.asarray()
    np.testing.assert_array_equal(exported_arr, expected_raw)
    assert (
        hashlib.sha256(np.ascontiguousarray(exported_arr).tobytes()).hexdigest()
        == receipt["input"]["array_sha256"]
    )
    assert (
        hashlib.sha256((dest / "input.tif").read_bytes()).hexdigest()
        == receipt["input"]["file_sha256"]
    )

    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["upstream_reference"] == UPSTREAM_REFERENCE
    assert manifest["label_profile"]["profile"] == "scalar-native-yx/v1"
    assert str(tmp_path) not in canonical_json(manifest)
    readme = (dest / "README.md").read_text(encoding="utf-8")
    assert UPSTREAM_REFERENCE["commit"] in readme
    assert "pooch" in readme and "xxh128" in readme and "micro_sam/util.py:477" in readme
    assert "raw scalar image" in readme and "micro_sam inference segmentation" in readme
    assert str(tmp_path) not in readme

    # Reopen study across sessions and bind return via manifest.json.
    wb.close()
    reopened = Workbench(ResearchProject(study_path))
    try:
        stored = list_usam_handoffs(reopened)
        assert len(stored) == 1 and stored[0]["handoff_id"] == receipt["handoff_id"]

        labels = np.zeros((13, 29), dtype=np.uint32)
        labels[2:6, 4:10] = 42
        labels[8:11, 18:24] = 2**32 - 5
        labels_path = tmp_path / "labels-2d.tif"
        tifffile.imwrite(
            labels_path,
            labels,
            photometric="minisblack",
            metadata={"axes": "YX"},
            compression="zlib",
        )

        grant = create_import_grant(
            reopened,
            str(labels_path),
            src2d["id"],
            src2d["sha256"],
            selection,
            handoff_manifest_path=str(dest / "manifest.json"),
        )
        assert grant["handoff"]["handoff_id"] == receipt["handoff_id"]
        assert grant["handoff"]["export_identity_basis"] == "verified-loci-study-handoff"
        assert grant["handoff"]["mask_origin_verified_by_loci"] is False
        assert grant["handoff"]["model_validation"] == "unknown"

        producer = {
            "name": "micro-sam",
            "version": "2.0.1",
            "model": "hvit_t_cells",
            "mode": "ais-sparse",
            "checkpoint": "hvit_t_cells_v2",
            "checkpoint_digest": "XXH128:" + ("ab" * 16),
        }
        job = submit_job(
            reopened,
            {
                "source_id": src2d["id"],
                "source_sha256": src2d["sha256"],
                "grant_id": grant["grant_id"],
                "alignment": ALIGNMENT,
                "producer": producer,
            },
            "usam-2d-adopt",
            "labels_import",
        )
        out = run_job(reopened, job["id"])
        summary = out["result"]["label_import"]
        assert summary["handoff"]["handoff_id"] == receipt["handoff_id"]
        assert summary["handoff"]["mask_origin_verified_by_loci"] is False
        assert summary["producer"] == {
            **producer,
            "checkpoint_digest": "xxh128:" + ("ab" * 16),
        }
        res = reopened.project.result(out["result"]["id"])
        ext = res["provenance"]["external_labels"]
        assert ext["producer_identity_basis"] == "user-declared"
        assert ext["mask_origin_basis"] == "user-declared"
        assert ext["upstream_model"] is None
        assert ext["upstream_settings"] is None
        assert ext["upstream_runtime"] is None
        assert ext["upstream_validation"] == "unknown"
        assert ext["handoff"]["exported_input_array_sha256"] == receipt["input"]["array_sha256"]

        reopened.project.review(res["id"], res["revision_hash"], "reviewed")
        export_dir = tmp_path / "reviewed-2d"
        export_research_result(reopened.project, res["id"], res["revision_hash"], str(export_dir))
        methods = (export_dir / "methods.md").read_text(encoding="utf-8")
        assert receipt["handoff_id"] in methods
        assert "hvit_t_cells" in methods
        assert str(tmp_path) not in methods
    finally:
        reopened.close()


def test_float32_native_export_preserves_dtype_and_rejects_non_finite(usam_study, tmp_path: Path):
    wb = usam_study[0]
    fpath = tmp_path / "float-raw.ome.tif"
    raw = _make_2d_source(fpath, "float32")
    src = wb.import_native(str(fpath))
    dest = tmp_path / "handoff-float"
    receipt = export_usam_handoff(
        wb, src["id"], src["sha256"], {"t": 0, "c": 0, "z": 0, "level": 0}, dest
    )
    assert receipt["input"]["dtype"] == "float32"
    np.testing.assert_array_equal(tifffile.imread(dest / "input.tif"), raw)

    nan_path = tmp_path / "nan-raw.tif"
    bad = raw.copy()
    bad[3, 5] = np.nan
    tifffile.imwrite(nan_path, bad, photometric="minisblack", metadata={"axes": "YX"})
    bad_src = wb.import_native(str(nan_path))
    with pytest.raises(ValueError, match="non-finite"):
        export_usam_handoff(
            wb,
            bad_src["id"],
            bad_src["sha256"],
            {"t": 0, "c": 0, "z": 0, "level": 0},
            tmp_path / "handoff-nan",
        )
    assert not (tmp_path / "handoff-nan").exists()


def test_3d_zyx_export_upstream_writer_caveat_checked_writer_and_portable_archive(
    usam_study, tmp_path: Path
):
    wb, study_path, _, _, src3d, raw3d, src3d_twin, _ = usam_study
    selection = {"t": 1, "c": 1, "z": 2, "z_stop": 6, "level": 0}
    expected_vol = raw3d[1, 1, 2:6]
    dest = tmp_path / "handoff-zyx"

    receipt = export_usam_handoff(wb, src3d["id"], src3d["sha256"], selection, dest)
    assert receipt["input"]["shape"] == [4, 13, 23]
    assert receipt["input"]["axes"] == "ZYX"
    assert receipt["calibration"] == {
        "status": "known",
        "unit": "um",
        "axes": "ZYX",
        "spacing": [2.5, 1.25, 0.5],
    }
    readme = (dest / "README.md").read_text(encoding="utf-8")
    assert "micro_sam/v2/automatic_segmentation.py:351" in readme
    assert "micro_sam annotator segmentation" in readme
    assert 'photometric="minisblack"' in readme
    assert "SYX" in readme and "QYX" in readme

    with tifffile.TiffFile(dest / "input.tif") as tif:
        assert tif.series[0].axes == "ZYX"
        assert tif.series[0].shape == (4, 13, 23)
        assert len(tif.pages) == 4
        assert all(p.samplesperpixel == 1 for p in tif.pages)
        np.testing.assert_array_equal(tif.asarray(), expected_vol)

    # Reject upstream-style unannotated 3-plane (SYX), 4-plane (SYX), and 5-plane (QYX) TIFFs.
    for depth in (3, 4, 5):
        sel_bad = {"t": 1, "c": 1, "z": 1, "z_stop": 1 + depth, "level": 0}
        bad_tiff = tmp_path / f"upstream-imageio-d{depth}.tif"
        tifffile.imwrite(bad_tiff, np.zeros((depth, 13, 23), np.uint32), compression="zlib")
        with pytest.raises(ValueError, match="page|ZYX"):
            create_import_grant(wb, str(bad_tiff), src3d["id"], src3d["sha256"], sel_bad)

    # Execute the documented range-checked external writer snippet on non-symmetric int64 IDs.
    external_labels = np.zeros((4, 13, 23), dtype=np.int64)
    external_labels[:, 2:5, 3:8] = 17
    external_labels[1, 9:12, 14:20] = 2**32 - 1
    assert external_labels.dtype.kind in ("u", "i")
    assert int(external_labels.min()) >= 0 and int(external_labels.max()) <= np.iinfo(np.uint32).max
    labels_path = tmp_path / "labels-zyx.tif"
    tifffile.imwrite(
        labels_path,
        external_labels.astype(np.uint32, copy=False),
        photometric="minisblack",
        metadata={"axes": "ZYX"},
        compression="zlib",
    )

    # Reject a different same-shaped source or shifted same-shaped Z range when handoff is supplied.
    with pytest.raises(ValueError, match="different source"):
        create_import_grant(
            wb,
            str(labels_path),
            src3d_twin["id"],
            src3d_twin["sha256"],
            selection,
            handoff_id=receipt["handoff_id"],
        )
    shifted_selection = {"t": 1, "c": 1, "z": 1, "z_stop": 5, "level": 0}
    with pytest.raises(ValueError, match="different native plane or Z range"):
        create_import_grant(
            wb,
            str(labels_path),
            src3d["id"],
            src3d["sha256"],
            shifted_selection,
            handoff_manifest_path=str(dest / "manifest.json"),
        )
    # Generic unbound import (without handoff) remains available on shifted Z range or twin source.
    unbound_grant = create_import_grant(
        wb, str(labels_path), src3d_twin["id"], src3d_twin["sha256"], selection
    )
    assert "handoff" not in unbound_grant

    # Bound cross-session return via immutable study handoff_id.
    wb.close()
    reopened = Workbench(ResearchProject(study_path))
    try:
        grant = create_import_grant(
            reopened,
            str(labels_path),
            src3d["id"],
            src3d["sha256"],
            selection,
            handoff_id=receipt["handoff_id"],
        )
        assert grant["handoff"]["binding_source"] == "study-handoff-id"
        out = reopened.execute(
            "labels_import",
            {
                "source_id": src3d["id"],
                "source_sha256": src3d["sha256"],
                "grant_id": grant["grant_id"],
                "alignment": VOLUME_ALIGNMENT,
                "producer": {
                    "name": "micro-sam",
                    "model": "hvit_t_cells",
                    "mode": "interactive-3d",
                },
            },
        )
        res = reopened.project.result(out["result"]["id"])
        rows = res["provenance"]["measurements"]
        assert [row["label"] for row in rows] == [17, 2**32 - 1]
        for row in rows:
            mask = external_labels == row["label"]
            assert row["voxel_count"] == int(mask.sum())
            assert row["measure"] == pytest.approx(int(mask.sum()) * 0.5 * 1.25 * 2.5)
            assert row["intensity"]["2: Marker"]["mean"] == pytest.approx(
                expected_vol[mask].astype(np.float64).mean()
            )

        # Local Save as preserves authority. Archive restoration preserves only the adopted result.
        clone = Workbench(clone_study(reopened.project, tmp_path / "local-copy.loci-study"))
        try:
            assert (
                create_import_grant(
                    clone,
                    str(labels_path),
                    src3d["id"],
                    src3d["sha256"],
                    selection,
                    handoff_id=receipt["handoff_id"],
                )["handoff"]
                == grant["handoff"]
            )
        finally:
            clone.close()
        archive = tmp_path / "portable.zip"
        export_project(reopened.project, str(archive))
        with zipfile.ZipFile(archive) as zipped:
            assert not any(
                "usam_handoff" in name or "labels_import_grant" in name
                for name in zipped.namelist()
            )
        restored_project = import_project(str(archive), str(tmp_path / "restored"))
        restored = Workbench(ResearchProject(restored_project.root))
        try:
            assert list_usam_handoffs(restored) == []
            historical = restored.project.result(res["id"])
            assert historical == res
            assert (
                historical["provenance"]["external_labels"]["producer"]["model"] == "hvit_t_cells"
            )
            relink_interchanged_source(restored.project, src3d["id"], tmp_path / "vol-raw.ome.tif")
            for reference in (
                {"handoff_id": receipt["handoff_id"]},
                {"handoff_manifest_path": str(dest / "manifest.json")},
            ):
                with pytest.raises(ValueError, match="this study"):
                    create_import_grant(
                        restored,
                        str(labels_path),
                        src3d["id"],
                        src3d["sha256"],
                        selection,
                        **reference,
                    )
        finally:
            restored.close()
    finally:
        reopened.close()


@pytest.mark.parametrize(
    "bad_dtype", ["int8", "int16", "int32", "int64", "uint64", "float32", "bool"]
)
def test_signed_and_unsupported_label_dtypes_give_actionable_errors(
    usam_study, tmp_path: Path, bad_dtype: str
):
    wb, _, src2d, *_ = usam_study
    bad_file = tmp_path / f"bad-{bad_dtype}.tif"
    tifffile.imwrite(bad_file, np.zeros((13, 29), bad_dtype), metadata={"axes": "YX"})
    with pytest.raises(ValueError) as exc:
        create_import_grant(
            wb, str(bad_file), src2d["id"], src2d["sha256"], {"t": 0, "c": 0, "z": 0, "level": 0}
        )
    message = str(exc.value)
    assert "uint8, uint16 or uint32" in message
    assert "implicit" in message.lower()


def test_export_rejects_collisions_symlinks_study_root_rgb_derived_crop_stale_and_budget(
    usam_study, tmp_path: Path, monkeypatch
):
    wb, study_path, src2d, _, src3d, *_ = usam_study
    sel2d = {"t": 0, "c": 0, "z": 0, "level": 0}

    existing = tmp_path / "existing-dir"
    existing.mkdir()
    with pytest.raises(FileExistsError):
        export_usam_handoff(wb, src2d["id"], src2d["sha256"], sel2d, existing)
    assert not list(tmp_path.glob(".loci-usam-*"))

    inside_study = study_path / "inside-export"
    with pytest.raises(ValueError, match="outside the active study"):
        export_usam_handoff(wb, src2d["id"], src2d["sha256"], sel2d, inside_study)

    real_parent = tmp_path / "real-parent"
    real_parent.mkdir()
    link_parent = tmp_path / "link-parent"
    link_parent.symlink_to(real_parent, target_is_directory=True)
    with pytest.raises(ValueError, match="canonical plain"):
        export_usam_handoff(wb, src2d["id"], src2d["sha256"], sel2d, link_parent / "out")

    # Stale source fingerprint
    with pytest.raises(ValueError, match="fingerprint"):
        export_usam_handoff(wb, src2d["id"], "0" * 64, sel2d, tmp_path / "stale")

    # Crop or non-level-0 or singleton Z
    with pytest.raises(ValueError, match="complete native level-zero"):
        export_usam_handoff(
            wb, src2d["id"], src2d["sha256"], {**sel2d, "width": 10}, tmp_path / "crop"
        )
    with pytest.raises(ValueError, match="at least two"):
        export_usam_handoff(
            wb,
            src3d["id"],
            src3d["sha256"],
            {"t": 0, "c": 0, "z": 0, "z_stop": 1, "level": 0},
            tmp_path / "singleton",
        )

    # RGB source rejected
    rgb_path = tmp_path / "rgb.tif"
    tifffile.imwrite(rgb_path, np.zeros((13, 29, 3), np.uint8), photometric="rgb")
    rgb_src = wb.import_native(str(rgb_path))
    with pytest.raises(ValueError, match="RGB"):
        export_usam_handoff(wb, rgb_src["id"], rgb_src["sha256"], sel2d, tmp_path / "rgb-handoff")

    # Derived source rejected for handoff export
    fake_source = wb.project.source(src2d["id"])
    monkeypatch.setattr(
        wb.project,
        "source",
        lambda sid, verify=False: {
            **fake_source,
            "derivation": {"schema": "loci.vendor-derived-source/v1"},
        },
    )
    with pytest.raises(ValueError, match="derived"):
        export_usam_handoff(wb, src2d["id"], src2d["sha256"], sel2d, tmp_path / "derived")
    monkeypatch.undo()

    # Palette TIFF rejected
    palette_path = tmp_path / "palette.tif"
    colormap = np.vstack([np.arange(256, dtype=np.uint16) * 257] * 3)
    tifffile.imwrite(
        palette_path,
        np.zeros((13, 29), np.uint8),
        photometric="palette",
        colormap=colormap,
    )
    palette_src = wb.import_native(str(palette_path))
    with pytest.raises(ValueError, match="RGB or palette"):
        export_usam_handoff(
            wb, palette_src["id"], palette_src["sha256"], sel2d, tmp_path / "palette-handoff"
        )

    # Calibrated volume missing PhysicalSizeZ rejected
    missing_z_path = tmp_path / "no-z-cal.ome.tif"
    tifffile.imwrite(
        missing_z_path,
        np.zeros((3, 13, 23), np.uint16),
        ome=True,
        photometric="minisblack",
        metadata={"axes": "ZYX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 0.5},
    )
    missing_z_src = wb.import_native(str(missing_z_path))
    with pytest.raises(ValueError, match="Z spacing"):
        export_usam_handoff(
            wb,
            missing_z_src["id"],
            missing_z_src["sha256"],
            {"t": 0, "c": 0, "z": 0, "z_stop": 3, "level": 0},
            tmp_path / "no-z-handoff",
        )

    # Budget check precedes load_scalar
    monkeypatch.setattr(
        wb,
        "load_scalar",
        lambda *args, **kwargs: pytest.fail("Budget check must precede pixel load"),
    )
    with pytest.raises(ValueError, match="budget|exceeds"):
        export_usam_handoff(
            wb,
            src2d["id"],
            src2d["sha256"],
            sel2d,
            tmp_path / "tiny-budget",
            working_bytes=1024**2 // 2,
        )
    with pytest.raises(ValueError, match="memory or artifact limit"):
        big_path = tmp_path / "big.tif"
        tifffile.imwrite(big_path, np.zeros((128, 128), np.uint16), metadata={"axes": "YX"})
        big_src = wb.import_native(str(big_path))
        export_usam_handoff(
            wb,
            big_src["id"],
            big_src["sha256"],
            sel2d,
            tmp_path / "over-budget",
            working_bytes=1024**2,
        )


def test_tampered_or_forged_manifest_and_bad_producer_rejected(usam_study, tmp_path: Path):
    wb, _, src2d, *_ = usam_study
    sel2d = {"t": 0, "c": 0, "z": 0, "level": 0}
    dest = tmp_path / "handoff"
    receipt = export_usam_handoff(wb, src2d["id"], src2d["sha256"], sel2d, dest)

    labels_path = tmp_path / "labels.tif"
    tifffile.imwrite(labels_path, np.zeros((13, 29), np.uint8), metadata={"axes": "YX"})

    # Tampered manifest recomputing manifest_sha256 still fails study verification
    forged = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    forged["source_name"] = "forged.tif"
    body = {k: v for k, v in forged.items() if k != "manifest_sha256"}
    forged["manifest_sha256"] = hashlib.sha256(canonical_json(body).encode()).hexdigest()
    forged_path = tmp_path / "forged-manifest.json"
    forged_path.write_text(canonical_json(forged), encoding="utf-8")
    with pytest.raises(ValueError, match="does not match an immutable handoff"):
        create_import_grant(
            wb,
            str(labels_path),
            src2d["id"],
            src2d["sha256"],
            sel2d,
            handoff_manifest_path=str(forged_path),
        )

    for revision in (0, 1):
        with pytest.raises(ValueError, match="Unsupported study document kind"):
            wb.project.put_document(
                "usam_handoff", receipt["handoff_id"], forged, expected_revision=revision
            )
    with pytest.raises(ValueError):
        wb.execute("usam_handoff", forged)

    grant = create_import_grant(wb, str(labels_path), src2d["id"], src2d["sha256"], sel2d)
    for bad_producer in (
        {"name": "micro-sam", "checkpoint": "/private/ckpt.pt"},
        {"name": " C:checkpoint"},
        {"name": "micro-sam", "model": "..\\bad"},
        {"name": "micro-sam", "checkpoint_digest": "xxh128:not-hex"},
        {"name": "micro-sam", "checkpoint_digest": "md5:" + ("a" * 32)},
    ):
        with pytest.raises(ValueError):
            wb.execute(
                "labels_import",
                {
                    "source_id": src2d["id"],
                    "source_sha256": src2d["sha256"],
                    "grant_id": grant["grant_id"],
                    "alignment": ALIGNMENT,
                    "producer": bad_producer,
                },
            )


def test_cli_round_trip_rpc_operation_parity_and_no_mcp_exposure(
    usam_study, tmp_path: Path, capsys
):
    from loci_engine.agent_sessions import (
        _GUI_ONLY_REASONS,
        APPROVAL_GATED_TOOLS,
        METADATA_TOOLS,
        READ_ONLY_TOOLS,
    )
    from loci_engine.cli_support import operation

    wb, study_path, _, _, src3d, _, _, _ = usam_study
    wb.close()

    # Check operation("labels_import") YX and ZYX schema parity
    schema_info = operation("labels_import")
    assert schema_info["request_schema"]["properties"]["alignment"] == {
        "enum": ["same-native-yx-grid", "same-native-zyx-grid"]
    }
    assert len(schema_info["request_schema"]["examples"]) == 2
    producer_props = schema_info["request_schema"]["properties"]["producer"]["properties"]
    assert "checkpoint_digest" in producer_props
    assert "labels_import" in _GUI_ONLY_REASONS
    mcp_tools = READ_ONLY_TOOLS | APPROVAL_GATED_TOOLS | METADATA_TOOLS
    assert "labels_import" not in mcp_tools
    assert "usam-handoff" not in mcp_tools
    assert "usam_handoff" not in mcp_tools

    sel3d = {"t": 0, "c": 0, "z": 1, "z_stop": 4, "level": 0}
    bundle = tmp_path / "cli-bundle"
    assert (
        cli.main(
            [
                "--json",
                "usam-handoff",
                "--project",
                str(study_path),
                "--source",
                src3d["id"],
                "--source-sha256",
                src3d["sha256"],
                "--selection",
                json.dumps(sel3d),
                "--destination",
                str(bundle),
            ]
        )
        == 0
    )
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["schema"] == "loci.usam-handoff-receipt/v1"

    labels = np.zeros((3, 13, 23), dtype=np.uint16)
    labels[:, 1:4, 2:5] = 99
    labels_path = tmp_path / "cli-labels.tif"
    tifffile.imwrite(
        labels_path, labels, photometric="minisblack", metadata={"axes": "ZYX"}, compression="zlib"
    )

    assert (
        cli.main(
            [
                "--json",
                "import-labels",
                "--project",
                str(study_path),
                "--path",
                str(labels_path),
                "--source",
                src3d["id"],
                "--source-sha256",
                src3d["sha256"],
                "--selection",
                json.dumps(sel3d),
                "--handoff-manifest",
                str(bundle / "manifest.json"),
            ]
        )
        == 0
    )
    grant = json.loads(capsys.readouterr().out)
    assert grant["handoff"]["handoff_id"] == receipt["handoff_id"]

    req_path = tmp_path / "adopt.json"
    req_path.write_text(
        json.dumps(
            {
                "source_id": src3d["id"],
                "source_sha256": src3d["sha256"],
                "grant_id": grant["grant_id"],
                "alignment": VOLUME_ALIGNMENT,
                "producer": {"name": "micro-sam", "version": "2.0.1", "model": "hvit_b_lm"},
            }
        ),
        encoding="utf-8",
    )
    assert (
        cli.main(
            [
                "--json",
                "submit",
                "--project",
                str(study_path),
                "--operation",
                "labels_import",
                "--request",
                f"@{req_path}",
                "--request-key",
                "cli-usam-zyx-001",
                "--run",
            ]
        )
        == 0
    )
    run_out = json.loads(capsys.readouterr().out)
    assert run_out["job"]["state"] == "succeeded"
    assert run_out["result"]["label_import"]["handoff"]["handoff_id"] == receipt["handoff_id"]

    listed = dispatch_research("research_usam_handoffs", {"project": str(study_path)})
    assert listed["handoffs"][0]["handoff_id"] == receipt["handoff_id"]
    rpc_bundle = tmp_path / "rpc-bundle"
    rpc_receipt = dispatch_research(
        "research_usam_handoff_export",
        {
            "project": str(study_path),
            "destination": str(rpc_bundle),
            "source_id": src3d["id"],
            "source_sha256": src3d["sha256"],
            "selection": sel3d,
        },
    )
    assert rpc_receipt["schema"] == "loci.usam-handoff-receipt/v1"
    rpc_grant = dispatch_research(
        "research_labels_import_grant",
        {
            "project": str(study_path),
            "path": str(labels_path),
            "source_id": src3d["id"],
            "source_sha256": src3d["sha256"],
            "selection": sel3d,
            "handoff_id": rpc_receipt["handoff_id"],
        },
    )
    assert rpc_grant["handoff"]["handoff_id"] == rpc_receipt["handoff_id"]


@pytest.mark.parametrize(
    "failure",
    ["insert", "commit", "rename", "file-sync", "parent-sync", "replaced-target", "replaced-file"],
)
def test_publication_failure_leaves_no_usable_uuid(usam_study, tmp_path, monkeypatch, failure):
    from loci_engine import research_usam_handoff as handoff

    wb, _, source, *_ = usam_study
    destination = tmp_path / "published"
    selection = {"t": 0, "c": 0, "z": 0, "level": 0}
    ids = []
    rename = handoff._rename_noreplace

    def capture_rename(stage, name, **kwargs):
        ids.append(json.loads((tmp_path / stage / "manifest.json").read_text())["handoff_id"])
        if failure == "rename":
            destination.mkdir()  # A different publisher won the race.
            (destination / "user.txt").write_text("keep")
        rename(stage, name, **kwargs)
        if failure == "replaced-file":
            (destination / "input.tif").unlink()
            os.mkfifo(destination / "input.tif")

    monkeypatch.setattr(handoff, "_rename_noreplace", capture_rename)
    if failure in ("insert", "replaced-target", "commit"):
        if failure == "insert":
            with wb.project.connection() as db:
                db.execute("""CREATE TRIGGER reject_export BEFORE INSERT ON metadata
                           WHEN NEW.key GLOB 'usam-export:*'
                           BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END""")
        else:
            connect = wb.project.connection

            @contextmanager
            def failing_commit(*args, **kwargs):
                with connect(*args, **kwargs) as db:
                    yield db
                    if db.in_transaction and destination.exists():
                        if failure == "replaced-target":
                            destination.rename(tmp_path / "moved")
                            destination.mkdir()
                            (destination / "README.md").write_text("replacement")
                        raise sqlite3.OperationalError("injected commit failure")

            monkeypatch.setattr(wb.project, "connection", failing_commit)
    if failure in ("parent-sync", "file-sync"):
        sync = os.fsync

        def fail_sync(fd):
            if (failure == "file-sync" and stat.S_ISREG(os.fstat(fd).st_mode)) or (
                failure == "parent-sync"
                and os.path.samestat(os.fstat(fd), tmp_path.stat())
                and destination.exists()
            ):
                raise OSError("injected fsync failure")
            sync(fd)

        monkeypatch.setattr(handoff.os, "fsync", fail_sync)

    with pytest.raises((ValueError, FileExistsError)):
        export_usam_handoff(wb, source["id"], source["sha256"], selection, destination)
    assert not list(tmp_path.glob(".loci-usam-*"))
    if failure == "rename":
        assert (destination / "user.txt").read_text() == "keep"
    elif failure == "replaced-file":
        assert (destination / "input.tif").is_fifo()
    elif failure == "replaced-target":
        assert (destination / "README.md").read_text() == "replacement"
        assert (tmp_path / "moved" / "manifest.json").is_file()
    else:
        assert not destination.exists()
    assert list_usam_handoffs(wb) == []
    for handoff_id in ids:
        with pytest.raises(ValueError, match="not found in this study"):
            create_import_grant(
                wb,
                str(tmp_path / "labels.tif"),
                source["id"],
                source["sha256"],
                selection,
                handoff_id=handoff_id,
            )


def test_bound_return_rechecks_selected_channel_declarations(usam_study, tmp_path):
    from loci_engine.research_channels import save_channels

    wb, _, source, *_ = usam_study
    selection = {"t": 0, "c": 1, "z": 0, "level": 0}
    dest = tmp_path / "bundle"
    receipt = export_usam_handoff(wb, source["id"], source["sha256"], selection, dest)
    labels = tmp_path / "labels.tif"
    tifffile.imwrite(labels, np.zeros((13, 29), dtype=np.uint16))

    def preview():
        return create_import_grant(
            wb,
            str(labels),
            source["id"],
            source["sha256"],
            selection,
            handoff_id=receipt["handoff_id"],
        )

    def change(index, field, value):
        metadata = wb.channel_metadata(source["id"])
        metadata["channels"][index][field] = value
        save_channels(
            wb.project,
            {
                "source_id": source["id"],
                "channels": metadata["channels"],
                "expected_revision": metadata["revision"],
            },
        )

    change(0, "name", "Other channel")
    grant = preview()
    for field in ("marker", "fluorophore", "declaration"):
        change(1, field, "changed")
        with pytest.raises(ValueError, match="channel declaration"):
            preview()
        change(1, field, "")
    change(1, "name", "Renamed")
    with pytest.raises(ValueError, match="measurement channel"):
        preview()
    with pytest.raises(ValueError, match="changed after label preview"):
        wb.execute(
            "labels_import",
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "grant_id": grant["grant_id"],
                "alignment": ALIGNMENT,
            },
        )
    change(1, "name", "file:///private/path")
    with pytest.raises(ValueError, match="paths"):
        export_usam_handoff(wb, source["id"], source["sha256"], selection, tmp_path / "unsafe")
    assert not (tmp_path / "unsafe").exists()
    assert len(list_usam_handoffs(wb)) == 1


def test_malformed_manifest_bounds_and_nested_locators(usam_study, tmp_path):
    wb, _, source, *_ = usam_study
    selection = {"t": 0, "c": 0, "z": 0, "level": 0}
    dest = tmp_path / "bundle"
    export_usam_handoff(wb, source["id"], source["sha256"], selection, dest)
    original = json.loads((dest / "manifest.json").read_text())
    for parent, key, value in (
        ("measurement_channel", "name", "1: file:///private/source"),
        ("measurement_channel", "private_locator", "relative-file"),
        ("geometry", "affine", [[True, 0, 0, 0]] * 4),
        ("geometry", "frame", "file:source"),
        ("calibration", "private_path", "relative-file"),
        ("input", "dtype", "object"),
        ("input", "dtype", "int64"),
        ("input", "dtype", "uint64"),
        ("input", "compression", "other"),
        ("input", "shape", [13.0, 29.0]),
        ("input", "file_size_bytes", 2**42),
        ("label_profile", "background_value", False),
    ):
        bad = copy.deepcopy(original)
        bad[parent][key] = value
        del bad["manifest_sha256"]
        bad["manifest_sha256"] = hashlib.sha256(canonical_json(bad).encode()).hexdigest()
        with pytest.raises(ValueError):
            validate_usam_handoff_manifest(bad)
    invalid = tmp_path / "too-large.json"
    invalid.write_bytes(b" " * (MAX_MANIFEST_BYTES + 1))
    with pytest.raises(ValueError, match="size"):
        create_import_grant(
            wb,
            str(tmp_path / "labels.tif"),
            source["id"],
            source["sha256"],
            selection,
            handoff_manifest_path=str(invalid),
        )


def _write_changed_archive(original, destination, path, record):
    with zipfile.ZipFile(original) as source:
        files = {name: source.read(name) for name in source.namelist()}
    manifest = json.loads(files.pop("manifest.json"))
    files[path] = canonical_json(record).encode()
    members = [member for member in manifest["members"] if member["path"] != path]
    members.append(
        {
            "path": path,
            "sha256": hashlib.sha256(files[path]).hexdigest(),
            "size_bytes": len(files[path]),
            "media_type": "application/json",
        }
    )
    manifest["members"] = sorted(members, key=lambda item: item["path"])
    with zipfile.ZipFile(destination, "w") as output:
        for name in sorted(files):
            output.writestr(_zip_info(name), files[name])
        output.writestr(_zip_info("manifest.json"), canonical_json(manifest))


def test_portable_rejects_self_consistent_registry_and_malformed_provenance(usam_study, tmp_path):
    wb, _, source, *_ = usam_study
    selection = {"t": 0, "c": 0, "z": 0, "level": 0}
    dest = tmp_path / "bundle"
    receipt = export_usam_handoff(wb, source["id"], source["sha256"], selection, dest)
    labels = tmp_path / "labels.tif"
    tifffile.imwrite(labels, np.zeros((13, 29), dtype=np.uint16))
    grant = create_import_grant(
        wb, str(labels), source["id"], source["sha256"], selection, handoff_id=receipt["handoff_id"]
    )
    adopted = wb.execute(
        "labels_import",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "grant_id": grant["grant_id"],
            "alignment": ALIGNMENT,
            "producer": {"name": "micro-sam"},
        },
    )
    result = wb.project.result(adopted["result"]["id"])
    archive = tmp_path / "portable.zip"
    export_project(wb.project, archive)
    handoff_id = receipt["handoff_id"]
    fake = {
        "id": handoff_id,
        "kind": "usam_handoff",
        "revision": 1,
        "updated_at": "2026-11-19",
        "data": json.loads((dest / "manifest.json").read_text()),
    }
    forged = tmp_path / "forged.zip"
    _write_changed_archive(archive, forged, f"documents/usam_handoff/{handoff_id}.json", fake)
    with pytest.raises(ValueError, match="document envelope"):
        import_project(forged, tmp_path / "restored")
    for field in ("handoff", "producer", "source_geometry", "measurement_channel", "importer"):
        bad = copy.deepcopy(result)
        bad["provenance"]["external_labels"][field]["private_locator"] = "relative-name"
        del bad["revision_hash"]
        bad["revision_hash"] = hashlib.sha256(canonical_json(bad).encode()).hexdigest()
        _write_changed_archive(archive, forged, f"results/{result['id']}.json", bad)
        with pytest.raises(
            ValueError,
            match="handoff binding|external producer|geometry|measurement channel|private locator",
        ):
            import_project(forged, tmp_path / "restored")
    metadata = wb.channel_metadata(source["id"])
    metadata["channels"][0]["private_locator"] = "relative-name"
    fake_channels = {
        "id": source["id"],
        "kind": "channels",
        "revision": 1,
        "data": {key: metadata[key] for key in ("source_sha256", "original_names", "channels")},
    }
    _write_changed_archive(
        archive, forged, f"documents/channels/{source['id']}.json", fake_channels
    )
    with pytest.raises(ValueError, match="channel metadata"):
        import_project(forged, tmp_path / "restored")
    assert not (tmp_path / "restored").exists()


@pytest.mark.parametrize("dtype", [">u4", ">i4", ">f8"])
def test_wide_scalar_samples_are_bit_exact(usam_study, tmp_path, dtype):
    wb = usam_study[0]
    raw = np.arange(13 * 29).reshape(13, 29).astype(dtype)
    if raw.dtype.kind in "ui":
        raw[1, 3] = np.iinfo(raw.dtype).max
        raw[5, 7] = np.iinfo(raw.dtype).min
    else:
        raw[1, 3] = np.nextafter(1.0, 2.0)
        raw[5, 7] = -0.0
    path = tmp_path / "wide.tif"
    tifffile.imwrite(path, raw, photometric="minisblack", byteorder=">", metadata={"axes": "YX"})
    source = wb.import_native(str(path))
    dest = tmp_path / "bundle"
    receipt = export_usam_handoff(
        wb, source["id"], source["sha256"], {"t": 0, "c": 0, "z": 0, "level": 0}, dest
    )
    actual = tifffile.imread(dest / "input.tif")
    expected_bytes = raw.astype(raw.dtype.newbyteorder("=")).tobytes()
    assert actual.dtype.name == raw.dtype.name == receipt["input"]["dtype"]
    assert actual.tobytes() == expected_bytes
    assert hashlib.sha256(expected_bytes).hexdigest() == receipt["input"]["array_sha256"]
