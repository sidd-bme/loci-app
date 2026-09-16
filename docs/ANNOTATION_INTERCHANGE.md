# Research annotation correction and interchange

## Implemented boundary

`loci_engine.research_annotations` provides engine-side correction of derived
`uint32` label arrays, geometry-bound polygon measurements, and strict polygon
interchange profiles. It operates on scalar YX or ZYX arrays with the shared
`quantitative.Geometry` contract. Source images are inputs only; correction
always returns a new immutable label array.

This module records reproducible editing and descriptive measurement. It does
not establish annotation truth, segmentation accuracy, biological identity,
diagnosis, or clinical validity. A researcher must review every corrected
result and any interpretation derived from it.

## Coordinates and identities

Arrays use YX or ZYX order. World coordinates use XYZ order and the declared
voxel-center affine. Plane-local polygon and brush coordinates use `(u, v)`:

| Plane | U axis | V axis | Fixed axis |
| --- | --- | --- | --- |
| XY | X | Y | Z |
| XZ | X | Z | Y |
| YZ | Y | Z | X |

Integer U/V coordinates address voxel centers. Polygon ROI vertices may extend
to `-0.5` and `size - 0.5`, which are the outer edges of the first and last
voxels. Correction vertices and brush control points must lie on voxel-center
coordinates inside the selected plane. Physical brush radii use the geometry's
declared unit and respect anisotropic spacing. Euclidean brushes and watershed
distance transforms require an orthogonal grid; sheared geometry is rejected.

Every correction operation carries `expected_input_sha256`. It must equal the
canonical hash of the exact current `uint32` array, including shape and values.
For a sequence, each operation binds to the output hash of its predecessor.
The returned record includes the input and output hashes, geometry and geometry
hash, normalized operation parameters, changed-voxel counts, and the retained
sparse label IDs. Input arrays remain byte-identical after success or failure.

Polygon ROIs carry the source SHA-256, optional result SHA-256, T and C indices,
image shape, plane and optional normal-axis slab, complete affine, units and
world frame. Measurement requires the caller to present the same source and
result identities and an array with the anchored shape and geometry.

## Label correction operations

`correct_labels(labels, geometry, operations)` accepts one through 64 exact-key
operation objects:

```json
{
  "op": "brush",
  "expected_input_sha256": "...",
  "mode": "paint",
  "plane": "XY",
  "index": 3,
  "points": [{"u": 20.0, "v": 40.0}],
  "radius": 2.5,
  "label": 4000000000
}
```

- `brush` paints or erases one label on one XY, XZ, or YZ plane. A physical
  point-to-segment rasterization is used. Contact with another nonzero label
  fails rather than overwriting it.
- `polygon_add` creates one unused label inside a simple polygon and fails on
  any nonzero overlap.
- `polygon_replace` replaces one connected occurrence of the selected label on
  one plane. The polygon must overlap that occurrence and must not overlap any
  other label. Other planes and labels remain unchanged.
- `merge` replaces every voxel of two through 32 existing `source_labels` with
  one listed `target_label` across the complete array.
- `delete` replaces every voxel of one existing label with background zero
  across the complete array.
- `watershed_split` partitions one connected label from two through 32 explicit
  seeds. Mode `2D` requires a plane and index; mode `3D` requires a ZYX array.
  Face connectivity and physical-axis sampling are recorded. The first seed
  retains the source label; later seeds receive the lowest unused positive
  `uint32` IDs in seed order.

Unknown fields, stale identities, invalid or repeated seeds, disconnected split
targets, absent labels, no-op edits, non-finite values, label collisions, ID
exhaustion, excessive brush extent, and working-memory excess all fail closed.
Pre-existing IDs are never compacted or narrowed.

## Polygon measurement

`create_polygon_roi(...)` validates a simple plane polygon and binds it to its
source, result and geometry. `measure_polygon_roi(...)` rasterizes the same
voxel-center rule used by corrections and reports:

- exact plane/slab and array identity metadata;
- polygon vertices in plane U/V and world XYZ coordinates;
- continuous shoelace area in index units and declared physical units;
- geometric polygon area or slab volume;
- sampled voxel count and sampled area or voxel volume; and
- raw scalar sum, mean, minimum, maximum and population standard deviation.

For a polygon on one plane of a 3D array, `geometric_measure` is the polygon
area while `sampled_measure` is the selected voxels' physical volume. Separate
kind and unit fields prevent these quantities from being conflated. Pixel units
are explicitly reported as uncalibrated. Values are descriptive raw intensities;
the module does not infer a fluorophore, stain, cell type or biological signal.

## Non-geographical JSON polygon profile

`roi_to_geojson()` and `roi_from_geojson()` use a strict JSON Feature/Polygon
shape with one closed three-coordinate ring. Coordinates are image-voxel XYZ,
not longitude/latitude. The properties explicitly set a zero-based,
voxel-center, non-geographical coordinate reference and retain the complete
voxel-to-world affine, the exact U/V polygon, world XYZ polygon, source/result
identities, C/Z/T anchors and raster rule. Import recomputes the geometry hash
and rejects disagreement among voxel, plane, affine and world coordinates.

RFC 7946 fixes standard GeoJSON coordinates to WGS 84 longitude and latitude.
The Loci profile deliberately uses the familiar Feature/Polygon JSON structure
outside that geographical CRS contract. It must not be sent to a web-map or
standards-only GeoJSON consumer without an explicit conversion. The
`coordinate_reference.geographical: false` property is disclosure, not an RFC
7946 CRS override.

- [RFC 7946: The GeoJSON Format](https://www.rfc-editor.org/rfc/rfc7946)

## ImageJ ROI profile

`roi_to_imagej()` writes a single-plane XY polygon through the pinned `roifile`
runtime. Loci voxel-center vertices are shifted by `+0.5` in X and Y because
ImageJ area ROI integer coordinates describe pixel edges. The ImageJ record
retains one-based C, Z and T positions as encoded by the format. Loci embeds an
exact, path-free annotation envelope containing the original double-precision
vertices, source/result identities, affine and world coordinates.

`roi_from_imagej()` accepts only a Loci-authored polygon with that complete
envelope. It checks the ROI type, C/Z/T positions, coordinate convention,
geometry hash, exact vertices, world coordinates and caller-supplied expected
identities. The binary polygon is float32, so export first checks a bounded
absolute representation tolerance. Import verifies the binary vertices against
the embedded exact vertices and returns the exact Loci values. XZ/YZ polygons,
multi-plane slabs, non-polygon ROI types and unanchored external ImageJ ROI
files are rejected.

- [ImageJ ROI coordinate convention](https://imagej.net/ij/developer/api/ij/ij/gui/Roi.html)
- [ImageJ ROI binary header](https://imagej.net/ij/developer/api/ij/ij/io/RoiDecoder.html)
- [`roifile` source and documentation](https://github.com/cgohlke/roifile)

## Verification and remaining gaps

Repository tests cover anisotropic brushes on all three orthogonal planes,
collision and no-op rejection, sparse IDs near the `uint32` maximum, whole-label
merge/delete, explicit 2D and 3D watershed, stale operation isolation, exhausted
ID space, memory rejection, oblique affine measurement, large and fractional
coordinates, full-image half-voxel boundaries, JSON tamper rejection, and
ImageJ C/Z/T and float32 round trips.

The module is not yet wired into the desktop, research project service, CLI,
MCP, remote execution, export publication, or packaged macOS journey. It does
not import arbitrary external ImageJ annotations, emit ROI ZIP collections,
support holes or multipolygons, measure multichannel/time arrays directly,
provide nonlinear transforms, or attach reviewer identity and adjudication.
Those integration and qualification boundaries remain explicit future work.
