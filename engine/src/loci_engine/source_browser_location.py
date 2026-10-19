"""Display-only source hierarchy; never a filesystem locator or scientific identity."""

from __future__ import annotations

import re
import unicodedata
import uuid
from pathlib import Path, PureWindowsPath
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .research_project import ResearchProject

_ID = re.compile(r"[a-f0-9]{32}\Z")


def relative_display_path(value: Any) -> str:
    if not isinstance(value, str) or not value or "\\" in value or PureWindowsPath(value).drive:
        raise ValueError("Browser location requires a relative display path")
    try:
        if len(value.encode("utf-8")) > 4096:
            raise ValueError("Browser display path exceeds its byte limit")
        parts = value.split("/")
        if len(parts) > 64 or any(
            part in {"", ".", ".."}
            or len(part.encode("utf-8")) > 255
            or any(unicodedata.category(character) == "Cc" for character in part)
            for part in parts
        ):
            raise ValueError("Browser display path components are invalid")
    except UnicodeError as error:
        raise ValueError("Browser display path has invalid text encoding") from error
    return value


def validate_browser_location(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"relative_path", "root"}:
        raise ValueError("Browser location fields are invalid")
    relative = relative_display_path(value["relative_path"])
    root = value["root"]
    if root is not None:
        if (
            not isinstance(root, dict)
            or set(root) != {"id", "name"}
            or not isinstance(root["id"], str)
            or not _ID.fullmatch(root["id"])
        ):
            raise ValueError("Browser import root identity is invalid")
        name = relative_display_path(root["name"])
        if "/" in name:
            raise ValueError("Browser import root name must be one display component")
        root = {"id": root["id"], "name": name}
    return {"relative_path": relative, "root": root}


def browser_location_for_source(record: dict[str, Any]) -> dict[str, Any] | None:
    """Project legacy hierarchy without writes or inferred filesystem ancestry."""
    if "browser_location" in record:
        try:
            return validate_browser_location(record["browser_location"])
        except ValueError:
            pass  # Invalid optional local presentation metadata cannot disclose a locator.
    for value, single_component in (
        (record.get("private_relative_path"), False),
        (record.get("name"), True),
    ):
        try:
            relative = relative_display_path(value)
            if single_component and "/" in relative:
                continue
            return {"relative_path": relative, "root": None}
        except ValueError:
            continue
    return None


def validate_browser_roots(sources: list[dict[str, Any]]) -> None:
    names: dict[str, str] = {}
    paths: set[tuple[str, str]] = set()
    for source in sources:
        if "browser_location" not in source:
            continue
        location = validate_browser_location(source["browser_location"])
        root = location["root"]
        if root is None:
            continue  # Unknown legacy ancestry must not invent identities for collisions.
        previous = names.setdefault(root["id"], root["name"])
        if previous != root["name"]:
            raise ValueError("One browser import root has conflicting names")
        key = (root["id"], location["relative_path"])
        if key in paths:
            raise ValueError("One browser import root has duplicate source paths")
        paths.add(key)


def prepare_import_root(
    root_value: Any, paths: list[str], relative_paths: list[str]
) -> dict[str, Any] | None:
    """Validate a private native-picker root against every explicitly selected file."""
    if root_value is None:
        return None
    if not isinstance(root_value, str):
        raise ValueError("Import root must be an explicitly selected absolute directory")
    root = Path(root_value)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError("Import root must be an explicitly selected plain directory")
    root = root.resolve(strict=True)
    name = relative_display_path(root.name)
    if "/" in name or len(paths) != len(relative_paths):
        raise ValueError("Import root source mapping is invalid")
    canonical = []
    for path, relative in zip(paths, relative_paths, strict=True):
        selected = Path(path)
        if not selected.is_absolute() or selected.is_symlink() or not selected.is_file():
            raise ValueError("Folder imports require explicitly selected plain source files")
        selected = selected.resolve(strict=True)
        try:
            observed = selected.relative_to(root).as_posix()
        except ValueError as error:
            raise ValueError("A folder source is outside its selected import root") from error
        if relative_display_path(relative) != observed:
            raise ValueError("A folder source relative path disagrees with its import root")
        canonical.append(str(selected))
    return {"path": str(root), "name": name, "paths": canonical, "relative_paths": relative_paths}


def associate_import_root(
    project: ResearchProject, imported: list[dict[str, Any]], plan: dict[str, Any] | None
) -> None:
    """Persist only presentation metadata after existing source registration succeeds."""
    if plan is None:
        return
    from .research_project import canonical_json, parse_json

    if len(imported) != len(plan["paths"]):
        raise ValueError("Import root does not match the registered source selection")
    with project.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        records = {
            row[0]: parse_json(row[1])
            for row in connection.execute("SELECT id,record FROM sources")
        }
        locations = {key: browser_location_for_source(record) for key, record in records.items()}
        candidates: dict[str, dict[str, str]] = {}
        for identity, record in records.items():
            location = locations[identity]
            if not location or not location["root"] or location["root"]["name"] != plan["name"]:
                continue
            expected = str(Path(plan["path"]).joinpath(*location["relative_path"].split("/")))
            actual = record.get("private_path", record.get("private_medical_selection"))
            if actual == expected:
                candidates[location["root"]["id"]] = location["root"]
        pending: dict[str, str] = {}
        # Reimports and overlapping folders retain prior explicit presentation.
        # Portable/relinked roots can be reused only with current locator agreement.
        for source, path, relative in zip(
            imported, plan["paths"], plan["relative_paths"], strict=True
        ):
            record = records[source["id"]]
            actual = record.get("private_path", record.get("private_medical_selection"))
            if actual != path or record["sha256"] != source["sha256"]:
                raise ValueError("Import root source identity changed during registration")
            location = locations[source["id"]]
            if not location or location["root"] is None:
                pending[source["id"]] = relative
        if not pending:
            return
        pending_paths = set(pending.values())
        root = next(iter(candidates.values())) if len(candidates) == 1 else None
        if root is not None and any(
            location
            and location["root"]
            and location["root"]["id"] == root["id"]
            and (
                location["root"]["name"] != root["name"]
                or location["relative_path"] in pending_paths
            )
            for location in locations.values()
        ):
            root = None
        # Ambiguous/converged roots and historical path collisions never make a
        # successful source import fail or erase earlier grouping. New entries get
        # a distinct import identity with the same truthful folder basename.
        if root is None:
            used = {
                location["root"]["id"]
                for location in locations.values()
                if location and location["root"]
            }
            root = {"id": uuid.uuid4().hex, "name": plan["name"]}
            while root["id"] in used:
                root["id"] = uuid.uuid4().hex
        for identity, relative in pending.items():
            record = records[identity]
            record["browser_location"] = validate_browser_location(
                {"relative_path": relative, "root": root}
            )
            record["private_import_root"] = plan["path"]
            connection.execute(
                "UPDATE sources SET record=? WHERE id=?",
                (
                    canonical_json(record),
                    identity,
                ),
            )
