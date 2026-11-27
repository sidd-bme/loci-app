"""Read the OrganoidTracker v1 D3 graph written by the 2.0 paper's example."""

from __future__ import annotations

import hashlib
import math
from collections import Counter
from pathlib import Path

from .research_large_exchange import _read_bounded_bytes
from .research_project import SHA_PATTERN, canonical_json, checked_id, parse_json

KIND = "organoidtracker_graph"
MAX_NODES = 50_000
ORIGINS = ("unspecified", "model-output", "manually-annotated", "synthetic")


def integer(value):
    if type(value) is not int or abs(value) > 2**31 - 1:
        raise ValueError("Invalid OrganoidTracker time point or node index")
    return value


def number(value):
    if type(value) not in (float, int) or not math.isfinite(value):
        raise ValueError("Expected finite numeric OrganoidTracker data")
    return value


def probability(value):
    if value is not None and not 0 <= number(value) <= 1:
        raise ValueError("Link probability must be between zero and one")
    return value


def identity(raw):
    if not isinstance(raw, dict) or set(raw) != {"x", "y", "z", "_time_point_number"}:
        raise ValueError("Expected an upstream XYZ and time point identity")
    return (integer(raw["_time_point_number"]), *(number(raw[a]) for a in "xyz"))


def grid(source):
    meta = source["metadata"]
    cal = meta.get("physical_calibration") or {}
    timing = meta.get("timing") or {}
    if (
        source.get("source_kind") != "native"
        or meta.get("format") != "OME-TIFF"
        or meta.get("geometry")
        or meta.get("plane_positions")
        or cal.get("axes") != "ZYX"
        or cal.get("unit") != "µm"
        or timing.get("source") != "ome-time-increment"
        or timing.get("interval_unit") != "s"
    ):
        raise ValueError(
            "Select a calibrated native ZYX OME-TIFF time series with uniform OME timing "
            "and no stage transform"
        )
    spacing = list(reversed(cal["spacing"]))
    interval = number(timing["uniform_interval"])
    if (
        len(spacing) != 3
        or min(map(number, spacing)) <= 0
        or interval <= 0
        or meta["dimensions"]["t"] < 2
    ):
        raise ValueError("A positive 3D calibration and time series are required")
    return spacing, interval


def validate(data, source, document_id):
    keys = {
        "schema",
        "source_id",
        "source_sha256",
        "series",
        "file_sha256",
        "origin",
        "first",
        "spacing_xyz_um",
        "interval_s",
        "nodes",
        "edges",
    }
    if set(data) != keys or data["schema"] != "loci.organoidtracker-aut-v1/1":
        raise ValueError("Unknown OrganoidTracker study graph")
    spacing, interval = grid(source)
    if (
        data["source_id"] != source["id"]
        or data["source_sha256"] != source["sha256"]
        or type(data["series"]) is not int
        or data["series"] != source["metadata"]["selected_series"]
        or data["origin"] not in ORIGINS
        or not SHA_PATTERN.fullmatch(data["file_sha256"])
        or document_id != digest(data)[:32]
    ):
        raise ValueError("OrganoidTracker graph or source identity changed")
    if len(data["spacing_xyz_um"]) != 3 or not all(
        math.isclose(number(a), b, rel_tol=1e-8)
        for a, b in zip(
            [*data["spacing_xyz_um"], data["interval_s"]], [*spacing, interval], strict=True
        )
    ):
        raise ValueError("OrganoidTracker and source calibration disagree")
    first = integer(data["first"])
    nodes = data["nodes"]
    edges = data["edges"]
    if not 1 <= len(nodes) <= MAX_NODES or not 1 <= len(edges) <= MAX_NODES:
        raise ValueError("Select a linked graph within the 50,000 node and link limits")
    dims = source["metadata"]["dimensions"]
    if not all(
        math.isfinite((dims[a] - 1) * scale)
        for a, scale in zip("xyzt", [*spacing, interval], strict=True)
    ):
        raise ValueError("Physical extent of the source is not finite")
    for t, x, y, z in nodes:
        if not (
            0 <= integer(t) - first < dims["t"]
            and all(0 <= number(v) <= dims[a] - 1 for v, a in zip((x, y, z), "xyz", strict=True))
        ):
            raise ValueError("Track position falls outside the bound image or time range")
    if len(set(map(tuple, nodes))) != len(nodes):
        raise ValueError("Duplicate upstream position identity")
    parents = set()
    children = Counter()
    for i, j, p, marginal in edges:
        if not (
            0 <= integer(i) < len(nodes)
            and 0 <= integer(j) < len(nodes)
            and nodes[j][0] == nodes[i][0] + 1
            and j not in parents
            and children[i] < 2
        ):
            raise ValueError(
                "Expected unique consecutive links, one parent and at most two daughters"
            )
        parents.add(j)
        children[i] += 1
        probability(p)
        probability(marginal)


def digest(data):
    return hashlib.sha256(canonical_json(data).encode()).hexdigest()


def decode(raw, source, first, origin):
    checked_id(source["id"])
    doc = parse_json(raw.decode("utf-8"))
    supported = {
        "version",
        "positions",
        "links",
        "image_resolution",
        "image_offsets",
        "name",
        "name_is_automatic",
        "warning_limits",
        "color",
        "image_channel_descriptions",
    }
    if not isinstance(doc, dict) or doc.get("version") != "v1" or set(doc) - supported:
        raise ValueError(
            "Choose a v1 .aut graph without additional transforms, timings or annotations"
        )
    if doc.get("image_offsets", []) != []:
        raise ValueError("OrganoidTracker image offsets are unsupported")
    graph = doc.get("links")
    if (
        not isinstance(graph, dict)
        or graph.get("directed") is not False
        or graph.get("multigraph") is not False
    ):
        raise ValueError("Expected the v1 undirected D3 node-link encoding")
    if (
        not isinstance(graph.get("nodes"), list)
        or len(graph["nodes"]) > MAX_NODES
        or not isinstance(graph.get("links"), list)
        or len(graph["links"]) > MAX_NODES
    ):
        raise ValueError("OrganoidTracker node or link limit exceeded")
    nodes = [identity(n["id"]) for n in graph["nodes"]]
    indices = {node: i for i, node in enumerate(nodes)}
    if "positions" in doc:
        declared = []
        for t, positions in doc["positions"].items():
            for xyz in positions:
                if len(xyz) != 3:
                    raise ValueError("Unsupported upstream position shape")
                if len(declared) >= len(nodes):
                    raise ValueError("Position list exceeds the graph node count")
                declared.append((integer(int(t)), *map(number, xyz)))
        if len(declared) != len(nodes) or set(declared) != set(indices):
            raise ValueError("Position and link node identities disagree")
    edges = []
    for edge in graph["links"]:
        a, b = sorted((identity(edge["source"]), identity(edge["target"])))
        if a not in indices or b not in indices:
            raise ValueError("OrganoidTracker link endpoint is missing")
        edges.append(
            [
                indices[a],
                indices[b],
                probability(edge.get("link_probability")),
                probability(edge.get("marginal_probability")),
            ]
        )
    resolution = doc.get("image_resolution") or {}
    if set(resolution) != {"x_um", "y_um", "z_um", "t_m"}:
        raise ValueError("An explicit XYZ and time calibration is required in the .aut")
    data = dict(
        schema="loci.organoidtracker-aut-v1/1",
        source_id=source["id"],
        source_sha256=source["sha256"],
        series=source["metadata"]["selected_series"],
        file_sha256=hashlib.sha256(raw).hexdigest(),
        origin=origin,
        first=first,
        spacing_xyz_um=[number(resolution[a + "_um"]) for a in "xyz"],
        interval_s=number(resolution["t_m"]) * 60,
        nodes=[list(n) for n in nodes],
        edges=edges,
    )
    validate(data, source, digest(data)[:32])
    return data


def bound_source(project, binding):
    if set(binding) != {"source_id", "source_sha256"}:
        raise ValueError("Expected an exact study source binding")
    source = project.source(
        binding["source_id"],
        verify=True,
        native_metadata_fields=("dimensions", "timing", "plane_positions", "format"),
    )
    if source["sha256"] != binding["source_sha256"]:
        raise ValueError("Selected source fingerprint changed")
    return source


def import_graph(project, path, binding, first, origin):
    source = bound_source(project, binding)
    path = Path(path)
    if not path.is_absolute() or path.suffix.lower() != ".aut":
        raise ValueError("Choose a local OrganoidTracker .aut file")
    raw = _read_bounded_bytes(path, 16 * 1024**2)
    try:
        data = decode(raw, source, first, origin)
    except (KeyError, TypeError, IndexError, AttributeError, OverflowError, RecursionError) as exc:
        raise ValueError("Invalid or unsupported OrganoidTracker graph structure") from exc
    graph_id = digest(data)[:32]
    records = project.documents(KIND, document_id=graph_id)
    if records:
        if records[0]["revision"] != 1 or digest(records[0]["data"]) != digest(data):
            raise ValueError("Existing OrganoidTracker record disagrees with the selected graph")
    else:
        project.put_document(KIND, graph_id, data, expected_revision=0)
    return {"id": graph_id, "graph_sha256": digest(data), **data}


def load(project, binding, graph_id):
    source = bound_source(project, binding)
    records = project.documents(KIND, document_id=checked_id(graph_id))
    if len(records) != 1 or records[0]["revision"] != 1:
        raise ValueError("The selected immutable graph is unavailable")
    data = records[0]["data"]
    validate(data, source, graph_id)
    return {"id": graph_id, "graph_sha256": digest(data), **data}


def list_graphs(project, binding):
    source = project.source(binding["source_id"])
    if source["sha256"] != binding["source_sha256"]:
        raise ValueError("Source identity changed")
    with project.connection() as db:
        ids = db.execute(
            "SELECT id FROM documents WHERE kind=? AND json_extract(record, '$.data.source_id')=? "
            "ORDER BY rowid DESC LIMIT 100",
            (KIND, source["id"]),
        ).fetchall()
    return [checked_id(row[0]) for row in ids]
