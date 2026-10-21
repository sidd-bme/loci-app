"""Trusted standalone reader sources, copied verbatim into scientific packages.

Loci never evaluates these scripts. Users explicitly run them in their own Python
or R session. Keep templates independent of Loci and third-party Python packages.
"""

PYTHON_READER = r'''"""Read a Loci scientific data package without discarding numeric precision.

Run: python -B read_data.py /path/to/package
Import without creating package cache files: runpy.run_path("read_data.py").
"""

import csv
import hashlib
import json
import math
import re
import sys
from collections import Counter
from decimal import Decimal
from pathlib import Path

PACKAGE_SCHEMA = "loci.scientific-data-package/v1"
TABLES = {
    "results.csv",
    "objects.csv",
    "measurements.csv",
    "samples.csv",
    "groups.csv",
    "memberships.csv",
    "object-records.jsonl",
}
INTEGER = re.compile(r"-?(?:0|[1-9][0-9]*)\Z")
NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\Z")


class NumberText(str):
    """An original JSON numeric lexeme; deliberately not an approximate float."""


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _key(row, fields):
    values = []
    for field in fields:
        value = row
        for part in field.split("."):
            value = value[part]
        _require(value is not None and value != "", "Null or empty key: " + field)
        values.append(value)
    return tuple(values)


def numeric_value(row, column, kind=None):
    """Opt in to an exact int or Decimal. The original cell stays unchanged."""
    value = row[column]
    if value is None:
        return None
    kind = kind or (row.get("raw_numeric_type") if column == "value" else None)
    _require(isinstance(value, str) and NUMBER.fullmatch(value), "Not a finite numeric lexeme")
    if kind == "integer" or kind is None and INTEGER.fullmatch(value):
        _require(INTEGER.fullmatch(value), "Integer has a fractional or exponent encoding")
        return int(value)
    _require(kind in (None, "float", "number"), "Unknown numeric type")
    return Decimal(value)


def double_value(row, column, kind=None):
    """Explicit binary64 conversion; reject integer loss, overflow and underflow."""
    exact = numeric_value(row, column, kind)
    if exact is None:
        return None
    if isinstance(exact, int):
        _require(abs(exact) <= 2**53, "Integer exceeds safe binary64 range; use numeric_value")
    else:
        _require(
            len(exact.as_tuple().digits) <= 17, "More than 17 significant digits; use numeric_value"
        )
    value = float(exact)
    _require(math.isfinite(value) and (value != 0 or exact == 0), "Binary64 overflow or underflow")
    _require(float(repr(value)) == value, "Binary64 round trip failed")
    return value


def _decode(value, field):
    if value == r"\N":
        return None
    kind = field["type"]
    if kind == "string":
        if value.startswith("'"):
            return value[1:]
        if value.startswith("\\"):
            _require(value.startswith("\\\\"), "Invalid escaped text")
            return value[1:]
    elif kind in ("integer", "number"):
        _require(
            (INTEGER if kind == "integer" else NUMBER).fullmatch(value), "Invalid numeric cell"
        )
    elif kind == "boolean":
        _require(value in ("true", "false"), "Invalid boolean cell")
    else:
        raise ValueError("Unsupported CSV field type: " + kind)
    return value


def _integer(value):
    _require(isinstance(value, str) and INTEGER.fullmatch(value), "Invalid count")
    number = int(value)
    _require(number >= 0, "Negative count")
    return number


def _relations(tables, manifest):
    results, objects = tables["results.csv"], tables["objects.csv"]
    measurements, groups = tables["measurements.csv"], tables["groups.csv"]
    memberships, raw = tables["memberships.csv"], tables["object-records.jsonl"]
    result_key = ["result_id", "revision_hash"]
    object_key = [*result_key, "label"]
    index = {_key(row, result_key): row for row in results}
    object_counts = Counter(_key(row, result_key) for row in objects)
    metric_counts = Counter(_key(row, result_key) for row in measurements)
    for row in results:
        key = _key(row, result_key)
        _require(
            _integer(row["selected_count"]) == object_counts[key],
            "Per-result object count mismatch",
        )
        _require(
            _integer(row["measurement_count"]) == metric_counts[key],
            "Per-result metric count mismatch",
        )
        _require(_integer(row["total_count"]) >= object_counts[key], "Selected count exceeds total")
        if manifest["purpose"] == "reviewed":
            _require(
                row["review_disposition"] == "reviewed", "Unreviewed result in reviewed package"
            )
    for row in objects:
        _require(
            row["label"].isdigit()
            and 0 < int(row["label"]) <= 2**32 - 1
            and str(int(row["label"])) == row["label"],
            "Invalid uint32 label",
        )
    for row in measurements:
        status, value, kind = row["status"], row["value"], row["raw_numeric_type"]
        _require(status in ("value", "null", "missing"), "Invalid measurement status")
        _require((status == "value") == (value is not None), "Measurement value/status mismatch")
        _require(
            kind in ("integer", "float") if status == "value" else kind is None,
            "Measurement numeric type/status mismatch",
        )
        if status == "value":
            numeric_value(row, "value")
    group_index = {row["group_id"]: row for row in groups}
    membership_counts = Counter(row["group_id"] for row in memberships)
    for row in groups:
        parent = index[_key(row, result_key)]
        _require(
            all(row[field] == parent[field] for field in ("source_id", "source_sha256")),
            "Group source binding mismatch",
        )
        _require(
            _integer(row["exported_count"]) == membership_counts[row["group_id"]],
            "Group membership count mismatch",
        )
        _require(
            _integer(row["included_count"]) >= membership_counts[row["group_id"]],
            "Group exported count exceeds included count",
        )
        _require(
            _integer(row["total_count"]) == _integer(parent["total_count"]),
            "Group total count mismatch",
        )
    for row in memberships:
        _require(
            _key(row, result_key) == _key(group_index[row["group_id"]], result_key),
            "Membership group revision mismatch",
        )
    _require(
        {_key(row, object_key) for row in objects}
        == {_key({**row, "label": row["object"]["label"]}, object_key) for row in raw},
        "Raw object keys mismatch",
    )
    sources = {row["source_id"] for row in results}
    _require(
        all(row["source_id"] in sources for row in tables["samples.csv"]),
        "Sample source absent from results",
    )
    samples = {row["source_id"]: row for row in tables["samples.csv"]}
    assigned = [row for row in samples.values() if row["biological_replicate"]]
    expected = {
        "result_count": len(results),
        "source_count": len(sources),
        "total_count": sum(_integer(row["total_count"]) for row in results),
        "selected_count": len(objects),
        "measurement_count": len(measurements),
        "group_count": len(groups),
        "membership_count": len(memberships),
        "declared_replicate_count": len(
            {(row["study"], row["condition"], row["biological_replicate"]) for row in assigned}
        ),
        "unassigned_source_count": len(sources - {row["source_id"] for row in assigned}),
    }
    _require(manifest["counts"] == expected, "Manifest count mismatch")


def read_package(directory):
    """Verify the complete file set, SHA-256, sizes, schema, keys and counts.

    Return exact decoded CSV cells as str/None; raw JSON numbers as NumberText.
    This validates internal consistency, not authenticity or biological accuracy.
    Read an unchanged package; put analysis outputs outside its directory.
    """
    root = Path(directory)
    _require(root.is_dir() and not root.is_symlink(), "Package must be a real directory")

    def load_json(name):
        with (root / name).open(encoding="utf-8") as stream:
            return json.load(stream)

    manifest = load_json("manifest.json")
    _require(
        manifest["schema"] == "loci.data-export-manifest/v1"
        and manifest["package_schema"] == PACKAGE_SCHEMA,
        "Unsupported manifest",
    )
    records = manifest["files"]
    names = [item["name"] for item in records]
    _require(
        len(set(names)) == len(names) and "manifest.json" not in names, "Invalid manifest file set"
    )
    _require(
        all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name) for name in names),
        "Unsafe manifest filename",
    )
    _require(
        {path.name for path in root.iterdir()} == {*names, "manifest.json"},
        "Missing or unexpected package files",
    )
    for item in [*records, {"name": "manifest.json"}]:
        path = root / item["name"]
        _require(path.is_file() and not path.is_symlink(), "Unsafe package file")
        if item["name"] != "manifest.json":
            _require(
                type(item.get("sha256")) is str
                and type(item.get("size_bytes")) is int
                and item["size_bytes"] >= 0
                and re.fullmatch(r"[a-f0-9]{64}", item["sha256"]),
                "Invalid manifest checksum metadata",
            )
            _require(path.stat().st_size == item["size_bytes"], "File size mismatch: " + path.name)
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024**2), b""):
                    digest.update(chunk)
            _require(digest.hexdigest() == item["sha256"], "File checksum mismatch: " + path.name)
    schema = load_json("schema.json")
    _require(
        schema["schema"] == PACKAGE_SCHEMA
        and schema["encoding"] == "UTF-8"
        and schema["purpose"] == manifest["purpose"]
        and manifest["purpose"] in ("reviewed", "provisional"),
        "Unsupported schema or purpose",
    )
    _require(set(schema["tables"]) == TABLES and TABLES <= set(names), "Unsupported table set")
    tables = {}
    csv.field_size_limit(sys.maxsize)
    for name, definition in schema["tables"].items():
        _require(
            type(definition["row_count"]) is int and definition["row_count"] >= 0,
            "Invalid row count",
        )
        with (root / name).open(encoding="utf-8", newline="") as stream:
            if definition["format"] == "csv":
                _require(
                    definition["encoding"]["null"] == r"\N"
                    and "double an initial backslash" in definition["encoding"]["text"],
                    "Unsupported CSV text codec",
                )
                fields = definition["fields"]
                columns = [field["name"] for field in fields]
                reader = csv.reader(stream, strict=True)
                _require(
                    len(set(columns)) == len(columns) and next(reader) == columns,
                    "CSV header mismatch",
                )
                rows = []
                for cells in reader:
                    _require(len(cells) == len(fields), "CSV row width mismatch")
                    rows.append(
                        {
                            field["name"]: _decode(value, field)
                            for value, field in zip(cells, fields)
                        }
                    )
            else:
                _require(
                    name == "object-records.jsonl" and definition["format"] == "jsonl",
                    "Unsupported table format",
                )
                rows = [
                    json.loads(
                        line,
                        parse_int=NumberText,
                        parse_float=NumberText,
                        parse_constant=lambda _: (_ for _ in ()).throw(
                            ValueError("Non-finite JSON number")
                        ),
                    )
                    for line in stream
                ]
        _require(len(rows) == definition["row_count"], "Table row count mismatch: " + name)
        keys = [_key(row, definition["primaryKey"]) for row in rows]
        _require(len(set(keys)) == len(keys), "Duplicate primary key: " + name)
        tables[name] = rows
    for name, definition in schema["tables"].items():
        for foreign in definition["foreignKeys"]:
            reference = foreign["reference"]
            target = {_key(row, reference["fields"]) for row in tables[reference["resource"]]}
            _require(
                all(_key(row, foreign["fields"]) in target for row in tables[name]),
                "Foreign key mismatch: " + name,
            )
    _relations(tables, manifest)
    return {"schema": schema, "manifest": manifest, "tables": tables}


if __name__ == "__main__":
    data = read_package(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent)
    for name, rows in data["tables"].items():
        print(name + ": " + str(len(rows)) + " rows")
'''

R_READER = r"""# Standalone Loci reader; source explicitly. Requires preinstalled jsonlite.
.loci_require <- function(ok, message) {
    if (length(ok) != 1L || is.na(ok) || !ok)
        stop(message, call. = FALSE)
}

.loci_integer <- "^-?(0|[1-9][0-9]*)$"

.loci_number <- "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$"

numeric_value <- function(row, column, kind = NULL) {
    value <- row[[column]]
    .loci_require(length(value) == 1L, "Pass one row to numeric_value")
    if (is.na(value))
        return(NA_real_)
    .loci_require(is.character(value) && grepl(.loci_number, value), "Invalid numeric lexeme")
    if (is.null(kind) && column == "value" && "raw_numeric_type" %in% names(row))
        kind <- row[["raw_numeric_type"]]
    is_integer <- identical(kind, "integer") || (is.null(kind) && grepl(.loci_integer,
        value))
    if (is_integer) {
        .loci_require(grepl(.loci_integer, value), "Invalid integer encoding")
        magnitude <- sub("^-", "", value)
        .loci_require(nchar(magnitude) < 16L || (nchar(magnitude) == 16L && magnitude <=
            "9007199254740992"), "Unsafe binary64 integer; keep character value")
    }
    else {
        .loci_require(is.null(kind) || kind %in% c("float", "number"), "Unknown numeric type")
        digits <- sub("[eE].*$", "", sub("^-", "", value))
        digits <- gsub("\\.", "", digits)
        digits <- sub("^0+", "", digits)
        digits <- sub("0+$", "", digits)
        .loci_require(nchar(digits) <= 17L, "Over 17 significant digits; keep character value")
    }
    number <- suppressWarnings(as.numeric(value))
    nonzero <- grepl("[1-9]", sub("[eE].*$", "", value))
    .loci_require(is.finite(number) && !(number == 0 && nonzero), "Binary64 overflow or underflow")
    .loci_require(identical(as.numeric(sprintf("%.17g", number)), number),
        "Binary64 round trip failed")
    number
}

.loci_key <- function(table, fields) {
    columns <- lapply(fields, function(field) {
        .loci_require(field %in% names(table), paste("Missing key field", field))
        values <- table[[field]]
        .loci_require(!anyNA(values) && all(nzchar(values)), paste("Null or empty key",
            field))
        paste0(nchar(values, type = "bytes"), ":", values)
    })
    if (!nrow(table))
        return(character())
    do.call(paste0, columns)
}

.loci_decode <- function(values, field) {
    null <- values == "\\N"
    values[null] <- NA_character_
    present <- !null
    if (field$type == "string") {
        apostrophe <- present & startsWith(values, "'")
        slash <- present & startsWith(values, "\\")
        .loci_require(all(startsWith(values[slash], "\\\\")), "Invalid escaped text")
        values[apostrophe | slash] <- substring(values[apostrophe | slash], 2L)
    }
    else if (field$type %in% c("integer", "number")) {
        .loci_require(all(grepl(if (field$type == "integer") .loci_integer else .loci_number,
            values[present])), "Invalid numeric cell")
    }
    else if (field$type == "boolean") {
        .loci_require(all(values[present] %in% c("true", "false")), "Invalid boolean cell")
    }
    else stop("Unsupported CSV field type", call. = FALSE)
    values
}

.loci_count <- function(value) {
    .loci_require(is.character(value) && length(value) == 1L && !is.na(value) &&
        grepl("^(0|[1-9][0-9]*)$", value), "Invalid count")
    numeric_value(list(n = value), "n", "integer")
}

.loci_relations <- function(tables, manifest) {
    results <- tables[["results.csv"]]
    objects <- tables[["objects.csv"]]
    metrics <- tables[["measurements.csv"]]
    groups <- tables[["groups.csv"]]
    members <- tables[["memberships.csv"]]
    raw <- tables[["object-records.jsonl"]]
    fields <- c("result_id", "revision_hash")
    result_keys <- .loci_key(results, fields)
    object_result_keys <- .loci_key(objects, fields)
    metric_result_keys <- .loci_key(metrics, fields)
    for (i in seq_len(nrow(results))) {
        row <- results[i, , drop = FALSE]
        key <- result_keys[i]
        .loci_require(.loci_count(row$selected_count) == sum(object_result_keys ==
            key), "Per-result object count mismatch")
        .loci_require(.loci_count(row$measurement_count) == sum(metric_result_keys ==
            key), "Per-result metric count mismatch")
        .loci_require(.loci_count(row$total_count) >= sum(object_result_keys == key),
            "Selected count exceeds total")
        if (manifest$purpose == "reviewed")
            .loci_require(row$review_disposition == "reviewed",
                "Unreviewed result in reviewed package")
    }
    .loci_require(all(grepl("^[1-9][0-9]*$", objects$label)) && all(as.numeric(objects$label) <=
        4294967295), "Invalid uint32 label")
    for (i in seq_len(nrow(metrics))) {
        row <- metrics[i, , drop = FALSE]
        .loci_require(row$status %in% c("value", "null", "missing"), "Invalid measurement status")
        .loci_require((row$status == "value") == !is.na(row$value),
            "Measurement value/status mismatch")
        .loci_require(if (row$status == "value")
            !is.na(row$raw_numeric_type) && row$raw_numeric_type %in% c("integer",
                "float")
        else is.na(row$raw_numeric_type), "Measurement numeric type/status mismatch")
        if (row$status == "value" && row$raw_numeric_type == "integer")
            .loci_require(grepl(.loci_integer, row$value), "Invalid integer metric")
    }
    for (i in seq_len(nrow(groups))) {
        row <- groups[i, , drop = FALSE]
        parent <- results[match(.loci_key(row, fields), result_keys), , drop = FALSE]
        .loci_require(all(row[c("source_id", "source_sha256")] == parent[c("source_id",
            "source_sha256")]), "Group source binding mismatch")
        n <- sum(members$group_id == row$group_id)
        .loci_require(.loci_count(row$exported_count) == n && .loci_count(row$included_count) >=
            n, "Group membership count mismatch")
        .loci_require(.loci_count(row$total_count) == .loci_count(parent$total_count),
            "Group total count mismatch")
    }
    if (nrow(members)) {
        parent <- groups[match(members$group_id, groups$group_id), , drop = FALSE]
        .loci_require(identical(.loci_key(members, fields), .loci_key(parent, fields)),
            "Membership group revision mismatch")
    }
    .loci_require(setequal(.loci_key(objects, c(fields, "label")), .loci_key(raw,
        c(fields, "object.label"))), "Raw object keys mismatch")
    sources <- unique(results$source_id)
    .loci_require(all(tables[["samples.csv"]]$source_id %in% sources),
        "Sample source absent from results")
    samples <- tables[["samples.csv"]]
    assigned <- samples[!is.na(samples$biological_replicate) & nzchar(samples$biological_replicate),
        , drop = FALSE]
    counts <- list(result_count = nrow(results), source_count = length(sources),
        total_count = sum(vapply(results$total_count, .loci_count, numeric(1))),
        selected_count = nrow(objects), measurement_count = nrow(metrics),
            group_count = nrow(groups),
        membership_count = nrow(members), declared_replicate_count = nrow(unique(assigned[c("study",
            "condition", "biological_replicate")])),
                unassigned_source_count = length(setdiff(sources,
            assigned$source_id)))
    .loci_require(setequal(names(counts), names(manifest$counts)) && all(vapply(names(counts),
        function(name) identical(as.numeric(counts[[name]]), as.numeric(manifest$counts[[name]])),
        logical(1))), "Manifest count mismatch")
}

read_loci_data <- function(directory, verify_hashes = TRUE) {
    .loci_require(requireNamespace("jsonlite", quietly = TRUE),
        "Install jsonlite separately before using this reader")
    root <- normalizePath(directory, mustWork = TRUE)
    read_json <- function(name) jsonlite::fromJSON(file.path(root, name), simplifyVector = FALSE)
    manifest <- read_json("manifest.json")
    .loci_require(manifest$schema == "loci.data-export-manifest/v1" && manifest$package_schema ==
        "loci.scientific-data-package/v1", "Unsupported manifest")
    names <- vapply(manifest$files, function(item) item$name, character(1))
    .loci_require(!anyDuplicated(names) && !"manifest.json" %in% names &&
        all(grepl("^[A-Za-z0-9][A-Za-z0-9_.-]*$",
        names)), "Invalid manifest file set")
    .loci_require(setequal(list.files(root, all.files = TRUE, no.. = TRUE), c(names,
        "manifest.json")), "Missing or unexpected package files")
    paths <- file.path(root, c(names, "manifest.json"))
    .loci_require(all(file.exists(paths)) && !any(file.info(paths)$isdir) &&
        all(Sys.readlink(paths) %in%
        c("", NA_character_)), "Unsafe package file")
    sha <- Sys.which("sha256sum")
    sha_args <- character()
    if (!nzchar(sha)) {
        sha <- Sys.which("shasum")
        sha_args <- c("-a", "256")
    }
    if (verify_hashes)
        .loci_require(nzchar(sha), "No SHA command; verify in Python, then set verify_hashes=FALSE")
    for (item in manifest$files) {
        path <- file.path(root, item$name)
        .loci_require(is.numeric(item$size_bytes) && length(item$size_bytes) == 1L &&
            is.finite(item$size_bytes) && item$size_bytes >= 0 && item$size_bytes ==
            floor(item$size_bytes) && is.character(item$sha256) && length(item$sha256) == 1L &&
            grepl("^[a-f0-9]{64}$", item$sha256),
                "Invalid manifest checksum metadata")
        .loci_require(file.info(path)$size == item$size_bytes, paste("File size mismatch",
            item$name))
        if (verify_hashes) {
            output <- system2(sha, c(sha_args, shQuote(path)), stdout = TRUE, stderr = TRUE)
            .loci_require(is.null(attr(output, "status")) && length(output) >= 1L &&
                substr(output[1], 1L, 64L) == item$sha256, paste("File checksum mismatch",
                item$name))
        }
    }
    schema <- read_json("schema.json")
    .loci_require(schema$schema == "loci.scientific-data-package/v1" && schema$encoding ==
        "UTF-8" && schema$purpose == manifest$purpose && manifest$purpose %in% c("reviewed",
        "provisional"), "Unsupported schema or purpose")
    required <- c("results.csv", "objects.csv", "measurements.csv", "samples.csv",
        "groups.csv", "memberships.csv", "object-records.jsonl")
    .loci_require(setequal(names(schema$tables), required) && all(required %in% names),
        "Unsupported table set")
    tables <- list()
    for (name in names(schema$tables)) {
        definition <- schema$tables[[name]]
        .loci_require(is.numeric(definition$row_count) && definition$row_count >=
            0 && definition$row_count == floor(definition$row_count), "Invalid row count")
        if (definition$format == "csv") {
            .loci_require(definition$encoding$null == "\\N" && grepl("double an initial backslash",
                definition$encoding$text, fixed = TRUE), "Unsupported CSV text codec")
            fields <- definition$fields
            columns <- vapply(fields, function(field) field$name, character(1))
            # Mark UTF-8 text without transcoding it to the native locale.
            # fileEncoding would reject valid Unicode when LC_CTYPE is C.
            table <- read.csv(file.path(root, name), colClasses = "character", check.names = FALSE,
                na.strings = character(), quote = "\"", encoding = "UTF-8",
                    stringsAsFactors = FALSE,
                comment.char = "", blank.lines.skip = FALSE, fill = FALSE, strip.white = FALSE,
                allowEscapes = FALSE)
            .loci_require(!anyDuplicated(columns) && identical(names(table), columns),
                "CSV header mismatch")
            for (field in fields) table[[field$name]] <- .loci_decode(table[[field$name]],
                field)
        }
        else {
            .loci_require(name == "object-records.jsonl" && definition$format ==
                "jsonl", "Unsupported table format")
            lines <- readLines(file.path(root, name), encoding = "UTF-8", warn = FALSE)
            records <- lapply(lines, function(line) jsonlite::fromJSON(line,
                simplifyVector = FALSE))
            extract <- function(field) vapply(records, function(row) {
                if (field == "object.label") {
                  label <- row$object$label
                  .loci_require(is.numeric(label) && is.finite(label) && label >=
                    1 && label <= 4294967295 && label == floor(label), "Invalid raw label")
                  return(sprintf("%.0f", label))
                }
                .loci_require(is.character(row[[field]]) && length(row[[field]]) ==
                  1L, "Invalid raw identity")
                row[[field]]
            }, character(1))
            table <- data.frame(result_id = extract("result_id"),
                revision_hash = extract("revision_hash"),
                object.label = extract("object.label"), raw_json = lines, check.names = FALSE)
        }
        .loci_require(nrow(table) == definition$row_count, paste("Table row count mismatch",
            name))
        .loci_require(!anyDuplicated(.loci_key(table, unlist(definition$primaryKey))),
            paste("Duplicate primary key", name))
        tables[[name]] <- table
    }
    for (name in names(schema$tables)) for (foreign in schema$tables[[name]]$foreignKeys) {
        target <- .loci_key(tables[[foreign$reference$resource]], unlist(foreign$reference$fields))
        .loci_require(all(.loci_key(tables[[name]], unlist(foreign$fields)) %in%
            target), paste("Foreign key mismatch", name))
    }
    .loci_relations(tables, manifest)
    list(schema = schema, manifest = manifest, tables = tables, hashes_verified = verify_hashes)
}


if (sys.nframe() == 0L) {
    args <- commandArgs(trailingOnly = TRUE)
    data <- read_loci_data(if (length(args)) args[[1]] else ".")
    for (name in names(data$tables)) {
        cat(name, ": ", nrow(data$tables[[name]]), " rows\n", sep = "")
    }
}
"""
