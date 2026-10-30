"""Generated physical-YX spatial QA fixture and independent brute-force oracle.

Create uses the trusted external-label preview/adopt routes to initialize three
ordinary immutable input results. Verify uses only the project storage loader;
it never calls the spatial implementation, EDT, or nearest-neighbour library.
All inputs are generated technical data, never biological validation evidence.
Run with the existing engine Python environment (no installs are required).
"""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import math
import sys
import xml.etree.ElementTree as ET
from itertools import pairwise
from pathlib import Path

import numpy as np
import tifffile

SHAPE = (64, 80)
SPACING_YX = np.array([2.0, 1.0])
EDGES = [0, 10, 30, 70]
CONTROL = "Generated technical spatial fixture; no biological or clinical validation"
COVERAGE = (
    "Declared full-height x=10 pixel column only; unseen crop boundaries not inferred"
)
ROLES = ("objects", "compartment", "boundary")
FILES = {
    "image": "generated-calibrated-source.ome.tif",
    "objects": "generated-sparse-objects.tif",
    "compartment": "generated-compartment-with-hole.tif",
    "boundary": "generated-declared-boundary.tif",
}
PIXELS = {
    3: [(8, 10)],
    1009: [(12, 19), (13, 20)],
    42001: [(20, 20)],
    70001: [(28, 39)],
    90001: [(36, 40)],
    123457: [(24, 25)],
    4_000_000_000: [(48, 79)],
    2**32 - 1: [(54, 55)],
}
RULES = {
    "distance": "Euclidean distance to declared boundary pixel centers, not tissue thickness",
    "membership": "Object centroid containing pixel floor(index + 0.5); ties toward higher index",
    "bands": "Half-open [lower, upper); final upper endpoint excluded",
    "area": "Sampled compartment pixels in each distance band, including boundary overlap",
    "coverage": "Only the declared boundary subset; unseen boundary outside crop is not inferred",
    "density": "Eligible object count / sampled compartment area; zero area is undefined",
    "aggregation": "One field only; objects are not independent biological replicates",
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def compare(actual, expected, path="value"):
    """Exact structure, integers and text; tolerance only for finite floats."""
    if isinstance(expected, dict):
        check(
            isinstance(actual, dict) and set(actual) == set(expected),
            f"{path}: keys differ",
        )
        for key, value in expected.items():
            compare(actual[key], value, f"{path}.{key}")
    elif isinstance(expected, list):
        check(
            isinstance(actual, list) and len(actual) == len(expected),
            f"{path}: length differs",
        )
        for index, value in enumerate(expected):
            compare(actual[index], value, f"{path}[{index}]")
    elif isinstance(expected, float):
        check(
            type(actual) in (int, float)
            and math.isfinite(actual)
            and math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-9),
            f"{path}: {actual!r} != {expected!r}",
        )
    else:
        check(
            type(actual) is type(expected) and actual == expected,
            f"{path}: {actual!r} != {expected!r}",
        )


def generated_arrays():
    yy, xx = np.indices(SHAPE)
    image = (1000 + 3 * yy + 2 * xx).astype(np.uint16)
    objects = np.zeros(SHAPE, np.uint32)
    for label, coordinates in PIXELS.items():
        for y, x in coordinates:
            objects[y, x] = label
    compartment = np.ones(SHAPE, np.uint32)
    compartment[22:27, 23:28] = 0
    boundary = np.zeros(SHAPE, np.uint32)
    boundary[:, 10] = 1
    return {
        "image": image,
        "objects": objects,
        "compartment": compartment,
        "boundary": boundary,
    }


def oracle(arrays):
    """Exhaust all boundary centers for every pixel and actual object centroid."""
    centers = [
        tuple(point * SPACING_YX) for point in np.argwhere(arrays["boundary"] > 0)
    ]

    def distance(y, x):
        return min(math.hypot(2 * y - by, x - bx) for by, bx in centers)

    def band(value):
        return next(
            (i for i, (a, b) in enumerate(pairwise(EDGES)) if a <= value < b), None
        )

    band_labels = np.zeros(SHAPE, np.uint32)
    pixel_counts = [0] * (len(EDGES) - 1)
    for y in range(SHAPE[0]):
        for x in range(SHAPE[1]):
            index = band(distance(y, x))
            if arrays["compartment"][y, x] and index is not None:
                band_labels[y, x] = index + 1
                pixel_counts[index] += 1
    rows, counts = [], [0] * len(pixel_counts)
    for label in sorted(PIXELS):
        coords = np.argwhere(arrays["objects"] == label)
        y, x = coords.mean(axis=0)
        d = distance(y, x)
        index = band(d)
        reasons = []
        if not arrays["compartment"][math.floor(y + 0.5), math.floor(x + 0.5)]:
            reasons.append("outside_compartment")
        if any(yy in (0, SHAPE[0] - 1) or xx in (0, SHAPE[1] - 1) for yy, xx in coords):
            reasons.append("crop_border")
        if index is None:
            reasons.append("outside_bands")
        if reasons:
            index = None
        else:
            counts[index] += 1
        rows.append(
            {"label": label, "distance": d, "band_index": index, "exclusions": reasons}
        )
    bands = [
        {
            "lower": float(a),
            "upper": float(b),
            "pixel_count": pixels,
            "area": float(pixels * 2),
            "object_count": count,
            "density": count / (pixels * 2) if pixels else None,
        }
        for a, b, pixels, count in zip(EDGES, EDGES[1:], pixel_counts, counts)
    ]
    # Independent closed-form cross-check for this rectangular fixture's areas.
    check(pixel_counts == [19 * 64, 21 * 64 - 25, 40 * 64], "Oracle area cross-check")
    check(counts == [2, 2, 2], "Oracle object-count cross-check")
    return {"objects": rows, "bands": bands}, band_labels


def measurement_oracle(labels, image, channel_name):
    """Raw arithmetic on each label's coordinates, with explicit physical units."""
    rows = []
    for label in np.unique(labels[labels > 0]).tolist():
        coords = np.argwhere(labels == label)
        world = np.column_stack([coords[:, 1], 2 * coords[:, 0], np.zeros(len(coords))])
        values = image[labels == label].astype(np.float64)
        covariance = (
            np.cov(world, rowvar=False, bias=True)
            if len(world) > 1
            else np.zeros((3, 3))
        )
        rows.append(
            {
                "label": label,
                "voxel_count": len(coords),
                "measure": float(len(coords) * 2),
                "measure_kind": "area",
                "measure_unit": "um^2",
                "centroid_index": coords.mean(axis=0).tolist(),
                "index_axes": "YX",
                "centroid_world_xyz": world.mean(axis=0).tolist(),
                "world_frame": "image",
                "distance_unit": "um",
                "bbox_start": coords.min(axis=0).tolist(),
                "bbox_stop_exclusive": (coords.max(axis=0) + 1).tolist(),
                "principal_rms_radii": np.sqrt(
                    np.maximum(np.linalg.eigvalsh(covariance), 0)[::-1]
                ).tolist(),
                "touches_crop_border": bool(
                    np.any(coords == 0) or np.any(coords == np.array(SHAPE) - 1)
                ),
                "intensity": {
                    channel_name: {
                        "mean": float(values.mean()),
                        "sum": float(values.sum()),
                        "min": float(values.min()),
                        "max": float(values.max()),
                        "std_population": float(values.std(ddof=0)),
                    }
                },
            }
        )
    for row in rows:
        others = [
            math.dist(row["centroid_world_xyz"], other["centroid_world_xyz"])
            for other in rows
            if row["label"] != other["label"]
        ]
        row["nearest_centroid_distance"] = min(others) if others else None
    return rows


def engine_imports():
    # Make invocation independent of cwd without changing the active environment.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "engine" / "src"))
    from loci_engine.research_project import ResearchProject

    return ResearchProject


def create(root):
    project_class = engine_imports()
    from loci_engine.research_labels_import import ALIGNMENT, create_import_grant
    from loci_engine.workbench import Workbench

    root.mkdir(parents=True, exist_ok=False)
    arrays = generated_arrays()
    for role, name in FILES.items():
        metadata = {"axes": "YX"}
        if role == "image":
            metadata.update(
                PhysicalSizeX=1.0,
                PhysicalSizeXUnit="µm",
                PhysicalSizeY=2.0,
                PhysicalSizeYUnit="µm",
            )
        tifffile.imwrite(
            root / name,
            arrays[role],
            ome=role == "image",
            photometric="minisblack",
            metadata=metadata,
        )
        (root / name).chmod(0o444)
    study = root / "spatial.loci-study"
    wb = Workbench(project_class.create(study, "Generated spatial technical QA"))
    try:
        source = wb.import_native(str(root / FILES["image"]))
        inputs = {}
        for role in ROLES:
            preview = create_import_grant(
                wb,
                str(root / FILES[role]),
                source["id"],
                source["sha256"],
                {"t": 0, "c": 0, "z": 0, "level": 0},
            )
            output = wb.execute(
                "labels_import",
                {
                    "source_id": source["id"],
                    "source_sha256": source["sha256"],
                    "grant_id": preview["grant_id"],
                    "alignment": ALIGNMENT,
                    "producer": {
                        "name": "Generated spatial technical QA fixture",
                        "version": "1",
                    },
                },
            )
            result = output["result"]
            inputs[role] = {
                "id": result["id"],
                "revision_hash": result["revision_hash"],
            }
        bindings = {
            role: {"result_id": item["id"], "revision_hash": item["revision_hash"]}
            for role, item in inputs.items()
        }
        expected, _ = oracle(arrays)
        fixture = {
            "schema": "loci.spatial-generated-fixture/v1",
            "purpose": CONTROL,
            "root": str(root),
            "study": str(study),
            "shape_yx": list(SHAPE),
            "spacing_yx_um": SPACING_YX.tolist(),
            "source": {"id": source["id"], "sha256": source["sha256"]},
            "paths": {role: str(root / name) for role, name in FILES.items()},
            "sha256": {role: digest(root / name) for role, name in FILES.items()},
            "inputs": inputs,
            "request": {
                **bindings["objects"],
                "compartment": bindings["compartment"],
                "boundary": bindings["boundary"],
                "band_edges": EDGES,
                "exclude_crop_border": True,
                "control": CONTROL,
                "boundary_coverage": COVERAGE,
                "working_bytes": 512 * 1024**2,
            },
            "expected": expected,
            "fixture_initialization": "Trusted scalar TIFF label preview and adoption for all masks",
        }
        manifest = root / "fixture.json"
        manifest.write_text(json.dumps(fixture, indent=2, allow_nan=False) + "\n")
        manifest.chmod(0o444)
        return fixture
    finally:
        wb.close()


def verify_record(record, arrays, parents, fixture, expected, band_labels):
    p = record["provenance"]
    compare(record["kind"], "spatial-distance-bands", "kind")
    compare(record["source_id"], fixture["source"]["id"], "source_id")
    compare(record["source_sha256"], fixture["source"]["sha256"], "source_sha256")
    compare(record["parent_id"], parents["objects"]["id"], "parent_id")
    compare(
        set(arrays)
        == {
            "image",
            "labels",
            "compartment_labels",
            "boundary_labels",
            "distance_bands",
        },
        True,
        "retained array names",
    )
    generated = generated_arrays()
    for field, role in (
        ("image", "image"),
        ("labels", "objects"),
        ("compartment_labels", "compartment"),
        ("boundary_labels", "boundary"),
    ):
        check(arrays[field].dtype == generated[role].dtype, f"{field}: dtype")
        np.testing.assert_array_equal(arrays[field], generated[role], err_msg=field)
    check(arrays["distance_bands"].dtype == np.uint32, "band-mask dtype")
    np.testing.assert_array_equal(arrays["distance_bands"], band_labels)
    request = p["accepted_request"]
    # GUI working-memory preference may differ; all scientific settings must match.
    compare(
        {k: v for k, v in request.items() if k != "working_bytes"},
        {k: v for k, v in fixture["request"].items() if k != "working_bytes"},
        "accepted_request",
    )
    check(
        type(request["working_bytes"]) is int
        and 8 * 1024**2 <= request["working_bytes"] <= 8 * 1024**3,
        "Explicit sufficient bounded memory allowance",
    )
    compare(
        p["geometry"],
        parents["objects"]["provenance"]["geometry"],
        "geometry inheritance",
    )
    compare(
        p["selection"],
        parents["objects"]["provenance"]["selection"],
        "selection inheritance",
    )
    compare(p["object_analysis"], parents["objects"]["provenance"], "object_analysis")
    compare(
        p["parent_result"],
        {
            "result_id": parents["objects"]["id"],
            "revision_hash": parents["objects"]["revision_hash"],
        },
        "parent_result",
    )
    compare(
        p["scientific_validation"], "unvalidated-research-method", "validation state"
    )
    spatial = p["spatial"]
    compare(spatial["schema"], "loci.spatial-distance-bands/v1", "spatial schema")
    compare(spatial["distance_unit"], "um", "distance_unit")
    compare(spatial["area_unit"], "um^2", "area_unit")
    compare(spatial["rules"], RULES, "rules")
    compare(
        spatial["inputs"],
        {
            role: {
                "result_id": parent["id"],
                "revision_hash": parent["revision_hash"],
                "labels_sha256": parent["arrays"]["labels"]["sha256"],
            }
            for role, parent in parents.items()
        },
        "spatial inputs",
    )
    compare(spatial["bands"], expected["bands"], "bands")
    originals = parents["objects"]["provenance"]["measurements"]
    compare(
        [{k: v for k, v in row.items() if k != "spatial"} for row in p["measurements"]],
        originals,
        "inherited measurements",
    )
    compare(
        [{"label": row["label"], **row["spatial"]} for row in p["measurements"]],
        expected["objects"],
        "independent spatial objects",
    )
    check(
        record["arrays"]["image"] == parents["objects"]["arrays"]["image"],
        "raw parent descriptor",
    )
    for role in ROLES:
        name = "labels" if role == "objects" else role + "_labels"
        compare(
            record["arrays"][name],
            parents[role]["arrays"]["labels"],
            f"{role} descriptor",
        )


def verify_export_tables(exported, record):
    """Check every CSV value and the structured methods blocks independently."""
    expected_rows = []
    for row in record["provenance"]["measurements"]:
        flat = {}
        for field, value in row.items():
            if isinstance(value, dict):
                for name, item in value.items():
                    if isinstance(item, dict):
                        for statistic, number in item.items():
                            flat[f"{field}:{name}:{statistic}"] = number
                    else:
                        flat[f"{field}:{name}"] = item
            elif isinstance(value, list):
                flat.update(
                    {f"{field}:{index}": item for index, item in enumerate(value)}
                )
            else:
                flat[field] = value
        expected_rows.append(flat)
    with (exported / "objects.csv").open(newline="") as stream:
        reader = csv.DictReader(stream)
        rows = list(reader)
        check(
            len(reader.fieldnames or []) == len(set(reader.fieldnames or [])),
            "CSV duplicate columns",
        )
    check(len(rows) == len(expected_rows), "CSV object row count")
    for actual, expected in zip(rows, expected_rows, strict=True):
        compare(sorted(actual), sorted(expected), "CSV columns")
        for field, value in expected.items():
            text = actual[field]
            if value is None:
                compare(text, "", f"CSV {field}")
            elif isinstance(value, bool | str | list | int):
                compare(text, str(value), f"CSV {field}")
            else:
                compare(float(text), value, f"CSV {field}")
    methods = (exported / "methods.md").read_text()
    blocks = [
        json.loads(part.split("```", 1)[0]) for part in methods.split("```json\n")[1:]
    ]
    check(len(blocks) == 3, "Methods selected-data, execution and runtime blocks")
    p = record["provenance"]
    compare(
        blocks[0],
        {"geometry": p["geometry"], "selection": p["selection"]},
        "methods geometry",
    )
    for field, key in (
        ("spatial", "spatial"),
        ("spatial_request", "accepted_request"),
        ("object_analysis", "object_analysis"),
        ("parent_result", "parent_result"),
        ("measurement_basis", "measurement_basis"),
    ):
        compare(blocks[1][field], p[key], f"methods {field}")
    compare(blocks[2], p["runtime"], "methods runtime")
    check(
        f"Result revision: `{record['revision_hash']}`." in methods,
        "methods revision identity",
    )
    check(
        f"Source identity: `{record['source_sha256']}`." in methods,
        "methods source identity",
    )
    check(
        "They do not establish biological accuracy." in methods,
        "methods evidence limitation",
    )
    return len(rows)


def verify(study, result_id, root=None, negative_checks=False, exports=()):
    project_class = engine_imports()
    project = project_class(study)
    root = root or study.parent
    fixture = json.loads((root / "fixture.json").read_text())
    generated = generated_arrays()
    expected, band_labels = oracle(generated)
    compare(fixture["expected"], expected, "saved independent expectations")
    for role, name in FILES.items():
        path = root / name
        check(not path.is_symlink() and path.is_file(), f"{role}: plain generated file")
        compare(digest(path), fixture["sha256"][role], f"{role} input hash")
        np.testing.assert_array_equal(tifffile.imread(path), generated[role])
    source = project.source(fixture["source"]["id"], verify=True)
    compare(source["sha256"], fixture["source"]["sha256"], "source identity")
    compare(source["sha256"], fixture["sha256"]["image"], "source TIFF identity")
    parents = {}
    for role, binding in fixture["inputs"].items():
        parent = project.result(binding["id"])
        compare(parent["revision_hash"], binding["revision_hash"], f"{role} revision")
        compare(parent["source_sha256"], source["sha256"], f"{role} source")
        p = parent["provenance"]
        compare(
            p["geometry"],
            {
                "axes": "YX",
                "unit": "um",
                "frame": "image",
                "affine": np.diag([1.0, 2.0, 1.0, 1.0]).tolist(),
            },
            f"{role} geometry",
        )
        compare(
            p["selection"],
            {
                "x": 0,
                "y": 0,
                "width": 80,
                "height": 64,
                "t": 0,
                "c": 0,
                "z": 0,
                "level": 0,
            },
            f"{role} selection",
        )
        for field, wanted in (
            ("labels", generated[role]),
            ("image", generated["image"]),
        ):
            loaded = project.load_array(parent["arrays"][field])
            check(loaded.dtype == wanted.dtype, f"{role}/{field} dtype")
            np.testing.assert_array_equal(loaded, wanted)
        channel = p["external_labels"]["measurement_channel"]
        compare(channel["index"], 0, "measurement channel")
        compare(
            p["measurements"],
            measurement_oracle(generated[role], generated["image"], channel["name"]),
            f"{role} independently derived parent measurements",
        )
        parents[role] = parent
    record = project.result(result_id)
    arrays = {name: project.load_array(desc) for name, desc in record["arrays"].items()}
    verify_record(record, arrays, parents, fixture, expected, band_labels)
    negatives = []
    if negative_checks:
        for name in (
            "distance",
            "count",
            "density",
            "units",
            "exclusion",
            "parent_measurement",
            "raw",
        ):
            changed, altered = copy.deepcopy(record), dict(arrays)
            p = changed["provenance"]
            if name == "distance":
                p["measurements"][0]["spatial"]["distance"] += 1
            elif name == "count":
                p["spatial"]["bands"][0]["object_count"] += 1
            elif name == "density":
                p["spatial"]["bands"][0]["density"] *= 2
            elif name == "units":
                p["spatial"]["distance_unit"] = "mm"
            elif name == "exclusion":
                next(row for row in p["measurements"] if row["label"] == 123457)[
                    "spatial"
                ]["exclusions"] = []
            elif name == "parent_measurement":
                p["measurements"][0]["measure"] += 1
            else:
                altered["image"] = arrays["image"].copy()
                altered["image"][0, 0] += 1
            try:
                verify_record(changed, altered, parents, fixture, expected, band_labels)
            except AssertionError:
                negatives.append(name)
            else:
                raise AssertionError(f"Independent oracle accepted mutated {name}")
    checked_exports = []
    for exported in exports:
        receipt = json.loads((exported / "result.json").read_text())
        compare(receipt["result"], record, "exported result")
        compare(
            json.loads((exported / "spatial-distance-bands.json").read_text()),
            record["provenance"]["spatial"],
            "exported bands",
        )
        manifest = json.loads((exported / "manifest.json").read_text())
        compare(manifest["result_id"], result_id, "export result id")
        compare(manifest["revision_hash"], record["revision_hash"], "export revision")
        check(
            {entry["name"] for entry in manifest["files"]}
            == {p.name for p in exported.iterdir()} - {"manifest.json"},
            "export inventory",
        )
        for entry in manifest["files"]:
            path = exported / entry["name"]
            check(
                path.parent == exported and not path.is_symlink(),
                "plain contained export",
            )
            compare(digest(path), entry["sha256"], "export file hash")
            compare(path.stat().st_size, entry["size_bytes"], "export file size")
        inventory = {entry["name"]: entry for entry in manifest["files"]}
        compare(
            sorted(receipt["artifact_files"]),
            sorted(arrays),
            "export mapped retained arrays",
        )
        for name, wanted in arrays.items():
            mapping = receipt["artifact_files"][name]
            filename = mapping["file"]
            check(
                Path(filename).name == filename and filename.endswith(".npy"),
                "plain mapped NPY name",
            )
            compare(
                mapping["sha256"],
                record["arrays"][name]["sha256"],
                "export retained array identity",
            )
            compare(
                mapping["size_bytes"],
                record["arrays"][name]["bytes"],
                "export retained array bytes",
            )
            compare(
                inventory[filename],
                {
                    "name": filename,
                    "sha256": mapping["sha256"],
                    "size_bytes": mapping["size_bytes"],
                },
                "mapped artifact manifest",
            )
            got = np.load(exported / filename, allow_pickle=False)
            check(got.dtype == wanted.dtype, f"{name}: mapped export dtype")
            np.testing.assert_array_equal(got, wanted)
        # The supported export profile emits TIFFs for image and labels. Other
        # retained masks are lossless NPY artifacts described by artifact_files.
        tiffs = {name for name in inventory if name.endswith(".ome.tif")}
        compare(
            sorted(tiffs), ["image.ome.tif", "labels.ome.tif"], "TIFF export profile"
        )
        for filename in sorted(tiffs):
            wanted = arrays[filename.removesuffix(".ome.tif")]
            with tifffile.TiffFile(exported / filename) as tif:
                check(
                    len(tif.series) == 1 and tif.series[0].axes == "YX",
                    "export TIFF axes",
                )
                got = tif.asarray()
                check(got.dtype == wanted.dtype, "export TIFF dtype")
                np.testing.assert_array_equal(got, wanted)
                pixels = next(
                    node
                    for node in ET.fromstring(tif.ome_metadata).iter()
                    if node.tag.rsplit("}", 1)[-1] == "Pixels"
                )
                for axis, spacing in (("Y", 2.0), ("X", 1.0)):
                    compare(
                        float(pixels.attrib[f"PhysicalSize{axis}"]),
                        spacing,
                        "export TIFF spacing",
                    )
                    check(
                        pixels.attrib[f"PhysicalSize{axis}Unit"] in {"µm", "μm", "um"},
                        "export TIFF units",
                    )
        csv_count = verify_export_tables(exported, record)
        compare(receipt["source"]["id"], record["source_id"], "export source id")
        compare(
            receipt["source"]["sha256"], record["source_sha256"], "export source hash"
        )
        compare(receipt["review"]["result_id"], result_id, "export review binding")
        compare(
            receipt["review"]["revision_hash"],
            record["revision_hash"],
            "export review revision",
        )
        compare(receipt["review"]["disposition"], "reviewed", "export review gate")
        check(
            str(root) not in json.dumps(receipt)
            and str(study) not in json.dumps(receipt),
            "export provenance must not contain private input paths",
        )
        checked_exports.append(
            {
                "path": str(exported),
                "manifest_sha256": digest(exported / "manifest.json"),
                "retained_arrays": sorted(receipt["artifact_files"]),
                "tiffs": sorted(tiffs),
                "csv_rows": csv_count,
                "methods_provenance": "exact geometry, inputs, settings, parent analysis and runtime",
            }
        )
    return {
        "status": "passed",
        "study": str(study),
        "result_id": result_id,
        "revision_hash": record["revision_hash"],
        "fixture_sha256": fixture["sha256"],
        "expected": expected,
        "negative_oracle_checks": negatives,
        "exports": checked_exports,
        "oracle": "Brute-force Euclidean distance to every declared boundary pixel center; no spatial kernel or EDT",
        "scope": CONTROL,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("create", "verify"))
    parser.add_argument("--root", type=Path)
    parser.add_argument("--study", type=Path)
    parser.add_argument("--result")
    parser.add_argument("--negative-checks", action="store_true")
    parser.add_argument("--export", type=Path, action="append", default=[])
    args = parser.parse_args()
    if args.mode == "create":
        if args.root is None:
            parser.error("create requires --root pointing to an absent directory")
        output = create(args.root.expanduser().resolve())
    else:
        if args.study is None or args.result is None:
            parser.error(
                "verify requires --study and --result; --root defaults to the study parent"
            )
        output = verify(
            args.study.expanduser().resolve(),
            args.result,
            args.root.expanduser().resolve() if args.root else None,
            args.negative_checks,
            [p.expanduser().resolve() for p in args.export],
        )
    print(json.dumps(output, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
