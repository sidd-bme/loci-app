"""Synthetic independent oracles for trusted external-label adoption."""

import copy
import hashlib
import json
import shutil
import zipfile

import numpy as np
import pytest
import tifffile

from loci_engine.research_jobs import cancel_job, run_job, submit_job
from loci_engine.research_labels_import import ALIGNMENT, create_import_grant
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.workbench import Workbench


@pytest.fixture
def scene(tmp_path):
    y, x = np.indices((64, 64))
    image = np.stack([7 + y + x, 1000 + 3 * y + 2 * x]).astype(np.uint16)
    source_path = tmp_path / "raw.ome.tif"
    tifffile.imwrite(
        source_path,
        image,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "CYX",
            "PhysicalSizeX": 0.5,
            "PhysicalSizeY": 1,
            "Channel": {"Name": ["DNA", "Marker"]},
        },
    )
    wb = Workbench(ResearchProject.create(tmp_path / "study", "Synthetic labels"))
    source = wb.import_native(str(source_path))
    labels = np.zeros((64, 64), np.uint32)
    for i, label_id in enumerate([17, 65536, 4_000_000_000, 2**32 - 1]):
        labels[2 + i * 8 : 5 + i * 8, 3:7] = label_id
    labels[60, 60] = 17  # disconnected pixels belong to the same external object
    file = tmp_path / "labels.tif"
    tifffile.imwrite(file, labels, metadata={"axes": "YX"}, compression="deflate")
    yield wb, source, source_path, labels, file, image[1]
    wb.close()


def preview(scene, **options):
    wb, source, _, _, file, _ = scene
    return create_import_grant(
        wb,
        str(file),
        source["id"],
        source["sha256"],
        {"t": 0, "c": 1, "z": 0, "level": 0},
        **options,
    )


def request(scene, grant, **options):
    _, source, *_ = scene
    return {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
        "grant_id": grant["grant_id"],
        "alignment": ALIGNMENT,
        **options,
    }


def adopt(scene, **options):
    wb = scene[0]
    grant = preview(scene)
    job = submit_job(wb, request(scene, grant, **options), "adopt-external", "labels_import")
    output = run_job(wb, job["id"])
    return grant, job, output, wb.project.result(output["result"]["id"])


def assert_measurements(rows, labels, image, area=0.5):
    ids = np.unique(labels)
    ids = ids[ids != 0]
    assert [row["label"] for row in rows] == ids.tolist()
    for row in rows:
        mask = labels == row["label"]
        expected = image[mask].astype(np.float64)
        assert row["voxel_count"] == np.count_nonzero(mask)
        assert row["measure"] == np.count_nonzero(mask) * area
        intensity = row["intensity"]["2: Marker"]
        assert intensity["sum"] == expected.sum()
        assert intensity["mean"] == expected.mean()
        assert row["index_axes"] == "YX"
        expected_y, expected_x = np.argwhere(mask).mean(axis=0)
        np.testing.assert_allclose(
            row["centroid_index"], [expected_y, expected_x], rtol=0, atol=1e-12
        )
        np.testing.assert_allclose(
            row["centroid_world_xyz"][:2], [expected_x * area, expected_y], rtol=0, atol=1e-12
        )


def test_sparse_exact_values_raw_measurements_grant_privacy_and_retry(scene):
    wb, source, source_path, labels, file, image = scene
    source_bytes, label_bytes = source_path.read_bytes(), file.read_bytes()
    grant, job, output, result = adopt(
        scene, producer={"name": "Declared external tool", "version": "1"}
    )
    assert grant["object_count"] == 4
    assert grant["labels_sha256"] == hashlib.sha256(labels.tobytes()).hexdigest()
    assert grant["measurement_channel"] == {
        "index": 1,
        "name": "2: Marker",
        "basis": "raw-source-channel-values",
    }
    assert grant["image"].startswith("data:image/png;base64,")
    assert grant["shape"] == [64, 64]
    assert "private_path" not in canonical_json(grant)
    assert str(file) not in canonical_json(grant)
    assert result["kind"] == "external-labels"
    assert result["schema"] == "loci.research-result/v1"
    assert wb.project.review_state(result["id"]) is None
    np.testing.assert_array_equal(wb.project.load_array(result["arrays"]["labels"]), labels)
    np.testing.assert_array_equal(wb.project.load_array(result["arrays"]["image"]), image)
    assert_measurements(result["provenance"]["measurements"], labels, image)
    assert source_path.read_bytes() == source_bytes and file.read_bytes() == label_bytes
    provenance = result["provenance"]["external_labels"]
    assert provenance["producer_identity_basis"] == "user-declared"
    assert provenance["upstream_runtime"] is None
    assert provenance["upstream_validation"] == "unknown"
    assert output["result"]["label_import"]["producer"]["name"] == "Declared external tool"
    assert (
        submit_job(
            wb,
            request(scene, grant, producer={"name": "Declared external tool", "version": "1"}),
            "adopt-external",
            "labels_import",
        )["id"]
        == job["id"]
    )
    assert run_job(wb, job["id"])["job"]["result_ids"] == [result["id"]]
    assert len(wb.project.list_results()) == 1
    snapshot = canonical_json(wb.snapshot())
    assert str(file) not in snapshot and "labels_import_grant" not in snapshot
    assert str(file) not in canonical_json(output["job"])
    assert output["job"]["request"]["task_request"]["grant_id"] == grant["grant_id"]
    assert source["sha256"] == result["source_sha256"]


@pytest.mark.parametrize("dtype", ["uint8", "uint16", "uint32"])
def test_unsigned_conversion_and_empty_population(scene, dtype):
    wb, _, _, _, file, _ = scene
    labels = np.zeros((64, 64), dtype)
    tifffile.imwrite(file, labels, metadata={"axes": "YX"})
    _, _, output, result = adopt(scene)
    assert output["result"]["object_count"] == 0
    assert result["provenance"]["measurements"] == []
    assert result["provenance"]["external_labels"]["original_dtype"] == dtype
    assert wb.project.load_array(result["arrays"]["labels"]).dtype == np.uint32


def test_population_beyond_first_page_exact_locate(scene):
    wb, _, _, _, file, image = scene
    labels = np.zeros((64, 64), np.uint32)
    ids = [(i + 1) * 1009 for i in range(255)] + [2**32 - 1]
    for i, label_id in enumerate(ids):
        labels[(i // 16) * 4, (i % 16) * 4] = label_id
    tifffile.imwrite(file, labels, metadata={"axes": "YX"})
    _, _, output, result = adopt(scene)
    assert output["result"]["object_count"] == 256
    rows = wb.execute("result", {"result_id": result["id"], "offset": 200})
    assert rows["measurements"][-1]["label"] == 2**32 - 1
    assert rows["total_rows"] == 256
    assert_measurements(result["provenance"]["measurements"], labels, image)
    located = wb.execute(
        "population_locate",
        {"result_id": result["id"], "revision_hash": result["revision_hash"], "label": 2**32 - 1},
    )
    assert located["label"] == 2**32 - 1


def test_removed_original_correction_exports_archive_relink_and_reopen(scene, tmp_path):
    from loci_engine.research_export import export_research_result
    from loci_engine.research_interchange import (
        export_project,
        import_project,
        relink_interchanged_source,
    )

    wb, source, source_path, labels, file, image = scene
    _, _, _, parent = adopt(scene)
    external = copy.deepcopy(parent["provenance"]["external_labels"])
    file.unlink()
    binding = {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    info = wb.execute("correction_info", binding)
    output = wb.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "delete",
                    "label": 65536,
                    "expected_input_sha256": info["label_sha256"],
                }
            ],
        },
    )
    child = wb.project.result(output["result"]["id"])
    expected = labels.copy()
    expected[expected == 65536] = 0
    assert child["provenance"]["external_labels"] == external
    assert wb.project.review_state(child["id"]) is None
    assert_measurements(child["provenance"]["measurements"], expected, image)
    np.testing.assert_array_equal(wb.project.load_array(parent["arrays"]["labels"]), labels)
    np.testing.assert_array_equal(wb.project.load_array(child["arrays"]["labels"]), expected)
    wb.project.review(child["id"], child["revision_hash"], "reviewed")
    destination = tmp_path / "bundle"
    export_research_result(wb.project, child["id"], child["revision_hash"], str(destination))
    np.testing.assert_array_equal(tifffile.imread(destination / "labels.ome.tif"), expected)
    np.testing.assert_array_equal(np.load(destination / "labels.npy", allow_pickle=False), expected)
    methods = (destination / "methods.md").read_text()
    assert "external_labels" in methods and "upstream_runtime" in methods
    assert external["file_sha256"] in methods and str(file) not in methods
    assert str(2**32 - 1) in (destination / "objects.csv").read_text()
    archive = tmp_path / "study.zip"
    export_project(wb.project, str(archive))
    with zipfile.ZipFile(archive) as zipped:
        assert not any("labels_import_grant" in name for name in zipped.namelist())
        json_bytes = b"".join(
            zipped.read(name) for name in zipped.namelist() if name.endswith(".json")
        )
        assert str(file).encode() not in json_bytes
    reopened = import_project(str(archive), str(tmp_path / "restored"))
    assert reopened.documents("labels_import_grant") == []
    candidate = tmp_path / "relinked.ome.tif"
    shutil.copyfile(source_path, candidate)
    relink_interchanged_source(reopened, source["id"], str(candidate))
    restored = Workbench(ResearchProject(reopened.root))
    try:
        np.testing.assert_array_equal(
            restored.project.load_array(child["arrays"]["labels"]), expected
        )
        assert restored.project.result(child["id"])["provenance"]["external_labels"] == external
        assert restored.execute("result", {"result_id": child["id"]})["result"]["label_import"]
        assert restored.execute(
            "correction_info", {"result_id": child["id"], "revision_hash": child["revision_hash"]}
        )["label_sha256"]
    finally:
        restored.close()


@pytest.mark.parametrize("bad_dtype", ["int8", "int16", "int32", "uint64", "float32", "bool"])
def test_reject_non_unsigned_32bit_labels(scene, bad_dtype):
    file = scene[4]
    tifffile.imwrite(file, np.zeros((64, 64), bad_dtype), metadata={"axes": "YX"})
    with pytest.raises(ValueError, match="uint8|uint16|uint32"):
        preview(scene)
    assert scene[0].project.documents("labels_import_grant") == []


@pytest.mark.parametrize("layout", ["rgb", "stack", "orientation", "wrong-grid", "axes", "spatial"])
def test_reject_layout_grid_and_metadata(scene, layout):
    file, labels = scene[4], scene[3]
    options = {"metadata": {"axes": "YX"}}
    if layout == "rgb":
        labels = np.zeros((64, 64, 3), np.uint8)
        options = {"photometric": "rgb"}
    elif layout == "stack":
        labels = np.stack([labels, labels])
        options["metadata"]["axes"] = "ZYX"
    elif layout == "orientation":
        options["extratags"] = [(274, "H", 1, 2, False)]
    elif layout == "wrong-grid":
        labels = labels[:63]
    elif layout == "axes":
        options["metadata"]["axes"] = "QX"
    else:
        options["metadata"]["spacing"] = 3
    tifffile.imwrite(file, labels, **options)
    with pytest.raises(ValueError):
        preview(scene)
    assert scene[0].project.list_results() == []


@pytest.mark.parametrize("mutation", ["source", "labels", "grant", "channels", "cancel", "guard"])
def test_mutation_and_cancellation_at_publication_never_publish(scene, monkeypatch, mutation):
    wb, _, source_path, _, file, _ = scene
    grant = preview(scene)
    job = submit_job(wb, request(scene, grant), "mutation", "labels_import")
    original = wb.project.store_array
    called = False

    def stage(array):
        nonlocal called
        descriptor = original(array)
        if not called:
            called = True
            if mutation == "source":
                with source_path.open("ab") as stream:
                    stream.write(b"changed")
            elif mutation == "labels":
                with file.open("ab") as stream:
                    stream.write(b"changed")
            elif mutation == "grant":
                document = wb.project.documents("labels_import_grant")[0]
                changed = {**document["data"], "working_bytes": 1024**2}
                wb.project.put_document(
                    "labels_import_grant", document["id"], changed, expected_revision=1
                )
            elif mutation == "channels":
                original_metadata = wb.channel_metadata
                monkeypatch.setattr(
                    wb,
                    "channel_metadata",
                    lambda source_id: {
                        **original_metadata(source_id),
                        "changed_after_preview": True,
                    },
                )
            elif mutation == "cancel":
                cancel_job(wb.project, job["id"])
        return descriptor

    monkeypatch.setattr(wb.project, "store_array", stage)

    def deny():
        raise PermissionError("Publication approval revoked")

    with pytest.raises((ValueError, PermissionError, RuntimeError)):
        run_job(wb, job["id"], publication_guard=deny if mutation == "guard" else None)
    assert wb.project.list_results() == []
    assert wb.project.job(job["id"])["state"] == ("cancelled" if mutation == "cancel" else "failed")
    assert str(file) not in canonical_json(wb.project.job(job["id"]))


def test_reject_grant_change_before_decode_or_path_in_task(scene, monkeypatch):
    wb = scene[0]
    grant = preview(scene)
    with pytest.raises(ValueError):
        submit_job(wb, request(scene, grant, path=str(scene[4])), "unsafe", "labels_import")
    assert wb.project.list_jobs() == []
    with pytest.raises(ValueError):
        submit_job(
            wb,
            request(scene, grant, producer={"name": "/private/path"}),
            "producer-path",
            "labels_import",
        )
    source_binding = request(scene, grant)
    source_binding["source_sha256"] = "0" * 64
    with pytest.raises(ValueError):
        submit_job(wb, source_binding, "wrong-source", "labels_import")
    with pytest.raises(ValueError):
        submit_job(
            wb, request(scene, grant, alignment="shape-only"), "wrong-align", "labels_import"
        )


def test_resource_bounds_selection_and_symlink(scene, tmp_path):
    wb, source, _, _, file, _ = scene
    for selection in (
        {"t": 0, "c": 1, "z": 0},
        {"t": 0, "c": 1, "z": 0, "level": 0, "width": 63},
        {"t": 0, "c": 1, "z": 0, "level": 0, "z_stop": 1},
    ):
        with pytest.raises(ValueError):
            create_import_grant(wb, str(file), source["id"], source["sha256"], selection)
    link = tmp_path / "label-link.tif"
    link.symlink_to(file)
    with pytest.raises(ValueError, match="symlink"):
        create_import_grant(
            wb, str(link), source["id"], source["sha256"], {"t": 0, "c": 1, "z": 0, "level": 0}
        )
    with pytest.raises(ValueError):
        preview(scene, working_bytes=True)
    with pytest.raises(ValueError):
        preview(scene, working_bytes=1024)


@pytest.mark.parametrize("mismatch", [False, True])
def test_ome_microscopic_calibration_must_agree(scene, mismatch):
    tifffile.imwrite(
        scene[4],
        scene[3],
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "YX",
            "PhysicalSizeX": 2 if mismatch else 0.5,
            "PhysicalSizeY": 1,
        },
    )
    if mismatch:
        with pytest.raises(ValueError, match="calibration"):
            preview(scene)
    else:
        grant = preview(scene)
        assert grant["calibration_handling"]["microscopic_calibration"] == "verified-OME-spacing"


def test_print_dpi_is_ignored_for_external_labels(scene):
    tifffile.imwrite(
        scene[4], scene[3], resolution=(300, 300), resolutionunit="INCH", metadata={"axes": "YX"}
    )
    grant = preview(scene)
    assert grant["calibration_handling"]["microscopic_calibration"] == "unknown"
    assert grant["calibration_handling"]["print_resolution"] == "ignored-as-microscopic-calibration"


def test_pixel_source_and_preview_only_cli(scene, tmp_path):
    from loci_engine.cli_support import operation
    from loci_engine.research_cli import execute, parser

    wb, _, _, labels, file, image = scene
    source_path = tmp_path / "pixel-source.tif"
    tifffile.imwrite(source_path, image, metadata={"axes": "YX"})
    source = wb.import_native(str(source_path))
    args = parser().parse_args(
        [
            "import-labels",
            "--project",
            str(wb.project.root),
            "--source",
            source["id"],
            "--source-sha256",
            source["sha256"],
            "--path",
            str(file),
            "--selection",
            json.dumps({"t": 0, "c": 0, "z": 0, "level": 0}),
        ]
    )
    grant = execute(args)
    assert wb.project.list_results() == []
    assert grant["geometry"]["unit"] == "pixel"
    output = wb.execute(
        "labels_import",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "grant_id": grant["grant_id"],
            "alignment": ALIGNMENT,
        },
    )
    rows = wb.project.result(output["result"]["id"])["provenance"]["measurements"]
    assert rows[0]["measure"] == np.count_nonzero(labels == 17)
    discovery = operation("labels_import")
    assert discovery["route"] == "submit"
    assert discovery["request_schema"]["additionalProperties"] is False


def test_policy_cannot_authorize_imported_results_or_jobs(scene, tmp_path):
    from test_agent_policy import specification

    from loci_engine.agent_policy import load_policy, write_policy
    from loci_engine.research_mcp import PolicyAgent

    wb, source, *_ = scene
    recipe = {
        "source_id": source["id"],
        "selection": {
            "t": 0,
            "c": 1,
            "z": 0,
            "level": 0,
            "x": 0,
            "y": 0,
            "width": 64,
            "height": 64,
        },
        "recipe": {},
    }
    export_root = tmp_path / "exports"
    export_root.mkdir()
    spec = specification(wb, source, recipe, export_root)
    spec["sources"][0].update(
        crop={"x": 0, "y": 0, "width": 64, "height": 64}, c=[1], z=[0], measurement_channels=[1]
    )
    policy_path = tmp_path / "policy.json"
    write_policy(policy_path, wb.project, spec)
    agent = PolicyAgent(load_policy(policy_path))
    _, job, _, result = adopt(scene)
    # The very same source/crop/channel is granted, so denials must result
    # from unsupported operation/provenance rather than an ungranted source.
    assert agent.policy.source_grant(wb.project, source["id"])
    assert "recipe" not in result["provenance"]
    with pytest.raises(PermissionError, match="operation"):
        agent._authorize_job(wb, job["id"])
    with pytest.raises((PermissionError, ValueError)):
        agent._authorize_result(wb, result["id"])


def test_miniswhite_numeric_labels_are_never_inverted(scene):
    tifffile.imwrite(scene[4], scene[3], photometric="miniswhite", metadata={"axes": "YX"})
    _, _, _, result = adopt(scene)
    np.testing.assert_array_equal(scene[0].project.load_array(result["arrays"]["labels"]), scene[3])


def test_exact_selected_time_z_raw_channel(scene, tmp_path):
    wb = scene[0]
    shape = (2, 2, 2, 64, 64)
    image = np.zeros(shape, np.uint16)
    image[1, 1, 1] = scene[5]
    source_path = tmp_path / "timed-volume.ome.tif"
    tifffile.imwrite(
        source_path,
        image,
        ome=True,
        photometric="minisblack",
        metadata={
            "axes": "TCZYX",
            "Channel": {"Name": ["DNA", "Marker"]},
        },
    )
    source = wb.import_native(str(source_path))
    grant = create_import_grant(
        wb, str(scene[4]), source["id"], source["sha256"], {"t": 1, "c": 1, "z": 1, "level": 0}
    )
    output = wb.execute(
        "labels_import",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "grant_id": grant["grant_id"],
            "alignment": ALIGNMENT,
        },
    )
    result = wb.project.result(output["result"]["id"])
    assert result["provenance"]["selection"]["t"] == 1
    assert result["provenance"]["selection"]["z"] == 1
    assert_measurements(result["provenance"]["measurements"], scene[3], scene[5], area=1)


def test_correction_paint_keeps_original_high_id_and_parent(scene):
    wb, _, _, labels, _, image = scene
    _, _, _, parent = adopt(scene)
    binding = {"result_id": parent["id"], "revision_hash": parent["revision_hash"]}
    info = wb.execute("correction_info", binding)
    output = wb.execute(
        "correct_result",
        {
            **binding,
            "operations": [
                {
                    "op": "brush",
                    "mode": "paint",
                    "plane": "XY",
                    "index": 0,
                    "points": [{"u": 40, "v": 40}],
                    "radius": 0.2,
                    "label": 2**32 - 1,
                    "expected_input_sha256": info["label_sha256"],
                }
            ],
        },
    )
    child = wb.project.result(output["result"]["id"])
    expected = labels.copy()
    expected[40, 40] = 2**32 - 1
    np.testing.assert_array_equal(wb.project.load_array(child["arrays"]["labels"]), expected)
    np.testing.assert_array_equal(wb.project.load_array(parent["arrays"]["labels"]), labels)
    assert_measurements(child["provenance"]["measurements"], expected, image)
    assert child["parent_id"] == parent["id"]
    assert wb.project.review_state(child["id"]) is None


def test_identical_replacement_is_rejected_after_preview(scene):
    wb, _, _, _, file, _ = scene
    grant = preview(scene)
    encoded = file.read_bytes()
    file.unlink()
    file.write_bytes(encoded)
    with pytest.raises(ValueError, match="replaced|changed"):
        wb.execute("labels_import", request(scene, grant))
    assert wb.project.list_results() == []


def test_private_grant_integrity_tamper_is_rejected(scene):
    wb = scene[0]
    grant = preview(scene)
    envelope = wb.project.documents("labels_import_grant")[0]
    changed = {**envelope, "data": {**envelope["data"], "labels_sha256": "0" * 64}}
    with wb.project.connection() as connection:
        connection.execute(
            "UPDATE documents SET record=? WHERE kind=? AND id=?",
            (canonical_json(changed), "labels_import_grant", envelope["id"]),
        )
    with pytest.raises(ValueError, match="integrity"):
        submit_job(wb, request(scene, grant), "changed-grant", "labels_import")
    assert wb.project.list_jobs() == []


def test_object_limit_and_combined_budget_before_measurement(scene, tmp_path, monkeypatch):
    import loci_engine.research_labels_import as imports

    wb = scene[0]
    image = np.zeros((320, 320), np.uint8)
    source_path = tmp_path / "many-source.tif"
    tifffile.imwrite(source_path, image, metadata={"axes": "YX"})
    source = wb.import_native(str(source_path))
    labels = np.arange(image.size, dtype=np.uint32).reshape(image.shape)
    file = tmp_path / "many-labels.tif"
    tifffile.imwrite(file, labels, metadata={"axes": "YX"})
    selection = {"t": 0, "c": 0, "z": 0, "level": 0}
    with pytest.raises(ValueError, match="Too many objects"):
        create_import_grant(wb, str(file), source["id"], source["sha256"], selection)
    monkeypatch.setattr(
        imports,
        "_read_tiff_segments",
        lambda *args: pytest.fail("Budget rejection must happen before decoding"),
    )
    with pytest.raises(ValueError, match="Combined.*bounds"):
        create_import_grant(
            wb, str(file), source["id"], source["sha256"], selection, working_bytes=1024**2
        )


def test_unsafe_segment_range_and_unsupported_spatial_metadata(scene):
    file, labels = scene[4], scene[3]
    for metadata in ({"axes": "YX", "origin": [1, 2]}, {"axes": "YX", "PhysicalSizeX": 0.5}):
        tifffile.imwrite(file, labels, metadata=metadata)
        with pytest.raises(ValueError, match="spatial"):
            preview(scene)
    tifffile.imwrite(file, labels, metadata={"axes": "YX"}, compression="deflate")
    with tifffile.TiffFile(file, mode="r+b") as tif:
        tif.pages[0].tags["StripOffsets"].overwrite(2**30)
    with pytest.raises((ValueError, RuntimeError)):
        preview(scene)
    assert scene[0].project.list_results() == []


def test_per_object_python_allocations_are_bounded_before_measurement(scene, monkeypatch):
    import loci_engine.research_labels_import as imports

    wb = scene[0]
    labels = np.zeros((64, 64), np.uint32)
    labels.ravel()[:256] = np.arange(1, 257, dtype=np.uint32)
    tifffile.imwrite(scene[4], labels, metadata={"axes": "YX"})
    monkeypatch.setattr(
        imports,
        "measure_objects",
        lambda *args, **kwargs: pytest.fail("Allocation rejection must precede measurement rows"),
    )
    with pytest.raises(ValueError, match="object measurement allocations"):
        preview(scene, working_bytes=1024**2)
    assert wb.project.documents("labels_import_grant") == []


def test_preview_io_error_never_discloses_private_path(scene):
    wb, source, _, _, file, _ = scene
    file.unlink()
    with pytest.raises(ValueError, match="unavailable") as error:
        preview(scene)
    assert str(file) not in str(error.value)
    assert wb.project.documents("labels_import_grant") == []
    assert wb.project.list_results() == []
