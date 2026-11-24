import base64
import json
import shutil

import numpy as np
import pytest
from test_ome_zarr import _store

from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


def test_zarr_study_preserves_selected_tcz_values_affine_and_relinks_exact_tree(tmp_path):
    root, arrays = _store(tmp_path / "raw")
    project = ResearchProject.create(tmp_path / "zarr.loci-study", "NGFF study")
    workbench = Workbench(project)
    source = workbench.import_native(str(root))
    policy = workbench._session(source["id"]).metadata.rgb_color_policy
    assert policy is not None and policy.source_status == "not-applicable"
    selection = {
        "x": 4,
        "y": 3,
        "width": 7,
        "height": 6,
        "t": 1,
        "c": 2,
        "z": 1,
        "z_stop": 4,
        "level": 0,
    }
    values, geometry, selected = workbench.load_scalar(source["id"], selection)
    np.testing.assert_array_equal(values, arrays[0][1, 2, 1:4, 3:9, 4:11])
    assert geometry.axes == "ZYX" and geometry.unit == "um"
    np.testing.assert_array_equal(geometry.world(np.array([[0, 0, 0]])), [[31, 21.5, 2]])
    saved = workbench.execute(
        "run_recipe",
        {
            "source_id": source["id"],
            "selection": selected,
            "recipe": {"steps": [{"op": "subtract_constant", "value": 1}]},
        },
    )
    result = project.result(saved["result"]["id"])
    np.testing.assert_array_equal(
        project.load_array(result["arrays"]["image"]), values.astype(np.float64) - 1
    )
    workbench.close()
    destination = tmp_path / "relocated.ome.zarr"
    shutil.copytree(root, destination)
    shutil.rmtree(root)
    project.relink(source["id"], destination)
    reopened = Workbench(ResearchProject(project.root))
    restored, restored_geometry, _ = reopened.load_scalar(source["id"], selection)
    np.testing.assert_array_equal(restored, values)
    assert restored_geometry == geometry
    assert str(tmp_path) not in str(reopened.snapshot())
    reopened.close()


def test_zarr_modified_chunk_blocks_adoption_and_bad_relink(tmp_path):
    root, _ = _store(tmp_path / "raw")
    project = ResearchProject.create(tmp_path / "zarr.loci-study", "NGFF study")
    workbench = Workbench(project)
    source = workbench.import_native(str(root))
    changed = tmp_path / "changed.ome.zarr"
    shutil.copytree(root, changed)
    chunk = next(path for path in (changed / "0").iterdir() if not path.name.startswith("."))
    chunk.write_bytes(bytes(chunk.stat().st_size))
    with pytest.raises(ValueError, match="do not exactly match"):
        project.relink(source["id"], changed)
    original = root / chunk.relative_to(changed)
    original.write_bytes(chunk.read_bytes())
    with pytest.raises((ValueError, RuntimeError), match="match|changed"):
        workbench.execute("run_recipe", {"source_id": source["id"]})
    assert not project.list_results()


def test_zarr_xy_plane_keeps_physical_z_translation(tmp_path):
    root, arrays = _store(tmp_path / "raw")
    project = ResearchProject.create(tmp_path / "zarr.loci-study", "NGFF study")
    workbench = Workbench(project)
    source = workbench.import_native(str(root))
    plane, geometry, _ = workbench.load_scalar(source["id"], {"t": 1, "c": 2, "z": 3})
    np.testing.assert_array_equal(plane, arrays[0][1, 2, 3])
    np.testing.assert_array_equal(geometry.world(np.array([[0, 0]])), [[30, 20, 6]])


def test_desktop_collection_picker_imports_real_ome_zarr(tmp_path):
    from loci_engine.research_rpc import dispatch_research

    root, _ = _store(tmp_path / "raw")
    project = ResearchProject.create(tmp_path / "collection.loci-study", "Collection")
    snapshot = dispatch_research(
        "research_import", {"project": str(project.root), "paths": [str(root)], "kind": "ome_zarr"}
    )
    assert len(snapshot["sources"]) == 1
    assert snapshot["sources"][0]["source_kind"] == "ome_zarr"


def test_zarr_adapter_region_reader_verifies_transaction_and_matches_exact_arrays(
    tmp_path, monkeypatch
):
    import loci_engine.ome_zarr as ome_zarr_module
    from loci_engine.native_image import NativeSelection
    from loci_engine.ome_zarr import OMEZarrBudgetError, OMEZarrError, OMEZarrSourceChangedError
    from loci_engine.zarr_adapter import ZarrAdapter

    root, arrays = _store(tmp_path / "raw")
    adapter = ZarrAdapter(str(root))
    try:
        selections = [
            NativeSelection(
                x=2,
                y=1,
                width=8,
                height=7,
                t=t,
                c=c,
                z=z,
                level=0,
                series=0,
                expected_sha256=adapter.metadata.sha256,
            )
            for t in range(2)
            for c in range(3)
            for z in range(4)
        ]
        inventory_calls = 0
        open_calls = 0
        original_inventory = ome_zarr_module._inventory
        original_open = ome_zarr_module._open_verified_file

        def counted_inventory(*args, **kwargs):
            nonlocal inventory_calls
            inventory_calls += 1
            return original_inventory(*args, **kwargs)

        def counted_open(*args, **kwargs):
            nonlocal open_calls
            open_calls += 1
            return original_open(*args, **kwargs)

        monkeypatch.setattr(ome_zarr_module, "_inventory", counted_inventory)
        monkeypatch.setattr(ome_zarr_module, "_open_verified_file", counted_open)

        with adapter.region_reader() as read_region:
            regions = [read_region(sel) for sel in selections]
        assert inventory_calls == 2
        assert open_calls > 0

        # Stale reader handle refuses reads after exiting the transaction.
        with pytest.raises(OMEZarrError, match="closed"):
            read_region(selections[0])

        # Ordinary individual read_region still checks inventory before and after.
        inventory_calls = 0
        single = adapter.read_region(selections[0])
        assert inventory_calls == 2
        np.testing.assert_array_equal(single.pixels, regions[0].pixels)
        assert single.sha256 == regions[0].sha256 == adapter.metadata.sha256
        assert single.integrity_mode == regions[0].integrity_mode == "stat-verified-session"
        assert single.read_mode == regions[0].read_mode == "bounded-zarr-chunks"

        for sel, reg in zip(selections, regions, strict=True):
            expected = arrays[0][sel.t, sel.c, sel.z, 1:8, 2:10]
            np.testing.assert_array_equal(reg.pixels, expected)
            assert not reg.pixels.flags.writeable
            assert reg.axes == "YX"
            assert reg.format == "OME-Zarr"

        # Selection validation, budget enforcement, and mutation detection stay strict.
        with adapter.region_reader() as read_region:
            with pytest.raises(ValueError, match="image group"):
                read_region(NativeSelection(x=0, y=0, series=1, width=2, height=2))
            with pytest.raises(ValueError, match="fingerprint"):
                read_region(NativeSelection(x=0, y=0, width=2, height=2, expected_sha256="0" * 64))
            with pytest.raises(ValueError, match="fingerprint"):
                read_region(
                    NativeSelection(x=0, y=0, width=2, height=2, expected_sha256=123)  # type: ignore[arg-type]
                )

        # Budget rejection occurs before decoding inside region_reader().
        budget_root, _ = _store(tmp_path / "budget", chunks=(1, 1, 4, 11, 13), dtype="<f8")
        budget_adapter = ZarrAdapter(str(budget_root))
        try:
            with (
                pytest.raises(OMEZarrBudgetError, match="No chunks were decoded"),
                budget_adapter.region_reader() as budget_read,
            ):
                budget_read(NativeSelection(x=0, y=0, width=13, height=11, budget_bytes=1024))
        finally:
            budget_adapter.close()

        with (
            pytest.raises(OMEZarrSourceChangedError, match="changed"),
            adapter.region_reader() as read_region,
        ):
            read_region(selections[0])
            (root / "extra-file").write_bytes(b"tampered")
    finally:
        adapter.close()


def test_zarr_registration_and_registered_session_avoid_duplicate_manifest_hashing(
    tmp_path, monkeypatch
):
    import loci_engine.ome_zarr as ome_zarr_module
    from loci_engine.ome_zarr import OMEZarrSourceChangedError
    from loci_engine.zarr_adapter import ZarrAdapter

    root, _ = _store(tmp_path / "raw")
    project = ResearchProject.create(tmp_path / "zarr.loci-study", "NGFF study")
    manifest_calls = 0
    original_manifest = ome_zarr_module._content_manifest

    def counted_manifest(*args, **kwargs):
        nonlocal manifest_calls
        manifest_calls += 1
        return original_manifest(*args, **kwargs)

    monkeypatch.setattr(ome_zarr_module, "_content_manifest", counted_manifest)

    source = project.register_zarr_source(str(root))
    assert manifest_calls == 1

    # Re-registering the unchanged store re-verifies once at the registration boundary.
    manifest_calls = 0
    same = project.register_zarr_source(str(root))
    assert same["id"] == source["id"]
    assert manifest_calls == 1

    # Opening a registered expected-hash session hashes once, not twice.
    manifest_calls = 0
    workbench = Workbench(project)
    try:
        session = workbench._session(source["id"])
        assert isinstance(session, ZarrAdapter)
        assert session.metadata.sha256 == source["sha256"]
        assert session.store.metadata.strict_content_manifest_sha256 == source["sha256"]
        assert manifest_calls == 1

        # Explicit verify_strict still hashes fresh from disk every time.
        manifest_calls = 0
        receipt = session.verify_strict()
        assert receipt.content_manifest_sha256 == source["sha256"]
        assert manifest_calls == 1
    finally:
        workbench.close()

    # project.source(verify=True) hashes once and enforces exact match.
    manifest_calls = 0
    verified = project.source(source["id"], verify=True)
    assert verified["sha256"] == source["sha256"]
    assert manifest_calls == 1

    # Mutating a chunk is still caught at every independent boundary.
    chunk = root / "0" / "0.0.0.0.0"
    raw = chunk.read_bytes()
    chunk.write_bytes(bytes([raw[0] ^ 1]) + raw[1:])
    with pytest.raises(ValueError, match="changed"):
        project.register_zarr_source(str(root))
    with pytest.raises(OMEZarrSourceChangedError, match="expected"):
        ZarrAdapter(str(root), expected_sha256=source["sha256"])
    with pytest.raises(ValueError, match="changed"):
        project.source(source["id"], verify=True)


def test_imported_zarr_reuses_the_verified_session_for_display_defaults(tmp_path, monkeypatch):
    import json

    import loci_engine.ome_zarr as ome_zarr_module
    from loci_engine.research_project import canonical_json

    root, arrays = _store(tmp_path / "raw")
    path = root / ".zattrs"
    attrs = json.loads(path.read_text(encoding="utf-8"))
    names = ("First display label", "Second display label", "Third display label")
    attrs["omero"] = {"channels": [{"label": name} for name in names]}
    path.write_text(json.dumps(attrs), encoding="utf-8")
    project = ResearchProject.create(tmp_path / "reuse.loci-study", "Verified session")
    workbench = Workbench(project)
    manifest_calls = 0
    original_manifest = ome_zarr_module._content_manifest

    def counted_manifest(*args, **kwargs):
        nonlocal manifest_calls
        manifest_calls += 1
        return original_manifest(*args, **kwargs)

    monkeypatch.setattr(ome_zarr_module, "_content_manifest", counted_manifest)
    try:
        source = workbench.import_native(str(root))
        source_id = source["id"]
        assert source["metadata"]["channel_names"] == names
        assert manifest_calls == 1
        session = workbench._session(source_id)
        assert session.metadata.channel_names == names
        assert session.metadata.source_axes == "TCZYX"
        defaults = workbench.execute("viewer_defaults", {"source_id": source_id})
        assert [channel["channel"] for channel in defaults["channels"]] == [0, 1, 2]
        assert defaults["source_sha256"] == source["sha256"]
        assert manifest_calls == 1

        # Simulate a study saved before OMERO names were discovered by this reader.
        record = project.source(source_id)
        registered_names = ("Channel 1", "Channel 2", "Channel 3")
        record["metadata"]["channel_names"] = list(registered_names)
        record["metadata"]["ome_zarr"].pop("channel_labels")
        with project.connection() as connection:
            connection.execute(
                "UPDATE sources SET record=? WHERE id=?",
                (
                    canonical_json(record),
                    source_id,
                ),
            )
        repeated = workbench.import_native(str(root))
        assert repeated["id"] == source_id and repeated["metadata"] == record["metadata"]
        assert manifest_calls == 2
        new_session = workbench._session(source_id)
        assert new_session is not session and new_session.metadata.channel_names == registered_names
        assert new_session.metadata.source_axes == "TCZYX"
        pixels, _, _ = workbench.load_scalar(
            source_id,
            {"c": 2, "t": 1, "z": 3, "level": 0},
            strict=False,
        )
        np.testing.assert_array_equal(pixels, arrays[0][1, 2, 3])
        assert manifest_calls == 2
    finally:
        workbench.close()


def test_imported_zarr_cache_rejects_mutation_and_reopens_relinked_source(tmp_path):
    from loci_engine.ome_zarr import OMEZarrSourceChangedError

    root, _ = _store(tmp_path / "raw")
    project = ResearchProject.create(tmp_path / "reuse.loci-study", "Verified session")
    workbench = Workbench(project)
    try:
        source = workbench.import_native(str(root))
        source_id = source["id"]
        exact = tmp_path / "relocated.ome.zarr"
        shutil.copytree(root, exact)

        # A change before the first viewer request cannot borrow the opening receipt.
        chunk = root / "0" / "0.0.0.0.0"
        raw = chunk.read_bytes()
        chunk.write_bytes(bytes([raw[0] ^ 1]) + raw[1:])
        with pytest.raises(ValueError, match="registered .* changed"):
            workbench.import_native(str(root))
        with pytest.raises(OMEZarrSourceChangedError, match="expected"):
            workbench.execute("viewer_defaults", {"source_id": source_id})
        assert source_id not in workbench.sessions

        # Even an exact tree moved into place must open a session on its own root.
        shutil.rmtree(root)
        shutil.copytree(exact, root)
        workbench.import_native(str(root))
        pending_session = workbench.sessions[source_id]
        root.rename(tmp_path / "previous.ome.zarr")
        shutil.copytree(exact, root)
        old_locator_session = workbench._session(source_id)
        assert old_locator_session is not pending_session

        project.relink(source_id, exact)
        relocated_session = workbench._session(source_id)
        assert relocated_session is not old_locator_session
        assert relocated_session.metadata.sha256 == source["sha256"]
        shutil.rmtree(root)
        workbench.load_scalar(source_id, {"width": 2, "height": 2}, strict=False)
    finally:
        workbench.close()


def test_imported_zarr_cache_closes_failed_and_evicted_sessions(tmp_path, monkeypatch):
    from contextlib import contextmanager

    from loci_engine.zarr_adapter import ZarrAdapter

    project = ResearchProject.create(tmp_path / "reuse.loci-study", "Verified session")
    workbench = Workbench(project)
    actual_connection = project.connection
    closed = []
    actual_close = ZarrAdapter.close

    def track_close(self):
        closed.append(self)
        actual_close(self)

    @contextmanager
    def fail_commit():
        with actual_connection() as connection:
            yield connection
            raise RuntimeError("injected commit failure")

    monkeypatch.setattr(ZarrAdapter, "close", track_close)
    root, _ = _store(tmp_path / "first", write=False)
    try:
        with monkeypatch.context() as step:
            step.setattr(project, "connection", fail_commit)
            with pytest.raises(RuntimeError, match="commit failure"):
                workbench.import_native(str(root))
        assert len(closed) == 1
        assert not workbench.sessions and not project.list_sources()

        source = workbench.import_native(str(root))
        first_session = workbench._session(source["id"])
        with monkeypatch.context() as step:
            step.setattr(project, "connection", fail_commit)
            with pytest.raises(RuntimeError, match="commit failure"):
                workbench.import_native(str(root))
        assert len(closed) == 2 and first_session not in closed
        assert workbench._session(source["id"]) is first_session

        for index in range(4):
            additional, _ = _store(tmp_path / f"store-{index}", write=False)
            workbench.import_native(str(additional))
        assert len(workbench.sessions) == 4 and first_session in closed
        assert workbench._session(source["id"]) is not first_session
    finally:
        workbench.close()


def test_direct_volume_import_binds_only_a_verified_ome_zarr_store(tmp_path):
    from loci_engine.ome_zarr import OMEZarrSourceChangedError
    from loci_engine.research_rpc import dispatch_research

    root, _ = _store(tmp_path / "private-raw")
    project = ResearchProject.create(tmp_path / "volume.loci-study", "Volume")
    params = {"project": str(project.root), "kind": "ome_zarr", "include_import_receipt": True}

    invalid = tmp_path / "ordinary-folder.zarr"
    invalid.mkdir()
    with pytest.raises(OMEZarrSourceChangedError, match=r"\.zgroup.*missing"):
        dispatch_research("research_import", {**params, "paths": [str(invalid)]})
    assert not project.list_sources()

    receipt = dispatch_research("research_import", {**params, "paths": [str(root)]})
    source = receipt["snapshot"]["sources"][0]
    assert source["source_kind"] == "ome_zarr"
    assert source["metadata"]["dimensions"]["z"] > 1
    assert receipt["imported_sources"] == [{"id": source["id"], "sha256": source["sha256"]}]
    assert "private-raw" not in str(receipt)


def _volume_pyramid(tmp_path, *, calibrated, x_scale=0.5, x_offset=1.5, z_scale=2.0):
    root, arrays = _store(
        tmp_path / "raw", names="zyx", shapes=((5, 69, 71), (5, 33, 34)), chunks=(2, 10, 12)
    )
    path = root / ".zattrs"
    attrs = json.loads(path.read_text())
    pyramid = attrs["multiscales"][0]
    if not calibrated:
        for axis in pyramid["axes"]:
            axis.pop("unit")
    # Include both a level-dependent offset and shared scale/translation.
    pyramid["coordinateTransformations"] = [
        {"type": "scale", "scale": [1.0, 2.0, 4.0]},
        {"type": "translation", "translation": [4.0, -5.0, 8.0]},
    ]
    coarse = pyramid["datasets"][1]["coordinateTransformations"]
    coarse[0]["scale"] = [z_scale, 1.0, x_scale]
    coarse[1]["translation"] = [0.0, 21.0, 30.0 + 0.25 * x_offset]
    path.write_text(json.dumps(attrs))
    return root, arrays


@pytest.mark.parametrize(("calibrated", "unit"), [(True, "um"), (False, "pixel")])
def test_zarr_volume_maps_translated_pyramid_and_exact_focus(tmp_path, calibrated, unit):
    root, arrays = _volume_pyramid(tmp_path, calibrated=calibrated)
    project = ResearchProject.create(tmp_path / "zarr.loci-study", "NGFF volume")
    workbench = Workbench(project)
    try:
        source = workbench.import_native(str(root))
        response = workbench.execute(
            "viewer_volume",
            {
                "source_id": source["id"],
                "target_long_axis": 16,
                "focus_region_xyzxyz": [65, 70, 62, 68, 1, 4],
            },
        )
        context, focus = response["context"], response["focus"]
        assert context["level"] == 1 and focus["level"] == 0
        assert context["unit"] == focus["unit"] == unit
        assert context["frame"] == focus["frame"] == "image"
        assert context["origin_xyz"] == [129.5, 37.0, 4.0]
        assert focus["origin_xyz"] == [193.0, 97.0, 6.0]
        transform = context["sampling"]["level_zero_index_transform"]
        assert transform == {"scale_xyz": [2.0, 2.0, 1.0], "translation_xyz": [1.5, 2.0, 0.0]}
        x, y, z = context["sampling"]["source_indices_xyz"]
        assert context["sampling"]["level_zero_indices_xyz"] == [
            [2 * i + 2 for i in x], [2 * j + 2 for j in y], z
        ]
        assert [axis[-1] for axis in context["sampling"]["level_zero_indices_xyz"]] == [68, 66, 4]
        focus_sampling = focus["sampling"]
        assert focus_sampling["source_indices_xyz"] == focus_sampling["level_zero_indices_xyz"]
        for block, values in [(context, arrays[1]), (focus, arrays[0])]:
            x, y, z = block["sampling"]["source_indices_xyz"]
            data = np.frombuffer(base64.b64decode(block["data_base64"]), dtype="<u2")
            np.testing.assert_array_equal(
                data.reshape(len(z), len(y), len(x)), values[np.ix_(z, y, x)]
            )
    finally:
        workbench.close()


@pytest.mark.parametrize(
    "parameters", [{"x_offset": -0.25}, {"x_scale": 1.0}, {"z_scale": 1.0}]
)
def test_zarr_volume_falls_back_if_coarse_centers_are_outside_or_duplicate(tmp_path, parameters):
    root, _ = _volume_pyramid(tmp_path, calibrated=True, **parameters)
    project = ResearchProject.create(tmp_path / "zarr.loci-study", "NGFF volume")
    workbench = Workbench(project)
    try:
        source = workbench.import_native(str(root))
        context = workbench.execute(
            "viewer_volume", {"source_id": source["id"], "target_long_axis": 16}
        )["context"]
        assert context["level"] == 0
        assert context["origin_xyz"] == [128.0, 35.0, 4.0]
        sampling = context["sampling"]
        assert "level_zero_index_transform" not in sampling
        assert sampling["source_indices_xyz"] == sampling["level_zero_indices_xyz"]
    finally:
        workbench.close()


@pytest.mark.parametrize("channel_count", [1, 2])
@pytest.mark.parametrize("pyramid", [True, False], ids=["native-level", "tiled-level-zero"])
def test_zarr_auto_defaults_batch_source_inventory_and_match_unbatched_defaults(
    tmp_path, monkeypatch, channel_count, pyramid
):
    from types import SimpleNamespace

    import loci_engine.ome_zarr as ome_zarr_module
    import loci_engine.viewer_image as viewer_image_module

    shapes = ((2, channel_count, 4, 11, 13),)
    if pyramid:
        shapes += ((2, channel_count, 4, 6, 7),)
    root, arrays = _store(tmp_path / "raw", shapes=shapes)
    project = ResearchProject.create(tmp_path / "auto.loci-study", "Auto display")
    workbench = Workbench(project)
    try:
        source = workbench.import_native(str(root))
        source_id = source["id"]
        session = workbench._session(source_id)
        monkeypatch.setattr(viewer_image_module, "MAX_OVERVIEW_EDGE", 8)
        monkeypatch.setattr(viewer_image_module, "SOURCE_TILE_EDGE", 5)
        original_inventory = ome_zarr_module._inventory
        inventories = []

        def counted_inventory(path):
            inventories.append(path)
            return original_inventory(path)

        monkeypatch.setattr(ome_zarr_module, "_inventory", counted_inventory)
        request = {"source_id": source_id, "t": 1, "z": 2, "auto": True}

        acquisition = workbench.execute("viewer_defaults", {**request, "auto": False})
        assert acquisition["basis"]["mode"] == "acquisition"
        assert not inventories

        legacy_reader = SimpleNamespace(metadata=session.metadata, read_region=session.read_region)
        legacy = viewer_image_module.viewer_defaults(legacy_reader, request)
        # The baseline enters and leaves an inventory check for every plane or tile.
        assert len(inventories) == 2 * channel_count * (1 if pyramid else 9)
        inventories.clear()

        actual = workbench.execute("viewer_defaults", request)
        assert len(inventories) == 2
        assert actual == legacy

        level = 1 if pyramid else 0
        assert actual["basis"]["level"] == level
        assert (actual["basis"]["t"], actual["basis"]["z"]) == (1, 2)
        assert len(actual["channels"]) == channel_count
        for channel in actual["channels"]:
            plane = arrays[level][1, channel["channel"], 2]
            if not pyramid:
                ys = np.rint(np.linspace(0, 10, 7)).astype(int)
                xs = np.rint(np.linspace(0, 12, 8)).astype(int)
                plane = plane[np.ix_(ys, xs)]
            np.testing.assert_array_equal(
                [channel["low"], channel["high"]], [plane.min(), plane.max()]
            )
    finally:
        workbench.close()


def test_zarr_auto_defaults_reject_mutation_after_the_last_sample(tmp_path, monkeypatch):
    from loci_engine.ome_zarr import OMEZarrSourceChangedError

    root, _ = _store(tmp_path / "raw", shapes=((1, 2, 1, 11, 13), (1, 2, 1, 6, 7)))
    project = ResearchProject.create(tmp_path / "auto.loci-study", "Auto display")
    workbench = Workbench(project)
    try:
        source = workbench.import_native(str(root))
        session = workbench._session(source["id"])
        original_read = session.store._read_plane
        read_channels = []

        def read_and_mutate(request, *, check_inventory):
            plane = original_read(request, check_inventory=check_inventory)
            read_channels.append((request.level, request.c))
            if request.c == 1:
                # Change an unsampled chunk after the second channel is decoded.
                chunk = root / "0" / "0.0.0.0.0"
                original = chunk.read_bytes()
                chunk.write_bytes(bytes([original[0] ^ 1]) + original[1:])
            return plane

        monkeypatch.setattr(session.store, "_read_plane", read_and_mutate)
        with pytest.raises(OMEZarrSourceChangedError, match="changed"):
            workbench.execute("viewer_defaults", {"source_id": source["id"], "auto": True})
        assert read_channels == [(1, 0), (1, 1)]
    finally:
        workbench.close()
