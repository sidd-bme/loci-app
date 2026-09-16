"""Validated task semantics for the native research workbench.

This is the common engine boundary consumed by desktop, CLI and bounded agent
clients. Private picker/provisioning operations live outside ``execute``. All
image input is resolved from project-scoped source/result identities.
"""

from __future__ import annotations

import base64
import hashlib
import io
import math
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any

import numpy as np
import scipy
import skimage
from PIL import Image

from .models import ENGINE_VERSION
from .native_image import NativeImageSession, NativeSelection
from .quantitative import (
    DEFAULT_WORKING_BYTES,
    Geometry,
    apply_marker_gates,
    colocalisation,
    exact_keys,
    finite_number,
    integer,
    measure_objects,
    process_scalar,
    segment_scalar,
    validate_array,
)
from .research_operations import OPERATION_CATALOG
from .research_project import ResearchProject, canonical_json, checked_id, checked_text
from .study_analysis import validate_sample_metadata

MAX_VIEW_EDGE = 2048
MAX_VIEW_CHANNELS = 16


def _study_measurement_records(
    project: ResearchProject, result_ids: Any, label: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if (
        not isinstance(result_ids, list)
        or not 1 <= len(result_ids) <= 10_000
        or any(not isinstance(result_id, str) for result_id in result_ids)
        or len(set(result_ids)) != len(result_ids)
    ):
        raise ValueError(f"Choose a unique bounded set of {label} result revisions")
    sample_documents = {item["id"]: item for item in project.documents("sample")}
    records: list[dict[str, Any]] = []
    bindings: list[dict[str, Any]] = []
    for result_id in result_ids:
        result = project.result(checked_id(result_id))
        review = project.review_state(result_id)
        if not review or review["disposition"] == "pending":
            raise ValueError(
                "Study comparisons require reviewed or explicitly excluded result revisions"
            )
        sample = sample_documents.get(result["source_id"])
        if sample is None:
            raise ValueError("Assign study/sample metadata to every selected source")
        metadata = validate_sample_metadata(sample["data"]).to_dict()
        provenance = result["provenance"]
        comparison_scope = {
            "selection": provenance.get("selection"),
            "geometry": provenance["geometry"],
        }
        records.append(
            {
                "source_id": result["source_id"],
                "result_id": result_id,
                "revision_hash": result["revision_hash"],
                "review": review,
                "metadata": metadata,
                "objects": provenance.get("measurements", []),
                "method": provenance.get("recipe_sha256")
                or hashlib.sha256(canonical_json(provenance.get("recipe")).encode()).hexdigest(),
                "run_scope": canonical_json(
                    {
                        "axes": provenance["geometry"]["axes"],
                        "measurement_basis": provenance.get("measurement_basis"),
                    }
                ),
                "excluded": review["disposition"] == "excluded",
            }
        )
        bindings.append(
            {
                "result_id": result_id,
                "revision_hash": result["revision_hash"],
                "source_id": result["source_id"],
                "source_sha256": result["source_sha256"],
                "review": review,
                "sample_document": {
                    "revision": sample["revision"],
                    "data": metadata,
                },
                "scope": comparison_scope,
            }
        )
    return records, bindings


def geometry_from_dict(value: dict[str, Any]) -> Geometry:
    exact_keys(value, {"axes", "affine", "unit", "frame"}, "geometry")
    try:
        return Geometry(
            value["axes"],
            tuple(tuple(row) for row in value["affine"]),
            value["unit"],
            value.get("frame", "image"),
        )
    except (KeyError, TypeError) as exc:
        raise ValueError("A complete explicit geometry is required") from exc


def runtime_record() -> dict[str, Any]:
    return {
        "engine": ENGINE_VERSION,
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "scikit_image": skimage.__version__,
        "requested_device": "auto",
        "resolved_device": "cpu",
        "backend": "numpy-scipy-cpu",
        "fallback_reason": None,
        "scientific_validation": "unvalidated-research-method",
    }


def _png(array: np.ndarray) -> str:
    output = io.BytesIO()
    Image.fromarray(array).save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def display_scalar(
    array: np.ndarray, display: dict[str, Any] | None = None
) -> tuple[np.ndarray, dict[str, Any]]:
    array = validate_array(array)
    if array.ndim != 2:
        raise ValueError("Display requires an explicit plane or projection")
    values = display or {}
    exact_keys(values, {"low", "high", "gamma", "color", "visible", "channel"}, "channel display")
    low = finite_number(values.get("low", float(array.min())), "display low", -1e30, 1e30)
    high = finite_number(values.get("high", float(array.max())), "display high", -1e30, 1e30)
    if high < low or (high == low and "high" in values):
        raise ValueError("Display high must exceed display low")
    gamma = finite_number(values.get("gamma", 1.0), "display gamma", 0.1, 10)
    if "visible" in values and not isinstance(values["visible"], bool):
        raise ValueError("Channel visibility must be boolean")
    color = values.get("color", "#ffffff")
    if not isinstance(color, str) or len(color) != 7 or not color.startswith("#"):
        raise ValueError("Channel display color must be an RGB hex value")
    try:
        rgb = np.array([int(color[n : n + 2], 16) for n in (1, 3, 5)]) / 255
    except ValueError as exc:
        raise ValueError("Invalid channel display color") from exc
    normalized = (
        np.zeros_like(array, dtype=np.float64)
        if high == low
        else np.clip((array.astype(np.float64) - low) / (high - low), 0, 1)
    )
    normalized = normalized ** (1 / gamma)
    if not values.get("visible", True):
        normalized.fill(0)
    return normalized[..., None] * rgb, {
        "low": low,
        "high": high,
        "gamma": gamma,
        "color": color,
        "visible": values.get("visible", True),
        "basis": "display-only; analysis values unchanged",
        "auto_algorithm": "selected-plane-min-max"
        if "low" not in values and "high" not in values
        else None,
    }


def result_summary(result: dict[str, Any], review: dict[str, Any] | None = None) -> dict[str, Any]:
    provenance = result["provenance"]
    return {
        "id": result["id"],
        "source_id": result["source_id"],
        "kind": result["kind"],
        "created_at": result["created_at"],
        "parent_id": result["parent_id"],
        "revision_hash": result["revision_hash"],
        "source_sha256": result["source_sha256"],
        "arrays": result["arrays"],
        "geometry": provenance.get("geometry"),
        "selection": provenance.get("selection"),
        "object_count": len(provenance.get("measurements", [])),
        "review": review,
    }


class Workbench:
    def __init__(self, project: ResearchProject):
        self.project = project
        self.sessions: OrderedDict[str, Any] = OrderedDict()

    def channel_metadata(self, source_id: str) -> dict[str, Any]:
        from .research_channels import channel_metadata

        return channel_metadata(self.project, source_id)

    def close(self) -> None:
        for session in self.sessions.values():
            session.close()
        self.sessions.clear()

    def snapshot(self) -> dict[str, Any]:
        from .research_jobs import public_job
        from .research_workspace_records import ordered_sources, read_visibility

        visibility = read_visibility(self.project)
        hidden_sources = visibility["data"]["sources"]
        hidden_results = visibility["data"]["results"]
        sources = ordered_sources(visibility["data"], self.project.list_sources())
        results = [
            result_summary(result, self.project.review_state(result["id"]))
            for result in self.project.list_results()
        ]
        return {
            "project": self.project.summary(),
            "sources": [source for source in sources if source["id"] not in hidden_sources],
            "results": [
                result
                for result in results
                if result["id"] not in hidden_results and result["source_id"] not in hidden_sources
            ],
            "workspace": {
                "revision": visibility["revision"],
                "closed_sources": [source for source in sources if source["id"] in hidden_sources],
                "hidden_results": [result for result in results if result["id"] in hidden_results],
            },
            "samples": self.project.documents("sample"),
            "recipes": self.project.documents("recipe"),
            "displays": self.project.documents("display"),
            "channels": self.project.documents("channels"),
            "selections": self.project.documents("selection"),
            "comparisons": self.project.documents("comparison"),
            "jobs": [public_job(job) for job in self.project.list_jobs()],
            "operations": OPERATION_CATALOG,
        }

    def import_native(
        self,
        path: str,
        *,
        name: str | None = None,
        series: int = 0,
        relative_path: str | None = None,
    ) -> dict[str, Any]:
        if Path(path).is_dir():
            if series != 0:
                raise ValueError("Use an explicit image group for OME-Zarr selection")
            return self.project.register_zarr_source(path, name=name)
        if Path(path).suffix.lower() in {".svs", ".ndpi"}:
            from .slide_adapter import SlideAdapter

            if series != 0:
                raise ValueError("Whole-slide import requires series zero")
            session = SlideAdapter(path)
            kind = "whole_slide"
            metadata = session.public_metadata()
        else:
            session = NativeImageSession(path, series=series)
            kind = "native"
            metadata = asdict(session.metadata)
        try:
            source = self.project.register_source(
                path,
                session.metadata.sha256,
                metadata,
                name=name,
                source_kind=kind,
                relative_path=relative_path,
            )
            self._remember(source["id"], session)
            return source
        except BaseException:
            session.close()
            raise

    def _remember(self, source_id: str, session: NativeImageSession) -> None:
        old = self.sessions.pop(source_id, None)
        if old and old is not session:
            old.close()
        self.sessions[source_id] = session
        while len(self.sessions) > 4:
            self.sessions.popitem(last=False)[1].close()

    def _session(self, source_id: str) -> NativeImageSession:
        source = self.project.source(source_id)
        if source.get("locator_state") == "relink-required":
            raise ValueError(
                "Source locator is unavailable after interchange; relink an exact local copy"
            )
        if source.get("source_kind") not in {"native", "whole_slide", "ome_zarr", "medical"}:
            raise ValueError("This source has no supported viewer reader")
        session = self.sessions.get(source_id)
        if session is None:
            if source.get("source_kind") == "medical":
                from .viewer_medical import MedicalViewerSession

                session = MedicalViewerSession(
                    source["private_medical_selection"],
                    expected_source_identity="sha256:" + source["sha256"],
                )
            elif source.get("source_kind") == "ome_zarr":
                from .zarr_adapter import ZarrAdapter

                session = ZarrAdapter(
                    **source["private_zarr_selection"], expected_sha256=source["sha256"]
                )
            elif source.get("source_kind") == "whole_slide":
                from .slide_adapter import SlideAdapter

                session = SlideAdapter(source["private_path"], expected_sha256=source["sha256"])
            else:
                session = NativeImageSession(
                    source["private_path"],
                    series=source["metadata"]["selected_series"],
                    expected_sha256=source["sha256"],
                )
        self._remember(source_id, session)
        return session

    def inspect(self, source_id: str) -> dict[str, Any]:
        source = self.project.source(source_id)
        if source.get("locator_state") == "relink-required":
            raise ValueError(
                "Source locator is unavailable after interchange; relink an exact local copy"
            )
        if source.get("source_kind") in {"native", "whole_slide", "ome_zarr"}:
            metadata = asdict(self._session(source_id).metadata)
        else:
            from .medical_image import inspect_medical

            metadata = inspect_medical(source["private_medical_selection"]).to_dict()
            if metadata["source_identity"] != "sha256:" + source["sha256"]:
                raise ValueError("The medical source changed after import")
        return {"source": self.project.public_source(source), "metadata": metadata}

    def selection(self, source_id: str, value: dict[str, Any] | None) -> dict[str, Any]:
        """Resolve every omitted field once, then persist the complete selection."""
        value = value or {}
        exact_keys(
            value, {"x", "y", "width", "height", "t", "c", "z", "z_stop", "level"}, "selection"
        )
        source = self.project.source(source_id)
        if source.get("source_kind") in {"native", "whole_slide", "ome_zarr"}:
            metadata = self._session(source_id).metadata
            level = integer(
                value.get("level", len(metadata.levels) - 1), "level", 0, len(metadata.levels) - 1
            )
            dimensions = asdict(metadata.levels[level].dimensions)
        else:
            shape = source["metadata"]["shape"]
            dimensions = {
                "x": shape[-1],
                "y": shape[-2],
                "z": shape[0] if len(shape) == 3 else 1,
                "t": 1,
                "c": 1,
            }
            level = integer(value.get("level", 0), "level", 0, 0)
        x = integer(value.get("x", 0), "x", 0, dimensions["x"] - 1)
        y = integer(value.get("y", 0), "y", 0, dimensions["y"] - 1)
        z = integer(value.get("z", dimensions["z"] // 2), "z", 0, dimensions["z"] - 1)
        resolved = {
            "x": x,
            "y": y,
            "width": integer(
                value.get("width", min(1024, dimensions["x"] - x)), "width", 1, dimensions["x"] - x
            ),
            "height": integer(
                value.get("height", min(1024, dimensions["y"] - y)),
                "height",
                1,
                dimensions["y"] - y,
            ),
            "z": z,
            "t": integer(value.get("t", 0), "t", 0, dimensions["t"] - 1),
            "c": integer(value.get("c", 0), "c", 0, dimensions["c"] - 1),
            "level": level,
        }
        if "z_stop" in value:
            resolved["z_stop"] = integer(value["z_stop"], "z_stop", z + 1, dimensions["z"])
        return resolved

    def _native_geometry(
        self, session: NativeImageSession, selection: dict[str, Any], volume: bool
    ) -> Geometry:
        from .slide_adapter import SlideAdapter
        from .zarr_adapter import ZarrAdapter

        if isinstance(session, ZarrAdapter):
            return session.geometry(selection, volume)
        if isinstance(session, SlideAdapter):
            if volume:
                raise ValueError("A whole slide cannot be treated as a Z volume")
            return session.geometry(selection)
        return session.geometry(selection, volume)

    def load_scalar(
        self,
        source_id: str,
        selection: dict[str, Any],
        *,
        strict: bool = True,
        working_bytes: int = DEFAULT_WORKING_BYTES,
        allow_rgb: bool = False,
    ) -> tuple[np.ndarray, Geometry, dict[str, Any]]:
        selection = self.selection(source_id, selection)
        source = self.project.source(source_id)
        volume = "z_stop" in selection
        depth = selection.get("z_stop", selection["z"] + 1) - selection["z"]
        voxels = depth * selection["height"] * selection["width"]
        integer(working_bytes, "working_bytes", 1024, DEFAULT_WORKING_BYTES)
        if voxels * 96 > working_bytes:
            raise ValueError(
                "Selected analysis region exceeds its working-memory budget; reduce the crop"
            )
        if source.get("source_kind") == "medical":
            from .medical_image import read_medical

            metadata = source["metadata"]
            region = [
                slice(selection["y"], selection["y"] + selection["height"]),
                slice(selection["x"], selection["x"] + selection["width"]),
            ]
            if len(metadata["shape"]) == 3:
                region.insert(0, slice(selection["z"], selection["z"] + depth))
            result = read_medical(
                source["private_medical_selection"],
                region=tuple(region),
                expected_identity="sha256:" + source["sha256"],
                max_decoded_bytes=working_bytes,
            )
            array, geometry = result.array, result.geometry
            if not volume and array.ndim == 3:
                array = array[0]
                geometry = Geometry("YX", geometry.affine, geometry.unit, geometry.frame)
        else:
            session = self._session(source_id)
            if session.metadata.dimensions.s > 1 and not allow_rgb:
                raise ValueError(
                    "RGB samples are not biological channels; choose declared stain analysis"
                )
            if strict:
                session.verify_strict()
            planes = []
            for z in range(selection["z"], selection["z"] + depth):
                region = session.read_region(
                    NativeSelection(
                        x=selection["x"],
                        y=selection["y"],
                        width=selection["width"],
                        height=selection["height"],
                        z=z,
                        t=selection["t"],
                        c=selection["c"],
                        level=selection["level"],
                        series=session.metadata.selected_series,
                        budget_bytes=min(64 * 1024**2, working_bytes),
                    )
                )
                planes.append(region.pixels)
            array = np.stack(planes) if volume else np.array(planes[0])
            geometry = self._native_geometry(session, selection, volume)
            if strict:
                session.verify_strict()
        return array, geometry, selection

    def view(self, request: dict[str, Any]) -> dict[str, Any]:
        exact_keys(request, {"source_id", "selection", "channels", "projection"}, "view")
        source_id = checked_id(request.get("source_id"))
        selection = self.selection(source_id, request.get("selection"))
        if selection["width"] > MAX_VIEW_EDGE or selection["height"] > MAX_VIEW_EDGE:
            raise ValueError(
                "A view is limited to 2048 pixels per edge; select a pyramid level or region"
            )
        source = self.project.source(source_id)
        rgb = (
            source.get("source_kind") in {"native", "whole_slide"}
            and self._session(source_id).metadata.dimensions.s > 1
        )
        channels = request.get("channels", [{"channel": selection["c"]}])
        if not isinstance(channels, list) or not 1 <= len(channels) <= MAX_VIEW_CHANNELS:
            raise ValueError("A view requires 1-16 explicit channel mappings")
        projection = request.get("projection")
        if projection is not None and (
            projection not in {"max", "mean"} or "z_stop" not in selection
        ):
            raise ValueError("Projection requires an explicit Z range and max or mean method")
        if "z_stop" in selection and projection is None:
            raise ValueError(
                "Choose an explicit projection or use linked orthogonal views for volumes"
            )
        if rgb and (len(channels) != 1 or projection is not None):
            raise ValueError(
                "RGB samples use one declared RGB display, not biological-channel compositing"
            )
        composite = np.zeros((selection["height"], selection["width"], 3), dtype=np.float64)
        display_records = []
        statistics = []
        for display in channels:
            exact_keys(display, {"channel", "low", "high", "gamma", "visible", "color"}, "display")
            selected = {**selection, "c": display.get("channel", selection["c"])}
            array, geometry, _ = self.load_scalar(source_id, selected, strict=False, allow_rgb=rgb)
            if projection is not None:
                array = (
                    np.max(array, axis=0)
                    if projection == "max"
                    else np.mean(array, axis=0, dtype=np.float64)
                )
            if rgb:
                if array.dtype != np.uint8:
                    raise ValueError("Native RGB display currently requires 8-bit samples")
                composite = array[..., :3].astype(np.float64) / 255
                if array.shape[-1] == 4:
                    composite *= array[..., 3:4] / 255
                record = {
                    "basis": "RGB samples; no biological-channel inference",
                    "icc": "unmanaged",
                }
                if source.get("source_kind") == "whole_slide":
                    region = self._session(source_id).raw_region(NativeSelection(**selected))
                    composite = region.display_rgb.astype(np.float64) / 255
                    record["icc"] = asdict(region.display_color)
                    record["level0_extent_xyxy"] = region.level0_extent_xyxy
            else:
                colored, record = display_scalar(array, display)
                composite += colored
            display_records.append({"channel": selected["c"], **record})
            statistics.append(
                {
                    "channel": selected["c"],
                    "min": float(array.min()),
                    "max": float(array.max()),
                    "mean": float(array.mean()),
                    "dtype": str(array.dtype),
                }
            )
        pixels = np.round(np.clip(composite, 0, 1) * 255).astype(np.uint8)
        return {
            "image": _png(pixels),
            # The viewport scope belongs to the request. Display mappings may
            # composite other channels; each is recorded below and must not
            # replace the active analysis channel with the last display channel.
            "selection": selection,
            "geometry": geometry.to_dict(),
            "display": display_records,
            "statistics": statistics,
            "projection": projection,
            "source_sha256": source["sha256"],
            "integrity": "stat-verified-session"
            if source.get("source_kind") == "native"
            else "full-source-manifest-sha256",
        }

    def volume_view(self, request: dict[str, Any]) -> dict[str, Any]:
        exact_keys(
            request,
            {"source_id", "selection", "crosshair", "display", "include_volume"},
            "volume view",
        )
        array, geometry, selection = self.load_scalar(
            request["source_id"], request.get("selection", {}), strict=False
        )
        if array.ndim != 3:
            raise ValueError("Linked volume view requires an explicit Z range")
        crosshair = request.get("crosshair", [n // 2 for n in array.shape])
        if not isinstance(crosshair, list) or len(crosshair) != 3:
            raise ValueError("Crosshair must be local crop Z,Y,X indices")
        z, y, x = [
            integer(v, "crosshair", 0, n - 1) for v, n in zip(crosshair, array.shape, strict=True)
        ]
        display = request.get(
            "display", {"low": float(array.min()), "high": float(array.max()) or 1}
        )
        planes = {"xy": array[z], "xz": array[:, y, :], "yz": array[:, :, x]}
        rendered = {}
        for name, plane in planes.items():
            rgb, _ = display_scalar(plane, display)
            rendered[name] = _png(np.round(rgb * 255).astype(np.uint8))
        response = {
            "planes": rendered,
            "crosshair": [z, y, x],
            "shape": list(array.shape),
            "world_xyz": geometry.world(np.array([[z, y, x]]))[0].tolist(),
            "value": float(array[z, y, x]),
            "geometry": geometry.to_dict(),
            "selection": selection,
        }
        if request.get("include_volume", False):
            strides = tuple(max(1, math.ceil(n / 96)) for n in array.shape)
            small = np.ascontiguousarray(
                array[tuple(slice(None, None, s) for s in strides)], dtype="<f4"
            )
            response["volume"] = {
                "data": base64.b64encode(small.tobytes()).decode(),
                "dtype": "float32-le",
                "shape": list(small.shape),
                "strides": list(strides),
                "purpose": "display-only-nearest-subsample",
            }
        return response

    def histology(
        self,
        request: dict[str, Any],
        *,
        preview: bool,
        job_id: str | None = None,
        publication_guard: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        from skimage.color import hdx_from_rgb, hed_from_rgb, separate_stains

        exact_keys(
            request,
            {
                "source_id",
                "selection",
                "basis",
                "component",
                "steps",
                "segmentation",
                "gates",
                "working_bytes",
            },
            "declared histology",
        )
        source_id = checked_id(request.get("source_id"))
        selection = self.selection(source_id, request.get("selection"))
        source = self.project.source(source_id)
        if (
            source.get("source_kind") not in {"native", "whole_slide"}
            or self._session(source_id).metadata.dimensions.s < 3
        ):
            raise ValueError("Declared stain analysis requires an RGB brightfield source")
        if "z_stop" in selection:
            raise ValueError("Stain analysis requires one explicitly selected RGB plane")
        basis = request.get("basis")
        if basis not in {"H&E", "H-DAB"}:
            raise ValueError("Declare H&E or H-DAB; Loci does not infer stains")
        component = integer(request.get("component", 0), "stain component", 0, 1)
        working_bytes = integer(
            request.get("working_bytes", DEFAULT_WORKING_BYTES),
            "stain working bytes",
            1024**2,
            DEFAULT_WORKING_BYTES,
        )
        peak_bytes = selection["width"] * selection["height"] * 192
        if peak_bytes > working_bytes:
            raise ValueError("Stain analysis exceeds the working-memory budget before decode")
        names = [
            "hematoxylin-basis",
            "eosin-basis" if basis == "H&E" else "DAB-basis",
            "complementary-basis",
        ]
        gates = request.get("gates", [])
        apply_marker_gates([], gates)
        if any(gate["channel"] not in names[:2] for gate in gates):
            raise ValueError("Stain rules must reference a coordinate in the declared stain basis")
        rgb, geometry, selection = self.load_scalar(
            source_id,
            selection,
            allow_rgb=True,
            working_bytes=working_bytes,
        )
        if rgb.ndim != 3 or rgb.shape[-1] != 3 or rgb.dtype != np.uint8:
            raise ValueError(
                "Declared stain separation requires 8-bit RGB without an alpha channel"
            )
        matrix = hed_from_rgb if basis == "H&E" else hdx_from_rgb
        stains = separate_stains(rgb, matrix)
        steps = request.get("steps", [])
        processed, process_record = process_scalar(
            stains[..., component], geometry, steps, working_bytes=working_bytes
        )
        segmentation = request.get("segmentation")
        arrays = {"image": processed}
        rows = []
        segment_record = None
        if segmentation is not None:
            labels, segment_record = segment_scalar(
                processed, geometry, segmentation, working_bytes=working_bytes
            )
            arrays["labels"] = labels
            rows = apply_marker_gates(
                measure_objects(
                    labels,
                    geometry,
                    {name: stains[..., index] for index, name in enumerate(names[:2])},
                    working_bytes=working_bytes,
                ),
                request.get("gates", []),
            )
        elif request.get("gates"):
            raise ValueError("Histology gates require segmented object measurements")
        provenance = {
            "resource_estimate": {"peak_bytes": peak_bytes, "working_bytes": working_bytes},
            "geometry": geometry.to_dict(),
            "selection": selection,
            "processing": process_record,
            "segmentation": segment_record,
            "recipe": {
                key: value
                for key, value in request.items()
                if key not in {"source_id", "selection"}
            },
            "stain_separation": {
                "declared_basis": basis,
                "component": names[component],
                "matrix": matrix.tolist(),
                "method": "skimage.color.separate_stains",
                "input": "source-device-RGB; display ICC transform excluded",
            },
            "measurements": rows,
            "measurement_basis": "declared-derived-stain-coordinates-on-source-grid",
            "runtime": runtime_record(),
        }
        if preview:
            display, _ = display_scalar(processed)
            return {
                "preview": True,
                "adopted": False,
                "image": _png(np.round(display * 255).astype(np.uint8)),
                "object_count": len(rows),
                "measurements": rows[:1000],
                "provenance": {k: v for k, v in provenance.items() if k != "measurements"},
            }
        result = self.project.save_result(
            source_id=source_id,
            kind="declared-stain-analysis",
            arrays=arrays,
            provenance=provenance,
            job_id=job_id,
            publication_guard=publication_guard,
        )
        return {"result": result_summary(result), "measurements": rows[:1000]}

    def validate_recipe(self, request: dict[str, Any]) -> dict[str, Any]:
        exact_keys(request, {"source_id", "selection", "recipe"}, "recipe request")
        source_id = checked_id(request.get("source_id"))
        selected = self.selection(source_id, request.get("selection"))
        recipe = request.get("recipe", {})
        exact_keys(
            recipe,
            {
                "steps",
                "segmentation",
                "measurement_channels",
                "gates",
                "working_bytes",
                "references",
                "input_transform",
            },
            "recipe",
        )
        input_transform = recipe.get("input_transform")
        if input_transform is not None and input_transform != "rgb_intensity":
            raise ValueError("Choose a supported explicit input transform")
        rgb_intensity = input_transform == "rgb_intensity"
        if rgb_intensity:
            source = self.project.source(source_id)
            if source.get("source_kind") not in {"native", "whole_slide"} or self._session(
                source_id
            ).metadata.dimensions.s not in {3, 4}:
                raise ValueError(
                    "RGB intensity conversion requires verified interleaved RGB samples"
                )
            if "z_stop" in selected:
                raise ValueError("RGB intensity conversion currently requires one plane")
        steps = recipe.get("steps", [])
        segmentation = recipe.get("segmentation")
        dimensions = 3 if "z_stop" in selected else 2
        probe = np.ones((3,) * dimensions, dtype=np.float64)
        probe_geometry = Geometry.diagonal((1.0,) * dimensions)
        # Validate operation fields with a tiny reference array. Reference-image
        # operations require source binding and are handled separately below.
        references = recipe.get("references", {})
        exact_keys(references, {"flatfield", "darkfield"}, "reference images")
        if rgb_intensity and references:
            raise ValueError("RGB intensity conversion does not accept scalar reference images")
        has_flatfield = isinstance(steps, list) and any(
            isinstance(step, dict) and step.get("op") == "flatfield" for step in steps
        )
        if has_flatfield != ("flatfield" in references) or (
            "darkfield" in references and not has_flatfield
        ):
            raise ValueError(
                "Flat-field processing requires an explicit flat reference; "
                "unused references are invalid"
            )
        normalized_references = {}
        for name, reference in references.items():
            exact_keys(reference, {"source_id", "selection"}, "reference binding")
            ref_id = checked_id(reference.get("source_id"))
            normalized_references[name] = {
                "source_id": ref_id,
                "selection": self.selection(ref_id, reference.get("selection")),
            }
        process_scalar(
            probe,
            probe_geometry,
            steps,
            flatfield=probe if has_flatfield else None,
            darkfield=np.zeros_like(probe) if "darkfield" in references else None,
        )
        if segmentation is not None:
            segment_scalar(probe, probe_geometry, segmentation)
        channel_list = recipe.get("measurement_channels", [] if rgb_intensity else [selected["c"]])
        if (
            not isinstance(channel_list, list)
            or not (0 if rgb_intensity else 1) <= len(channel_list) <= 32
            or len(set(channel_list)) != len(channel_list)
        ):
            raise ValueError("Measurement channels must be a unique list of 1-32 channel indices")
        if rgb_intensity and channel_list:
            raise ValueError("RGB intensity measurements are derived, not biological channels")
        for channel in channel_list:
            self.selection(source_id, {**selected, "c": channel})
        gates = recipe.get("gates", [])
        apply_marker_gates([], gates)
        if rgb_intensity and gates:
            raise ValueError("RGB intensity conversion does not accept biological marker gates")
        if gates and segmentation is None:
            raise ValueError("Marker gates require object segmentation")
        working_bytes = integer(
            recipe.get("working_bytes", DEFAULT_WORKING_BYTES),
            "working_bytes",
            1024,
            DEFAULT_WORKING_BYTES,
        )
        voxels = (
            selected["width"]
            * selected["height"]
            * (selected.get("z_stop", selected["z"] + 1) - selected["z"])
        )
        estimated = voxels * (
            96 + 8 * len(channel_list) + 16 * len(references) + (32 if rgb_intensity else 0)
        )
        if estimated > working_bytes:
            raise ValueError(
                "Recipe working-memory estimate exceeds its budget; reduce the selected crop"
            )
        normalized = {
            "steps": steps,
            "segmentation": segmentation,
            "measurement_channels": channel_list,
            "gates": gates,
            "working_bytes": working_bytes,
        }
        if rgb_intensity:
            normalized["input_transform"] = "rgb_intensity"
        if normalized_references:
            normalized["references"] = normalized_references
        return {
            "source_id": source_id,
            "selection": selected,
            "recipe": normalized,
            "estimated_working_bytes": estimated,
            "recipe_sha256": hashlib.sha256(canonical_json(normalized).encode()).hexdigest(),
            "resolved_device": "cpu",
            "scientific_validation": "unvalidated-research-method",
        }

    def run_recipe(
        self,
        request: dict[str, Any],
        *,
        preview: bool = False,
        job_id: str | None = None,
        publication_guard: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        validated = self.validate_recipe(request)
        source_id, recipe, selection = (
            validated["source_id"],
            validated["recipe"],
            validated["selection"],
        )
        rgb_intensity = recipe.get("input_transform") == "rgb_intensity"
        array, geometry, selection = self.load_scalar(
            source_id, selection, working_bytes=recipe["working_bytes"], allow_rgb=rgb_intensity
        )
        input_record = None
        if rgb_intensity:
            from skimage.color import rgb2gray

            if array.dtype not in (np.dtype("uint8"), np.dtype("uint16")):
                raise ValueError("RGB intensity conversion requires unsigned 8- or 16-bit samples")
            if array.shape[-1] == 4 and np.any(array[..., 3] != np.iinfo(array.dtype).max):
                raise ValueError(
                    "RGB intensity conversion requires opaque samples; "
                    "alpha compositing is display-only"
                )
            input_record = {
                "method": "skimage.color.rgb2gray",
                "version": skimage.__version__,
                "input": "source-device RGB samples; display ICC excluded",
                "coefficients_rgb": [0.2125, 0.7154, 0.0721],
                "integer_scale": int(np.iinfo(array.dtype).max),
                "gamma_linearization": False,
                "alpha": "opaque only",
                "meaning": (
                    "derived weighted encoded RGB intensity; not biological channel intensity"
                ),
            }
            array = rgb2gray(array[..., :3])
        declarations = self.channel_metadata(source_id)
        reference_arrays, reference_records = {}, {}
        for name, reference in recipe.get("references", {}).items():
            values, ref_geometry, ref_selection = self.load_scalar(
                reference["source_id"],
                reference["selection"],
                working_bytes=recipe["working_bytes"],
            )
            if values.shape != array.shape or geometry != ref_geometry:
                raise ValueError(
                    "Reference image shape and physical grid must exactly match the selected image"
                )
            reference_arrays[name] = values
            reference_records[name] = {
                "source_id": reference["source_id"],
                "source_sha256": self.project.source(reference["source_id"])["sha256"],
                "selection": ref_selection,
            }
        processed, steps = process_scalar(
            array,
            geometry,
            recipe["steps"],
            working_bytes=recipe["working_bytes"],
            **reference_arrays,
        )
        arrays = {"image": processed}
        if rgb_intensity:
            arrays["rgb_intensity"] = array
        segment_record = None
        rows: list[dict[str, Any]] = []
        if recipe["segmentation"] is not None:
            labels, segment_record = segment_scalar(
                processed, geometry, recipe["segmentation"], working_bytes=recipe["working_bytes"]
            )
            arrays["labels"] = labels
            names = [item["name"] for item in declarations["channels"]]
            channels = {"RGB-DERIVED:rgb_intensity": array} if rgb_intensity else {}
            for channel in recipe["measurement_channels"]:
                raw_channel, _, _ = self.load_scalar(
                    source_id,
                    {**selection, "c": channel},
                    strict=False,
                    working_bytes=recipe["working_bytes"],
                )
                # Channel index makes duplicate biological names unambiguous.
                name = f"{channel + 1}: {names[channel]}"
                channels[name] = raw_channel
            rows = apply_marker_gates(
                measure_objects(labels, geometry, channels, working_bytes=recipe["working_bytes"]),
                recipe["gates"],
            )
        provenance = {
            "geometry": geometry.to_dict(),
            "selection": selection,
            "recipe": recipe,
            "recipe_sha256": validated["recipe_sha256"],
            "channel_metadata": declarations,
            "processing": steps,
            "segmentation": segment_record,
            "measurements": rows,
            "measurement_basis": "raw-selected-channel-values-on-result-grid",
            "runtime": runtime_record(),
            "estimated_working_bytes": validated["estimated_working_bytes"],
        }
        if input_record is not None:
            provenance.update(
                {
                    "input_transform": input_record,
                    "derived_measurement_arrays": ["rgb_intensity"],
                    "derived_measurement_prefix": "RGB-DERIVED",
                    "measurement_basis": "derived weighted encoded RGB intensity on source grid",
                }
            )
        if reference_records:
            provenance["references"] = reference_records
        if job_id is not None:
            provenance["job_id"] = job_id
        if preview:
            plane = processed[processed.shape[0] // 2] if processed.ndim == 3 else processed
            rgb, display = display_scalar(plane)
            return {
                "preview": True,
                "image": _png(np.round(rgb * 255).astype(np.uint8)),
                "display": display,
                "object_count": len(rows),
                "measurements": rows[:1000],
                "provenance": {k: v for k, v in provenance.items() if k != "measurements"},
                "adopted": False,
            }
        result = self.project.save_result(
            source_id=source_id,
            kind="segmentation" if segment_record else "processed",
            arrays=arrays,
            provenance=provenance,
            job_id=job_id,
            publication_guard=publication_guard,
        )
        return {"result": result_summary(result), "measurements": rows[:1000]}

    def result_view(self, request: dict[str, Any]) -> dict[str, Any]:
        exact_keys(request, {"result_id", "axis", "index", "display", "labels"}, "result view")
        result = self.project.result(request["result_id"])
        array = self.project.load_array(result["arrays"]["image"])
        geometry = geometry_from_dict(result["provenance"]["geometry"])
        axis = request.get("axis", "z")
        if axis not in {"z", "y", "x"}:
            raise ValueError("Plane axis must be z, y or x")
        axis_number = {"z": 0, "y": 1, "x": 2}[axis]
        if array.ndim == 2:
            if axis != "z":
                raise ValueError("A 2D result has only the XY plane")
            plane, index = array, 0
        else:
            index = integer(
                request.get("index", array.shape[axis_number] // 2),
                "plane index",
                0,
                array.shape[axis_number] - 1,
            )
            plane = np.take(array, index, axis=axis_number)
        rgb, display = display_scalar(plane, request.get("display"))
        if request.get("labels", True) and "labels" in result["arrays"]:
            labels = self.project.load_array(result["arrays"]["labels"])
            label_plane = labels if labels.ndim == 2 else np.take(labels, index, axis=axis_number)
            tint = np.stack(
                [(label_plane * multiplier % 223 + 32) / 255 for multiplier in (67, 97, 137)],
                axis=-1,
            )
            rgb = np.where((label_plane > 0)[..., None], 0.6 * rgb + 0.4 * tint, rgb)
        return {
            "image": _png(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8)),
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "axis": axis,
            "index": index,
            "shape": list(array.shape),
            "display": display,
            "geometry": geometry.to_dict(),
        }

    def result_label_at(self, request: dict[str, Any]) -> dict[str, Any]:
        exact_keys(
            request,
            {"result_id", "revision_hash", "axis", "index", "u", "v"},
            "result label lookup",
        )
        if "result_id" not in request:
            raise ValueError("result_id is required")
        result = self.project.result(request["result_id"])
        if "revision_hash" in request and result["revision_hash"] != request["revision_hash"]:
            raise ValueError("Result revision mismatch")
        if "labels" not in result.get("arrays", {}):
            raise ValueError("Result does not contain a label array")

        file, digest, size, labels = self.project._open_array_artifact(result["arrays"]["labels"])
        axis = request.get("axis", "z")
        if axis not in {"z", "y", "x"}:
            raise ValueError("Plane axis must be z, y or x")
        axis_number = {"z": 0, "y": 1, "x": 2}[axis]

        if "u" not in request or "v" not in request:
            raise ValueError("u and v coordinates are required")
        try:
            u = int(round(float(request["u"])))
            v = int(round(float(request["v"])))
        except (ValueError, TypeError, OverflowError):
            raise ValueError("u and v must be numeric coordinates") from None

        if labels.ndim == 2:
            if axis != "z":
                raise ValueError("A 2D result has only the XY plane")
            index = 0
            if 0 <= v < labels.shape[0] and 0 <= u < labels.shape[1]:
                label_val = int(labels[v, u])
            else:
                label_val = 0
        elif labels.ndim == 3:
            index = integer(
                request.get("index", labels.shape[axis_number] // 2),
                "plane index",
                0,
                labels.shape[axis_number] - 1,
            )
            if axis_number == 0:
                in_bounds = (0 <= v < labels.shape[1]) and (0 <= u < labels.shape[2])
                label_val = int(labels[index, v, u]) if in_bounds else 0
            elif axis_number == 1:
                in_bounds = (0 <= v < labels.shape[0]) and (0 <= u < labels.shape[2])
                label_val = int(labels[v, index, u]) if in_bounds else 0
            else:
                in_bounds = (0 <= v < labels.shape[0]) and (0 <= u < labels.shape[1])
                label_val = int(labels[v, u, index]) if in_bounds else 0
        else:
            raise ValueError(f"Unsupported label array dimensions: {labels.ndim}")

        return {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "label": label_val,
            "axis": axis,
            "index": index,
            "u": u,
            "v": v,
        }

    def execute(
        self,
        operation: str,
        request: dict[str, Any],
        *,
        job_id: str | None = None,
        publication_guard: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        # Desktop-only display services are deliberately outside the public
        # agent operation catalog and its separately granted disclosure surface.
        if operation == "verify_source":
            exact_keys(request, {"source_id"}, operation)
            source = self.project.source(checked_id(request.get("source_id")), verify=True)
            return {"source_id": source["id"], "source_sha256": source["sha256"]}
        if operation in {"viewer_defaults", "viewer_tile", "viewer_volume", "viewer_histogram"}:
            source_id = checked_id(request.get("source_id"))
            if operation == "viewer_volume":
                from .viewer_volume import build_medical_volume_payload, build_volume_payload

                exact_keys(
                    request,
                    {
                        "source_id",
                        "t",
                        "channel_indices",
                        "target_long_axis",
                        "focus_region_xyzxyz",
                    },
                    operation,
                )
                source = self.project.source(source_id)
                shared = {
                    "source_id": source_id,
                    "target_long_axis": request.get("target_long_axis", 128),
                    "max_decoded_bytes": 128 * 1024**2,
                    "focus_region_xyzxyz": request.get("focus_region_xyzxyz"),
                }
                if source.get("source_kind") == "medical":
                    if request.get("t", 0) != 0 or request.get("channel_indices", [0]) != [0]:
                        raise ValueError(
                            "This medical source contains one scalar channel and time point"
                        )
                    return build_medical_volume_payload(
                        source["private_medical_selection"],
                        expected_source_identity="sha256:" + source["sha256"],
                        **shared,
                    )
                return build_volume_payload(
                    self._session(source_id),
                    t=request.get("t", 0),
                    channel_indices=request.get("channel_indices"),
                    **shared,
                )
            from .viewer_image import viewer_defaults, viewer_histogram, viewer_tile

            session = self._session(source_id)
            if operation == "viewer_defaults":
                return viewer_defaults(session, request)
            if operation == "viewer_histogram":
                return viewer_histogram(session, request)
            self.project._check_layout()
            return viewer_tile(
                session,
                request,
                cache_root=self.project.root,
                embedded_icc=session.display_icc() if hasattr(session, "display_icc") else None,
            )
        if operation in {"source_view", "save_source_view"}:
            from .source_view_state import execute_view_state

            return execute_view_state(self, operation, request)
        if operation in {"source_annotations", "annotate_source"}:
            from .source_annotations import execute_annotations

            return execute_annotations(self, operation, request)
        if operation not in OPERATION_CATALOG or not isinstance(request, dict):
            raise ValueError("Unknown or invalid workbench operation")
        if operation == "roi_import":
            from .research_annotation_import import import_annotations

            return import_annotations(
                self, request, job_id=job_id, publication_guard=publication_guard
            )
        if operation in {"puncta_preview", "puncta_run", "associate_results", "colocalisation_run"}:
            from .research_quantification import execute_quantification

            return execute_quantification(
                self, operation, request, job_id=job_id, publication_guard=publication_guard
            )
        if operation in {"field_assay_preview", "field_assay_run"}:
            from .research_field_assay import execute_field_assay

            return execute_field_assay(
                self, operation, request, job_id=job_id, publication_guard=publication_guard
            )
        if operation == "batch_channel_colors":
            from .source_view_state import execute_batch_channel_colors

            return execute_batch_channel_colors(self, request)
        if operation == "surface_view":
            from .research_surface import execute_surface

            return execute_surface(self, request)
        if operation.startswith("remote_"):
            from .research_remote import execute_remote

            return execute_remote(self, operation.removeprefix("remote_"), request)
        if operation == "channel_metadata":
            exact_keys(request, {"source_id"}, operation)
            return self.channel_metadata(request["source_id"])
        if operation == "channels":
            from .research_channels import save_channels

            return save_channels(self.project, request)
        if operation == "inspect":
            exact_keys(request, {"source_id"}, "inspect")
            return self.inspect(request["source_id"])
        if operation in {"registration_preview", "registration_run", "resample_grid"}:
            from .research_registration import execute_registration

            return execute_registration(
                self, operation, request, job_id=job_id, publication_guard=publication_guard
            )
        if operation in {"track_results", "tracking_result", "correct_tracks"}:
            from .research_temporal import execute_temporal

            return execute_temporal(
                self, operation, request, job_id=job_id, publication_guard=publication_guard
            )
        if operation in {"correction_info", "correct_result", "roi_add", "select_result"}:
            from .research_editing import execute_edit

            return execute_edit(
                self, operation, request, job_id=job_id, publication_guard=publication_guard
            )
        if operation in {"model_list", "model_preview", "model_run"}:
            from .research_models import execute_model

            return execute_model(
                self, operation, request, job_id=job_id, publication_guard=publication_guard
            )
        if operation == "classical_run":
            from .research_adaptive import execute_adaptive

            return execute_adaptive(
                self, request, job_id=job_id, publication_guard=publication_guard
            )
        if operation == "cellpose_run":
            from .research_cellpose import execute_cellpose

            return execute_cellpose(
                self, request, job_id=job_id, publication_guard=publication_guard
            )
        if operation in {"tissue_preview", "tissue_run"}:
            from .research_histology import execute_tissue

            return execute_tissue(
                self,
                request,
                preview=operation == "tissue_preview",
                job_id=job_id,
                publication_guard=publication_guard,
            )
        if operation in {"histology_preview", "histology_run"}:
            return self.histology(
                request,
                preview=operation == "histology_preview",
                job_id=job_id,
                publication_guard=publication_guard,
            )
        if operation == "view":
            return self.view(request)
        if operation == "volume_view":
            return self.volume_view(request)
        if operation == "validate_recipe":
            return self.validate_recipe(request)
        if operation in {"preview_recipe", "run_recipe"}:
            return self.run_recipe(
                request,
                preview=operation == "preview_recipe",
                job_id=job_id,
                publication_guard=publication_guard,
            )
        if operation == "result_view":
            return self.result_view(request)
        if operation == "result_label_at":
            return self.result_label_at(request)
        if operation == "study_summary":
            from .study_analysis import summarize_measurements

            exact_keys(request, {"result_ids", "value"}, "study summary")
            value = request.get("value", "measure")
            if value != "measure":
                raise ValueError("Study summary supports only the calibrated measure metric")
            records, _ = _study_measurement_records(
                self.project, request.get("result_ids"), "study summary"
            )
            return summarize_measurements(records, value=value)
        if operation == "study_compare":
            from .study_analysis import compare_runs, summarize_measurements

            exact_keys(
                request,
                {"left_result_ids", "right_result_ids", "value"},
                "study run comparison",
            )
            value = request.get("value", "measure")
            if value != "measure":
                raise ValueError("Study run comparison supports only the calibrated measure metric")
            left_records, left_bindings = _study_measurement_records(
                self.project, request.get("left_result_ids"), "left-run"
            )
            right_records, right_bindings = _study_measurement_records(
                self.project, request.get("right_result_ids"), "right-run"
            )
            left_ids = {record["result_id"] for record in left_records}
            right_ids = {record["result_id"] for record in right_records}
            if left_ids & right_ids:
                raise ValueError("Run comparison groups must use distinct result revisions")
            if {record["source_id"] for record in left_records} != {
                record["source_id"] for record in right_records
            }:
                raise ValueError("Run comparison requires the same exact source set")
            left_scopes = {binding["source_id"]: binding["scope"] for binding in left_bindings}
            right_scopes = {binding["source_id"]: binding["scope"] for binding in right_bindings}
            if left_scopes != right_scopes:
                raise ValueError(
                    "Run comparison requires the same exact per-source selection and geometry"
                )
            comparison = compare_runs(left_records, right_records, value=value)
            left_summary = summarize_measurements(left_records, value=value)
            right_summary = summarize_measurements(right_records, value=value)
            receipt = {
                "schema": "loci.study-run-comparison/v1",
                "value": comparison["value"],
                "unit": comparison["unit"],
                "method": left_summary["method"],
                "run_scope": left_summary["run_scope"],
                "independent_n_basis": left_summary["independent_n_basis"],
                "left": {
                    "bindings": left_bindings,
                    "summaries": left_summary["summaries"],
                    "replicates": left_summary["replicates"],
                    "record_audit": left_summary["record_audit"],
                },
                "right": {
                    "bindings": right_bindings,
                    "summaries": right_summary["summaries"],
                    "replicates": right_summary["replicates"],
                    "record_audit": right_summary["record_audit"],
                },
                "comparisons": comparison["comparisons"],
                "p_values": comparison["p_values"],
                "interpretation": comparison["interpretation"],
            }
            receipt["receipt_sha256"] = hashlib.sha256(canonical_json(receipt).encode()).hexdigest()
            stored_request = {
                "left_result_ids": request["left_result_ids"],
                "right_result_ids": request["right_result_ids"],
                "value": value,
            }
            comparison_id = receipt["receipt_sha256"][:32]
            stored_data = {
                "request": stored_request,
                "receipt": receipt,
            }
            existing = next(
                (
                    document
                    for document in self.project.documents("comparison")
                    if document["id"] == comparison_id
                ),
                None,
            )
            if existing is None:
                document = self.project.put_document(
                    "comparison", comparison_id, stored_data, expected_revision=0
                )
            else:
                if existing["data"] != stored_data:
                    raise ValueError("Stored study comparison identity is inconsistent")
                document = existing
            return {
                **receipt,
                "comparison_document": {
                    "id": document["id"],
                    "revision": document["revision"],
                },
            }
        if operation == "result":
            exact_keys(request, {"result_id", "offset", "limit"}, "result")
            result = self.project.result(request["result_id"])
            offset = integer(request.get("offset", 0), "table offset", 0, 1_000_000)
            limit = integer(request.get("limit", 200), "table limit", 1, 1000)
            rows = result["provenance"].get("measurements", [])
            return {
                "result": result_summary(result, self.project.review_state(result["id"])),
                "measurements": rows[offset : offset + limit],
                "total_rows": len(rows),
                "provenance": {
                    k: v for k, v in result["provenance"].items() if k != "measurements"
                },
            }
        if operation in {"sample", "display", "recipe"}:
            exact_keys(request, {"id", "data", "expected_revision", "source_id"}, operation)
            data = request.get("data")
            if operation == "sample":
                source = self.project.source(request["id"])
                data = validate_sample_metadata(data).to_dict()
                if data["study"] != self.project.meta["title"]:
                    raise ValueError("Sample study title must match the open study")
                del source
            elif operation == "recipe":
                exact_keys(data, {"name", "recipe", "selection"}, "saved recipe")
                checked_text(data.get("name"), "Recipe name")
                validation = self.validate_recipe(
                    {
                        "source_id": request["source_id"],
                        "selection": data.get("selection"),
                        "recipe": data["recipe"],
                    }
                )
                data = {
                    **data,
                    "recipe": validation["recipe"],
                    "recipe_sha256": validation["recipe_sha256"],
                }
            elif operation == "display":
                self.project.source(request["id"])
                exact_keys(data, {"channels", "selection"}, "saved display")
                self.view({"source_id": request["id"], **data})
            return self.project.put_document(
                operation,
                request["id"],
                data,
                expected_revision=request.get("expected_revision", 0),
            )
        if operation == "colocalisation":
            exact_keys(
                request,
                {
                    "source_id",
                    "selection",
                    "first_channel",
                    "second_channel",
                    "threshold_first",
                    "threshold_second",
                    "control",
                },
                "colocalisation",
            )
            checked_text(request.get("control"), "Colocalisation control/assumptions", 2048)
            first, geometry, selection = self.load_scalar(
                request["source_id"],
                {**request.get("selection", {}), "c": request["first_channel"]},
            )
            second, _, _ = self.load_scalar(
                request["source_id"], {**selection, "c": request["second_channel"]}
            )
            return {
                **colocalisation(
                    first,
                    second,
                    threshold_first=request["threshold_first"],
                    threshold_second=request["threshold_second"],
                ),
                "control": request["control"],
                "geometry": geometry.to_dict(),
                "selection": selection,
            }
        raise ValueError("Operation has no executor")
