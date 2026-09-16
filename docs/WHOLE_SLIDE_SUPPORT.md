# Bounded SVS and NDPI support

## Implemented boundary

`loci_engine.whole_slide` provides an engine-only, read-only session for
content-detected Aperio SVS and Hamamatsu NDPI sources through OpenSlide. It is
a bounded decoder and research-region analysis foundation. It is not a complete
whole-slide viewport, a diagnostic system, or biological validation.

Opening a `WholeSlideSession`:

- requires an absolute path to one regular, non-symlink file;
- computes a stable full-file SHA-256 before OpenSlide opens the source;
- accepts an optional exact expected SHA-256 and fails closed on mismatch;
- records only path-redacted format, geometry, calibration, binding/runtime, colour,
  and fingerprint metadata;
- validates positive finite dimensions, downsample factors, and declared
  micrometres-per-pixel values; and
- installs an explicit 64 MiB OpenSlide decoded-tile cache (caller configurable
  from 1 KiB through 512 MiB); and
- rejects unsupported vendors, suffix/vendor mismatches, incomplete X/Y
  calibration, malformed ICC profiles, and inconsistent pyramid metadata.

Each region read checks the source device, inode, size, modification time, and
change time before and after decoding. `verify_strict()` rehashes the complete
source and returns a full-SHA-256 receipt. Per-read stat checks catch ordinary
edits and replacement efficiently, but are explicitly not a cryptographic
substitute for the strict receipt at a saved-result or publication boundary.

The session API follows OpenSlide's coordinate contract exactly:

- `level0_x` and `level0_y` are integer XY coordinates in the level 0 reference
  frame;
- `width` and `height` are pixels at the selected pyramid level;
- the exact floating-point downsample reported by OpenSlide is retained;
- `level0_extent_xyxy` records the requested half-open extent as
  `(x0, y0, x0 + width * downsample, y0 + height * downsample)`; and
- every request must stay inside the declared level 0 dimensions and a maximum
  512 MiB caller-selected working-memory budget.

The decoder returns immutable `uint8` YXS arrays. `analysis_rgb` is the
source-device RGB from OpenSlide with no display profile transform. When a
usable embedded slide ICC profile exists, Pillow `ImageCms` transforms a
separate copy to sRGB for `display_rgb`. Provenance records the input and output
profile hashes, profile byte count, rendering intent, Pillow version, LittleCMS
version, and transform name. When no profile exists, the bytes are labelled
`uncharacterized-source-RGB`; no colour calibration or sRGB conversion is
claimed. A malformed declared profile fails closed.

OpenSlide returns RGBA regions. Loci records the number of non-opaque pixels and
retains the RGB component values as the analysis array. A later viewport should
choose and record any compositing background explicitly rather than silently
changing analysis values.

## Declared bounded region analysis

All analysis functions operate only on a previously decoded bounded region,
apply a separate caller-selected working-memory budget, and use `analysis_rgb`,
never the ICC-transformed display copy. Derived records retain the source hash,
level, downsample, and level 0 region extent needed to identify their sampling
basis.

`deconvolve_stains()` requires the caller to declare either `H&E` or `H-DAB`.
It uses the corresponding exact `skimage.color` separation matrix and returns
the matrix, component labels, method, input colour basis, and
`unvalidated-research-method` status with the derived float values. Loci does
not infer a stain or biological channel from appearance. Colour deconvolution
separates signals under a declared optical stain model; it does not establish
cell type, diagnosis, stain quality, or quantitative validity for a specimen.
For declared H&E, the returned third component is explicitly labelled the HED
matrix's DAB reference axis; it is not evidence that DAB is present. For H-DAB,
the third component is labelled the HDX complementary basis.

`tissue_mask()` is an explicit `otsu-dark-luminance` research recipe with
optional pixel-unit closing and small-component removal. It returns the resolved
threshold and complete recipe. It is a crop-level tissue-area aid, not a generic
or validated tissue classifier.

`analyze_polygon_roi()` accepts a bounded, simple polygon in level 0 XY
coordinates and reports the exact shoelace area and centroid, selected-level
pixel-centre sample count, mean source-device RGB, and optional tissue fraction.
When both positive X/Y MPP values are declared, it also reports area in square
micrometres and centroid in micrometres. Without calibration, physical values
remain `None` and physical-coordinate GeoJSON export is refused. GeoJSON can
use level 0 pixel coordinates or calibrated physical micrometres; properties
state the coordinate space, XY axis order, units, and source SHA-256. GeoJSON
contains no source path.

These region operations are deterministic CPU methods. They download no model,
runtime, recipe, or data.

## Dependencies and distribution

The tested implementation uses `openslide-python` 1.4.6 with the OpenSlide
4.0.1 runtime. OpenSlide's official installation page provides native packages,
including Homebrew and the `openslide-bin` PyPI distribution. OpenSlide and its
official language bindings are LGPL-2.1, so bundled distribution still requires
the repository's notice, source/relinking, and release review.

- [OpenSlide Python API](https://openslide.org/api/python/)
- [Official OpenSlide downloads](https://openslide.org/download/)
- [OpenSlide supported-format notes](https://openslide.org/formats/)

The OpenSlide Python API is the authority for level 0 region coordinates,
selected-level sizes, pyramid downsample metadata, MPP property names, ICC
profile availability, and Pillow `ImageCms` conversion. OpenSlide documents
that a decoder error latches the handle; Loci converts such failures into a
failed region request and callers must discard the session.

## Public fixture evidence

Real decoder smoke checks use two official OpenSlide test-data files. The files
are never committed and remain under `/tmp/loci-release-run/wsi`:

| Route | Official fixture | Licence | Bytes | Published source SHA-256 | 64 × 64 analysis-RGB SHA-256 on OpenSlide 4.0.1 |
| --- | --- | --- | ---: | --- | --- |
| Aperio SVS | `Aperio/CMU-1-Small-Region.svs` | CC0-1.0 | 1,938,955 | `ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7` | `c51949e04131e1b26ab8f037a16b5efda632291585821ea3b108e7d7b00c29c1` |
| Hamamatsu NDPI | `Hamamatsu/CMU-1.ndpi` | CC0-1.0 | 198,030,965 | `edf4a1ccf395c7000ae93ad3b44c07d97043810e00be0c1d167dd09bbe436e46` | `df8942c11889154493bed318ca2e8a435e7f1892f71e703ac6759a54672e78be` |

The filenames, descriptions, byte counts, licences, and hashes come from the
[official OpenSlide test-data index](https://openslide.cs.cmu.edu/download/openslide-testdata/index.json).
The smoke test supplies the published hash when opening each source, checks the
detected format/vendor, exact pyramid dimensions/downsamples and declared MPP,
records both binding and native-library versions, and decodes a bounded 64 × 64 level 0 region. If the
external files are absent, this optional local test skips; synthetic contract
tests remain repository-contained.

The decoded-region hashes are regression evidence for the pinned decoder
runtime, not independent image truth or a biological reference.

The authorized local fixture command is:

```sh
mkdir -p /tmp/loci-release-run/wsi
curl --fail --location --output /tmp/loci-release-run/wsi/CMU-1-Small-Region.svs \
  https://openslide.cs.cmu.edu/download/openslide-testdata/Aperio/CMU-1-Small-Region.svs
curl --fail --location --output /tmp/loci-release-run/wsi/CMU-1.ndpi \
  https://openslide.cs.cmu.edu/download/openslide-testdata/Hamamatsu/CMU-1.ndpi
```

## Scientific method references

- Ruifrok AC, Johnston DA. Quantification of histochemical staining by color
  deconvolution. *Analytical and Quantitative Cytology and Histology*.
  2001;23(4):291-299. [PMID 11531144](https://pubmed.ncbi.nlm.nih.gov/11531144/).
- Otsu N. A threshold selection method from gray-level histograms. *IEEE
  Transactions on Systems, Man, and Cybernetics*. 1979;9(1):62-66.
  [doi:10.1109/TSMC.1979.4310076](https://doi.org/10.1109/TSMC.1979.4310076).

These primary papers describe the underlying mathematical methods. They do not
validate this implementation for a tissue, stain protocol, scanner, biological
endpoint, or clinical use.

## Remaining gaps

This module does not yet provide a decoded-tile cache, cancellation inside one
native decode, viewport/preload transport, publication rendering, associated
image access, multi-file formats, DICOM WSI, fluorescence channels, annotations
persisted into a project, or packaged macOS journey coverage. SVS and NDPI are
the only claimed OpenSlide routes here. Scanner/version diversity, corrupt-file
qualification, memory-pressure and long-run testing, display/export colour
parity, and cross-platform packaging remain release gates.
