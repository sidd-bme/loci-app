# Epidermal thickness: current scope and automation feasibility

Reviewed 2026-09-12. This document describes an engineering capability and a
future evaluation route; it does not establish biological measurement accuracy.

## Implemented scope

Loci supports user-drawn, straight epidermal transects on source images.
Researchers choose the upper and lower boundaries, orientation rule, exclusion
criteria, and suprapapillary, ridge-base or custom class. These are explicit
protocol choices; Loci does not identify tissue layers or ridge tips automatically.

Each new transect retains structured protocol metadata, source identity, plane
and time, geometry, measured length, units, and review state. An approved record
requires a nonempty reviewer name. CSV export uses each saved transect's protocol,
not the current form values, and includes zero-based Z/T and level-zero pixel-edge
coordinates. Legacy label-only records remain available but their missing protocol
and review evidence are marked unverified. Review status records the user's
confirmation; it is not independent validation.

Lengths use source geometry and calibration. Uncalibrated sources remain in
pixels. Suprapapillary and ridge-base summaries are separate, descriptive summaries
of sampled transects. They are not automatic minima or maxima over the section,
and transect counts are not independent patient or specimen counts. Multiple
protocols or review states must be inspected before interpreting a summary.

The source annotation tests cover geometry, calibration, bounded history,
reopen/interchange and metadata preservation. Packaged-app evidence and remaining
qualification gaps are recorded in [PROJECT_STATE.md](../PROJECT_STATE.md).

## Evidence and corrections

| Candidate or method | Verified evidence | Loci decision |
| --- | --- | --- |
| PathoEye | Lin et al. describe epidermis extraction and basement-membrane-zone guided WSI analysis. The upstream README advertises example data and pretrained weights on Figshare, plus an epidermal-thickness command. It labels the code MIT. | A candidate for further inspection. Exact checkpoint identity, weight licence, completeness of the advertised scripts, safe loading, offline compatibility and resource use have not been qualified. No asset was downloaded or executed in this review. |
| Manual skin morphometry | Costello et al. report minimum and maximum viable-epidermis measures as distinct quantities in their skin-ageing study. | Supports retaining distinct measurement definitions. It does not validate Loci's implementation, operator reproducibility or a universal histology protocol. |
| Cellpose, StarDist and SAM | No specific epidermis checkpoint, runtime or thickness protocol was evaluated in this repair. | Keep as possible future candidates. Availability of a general segmentation method does not establish the intended epidermal measurement. |

Primary sources: Lin et al., *PathoEye: A deep learning framework for the
whole-slide image analysis of skin tissue*, 2025,
[DOI 10.1016/j.csbj.2025.11.052](https://pmc.ncbi.nlm.nih.gov/articles/PMC12699262/),
[upstream README](https://github.com/lysovosyl/PathoEye);
Costello et al., *Quantitative morphometric analysis of intrinsic and extrinsic
skin ageing in individuals with Fitzpatrick skin types II–III*, 2023,
[DOI 10.1111/exd.14754](https://pubmed.ncbi.nlm.nih.gov/36695185/).

The previous version's statements that no weights were available, that particular
models necessarily exceeded a 2 GB runtime budget, that generic methods cannot
segment epidermis, and that manual measurements were highly reproducible or
biologically qualified were not supported by this review and have been removed.

## Feasible next step

A future assisted workflow should propose editable upper/lower boundaries, retain
human corrections, and measure only under a declared thickness definition.
Before adopting a candidate, verify exact files and rights, inspect its loading
path, benchmark an isolated offline runtime, and compare measurements against
independently reviewed authorized histology with difficult ridges, folds, tears,
appendages and oblique sections. Keep specimens and patients grouped in evaluation.
Permit abstention when boundaries or geometry are unreliable. Package a model only
after those checks support the intended use; the calibrated manual workflow remains
available without it.
