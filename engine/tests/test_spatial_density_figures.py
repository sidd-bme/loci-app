"""Independent SVG/table-coordinate and immutable export oracles; generated images only."""

import copy
import csv
import hashlib
import io
import json
import math
import xml.etree.ElementTree as ET

import pytest
from test_research_spatial_density import density as density_fixture
from test_research_spatial_density import save

from loci_engine.research_project import canonical_json
from loci_engine.research_spatial_density import plan, preview, publish
from loci_engine.spatial_density_figures import NS, _axis, _panels, _svg, _y, contents


@pytest.fixture
def density(tmp_path):
    return density_fixture.__wrapped__(tmp_path)


def parse(files, filename):
    return ET.fromstring(files[filename])


def test_exact_saved_values_equal_donor_mean_and_independent_coordinates(density):
    wb, request, _, _ = density
    report = preview(wb.project, request)
    original = copy.deepcopy(report)
    files = contents(report)
    data = json.loads(files["density-figure-data.json"])
    assert report == original
    assert contents(report) == files
    assert data["report_hash"] == report["report_hash"]
    assert data["result_references"] == report["result_bindings"]
    assert data["source_references"] == report["source_snapshots"]
    panel = data["donor_panels"][0]
    assert len(panel["points"]) == 3
    assert panel["omitted"] == []
    assert len(panel["pair_connections"]) == 1
    # The independently known densities are 4/480, 1/240 and 1/240.
    assert sorted(p["value"] for p in panel["points"]) == [1 / 240, 1 / 240, 4 / 480]
    assert panel["axis"]["scale"] == 4 / 480
    assert panel["axis"]["normalized_domain"] == [-0.1, 1.1]
    top = panel["plot"]["top"]
    root = parse(files, "donor-density.svg")
    for circle in root.findall(f".//{{{NS}}}circle"):
        row = report["aggregation"]["donor_rows"][int(circle.get("data-row"))]
        expected_y = top + (15 if row["density"] == 4 / 480 else 90)
        assert float(circle.get("cy")) == pytest.approx(expected_y, abs=1e-6)
    means = {m["record"]["condition"]: m for m in panel["means"]}
    assert means["A"]["value"] == (4 / 480 + 1 / 240) / 2
    assert means["A"]["display"]["y"] == pytest.approx(top + 52.5)
    paired = data["paired_panels"][0]
    assert paired["points"][0]["value"] == 1 / 240 - 4 / 480
    assert paired["means"][0]["value"] == paired["points"][0]["value"]
    paired_svg = parse(files, "paired-density-change.svg")
    circle = paired_svg.find(f".//{{{NS}}}circle")
    assert float(circle.get("cy")) == pytest.approx(paired["plot"]["top"] + 165, abs=1e-6)
    assert data["unmatched_donors"] == report["aggregation"]["unmatched_donors"]
    embedded = json.loads(root.find(f"{{{NS}}}metadata").text)
    assert embedded["panels"] == data["donor_panels"]
    assert root.find(f".//{{{NS}}}text").text == "Donor density"
    all_text = " ".join(t.text or "" for t in root.findall(f".//{{{NS}}}text"))
    assert report["report_hash"] in all_text
    assert "um^2" in all_text and "Band 0: [0, 20) um" in all_text
    assert "Unmatched declared donors in this study: 1" in all_text


def multiband(density):
    wb, request, results, parents = density
    fields = []
    for index, result in enumerate(results):
        source_id = result["source_id"]
        old = wb.project.documents("sample", document_id=source_id)[0]
        malicious = '<script>alert("study")</script> & Ω'
        wb.project.put_document(
            "sample",
            source_id,
            {**old["data"], "study": "Second study" if index == 2 else malicious},
            expected_revision=old["revision"],
        )
        bindings = [
            {"result_id": r["id"], "revision_hash": r["revision_hash"]}
            for r in parents[index * 3 : index * 3 + 3]
        ]
        result = wb.execute(
            "spatial_distance_run",
            {
                **bindings[0],
                "compartment": bindings[1],
                "boundary": bindings[2],
                "band_edges": [0, 4, 8, 15, 30],
                "exclude_crop_border": True,
                "control": "Generated figure engineering fixture",
                "boundary_coverage": "Supplied column",
                "working_bytes": 16 * 1024**2,
            },
        )["result"]
        fields.append({"result_id": result["id"], "revision_hash": result["revision_hash"]})
    return wb, {**request, "fields": fields}


def test_multiple_studies_bands_xml_escaping_zero_area_and_defined_connections(density):
    wb, request = multiband(density)
    report = preview(wb.project, request)
    files = contents(report)
    data = json.loads(files["density-figure-data.json"])
    assert len(data["donor_panels"]) == 8
    assert len(data["paired_panels"]) == 8
    root = parse(files, "donor-density.svg")
    assert not root.findall(f".//{{{NS}}}script")
    assert not root.findall(f".//{{{NS}}}image")
    assert "&lt;script&gt;" in files["donor-density.svg"]
    assert any(p["study"] == '<script>alert("study")</script> & Ω' for p in data["donor_panels"])
    assert all("href" not in key for node in root.iter() for key in node.attrib)
    for panel in data["donor_panels"]:
        expected_omissions = (
            (1 if panel["study"] == "Second study" else 2) if panel["band_index"] == 3 else 0
        )
        assert len(panel["omitted"]) == expected_omissions
        if panel["band_index"] == 3:
            assert panel["points"] == [] and panel["means"] == []
            assert panel["pair_connections"] == []
        for line in panel["pair_connections"]:
            row = report["aggregation"]["paired_rows"][line["row"]]
            left, right = [
                report["aggregation"]["donor_rows"][line[k]] for k in ("left_row", "right_row")
            ]
            assert row["status"] == "defined"
            assert (
                left["biological_replicate"]
                == right["biological_replicate"]
                == row["biological_replicate"]
            )
            assert (left["condition"], right["condition"]) == ("A", "B")
    paired_values = [p["value"] for panel in data["paired_panels"] for p in panel["points"]]
    assert 0 in paired_values and any(v < 0 for v in paired_values)
    assert any(panel["omitted"] for panel in data["paired_panels"])
    for filename in ("donor-density.svg", "paired-density-change.svg"):
        svg = parse(files, filename)
        assert len(svg.findall(f"{{{NS}}}g")) == 8
        height = float(svg.get("height"))
        assert all(float(t.get("y")) < height for t in svg.findall(f".//{{{NS}}}text"))


@pytest.mark.parametrize(
    "values,paired",
    [
        ([0, 0], False),
        ([0, 0], True),
        ([-1e308, 1e308], True),
        ([5e-324, 1e-323], False),
        ([], False),
    ],
)
def test_axis_finite_for_zero_subnormal_extreme_and_undefined(values, paired):
    axis = _axis(values, paired)
    for value in values:
        y = _y(value, axis, 120)
        assert math.isfinite(y) and 120 <= y <= 300
    assert _y(0, axis, 120) >= 120


def test_unpaired_and_missing_donors_are_explicit(density):
    wb, request, results, _ = density
    request = {"fields": request["fields"]}
    for result in results:
        sample = wb.project.documents("sample", document_id=result["source_id"])[0]
        data = {k: v for k, v in sample["data"].items() if k != "biological_replicate"}
        wb.project.put_document("sample", sample["id"], data, expected_revision=sample["revision"])
    report = preview(wb.project, request)
    files = contents(report)
    assert "paired-density-change.svg" not in files
    data = json.loads(files["density-figure-data.json"])
    assert all(p["points"] == [] and p["means"] == [] for p in data["donor_panels"])
    assert not parse(files, "donor-density.svg").findall(f".//{{{NS}}}circle")


def test_malformed_report_cannot_be_rendered_as_saved_science(density):
    wb, request, _, _ = density
    report = preview(wb.project, request)
    report["aggregation"]["donor_rows"][0]["density"] *= 2
    with pytest.raises(ValueError):
        contents(report)


def test_xml_control_labels_fail_closed(density):
    wb, request, _, _ = density
    report = preview(wb.project, request)
    # Private display helper rejects invalid XML even if a future caller bypasses report validation.
    report["aggregation"]["phenotype_name"] = "bad\x01label"
    with pytest.raises(ValueError, match="XML"):
        _svg(report, _panels(report["aggregation"], False), False)


def test_atomic_native_export_manifest_binds_figures_and_preserves_csv(density, tmp_path):
    wb, request, _, _ = density
    saved = save(wb.project, request)
    expected = contents(saved["report"])
    target = tmp_path / "figure-package"
    export_plan = plan(wb.project, saved["report_id"])
    publish(wb.project, saved["report_id"], export_plan, target)
    manifest = json.loads((target / "manifest.json").read_text())
    assert len(list(target.iterdir())) == 16
    assert manifest["report_hash"] == saved["report"]["report_hash"]
    for name, content in expected.items():
        data = (target / name).read_bytes()
        record = next(r for r in manifest["files"] if r["name"] == name)
        assert data == content.encode()
        assert record["sha256"] == hashlib.sha256(data).hexdigest()
        assert record["size_bytes"] == len(data)
    rows = csv.DictReader(io.StringIO((target / "donor-rows.csv").read_text()))
    assert [{k: json.loads(v) for k, v in r.items()} for r in rows] == saved["report"][
        "aggregation"
    ]["donor_rows"]
    assert json.loads((target / "report.json").read_text()) == saved["report"]
    assert str(wb.project.root) not in canonical_json(expected)


def test_legacy_v1_projection_retains_exact_original_record_hashes(density):
    from loci_engine.research_spatial_density import _legacy_preview

    wb, request, _, _ = density
    report = _legacy_preview(wb.project, request)
    data = json.loads(contents(report)["density-figure-data.json"])
    assert len(data["result_references"]) == len(report["result_snapshots"])
    for ref, original in zip(data["result_references"], report["result_snapshots"], strict=True):
        assert ref["id"] == original["id"]
        assert ref["revision_hash"] == original["revision_hash"]
        assert ref["record_sha256"] == hashlib.sha256(canonical_json(original).encode()).hexdigest()


def test_frozen_renderer_needs_no_readable_source_module(density, monkeypatch, tmp_path):
    import loci_engine.spatial_density_figures as figures

    wb, request, _, _ = density
    report = preview(wb.project, request)
    expected = figures.contents(report)
    monkeypatch.setattr(figures, "__file__", str(tmp_path / "missing-frozen-module.py"))
    actual = figures.contents(report)
    assert actual == expected
    data = json.loads(actual["density-figure-data.json"])
    assert data["renderer"] == {
        "schema": figures.SCHEMA,
        "version": 1,
        "engine": report["software"]["engine"],
    }
    assert "renderer_sha256" not in data
