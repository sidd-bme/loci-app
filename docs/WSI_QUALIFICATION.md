# Public WSI qualification

On 2026-09-07, the current `SlideAdapter` and `Workbench` were exercised with
two real public whole-slide files. This is structural, coordinate,
reproducibility, and bounded-execution qualification. It is not biological,
stain, tissue, phenotype, diagnostic, or accuracy validation.

The primary OpenSlide test-data index reports both individual files as
`CC0-1.0`:

- `Aperio/CMU-1-Small-Region.svs`: 1,938,955 bytes, SHA-256
  `ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7`.
- `Hamamatsu/CMU-1.ndpi`: 198,030,965 bytes, SHA-256
  `edf4a1ccf395c7000ae93ad3b44c07d97043810e00be0c1d167dd09bbe436e46`.

Source: <https://openslide.cs.cmu.edu/download/openslide-testdata/index.json>

The local files matched those sizes and hashes before the run, and their full
hashes were unchanged after the workflow. Exact nonzero-origin RGB regions at
level 0 and the last level matched direct OpenSlide/Pillow reference pixels.
The one-level SVS therefore exercised two distinct level-0 origins; the NDPI
exercised level 0 and level 8. First and warm reads remained bounded to the
requested rectangles.

| File | Adapter startup including identity hash | Level 0 first / warm read | Last-level first / warm read | Worker peak RSS |
| --- | ---: | ---: | ---: | ---: |
| CMU-1-Small-Region.svs | 0.007 s | 0.0011 / 0.0003 s | 0.0003 / 0.0003 s | 176.4 MiB |
| CMU-1.ndpi | 0.096 s | 0.0016 / 0.0001 s | 0.0011 / 0.0001 s | 189.2 MiB |

For the NDPI, a decoded level-0 RGB plane would require 5,858,918,400 bytes.
Adapter-startup peak RSS was 123,224,064 bytes, 2.10% of that plane, and the
complete isolated worker remained below a declared 8 GiB machine budget. This
supports bounded region decoding rather than eager whole-slide decoding.

For each source, a bounded 512 × 512 native crop was processed through an
explicitly declared H&E basis, Otsu component segmentation, a declared
qualification-only measurement rule, tissue masking, polygon measurement, and
strict annotation GeoJSON and measurement-table reopen checks. The SVS yielded
5 rule-classified objects and the NDPI 253. These counts only demonstrate that
the implemented workflow produced inspectable non-empty outputs for these
declared settings.

Neither specified file contains an embedded ICC profile. Their declared
missing-profile/no-transform display output matched the independent Pillow
reference exactly. This run does not qualify the embedded-profile
source-to-sRGB transform branch.

## Deterministic nonidentity ICC reference

Engine checkpoint `5cf198a` includes
`test_nonidentity_icc_display_matches_analytic_linear_to_srgb` in
`engine/tests/test_whole_slide.py`; the full engine run passed 685 tests. The
test builds a linear-transfer-curve RGB profile from Pillow's sRGB primaries,
keeps the raw analysis RGB unchanged, and compares the transformed display RGB
with the analytic IEC sRGB transfer function. Its predeclared tolerance is at
most one 8-bit code value per component. This deterministic numerical reference
does not imply that either public slide above contains an ICC profile, and it is
not biological, stain, tissue, diagnostic, or accuracy validation. References:
[ICC sRGB registry](https://registry.color.org/rgb-registry/srgb) and
[ICC profile specification](https://www.color.org/icc1-v41.pdf).

The executable harness and detailed JSON receipt are intentionally outside the
repository at `/tmp/loci-release-run/wsi/qualify_wsi.py` and
`/tmp/loci-release-run/wsi/wsi-qualification.json`. The receipt records commit
`d5c5b0d17e638383141c9b2dd77adad2699d3a3e` and that the tested working tree had
uncommitted changes.
