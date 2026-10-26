# Native coordinates and time

Loci exposes native TIFF, OME-TIFF, and modern HDF5 IMS arrays in canonical
`TCZYX` or `TCZYXS` order. Spatial arrays passed to quantitative code use `YX`
or `ZYX`; affine columns are world `X`, `Y`, and `Z`. Integer array coordinates
address voxel centres. Every pyramid level has its own dimensions, spacing, and
optional `origin_xyz`.

## Spatial calibration

OME `PhysicalSizeX`, `PhysicalSizeY`, and optional `PhysicalSizeZ` values are
normalized independently to micrometres. This supports valid mixed-unit OME
metadata. In the [OME 2016-06 schema](https://www.openmicroscopy.org/Schemas/OME/2016-06/ome.xsd),
the omitted unit default for each `PhysicalSize` is `µm`; Loci applies that
schema default. X and Y must either both be present and valid or both be absent.
A Z stack with only X/Y calibration remains valid for plane work, but volume
geometry is rejected because a pixel Z scale cannot be mixed into a physical
affine.

OME `Plane PositionX/Y/Z` values are retained with their `TheT`, `TheC`, and
`TheZ` indices, original values and units, and micrometre-normalized values when
their units are physical. The schema describes these values as stage positions
and defaults an omitted position unit to `reference frame`; it does not define
which image pixel or voxel the stage position anchors. Loci therefore does not
use OME plane positions as image origins. Duplicate or out-of-range plane
indices, unsupported units, missing value/unit pairs, non-finite values, and
invalid time coordinates fail inspection.

For modern IMS, the official
[Imaris file-format description](https://imaris.oxinst.com/support/imaris-file-format)
defines `ExtMin0..2` and `ExtMax0..2` as the data origin and extent. The
[open-source ImarisWriter](https://github.com/imaris/ImarisWriter/tree/b128e6e7d1a147261e9d5caf24ebc6b5c9c63779)
writes the supplied image extents into those attributes. Loci interprets the
extent limits as voxel-boundary corners and sets each level's first voxel centre
to `ExtMin + spacing / 2`. This matches the explicit bounding-box convention in
the [NIAID SimpleITK IMS bridge](https://github.com/niaid/imaris_extensions/blob/main/sitk_ims_file_io.py).
The convention is applied only when all six finite, ordered extent values and a
supported physical unit are present. A partial or invalid extent record is
rejected rather than silently reduced to spacing-only metadata.

When a format declares no usable origin, Loci uses an image-local coordinate
frame whose first voxel centre is zero. A selected crop translates that origin
by the selected-level spacing. Uncalibrated data use explicit `pixel` units.
An XY plane retains its calibrated Z coordinate only when Z spacing is declared.

Raster print-density metadata (PNG/JPEG DPI or pixels per metre, and TIFF
XResolution/YResolution/ResolutionUnit) does not establish specimen calibration.
Ordinary TIFF and BigTIFF therefore also use pixel coordinates and pixel-based
measurements. OME-TIFF uses explicit OME PhysicalSize values; TIFF density never
supplies missing specimen spacing. A calibrated acquisition should retain its
microscopy metadata in a supported scientific format, such as OME-TIFF.
Sources imported by an older Loci version with print DPI converted to specimen
spacing remain in their saved
history, but new analysis and result export are refused. Preserve that study and
import the unchanged image into a new study to measure in pixels; no saved
measurement or annotation is silently rescaled.

## Time coordinates

Every OME `Plane DeltaT` value is retained with its T/C/Z indices, original
value and unit, and a seconds-normalized value. Loci also exposes one elapsed
coordinate per T index when every T is represented and all C/Z planes for that
T agree. A derived T sequence must increase strictly; its adjacent differences
are stored explicitly, so irregular sampling remains irregular. When the plane
records are sparse or their within-T acquisition times differ, Loci leaves the
per-T sequence empty instead of collapsing distinct plane times. An OME
`TimeIncrement` is normalized to seconds and retained separately as the
declared uniform interval. Loci does not expand it into fabricated per-frame
times or replace explicit `DeltaT` coordinates with it. Omitted OME time units
use the schema default of seconds.

IMS `DataSetInfo/TimeInfo/TimePoint1..N` strings are preserved verbatim after
whitespace trimming and parsed only as ISO-compatible date-times. Declared
`DatasetTimePoints`, `DataSetTimePoints`, and `FileTimePoints` counts, when
present, must match the stored T dimension. All indexed timestamps must be
present and strictly increasing. Loci stores elapsed seconds from the first
timestamp and every adjacent interval; it does not infer a uniform interval or
a timezone for local timestamps.

These rules establish coordinate and metadata reproducibility. They do not
establish biological channel identity, acquisition accuracy, registration
accuracy, or clinical validity.

## Qualified RGB and pixel-unit metadata

OME `SizeC` includes RGB(A) samples. Loci retains one logical C axis and a
separate S axis for these images; per-component OME Plane records retain their
logical `c` and explicit `sample` index. These records never create biological
channels. Complete positive pixel-unit X/Y(/Z) spacing remains in `pixel` units;
Loci rejects mixtures of pixels and physical lengths instead of inventing a
conversion. See the [OME units definition](https://ome-model.readthedocs.io/en/latest/developers/ome-units.html).
These variants were encountered during local, owner-authorized TIFF checks;
regression fixtures are generated and contain no private source pixels or names.

## Palette TIFF presentation

Native PALETTE TIFF supports one unsigned 8- or 16-bit index sample per pixel,
Orientation 1, and a complete unsigned 16-bit RGB ColorMap. Each actual IFD is
validated, including pages represented internally as TIFF frames. Palettes may
vary across logical C/T/Z and pyramid levels; the selected page's own ColorMap
is authoritative. A shared TIFF decoding keyframe never supplies another
page's palette. Source bytes and stored array axes remain unchanged.

The native region contains exact uint16 RGB lookup values on sample axis S=3,
with logical C/T/Z and physical geometry preserved. Metadata `palette` records
the stored index dtype and the exact per-IFD expansion policy; the source SHA-256
binds the lookup tables. OME metadata is interpreted using its original single
index sample before adding the presentation sample axis. Indices are not scalar
fluorescence intensities, and expanded RGB components cannot be declared as
independent biological channels. Reads admit the indices, RGB output, lookup
scratch, coverage, ColorMap, and encoded/decoded strip or tile memory before
pixel decoding.

The viewer displays one selected logical C at a time, using that C for tiles,
overviews, histograms, saved views and rendered exports. Interleaved RGB composites
and Z projections are rejected. The canvas rounds uint16 RGB to the nearest
8-bit code using `(value + 128) // 257`; it does not stretch an observed palette
maximum such as 65280 to 65535. Neutral rendered TIFF exports retain exact uint16
lookup values. Adjusted exports remain presentation data. A uint16 ICC transform
is refused when the available transform would change precision. These are
software interpretation guarantees, not biological or clinical validation.
