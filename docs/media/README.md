# Product media and image credits

These screenshots and the silent, captioned product video show the packaged
macOS application. They demonstrate actual viewing, annotation, illustrative
analysis, review, and display controls. They do not establish biological
accuracy, clinical suitability, or completed release qualification. See the
[current verification record](../PROJECT_STATE.md).

The repository maintains two sets of media: the **automated CC0 fixture suite**
and the **UI polish gallery**.

---

## 1. Automated CC0 fixture suite & demo video

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

- Exact SHA-256 checksums, dimensions, and capture metadata for all media assets are recorded in [provenance.json](provenance.json).
- The underlying scientific fixtures retain their CC0-1.0 dedication.
- Loci application code, interface designs, and packaging are licensed under [Apache-2.0](../../LICENSE).
