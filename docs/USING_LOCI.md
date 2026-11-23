# Using Loci

Loci is a local-first workbench for inspecting scientific images and creating traceable derived results. Original image files stay untouched on disk; display settings, annotations, analysis results, reviews, and exports are stored as separate derived records. Loci does not identify stains or fluorophores from visual appearance, diagnose a sample, or establish biological or clinical validity.

> **Core boundaries:** Panning or zooming never crops an analysis. Adjusting display ranges, colour maps, or projections never alters raw pixels or completed measurements. Every derived result stays bound to its exact source fingerprint, geometry, settings, and review state.

### Three independent layers in Loci

| Layer | What it controls | Changes source pixels or saved results? |
| --- | --- | --- |
| **Camera** | Area and magnification currently on screen | No |
| **Display** | How source values map to colour on screen (Low/High, Gamma, Window/Level, LUTs, Z projections, sampling) | No |
| **Analysis scope & results** | Declared region, native channel/Z/T indices, method settings, labels, measurements, and reviews | Creates new immutable derived records; originals stay read-only |

### Where to go for common tasks

- **New to Loci?** Run the offline synthetic walkthrough in [First study with synthetic shapes](#first-study-with-synthetic-shapes), or orient yourself in [Read the workspace](#read-the-workspace).
- **Opening or converting images?** See [Start, save, and return](#start-save-and-return) for supported sources, studies, relinking, and native OME-TIFF / OME-Zarr conversion.
- **Inspecting 2D channels, histograms, or 3D volumes?** See [View images and set display](#view-images-and-set-display), [Use histograms deliberately](#use-histograms-deliberately), and [Inspect scalar volumes and MPR](#inspect-scalar-volumes-and-mpr).
- **Drawing ROIs, running segmentation, or quantifying assays?** See [Annotate and define analysis scope](#annotate-and-define-analysis-scope) and [Run practical analysis workflows](#run-practical-analysis-workflows).
- **Reviewing, batching, or exporting data and figures?** See [Review, batch, and export results](#review-batch-and-export-results) and [Export rendered figures](#export-rendered-figures).
- **Automating with workflows, assistants, or the CLI?** See [Compose and reuse workflows](#compose-and-reuse-workflows), [Work with external agents](#work-with-external-agents), and [Terminal workflows](#terminal-workflows).

This manual is bundled offline inside Loci. Open it anytime with `F1`, **Help → User guide**, or **Settings → User guide → Open user guide**. Use the search bar (`/` or `⌘F` / `Ctrl+F`) to find tools, shortcuts, or concepts; Back/Forward, Contents, and Previous/Next keep your place.

For exact format subsets and resource limits, see the [capability matrix](CAPABILITY_MATRIX.md). For published beta status and limitations, see [release status](https://github.com/sidd-bme/loci-app/blob/main/docs/RELEASE_STATUS.md). Current source can include changes absent from a published download; qualification applies only to the exact source and application tested.

## Contents

**Start here**

- [Start, save, and return](#start-save-and-return)
- [First study with synthetic shapes](#first-study-with-synthetic-shapes)
- [Read the workspace](#read-the-workspace)

**View & display**

- [View images and set display](#view-images-and-set-display)
- [Use histograms deliberately](#use-histograms-deliberately)
- [Inspect scalar volumes and MPR](#inspect-scalar-volumes-and-mpr)

**Annotate & analyze**

- [Annotate and define analysis scope](#annotate-and-define-analysis-scope)
- [Run practical analysis workflows](#run-practical-analysis-workflows)
- [Medical, temporal, and registration work](#medical-temporal-and-registration-work)

**Review & export**

- [Review, batch, and export results](#review-batch-and-export-results)
- [Export rendered figures](#export-rendered-figures)

**Settings & automation**

- [Settings, recovery, and help](#settings-recovery-and-help)
- [Work with external agents](#work-with-external-agents)
- [Compose and reuse workflows](#compose-and-reuse-workflows)
- [Terminal workflows](#terminal-workflows)

## Start, save, and return

### Open images, folders, and stores

1. Choose **Open images** (`⌘O` / `Ctrl+O`) or drag local items onto the opening window.
   - A **single dropped item** can be a supported image, an ordinary image folder, an OME-Zarr store, a `.loci-study` directory, or a legacy `.loci-project` file.
   - A **multi-item drop** accepts supported image files only.
   - Loci validates the entire selection before modifying the study, so an invalid or unsafe item never leaves a partial import.
2. For nested directories, use **Open folder** (`⌘⇧O` / `Ctrl+Shift+O`) from the opening screen, header **File** menu, or native **File** menu. Existing published `_loci` bundles are excluded automatically.
3. For specialized formats, expand **More sources** on the opening screen or open the header **File** menu:
   - **DICOM series** (**File → Open DICOM series**): choose one conventional CT or MR series explicitly. DICOM files inside an ordinary folder are not assembled silently across acquisitions.
   - **OME-Zarr store** (**File → Open OME-Zarr store**): open a local OME-NGFF 0.4 Zarr v2 directory store.
   - **Loci project** (**File → Open .loci-project**): import a legacy `.loci-project` file.
   - **Convert image format**: open the conversion route for supported study or vendor images.
   - **New empty study**: open an empty workspace before importing sources.

### Save studies and recover sessions

Opening a valid source creates a managed local session that autosaves derived work as you go. The status indicator in the header distinguishes an **Autosaved session** from a **Saved locally** named study.

- **Save a named study:** Choose **Save study…** in the header, **File → Save as study…** in the header menu, or native **File → Save study…** (`⌘S` / `Ctrl+S`). Loci writes a `.loci-study` snapshot without copying or altering original source files.
- **Keep originals accessible:** Reopening a study can require the original source files to remain reachable.
- **Reopen recent work:** Use **Recent work** on the opening screen or **File → Recent work** to return to saved studies and recoverable managed sessions. Its **Updated** timestamp reflects Loci session activity (open, save, or reopen), not image acquisition time.
- **Relink a moved source:** If a study or source file has moved, follow the recovery prompt or choose **Relink exact source** in the unavailable-source banner. Relinking checks the original source identity and rejects a different file at a familiar path.
- **Discard a managed session:** Discarding affects only Loci's derived session state and offers immediate **Undo**; it never deletes source images.

### Convert study images to OME-TIFF or OME-Zarr

Use the native format converter when you need a portable, pixel-verified copy of a supported study image in standard OME-TIFF or OME-Zarr format.

1. Open **View → Import & conversion → Convert image format → Study image**.
2. Select the source series in the image list. The converter reads finite scalar pixels from supported sources such as TIFF/OME-TIFF, Imaris IMS, and OME-NGFF 0.4/Zarr v2. All channels must share one numeric type.
3. Choose **OME-TIFF** or **OME-Zarr** under **Output format**. OME-TIFF supports 8-, 16-, and 32-bit integers and 32- or 64-bit floats. Choose OME-Zarr for other supported scalar types, including 64-bit integers.
4. Select **Convert image…** and choose the destination in the **Save converted image** dialog.
5. Confirm the **Conversion verified** status once writing and verification finish.

Conversion exports the full-resolution native T, C, and Z planes with no resampling. Loci creates a new folder containing:

- `image.ome.tif` (for OME-TIFF) or `image.ome.zarr` (OME-NGFF 0.4), and
- `conversion.json`, recording original and output fingerprints, array shape, dtype, and recognized coordinates, timing, and plane positions.

Loci reopens the output and checks every pixel before publishing both files together. Use a destination filesystem that supports atomic folder creation without replacement on macOS or Linux. Keep the original for vendor headers, other pyramid levels, and future analysis. Display edits and study results stay in the study.

RGB and indexed-colour images, whole slides, and medical series have separate export workflows. To export segmentation labels from a result, use **Results → Review & export**. The [capability matrix](CAPABILITY_MATRIX.md) lists the supported operations for each source type.

### Convert vendor files (Bio-Formats)

For standalone proprietary vendor microscopy files (`.czi`, `.lif`, or `.nd2`), Loci provides an optional local conversion boundary backed by an explicitly supplied Bio-Formats runtime.

1. Open **View → Import & conversion → Convert image format → Vendor file** (or **More sources → Convert image format** on the opening screen).
2. Select the source file, the official Bio-Formats `8.5.0` `bioformats_package.jar`, and your local Java executable. For whole series or C/Z/T ranges, choose the `java` executable from a **JDK 11 or later**. Loci checks the supplied JAR and executable before running the reader.
3. Inspect the series dimensions, channels, and spacing, then choose **Whole series**, **Selected C/Z/T range**, or **Single plane**. C/Z/T ranges in the UI are zero-based and **inclusive** on both endpoints. Optional **Crop XY** applies one source-pixel rectangle across all selected planes.
4. Review the output preview and **Resource limits** (Java heap, timeout, and output cap up to **1 GiB**; stacks are capped at **4,096 planes**, and each plane is capped at 512 MiB).
5. Choose a new destination folder outside the study. Loci writes `image.ome.tif` and `provenance.json`, verifies the decoded scalar pixels against the pinned Bio-Formats reader, and imports the converted result as a derived study image (retained under **Study conversions**).

For exact JAR hashes, JVM codec notes, and CLI/Python details, see [vendor conversion](VENDOR_CONVERSION.md) and the [capability matrix](CAPABILITY_MATRIX.md).

## First study with synthetic shapes

Use the built-in synthetic fixture to practice inspection, segmentation, label correction, review, and export completely offline before working on experimental data.

> **Practice fixture boundary:** **Try a synthetic example** creates a 256 × 256 scalar image with three authored rectangles and 0.5 µm X/Y spacing. It is geometric practice, not biological cells or validation evidence, and no analysis or human review is prefilled.

### Walkthrough steps

1. **Create the study:** Choose **Try a synthetic example** on the opening screen.
2. **Confirm the analysis region:** Open **View → Image & channels → Analysis region** and confirm `X = 0`, `Y = 0`, `Width = 256`, `Height = 256` on the first scalar channel and single Z/time plane at native level 0. Researcher-facing summaries display these as Channel 1, Z 1, and T 1; recorded API indices are zero-based (`0`).
3. **Run a classical recipe:** Open **Analyze → Segment & measure**, choose **Whole image**, then select **Classical methods**, **Components**, **Threshold** `50`, **Above threshold**, and **Minimum object area** `1`. Leave preprocessing empty and border exclusion off, then choose **Run recipe**.
4. **Check the expected objects:** Inspect the object table and label overlay. Expect 3 objects:

   | Object | Pixel count | Calibrated area | Mean scalar intensity |
   | --- | --- | --- | --- |
   | Object 1 | 320 px | 80 µm² | 100 |
   | Object 2 | 768 px | 192 µm² | 150 |
   | Object 3 | 512 px | 128 µm² | 200 |

5. **Practice label correction:** Open **Annotate → Edit labels & ROIs** and delete label 1 to create a two-object revision. Test **Undo revision** and **Redo revision** to see how parent and child revisions remain distinct.
6. **Review and export:** Open **Results → Review & export → Review**, inspect the exact revision yourself, choose **Mark reviewed**, and then choose **Export → Export result**.
7. **Save and reopen:** Choose **Save study…** in the header and reopen it through **Recent work** or **Open study**. Original pixels stay untouched, and every new correction requires its own review.

The synthetic source file stays in a separate app-owned directory if its managed session is discarded. Because **Save study…** preserves the source binding without copying source bytes, keep a copy of the source if you move the study or remove the app profile.

For independent fixture geometry, coordinate conventions, and provenance, see the [first-study reference](workflows/FIRST_STUDY.md). In current source, the optional **Practice: inspect, measure and export** panel in the inspector links directly to these steps and keeps expected values inside a disclosure; it never configures, runs, or reviews work automatically. See the [release record](https://github.com/sidd-bme/loci-app/blob/main/docs/RELEASE_STATUS.md) for downloadable availability.

## Read the workspace

### Layout and navigation

- **Left rail — Images, then Layers & results:** Switch between **Folder tree** for nested imports and **Flat list** for a plain list. **Find images or folders** filters by relative path; **Reveal current image** clears the search and expands ancestors. The header path breadcrumb shows relative location without exposing the host filesystem prefix. Use arrow keys to move through the tree, `Enter` to open an image, and `Space` to select images. In **Study & batch → Batch**, selecting a folder includes its descendant images—check the selected count before running.
- **Layers & results:** Select **Original image** to inspect the raw source display, or select a specific result row to inspect that exact derived revision. Rows display method names, object counts, and review states, adding creation-time or sequence labels when similar results need disambiguation. Open **Review & export → Review → Technical identity** for the full result ID and revision hash.
- **Centre stage:** Displays the 2D image, A/B comparison, or 3D/MPR volume viewport.
- **Right inspector:** Organizes all controls under four task groups (**View**, **Annotate**, **Analyze**, **Results**). Each group remembers its last used tool, and specialized routes appear in labelled sections of each selector. Press `⌘K` (`Ctrl+K` on Windows) to search all tools by name or keyword; use arrow keys and `Enter` to open, or `Escape` to close search.

### Workspace tools at a glance

| Group | Primary tools | Additional & advanced routes |
| --- | --- | --- |
| **View** (`⌘1`) | **Image & channels** | *Import & conversion:* **Convert image format** |
| **Annotate** (`⌘2`) | **Draw & measure**, **Epidermal thickness**, **Edit labels & ROIs** | — |
| **Analyze** (`⌘3`) | **Segment & measure** (including **Model Zoo**), **Preprocess**, **Workflow builder**, **Use a model**, **Epidermis model**, **Fluorescence & field assay**, **Nuclear & cell shape**, **Track over time**, **Wound closure**, **Register & resample** | *Connections:* **Connect an assistant**, **Remote compute** |
| **Results** (`⌘4`) | **Review & export**, **Spatial donor density**, **Statistics & objects**, **Study & batch** | *Portable results:* **Import & share results** |

### Keyboard shortcuts and panel focus

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Search all tools | `⌘K` | `Ctrl+K` |
| Switch inspector group (View / Annotate / Analyze / Results) | `⌘1` – `⌘4` | `Ctrl+1` – `Ctrl+4` |
| Toggle image list | `⌘[` | `Ctrl+[` |
| Toggle tools panel | `⌘]` | `Ctrl+]` |
| Open images / Open folder | `⌘O` / `⌘⇧O` | `Ctrl+O` / `Ctrl+Shift+O` |
| Open study / Save study | `⌘⇧P` / `⌘S` | `Ctrl+Shift+P` / `Ctrl+S` |
| Open Settings | `⌘,` | `Ctrl+,` |
| Open offline User manual | `F1` | `F1` |

The two panel buttons in the header toggle the image list and tools panel while preserving active image and tool state.

When working in larger inspector tools, use the focus toggle in the inspector header (**Focus panel**, **Focus workflow**, or **Focus setup**) to expand the panel across the image stage, then choose **Show image** to return. Controls, drafts, and prepared export previews stay mounted across layout switches; changing tools restores the normal layout. **Study & batch** (**Focus study**) and **Statistics & objects** (**Focus statistics**) provide their own focus toggles.

Native **File** commands open images, folders, and studies in the active workspace (returning from detached image windows to the main workspace first). **Window → Focus control panel** and **Window → Return to workspace** expose the same window switches from the menu bar.

> **Remember the three independent choices:** **Camera** controls only what is on screen; **Display** maps source values to colour; **Analysis scope** declares the exact region, plane, channels, and settings for the next run. Treat the right inspector—not the camera frame—as the declaration of the next operation.

## View images and set display

### Direct 2D viewing and sampling

Open **View → Image & channels**. Expand **Image info** to inspect declared dimensions, axes, channel/sample count, depth/time count, and recorded physical calibration. **Open as** (**Automatic**, **Generic image**, **Histology**, **Fluorescence**, **Volume**, or **Medical research**) is a reversible presentation choice that surfaces relevant workflow shortcuts; it never modifies source values or recorded axes.

> **Calibration boundary:** Print density (DPI) in an ordinary TIFF, PNG, or JPEG does not establish physical specimen size. Loci reports pixels unless supported acquisition metadata (such as OME-TIFF `PhysicalSize` values) declares physical spacing. Older studies with unsupported saved calibration remain readable; import the unchanged source into a new study before making new measurements or exports.

Select a source and choose **Fit** to frame its full plane. Scroll or pinch to zoom around the pointer, and drag to pan.

| 2D viewer action | Shortcut |
| --- | --- |
| Fit selected plane | `F` |
| 1:1 native pixel scale | `1` |
| Zoom in / out | `+` / `-` |
| Reset camera | `0` |
| Pan | Arrow keys |

At **1:1**, one source X pixel spans one physical display pixel while respecting declared Y spacing. The **Display sampling** control applies independently to each 2D view (including each pane of an A/B comparison):

- **Auto:** Smooths below native scale and displays crisp individual pixels at or above 1:1.
- **Nearest pixel:** Shows exact pixel boundaries at every zoom level.
- **Smooth:** Keeps continuous interpolation at all zoom levels.

The status readout names the active sampling mode. Display sampling affects the image display only: categorical label overlays always use nearest-pixel sampling, and all measurements use raw source values.

The navigation toolbar docks above or below the image, and the scale bar keeps its own space outside source pixels. Large images display a bounded overview first and stream finer tiles progressively; the optional navigator shows the full extent and current viewport.

### Z stacks, time series, and loading controls

Use the **Z** and **Time** sliders whenever the source declares depth or time axes. Choose **Play** to step through a time series, and pause playback before opening a plane histogram.

For multi-Z scalar data, the **View** selector switches between **Single plane**, **Maximum projection**, and **Mean projection**. A projection is an explicit display summary over the shown Z range—it is not a raw plane and must not be treated as a 3D object count or measurement.

During rapid Z or Time scrubbing, Loci can show a smaller XY preview based on measured response time and refine once movement stops, without changing the selected native plane or analysis resolution. While a previous plane remains on screen, the status bar identifies both displayed and requested planes and pauses drawing until the requested plane paints. **Stop loading** cancels pending view work without interrupting other views (an active decode may finish); **Retry view** resumes after a stop or error.

The Z and Time sliders stay accessible inside **Annotate** for plane-by-plane drawing. Unfinished drafts are retained separately in memory by source identity, Z/T plane, and drawing tool (up to 128 unfinished drafts; Loci prompts you to save or clear an older draft rather than silently dropping it). Drafts are session-only, clear when opening another study, and are not saved until you explicitly save them; use **Clear draft** to discard the active draft.

### Scalar channels, RGB, and medical windows

Above a scalar image, expand **Display channels** to toggle channel visibility with the eye icon, or click a channel name to adjust its range, gamma, LUT colour, opacity, or **Solo** view. RGB sources show **Image tone** instead. Choose **Full display options** to open histograms inside **View → Image & channels**. Analysis channel selection remains independent inside each analysis tool. Exact native 2D result labels can overlay the source display; non-matching grids open in the result viewer.

Inside **View → Image & channels**, expand any scalar channel to adjust visibility, **Colour**, **Low**, **High**, **Gamma**, and **Opacity**:

- **Auto / Auto range:** Calculates stable channel limits from a full-plane sample of the selected source, T frame, and Z plane—never from a Z projection or the current camera crop.
- **Reset display:** Restores acquisition/default display settings.
- **Hold to show default display:** Temporarily compares your adjusted display against the baseline while held (pointer or Space key).
- **Window & Level:** Shown for declared medical sources or when **Open as → Medical research** is chosen. Window (width) and Level (midpoint) express the same display-range mapping in medical conventions without applying a diagnostic preset or modifying stored pixels.

An interleaved RGB or RGBA file is treated as a colour image: Loci applies a valid embedded ICC profile once to the display copy and exposes one shared **Image tone** curve (**Black point**, **White point**, **Gamma**). RGB components are display samples, not biological channels.

For scalar sources with at least three channels, **Image info → RGB plane mapping** lets you assign three distinct scalar planes to display Red, Green, and Blue. Choose **Apply RGB mapping** for an explicit visual composite and **Restore source composite** to revert. Analysis continues to read the original scalar channels.

### Batch channel colours and A/B comparison

- **Propagate channel colours:** In **View → Image & channels**, select the **Copy colours to images…** button beside **Auto**. Choose target scope (**Selected images** or **All loaded images**) and channel matching (**Name, then index**, **Channel name**, or **Channel index**). Pick a standard palette preset (DAPI/GFP/TRITC/Cy5, DAPI/GFP/TRITC/Far-Red, RGB, CMY, or Greyscale) or customize hex colours. Inspect the preflight preview—which flags skipped interleaved RGB sources—before applying. Colour updates are display-only, leave raw values and reviews untouched, and can be reversed with **Undo colors**.
- **Side-by-side comparison:** With two or more images loaded, select **Compare A/B** in the canvas toolbar. Assign independent sources, T/Z planes, and channels to **Pane A** and **Pane B**. **Match display (A → B)** copies compatible display ranges and colours from A to B for visual comparison only (it does not standardize physical intensity). **Link pan/zoom** activates only when both panes share the same source identity and coordinate grid; matching pixel dimensions alone do not establish correspondence.

### Independent image windows

Select a source and choose **Detach image** to open an independent viewer window (up to two detached views sharing bounded resources). The main window becomes **Image controls**.

- **What carries over:** Current channel colours, ranges, gamma, visibility, opacity (0 transparent to 1 opaque), selected plane/projection, 2D camera, and supported 3D mode, quality, and transfer settings. Finish drawing and clear any display-save error before detaching. VTK orbit pose, clipping, and temporary detail boxes do not transfer yet.
- **Multi-monitor & target control:** Move detached windows across monitors using their native title bars, or toggle native full screen (`Escape` exits). You can open a second view of another source or a second plane/camera of the same source. **Image controls** follows the last focused window (clicking the control panel keeps that target); use **Pin this target** and **Follow focused view** to lock or unlock it. Always verify the view letter and image name before editing.
- **Available tools & conflicts:** Display channels, Z/T, raw volume viewing (synced bidirectionally with the image window), and source annotations work from the control panel. If a stale annotation revision conflicts, Loci preserves your unsaved draft and offers **Reload annotations**. Segmentation, label correction, and full analysis remain in **Return to workspace**.
- **Persistence & recovery:** Window positions, display settings, and pinned target save locally with the study; after reopening, choose **Restore image windows** explicitly. Unsaved drafts are not saved as layout. Saving a new study copy changes document identity and closes detached views. If an image renderer stops, **Reopen** starts a fresh view while preserving committed annotations.

## Use histograms deliberately

Open **Histogram & levels** inside **Image tone** or any expanded scalar channel in **View → Image & channels**.

- **Sampling basis:** A 2D scalar histogram is a deterministic full-plane sample of native scalar values at the selected T and Z plane. An RGB histogram samples stored RGB component values before ICC display conversion. Neither follows camera pan/zoom, and both remain bound to the selected plane even when a Maximum or Mean Z projection is displayed. The caption below the plot reports exact sample count, T, Z, and pyramid level.
- **Adjusting range:** Drag the black and white handles or edit the numeric **Low** and **High** fields.
- **Trim 1–99%:** Sets Low and High to the sampled 1st and 99th percentile bin edges. This is a binned display approximation: values outside the interval clip in screen rendering and rendered figures while source pixels and analysis measurements stay unchanged. The readout below the plot reports the clipped sample-bin percentage.
- **Log counts:** Changes only the vertical display scale of the histogram bars.

> **Not a quantitative assay:** Use the histogram to choose a documented display window and spot acquisition saturation—never as proof of sample comparability or a reason to alter raw pixels. When comparing images visually, set identical display bounds deliberately and retain figure display provenance.

## Inspect scalar volumes and MPR

Choose **Open image in 3D…** on the welcome screen or in the workbench’s **File**
menu. Select one image file, such as a scalar OME-TIFF Z-stack, or on macOS one
OME-Zarr store ending in `.zarr`. For a local multiscale store, a first-channel
maximum-intensity preview can appear during verification. Drag to rotate it or
choose **XY slice** to step through its sampled planes. **Hide preview** leaves
the file opening. The full workspace uses the verified source for measurements,
annotations and exports.

A newly registered OME-Zarr opened this way starts in **MIP** (maximum intensity)
when it has no saved view. Use **Mode** to change the rendering. For an image
already open, choose **3D volume** above the canvas. Choose **2D image** to return
to the source plane. The 3D workspace requires at least two Z planes, up to four
visible scalar channels and compatible orthogonal geometry. A source that supports
only 2D opens with a reason.

### Layout, rendering modes, and focus detail

- **Four panes** (default) shows three linked orthogonal slice views beside the 3D pane. Patient-frame sources display **axial**, **coronal**, and **sagittal** views in radiological orientation (including reslicing oblique acquisitions); generic microscopy sources display **XY**, **XZ**, and **YZ**. Drag the crosshair to synchronize all panes, scroll or press `↑`/`↓` in a slice pane to step through slices, and use each pane's **Expand** / **Restore** button. Choose **3D view** for a single large 3D canvas.
- **Volume and MPR.** In **Volume**, choose **Blend** for opacity compositing or **Normal Shading** to light the volume. **MIP**, **Average** and **MinIP** project the brightest, mean and darkest sampled intensities along each ray, respectively. **MPR** shows intersecting source-grid planes. X, Y and Z follow the acquisition axes, including for oblique data.
- **Rendering & detail:** Expand **Rendering & detail** to adjust 3D **Quality**, toggle a display-only **Clip** plane (**Axis** X/Y/Z and **Position**), or request higher local resolution with **Detail span** (a cube of 32, 64 or 96 voxels, or a 256 × 256 × 64 XYZ field) and **Detail at crosshair**. Once loaded, switch between **Whole** and **Focus**. The status line reports whether every native step fits the active channel and memory budget. A late focus response preserves your crosshair; moving outside the focus box returns to **Whole**. Focus refines display only and never modifies source data.
- **Controls & sampling:** Expand **Controls & sampling** for inline navigation hints. In Volume mode, left-drag (or `Alt`-drag) orbits, right-drag or `Shift`-drag pans, scroll/pinch zooms, arrow keys orbit, `+`/`-` zoom, and `R` resets the camera. Raw slice views use bounded linear resampling; verified label overlays use nearest-pixel native sampling, and 3D label surfaces are bounded voxel display approximations. Always use source-space tools for quantitative measurements.

### Volume channels, histograms, and PNG figures

Expand a volume channel to change colour, **Low**, **High**, **Gamma**, opacity, visibility, or **Reset channel**. Its histogram is a deterministic sample of the whole-volume context at the current T and display level—it stays stable when toggling **Whole** and **Focus**. **Trim 1–99%** remains binned display clipping only.

Choose **Export PNG…** in the volume toolbar to save a `.loci-figure` directory atomically (`image.png` and `manifest.json`).

> **3D figure export scope:** **Export PNG…** captures only the 3D pane at its current screen resolution (the three separate slice panes are excluded; hide labels to export a raw-volume figure). The manifest records source binding, payload fingerprints, representation, camera, transfer functions, shading, clipping, MPR indices/grids when applicable, Loci and VTK software identities, and PNG SHA-256. It intentionally omits scale bars under perspective and contains no original-value pixel arrays.

## Annotate and define analysis scope

### Draw source-bound annotations

Open **Annotate → Draw & measure** to draw points, lines, rectangles, polygons, or freehand regions. Select the intended **T** and **Z** plane first so the annotation binds to the exact source identity and T/Z location. Scale bars and physical lengths appear only when trustworthy calibration is declared.

- **Rectangle:** Drag across the region, or click opposite corners.
- **Polygon:** Click vertices; close by clicking the first point, double-clicking the last point, or pressing `Enter`.
- **Freehand region:** Drag around the boundary and release to close. Freehand regions save in the same source-bound polygon format with a visible vertex-limit notice on long traces.
- **Save or cancel:** Choose **Save annotation** to commit the draft, or press `Escape` to clear it.
- **Inspect stored geometry:** Expand **Measurements & coordinates** on any saved annotation to inspect stored length/perimeter, area, level-0 pixel-edge X/Y points, zero-based T/Z indices, geometry axes, and world coordinates (when supported). Long point lists are paged.

Annotation export/import follows the strict schema in [annotation interchange](ANNOTATION_INTERCHANGE.md). For comparing frozen drawn references or saved masks on identical grids, see [annotation agreement](ANNOTATION_EVALUATION.md).

### Declare analysis scope

Before running processing, segmentation, models, puncta tools, or measurements, confirm your input extent using **View → Image & channels → Analysis region** or the right-hand **Analysis scope** card:

- Set **X**, **Y**, **Width**, **Height**, **Analysis channel**, **Start Z**, **Depth** (**One plane** or **Z range** with exclusive **Stop Z**), and **Time** as needed.
- Use **Draw region** to sketch the yellow analysis rectangle directly on the canvas, or **Whole image** to cover the full plane.
- In **Analysis region**, `X`, `Y`, `C`, `Z`, and `T` are **zero-based** and `Stop Z` is **exclusive** (for example, `Start Z = 0` and `Stop Z = 10` covers 10 planes, displayed as Z 1–10 in summaries).

### Edit segmentation labels

With a segmentation result selected, open **Annotate → Edit labels & ROIs** to correct that exact revision using brush, polygon, merge, delete, or supported watershed-split tools. Every correction produces a new unreviewed child revision while preserving the parent; it never alters source pixels or establishes biological ground truth.

### Calibrated epidermal transects and rete ridge morphometry

Open **Annotate → Epidermal thickness** for guided manual histology transect measurement:

1. Declare the named measurement protocol (upper/lower tissue boundaries, orientation rule, and exclusions such as folds or appendages).
2. Choose the morphological class (**Suprapapillary**, **Ridge-base**, or another protocol-defined category) and draw two-endpoint transects across the viable epidermis.
3. Choose **Save transect** for an unverified record, or **Save reviewed transect** (requiring a reviewer name) to record approval of the current endpoints, boundaries, and orientation. Each save is an independent decision; restoring a draft or saving one transect never approves the next.

Distance is computed as calibrated Euclidean length (`sqrt((dx * pixel_size_x)^2 + (dy * pixel_size_y)^2)`), falling back to pixels without fabricating physical units when calibration is absent. Summary tables separate sampled suprapapillary and ridge-base transects on the current T/Z plane with compatible protocols—they do not search for global minima or maxima automatically. CSV export includes protocol text, source identity, endpoints, zero-based Z/T, coordinate basis, length, units, and reviewer (legacy label-only records stay explicitly unverified). Oblique sectioning and tissue processing distortion are not automatically corrected.

## Run practical analysis workflows

### Classical segmentation, memory budgets, and remote compute

1. Select the source, set display for comfortable viewing, and confirm **Analysis scope**.
2. Open **Analyze → Segment & measure → Classical methods**.
3. Choose **Segmentation input** by recorded channel name and numbered index (adjacent T/Z scope uses one-based labels; submitted API indices stay zero-based) and pick **Raw measurement channel** independently. **Display channel** and **Solo** remain presentation-only and never infer stains or fluorophores.
4. Set threshold, **Components** or **Watershed**, foreground polarity, minimum object area, optional watershed split height, and border exclusion, then choose **Run recipe**. Analysis reads declared raw source data rather than rendered tone curves.

- **Working-memory allowances:** **Recipe resources** shows the engine's working-memory estimate for the selected scope. The default **Recipe memory allowance** is 512 MiB and can be raised up to 8 GiB (or set via the hardware recommendation, which reads installed RAM and neither measures free memory nor reserves RAM). Estimates never execute analysis, and over-budget refusals publish no result. Cellpose-SAM, Cellpose-SAM v2, and Loci Adaptive Watershed expose a shared **Memory allowance** (256 MiB–8 GiB) that persists when switching methods; imported ONNX models use **Working memory**. Accepted allowances travel with saved recipes and results (label corrections record their own budget). Larger allowances never alter resolution or scientific settings, and separate GPU, checkpoint, decoder, and export caps remain in force.
- **Explore before committing:** Choose **Try settings on regions** to compare bounded classical previews across representative ROIs without saving results; adopting a preview creates an unreviewed result. See [exploration and groups](EXPLORATION_AND_GROUPS.md).
- **Run locally or remotely:** Choose **Run on: This Mac** or a configured remote target for supported classical and Cellpose runs. **Compute setup** opens **Settings → Compute** to import a trusted SSH alias, configure a prepared Linux runtime and workspaces, and select CPU or Single GPU resources. **Check runtime** records a dated check without installing runtimes or models. Submitting a remote run authorizes the displayed whole-file transfer, execution, retrieval, and attachment (even for a cropped region). Job Center preserves progress across disconnects and reopens; cancellation stops attachment while scheduler confirmation is pending. See [remote workflow](REMOTE_WORKFLOW.md).

### Loci Adaptive Watershed, Model Zoo, and provisioned models

- **Built-in baseline** (**Loci Adaptive Watershed**): Runs on one 2D plane using the selected scalar channel or RGB-derived grayscale. Its editable, resettable default profile uses Auto image mode and polarity, expected diameter `34 px`, minimum area `80 px`, sensitivity `0`, smoothing `1.2 px`, touching-object splitting enabled, and border exclusion disabled. It normalizes the selected plane at the 1st and 99th percentiles while measuring original scalar intensities (independent of display range). Defaults are starting recommendations, not cell-type inference or assay validation. For supported 3D segmentation, use **Classical methods**.
- **Provisioned models** (**Analyze → Use a model**): Runs explicitly provisioned ONNX model packages with recorded runtime identity, working-memory bounds, and reference-tensor checks; see [model package format](MODEL_PACKAGE_FORMAT.md).
- **Standalone μSAM interchange:** Select a full native level-0 plane or Z range in one original scalar channel, then open **Analyze → Segment & measure → Import existing labels → μSAM (standalone)** to export the raw TIFF handoff. After running μSAM externally, preview the returned label TIFF on the exact same source and confirm import to measure the raw channel and create an unreviewed result. See [external labels](EXTERNAL_LABELS.md).
- **Additional specialist tools:** **Analyze → Preprocess** builds an ordered preprocessing preview (see [Preprocessing pipeline](#preprocessing-pipeline)); **Analyze → Epidermis model** supports explicit managed PUMA H&E tissue preview and adoption ([tissue models](TISSUE_MODELS.md)); **Analyze → Nuclear & cell shape** and **Analyze → Wound closure** compute shape and scratch-assay metrics on exact saved masks ([assay measurements](ASSAY_MEASUREMENTS.md)). Controlled reusable method packages follow [controlled methods](CONTROLLED_METHODS.md).

### Preprocessing pipeline

Open **Analyze → Preprocess** to assemble and preview an ordered scalar preprocessing sequence without altering source pixels or publishing a result:

1. **Analysis scope:** Switch between **Whole image** and **Region** (choosing **Region** enters rectangle drawing on the image with **Cancel drawing** to leave the current scope unchanged, and **Redraw** once a crop is active). The subdued summary reports actual crop dimensions, plane count, and Z/T position when the source has multiple planes or timepoints.
2. **Processing pipeline:** Choose **Add processing step** to pick from **Smoothing** (**Gaussian blur**, **Median filter**), **Background & intensity** (**Background subtraction**, **Subtract constant**), or **Morphology** (**Morphological opening**, **Morphological closing**). Steps run in their numbered order (`01`, `02`, …). Select a step to edit its parameter inline in verified units (`µm` only when calibrated, `px` for uncalibrated native levels, `unit unverified` when calibration is incomplete, or `source intensity` / `step N intensity` for constant subtraction), optionally toggle **Clip negative values to zero** on supported subtraction or flat-field steps, reorder steps with **Up** / **Down**, or remove individual steps. Unfinished or invalid numeric drafts remain visible and block preview/execution across collapse or reordering until corrected, reverted with `Escape`, removed, or restored.
3. **Preview and memory:** Choose **Preview selected crop** below the pipeline to inspect the ordered recipe on the declared scope, and expand **Memory** below it when you need to inspect the working-memory estimate or adjust the allowance.

### Model Zoo

Open **File → Model Zoo…** or **Analyze → Segment & measure → Browse Model Zoo…**. Search for a model or filter by **Local** or **External**. Select a card to see its microscopy example, exact version and workflow.

When a model has a paired prediction, switch between **Original** and **Overlay** or use the comparison divider to inspect the same structures on both sides. The image credit records the source, licence, displayed region and how the overlay was produced. Use the publisher link to visit the model's source or weights. Use the workflow action to return to your own image.

| Profile | What you can use in Loci |
| --- | --- |
| **Cellpose-SAM v2** | Provision the exact `cpsam_v2` checkpoint for cellular instance segmentation. The original `cpsam` remains separately selectable. [Cellpose compatibility](CELLPOSE_COMPATIBILITY.md) |
| **μSAM Light Microscopy Generalist** | Export native pixels, segment them in standalone μSAM, and return the matching labels. The registered generalist uses `vit_b_lm` from the SAM1 registry in `micro-sam v2.0.1`. [Standalone handoff](EXTERNAL_LABELS.md) |
| **StarDist Versatile Fluorescence Nuclei** | Import the native 2D integer labels produced externally by `2D_versatile_fluo`. [Import existing labels](EXTERNAL_LABELS.md) |
| **BioImage.IO 2D Nuclei Boundary ONNX** | Supply a compatible ONNX-only package for the fluorescence nuclei model. The upstream BioImage.IO 0.4.4 archive requires adaptation. [Model package format](MODEL_PACKAGE_FORMAT.md) |
| **PUMA tissue nnU-Net · fold 4** | Supply the exact converted weights and receipt for fold 4. Declare the H&E preparation and inspect the proposed epidermis against the original tissue. [Tissue model](TISSUE_MODELS.md) |

The [Model Zoo guide](MODEL_LIBRARY.md) gives checkpoint identities, papers and publisher links. A verified example documents one execution on the credited image. Assess the output on your specimen before recording a review.

After any segmentation run, select the new result under **Layers & results**, inspect objects and measurements, correct labels if needed, then open **Results → Review & export** to inspect the exact revision and choose **Mark reviewed** before **Export result**. Human review records an assessment of that immutable revision—not an automatic claim of accuracy.

### Repeating a prepared workflow across images

- **Visual workflow graph:** Open **Analyze → Workflow builder** to chain preprocessing, segmentation, raw measurements, and population gates alongside the image canvas, then run saved definitions across compatible sources. See [visual workflows](WORKFLOWS.md).
- **Batch execution:** Open **Results → Study & batch**. For a classical recipe, name it and choose **Save validated recipe** after validation, select target images, and use **Preview** where available. For Adaptive Watershed or a Cellpose profile, configure the exact method in **Analyze** first so the batch freezes its profile, settings, measurement channels, and 2D scope.
- Choose **Run selected sources sequentially** (or on a selected remote target). Loci validates each source and creates durable jobs before execution. **Stop batch** cancels the current item and leaves remaining work queued; **Resume batch** continues queued or interrupted jobs; **Retry failed or cancelled** is a separate action. Completed jobs are never silently duplicated. Use **Open result** on each row to inspect and review before batch export.

### Histology RGB and scalar fluorescence

- **Histology RGB:** Choose **Open as → Histology** to surface **Annotate tissue** and **Choose analysis**. Under **Analyze → Declared stain separation**, declare either the **H&E** or **H-DAB** basis, select the derived stain coordinate, threshold, minimum object area, Components or Watershed, and optional split height. Use **Preview declared stain** before **Run declared stain**. An optional object rule requires an explicit rule name, coordinate, statistic, threshold, and control/evidence note; it records a measurement rule, never an automatic biological classification. For classical RGB analysis, select **Weighted RGB intensity** explicitly under **Intensity input** (a documented 0–1 derivation, not biological channel separation).
- **Scalar fluorescence:** Choose **Open as → Fluorescence**, adjust display channels in **View**, set your scalar analysis channel and scope, and open **Quantify channels** (**Analyze → Fluorescence & field assay**) or another scalar route. Keep measurement channels explicit rather than inferring fluorophores from display colours.

### Fluorescence field assay (signal per nucleus)

Open **Analyze → Fluorescence & field assay → Field assay** for two-channel field quantification on a single native plane:

1. Verify source identity and T/Z plane in the readiness summary.
2. Draw and review a **focus region** and a separate, **disjoint cell-free background region** on that exact plane (annotations from other planes are rejected).
3. Declare the nuclear segmentation channel and signal measurement channel explicitly (metadata or user declarations, never inferred from colour).
4. Preview provisional nuclei using a fixed threshold or Otsu/Yen thresholding and object-size limits (failed automatic thresholds error cleanly and never fall back silently to an arbitrary number).
5. Inspect the computed raw-pixel metrics: signed background-corrected signal sum (`sum(signal in focus) − focus_pixels × background_estimate` using the selected median or mean background estimator), accepted nucleus count, signal per nucleus, and saturation pixel fractions. If automatic nuclei are unsuitable, supply reviewed point marks on the same plane or an explicit reviewed manual count (measuring signal over the full reviewed focus region divided by the human count).
6. Choose **Save exploratory** to keep the unapproved preview, or **Approve & save** (requiring a reviewer name, fixed threshold or reviewed manual count, and valid focus/background regions) to record approval of channel identity, acquisition comparability, focus, nuclei, background, and saturation. Any edit to channels, regions, masks, or settings invalidates the preview.

> **Assay interpretation:** Signal per nucleus is a field-level proxy, not per-cell membrane intensity or absolute receptor abundance. Background subtraction does not establish a positivity cutoff or remove all nonspecific signal. Document controls, acquisition comparability, independent replicates, and normalization references in your study protocol.

## Medical, temporal, and registration work

### Medical research sources

Loci imports documented scalar subsets of NIfTI, NRRD, and explicitly selected conventional CT/MR DICOM series with declared geometry. Choose **Open as → Medical research**, inspect **Image info** (orientation/frame, units, and calibration), and use **Window** and **Level** for viewing. Confirm displayed geometry before opening **Explore in 3D** or MPR. Loci makes no de-identification, diagnostic, clinical-preset, or clinical-performance claim.

### Track over time

Select the target Time frame in **Image & channels** and create or select exact timed result revisions. Open **Analyze → Track over time** to link objects across timepoints and review ambiguous associations before publishing. Tracking records preserve selected timepoints and settings; repeated frames, planes, patches, or objects do not become independent biological samples simply by being numerous. See [assay measurements](ASSAY_MEASUREMENTS.md).

### Register and resample

Open **Analyze → Register & resample** when an explicit transform or resampling grid is required. Inspect source geometry and compatibility first. Registration and resampling create explicit derived state with recorded transforms and grids—they never silently replace an original source or establish biological correspondence. See [registration](REGISTRATION.md).

## Review, batch, and export results

### Inspect provenance, review, and export one result

Open **Results → Review & export** to inspect ordinary results in **Review**:

- **Quantitative summaries:** Pooled mean and range require homogeneous metric fields, declared measurement kinds, and compatible units across rows. Mixed units (such as µm and pixels), mixed kinds (area vs. volume), or declared-versus-unspecified metadata withhold pooled statistics with an explicit explanation while keeping individual rows, selection, and review/export controls usable. Non-finite or missing values are excluded rather than treated as zero (with exclusions disclosed), missing units are labelled unspecified, and partial preview coverage is stated clearly (use **Statistics & objects** for the full population).
- **Analysis details & CLI replay:** Expand **Analysis details** to inspect method, segmentation/measurement channels, measurement basis, region, recorded settings, parent steps, and **Technical record**. Use **Copy analysis request** to copy the verified request, or **Copy CLI recipe JSON** (available on eligible original native 2D CPU Components results) with the inline **Run from CLI** instructions to replay in a saved study via the `loci` CLI. Expand **Technical identity** for the full result ID and revision hash.
- **Review authority:** Choose **Mark reviewed** only after human assessment of that exact revision. Review history distinguishes researcher decisions from explicitly delegated agent reviews (with reason and coverage); a researcher can supersede an agent decision while retaining the prior event, and any label edit creates a new unreviewed revision. Review is an assessment record, not independent validation.
- **Exporting scientific data:** Under **Export**, choose **Export result** to write the scientific package (arrays, labels where applicable, measurements, method/provenance records, review state, and integrity hashes—distinct from a rendered picture). Use **Export scientific data** for interoperable tables and Python/R reader scripts; editable export choices persist across panel navigation, while reopening the panel requires a fresh preview. Large indexed results use their dedicated inspector and export workspace. See [scientific data packages](SCIENTIFIC_DATA_EXPORT.md).

### Explore object populations and spatial density

- **Statistics & objects** (**Results → Statistics & objects**): Explore the full object population with linked tables, charts, and canvas selection. **Go to object label** jumps to an exact label in the current filtered order; **Previous object**, **Next object**, and table arrow keys step across pages without moving the image camera until you choose **Locate selected object**. See [object populations](OBJECT_POPULATIONS.md).
- **External labels and correction effects:** Adopt verified external label masks onto a native source plane ([external labels](EXTERNAL_LABELS.md)), then from a corrected revision choose **Show experiment effect** to compare direct parent and child revisions using the existing object-size endpoint and assigned biological replicates ([correction effects](CORRECTION_EFFECTS.md)).
- **Spatial donor density** (**Results → Spatial donor density**): Pool exact tissue-distance band results within declared donors and compare conditions while retaining counts, sampled areas, and exclusions. See [tissue distance bands](SPATIAL_DISTANCE_BANDS.md) and [spatial donor density](SPATIAL_DONOR_DENSITY.md).

### Organize studies, compare intensity, and export batches

Open **Results → Study & batch** for **Samples**, **Intensity**, **Batch**, and (when available) **Corrections**. **Focus study** expands the workspace and **Show image** restores the canvas; switching tabs preserves unapplied CSV and comparison drafts.

- **Samples:** Search image or sample names in **Sources & samples**, filter by condition, replicate, or metadata/result state, expand a source's **Results** to **Inspect result** (with **Technical result identity**), or choose **Edit metadata**. Missing required metadata and an optional unassigned replicate are tracked separately; neither implies automatic readiness.
- **Intensity:** Compare saved raw mean intensities while preserving image and biological replicate grouping. Long decimals with an **≈** disclosure open via pointer or keyboard to show the exact stored spelling; calculations and exports always keep full precision. See [sample sheets and intensity](EXPERIMENT_INTENSITY.md).
- **Provisional review package** (**Batch**): Select exact revisions, name the package, and choose **Export review package**. Supported whole native `uint8` RGB planes up to 16 megapixels write `counts.csv`, a provenance manifest, and native-resolution boundary-outline PNGs preserving relative paths (source pixels outside recoloured boundaries stay untouched). Pending results may be included without marking them reviewed. Choose a filesystem supporting atomic no-replace publication (such as APFS; exFAT on macOS is unsupported).
- **Reviewed batch & portable exports** (**Batch**): After every intended result is reviewed, export reviewed bundles, reviewed bundles plus a summary CSV, or **Summary CSV only** (count CSV and manifest without image/label bundles). Loci validates exact revisions and destination names before writing. Portable study export (**Results → Import & share results**) retains derived records while omitting private source paths; source-dependent work after import requires exact local relinking.

## Export rendered figures

Open **View → Image & channels → Export rendered image** to export the current visual display (selected plane or Z projection, channel appearance, and display provenance). Rendered figures never export original pixel values or annotation overlays.

| Format | Available extent | Output meaning |
| --- | --- | --- |
| **PNG · 8-bit display** | **Whole image** (up to 1024 px) or **Analysis region** (source pixels, up to 2048 × 2048 px) | Rendered 8-bit RGB display image with rendering provenance |
| **TIFF · 16-bit display** | **Whole selected plane** (full resolution) or **Analysis region** (source pixels) | Rendered 16-bit RGB display image with rendering provenance |

- **Resolution (DPI):** Enter a whole number from `72` to `1200` (initial default `300`, configurable in **Settings → Saving & export**). DPI sets output metadata and print layout—never source resolution or detail.
- **Scale bar & channel legend:** Enable **Include calibrated scale bar** when trustworthy physical X/Y geometry is declared (unavailable for RGBA or uncalibrated sources). Enable **Include channel legend** for visible scalar channels and enter clear user labels. Both sit in a dedicated footer outside source pixels—they are not burned over image data or treated as vector annotations.

> **Choose the right artifact:** Use **Export result** or **Export scientific data** for downstream arrays, labels, measurements, and provenance; use annotation interchange for vector ROIs; use **Export rendered image** only for presentation figures. Never substitute a display figure for raw-value scientific data.

## Settings, recovery, and help

### Open Settings and configure preferences

Open **Settings** from the header or the application menu, or press `⌘,` on macOS (`Ctrl+,` on Windows). Settings opens as an overlay over the current workbench. Choose a category in the sidebar or use **Search settings** to jump directly to a control; **Back** and **Forward** revisit categories. Use **Done**, the close button, or `Escape` to return to the workspace (`Escape` clears an active search first).

- **Appearance:** Choose from eight themes—**Graphite** (default), **Black** (pure black application ground and 2D image surround with neutral gray controls), **Midnight**, **Paper**, **Aurora**, **Ember**, **Lagoon**, and **FIJI**—plus interface font, control density, text size, and motion preference. Appearance persists locally across workspaces without altering source intensities, channel colours, or figure exports.
- **Viewing & help:** Toggle the viewer scale bar (shown only when usable calibration exists), overview navigator, and contextual guidance tips (which also offer **Close tip** and `Escape` dismissal).
- **Saving & export:** Configure default rendered-figure DPI (`72–1200`) and review the boundaries between rendered figures, derived results, and recoverable sessions.
- **External agents:** Set default view-following and activity-expansion preferences for new workspaces (connection permissions stay per-session in the workspace).
- **Capabilities & Compute:** Inspect supported format subsets under **Capabilities**, and manage trusted SSH/cluster targets under **Compute**.
- **User guide:** Open this bundled offline manual or jump directly to a workflow topic. `F1` and **Help → User guide** open the manual directly from anywhere in Loci.

### Numeric editing, layout resizing, and troubleshooting

- **Numeric fields:** Display and analysis-region numbers commit on `Enter` or blur; `Escape` restores the last applied value. Analysis settings accept valid edits immediately. Empty or invalid numbers remain visible with a specific reason (never silently turning into zero) and block running or saving until fixed; choose **Restore applied numbers** to discard unfinished edits.
- **Resizable tools panel:** Drag the left divider of the tools panel to resize it, or focus the divider and use Left/Right arrows, `Home`/`End` for bounds, or double-click to reset. Its width persists locally.
- **Unavailable controls:** Read the inline prerequisite beside any disabled control. Common causes are an unsupported format subset, missing or incompatible calibration/geometry, incomplete analysis scope, absent Z/T axis, source identity mismatch, unprovisioned model/runtime, or an unreviewed result. When reporting an issue, preserve the exact error wording without sharing protected data or private filesystem paths.

## Work with external agents

Open **Analyze → Connect an assistant**. Choose **Inspect**, **Analyze**, or **Full study**, then expand **Customize permissions** to narrow scope before choosing **Grant selected access** and selecting a destination folder. Configure and start the generated local connection in your external assistant host. A prepared bundle is not an active session; the bottom status indicator reports live connection state. Source access, image disclosure, corrections, compute, review, and export always remain explicit grants.

### Follow work and edit a plan

Open the agent indicator in the bottom status bar to inspect connection state, permission mode, **Task plan**, assessments, and recent activity. Pending approval requests remain accessible from every agent section; inspect the requested operation, source, and recorded identity before approving or denying.

- **Follow agent:** Brings agent-inspected views into your workspace; turning it off leaves your view independent. Defaults for new workspaces live in **Settings → External agents** (display preferences only; they grant no access).
- **Edit a task plan:** When an external agent records a goal and steps under **Task plan**, choose **Edit plan** to update the goal, add or remove steps, or reorder them, then **Save plan** (recording changes without running anything). Edited steps reset to **Planned**, and the agent must read the new revision before continuing. If the plan changes concurrently while you edit, your draft stays visible and saving is blocked until you cancel and reload the latest plan.
- **Plans vs. execution:** Plan states are agent-reported; durable jobs and **Recorded activity** provide separate execution evidence. **Cancel plan** cancels the plan record; use **Stop job** to cancel a confirmed running job. A retained plan after disconnect requires an explicit resume from the external agent.

### Inspect evidence and review results

Open any source, result, workflow, or job link to inspect the exact recorded target (changed or missing targets never silently substitute another record). Expand **Recorded activity**, **Step evidence**, or the task record for full identities and provenance.

An **Agent assessment** records the agent's observations, stated limitations, and evidence links; it never substitutes for scientific result review. Choose **Review result** to inspect and record your decision on that exact revision. If underlying evidence changes, the assessment stays in history with a warning.

**Full study** pins the sources present at grant time (excluding later imports) and can delegate approval of exact revisions and exports to new names in the chosen folder. Delegated approvals display **Reviewed by agent** with stated reason, coverage, and authority. Marking the result reviewed in Loci records your researcher decision while retaining the prior agent event; any label correction creates a new unreviewed revision. Inspect review history before exporting. See [agent access](AGENT_ACCESS.md) for supported operations, setup, and revocation.

## Compose and reuse workflows

Open **Analyze → Workflow builder**, then expand **Composed workflows** to inspect a saved multi-step definition (an authorized assistant connection can author the initial definition). Bind exact source, prepared-preview, or result inputs, then choose **Check inputs**. Resolve every missing or incompatible binding before choosing **Run composed workflow**. A saved definition declares intended steps; each durable run records actual node states and exact outputs.

### Inspect and save a run

Select any saved run to review its steps, input bindings, and result links. Choose **Refresh run** to read current state. For desktop-owned runs, **Advance workflow** starts the next ready step and **Cancel composed run** requests cancellation; agent-owned runs remain under their recorded owner. **Open result** requires the exact revision to remain present in study history.

After a successful run, choose **Save as workflow** to retain a reusable definition. Saving a definition never implies another source is compatible or scientifically valid—bind and check inputs again for each new run.

### Continue unfinished work

For a failed or cancelled run, select **Inspect continuation** to review remaining steps, completed evidence, and required replacement inputs. **Prepare fresh run** requires native confirmation and creates a new continuation with updated bindings—it never restarts the old run, carries over an earlier agent's permissions, or starts steps automatically. Select **Advance workflow** once ready, resolving any changed evidence, incompatible replacements, or stale records first.

## Terminal workflows

Use the [Loci CLI](CLI.md) to create studies, register immutable sources, validate explicit JSON requests, inspect measured objects and durable jobs, and export reviewed exact revisions from a shell.

- **Bundled launcher:** The local macOS app ships its own CLI at `Loci.app/Contents/Resources/bin/loci` (add that directory to `PATH` to invoke `loci` directly).
- **Discover and inspect:**
  - `loci discover QUERY` searches supported operations.
  - `loci operation NAME` prints the exact invocation schema.
  - `loci examples` lists authored example requests.
  - `loci doctor` reports lightweight runtime diagnostics (it does not validate models or establish analysis readiness).
- **Replay a desktop recipe:** For an eligible original native 2D CPU Components result, open **Results → Review & export → Review → Analysis details → Copy CLI recipe JSON**, save the copied request as `recipe.json`, save the study via **Save study…** if it is still a managed session, and run it against that `.loci-study` directory with a fresh retry key.
- **Output modes:** Interactive summaries preserve complete identities and numerical precision. Piped output defaults to JSON, `--json` explicitly emits full machine receipts, and `--plain` / `--no-motion` produce control-free output. The welcome animation and optional `loci logo --animate` are strictly bounded. See the [CLI guide](CLI.md) for study paths, object queries, validation, retry keys, review/export gates, and shell completions.
