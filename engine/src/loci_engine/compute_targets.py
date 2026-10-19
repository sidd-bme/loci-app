"""Private application-wide compute settings; accessible only through desktop RPC.

The store reuses the transactional profile records. No source is registered here,
and resolving an SSH alias never connects to a host or transfers study data.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import shlex
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from . import research_remote as remote
from .remote_compute import RemoteComputeError, SubprocessRunner
from .research_project import ResearchProject, checked_id, timestamp
from .working_result import _sha256_file_stable

DRAFT_SCHEMA = "loci.compute-ssh-import/v1"
_ALIAS = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_runner_factory = SubprocessRunner


def _pin_file(project: ResearchProject, content: bytes) -> Path:
    hosts = project.root / "ssh-hosts"
    hosts.mkdir(mode=0o700, exist_ok=True)
    if (
        hosts.is_symlink()
        or not hosts.is_dir()
        or hosts.stat().st_mode & 0o077
        or hosts.stat().st_uid != os.getuid()
    ):
        raise ValueError("The private host identity directory is invalid")
    pinned = hosts / hashlib.sha256(content).hexdigest()
    if pinned.exists() or pinned.is_symlink():
        if (
            pinned.is_symlink()
            or not pinned.is_file()
            or pinned.stat().st_size != len(content)
            or pinned.stat().st_mode & 0o077
            or pinned.stat().st_uid != os.getuid()
            or pinned.read_bytes() != content
        ):
            raise ValueError("The saved host identity changed")
    else:
        with pinned.open("xb") as stream:
            os.chmod(pinned, 0o600)
            stream.write(content)
    return pinned


def _store(directory: str) -> ResearchProject:
    if os.name != "posix":
        raise ValueError("Saved SSH compute targets currently require macOS or Linux")
    root = Path(directory)
    if not root.is_absolute() or root.is_symlink():
        raise ValueError("Compute settings need a private application directory")
    if not root.exists():
        ResearchProject.create(root, "Private compute targets")
    project = ResearchProject(root)
    if project.root.stat().st_uid != os.getuid() or project.root.stat().st_mode & 0o077:
        raise ValueError("Compute settings must be private to this account")
    return project


def _revision(value: object, *, zero: bool = False) -> int:
    if type(value) is not int or value < (0 if zero else 1):
        raise ValueError("Choose the current compute target revision")
    return value


def _target(project: ResearchProject, request: dict[str, Any]) -> dict[str, Any]:
    target_id = checked_id(request["id"])
    revision = _revision(request["revision"])
    matches = [item for item in remote._profiles(project) if item["id"] == target_id]
    if len(matches) != 1 or matches[0]["revision"] != revision:
        raise ValueError("Compute target changed; reload Settings before continuing")
    remote._profile_from_data(matches[0]["data"])
    return matches[0]


def _import_ssh(project: ResearchProject, request: dict[str, Any]) -> dict[str, Any]:
    remote._exact(request, {"alias"}, "SSH alias import")
    alias = request["alias"]
    if not isinstance(alias, str) or not _ALIAS.fullmatch(alias):
        raise ValueError("Enter one SSH alias from your OpenSSH configuration")
    runner = _runner_factory()
    resolved = runner.run(["ssh", "-G", "--", alias], output_limit=64 * 1024)
    if resolved.returncode:
        raise RemoteComputeError("OpenSSH could not resolve this alias")
    fields: dict[str, list[str]] = {}
    for line in resolved.stdout.splitlines():
        key, separator, value = line.partition(" ")
        if separator:
            fields.setdefault(key, []).append(value.strip())
    host = fields.get("hostname", [""])[0]
    port = fields.get("port", ["22"])[0]
    host_alias = fields.get("hostkeyalias", [""])[0]
    if host_alias.lower() == "none":
        host_alias = ""
    if not host or not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise ValueError("OpenSSH returned an invalid alias destination")
    lookup = host_alias or (host if port == "22" else f"[{host}]:{port}")
    if not re.fullmatch(r"[A-Za-z0-9._:\[\]-]+", lookup):
        raise ValueError("OpenSSH returned an unsupported host identity")
    keys: list[tuple[str, str]] = []
    for value in fields.get("userknownhostsfile", []):
        for name in shlex.split(value):
            source = Path(name).expanduser()
            if not source.is_absolute() or source.is_symlink() or not source.is_file():
                continue
            if source.stat().st_size > 4 * 1024**2:
                raise ValueError("The SSH host file exceeds the supported import size")
            found = runner.run(
                ["ssh-keygen", "-F", lookup, "-f", str(source)], output_limit=64 * 1024
            )
            if found.returncode not in {0, 1}:
                raise ValueError("The trusted SSH host identity could not be read")
            for line in found.stdout.splitlines():
                parts = line.split()
                if parts and parts[0] == "@revoked":
                    raise ValueError("This host has a revoked key; resolve it in OpenSSH first")
                if len(parts) >= 3 and not parts[0].startswith(("#", "@")):
                    algorithm, encoded = parts[1:3]
                    if algorithm not in {"ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"}:
                        continue
                    key = base64.b64decode(encoded, validate=True)
                    digest = base64.b64encode(hashlib.sha256(key).digest()).decode().rstrip("=")
                    keys.append((algorithm, encoded + "|SHA256:" + digest))
    if not keys:
        raise ValueError("Trust this host in OpenSSH first, then import its alias again")
    rank = {"ssh-ed25519": 0, "ecdsa-sha2-nistp256": 1, "ssh-rsa": 2}
    chosen = sorted(set(keys), key=lambda item: (rank[item[0]], item[1]))[0]
    # Multiple keys of the selected algorithm are ambiguous; do not silently
    # decide which host identity is current.
    if sum(algorithm == chosen[0] for algorithm, _ in set(keys)) != 1:
        raise ValueError("Resolve the conflicting host keys in OpenSSH before importing")
    encoded, fingerprint = chosen[1].split("|")
    content = f"{lookup} {chosen[0]} {encoded}\n".encode()
    pinned = _pin_file(project, content)
    identities = [Path(value).expanduser() for value in fields.get("identityfile", [])]
    identity = next(
        (
            item
            for item in identities
            if item.is_absolute() and item.is_file() and not item.is_symlink()
        ),
        None,
    )
    draft_id = remote._document_id("compute-ssh-import", alias)
    drafts = [
        item
        for item in project.documents("policy")
        if item.get("data", {}).get("schema") == DRAFT_SCHEMA
    ]
    existing = next((item for item in drafts if item["id"] == draft_id), None)
    if existing is None and len(drafts) >= remote.MAX_REMOTE_PROFILES:
        raise ValueError("The saved SSH alias limit has been reached")
    draft = project.put_document(
        "policy",
        draft_id,
        {
            "schema": DRAFT_SCHEMA,
            "alias": alias,
            "private_connection": {
                "known_host": lookup,
                "known_hosts_file": str(pinned),
                "host_key_sha256": fingerprint,
                "identity_file": str(identity) if identity else None,
            },
        },
        expected_revision=existing["revision"] if existing else 0,
    )
    return {
        "draft": {
            "id": draft["id"],
            "revision": draft["revision"],
            "alias": alias,
            "host_key_sha256": fingerprint,
        }
    }


_SETUP_KEYS = {
    "draft_id",
    "draft_revision",
    "expected_revision",
    "runtime_python",
    "remote_project_root",
    "remote_output_root",
    "scheduler",
    "scheduler_bin_dir",
    "queue",
    "account",
    "resources",
}


def dispatch(
    directory: str, operation: str, request: dict[str, Any], study: ResearchProject | None = None
) -> dict[str, Any]:
    if operation not in {
        "list",
        "import_ssh",
        "save",
        "test",
        "resources",
        "remember",
        "use",
        "forget",
    }:
        raise ValueError("Unsupported compute settings operation")
    if not isinstance(request, dict):
        raise ValueError("Compute settings request must be an object")
    project = _store(directory)
    holder = SimpleNamespace(project=project)
    if operation == "list":
        remote._exact(request, set(), "Compute target list")
        return {
            "targets": [remote._public_profile(item) for item in remote._profiles(project)],
            "study_profiles": [remote._public_profile(item) for item in remote._profiles(study)]
            if study is not None
            else [],
        }
    if operation == "import_ssh":
        return _import_ssh(project, request)
    if operation == "save":
        remote._exact(request, _SETUP_KEYS, "Compute target setup")
        draft_id = checked_id(request["draft_id"])
        drafts = [
            item
            for item in project.documents("policy")
            if item["id"] == draft_id and item.get("data", {}).get("schema") == DRAFT_SCHEMA
        ]
        if len(drafts) != 1 or drafts[0]["revision"] != _revision(request["draft_revision"]):
            raise ValueError("SSH import changed; import the alias again")
        draft = drafts[0]["data"]
        if request["scheduler"] not in {"pbs", "pbspro", "slurm"}:
            raise ValueError("Choose a supported batch scheduler")
        values = {key: request[key] for key in _SETUP_KEYS - {"draft_id", "draft_revision"}}
        values.update(
            {
                key: draft["private_connection"][key]
                for key in (
                    "known_host",
                    "known_hosts_file",
                    "host_key_sha256",
                    "identity_file",
                )
            }
        )
        values.update(
            {
                "alias": draft["alias"],
                "remote_input_roots": [],
                "allow_direct_compute": False,
                "connect_timeout_seconds": 10,
                "pbs_gpu_resource": "ngpus" if request["scheduler"] in {"pbs", "pbspro"} else None,
            }
        )
        return remote._save_profile(holder, values)
    if operation == "remember":
        remote._exact(request, {"alias", "expected_revision"}, "Remember study target")
        if study is None:
            raise ValueError("Open the study containing this target first")
        if not isinstance(request["alias"], str) or not _ALIAS.fullmatch(request["alias"]):
            raise ValueError("Choose one saved study target")
        source = remote._load_profile(study, request["alias"])
        remote._profile_from_data(source["data"])
        data = deepcopy(source["data"])
        data.pop("app_target", None)
        known_hosts = Path(data["private_profile"]["known_hosts_file"])
        if known_hosts.stat().st_size > 4 * 1024**2:
            raise ValueError("The SSH host file exceeds the supported import size")
        digest, size = _sha256_file_stable(known_hosts, reject_symlink=True)
        with os.fdopen(os.open(known_hosts, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
            content = stream.read(4 * 1024**2 + 1)
        if len(content) != size or hashlib.sha256(content).hexdigest() != digest:
            raise ValueError("The SSH host file changed while it was being saved")
        data["private_profile"]["known_hosts_file"] = str(_pin_file(project, content))
        existing = remote._profiles(project)
        if (
            not any(item["id"] == source["id"] for item in existing)
            and len(existing) >= remote.MAX_REMOTE_PROFILES
        ):
            raise ValueError("The saved compute target limit has been reached")
        saved = project.put_document(
            "policy",
            source["id"],
            data,
            expected_revision=_revision(request["expected_revision"], zero=True),
        )
        return {"profile": remote._public_profile(saved)}
    remote._exact(
        request,
        {"id", "revision", "resources"} if operation == "resources" else {"id", "revision"},
        "Compute target action",
    )
    envelope = _target(project, request)
    if operation == "test":
        return remote._test_profile(
            holder,
            {"alias": envelope["data"]["alias"]},
            ready=True,
            expected_revision=envelope["revision"],
        )
    if operation == "resources":
        resources = asdict(remote._resource(request["resources"]))
        updated = remote._put(
            project,
            envelope,
            {**envelope["data"], "resources": resources, "updated_at": timestamp()},
        )
        return {"profile": remote._public_profile(updated)}
    if operation == "forget":
        with project.connection() as connection:
            cursor = connection.execute(
                "DELETE FROM documents WHERE kind=? AND id=? AND revision=?",
                ("policy", envelope["id"], envelope["revision"]),
            )
            if cursor.rowcount != 1:
                raise ValueError("Compute target changed; reload before removing it")
        return {"removed": True}
    if study is None:
        raise ValueError("Open a study before choosing a compute target")
    existing = remote._profiles(study)
    current = next((item for item in existing if item["id"] == envelope["id"]), None)
    if current is None and len(existing) >= remote.MAX_REMOTE_PROFILES:
        raise ValueError("This study has reached its compute target limit")
    binding = {"id": envelope["id"], "revision": envelope["revision"]}
    data = {**deepcopy(envelope["data"]), "app_target": binding}
    if current is not None and current["data"] == data:
        saved = current
    else:
        saved = study.put_document(
            "policy", envelope["id"], data, expected_revision=current["revision"] if current else 0
        )
    return {"profile": remote._public_profile(saved), "target": binding}
