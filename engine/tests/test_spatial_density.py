"""Independent arithmetic on hand-constructed records; no image-array allocation."""

import copy
import hashlib

import pytest

from loci_engine.quantitative import Geometry
from loci_engine.research_project import canonical_json
from loci_engine.research_spatial import KIND, RULES, SCHEMA
from loci_engine.spatial_density import aggregate_spatial_density


def digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def rebind(item):
    r = item["result"]
    r["revision_hash"] = digest({k: v for k, v in r.items() if k != "revision_hash"})
    return item


def field(
    i,
    count=1,
    pixels=10,
    donor="D1",
    condition="A",
    source=None,
    x=0,
    t=0,
    z=0,
    unit="um",
    edges=None,
    labels=None,
    excluded=None,
    study="Study",
):
    rid, sid = f"{i:032x}", f"{source if source is not None else i + 1000:032x}"
    parent = {"result_id": f"{i + 2000:032x}", "revision_hash": "a" * 64}
    request = {
        **parent,
        "compartment": {"result_id": f"{i + 3000:032x}", "revision_hash": "b" * 64},
        "boundary": {"result_id": f"{i + 4000:032x}", "revision_hash": "c" * 64},
        "band_edges": edges or [0, 5],
        "exclude_crop_border": True,
        "control": "Synthetic arithmetic fixture",
        "boundary_coverage": "Declared boundary only",
        "working_bytes": 1024**2,
    }
    labels = labels if labels is not None else list(range(1, count + 1))
    measurements = [
        {"label": label, "spatial": {"distance": 1.0, "band_index": 0, "exclusions": []}}
        for label in labels
    ]
    measurements.extend(excluded or [])
    arrays = {
        n: {"shape": [10, 10], "sha256": str(j) * 64}
        for j, n in enumerate(
            ("image", "labels", "compartment_labels", "boundary_labels", "distance_bands"), 1
        )
    }
    inputs = {
        role: {
            **b,
            "labels_sha256": arrays["labels" if role == "objects" else f"{role}_labels"]["sha256"],
        }
        for role, b in (
            ("objects", parent),
            ("compartment", request["compartment"]),
            ("boundary", request["boundary"]),
        )
    }
    r = {
        "schema": "loci.research-result/v1",
        "kind": KIND,
        "id": rid,
        "source_id": sid,
        "source_sha256": "e" * 64,
        "parent_id": parent["result_id"],
        "arrays": arrays,
        "provenance": {
            "geometry": Geometry.diagonal((1, 1), unit).to_dict(),
            "selection": {
                "x": x,
                "y": 0,
                "width": 10,
                "height": 10,
                "t": t,
                "z": z,
                "c": 0,
                "level": 0,
            },
            "accepted_request": request,
            "measurements": measurements,
            "spatial": {
                "schema": SCHEMA,
                "rules": dict(RULES),
                "distance_unit": unit,
                "area_unit": f"{unit}^2",
                "inputs": inputs,
                "bands": [
                    {
                        "lower": request["band_edges"][0],
                        "upper": request["band_edges"][1],
                        "pixel_count": pixels,
                        "area": float(pixels),
                        "object_count": len(labels),
                        "density": len(labels) / pixels if pixels else None,
                    }
                ],
            },
        },
    }
    sample = {
        "id": sid,
        "kind": "sample",
        "revision": 3,
        "updated_at": "2026-10-30T00:00:00Z",
        "data": {
            "study": study,
            "sample": "Sample",
            "condition": condition,
            "biological_replicate": donor,
        },
    }
    return rebind({"result": r, "sample": sample, "phenotype": None})


def phenotype(item, labels, parent=True):
    r = item["result"]
    exact = (
        r["provenance"]["spatial"]["inputs"]["objects"]
        if parent
        else {"result_id": r["id"], "revision_hash": r["revision_hash"]}
    )
    binding = {
        "result_id": exact["result_id"],
        "revision_hash": exact["revision_hash"],
        "source_id": r["source_id"],
        "source_sha256": r["source_sha256"],
    }
    population = sorted(row["label"] for row in r["provenance"]["measurements"])
    receipt = {
        **binding,
        "labels": sorted(labels),
        "membership_sha256": digest({**binding, "labels": sorted(labels)}),
        "population_sha256": digest({**binding, "labels": population}),
    }
    gid = f"{int(r['id'], 16) + 5000:032x}"
    data = {
        "schema": "loci.population-group/v1",
        "id": gid,
        "name": "Explicit phenotype",
        "definition": {"kind": "fixed"},
        "receipt": receipt,
    }
    data["record_sha256"] = digest(data)
    item["phenotype"] = {
        "id": gid,
        "kind": "population_group",
        "revision": 1,
        "updated_at": "2026-10-30T00:00:00Z",
        "data": data,
    }
    return item


def test_pool_counts_and_areas_then_equal_weight_donors():
    inputs = [field(1), field(2, count=9, pixels=30), field(3, donor="D2")]
    saved = copy.deepcopy(inputs)
    out = aggregate_spatial_density(inputs)
    assert [r["density"] for r in out["donor_rows"]] == [0.25, 0.1]
    row = out["condition_rows"][0]
    assert row["n"] == 2
    assert row["mean"] == pytest.approx(0.175)
    assert row["sd"] == pytest.approx((0.15**2 / 2) ** 0.5)
    assert row["median"] == pytest.approx(0.175)
    assert row["mean"] != pytest.approx((0.1 + 0.3 + 0.1) / 3)
    assert out["input_snapshots"] == saved
    assert inputs == saved
    assert out["record_sha256"] == digest({k: v for k, v in out.items() if k != "record_sha256"})
    assert aggregate_spatial_density(saved[::-1]) == out
    inputs[0]["sample"]["data"]["sample"] = "Later edit"
    assert out["input_snapshots"] == saved


def test_missing_donors_and_sample_audit_only():
    inputs = [field(1, donor=None), field(2, donor=None), field(3)]
    inputs[2]["sample"] = None
    out = aggregate_spatial_density(inputs)
    assert out["donor_rows"] == []
    assert out["condition_rows"][0]["n"] == 0
    assert all(not r["included_in_donor_pool"] for r in out["field_rows"])
    assert [r["reasons"] for r in out["exclusion_audit"]] == [
        ["missing_biological_replicate"],
        ["missing_biological_replicate"],
        ["missing_sample_metadata"],
    ]


def test_explicit_pairs_match_within_study_and_list_unmatched():
    inputs = [
        field(1),
        field(2, condition="B", count=3),
        field(3, donor="D2"),
        field(4, donor="D3", condition="B"),
        field(5, study="Other", condition="B"),
    ]
    assert aggregate_spatial_density(inputs)["paired_rows"] == []
    out = aggregate_spatial_density(inputs, condition_pair=["A", "B"])
    assert len(out["paired_rows"]) == 1
    assert out["paired_rows"][0]["difference"] == pytest.approx(0.2)
    assert out["paired_summary"][1]["n"] == 1
    assert out["paired_summary"][1]["sd"] is None
    assert {
        (r["study"], r["condition"], r["biological_replicate"]) for r in out["unmatched_donors"]
    } == {("Study", "A", "D2"), ("Study", "B", "D3"), ("Other", "B", "D1")}
    assert "pvalue" not in canonical_json(out)


def test_overlap_across_channels_duplicates_and_touching_crops():
    a, b = field(1, source=100), field(2, source=100)
    b["result"]["provenance"]["selection"]["c"] = 1
    rebind(b)
    with pytest.raises(ValueError, match="Overlapping"):
        aggregate_spatial_density([a, b])
    with pytest.raises(ValueError, match="Duplicate"):
        aggregate_spatial_density([a, a])
    b["result"]["provenance"]["selection"]["x"] = 10
    rebind(b)
    out = aggregate_spatial_density([a, b])
    assert out["donor_rows"][0]["object_count"] == 2
    assert out["donor_rows"][0]["sampled_area"] == 20


@pytest.mark.parametrize("kind", ["unit", "edge", "policy", "time", "z"])
def test_incompatible_units_edges_policies_or_strata_refused(kind):
    a, b = (
        field(1),
        field(
            2,
            unit="mm" if kind == "unit" else "um",
            edges=[0, 6] if kind == "edge" else None,
            t=int(kind == "time"),
            z=int(kind == "z"),
        ),
    )
    if kind == "policy":
        b["result"]["provenance"]["accepted_request"]["exclude_crop_border"] = False
        rebind(b)
    with pytest.raises(ValueError, match="units|policies|strata"):
        aggregate_spatial_density([a, b])


def test_explicit_stratum_retains_excluded_records():
    out = aggregate_spatial_density([field(1), field(2, t=1, count=9)], stratum={"t": 0, "z": 0})
    assert out["donor_rows"][0]["object_count"] == 1
    assert out["exclusion_audit"][1]["reasons"] == ["outside_explicit_stratum"]
    assert len(out["input_snapshots"]) == 2


@pytest.mark.parametrize("parent", [True, False])
def test_large_sparse_phenotype_intersection_preserves_area_and_exclusions(parent):
    excluded = [
        {
            "label": 4_000_000_001,
            "spatial": {"distance": 1, "band_index": None, "exclusions": ["crop_border"]},
        }
    ]
    a = phenotype(
        field(1, labels=[3, 4_000_000_000], excluded=excluded),
        [4_000_000_000, 4_000_000_001],
        parent=parent,
    )
    out = aggregate_spatial_density([a], phenotype_name="User-declared phenotype")
    row = out["field_rows"][0]
    assert (
        row["object_count"],
        row["eligible_object_count"],
        row["sampled_area"],
        row["density"],
    ) == (1, 2, 10, 0.1)
    assert out["exclusion_audit"][0]["object_exclusions"] == {"crop_border": 1}
    assert out["condition_rows"][0]["sd"] is None


@pytest.mark.parametrize("key", ["revision_hash", "population_sha256"])
def test_stale_phenotype_or_population_refused_after_document_rehash(key):
    a = phenotype(field(1), [1])
    data = a["phenotype"]["data"]
    data["receipt"][key] = "0" * 64
    if key == "revision_hash":
        receipt = data["receipt"]
        binding = {
            k: receipt[k] for k in ("result_id", "revision_hash", "source_id", "source_sha256")
        }
        receipt["membership_sha256"] = digest({**binding, "labels": receipt["labels"]})
    data["record_sha256"] = digest({k: v for k, v in data.items() if k != "record_sha256"})
    with pytest.raises(ValueError, match="stale|population"):
        aggregate_spatial_density([a], phenotype_name="Explicit")


def test_zero_area_and_zero_count_have_distinct_semantics():
    out = aggregate_spatial_density([field(1, count=0, pixels=0), field(2, count=0, donor="D2")])
    assert [r["density"] for r in out["donor_rows"]] == [None, 0]
    assert out["condition_rows"][0]["n"] == 1
    assert out["condition_rows"][0]["n_undefined_zero_area"] == 1
    assert out["condition_rows"][0]["mean"] == 0
    positive = aggregate_spatial_density([field(3, pixels=0)])
    assert positive["donor_rows"][0]["density"] is None
    paired = aggregate_spatial_density(
        [field(4, pixels=0), field(5, condition="B")], condition_pair=["A", "B"]
    )
    assert paired["paired_rows"][0]["difference"] is None
    assert paired["paired_summary"][0]["n"] == 0


@pytest.mark.parametrize("mutation", ["count", "area", "density", "label", "revision", "distance"])
def test_corrupt_arithmetic_or_revision_refused(mutation):
    a = field(1)
    p = a["result"]["provenance"]
    if mutation in {"count", "area", "density"}:
        name = {"count": "object_count", "area": "area", "density": "density"}[mutation]
        p["spatial"]["bands"][0][name] = 9
    elif mutation == "label":
        p["measurements"].append(copy.deepcopy(p["measurements"][0]))
    elif mutation == "distance":
        p["measurements"][0]["spatial"]["distance"] = float("inf")
    else:
        a["result"]["revision_hash"] = "f" * 64
    if mutation not in {"revision", "distance"}:
        rebind(a)
    with pytest.raises(ValueError):
        aggregate_spatial_density([a])


def test_mixed_membership_conflicting_metadata_and_pyramid_levels_refused():
    with pytest.raises(ValueError, match="mix"):
        aggregate_spatial_density([phenotype(field(1), [1]), field(2)], phenotype_name="Explicit")
    a, b = field(3, source=100), field(4, source=100, x=10)
    b["sample"]["data"]["condition"] = "B"
    with pytest.raises(ValueError, match="conflicting"):
        aggregate_spatial_density([a, b])
    b["sample"] = copy.deepcopy(a["sample"])
    b["result"]["provenance"]["selection"]["level"] = 1
    rebind(b)
    with pytest.raises(ValueError, match="pyramid"):
        aggregate_spatial_density([a, b])


def test_multiple_half_open_bands_and_exclusion_reasons_remain_distinct():
    a = field(1, count=0)
    p = a["result"]["provenance"]
    p["accepted_request"]["band_edges"] = [0, 2, 5]
    p["measurements"] = [
        {"label": 1, "spatial": {"distance": 0, "band_index": 0, "exclusions": []}},
        {"label": 3, "spatial": {"distance": 2, "band_index": 1, "exclusions": []}},
        {
            "label": 9,
            "spatial": {
                "distance": 5,
                "band_index": None,
                "exclusions": ["outside_bands", "crop_border"],
            },
        },
        {
            "label": 10,
            "spatial": {"distance": 3, "band_index": None, "exclusions": ["outside_compartment"]},
        },
    ]
    p["spatial"]["bands"] = [
        {"lower": 0, "upper": 2, "pixel_count": 10, "area": 10, "object_count": 1, "density": 0.1},
        {"lower": 2, "upper": 5, "pixel_count": 20, "area": 20, "object_count": 1, "density": 0.05},
    ]
    out = aggregate_spatial_density([rebind(a)])
    assert [r["density"] for r in out["donor_rows"]] == [0.1, 0.05]
    assert out["exclusion_audit"][0]["object_exclusions"] == {
        "crop_border": 1,
        "outside_bands": 1,
        "outside_compartment": 1,
    }


@pytest.mark.parametrize("kind", ["boolean_density", "boolean_lower", "nan_area", "negative_area"])
def test_non_numeric_boolean_or_invalid_band_values_refused(kind):
    a = field(1, count=0)
    band = a["result"]["provenance"]["spatial"]["bands"][0]
    if kind == "boolean_density":
        band["density"] = False
    elif kind == "boolean_lower":
        band["lower"] = False
    elif kind == "nan_area":
        band["area"] = float("nan")
    else:
        band["area"] = -1
    if kind != "nan_area":
        rebind(a)
    with pytest.raises(ValueError):
        aggregate_spatial_density([a])


def test_compact_endpoint_projection_preserves_exact_full_kernel_math():
    from loci_engine.spatial_density import (
        aggregate_spatial_density_projections,
        project_spatial_density_field,
    )

    fields = [
        field(1, count=2, pixels=10),
        field(2, count=1, pixels=100),
        field(3, count=3, pixels=10, donor="D2"),
    ]
    full = aggregate_spatial_density(fields)
    compact = aggregate_spatial_density_projections(
        [project_spatial_density_field(f) for f in fields]
    )
    assert compact["schema"] == "loci.spatial-density-aggregation/v2"
    for key in (
        "field_rows",
        "donor_rows",
        "condition_rows",
        "paired_rows",
        "paired_summary",
        "exclusion_audit",
        "rules",
        "contract",
        "stratum",
    ):
        assert compact[key] == full[key]
    assert "measurements" not in canonical_json(compact)
