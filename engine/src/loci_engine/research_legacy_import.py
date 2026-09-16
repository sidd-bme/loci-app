"""Read-only adapter from verified v1 project working packs into research studies."""

from __future__ import annotations

import hashlib
import json
import re
from typing import TYPE_CHECKING, Any

import numpy as np

from .models import ENGINE_VERSION
from .quantitative import Geometry, exact_keys, measure_objects
from .working_result import (
    WORKING_RESULT_MEDIA_TYPE,
    _settings_from_record,
    restore_working_result,
)

if TYPE_CHECKING:
    from .models import AnalysisSettings
    from .workbench import Workbench


_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_LEGACY_ID = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
_MAX_IMPORTS = 10_000
_MAX_SETTINGS_JSON_BYTES = 64 * 1024


def _identifier(value: object, label: str) -> str:
    if not isinstance(value, str) or not _LEGACY_ID.fullmatch(value):
        raise ValueError(f"{label} is invalid")
    return value


def _sha256(value: object, label: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        raise ValueError(f"{label} is invalid")
    return value


def _artifact(value: object, *, active: bool) -> dict[str, Any]:
    keys = {"artifactId", "filename", "mediaType", "byteLength", "sha256"}
    if active:
        keys.add("path")
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("Legacy working-result artifact metadata is invalid")
    if (
        value["artifactId"] != "working-result"
        or value["mediaType"] != WORKING_RESULT_MEDIA_TYPE
        or not isinstance(value["filename"], str)
        or not value["filename"].endswith(".loci-result")
        or isinstance(value["byteLength"], bool)
        or not isinstance(value["byteLength"], int)
        or not 1 <= value["byteLength"] <= 1024 * 1024**3
    ):
        raise ValueError("Legacy working-result artifact metadata is invalid")
    _sha256(value["sha256"], "Legacy working-result digest")
    if active and (not isinstance(value["path"], str) or not value["path"]):
        raise ValueError("Legacy working-result path is invalid")
    return value


def _operation_ids(result: Any) -> list[str]:
    return [operation.operation_id for operation in result.applied_corrections]


def _verify_legacy_settings(
    settings_json: object,
    expected_sha256: str,
    *,
    restored: AnalysisSettings,
    backend_kind: str,
) -> None:
    """Hash exact JS canonical bytes, then bind parsed values to restored settings."""

    if not isinstance(settings_json, str):
        raise TypeError("Legacy settings JSON must be a string")
    encoded = settings_json.encode()
    if not encoded or len(encoded) > _MAX_SETTINGS_JSON_BYTES:
        raise ValueError("Legacy settings JSON exceeds its bounded size")
    if hashlib.sha256(encoded).hexdigest() != expected_sha256:
        raise ValueError("Legacy settings do not match their saved digest")

    def reject_constant(token: str) -> None:
        raise ValueError(f"Legacy settings contain invalid constant {token}")

    try:
        value = json.loads(settings_json, parse_constant=reject_constant)
    except (TypeError, ValueError) as error:
        raise ValueError("Legacy settings JSON is invalid") from error
    if not isinstance(value, dict):
        raise TypeError("Legacy settings must be an object")
    parsed = _settings_from_record(
        {"kind": type(restored).__name__, "values": value},
        backend_kind=backend_kind,
    )
    if restored.to_dict() != parsed.to_dict():
        raise ValueError("The restored settings do not match the legacy project binding")


def import_legacy_project(
    workbench: Workbench,
    legacy_project_value: object,
    items_value: object,
) -> dict[str, Any]:
    """Import one current source/result layer per legacy source without executing a model."""

    exact_keys(
        legacy_project_value, {"project_id", "title", "revision", "sha256"}, "legacy project"
    )
    legacy_project = legacy_project_value
    project_id = _identifier(legacy_project.get("project_id"), "Legacy project identity")
    title = legacy_project.get("title")
    if not isinstance(title, str) or not title.strip() or len(title) > 256:
        raise ValueError("Legacy project title is invalid")
    revision = legacy_project.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ValueError("Legacy project revision is invalid")
    project_sha256 = _sha256(legacy_project.get("sha256"), "Legacy project digest")
    if not isinstance(items_value, list) or not 1 <= len(items_value) <= _MAX_IMPORTS:
        raise ValueError("Choose 1-10000 bounded legacy project sources")

    receipts: list[dict[str, Any]] = []
    for item_value in items_value:
        exact_keys(
            item_value,
            {"legacy_source_id", "source_path", "source_name", "expected_sha256", "result"},
            "legacy source import",
        )
        item = item_value
        legacy_source_id = _identifier(item.get("legacy_source_id"), "Legacy source identity")
        source_path = item.get("source_path")
        source_name = item.get("source_name")
        expected_source_sha256 = _sha256(
            item.get("expected_sha256"), "Legacy source digest", nullable=True
        )
        if not isinstance(source_path, str) or not source_path:
            raise ValueError("Legacy source path is invalid")
        if not isinstance(source_name, str) or not source_name.strip() or len(source_name) > 256:
            raise ValueError("Legacy source name is invalid")

        result_value = item.get("result")
        restored = None
        result_binding: dict[str, Any] | None = None
        active_pack: dict[str, Any] | None = None
        if result_value is not None:
            exact_keys(
                result_value,
                {
                    "legacy_result_id",
                    "result_manifest_id",
                    "job_id",
                    "model_id",
                    "model_sha256",
                    "settings_json",
                    "settings_sha256",
                    "engine_version",
                    "correction_revision",
                    "correction_operation_ids",
                    "original_pack",
                    "active_pack",
                    "review_disposition",
                },
                "legacy result import",
            )
            result_binding = result_value
            for field in ("legacy_result_id", "result_manifest_id", "job_id", "model_id"):
                _identifier(result_binding.get(field), f"Legacy {field}")
            model_sha256 = _sha256(
                result_binding.get("model_sha256"), "Legacy model digest", nullable=True
            )
            settings_sha256 = _sha256(
                result_binding.get("settings_sha256"), "Legacy settings digest"
            )
            legacy_settings_json = result_binding.get("settings_json")
            if result_binding.get("engine_version") != ENGINE_VERSION:
                raise ValueError("The legacy result engine version is not supported")
            correction_revision = result_binding.get("correction_revision")
            operation_ids = result_binding.get("correction_operation_ids")
            if (
                isinstance(correction_revision, bool)
                or not isinstance(correction_revision, int)
                or correction_revision < 0
                or not isinstance(operation_ids, list)
                or len(operation_ids) > 100
            ):
                raise ValueError("Legacy correction binding is invalid")
            expected_operation_ids = [
                _identifier(value, "Legacy correction operation identity")
                for value in operation_ids
            ]
            if len(set(expected_operation_ids)) != len(expected_operation_ids):
                raise ValueError("Legacy correction operation identities are duplicated")
            _artifact(result_binding.get("original_pack"), active=False)
            active_pack = _artifact(result_binding.get("active_pack"), active=True)
            if result_binding.get("review_disposition") not in {None, "reviewed", "excluded"}:
                raise ValueError("Legacy review disposition is invalid")
            if expected_source_sha256 is None:
                raise ValueError("A legacy result requires a verified source digest")
            restored, _evicted, verified_pack = restore_working_result(
                active_pack["path"],
                source_path,
                expected_source_sha256,
                cache=None,
                require_installed_profile=False,
            )
            _verify_legacy_settings(
                legacy_settings_json,
                settings_sha256,
                restored=restored.settings,
                backend_kind=restored.profile.backend_kind,
            )
            if (
                verified_pack["basename"] != active_pack["filename"]
                or verified_pack["size_bytes"] != active_pack["byteLength"]
                or verified_pack["sha256"] != active_pack["sha256"]
                or restored.result_id != result_binding["legacy_result_id"]
                or restored.source.sha256 != expected_source_sha256
                or restored.profile.id != result_binding["model_id"]
                or restored.profile.model.sha256 != model_sha256
                or restored.correction_revision != correction_revision
                or _operation_ids(restored) != expected_operation_ids
            ):
                raise ValueError("The verified legacy pack does not match its project binding")

        source = workbench.import_native(source_path, name=source_name)
        if expected_source_sha256 is not None and source["sha256"] != expected_source_sha256:
            raise ValueError("The imported source does not match its legacy project fingerprint")
        if restored is None or result_binding is None or active_pack is None:
            receipts.append(
                {
                    "legacy_source_id": legacy_source_id,
                    "source_id": source["id"],
                    "result_id": None,
                    "correction_revision": None,
                }
            )
            continue

        legacy_identity = {
            "project_id": project_id,
            "project_title": title,
            "project_revision": revision,
            "project_sha256": project_sha256,
            "source_id": legacy_source_id,
            "result_id": result_binding["legacy_result_id"],
            "result_manifest_id": result_binding["result_manifest_id"],
            "job_id": result_binding["job_id"],
            "original_pack": result_binding["original_pack"],
            "active_pack": {key: active_pack[key] for key in active_pack if key != "path"},
        }
        existing = next(
            (
                result
                for result in workbench.project.list_results(source["id"])
                if result.get("provenance", {}).get("legacy_import") == legacy_identity
            ),
            None,
        )
        if existing is None:
            analysis = restored.provenance_dict()
            geometry = Geometry.diagonal((1.0, 1.0))
            converted_labels = restored.output.labels.astype(np.uint32, copy=True)
            working_bytes = min(
                8 * 1024**3,
                max(512 * 1024**2, converted_labels.size * 128),
            )
            converted_measurements = measure_objects(
                converted_labels,
                geometry,
                {"LEGACY-DERIVED:image": restored.output.normalized},
                working_bytes=working_bytes,
            )
            imported_provenance = {
                "geometry": geometry.to_dict(),
                "selection": {
                    "x": 0,
                    "y": 0,
                    "width": restored.source.width,
                    "height": restored.source.height,
                    "z": 0,
                    "t": 0,
                    "c": 0,
                    "level": 0,
                },
                "selection_basis": (
                    "full source-resolution YX bounds declared by the verified working pack"
                ),
                "measurement_channels": [0],
                "derived_measurement_arrays": ["image"],
                "derived_measurement_prefix": "LEGACY-DERIVED",
                "measurement_basis": (
                    "LEGACY-DERIVED normalized display; technical conversion, not raw or "
                    "registered intensity"
                ),
                "label_conversion": {
                    "from_dtype": "int32",
                    "to_dtype": "uint32",
                    "value_transform": "exact non-negative integer cast",
                    "reason": "research label editing requires canonical uint32 labels",
                },
                "measurements": converted_measurements,
                "legacy_measurements": restored.output.measurements,
                "metrics": analysis["metrics"],
                "profile": analysis["profile"],
                "settings": analysis["settings"],
                "corrections": analysis["corrections"],
                "segmentation": {
                    "method": "verified-legacy-working-result",
                    "executed_during_import": False,
                },
                "recipe": {
                    "schema": "loci.legacy-saved-result-view/v1",
                    "execution": "not-executed-during-import",
                    "measurement_channels": [0],
                    "gates": [],
                },
                "model": {
                    "profile": analysis["profile"],
                    "runtime": analysis.get("runtime"),
                    "executed_during_import": False,
                },
                "legacy_import": legacy_identity,
            }
            if analysis.get("runtime") is not None:
                imported_provenance["runtime"] = analysis["runtime"]
            result = workbench.project.save_result(
                source_id=source["id"],
                kind="segmentation",
                arrays={
                    "image": restored.output.normalized,
                    "labels": converted_labels,
                },
                provenance=imported_provenance,
            )
        else:
            result = existing
        disposition = result_binding["review_disposition"]
        if disposition is not None:
            current_review = workbench.project.review_state(result["id"])
            if current_review is None or current_review["disposition"] != disposition:
                workbench.project.review(result["id"], result["revision_hash"], disposition)
        receipts.append(
            {
                "legacy_source_id": legacy_source_id,
                "source_id": source["id"],
                "result_id": result["id"],
                "correction_revision": restored.correction_revision,
            }
        )

    return {
        "snapshot": workbench.snapshot(),
        "receipt": {
            "schema": "loci.legacy-project-import/v1",
            "legacy_project_id": project_id,
            "legacy_project_title": title,
            "legacy_project_revision": revision,
            "legacy_project_sha256": project_sha256,
            "sources": receipts,
        },
    }
