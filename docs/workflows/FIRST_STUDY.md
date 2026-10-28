# First study with synthetic shapes

Choose **Try an example** on Loci's opening screen. This optional offline workflow creates a normal managed study and one small scalar OME-TIFF. It creates no analysis result or review decision. You can open your own data instead at any time.

These instructions describe current source. The published beta may use earlier
control labels; see [release status](../RELEASE_STATUS.md). The optional inspector
guide is named **Practice: inspect, measure and export** and links to the same
tools without configuring or running analysis for you.

The exact example starts with display contrast 0–200 so its three authored values are visible. This changes only the display; native pixels and measurements remain unchanged. Saved display adjustments take precedence when you reopen the study.

The source contains three authored rectangles, not cells. Its 0.5 µm X/Y pixel spacing is a declared mathematical calibration, not a microscope measurement. This example checks software workflow and arithmetic; it does not establish biological accuracy or researcher usability.

## Declare and run

1. Open **View → Image & channels**. In **Analysis region**, verify X = 0, Y = 0, Width = 256 and Height = 256, the first scalar channel, first Z/time plane and native level 0. Researcher-facing summaries call these Channel 1, Z 1 and T 1; the corresponding recorded API C/Z/T indices are 0. X/Y remain zero-based pixel offsets. The camera and display settings do not define analysis scope.
2. Open **Analyze → Segment & measure**. Choose **Whole image**, then **Classical methods**, **Components**, **Threshold** 50, **Above threshold**, and **Minimum object area** 1. Leave preprocessing empty and **Exclude border objects** unchecked. Set both **Segmentation input** and **Raw measurement channel** to **1: Synthetic scalar intensity**. The adjacent segmentation scope shows T 1 and Z 1; these are the same zero-based T/Z = 0 inputs.
3. Choose **Run recipe**. Expect three objects. The threshold operates on raw uint16 values; display brightness does not change their measurements.

## Inspect the exact result

Open **Results → Statistics & objects**, enter **Go to object label** 1 and choose **Go**. Inspect the selected row; use **Locate selected object** to move the image to it. **Next object** and **Previous object** follow the filtered table order without moving the image. With the complete native scope and recipe above, component IDs follow first pixels in row-major order. Index centroids below are **Y, X**; physical centroids are **X, Y** with authored zero origin and 0.5 µm spacing.

| Label | Native rows Y | Native columns X | Pixels | Area (µm²) | Index centroid (Y, X) | Physical centroid (X, Y), µm | Mean intensity | Intensity sum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 32–47 | 32–51 | 320 | 80 | 39.5, 41.5 | 20.75, 19.75 | 100 | 32,000 |
| 2 | 80–103 | 128–159 | 768 | 192 | 91.5, 143.5 | 71.75, 45.75 | 150 | 115,200 |
| 3 | 160–191 | 64–79 | 512 | 128 | 175.5, 71.5 | 35.75, 87.75 | 200 | 102,400 |

These values follow rectangle height × width, area = pixels × 0.5 × 0.5, and centroid = the midpoint of inclusive pixel indices. Background intensity is zero; each rectangle has a constant scalar intensity. The word “intensity” here describes authored numbers, not a fluorophore or biological channel.

## Correct, review and export

1. Open **Annotate → Edit labels & ROIs**. Select **Correction label** 1 and choose **Delete selected label**. This deliberate practice edit creates a new revision with labels 2 and 3, two objects, and total area 320 µm². The source and parent result stay intact; survivor IDs do not renumber.
2. Choose **Undo revision** to inspect the three-object parent, then **Redo revision** to inspect the two-object correction. Review is bound to the exact revision, so a correction does not inherit a parent's approval.
3. Open **Results → Review & export → Review**. Inspect the measurements and **Technical identity** for the selected revision, then choose **Mark reviewed** yourself. The example never performs this human decision automatically.
4. Choose **Export → Export result** and a new destination. Export requires the reviewed revision and publishes its bundle atomically. Inspect the manifest, result/provenance records, labels and measurement table. Existing destinations are never overwritten.

To browse the study’s source/result bindings, open **Results → Study & batch → Samples**. Expand **Results** in **Sources & samples**, then choose **Inspect result** for the intended revision. **Technical result identity** shows its complete IDs; inspection does not grant review.

## Save, reopen and recover

Choose **Save study…** in the header or **File → Save as study…**, then choose an absent `.loci-study` destination. Reopen it through **Open study** or **Recent work**. Verify the source identity, result revisions and review status.

Save As keeps original source bindings rather than copying raw images. This example's read-only source and provenance sidecar live in a separate app-owned sibling directory outside its discardable managed study. Discarding the managed study preserves that source, so a saved study can still reopen. Removing the app's entire profile or moving the study to another computer requires retaining an exact source copy separately. This small example source is intentionally retained; there is no automatic source deletion.

For a study imported through portable interchange, the unavailable-source banner offers **Relink exact source**. Select the original bytes or a byte-identical local copy. TIFF and ordinary files use a file picker, conventional DICOM series use explicit file selection, and OME-Zarr uses a directory picker. SHA-256/content identity and size must match. A mismatched selection keeps pixel access locked and preserves existing results and review state. Portability's existing relink route remains available.

## Source provenance and reuse

The generator is `engine/src/loci_engine/research_example.py`, version `synthetic-shapes-v1`. It writes a fixed 256 × 256 YX uint16 array, deterministic OME XML with a fixed UUID, explicit calibration, no acquisition time, and no downloaded assets. The independently specified pixel and numerical oracle is in `engine/tests/test_research_example.py`. Each generated source records its exact byte size and SHA-256 in `provenance.json`; study metadata binds that provenance to the exact source ID and hash.

The authored TIFF pixel data and accompanying provenance are dedicated under **CC0-1.0** by Loci contributors. Generator code remains under the repository's Apache-2.0 licence. This teaching source is distinct from the approved product-film media and from any laboratory data.

The packaged regression entrypoint is `desktop/tests/first-study.qa.mjs`. It exercises the welcome action, known recipe, correction, visible human-review controls, export, Save As, cold reopen, portable import and rejected/exact relink. A passing source test does not qualify a changed packaged app; run the harness against the identified candidate and record the source/app/fixture identities.
