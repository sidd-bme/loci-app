import copy

import numpy as np
import pytest
import tifffile

from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


def fixture(tmp_path):
    path = tmp_path / "scalar.tif"
    tifffile.imwrite(path, np.arange(1200, dtype=np.uint16).reshape(30, 40))
    workbench = Workbench(ResearchProject.create(tmp_path / "study.loci-study", "Display"))
    source = workbench.import_native(str(path))
    state = {
        "interpretation": "histology",
        "projection": "plane",
        "channels": [
            {
                "channel": 0,
                "low": 0,
                "high": 65535,
                "gamma": 1,
                "color": "#ffffff",
                "opacity": 1,
                "visible": True,
            }
        ],
        "selection": {
            "x": 5,
            "y": 6,
            "width": 10,
            "height": 12,
            "z": 0,
            "t": 0,
            "c": 0,
            "level": 0,
        },
        "camera": {"x": 20.25, "y": 15, "scale": 2.5},
    }
    return workbench, source, state, path.read_bytes()


def save(workbench, source, state, revision=0):
    return workbench.execute(
        "save_source_view",
        {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "expected_revision": revision,
            "state": state,
        },
    )


def test_presentation_roundtrip_does_not_change_analysis_region_or_source(tmp_path):
    workbench, source, state, original = fixture(tmp_path)
    first = save(workbench, source, state)
    changed = copy.deepcopy(state)
    changed["camera"] = {"x": 1, "y": 1, "scale": 0.02}
    changed["channels"][0]["gamma"] = 2
    updated = save(workbench, source, changed, 1)
    reopened = Workbench(ResearchProject(workbench.project.root))
    assert reopened.execute("source_view", {"source_id": source["id"]}) == updated
    assert first["state"]["selection"] == updated["state"]["selection"]
    assert (tmp_path / "scalar.tif").read_bytes() == original
    assert not workbench.project.list_results()
    with pytest.raises(ValueError, match="reload"):
        save(workbench, source, state, 1)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda s: s["camera"].update(scale=float("nan")),
        lambda s: s["camera"].update(x=1000),
        lambda s: s["selection"].update(width=100),
        lambda s: s["selection"].update(level=1),
        lambda s: s["channels"][0].update(low=100, high=10),
        lambda s: s["channels"][0].update(visible="yes"),
        lambda s: s.update(interpretation="volume"),
    ],
)
def test_invalid_presentation_is_rejected_atomically(tmp_path, mutation):
    workbench, source, state, _ = fixture(tmp_path)
    expected = copy.deepcopy(save(workbench, source, state))
    mutation(state)
    with pytest.raises(ValueError):
        save(workbench, source, state, 1)
    assert workbench.execute("source_view", {"source_id": source["id"]}) == expected


def test_source_verification_reads_original_bytes_before_figure_publication(tmp_path):
    workbench, source, _state, original = fixture(tmp_path)
    assert workbench.execute("verify_source", {"source_id": source["id"]}) == {
        "source_id": source["id"],
        "source_sha256": source["sha256"],
    }
    # A registered display preference retains its identity; publication must
    # nevertheless reject even an in-place, same-length source alteration.
    (tmp_path / "scalar.tif").write_bytes(original[:-2] + bytes([original[-2] ^ 1, original[-1]]))
    with pytest.raises(ValueError, match="changed or is unavailable"):
        workbench.execute("verify_source", {"source_id": source["id"]})


def test_histogram_dispatch_keeps_source_plane_and_original_values(tmp_path):
    workbench, source, _state, original = fixture(tmp_path)
    response = workbench.execute(
        "viewer_histogram", {"source_id": source["id"], "t": 0, "z": 0, "bins": 32}
    )
    assert response["source_sha256"] == source["sha256"]
    assert sum(response["histograms"][0]["counts"]) == 1200
    assert (response["histograms"][0]["min"], response["histograms"][0]["max"]) == (0, 1199)
    assert (tmp_path / "scalar.tif").read_bytes() == original


def test_batch_channel_colors_by_index_and_undo(tmp_path):
    workbench, source, state, original = fixture(tmp_path)
    save(workbench, source, state)

    # 1. Preview mode
    preview = workbench.execute(
        "batch_channel_colors",
        {
            "source_ids": [source["id"]],
            "preview_only": True,
            "mapping_mode": "index",
            "color_map": {"0": "#00ffff"},
        },
    )
    assert preview == {
        "preview_only": True,
        "total_sources": 1,
        "applicable_count": 1,
        "applied_count": 0,
        "skipped_count": 0,
        "affected_sources": [
            {
                "source_id": source["id"],
                "source_name": source["name"],
                "revision": 1,
                "status": "ready",
                "reason": None,
                "changes": [
                    {
                        "channel": 0,
                        "channel_name": "Channel 1",
                        "old_color": "#ffffff",
                        "new_color": "#00ffff",
                    }
                ],
            }
        ],
        "previous_palettes": {source["id"]: [{"channel": 0, "color": "#ffffff"}]},
        "new_revisions": {source["id"]: 1},
    }
    # Verify not mutated
    current = workbench.execute("source_view", {"source_id": source["id"]})
    assert current["state"]["channels"][0]["color"] == "#ffffff"

    # 2. Apply mode
    res = workbench.execute(
        "batch_channel_colors",
        {
            "source_ids": [source["id"]],
            "preview_only": False,
            "mapping_mode": "index",
            "color_map": {"0": "#00ffff"},
        },
    )
    assert res["preview_only"] is False
    assert res["applied_count"] == 1
    assert res["affected_sources"][0]["status"] == "applied"
    assert res["affected_sources"][0]["revision"] == 2
    assert source["id"] in res["previous_palettes"]
    assert res["previous_palettes"][source["id"]][0]["color"] == "#ffffff"

    # Verify updated
    updated = workbench.execute("source_view", {"source_id": source["id"]})
    assert updated["state"]["channels"][0]["color"] == "#00ffff"
    # Verify other settings intact
    assert updated["state"]["channels"][0]["gamma"] == 1
    assert updated["state"]["channels"][0]["low"] == 0
    assert updated["state"]["channels"][0]["high"] == 65535
    assert (tmp_path / "scalar.tif").read_bytes() == original

    # 3. Undo with previous_palettes
    undo_res = workbench.execute(
        "batch_channel_colors",
        {
            "source_ids": [source["id"]],
            "mapping_mode": "restore",
            "restore_palettes": res["previous_palettes"],
        },
    )
    assert undo_res["applied_count"] == 1
    assert undo_res["affected_sources"][0]["status"] == "applied"
    restored = workbench.execute("source_view", {"source_id": source["id"]})
    assert restored["state"]["channels"][0]["color"] == "#ffffff"


def test_batch_channel_colors_skips_rgb_and_handles_differing_channels(tmp_path):
    workbench, source_scalar, state, _ = fixture(tmp_path)
    save(workbench, source_scalar, state)

    # Create 2-channel scalar image
    path_2ch = tmp_path / "2ch.tif"
    tifffile.imwrite(path_2ch, np.zeros((2, 20, 20), dtype=np.uint16), metadata={"axes": "CYX"})
    source_2ch = workbench.import_native(str(path_2ch))

    # Create RGB image
    path_rgb = tmp_path / "rgb.tif"
    tifffile.imwrite(path_rgb, np.zeros((20, 20, 3), dtype=np.uint8), photometric="rgb")
    source_rgb = workbench.import_native(str(path_rgb))

    # Batch recolor channel 0 and 1
    res = workbench.execute(
        "batch_channel_colors",
        {
            "source_ids": [source_scalar["id"], source_2ch["id"], source_rgb["id"]],
            "preview_only": False,
            "mapping_mode": "index",
            "color_map": {"0": "#ff0000", "1": "#00ff00"},
        },
    )
    assert res["applied_count"] == 2
    assert {
        item["source_id"]
        for item in res["affected_sources"]
        if item["status"] == "applied"
    } == {source_scalar["id"], source_2ch["id"]}
    skipped = [item for item in res["affected_sources"] if item["status"] == "skipped"]
    assert len(skipped) == 1
    assert skipped[0]["source_id"] == source_rgb["id"]
    assert "RGB/RGBA" in skipped[0]["reason"]

    # Check source_2ch got both colors
    v_2ch = workbench.execute("source_view", {"source_id": source_2ch["id"]})
    assert v_2ch["state"]["channels"][0]["color"] == "#ff0000"
    assert v_2ch["state"]["channels"][1]["color"] == "#00ff00"

    # Check source_scalar got channel 0 recolored, and was not broken by lack of channel 1
    v_scalar = workbench.execute("source_view", {"source_id": source_scalar["id"]})
    assert v_scalar["state"]["channels"][0]["color"] == "#ff0000"


def test_batch_channel_colors_name_mapping_and_stale_rejection(tmp_path):
    workbench, source, state, _ = fixture(tmp_path)
    save(workbench, source, state)

    # Test stale revision rejection
    with pytest.raises(ValueError, match="Saved view changed"):
        workbench.execute(
            "batch_channel_colors",
            {
                "source_ids": [source["id"]],
                "color_map": {"0": "#ff00ff"},
                "expected_revisions": {source["id"]: 999},
            },
        )

    # Test invalid color
    with pytest.raises(ValueError, match="6-digit hex"):
        workbench.execute(
            "batch_channel_colors",
            {
                "source_ids": [source["id"]],
                "color_map": {"0": "invalid"},
            },
        )

    # Test name mapping mode on 2ch image with channel names
    path_named = tmp_path / "named.tif"
    tifffile.imwrite(
        path_named,
        np.zeros((2, 20, 20), dtype=np.uint16),
        ome=True,
        metadata={"axes": "CYX", "Channel": {"Name": ["DAPI", "TRITC"]}},
    )
    source_named = workbench.import_native(str(path_named))

    # Name mapping: DAPI -> #112233, TRITC -> #445566
    res_name = workbench.execute(
        "batch_channel_colors",
        {
            "source_ids": [source_named["id"]],
            "mapping_mode": "name",
            "color_map": {"DAPI": "#112233", "TRITC": "#445566"},
        },
    )
    assert res_name["applied_count"] == 1
    v_named = workbench.execute("source_view", {"source_id": source_named["id"]})
    assert v_named["state"]["channels"][0]["color"] == "#112233"
    assert v_named["state"]["channels"][1]["color"] == "#445566"


def test_batch_channel_colors_preflights_later_stale_revision_before_any_write(tmp_path):
    workbench, first, state, _ = fixture(tmp_path)
    save(workbench, first, state)
    second_path = tmp_path / "second.tif"
    tifffile.imwrite(second_path, np.arange(1200, dtype=np.uint16).reshape(30, 40))
    second = workbench.import_native(str(second_path))
    save(workbench, second, copy.deepcopy(state))

    with pytest.raises(ValueError, match="Saved view changed"):
        workbench.execute(
            "batch_channel_colors",
            {
                "source_ids": [first["id"], second["id"]],
                "mapping_mode": "index",
                "color_map": {"0": "#ff00ff"},
                "expected_revisions": {first["id"]: 1, second["id"]: 999},
            },
        )

    first_view = workbench.execute("source_view", {"source_id": first["id"]})
    second_view = workbench.execute("source_view", {"source_id": second["id"]})
    assert first_view["revision"] == second_view["revision"] == 1
    assert first_view["state"]["channels"][0]["color"] == "#ffffff"
    assert second_view["state"]["channels"][0]["color"] == "#ffffff"


def test_batch_channel_colors_auto_mapping(tmp_path):
    workbench, source_unnamed, state, _ = fixture(tmp_path)
    save(workbench, source_unnamed, state)

    path_named = tmp_path / "named_auto.tif"
    tifffile.imwrite(
        path_named,
        np.zeros((2, 20, 20), dtype=np.uint16),
        ome=True,
        metadata={"axes": "CYX", "Channel": {"Name": ["DAPI", "GFP"]}},
    )
    source_named = workbench.import_native(str(path_named))

    # Auto mapping with name match for "DAPI" and fallback index 0/1 for unnamed
    res = workbench.execute(
        "batch_channel_colors",
        {
            "source_ids": [source_named["id"], source_unnamed["id"]],
            "mapping_mode": "auto",
            "color_map": {"DAPI": "#aabbcc", "GFP": "#ddeeff", "0": "#123456", "1": "#654321"},
        },
    )
    assert res["applied_count"] == 2
    v_named = workbench.execute("source_view", {"source_id": source_named["id"]})
    assert v_named["state"]["channels"][0]["color"] == "#aabbcc"
    assert v_named["state"]["channels"][1]["color"] == "#ddeeff"

    v_unnamed = workbench.execute("source_view", {"source_id": source_unnamed["id"]})
    assert v_unnamed["state"]["channels"][0]["color"] == "#123456"
