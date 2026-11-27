"""Exact read-only queries over external graphs with unknown model input footprint."""

from collections import Counter

from .organoidtracker import KIND, bound_source, digest, validate
from .research_project import parse_json


def authorized_graph(policy, project, request):
    # An .aut graph does not encode the generating channels, receptive field or
    # neighborhood used for marginalization. Partial grants cannot cover these inputs.
    if not policy.delegation or policy.delegation["result_scope"] != "granted-sources":
        raise PermissionError("External graph inspection requires granted-source result access")
    grant = policy.source_grant(project, request["source_id"])
    source = project.source(request["source_id"])
    dims = source["metadata"]["dimensions"]
    if (
        source["sha256"] != request["source_sha256"]
        or source["sha256"] != grant.sha256
        or grant.crop != (0, 0, dims["x"], dims["y"])
        or 0 not in grant.level
        or any(
            len(values) != dims[axis] or any(i != v for i, v in enumerate(values))
            for axis, values in (("c", grant.c), ("t", grant.t), ("z", grant.z))
        )
    ):
        raise PermissionError("Graph inspection requires the complete native source grant")
    if request["filter"] == "low-marginal" and "marginal_below" not in request:
        raise ValueError("Declare the marginal probability cutoff")
    if request["filter"] != "low-marginal" and "marginal_below" in request:
        raise ValueError("A marginal cutoff applies only to the low-marginal filter")
    if request.get("source_t", 0) >= dims["t"]:
        raise ValueError("Source time is out of range")
    unavailable = "The exact graph is unavailable under this source grant"
    if request["graph_id"] != request["graph_sha256"][:32]:
        raise PermissionError(unavailable)
    with project.connection() as db:
        row = db.execute(
            "SELECT record FROM documents WHERE kind=? AND id=? AND revision=1 "
            "AND json_extract(record, '$.data.source_id')=? "
            "AND json_extract(record, '$.data.source_sha256')=? AND length(record)<=?",
            (KIND, request["graph_id"], source["id"], source["sha256"], policy.memory_bytes // 32),
        ).fetchone()
    if row is None:
        raise PermissionError(unavailable)
    document = parse_json(row[0])
    record = document["data"]
    if (
        document["id"] != request["graph_id"]
        or document["kind"] != KIND
        or document["revision"] != 1
        or digest(record) != request["graph_sha256"]
    ):
        raise PermissionError(unavailable)
    validate(record, source, request["graph_id"])
    return record


def inspect_links(policy, project, request):
    data = authorized_graph(policy, project, request)
    bound_source(project, {key: request[key] for key in ("source_id", "source_sha256")})
    nodes = data["nodes"]
    children = Counter(edge[0] for edge in data["edges"])

    def endpoint(index):
        time, *xyz = nodes[index]
        t = time - data["first"]
        return dict(
            node_index=index,
            upstream_time_point=time,
            source_t=t,
            elapsed_s=t * data["interval_s"],
            xyz_px=xyz,
            xyz_um=[v * s for v, s in zip(xyz, data["spacing_xyz_um"], strict=True)],
        )

    rows = []
    count = 0
    for index, (a, b, link, marginal) in enumerate(data["edges"]):
        branch = children[a] == 2
        if "source_t" in request and nodes[a][0] - data["first"] != request["source_t"]:
            continue
        if request["filter"] == "branch" and not branch:
            continue
        if request["filter"] == "low-marginal" and (
            marginal is None or marginal >= request["marginal_below"]
        ):
            continue
        if count >= request["offset"] and len(rows) < request["limit"]:
            rows.append(
                dict(
                    edge_index=index,
                    earlier=endpoint(a),
                    later=endpoint(b),
                    two_daughter_parent=branch,
                    link_probability=link,
                    marginal_probability=marginal,
                )
            )
        count += 1
    next_offset = request["offset"] + len(rows)
    return dict(
        query=request,
        origin_declaration=data["origin"],
        aut_sha256=data["file_sha256"],
        series=data["series"],
        coordinate_frame="native image voxel centers",
        level=0,
        matching_link_count=count,
        rows=rows,
        next_offset=next_offset if next_offset < count else None,
    )
