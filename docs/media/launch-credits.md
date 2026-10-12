# Loci launch film credits

The 74-second film presents Loci with scientific images credited below, including a montage of 24 distinct source images. Source reuse does not imply provider endorsement. Each image retains its own rights; Loci's software licence does not relicense third-party media.

This edited tour combines native application captures with arranged analysis and MCP graphics. Its CLI segment faithfully replays recorded POSIX PTY bytes through xterm.js; it is not a native macOS Terminal recording. Illustrative workflows do not establish biological accuracy, clinical suitability or qualification of a downloadable release.

## Main scientific sources

| Source | Credit and rights | Modifications |
| --- | --- | --- |
| [CMU-1.svs](https://openslide.cs.cmu.edu/download/openslide-testdata/Aperio/) | OpenSlide Aperio test-data collection, exact CMU-1 item; CC0. | Actual native Loci histology opening, camera/framing, crop/scale and timing. Distinct from CMU-1-Small-Region.svs. |
| Maintainer image and retained Cellpose labels | Maintainer-provided image, used with permission. | Unchanged 3088×2000 field and 4,837 imported label IDs; encoded RGB components and uncalibrated pixel units. No new model run; no checkpoint is distributed. |
| [CIL:50647 endothelial cells](https://www.cellimagelibrary.org/images/50647) | Ashwin Inala and Eileen Shiuan (2019), Cell Image Library; Dr. Jin Chen's lab, Vanderbilt University Medical Center. Provider declares public domain. | Original 2667×2008 RGB TIFF represented pixel-identically as PNG; editorial crop/scale/timing. Provider recoloured nuclei from blue to red and vascular endothelial cadherin from red to cyan. |
| [CIL:214 nerve ending](https://www.cellimagelibrary.org/images/214) | Tina Carvalho (2011), Cell Image Library. Provider declares public domain. | Provider's 3000×2395 RGB JPEG represented pixel-identically as PNG; editorial crop/scale/timing. This is provider-colourized SEM, not fluorescence; colours do not establish biological channels. |
| [CIL:36695 dividing zebrafish embryo](https://www.cellimagelibrary.org/images/36695) | Martin Wuehr and Timothy Mitchison, Cell Image Library. Provider declares public domain. | Explicit derived maximum over all 56 Z planes of the 56×3×2048×2048 ZCYX uint8 source. Stored C0→red, C1→green, C2→blue are authored display colours with unknown dye correspondence. Raw maxima preserved at shared range 0–255, gamma 1; no per-channel normalization. Editorial crop/scale/timing. |
| [BBBC032v1](https://bbbc.broadinstitute.org/BBBC032) | Nicolas Rivron, Laboratory for Modeling Development and Regeneration, Hubrecht Institute; Rivron et al. (2018), via BBBC. Provider records copyright and related-rights waiver. | Exact two-channel source crop 172×800×800 ZYX; native corrected volume overview 55×256×256 ZYX, transfers/camera and editorial framing/timing. Display pixels differ from original scalar source resolution. |
| [S-BIAD564 IM191](https://uk1s3.embassy.ebi.ac.uk/bia-integrator-data/pages/S-BIAD564/IM191.html) | Katrin Möller, Amber Villani and Isabel Kemmer, BioImage Archive; CC0. | Retained fixed original Z18 at existing pyramid level 1; 82 timepoints with 60 s acquisition interval. Native display mapping, editorial brightness/framing and accelerated playback. Film time differs from acquisition time. |
| [BBBC039v1](https://bbbc.broadinstitute.org/BBBC039) | Caicedo et al. (2018), Broad Bioimage Benchmark Collection; CC0. | Local MCP segmentation result and overlay, 67 objects and uncalibrated pixel² statistics. Separate from the maintainer image. |
| [MNI ICBM152 nonlinear asymmetric 2009b T1](https://www.mcgill.ca/bic/icbm152-152-nonlinear-atlases-version-2009) | Louis Collins, McConnell Brain Imaging Centre, Montreal Neurological Institute, McGill University; full official notice below. | Original 0.5 mm isotropic population template, 394×466×378 XYZ. Source voxel values, including small negative values, and geometry are unchanged. Bounded volume display, transfer mapping, camera, themes, orthogonal planes, framing and timing are display choices; no source resampling. |

BBBC collection reference: [Ljosa et al., Nature Methods (2012)](https://doi.org/10.1038/nmeth.2089).

## Additional montage sources

The following provider images were converted losslessly to PNG, preserving decoded RGB components and retained ICC profiles. Editorial changes include cropping, scaling and timing. Three images use lossless source-pixel regions, noted individually below. These steps preserve provider pixels, including any upstream JPEG compression or processing; RGB colours do not independently establish biological channel identity.

| Source | Credit and rights | Source presentation and modifications |
| --- | --- | --- |
| [Osteosarcoma cells: actin, microtubules and nuclei](https://commons.wikimedia.org/wiki/File:Osteosarcoma_cells_stained_for_actin,_microtubules,_and_nuclei.png) | Howard Vindin; [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). | Provider authored RGB fluorescence display; colour labels are creator declarations, not independent biological validation. Display intensity processing is not independently established. |
| [Actin filaments in a neuroblastoma cell line](https://commons.wikimedia.org/wiki/File:Actin_Filaments_in_a_Neuroblastoma_cell_Line.png) | Howard Vindin; [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). | Provider authored RGB fluorescence display; colour labels are creator declarations, not independent biological validation. Display intensity processing is not independently established. |
| [Rat primary cortical neuron culture](https://commons.wikimedia.org/wiki/File:Rat_primary_cortical_neuron_culture,_deconvolved_z-stack_overlay_(30614937102).jpg) | ZEISS Microscopy; [CC-BY-2.0](https://creativecommons.org/licenses/by/2.0/). | Provider deconvolved Z-stack overlay. |
| [Oocyte cortex and microvilli TEM](https://www.cellimagelibrary.org/images/12618) | Prue Talbot; Public domain (Cell Image Library notice below). | Uncolorized TEM stored as RGB; provider unprocessed-data descriptor and reported 0.0067 micrometre pixel size are source metadata, not independently validated calibration. |
| [H&E lymphocyte tissue field](https://www.cellimagelibrary.org/images/43601) | Gabriel Caponetti; [CC-BY-3.0](https://creativecommons.org/licenses/by/3.0/). | Provider H&E RGB display; no physical pixel calibration supplied. Source diagnosis is not an inference from image appearance. |
| [Microscopy in bloom: mouse dorsal root ganglion](https://commons.wikimedia.org/wiki/File:Microscopy_in_bloom.jpg) | Saraifveiga; [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). | Provider authored RGB fluorescence display; colour labels are creator declarations, not independent biological validation. Display intensity processing is not independently established. Lossless source-pixel ROI used. |
| [Chlamydomonas reinhardtii eyespot TEM](https://www.cellimagelibrary.org/images/9523) | Mary Morphew and J. Richard McIntosh; Public domain (Cell Image Library notice below). | TEM display derivative of a 250 nm embedded section at +6 degrees tilt. Related 0 and -6 degree views are excluded as repeats of the same source group. |
| [Microplastics that have penetrated inside cells](https://commons.wikimedia.org/wiki/File:Microplastics_that_have_penetrated_inside_cells.png) | Karimov Denis, Valova Iana; [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). | Authored RGB fluorescence display. Source colour descriptions conflict; no stain correspondence, particle size or intracellular uptake is asserted. |
| [Rat alveolar type II cell after ethoxyethane exposure](https://www.cellimagelibrary.org/images/50303) | Marian Miller, Cell Image Library; Public domain (Cell Image Library notice below). | Provider pseudocoloured TEM; colours are presentation choices, not fluorescence channels. |
| [Purkinje neuron cell bodies in a mouse cerebellum fold - Ksena Longrin](https://commons.wikimedia.org/wiki/File:Purkinje_neuron_cell_bodies_in_a_mouse_cerebellum_fold_-_Ksena_Longrin.png) | Morne Arin (uploader); Ksena Longrin (filename credit); [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). | Creator-declared deconvoluted max-Z of 28 slices and red/yellow/blue channel mapping. Source descriptions disagree on anatomical preparation and meaning of 4.32 micrometres; neither is asserted or used as calibration. |
| [SK8-18-2 human derived cells, fluorescence microscopy (29942101073)](https://commons.wikimedia.org/wiki/File:SK8-18-2_human_derived_cells,_fluorescence_microscopy_(29942101073).jpg) | ZEISS Microscopy; [CC-BY-2.0](https://creativecommons.org/licenses/by/2.0/). | Creator-declared vimentin green and DAPI blue. Projection and intensity processing unspecified. |
| [Xenopus egg](https://www.cellimagelibrary.org/images/36441) | Martin Wuehr and Timothy Mitchison, Cell Image Library; Public domain (Cell Image Library notice below). | Provider confocal display of Xenopus egg with alpha-tubulin green and gamma-tubulin red. Projection and intensity-processing method not specified. |
| [Human gallbladder H&E field](https://www.cellimagelibrary.org/images/34859) | William Karkow; Public domain (Cell Image Library notice below). | Provider adjusted colour balance. Stated scale is approximate and not independently established here. |
| [SH-SY5Y cells in a microwell plate](https://commons.wikimedia.org/wiki/File:SH-SY5Y_cells_cultured_on_a_384_microwell_plate,_imaged_with_ZEISS_Celldiscoverer_7_(30614937472).jpg) | ZEISS Microscopy; sample courtesy P. Denner, DZNE; [CC-BY-2.0](https://creativecommons.org/licenses/by/2.0/). | Provider extended depth of focus from one position with five channels; not a raw single optical section. |
| [Fibroblast,polydopamine nanoparticles and mithocondria](https://commons.wikimedia.org/wiki/File:Fibroblast,polydopamine_nanoparticles_and_mithocondria.jpg) | Matteo.battaglini91; [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). | Creator-declared red mitochondria, green dye-labelled nanoparticles, blue nuclei. Projection and intensity processing unspecified. Uptake is a creator interpretation, not established here. |
| [Mouse cerebellar sclices showing Purkinje neurons](https://commons.wikimedia.org/wiki/File:Mouse_cerebellar_sclices_showing_Purkinje_neurons.jpg) | Achinraj; [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). | Creator describes sagittal mouse cerebellum confocal. Stain identities, projection and display normalization not supplied. |
| [Microtubule binding domain fused with GFP-tag reveals microtubule network of HeLa cell line](https://commons.wikimedia.org/wiki/File:Microtubule_binding_domain_fused_with_GFP-tag_reveals_microtubule_network_of_HeLa_cell_line.jpg) | DrBib; [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). | Creator describes Opera Phenix Plus confocal 40x and GFP-tagged microtubule-binding domain. Projection, stitching and resampling unspecified; export dimensions are not optical resolution. Lossless source-pixel ROI used. |
| [Coronal section of a mouse brain](https://commons.wikimedia.org/wiki/File:Coronal_section_of_a_mouse_brain.jpg) | Syed07; [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). | Provider merged fluorescence and stitched a single coronal section; spatial mosaic, not a single raw optical exposure. Lossless source-pixel ROI used. |
| [Mouse alveolar macrophage containing fluorocarbon E2](https://www.cellimagelibrary.org/images/50301) | Marian Miller, Cell Image Library; Public domain (Cell Image Library notice below). | Provider pseudocoloured TEM; colours are presentation choices, not fluorescence channels. |

## Cell Image Library public-domain notice

This provider notice applies to the Cell Image Library images identified as public domain above:

> Public Domain: This image is in the public domain and thus free of any copyright restrictions. However, as is the norm in scientific publishing and as a matter of courtesy, any user should credit the content provider for any public or private use of this image whenever possible.

## MNI template references and notice

Requested references: Fonov VS et al. (2011), “Unbiased average age-appropriate atlases for pediatric studies,” NeuroImage 54(1), [publisher record](https://www.sciencedirect.com/science/article/pii/S1053811910010062); Fonov VS et al. (2009), “Unbiased nonlinear average age-appropriate brain templates from birth to adulthood,” NeuroImage 47, Supplement 1, S102, [publisher record](https://www.sciencedirect.com/science/article/pii/S1053811909708845).

The official dataset [COPYING notice](https://www.bic.mni.mcgill.ca/~vfonov/icbm/2009/COPYING) is reproduced verbatim:

```text
Copyright (C) 1993-2004 Louis Collins, McConnell Brain
Imaging Centre, Montreal Neurological Institute, McGill University.
Permission to use, copy, modify, and distribute this software and
its documentation for any purpose and without fee is hereby granted,
provided that the above copyright notice appear in all copies.  The
authors and McGill University make no representations about the
suitability of this software for any purpose.  It is provided "as
is" without express or implied warranty.  The authors are not
responsible for any data loss, equipment damage, property loss, or
injury to subjects or patients resulting from the use or misuse of
this software package.
```

## Software, fonts and audio

[Loci](https://github.com/sidd-bme/loci-app) software and interface are [Apache-2.0](../../LICENSE); retain the applicable [NOTICE](../../NOTICE). Scientific images remain subject to the individual terms above.

**Inter:** Copyright 2016 The Inter Project Authors; [SIL Open Font License 1.1](https://github.com/rsms/inter/blob/master/LICENSE.txt). The full notice accompanies bundled WOFF2 files. Times New Roman/Times and terminal system fonts were rendered locally; their font files are not distributed.

**Audio:** Original procedural composition and synthesized effects, conformed to the 74-second film. No sampled third-party material, paid music or external sound assets are included. Foley is editorial synthesis.
