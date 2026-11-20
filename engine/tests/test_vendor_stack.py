from __future__ import annotations

import copy
import hashlib
import os
import xml.etree.ElementTree as ET
from dataclasses import asdict
from pathlib import Path

import numpy as np
import pytest
import tifffile

from loci_engine import vendor_conversion as vendor
from loci_engine import vendor_stack
from loci_engine.native_image import NativeImageSession
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_vendor import convert_and_import, validate_derivation
from loci_engine.vendor_acquisition import Acquisition, validate_evidence, verify_acquisition
from loci_engine.workbench import Workbench

GRID = {
    "index": 0,
    "dtype": "uint16",
    "dimensions": dict(x=9, y=8, c=3, z=4, t=5),
    "dimension_order": "XYZCT",
    "channel_names": ["First", "Second", "Third"],
    "declared_channel_names": ["First", "Second", "Third"],
    "samples_per_channel": [1, 1, 1],
    "calibration": None,
}
BOX = dict(series=0, c=1, z=1, t=2, end_exclusive=dict(c=3, z=4, t=4), crop=[2, 1, 6, 5])


@pytest.mark.parametrize(
    "mutation",
    [
        {"end_exclusive": [2, 3, 4]},
        {"end_exclusive": {"c": 2, "t": 4}},
        {"end_exclusive": {"c": 2, "z": True, "t": 4}},
        {"end_exclusive": {"c": 2, "z": 1, "t": 4}},
        {"end_exclusive": {"c": 2, "z": 5, "t": 4}},
        {"crop": [5, 4, 6, 5]},
        {"max_output_bytes": 719},
    ],
)
def test_invalid_range_fails_before_pixel_read(mutation):
    with pytest.raises(vendor.VendorConversionError):
        vendor._resolve_selection(vendor._request({**BOX, **mutation}), [GRID])


def test_rgb_anywhere_in_range_and_excessive_plane_count_refused():
    with pytest.raises(vendor.VendorConversionError, match="scalar"):
        vendor._resolve_selection(
            vendor._request(BOX), [{**GRID, "samples_per_channel": [1, 1, 3]}]
        )
    with pytest.raises(vendor.VendorConversionError, match="budget"):
        vendor._resolve_selection(
            vendor._request({**BOX, "end_exclusive": dict(c=3, z=4, t=5000)}),
            [{**GRID, "dimensions": {**GRID["dimensions"], "t": 5000}}],
        )


def _runtime():
    java = os.environ.get("LOCI_QA_JAVA")
    jar = os.environ.get("LOCI_QA_BIOFORMATS_JAR")
    if not java or not jar:
        pytest.skip("explicit approved JAR and source-capable Java required")
    return java, jar


def _fixture(extension):
    root = os.environ.get("LOCI_VENDOR_FIXTURE_DIR")
    if not root:
        pytest.skip("explicit public vendor fixture directory required")
    return Path(root) / f"sample.{extension}"


def test_real_reader_time_coordinate_selection_against_known_big_endian_input(
    tmp_path, monkeypatch
):
    java, jar = _runtime()
    monkeypatch.setitem(vendor_stack.VENDOR_READERS, ".tif", "loci.formats.in.OMETiffReader")
    # Exercise the internal Bio-Formats adapter on independently known pixels.
    # The public converter still admits only the documented vendor extensions.
    source = tmp_path / "control.ome.tif"
    values = np.arange(5 * 3 * 4 * 8 * 9, dtype=">u2").reshape(5, 3, 4, 8, 9)
    tifffile.imwrite(source, values, ome=True, photometric="minisblack", metadata={"axes": "TCZYX"})
    selected = vendor._request(BOX)
    output = tmp_path / "result.ome.tif"
    source_grid = {**GRID, "dimension_order": "XYZCT"}
    # Use the regular pin/ownership checks before executing the reference library.
    pin = _fixture("lif")
    runtime = vendor._validate_runtime(pin, jar, java, heap_mib=512, timeout_seconds=60)
    runtime = vendor._private_jar_copy(runtime, tmp_path)
    from dataclasses import replace

    runtime = replace(runtime, source=source, source_identity=vendor._identity(source))
    artifact = vendor_stack.convert_stack(
        runtime,
        selected,
        source_grid,
        tuple(BOX["crop"]),
        [2, 2, 3, 5, 6],
        tmp_path,
        output,
        Acquisition({}, {}),
    )
    expected = values[2:4, 1:3, 1:4, 1:6, 2:8]
    np.testing.assert_array_equal(tifffile.imread(output), expected)
    assert artifact[1] == hashlib.sha256(expected.astype("<u2").tobytes()).hexdigest()
    assert artifact[2] is None
    assert artifact[3]["planes_verified"] == 12


def test_real_lif_range_reopens_and_matches_independent_bfconvert(tmp_path):
    java, jar = _runtime()
    source = _fixture("lif")
    fingerprint = "a4bc49b2fb9f1adf3a66872d01e1450db1d898fc7f4d2386aefa28836c2ec419"
    project = ResearchProject.create(tmp_path / "test.loci-study", "LIF stack")
    workbench = Workbench(project)
    try:
        result = convert_and_import(
            workbench,
            {
                "source": source,
                "jar": jar,
                "java": java,
                "destination": tmp_path / "converted",
                "expected_source_sha256": fingerprint,
                "request": {
                    "series": 0,
                    "c": 1,
                    "z": 1,
                    "t": 0,
                    "end_exclusive": dict(c=3, z=4, t=1),
                    "crop": dict(x=0, y=0, width=64, height=64),
                },
            },
        )
    finally:
        workbench.close()
    adopted = result["source"]
    reopened = ResearchProject(project.root).source(adopted["id"], verify=True)
    assert reopened["derivation"] == adopted["derivation"]
    artifact = result["conversion"]["artifact"]
    assert artifact["shape"] == [1, 2, 3, 64, 64]
    assert artifact["numeric_summary"]["planes_verified"] == 6
    assert result["conversion"]["schema_version"] == "loci.vendor-conversion-receipt/v3"
    assert "_acquisition" not in adopted["derivation"]["record"]["source_series"]
    assert artifact["acquisition"]["planes_with_delta_t"] == 6
    assert artifact["acquisition"]["planes_with_stage_position"] == 6
    lif_times = [1.7280006408691406, 3.4549999237060547, 5.183000564575195]
    for plane in reopened["metadata"]["plane_times"]:
        assert (plane["delta_t"], plane["delta_t_unit"]) == (lif_times[plane["z"]], "s")
    for plane in reopened["metadata"]["plane_positions"]:
        assert plane["position_xyz"] == [0.0389732222332, -0.07587924337637, None]
        assert plane["units_xyz"] == ["m", "m", None]
    # Historical v2 records carry the original grid/byte evidence without acquisition claims.
    legacy = copy.deepcopy(adopted["derivation"])
    for section, schema in [
        ("record", "loci.vendor-conversion/v2"),
        ("receipt", "loci.vendor-conversion-receipt/v2"),
    ]:
        legacy[section]["schema_version"] = schema
        del legacy[section]["artifact"]["acquisition"]
    legacy["receipt"]["provenance"]["sha256"] = hashlib.sha256(
        (canonical_json(legacy["record"]) + "\n").encode()
    ).hexdigest()
    assert validate_derivation(legacy, adopted["sha256"]) == legacy
    # Independent conversion: ask bfconvert for every C/Z in the XY crop.
    runtime = vendor._validate_runtime(source, jar, java, heap_mib=512, timeout_seconds=60)
    runtime = vendor._private_jar_copy(runtime, tmp_path)
    reference = tmp_path / "bfconvert.ome.tif"
    command = vendor._java_prefix(runtime.java, runtime.jar, 512, tmp_path) + [
        vendor._IMAGE_CONVERTER,
        "-series",
        "0",
        "-crop",
        "0,0,64,64",
        "-no-upgrade",
        "-nogroup",
        "-nolookup",
        "-no-sas",
        "-nooverwrite",
        str(source),
        str(reference),
    ]
    assert (
        vendor._run_bounded(
            command,
            cwd=tmp_path,
            timeout_seconds=60,
            watched_output=reference,
            max_output_bytes=4 << 20,
        ).returncode
        == 0
    )
    with tifffile.TiffFile(reference) as tif:
        series = tif.series[0]
        axes = series.axes
        reference_czyx = series.asarray().transpose([axes.index(axis) for axis in "CZYX"])
    expected = reference_czyx[1:3, 1:4]
    actual = tifffile.imread(tmp_path / "converted/image.ome.tif")
    np.testing.assert_array_equal(actual, expected)
    assert artifact["pixel_sha256"] == hashlib.sha256(expected.tobytes()).hexdigest()
    # Re-hashing a contradictory selection cannot make it a valid portable record.
    altered = copy.deepcopy(adopted["derivation"])
    altered["record"]["selection"]["end_exclusive"]["z"] += 1
    altered["receipt"]["selection"] = altered["record"]["selection"]
    altered["receipt"]["provenance"]["sha256"] = hashlib.sha256(
        (canonical_json(altered["record"]) + "\n").encode()
    ).hexdigest()
    with pytest.raises(ValueError, match="grid"):
        validate_derivation(altered, adopted["sha256"])


def test_interior_pixel_change_with_unchanged_extrema_and_nonfinite_refused(tmp_path):
    values = np.arange(2 * 3 * 4, dtype="<f4").reshape((1, 1, 2, 3, 4))
    output = tmp_path / "output.ome.tif"
    expected = values.copy()
    expected.flat[5] = 9
    tifffile.imwrite(output, values, ome=True, photometric="minisblack", metadata={"axes": "TCZYX"})
    with pytest.raises(vendor.VendorConversionError, match="differs"):
        vendor_stack._verify_stack(
            output,
            expected,
            list(values.shape),
            ["Channel 1"],
            None,
            float("inf"),
            Acquisition({}, {}),
        )
    values.flat[5] = np.nan
    tifffile.imwrite(output, values, ome=True, photometric="minisblack", metadata={"axes": "TCZYX"})
    with pytest.raises(vendor.VendorConversionError, match="finite-value"):
        vendor_stack._verify_stack(
            output,
            values,
            list(values.shape),
            ["Channel 1"],
            None,
            float("inf"),
            Acquisition({}, {}),
        )


def test_stack_generated_bytes_and_absent_channel_metadata(tmp_path, monkeypatch):
    """Fixture-independent stack writer/reader coverage in CI without the optional JDK."""
    source = np.arange(2 * 2 * 3 * 5 * 6, dtype="<u2").reshape(2, 2, 3, 5, 6)
    request = vendor._request(BOX)
    grid = {
        **GRID,
        "declared_channel_names": ["First", None, "Acquisition B"],
        "calibration": {"x": {"value": 225, "unit": "nm"}, "y": {"value": 500, "unit": "nm"}},
    }

    def read_box(runtime, request, series, crop, scratch, expected_bytes):
        assert expected_bytes == source.nbytes
        raw = scratch / "planes.raw"
        source.tofile(raw)
        return raw, source.dtype

    monkeypatch.setattr(vendor_stack, "_read_box", read_box)
    output = tmp_path / "stack.ome.tif"
    planes = [
        dict(TheT="3", TheC="2", TheZ="3", DeltaT="12.25", PositionZ="-6", PositionZUnit="nm"),
        dict(TheT="0", TheC="0", TheZ="0", DeltaT="400", PositionY="1234"),
        dict(TheT="2", TheC="2", TheZ="2", PositionX="-77.25", PositionXUnit="µm", PositionY="8"),
        dict(
            TheT="2",
            TheC="1",
            TheZ="1",
            DeltaT="12000",
            DeltaTUnit="ms",
            PositionX="0",
            PositionXUnit="pixel",
        ),
    ]
    xml = _source_xml(planes, dict(TimeIncrement="250", TimeIncrementUnit="ms"))
    assert "_acquisition" not in vendor._parse_ome_xml(xml)[0]
    acquisition = vendor._parse_ome_xml(xml, request)[0]["_acquisition"]
    _, digest, calibration, summary, proof = vendor_stack.convert_stack(
        None, request, grid, tuple(BOX["crop"]), list(source.shape), tmp_path, output, acquisition
    )
    np.testing.assert_array_equal(tifffile.imread(output), source)
    assert digest == hashlib.sha256(source.tobytes()).hexdigest()
    assert calibration == {"axes": "YX", "spacing": [0.5, 0.225], "unit": "µm"}
    assert summary["planes_verified"] == 12
    with tifffile.TiffFile(output) as tif:
        pixels = ET.fromstring(tif.ome_metadata).find("{*}Image/{*}Pixels")
        assert (float(pixels.get("TimeIncrement")), pixels.get("TimeIncrementUnit")) == (250, "ms")
        observed = {}
        for plane in pixels.findall("{*}Plane"):
            index = tuple(int(plane.get("The" + axis)) for axis in "TCZ")
            attrs = {
                k: v if k.endswith("Unit") else float(v)
                for k, v in plane.attrib.items()
                if not k.startswith("The")
            }
            if attrs:
                observed[index] = attrs
        assert observed == {
            (0, 0, 0): dict(DeltaT=12000, DeltaTUnit="ms", PositionX=0, PositionXUnit="pixel"),
            (0, 1, 1): dict(
                PositionX=-77.25, PositionXUnit="µm", PositionY=8, PositionYUnit="reference frame"
            ),
            (1, 1, 2): dict(DeltaT=12.25, DeltaTUnit="s", PositionZ=-6, PositionZUnit="nm"),
        }
        channels = pixels.findall("{*}Channel")
        assert [channel.get("Name") for channel in channels] == [None, "Acquisition B"]

    with NativeImageSession(output) as session:
        assert session.metadata.timing.uniform_interval == 0.25
        assert session.metadata.timing.elapsed_times == (12.0, 12.25)
        assert proof["planes_with_delta_t"] == 2 and proof["planes_with_stage_position"] == 3
        assert proof["stage_position_anchor"] == "unspecified"
        persisted = asdict(session.metadata)
        validate_evidence(proof, persisted, 12)
        altered = copy.deepcopy(acquisition)
        altered.planes[(0, 1, 1)]["PositionX"] += 2
        with pytest.raises(vendor.VendorConversionError, match="differ"):
            verify_acquisition(output, session.metadata, altered)
        with pytest.raises(vendor.VendorConversionError, match="increment differs"):
            verify_acquisition(output, session.metadata, Acquisition({}, acquisition.planes))
        persisted["plane_times"][0]["delta_t"] = 0
        with pytest.raises(ValueError, match="differs"):
            validate_evidence(proof, persisted, 12)


def _source_xml(planes, attrs):
    root = ET.Element("OME")
    image = ET.SubElement(root, "Image")
    pixels = ET.SubElement(
        image,
        "Pixels",
        {
            **{"Size" + a.upper(): str(n) for a, n in GRID["dimensions"].items()},
            "Type": "uint16",
            "DimensionOrder": "XYZCT",
            **attrs,
        },
    )
    for name in GRID["channel_names"]:
        ET.SubElement(pixels, "Channel", Name=name)
    for plane in planes:
        ET.SubElement(pixels, "Plane", plane)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


@pytest.mark.parametrize(
    "extra,attrs,duplicate",
    [
        ({"DeltaTUnit": "ms"}, {}, False),
        ({"PositionYUnit": "nm"}, {}, False),
        ({"DeltaT": "-1"}, {}, False),
        ({"PositionZ": "NaN"}, {}, False),
        ({"PositionZ": "1e-400"}, {}, False),
        ({"PositionX": "1", "PositionXUnit": "nonsense"}, {}, False),
        ({"DeltaT": "1", "DeltaTUnit": "days"}, {}, False),
        ({"DeltaT": "1_2"}, {}, False),
        ({"TheC": "3"}, {}, False),
        ({"TheZ": "-1"}, {}, False),
        ({}, {"TimeIncrement": "0"}, False),
        ({}, {"TimeIncrementUnit": "s"}, False),
        ({}, {}, True),
    ],
)
def test_invalid_selected_acquisition_refused(extra, attrs, duplicate):
    planes = [dict(TheT="2", TheC="1", TheZ="1") | extra] * (2 if duplicate else 1)
    with pytest.raises(vendor.VendorConversionError):
        vendor._parse_ome_xml(_source_xml(planes, attrs), vendor._request(BOX))
