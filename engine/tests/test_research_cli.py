import json
import subprocess
import sys

import numpy as np
import pytest
import tifffile

from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench


def test_annotation_request_transport_has_a_separate_bounded_utf8_budget(tmp_path):
    from loci_engine.research_cli import _request

    encoded = json.dumps({"payload": "界" * 400_000}, ensure_ascii=False)
    source = tmp_path / "annotation.json"
    source.write_text(encoded, encoding="utf-8")
    with pytest.raises(ValueError, match="1 MiB"):
        _request("@" + str(source))
    assert _request("@" + str(source), 12 * 1024**2)["payload"] == "界" * 400_000
    with pytest.raises(ValueError, match="1 MiB"):
        _request(encoded)


def cli(*args):
    output = subprocess.run(
        [sys.executable, "-m", "loci_engine.research_cli", *args],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return json.loads(output.stdout)


def test_real_cli_import_preview_run_retry_review_export_and_reopen(tmp_path):
    project_path = str(tmp_path / "study")
    cli("create", "--project", project_path, "--title", "CLI study")
    image = np.zeros((16, 20), np.uint16)
    image[3:6, 8:12] = 123
    file = tmp_path / "source.tif"
    tifffile.imwrite(file, image)
    imported = cli("import", "--project", project_path, str(file))
    source_id = imported["sources"][0]["id"]
    request = {
        "source_id": source_id,
        "recipe": {
            "segmentation": {"method": "components", "threshold": 100},
        },
    }
    encoded = json.dumps(request)
    preview = cli("execute", "--project", project_path, "preview_recipe", "--request", encoded)
    assert preview["object_count"] == 1
    assert preview["adopted"] is False
    result = cli(
        "submit",
        "--project",
        project_path,
        "--request",
        encoded,
        "--request-key",
        "stable",
        "--run",
    )
    repeated = cli(
        "submit",
        "--project",
        project_path,
        "--request",
        encoded,
        "--request-key",
        "stable",
        "--run",
    )
    assert repeated["job"]["result_ids"] == [result["result"]["id"]]
    gui_engine = Workbench(ResearchProject(project_path))
    gui_preview = gui_engine.execute("preview_recipe", request)
    assert gui_preview["measurements"] == preview["measurements"] == result["measurements"]
    cli(
        "review",
        "--project",
        project_path,
        "--result",
        result["result"]["id"],
        "--revision",
        result["result"]["revision_hash"],
        "--disposition",
        "reviewed",
    )
    cli(
        "export",
        "--project",
        project_path,
        "--result",
        result["result"]["id"],
        "--revision",
        result["result"]["revision_hash"],
        "--destination",
        str(tmp_path / "output"),
    )
    reopened = cli("snapshot", "--project", project_path)
    assert reopened["results"][0]["review"]["disposition"] == "reviewed"
    assert len(reopened["results"]) == 1
    assert np.array_equal(tifffile.imread(tmp_path / "output" / "image.ome.tif"), image)
    assert str(tmp_path) not in json.dumps(result)


def test_frozen_style_cli_dispatch_and_unknown_operation():
    output = subprocess.run(
        [sys.executable, "-m", "loci_engine.worker", "--cli", "discover"],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    assert "run_recipe" in json.loads(output.stdout)["operations"]


def test_mcp_startup_failure_is_generic_and_does_not_disclose_policy_path(tmp_path):
    missing = tmp_path / "private-study-name" / "private-policy-name.json"
    output = subprocess.run(
        [
            sys.executable,
            "-m",
            "loci_engine.research_cli",
            "mcp",
            "--policy",
            str(missing),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert output.returncode == 1
    assert output.stdout == ""
    assert json.loads(output.stderr) == {
        "error": {
            "type": "MCPStartupError",
            "message": "The local research tool server could not start.",
        }
    }
    assert str(tmp_path) not in output.stderr
    assert "private-study-name" not in output.stderr
    assert "private-policy-name.json" not in output.stderr
    assert "Traceback" not in output.stderr
