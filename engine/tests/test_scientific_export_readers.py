"""Execute delivered readers against independently authored package bytes."""

import csv
import hashlib
import json
import shutil
import subprocess
import sys

import pytest

from loci_engine.scientific_export_readers import PYTHON_READER, R_READER

RESULT = "0" * 31 + "1"
REVISION = "a" * 64
SOURCE = "0" * 31 + "2"
SOURCE_HASH = "b" * 64
NULL = r"\N"


def package(tmp_path):
    """Hand-authored schema/rows: no production table writer or codec imported."""
    root = tmp_path / "package"
    root.mkdir()
    key = ["result_id", "revision_hash"]
    object_key = [*key, "label"]
    definitions = {}
    rows = {}

    def table(name, columns, data, primary, foreign=(), integers=(), numbers=()):
        definitions[name] = {
            "format": "csv",
            "fields": [
                {
                    "name": field,
                    "type": "integer"
                    if field in integers
                    else "number"
                    if field in numbers
                    else "string",
                }
                for field in columns
            ],
            "primaryKey": primary,
            "foreignKeys": list(foreign),
            "row_count": len(data),
            "encoding": {
                "null": NULL,
                "text": "Prefix one apostrophe; double an initial backslash. Decode null first.",
            },
        }
        rows[name] = [dict(zip(columns, row, strict=True)) for row in data]

    def fk(fields, resource, target):
        return {"fields": fields, "reference": {"resource": resource, "fields": target}}

    table(
        "results.csv",
        [
            *key,
            "source_id",
            "source_sha256",
            "total_count",
            "selected_count",
            "measurement_count",
            "review_disposition",
        ],
        [[RESULT, REVISION, SOURCE, SOURCE_HASH, "2", "2", "8", "reviewed"]],
        key,
        integers=["total_count", "selected_count", "measurement_count"],
    )
    table(
        "objects.csv",
        [*object_key, "measure", "measure_unit"],
        [[RESULT, REVISION, "1", "-0.0", "µm²"], [RESULT, REVISION, "4294967295", "1e-200", "µm²"]],
        object_key,
        [fk(key, "results.csv", key)],
        numbers=["measure"],
    )
    values = [
        ("0", "integer"),
        ("-0.0", "float"),
        ("-2.5", "float"),
        ("5e-324", "float"),
        ("9007199254740993", "integer"),
        ("1e+308", "float"),
        (NULL, NULL),
        (NULL, NULL),
    ]
    table(
        "measurements.csv",
        [*object_key, "metric_id", "value", "status", "raw_numeric_type"],
        [
            [
                RESULT,
                REVISION,
                "1" if i % 2 == 0 else "4294967295",
                f"metric-{i}",
                value,
                "null" if i == 6 else "missing" if i == 7 else "value",
                kind,
            ]
            for i, (value, kind) in enumerate(values)
        ],
        [*object_key, "metric_id"],
        [fk(object_key, "objects.csv", object_key)],
        numbers=["value"],
    )
    table(
        "samples.csv",
        ["source_id", "study", "sample", "condition", "biological_replicate", "plate", "well"],
        [[SOURCE, "'=study", "''quoted", "", r"\\N", NULL, r"\\start"]],
        ["source_id"],
    )
    table(
        "groups.csv",
        [
            "group_id",
            *key,
            "source_id",
            "source_sha256",
            "name",
            "total_count",
            "included_count",
            "exported_count",
        ],
        [
            [
                "group-1",
                RESULT,
                REVISION,
                SOURCE,
                SOURCE_HASH,
                '\'\t=SUM("α,β")\nline',
                "2",
                "2",
                "2",
            ],
            ["group-2", RESULT, REVISION, SOURCE, SOURCE_HASH, "Overlap", "2", "1", "1"],
        ],
        ["group_id"],
        [fk(key, "results.csv", key)],
        integers=["total_count", "included_count", "exported_count"],
    )
    table(
        "memberships.csv",
        ["group_id", *object_key],
        [
            ["group-1", RESULT, REVISION, "1"],
            ["group-1", RESULT, REVISION, "4294967295"],
            ["group-2", RESULT, REVISION, "4294967295"],
        ],
        ["group_id", *object_key],
        [fk(["group_id"], "groups.csv", ["group_id"]), fk(object_key, "objects.csv", object_key)],
    )
    definitions["object-records.jsonl"] = {
        "format": "jsonl",
        "row_count": 2,
        "primaryKey": [*key, "object.label"],
        "foreignKeys": [],
    }
    raw = [
        f'{{"result_id":"{RESULT}","revision_hash":"{REVISION}","object":{{"label":1,"value":9007199254740993}}}}',
        f'{{"result_id":"{RESULT}","revision_hash":"{REVISION}","object":{{"label":4294967295,"value":5e-324}}}}',
    ]
    (root / "object-records.jsonl").write_text("\n".join(raw) + "\n", encoding="utf-8")
    (root / "read_data.py").write_text(PYTHON_READER, encoding="utf-8")
    (root / "read_data.R").write_text(R_READER, encoding="utf-8")
    (root / "readme.md").write_text("Independent synthetic reader fixture.\n", encoding="utf-8")
    schema = {
        "schema": "loci.scientific-data-package/v1",
        "encoding": "UTF-8",
        "purpose": "reviewed",
        "tables": definitions,
    }
    (root / "schema.json").write_text(json.dumps(schema, ensure_ascii=False), encoding="utf-8")
    write_rows(root, rows)
    rehash(root)
    return root, rows


def write_rows(root, rows):
    for name, records in rows.items():
        with (root / name).open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(records[0]))
            writer.writeheader()
            writer.writerows(records)


def rehash(root):
    manifest = {
        "schema": "loci.data-export-manifest/v1",
        "package_schema": "loci.scientific-data-package/v1",
        "purpose": "reviewed",
        "counts": {
            "result_count": 1,
            "source_count": 1,
            "total_count": 2,
            "selected_count": 2,
            "measurement_count": 8,
            "group_count": 2,
            "membership_count": 3,
            "declared_replicate_count": 1,
            "unassigned_source_count": 0,
        },
        "files": [
            {
                "name": path.name,
                "size_bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for path in sorted(root.iterdir())
            if path.name != "manifest.json"
        ],
    }
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def python_run(root, checks=""):
    return subprocess.run(
        [
            sys.executable,
            "-B",
            "-c",
            "import runpy,sys; reader=runpy.run_path(sys.argv[1]); "
            "data=reader['read_package'](sys.argv[2]); " + checks,
            str(root / "read_data.py"),
            str(root),
        ],
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )


@pytest.fixture(scope="module")
def rscript():
    executable = shutil.which("Rscript")
    if not executable:
        pytest.skip("Rscript not installed; Python reader coverage remains active")
    probe = subprocess.run(
        [
            executable,
            "--vanilla",
            "-e",
            "quit(status=if(requireNamespace('jsonlite',quietly=TRUE)) 0 else 1)",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if probe.returncode:
        pytest.skip("R jsonlite not installed; no dependency installation attempted")
    return executable


def r_run(executable, root, checks=""):
    return subprocess.run(
        [
            executable,
            "--vanilla",
            "-",
            str(root / "read_data.R"),
            str(root),
        ],
        text=True,
        encoding="utf-8",
        input="args<-commandArgs(trailingOnly=TRUE); source(args[1]); "
        "data<-read_loci_data(args[2]); " + checks,
        capture_output=True,
        check=False,
    )


def test_python_reader_preserves_text_null_numeric_lexemes_and_overlap(tmp_path):
    root, _ = package(tmp_path)
    checks = r"""
from decimal import Decimal

t = data["tables"]
sample = t["samples.csv"][0]
metrics = t["measurements.csv"]
numeric = reader["numeric_value"]
double = reader["double_value"]
assert sample["study"] == "=study" and sample["sample"] == "'quoted" and sample["condition"] == ""
assert (
    sample["biological_replicate"] == r"\N"
    and sample["plate"] is None
    and sample["well"] == r"\start"
)
assert t["groups.csv"][0]["name"] == '\t=SUM("α,β")\nline'
assert len(t["objects.csv"]) == 2 and len(t["memberships.csv"]) == 3
assert (
    t["objects.csv"][1]["label"] == "4294967295"
    and numeric(t["objects.csv"][1], "label") == 4294967295
)
assert [row["value"] for row in metrics] == [
    "0",
    "-0.0",
    "-2.5",
    "5e-324",
    "9007199254740993",
    "1e+308",
    None,
    None,
]
assert numeric(metrics[0], "value") == 0 and numeric(metrics[1], "value").is_signed()
assert (
    numeric(metrics[3], "value") == Decimal("5e-324")
    and numeric(metrics[4], "value") == 9007199254740993
)
assert numeric(metrics[6], "value") is None and metrics[7]["status"] == "missing"
assert double(metrics[3], "value") == 5e-324 and double(metrics[5], "value") == 1e308
assert t["object-records.jsonl"][0]["object"]["value"] == "9007199254740993"
try:
    double(metrics[4], "value")
except ValueError:
    pass
else:
    raise AssertionError("unsafe integer conversion accepted")
print("Python exact-reader checks passed")
"""
    completed = python_run(root, checks)
    assert completed.returncode == 0, completed.stderr
    assert "Python exact-reader checks passed" in completed.stdout
    cli = subprocess.run(
        [sys.executable, "-B", str(root / "read_data.py"), str(root)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert cli.returncode == 0, cli.stderr
    assert "memberships.csv: 3 rows" in cli.stdout


@pytest.mark.parametrize(
    "fault,expected",
    [
        ("checksum", "checksum mismatch"),
        ("size", "size mismatch"),
        ("files", "unexpected package files"),
        ("hash", "checksum metadata"),
        ("pk", "Duplicate primary key"),
        ("fk", "Foreign key mismatch"),
        ("counts", "Manifest count mismatch"),
        ("status", "value/status mismatch"),
        ("raw", "Raw object keys mismatch"),
        ("group", "Group source binding mismatch"),
    ],
)
def test_python_reader_rejects_inconsistent_packages(tmp_path, fault, expected):
    root, rows = package(tmp_path)
    if fault == "checksum":
        path = root / "readme.md"
        path.write_bytes(path.read_bytes().replace(b"fixture", b"corrupt"))
    elif fault == "size":
        with (root / "readme.md").open("a") as stream:
            stream.write("changed")
    elif fault == "files":
        (root / "unexpected.txt").write_text("extra")
    elif fault in ("hash", "counts"):
        manifest = json.loads((root / "manifest.json").read_text())
        if fault == "hash":
            manifest["files"][0]["sha256"] = "x" * 64
        else:
            manifest["counts"]["selected_count"] = 3
        (root / "manifest.json").write_text(json.dumps(manifest))
    else:
        if fault == "pk":
            rows["objects.csv"][1]["label"] = "1"
        elif fault == "fk":
            rows["memberships.csv"][0]["label"] = "4294967294"
        elif fault == "status":
            rows["measurements.csv"][6]["value"] = "0"
        elif fault == "group":
            rows["groups.csv"][0]["source_sha256"] = "f" * 64
        elif fault == "raw":
            path = root / "object-records.jsonl"
            path.write_text(path.read_text().replace('"label":4294967295', '"label":4294967294'))
        write_rows(root, rows)
        rehash(root)
    completed = python_run(root)
    assert completed.returncode != 0
    assert expected in completed.stderr, completed.stderr


def test_r_reader_preserves_text_null_numeric_lexemes_and_overlap(tmp_path, rscript):
    root, _ = package(tmp_path)
    checks = r"""
t <- data$tables

sample <- t[["samples.csv"]]

metrics <- t[["measurements.csv"]]

stopifnot(sample$study == "=study", sample$sample == "'quoted", identical(sample$condition,
    ""))

stopifnot(sample$biological_replicate == "\\N", is.na(sample$plate), sample$well ==
    "\\start")

# Unicode escapes keep the expected R literal unambiguous in a C-locale parser.
# The hand-authored package still contains literal UTF-8 Greek and unit symbols.
stopifnot(t[["groups.csv"]]$name[1] == "\t=SUM(\"\u03b1,\u03b2\")\nline")
stopifnot(identical(t[["objects.csv"]]$measure_unit, rep("\u00b5m\u00b2", 2)))

stopifnot(nrow(t[["objects.csv"]]) == 2, nrow(t[["memberships.csv"]]) == 3)

stopifnot(t[["objects.csv"]]$label[2] == "4294967295", numeric_value(t[["objects.csv"]][2,
    , drop = FALSE], "label") == 4294967295)

stopifnot(identical(metrics$value, c("0", "-0.0", "-2.5", "5e-324", "9007199254740993",
    "1e+308", NA_character_, NA_character_)))

stopifnot(numeric_value(metrics[1, , drop = FALSE], "value") == 0, 1/numeric_value(metrics[2,
    , drop = FALSE], "value") == -Inf)

stopifnot(numeric_value(metrics[4, , drop = FALSE], "value") == as.numeric("5e-324"))
stopifnot(inherits(try(numeric_value(metrics[6, , drop = FALSE], "value"),
    silent = TRUE), "try-error"))

stopifnot(is.na(numeric_value(metrics[7, , drop = FALSE], "value")), metrics$status[8] ==
    "missing")

stopifnot(inherits(try(numeric_value(metrics[5, , drop = FALSE], "value"), silent = TRUE),
    "try-error"))

stopifnot(grepl("9007199254740993", t[["object-records.jsonl"]]$raw_json[1], fixed = TRUE))

stopifnot(data$hashes_verified)

cat("R exact-reader checks passed\n")

"""
    completed = r_run(rscript, root, checks)
    assert completed.returncode == 0, completed.stderr
    assert "R exact-reader checks passed" in completed.stdout
    cli = subprocess.run(
        [rscript, "--vanilla", str(root / "read_data.R"), str(root)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert cli.returncode == 0, cli.stderr
    assert "memberships.csv: 3 rows" in cli.stdout


@pytest.mark.parametrize(
    "fault,expected",
    [
        ("fk", "Foreign key mismatch"),
        ("hash", "checksum mismatch"),
        ("count", "Manifest count mismatch"),
    ],
)
def test_r_reader_rejects_inconsistent_packages(tmp_path, rscript, fault, expected):
    root, rows = package(tmp_path)
    if fault == "fk":
        rows["memberships.csv"][0]["label"] = "4294967294"
        write_rows(root, rows)
        rehash(root)
    elif fault == "hash":
        path = root / "readme.md"
        path.write_bytes(path.read_bytes().replace(b"fixture", b"corrupt"))
    else:
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["counts"]["membership_count"] = 2
        (root / "manifest.json").write_text(json.dumps(manifest))
    completed = r_run(rscript, root)
    assert completed.returncode != 0
    assert expected in completed.stderr, completed.stderr


@pytest.mark.parametrize(
    "field,value",
    [
        ("sha256", "missing"),
        ("sha256", None),
        ("sha256", 123),
        ("sha256", "f" * 63),
        ("sha256", "G" * 64),
        ("size_bytes", "missing"),
        ("size_bytes", None),
        ("size_bytes", True),
        ("size_bytes", -1),
        ("size_bytes", 1.5),
        ("size_bytes", "12"),
        ("sha256", []),
        ("size_bytes", []),
    ],
)
@pytest.mark.parametrize("runtime", ["python", "r", "r-no-hash"])
def test_readers_require_integrity_metadata_for_every_listed_file(
    tmp_path, request, runtime, field, value
):
    root, rows = package(tmp_path)
    # The reviewed counterexample: changed science plus removed checksum.
    rows["objects.csv"][0]["measure"] = "99.0"
    write_rows(root, rows)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    record = next(item for item in manifest["files"] if item["name"] == "objects.csv")
    if value == "missing":
        record.pop(field)
    else:
        record[field] = value
    manifest_path.write_text(json.dumps(manifest))
    if runtime == "python":
        completed = python_run(root)
    else:
        rscript = request.getfixturevalue("rscript")
        completed = (
            r_run(rscript, root)
            if runtime == "r"
            else subprocess.run(
                [
                    rscript,
                    "--vanilla",
                    "-e",
                    "args<-commandArgs(TRUE); source(args[1]); "
                    "read_loci_data(args[2], verify_hashes=FALSE)",
                    str(root / "read_data.R"),
                    str(root),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
        )
    assert completed.returncode != 0
    assert "Invalid manifest checksum metadata" in completed.stderr, completed.stderr
