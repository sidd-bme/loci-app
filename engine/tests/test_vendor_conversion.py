from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

import loci_engine.vendor_conversion as vendor_module
from loci_engine.native_image import NativeImageSession, NativeSelection
from loci_engine.vendor_conversion import (
    BIOFORMATS_JAR_SHA256,
    VendorConversionError,
    VendorConversionRequest,
    convert_vendor,
    inspect_vendor,
)

FIXTURE_HASHES = {
    "czi": "1e19c9c0cf5f067404bc0483c3ff608cc3ddb67dcfb39765ae91b5a50996d29e",
    "nd2": "77c921fa2d3ebce182c261d28790de97d119062e550029b5e501d6200720eb0d",
    "lif": "a4bc49b2fb9f1adf3a66872d01e1450db1d898fc7f4d2386aefa28836c2ec419",
}


def _fixture_root() -> Path:
    root = Path(os.environ.get("LOCI_VENDOR_FIXTURE_DIR", "/tmp/loci-release-run/vendor-reader"))
    required = [
        root / "bioformats_package.jar",
        *(root / f"sample.{ext}" for ext in FIXTURE_HASHES),
    ]
    if not all(path.is_file() for path in required):
        pytest.skip("authorized Bio-Formats qualification fixtures are not available")
    return root


def test_parse_ome_xml_returns_explicit_scalar_axes_and_redacted_channel_names() -> None:
    output = b"""reader diagnostics
<?xml version="1.0" encoding="UTF-8"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">
  <Image ID="Image:0" Name="/private/source.czi">
    <Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16"
      SizeX="17" SizeY="13" SizeZ="3" SizeC="2" SizeT="5"
      PhysicalSizeX="0.5" PhysicalSizeXUnit="&#181;m"
      PhysicalSizeY="0.75" PhysicalSizeYUnit="&#181;m">
      <Channel ID="Channel:0:0" Name="DAPI" SamplesPerPixel="1"/>
      <Channel ID="Channel:0:1" Name="/private/channel" SamplesPerPixel="1"/>
    </Pixels>
  </Image>
</OME>
trailing diagnostics"""

    assert vendor_module._parse_ome_xml(output) == [
        {
            "index": 0,
            "dimensions": {"x": 17, "y": 13, "z": 3, "c": 2, "t": 5},
            "dimension_order": "XYZCT",
            "dtype": "uint16",
            "channel_names": ["DAPI", "Channel 2"],
            "samples_per_channel": [1, 1],
            "calibration": {
                "x": {"value": 0.5, "unit": "µm"},
                "y": {"value": 0.75, "unit": "µm"},
            },
        }
    ]


@pytest.mark.parametrize("declaration", [b"<!DOCTYPE OME>", b"<!ENTITY leak SYSTEM 'x'>"])
def test_parse_ome_xml_rejects_external_declarations(declaration: bytes) -> None:
    with pytest.raises(VendorConversionError, match="unsafe"):
        vendor_module._parse_ome_xml(b'<?xml version="1.0"?>' + declaration + b"<OME></OME>")


@pytest.mark.parametrize(
    "conversion_request, message",
    [
        ({"series": True, "c": 0, "z": 0, "t": 0}, "series"),
        ({"series": 0, "c": 0, "z": 0, "t": 0, "extra": 1}, "unknown"),
        ({"series": 0, "c": 0, "z": 0, "t": 0, "crop": (0, 0, 0, 1)}, "crop"),
        (
            {
                "series": 0,
                "c": 0,
                "z": 0,
                "t": 0,
                "max_output_bytes": vendor_module.MAX_OUTPUT_BYTES + 1,
            },
            "max_output_bytes",
        ),
    ],
)
def test_request_rejects_ambiguous_or_unbounded_values(
    conversion_request: dict[str, object], message: str
) -> None:
    with pytest.raises(VendorConversionError, match=message):
        vendor_module._request(conversion_request)


def test_leaf_symlinks_and_unapproved_jar_are_rejected_before_execution(tmp_path: Path) -> None:
    source = tmp_path / "source.czi"
    source.write_bytes(b"source")
    link = tmp_path / "linked.czi"
    link.symlink_to(source)
    fake_jar = tmp_path / "bioformats_package.jar"
    fake_jar.write_bytes(b"not approved")

    with pytest.raises(VendorConversionError, match="non-symlink"):
        inspect_vendor(link, fake_jar)
    with pytest.raises(VendorConversionError, match="approved 8.5.0"):
        inspect_vendor(source, fake_jar)


def test_subprocess_environment_drops_jvm_injection_variables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("JAVA_TOOL_OPTIONS", "-Duntrusted=yes")
    monkeypatch.setenv("JDK_JAVA_OPTIONS", "-Duntrusted=yes")
    monkeypatch.setenv("CLASSPATH", "/untrusted")
    result = vendor_module._run_bounded(
        [
            sys.executable,
            "-c",
            "import os; print(any(k in os.environ for k in "
            "('JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','CLASSPATH')))",
        ],
        cwd=tmp_path,
        timeout_seconds=5,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == b"False"


def test_subprocess_output_is_bounded(tmp_path: Path) -> None:
    with pytest.raises(VendorConversionError, match="diagnostic-output limit"):
        vendor_module._run_bounded(
            [sys.executable, "-c", "import sys; sys.stdout.write('x' * 10000)"],
            cwd=tmp_path,
            timeout_seconds=5,
            max_capture_bytes=128,
        )


def test_expected_inspection_fingerprint_blocks_conversion_before_staging(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(vendor_module, "_validate_runtime", lambda *args, **kwargs: object())
    monkeypatch.setattr(
        vendor_module,
        "_inspect",
        lambda *args, **kwargs: ([], "a" * 64),
    )
    destination = tmp_path / "must-not-exist"
    with pytest.raises(VendorConversionError, match="inspected fingerprint"):
        convert_vendor(
            "source.czi",
            "reader.jar",
            destination,
            VendorConversionRequest(0, 0, 0, 0, (0, 0, 1, 1)),
            expected_source_sha256="b" * 64,
        )
    assert not destination.exists()


@pytest.fixture(scope="module")
def bioformats_reference_helper(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = _fixture_root()
    javac = shutil.which("javac")
    if javac is None:
        pytest.skip("javac is unavailable for the direct Bio-Formats reference reader")
    helper = tmp_path_factory.mktemp("bioformats-reference")
    source = helper / "BfPixelReference.java"
    source.write_text(
        r"""
import java.nio.file.Files;
import java.nio.file.Path;
import loci.formats.ImageReader;

public final class BfPixelReference {
  public static void main(String[] args) throws Exception {
    if (args.length != 11) throw new IllegalArgumentException("expected 11 arguments");
    ImageReader reader = new ImageReader();
    reader.setGroupFiles(false);
    reader.setOriginalMetadataPopulated(false);
    try {
      reader.setId(args[0]);
      reader.setSeries(Integer.parseInt(args[1]));
      int c = Integer.parseInt(args[2]);
      int z = Integer.parseInt(args[3]);
      int t = Integer.parseInt(args[4]);
      int x = Integer.parseInt(args[5]);
      int y = Integer.parseInt(args[6]);
      int width = Integer.parseInt(args[7]);
      int height = Integer.parseInt(args[8]);
      if (reader.getRGBChannelCount() != 1) {
        throw new IllegalArgumentException("scalar channels only");
      }
      byte[] pixels = reader.openBytes(reader.getIndex(z, c, t), x, y, width, height);
      Files.write(Path.of(args[9]), pixels);
      Files.writeString(
        Path.of(args[10]),
        "littleEndian=" + reader.isLittleEndian() + "\nlength=" + pixels.length + "\n"
      );
    } finally {
      reader.close();
    }
  }
}
""".strip()
        + "\n",
        encoding="utf-8",
    )
    subprocess.run(
        [javac, "-cp", str(root / "bioformats_package.jar"), str(source)],
        cwd=helper,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=True,
        timeout=60,
    )
    return helper


@pytest.mark.parametrize(
    ("extension", "conversion_request", "expected_series_count", "expected_dtype"),
    [
        ("czi", VendorConversionRequest(0, 0, 0, 0, (5000, 5000, 64, 64)), 8, "uint16"),
        ("nd2", VendorConversionRequest(0, 0, 0, 0, (50, 60, 32, 24)), 10, "float32"),
        ("lif", VendorConversionRequest(0, 2, 3, 0, (10, 20, 32, 24)), 7, "uint8"),
    ],
)
def test_real_vendor_fixture_conversion_matches_direct_bioformats_pixels(
    tmp_path: Path,
    bioformats_reference_helper: Path,
    extension: str,
    conversion_request: VendorConversionRequest,
    expected_series_count: int,
    expected_dtype: str,
) -> None:
    root = _fixture_root()
    source = root / f"sample.{extension}"
    jar = root / "bioformats_package.jar"
    inspection = inspect_vendor(source, jar)
    encoded_inspection = json.dumps(inspection, sort_keys=True)
    assert str(root) not in encoded_inspection
    assert inspection["source_sha256"] == FIXTURE_HASHES[extension]
    assert inspection["runtime"]["bioformats_jar_sha256"] == BIOFORMATS_JAR_SHA256
    assert len(inspection["series"]) == expected_series_count
    assert inspection["series"][conversion_request.series]["dtype"] == expected_dtype

    destination = tmp_path / f"converted-{extension}"
    receipt = convert_vendor(
        source,
        jar,
        destination,
        conversion_request,
        expected_source_sha256=inspection["source_sha256"],
    )
    assert destination.is_dir()
    assert receipt["source_sha256"] == FIXTURE_HASHES[extension]
    assert receipt["selection"]["crop_xywh"] == list(conversion_request.crop)
    assert receipt["artifact"]["dtype"] == expected_dtype
    assert set(path.name for path in destination.iterdir()) == {
        "image.ome.tif",
        "provenance.json",
    }
    provenance = json.loads((destination / "provenance.json").read_text(encoding="utf-8"))
    assert provenance["source"]["sha256_before"] == provenance["source"]["sha256_after"]
    assert provenance["artifact"]["dtype"] == expected_dtype

    assert conversion_request.crop is not None
    x, y, width, height = conversion_request.crop
    reference_raw = tmp_path / f"reference-{extension}.bin"
    reference_meta = tmp_path / f"reference-{extension}.txt"
    classpath = f"{jar}{os.pathsep}{bioformats_reference_helper}"
    subprocess.run(
        [
            "/usr/bin/java",
            "-Djava.awt.headless=true",
            "-cp",
            classpath,
            "BfPixelReference",
            str(source),
            str(conversion_request.series),
            str(conversion_request.c),
            str(conversion_request.z),
            str(conversion_request.t),
            str(x),
            str(y),
            str(width),
            str(height),
            str(reference_raw),
            str(reference_meta),
        ],
        cwd=tmp_path,
        env={
            "PATH": "/usr/bin:/bin",
            "LANG": "en_US.UTF-8",
            "LC_ALL": "en_US.UTF-8",
            "HOME": str(tmp_path),
            "TMPDIR": str(tmp_path),
        },
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=True,
        timeout=120,
    )
    metadata = dict(
        line.split("=", 1) for line in reference_meta.read_text(encoding="utf-8").splitlines()
    )
    with NativeImageSession(destination / "image.ome.tif") as session:
        converted = session.read_region(NativeSelection(0, 0, width, height)).pixels
    byte_order = "<" if metadata["littleEndian"] == "true" else ">"
    reference = np.frombuffer(
        reference_raw.read_bytes(), dtype=converted.dtype.newbyteorder(byte_order)
    ).astype(converted.dtype, copy=False)
    reference = reference.reshape(height, width)
    assert int(metadata["length"]) == converted.nbytes
    assert np.array_equal(reference, converted)


def test_destination_must_be_absent(tmp_path: Path) -> None:
    root = _fixture_root()
    destination = tmp_path / "already-there"
    destination.mkdir()
    with pytest.raises(VendorConversionError, match="already exists"):
        convert_vendor(
            root / "sample.lif",
            root / "bioformats_package.jar",
            destination,
            VendorConversionRequest(0, 0, 0, 0, (0, 0, 8, 8)),
        )
