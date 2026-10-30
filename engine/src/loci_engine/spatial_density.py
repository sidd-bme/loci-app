"""Pure, exact-record spatial density aggregation; no image arrays or I/O.

Callers resolve/authorize source bytes, dependencies and immutable group definitions
before entry. This kernel verifies records and arithmetic without decoding masks.
Full input snapshots are retained, so its digest is a binding rather than a generic
study summary. Biological independence and phenotype meaning are user declarations.
"""

from __future__ import annotations

import copy
import hashlib
import math
import statistics
from collections import Counter, defaultdict

from .quantitative import MAX_OBJECTS, integer
from .research_groups import _record as validate_group_record
from .research_project import SHA_PATTERN, canonical_json, checked_id, checked_text
from .research_spatial import KIND, validate_record
from .study_analysis import validate_sample_metadata

SCHEMA = "loci.spatial-density-aggregation/v1"
MAX_FIELDS = 256
RULES = {
    "numerator": "Phenotype membership intersect eligible band labels, or all eligible labels",
    "denominator": "Entire sampled compartment band area, including when phenotype count is zero",
    "donor": "Pool counts and compartment areas within study, condition, biological_replicate",
    "condition": "Equal weight per donor with defined pooled density; sample SD requires n >= 2",
    "zero_area": "Density undefined (null), including when object count is zero",
    "pairing": "Only explicit condition pair; match biological_replicate within study",
    "contrast": "Right minus left donor density; descriptive effects only, no p-values",
}


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _number(value, name):
    if type(value) not in (int, float):
        raise ValueError(f"{name} must be finite and nonnegative")
    try:
        result = float(value)
    except OverflowError as exc:
        raise ValueError(f"{name} must be finite and nonnegative") from exc
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{name} must be finite and nonnegative")
    return result


def _finite(value):
    if value is not None and not math.isfinite(value):
        raise ValueError("Aggregation exceeds the finite numerical range")
    return value


def _density(count, area):
    return _finite(count / area) if area else None


def _describe(values):
    return {
        "n": len(values),
        "mean": _finite(statistics.mean(values)) if values else None,
        "sd": _finite(statistics.stdev(values)) if len(values) >= 2 else None,
        "median": _finite(statistics.median(values)) if values else None,
    }


def _sample(document, source_id):
    if document is None:
        return None
    if (
        not isinstance(document, dict)
        or set(document) != {"id", "kind", "revision", "updated_at", "data"}
        or document["id"] != source_id
        or document["kind"] != "sample"
    ):
        raise ValueError("Sample snapshot must be the exact source sample document")
    integer(document["revision"], "sample revision", 1, 2**63 - 1)
    checked_text(document["updated_at"], "sample timestamp", 64)
    return validate_sample_metadata(document["data"]).to_dict()


def _selection(result):
    selection = result["provenance"]["selection"]
    keys = {"x", "y", "width", "height", "t", "z", "c", "level"}
    if not isinstance(selection, dict) or set(selection) != keys:
        raise ValueError("Density requires an explicitly resolved single-plane selection")
    for key, value in selection.items():
        integer(value, f"selection {key}", 1 if key in {"width", "height"} else 0, 2**63 - 1)
    if result["arrays"]["labels"]["shape"] != [selection["height"], selection["width"]]:
        raise ValueError("Spatial selection and retained shape disagree")
    return selection


def _checked_field(field):
    if not isinstance(field, dict) or set(field) != {"result", "sample", "phenotype"}:
        raise ValueError("Each resolved field requires result, sample and phenotype snapshots")
    result = field["result"]
    if not isinstance(result, dict) or result.get("kind") != KIND:
        raise ValueError("Choose an exact spatial-distance-bands result record")
    checked_id(result.get("id"))
    checked_id(result.get("source_id"))
    if not isinstance(result.get("source_sha256"), str) or not SHA_PATTERN.fullmatch(
        result["source_sha256"]
    ):
        raise ValueError("Spatial field source fingerprint is invalid")
    if result.get("schema") != "loci.research-result/v1" or result.get("revision_hash") != _hash(
        {key: value for key, value in result.items() if key != "revision_hash"}
    ):
        raise ValueError("Spatial result revision failed integrity verification")
    validate_record(result)
    selection = _selection(result)
    metadata = _sample(field["sample"], result["source_id"])
    p = result["provenance"]
    spatial = p["spatial"]
    edges = p["accepted_request"]["band_edges"]
    measurements = p["measurements"]
    if not isinstance(measurements, list) or len(measurements) > MAX_OBJECTS:
        raise ValueError("Spatial measurements exceed the bounded object population")
    labels, eligible, exclusions = set(), defaultdict(set), Counter()
    for row in measurements:
        label = integer(row["label"], "spatial object label", 1, 0xFFFFFFFF)
        if label in labels:
            raise ValueError("Spatial object labels must be unique")
        labels.add(label)
        s = row["spatial"]
        distance = _number(s["distance"], "spatial distance")
        reasons = s["exclusions"]
        if (
            not isinstance(reasons, list)
            or any(
                r not in {"outside_compartment", "crop_border", "outside_bands"} for r in reasons
            )
            or len(set(reasons)) != len(reasons)
        ):
            raise ValueError("Spatial exclusion audit is invalid")
        candidate = next(
            (i for i in range(len(edges) - 1) if edges[i] <= distance < edges[i + 1]), None
        )
        if ("outside_bands" in reasons) != (candidate is None):
            raise ValueError("Spatial distance and band exclusion disagree")
        if "crop_border" in reasons and not p["accepted_request"]["exclude_crop_border"]:
            raise ValueError("Spatial border exclusion contradicts its policy")
        band = s["band_index"]
        if reasons:
            if band is not None:
                raise ValueError("Excluded spatial objects cannot enter a band")
            exclusions.update(reasons)
        else:
            integer(band, "object band", 0, len(edges) - 2)
            if band != candidate:
                raise ValueError("Spatial distance and eligible band disagree")
            eligible[band].add(label)
    bands = spatial["bands"]
    if not isinstance(bands, list) or len(bands) != len(edges) - 1:
        raise ValueError("Spatial band count disagrees with exact edges")
    from .workbench import geometry_from_dict

    pixel_area = math.prod(geometry_from_dict(p["geometry"]).orthogonal_spacing())
    if not math.isfinite(pixel_area) or pixel_area <= 0:
        raise ValueError("Spatial pixel area must be finite and positive")
    total_pixels = 0
    for index, band in enumerate(bands):
        pixels = integer(band["pixel_count"], "band pixel count", 0, 2**63 - 1)
        total_pixels += pixels
        area = _number(band["area"], "band area")
        count = integer(band["object_count"], "band object count", 0, MAX_OBJECTS)
        lower = _number(band["lower"], "band lower edge")
        upper = _number(band["upper"], "band upper edge")
        stored_density = band["density"]
        if stored_density is not None:
            stored_density = _number(stored_density, "band density")
        if (
            lower != edges[index]
            or upper != edges[index + 1]
            or area != pixels * pixel_area
            or count != len(eligible[index])
            or stored_density != _density(count, area)
        ):
            raise ValueError("Spatial band arithmetic disagrees with retained measurements")
    if total_pixels > selection["width"] * selection["height"]:
        raise ValueError("Spatial compartment pixels exceed selected field")
    phenotype = field["phenotype"]
    if phenotype is None:
        selected = labels
    else:
        group = validate_group_record(phenotype)
        receipt = group["receipt"]
        binding = {key: receipt[key] for key in ("result_id", "revision_hash")}
        allowed = [
            {"result_id": result["id"], "revision_hash": result["revision_hash"]},
            {key: spatial["inputs"]["objects"][key] for key in ("result_id", "revision_hash")},
        ]
        if (
            binding not in allowed
            or receipt["source_id"] != result["source_id"]
            or receipt["source_sha256"] != result["source_sha256"]
        ):
            raise ValueError("Phenotype has a stale source or exact result binding")
        population_binding = {
            key: receipt[key]
            for key in ("result_id", "revision_hash", "source_id", "source_sha256")
        }
        if receipt.get("population_sha256") != _hash(
            {**population_binding, "labels": sorted(labels)}
        ):
            raise ValueError("Phenotype population differs from exact spatial objects")
        selected = set(receipt["labels"])
        if not selected <= labels:
            raise ValueError("Phenotype membership contains unknown spatial labels")
    rows = []
    for index, band in enumerate(bands):
        count = len(eligible[index] & selected)
        rows.append(
            {
                "band_index": index,
                "lower": band["lower"],
                "upper": band["upper"],
                "object_count": count,
                "eligible_object_count": len(eligible[index]),
                "sampled_area": band["area"],
                "sampled_pixel_count": band["pixel_count"],
                "density": _density(count, band["area"]),
                "density_status": "defined" if band["area"] else "undefined_zero_area",
            }
        )
    return result, selection, metadata, rows, dict(sorted(exclusions.items()))


def aggregate_spatial_density(fields, *, phenotype_name=None, stratum=None, condition_pair=None):
    """Pool exact fields within donors, then describe donors with equal weight.

    ``fields`` is a list of ``{result, sample, phenotype}`` snapshots. ``sample``
    may be None (audit only); ``phenotype`` may be None for every field (all
    eligible objects), otherwise supply verified immutable population-group
    envelopes for every field and an explicit common ``phenotype_name``. A group
    may bind the spatial result itself or its exact retained objects parent.
    ``stratum={t,z}`` selects one plane/time stratum, retaining other inputs in
    audit; absent a stratum, mixed t/z are refused. ``condition_pair=[left,right]``
    requests matched-donor differences right minus left within each study.
    Caller validation of masks, source bytes and group definitions is required.
    """
    if not isinstance(fields, list) or not 1 <= len(fields) <= MAX_FIELDS:
        raise ValueError(f"Choose 1-{MAX_FIELDS} exact spatial fields")
    if stratum is not None:
        if not isinstance(stratum, dict) or set(stratum) != {"t", "z"}:
            raise ValueError("Explicit stratum requires exactly t and z")
        for key in stratum:
            integer(stratum[key], f"stratum {key}", 0, 2**63 - 1)
    if condition_pair is not None:
        if not isinstance(condition_pair, list) or len(condition_pair) != 2:
            raise ValueError("Explicit condition pair requires [left, right]")
        for condition in condition_pair:
            checked_text(condition, "paired condition")
        if condition_pair[0] == condition_pair[1]:
            raise ValueError("Paired conditions must differ")
    checked = [_checked_field(field) for field in fields]
    return _aggregate(fields, checked, phenotype_name, stratum, condition_pair, compact=False)


def _aggregate(fields, checked, phenotype_name, stratum, condition_pair, *, compact):
    modes = {field["phenotype"] is None for field in fields}
    if len(modes) != 1:
        raise ValueError("Cannot mix phenotype membership and all-object fields")
    if False in modes:
        checked_text(phenotype_name, "explicit common phenotype name")
    elif phenotype_name is not None:
        raise ValueError("All-object aggregation has no phenotype name")
    strata = {(s["t"], s["z"]) for _, s, _, _, _ in checked}
    if stratum is None:
        if len(strata) != 1:
            raise ValueError("Mixed timepoint or z strata require an explicit stratum")
        t, z = next(iter(strata))
        stratum = {"t": t, "z": z}
    seen_results, source_bindings, spatial_fields = set(), {}, []
    field_rows, audit, pools, conditions = [], [], {}, set()
    contract = None
    for field, (result, selection, metadata, rows, exclusions) in sorted(
        zip(fields, checked, strict=True), key=lambda pair: pair[1][0]["id"]
    ):
        if result["id"] in seen_results:
            raise ValueError("Duplicate spatial result bindings cannot be pooled")
        seen_results.add(result["id"])
        source_binding = (result["source_sha256"], _hash(field["sample"]))
        previous = source_bindings.setdefault(result["source_id"], source_binding)
        if previous != source_binding:
            raise ValueError(
                "Fields of the same source have conflicting source or sample snapshots"
            )
        reasons = []
        if any(selection[key] != stratum[key] for key in ("t", "z")):
            reasons.append("outside_explicit_stratum")
        else:
            p = result["provenance"]
            current = {
                "distance_unit": p["spatial"]["distance_unit"],
                "area_unit": p["spatial"]["area_unit"],
                "band_edges": p["accepted_request"]["band_edges"],
                "rules": p["spatial"]["rules"],
                "exclude_crop_border": p["accepted_request"]["exclude_crop_border"],
            }
            if contract is None:
                contract = current
            elif canonical_json(contract) != canonical_json(current):
                raise ValueError("Spatial units, band edges or endpoint/exclusion policies differ")
            for other, os in spatial_fields:
                if other["source_id"] != result["source_id"]:
                    continue
                if os["level"] != selection["level"]:
                    raise ValueError("Same-source pyramid levels cannot be pooled")
                if max(os["x"], selection["x"]) < min(
                    os["x"] + os["width"], selection["x"] + selection["width"]
                ) and max(os["y"], selection["y"]) < min(
                    os["y"] + os["height"], selection["y"] + selection["height"]
                ):
                    raise ValueError(
                        "Overlapping source selections cannot be pooled across channels"
                    )
            spatial_fields.append((result, selection))
        if metadata is None:
            reasons.append("missing_sample_metadata")
        elif metadata["biological_replicate"] is None:
            reasons.append("missing_biological_replicate")
        if metadata is not None and "outside_explicit_stratum" not in reasons:
            conditions.add((metadata["study"], metadata["condition"]))
        identity = {
            "result_id": result["id"],
            "revision_hash": result["revision_hash"],
            "source_id": result["source_id"],
            "source_sha256": result["source_sha256"],
            "result_record_sha256": result.get("record_sha256", _hash(result)),
            "sample_snapshot_sha256": _hash(field["sample"]),
            "phenotype_snapshot_sha256": (
                field["phenotype"].get("snapshot_sha256", _hash(field["phenotype"]))
                if field["phenotype"] is not None
                else _hash(None)
            ),
        }
        audit.append({**identity, "reasons": reasons, "object_exclusions": exclusions})
        for row in rows:
            field_rows.append(
                {
                    **identity,
                    "metadata": metadata,
                    "selection": selection,
                    "included_in_donor_pool": not reasons,
                    **row,
                }
            )
            if reasons:
                continue
            key = (
                metadata["study"],
                metadata["condition"],
                metadata["biological_replicate"],
                row["band_index"],
            )
            pool = pools.setdefault(key, {"counts": [], "areas": [], "result_ids": []})
            pool["counts"].append(row["object_count"])
            pool["areas"].append(row["sampled_area"])
            pool["result_ids"].append(result["id"])
    if contract is None:
        raise ValueError("Explicit stratum selects no spatial fields")
    donor_rows, condition_values = [], defaultdict(list)
    for (study, condition, donor, band), pool in sorted(pools.items()):
        count, area = sum(pool["counts"]), _finite(math.fsum(pool["areas"]))
        density = _density(count, area)
        donor_rows.append(
            {
                "study": study,
                "condition": condition,
                "biological_replicate": donor,
                "band_index": band,
                "object_count": count,
                "sampled_area": area,
                "density": density,
                "density_status": "defined" if area else "undefined_zero_area",
                "field_result_ids": pool["result_ids"],
                "n_fields": len(pool["result_ids"]),
            }
        )
        if density is not None:
            condition_values[study, condition, band].append(density)
    condition_rows = []
    for study, condition in sorted(conditions):
        for band in range(len(contract["band_edges"]) - 1):
            matching = [
                r
                for r in donor_rows
                if (r["study"], r["condition"], r["band_index"]) == (study, condition, band)
            ]
            condition_rows.append(
                {
                    "study": study,
                    "condition": condition,
                    "band_index": band,
                    **_describe(condition_values[study, condition, band]),
                    "n_donors_total": len(matching),
                    "n_undefined_zero_area": sum(r["density"] is None for r in matching),
                }
            )
    paired_rows, paired_summary, unmatched = [], [], []
    if condition_pair is not None:
        left, right = condition_pair
        for study in sorted({s for s, _ in conditions}):
            donor_sets = {
                c: {
                    r["biological_replicate"]
                    for r in donor_rows
                    if r["study"] == study and r["condition"] == c
                }
                for c in condition_pair
            }
            for condition, opposite in ((left, right), (right, left)):
                unmatched.extend(
                    {
                        "study": study,
                        "condition": condition,
                        "biological_replicate": d,
                        "reason": "missing_paired_condition",
                    }
                    for d in sorted(donor_sets[condition] - donor_sets[opposite])
                )
            lookup = {
                (r["condition"], r["biological_replicate"], r["band_index"]): r
                for r in donor_rows
                if r["study"] == study
            }
            for band in range(len(contract["band_edges"]) - 1):
                differences = []
                for donor in sorted(donor_sets[left] & donor_sets[right]):
                    a, b = lookup[left, donor, band], lookup[right, donor, band]
                    difference = (
                        _finite(b["density"] - a["density"])
                        if a["density"] is not None and b["density"] is not None
                        else None
                    )
                    if difference is not None:
                        differences.append(difference)
                    paired_rows.append(
                        {
                            "study": study,
                            "biological_replicate": donor,
                            "left_condition": left,
                            "right_condition": right,
                            "band_index": band,
                            "left_density": a["density"],
                            "right_density": b["density"],
                            "difference": difference,
                            "status": "defined"
                            if difference is not None
                            else "undefined_zero_area",
                        }
                    )
                paired_summary.append(
                    {
                        "study": study,
                        "left_condition": left,
                        "right_condition": right,
                        "band_index": band,
                        **_describe(differences),
                    }
                )
    output = {
        "schema": "loci.spatial-density-aggregation/v2" if compact else SCHEMA,
        "rules": dict(RULES),
        "contract": contract,
        "stratum": dict(stratum),
        "phenotype_name": phenotype_name,
        "condition_pair": condition_pair,
        "input_snapshots": sorted(copy.deepcopy(fields), key=lambda f: f["result"]["id"]),
        "field_rows": field_rows,
        "donor_rows": donor_rows,
        "condition_rows": condition_rows,
        "paired_rows": paired_rows,
        "paired_summary": paired_summary,
        "unmatched_donors": unmatched,
        "exclusion_audit": audit,
    }
    output["record_sha256"] = _hash(output)
    return copy.deepcopy(output)


def phenotype_binding(document):
    if document is None:
        return None
    group = validate_group_record(document)
    receipt = group["receipt"]
    return {
        "id": document["id"],
        "name": group["name"],
        "record_sha256": group["record_sha256"],
        "snapshot_sha256": _hash(document),
        **{
            k: receipt[k]
            for k in (
                "result_id",
                "revision_hash",
                "source_id",
                "source_sha256",
                "membership_sha256",
                "population_sha256",
            )
        },
    }


def project_spatial_density_field(field):
    """Retain endpoint-required projections, binding every omitted original byte."""
    result, selection, _, rows, exclusions = _checked_field(field)
    p = result["provenance"]
    return {
        "result": {
            "projection_schema": "loci.spatial-density-field/v2",
            **{k: result[k] for k in ("id", "revision_hash", "source_id", "source_sha256")},
            "record_sha256": _hash(result),
            "selection": copy.deepcopy(selection),
            "geometry": copy.deepcopy(p["geometry"]),
            "contract": {
                "distance_unit": p["spatial"]["distance_unit"],
                "area_unit": p["spatial"]["area_unit"],
                "band_edges": copy.deepcopy(p["accepted_request"]["band_edges"]),
                "rules": copy.deepcopy(p["spatial"]["rules"]),
                "exclude_crop_border": p["accepted_request"]["exclude_crop_border"],
            },
            "bands": copy.deepcopy(rows),
            "object_exclusions": exclusions,
        },
        "sample": copy.deepcopy(field["sample"]),
        "phenotype": phenotype_binding(field["phenotype"]),
    }


def _checked_projection(field):
    from .research_spatial import RULES as SPATIAL_RULES
    from .workbench import geometry_from_dict

    if not isinstance(field, dict) or set(field) != {"result", "sample", "phenotype"}:
        raise ValueError("Density projection requires exact result/sample/phenotype fields")
    r = field["result"]
    required = {
        "projection_schema",
        "id",
        "revision_hash",
        "source_id",
        "source_sha256",
        "record_sha256",
        "selection",
        "geometry",
        "contract",
        "bands",
        "object_exclusions",
    }
    if (
        not isinstance(r, dict)
        or set(r) != required
        or r["projection_schema"] != "loci.spatial-density-field/v2"
    ):
        raise ValueError("Invalid compact spatial density field projection")
    checked_id(r["id"])
    checked_id(r["source_id"])
    for key in ("revision_hash", "source_sha256", "record_sha256"):
        if not isinstance(r[key], str) or not SHA_PATTERN.fullmatch(r[key]):
            raise ValueError("Density projection requires exact result record hashes")
    selection = r["selection"]
    if not isinstance(selection, dict) or set(selection) != {
        "x",
        "y",
        "width",
        "height",
        "t",
        "z",
        "c",
        "level",
    }:
        raise ValueError("Density projection requires exact native-plane selection")
    for key, value in selection.items():
        integer(
            value, "density projection selection", 1 if key in {"width", "height"} else 0, 2**63 - 1
        )
    geometry = geometry_from_dict(r["geometry"])
    if geometry.axes != "YX" or geometry.unit == "pixel":
        raise ValueError("Density projection requires physical YX geometry")
    pixel_area = math.prod(geometry.orthogonal_spacing())
    c = r["contract"]
    if not isinstance(c, dict) or set(c) != {
        "distance_unit",
        "area_unit",
        "band_edges",
        "rules",
        "exclude_crop_border",
    }:
        raise ValueError("Invalid density projection endpoint contract")
    edges = c["band_edges"]
    if (
        c["distance_unit"] != geometry.unit
        or c["area_unit"] != f"{geometry.unit}^2"
        or c["rules"] != SPATIAL_RULES
        or type(c["exclude_crop_border"]) is not bool
    ):
        raise ValueError("Density projection units or endpoint policies disagree")
    if (
        not isinstance(edges, list)
        or not 2 <= len(edges) <= 33
        or any(
            type(e) not in (int, float) or not math.isfinite(e) or not 0 <= e <= 1e12 for e in edges
        )
        or any(a >= b for a, b in zip(edges, edges[1:], strict=False))
    ):
        raise ValueError("Density projection band edges are invalid")
    rows = r["bands"]
    if not isinstance(rows, list) or len(rows) != len(edges) - 1:
        raise ValueError("Density projection bands disagree with exact edges")
    total_pixels = 0
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or set(row) != {
            "band_index",
            "lower",
            "upper",
            "object_count",
            "eligible_object_count",
            "sampled_area",
            "sampled_pixel_count",
            "density",
            "density_status",
        }:
            raise ValueError("Invalid density projection band record")
        count = integer(row["object_count"], "phenotype band count", 0, MAX_OBJECTS)
        eligible = integer(row["eligible_object_count"], "eligible band count", 0, MAX_OBJECTS)
        pixels = integer(row["sampled_pixel_count"], "sampled band pixels", 0, 2**63 - 1)
        area = _number(row["sampled_area"], "sampled band area")
        _number(row["lower"], "band lower edge")
        _number(row["upper"], "band upper edge")
        if row["density"] is not None:
            _number(row["density"], "band density")
        total_pixels += pixels
        if (
            row["band_index"] != index
            or type(row["band_index"]) is not int
            or row["lower"] != edges[index]
            or row["upper"] != edges[index + 1]
            or count > eligible
            or area != pixels * pixel_area
            or row["density"] != _density(count, area)
            or row["density_status"] != ("defined" if area else "undefined_zero_area")
        ):
            raise ValueError("Density projection band arithmetic is inconsistent")
        if field["phenotype"] is None and count != eligible:
            raise ValueError("All-object density projection cannot exclude phenotype members")
    if (
        total_pixels > selection["height"] * selection["width"]
        or sum(row["eligible_object_count"] for row in rows) > MAX_OBJECTS
    ):
        raise ValueError("Density projection exceeds its native field population")
    exclusions = r["object_exclusions"]
    if not isinstance(exclusions, dict) or set(exclusions) - {
        "outside_compartment",
        "crop_border",
        "outside_bands",
    }:
        raise ValueError("Invalid density object exclusion audit")
    for value in exclusions.values():
        integer(value, "object exclusion count", 0, MAX_OBJECTS)
    phenotype = field["phenotype"]
    if phenotype is not None:
        if not isinstance(phenotype, dict) or set(phenotype) != {
            "id",
            "name",
            "record_sha256",
            "snapshot_sha256",
            "result_id",
            "revision_hash",
            "source_id",
            "source_sha256",
            "membership_sha256",
            "population_sha256",
        }:
            raise ValueError("Invalid compact phenotype binding")
        checked_id(phenotype["id"])
        checked_id(phenotype["result_id"])
        checked_id(phenotype["source_id"])
        checked_text(phenotype["name"], "Phenotype group name", 128)
        for key in (
            "record_sha256",
            "snapshot_sha256",
            "revision_hash",
            "source_sha256",
            "membership_sha256",
            "population_sha256",
        ):
            if not isinstance(phenotype[key], str) or not SHA_PATTERN.fullmatch(phenotype[key]):
                raise ValueError("Invalid phenotype binding hash")
        if (
            phenotype["source_id"] != r["source_id"]
            or phenotype["source_sha256"] != r["source_sha256"]
        ):
            raise ValueError("Phenotype projection source binding disagrees")
    # Internal arithmetic adapter only: never persisted as an original result.
    arithmetic_result = {
        k: r[k] for k in ("id", "revision_hash", "source_id", "source_sha256", "record_sha256")
    }
    arithmetic_result["provenance"] = {
        "spatial": {
            "distance_unit": c["distance_unit"],
            "area_unit": c["area_unit"],
            "rules": c["rules"],
        },
        "accepted_request": {"band_edges": edges, "exclude_crop_border": c["exclude_crop_border"]},
    }
    return arithmetic_result, selection, _sample(field["sample"], r["source_id"]), rows, exclusions


def aggregate_spatial_density_projections(
    fields, *, phenotype_name=None, stratum=None, condition_pair=None
):
    """Replay pooled donor arithmetic from compact endpoint projections.

    Source adapters must independently rederive every projection from its exact
    full result/group records and retained arrays before scientific disclosure.
    """
    if not isinstance(fields, list) or not 1 <= len(fields) <= MAX_FIELDS:
        raise ValueError("Choose 1-256 compact spatial fields")
    if stratum is not None:
        if not isinstance(stratum, dict) or set(stratum) != {"t", "z"}:
            raise ValueError("Explicit stratum requires t and z")
        for value in stratum.values():
            integer(value, "stratum", 0, 2**63 - 1)
    if condition_pair is not None:
        if (
            not isinstance(condition_pair, list)
            or len(condition_pair) != 2
            or condition_pair[0] == condition_pair[1]
        ):
            raise ValueError("Choose an explicit distinct condition pair")
        for value in condition_pair:
            checked_text(value, "paired condition")
    checked = [_checked_projection(f) for f in fields]
    return _aggregate(fields, checked, phenotype_name, stratum, condition_pair, compact=True)
