"""Bounded in-process storage for exportable analysis results."""

from __future__ import annotations

import secrets
import threading
from collections import OrderedDict
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from math import isfinite
from typing import Literal

import numpy as np
from scipy import ndimage as ndi
from skimage import measure
from skimage.draw import line, polygon2mask

from .models import ENGINE_VERSION, AnalysisSettings, SourceMetadata
from .profiles import CLASSICAL_PROFILE, SegmentationProfile
from .segment import SegmentationOutput, rebuild_output_from_labels

ANALYSIS_SCHEMA_VERSION = "1.0"
MAX_CORRECTION_OPERATIONS = 100
MAX_CORRECTION_EVENTS = 256
MAX_POLYGON_POINTS = 1024
MAX_BRUSH_RADIUS_PX = 256
MAX_EDITABLE_BOUNDARY_VERTICES = 96

CorrectionKind = Literal[
    "delete_instance",
    "add_polygon",
    "split_instance",
    "merge_instances",
    "replace_instance_boundary",
    "paint_stroke",
    "erase_stroke",
    "move_boundary_vertex",
]
CorrectionAction = Literal["apply", "undo", "redo"]


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


@dataclass(frozen=True, slots=True)
class CorrectionOperation:
    operation_id: str
    kind: CorrectionKind
    created_at: str
    x: int | None = None
    y: int | None = None
    other_x: int | None = None
    other_y: int | None = None
    points: tuple[tuple[float, float], ...] = ()
    brush_radius_px: int | None = None
    target_cell_id: int | None = None
    other_target_cell_id: int | None = None
    affected_area_px: int = 0
    resulting_cell_count: int = 0

    def to_dict(self) -> dict[str, object]:
        record: dict[str, object] = {
            "operation_id": self.operation_id,
            "type": self.kind,
            "created_at": self.created_at,
            "affected_area_px": self.affected_area_px,
            "resulting_cell_count": self.resulting_cell_count,
        }
        if self.kind == "delete_instance":
            record["source_coordinate"] = {"x": self.x, "y": self.y}
            record["target_cell_id_at_apply"] = self.target_cell_id
        elif self.kind == "add_polygon":
            record["source_polygon"] = [
                {"x": round(x, 6), "y": round(y, 6)} for x, y in self.points
            ]
        elif self.kind == "split_instance":
            record["source_coordinate"] = {"x": self.x, "y": self.y}
            record["source_polyline"] = [
                {"x": round(x, 6), "y": round(y, 6)} for x, y in self.points
            ]
            record["target_cell_id_at_apply"] = self.target_cell_id
        elif self.kind == "merge_instances":
            record["source_coordinates"] = [
                {"x": self.x, "y": self.y},
                {"x": self.other_x, "y": self.other_y},
            ]
            record["target_cell_ids_at_apply"] = [
                self.target_cell_id,
                self.other_target_cell_id,
            ]
        elif self.kind == "replace_instance_boundary":
            record["source_coordinate"] = {"x": self.x, "y": self.y}
            record["source_polygon"] = [
                {"x": round(x, 6), "y": round(y, 6)} for x, y in self.points
            ]
            record["target_cell_id_at_apply"] = self.target_cell_id
        elif self.kind in {"paint_stroke", "erase_stroke"}:
            record["source_polyline"] = [
                {"x": round(x, 6), "y": round(y, 6)} for x, y in self.points
            ]
            record["brush_radius_px"] = self.brush_radius_px
            if self.kind == "paint_stroke":
                record["target_cell_id_at_apply"] = self.target_cell_id
        elif self.kind == "move_boundary_vertex":
            record["source_coordinate"] = {"x": self.x, "y": self.y}
            record["source_polygon"] = [
                {"x": round(x, 6), "y": round(y, 6)} for x, y in self.points
            ]
            record["target_cell_id_at_apply"] = self.target_cell_id
        return record


@dataclass(frozen=True, slots=True)
class CorrectionEvent:
    revision: int
    action: CorrectionAction
    occurred_at: str
    operation: CorrectionOperation
    discarded_redo_count: int = 0

    def to_dict(self) -> dict[str, object]:
        record: dict[str, object] = {
            "revision": self.revision,
            "action": self.action,
            "occurred_at": self.occurred_at,
            "operation": self.operation.to_dict(),
        }
        if self.discarded_redo_count:
            record["discarded_redo_count"] = self.discarded_redo_count
        return record


def _orientation(
    first: tuple[float, float],
    second: tuple[float, float],
    third: tuple[float, float],
) -> float:
    return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (
        third[0] - first[0]
    )


def _on_segment(
    first: tuple[float, float],
    point: tuple[float, float],
    second: tuple[float, float],
) -> bool:
    epsilon = 1e-9
    return (
        min(first[0], second[0]) - epsilon <= point[0] <= max(first[0], second[0]) + epsilon
        and min(first[1], second[1]) - epsilon <= point[1] <= max(first[1], second[1]) + epsilon
    )


def _segments_intersect(
    first_start: tuple[float, float],
    first_end: tuple[float, float],
    second_start: tuple[float, float],
    second_end: tuple[float, float],
) -> bool:
    values = (
        _orientation(first_start, first_end, second_start),
        _orientation(first_start, first_end, second_end),
        _orientation(second_start, second_end, first_start),
        _orientation(second_start, second_end, first_end),
    )
    epsilon = 1e-9
    if (
        (values[0] > epsilon and values[1] < -epsilon)
        or (values[0] < -epsilon and values[1] > epsilon)
    ) and (
        (values[2] > epsilon and values[3] < -epsilon)
        or (values[2] < -epsilon and values[3] > epsilon)
    ):
        return True
    return any(
        abs(value) <= epsilon and _on_segment(start, point, end)
        for value, start, point, end in (
            (values[0], first_start, second_start, first_end),
            (values[1], first_start, second_end, first_end),
            (values[2], second_start, first_start, second_end),
            (values[3], second_start, first_end, second_end),
        )
    )


def _is_simple_polygon(points: tuple[tuple[float, float], ...]) -> bool:
    count = len(points)
    for first_index in range(count):
        first_end_index = (first_index + 1) % count
        for second_index in range(first_index + 1, count):
            second_end_index = (second_index + 1) % count
            if (
                first_index == second_index
                or first_end_index == second_index
                or second_end_index == first_index
            ):
                continue
            if _segments_intersect(
                points[first_index],
                points[first_end_index],
                points[second_index],
                points[second_end_index],
            ):
                return False
    return True


def assess_quality(output: SegmentationOutput) -> dict[str, object]:
    """Flag structural failure modes without presenting them as accuracy estimates."""

    flags: list[dict[str, str]] = []
    coverage = output.confluence_percent
    if output.count == 0:
        flags.append(
            {
                "code": "no_instances",
                "severity": "error",
                "message": (
                    "No cell instances were found. Check the preset, polarity, and image contrast."
                ),
            }
        )
    if coverage >= 80:
        flags.append(
            {
                "code": "foreground_coverage_extreme",
                "severity": "error",
                "message": (
                    f"The mask covers {coverage:.1f}% of the image. This count is not usable for "
                    "discrete cells; check polarity or use a model matched to this imaging "
                    "workflow."
                ),
            }
        )
    elif coverage >= 60:
        flags.append(
            {
                "code": "foreground_coverage_high",
                "severity": "warning",
                "message": (
                    f"The mask covers {coverage:.1f}% of the image. Individual-cell counting may "
                    "be unreliable at this coverage; inspect the overlay closely."
                ),
            }
        )
    elif output.count and coverage <= 0.05:
        flags.append(
            {
                "code": "foreground_coverage_low",
                "severity": "warning",
                "message": (
                    f"The mask covers only {coverage:.2f}% of the image. The current settings may "
                    "be missing cells."
                ),
            }
        )

    if output.measurements:
        largest_area = max(float(row["area_px"]) for row in output.measurements)
        largest_percent = largest_area / output.labels.size * 100
        if largest_percent >= 50:
            flags.append(
                {
                    "code": "dominant_instance_extreme",
                    "severity": "error",
                    "message": (
                        f"One segment occupies {largest_percent:.1f}% of the image. This usually "
                        "indicates merged foreground rather than one cell."
                    ),
                }
            )
        elif largest_percent >= 20:
            flags.append(
                {
                    "code": "dominant_instance_large",
                    "severity": "warning",
                    "message": (
                        f"One segment occupies {largest_percent:.1f}% of the image. Check for "
                        "under-segmentation or a genuinely large object."
                    ),
                }
            )

    severities = {flag["severity"] for flag in flags}
    status = "invalid" if "error" in severities else "warning" if flags else "nominal"
    return {
        "status": status,
        "scope": "structural_sanity_only",
        "flags": flags,
    }


@dataclass(frozen=True, slots=True)
class CachedAnalysis:
    """The full-resolution state needed to export one segmentation result."""

    result_id: str
    created_at: str
    source: SourceMetadata
    settings: AnalysisSettings
    output: SegmentationOutput
    profile: SegmentationProfile = CLASSICAL_PROFILE
    runtime: dict[str, object] | None = None
    base_output: SegmentationOutput | None = None
    applied_corrections: tuple[CorrectionOperation, ...] = ()
    redo_corrections: tuple[CorrectionOperation, ...] = ()
    correction_events: tuple[CorrectionEvent, ...] = ()
    correction_revision: int = 0
    correction_event_count: int = 0

    def corrections_dict(self) -> dict[str, object]:
        record: dict[str, object] = {
            "revision": self.correction_revision,
            "has_manual_edits": bool(self.applied_corrections),
            "can_undo": bool(self.applied_corrections),
            "can_redo": bool(self.redo_corrections),
            "applied_operations": [operation.to_dict() for operation in self.applied_corrections],
            "events": [event.to_dict() for event in self.correction_events],
            "event_count": self.correction_event_count,
            "events_truncated": self.correction_event_count > len(self.correction_events),
        }
        return record

    def provenance_dict(self, *, include_source_path: bool = False) -> dict[str, object]:
        """Return the serializable scientific record shared by UI and exports."""

        source = self.source.to_dict()
        if not include_source_path:
            source.pop("path", None)
        record: dict[str, object] = {
            "schema_version": ANALYSIS_SCHEMA_VERSION,
            "result_id": self.result_id,
            "created_at": self.created_at,
            "source": source,
            "engine": {"id": self.profile.id, "version": ENGINE_VERSION},
            "profile": self.profile.provenance_dict(),
            "settings": self.settings.to_dict(),
            "resolved": {
                "polarity": self.output.resolved_polarity,
                "threshold": self.output.threshold,
            },
            "metrics": {
                "count": self.output.count,
                "confluence_percent": self.output.confluence_percent,
            },
            "quality": assess_quality(self.output),
            "measurements": self.output.measurements,
            "corrections": self.corrections_dict(),
        }
        if self.runtime is not None:
            record["runtime"] = self.runtime
        return record


class ResultCache:
    """A small LRU cache that keeps export arrays out of the JSON-lines channel."""

    def __init__(
        self,
        max_entries: int = 8,
        max_bytes: int = 384 * 1024 * 1024,
        *,
        max_correction_operations: int = MAX_CORRECTION_OPERATIONS,
        max_correction_events: int = MAX_CORRECTION_EVENTS,
        max_polygon_points: int = MAX_POLYGON_POINTS,
    ) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be at least 1")
        if max_bytes < 1:
            raise ValueError("max_bytes must be at least 1")
        if max_correction_operations < 1:
            raise ValueError("max_correction_operations must be at least 1")
        if max_correction_events < 1:
            raise ValueError("max_correction_events must be at least 1")
        if max_polygon_points < 3:
            raise ValueError("max_polygon_points must be at least 3")
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._max_correction_operations = max_correction_operations
        self._max_correction_events = max_correction_events
        self._max_polygon_points = max_polygon_points
        self._items: OrderedDict[str, CachedAnalysis] = OrderedDict()
        self._lock = threading.RLock()

    def add(
        self,
        *,
        source: SourceMetadata,
        settings: AnalysisSettings,
        output: SegmentationOutput,
        profile: SegmentationProfile = CLASSICAL_PROFILE,
        runtime: dict[str, object] | None = None,
    ) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            evicted_result_ids: list[str] = []
            # The renderer retains only the newest analysis for one imported path.
            # Byte-identical files in different folders remain distinct batch items.
            for existing_id, existing in list(self._items.items()):
                if existing.source.path == source.path:
                    self._items.pop(existing_id)
                    evicted_result_ids.append(existing_id)
            result_id = secrets.token_urlsafe(24)
            result = CachedAnalysis(
                result_id=result_id,
                created_at=_now(),
                source=source,
                settings=settings,
                output=output,
                profile=profile,
                runtime=runtime,
            )
            self._items[result_id] = result
            self._items.move_to_end(result_id)
            evicted_result_ids.extend(self._enforce_limits_locked())
            return result, evicted_result_ids

    def restore(self, result: CachedAnalysis) -> tuple[CachedAnalysis, list[str]]:
        """Insert a fully verified recoverable result without changing its identity.

        Pack parsing and scientific-state validation happen before this method is called.
        The cache mutation is intentionally one locked publish step so a failed restore
        cannot evict or partially replace a live result.
        """

        if not isinstance(result, CachedAnalysis):
            raise TypeError("result must be a verified CachedAnalysis")
        self._validate_result_id(result.result_id)
        with self._lock:
            evicted_result_ids: list[str] = []
            for existing_id, existing in list(self._items.items()):
                if existing_id == result.result_id or existing.source.path == result.source.path:
                    self._items.pop(existing_id)
                    if existing_id != result.result_id:
                        evicted_result_ids.append(existing_id)
            self._items[result.result_id] = result
            self._items.move_to_end(result.result_id)
            evicted_result_ids.extend(self._enforce_limits_locked())
            return result, evicted_result_ids

    def _enforce_limits_locked(self) -> list[str]:
        evicted_result_ids: list[str] = []
        while len(self._items) > 1 and (
            len(self._items) > self._max_entries
            or sum(self._estimated_bytes(item) for item in self._items.values()) > self._max_bytes
        ):
            evicted_id, _ = self._items.popitem(last=False)
            evicted_result_ids.append(evicted_id)
        return evicted_result_ids

    @staticmethod
    def _estimated_bytes(result: CachedAnalysis) -> int:
        output = result.output
        estimated = (
            int(output.normalized.nbytes)
            + int(output.labels.nbytes)
            + len(output.measurements) * 256
        )
        if result.base_output is not None and not np.shares_memory(
            result.base_output.labels, output.labels
        ):
            estimated += int(result.base_output.labels.nbytes)
        estimated += sum(
            len(operation.points) * 16 + 256 for operation in result.applied_corrections
        )
        estimated += sum(len(operation.points) * 16 + 256 for operation in result.redo_corrections)
        estimated += len(result.correction_events) * 384
        return estimated

    @staticmethod
    def _validate_result_id(result_id: object) -> str:
        if not isinstance(result_id, str) or not result_id:
            raise TypeError("result_id must be a non-empty string")
        return result_id

    def _get_locked(self, result_id: object) -> CachedAnalysis:
        validated = self._validate_result_id(result_id)
        try:
            result = self._items[validated]
        except KeyError as exc:
            raise KeyError(
                "Unknown or expired result_id. Run segmentation again before using this result."
            ) from exc
        self._items.move_to_end(validated)
        return result

    def get(self, result_id: str) -> CachedAnalysis:
        with self._lock:
            return self._get_locked(result_id)

    def discard(self, result_id: object) -> bool:
        """Idempotently release one cached full-resolution result."""

        validated = self._validate_result_id(result_id)
        with self._lock:
            return self._items.pop(validated, None) is not None

    @staticmethod
    def _coordinate(value: object, *, name: str, maximum: int) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f"{name} must be an integer source-pixel coordinate")
        if not 0 <= value < maximum:
            raise ValueError(f"{name} must be between 0 and {maximum - 1}")
        return value

    def _polygon(
        self,
        value: object,
        *,
        width: int,
        height: int,
    ) -> tuple[tuple[float, float], ...]:
        if not isinstance(value, (list, tuple)):
            raise TypeError("points must be an array of source-coordinate objects")
        if len(value) > self._max_polygon_points:
            raise ValueError(
                f"A correction polygon may contain at most {self._max_polygon_points} points"
            )
        points: list[tuple[float, float]] = []
        for index, point in enumerate(value):
            if not isinstance(point, dict):
                raise TypeError(f"points[{index}] must be an object with x and y")
            unknown = set(point) - {"x", "y"}
            if unknown:
                raise ValueError(f"Unknown points[{index}] fields: {', '.join(sorted(unknown))}")
            if "x" not in point or "y" not in point:
                raise ValueError(f"points[{index}] must include x and y")
            coordinates: list[float] = []
            for name, maximum in (("x", width), ("y", height)):
                coordinate = point[name]
                if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)):
                    raise TypeError(f"points[{index}].{name} must be a finite number")
                numeric = float(coordinate)
                if not isfinite(numeric):
                    raise ValueError(f"points[{index}].{name} must be finite")
                if not 0 <= numeric <= maximum - 1:
                    raise ValueError(f"points[{index}].{name} must be between 0 and {maximum - 1}")
                coordinates.append(numeric)
            points.append((coordinates[0], coordinates[1]))

        if len(points) >= 2 and points[0] == points[-1]:
            points.pop()
        polygon = tuple(points)
        if len(polygon) < 3 or len(set(polygon)) < 3:
            raise ValueError("A correction polygon requires at least three distinct points")
        if not _is_simple_polygon(polygon):
            raise ValueError("A correction polygon cannot self-intersect")
        area_twice = abs(
            sum(
                x * polygon[(index + 1) % len(polygon)][1]
                - polygon[(index + 1) % len(polygon)][0] * y
                for index, (x, y) in enumerate(polygon)
            )
        )
        if area_twice <= 1e-9:
            raise ValueError("A correction polygon must enclose a non-zero area")
        return polygon

    @staticmethod
    def _polygon_mask(
        points: tuple[tuple[float, float], ...],
        shape: tuple[int, int],
    ) -> np.ndarray:
        vertices = np.asarray([(y, x) for x, y in points], dtype=np.float64)
        return polygon2mask(shape, vertices)

    def _polyline(
        self,
        value: object,
        *,
        width: int,
        height: int,
    ) -> tuple[tuple[float, float], ...]:
        if not isinstance(value, (list, tuple)):
            raise TypeError("points must be an array of source-coordinate objects")
        if len(value) > self._max_polygon_points:
            raise ValueError(
                f"A correction polyline may contain at most {self._max_polygon_points} points"
            )
        points: list[tuple[float, float]] = []
        for index, point in enumerate(value):
            if not isinstance(point, dict):
                raise TypeError(f"points[{index}] must be an object with x and y")
            unknown = set(point) - {"x", "y"}
            if unknown:
                raise ValueError(f"Unknown points[{index}] fields: {', '.join(sorted(unknown))}")
            if "x" not in point or "y" not in point:
                raise ValueError(f"points[{index}] must include x and y")
            coordinates: list[float] = []
            for name, maximum in (("x", width), ("y", height)):
                coordinate = point[name]
                if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)):
                    raise TypeError(f"points[{index}].{name} must be a finite number")
                numeric = float(coordinate)
                if not isfinite(numeric):
                    raise ValueError(f"points[{index}].{name} must be finite")
                if not 0 <= numeric <= maximum - 1:
                    raise ValueError(f"points[{index}].{name} must be between 0 and {maximum - 1}")
                coordinates.append(numeric)
            candidate = (coordinates[0], coordinates[1])
            if not points or candidate != points[-1]:
                points.append(candidate)

        polyline = tuple(points)
        if len(polyline) < 2:
            raise ValueError("A correction polyline requires at least two distinct points")
        return polyline

    def _stroke(
        self,
        value: object,
        *,
        width: int,
        height: int,
    ) -> tuple[tuple[float, float], ...]:
        """Validate a bounded brush stroke, including a deliberate single click."""

        if not isinstance(value, (list, tuple)):
            raise TypeError("points must be an array of source-coordinate objects")
        if len(value) > self._max_polygon_points:
            raise ValueError(
                f"A correction stroke may contain at most {self._max_polygon_points} points"
            )
        points: list[tuple[float, float]] = []
        for index, point in enumerate(value):
            if not isinstance(point, dict):
                raise TypeError(f"points[{index}] must be an object with x and y")
            unknown = set(point) - {"x", "y"}
            if unknown:
                raise ValueError(f"Unknown points[{index}] fields: {', '.join(sorted(unknown))}")
            if "x" not in point or "y" not in point:
                raise ValueError(f"points[{index}] must include x and y")
            coordinates: list[float] = []
            for name, maximum in (("x", width), ("y", height)):
                coordinate = point[name]
                if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)):
                    raise TypeError(f"points[{index}].{name} must be a finite number")
                numeric = float(coordinate)
                if not isfinite(numeric):
                    raise ValueError(f"points[{index}].{name} must be finite")
                if not 0 <= numeric <= maximum - 1:
                    raise ValueError(f"points[{index}].{name} must be between 0 and {maximum - 1}")
                coordinates.append(numeric)
            candidate = (coordinates[0], coordinates[1])
            if not points or candidate != points[-1]:
                points.append(candidate)
        if not points:
            raise ValueError("A correction stroke requires at least one source point")
        return tuple(points)

    @staticmethod
    def _brush_radius(value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError("radius_px must be an integer source-pixel radius")
        if not 1 <= value <= MAX_BRUSH_RADIUS_PX:
            raise ValueError(f"radius_px must be between 1 and {MAX_BRUSH_RADIUS_PX}")
        return value

    @staticmethod
    def _polyline_mask(
        points: tuple[tuple[float, float], ...],
        shape: tuple[int, int],
    ) -> np.ndarray:
        mask = np.zeros(shape, dtype=bool)
        for (start_x, start_y), (end_x, end_y) in zip(points, points[1:], strict=False):
            rows, columns = line(
                int(round(start_y)),
                int(round(start_x)),
                int(round(end_y)),
                int(round(end_x)),
            )
            mask[rows, columns] = True
        if np.count_nonzero(mask) < 2:
            raise ValueError("A correction polyline must cover at least two source pixels")
        return mask

    @classmethod
    def _stroke_mask(
        cls,
        points: tuple[tuple[float, float], ...],
        shape: tuple[int, int],
        radius_px: int,
    ) -> np.ndarray:
        centerline = np.zeros(shape, dtype=bool)
        if len(points) == 1:
            x, y = points[0]
            centerline[int(round(y)), int(round(x))] = True
        else:
            for (start_x, start_y), (end_x, end_y) in zip(
                points,
                points[1:],
                strict=False,
            ):
                rows, columns = line(
                    int(round(start_y)),
                    int(round(start_x)),
                    int(round(end_y)),
                    int(round(end_x)),
                )
                centerline[rows, columns] = True
        offsets = np.arange(-radius_px, radius_px + 1)
        yy, xx = np.meshgrid(offsets, offsets, indexing="ij")
        disk = xx * xx + yy * yy <= radius_px * radius_px
        return ndi.binary_dilation(centerline, structure=disk)

    @staticmethod
    def _selected_instance(labels: np.ndarray, *, x: int, y: int) -> int:
        target = int(labels[y, x])
        if target == 0:
            raise ValueError("The selected source pixel is not inside a segmented instance")
        return target

    @classmethod
    def _split_labels(
        cls,
        labels: np.ndarray,
        operation: CorrectionOperation,
        *,
        replay: bool,
    ) -> tuple[np.ndarray, int]:
        error = RuntimeError if replay else ValueError
        assert operation.x is not None and operation.y is not None
        corrected = np.asarray(labels, dtype=np.int32).copy()
        target = int(corrected[operation.y, operation.x])
        if target == 0:
            raise error("The split selection no longer targets an instance")

        try:
            stroke = cls._polyline_mask(operation.points, corrected.shape)
        except ValueError as exc:
            raise error(str(exc)) from exc
        crossed = {int(value) for value in np.unique(corrected[stroke]) if int(value) != 0}
        if crossed != {target}:
            raise error("The split polyline must pass through exactly the selected instance")

        target_mask = corrected == target
        # A one-pixel diagonal stroke is not a separating boundary under 8-connectivity.
        # Dilating only inside the selected instance creates a deterministic narrow cut
        # without changing any neighbouring object.
        barrier = ndi.binary_dilation(stroke, structure=np.ones((3, 3), dtype=bool)) & target_mask
        components, component_count = ndi.label(
            target_mask & ~barrier,
            structure=np.ones((3, 3), dtype=bool),
        )
        if component_count != 2:
            raise error(
                "The split polyline must divide the selected instance into exactly two "
                "connected components"
            )
        if not np.any(components == 1) or not np.any(components == 2):
            raise error("Both split components must contain source pixels")

        corrected[target_mask] = 0
        corrected[components == 1] = target
        corrected[components == 2] = int(corrected.max(initial=0)) + 1
        return corrected, int(np.count_nonzero(barrier))

    @staticmethod
    def _merge_labels(
        labels: np.ndarray,
        operation: CorrectionOperation,
        *,
        replay: bool,
    ) -> tuple[np.ndarray, int]:
        error = RuntimeError if replay else ValueError
        assert operation.x is not None and operation.y is not None
        assert operation.other_x is not None and operation.other_y is not None
        corrected = np.asarray(labels, dtype=np.int32).copy()
        target = int(corrected[operation.y, operation.x])
        other = int(corrected[operation.other_y, operation.other_x])
        if target == 0 or other == 0:
            raise error("Both merge selections must be inside segmented instances")
        if target == other:
            raise error("Merge requires two distinct segmented instances")

        target_mask = corrected == target
        other_mask = corrected == other
        adjacent = np.any(
            ndi.binary_dilation(target_mask, structure=np.ones((3, 3), dtype=bool)) & other_mask
        )
        if not adjacent:
            raise error("The selected instances must be touching or immediately adjacent")
        combined = target_mask | other_mask
        _, component_count = ndi.label(combined, structure=np.ones((3, 3), dtype=bool))
        if component_count != 1:
            raise error("The selected instances cannot be merged into one connected object")

        corrected[other_mask] = target
        return corrected, int(np.count_nonzero(combined))

    @classmethod
    def _replace_boundary_labels(
        cls,
        labels: np.ndarray,
        operation: CorrectionOperation,
        *,
        replay: bool,
    ) -> tuple[np.ndarray, int]:
        error = RuntimeError if replay else ValueError
        assert operation.x is not None and operation.y is not None
        corrected = np.asarray(labels, dtype=np.int32).copy()
        target = int(corrected[operation.y, operation.x])
        if target == 0:
            raise error("The replacement selection no longer targets an instance")

        replacement = cls._polygon_mask(operation.points, corrected.shape)
        if not np.any(replacement):
            raise error("The replacement polygon does not cover any source pixels")
        overlaps = {int(value) for value in np.unique(corrected[replacement]) if int(value) != 0}
        if target not in overlaps:
            raise error("The replacement polygon must overlap the selected instance")
        if overlaps != {target}:
            raise error("The replacement polygon may overlap only the selected instance")
        _, component_count = ndi.label(replacement, structure=np.ones((3, 3), dtype=bool))
        if component_count != 1:
            raise error("The replacement polygon must rasterize to one connected object")

        target_mask = corrected == target
        affected_area = int(np.count_nonzero(target_mask ^ replacement))
        corrected[target_mask] = 0
        corrected[replacement] = target
        return corrected, affected_area

    @classmethod
    def _paint_labels(
        cls,
        labels: np.ndarray,
        operation: CorrectionOperation,
        *,
        replay: bool,
    ) -> tuple[np.ndarray, int, int]:
        error = RuntimeError if replay else ValueError
        if operation.brush_radius_px is None:
            raise error("Paint correction history is missing its brush radius")
        corrected = np.asarray(labels, dtype=np.int32).copy()
        stroke = cls._stroke_mask(
            operation.points,
            corrected.shape,
            operation.brush_radius_px,
        )
        overlaps = {int(value) for value in np.unique(corrected[stroke]) if int(value) != 0}
        if len(overlaps) > 1:
            raise error(
                "The paint brush touches more than one instance. Use Merge for an intentional join."
            )
        created = not overlaps
        target = next(iter(overlaps), int(corrected.max(initial=0)) + 1)
        changed = stroke & (corrected == 0)
        affected_area = int(np.count_nonzero(changed))
        if affected_area == 0:
            raise error("The paint stroke does not add any foreground pixels")
        if (
            overlaps
            and operation.target_cell_id is not None
            and not replay
            and target != operation.target_cell_id
        ):
            raise error("The paint selection changed before the correction could be applied")
        corrected[changed] = target
        target_mask = corrected == target
        _, component_count = ndi.label(target_mask, structure=np.ones((3, 3), dtype=bool))
        if component_count != 1:
            raise error("The paint stroke must remain connected to the selected instance")
        return corrected, affected_area, 1 if created else 0

    @classmethod
    def _erase_labels(
        cls,
        labels: np.ndarray,
        operation: CorrectionOperation,
        *,
        replay: bool,
    ) -> tuple[np.ndarray, int]:
        error = RuntimeError if replay else ValueError
        if operation.brush_radius_px is None:
            raise error("Erase correction history is missing its brush radius")
        corrected = np.asarray(labels, dtype=np.int32).copy()
        stroke = cls._stroke_mask(
            operation.points,
            corrected.shape,
            operation.brush_radius_px,
        )
        affected_ids = sorted(
            int(value) for value in np.unique(corrected[stroke]) if int(value) != 0
        )
        if not affected_ids:
            raise error("The eraser stroke does not touch any segmented foreground")
        removed_area = int(np.count_nonzero(corrected[stroke]))
        corrected[stroke] = 0
        next_label = int(corrected.max(initial=0)) + 1
        connectivity = np.ones((3, 3), dtype=bool)
        for target in affected_ids:
            target_mask = corrected == target
            components, component_count = ndi.label(target_mask, structure=connectivity)
            if component_count <= 1:
                continue
            ranked: list[tuple[int, int, int, int]] = []
            for component in range(1, component_count + 1):
                rows, columns = np.nonzero(components == component)
                ranked.append((-len(rows), int(rows.min()), int(columns.min()), component))
            ranked.sort()
            for _size, _row, _column, component in ranked[1:]:
                corrected[components == component] = next_label
                next_label += 1
        return corrected, removed_area

    def _editable_boundary_polygon(
        self,
        labels: np.ndarray,
        target: int,
    ) -> tuple[tuple[tuple[float, float], ...], bool]:
        """Return the canonical bounded outer polygon used by explicit vertex editing."""

        height, width = labels.shape
        mask = labels == target
        padded = np.pad(mask, 1, mode="constant", constant_values=False)
        contours = measure.find_contours(
            padded.astype(np.uint8),
            0.5,
            fully_connected="high",
        )
        if not contours:
            raise RuntimeError("The selected instance has no editable outer boundary")
        contour = max(contours, key=lambda item: (item.shape[0], float(item[:, 0].max())))
        contour = contour - 1
        tolerance = 0.35
        simplified = measure.approximate_polygon(contour, tolerance=tolerance)
        while len(simplified) - 1 > MAX_EDITABLE_BOUNDARY_VERTICES:
            tolerance *= 1.35
            simplified = measure.approximate_polygon(contour, tolerance=tolerance)
        raw_points: list[tuple[float, float]] = []
        for row, column in simplified:
            point = (
                min(width - 1.0, max(0.0, float(column))),
                min(height - 1.0, max(0.0, float(row))),
            )
            if not raw_points or point != raw_points[-1]:
                raw_points.append(point)
        if len(raw_points) >= 2 and raw_points[0] == raw_points[-1]:
            raw_points.pop()
        point_objects = [{"x": x_point, "y": y_point} for x_point, y_point in raw_points]
        polygon = self._polygon(point_objects, width=width, height=height)
        return polygon, len(contour) - 1 > len(polygon)

    def instance_boundary(
        self,
        result_id: object,
        *,
        x: object,
        y: object,
    ) -> dict[str, object]:
        """Return a bounded, deterministic editable outer polygon for one instance."""

        with self._lock:
            result = self._get_locked(result_id)
            height, width = result.output.labels.shape
            x_value = self._coordinate(x, name="x", maximum=width)
            y_value = self._coordinate(y, name="y", maximum=height)
            target = self._selected_instance(result.output.labels, x=x_value, y=y_value)
            polygon, simplified = self._editable_boundary_polygon(result.output.labels, target)
            return {
                "result_id": result.result_id,
                "cell_id": target,
                "source_coordinate": {"x": x_value, "y": y_value},
                "vertices": [
                    {"x": round(x_point, 6), "y": round(y_point, 6)} for x_point, y_point in polygon
                ],
                "simplified": simplified,
            }

    @classmethod
    def _apply_operation_to_labels(
        cls,
        labels: np.ndarray,
        operation: CorrectionOperation,
    ) -> np.ndarray:
        corrected = np.asarray(labels, dtype=np.int32).copy()
        if operation.kind == "delete_instance":
            assert operation.x is not None and operation.y is not None
            target = int(corrected[operation.y, operation.x])
            if target == 0:
                raise RuntimeError("Correction history no longer targets an instance.")
            corrected[corrected == target] = 0
            return corrected
        if operation.kind == "add_polygon":
            mask = cls._polygon_mask(operation.points, corrected.shape)
            if np.any(corrected[mask] != 0):
                raise RuntimeError("Correction history polygon now overlaps an instance.")
            corrected[mask] = int(corrected.max(initial=0)) + 1
            return corrected
        if operation.kind == "split_instance":
            return cls._split_labels(corrected, operation, replay=True)[0]
        if operation.kind == "merge_instances":
            return cls._merge_labels(corrected, operation, replay=True)[0]
        if operation.kind == "replace_instance_boundary":
            return cls._replace_boundary_labels(corrected, operation, replay=True)[0]
        if operation.kind == "paint_stroke":
            return cls._paint_labels(corrected, operation, replay=True)[0]
        if operation.kind == "erase_stroke":
            return cls._erase_labels(corrected, operation, replay=True)[0]
        if operation.kind == "move_boundary_vertex":
            return cls._replace_boundary_labels(corrected, operation, replay=True)[0]
        raise RuntimeError(f"Unknown correction operation kind: {operation.kind}")

    @classmethod
    def _rebuild(
        cls,
        base_output: SegmentationOutput,
        operations: tuple[CorrectionOperation, ...],
    ) -> SegmentationOutput:
        labels = base_output.labels
        for operation in operations:
            labels = cls._apply_operation_to_labels(labels, operation)
        return rebuild_output_from_labels(base_output, labels)

    def _append_event(
        self,
        result: CachedAnalysis,
        *,
        action: CorrectionAction,
        operation: CorrectionOperation,
        discarded_redo_count: int = 0,
    ) -> tuple[tuple[CorrectionEvent, ...], int, int]:
        revision = result.correction_revision + 1
        event_count = result.correction_event_count + 1
        events = (
            *result.correction_events,
            CorrectionEvent(
                revision=revision,
                action=action,
                occurred_at=_now(),
                operation=operation,
                discarded_redo_count=discarded_redo_count,
            ),
        )[-self._max_correction_events :]
        return events, revision, event_count

    def _publish_correction_locked(
        self,
        result: CachedAnalysis,
        **changes: object,
    ) -> tuple[CachedAnalysis, list[str]]:
        updated = replace(result, **changes)
        self._items[result.result_id] = updated
        self._items.move_to_end(result.result_id)
        return updated, self._enforce_limits_locked()

    def delete_instance(
        self,
        result_id: object,
        *,
        x: object,
        y: object,
    ) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            result = self._get_locked(result_id)
            if len(result.applied_corrections) >= self._max_correction_operations:
                raise ValueError(
                    f"A result may contain at most {self._max_correction_operations} corrections"
                )
            x_value = self._coordinate(x, name="x", maximum=result.output.labels.shape[1])
            y_value = self._coordinate(y, name="y", maximum=result.output.labels.shape[0])
            target = int(result.output.labels[y_value, x_value])
            if target == 0:
                raise ValueError("The selected source pixel is not inside a segmented instance")
            affected_area = int(np.count_nonzero(result.output.labels == target))
            operation = CorrectionOperation(
                operation_id=secrets.token_urlsafe(12),
                kind="delete_instance",
                created_at=_now(),
                x=x_value,
                y=y_value,
                target_cell_id=target,
                affected_area_px=affected_area,
                resulting_cell_count=result.output.count - 1,
            )
            output = rebuild_output_from_labels(
                result.output,
                self._apply_operation_to_labels(result.output.labels, operation),
            )
            events, revision, event_count = self._append_event(
                result,
                action="apply",
                operation=operation,
                discarded_redo_count=len(result.redo_corrections),
            )
            return self._publish_correction_locked(
                result,
                base_output=result.base_output or result.output,
                output=output,
                applied_corrections=(*result.applied_corrections, operation),
                redo_corrections=(),
                correction_events=events,
                correction_revision=revision,
                correction_event_count=event_count,
            )

    def add_polygon(
        self,
        result_id: object,
        *,
        points: object,
    ) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            result = self._get_locked(result_id)
            if len(result.applied_corrections) >= self._max_correction_operations:
                raise ValueError(
                    f"A result may contain at most {self._max_correction_operations} corrections"
                )
            polygon = self._polygon(
                points,
                width=result.output.labels.shape[1],
                height=result.output.labels.shape[0],
            )
            mask = self._polygon_mask(polygon, result.output.labels.shape)
            affected_area = int(np.count_nonzero(mask))
            if affected_area == 0:
                raise ValueError("The correction polygon does not cover any source pixels")
            if np.any(result.output.labels[mask] != 0):
                raise ValueError(
                    "The correction polygon overlaps an existing instance; delete that instance "
                    "before drawing its replacement boundary"
                )
            operation = CorrectionOperation(
                operation_id=secrets.token_urlsafe(12),
                kind="add_polygon",
                created_at=_now(),
                points=polygon,
                affected_area_px=affected_area,
                resulting_cell_count=result.output.count + 1,
            )
            output = rebuild_output_from_labels(
                result.output,
                self._apply_operation_to_labels(result.output.labels, operation),
            )
            events, revision, event_count = self._append_event(
                result,
                action="apply",
                operation=operation,
                discarded_redo_count=len(result.redo_corrections),
            )
            return self._publish_correction_locked(
                result,
                base_output=result.base_output or result.output,
                output=output,
                applied_corrections=(*result.applied_corrections, operation),
                redo_corrections=(),
                correction_events=events,
                correction_revision=revision,
                correction_event_count=event_count,
            )

    def split_instance(
        self,
        result_id: object,
        *,
        x: object,
        y: object,
        points: object,
    ) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            result = self._get_locked(result_id)
            if len(result.applied_corrections) >= self._max_correction_operations:
                raise ValueError(
                    f"A result may contain at most {self._max_correction_operations} corrections"
                )
            height, width = result.output.labels.shape
            x_value = self._coordinate(x, name="x", maximum=width)
            y_value = self._coordinate(y, name="y", maximum=height)
            target = self._selected_instance(result.output.labels, x=x_value, y=y_value)
            polyline = self._polyline(points, width=width, height=height)
            operation = CorrectionOperation(
                operation_id=secrets.token_urlsafe(12),
                kind="split_instance",
                created_at=_now(),
                x=x_value,
                y=y_value,
                points=polyline,
                target_cell_id=target,
                resulting_cell_count=result.output.count + 1,
            )
            labels, affected_area = self._split_labels(
                result.output.labels,
                operation,
                replay=False,
            )
            operation = replace(operation, affected_area_px=affected_area)
            output = rebuild_output_from_labels(result.output, labels)
            events, revision, event_count = self._append_event(
                result,
                action="apply",
                operation=operation,
                discarded_redo_count=len(result.redo_corrections),
            )
            return self._publish_correction_locked(
                result,
                base_output=result.base_output or result.output,
                output=output,
                applied_corrections=(*result.applied_corrections, operation),
                redo_corrections=(),
                correction_events=events,
                correction_revision=revision,
                correction_event_count=event_count,
            )

    def merge_instances(
        self,
        result_id: object,
        *,
        x: object,
        y: object,
        other_x: object,
        other_y: object,
    ) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            result = self._get_locked(result_id)
            if len(result.applied_corrections) >= self._max_correction_operations:
                raise ValueError(
                    f"A result may contain at most {self._max_correction_operations} corrections"
                )
            height, width = result.output.labels.shape
            x_value = self._coordinate(x, name="x", maximum=width)
            y_value = self._coordinate(y, name="y", maximum=height)
            other_x_value = self._coordinate(other_x, name="other_x", maximum=width)
            other_y_value = self._coordinate(other_y, name="other_y", maximum=height)
            target = self._selected_instance(result.output.labels, x=x_value, y=y_value)
            other_target = self._selected_instance(
                result.output.labels,
                x=other_x_value,
                y=other_y_value,
            )
            operation = CorrectionOperation(
                operation_id=secrets.token_urlsafe(12),
                kind="merge_instances",
                created_at=_now(),
                x=x_value,
                y=y_value,
                other_x=other_x_value,
                other_y=other_y_value,
                target_cell_id=target,
                other_target_cell_id=other_target,
                resulting_cell_count=result.output.count - 1,
            )
            labels, affected_area = self._merge_labels(
                result.output.labels,
                operation,
                replay=False,
            )
            operation = replace(operation, affected_area_px=affected_area)
            output = rebuild_output_from_labels(result.output, labels)
            events, revision, event_count = self._append_event(
                result,
                action="apply",
                operation=operation,
                discarded_redo_count=len(result.redo_corrections),
            )
            return self._publish_correction_locked(
                result,
                base_output=result.base_output or result.output,
                output=output,
                applied_corrections=(*result.applied_corrections, operation),
                redo_corrections=(),
                correction_events=events,
                correction_revision=revision,
                correction_event_count=event_count,
            )

    def replace_instance_boundary(
        self,
        result_id: object,
        *,
        x: object,
        y: object,
        points: object,
    ) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            result = self._get_locked(result_id)
            if len(result.applied_corrections) >= self._max_correction_operations:
                raise ValueError(
                    f"A result may contain at most {self._max_correction_operations} corrections"
                )
            height, width = result.output.labels.shape
            x_value = self._coordinate(x, name="x", maximum=width)
            y_value = self._coordinate(y, name="y", maximum=height)
            target = self._selected_instance(result.output.labels, x=x_value, y=y_value)
            polygon = self._polygon(points, width=width, height=height)
            operation = CorrectionOperation(
                operation_id=secrets.token_urlsafe(12),
                kind="replace_instance_boundary",
                created_at=_now(),
                x=x_value,
                y=y_value,
                points=polygon,
                target_cell_id=target,
                resulting_cell_count=result.output.count,
            )
            labels, affected_area = self._replace_boundary_labels(
                result.output.labels,
                operation,
                replay=False,
            )
            operation = replace(operation, affected_area_px=affected_area)
            output = rebuild_output_from_labels(result.output, labels)
            events, revision, event_count = self._append_event(
                result,
                action="apply",
                operation=operation,
                discarded_redo_count=len(result.redo_corrections),
            )
            return self._publish_correction_locked(
                result,
                base_output=result.base_output or result.output,
                output=output,
                applied_corrections=(*result.applied_corrections, operation),
                redo_corrections=(),
                correction_events=events,
                correction_revision=revision,
                correction_event_count=event_count,
            )

    def paint_stroke(
        self,
        result_id: object,
        *,
        points: object,
        radius_px: object,
    ) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            result = self._get_locked(result_id)
            if len(result.applied_corrections) >= self._max_correction_operations:
                raise ValueError(
                    f"A result may contain at most {self._max_correction_operations} corrections"
                )
            height, width = result.output.labels.shape
            stroke = self._stroke(points, width=width, height=height)
            radius = self._brush_radius(radius_px)
            stroke_mask = self._stroke_mask(stroke, result.output.labels.shape, radius)
            overlaps = {
                int(value)
                for value in np.unique(result.output.labels[stroke_mask])
                if int(value) != 0
            }
            if len(overlaps) > 1:
                raise ValueError(
                    "The paint brush touches more than one instance. Use Merge for an "
                    "intentional join."
                )
            target = next(iter(overlaps), int(result.output.labels.max(initial=0)) + 1)
            operation = CorrectionOperation(
                operation_id=secrets.token_urlsafe(12),
                kind="paint_stroke",
                created_at=_now(),
                points=stroke,
                brush_radius_px=radius,
                target_cell_id=target,
                resulting_cell_count=result.output.count + (0 if overlaps else 1),
            )
            labels, affected_area, created_count = self._paint_labels(
                result.output.labels,
                operation,
                replay=False,
            )
            operation = replace(
                operation,
                affected_area_px=affected_area,
                resulting_cell_count=result.output.count + created_count,
            )
            output = rebuild_output_from_labels(result.output, labels)
            events, revision, event_count = self._append_event(
                result,
                action="apply",
                operation=operation,
                discarded_redo_count=len(result.redo_corrections),
            )
            return self._publish_correction_locked(
                result,
                base_output=result.base_output or result.output,
                output=output,
                applied_corrections=(*result.applied_corrections, operation),
                redo_corrections=(),
                correction_events=events,
                correction_revision=revision,
                correction_event_count=event_count,
            )

    def erase_stroke(
        self,
        result_id: object,
        *,
        points: object,
        radius_px: object,
    ) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            result = self._get_locked(result_id)
            if len(result.applied_corrections) >= self._max_correction_operations:
                raise ValueError(
                    f"A result may contain at most {self._max_correction_operations} corrections"
                )
            height, width = result.output.labels.shape
            stroke = self._stroke(points, width=width, height=height)
            radius = self._brush_radius(radius_px)
            operation = CorrectionOperation(
                operation_id=secrets.token_urlsafe(12),
                kind="erase_stroke",
                created_at=_now(),
                points=stroke,
                brush_radius_px=radius,
            )
            labels, affected_area = self._erase_labels(
                result.output.labels,
                operation,
                replay=False,
            )
            output = rebuild_output_from_labels(result.output, labels)
            operation = replace(
                operation,
                affected_area_px=affected_area,
                resulting_cell_count=output.count,
            )
            events, revision, event_count = self._append_event(
                result,
                action="apply",
                operation=operation,
                discarded_redo_count=len(result.redo_corrections),
            )
            return self._publish_correction_locked(
                result,
                base_output=result.base_output or result.output,
                output=output,
                applied_corrections=(*result.applied_corrections, operation),
                redo_corrections=(),
                correction_events=events,
                correction_revision=revision,
                correction_event_count=event_count,
            )

    def move_boundary_vertex(
        self,
        result_id: object,
        *,
        x: object,
        y: object,
        points: object,
    ) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            result = self._get_locked(result_id)
            if len(result.applied_corrections) >= self._max_correction_operations:
                raise ValueError(
                    f"A result may contain at most {self._max_correction_operations} corrections"
                )
            height, width = result.output.labels.shape
            x_value = self._coordinate(x, name="x", maximum=width)
            y_value = self._coordinate(y, name="y", maximum=height)
            target = self._selected_instance(result.output.labels, x=x_value, y=y_value)
            polygon = self._polygon(points, width=width, height=height)
            original_polygon, _simplified = self._editable_boundary_polygon(
                result.output.labels,
                target,
            )
            if len(polygon) != len(original_polygon):
                raise ValueError(
                    "Move exactly one vertex from the editable boundary returned by Loci"
                )
            changed_vertices = sum(
                (round(x_point, 6), round(y_point, 6))
                != (round(original_x, 6), round(original_y, 6))
                for (x_point, y_point), (original_x, original_y) in zip(
                    polygon,
                    original_polygon,
                    strict=True,
                )
            )
            if changed_vertices != 1:
                raise ValueError(
                    "Move exactly one vertex from the editable boundary returned by Loci"
                )
            operation = CorrectionOperation(
                operation_id=secrets.token_urlsafe(12),
                kind="move_boundary_vertex",
                created_at=_now(),
                x=x_value,
                y=y_value,
                points=polygon,
                target_cell_id=target,
                resulting_cell_count=result.output.count,
            )
            labels, affected_area = self._replace_boundary_labels(
                result.output.labels,
                operation,
                replay=False,
            )
            operation = replace(operation, affected_area_px=affected_area)
            if affected_area == 0:
                raise ValueError("Move at least one boundary vertex before committing")
            output = rebuild_output_from_labels(result.output, labels)
            events, revision, event_count = self._append_event(
                result,
                action="apply",
                operation=operation,
                discarded_redo_count=len(result.redo_corrections),
            )
            return self._publish_correction_locked(
                result,
                base_output=result.base_output or result.output,
                output=output,
                applied_corrections=(*result.applied_corrections, operation),
                redo_corrections=(),
                correction_events=events,
                correction_revision=revision,
                correction_event_count=event_count,
            )

    def undo_correction(self, result_id: object) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            result = self._get_locked(result_id)
            if not result.applied_corrections or result.base_output is None:
                raise ValueError("No manual correction is available to undo")
            operation = result.applied_corrections[-1]
            applied = result.applied_corrections[:-1]
            output = self._rebuild(result.base_output, applied) if applied else result.base_output
            events, revision, event_count = self._append_event(
                result,
                action="undo",
                operation=operation,
            )
            return self._publish_correction_locked(
                result,
                output=output,
                applied_corrections=applied,
                redo_corrections=(*result.redo_corrections, operation),
                correction_events=events,
                correction_revision=revision,
                correction_event_count=event_count,
            )

    def redo_correction(self, result_id: object) -> tuple[CachedAnalysis, list[str]]:
        with self._lock:
            result = self._get_locked(result_id)
            if not result.redo_corrections or result.base_output is None:
                raise ValueError("No manual correction is available to redo")
            operation = result.redo_corrections[-1]
            applied = (*result.applied_corrections, operation)
            output = self._rebuild(result.base_output, applied)
            events, revision, event_count = self._append_event(
                result,
                action="redo",
                operation=operation,
            )
            return self._publish_correction_locked(
                result,
                output=output,
                applied_corrections=applied,
                redo_corrections=result.redo_corrections[:-1],
                correction_events=events,
                correction_revision=revision,
                correction_event_count=event_count,
            )

    def clear(self) -> None:
        """Drop all cached arrays, primarily for deterministic tests and shutdown hooks."""

        with self._lock:
            self._items.clear()


RESULT_CACHE = ResultCache()
