# Tissue distance bands

`spatial_distance_run` measures object distance and density against a declared
boundary on a calibrated two-dimensional plane. It is available in Quantify →
Tissue distances, the manual CLI and explicitly granted MCP actions. It does not
detect an anatomical boundary or measure tissue thickness.

## Inputs and definitions

Every request binds exact object, analyzable-compartment and boundary result
revisions. They must share the source fingerprint, physical YX grid, plane and
extent. Channels may differ explicitly. Physical units and orthogonal spacing
are required; pixels without calibration, 3D and sheared grids are refused.
Masks must contain nonnegative integer labels. Objects preserve sparse uint32
identities and their original measurements and analysis provenance.

Distance is the Euclidean distance from an object's physical centroid to the
nearest declared boundary pixel center. It is unsigned and depends on the
supplied boundary coverage. The compartment determines eligible tissue and
sampled area. An object's containing pixel is `floor(centroid_index + 0.5)`, with
ties toward the higher index; this pixel determines compartment membership.
The request explicitly chooses whether crop-border objects are excluded.

Distance bands are half-open `[lower, upper)`, including the first lower bound
and excluding the final upper bound. Band area is the number of compartment
pixels whose pixel centers lie in that band, multiplied by physical pixel area.
Boundary pixels overlapping the compartment contribute to the first applicable
band. Tissue gaps and exclusions contribute no area. Density is eligible object
count divided by sampled area; zero area produces `null`, while zero objects in
a nonempty area produce zero. This is a single-field endpoint. Pooling across
fields or comparing donors requires an explicit higher-level analysis.

## Revisions, inspection and export

The derived result retains the image, object labels, compartment labels,
boundary labels and distance-band raster. Provenance retains all three parent
identities and mask hashes, calibration, band settings, exclusions, control
declaration and boundary-coverage statement. The ordinary Statistics & objects
view exposes the saved distance metric and links selected objects to the image.

Correct the underlying masks and rerun to obtain a new immutable spatial result.
Generic label correction of the spatial derivative is refused because it would
invalidate its other inputs and denominator. Permission checks traverse all
three parents, including later access to the derivative. Cancellation or revoked
publication authority prevents result publication.

Reviewed export includes `objects.csv`, retained arrays and TIFF masks,
`spatial-distance-bands.json`, methods and review history. Save, scientific export
and portable study interchange check the scientific record and dependencies;
export/interchange additionally verify retained arrays and recomputed endpoints.
Display changes do not change the saved measurements.

## Evidence boundary

Known-grid tests exercise independent distance calculations, anisotropic pixels,
fractional centroids, sparse IDs, tissue holes, exclusions, empty area, stale
inputs, altered units/measurements, publication cancellation and portability.
The generated packaged fixture has a separate brute-force oracle. Current run
status and exact candidate evidence belong in [project state](PROJECT_STATE.md).
These checks establish software arithmetic and persistence, not anatomical
accuracy, adequate boundary annotation or biological/clinical validity.
