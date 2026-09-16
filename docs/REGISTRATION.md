# Registration and resampling

The shared research backend exposes three operations through
`execute_registration(workbench, operation, request, ...)`:

- `registration_preview` estimates a transform and returns a receipt, its exact
  canonical `preview_json` string, and SHA-256. It does not create a result.
- `registration_run` accepts that exact receipt and hash, repeats registration,
  rejects any changed input, runtime, settings, transform, or quality record,
  and then creates a derived result.
- `resample_grid` applies an explicit crop, shape, and spacing in the parent's
  established world frame without estimating a transform.

Cross-language clients submit the unchanged `preview_json` string with
`preview_sha256`. This preserves floating-point JSON spellings such as `1.0`
and `-0.0` across JavaScript transport. Receipts are bounded to 1 MiB; malformed,
noncanonical, duplicate-key, changed-hash and stale receipts fail closed.
Supplying both string and object representations is rejected. The original
in-process Python `preview` object interface remains supported. Neither route
bypasses exact re-estimation and source/runtime verification before publication.

Every fixed, moving, or parent binding contains a result ID, revision hash, and
array name. The backend reopens the content-addressed array, verifies its result
record and source bytes, and requires explicit geometry. Fixed and moving arrays
must have the same array dimensionality, world frame, and units. Orthogonal
anisotropic and oblique grids are supported. Singular, sheared, non-finite,
dimensionally incompatible, or mixed-frame geometry is rejected.

## Transform direction

The canonical transform is a 4 by 4 homogeneous matrix mapping **moving XYZ
world coordinates to fixed XYZ world coordinates**. Its exact inverse is also
stored and is labelled **fixed world to moving world; resampling map**. For each
fixed output voxel, resampling applies that inverse to locate the moving input
coordinate. Arrays remain `YX` or `ZYX`; the matrix is always `XYZ`, preventing
an implicit row/column or Z/Y/X swap.

Phase correlation uses scikit-image `phase_cross_correlation` on matching sampled
grids, followed by explicit overlap and normalized-correlation checks. The
record retains phase error, phase difference, overlap, correlation, upsampling,
and the accepted threshold. It is suitable for bounded translation correction,
not deformation.

The `sitk_rigid` route uses SimpleITK's physical-space
[`ImageRegistrationMethod`](https://simpleitk.org/doxygen/latest/html/classitk_1_1simple_1_1ImageRegistrationMethod.html)
with a centered Euler transform, full-sample mean squares, physical-shift
optimizer scales, and declared multiresolution shrink/smoothing levels. The
official API defines the optimized transform from the virtual/fixed domain to
the moving domain. Loci records that transform as the resampling map and stores
its inverse as the canonical moving-to-fixed transform. The implementation
follows the official pattern of passing the returned transform to a
[`ResampleImageFilter`](https://simpleitk.org/doxygen/latest/html/classitk_1_1simple_1_1ResampleImageFilter.html)
with the fixed image as reference. Sampling is exhaustive, the seed is fixed at
zero, and each registration/quality filter uses one SimpleITK work unit and
thread. Optimizer stop text,
iteration, metric, post-resample correlation, overlap, and exact runtime versions
are retained. This same-modality research route does not establish anatomical
or biological correctness.

## Derived arrays and measurements

Each output declares its parent array, output name, semantic kind, interpolator,
and outside value. Scalars may use linear or nearest interpolation and are
always computed and stored as float64, avoiding integer interpolation
quantization. Labels require nearest-neighbour interpolation and a zero outside
value; the backend verifies that no new label ID appears. IDs above `2^24`
therefore remain exact.

When a label output is present, object geometry is recomputed on the output
affine. Any intensity statistics use only resampled scalar outputs and are named
`REGISTERED-DERIVED:<array>`. Provenance states
`REGISTERED-DERIVED scalar values and output-grid geometry`; these values are
not represented as raw fluorescence or other source-intensity claims.

The durable child retains the moving result as its parent and records both
input result revisions, source identities, array artifacts, transform
directions and matrices, output grid, interpolation, runtime, quality,
measurements, and exact preview receipt. Publication rechecks both result/source
bindings after artifact staging. A supplied cancellation/publication guard is
called before and between expensive phases and inside the atomic publication
boundary.

The output-grid operation preserves the parent's direction and world coordinate
at the declared integer crop start while applying the requested spacing and
shape. Every output corner must lie inside the parent grid. It never invents an
origin, orientation, extrapolated field of view, or biological interpretation.
