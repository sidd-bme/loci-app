# Optional vendor image conversion

Loci can inspect and convert a deliberately narrow subset of vendor microscopy
files with an explicitly supplied Bio-Formats runtime. This is an optional
local conversion boundary. The Apache-2.0 engine does not contain, download,
install, bundle, or redistribute Bio-Formats, Java, vendor readers, or sample
data.

## Approved runtime

The converter accepts only the official `bioformats_package.jar` release below:

- Bio-Formats version: `8.5.0`
- Size: `53,843,906` bytes
- SHA-256: `c6e60665d53a334b66e4d635340151f403dfe57a64704c573dd4c03b873befb9`
- Upstream artifact: <https://downloads.openmicroscopy.org/bio-formats/8.5.0/artifacts/bioformats_package.jar>

The caller must provide the JAR as a local regular file. Loci checks its exact
size and full hash before use and checks its identity and hash again after
conversion. It never searches for a different JAR or downloads one. The Java
executable must also be an explicit regular, non-symlink executable owned by
root or the current user and must not be group or world writable. JVM option
and classpath environment variables are removed from the child environment.

The official Bio-Formats package includes readers under copyleft licences.
Review the upstream licences and the rights for each vendor file before using
or distributing either dependency or derived data. Keep the JAR outside the
repository, Python wheel, desktop bundle, and release artifacts.

## API and supported scope

In the desktop research workbench, open **Vendor import**, select the vendor
file, the exact package JAR and the installed Java executable. Inspection shows
the series, scalar channels, Z/T indices, size and runtime fingerprints before
conversion. Choose one bounded plane or crop and a new output folder. The
converted OME-TIFF is added to the current study with its immutable derivation
receipt; subsequent results, methods exports and portable studies retain it.
The displayed grid is the converted image's local grid. The original series,
C/Z/T selection and source-pixel crop offset are recorded in the receipt;
arbitrary vendor stage-coordinate or time-axis reconstruction is not claimed.

Import the optional boundary directly:

```python
from loci_engine.vendor_conversion import (
    VendorConversionRequest,
    convert_vendor,
    inspect_vendor,
)

inspection = inspect_vendor(source_path, bioformats_jar_path)

receipt = convert_vendor(
    source_path,
    bioformats_jar_path,
    absent_destination_directory,
    VendorConversionRequest(
        series=0,
        c=0,
        z=0,
        t=0,
        crop=(100, 200, 512, 512),  # x, y, width, height
        heap_mib=768,
        timeout_seconds=300,
        max_output_bytes=512 << 20,
    ),
    expected_source_sha256=inspection["source_sha256"],
)
```

`inspect_vendor` currently accepts standalone `.czi`, `.nd2`, and `.lif`
files. It invokes `ImageInfo` with grouping, update checks, and structured
annotations disabled. The returned mapping contains the source fingerprint,
series dimensions, explicit OME dimension order, native dtype, physical
calibration, channel names, samples per channel, and runtime identities. It
does not contain a source, JAR, Java, home, or temporary path.

`convert_vendor` requires explicit series, channel, Z, and time indices. A crop
is optional only when the full plane fits the same decoded and output budgets.
This first boundary converts one scalar channel plane; RGB sample components are
reported during inspection but rejected for conversion because RGB components
must not be presented as biological channels. The decoded plane is capped at
512 MiB. Heap is bounded to 256–4096 MiB, elapsed time to at most 1,800 seconds,
captured diagnostics to 16 MiB per stream, and the derived artifact to at most
1 GiB. Caller limits may be smaller.

Pass the fingerprint returned by `inspect_vendor` as
`expected_source_sha256`. Loci rejects an invalid or changed fingerprint before
it creates a staging directory or decodes the requested output.

The converter passes arguments without a shell and uses fixed Bio-Formats tool
classes and flags. It disables file grouping, lookup-table expansion, update
checks, and reader caching. A destination must be absent. Loci builds the result
in a private sibling staging directory, fsyncs both files, and publishes the
directory with an atomic no-replace rename.

The published directory contains:

- `image.ome.tif`: one Zlib-compressed, tiled, selected scalar plane;
- `provenance.json`: source and runtime identities, resolved selection,
  inspected source-series metadata, resource limits, output hash, canonical
  decoded-pixel hash, calibration, and numeric bounds.

Bio-Formats 8.5.0 can retain `<Plane>` entries for coordinates excluded by
`-channel`, `-z`, or `-timepoint`. Loci removes only those stale entries in the
derived OME metadata and rebases the one matching selected entry to C/Z/T zero.
It does not repair any other mismatch. The result must then open through
`NativeImageSession` as exactly one scalar YX plane with the requested shape,
source dtype, and source calibration. Loci reads the entire bounded output,
rejects non-finite floating values, checks its observed min/max against the
Bio-Formats reader's selected-crop report, hashes the canonical decoded pixels,
and rehashes the OME-TIFF.

The min/max check is a narrow conversion guard, not independent validation of a
vendor decoder. The full source remains immutable; the OME-TIFF is an explicit
derived artifact.

## Fixture qualification

The focused test suite uses public CC BY 4.0 fixtures only when they are
explicitly staged in `LOCI_VENDOR_FIXTURE_DIR` (or the local qualification
default). CI without these large fixtures skips the three integration cases.
The qualification set is:

| Format | Public source | Attribution | Fixture SHA-256 |
| --- | --- | --- | --- |
| CZI | [OME sample from Zenodo 10577186](https://downloads.openmicroscopy.org/images/Zeiss-CZI/zenodo-10577186/2023_11_30__RecognizedCode-27.czi) | Stephan Wagner-Conrad | `1e19c9c0cf5f067404bc0483c3ff608cc3ddb67dcfb39765ae91b5a50996d29e` |
| ND2 | [OME sample from Zenodo 14893791](https://downloads.openmicroscopy.org/images/ND2/zenodo-14893791/C3_N01Ato5_nucleo-trans_div3_mSG_b2s_200ms_30%25_Reconstructed.nd2) | Louis Romette | `77c921fa2d3ebce182c261d28790de97d119062e550029b5e501d6200720eb0d` |
| LIF | [OME sample from Zenodo 6606445](https://downloads.openmicroscopy.org/images/Leica-LIF/zenodo-6606445/Project007.lif) | Peter Zentis | `a4bc49b2fb9f1adf3a66872d01e1450db1d898fc7f4d2386aefa28836c2ec419` |

For each format, the integration test inspects the real file, converts a
bounded crop, and compiles a small test-only Java reference helper that calls
the same pinned library's `ImageReader.openBytes` directly. It compares every
decoded output pixel with those direct reader bytes. This verifies converter
selection, axis handling, byte order, and value preservation relative to the
pinned reader. It does not independently validate Bio-Formats' interpretation
of the proprietary format and is not biological or clinical validation.

Run the focused checks from `engine/`:

```bash
uv run ruff check src/loci_engine/vendor_conversion.py tests/test_vendor_conversion.py
uv run pytest tests/test_vendor_conversion.py
```
