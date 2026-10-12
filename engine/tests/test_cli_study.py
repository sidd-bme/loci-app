"""Human study commands exercise real measured populations without changing state."""

import hashlib
import json
import shlex

import numpy as np
import pytest
import tifffile
from test_cli_process import pty_cli
from test_cli_readable_population import invoke

from loci_engine.cli import _json
from loci_engine.quantitative import Geometry, measure_objects
from loci_engine.research_project import ResearchProject
from loci_engine.terminal import _width, render
from loci_engine.terminal_session import StudySession
from loci_engine.workbench import Workbench


@pytest.fixture
def measured_study(tmp_path):
    def create(*, axes="YX", multiple=False, warnings=None, objects=3, unit="um"):
        shape = (64, 128) if axes == "YX" else (2, 64, 128)
        image = np.zeros(shape, dtype=np.uint16)
        labels = np.zeros(shape, dtype=np.uint32)
        regions = ((101, (5, 5), 2), (102, (10, 20), 3), (103, (25, 40), 4))
        for label, start, edge in regions[:objects]:
            region = (slice(start[0], start[0] + edge), slice(start[1], start[1] + edge))
            if axes == "ZYX":
                region = (slice(None), *region)
            labels[region] = label
            image[region] = label
        file = tmp_path / "synthetic.tif"
        tifffile.imwrite(file, image, metadata={"axes": axes}, photometric="minisblack")
        geometry = Geometry(
            axes, ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 2, 0), (0, 0, 0, 1)), unit, "image"
        )
        project = ResearchProject.create(tmp_path / "cells.loci-study", "Synthetic study")
        workbench = Workbench(project)
        source = workbench.import_native(str(file))
        provenance = {
            "geometry": geometry.to_dict(),
            "measurements": measure_objects(labels, geometry, {"raw": image}),
        }
        if warnings:
            provenance["warnings"] = warnings
        result = project.save_result(
            source_id=source["id"],
            kind="segmentation",
            arrays={"image": image, "labels": labels},
            provenance=provenance,
        )
        if multiple:
            project.save_result(
                source_id=source["id"],
                kind="segmentation",
                arrays={"image": image, "labels": labels},
                provenance={**provenance, "note": "second explicit result"},
                parent_id=result["id"],
            )
        workbench.close()
        return project, result, file

    return create


def state_hashes(project, source):
    paths = [source, *[p for p in project.root.rglob("*") if p.is_file()]]
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def open_session(project):
    session = StudySession()
    opened = invoke(*session.prepare("open " + shlex.quote(str(project.root))))
    assert opened.returncode == 0, opened.stderr
    assert "exact revision pinned" in session.finish(opened.stdout, opened.returncode)
    return session


@pytest.mark.parametrize("axes,flag,bounds", [("YX", "area", "4:16"), ("ZYX", "volume", "16:64")])
def test_objects_native_units_label_order_exact_json_and_read_only(
    measured_study, monkeypatch, tmp_path, axes, flag, bounds
):
    project, result, source = measured_study(axes=axes)
    before = state_hashes(project, source)
    monkeypatch.chdir(tmp_path)
    opened = invoke("--plain", "open", "cells.loci-study")
    assert opened.returncode == 0, opened.stderr
    assert "Synthetic study" in opened.stdout and "exact revision verified" in opened.stdout
    args = [
        "objects",
        "--project",
        "cells.loci-study",
        "--" + flag,
        bounds,
        "--spacing",
        "10:30",
        "--limit",
        "3",
    ]
    machine = invoke("--json", *args)
    assert machine.returncode == 0, machine.stderr
    receipt = json.loads(machine.stdout)
    request = {
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "x_metric": "measure",
        "y_metric": "nearest_centroid_distance",
        "filters": [
            {
                "metric": "measure",
                "min": float(bounds.split(":")[0]),
                "max": float(bounds.split(":")[1]),
            },
            {"metric": "nearest_centroid_distance", "min": 10.0, "max": 30.0},
        ],
        "limit": 3,
    }
    workbench = Workbench(project)
    expected = workbench.execute("population_query", request)
    workbench.close()
    assert machine.stdout == _json(expected) + "\n"
    assert [row["label"] for row in receipt["rows"]] == [101, 102, 103]
    assert len({row["values"]["measure"] for row in receipt["rows"]}) == 3
    underlying = invoke(
        "--json",
        "execute",
        "population_query",
        "--project",
        str(project.root),
        "--request",
        json.dumps(request),
    )
    assert underlying.stdout == machine.stdout
    human = invoke("--plain", *args)
    assert human.returncode == 0, human.stderr
    assert "Objects: 3 of 3 after filters" in human.stdout
    assert "Review: not reviewed" in human.stdout
    assert ("Area (um^2)" if axes == "YX" else "Volume (um^3)") in human.stdout
    assert "Nearest centroid distance (um)" in human.stdout
    assert result["revision_hash"] not in human.stdout
    assert "\x1b" not in human.stdout
    assert state_hashes(project, source) == before


def test_locate_exact_json_coordinates_and_review_warning_preservation(measured_study):
    project, result, source = measured_study(warnings=["Synthetic warning\u202e\x1b[31m"])
    project.review(result["id"], result["revision_hash"], "excluded")
    before = state_hashes(project, source)
    actual = invoke("--json", "locate", "102", "--project", str(project.root))
    expected = invoke(
        "--json",
        "execute",
        "population_locate",
        "--project",
        str(project.root),
        "--request",
        json.dumps(
            {"result_id": result["id"], "revision_hash": result["revision_hash"], "label": 102}
        ),
    )
    assert actual.returncode == expected.returncode == 0
    assert actual.stdout == expected.stdout
    human = invoke("--plain", "locate", "102", "--project", str(project.root))
    assert "Y=11, X=21" in human.stdout
    assert "Review: excluded" in human.stdout
    assert "Synthetic warning\\u202e\\x1b[31m" in human.stdout
    assert "\u202e" not in human.stdout and "\x1b" not in human.stdout
    assert state_hashes(project, source) == before


def test_ambiguity_requires_explicit_selection_and_never_switches_to_child(measured_study):
    project, result, source = measured_study(multiple=True)
    before = state_hashes(project, source)
    session = StudySession()
    opened = invoke(*session.prepare("open " + shlex.quote(str(project.root))))
    text = session.finish(opened.stdout, opened.returncode)
    assert "2; no result selected" in text
    assert session.opened["selected"] is None
    with pytest.raises(ValueError, match="select"):
        session.prepare("objects --limit 3")
    ambiguous = invoke("--plain", "objects", "--project", str(project.root))
    assert ambiguous.returncode == 1 and not ambiguous.stdout
    assert "--result ID explicitly" in ambiguous.stderr
    chosen = invoke(*session.prepare("select 1"))
    session.finish(chosen.stdout, chosen.returncode)
    assert session.opened["selected"]["result_id"] == result["id"]
    argv = session.prepare("objects --limit 3")
    assert argv[argv.index("--revision") + 1] == result["revision_hash"]
    assert invoke(*argv).returncode == 0
    assert state_hashes(project, source) == before


def test_mismatched_binding_fails_until_explicit_refresh_and_failure_keeps_state(measured_study):
    project, result, source = measured_study()
    before = state_hashes(project, source)
    session = open_session(project)
    session.opened["selected"]["revision_hash"] = "0" * 64
    for line in ("objects --limit 3", "locate 102"):
        stale = invoke(*session.prepare(line))
        assert stale.returncode == 1 and not stale.stdout
        assert "exact result revision" in stale.stderr
    failed = invoke(*session.prepare("open /nonexistent/study"))
    session.finish(failed.stderr, failed.returncode)
    assert session.opened["selected"]["revision_hash"] == "0" * 64
    fresh = invoke(*session.prepare("refresh"))
    session.finish(fresh.stdout, fresh.returncode)
    assert session.opened["selected"]["revision_hash"] == result["revision_hash"]
    assert invoke(*session.prepare("objects --limit 3")).returncode == 0
    assert state_hashes(project, source) == before


@pytest.mark.parametrize(
    "options",
    [
        ["--area", "nan:10"],
        ["--area", "1:inf"],
        ["--area", "-1:10"],
        ["--area", "10:1"],
        ["--spacing", "1:2:3"],
        ["--limit", "0"],
        ["--limit", "201"],
        ["--volume", "1:100"],
    ],
)
def test_invalid_ranges_limits_and_wrong_dimensions_fail_without_output(measured_study, options):
    project, _, source = measured_study()
    before = state_hashes(project, source)
    output = invoke("--plain", "objects", "--project", str(project.root), *options)
    assert output.returncode in (1, 2) and not output.stdout
    assert "Loci:" in output.stderr
    assert state_hashes(project, source) == before


def test_open_symlink_missing_source_and_literal_shell_text_do_not_bind(measured_study, tmp_path):
    project, _, source = measured_study()
    symlink = tmp_path / "alias.loci-study"
    symlink.symlink_to(project.root, target_is_directory=True)
    output = invoke("--plain", "open", str(symlink))
    assert output.returncode == 1 and not output.stdout
    session = open_session(project)
    original = session.opened
    marker = tmp_path / "unwanted"
    literal = "open " + shlex.quote(f"$(touch {marker})")
    output = invoke(*session.prepare(literal))
    session.finish(output.stderr, output.returncode)
    assert not marker.exists() and session.opened is original
    source.unlink()
    output = invoke(*session.prepare("open " + shlex.quote(str(project.root))))
    assert output.returncode == 1
    session.finish(output.stderr, output.returncode)
    assert session.opened is original


def test_open_receipt_memory_bound_and_narrow_safe_views(measured_study):
    from loci_engine.cli import parser
    from loci_engine.cli_study import execute

    project, _, _ = measured_study()
    session = open_session(project)
    original = session.opened
    assert "unchanged" in session.finish("x" * (256 * 1024 + 1), 0)
    assert session.opened is original
    for width in (1, 12, 40, 80):
        text = render("open", original, width)
        assert all(_width(line) <= width for line in text.splitlines())
    receipt, context = execute(parser().parse_args(["objects", "--project", str(project.root)]))
    for width in (1, 12, 40, 80):
        text = render("objects", receipt, width, context=context)
        assert all(_width(line) <= width for line in text.splitlines())
    wide = render("objects", receipt, 120, context=context)
    assert (
        len([line for line in wide.splitlines() if line.startswith(("101 ", "102 ", "103 "))]) == 3
    )


@pytest.mark.parametrize("objects", [0, 1])
def test_empty_and_missing_distances_are_explicit_in_pixel_units(measured_study, objects):
    project, _, source = measured_study(objects=objects, unit="pixel")
    before = state_hashes(project, source)
    human = invoke("--plain", "objects", "--project", str(project.root))
    assert human.returncode == 0, human.stderr
    assert f"Objects: {objects} of {objects} after filters" in human.stdout
    if objects:
        assert "Area (pixel^2)" in human.stdout
        assert "not available" in human.stdout
        assert "Missing Nearest centroid distance (pixel): 1" in human.stdout
        filtered = invoke(
            "--plain", "objects", "--project", str(project.root), "--spacing", "0:100"
        )
        assert filtered.returncode == 0
        assert "Objects: 0 of 1 after filters" in filtered.stdout
        assert "missing filter values: 1" in filtered.stdout
    assert state_hashes(project, source) == before


def test_real_pty_open_objects_locate_and_command_history(measured_study):
    pytest.importorskip("curses")
    project, _, source = measured_study()
    before = state_hashes(project, source)
    status, text = pty_cli(
        [],
        session_script=[
            (b"loci> ", 0.1, ("open " + shlex.quote(str(project.root)) + "\r").encode()),
            (b"exact revision pinned", 0.1, b"objects --area 4:16 --spacing 10:30 --limit 3\r"),
            (b"Showing 3 objects", 0.1, b"locate 102\r"),
            # Clear old output before recalling the command. A curses redraw of
            # the first locate result is not acknowledgement of the second run.
            ((b"Running locate 102", b"Exit 0"), 0.1, b"\x0c\x1bOA\r"),
            ((b"Running locate 102", b"Exit 0"), 0.1, b"\x04"),
        ],
    )
    assert status == 0
    assert "Study: Synthetic study" in text
    assert "objects --area 4:16" in text
    assert text.count("Y=11, X=21") >= 2
    assert "\x1b[?25h" in text
    assert state_hashes(project, source) == before
