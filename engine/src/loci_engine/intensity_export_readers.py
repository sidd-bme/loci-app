"""Independent, dependency-light readers shipped inside intensity packages.

These programs deliberately do not import Loci. CSV identity is exact; numerical
hierarchy checks independently recalculate descriptive means and sample SD.
"""

# Embedded reader programs retain their own readable continuation conventions.
# ruff: noqa: E501

PYTHON_READER = r'''#!/usr/bin/env python3
"""Verify a Loci intensity package with the Python standard library only."""
import csv
import hashlib
import json
import math
import sys
from pathlib import Path

PACKAGE = "loci.experiment-intensity-package/v1"
REPORT = "loci.experiment-intensity-report/v1"
TABLES = {"objects.csv": "observations", "images.csv": "images",
          "replicates.csv": "replicates", "conditions.csv": "conditions", "audit.csv": "audit"}
FILES = set(TABLES) | {"report.json", "schema.json", "provenance.json", "readme.md",
                       "read_report.py", "read_report.R"}
MAX_BYTES = 64 * 1024**2
AGGREGATION = {
    "object_to_image": "equal weight of finite stored object means",
    "image_to_replicate": "equal weight of valid image means within (condition, biological_replicate)",
    "replicate_to_condition": "equal weight of valid declared replicate means",
    "sd": "descriptive sample SD of valid replicate means; ddof=1; null below two",
    "missing_replicate": "unassigned; excluded from condition estimates",
    "review": "reviewed contributes; excluded is audit only; pending blocks",
    "interpretation": "raw source-intensity; no calibration or biological independence established",
}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def decode(text):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    def invalid(_value):
        raise ValueError("Non-finite JSON constant")
    return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid)


def number(value):
    require(type(value) in (int, float) and math.isfinite(value), "Expected finite number")
    return value


def average(values):
    return math.fsum(value / len(values) for value in values) if values else None


def same_rows(actual, expected, table):
    require(len(actual) == len(expected), table + " row count mismatch")
    for left, right in zip(actual, expected):
        require(set(left) == set(right), table + " column mismatch")
        for key in right:
            if key in {"mean", "sd"} and right[key] is not None:
                require(type(left[key]) in (int, float)
                        and math.isclose(number(left[key]), right[key], rel_tol=1e-12, abs_tol=1e-12),
                        table + " independently recomputed " + key + " mismatch")
            else:
                require(canonical(left[key]) == canonical(right[key]), table + " " + key + " mismatch")


def hierarchy(report):
    ids = report["result_ids"]
    bindings = report["bindings"]
    require(1 <= len(ids) <= 100 and len(set(ids)) == len(ids), "Invalid selected revisions")
    require([b["result_id"] for b in bindings] == ids, "Result binding/order mismatch")
    require(len({b["source_id"] for b in bindings}) == len(bindings), "Duplicate source")
    require(len(report["observations"]) <= 50000, "Too many object observations")
    by_result = {identity: [] for identity in ids}
    labels = set()
    for row in report["observations"]:
        require(set(row) == {"result_id", "label", "status", "value"}, "Invalid object columns")
        key = (row["result_id"], row["label"])
        require(row["result_id"] in by_result and type(row["label"]) is int
                and 1 <= row["label"] <= 2**32 - 1 and key not in labels,
                "Invalid/duplicate object label or result")
        labels.add(key)
        require(row["status"] in {"value", "null", "missing"}, "Unknown object status")
        if row["status"] == "value":
            number(row["value"])
        else:
            require(row["value"] is None, "Missing/null means must retain JSON null")
        by_result[row["result_id"]].append(row)
    images, audits, groups = [], [], {}
    for binding in bindings:
        identity = binding["result_id"]
        rows = by_result[identity]
        require(type(binding["object_count"]) is int and binding["object_count"] == len(rows),
                "Bound object count mismatch")
        require(binding["source"]["id"] == binding["source_id"]
                and binding["source"]["sha256"] == binding["source_sha256"], "Source identity mismatch")
        require(binding["review"]["result_id"] == identity
                and binding["review"]["revision_hash"] == binding["revision_hash"], "Review identity mismatch")
        disposition = binding["review"]["disposition"]
        require(disposition in {"reviewed", "excluded"}, "Pending or invalid review")
        metadata = binding["sample_document"]["data"]
        require(set(metadata) == {"study", "sample", "condition", "biological_replicate", "plate", "well"},
                "Invalid sample metadata columns")
        require(all(isinstance(metadata[k], str) and metadata[k].strip()
                    for k in ("study", "sample", "condition")), "Required sample metadata missing")
        for key in ("biological_replicate", "plate", "well"):
            require(metadata[key] is None or isinstance(metadata[key], str) and metadata[key].strip(),
                    "Invalid optional sample metadata")
        descriptor = binding["descriptor"]
        require(descriptor["kind"] == "intensity" and descriptor["statistic"] == "mean"
                and descriptor["unit"] == "source-intensity"
                and descriptor.get("compartment", "object") == report["endpoint"]["compartment"]
                and descriptor["channel"] == binding["channel"]["key"], "Endpoint/channel/unit mismatch")
        values = [row["value"] for row in rows if row["status"] == "value"]
        included = disposition == "reviewed"
        reason = ("excluded-by-review" if not included else "no-valid-object-means" if not values
                  else "missing-biological-replicate" if metadata["biological_replicate"] is None
                  else "included")
        image = dict(metadata, result_id=identity, revision_hash=binding["revision_hash"],
                     source_id=binding["source_id"], object_count=len(rows), valid_object_count=len(values),
                     missing_object_count=sum(r["status"] == "missing" for r in rows),
                     null_object_count=sum(r["status"] == "null" for r in rows),
                     mean=average(values) if included else None, included=included, reason=reason)
        images.append(image)
        audits.append(dict(result_id=identity, source_id=binding["source_id"], review_disposition=disposition,
                           reason=reason, contributes_to_condition=reason == "included"))
        if included and metadata["biological_replicate"] is not None:
            groups.setdefault((metadata["condition"], metadata["biological_replicate"]), []).append(image)
    require(len({i["study"] for i in images}) == 1, "Mixed studies")
    replicates = []
    for (condition, replicate), rows in sorted(groups.items()):
        values = [row["mean"] for row in rows if row["mean"] is not None]
        replicates.append(dict(condition=condition, biological_replicate=replicate,
                               result_ids=[r["result_id"] for r in rows], image_count=len(rows),
                               valid_image_count=len(values), object_count=sum(r["object_count"] for r in rows),
                               valid_object_count=sum(r["valid_object_count"] for r in rows), mean=average(values)))
    conditions = []
    for condition in sorted({row["condition"] for row in images}):
        rows = [r for r in images if r["condition"] == condition and r["included"]]
        declared = [r for r in replicates if r["condition"] == condition]
        values = [r["mean"] for r in declared if r["mean"] is not None]
        mean = average(values)
        sd = None
        if len(values) > 1:
            scale = max(abs(value) for value in values)
            normalized = [value / scale for value in values] if scale else [0.0] * len(values)
            center = average(normalized)
            sd = scale * math.sqrt(math.fsum((value-center)**2 for value in normalized) / (len(values)-1))
            number(sd)
        conditions.append(dict(condition=condition, image_count=len(rows),
                               valid_image_count=sum(r["mean"] is not None for r in rows),
                               unassigned_image_count=sum(r["biological_replicate"] is None for r in rows),
                               object_count=sum(r["object_count"] for r in rows),
                               valid_object_count=sum(r["valid_object_count"] for r in rows),
                               declared_replicate_count=len(declared), valid_replicate_count=len(values), mean=mean, sd=sd))
    for name, rows in (("images", images), ("replicates", replicates), ("conditions", conditions), ("audit", audits)):
        same_rows(report[name], rows, name)


def verify(directory):
    root = Path(directory)
    require(root.is_dir() and not root.is_symlink(), "Choose a plain package directory")
    require({p.name for p in root.iterdir()} == FILES | {"manifest.json"}, "Unexpected/missing package files")
    require(all((root/name).is_file() and not (root/name).is_symlink() for name in FILES | {"manifest.json"}),
            "Package files must be plain files")
    require(sum((root/name).stat().st_size for name in FILES | {"manifest.json"}) <= MAX_BYTES, "Package too large")
    manifest = decode((root/"manifest.json").read_text(encoding="utf-8"))
    require(set(manifest) == {"schema", "package_schema", "report_hash", "plan_hash", "export_software", "files"}
            and manifest["schema"] == "loci.intensity-export-manifest/v1"
            and manifest["package_schema"] == PACKAGE, "Unsupported package manifest")
    software = manifest["export_software"]
    require(set(software) == {"kind", "sha256", "engine_version", "python_version"}
            and software["kind"] in {"source-modules-sha256", "frozen-executable-sha256"}
            and isinstance(software["sha256"], str) and len(software["sha256"]) == 64
            and all(char in "0123456789abcdef" for char in software["sha256"]),
            "Invalid export software identity")
    records = manifest["files"]
    require(len(records) == len(FILES) and {r["name"] for r in records} == FILES, "Manifest membership mismatch")
    for record in records:
        require(set(record) == {"name", "size_bytes", "sha256"}, "Invalid manifest file record")
        data = (root/record["name"]).read_bytes()
        require(type(record["size_bytes"]) is int and record["size_bytes"] == len(data)
                and hashlib.sha256(data).hexdigest() == record["sha256"], "Manifest checksum/size mismatch")
    require((root/"report.json").stat().st_size <= 8*1024**2+1, "Report exceeds 8 MiB")
    report = decode((root/"report.json").read_text(encoding="utf-8"))
    require(set(report) == {"schema", "created_at", "software", "endpoint", "declaration", "result_ids", "bindings",
                            "observations", "images", "replicates", "conditions", "audit", "aggregation", "report_hash"}
            and report["schema"] == REPORT, "Unsupported report schema")
    content_hash = hashlib.sha256(canonical({k:v for k,v in report.items() if k != "report_hash"}).encode()).hexdigest()
    require(content_hash == report["report_hash"] == manifest["report_hash"], "Report content hash mismatch")
    require(report["aggregation"] == AGGREGATION, "Unsupported aggregation definition")
    endpoint = report["endpoint"]
    require(endpoint == dict(schema="loci.intensity-endpoint/v1", kind="raw-channel-intensity", statistic="mean",
                             unit="source-intensity", compartment=endpoint.get("compartment"))
            and endpoint["compartment"] in {"object", "cell", "nuclear", "cytoplasm"}, "Unsupported endpoint")
    schema = decode((root/"schema.json").read_text(encoding="utf-8"))
    require(schema["schema"] == PACKAGE and schema["report_hash"] == report["report_hash"]
            and schema["unit"] == "source-intensity" and schema["encoding"] == "UTF-8"
            and canonical(schema["endpoint"]) == canonical(endpoint)
            and canonical(schema["aggregation"]) == canonical(report["aggregation"])
            and set(schema["tables"]) == set(TABLES), "Schema/report mismatch")
    provenance = decode((root/"provenance.json").read_text(encoding="utf-8"))
    for key in ("report_hash", "created_at", "software", "bindings", "declaration"):
        require(canonical(provenance[key]) == canonical(report[key]), "Provenance/report mismatch: " + key)
    for filename, key in TABLES.items():
        expected = report[key]
        columns = sorted({k for row in expected for k in row})
        table_schema = schema["tables"][filename]
        require(set(table_schema) == {"columns", "rows", "dictionary"}
                and table_schema["columns"] == columns and type(table_schema["rows"]) is int
                and table_schema["rows"] == len(expected)
                and set(table_schema["dictionary"]) == set(columns)
                and all(isinstance(value, str) and value.strip() for value in table_schema["dictionary"].values()),
                "Table schema/dictionary mismatch")
        with (root/filename).open(encoding="utf-8", newline="") as stream:
            rows = list(csv.reader(stream, strict=True))
        require(bool(rows) and rows[0] == columns and all(len(row) == len(columns) for row in rows[1:]), "CSV shape mismatch")
        actual = [dict(zip(columns, [decode(cell) for cell in row])) for row in rows[1:]]
        require(canonical(actual) == canonical(expected), "CSV rows differ from exact report: " + filename)
    hierarchy(report)
    return {"verified": True, "report_hash": report["report_hash"], "compartment": endpoint["compartment"],
            "object_count": len(report["observations"]), "conditions": report["conditions"]}


if __name__ == "__main__":
    try:
        print(json.dumps(verify(sys.argv[1] if len(sys.argv)>1 else "."), ensure_ascii=False, allow_nan=False))
    except Exception as error:
        print("Intensity package verification failed: " + str(error), file=sys.stderr)
        sys.exit(1)
'''

R_READER = r"""#!/usr/bin/env Rscript
# Independent R/jsonlite verifier. No Loci code or additional package install.
suppressPackageStartupMessages(library(jsonlite))
require_ok <- function(ok, message) { if (!isTRUE(ok)) stop(message, call.=FALSE) }
PACKAGE <- "loci.experiment-intensity-package/v1"
TABLES <- c("objects.csv"="observations", "images.csv"="images", "replicates.csv"="replicates",
            "conditions.csv"="conditions", "audit.csv"="audit")
FILES <- c(names(TABLES), "report.json", "schema.json", "provenance.json", "readme.md", "read_report.py", "read_report.R")
text_file <- function(path) {
  n <- file.info(path)$size
  connection <- file(path, "rb"); on.exit(close(connection))
  rawToChar(readBin(connection, "raw", n=n))
}
check_json <- function(value) {
  if (is.list(value)) {
    if (!is.null(names(value))) require_ok(!anyDuplicated(names(value)), "Duplicate JSON key")
    invisible(lapply(value, check_json))
  } else if (is.numeric(value)) require_ok(all(is.finite(value)), "Non-finite JSON number")
}
decode <- function(text) { value <- fromJSON(text, simplifyVector=FALSE); check_json(value); value }
equal_json <- function(a, b) {
  if (is.null(a) || is.null(b)) return(is.null(a) && is.null(b))
  if (is.list(a) || is.list(b)) {
    if (!is.list(a) || !is.list(b) || length(a)!=length(b)) return(FALSE)
    if (!is.null(names(a)) || !is.null(names(b))) {
      if (!setequal(names(a),names(b))) return(FALSE)
      a <- a[sort(names(a))]; b <- b[sort(names(b))]
    }
    return(all(vapply(seq_along(a), function(i) equal_json(a[[i]],b[[i]]), logical(1))))
  }
  identical(a,b)
}
sha_file <- function(path) {
  executable <- Sys.which("sha256sum")
  arguments <- shQuote(path)
  if (!nzchar(executable)) { executable <- Sys.which("shasum"); arguments <- c("-a","256",shQuote(path)) }
  require_ok(nzchar(executable), "A local sha256sum or shasum executable is required")
  output <- system2(executable, arguments, stdout=TRUE, stderr=TRUE)
  require_ok(is.null(attr(output,"status")), "SHA-256 utility failed")
  substring(output[[1]],1,64)
}
sha_text <- function(text) {
  path <- tempfile("loci-reader-"); on.exit(unlink(path))
  connection <- file(path,"wb"); writeBin(charToRaw(text),connection); close(connection)
  sha_file(path)
}
unsigned_report_text <- function(text) {
  # Publisher writes canonical JSON. Remove only the top-level hash member,
  # preserving Python's exact float and Unicode escapes for independent hashing.
  text <- sub("\n$","",text)
  chars <- strsplit(text,"",fixed=TRUE)[[1]]
  depth <- 0L; quoted <- FALSE; escaped <- FALSE; found <- integer()
  for (i in seq_along(chars)) {
    char <- chars[[i]]
    if (quoted) {
      if (escaped) escaped <- FALSE else if (char=="\\") escaped <- TRUE else if (char=='"') quoted <- FALSE
    } else if (char=='"') {
      if (depth==1L && startsWith(substring(text,i),'"report_hash":"')) found <- c(found,i)
      quoted <- TRUE
    } else if (char %in% c("{","[")) depth <- depth+1L else if (char %in% c("}","]")) depth <- depth-1L
  }
  require_ok(length(found)==1L && depth==0L && !quoted, "Canonical report hash member missing")
  start <- found[[1]]
  match <- regexpr('^"report_hash":"[a-f0-9]{64}"',substring(text,start),perl=TRUE)
  require_ok(match[[1]]==1L, "Invalid report hash member")
  end <- start+attr(match,"match.length")-1L
  require_ok(substring(text,start-1L,start-1L)==",", "Unsupported canonical report member order")
  paste0(substring(text,1,start-2L),substring(text,end+1L))
}
number <- function(value) { require_ok(is.numeric(value)&&length(value)==1L&&is.finite(value),"Expected finite number"); value }
average <- function(values) if (length(values)) mean(unlist(values)) else NULL
sample_sd <- function(values) {
  if (length(values)<2L) return(NULL)
  values <- unlist(values); scale <- max(abs(values))
  result <- if (scale) scale*sd(values/scale) else 0
  number(result)
}
rows_equal <- function(actual,expected,name) {
  require_ok(length(actual)==length(expected),paste(name,"row count mismatch"))
  for (i in seq_along(expected)) {
    a <- actual[[i]]; b <- expected[[i]]
    require_ok(setequal(names(a),names(b)),paste(name,"column mismatch"))
    for (key in names(b)) {
      if (key %in% c("mean","sd") && !is.null(b[[key]])) {
        value <- number(a[[key]])
        require_ok(abs(value-b[[key]]) <= 1e-12*max(1,abs(value),abs(b[[key]])),paste(name,key,"independent mismatch"))
      } else require_ok(equal_json(a[[key]],b[[key]]),paste(name,key,"mismatch"))
    }
  }
}
hierarchy <- function(report) {
  ids <- unlist(report$result_ids, use.names=FALSE)
  bindings <- report$bindings
  require_ok(length(ids)>=1L&&length(ids)<=100L&&!anyDuplicated(ids),"Invalid selected revisions")
  require_ok(identical(vapply(bindings,function(b)b$result_id,character(1)),ids),"Binding order mismatch")
  require_ok(!anyDuplicated(vapply(bindings,function(b)b$source_id,character(1))),"Duplicate source")
  observations <- report$observations
  require_ok(length(observations)<=50000L,"Too many observations")
  seen <- new.env(hash=TRUE,parent=emptyenv())
  for (row in observations) {
    require_ok(setequal(names(row),c("result_id","label","value","status")),"Invalid object columns")
    key <- paste(row$result_id,row$label,sep=":")
    require_ok(row$result_id %in% ids&&is.numeric(row$label)&&row$label==floor(row$label)&&row$label>=1&&row$label<=2^32-1&&!exists(key,envir=seen,inherits=FALSE),"Invalid/duplicate object label")
    assign(key,TRUE,envir=seen)
    require_ok(row$status %in% c("value","null","missing"),"Invalid object status")
    if (row$status=="value") number(row$value) else require_ok(is.null(row$value),"Null/missing mean must be null")
  }
  images <- list(); audits <- list()
  for (binding in bindings) {
    rows <- Filter(function(row)row$result_id==binding$result_id,observations)
    require_ok(is.numeric(binding$object_count)&&binding$object_count==length(rows),"Bound object count mismatch")
    require_ok(binding$source$id==binding$source_id&&binding$source$sha256==binding$source_sha256,"Source identity mismatch")
    require_ok(binding$review$result_id==binding$result_id&&binding$review$revision_hash==binding$revision_hash,"Review identity mismatch")
    disposition <- binding$review$disposition
    require_ok(disposition %in% c("reviewed","excluded"),"Pending or invalid review")
    metadata <- binding$sample_document$data
    require_ok(setequal(names(metadata),c("study","sample","condition","biological_replicate","plate","well")),"Sample metadata columns mismatch")
    for (key in c("study","sample","condition")) require_ok(is.character(metadata[[key]])&&nzchar(trimws(metadata[[key]])),"Required metadata missing")
    for (key in c("biological_replicate","plate","well")) require_ok(is.null(metadata[[key]])||is.character(metadata[[key]])&&nzchar(trimws(metadata[[key]])),"Optional metadata malformed")
    d <- binding$descriptor
    compartment <- if (is.null(d$compartment)) "object" else d$compartment
    require_ok(d$kind=="intensity"&&d$statistic=="mean"&&d$unit=="source-intensity"&&compartment==report$endpoint$compartment&&d$channel==binding$channel$key,"Endpoint/channel/unit mismatch")
    values <- lapply(Filter(function(row)row$status=="value",rows),function(row)row$value)
    included <- disposition=="reviewed"
    reason <- if (!included) "excluded-by-review" else if (!length(values)) "no-valid-object-means" else if (is.null(metadata$biological_replicate)) "missing-biological-replicate" else "included"
    image <- c(metadata,list(result_id=binding$result_id,revision_hash=binding$revision_hash,source_id=binding$source_id,
                 object_count=as.integer(length(rows)),valid_object_count=as.integer(length(values)),
                 missing_object_count=as.integer(sum(vapply(rows,function(r)r$status=="missing",logical(1)))),
                 null_object_count=as.integer(sum(vapply(rows,function(r)r$status=="null",logical(1)))),
                 mean=if(included)average(values) else NULL,included=included,reason=reason))
    images[[length(images)+1L]] <- image
    audits[[length(audits)+1L]] <- list(result_id=binding$result_id,source_id=binding$source_id,review_disposition=disposition,reason=reason,contributes_to_condition=reason=="included")
  }
  require_ok(length(unique(vapply(images,function(r)r$study,character(1))))==1L,"Mixed studies")
  conditions_names <- sort(unique(vapply(images,function(r)r$condition,character(1))),method="radix")
  replicates <- list(); conditions <- list()
  for (condition in conditions_names) {
    rows <- Filter(function(r)r$included&&r$condition==condition,images)
    names_rep <- sort(unique(unlist(lapply(rows,function(r)r$biological_replicate))),method="radix")
    declared <- list()
    for (replicate in names_rep) {
      grouped <- Filter(function(r)!is.null(r$biological_replicate)&&r$biological_replicate==replicate,rows)
      values <- Filter(Negate(is.null),lapply(grouped,function(r)r$mean))
      item <- list(condition=condition,biological_replicate=replicate,result_ids=lapply(grouped,function(r)r$result_id),
                   image_count=as.integer(length(grouped)),valid_image_count=as.integer(length(values)),
                   object_count=as.integer(sum(vapply(grouped,function(r)r$object_count,numeric(1)))),
                   valid_object_count=as.integer(sum(vapply(grouped,function(r)r$valid_object_count,numeric(1)))),mean=average(values))
      declared[[length(declared)+1L]] <- item; replicates[[length(replicates)+1L]] <- item
    }
    values <- Filter(Negate(is.null),lapply(declared,function(r)r$mean))
    conditions[[length(conditions)+1L]] <- list(condition=condition,image_count=as.integer(length(rows)),
      valid_image_count=as.integer(sum(vapply(rows,function(r)!is.null(r$mean),logical(1)))),
      unassigned_image_count=as.integer(sum(vapply(rows,function(r)is.null(r$biological_replicate),logical(1)))),
      object_count=as.integer(sum(vapply(rows,function(r)r$object_count,numeric(1)))),
      valid_object_count=as.integer(sum(vapply(rows,function(r)r$valid_object_count,numeric(1)))),
      declared_replicate_count=as.integer(length(declared)),valid_replicate_count=as.integer(length(values)),
      mean=average(values),sd=sample_sd(values))
  }
  rows_equal(report$images,images,"images"); rows_equal(report$audit,audits,"audit")
  rows_equal(report$replicates,replicates,"replicates"); rows_equal(report$conditions,conditions,"conditions")
}
verify <- function(directory) {
  root <- normalizePath(directory,mustWork=TRUE)
  require_ok(dir.exists(root)&&!nzchar(Sys.readlink(directory)),"Choose a plain package directory")
  names <- list.files(root,all.files=TRUE,no..=TRUE)
  require_ok(setequal(names,c(FILES,"manifest.json")),"Unexpected/missing package files")
  paths <- file.path(root,names)
  require_ok(all(!file.info(paths)$isdir)&&all(!nzchar(Sys.readlink(paths))),"Package files must be plain")
  require_ok(sum(file.info(paths)$size)<=64*1024^2,"Package too large")
  manifest <- decode(text_file(file.path(root,"manifest.json")))
  require_ok(setequal(names(manifest),c("schema","package_schema","report_hash","plan_hash","export_software","files"))&&manifest$schema=="loci.intensity-export-manifest/v1"&&manifest$package_schema==PACKAGE,"Unsupported manifest")
  software <- manifest$export_software
  require_ok(setequal(names(software),c("kind","sha256","engine_version","python_version"))&&
    software$kind %in% c("source-modules-sha256","frozen-executable-sha256")&&
    is.character(software$sha256)&&grepl("^[a-f0-9]{64}$",software$sha256),"Invalid export software identity")
  require_ok(length(manifest$files)==length(FILES)&&setequal(vapply(manifest$files,function(r)r$name,character(1)),FILES),"Manifest membership mismatch")
  for (record in manifest$files) {
    require_ok(setequal(names(record),c("name","sha256","size_bytes")),"Invalid manifest file record")
    path <- file.path(root,record$name)
    require_ok(file.info(path)$size==record$size_bytes&&sha_file(path)==record$sha256,"Manifest checksum/size mismatch")
  }
  require_ok(file.info(file.path(root,"report.json"))$size<=8*1024^2+1,"Report exceeds 8 MiB")
  report_text <- text_file(file.path(root,"report.json")); report <- decode(report_text)
  require_ok(setequal(names(report),c("schema","created_at","software","endpoint","declaration","result_ids","bindings","observations","images","replicates","conditions","audit","aggregation","report_hash"))&&report$schema=="loci.experiment-intensity-report/v1","Unsupported report schema")
  require_ok(sha_text(unsigned_report_text(report_text))==report$report_hash&&report$report_hash==manifest$report_hash,"Report content hash mismatch")
  aggregation <- list(
    object_to_image="equal weight of finite stored object means",
    image_to_replicate="equal weight of valid image means within (condition, biological_replicate)",
    replicate_to_condition="equal weight of valid declared replicate means",
    sd="descriptive sample SD of valid replicate means; ddof=1; null below two",
    missing_replicate="unassigned; excluded from condition estimates",
    review="reviewed contributes; excluded is audit only; pending blocks",
    interpretation="raw source-intensity; no calibration or biological independence established")
  require_ok(equal_json(report$aggregation,aggregation),"Unsupported aggregation definition")
  endpoint <- report$endpoint
  require_ok(setequal(names(endpoint),c("schema","kind","statistic","unit","compartment"))&&endpoint$schema=="loci.intensity-endpoint/v1"&&endpoint$kind=="raw-channel-intensity"&&endpoint$statistic=="mean"&&endpoint$unit=="source-intensity"&&endpoint$compartment %in% c("object","cell","nuclear","cytoplasm"),"Unsupported endpoint")
  schema <- decode(text_file(file.path(root,"schema.json")))
  require_ok(schema$schema==PACKAGE&&schema$report_hash==report$report_hash&&schema$unit=="source-intensity"&&schema$encoding=="UTF-8"&&equal_json(schema$endpoint,endpoint)&&equal_json(schema$aggregation,report$aggregation)&&setequal(names(schema$tables),names(TABLES)),"Schema/report mismatch")
  provenance <- decode(text_file(file.path(root,"provenance.json")))
  for (key in c("report_hash","created_at","software","bindings","declaration")) require_ok(equal_json(provenance[[key]],report[[key]]),paste("Provenance mismatch",key))
  for (filename in names(TABLES)) {
    expected <- report[[TABLES[[filename]]]]
    columns <- sort(unique(unlist(lapply(expected,names))),method="radix")
    if (is.null(columns)) columns <- character()
    table_schema <- schema$tables[[filename]]
    require_ok(setequal(names(table_schema),c("columns","rows","dictionary"))&&
      identical(unlist(table_schema$columns,use.names=FALSE),if(length(columns))columns else NULL)&&
      table_schema$rows==length(expected)&&setequal(names(table_schema$dictionary),columns)&&
      all(vapply(table_schema$dictionary,function(text)is.character(text)&&nzchar(trimws(text)),logical(1))),
      "Table schema/dictionary mismatch")
    path <- file.path(root,filename)
    if (!length(columns)) { require_ok(text_file(path)=="\n", "Empty CSV shape mismatch"); actual <- list() } else {
      raw <- read.csv(path,colClasses="character",check.names=FALSE,na.strings=NULL,blank.lines.skip=FALSE,
                      stringsAsFactors=FALSE,comment.char="",strip.white=FALSE,fileEncoding="UTF-8",fill=FALSE,row.names=NULL)
      require_ok(identical(names(raw),columns)&&nrow(raw)==length(expected),"CSV shape mismatch")
      actual <- lapply(seq_len(nrow(raw)),function(i)setNames(lapply(raw[i,,drop=FALSE],function(cell)decode(cell[[1]])),columns))
    }
    require_ok(equal_json(actual,expected),paste("CSV differs from exact report",filename))
  }
  hierarchy(report)
  list(verified=TRUE,report_hash=report$report_hash,compartment=endpoint$compartment,
       object_count=length(report$observations),conditions=report$conditions)
}
tryCatch({
  arguments <- commandArgs(trailingOnly=TRUE)
  result <- verify(if(length(arguments))arguments[[1]] else ".")
  cat(toJSON(result,auto_unbox=TRUE,null="null",digits=NA),"\n")
},error=function(error){cat("Intensity package verification failed:",conditionMessage(error),"\n",file=stderr());quit(status=1)})
"""
