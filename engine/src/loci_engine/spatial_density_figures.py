"""Deterministic editable SVG views of immutable donor-density table values.

No scientific endpoint is calculated here. Coordinates and ticks are display
transforms; all points and mean marks cite exact saved table rows.
"""

from __future__ import annotations

import hashlib
import math
import textwrap
import xml.etree.ElementTree as ET

from .research_project import canonical_json

SCHEMA = "loci.spatial-density-figures/v1"
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)


def _node(parent, name, text=None, **attrs):
    element = ET.SubElement(parent, f"{{{NS}}}{name}", {k: str(v) for k, v in attrs.items()})
    if text is not None:
        value = str(text)
        if any(
            not (
                c in "\t\n\r"
                or 0x20 <= ord(c) <= 0xD7FF
                or 0xE000 <= ord(c) <= 0xFFFD
                or 0x10000 <= ord(c) <= 0x10FFFF
            )
            for c in value
        ):
            raise ValueError("Density figure labels contain unsupported XML characters")
        element.text = value
    return element


def _text(parent, x, y, value, size=13, **attrs):
    return _node(parent, "text", value, x=x, y=y, **{"font-size": size, **attrs})


def _lines(value, width=90):
    return textwrap.wrap(" ".join(str(value).split()), width=width) or [""]


def _axis(values, paired):
    scale = max((abs(v) for v in values), default=0.0) or 1.0
    lower = min([0.0, *(v / scale for v in values)])
    upper = max([0.0, *(v / scale for v in values)])
    if lower == upper:
        lower, upper = (-1.0, 1.0) if paired else (0.0, 1.0)
    padding = (upper - lower) * 0.1
    return {
        "scale": scale,
        "normalized_domain": [lower - padding, upper + padding],
        "normalized_tick_domain": [lower, upper],
    }


def _y(value, axis, top):
    low, high = axis["normalized_domain"]
    return top + 180 * (1 - (value / axis["scale"] - low) / (high - low))


def _refs(report):
    if "result_bindings" in report:
        return report["result_bindings"]
    return [
        {
            "id": row["id"],
            "revision_hash": row["revision_hash"],
            "source_id": row["source_id"],
            "source_sha256": row["source_sha256"],
            "record_sha256": hashlib.sha256(canonical_json(row).encode()).hexdigest(),
        }
        for row in report["result_snapshots"]
    ]


def _panels(aggregation, paired):
    donors = aggregation["donor_rows"]
    pairs = aggregation["paired_rows"]
    panels = []
    keys = sorted({(r["study"], r["band_index"]) for r in aggregation["condition_rows"]})
    for study, band in keys:
        donor_rows = [
            (i, r) for i, r in enumerate(donors) if (r["study"], r["band_index"]) == (study, band)
        ]
        pair_rows = [
            (i, r) for i, r in enumerate(pairs) if (r["study"], r["band_index"]) == (study, band)
        ]
        rows = pair_rows if paired else donor_rows
        value_key = "difference" if paired else "density"
        summary_table = "paired_summary" if paired else "condition_rows"
        summaries = [
            (i, r)
            for i, r in enumerate(aggregation[summary_table])
            if (r["study"], r["band_index"]) == (study, band)
        ]
        panel = {
            "study": study,
            "band_index": band,
            "conditions": list(aggregation["condition_pair"])
            if paired
            else sorted(
                {
                    r["condition"]
                    for r in aggregation["condition_rows"]
                    if (r["study"], r["band_index"]) == (study, band)
                }
            ),
            "points": [
                {
                    "table": "paired_rows" if paired else "donor_rows",
                    "row": i,
                    "value": r[value_key],
                    "record": r,
                }
                for i, r in rows
                if r[value_key] is not None
            ],
            "means": [
                {"table": summary_table, "row": i, "value": r["mean"], "record": r}
                for i, r in summaries
                if r["mean"] is not None
            ],
            "omitted": [
                {
                    "table": "paired_rows" if paired else "donor_rows",
                    "row": i,
                    "reason": r["status"] if paired else r["density_status"],
                }
                for i, r in rows
                if r[value_key] is None
            ],
            "pair_connections": [],
        }
        if not paired:
            lookup = {(r["condition"], r["biological_replicate"]): i for i, r in donor_rows}
            for i, r in pair_rows:
                if r["difference"] is not None:
                    panel["pair_connections"].append(
                        {
                            "table": "paired_rows",
                            "row": i,
                            "left_row": lookup[r["left_condition"], r["biological_replicate"]],
                            "right_row": lookup[r["right_condition"], r["biological_replicate"]],
                        }
                    )
        values = [p["value"] for p in panel["points"] + panel["means"]]
        if any(not math.isfinite(v) for v in values):
            raise ValueError("Density figures require finite saved endpoints")
        panel["axis"] = _axis(values, paired)
        panels.append(panel)
    return panels


def _svg(report, panels, paired):
    a = report["aggregation"]
    width = max([880, *(200 + 150 * len(p["conditions"]) for p in panels)])
    height = 90 + sum(
        400 + 17 * max([1, *(len(_lines(c, 22)) for c in p["conditions"]), len(_lines(p["study"]))])
        for p in panels
    )
    root = ET.Element(
        f"{{{NS}}}svg",
        {
            "viewBox": f"0 0 {width} {height}",
            "width": str(width),
            "height": str(height),
            "role": "img",
            "font-family": "Arial, Helvetica, sans-serif",
            "fill": "#202c35",
        },
    )
    kind = "Paired density change (right minus left)" if paired else "Donor density"
    _node(root, "title", kind)
    _node(root, "desc", "Saved donor values and equal-donor means; no significance testing.")
    _node(root, "rect", x=0, y=0, width=width, height=height, fill="white")
    _text(root, 28, 30, kind, 20)
    context = (
        f"Phenotype: {a['phenotype_name'] or 'all eligible objects'}; "
        f"stratum: {canonical_json(a['stratum'])}; "
        f"density unit: objects/{a['contract']['area_unit']}"
    )
    for j, line in enumerate(_lines(context, 110)):
        _text(root, 28, 52 + j * 16, line, 12)
    offset = 90 + max(0, len(_lines(context, 110)) - 2) * 16
    if not panels:
        _text(
            root,
            28,
            offset,
            "No eligible declared donor/condition panels. See exclusion-audit.csv.",
        )
        offset += 50
    for number, panel in enumerate(panels):
        group = _node(
            root,
            "g",
            id=f"panel-{number}",
            **{"data-study": panel["study"], "data-band": panel["band_index"]},
        )
        heading = _lines(panel["study"])
        edges = a["contract"]["band_edges"]
        band = panel["band_index"]
        for j, line in enumerate(heading):
            _text(group, 28, offset + j * 17, line, 15, **{"font-weight": "bold"})
        _text(
            group,
            28,
            offset + len(heading) * 17,
            f"Band {band}: [{edges[band]!r}, {edges[band + 1]!r}) {a['contract']['distance_unit']}",
        )
        top = offset + len(heading) * 17 + 33
        left, right = 110, width - 70
        axis = panel["axis"]
        panel["plot"] = {"left": left, "right": right, "top": top, "height": 180}
        _node(group, "line", x1=left, x2=left, y1=top, y2=top + 180, stroke="#52616b")
        low, high = axis["normalized_tick_domain"]
        for tick in range(5):
            normalized = low * (1 - tick / 4) + high * (tick / 4)
            value = normalized * axis["scale"]
            y = _y(value, axis, top)
            _node(
                group,
                "line",
                x1=left,
                x2=right,
                y1=f"{y:.6f}",
                y2=f"{y:.6f}",
                stroke="#dce1e5",
                **{"stroke-width": 0.7},
            )
            _text(group, left - 10, y + 4, f"{value:.5g}", 11, **{"text-anchor": "end"})
        conditions = panel["conditions"]
        centers = {
            c: left + (i + 0.5) * (right - left) / len(conditions) for i, c in enumerate(conditions)
        }
        points_by_row = {}
        for point in panel["points"]:
            row = point["record"]
            condition = row["condition"] if not paired else conditions[0]
            x = (left + right) / 2 if paired else centers[condition]
            # Deterministic visual offsets separate coincident donor points.
            peer_rows = sorted(
                p["row"] for p in panel["points"] if paired or p["record"]["condition"] == condition
            )
            rank = peer_rows.index(point["row"])
            x += (rank - (len(peer_rows) - 1) / 2) * min(8, 56 / max(1, len(peer_rows)))
            point["display"] = {"x": x, "y": _y(point["value"], axis, top)}
            points_by_row[point["row"]] = point
        for line in panel["pair_connections"]:
            start, end = (
                points_by_row[line["left_row"]]["display"],
                points_by_row[line["right_row"]]["display"],
            )
            _node(
                group,
                "line",
                x1=f"{start['x']:.6f}",
                y1=f"{start['y']:.6f}",
                x2=f"{end['x']:.6f}",
                y2=f"{end['y']:.6f}",
                stroke="#a4adb4",
                **{"data-paired-row": line["row"]},
            )
        for point in panel["points"]:
            d = point["display"]
            circle = _node(
                group,
                "circle",
                cx=f"{d['x']:.6f}",
                cy=f"{d['y']:.6f}",
                r=4,
                fill="#2b637d",
                **{"data-table": point["table"], "data-row": point["row"]},
            )
            _node(circle, "title", f"{point['record']['biological_replicate']}: {point['value']!r}")
        for mean in panel["means"]:
            x = (left + right) / 2 if paired else centers[mean["record"]["condition"]]
            y = _y(mean["value"], axis, top)
            mean["display"] = {"x": x, "y": y}
            _node(
                group,
                "line",
                x1=f"{x - 18:.6f}",
                x2=f"{x + 18:.6f}",
                y1=f"{y:.6f}",
                y2=f"{y:.6f}",
                stroke="#172d39",
                **{"stroke-width": 3, "data-table": mean["table"], "data-row": mean["row"]},
            )
        labels = [f"{conditions[1]} minus {conditions[0]}"] if paired else conditions
        for label in labels:
            x = (left + right) / 2 if paired else centers[label]
            for j, line in enumerate(_lines(label, 22)):
                _text(group, x, top + 204 + j * 17, line, 12, **{"text-anchor": "middle"})
        label_lines = max(len(_lines(label, 22)) for label in labels)
        bottom = top + 218 + label_lines * 17
        _text(
            group,
            28,
            bottom,
            f"{len(panel['points'])} defined donor {'pairs' if paired else 'values'}; "
            f"{len(panel['omitted'])} undefined "
            f"{'pairs' if paired else 'zero-area donor values'} omitted.",
            12,
        )
        _text(
            group,
            28,
            bottom + 18,
            "Points: donors; dark marks: saved equal-donor means. "
            + (
                "Differences: right minus left."
                if paired
                else "Lines: defined declared pairs only."
            ),
            12,
        )
        unmatched = sum(r["study"] == panel["study"] for r in a["unmatched_donors"])
        if a["condition_pair"] is not None:
            _text(
                group, 28, bottom + 36, f"Unmatched declared donors in this study: {unmatched}.", 12
            )
        offset = bottom + 85
    height = offset + 25
    root.set("height", str(height))
    root.set("viewBox", f"0 0 {width} {height}")
    root.find(f"{{{NS}}}rect").set("height", str(height))
    _text(root, 28, height - 24, f"Report SHA-256: {report['report_hash']}", 11)
    # JSON metadata contains original unrounded values, table row addresses and display transforms.
    _node(
        root,
        "metadata",
        canonical_json({"schema": SCHEMA, "report_hash": report["report_hash"], "panels": panels}),
    )
    return ET.tostring(root, encoding="unicode", xml_declaration=True) + "\n"


def contents(report):
    """Return at most three export files; validate the original report first."""
    from .research_spatial_density import validate_report

    report = validate_report(report)
    a = report["aggregation"]
    donor = _panels(a, False)
    paired = _panels(a, True) if a["condition_pair"] is not None else []
    files = {"donor-density.svg": _svg(report, donor, False)}
    if a["condition_pair"] is not None:
        files["paired-density-change.svg"] = _svg(report, paired, True)
    data = {
        "schema": SCHEMA,
        "renderer": {"schema": SCHEMA, "version": 1, "engine": report["software"]["engine"]},
        "report_hash": report["report_hash"],
        "contract": a["contract"],
        "stratum": a["stratum"],
        "phenotype_name": a["phenotype_name"],
        "condition_pair": a["condition_pair"],
        "rules": a["rules"],
        "result_references": _refs(report),
        "source_references": report["source_snapshots"],
        "phenotype_references": report.get(
            "phenotype_bindings",
            [
                {
                    "id": g["id"],
                    "record_sha256": g["data"]["record_sha256"],
                    "membership_sha256": g["data"]["receipt"]["membership_sha256"],
                }
                for g in report.get("phenotype_groups", [])
            ],
        ),
        "donor_panels": donor,
        "paired_panels": paired,
        "unmatched_donors": a["unmatched_donors"],
        "display_policy": "Linear axes include zero; normalized scale prevents overflow. "
        "Deterministic horizontal offsets are visual only. Tick labels are rounded; "
        "JSON values and CSV tables retain full precision. No SD, confidence interval "
        "or significance claim is drawn. Declared donors do not prove independence.",
        "authoritative_tables": [
            "donor-rows.csv",
            "condition-rows.csv",
            "paired-rows.csv",
            "paired-summary.csv",
        ],
    }
    files["density-figure-data.json"] = canonical_json(data) + "\n"
    return files
