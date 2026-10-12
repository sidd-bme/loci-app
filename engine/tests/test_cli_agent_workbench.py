import hashlib
import json

from test_agent_policy import make_study
from test_research_agent_setup import access_request, interactive_request

from loci_engine.cli import main
from loci_engine.research_rpc import dispatch_research


def test_human_cli_creates_source_bound_vision_and_local_plugin(tmp_path, capsys):
    workbench, source, recipe = make_study(tmp_path)
    before = hashlib.sha256((tmp_path / "synthetic.tif").read_bytes()).hexdigest()
    request = {
        "source_id": source["id"],
        "selection": {
            "x": 0,
            "y": 0,
            "width": 32,
            "height": 32,
            "t": 0,
            "c": 0,
            "z": 1,
            "level": 0,
        },
        "channels": [
            {
                "channel": 0,
                "low": 0,
                "high": 100,
                "gamma": 1,
                "color": "#ff0000",
                "visible": True,
                "opacity": 1,
            }
        ],
        "projection": "plane",
        "max_size": 64,
    }
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request))
    destination = tmp_path / "candidate.loci-vision"
    assert (
        main(
            [
                "--json",
                "vision-handoff",
                "--project",
                str(workbench.project.root),
                "--request",
                "@" + str(request_path),
                "--destination",
                str(destination),
            ]
        )
        == 0
    )
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["source_sha256"] == before == source["sha256"]
    assert receipt["status"] == "provisional-visualization"
    assert set(receipt["artifacts"]) == {"image.png", "context.json", "README.md", "manifest.json"}
    for name, meta in receipt["artifacts"].items():
        assert hashlib.sha256((destination / name).read_bytes()).hexdigest() == meta["sha256"]
    config = access_request(
        recipe,
        disclosures=["previews"],
        interactive=interactive_request(allow_image=True, channels=[0]),
    )
    request_path.write_text(json.dumps(config))
    access = tmp_path / "access"
    assert (
        main(
            [
                "--json",
                "agent-access",
                "--project",
                str(workbench.project.root),
                "--request",
                "@" + str(request_path),
                "--destination",
                str(access),
            ]
        )
        == 0
    )
    result = json.loads(capsys.readouterr().out)
    assert result["schema"] == "loci.agent-policy/v3"
    assert (access / "plugin" / "plugin.json").is_file()
    assert workbench.project.list_results() == []
    assert hashlib.sha256((tmp_path / "synthetic.tif").read_bytes()).hexdigest() == before


def test_native_rpc_rejects_stale_source_before_handoff_publication(tmp_path):
    import pytest

    workbench, source, _ = make_study(tmp_path)
    destination = tmp_path / "wrong.loci-vision"
    with pytest.raises(ValueError, match="identity"):
        dispatch_research(
            "research_vision_handoff",
            {
                "project": str(workbench.project.root),
                "request": {"source_id": source["id"]},
                "source_sha256": "0" * 64,
                "destination": str(destination),
            },
        )
    assert not destination.exists()
