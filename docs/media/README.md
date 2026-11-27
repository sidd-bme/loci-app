# Product media and image credits

## Current README

The [workbench tour credits](tour/README.md) identify the specimens, display choices and licences for the current product screenshots and CLI session. [Optical Section credits](optical-section-credits.md) cover the demonstration film.

## Earlier workbench captures

These two earlier workbench screenshots were captured in Loci build 77 on macOS. Both use the native Black theme. The published images are resized WebP versions of the full application captures. [Application source](https://github.com/sidd-bme/loci-app/tree/89fdf9b1691f9e487627df49e9aac8efba155df5)

- **[Human iPSC colony](ipsc-workbench.webp).** Thirstrup and the Allen Institute for Cell Science Microscopy & Image Analysis Team contributed BBBC034v1. From field AICS_12_134, six consecutive acquired sections (zero-based Z 15–20) of the three fluorescence channels were copied losslessly into an OME-TIFF. Loci projects the maximum per channel and uses amber for plasma membrane, aqua for GFP-labelled α-tubulin and violet for DNA. The view is enlarged and the display ranges adjusted. Source sampling is 0.065 µm in X and Y and 0.29 µm in Z. The image and its adaptation are credited under CC BY 4.0. [Dataset](https://bbbc.broadinstitute.org/BBBC034) · [Cell line](https://cell-catalog.allencell.org/cell-line/aics-12-105/) · [Collection citation](https://doi.org/10.1038/nmeth.2083) · [Licence](https://creativecommons.org/licenses/by/4.0/)
- **[Nuclear segmentation comparison](nuclei-comparison.webp).** Hoechst fluorescence from U2OS cells, plate position A06, site 6, in BBBC039v1 (Caicedo et al., Broad Bioimage Benchmark Collection, CC0). Two methods ran on the same 696 × 520 pixel field. The BioImage.IO nuclei boundary ONNX model with connected-component postprocessing yielded 66 objects and classical thresholding with connected components yielded 67. At an intersection-over-union threshold of 0.50, 56 pairs matched. The selected model label, 49, has an area of 851 px² and no match at that threshold. Colours identify predicted objects. This comparison uses the two predictions as its inputs. [Dataset and licence](https://bbbc.broadinstitute.org/BBBC039) · [Model publisher](https://doi.org/10.5281/zenodo.6647674) · [Comparison workflow](../AGENT_ACCESS.md#compare-two-segmentation-methods-with-your-assistant)
- **[*Optical Section*](optical-section.mp4).** The film poster uses a cropped frame of the PUMA melanoma field in the closing sequence. The complete film is 2 minutes 4 seconds. [Film credits and methods](optical-section-credits.md)

## Model Zoo

[The gallery image](model-zoo.webp) is a crop of the running Loci workbench. The original screenshot was captured at 1336 × 932 pixels from public commit `616615ebb8da`. The WebP preserves the pixels inside the dialog.

| Example in reading order | Specimen and credit |
| --- | --- |
| Cellpose-SAM v2 | Allen Institute for Cell Science, BBBC034v1. Three fluorescence channels and predicted cell contours. [CC BY 4.0 and source](../../desktop/src/renderer/model-zoo/examples/cellpose-sam-v2/credit.json) |
| µSAM | Mariusz Marzec, Adam Piórkowski and Arkadiusz Gertych. A DAPI optical section from the upstream example volume. [CC BY 4.0 and source](../../desktop/src/renderer/model-zoo/examples/micro-sam-vit-b-lm/credit.json) |
| StarDist | 2018 Data Science Bowl contributors, BBBC038v1. Nuclear fluorescence and predicted instance contours. [CC0 and source](../../desktop/src/renderer/model-zoo/examples/stardist-2d-versatile-fluo/credit.json) |
| BioImage.IO nuclei boundary model | Constantin Pape's supplier test image from BBBC038, with contours derived from the foreground output. [CC BY 4.0 and source](../../desktop/src/renderer/model-zoo/examples/bioimageio-nuclei-boundary-onnx/credit.json) |
| PUMA tissue nnU-Net | PUMA authors' melanoma H&E training region 004, with the fold-4 model's epidermis prediction. [CC0 and source](../../desktop/src/renderer/model-zoo/examples/puma-tissue-cpu/credit.json) |

## October 2026 showcase

The October 2026 homepage featured a 74-second launch film alongside application
captures. The tour combines native views, arranged analysis graphics and recorded
command-line output. [Watch the October film](https://github.com/user-attachments/assets/d825ca58-b8ed-4011-83e0-a6ea6b4fe6b3) · [Launch film credits](launch-credits.md)

- `histology-current.png`: native CMU-1 view; OpenSlide test data, CC0.
- `fluorescence-volume-current.png`: native BBBC032 volume and channel controls; provider copyright and related-rights waiver.
- `linked-mri-current.png`: native linked views of the MNI ICBM152 nonlinear asymmetric 2009b template; full notice in the film credits.
- `launch-poster.png`: title card from the finished film.
- `cellpose-population-current.png`: native 0.2.0 candidate showing the maintainer-authorized image and retained Cellpose labels, with the full 4,837-object population. The screenshot uses encoded RGB components and uncalibrated pixel units; no new model run.
- `cli-workflow.gif`: genuine PTY output replay from the film, resized to 1200 pixels wide at 12 fps; waiting and typing cadence are editorially conformed.
- `medical-volume.gif`: native MNI template volume captures, resized to 1200 pixels wide at 12 fps; full source notice is in the film credits.
- `mcp-overview.svg`: capability overview drawn from the agent-access guide; an explanatory diagram, not an application screenshot.

The histology, fluorescence and MRI views were captured during development for the film.
The Cellpose population view was captured from public candidate `c041ff2`. File hashes and
its exact application identity are recorded in the
[showcase manifest](showcase.json).

## Earlier media collections


The earlier homepage combined public-sample fluorescence and histology screenshots with
maintainer-provided captures of 3D microscopy, linked volume slices and channel
controls. Captures show the real application, including development builds; they
are not a version-specific feature guarantee for the downloadable beta. Earlier recordings are retained as archive material.

### Maintainer-provided presentation captures

| File | View |
| --- | --- |
| `embryo-volume.png` | Multichannel embryo fluorescence in the 3D viewer. |
| `linked-volume-slices.png` | A NIfTI volume with three orthogonal slices and a 3D view. |
| `channel-controls.png` | Per-channel histograms, colour, range, gamma and opacity controls. |

These captures were supplied and authorized by the maintainer for this repository
on 27 September 2026 and copied without modification. Exact build identity and
underlying dataset licences were not supplied; the CC0 statement below does not
apply to them. Original filenames, dimensions and hashes are recorded in
[presentation-captures.json](presentation-captures.json).

The older media collections below retain their original provenance. Screenshots
illustrate the interface, not biological accuracy or clinical validation.

---

## 1. Public sample screenshots and archived recordings

The baseline screenshots and captioned product video were generated under
automated test harnesses from three rights-cleared, public **CC0-1.0** fixtures.
The source arrays were not retouched. Display colours, ranges, camera angles,
and selected planes were set through Loci's real controls.

| Fixture | Credit and source | Preparation |
| --- | --- | --- |
| `Phase cell.ome.tiff` | Paul Müller, Mirjam Schürmann, Salvatore Girardo, Gheorghe Cojoc and Jochen Guck, [Optics Express (2018)](https://doi.org/10.1364/OE.26.010729); [scikit-image cell documentation and CC0 statement](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.cell) | Exact uint8 pixels from `cell.png` written as tiled OME-TIFF, with the documented 0.107 µm XY spacing. This is a quantitative phase image. |
| `Kidney fluorescence.ome.tiff` | Genevieve Buckley, Monash Micro Imaging (2018); [scikit-image kidney documentation and CC0 statement](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.kidney) | Exact TIFF pixels reordered from ZCYX to explicit TCZYX OME axes, with documented calibration. No intensity rescaling was applied to the source. |
| `CMU-1-Small-Region.svs` | [OpenSlide Aperio test data](https://openslide.cs.cmu.edu/download/openslide-testdata/Aperio/), item licence CC0-1.0 | Original downloaded SVS bytes. This small exported region has one stored level; it demonstrates the SVS reader and native detail. |

### Baseline automated media files (3200 × 1800 px)

- **`multichannel.png`**: Single-plane multichannel fluorescence viewing of `Kidney fluorescence.ome.tiff`, displaying 450 nm, 515 nm, and 605 nm channels with explicit false-coloring.
- **`native-slide.png`**: Aperio SVS whole-slide histology viewing using `CMU-1-Small-Region.svs`.
- **`segmentation.png`**: Illustrative adaptive watershed segmentation and object review table on `Phase cell.ome.tiff`. The displayed object count is not a ground-truth count.
- **`raw-volume.png`**: Direct GPU ray-cast 3D volume view of `Kidney fluorescence.ome.tiff` showing the 450 nm channel at opacity 0.2.
- **`annotation.png`**: Manual calibrated bounding box annotation on `Phase cell.ome.tiff`.
- **`welcome.png`**: Application shell welcome state upon initial launch.

### Demo video

- **`loci-product-demo-1080p.mp4`** (and poster `loci-product-demo-poster.png`): Silent, captioned product video (78.9 s, 1080p, 30 fps) demonstrating uncropped application frames across the three CC0 fixtures. Contains no simulated interface or artificial animations. The capture workflow is detailed in `scripts/demo/demo-manifest.json`.

---

## 2. UI polish gallery screenshots (`*_2.png`, 3360 × 2100 px)

These screenshots were captured during interface refinement passes on real interactive sessions using the packaged macOS application. They demonstrate the refined dark workbench theme, multi-pane layouts, model-guided segmentation, and diverse scientific modalities:

| File | Modality & fixture depicted | Workflow & content shown |
| --- | --- | --- |
| **`native-slide_2.png`** | Multiscale hierarchical bioimage pyramid in Bitplane Imaris (`.ims`) format (`CSM_10_A2_6_Merged_ch00_SV.ims`, 3 C / 1 Z) | Native-resolution pyramid inspection, level navigation, viewport navigator, and layer stack management without image flattening. |
| **`segmentation_2.png`** | Cell culture phase-contrast image (`FBS3.jpg`, 1 C / 1 Z) | Model-guided segmentation via Cellpose-SAM scoped to a user-drawn region of interest (1,100 × 849 px), displaying 200 detected object boundaries and interactive quantitative measurement table. |
| **`raw-volume_2.png`** | Volumetric medical MRI study (`chris_t2.nii.gz`, NIfTI-1/2 format) | Four-pane orthogonal Multi-Planar Reformatting (axial, sagittal, coronal MPR slices) linked with direct 3D GPU ray-cast volume rendering. |
| **`multichannel_2.png`** | Multichannel fluorescence microscopy session (`KM_LNG_00PY_...`) | Multichannel acquisition viewing displaying channel toggles and tiled acquisition boundaries; preserved as an interface reference. |

*Note: These `*_2.png` files capture interactive workbench states and are distinct from the automated CC0 test fixture suite above.*

---

## 3. Provenance & licensing

- Exact SHA-256 checksums, dimensions, and capture metadata for the original media collections are recorded in [provenance.json](provenance.json); the new presentation captures have their separate manifest above.
- The three baseline scientific fixtures listed in section 1 retain their CC0-1.0 dedication. This statement does not assign a licence to the separate UI polish gallery.
- Loci application code, interface designs, and packaging are licensed under [Apache-2.0](../../LICENSE).
