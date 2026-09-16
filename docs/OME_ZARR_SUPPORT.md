# Bounded local OME-Zarr support

## Implemented boundary

`loci_engine.ome_zarr` provides read-only, engine-side access to one explicitly
selected image group in a local directory store. The implemented interchange
boundary is OME-NGFF 0.4 on Zarr storage format 2. It does not treat the current
OME-NGFF 0.5/Zarr v3 format as backward-compatible.

Opening an `OMEZarrSession`:

- requires an absolute path to a local, regular, non-symlink directory;
- inventories every file and directory without following symlinks and rejects
  special files, external links, and changes during metadata parsing;
- requires exact Zarr v2 group metadata and an OME-NGFF `multiscales` entry whose
  declared version is `0.4`;
- requires the caller to select `image_group` for a transitional
  `bioformats2raw.layout` collection or plate, and `multiscale_index` when an
  image group declares more than one multiscale image;
- records path-redacted metadata, a session-local stat-manifest identity, library
  versions, and bounded source counts; and
- performs no network access, runtime/model download, write, or metadata repair.

The reader accepts these ordered source-axis layouts: `YX`, `ZYX`, `CYX`,
`CZYX`, `TYX`, `TZYX`, `TCYX`, and `TCZYX`. Axis names and types must agree
explicitly, and Y/X must be the terminal spatial axes. Metadata and returned
geometry use canonical `TCZYX`; an absent T, C, or Z dimension has length one.
This explicit subset avoids guessing that arbitrary or custom axes correspond
to time, biological channels, depth, rows, or columns.

Every dataset level must be a 2- through 5-dimensional numeric scalar Zarr v2
array. Supported dtypes are boolean, signed integer, unsigned integer, and
floating point values up to 64 bits with explicit byte order. Structured,
object, complex, string, date/time, and larger scalar dtypes are rejected.
Filters are rejected. The compressor allowlist is:

| Zarr v2 compressor | Accepted configuration |
| --- | --- |
| `null` | uncompressed chunk bytes |
| `blosc` | standard `cname`, `clevel`, `shuffle`, and optional `blocksize` |
| `zlib` | integer level 0 through 9 |
| `gzip` | integer level 0 through 9 |

Both `.` and `/` dimension separators and C/F chunk byte order are supported.
Codec metadata is preflighted before any chunk decode. zlib and gzip expansion
is capped at the exact declared decoded chunk byte count; Blosc is given a
caller-sized output buffer. A decoded chunk with any other byte count fails.
Missing chunks use a finite, dtype-compatible declared fill value. A requested
uninitialized chunk with `fill_value: null` is refused because Zarr v2 defines
its contents as undefined.

`read_plane()` accepts explicit T, C, and Z indices and a half-open YX rectangle.
It calculates all touched chunks and a conservative peak-memory estimate before
decoding. The estimate includes the immutable output, two copies of the largest
encoded chunk, and two decoded-chunk buffers. The result is an immutable,
contiguous, two-dimensional scalar array in YX order. Requested floating data
must be finite. This is a scalar-plane contract: it does not combine channels,
interpret interleaved RGB samples, apply OMERO display settings, infer a stain or
fluorophore, or claim that a channel has a biological meaning.

The default plane budget is 64 MiB and the caller-selectable maximum is 512 MiB.
Additional source limits are 256 MiB per decoded chunk, 512 MiB per encoded
file, 1 MiB per parsed JSON metadata file, 250,000 entries, 32 directory levels,
1,024 UTF-8 bytes per relative path, 32 pyramid levels, and 16 TiB total encoded
bytes. These are parser and working-memory bounds; they are not performance or
dataset-size recommendations.

## Coordinates and calibration

OME-NGFF 0.4 dataset `coordinateTransformations` must contain one inline,
positive, finite scale followed by at most one inline finite translation.
Optional multiscale-level transformations follow the same restricted form and
are applied after the dataset transform, matching the specification. For a
dataset transform `(Sd, Td)` followed by a shared transform `(Sg, Tg)`, Loci
records:

```text
scale = Sg * Sd
translation = Sg * Td + Tg
```

The complete scale, translation, and declared unit for each source axis are
retained in canonical TCZYX order at every level. `pixel_extent_xyxy` is the
half-open selected-level extent. When both X and Y declare units,
`physical_extent_xyxy` retains the exact declared units independently. When
both units are one of angstrom, nanometer, micrometer, millimeter, centimeter,
or meter, the reader also reports X/Y scale, origin, and extent in micrometres.
Otherwise calibration status is `relative-or-missing`; the numeric scale remains
available as declared, but no physical-size claim is made.

The reader verifies transform syntax and finite values. It does not prove that
the source metadata describe the microscope, specimen, stage, downsampling
kernel, or acquisition correctly.

## Source identity and mutation checks

The session inventory contains each relative path, entry kind, device, inode,
byte count, modification time, and change time. Its canonical JSON-line SHA-256
is a fast, session-local identity. Every plane read compares the complete store
inventory before and after decoding, and each accessed file is opened with
`O_NOFOLLOW` where the platform provides it and checked against its original
file identity. A request can bind itself to the exact session inventory hash.

The stat-manifest hash is deliberately not described as a portable content
fingerprint. `verify_strict()` streams every regular file, checks identity before
and after each read, and produces a deterministic content-manifest SHA-256. Each
canonical line contains the relative path, byte count, and full file SHA-256;
the outer digest covers the sorted lines. It is stable across copies of the same
directory contents. Supply a known `expected_content_manifest_sha256` when
opening to require this full verification. Persist the strict receipt, rather
than only the live inventory hash, at a saved-result, transfer, or publication
boundary.

The checks detect normal concurrent edits, replacement, added or removed files,
and symlink substitution. They do not turn a directory writable by a hostile
same-user process into a trusted store. Keep source permissions and ownership
appropriate for the trust boundary.

## Converting CZI, ND2, and LIF locally

Loci does not silently convert proprietary sources. A user-controlled local
conversion can use `bioformats2raw`, which uses Bio-Formats readers and can emit
OME-NGFF 0.4/Zarr v2. Keep the original source immutable and retain the exact
converter/Bio-Formats versions, command, logs, source hash, and resulting strict
content-manifest receipt.

```sh
bioformats2raw input.czi output-czi.ome.zarr \
  --ngff-version 0.4 --compression zlib

bioformats2raw input.nd2 output-nd2.ome.zarr \
  --ngff-version 0.4 --compression zlib

bioformats2raw input.lif output-lif.ome.zarr \
  --ngff-version 0.4 --compression zlib
```

The same route applies to one explicitly selected series via `--series INDEX`.
The default 0.4 `bioformats2raw` output uses its transitional collection layout,
so inspect `OME/.zattrs` `series` metadata and pass the chosen contained image
group, commonly `image_group="0"`, to `OMEZarrSession`. Do not silently choose
the first series. Check series count, T/C/Z/Y/X sizes, channel order and names,
physical units and scales, dtype/range, and representative source-versus-output
planes before treating a conversion as usable. Those checks establish structural
and pixel equivalence for the tested source; they do not validate biological
identity, staining, viability, diagnosis, or quantitative accuracy.

Bio-Formats documents CZI, ND2, and LIF readers, but support ratings and metadata
coverage differ by format and version. Reader options can also alter behavior,
including CZI attachment handling, ND2 chunk-map use, and legacy LIF physical
sizes. Record every non-default option as part of conversion provenance.

- [OME-NGFF 0.4 specification](https://ngff.openmicroscopy.org/0.4/)
- [Zarr storage specification v2](https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html)
- [bioformats2raw project and usage](https://github.com/glencoesoftware/bioformats2raw)
- [Bio-Formats supported-format table](https://bio-formats.readthedocs.io/en/latest/supported-formats.html)
- [Bio-Formats reader-specific options](https://bio-formats.readthedocs.io/en/latest/formats/options.html)

`bioformats2raw` and Bio-Formats have their own licences and distribution terms.
They are conversion tools and are not added to the Apache-2.0 Loci core or
executed automatically.

## Verification evidence

Repository tests construct actual Zarr v2 stores and exercise every supported
axis subset, both chunk-key layouts, all allowlisted compressors, cross-chunk
reads, C/F layout, missing chunks, transform composition, physical conversion,
memory rejection before decode, non-finite output, malformed streams, codec and
dtype rejection, explicit collection/multiscale selection, symlink rejection,
source mutation, and both inventory and strict content manifests.

An optional local compatibility fixture under
`/tmp/loci-release-run/ome-zarr/independent-v04-20260907.ome.zarr` was written by
the independent `ome-zarr-py` 0.12.2 `FormatV04` writer using Zarr 3.1.6 and a
two-level TCZYX uint16/Blosc pyramid. It contains no laboratory or patient data.
The repository test binds the directory to content-manifest SHA-256
`07f5934993b6f89fe0873e854a3c0e95fab25d81f0d9167b317ce4a24ad085fd` and checks
a 13 x 17 cross-chunk plane against SHA-256
`b9d67b7752bc2271d8bca9e0b66f499f22fc0c109e8c18b17cbdba4cd6747409`.
If the external fixture is absent, that one test skips; repository-contained
contract tests continue to run.

## Remaining gaps

There is no OME-NGFF 0.5/Zarr v3, sharding, filters, consolidated-metadata
optimization, remote/object/zip store, encrypted store, custom axis, affine or
nonlinear transform, label-image, HCS discovery, OMERO rendering, interleaved
RGB, region cache, cancellation during one codec call, write/conversion path, or
packaged macOS journey in this module. Scanner and converter diversity,
multi-terabyte performance, hostile concurrent-writer testing, and independent
pixel-equivalence fixtures for CZI, ND2, and LIF remain qualification work.
