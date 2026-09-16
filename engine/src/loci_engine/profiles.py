"""Safe, immutable descriptors for selectable segmentation backends.

Profile manifests are data-only JSON records. They deliberately contain no
filesystem paths, import targets, callables, or executable serialization. A
future native model backend may reference a packaged ONNX artifact by stable
identifier and digest, but loading that artifact remains backend-owned code.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, fields
from types import MappingProxyType
from typing import Any, Literal

from .models import ENGINE_VERSION, AnalysisSettings, CellposeSettings, SegmentationSettings

PROFILE_SCHEMA_VERSION = "1.2"
DEFAULT_PROFILE_ID = "loci-classical"
CELLPOSE_PROFILE_ID = "cellpose-sam-v2"
CELLPOSE_WEBSITE_PROFILE_ID = "cellpose-sam"

BackendKind = Literal["classical", "cellpose", "onnx"]
ModelFormat = Literal["builtin-algorithm", "cellpose-native", "onnx"]
ProfileStatus = Literal["ready", "unavailable", "validation_failed"]
ValidationStatus = Literal["baseline", "validated", "limited", "unvalidated"]
RedistributionStatus = Literal["bundled", "permitted", "not_permitted", "unknown"]
CommercialUseStatus = Literal[
    "permitted", "restricted", "not_permitted", "not_applicable", "unknown"
]
ChannelConversion = Literal["grayscale-luminance", "rgb-or-replicated-grayscale"]
IntensityNormalization = Literal[
    "per-image-percentile-1-99", "cellpose-configurable-percentile"
]
ResizePolicy = Literal["none", "downsample-only"]
OutputGrid = Literal["source-resolution"]
SettingValueType = Literal["boolean", "integer", "number", "choice"]

_PROFILE_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
_VERSION_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
    r"|^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$"
)
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_WINDOWS_ABSOLUTE_PATH_PATTERN = re.compile(r"^[A-Za-z]:[\\/]")


def _validate_text(value: object, field_name: str, *, max_length: int = 1000) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if not value or value != value.strip():
        raise ValueError(f"{field_name} must be non-empty and have no outer whitespace")
    if len(value) > max_length:
        raise ValueError(f"{field_name} must contain at most {max_length} characters")
    if any(ord(character) < 32 for character in value):
        raise ValueError(f"{field_name} must not contain control characters")
    return value


def _looks_like_path(value: str) -> bool:
    lowered = value.lower()
    return (
        value.startswith(("/", "./", "../", "~/", "\\\\"))
        or bool(_WINDOWS_ABSOLUTE_PATH_PATTERN.match(value))
        or lowered.startswith("file:")
        or (("/" in value or "\\" in value) and not any(character.isspace() for character in value))
    )


def validate_path_free_json(value: object, *, location: str = "profile") -> None:
    """Reject values that are unsafe or unsuitable for a profile manifest.

    Only ordinary JSON types are accepted. Non-finite numbers, path-bearing
    keys, and strings that look like absolute or relative filesystem paths are
    rejected. This validator never deserializes model objects or imports code.
    """

    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{location} contains a non-finite number")
        return
    if isinstance(value, str):
        if _looks_like_path(value):
            raise ValueError(f"{location} must not contain a filesystem path")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            validate_path_free_json(item, location=f"{location}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError(f"{location} object keys must be strings")
            normalized_key = key.lower().replace("-", "_")
            if "path" in normalized_key.split("_"):
                raise ValueError(f"{location}.{key} is not allowed in a path-free manifest")
            validate_path_free_json(item, location=f"{location}.{key}")
        return
    raise TypeError(f"{location} contains a non-JSON value of type {type(value).__name__}")


def _require_exact_keys(value: object, expected: set[str], location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"{location} must be an object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        details: list[str] = []
        if missing:
            details.append(f"missing: {', '.join(missing)}")
        if unknown:
            details.append(f"unknown: {', '.join(unknown)}")
        raise ValueError(f"{location} has invalid fields ({'; '.join(details)})")
    return value


@dataclass(frozen=True, slots=True)
class ModelArtifact:
    """Non-executable identity for a backend's model artifact."""

    format: ModelFormat
    artifact_id: str | None
    sha256: str | None

    def validate(self) -> None:
        if self.format not in {"builtin-algorithm", "cellpose-native", "onnx"}:
            raise ValueError(f"Unsupported model format: {self.format}")
        if self.format == "builtin-algorithm":
            if self.artifact_id is not None or self.sha256 is not None:
                raise ValueError("A built-in algorithm must not declare a model artifact or hash")
            return
        _validate_text(self.artifact_id, "model.artifact_id", max_length=120)
        if not _PROFILE_ID_PATTERN.fullmatch(self.artifact_id):
            raise ValueError("model.artifact_id must be a lowercase, path-free identifier")
        if not isinstance(self.sha256, str) or not _SHA256_PATTERN.fullmatch(self.sha256):
            raise ValueError("A model artifact must declare a lowercase SHA-256 digest")

    def to_dict(self) -> dict[str, object]:
        return {
            "format": self.format,
            "artifact_id": self.artifact_id,
            "sha256": self.sha256,
        }


@dataclass(frozen=True, slots=True)
class PreprocessingContract:
    """Spatial and intensity transform required by a model profile."""

    channel_conversion: ChannelConversion
    intensity_normalization: IntensityNormalization
    resize_policy: ResizePolicy
    max_edge_px: int | None
    output_grid: OutputGrid

    def validate(self) -> None:
        if self.channel_conversion not in {
            "grayscale-luminance",
            "rgb-or-replicated-grayscale",
        }:
            raise ValueError(f"Unsupported channel conversion: {self.channel_conversion}")
        if self.intensity_normalization not in {
            "per-image-percentile-1-99",
            "cellpose-configurable-percentile",
        }:
            raise ValueError(
                f"Unsupported intensity normalization: {self.intensity_normalization}"
            )
        if self.resize_policy not in {"none", "downsample-only"}:
            raise ValueError(f"Unsupported resize policy: {self.resize_policy}")
        if self.resize_policy == "none":
            if self.max_edge_px is not None:
                raise ValueError("A no-resize profile must not declare max_edge_px")
        elif (
            isinstance(self.max_edge_px, bool)
            or not isinstance(self.max_edge_px, int)
            or not 64 <= self.max_edge_px <= 10_000
        ):
            raise ValueError("A downsample-only profile requires max_edge_px between 64 and 10000")
        if self.output_grid != "source-resolution":
            raise ValueError(f"Unsupported output grid: {self.output_grid}")

    def to_dict(self) -> dict[str, object]:
        return {
            "channel_conversion": self.channel_conversion,
            "intensity_normalization": self.intensity_normalization,
            "resize_policy": self.resize_policy,
            "max_edge_px": self.max_edge_px,
            "output_grid": self.output_grid,
        }


@dataclass(frozen=True, slots=True)
class RightsLineage:
    """License and data-lineage facts needed before redistribution."""

    code_license: str
    model_license: str
    redistribution: RedistributionStatus
    commercial_use: CommercialUseStatus
    training_data_lineage: str

    def validate(self) -> None:
        _validate_text(self.code_license, "rights.code_license", max_length=120)
        _validate_text(self.model_license, "rights.model_license", max_length=120)
        _validate_text(
            self.training_data_lineage,
            "rights.training_data_lineage",
            max_length=1000,
        )
        if self.redistribution not in {"bundled", "permitted", "not_permitted", "unknown"}:
            raise ValueError(f"Unsupported redistribution status: {self.redistribution}")
        if self.commercial_use not in {
            "permitted",
            "restricted",
            "not_permitted",
            "not_applicable",
            "unknown",
        }:
            raise ValueError(f"Unsupported commercial-use status: {self.commercial_use}")

    def to_dict(self) -> dict[str, str]:
        return {
            "code_license": self.code_license,
            "model_license": self.model_license,
            "redistribution": self.redistribution,
            "commercial_use": self.commercial_use,
            "training_data_lineage": self.training_data_lineage,
        }


@dataclass(frozen=True, slots=True)
class FailureMode:
    code: str
    summary: str

    def validate(self) -> None:
        _validate_text(self.code, "validation.failure_modes.code", max_length=80)
        if not _PROFILE_ID_PATTERN.fullmatch(self.code):
            raise ValueError("A failure-mode code must use lowercase identifier characters")
        _validate_text(self.summary, "validation.failure_modes.summary", max_length=500)

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "summary": self.summary}


@dataclass(frozen=True, slots=True)
class ValidationSummary:
    status: ValidationStatus
    summary: str
    failure_modes: tuple[FailureMode, ...]

    def validate(self) -> None:
        if self.status not in {"baseline", "validated", "limited", "unvalidated"}:
            raise ValueError(f"Unsupported validation status: {self.status}")
        _validate_text(self.summary, "validation.summary", max_length=1000)
        if not isinstance(self.failure_modes, tuple):
            raise TypeError("validation.failure_modes must be an immutable tuple")
        if len(self.failure_modes) > 50:
            raise ValueError("validation.failure_modes must contain at most 50 entries")
        codes: set[str] = set()
        for failure_mode in self.failure_modes:
            if not isinstance(failure_mode, FailureMode):
                raise TypeError("validation.failure_modes must contain FailureMode values")
            failure_mode.validate()
            if failure_mode.code in codes:
                raise ValueError(f"Duplicate failure-mode code: {failure_mode.code}")
            codes.add(failure_mode.code)

    def to_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "summary": self.summary,
            "failure_modes": [failure_mode.to_dict() for failure_mode in self.failure_modes],
        }


@dataclass(frozen=True, slots=True)
class AvailabilitySummary:
    """Current runtime availability without exposing a local filesystem path."""

    code: str
    summary: str

    def validate(self) -> None:
        _validate_text(self.code, "availability.code", max_length=80)
        if not _PROFILE_ID_PATTERN.fullmatch(self.code):
            raise ValueError("An availability code must use lowercase identifier characters")
        _validate_text(self.summary, "availability.summary", max_length=500)

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "summary": self.summary}


@dataclass(frozen=True, slots=True)
class SettingDefinition:
    """A data-only UI and validation description for one backend control."""

    key: str
    label: str
    section: str
    value_type: SettingValueType
    help: str
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    choices: tuple[str, ...] = ()

    def validate(self) -> None:
        _validate_text(self.key, "settings_contract.key", max_length=80)
        if not _PROFILE_ID_PATTERN.fullmatch(self.key):
            raise ValueError("A setting key must use lowercase identifier characters")
        _validate_text(self.label, "settings_contract.label", max_length=120)
        _validate_text(self.section, "settings_contract.section", max_length=80)
        _validate_text(self.help, "settings_contract.help", max_length=500)
        if self.value_type not in {"boolean", "integer", "number", "choice"}:
            raise ValueError(f"Unsupported setting value type: {self.value_type}")
        for field_name, value in (
            ("minimum", self.minimum),
            ("maximum", self.maximum),
            ("step", self.step),
        ):
            if value is not None and (isinstance(value, bool) or not math.isfinite(value)):
                raise ValueError(f"settings_contract.{field_name} must be finite or null")
        if (
            self.minimum is not None
            and self.maximum is not None
            and self.minimum > self.maximum
        ):
            raise ValueError("A setting minimum must not exceed its maximum")
        if self.step is not None and self.step <= 0:
            raise ValueError("A setting step must be greater than zero")
        if not isinstance(self.choices, tuple):
            raise TypeError("settings_contract.choices must be an immutable tuple")
        if self.value_type == "choice":
            if not self.choices:
                raise ValueError("A choice setting must declare at least one choice")
            for choice in self.choices:
                _validate_text(choice, "settings_contract.choices", max_length=80)
        elif self.choices:
            raise ValueError("Only a choice setting may declare choices")

    def to_dict(self) -> dict[str, object]:
        return {
            "key": self.key,
            "label": self.label,
            "section": self.section,
            "value_type": self.value_type,
            "help": self.help,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "step": self.step,
            "choices": list(self.choices),
        }


@dataclass(frozen=True, slots=True)
class SegmentationProfile:
    """Strict data-only contract for one selectable segmentation profile."""

    id: str
    name: str
    version: str
    status: ProfileStatus
    availability: AvailabilitySummary
    backend_kind: BackendKind
    model: ModelArtifact
    preprocessing: PreprocessingContract
    rights: RightsLineage
    recommended_settings: AnalysisSettings
    settings_contract: tuple[SettingDefinition, ...]
    validation: ValidationSummary

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        _validate_text(self.id, "id", max_length=80)
        if not _PROFILE_ID_PATTERN.fullmatch(self.id):
            raise ValueError("Profile id must be a lowercase, path-free identifier")
        _validate_text(self.name, "name", max_length=120)
        _validate_text(self.version, "version", max_length=80)
        if not _VERSION_PATTERN.fullmatch(self.version):
            raise ValueError("Profile version must be a valid semantic or package version")
        if self.status not in {"ready", "unavailable", "validation_failed"}:
            raise ValueError(f"Unsupported profile status: {self.status}")
        if not isinstance(self.availability, AvailabilitySummary):
            raise TypeError("availability must be an AvailabilitySummary")
        self.availability.validate()
        if self.backend_kind not in {"classical", "cellpose", "onnx"}:
            raise ValueError(f"Unsupported backend kind: {self.backend_kind}")
        if not isinstance(self.model, ModelArtifact):
            raise TypeError("model must be a ModelArtifact")
        self.model.validate()
        if self.backend_kind == "classical" and self.model.format != "builtin-algorithm":
            raise ValueError("The classical backend requires the built-in algorithm format")
        if self.backend_kind == "cellpose" and self.model.format != "cellpose-native":
            raise ValueError("The Cellpose backend requires a Cellpose-native model artifact")
        if self.backend_kind == "onnx" and self.model.format != "onnx":
            raise ValueError("The ONNX backend requires an ONNX model artifact")
        if not isinstance(self.preprocessing, PreprocessingContract):
            raise TypeError("preprocessing must be a PreprocessingContract")
        self.preprocessing.validate()
        if not isinstance(self.rights, RightsLineage):
            raise TypeError("rights must be RightsLineage")
        self.rights.validate()
        if self.backend_kind == "cellpose":
            if not isinstance(self.recommended_settings, CellposeSettings):
                raise TypeError("A Cellpose profile requires CellposeSettings")
        elif not isinstance(self.recommended_settings, SegmentationSettings):
            raise TypeError("A classical or ONNX profile requires SegmentationSettings")
        self.recommended_settings.validate()
        if not isinstance(self.settings_contract, tuple):
            raise TypeError("settings_contract must be an immutable tuple")
        expected_keys = {field.name for field in fields(type(self.recommended_settings))}
        actual_keys: set[str] = set()
        for definition in self.settings_contract:
            if not isinstance(definition, SettingDefinition):
                raise TypeError("settings_contract must contain SettingDefinition values")
            definition.validate()
            if definition.key in actual_keys:
                raise ValueError(f"Duplicate settings-contract key: {definition.key}")
            actual_keys.add(definition.key)
        if actual_keys != expected_keys:
            missing = sorted(expected_keys - actual_keys)
            unknown = sorted(actual_keys - expected_keys)
            details: list[str] = []
            if missing:
                details.append(f"missing: {', '.join(missing)}")
            if unknown:
                details.append(f"unknown: {', '.join(unknown)}")
            raise ValueError(f"settings_contract does not match settings ({'; '.join(details)})")
        if not isinstance(self.validation, ValidationSummary):
            raise TypeError("validation must be ValidationSummary")
        self.validation.validate()
        validate_path_free_json(self.to_dict())

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "status": self.status,
            "availability": self.availability.to_dict(),
            "backend_kind": self.backend_kind,
            "model": self.model.to_dict(),
            "preprocessing": self.preprocessing.to_dict(),
            "rights": self.rights.to_dict(),
            "recommended_settings": self.recommended_settings.to_dict(),
            "settings_contract": [definition.to_dict() for definition in self.settings_contract],
            "validation": self.validation.to_dict(),
        }

    def provenance_dict(self) -> dict[str, object]:
        """Return the immutable subset needed to reproduce an analysis choice."""

        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "backend_kind": self.backend_kind,
            "model": self.model.to_dict(),
            "preprocessing": self.preprocessing.to_dict(),
        }


def _parse_settings(value: object, backend_kind: object) -> AnalysisSettings:
    settings_type = CellposeSettings if backend_kind == "cellpose" else SegmentationSettings
    expected = {field.name for field in fields(settings_type)}
    manifest = _require_exact_keys(value, expected, "recommended_settings")
    if settings_type is CellposeSettings:
        settings = CellposeSettings(**manifest)
        settings.validate()
        return settings
    string_fields = {"image_mode", "polarity"}
    float_fields = {"expected_diameter_px", "sensitivity", "smoothing_px"}
    bool_fields = {"split_touching", "exclude_border"}
    for field_name in string_fields:
        if not isinstance(manifest[field_name], str):
            raise TypeError(f"recommended_settings.{field_name} must be a string")
    if isinstance(manifest["min_area_px"], bool) or not isinstance(manifest["min_area_px"], int):
        raise TypeError("recommended_settings.min_area_px must be an integer")
    for field_name in float_fields:
        field_value = manifest[field_name]
        if isinstance(field_value, bool) or not isinstance(field_value, (int, float)):
            raise TypeError(f"recommended_settings.{field_name} must be a finite number")
        if not math.isfinite(float(field_value)):
            raise ValueError(f"recommended_settings.{field_name} must be a finite number")
    for field_name in bool_fields:
        if not isinstance(manifest[field_name], bool):
            raise TypeError(f"recommended_settings.{field_name} must be a boolean")
    settings = SegmentationSettings(**manifest)
    settings.validate()
    return settings


def _parse_settings_contract(value: object) -> tuple[SettingDefinition, ...]:
    if not isinstance(value, list):
        raise TypeError("settings_contract must be an array")
    definitions: list[SettingDefinition] = []
    expected = {
        "key",
        "label",
        "section",
        "value_type",
        "help",
        "minimum",
        "maximum",
        "step",
        "choices",
    }
    for index, raw_definition in enumerate(value):
        parsed = _require_exact_keys(
            raw_definition,
            expected,
            f"settings_contract[{index}]",
        )
        choices = parsed["choices"]
        if not isinstance(choices, list) or not all(isinstance(choice, str) for choice in choices):
            raise TypeError(f"settings_contract[{index}].choices must be an array of strings")
        definitions.append(
            SettingDefinition(
                key=parsed["key"],
                label=parsed["label"],
                section=parsed["section"],
                value_type=parsed["value_type"],
                help=parsed["help"],
                minimum=parsed["minimum"],
                maximum=parsed["maximum"],
                step=parsed["step"],
                choices=tuple(choices),
            )
        )
    return tuple(definitions)


def profile_from_manifest(value: object) -> SegmentationProfile:
    """Parse a strict path-free JSON manifest into an immutable descriptor."""

    validate_path_free_json(value)
    manifest = _require_exact_keys(
        value,
        {
            "schema_version",
            "id",
            "name",
            "version",
            "status",
            "availability",
            "backend_kind",
            "model",
            "preprocessing",
            "rights",
            "recommended_settings",
            "settings_contract",
            "validation",
        },
        "profile",
    )
    if manifest["schema_version"] != PROFILE_SCHEMA_VERSION:
        raise ValueError(f"Unsupported profile schema version: {manifest['schema_version']}")

    model = _require_exact_keys(manifest["model"], {"format", "artifact_id", "sha256"}, "model")
    availability = _require_exact_keys(
        manifest["availability"], {"code", "summary"}, "availability"
    )
    preprocessing = _require_exact_keys(
        manifest["preprocessing"],
        {
            "channel_conversion",
            "intensity_normalization",
            "resize_policy",
            "max_edge_px",
            "output_grid",
        },
        "preprocessing",
    )
    rights = _require_exact_keys(
        manifest["rights"],
        {
            "code_license",
            "model_license",
            "redistribution",
            "commercial_use",
            "training_data_lineage",
        },
        "rights",
    )
    validation = _require_exact_keys(
        manifest["validation"],
        {"status", "summary", "failure_modes"},
        "validation",
    )
    failure_modes_value = validation["failure_modes"]
    if not isinstance(failure_modes_value, list):
        raise TypeError("validation.failure_modes must be an array")
    failure_modes: list[FailureMode] = []
    for index, raw_failure_mode in enumerate(failure_modes_value):
        parsed = _require_exact_keys(
            raw_failure_mode,
            {"code", "summary"},
            f"validation.failure_modes[{index}]",
        )
        failure_modes.append(FailureMode(code=parsed["code"], summary=parsed["summary"]))

    return SegmentationProfile(
        id=manifest["id"],
        name=manifest["name"],
        version=manifest["version"],
        status=manifest["status"],
        availability=AvailabilitySummary(
            code=availability["code"],
            summary=availability["summary"],
        ),
        backend_kind=manifest["backend_kind"],
        model=ModelArtifact(
            format=model["format"],
            artifact_id=model["artifact_id"],
            sha256=model["sha256"],
        ),
        preprocessing=PreprocessingContract(
            channel_conversion=preprocessing["channel_conversion"],
            intensity_normalization=preprocessing["intensity_normalization"],
            resize_policy=preprocessing["resize_policy"],
            max_edge_px=preprocessing["max_edge_px"],
            output_grid=preprocessing["output_grid"],
        ),
        rights=RightsLineage(
            code_license=rights["code_license"],
            model_license=rights["model_license"],
            redistribution=rights["redistribution"],
            commercial_use=rights["commercial_use"],
            training_data_lineage=rights["training_data_lineage"],
        ),
        recommended_settings=_parse_settings(
            manifest["recommended_settings"], manifest["backend_kind"]
        ),
        settings_contract=_parse_settings_contract(manifest["settings_contract"]),
        validation=ValidationSummary(
            status=validation["status"],
            summary=validation["summary"],
            failure_modes=tuple(failure_modes),
        ),
    )


CLASSICAL_SETTINGS_CONTRACT = (
    SettingDefinition(
        "image_mode",
        "Imaging preset",
        "Input",
        "choice",
        "Guides automatic polarity selection for brightfield or fluorescence images.",
        choices=("auto", "brightfield", "fluorescence"),
    ),
    SettingDefinition(
        "polarity",
        "Cell polarity",
        "Input",
        "choice",
        "Select whether cells are darker or brighter than their background.",
        choices=("auto", "dark", "bright"),
    ),
    SettingDefinition(
        "expected_diameter_px",
        "Expected diameter",
        "Instances",
        "number",
        "Approximate cell diameter in source-image pixels.",
        4,
        1000,
        1,
    ),
    SettingDefinition(
        "min_area_px",
        "Minimum cell area",
        "Instances",
        "integer",
        "Reject connected regions smaller than this source-image area.",
        1,
        10_000_000,
        1,
    ),
    SettingDefinition(
        "sensitivity",
        "Sensitivity",
        "Detection",
        "number",
        "Positive values admit more foreground; negative values are stricter.",
        -1,
        1,
        0.05,
    ),
    SettingDefinition(
        "smoothing_px",
        "Edge smoothing",
        "Detection",
        "number",
        "Gaussian smoothing radius in source-image pixels.",
        0,
        20,
        0.1,
    ),
    SettingDefinition(
        "split_touching",
        "Split touching cells",
        "Instances",
        "boolean",
        "Use distance-transform watershed to separate touching foreground regions.",
    ),
    SettingDefinition(
        "exclude_border",
        "Exclude border cells",
        "Instances",
        "boolean",
        "Remove instances that touch an image border.",
    ),
)


CELLPOSE_SETTINGS_CONTRACT = (
    SettingDefinition(
        "max_edge_px",
        "Maximum inference edge",
        "Input",
        "integer",
        (
            "Downsample only when an image edge exceeds this size; outputs return to source "
            "resolution."
        ),
        64,
        10_000,
        16,
    ),
    SettingDefinition(
        "diameter_px",
        "Expected diameter",
        "Input",
        "number",
        "Cell diameter in source pixels; zero lets Cellpose use native scale.",
        0,
        10_000,
        1,
    ),
    SettingDefinition(
        "flow_threshold",
        "Flow threshold",
        "Mask filtering",
        "number",
        "Reject masks whose flow consistency error exceeds this value.",
        0,
        3,
        0.05,
    ),
    SettingDefinition(
        "cellprob_threshold",
        "Cell probability threshold",
        "Mask filtering",
        "number",
        "Lower values retain more and larger candidate masks.",
        -10,
        10,
        0.1,
    ),
    SettingDefinition(
        "min_size_px",
        "Minimum mask area",
        "Mask filtering",
        "integer",
        "Discard masks smaller than this area on the inference grid.",
        0,
        10_000_000,
        1,
    ),
    SettingDefinition(
        "max_size_fraction",
        "Maximum mask fraction",
        "Mask filtering",
        "number",
        "Discard a mask larger than this fraction of the inference image.",
        0.01,
        1,
        0.01,
    ),
    SettingDefinition(
        "niter",
        "Dynamics iterations",
        "Dynamics",
        "integer",
        "Number of flow-integration iterations used to form instances.",
        1,
        10_000,
        10,
    ),
    SettingDefinition(
        "batch_size",
        "Tile batch size",
        "Performance",
        "integer",
        "Tiles processed together; lower this when device memory is constrained.",
        1,
        256,
        1,
    ),
    SettingDefinition(
        "resample",
        "Resample dynamics",
        "Dynamics",
        "boolean",
        "Run dynamics at the inference image size for more precise boundaries.",
    ),
    SettingDefinition(
        "augment",
        "Tile augmentation",
        "Performance",
        "boolean",
        "Flip overlapping tiles and average predictions at additional compute cost.",
    ),
    SettingDefinition(
        "tile_overlap",
        "Tile overlap",
        "Performance",
        "number",
        "Fractional overlap between adjacent inference tiles.",
        0.05,
        0.5,
        0.05,
    ),
    SettingDefinition(
        "normalize",
        "Normalize intensities",
        "Normalization",
        "boolean",
        "Normalize image intensities before inference.",
    ),
    SettingDefinition(
        "percentile_low",
        "Low percentile",
        "Normalization",
        "number",
        "Intensity percentile mapped to the low end of the normalized range.",
        0,
        100,
        0.1,
    ),
    SettingDefinition(
        "percentile_high",
        "High percentile",
        "Normalization",
        "number",
        "Intensity percentile mapped to the high end of the normalized range.",
        0,
        100,
        0.1,
    ),
    SettingDefinition(
        "tile_norm_blocksize",
        "Local normalization block",
        "Normalization",
        "integer",
        "Set a tile size for local normalization; zero keeps whole-image normalization.",
        0,
        10_000,
        16,
    ),
    SettingDefinition(
        "sharpen_radius",
        "Sharpen radius",
        "Normalization",
        "number",
        "High-pass sharpening radius; zero disables sharpening.",
        0,
        10_000,
        1,
    ),
    SettingDefinition(
        "smooth_radius",
        "Smoothing radius",
        "Normalization",
        "number",
        "Pre-inference smoothing radius; zero disables smoothing.",
        0,
        10_000,
        1,
    ),
    SettingDefinition(
        "invert",
        "Invert intensities",
        "Normalization",
        "boolean",
        "Invert normalized intensities before inference.",
    ),
    SettingDefinition(
        "device",
        "Compute device",
        "Performance",
        "choice",
        "Auto prefers an available accelerator and retries on CPU if acceleration fails.",
        choices=("auto", "cpu", "mps", "cuda"),
    ),
)


CLASSICAL_PROFILE = SegmentationProfile(
    id=DEFAULT_PROFILE_ID,
    name="Loci Adaptive Watershed",
    version=ENGINE_VERSION,
    status="ready",
    availability=AvailabilitySummary(
        code="ready",
        summary="Built into Loci and ready for local processing.",
    ),
    backend_kind="classical",
    model=ModelArtifact(format="builtin-algorithm", artifact_id=None, sha256=None),
    preprocessing=PreprocessingContract(
        channel_conversion="grayscale-luminance",
        intensity_normalization="per-image-percentile-1-99",
        resize_policy="none",
        max_edge_px=None,
        output_grid="source-resolution",
    ),
    rights=RightsLineage(
        code_license="Apache-2.0",
        model_license="not-applicable",
        redistribution="bundled",
        commercial_use="permitted",
        training_data_lineage=(
            "No learned weights or training data; deterministic image processing."
        ),
    ),
    recommended_settings=SegmentationSettings(),
    settings_contract=CLASSICAL_SETTINGS_CONTRACT,
    validation=ValidationSummary(
        status="baseline",
        summary=(
            "Deterministic baseline with structural sanity checks; not an accuracy-validated "
            "cell model."
        ),
        failure_modes=(
            FailureMode(
                code="dense-clusters",
                summary="Touching cells in dense clusters may merge or split incorrectly.",
            ),
            FailureMode(
                code="low-contrast",
                summary="Low-contrast, unevenly illuminated cells may be missed.",
            ),
            FailureMode(
                code="debris-and-dead-cells",
                summary="Morphology alone cannot reliably distinguish viable cells from debris.",
            ),
        ),
    ),
)


def _cellpose_profile(profile_id: str) -> SegmentationProfile:
    from .cellpose_backend import (
        CELLPOSE_PACKAGE_VERSION,
        get_cellpose_status,
        resolve_cellpose_model_spec,
    )

    spec = resolve_cellpose_model_spec(profile_id)
    backend_status = get_cellpose_status(spec)
    website_compatible = profile_id == CELLPOSE_WEBSITE_PROFILE_ID
    validation_failure_codes = {
        "model-hash-mismatch",
        "model-invalid",
        "model-size-mismatch",
        "model-unverified",
    }
    profile_status: ProfileStatus = (
        "validation_failed"
        if backend_status.code in validation_failure_codes
        else ("ready" if backend_status.ready else "unavailable")
    )
    return SegmentationProfile(
        id=profile_id,
        name=(
            "Cellpose-SAM · Website compatible"
            if website_compatible
            else "Cellpose-SAM v2"
        ),
        version=CELLPOSE_PACKAGE_VERSION,
        status=profile_status,
        availability=AvailabilitySummary(
            code=backend_status.code,
            summary=backend_status.summary,
        ),
        backend_kind="cellpose",
        model=ModelArtifact(
            format="cellpose-native",
            artifact_id=spec.artifact_id,
            sha256=spec.sha256,
        ),
        preprocessing=PreprocessingContract(
            channel_conversion="rgb-or-replicated-grayscale",
            intensity_normalization="cellpose-configurable-percentile",
            resize_policy="downsample-only",
            max_edge_px=1000,
            output_grid="source-resolution",
        ),
        rights=RightsLineage(
            code_license="BSD-3-Clause",
            model_license="BSD-3-Clause repository declaration with lineage caveat",
            redistribution="unknown",
            commercial_use="restricted",
            training_data_lineage=(
                "The official checkpoint repository declares BSD-3-Clause, while the "
                "maintainers state that Cellpose models were trained on CC-BY-NC datasets. "
                "Loci does not bundle the checkpoint; commercial use needs written clearance."
            ),
        ),
        recommended_settings=CellposeSettings(),
        settings_contract=CELLPOSE_SETTINGS_CONTRACT,
        validation=ValidationSummary(
            status="limited",
            summary=(
                (
                    "Recommended for parity with the official Cellpose Hugging Face Space on "
                    "routine uint8 images. This profile uses the official cpsam checkpoint and "
                    "the Space's OpenCV uint8 resize path; higher-bit-depth inputs preserve their "
                    "dynamic range."
                )
                if website_compatible
                else (
                    "Official generalist Cellpose-SAM v2 checkpoint. On routine uint8 images "
                    "Loci uses the Space-compatible OpenCV resize path; higher-bit-depth inputs "
                    "preserve their dynamic range. Accuracy is not yet validated on a locked lab "
                    "set."
                )
            ),
            failure_modes=(
                FailureMode(
                    code="viability-not-inferred",
                    summary=(
                        "Morphology alone does not establish whether a segmented cell is alive."
                    ),
                ),
                FailureMode(
                    code="domain-shift",
                    summary=(
                        "Performance can change across cell types, optics, focus, and staining."
                    ),
                ),
                FailureMode(
                    code="dense-clusters",
                    summary="Dense touching clusters may still merge or split incorrectly.",
                ),
            ),
        ),
    )


BUILTIN_PROFILES: tuple[SegmentationProfile, ...] = (CLASSICAL_PROFILE,)
_PROFILE_INDEX = MappingProxyType({profile.id: profile for profile in BUILTIN_PROFILES})
CELLPOSE_PROFILE_IDS = (CELLPOSE_WEBSITE_PROFILE_ID, CELLPOSE_PROFILE_ID)


def list_profiles() -> tuple[SegmentationProfile, ...]:
    cellpose_profiles = tuple(_cellpose_profile(profile_id) for profile_id in CELLPOSE_PROFILE_IDS)
    return (*BUILTIN_PROFILES, *cellpose_profiles)


def resolve_profile(profile_id: object, *, require_ready: bool = False) -> SegmentationProfile:
    if not isinstance(profile_id, str) or not profile_id:
        raise TypeError("profile_id must be a non-empty string")
    try:
        profile = (
            _cellpose_profile(profile_id)
            if profile_id in CELLPOSE_PROFILE_IDS
            else _PROFILE_INDEX[profile_id]
        )
    except KeyError as exc:
        raise ValueError(f"Unknown segmentation profile: {profile_id}") from exc
    if require_ready and profile.status != "ready":
        raise RuntimeError(
            f"Segmentation profile '{profile.id}' is not ready (status: {profile.status})."
        )
    return profile
