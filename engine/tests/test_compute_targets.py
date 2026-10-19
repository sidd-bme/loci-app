import base64
import hashlib
import json
import struct
from copy import deepcopy
from pathlib import Path

import pytest
from test_research_compute import advance, setup
from test_research_remote import _profile_request, _project

from loci_engine import compute_targets as targets
from loci_engine import research_remote as remote
from loci_engine.remote_compute import CommandResult
from loci_engine.research_project import ResearchProject
from loci_engine.research_rpc import dispatch_research


def binding(profile):
    return {"id": profile["id"], "revision": profile["revision"]}


def test_saved_targets_cross_studies_without_sources_or_implicit_transfers(tmp_path):
    study, workbench, _ = _project(tmp_path)
    workbench.execute("remote_profile_save", _profile_request(tmp_path))
    store = str(tmp_path / "settings.loci-study")
    saved = targets.dispatch(store, "remember", {"alias": "vanda", "expected_revision": 0}, study)[
        "profile"
    ]
    public = targets.dispatch(store, "list", {})
    assert str(tmp_path) not in json.dumps(public)
    assert public["targets"] == [saved] and public["study_profiles"] == []
    config = ResearchProject(store)
    original_hosts = Path(
        remote._load_profile(study, "vanda")["data"]["private_profile"]["known_hosts_file"]
    )
    saved_hosts = Path(
        remote._load_profile(config, "vanda")["data"]["private_profile"]["known_hosts_file"]
    )
    assert saved_hosts != original_hosts and saved_hosts.read_bytes() == original_hosts.read_bytes()
    original_hosts.unlink()
    assert config.list_sources() == [] and config.list_results() == []
    assert not config.root.stat().st_mode & 0o077
    second = ResearchProject.create(tmp_path / "second.loci-study", "Separate study")
    used = targets.dispatch(store, "use", binding(saved), second)
    assert used["profile"]["alias"] == "vanda" and used["target"] == binding(saved)
    assert remote._runs(second) == []
    assert targets.dispatch(store, "use", binding(saved), second) == used
    targets.dispatch(store, "forget", binding(saved))
    assert targets.dispatch(store, "list", {})["targets"] == []
    assert len(remote._profiles(second)) == 1


def test_future_target_edits_preserve_submitted_run_settings_and_global_revision(
    tmp_path, monkeypatch
):
    study, workbench, _, state, _, _, authorized = setup(tmp_path, monkeypatch)
    store = str(tmp_path / "settings.loci-study")
    saved = targets.dispatch(store, "remember", {"alias": "vanda", "expected_revision": 0}, study)[
        "profile"
    ]
    targets.dispatch(store, "use", binding(saved), study)
    authorized["plan_sha256"] = workbench.execute("remote_analysis_plan", authorized["analysis"])[
        "plan"
    ]["plan_sha256"]
    run = workbench.execute("remote_analysis_start", authorized)["run"]
    assert run["app_target"] == binding(saved)
    before = deepcopy(
        remote._load_run(study, run["request_key"])["data"]["private_profile_snapshot"]
    )
    changed = targets.dispatch(
        store,
        "resources",
        {
            **binding(saved),
            "resources": {
                **saved["resources"],
                "cpus": 8,
            },
        },
    )["profile"]
    with pytest.raises(ValueError, match="changed"):
        targets.dispatch(store, "use", binding(saved), study)
    targets.dispatch(store, "use", binding(changed), study)
    assert advance(workbench)["state"] == "finished"
    assert advance(workbench)["state"] == "retrieved"
    assert advance(workbench)["state"] == "attached"
    assert state.submit_calls == 1
    current = remote._load_run(study, run["request_key"])["data"]
    assert current["private_profile_snapshot"] == before
    assert current["app_target"] == binding(saved) and current["resources"]["cpus"] != 8


def ssh_fixture(tmp_path, monkeypatch, *, key_line=None, config_extra=""):
    known = tmp_path / "known_hosts"
    known.write_text("fixture file read only by the fake ssh-keygen\n")
    identity = tmp_path / "identity"
    identity.write_text("not read by importer")
    wire = struct.pack(">I", 11) + b"ssh-ed25519" + struct.pack(">I", 32) + bytes(range(32))
    encoded = base64.b64encode(wire).decode()
    line = key_line or f"[fixture.example]:2222 ssh-ed25519 {encoded}\n"
    calls = []

    class Runner:
        def run(self, args, **_kwargs):
            calls.append(args)
            if args[:2] == ["ssh", "-G"]:
                return CommandResult(
                    0,
                    f"hostname fixture.example\nport 2222\n"
                    f"userknownhostsfile {known}\nidentityfile {identity}\n" + config_extra,
                    "",
                )
            assert args[:2] == ["ssh-keygen", "-F"]
            return CommandResult(0, line, "")

    monkeypatch.setattr(targets, "_runner_factory", Runner)
    return calls, known, identity, wire


def test_alias_import_pins_one_previously_trusted_key_and_returns_no_private_paths(
    tmp_path, monkeypatch
):
    calls, known, identity, wire = ssh_fixture(tmp_path, monkeypatch)
    before = known.read_bytes()
    store = str(tmp_path / "settings.loci-study")
    draft = targets.dispatch(store, "import_ssh", {"alias": "fixture"})["draft"]
    assert draft["host_key_sha256"] == "SHA256:" + base64.b64encode(
        hashlib.sha256(wire).digest()
    ).decode().rstrip("=")
    assert str(tmp_path) not in json.dumps(draft) and "fixture.example" not in json.dumps(draft)
    assert known.read_bytes() == before
    assert all(call[0] == "ssh-keygen" or call[:2] == ["ssh", "-G"] for call in calls)
    profile = targets.dispatch(
        store,
        "save",
        {
            "draft_id": draft["id"],
            "draft_revision": draft["revision"],
            "expected_revision": 0,
            "runtime_python": "/opt/loci/python",
            "remote_project_root": "/scratch/fixture/inputs",
            "remote_output_root": "/scratch/fixture/results",
            "scheduler": "pbspro",
            "scheduler_bin_dir": "/opt/pbs/bin",
            "queue": "fixture",
            "account": None,
            "resources": {"cpus": 2, "memory_mb": 4096, "wall_minutes": 10, "gpus": 0},
        },
    )["profile"]
    private = remote._load_profile(ResearchProject(store), "fixture")["data"]["private_profile"]
    assert private["identity_file"] == str(identity)
    assert Path(private["known_hosts_file"]).parent == Path(store) / "ssh-hosts"
    assert (
        Path(private["known_hosts_file"])
        .read_text()
        .startswith("[fixture.example]:2222 ssh-ed25519 ")
    )
    assert Path(private["known_hosts_file"]).stat().st_mode & 0o777 == 0o600
    assert profile["runtime_ready"] is False
    assert targets.dispatch(store, "list", {})["targets"] == [profile]


@pytest.mark.parametrize("attack", ["unknown", "revoked", "ambiguous", "bad_alias"])
def test_alias_import_rejects_untrusted_and_ambiguous_keys_without_a_profile(
    tmp_path, monkeypatch, attack
):
    _, _, _, wire = ssh_fixture(tmp_path, monkeypatch)
    encoded = base64.b64encode(wire).decode()
    line = {
        "unknown": "# No matching key\n",
        "revoked": f"@revoked fixture ssh-ed25519 {encoded}\n",
        "ambiguous": (
            f"fixture ssh-ed25519 {encoded}\n"
            f"fixture ssh-ed25519 {base64.b64encode(wire + b'x').decode()}\n"
        ),
    }.get(attack)
    if line:
        ssh_fixture(tmp_path, monkeypatch, key_line=line)
    store = str(tmp_path / "settings.loci-study")
    with pytest.raises(ValueError):
        targets.dispatch(
            store, "import_ssh", {"alias": "fixture;echo" if attack == "bad_alias" else "fixture"}
        )
    assert targets.dispatch(store, "list", {})["targets"] == []


def test_revision_and_rpc_boundaries_fail_closed(tmp_path):
    study, workbench, _ = _project(tmp_path)
    workbench.execute("remote_profile_save", _profile_request(tmp_path))
    store = str(tmp_path / "settings.loci-study")
    saved = targets.dispatch(store, "remember", {"alias": "vanda", "expected_revision": 0}, study)[
        "profile"
    ]
    for operation in ("use", "test", "forget", "resources"):
        request = {**binding(saved), "revision": saved["revision"] + 1}
        if operation == "resources":
            request["resources"] = saved["resources"]
        with pytest.raises(ValueError, match="changed"):
            targets.dispatch(store, operation, request, study)
    with pytest.raises(remote.ResearchRemoteError, match="resource policy"):
        targets.dispatch(
            store, "resources", {**binding(saved), "resources": {**saved["resources"], "gpus": -1}}
        )
    with pytest.raises(ValueError):
        dispatch_research(
            "research_compute_targets",
            {
                "directory": store,
                "operation": "list",
                "request": {},
                "project": None,
                "shell": "anything",
            },
        )
    link = tmp_path / "linked.loci-study"
    link.symlink_to(store)
    with pytest.raises(ValueError):
        targets.dispatch(str(link), "list", {})
    assert targets.dispatch(store, "list", {})["targets"] == [saved]
