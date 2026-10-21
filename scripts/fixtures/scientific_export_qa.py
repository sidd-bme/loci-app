#!/usr/bin/env python3
"""Authored synthetic study and independent standard-library CSV package oracle.

Only create() imports imaging/engine packages. verify/snapshot/unchanged use the
Python standard library and constants derived from the authored square geometry.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sqlite3
import stat
import sys
from pathlib import Path

LABELS = (1, 7, 0xFFFFFFFF)
SIDES = (2, 3, 4)
STARTS = (4, 12, 24)
RAW_A = (-2.5, 1e-150, 1e20)
RAW_B = (-0.0, 0.0, 10.0)
RAW_PIXEL = (100.0, 160.0, 220.0)
SAMPLES = {
    "A": '=Synthetic µm, "A"\nsecond line',
    "B": "'Synthetic B, β",
    "C": "Empty authored field",
    "D": "Large authored grid",
}
MODES = ("reviewedA", "allprovisional", "A-groupunion", "large600")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024**2):
            result.update(chunk)
    return result.hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def write_json(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def create(directory):
    # These imports are intentionally absent from independent verification modes.
    import numpy as np
    import tifffile

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "engine" / "src"))
    from loci_engine.research_groups import dispatch_group
    from loci_engine.research_jobs import run_job, submit_job
    from loci_engine.research_labels_import import ALIGNMENT, create_import_grant
    from loci_engine.research_population import intensity_metric_id
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=False)
    inputs = root / "inputs"
    inputs.mkdir()
    project = ResearchProject.create(
        root / "Scientific-export.loci-study",
        "Authored scientific CSV qualification",
        schema_version=2,
    )
    workbench = Workbench(project)
    source_records, final_results, auxiliary, groups = {}, {}, [], {}

    def import_source(name, pixels, calibrated=False, tiled=False):
        path = inputs / f"{name}-source.ome.tif"
        axes = "CYX" if pixels.ndim == 3 else "YX"
        metadata = {"axes": axes}
        if pixels.ndim == 3:
            metadata["Channel"] = {"Name": ["A raw", "B raw"]}
        elif name == "D":
            metadata["Channel"] = {"Name": ["Grid raw"]}
        if calibrated:
            metadata.update(
                PhysicalSizeX=0.5,
                PhysicalSizeY=0.5,
                PhysicalSizeXUnit="µm",
                PhysicalSizeYUnit="µm",
            )
        options = {"tile": (64, 64), "compression": "deflate"} if tiled else {}
        tifffile.imwrite(
            path,
            pixels,
            ome=True,
            photometric="minisblack",
            metadata=metadata,
            **options,
        )
        source = workbench.import_native(str(path))
        source_records[name] = {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "path": str(path),
        }
        return source

    def import_labels(name, source, labels, channel=0):
        path = inputs / f"{name}-labels.tif"
        tifffile.imwrite(
            path, labels, photometric="minisblack", metadata={"axes": "YX"}
        )
        grant = create_import_grant(
            workbench,
            str(path),
            source["id"],
            source["sha256"],
            {"t": 0, "c": channel, "z": 0, "level": 0},
        )
        request = {
            "source_id": source["id"],
            "source_sha256": source["sha256"],
            "grant_id": grant["grant_id"],
            "alignment": ALIGNMENT,
            "producer": {
                "name": "Authored square geometry software fixture",
                "version": "1",
            },
        }
        job = submit_job(workbench, request, f"authored-{name}", "labels_import")
        output = run_job(workbench, job["id"])
        require(
            output["job"]["state"] == "succeeded",
            "Authored external-label adoption failed",
        )
        return project.result(output["result"]["id"])

    def identity(result):
        return {"result_id": result["id"], "revision_hash": result["revision_hash"]}

    def save_group(result, name, x_metric, y_metric, bounds):
        binding = identity(result)
        gate = {
            "kind": "rectangle",
            "x_metric": x_metric,
            "y_metric": y_metric,
            "x_transform": "linear",
            "y_transform": "linear",
            "bounds": bounds,
        }
        receipt = dispatch_group(
            project, "population_gate_evaluate", {**binding, "gate": gate}
        )
        document = dispatch_group(
            project,
            "population_group_save",
            {
                **binding,
                "gate": gate,
                "name": name,
                "membership_sha256": receipt["membership_sha256"],
            },
        )
        labels = document["data"]["receipt"]["labels"]
        groups[name] = {
            "group_id": document["id"],
            "name": name,
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "membership_sha256": receipt["membership_sha256"],
            "labels": labels,
        }

    try:
        labels = np.zeros((64, 64), np.uint32)
        raw = np.zeros((2, 64, 64), np.float64)
        inner = np.zeros((64, 64), np.uint32)
        for index, (label, side, start) in enumerate(
            zip(LABELS, SIDES, STARTS, strict=True)
        ):
            region = (slice(start, start + side), slice(start, start + side))
            labels[region] = label
            raw[(0, *region)] = RAW_A[index]
            raw[(1, *region)] = RAW_B[index]
            if index < 2:
                inner[start, start] = label
        source_a = import_source("A", raw, calibrated=True)
        cells = import_labels("A-cells", source_a, labels)
        nuclei = import_labels("A-inner", source_a, inner, channel=1)
        auxiliary = [identity(cells), identity(nuclei)]
        result_a = workbench.execute(
            "associate_results",
            {
                "cells": identity(cells),
                "nuclei": identity(nuclei),
                "roles": {
                    "cells": "Authored square objects",
                    "nuclei": "Authored inner pixels",
                },
                "control": "Authored software fixture geometry; no biological interpretation",
                "measurement_channels": [0, 1],
            },
        )["result"]
        final_results["A"] = project.result(result_a["id"])
        require(
            [row["label"] for row in final_results["A"]["provenance"]["measurements"]]
            == list(LABELS),
            "External-label sparse IDs changed",
        )
        project.review(result_a["id"], result_a["revision_hash"], "reviewed")
        save_group(
            final_results["A"], "Small", "measure", "voxel_count", [1, 2.25, 4, 9]
        )
        save_group(
            final_results["A"], "High", "measure", "voxel_count", [2.25, 4, 9, 16]
        )
        require(
            groups["Small"]["labels"] == [1, 7]
            and groups["High"]["labels"] == [7, 0xFFFFFFFF],
            "Authored groups disagree with exact area/count math",
        )

        pixel_raw = np.zeros((64, 64), np.float64)
        for value, side, start in zip(RAW_PIXEL, SIDES, STARTS, strict=True):
            pixel_raw[start : start + side, start : start + side] = value
        source_b = import_source("B", pixel_raw)
        final_results["B"] = import_labels("B", source_b, labels)
        source_c = import_source("C", np.zeros((8, 8), np.uint16))
        final_results["C"] = import_labels("C", source_c, np.zeros((8, 8), np.uint32))

        grid = np.zeros((400, 400), np.uint16)
        for y in range(100):
            for x in range(100):
                grid[4 * y + 1 : 4 * y + 3, 4 * x + 1 : 4 * x + 3] = y * 100 + x + 1
        source_d = import_source("D", grid, calibrated=True, tiled=True)
        large_request = {
            "source_id": source_d["id"],
            "selection": {"t": 0, "c": 0, "z": 0, "level": 0},
            "segmentation": {
                "method": "components",
                "threshold": 0.5,
                "polarity": "bright",
                "min_size": 0,
                "exclude_border": False,
            },
            "working_bytes": 256 * 1024**2,
        }
        output = workbench.execute("large_components_run", large_request)
        final_results["D"] = project.result(output["result"]["id"])
        require(
            final_results["D"]["object_count"] == 10000,
            "Authored large grid did not produce 10000 objects",
        )
        project.review(
            final_results["D"]["id"], final_results["D"]["revision_hash"], "reviewed"
        )
        save_group(
            final_results["D"],
            "Selected600",
            intensity_metric_id("1: Grid raw", "mean"),
            "measure",
            [1, 600, 1, 1],
        )
        require(
            groups["Selected600"]["labels"] == list(range(1, 601)),
            "Large gate must include all 600 authored objects",
        )

        # Execute supported producers, rather than manufacturing provenance maps.
        rgb = np.full((32, 48, 3), 255, np.uint8)
        rgb[4:12, 5:15] = 64
        rgb[20:24, 30:34] = 64
        rgb_path = inputs / "E-method-source.ome.tif"
        tifffile.imwrite(
            rgb_path, rgb, photometric="rgb", ome=True, metadata={"axes": "YXS"}
        )
        rgb_source = workbench.import_native(str(rgb_path))
        source_records["E"] = {
            "source_id": rgb_source["id"],
            "source_sha256": rgb_source["sha256"],
            "path": str(rgb_path),
        }
        method_results, method_provenance = {}, {}
        for name, operation, source_id, request, field in [
            (
                "Tissue",
                "tissue_run",
                rgb_source["id"],
                {
                    "settings": {
                        "control": "/private/authored-control-not-for-export",
                        "closing_radius_pixels": 2,
                        "minimum_component_pixels": 20,
                    }
                },
                "tissue_mask",
            ),
            (
                "Stain",
                "histology_run",
                rgb_source["id"],
                {
                    "basis": "H&E",
                    "component": 0,
                    "segmentation": {"method": "components", "threshold": 0.01},
                },
                "stain_separation",
            ),
            (
                "RGB",
                "run_recipe",
                rgb_source["id"],
                {
                    "recipe": {
                        "input_transform": "rgb_intensity",
                        "measurement_channels": [],
                        "segmentation": {"method": "components", "threshold": 0.2},
                    }
                },
                "input_transform",
            ),
            (
                "Puncta",
                "puncta_run",
                source_records["B"]["source_id"],
                {
                    "sigma": 1.0,
                    "response_threshold": 0.0,
                    "raw_threshold": 50.0,
                    "minimum_distance": 2.1,
                    "aperture_radius": 1.0,
                    "exclude_border": True,
                    "control": "/private/authored-control-not-for-export",
                },
                "puncta",
            ),
        ]:
            result = project.result(
                workbench.execute(operation, {"source_id": source_id, **request})[
                    "result"
                ]["id"]
            )
            method_results[name] = {
                **identity(result),
                "source_id": result["source_id"],
                "source_sha256": result["source_sha256"],
                "review_status": "pending",
            }
            method_provenance[name] = {
                "field": field,
                "expected": {
                    key: value
                    for key, value in result["provenance"][field].items()
                    if key
                    not in {
                        "control",
                        "response_formula",
                        "candidate_rule",
                        "suppression_rule",
                        "region_rule",
                        "limits",
                        "interpretation",
                    }
                },
            }

        for name, result in final_results.items():
            project.put_document(
                "sample",
                result["source_id"],
                {
                    "study": "Authored scientific CSV study",
                    "sample": SAMPLES[name],
                    "condition": "Authored shared condition",
                    "biological_replicate": "R1" if name in {"A", "B"} else None,
                    "plate": None,
                    "well": None,
                },
                expected_revision=0,
            )
        manifest = {
            "schema": "loci.scientific-export-qa-fixture/v1",
            "purpose": "Authored software qualification; no biological validation",
            "study_path": str(project.root),
            "sources": source_records,
            "results": {
                name: {
                    **identity(result),
                    "source_id": result["source_id"],
                    "source_sha256": result["source_sha256"],
                    "review_status": "reviewed" if name in {"A", "D"} else "pending",
                }
                for name, result in final_results.items()
            },
            "method_results": method_results,
            "method_provenance": method_provenance,
            "auxiliary_results": auxiliary,
            "groups": groups,
            "authored_math": {
                "A": {
                    "labels": list(LABELS),
                    "counts": [4, 9, 16],
                    "areas_um2": [1, 2.25, 4],
                    "raw_A": list(RAW_A),
                    "requested_raw_A": [-2.5, 1e-150, 1e150],
                    "native_capability_limit": "Native label preview rejects intensity magnitude above 1e30; third value uses supported 1e20. Larger stored-value serialization tests are separate, not native capability evidence.",
                    "raw_B": list(RAW_B),
                },
                "B": {"areas_pixel2": [4, 9, 16], "raw_means": list(RAW_PIXEL)},
                "D": {
                    "object_count": 10000,
                    "selected_count": 600,
                    "area_um2": 1,
                    "raw_mean_equals_label": True,
                },
                "declared_replicates": 1,
                "note": "A and B share declared R1; correlated image/object counts are not independent n",
            },
            "sample_names": SAMPLES,
            "inputs_sha256": {
                path.name: digest(path) for path in sorted(inputs.iterdir())
            },
        }
        write_json(root / "fixture.json", manifest)
        return {
            "manifest": str(root / "fixture.json"),
            "study_path": str(project.root),
            "source_count": len(source_records),
            "authored_result_count": len(final_results),
            "executed_method_result_count": len(method_results),
            "large_object_count": 10000,
            "large_selected_count": 600,
        }
    finally:
        workbench.close()


def decode_cell(value):
    if value == r"\N":
        return None
    if value.startswith(("'", "\\\\")):
        return value[1:]
    return value


def typed(value, kind):
    value = decode_cell(value)
    if value is None:
        return None
    if kind == "integer":
        require(value.lstrip("-").isdigit(), "Invalid integer CSV field")
        return int(value)
    if kind == "number":
        number = float(value)
        require(math.isfinite(number), "Non-finite CSV field")
        return number
    if kind == "boolean":
        require(value in {"true", "false"}, "Invalid boolean CSV field")
        return value == "true"
    return value


def decode_row(row, fields):
    require(
        set(row) == {field["name"] for field in fields}
        and all(isinstance(value, str) for value in row.values()),
        "CSV record has extra or missing cells",
    )
    return {
        field["name"]: typed(
            row[field["name"]],
            "integer"
            if field["name"] == "value" and row.get("raw_numeric_type") == "integer"
            else field["type"],
        )
        for field in fields
    }


def close(actual, expected, context):
    require(
        type(actual) in {int, float} and math.isfinite(actual),
        "Non-finite/missing numeric value: " + context,
    )
    require(
        math.isclose(actual, expected, rel_tol=2e-14, abs_tol=0),
        f"Independent math mismatch {context}: {actual!r} != {expected!r}",
    )


def private_absent(value, root):
    if isinstance(value, dict):
        for key, item in value.items():
            require(not key.startswith("private_"), "Private key in package")
            private_absent(key, root)
            private_absent(item, root)
    elif isinstance(value, list):
        for item in value:
            private_absent(item, root)
    elif isinstance(value, str):
        require(str(root) not in value, "Private fixture path leaked")
        require(
            not value.startswith(("/", "file://", "\\\\"))
            and not (len(value) > 2 and value[1:3] in {":\\", ":/"}),
            "Absolute local locator in package data",
        )


def read_package(package, root):
    requested = Path(package)
    require(
        requested.is_dir() and not requested.is_symlink(),
        "Package must be a plain directory",
    )
    directory = requested.resolve(strict=True)
    manifest_stat = (directory / "manifest.json").lstat()
    require(
        stat.S_ISREG(manifest_stat.st_mode) and manifest_stat.st_nlink == 1,
        "Package manifest is not a plain single-link file",
    )
    manifest = json.loads((directory / "manifest.json").read_text())
    expected = {"manifest.json"}
    for record in manifest["files"]:
        name = record["name"]
        require(
            isinstance(name, str) and Path(name).name == name, "Unsafe package filename"
        )
        require(name not in expected, "Duplicate manifest file")
        expected.add(name)
        path = directory / name
        info = path.lstat()
        require(
            stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
            "Linked/non-regular package artifact",
        )
        require(
            info.st_size == record["size_bytes"] and digest(path) == record["sha256"],
            "Package artifact checksum/size mismatch",
        )
    require(
        {path.name for path in directory.iterdir()} == expected,
        "Package has unmanifested artifacts",
    )
    schema = json.loads((directory / "schema.json").read_text())
    tables = {}
    for name, descriptor in schema["tables"].items():
        if descriptor["format"] != "csv":
            continue
        with (directory / name).open(encoding="utf-8", newline="") as stream:
            reader = csv.DictReader(stream)
            fields = descriptor["fields"]
            require(
                reader.fieldnames == [field["name"] for field in fields],
                "CSV headers differ from schema",
            )
            rows = [decode_row(row, fields) for row in reader]
        require(
            len(rows) == descriptor["row_count"], "CSV row count differs from schema"
        )
        keys = [tuple(row[field] for field in descriptor["primaryKey"]) for row in rows]
        require(len(keys) == len(set(keys)), "Duplicate CSV primary key")
        tables[name] = rows
    for name, descriptor in schema["tables"].items():
        if name not in tables:
            continue
        for foreign in descriptor["foreignKeys"]:
            reference = foreign["reference"]
            targets = {
                tuple(row[field] for field in reference["fields"])
                for row in tables[reference["resource"]]
            }
            require(
                all(
                    tuple(row[field] for field in foreign["fields"]) in targets
                    for row in tables[name]
                ),
                "CSV foreign key has no target",
            )
    raw = [
        json.loads(line)
        for line in (directory / "object-records.jsonl").read_text().splitlines()
    ]
    require(
        len(raw) == schema["tables"]["object-records.jsonl"]["row_count"],
        "Exact JSONL row count mismatch",
    )
    for name in ("manifest.json", "schema.json", "provenance.json"):
        private_absent(json.loads((directory / name).read_text()), root)
    for rows in tables.values():
        private_absent(rows, root)
    private_absent(raw, root)
    return directory, manifest, schema, tables, raw


def verify(manifest_path, mode, package):
    fixture = json.loads(Path(manifest_path).read_text())
    directory, manifest, schema, tables, raw = read_package(
        package, Path(manifest_path).resolve().parent
    )
    names = (
        ("A", "B", "C", "D")
        if mode == "allprovisional"
        else (("D",) if mode == "large600" else ("A",))
    )
    expected_results = {fixture["results"][name]["result_id"]: name for name in names}
    results = tables["results.csv"]
    require(
        {row["result_id"] for row in results} == set(expected_results),
        "Export result set differs from selected fixture mode",
    )
    for row in results:
        named = expected_results[row["result_id"]]
        binding = fixture["results"][named]
        require(
            all(
                row[key] == binding[key]
                for key in ("revision_hash", "source_id", "source_sha256")
            ),
            "Exact source/result identity changed",
        )
        require(
            (row["review_disposition"] or "pending") == binding["review_status"],
            "Export changed exact review status",
        )
        if binding["review_status"] == "pending":
            require(
                row["review_disposition"] is None and row["review_json"] is None,
                "Implicit pending review gained a fabricated receipt",
            )
    expected_count = (
        10006 if mode == "allprovisional" else (600 if mode == "large600" else 3)
    )
    require(
        len(tables["objects.csv"]) == expected_count == len(raw),
        "Full exact object count mismatch",
    )
    require(
        manifest["counts"]["selected_count"] == expected_count,
        "Manifest object count mismatch",
    )
    objects = {
        (row["result_id"], int(row["label"])): row for row in tables["objects.csv"]
    }
    measurements = {}
    metric_index = {}
    for row in tables["measurements.csv"]:
        key = (
            row["result_id"],
            int(row["label"]),
            row["compartment"],
            row["channel"],
            row["statistic"],
            row["metric_id"],
        )
        measurements[key] = row
        metric_index.setdefault(key[:5], []).append(row)
    exact = {
        (row["result_id"], int(row["object"]["label"])): row["object"] for row in raw
    }
    require(
        set(exact) == set(objects), "JSONL exact object membership differs from CSV"
    )
    signed_zero_checks = 0
    for name in names:
        result_id = fixture["results"][name]["result_id"]
        expected_labels = (
            []
            if name == "C"
            else (
                list(range(1, 601 if mode == "large600" else 10001))
                if name == "D"
                else list(LABELS)
            )
        )
        require(
            sorted(label for result, label in objects if result == result_id)
            == expected_labels,
            "Sparse/full membership mismatch for " + name,
        )
        for ordinal, label in enumerate(expected_labels):
            obj = objects[result_id, label]
            original = exact[result_id, label]
            count = 4 if name == "D" else SIDES[ordinal] ** 2
            area = count if name == "B" else count * 0.25
            require(
                obj["voxel_count"] == count, "Independent square pixel-count mismatch"
            )
            close(obj["measure"], area, name + " area")
            require(
                obj["measure_unit"] == ("pixel^2" if name == "B" else "um^2"),
                "Units pooled or changed",
            )
            require(obj["index_axes"] == "YX", "Index axes changed")
            close(original["measure"], area, "Exact JSONL area")
            side = 2 if name == "D" else SIDES[ordinal]
            scale = 1.0 if name == "B" else 0.5
            if name == "D":
                row_index, column_index = divmod(label - 1, 100)
                start_y, start_x = row_index * 4 + 1, column_index * 4 + 1
            else:
                start_y = start_x = STARTS[ordinal]
            for axis, start in (("y", start_y), ("x", start_x)):
                centroid = start + (side - 1) / 2
                close(
                    obj[f"centroid_index_{axis}"],
                    centroid,
                    "Index centroid axis " + axis,
                )
                close(
                    obj[f"centroid_world_{axis}"],
                    centroid * scale,
                    "World centroid axis " + axis,
                )
                require(
                    obj[f"bbox_start_{axis}"] == start
                    and obj[f"bbox_stop_exclusive_{axis}"] == start + side,
                    "Half-open bounding box changed",
                )
            radius = math.sqrt((side * side - 1) / 12) * scale
            for index, expectation in enumerate((radius, radius, 0.0), 1):
                close(
                    original["principal_rms_radii"][index - 1],
                    expectation,
                    "Independent square RMS radius",
                )
                metric = measurements.get(
                    (
                        result_id,
                        label,
                        None,
                        None,
                        None,
                        f"principal_rms_radius:{index}",
                    )
                )
                require(
                    metric is not None and metric["status"] == "value",
                    "Normalized RMS radius missing",
                )
                close(metric["value"], expectation, "Normalized square RMS radius")
                require(
                    metric["value"] == original["principal_rms_radii"][index - 1],
                    "Radius precision changed between raw JSONL and normalized CSV",
                )
            expected_raw = (
                float(label)
                if name == "D"
                else (RAW_A[ordinal] if name == "A" else RAW_PIXEL[ordinal])
            )
            top_channel = (
                "1: A raw"
                if name == "A"
                else (
                    "1: Grid raw" if name == "D" else next(iter(original["intensity"]))
                )
            )
            for statistic, expectation in (
                ("mean", expected_raw),
                ("sum", expected_raw * count),
                ("min", expected_raw),
                ("max", expected_raw),
            ):
                candidates = metric_index.get(
                    (result_id, label, None, top_channel, statistic), []
                )
                require(
                    len(candidates) == 1 and candidates[0]["status"] == "value",
                    "Missing exact raw object metric",
                )
                require(
                    candidates[0]["value"]
                    == original["intensity"][top_channel][statistic],
                    "Raw numeric precision changed between JSONL and CSV",
                )
                close(
                    candidates[0]["value"],
                    expectation,
                    f"{name} raw {label} {statistic}",
                )
            if name == "A":
                compartments = original["compartments"]
                nuclear = 1 if ordinal < 2 else 0
                require(
                    compartments["nuclear"]["voxel_count"] == nuclear,
                    "Authored inner-pixel count mismatch",
                )
                require(
                    compartments["cytoplasm"]["voxel_count"] == count - nuclear,
                    "Authored remaining-pixel count mismatch",
                )
                for compartment in ("cell", "nuclear", "cytoplasm"):
                    for channel, expected_value in (
                        ("1: A raw", RAW_A[ordinal]),
                        ("2: B raw", RAW_B[ordinal]),
                    ):
                        hits = metric_index.get(
                            (result_id, label, compartment, channel, "mean"), []
                        )
                        require(len(hits) == 1, "Missing raw compartment channel mean")
                        require(
                            hits[0]["value"]
                            == compartments[compartment]["intensity"][channel]["mean"],
                            "Compartment precision changed between JSONL and CSV",
                        )
                        if compartment == "nuclear" and nuclear == 0:
                            require(
                                hits[0]["status"] == "null"
                                and hits[0]["value"] is None,
                                "Empty compartment null was coerced to zero",
                            )
                        else:
                            close(
                                hits[0]["value"],
                                expected_value,
                                "Raw compartment channel mean",
                            )
                if nuclear == 0:
                    for channel in ("1: A raw", "2: B raw"):
                        zero_sum = metric_index.get(
                            (result_id, label, "nuclear", channel, "sum"), []
                        )
                        require(
                            len(zero_sum) == 1
                            and zero_sum[0]["status"] == "value"
                            and zero_sum[0]["value"] == 0,
                            "Empty compartment sum is an actual zero, not null",
                        )
                b_min = compartments["cell"]["intensity"]["2: B raw"]["min"]
                if ordinal == 0:
                    require(
                        b_min == 0 and math.copysign(1, b_min) == -1,
                        "Stored raw negative zero lost in JSONL",
                    )
                    hits = metric_index.get(
                        (result_id, label, "cell", "2: B raw", "min"), []
                    )
                    require(
                        len(hits) == 1 and math.copysign(1, hits[0]["value"]) == -1,
                        "Stored negative zero lost in normalized CSV",
                    )
                    signed_zero_checks += 2
    expected_group_names = (
        {"Selected600"}
        if mode == "large600"
        else (
            {"Small", "High", "Selected600"}
            if mode == "allprovisional"
            else {"Small", "High"}
        )
    )
    require(
        {row["name"] for row in tables["groups.csv"]} == expected_group_names,
        "Exact named group set mismatch",
    )
    for name in expected_group_names:
        expected_group = fixture["groups"][name]
        row = next(row for row in tables["groups.csv"] if row["name"] == name)
        require(
            row["group_id"] == expected_group["group_id"]
            and row["membership_sha256"] == expected_group["membership_sha256"],
            "Group identity changed",
        )
        expected_labels = (
            list(range(1, 601))
            if name == "Selected600"
            else ([1, 7] if name == "Small" else [7, 0xFFFFFFFF])
        )
        actual = [
            int(member["label"])
            for member in tables["memberships.csv"]
            if member["group_id"] == row["group_id"]
        ]
        require(
            sorted(actual) == expected_labels,
            "Complete group membership differs from authored math",
        )
    if "A" in names:
        aid = fixture["results"]["A"]["result_id"]
        require(
            sum(
                row["result_id"] == aid and row["label"] == "7"
                for row in tables["memberships.csv"]
            )
            == 2,
            "Overlapping membership was lost or duplicated objects",
        )
    samples = {row["source_id"]: row for row in tables["samples.csv"]}
    for name in names:
        source_id = fixture["results"][name]["source_id"]
        require(
            samples[source_id]["sample"] == SAMPLES[name],
            "Formula/Unicode/newline CSV text did not round trip",
        )
        require(
            samples[source_id]["biological_replicate"]
            == ("R1" if name in {"A", "B"} else None),
            "Biological replicate assignment changed",
        )
    replicate_keys = {
        (row["study"], row["condition"], row["biological_replicate"])
        for row in samples.values()
        if row["biological_replicate"] is not None
    }
    require(
        len(replicate_keys) == (0 if mode == "large600" else 1),
        "Declared replicate count was inferred from images or objects",
    )
    require(
        manifest["counts"]["source_count"] == len(names),
        "Source count differs from exact source set",
    )
    require(
        not (directory / "conditions.csv").exists()
        and not (directory / "replicates.csv").exists(),
        "Package inferred unrequested replicate estimates",
    )
    require(
        "correlated" in schema["independent_n_basis"],
        "Independent-n disclosure missing",
    )
    purpose = "provisional" if mode == "allprovisional" else "reviewed"
    require(
        manifest["purpose"] == purpose, "Package purpose differs from native request"
    )
    return {
        "schema": "loci.scientific-export-independent-oracle/v1",
        "mode": mode,
        "package": str(directory),
        "manifest_sha256": digest(directory / "manifest.json"),
        "object_count": expected_count,
        "measurement_count": len(measurements),
        "membership_count": len(tables["memberships.csv"]),
        "signed_zero_checks": signed_zero_checks,
        "declared_replicate_count": len(replicate_keys),
        "unassigned_source_count": sum(
            row["biological_replicate"] is None for row in samples.values()
        ),
        "hashes_counts_pk_fk_codec_math_privacy": "passed",
        "independent_reader": "Python standard library only",
    }


def snapshot(manifest_path):
    fixture = json.loads(Path(manifest_path).read_text())
    root = Path(manifest_path).resolve().parent
    study = Path(fixture["study_path"])
    files = {}
    for directory in (root / "inputs", study / "artifacts"):
        for path in sorted(directory.iterdir()):
            require(
                path.is_file() and not path.is_symlink(),
                "Fixture immutable file is not plain",
            )
            files[str(path.relative_to(root))] = {
                "sha256": digest(path),
                "size_bytes": path.stat().st_size,
            }
    database = study / "study.sqlite3"
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        scientific = {
            "sources": connection.execute(
                "SELECT id,record FROM sources ORDER BY id"
            ).fetchall(),
            "results": connection.execute(
                "SELECT id,record FROM results ORDER BY id"
            ).fetchall(),
            "documents": connection.execute(
                "SELECT kind,id,revision,record FROM documents WHERE kind NOT IN ('data_export_grant','labels_import_grant','large_export_grant','large_exchange_grant','display','selection','workspace') ORDER BY kind,id"
            ).fetchall(),
            "metadata": connection.execute(
                "SELECT key,value FROM metadata WHERE key='project' OR key LIKE 'review:%' OR key LIKE 'review-event:%' ORDER BY key"
            ).fetchall(),
        }
    return {
        "schema": "loci.scientific-export-immutability/v1",
        "immutable_files": files,
        "scientific_state_sha256": hashlib.sha256(
            encoded(scientific).encode()
        ).hexdigest(),
        "database_sha256": digest(database),
        "database_note": "Export grants/jobs may change physical database bytes; scientific rows and all source/label/artifact bytes must remain identical",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    creation = sub.add_parser("create")
    creation.add_argument("--directory", required=True)
    verification = sub.add_parser("verify")
    verification.add_argument("--manifest", required=True)
    verification.add_argument("--mode", required=True, choices=MODES)
    verification.add_argument("--package", action="append", required=True)
    capture = sub.add_parser("snapshot")
    capture.add_argument("--manifest", required=True)
    capture.add_argument("--output", required=True)
    unchanged = sub.add_parser("unchanged")
    unchanged.add_argument("--manifest", required=True)
    unchanged.add_argument("--snapshot", required=True)
    args = parser.parse_args()
    if args.command == "create":
        result = create(args.directory)
    elif args.command == "verify":
        result = {
            "checks": [
                verify(args.manifest, args.mode, package) for package in args.package
            ]
        }
    elif args.command == "snapshot":
        result = snapshot(args.manifest)
        write_json(args.output, result)
    else:
        before = json.loads(Path(args.snapshot).read_text())
        after = snapshot(args.manifest)
        require(
            before["immutable_files"] == after["immutable_files"],
            "Source, labels or stored artifact bytes changed",
        )
        require(
            before["scientific_state_sha256"] == after["scientific_state_sha256"],
            "Scientific study state changed",
        )
        result = {
            "immutable_files": "passed",
            "scientific_state": "passed",
            "physical_database_changed": before["database_sha256"]
            != after["database_sha256"],
        }
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
