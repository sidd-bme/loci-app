<p align="center">
  <img src="desktop/assets/loci-mark-128.png" width="72" alt="Loci">
</p>

<h1 align="center">Loci</h1>
<p align="center"><strong>An open imaging workbench for life-science research.</strong></p>
<p align="center">Explore images, develop repeatable analyses, and work with an authorized AI assistant while keeping each result connected to its source.</p>

<p align="center">
  <a href="https://github.com/sidd-bme/loci-app/releases/tag/v0.2.0-beta.2">Download for macOS</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/sidd-bme/loci-app/issues">Feedback</a> ·
  <a href="https://ko-fi.com/lociimaging">Support on Ko-fi</a>
</p>

The current download is **v0.2.0-beta.2 for Apple Silicon Macs**. Newer shared
agent workflows, scientific data packages and researcher-interface refinements
are available in the source tree; they are not all included in that download.
Staged development apps remain unreleased candidates. See the
[release record](docs/RELEASE_STATUS.md) and [capability guide](docs/CAPABILITY_MATRIX.md)
for the difference.

## See Loci in action

https://github.com/user-attachments/assets/d825ca58-b8ed-4011-83e0-a6ea6b4fe6b3

Loci brings your images, measurements and analysis tools into one desktop workspace. Move from a tissue overview to individual cells, explore a volume, refine a segmentation, and keep the results connected to the image they came from.

Your original data stays intact. Core viewing and analysis run on your computer, with no account or cloud service required. Model checkpoints are supplied separately, with explicit runtime/profile requirements; you choose whether to connect an external assistant or configured remote computer.

The existing film and captures show recorded development-app views, not a version-specific feature guarantee for the download. [Media credits and capture provenance](docs/media/README.md) describe their sources and limits.

## See the whole picture

Open microscopy images, whole-slide scans and 3D volumes. Navigate channels, depth and time, then set the colours and contrast that make the structures you care about easier to see.

![Histology in Loci, with native image navigation and display controls](docs/media/histology-current.png)

| Follow your channels | Explore in three dimensions |
| :--- | :--- |
| ![Multichannel fluorescence and channel controls](docs/media/multichannel.png) | ![Fluorescence volume with independent channel display controls](docs/media/fluorescence-volume-current.png) |
| Adjust each channel without changing the source pixels. | Rotate a volume and tune its colour and opacity. |

### Connect the slices

Linked orthogonal views keep a point in context across the volume. Inspect the planes alongside a 3D view and move between them as you explore.

![Linked MRI slices and a rotating 3D template volume in Loci](docs/media/medical-volume.gif)

## From objects to answers

Bring your own model and keep the rest of your workflow in one place. Use a [compatible local model](docs/MODEL_PACKAGE_FORMAT.md), a configured Cellpose profile, or import labels from another segmentation tool. Inspect individual objects, filter their measurements, refine labels, and compare distributions in the statistics workspace. Save a study when you pause and return with the images, settings and results together.

![Cellpose segmentation labels overlaid on a complex image, alongside full-population statistics](docs/media/cellpose-population-current.png)

*4,837 imported Cellpose objects, with measurements and distributions linked to the source image. This view shows retained imported labels, not a new inference run or an accuracy benchmark.*

- **Measure in context.** Draw regions and annotations, inspect object measurements, and keep calibration and units alongside the results.
- **Review and refine.** Edit labels, compare correction effects, and choose the results you want to export.
- **Build a repeatable workflow.** Save recipes, run batches, and use the command line or local MCP connection for supported automation.
- **Share the result.** Export tables, rendered figures and portable studies.

Current source also includes [scientific data packages](docs/SCIENTIFIC_DATA_EXPORT.md)
with exact stored measurements, provenance and Python/R readers, plus
[sample sheets and raw mean intensity comparisons](docs/EXPERIMENT_INTENSITY.md)
that retain image and declared replicate grouping. The study workspace separates
samples, intensity, batches and correction comparisons; result review and export
have their own sections. Inspect exact result identities, object labels and stored
values when you need them. These additions are available when building from source;
see the [release record](docs/RELEASE_STATUS.md) for downloadable availability.

## Work your way

Use the desktop for exploration and the command line for repeatable work. Discover commands, inspect a study and run supported operations from a local terminal.

![Loci command-line workflow, replayed from recorded terminal output](docs/media/cli-workflow.gif)

### Connect an assistant

Through a local MCP connection, an authorized assistant can inspect granted sources, prepare supported recipes, follow permitted tasks and inspect results. The current source adds named workflow, exploration, population and study actions, retained image previews and comparisons, exact activity links, expiring approvals and explicit Follow controls. Availability depends on the granted operations and each action’s documented source and method limits.

You choose the sources, operations and response categories it may access. A cloud-hosted assistant can receive the data its client is permitted to read; local execution does not make that external client private by itself. A prepared access bundle or SDK check does not establish a completed journey in a particular agent host. You remain in control of permissions, and review history distinguishes researcher decisions from explicitly delegated agent decisions.

![MCP capabilities: source inspection, recipe preparation, execution, results and reviewed export](docs/media/mcp-overview.svg)

*Capability illustration, not a connected-host recording.*

[Set up agent access](docs/AGENT_ACCESS.md) · [Explore the CLI](docs/CLI.md)

## Start a study

**[Download the development beta for Apple Silicon Macs](https://github.com/sidd-bme/loci-app/releases/tag/v0.2.0-beta.2)**, follow the **[installation guide](docs/INSTALLATION.md)**, then **[open your first image](docs/workflows/FIRST_STUDY.md)**.

This beta is unnotarized, so macOS requires an explicit first-launch approval. Model weights are supplied separately. The guides cover both steps.

| Learn | Make it your own |
| :--- | :--- |
| [User manual](docs/USING_LOCI.md) | [Command line](docs/CLI.md) |
| [Formats and capabilities](docs/CAPABILITY_MATRIX.md) | [Local agent and MCP access](docs/AGENT_ACCESS.md) |
| [Analysis workflows](docs/WORKFLOWS.md) | [Build from source](docs/BUILDING.md) |
| [What's new](CHANGELOG.md) | [Contribute](CONTRIBUTING.md) |

## Looking ahead

Current source refinements focus on first-study guidance, clearer analysis scope,
unfinished numeric drafts and reachable actions in longer forms. They preserve
the existing methods, source data and review boundaries; their availability is
separate from the published beta.

Next development directions are:

- A complete journey with one named, supported assistant client.
- Clearer complex-data inspection and explicit preparation routes.
- Bounded method extensions that keep the Apache-2.0 local core independent.
- Complete quantitative 3D workflows, from declared scope to reviewed export.

Model training, additional platforms and easier distribution remain later
directions. These are development priorities, not promises for the current download.

## Made for everyday research

Loci started with a practical cell-counting workflow. It is growing into the imaging workspace I wanted to use: approachable enough for a quick look with room to follow an analysis further.

Found a rough edge, have a workflow in mind, or want to help? [Open an issue](https://github.com/sidd-bme/loci-app/issues). If Loci is useful to you, [supporting it on Ko-fi](https://ko-fi.com/lociimaging) helps keep the project moving.

---

[Apache-2.0](LICENSE) · [Image and film credits](docs/media/README.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Security](SECURITY.md)

<sub>Research software in active development; not intended for clinical diagnosis.</sub>
