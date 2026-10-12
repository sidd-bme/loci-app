# Using Loci

Loci is a local-first workbench for inspecting scientific images and creating traceable derived results. It leaves original image files where they are, and keeps display settings, annotations, results, reviews, and exports as separate work. Loci does not identify a stain or fluorophore from appearance, diagnose a sample, or establish biological or clinical validity.

This manual describes the implemented image-first workspace. It is bundled with the application and opens offline with `F1` or **Settings → User guide → Open user guide**. The manual has a searchable contents pane. The [capability matrix](CAPABILITY_MATRIX.md) defines supported source subsets and limits; [release status](RELEASE_STATUS.md) records published beta status and limitations. Current source can include changes absent from that download; qualification applies to the exact source and app tested.

## Contents

- [Start, save, and return](#start-save-and-return)
- [First study with synthetic shapes](#first-study-with-synthetic-shapes)
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
- [Terminal and assistant workflows](#terminal-and-assistant-workflows)

## Start, save, and return

Select **Open images** or drop local items on the opening window. A single checked item can be a supported image, ordinary image folder, OME-Zarr store, `.loci-study` directory, or legacy `.loci-project` file. A multiple-item drop accepts supported image files only. Loci validates the full selection before changing the study, so an invalid or unsafe item does not leave a partly imported collection.

Use **Open folder** from the File menu for a recursive collection of ordinary images. Existing published `_loci` bundles are excluded. Use **Open DICOM series** for a deliberate DICOM series choice and **Open OME-Zarr store** for a store. DICOM encountered while opening an ordinary folder remains an explicit-series decision, which avoids silently assembling unrelated acquisitions. Use **Open study** for a saved study and **Open .loci-project** for a legacy project.

After opening a valid source, Loci creates a managed local session and saves derived work as it changes. To make a named study, choose **Save study…** in the header (also available under **File → Save as study…**). This creates a `.loci-study` snapshot without copying or modifying the original images. Keep original source locations available: reopening a study may require them to be present. The session status in the header distinguishes an autosaved session from saved local work.

**Recent work** opens saved studies and recoverable managed sessions. Its **Updated** time describes activity in Loci's session registry, such as an open, save, or reopen; it is not an acquisition timestamp. If a study or source location has moved, use the displayed recovery route to locate it again. Use **Relink exact source** directly in an unavailable-source banner. Relinking requires the original source identity, so a different file at a familiar path is rejected. Discarding a managed session affects only Loci's derived session state and offers immediate Undo; it never deletes the source image.

## First study with synthetic shapes

**Try an example** on the opening screen creates a normal managed study with three synthetic rectangles, offline. No analysis or human review is prefilled. Its 256 × 256 scalar image has authored 0.5 µm X/Y spacing; it is geometric practice, not cells or biological validation.

In **View → Image & channels → Analysis region**, set X/Y = 0, Width/Height = 256 and C = 0 (the single Z/T plane is 0; native level 0). In **Analyze → Segment & measure**, choose **Whole image**, then use **Classical methods**, **Components**, **Threshold** 50, **Above threshold**, **Minimum object area** 1, no preprocessing and no border exclusion; choose **Run recipe**. Expect 3 objects: 320, 768 and 512 pixels; areas 80, 192 and 128 µm²; mean intensities 100, 150 and 200.

Inspect object rows and labels. In **Annotate → Edit labels & ROIs**, delete label 1 for a deliberate two-object revision, then inspect **Undo revision** and **Redo revision**. In **Results → Review & export**, inspect the exact revision yourself, choose **Mark reviewed**, then **Export revision**. Choose **Save study…** and reopen through **Recent work** or **Open study**. The original pixels remain intact; each correction needs its own review.

The source stays in a separate app-owned directory when its managed study is discarded. Save As preserves the source binding, so keep an exact source copy if removing the whole app profile or moving the study. The [first-study reference](workflows/FIRST_STUDY.md) gives the independent geometry, coordinate conventions and provenance. The optional **Practice guide · synthetic shapes** in the inspector repeats the workflow beside the actual tools.

## Read the workspace

The left column contains **Images**, then **Layers & results** for the selected image. Results show a short revision identifier and review state; hover for the full identity. Choose **Original image** to inspect source display, or select a result to inspect one exact derived revision. The centre is the image or volume viewport. The right inspector groups work under **View**, **Annotate**, **Analyze**, and **Results**. Each group remembers its last tool. Its selector includes advanced routes such as portability, vendor conversion, remote compute, and assistant connection. Search all tools by name; use arrow keys and Enter to choose, or Escape to return.

Native **File** commands open images, folders and studies in the active workspace.
From detached image windows, these commands return to the main workspace first.
**Window → Focus control panel** and **Window → Return to workspace** expose the
same window controls from the menu bar.

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

The Z and Time controls also remain available in **Annotate** for plane-by-plane
work. The main workspace retains unfinished drafts separately by source identity,
Z/T plane and drawing tool. Return to that source, plane and tool to continue.
Drafts are session-only, are cleared when opening another study, and are not saved
annotations until you choose a save action. **Clear draft** discards the current
draft. Up to 128 unfinished drafts are retained; Loci asks you to save or clear one
before starting another instead of silently discarding an older draft.

During rapid Z or Time changes, Loci can use a smaller XY preview based on measured
response time, then refine once movement stops. The selected native plane and
analysis resolution do not change. If the previous plane remains visible, the
status identifies the displayed and requested planes; drawing is unavailable
until the requested plane paints. **Stop loading** stops new work for that view
and discards its pending response without interrupting other views. An active
decode may still finish. **Retry view** resumes that view after a stop or error.

### Scalar channels, RGB, and medical windows

For scalar sources, expand a channel under **Channels**. Set visibility, colour, **Low**, **High**, **Gamma**, and opacity. Low and high define the displayed range; gamma changes the mapping through it. **Auto** sets stable channel ranges from the selected source, T index, and Z plane. It does not calculate a range from a projection, current camera crop, or pan position. Selecting another plane or time point then pressing Auto deliberately gives a range for that selected plane.

Use **Reset** to restore acquisition/default display settings. Hold **Hold for source display** to compare temporarily with that baseline. For a medical source, or when **Open as → Medical research** is selected, each scalar channel also exposes **Window** and **Level**. Window is the displayed width and Level is its midpoint; these controls are the same display-range operation expressed in conventional medical terms. They do not apply a diagnostic preset or modify stored pixels.

An interleaved RGB or RGBA source is a colour image. Loci uses its stated display policy and applies a valid embedded ICC profile once to the display copy. **Image tone** provides one shared black point, white point, and gamma curve for RGB components. RGB components remain encoded display samples, not automatically biological channels.

For a scalar source with at least three channels, **Image info → RGB plane mapping** lets you explicitly select distinct planes for display red, green, and blue. Apply the mapping only when it is the intended visual composite; **Restore source composite** returns to the original representation. This is reversible display state. Analysis continues to use the original scalar channels rather than treating the composite as an inferred biological interpretation.

### Batch channel colors and A/B comparison viewing

Under **View → Image & channels**, select **Apply colors…** to propagate standard channel colors across multiple images in one step. Choose target scope (**Selected images** or **All loaded images** in the current session snapshot) and channel matching (**Name, then index**, **Channel name**, or **Channel index**). Select from standard microscopy presets (DAPI/GFP/TRITC/Cy5, RGB, CMY, Greyscale) or customize individual hex codes. The dialog provides a preflight preview showing affected images and explicit skip reasons for incompatible interleaved RGB sources. Color updates are display-only, do not alter raw pixel intensities or invalidate existing scientific reviews, and can be reversed across all affected images with **Undo colors**.

When two or more images are open, select **Compare A/B** in the canvas toolbar to inspect images side by side. Choose independent sources for **Pane A** and **Pane B**. Use **Match display (A → B)** to copy display ranges and colors from A to B (presentation only; does not standardize physical intensity). Each pane has its own T, Z and channel selection. **Link pan/zoom** is available when both panes show the same source identity and coordinate grid; matching dimensions alone do not establish correspondence. Display matching requires compatible channel mappings and remains a temporary comparison setting.

### Independent image windows

Select a source and choose **Detach image** to open an independent window. The
main window becomes **Image controls**. Detaching carries the current channel
colours, ranges, gamma, visibility and opacity, selected plane/projection and 2D
camera into the viewer. Supported volume mode, quality and transfer settings also
carry over. Opacity readouts use 0 (transparent) to 1 (fully opaque), matching the
sliders. Finish drawing and resolve any display-save error before detaching.
VTK orbit pose, clipping and temporary detail boxes are not transferred yet.
Move the resulting window using its native title bar onto another monitor.
You can open a second view of another
source, or of the same source with a different plane and camera. The control
target follows the last focused image window; clicking the control panel keeps
that target. **Pin this target** holds it until **Follow focused view** is chosen.
Always check the view letter and image name before drawing or changing settings.

Use the image window's full-screen button and `Escape` to enter and leave native
full screen. Display channels, Z/T, raw volume viewing and source annotations are
available through the control panel. The panel shows one shared tone curve for RGB/RGBA sources, scalar channel controls
for microscopy, and Window/Level for declared medical sources. **Open as** is an
explicit presentation choice; it does not infer stains or diagnoses. The source
summary identifies axes, calibration and any recorded coordinate frame. In 3D,
rendering mode, quality and scalar transfer settings are shared with the image
window. Changes made in either window appear in the other.

Annotation save, undo and redo remain bound
to that source and its selected plane. A stale annotation revision reports a
conflict and offers **Reload annotations**, preserving the unsaved draft.
Segmentation, immutable-result correction and the full analysis tools remain in
**Return to workspace**.

Window positions, display settings and the pinned target are stored locally for
the study. After reopening it, choose **Restore image windows** explicitly.
Unsaved annotation drafts are not saved as layout. Saving a new study copy changes
the document identity and closes its detached views; open views again for that
copy. If an image renderer stops, **Reopen** creates a new command generation and
keeps annotations already committed to the study. This version supports two
detached views with shared, bounded viewer resources.

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

The tool computes the calibrated Euclidean distance from physical pixel calibration (`sqrt((dx * pixel_size_x)^2 + (dy * pixel_size_y)^2)`). If physical calibration is absent, distance is reported in pixels without fabricating physical units. Summary tables separate sampled suprapapillary from ridge-base transects; they do not find global minima or maxima automatically. Each transect saves its boundary definitions, orientation, exclusions and review state. **Save transect** creates an unverified record. **Save reviewed transect** requires a reviewer name and records approval of the current two endpoints, boundaries and orientation. Each save is a separate decision; restoring a draft or saving one transect does not approve the next. Summaries use the current T/Z plane and compatible saved protocols. CSV export includes each saved protocol, source identity, endpoints, zero-based Z/T, coordinate basis, length, units and reviewer; legacy label-only records remain explicitly unverified. Oblique sectioning or tissue processing distortion is not automatically corrected.

## Run practical analysis workflows

### Cells with classical methods or Adaptive Watershed

For a transparent scalar workflow, select the source and set its display only for comfortable viewing. Define the analysis region and channel, then open **Analyze → Segment & measure**. Select **Classical methods** and choose the explicit threshold, Components or Watershed method, foreground direction, minimum object size, optional watershed split height, border exclusion, and raw measurement channel. Use **Run recipe** to create a new result; the method uses declared source data and scope rather than the rendered tone settings.

**Recipe resources** shows the engine's working-memory estimate for the selected
scope. The initial allowance is 512 MiB. Choose a larger **Recipe memory allowance**
(up to 8 GiB) when needed, or explicitly apply the hardware recommendation. A
recommendation uses installed memory; it does not measure available RAM or reserve
memory. Larger allowances can cause memory pressure and slower operation. The
estimate does not run the analysis, and an over-budget refusal publishes no result.
The chosen allowance travels with saved recipes and results. Cellpose-SAM, Cellpose-SAM v2 and Adaptive Watershed also expose a **Memory
allowance** control (256 MiB–8 GiB). Switching between these segmentation methods
retains the choice. Published results retain their accepted allowance for display
and subsequent label corrections; a correction records its own execution budget.
Imported ONNX models use their existing **Working memory** control.

These are host array-working allowances, not reservations or guarantees of peak
process memory. Cellpose checkpoint/runtime overhead and GPU memory are additional;
GPU batch size is a separate explicit setting. A larger allowance does not change
image resolution or scientific settings. Decoder and export-artifact limits remain
separate and can still reject oversized inputs/results. For cluster resources and
current remote limitations, see [Remote workflow](REMOTE_WORKFLOW.md).

For the built-in baseline, select **Loci Adaptive Watershed**. It identifies its input as the selected scalar channel or RGB-derived grayscale, and shows selected Z/T. It works on one 2D plane; choose Classical methods for a supported volumetric segmentation. Its recommended profile is editable and resettable: Auto image mode and polarity, expected diameter 34 px, minimum area 80 px, sensitivity 0, smoothing 1.2 px, touching-object splitting enabled, and border exclusion disabled. The method normalizes the selected plane at the first and 99th percentiles. For scalar data, measurements use original scalar intensities; display ranges do not alter the method. Settings are recommendations, not an inference of cell type or validated parameters for a new assay.

After either run, select the result under **Layers & results**. Inspect objects and measurements, then correct labels if needed. Open **Results → Review & export**, confirm the exact revision, and select **Mark reviewed** only after human review. **Export revision** is enabled for a reviewed revision. Review records a human decision for that immutable result; it is not an automatic claim of accuracy.

### Repeating a prepared workflow across images

For a connected analysis plan, choose **Analyze → Workflow builder**. Build a
sequence from image processing through segmentation, raw measurements and
population filtering, then inspect, review and export the exact result. The
dedicated workspace keeps the image alongside the graph and settings. Saved
workflows can run across compatible sources; see [Visual workflows](WORKFLOWS.md)
for revision, preview, batch and recovery behavior.

Open **Results → Study & batch**. For a recipe workflow, give the recipe a name and select **Save validated recipe** after the source has been validated. Check the images to include and use **Preview** for an ordinary recipe where available. For Adaptive Watershed or a Cellpose profile, first configure the exact method in Analyze; the batch then freezes its profile, settings, measurement channels, and 2D selection.

Choose **Run selected sources sequentially**. Loci validates each source and creates durable jobs before work proceeds. **Stop batch** cancels the current item and leaves later work queued. **Resume batch** resumes queued or interrupted jobs; **Retry failed or cancelled** is a separate action. Successful jobs are not silently duplicated. Use **Open result** from a batch row, inspect every result, and review it before reviewed-result or reviewed-batch export.

### Histology RGB and scalar fluorescence

For an RGB histology image, choose **Open as → Histology** if that describes the intended workflow. The shortcut offers **Annotate tissue** and **Choose analysis**. In Analyze, select **Declared stain separation**. State either the H&E or H-DAB basis, choose the derived stain coordinate, threshold, minimum object area, Components or Watershed method, and optional split height. **Preview declared stain** lets you inspect the declared separation before **Run declared stain**. If using the optional object rule, provide its rule name, coordinate, statistic, threshold, and control/evidence text. The recorded rule is a measurement rule, never an automatic stain or biological classification.

For RGB classical analysis, choose **Weighted RGB intensity** explicitly under **Intensity input**. This creates a documented 0–1 intensity derivation; it does not transform RGB components into biological channels. For scalar fluorescence, choose **Open as → Fluorescence**, make visibility and low/high choices in the channel panel, select a scalar analysis channel and scope, then use **Quantify channels** or another appropriate scalar route. A display colour is a viewing aid. Keep measurement-channel choices explicit and do not infer a fluorophore from colour.

### Fluorescence field assay (signal per nucleus)

For two-channel fluorescence field quantification, open **Analyze → Fluorescence & field assay → Field assay**. Confirm the exact source identity and T/Z plane shown in the readiness summary. The assay requires a human-reviewed focus region and a separate, disjoint cell-free background region drawn on that same native plane; Loci filters the selectors and rejects an annotation from another plane.

Select the declared nuclear channel for nuclei segmentation and the declared signal channel for intensity measurement; the names are user or metadata declarations, not inferences from colour. Preview provisional segmentation using an explicit fixed threshold or the selected Otsu/Yen method and object-size parameters. Failed automatic thresholding stops with an error; it never substitutes an arbitrary fixed value. The engine computes the signed background-corrected signal sum (`sum(signal in focus) − focus_pixels × background_estimate`), accepted nucleus count, signal per nucleus, and saturation pixel fractions directly from original pixel values. The background estimate uses the explicitly selected median or mean estimator. If automatic segmentation is unsatisfactory, supply reviewed point marks from the same plane or an explicit reviewed manual count. In manual mode, the signal is measured over the full reviewed focus region and divided by that human count; the automatic segmentation remains a provisional visual aid. A field result must be explicitly reviewed before publication; changing source, plane, annotations, channels, masks, or parameters makes the preview stale.

Choose **Save exploratory** to retain the current preview without scientific approval.
**Approve & save** requires a reviewer name, a fixed threshold or reviewed manual
count, and an appropriate focus/background selection. The click records review of
channel identity, acquisition comparability, focus, nuclei, background and any
reported saturation. Editing channel declarations or assay settings requires a new
preview. Each approval applies only to the current saved result.

Signal per nucleus is a field-level proxy; it is not automatically per-cell membrane intensity or absolute receptor abundance. Background subtraction does not establish a positive threshold or correct every source of nonspecific signal. Define the assay, controls, acquisition comparability, independent replicates and normalization reference in the study protocol. The workflow is general-purpose: record experiment-specific assumptions in your study protocol.

## Inspect scalar volumes and MPR

For a supported scalar source with depth, choose **Open as → Volume** or **Medical research**, then select **Explore in 3D**. Loci accepts up to four visible scalar channels in the raw volume view and requires compatible orthogonal geometry. It refuses unsupported RGB/RGBA, single-plane, or unsuitable geometry rather than inventing a volume.

The viewer starts with a bounded whole-volume context. **Detail at crosshair** requests a separately displayed focus region around the current crosshair; choose **Whole** or **Focus** once it is available. A late focus response preserves the crosshair; moving outside its extent returns to Whole. Focus improves local display detail but does not replace or modify source data. In Volume mode, left-drag orbits, right-drag or Shift-left-drag pans, scroll zooms, arrow keys orbit, `+`/`-` zoom, and `R` resets the camera. **Clip** exposes X/Y/Z axis and position controls for a display-only clipping plane.

The default **Four panes** layout shows three linked slice views and a fourth 3D pane. Patient-frame sources use axial, coronal and sagittal planes in radiological orientation, including reslicing oblique acquisitions. Generic microscopy sources use XY, XZ and YZ labels. Drag the crosshair to reposition all planes; scroll or use ↑/↓ in a slice to step through it. Each pane has Expand/Restore controls. **3D view** selects a single large 3D pane.

Inside the 3D pane, **Volume** displays the scalar volume and **MPR** displays intersecting source-grid planes. The X/Y/Z controls refer to acquisition axes; they are not renamed anatomical axes for oblique data. Displayed world coordinates follow source geometry and units. Slice canvases use bounded, linearly resampled display grids. Use source-space annotation and analysis for quantitative measurements. **Shade** adds optional display lighting; its settings are recorded in exported figures.

Expand a volume channel to set colour, Low, High, Gamma, opacity, visibility, or **Reset channel**. Its histogram is explicitly a deterministic sample of the whole-volume context at the current T and display level. It does not use the focus payload or a crop, so its basis stays stable while changing detail. **Trim 1–99%** remains binned display clipping only.

Use **Export PNG…** in the volume toolbar to save a `.loci-figure` directory atomically. It contains `image.png` and `manifest.json`. The PNG captures the 3D pane, including when the four-pane layout is open; the three separate slice canvases are not included. It uses the native canvas at its current screen resolution; it is not a high-resolution render or original-value data. The manifest records source binding, payload fingerprints, representation, camera, transfer functions, clipping, MPR indices and grids when applicable, Loci application and VTK renderer/software identities, and the PNG SHA-256. It intentionally has no scale bar under perspective, no source pixels in metadata, and no biological or clinical validation claim.

## Review, batch, and export results

**Review & export** is for exact derived results. Select a result, inspect its revision and review status, and use **Mark reviewed** after a person has assessed it. The review state binds to that revision. **Export revision** writes the scientific result package appropriate to the result: arrays, labels where applicable, measurements, method and provenance records, review information, and integrity material. It is distinct from a rendered display image.

Quantitative summaries in **Review & export** require homogeneous metric fields, declared measurement kinds, and compatible units across all rows. If a result contains mixed units (for example, micrometres and pixels), mixed measurement kinds (such as area and volume), or declared-versus-unspecified metadata, pooled statistics (mean and range) are withheld and a clear reason is displayed beside the table, while preserving all individual records, row selection, and review/export controls. Non-finite, missing, or null values are excluded from arithmetic calculations rather than counted as zero, and exclusions are disclosed beside the table. Missing unit metadata is explicitly labeled as unspecified rather than assuming calibration. The row count always includes every measurement record; the summary does not infer biological object identities.

For object-level exploration, choose **Results → Statistics & objects** to filter,
locate and inspect exact labels; see [Statistics & objects](OBJECT_POPULATIONS.md).
You can [adopt external labels](EXTERNAL_LABELS.md) onto a checked native source
plane and create ordinary correction revisions. From a corrected revision,
**Show experiment effect** compares its direct parent with that child using the
existing object-size endpoint and explicitly assigned biological replicates; see
[Correction effects](CORRECTION_EFFECTS.md).

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

Open **Settings** from the header. Under **Appearance**, choose one of seven interface themes: **Graphite**, **Midnight**, **Paper**, **Aurora**, **Ember**, **Lagoon**, or **FIJI**. Use the theme dropdown and choose System, Arial, or Verdana interface font. Choose Standard or Large interface text, and Follow system or Reduce motion. These affect the application interface, never source values or analysis.

Numeric display and region fields apply with Enter or when focus leaves the field; Escape restores the last applied value. Analysis numbers accept valid edits immediately. Empty or unfinished numbers block analysis and recipe saving until corrected; **Restore applied numbers** discards those unfinished edits. Invalid entries remain visible with a specific reason instead of becoming zero.

Drag the left edge of the tools panel to resize it. With that divider focused, use left/right arrows to adjust it, Home/End for its bounds, or double-click to reset. Its width is remembered locally. Contextual tips have a **Close tip** button and can also be dismissed with `Escape`.

Under **Viewing & help**, turn the viewer scale bar, overview navigator, and contextual guidance on or off. A viewer scale bar still appears only when the source declares usable calibration. Under **Saving & export**, set the default rendered-figure DPI and review the distinction between rendered figures, derived results, and recoverable local sessions. Under **User guide**, open this bundled manual. `F1` opens it directly; search its contents for terms such as `histogram`, `batch`, `MPR`, or `recovery`.

If a control is unavailable, read the inline prerequisite. Common reasons are an unsupported source subset, missing or incompatible geometry/calibration, incomplete analysis scope, absent depth/time dimension, source identity mismatch, missing model/runtime provisioning, or an unreviewed result. Preserve the shown error wording when seeking support, but do not include protected source data or private filesystem paths. Consult the [capability matrix](CAPABILITY_MATRIX.md) for supported formats and resource boundaries and [release status](RELEASE_STATUS.md) for published beta limitations.

## Terminal and assistant workflows

Use the [Loci CLI](CLI.md) to create studies, register immutable sources, validate
explicit requests, inspect durable jobs and export reviewed exact revisions from
a shell. The local macOS app includes its own terminal launcher. `loci discover QUERY` finds operations, `loci operation NAME` gives the exact invocation route,
and `loci examples` lists authored requests. `loci doctor` reports lightweight
runtime facts; it does not check models or establish analysis readiness.

Interactive terminal summaries preserve complete identities and numerical strings.
Piped output is JSON; `--json` explicitly selects full machine receipts. `--plain`
and `--no-motion` support control-free output. The welcome animation and optional
`loci logo --animate` are bounded. Read the CLI guide for study paths, validation,
stable retry keys, review/export requirements and bash/zsh/fish completion.

In **Analyze → Agent**, validate the exact recipe and grant selected access to a
local assistant. **Analysis context** explicitly shares permitted source IDs,
fingerprints, recipe grants and resource limits; names, geometry and measurements
each have separate choices. Assistants can read the static recipe guide without
study disclosure. See [agent access](AGENT_ACCESS.md) for supported clients, policy
scope and revocation.
