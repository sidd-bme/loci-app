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
Loci checks that the selected executable reports its version and records its
SHA-256. The guard has no numeric Java-major allowlist. Stack conversion also
requires a JDK with Java source-file launch support (Java 11 or later). Codec
compatibility depends on the selected JVM architecture as well as the JAR.

The official Bio-Formats package includes readers under copyleft licences.
Review the upstream licences and the rights for each vendor file before using
or distributing either dependency or derived data. Keep the JAR outside the
repository, Python wheel, desktop bundle, and release artifacts.

## API and supported scope

In the workbench, open **View → Import & conversion → Convert image format**
and choose **Vendor file**. Pick the vendor file, the approved package JAR and
the installed Java executable. Inspection shows the series dimensions, channel
labels, scalar sample counts, spatial spacing and runtime fingerprints.

Choose **Whole series**, **Selected C/Z/T range** or **Single plane**. The UI
uses zero-based indices and includes both endpoints. **Crop XY** applies one
source-pixel rectangle to every selected plane. The output preview shows logical
axes, shape, dtype, plane count and decoded bytes before the destination picker.
**Resource limits** controls the Java heap, timeout and output cap. Choose a new
folder outside the study. The converted source appears in the study and its
conversion record remains available after reopening under **Study conversions**.

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

The legacy request above produces a v1 single-plane record. For a contiguous
stack, supply the source start coordinates and all three **exclusive** stops.
For example, the following converts source C1–2 and Z1–3 at T0 into six planes.

```python
from loci_engine.vendor_conversion import VendorRangeEnd

request = VendorConversionRequest(
    series=0, c=1, z=1, t=0,
    end_exclusive=VendorRangeEnd(c=3, z=4, t=1),
    crop=(0, 0, 64, 64),
)
```

For a whole series, set C/Z/T starts to zero, use the inspected C/Z/T sizes
as exclusive stops and omit the crop. Each plane is capped at 512 MiB.
A stack is capped at 4,096 planes. Both the total decoded selection and the
finished TIFF including metadata must fit the selected output allowance (up to
1 GiB). Allow disk space for the private raw stack, the output and a verified
copy of the reader JAR. The Java heap range is 256–4,096 MiB. Reader processes
capture at most 16 MiB per diagnostic stream. The selected timeout is 1–1,800
seconds per reader invocation. Stack decoding and strip verification also share an elapsed-time
deadline checked between verification strips. Defaults are a 768 MiB heap,
120 seconds for inspection, 300 seconds for conversion and a 512 MiB output
allowance. Single-plane v1 verification requests four times the decoded plane
size from the native reader. Its 512 MiB read-budget ceiling therefore limits
v1 verification to at most 128 MiB of decoded samples.

Pass the fingerprint returned by `inspect_vendor` as
`expected_source_sha256`. Loci rejects an invalid or changed fingerprint before
it creates a staging directory or decodes the requested output.

The converter passes arguments without a shell and uses fixed Bio-Formats tool
classes and flags. It disables file grouping, lookup-table expansion, update
checks, and reader caching. A destination must be absent. Loci builds the result
in a private sibling staging directory, fsyncs both files, and publishes the
directory with an atomic no-replace rename.

The published directory contains:

- `image.ome.tif` holds the selected scalar data. Stacks use contiguous, uncompressed OME-TIFF storage. Single-plane v1 output uses tiled Zlib compression.
- `provenance.json`: source and runtime identities, resolved selection,
  inspected source-series metadata, resource limits, output hash, canonical
  decoded-pixel hash, calibration, and numeric bounds.

### Multidimensional fidelity and metadata

Range conversion uses the same pinned JAR and isolated JVM runner as inspection.
A fixed Java source-file adapter checks the active Bio-Formats reader class,
dimensions, order, dtype, scalar samples and standalone input. It reads each crop at
`getIndex(z, c, t)` with `ImageReader.openBytes`. This expresses independent
axis ranges even when the requested planes are noncontiguous in the vendor file.
The command-line reader's linear range and the OME plane mapping are described in
the [Bio-Formats conversion guide](https://bio-formats.readthedocs.io/en/stable/users/comlinetools/conversion.html)
and the [OME-TIFF specification](https://ome-model.readthedocs.io/en/stable/ome-tiff/specification.html).

The writer preserves the selected scalar dtype, declared X/Y/Z spacing and safe
declared channel names in source order. Missing or redacted names are omitted
from OME channel metadata. Loci provides ordinal labels for display. Logical
receipt axes are TCZYX, including singleton dimensions. Readers may squeeze
singleton axes in their array views. The stack contains local pixel coordinates
and time indices. Range and whole-series conversions now produce v3 records.

During conversion, Loci privately re-inspects the fingerprinted source with the
pinned reader. It matches each reported OME Plane by original T, C and Z, then
rebases those indices into the output grid. The following quantities retain
their source values and units, including when the selection starts after T0.

| Reader declaration | OME-TIFF and reopened study |
| --- | --- |
| Pixels `TimeIncrement` | Selected series' declared uniform interval, in its original unit in OME-TIFF and seconds in study timing |
| Plane `DeltaT` | Elapsed time on that plane, relative to the original time origin |
| Plane `PositionX/Y/Z` | Each available stage coordinate on that plane. Its image-pixel anchor is unspecified. Cropping changes the pixel rectangle and leaves the stage values intact |

Missing intervals, times and individual stage axes stay absent. For a declared
value with no explicit unit, OME defines seconds for time and `reference frame`
for stage coordinates. Stage values in pixels or reference frames retain those
units. Absolute acquisition timestamps, exposure, display settings, vendor
annotations and pyramids are outside the stack profile. [OME 2016-06 schema](https://www.openmicroscopy.org/Schemas/Documentation/Generated/OME-2016-06/ome_xsd.html)

Private source XML is bounded to 16 MiB. A conversion fails on ambiguous
selected plane indices, coordinates outside the series grid, a unit without a
value, unsupported units, or nonfinite or out-of-range selected quantities.
Time increments must be positive and elapsed times nonnegative. Native reopen
also requires strictly increasing per-T times when a single elapsed time can
be assigned unambiguously to each selected T. Per-plane times can differ
between channels and Z slices. Only numeric acquisition quantities belonging
to selected planes are projected. The public inspection stays series-level.

Before publication, Loci reopens the staged file and compares every retained
quantity and unit, including missing fields, against the source selection.
It checks dimensions, channel order, dtype and calibration and compares every
decoded plane bit-for-bit with the selected Bio-Formats bytes in bounded strips.
Nonfinite pixels fail verification. The v3 receipt binds the original file
and reader identities, half-open index range, XY crop, output SHA-256,
little-endian TCZYX pixel hash, plane count and numeric bounds. Its acquisition
record includes the declared interval, counts of timed and positioned planes,
the unspecified stage anchor and a digest of the indexed native plane records.
Registration and portable import check this record against the study source
metadata. Existing v1 single-plane and v2 stack records remain readable with
their original evidence.

### Single-plane compatibility

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

The single-plane integration tests inspect these real files, convert a
bounded crop, and run a fixed test-only Java reference helper that calls
the same pinned library's `ImageReader.openBytes` directly. It compares every
decoded output pixel with those direct reader bytes. This verifies converter
selection, axis handling, byte order, and value preservation relative to the
pinned reader. It does not independently validate Bio-Formats' interpretation
of the proprietary format and is not biological or clinical validation.

The LIF stack test compares a six-plane C/Z subset to a separate whole-C/Z
`bfconvert` crop. A generated big-endian OME-TIFF with known time-varying
values exercises the same range adapter and output verification across T, C
and Z. The three named vendor fixtures above have a singleton T axis in every
inspected series. The public processed PALM CZI from [Zenodo 10577621](https://zenodo.org/records/10577621)
has a convertible scalar series.

### JPEG-XR CZI on Apple silicon

The pinned JAR contains an x86-64 macOS JPEG-XR JNI library. On the public
RecognizedCode CZI above, the tested arm64 Zulu 21.0.7 JVM inspected the XML
but failed to load the decoder for the selected image-bearing crop. Loci
reported the codec error and left the destination absent.

On macOS 26.6.2 arm64, the installed x86-64 Eclipse Temurin **16.0.2+7** JVM
ran under Rosetta. Its executable SHA-256 was
`a0a83982c208e485b6411d6bd267ae6baacaf01446329b84cf46f5eed7e2ef87`.
With the same JAR, source commit `ec001bd` passed the original v1 CZI test.
The v2 range adapter also converted the same coordinates with singleton C/Z/T
stops. Both used a 768 MiB heap, a 300-second conversion timeout and a 512 MiB
output allowance. The standalone test used the following selection.

| Property | Inspected source | Reopened v1 and v2 output |
| --- | --- | --- |
| Grid | Series 0 of 8, 32,751 × 20,684, C0/Z0/T0 | Source crop at x=5,000, y=5,000, width=64, height=64 |
| OME metadata | Scalar uint16, channel `EGFP`, X and Y each 0.3444225755520869 µm | 64 × 64, C=Z=T=1, same dtype, channel and spacing |
| Scalar values | 4,096 samples from a separate Bio-Formats `openBytes` read, range 476–4,027 | All 4,096 samples identical in each output |

The raw little-endian uint16 ROI SHA-256 was
`bd7e48a8a39d82bf02cf54c17fa15b1fa606f70d1f764d7d264a3d68c6561abb`.
The vendor file retained its listed SHA-256 before and after both conversions.
The inspected XML declared `Plane DeltaT=2.06499981880188 s`. The v1 output
retained that value. The v2 output carried time index zero and omitted the
plane time and time increment.

The v3 range conversion of the same ROI under Temurin 16 retained that DeltaT
and stage XYZ (−30277.7754, 10510.1238, 4018.4463) µm. A separate Bio-Formats
XML inspection and TIFF reopen agreed on all four quantities, and the pixel
hash matched the original check. The public LIF subset under arm64 Zulu
21.0.7 retained DeltaT values of 1.7280006408691406, 3.4549999237060547
and 5.183000564575195 s at source Z1–3 for each of C1–2. All six planes
retained stage X 0.0389732222332 m and Y −0.07587924337637 m. Stage Z was
absent. Neither fixture declared a uniform interval. Both converted sources retained
their exact derivations through portable export, import and relink. The
multi-timepoint and declared uniform-interval checks use synthetic inputs.

For the packaged multidimensional journey, set `LOCI_PACKAGED_APP` to the
integrated app, `LOCI_QA_VENDOR_SOURCE` to the pinned `sample.lif`,
`LOCI_QA_BIOFORMATS_JAR` and `LOCI_QA_JAVA` to the explicitly provisioned
files, and `LOCI_QA_OUTPUT_ROOT` to a new directory outside the checkout.
Run `node desktop/tests/vendor-workbench.qa.mjs`. The journey checks the six-plane
pixel and acquisition-metadata digests, runs a recipe on a selected slice, then cold-opens the study and
checks its saved conversion record and result provenance.

Run the focused source checks from `engine/` with the fixture directory, JAR
and Java paths supplied through the corresponding test environment variables
(`LOCI_VENDOR_FIXTURE_DIR`, `LOCI_QA_BIOFORMATS_JAR`, `LOCI_QA_JAVA`):

```bash
uv run ruff check src/loci_engine/vendor_conversion.py tests/test_vendor_conversion.py
uv run pytest tests/test_vendor_conversion.py tests/test_vendor_stack.py tests/test_research_vendor.py
```
