# Quantitative research operations

The research engine exposes bounded puncta, nucleus-to-cell label association,
and persisted two-channel colocalisation through
`research_quantification.execute_quantification`. These operations create
derived results. They never alter source pixels or infer channel identity,
phenotype, molecular interaction, diagnosis, or accuracy.

Every run records the exact source or result revisions, channel-metadata
snapshot, array artifacts, selected grid, voxel-centre affine, settings,
software runtime, control declaration, measurements (including an empty list),
and conservative interpretation. Publication rechecks source identities and,
for label association, every array artifact in both input results after output
artifacts have been staged.

## Bright puncta-like maxima

`puncta_preview` and `puncta_run` accept one source ID and scalar selection plus
explicit `sigma`, `response_threshold`, `raw_threshold`, `minimum_distance`,
`aperture_radius`, `exclude_border`, and `control` values. `working_bytes` is
optional and bounded. The preview returns a real raw-plane overlay (a maximum
intensity projection for a 3D selection), but creates no result.

The run performs one physical-scale, bright-on-dark Laplacian of Gaussian (LoG)
operation. For array axis `a`, it uses `sigma_a = sigma / spacing_a` and sums

```text
response = -sum_a(
  gaussian_filter(raw, sigma=sigma/spacing,
                  order=2 on a, mode=reflect, truncate=4)
  * sigma_a^2
)
```

This is explicit per-axis scale normalisation on an orthogonal physical grid.
The implementation follows SciPy's documented multidimensional Gaussian
derivative interface; the scientific parameter and resolved voxel sigmas are
both preserved. See the current
[SciPy `gaussian_filter` reference](https://docs.scipy.org/doc/scipy/reference/generated/scipy.ndimage.gaussian_filter.html)
and the current
[scikit-image LoG description](https://scikit-image.org/docs/stable/api/skimage.feature.html#skimage.feature.blob_log).

A candidate must strictly exceed both response and raw thresholds. A connected
maximum plateau contributes one candidate: the highest response wins, followed
by the lowest C-order array index. Candidates are processed by descending
response and then ascending C-order index. A physical spatial-bucket search
suppresses a later candidate when its Euclidean world distance is strictly less
than `minimum_distance`. With `exclude_border=true`, a candidate is retained
only when its centre is at least `aperture_radius` from every crop edge in
physical units.

Accepted peaks seed a face-connected watershed on `-response`. Its mask is the
part of `raw > raw_threshold` within `aperture_radius` of a retained peak. The
result stores exact float64 `image` and `response` arrays, uint32 `labels`, peak
index and XYZ world coordinates, and object measurements on the source grid.
The channel measurement name comes from the exact `Workbench.channel_metadata`
snapshot.

The preflight rejects a selection whose voxel count times 192 bytes exceeds the
declared budget. It also rejects more than 10,000 candidate plateaus, more than
10,000 retained peaks, a per-axis sigma over 256 voxels, non-orthogonal
geometry, and non-finite numerical state.

## Nucleus-to-cell label association

`associate_results` requires exact `nuclei` and `cells` result ID/revision
bindings, distinct user-declared role text, a control declaration, and an
optional bounded working-memory budget. Each input must contain an image and an
integer label array. The two results must:

- be distinct revisions with distinct label artifacts;
- belong to the same exact source identity;
- have identical geometry and array shape; and
- have identical acquisition selection, time, level, and crop after excluding
  only the channel index.

For every nucleus, the existing quantitative kernel selects the cell with the
largest observed overlap. Equal overlaps resolve to the lowest cell label. The
record retains the full candidate list, overlap fraction, outside fraction, and
ambiguity flag, including nuclei that have no cell assignment. Cell measurement
rows receive the associated nucleus IDs and counts; this is a declared spatial
association and does not assert biological identity.

The immutable child uses the cell result as its parent and stores `image`, cell
`labels`, and `nuclei_labels`. Provenance retains full descriptors for every
artifact in both bound inputs. Immediately before publication, and again inside
the transactional result-publication callback after child artifact staging, the
engine reopens both result records, verifies their revisions and source hashes,
compares the complete artifact sets, and hash-validates every referenced array.

## Persisted colocalisation

`colocalisation_run` requires one source and selection, two distinct channel
indices, two explicit thresholds, a control declaration, and an optional
bounded memory budget. Both raw channels are read from the same exact source,
time point, crop, level, and physical grid. The immutable result stores the pair
as float64 `image` and `paired_image` arrays plus source identity and the channel
metadata snapshot.

Pearson's correlation is descriptive across the selected voxel pairs. It is
undefined (`null`) for a constant channel. Thresholded Manders fractions use
strict threshold comparisons and the recorded formula:

```text
sum(A where A > ta and B > tb) / sum(A where A > ta)
```

with the symmetric expression for channel B. No per-pixel p-value is calculated,
because spatially correlated pixels or voxels are not independent samples. The
result states that these values describe spatial association and do not
establish molecular interaction.

Reviewed puncta, association, and colocalisation results use the existing generic
atomic research export. Dense arrays remain content-addressed numerical
artifacts, and source data are never copied into the study or export.
