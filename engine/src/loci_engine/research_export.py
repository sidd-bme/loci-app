"""Atomic, reviewed research-result interchange with source-grid provenance."""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import tifffile

from .export import _fsync_directory, _rename_noreplace, sanitize_basename
from .research_project import ResearchProject, canonical_json
from .study_analysis import measurements_csv
from .workbench import geometry_from_dict
from .working_result import _sha256_file_stable


def flat_measurements(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for row in rows:
        flat: dict[str, Any] = {}
        for key, value in row.items():
            if isinstance(value, dict):
                for name, item in value.items():
                    if isinstance(item, dict):
                        for statistic, number in item.items():
                            flat[f"{key}:{name}:{statistic}"] = number
                    else:
                        flat[f"{key}:{name}"] = item
            elif isinstance(value, list):
                for axis, item in enumerate(value):
                    flat[f"{key}:{axis}"] = item
            else:
                flat[key] = value
        result.append(flat)
    return result


def methods_text(result: dict[str, Any]) -> str:
    provenance = result["provenance"]
    runtime = provenance.get("runtime", {})
    lines = [
        "# Executed Loci research methods",
        "",
        f"Result revision: `{result['revision_hash']}`.",
        f"Source identity: `{result['source_sha256']}`.",
        "",
        "These records describe execution. They do not establish biological accuracy.",
        "",
        "## Selected data and geometry",
        "",
        "```json",
        canonical_json(
            {"selection": provenance.get("selection"), "geometry": provenance.get("geometry")}
        ),
        "```",
        "",
        "## Executed operations",
        "",
        "```json",
        canonical_json(
            {
                "processing": provenance.get("processing", []),
                "segmentation": provenance.get("segmentation"),
                "correction": provenance.get("correction"),
                "recipe": provenance.get("recipe"),
                "measurement_basis": provenance.get("measurement_basis"),
                "stain_separation": provenance.get("stain_separation"),
                "tissue_mask": provenance.get("tissue_mask"),
                "tissue_mask_status": provenance.get("tissue_mask_status"),
                "references": provenance.get("references"),
                "model": provenance.get("model"),
                "model_preview": provenance.get("model_preview"),
                "channel_mapping": provenance.get("channel_mapping"),
                "channel_metadata": provenance.get("channel_metadata"),
                "source_derivation": provenance.get("source_derivation"),
                "puncta": provenance.get("puncta"),
                "puncta_peak_status": provenance.get("puncta_peak_status"),
                "association": provenance.get("association"),
                "association_inputs": provenance.get("association_inputs"),
                "colocalisation": provenance.get("colocalisation"),
                "transform": provenance.get("transform"),
                "output_grid": provenance.get("output_grid"),
                "interpolation": provenance.get("interpolation"),
                "registration_quality": provenance.get("quality"),
                "registration_preview": provenance.get("registration_preview"),
                "source_scale": provenance.get("source_scale"),
                "annotations": provenance.get("annotations", []),
                "tracking_settings": provenance.get("tracking_settings"),
                "temporal_inputs": provenance.get("temporal_inputs"),
                "trajectory_units": provenance.get("trajectory_units"),
                "track_correction": provenance.get("track_correction"),
            }
        ),
        "```",
        "",
        "## Software and citations",
        "",
        "```json",
        canonical_json(runtime),
        "```",
        "",
    ]
    if runtime.get("scipy"):
        lines.append(
            "- SciPy operation reference: https://docs.scipy.org/doc/scipy/reference/ndimage.html"
        )
    if runtime.get("scikit_image"):
        lines.append(
            "- scikit-image segmentation reference: https://scikit-image.org/docs/stable/api/skimage.segmentation.html"
        )
    citations = provenance.get("model", {}).get("citations", [])
    if citations:
        lines.extend(
            ["", "Declared model citations:", "", "```json", canonical_json(citations), "```"]
        )
    return "\n".join(lines) + "\n"


def _verify_references(project: ResearchProject, result: dict[str, Any]) -> None:
    from .research_vendor import verify_result_derivation

    provenance = result["provenance"]
    verify_result_derivation(project.source(result["source_id"]), provenance)
    for reference in provenance.get("references", {}).values():
        source = project.source(reference["source_id"], verify=True)
        if source["sha256"] != reference["source_sha256"]:
            raise ValueError("An exported reference source changed")
    result_bindings = list(provenance.get("temporal_inputs", []))
    result_bindings.extend(provenance.get("association_inputs", {}).values())
    result_bindings.extend(
        provenance[key]
        for key in ("parent_result", "fixed_result", "moving_result")
        if key in provenance
    )
    for binding in result_bindings:
        if binding.get("missing_reason"):
            continue
        frame = project.result(binding["result_id"])
        if frame["revision_hash"] != binding["revision_hash"]:
            raise ValueError("An exported scientific result reference changed")
        project.source(frame["source_id"], verify=True)
        for descriptor in frame["arrays"].values():
            project.verify_array(descriptor)


def _export_extended_records(
    project: ResearchProject, result: dict[str, Any], stage: Path
) -> dict[str, Any]:
    from .research_annotations import roi_from_geojson, roi_from_imagej, roi_to_imagej

    provenance = result["provenance"]
    summary: dict[str, Any] = {"imagej_roi_files": [], "geojson_only_annotations": []}
    summary["quantification_files"] = []
    for key, filename, rows in (
        ("puncta", "puncta-peaks.csv", provenance.get("peaks", [])),
        (
            "association",
            "nucleus-cell-associations.csv",
            provenance.get("association", {}).get("rows", []),
        ),
        ("colocalisation", "colocalisation.csv", [provenance.get("colocalisation", {})]),
    ):
        if key in provenance:
            (stage / filename).write_text(
                measurements_csv(flat_measurements(rows)), encoding="utf-8"
            )
            summary["quantification_files"].append(filename)
    features, measurements = [], []
    for annotation in provenance.get("annotations", []):
        roi = roi_from_geojson(annotation["geojson"])
        parent = project.result(annotation["parent_result_id"])
        if (
            parent["revision_hash"] != roi.result_sha256
            or parent["source_sha256"] != roi.source_sha256
            or result["source_sha256"] != roi.source_sha256
            or canonical_json(roi.geometry.to_dict()) != canonical_json(provenance["geometry"])
            or annotation["id"] != roi.annotation_id
        ):
            raise ValueError("An exported ROI lost its source, parent, or geometry binding")
        features.append(annotation["geojson"])
        for channel, row in annotation["measurements"].items():
            measurements.append({"annotation_id": roi.annotation_id, "channel": channel, **row})
        if (
            roi.plane == "XY"
            and roi.slab_start == roi.plane_index
            and roi.slab_stop_exclusive == roi.plane_index + 1
        ):
            encoded = roi_to_imagej(roi)
            restored = roi_from_imagej(encoded)
            if restored != roi:
                raise ValueError("Exported ImageJ ROI failed its coordinate round trip")
            filename = "annotation-" + roi.annotation_id + ".roi"
            (stage / filename).write_bytes(encoded)
            summary["imagej_roi_files"].append(filename)
        else:
            summary["geojson_only_annotations"].append(
                {"id": roi.annotation_id, "reason": "ImageJ ROI supports a single XY plane"}
            )
    if features:
        (stage / "annotations.geojson").write_text(
            canonical_json({"type": "FeatureCollection", "features": features}) + "\n",
            encoding="utf-8",
        )
        (stage / "roi-measurements.csv").write_text(
            measurements_csv(flat_measurements(measurements)), encoding="utf-8"
        )
    if "tracking" in provenance:
        from .research_temporal import _graph_from_record

        _graph_from_record(provenance["tracking"])
        (stage / "tracking.json").write_text(
            canonical_json(
                {
                    "schema": "loci.tracking-export/v1",
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "tracking": provenance["tracking"],
                    "inputs": provenance["temporal_inputs"],
                    "units": provenance["trajectory_units"],
                    "settings": provenance["tracking_settings"],
                }
            )
            + "\n",
            encoding="utf-8",
        )
        trajectory_rows = [
            {
                "track_index": index + 1,
                **point,
                **{name + "_unit": unit for name, unit in provenance["trajectory_units"].items()},
            }
            for index, track in enumerate(provenance["tracking"]["trajectories"])
            for point in track
        ]
        (stage / "trajectories.csv").write_text(
            measurements_csv(flat_measurements(trajectory_rows)), encoding="utf-8"
        )
        summary["tracking_file"] = "tracking.json"
    return summary


def export_research_result(
    project: ResearchProject,
    result_id: str,
    revision_hash: str,
    destination: str | Path,
) -> dict[str, Any]:
    """Publish one absent directory, only after exact review and full validation."""
    result = project.result(result_id)
    if result["revision_hash"] != revision_hash:
        raise ValueError("Export revision is stale; review the selected result again")
    review = project.review_state(result_id)
    if review is None or review["disposition"] != "reviewed":
        raise ValueError("Review this exact result revision before exporting it")
    source = project.source(result["source_id"], verify=True)
    _verify_references(project, result)
    target = Path(destination)
    if not target.is_absolute() or target.is_symlink() or target.exists():
        raise ValueError(
            "Export needs an absent absolute destination; existing work is never overwritten"
        )
    parent = target.parent.resolve(strict=True)
    parent_stat = parent.stat()
    target = parent / sanitize_basename(target.name, fallback="loci-result")
    if target.exists() or target.is_symlink():
        raise ValueError("The export destination already exists")
    if target == project.root or project.root.is_relative_to(target):
        raise ValueError("An export cannot replace its source study")
    if sum(descriptor["bytes"] for descriptor in result["arrays"].values()) > 512 * 1024**2:
        raise ValueError("Result export exceeds the 512 MiB decoded artifact budget")
    arrays = {name: project.load_array(descriptor) for name, descriptor in result["arrays"].items()}
    image = arrays.get("image")
    labels = arrays.get("labels")
    geometry = geometry_from_dict(result["provenance"]["geometry"])
    if image is None or image.ndim != len(geometry.axes):
        raise ValueError("Exported image and geometry disagree")
    if labels is not None and (labels.shape != image.shape or labels.dtype.kind not in "ui"):
        raise ValueError("Exported labels must be integers on the exact image grid")
    stage = Path(tempfile.mkdtemp(prefix=".loci-export-", dir=parent))
    try:
        extended_records = _export_extended_records(project, result, stage)
        artifact_files = {}
        for name, descriptor in result["arrays"].items():
            original = project.arrays / (descriptor["sha256"] + ".npy")
            target_array = stage / (name + ".npy")
            shutil.copyfile(original, target_array, follow_symlinks=False)
            digest, size = _sha256_file_stable(target_array, reject_symlink=True)
            if digest != descriptor["sha256"] or size != descriptor["bytes"]:
                raise ValueError("A derived array changed during export")
            artifact_files[name] = {"file": target_array.name, "sha256": digest, "size_bytes": size}
        if geometry.frame in {"LPS", "RAS"} and image.ndim == 3:
            from .medical_image import export_medical

            export_medical(stage / "image.nii.gz", image, geometry)
            if labels is not None:
                export_medical(stage / "labels.nii.gz", labels, geometry, labels=True)
        else:
            spacing = geometry.spacing
            unit = {"um": "µm", "mm": "mm", "nm": "nm", "m": "m"}.get(geometry.unit)
            metadata: dict[str, Any] = {"axes": geometry.axes}
            if unit:
                for axis, step in zip(geometry.axes, spacing, strict=True):
                    metadata[f"PhysicalSize{axis}"] = step
                    metadata[f"PhysicalSize{axis}Unit"] = unit
            for name, array in arrays.items():
                if name not in {"image", "labels", "probabilities"}:
                    continue
                array_metadata = dict(metadata)
                if name == "probabilities":
                    if array.ndim != image.ndim + 1 or array.shape[1:] != image.shape:
                        raise ValueError("Probability channels must share the exact image grid")
                    array_metadata["axes"] = "C" + geometry.axes
                file = stage / (name + ".ome.tif")
                tifffile.imwrite(
                    file,
                    array,
                    ome=True,
                    metadata=array_metadata,
                    photometric="minisblack",
                    compression="deflate",
                    bigtiff=array.nbytes > 2**32 - 2**25,
                )
                roundtrip = tifffile.imread(file)
                if (
                    roundtrip.dtype != array.dtype
                    or roundtrip.shape != array.shape
                    or not np.array_equal(roundtrip, array)
                ):
                    raise ValueError("Exported TIFF failed exact numerical round-trip verification")
        rows = result["provenance"].get("measurements", [])
        (stage / "objects.csv").write_text(
            measurements_csv(flat_measurements(rows)), encoding="utf-8"
        )
        (stage / "methods.md").write_text(methods_text(result), encoding="utf-8")
        receipt = {
            "schema": "loci.research-export/v1",
            "result": result,
            "review": review,
            "source": project.public_source(source),
            "geometry_authority": "result.provenance.geometry voxel-center XYZ-to-world affine",
            "raw_source_included": False,
            "artifact_files": artifact_files,
            "annotation_and_temporal_exports": extended_records,
        }
        (stage / "result.json").write_text(canonical_json(receipt) + "\n", encoding="utf-8")
        (stage / "loci-export.json").write_text(
            canonical_json(
                {
                    "schema": "loci.export-marker/v1",
                    "bundle_kind": "loci-export",
                    "result_id": result_id,
                    "revision_hash": revision_hash,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        files = []
        for entry in sorted(stage.iterdir()):
            if not entry.is_file() or entry.is_symlink():
                raise ValueError("Export staging contains an unexpected artifact")
            # Windows rejects fsync on a read-only CRT descriptor.
            with entry.open("rb+") as stream:
                os.fsync(stream.fileno())
            digest, size = _sha256_file_stable(entry, reject_symlink=True)
            files.append({"name": entry.name, "sha256": digest, "size_bytes": size})
        manifest = {
            "schema": "loci.export-manifest/v1",
            "result_id": result_id,
            "revision_hash": revision_hash,
            "files": files,
        }
        encoded = canonical_json(manifest).encode()
        with (stage / "manifest.json").open("xb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        _fsync_directory(stage)
        # The selected source and review are rechecked at publication, so a
        # correction or exclusion during a long export cannot publish stale work.
        project.source(result["source_id"], verify=True)
        _verify_references(project, result)
        if project.review_state(result_id) != review:
            raise ValueError("Review changed while export was being prepared")
        current = parent.stat()
        if (current.st_dev, current.st_ino) != (parent_stat.st_dev, parent_stat.st_ino):
            raise ValueError("Export directory changed during publication")
        _rename_noreplace(stage, target)
        _fsync_directory(parent)
        return {
            "export_name": target.name,
            "manifest_sha256": hashlib.sha256(encoded).hexdigest(),
            "files": files,
            "result_id": result_id,
            "revision_hash": revision_hash,
        }
    finally:
        if stage.exists() and not stage.is_symlink():
            shutil.rmtree(stage)
