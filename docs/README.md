# Loci documentation

Guides for working with images, understanding results and developing Loci.

## Start here

- **[Install Loci](INSTALLATION.md)** — download the macOS beta and complete first launch.
- **[First study](workflows/FIRST_STUDY.md)** — walk through opening an image, running a recipe and saving your work.
- **[User guide](USING_LOCI.md)** — open images, use the workspace and save a study.
- **[Supported formats and capabilities](CAPABILITY_MATRIX.md)** — check the available operations for your data.

## Work with images

| I want to… | Guide |
| --- | --- |
| Adjust channels, contrast and histograms | [Image display](USING_LOCI.md#view-images-and-set-display) |
| Annotate structures or choose a region | [Annotations and scope](USING_LOCI.md#annotate-and-define-analysis-scope) |
| Segment objects and inspect measurements | [Analysis workflows](USING_LOCI.md#run-practical-analysis-workflows) |
| Explore a volume and linked slices | [Volume viewing](USING_LOCI.md#inspect-scalar-volumes-and-mpr) |
| Review, export and return to a study | [Results and export](USING_LOCI.md#review-batch-and-export-results) |
| Prepare an image for a figure | [Rendered figures](USING_LOCI.md#export-rendered-figures) |

## Go deeper

- **Data:** [whole-slide images](WHOLE_SLIDE_SUPPORT.md), [OME-Zarr](OME_ZARR_SUPPORT.md), [Imaris IMS](IMS_OVERVIEW_SUPPORT.md), [vendor conversion](VENDOR_CONVERSION.md).
- **Analysis:** [quantification](QUANTIFICATION.md), [counting policy](COUNTING_POLICY.md), [Cellpose setup and compatibility](CELLPOSE_COMPATIBILITY.md), [model packages](MODEL_PACKAGE_FORMAT.md).
- **Explore settings and groups:** [regional previews, ROI comparisons and population gates](EXPLORATION_AND_GROUPS.md).
- **Explore results:** [object populations and statistics](OBJECT_POPULATIONS.md), [external labels](EXTERNAL_LABELS.md), [correction effects](CORRECTION_EFFECTS.md), [visual workflows](WORKFLOWS.md).
- **Compare and export study data:** [sample sheets and raw mean intensity](EXPERIMENT_INTENSITY.md), [scientific data packages and Python/R readers](SCIENTIFIC_DATA_EXPORT.md). These workflows are available in current source; see the release record for the published download.
- **Automation:** [command line](CLI.md), [local agents and MCP](AGENT_ACCESS.md).
- **Sharing and compute:** [study interchange](RESEARCH_INTERCHANGE.md), [annotation interchange](ANNOTATION_INTERCHANGE.md), [remote workflow](REMOTE_WORKFLOW.md).

The [capability matrix](CAPABILITY_MATRIX.md) records format-specific boundaries. The [release record](RELEASE_STATUS.md) distinguishes published builds from development work; the [changelog](../CHANGELOG.md) tracks changes.

## Develop and contribute

Start with [contributing](../CONTRIBUTING.md) for setup and checks, or the [extension guide](EXTENDING_LOCI.md) for where a workflow belongs and how to verify it. Use [building Loci](BUILDING.md) for packaging. The extension guide describes the desktop and analysis engine boundaries.

[Reproduce a bounded workflow](REPRODUCIBILITY.md) to compare the engine, CLI, worker and MCP against independent numerical expectations, or run the installed-ImageJ comparator.

[Image credits](media/README.md) · [Licence](../LICENSE) · [Security](../SECURITY.md) · [Back to Loci](../README.md)
