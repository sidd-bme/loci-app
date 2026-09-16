# Using Loci

Loci is a local-first workbench for inspecting scientific images and creating traceable derived results. It leaves original image files where they are, and keeps display settings, annotations, results, reviews, and exports as separate work. Loci does not identify a stain or fluorophore from appearance, diagnose a sample, or establish biological or clinical validity.

This manual describes the implemented image-first workspace. It is bundled with the application and opens offline with `F1` or **Settings → User guide → Open user guide**. The manual has a searchable contents pane. The [capability matrix](CAPABILITY_MATRIX.md) defines supported source subsets and limits; [project state](PROJECT_STATE.md) records current qualification status.

## Contents

- [Start, save, and return](#start-save-and-return)
- [Read the workspace](#read-the-workspace)
- [View images and set display](#view-images-and-set-display)
- [Use histograms deliberately](#use-histograms-deliberately)
- [Annotate and define analysis scope](#annotate-and-define-analysis-scope)
- [Run practical analysis workflows](#run-practical-analysis-workflows)
- [Inspect scalar volumes and MPR](#inspect-scalar-volumes-and-mpr)
- [Review, batch, and export results](#review-batch-and-export-results)
- [Export rendered figures](#export-rendered-figures)
- [Medical, temporal, and registration work](#medical-temporal-and-registration-work)
- [Settings, recovery, and help](#settings-recovery-and-help)

## Start, save, and return

Select **Open images** or drop local items on the opening window. A single checked item can be a supported image, ordinary image folder, OME-Zarr store, `.loci-study` directory, or legacy `.loci-project` file. A multiple-item drop accepts supported image files only. Loci validates the full selection before changing the study, so an invalid or unsafe item does not leave a partly imported collection.

Use **Open folder** from the File menu for a recursive collection of ordinary images. Existing published `_loci` bundles are excluded. Use **Open DICOM series** for a deliberate DICOM series choice and **Open OME-Zarr store** for a store. DICOM encountered while opening an ordinary folder remains an explicit-series decision, which avoids silently assembling unrelated acquisitions. Use **Open study** for a saved study and **Open .loci-project** for a legacy project.

After opening a valid source, Loci creates a managed local session and saves derived work as it changes. To make a named study, choose **Save study…** in the header (also available under **File → Save as study…**). This creates a `.loci-study` snapshot without copying or modifying the original images. Keep original source locations available: reopening a study may require them to be present. The session status in the header distinguishes an autosaved session from saved local work.

**Recent work** opens saved studies and recoverable managed sessions. Its **Updated** time describes activity in Loci's session registry, such as an open, save, or reopen; it is not an acquisition timestamp. If a study or source location has moved, use the displayed recovery route to locate it again. Relinking requires the original source identity, so a different file at a familiar path is rejected. Discarding a managed session affects only Loci's derived session state and offers immediate Undo; it never deletes the source image.

## Read the workspace

The left column contains **Images**, then **Layers & results** for the selected image. Choose **Original image** to inspect source display, or select a result to inspect one exact derived revision. The centre is the image or volume viewport. The right inspector groups work under **View**, **Annotate**, **Analyze**, and **Results**. Its tool finder can reveal advanced routes such as portability, vendor conversion, remote compute, and assistant connection.

Three independent choices are central to reliable work:

- **Camera** is the area and magnification currently on screen.
- **Display** maps source values to rendered colour.
- **Analysis scope** is the source region, plane, channels, and settings supplied to the next operation.

Panning or zooming does not crop an analysis. Changing low/high values or a colour map does not alter source values or rewrite a completed result. A result preserves its source binding, grid, resolved settings, method/runtime information, and review state. Treat the right inspector as the declaration of the next operation, not the current camera frame.

## View images and set display

### Direct image viewing

Open **View → Image & channels**. **Image info** reports declared dimensions, axes, channel/sample count, depth/time count, and recorded calibration. The **Open as** choice is a presentation choice: Automatic, Generic image, Histology, Fluorescence, Volume, or Medical research. It changes offered workflow shortcuts, never source values or recorded axes.

For a direct inspection, select a source, choose **Fit** to show its whole plane, then use the wheel or pinch to zoom around the pointer and drag to pan. The main keyboard controls are:

| Action | Shortcut |
| --- | --- |
| Fit selected plane | `F` |
| 1:1 view | `1` |
| Zoom | `+` / `-` |
| Reset camera | `0` |
| Pan | Arrow keys |

At **1:1**, one source X pixel is presented for one physical display pixel; declared Y spacing is respected. Once the effective display scale reaches native resolution and beyond, the viewport uses nearest-pixel replication. The readout says **Beyond native · nearest pixel**. This makes individual stored pixels easy to inspect; it does not create detail. At lower display scales the viewport may smooth a reduced display. Large images first show a bounded overview and then load finer tiles. The navigator, when enabled, shows the full extent and current field of view.

Use the Z and Time sliders when the source declares those axes. **Play** advances a time series; pause it before inspecting a plane histogram. For Z data, the **View** menu selects **Single plane**, **Maximum projection**, or **Mean projection**. A projection is an explicit display operation over the shown Z range. It is not a raw plane, and it should not be treated as a three-dimensional object count or measurement.

### Scalar channels, RGB, and medical windows

For scalar sources, expand a channel under **Channels**. Set visibility, colour, **Low**, **High**, **Gamma**, and opacity. Low and high define the displayed range; gamma changes the mapping through it. **Auto** sets stable channel ranges from the selected source, T index, and Z plane. It does not calculate a range from a projection, current camera crop, or pan position. Selecting another plane or time point then pressing Auto deliberately gives a range for that selected plane.

Use **Reset** to restore acquisition/default display settings. Hold **Hold for source display** to compare temporarily with that baseline. For a medical source, or when **Open as → Medical research** is selected, each scalar channel also exposes **Window** and **Level**. Window is the displayed width and Level is its midpoint; these controls are the same display-range operation expressed in conventional medical terms. They do not apply a diagnostic preset or modify stored pixels.

An interleaved RGB or RGBA source is a colour image. Loci uses its stated display policy and applies a valid embedded ICC profile once to the display copy. **Image tone** provides one shared black point, white point, and gamma curve for RGB components. RGB components remain encoded display samples, not automatically biological channels.

For a scalar source with at least three channels, **Image info → RGB plane mapping** lets you explicitly select distinct planes for display red, green, and blue. Apply the mapping only when it is the intended visual composite; **Restore source composite** returns to the original representation. This is reversible display state. Analysis continues to use the original scalar channels rather than treating the composite as an inferred biological interpretation.

### Batch channel colors and A/B comparison viewing

Under **View → Image & channels**, select **Apply colors…** to propagate standard channel colors across multiple images in one step. Choose target scope (**Selected images** or **All loaded images** in the current session snapshot) and channel matching (**Name, then index**, **Channel name**, or **Channel index**). Select from standard microscopy presets (DAPI/GFP/TRITC/Cy5, RGB, CMY, Greyscale) or customize individual hex codes. The dialog provides a preflight preview showing affected images and explicit skip reasons for incompatible interleaved RGB sources. Color updates are display-only, do not alter raw pixel intensities or invalidate existing scientific reviews, and can be reversed across all affected images with **Undo colors**.

When two or more images are open, select **Compare A/B** in the canvas toolbar to inspect images side by side. Choose independent sources for **Pane A** and **Pane B**. Use **Match display (A → B)** to copy display ranges and colors from A to B (presentation only; does not standardize physical intensity). Each pane has its own T, Z and channel selection. **Link pan/zoom** is available when both panes show the same source identity and coordinate grid; matching dimensions alone do not establish correspondence. Display matching requires compatible channel mappings and remains a temporary comparison setting.

## Use histograms deliberately

Open **Histogram & levels** inside Image tone or an individual scalar channel. A 2D scalar histogram is a deterministic full-plane sample of the current T and Z plane, drawn from native scalar values. An RGB histogram is a sample of stored RGB component values before ICC display conversion. Neither sample follows the camera, and both remain tied to the selected plane even when Maximum or Mean projection is displayed. The panel names its sample count, T, Z, and level so that the display basis is visible.

Use the plotted black and white handles, or the matching numeric Low and High entries, to choose a display range. **Trim 1–99%** uses the sampled first and 99th percentile bin edges. It is a deliberate, binned approximation: values outside the chosen interval clip in the rendered display and rendered figures, while source pixels and analysis values stay untouched. The line below the plot reports the percentage in clipped sample bins. **Log counts** only changes how the histogram bars are viewed.

The histogram is useful for choosing a documented display range and recognizing saturation. It is not a quantitative assay, proof that images are comparable, or a reason to clean up pixels cosmetically. If comparison needs common display limits, set them deliberately and retain the exported display provenance.

## Annotate and define analysis scope

Choose **Annotate → Draw & measure** to make source-bound points, lines, rectangles, polygons, or freehand regions. Select the intended T and Z first. Loci binds the annotation to source identity and its T/Z location, so it appears on the appropriate plane. Use these geometry records for observation and stated measurements; a scale bar or physical unit appears only when trustworthy calibration is declared. Annotation interchange follows the strict rules in [annotation interchange](ANNOTATION_INTERCHANGE.md).

Drag to draw a rectangle, or click its opposite corners. A polygon closes when you click its first point, double-click the last point, or press `Enter`. For **Freehand region**, drag around the boundary and release to close it. Choose **Save annotation** to retain the draft; `Escape` clears it. Freehand regions use the same source-bound polygon format, with a visible vertex-limit notice for long traces.

For analysis, use **Analysis region** in Image & channels or the right-side **Analysis scope** card. Set X, Y, width, height, analysis channel, Z start, optional Z depth/range, and T as needed. The inspector also offers **Draw region** and **Whole image**. A yellow analysis rectangle is a declared input area, separate from the camera. Confirm it before running processing, segmentation, a model, puncta work, or a measurement.

When a segmentation result is selected, use **Annotate → Edit labels & ROIs** for correction of that exact revision. Brush, polygon, merge, delete, and supported watershed-split tools produce a new unreviewed revision while retaining the parent. Corrections do not edit source pixels and do not turn a result into ground truth.

### Calibrated epidermal transects and rete ridge morphometry

Choose **Annotate → Epidermal thickness** for the guided manual measurement workflow on histology sections. State the named measurement definition (specifying upper/lower tissue boundaries, orientation rule, and exclusion criteria such as folds or appendages). Draw transects across the viable epidermis, selecting the appropriate morphological class: **Suprapapillary** (sampled over dermal papillae), **Ridge-base** (sampled toward a rete ridge base), or another protocol-defined category.

The tool computes the calibrated Euclidean distance from physical pixel calibration (`sqrt((dx * pixel_size_x)^2 + (dy * pixel_size_y)^2)`). If physical calibration is absent, distance is reported in pixels without fabricating physical units. Summary tables separate sampled suprapapillary from ridge-base transects; they do not find global minima or maxima automatically. Each transect saves its boundary definitions, orientation, exclusions and review state. Approved records require a reviewer name and confirmation of the current two-endpoint transect. Changing the source, plane, endpoints or protocol clears that confirmation; saving one transect does not approve the next. Summaries use the current T/Z plane and compatible saved protocols. CSV export includes each saved protocol, source identity, endpoints, zero-based Z/T, coordinate basis, length, units and reviewer; legacy label-only records remain explicitly unverified. Oblique sectioning or tissue processing distortion is not automatically corrected.

## Run practical analysis workflows

### Cells with classical methods or Adaptive Watershed

For a transparent scalar workflow, select the source and set its display only for comfortable viewing. Define the analysis region and channel, then open **Analyze → Segment & measure**. Select **Classical methods** and choose the explicit threshold, Components or Watershed method, foreground direction, minimum object size, optional watershed split height, border exclusion, and raw measurement channel. Use **Run recipe** to create a new result; the method uses declared source data and scope rather than the rendered tone settings.

For the built-in baseline, select **Loci Adaptive Watershed**. It identifies its input as the selected scalar channel or RGB-derived grayscale, and shows selected Z/T. It works on one 2D plane; choose Classical methods for a supported volumetric segmentation. Its recommended profile is editable and resettable: Auto image mode and polarity, expected diameter 34 px, minimum area 80 px, sensitivity 0, smoothing 1.2 px, touching-object splitting enabled, and border exclusion disabled. The method normalizes the selected plane at the first and 99th percentiles. For scalar data, measurements use original scalar intensities; display ranges do not alter the method. Settings are recommendations, not an inference of cell type or validated parameters for a new assay.

After either run, select the result under **Layers & results**. Inspect objects and measurements, then correct labels if needed. Open **Results → Review & export**, confirm the exact revision, and select **Mark reviewed** only after human review. **Export revision** is enabled for a reviewed revision. Review records a human decision for that immutable result; it is not an automatic claim of accuracy.

### Repeating a prepared workflow across images

Open **Results → Study & batch**. For a recipe workflow, give the recipe a name and select **Save validated recipe** after the source has been validated. Check the images to include and use **Preview** for an ordinary recipe where available. For Adaptive Watershed or a Cellpose profile, first configure the exact method in Analyze; the batch then freezes its profile, settings, measurement channels, and 2D selection.

Choose **Run selected sources sequentially**. Loci validates each source and creates durable jobs before work proceeds. **Stop batch** cancels the current item and leaves later work queued. **Resume batch** resumes queued or interrupted jobs; **Retry failed or cancelled** is a separate action. Successful jobs are not silently duplicated. Use **Open result** from a batch row, inspect every result, and review it before reviewed-result or reviewed-batch export.

### Histology RGB and scalar fluorescence

For an RGB histology image, choose **Open as → Histology** if that describes the intended workflow. The shortcut offers **Annotate tissue** and **Choose analysis**. In Analyze, select **Declared stain separation**. State either the H&E or H-DAB basis, choose the derived stain coordinate, threshold, minimum object area, Components or Watershed method, and optional split height. **Preview declared stain** lets you inspect the declared separation before **Run declared stain**. If using the optional object rule, provide its rule name, coordinate, statistic, threshold, and control/evidence text. The recorded rule is a measurement rule, never an automatic stain or biological classification.

For RGB classical analysis, choose **Weighted RGB intensity** explicitly under **Intensity input**. This creates a documented 0–1 intensity derivation; it does not transform RGB components into biological channels. For scalar fluorescence, choose **Open as → Fluorescence**, make visibility and low/high choices in the channel panel, select a scalar analysis channel and scope, then use **Quantify channels** or another appropriate scalar route. A display colour is a viewing aid. Keep measurement-channel choices explicit and do not infer a fluorophore from colour.

### Fluorescence field assay (signal per nucleus)

For two-channel fluorescence field quantification, open **Analyze → Fluorescence & field assay → Field assay**. Confirm the exact source identity and T/Z plane shown in the readiness summary. The assay requires a human-reviewed focus region and a separate, disjoint cell-free background region drawn on that same native plane; Loci filters the selectors and rejects an annotation from another plane.

Select the declared nuclear channel for nuclei segmentation and the declared signal channel for intensity measurement; the names are user or metadata declarations, not inferences from colour. Preview provisional segmentation using an explicit fixed threshold or the selected Otsu/Yen method and object-size parameters. Failed automatic thresholding stops with an error; it never substitutes an arbitrary fixed value. The engine computes the signed background-corrected signal sum (`sum(signal in focus) − focus_pixels × background_estimate`), accepted nucleus count, signal per nucleus, and saturation pixel fractions directly from original pixel values. The background estimate uses the explicitly selected median or mean estimator. If automatic segmentation is unsatisfactory, supply reviewed point marks from the same plane or an explicit reviewed manual count. In manual mode, the signal is measured over the full reviewed focus region and divided by that human count; the automatic segmentation remains a provisional visual aid. A field result must be explicitly reviewed before publication; changing source, plane, annotations, channels, masks, or parameters makes the preview stale.

Signal per nucleus is a field-level proxy; it is not automatically per-cell membrane intensity or absolute receptor abundance. Background subtraction does not establish a positive threshold or correct every source of nonspecific signal. Define the assay, controls, acquisition comparability, independent replicates and normalization reference in the study protocol. Experimental workflows must define controls, acquisition comparability, independent replicates, and normalization rules in their study protocol.

## Inspect scalar volumes and MPR

For a supported scalar source with depth, choose **Open as → Volume** or **Medical research**, then select **Explore in 3D**. Loci accepts up to four visible scalar channels in the raw volume view and requires compatible orthogonal geometry. It refuses unsupported RGB/RGBA, single-plane, or unsuitable geometry rather than inventing a volume.

The viewer starts with a bounded whole-volume context. **Detail at crosshair** requests a separately displayed focus region around the current crosshair; choose **Whole** or **Focus** once it is available. A late focus response preserves the crosshair; moving outside its extent returns to Whole. Focus improves local display detail but does not replace or modify source data. In Volume mode, left-drag orbits, right-drag or Shift-left-drag pans, scroll zooms, arrow keys orbit, `+`/`-` zoom, and `R` resets the camera. **Clip** exposes X/Y/Z axis and position controls for a display-only clipping plane.

The default **Four panes** layout shows three linked slice views and a fourth 3D pane. Patient-frame sources use axial, coronal and sagittal planes in radiological orientation, including reslicing oblique acquisitions. Generic microscopy sources use XY, XZ and YZ labels. Drag the crosshair to reposition all planes; scroll or use ↑/↓ in a slice to step through it. Each pane has Expand/Restore controls. **3D view** selects a single large 3D pane.

Inside the 3D pane, **Volume** displays the scalar volume and **MPR** displays intersecting source-grid planes. The X/Y/Z controls refer to acquisition axes; they are not renamed anatomical axes for oblique data. Displayed world coordinates follow source geometry and units. Slice canvases use bounded, linearly resampled display grids. Use source-space annotation and analysis for quantitative measurements. **Shade** adds optional display lighting; its settings are recorded in exported figures.

Expand a volume channel to set colour, Low, High, Gamma, opacity, visibility, or **Reset channel**. Its histogram is explicitly a deterministic sample of the whole-volume context at the current T and display level. It does not use the focus payload or a crop, so its basis stays stable while changing detail. **Trim 1–99%** remains binned display clipping only.

Use **Export PNG…** in the volume toolbar to save a `.loci-figure` directory atomically. It contains `image.png` and `manifest.json`. The PNG captures the 3D pane, including when the four-pane layout is open; the three separate slice canvases are not included. It uses the native canvas at its current screen resolution; it is not a high-resolution render or original-value data. The manifest records source binding, payload fingerprints, representation, camera, transfer functions, clipping, MPR indices and grids when applicable, Loci application and VTK renderer/software identities, and the PNG SHA-256. It intentionally has no scale bar under perspective, no source pixels in metadata, and no biological or clinical validation claim.

## Review, batch, and export results

**Review & export** is for exact derived results. Select a result, inspect its revision and review status, and use **Mark reviewed** after a person has assessed it. The review state binds to that revision. **Export revision** writes the scientific result package appropriate to the result: arrays, labels where applicable, measurements, method and provenance records, review information, and integrity material. It is distinct from a rendered display image.

For batch publication, use the reviewed-export controls in the study workflow after every intended result is reviewed. Available choices include reviewed bundles, reviewed bundles with a summary CSV, and **Summary CSV only**. Loci validates exact revisions and planned destination names before publication. Summary-only exports contain the count CSV and manifest, not image or label bundles. Portable study export retains derived records while omitting private raw-source locations; source-dependent work after import requires exact local relinking.

## Export rendered figures

Open **View → Image & channels → Export rendered image**. This panel exports the current display, including its selected plane or projection, channel appearance, and display provenance. It does not export original values or annotation overlays.

| Format | Available extent | Meaning |
| --- | --- | --- |
| **PNG · 8-bit display** | Whole image up to 1024 px, or Analysis region in source pixels | Rendered RGB display image |
| **TIFF · 16-bit display** | Whole selected plane at full resolution, or Analysis region in source pixels | Rendered RGB display image |

Set **Resolution (DPI)** from 72 to 1200; Settings supplies the default, initially 300. DPI changes output metadata and physical layout, not source resolution or image detail. Enable **Include calibrated scale bar** only when trustworthy physical X/Y geometry supports it. Enable **Include channel legend** only for visible scalar channels, then supply clear user labels. The scale bar and channel key are placed in a footer outside source pixels. They are not annotation overlays. Export records exact figure/display provenance for the rendered output.

Use a reviewed result export when downstream work needs arrays, labels, measurements, or method records. Use annotation interchange for vector annotations. Use PNG/TIFF display export when a presentation figure is the intended artifact. Do not substitute a display picture for original-value research data.

## Medical, temporal, and registration work

Medical import supports documented scalar subsets with declared geometry. Open a supported NIfTI, NRRD, or conventional CT/MR DICOM series through its explicit route, choose **Open as → Medical research**, inspect Image info, orientation/frame, units, and calibration, then set Window/Level as needed for viewing. For volume data, use 3D/MPR only after confirming the displayed geometry. Loci does not make a de-identification, diagnostic, clinical-preset, or clinical-performance claim.

For a time series, select the desired Time frame in Image & channels and create or choose exact result revisions. Open **Analyze → Track over time** to associate appropriate timed results. Review ambiguous links before publishing a tracking result. The records retain selected timepoints and settings; repeated frames, planes, patches, or objects do not become independent biological samples merely by being numerous.

Open **Analyze → Register & resample** when a declared transform or resampling grid is needed. Choose compatible sources and inspect geometry first. Registration and resampling create explicit derived state and preserve transforms/grids in their records. They do not silently turn a transformed display into an original source or establish biological correspondence.

## Settings, recovery, and help

Open **Settings** from the header. Under **Appearance**, choose one of six interface themes: **Graphite**, **Midnight**, **Paper**, **Aurora**, **Ember**, or **Lagoon**. Use the theme dropdown and choose System, Arial, or Verdana interface font. Choose Standard or Large interface text, and Follow system or Reduce motion. These affect the application interface, never source values or analysis.

Drag the left edge of the tools panel to resize it. With that divider focused, use left/right arrows to adjust it, Home/End for its bounds, or double-click to reset. Its width is remembered locally. Contextual tips have a **Close tip** button and can also be dismissed with `Escape`.

Under **Viewing & help**, turn the viewer scale bar, overview navigator, and contextual guidance on or off. A viewer scale bar still appears only when the source declares usable calibration. Under **Saving & export**, set the default rendered-figure DPI and review the distinction between rendered figures, derived results, and recoverable local sessions. Under **User guide**, open this bundled manual. `F1` opens it directly; search its contents for terms such as `histogram`, `batch`, `MPR`, or `recovery`.

If a control is unavailable, read the inline prerequisite. Common reasons are an unsupported source subset, missing or incompatible geometry/calibration, incomplete analysis scope, absent depth/time dimension, source identity mismatch, missing model/runtime provisioning, or an unreviewed result. Preserve the shown error wording when seeking support, but do not include protected source data or private filesystem paths. Consult the [capability matrix](CAPABILITY_MATRIX.md) for supported formats and resource boundaries and [project state](PROJECT_STATE.md) for current qualification evidence.
