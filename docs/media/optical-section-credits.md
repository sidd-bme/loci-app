# Optical Section

*Optical Section* is a 2-minute, 4-second film made for Loci. It combines workbench recordings, camera moves rendered from public microscopy, animated contours drawn from real label arrays, and an original instrumental score. The assistant sequence replays the public messages and tool calls from a recorded session. [Film (MP4)](optical-section.mp4) · [Screenshot credits](README.md#current-readme)

## Mouse embryo

Katie McDole and colleagues recorded the post-implantation mouse embryo by light-sheet microscopy. The opening uses H2B-eGFP and myr-tdTomato in IDR0044, image 4007801, at acquisition index 450. Loci adapted the crop, transfer functions, display colours and camera motion. The timed preview uses one local precomputed OME-Zarr channel, with 16.35 GiB of uncompressed level-zero data. The 2.98-second preview time is the median across five fresh-profile opens on an 8 GiB Apple M1 with build 60. [Image record](https://idr.openmicroscopy.org/webclient/?show=image-4007801) · [Dataset and CC BY 4.0 terms](https://doi.org/10.17867/10000116) · [Original study](https://doi.org/10.1016/j.cell.2018.09.031)

## Human stem cells

Thirstrup and the Allen Institute for Cell Science Microscopy & Image Analysis Team contributed BBBC034v1, distributed by the Broad Bioimage Benchmark Collection under CC BY 4.0. The colony-edge view follows GFP-labelled β-actin and DNA through depth. The colony-centre view traces the 38 whole-cell labels returned by Cellpose-SAM v2 on one section. The collection's manual annotations mark nuclei. The single-cell orbit uses an estimated enclosing mask derived from a public nuclear annotation and the fluorescence in field AICS_12_134. The film crops, projects, recolours and animates these images. The orbit shows plasma membrane, GFP-labelled α-tubulin and DNA. [Images and annotations](https://bbbc.broadinstitute.org/BBBC034) · [Collection citation](https://doi.org/10.1038/nmeth.2083) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) · [Cellpose-SAM checkpoint and BSD-3-Clause terms](https://huggingface.co/mouseland/cellpose-sam/blob/7c61431b5fbb078f3296754bd15d9f51b320f837/README.md)

## Nuclear segmentation and kidney fluorescence

The 2018 Data Science Bowl contributors released the fluorescence field and human masks under CC0. The Broad Institute Imaging Platform curated BBBC038v1. Uwe Schmidt, Martin Weigert and colleagues developed StarDist. Its 2D versatile fluorescence model ran externally on CPU, and Loci imported its integer labels. The animated contours and plots use those labels and the raw image. Sizes are in pixel units. At an intersection-over-union threshold of 0.50, 48 predictions matched 48 of the 49 reference nuclei. [Image and terms](https://bbbc.broadinstitute.org/BBBC038) · [StarDist paper](https://doi.org/10.1007/978-3-030-00934-2_30) · [Model release and BSD-3-Clause terms](https://github.com/stardist/stardist-models/releases/tag/v0.1)

Genevieve Buckley, Monash Micro Imaging (2018), supplied the three-channel kidney stack. Two channels are shown in selected colours through 16 sections. The linked view returns to the ninth section. The closing kidney image projects six sections. [Source and authorship](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.kidney) · [CC0](https://creativecommons.org/publicdomain/zero/1.0/)

## Melanoma tissue

Mark Schuiveling, Willeke Blokx and Gerben E. Breimer, University Medical Center Utrecht, released the PUMA v5 H&E fields and expert tissue and nucleus annotations under CC0. The study uses training fields 001 and 003, with the separately licensed MIT fold-4 PUMA nnU-Net checkpoint. The recorded assistant session selected that model and received single-use approvals for the two previews and two runs. A separate local spatial analysis counted expert-annotated lymphocytes per observed area within 40 µm on each side of each field's longest shared tumor–stroma boundary. The findings describe those two fields. The poster crops the closing view of field 003. [Dataset and licence](https://doi.org/10.5281/zenodo.15050523) · [Annotation methods](https://doi.org/10.1093/gigascience/giaf011) · [Model and licence](https://doi.org/10.5281/zenodo.14651631)

## Closing sequence, type and sound

The maize stem cross-section comes from the Berkshire Community College Bioscience Image Library. Loci cropped the image around a vascular bundle and adjusted the exposure. [Original](https://www.flickr.com/photos/146824358@N03/35716061792/) · [CC0](https://creativecommons.org/publicdomain/zero/1.0/)

D. Burnette and J. Lippincott-Schwartz, NICHD/NIH, produced the mouse fibroblast micrograph. Loci cropped and animated it inside the Loci mark. [Original](https://www.flickr.com/photos/nichd/19124186316/) · [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)

Instrument Sans, IBM Plex Mono and Noto Sans are distributed under the SIL Open Font License 1.1. Loci provided the edit, graphics and original synthesized instrumental score. [Instrument Sans](https://github.com/Instrument/instrument-sans) · [IBM Plex](https://github.com/IBM/plex) · [Noto Sans](https://github.com/notofonts/latin-greek-cyrillic) · [OFL](https://openfontlicense.org/open-font-license-official-text/)
