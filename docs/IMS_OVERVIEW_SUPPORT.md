# Modern IMS support

Updated for the image-first source implementation, 8 September 2026. Current
packaged qualification is recorded in [PROJECT_STATE.md](PROJECT_STATE.md).
This document's filename is retained for existing links; IMS is no longer
restricted to the historical cell-viewer overview path.

Loci detects modern Imaris 5.5+ HDF5 containers from their signature, dataset
marker and `DataSet/ResolutionLevel N/TimePoint N/Channel N/Data` hierarchy.
Filename extension alone is insufficient. Native axes are explicit `TCZYX`.

## Viewing and analysis

The unified workspace fits the full source plane, uses stored pyramid levels
automatically and requests bounded native tiles as the camera changes. T/C/Z
navigation, max/mean projections, raw volume/MPR for multiple Z planes and
separate result surfaces retain their different meanings. The analysis region
is independent of the camera. Supported finite scalar selections feed the
shared 2D/3D processing, segmentation, correction and measurement contracts.
The [capability matrix](CAPABILITY_MATRIX.md) gives exact operation limits.

Valid channel names, acquisition display metadata and physical extents are
retained. Native voxel spacing is derived only from valid declared extents,
dimensions and units. The renderer respects supported acquisition colours,
ranges, opacity and gamma, and records fallbacks. Auto samples a stable
full-source basis; navigation does not change the same tissue's display range.

Three scalar channels remain scalar channels even if their LUTs are red, green
and blue. The user can declare a reversible RGB-plane mapping, stored as display
state. This does not establish that the acquisition is stored RGB, H&E or any
particular biology. Reconstructing an original Imaris rendering exactly requires
its actual settings when they are absent from the container. Source-device and
rendered colour values remain distinct from quantitative scalar intensities.

## Boundaries and evidence

HDF5 external/virtual storage, links, discontinuous or malformed layouts,
inconsistent pyramid/channel geometry and legacy non-HDF5 IMS are refused.
A decoded HDF5 chunk is capped at 64 MiB. Viewer tiles, overviews, projections,
volume payloads and analysis selections each have independent aggregate limits.
No write-back to IMS is implemented. Derived export retains identities,
calibration and the declared rendering or scientific meaning.

Full source hashing remains linear in encoded file size at import/integrity
boundaries. Bounded reading does not make those checks sublinear. Opening never
copies the original or silently runs analysis.

`test_native_image.py`, `test_viewer_display.py`, `test_viewer_image.py` and
`test_viewer_volume.py` cover numerical layout, acquisition-display settings,
independent colour references, levels, bounds and geometry. The frozen-engine
builder checks a deterministic IMS fixture. Actual GUI evidence, local-owner
comparisons and externally unqualified variants retain their exact dataset and
build scope in the qualification record.
