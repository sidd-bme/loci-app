"""Actual CLI population views over synthetic, revision-bound measured results."""

import json
import os
import subprocess
import sys

import numpy as np
import pytest
import tifffile

from loci_engine.cli import _json
from loci_engine.quantitative import Geometry, measure_objects
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


def invoke(*args):
    launcher = os.environ.get("LOCI_TEST_CLI_LAUNCHER")
    executable = os.environ.get("LOCI_TEST_CLI_EXECUTABLE")
    command = (
        [launcher]
        if launcher
        else [executable, "--loci"]
        if executable
        else [sys.executable, "-m", "loci_engine.cli"]
    )
    return subprocess.run([*command, *args], capture_output=True, text=True, timeout=30)


@pytest.mark.parametrize(
    "axes,shape,point", [("YX", (8, 12), [3, 7]), ("ZYX", (2, 8, 12), [1, 3, 7])]
)
def test_real_population_query_and_locate_keep_exact_receipts_and_review(
    tmp_path, axes, shape, point
):
    image = np.zeros(shape, dtype=np.uint16)
    image[tuple(point)] = 121
    source_file = tmp_path / "synthetic.tif"
    tifffile.imwrite(source_file, image, metadata={"axes": axes}, photometric="minisblack")
    original_source = source_file.read_bytes()
    labels = np.zeros(shape, dtype=np.uint32)
    labels[tuple(point)] = 90000
    study = tmp_path / "synthetic.loci-study"
    project = ResearchProject.create(study, "CLI presentation fixture")
    workbench = Workbench(project)
    source = workbench.import_native(str(source_file))
    geometry = Geometry(
        axes,
        ((0.5, 0, 0, 0), (0, 2, 0, 0), (0, 0, 3, 0), (0, 0, 0, 1)),
        "um",
        "image",
    )
    result = project.save_result(
        source_id=source["id"],
        kind="segmentation",
        arrays={"image": image, "labels": labels},
        provenance={
            "geometry": geometry.to_dict(),
            "measurements": measure_objects(labels, geometry, {"raw": image}),
        },
    )
    request = {"result_id": result["id"], "revision_hash": result["revision_hash"]}
    query = workbench.execute("population_query", request)
    located = workbench.execute("population_locate", {**request, "label": 90000})
    review_before = project.review_state(result["id"])
    assert review_before is None
    workbench.close()

    for operation, payload, expected in (
        ("population_query", request, query),
        ("population_locate", {**request, "label": 90000}, located),
    ):
        arguments = [
            "execute",
            operation,
            "--project",
            str(study),
            "--request",
            json.dumps(payload),
        ]
        machine = invoke("--json", *arguments)
        assert machine.returncode == 0, machine.stderr
        assert machine.stdout == _json(expected) + "\n"
        human = invoke("--plain", *arguments)
        assert human.returncode == 0, human.stderr
        assert "\x1b" not in human.stdout + human.stderr
        assert result["revision_hash"] not in human.stdout
        assert source["sha256"] not in human.stdout
        assert result["id"] in human.stdout
        if operation == "population_query":
            assert "Objects: 1 of 1 after filters" in human.stdout
            assert (
                "Area (um^2)" in human.stdout if axes == "YX" else "Volume (um^3)" in human.stdout
            )
            assert "Finite: 1; missing: 0" in human.stdout
            assert "Scatter: 1 of 1 finite pairs; missing pairs: 0" in human.stdout
        else:
            assert "Label: 90000" in human.stdout
            assert (
                ", ".join(f"{axis}={value}" for axis, value in zip(axes, point, strict=True))
                in human.stdout
            )
    reopened = Workbench(ResearchProject(study))
    try:
        assert reopened.project.review_state(result["id"]) == review_before
        stale = invoke(
            "--plain",
            "execute",
            "population_query",
            "--project",
            str(study),
            "--request",
            json.dumps({**request, "revision_hash": "0" * 64}),
        )
        assert stale.returncode == 1
        assert stale.stdout == ""
        assert "exact result revision" in stale.stderr
    finally:
        reopened.close()
    assert source_file.read_bytes() == original_source
