# Exploration and population groups

Compare explicit classical settings on small regions, adopt an inspected configuration, then describe measured object populations with reproducible gates. These tools do not infer cell types or establish biological accuracy.

## Compare regions and settings

1. Open a native scalar image and choose **Analyze → Segment & measure → Try settings on regions**. Draw an ROI or enter zero-based X/Y/C/Z/T under **Region & plane**. Panning does not change the analysis region.
2. Choose raw-intensity threshold and minimum area in the recorded units. Compare up to three ROIs, each at most 512 × 512 pixels, on the same C/Z/T and pyramid level, against three distinct settings. **Enlarge parameter comparison** shows settings as columns and ROIs as rows. Cells report object count, mean area and crop-edge objects alongside image/label views.
3. **Adopt this region** verifies the exact preview identity, settings, measurements and hashes, reruns it, and creates an unreviewed result. **Use settings in Analyze** transfers the actual recipe and region to normal controls for reuse. Saved comparisons are inspectable records; saving one does not adopt a result.

Previews use crop-local connected components with bright polarity, no preprocessing and zero processing halo. Crop-edge objects remain included with clipped measurements. Cropping can change connectivity and object size compared with a whole-image run. A comparison is descriptive sampling, not an accuracy benchmark or proof of whole-image equivalence. Execution is explicit bounded CPU work; it does not download a model or start remote computation. Obsolete responses cannot replace a changed source, plane or region.

Compact **Channels** controls change display visibility, solo and range without leaving the task. Display-channel selection does not select the analysis channel. RGB components remain display samples rather than biological channels.

## Gate all measured objects

In **Results → Statistics & objects → Gates & named groups**, choose recorded metrics and explicit linear or log10 coordinates. Draw a rectangle or polygon, or edit its numeric bounds/vertices with the keyboard. **Evaluate gate on all objects** uses every eligible measurement row, up to 100,000 objects, independently of scatter display sampling, plot zoom and current numeric filters. Highlights use measured centroids on the matching displayed plane.

**Save fixed group & gate** saves both exact-revision membership and a reusable rule. Applying a rule to a compatible result creates a new evaluated group. Union selects any member of the chosen groups, intersection selects members common to all, and unclassified selects the complement of their union in that exact population. Groups may overlap. Highlighting never deletes labels; corrections create child revisions without inherited memberships.

Rectangle/polygon edges are included without expanding membership by a floating tolerance. Log10 axes exclude nonpositive values. Missing and non-finite values are excluded and counted. Incompatible metric kinds/units, stale source bindings and invalid hashes are rejected. Group receipts retain metric descriptors and units, transforms, geometry, accounting, sorted label IDs and exact population/membership hashes. Limits are 256 saved groups, 32 combination operands and dependency depth below 16.

Groups from an unavailable source remain identifiable but cannot be highlighted or combined. Compatible reusable gates can still be applied to an intact result. Object counts describe one result, not independent specimen or patient replicates.

## Save and share

Download exact membership records or use **Import & share results → Export portable study**. Study save and reopen retain groups, comparison records and channel display state. Portable studies retain group receipts; source-dependent viewing after import requires exact source relinking. Tiled-study portability remains unsupported. Log gate geometry is retained in its record; scientific plot export retains its existing raw linear-axis contract.

Continue with [Statistics & objects](OBJECT_POPULATIONS.md), [quantification](QUANTIFICATION.md), or [review and export](USING_LOCI.md#review-batch-and-export-results).
