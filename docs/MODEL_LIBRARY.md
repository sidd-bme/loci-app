# Model Zoo

Open **File → Model Zoo…** to browse microscopy segmentation models. Search by model, biological target or modality. **Local** shows profiles you can provision in Loci. **External** shows methods whose labels you can bring back to the workbench.

## Inspect an example

Select a model to inspect its image at higher resolution. When the example includes a verified model output, use **Original** and **Overlay** on its card or move the comparison divider in the detail view. Both sides show the same field of view. The example credits identify the specimen, image author, licence, processing and origin of the prediction. An entry with only a source image has a single view.

The catalog and its images open offline. Choose a publisher link to visit that destination, or use the workflow action to open the corresponding tool. Running a local model requires its exact supported files and runtime.

| Example | What you can inspect |
| --- | --- |
| Cellpose-SAM v2 | A three-channel optical section through a human stem-cell colony from BBBC034v1, with 38 predicted cell instances. |
| μSAM | A native confocal section of DAPI-stained nuclei from the authors' example volume. This entry shows the input only. |
| StarDist | The fluorescence field from the authors' prediction notebook, with 48 predicted nuclear instances. |
| BioImage.IO nuclei boundary model | The supplier's 256 × 256 test image, with 45 connected components from the model's foreground probability at a threshold of 0.5. |
| PUMA | A melanoma H&E training tile with the fold-4 tissue model's predicted epidermis. |

These examples document what each run produced on one field. Accuracy on a new specimen requires independent reference annotations.

## Choose a workflow

| Model | What it does | Workflow in Loci |
| --- | --- | --- |
| Cellpose-SAM v2 | Finds individual cells by grouping pixels along predicted flows from a SAM ViT-L backbone. | **Analyze → Segment & measure → Cellpose-SAM v2** |
| μSAM Light Microscopy Generalist | Uses a microscopy-tuned SAM image encoder for prompted segmentation. The matched decoder supports automatic instances. | **Analyze → Segment & measure → Import existing labels → μSAM (standalone)** |
| StarDist Versatile Fluorescence Nuclei | Predicts radial distances to the nuclear boundary and assembles star-convex polygons in 2D fluorescence images. | **Analyze → Segment & measure → Import existing labels** |
| BioImage.IO 2D Nuclei Boundary ONNX | Predicts foreground and boundary probabilities in fluorescence images. Postprocessing separates nuclear instances. | **Analyze → Use a model** |
| PUMA tissue nnU-Net · fold 4 | Segments tissue compartments in melanoma H&E. Loci surfaces the predicted epidermis from the six-class tissue output. | **Analyze → Epidermis model** |

For an offline method with no learned weights, **Analyze → Segment & measure** includes classical thresholding, connected components and watershed.

## Model records

### Cellpose-SAM v2

The registered local profile uses Cellpose `4.2.1.1` and the `cpsam_v2` checkpoint from publisher revision `7c61431b5fbb`. Its SHA-256 is `0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667`. The original `cpsam` checkpoint has a separate profile in Loci. The Cellpose-SAM preprint describes the method family. The versioned file and publisher's model notes identify v2. [Pinned v2 weights](https://huggingface.co/mouseland/cellpose-sam/blob/7c61431b5fbb078f3296754bd15d9f51b320f837/cpsam_v2) · [Publisher's model notes](https://cellpose.readthedocs.io/en/latest/models.html) · [Pachitariu, Rariden & Stringer, bioRxiv preprint](https://doi.org/10.1101/2025.04.28.651001) · [Original Cellpose method, Nature Methods](https://doi.org/10.1038/s41592-020-01018-x)

### μSAM Light Microscopy Generalist

The native TIFF handoff targets the `vit_b_lm` profile in the SAM1 registry of `micro-sam v2.0.1`. Its BioImage.IO record is **diplomatic-bug 1.2**. The publisher pins `vit_b.pt` and `vit_b_decoder.pt` with xxh128 digests `fe9252a29f3f4ea53c15a06de471e186` and `708b15ac620e235f90bb38612c4929ba`, respectively. Use the external tool on the exported image. Loci checks the returning labels against the exported source and native grid. [Versioned BioImage.IO model card](https://bioimage.io/#/artifacts/diplomatic-bug/v0) · [Pinned upstream registry](https://github.com/computational-cell-analytics/micro-sam/blob/d45ab70ece93a9eb3ca1e237b9067767b0a18263/micro_sam/v1/util.py) · [Archit et al., Nature Methods](https://doi.org/10.1038/s41592-024-02580-4) · [Standalone handoff guide](EXTERNAL_LABELS.md#offline-standalone-μsam-interchange)

The native 16-bit DAPI crop is available alongside its display image. [Native image crop](../desktop/src/renderer/model-zoo/examples/micro-sam-vit-b-lm/source.png) · [Source dataset](https://doi.org/10.5281/zenodo.4462097)

### StarDist Versatile Fluorescence Nuclei

Use `2D_versatile_fluo` with scalar 2D nuclear fluorescence. The publisher reports that its v0.1 release archive `python_2D_versatile_fluo.zip` has SHA-256 `4ad678d0758eed6e55625f1b5ae30771e59adb79f1239e09b9772eac8846c3dd`. Bring the resulting unsigned integer instance-label TIFF back on its native grid. [Publisher release and model weights](https://github.com/stardist/stardist-models/releases/tag/v0.1) · [Schmidt et al., MICCAI](https://doi.org/10.1007/978-3-030-00934-2_30) · [External label guide](EXTERNAL_LABELS.md)

### BioImage.IO 2D Nuclei Boundary ONNX

Open a study and choose **Install for this study** in Model Zoo or **Analyze → Use a model**. Loci downloads 111.2 MiB from BioImage.IO, verifies each file and runs the publisher's reference test on the CPU. You can cancel the download. Once installed, select a fluorescence channel and preview the model offline with a 2 GiB working-memory budget. Check the outlines before saving or correcting the result.

The installer reads three pinned files from the BioImage.IO `affable-shark` v0 artifact on `hypha.aicell.io`. They accompany Constantin Pape's Zenodo publication. The upstream package contains several weight formats. The study stores the verified ONNX adapter and its reference tensors.

You can also prepare and import a local ONNX-only Loci manifest or supported single-weight BioImage.IO 0.5 package offline via **Import model package…** (and recover moved studies via **Re-import model package…**). The upstream `weights.onnx` has SHA-256 `df913b85947f5132bcdaf81d91af0963f60d44f4caf8a4fec672d96a2f327b44`. The catalog-installed `0.1.0-publication-20261015-r2` adapter has package SHA-256 `774aa0c53566c9f995af02c905863c0ca86b71460f93c3a11fe101b11c5ba582`. The earlier independently checked, locally adapted `0.1.0-zenodo-v7` package has SHA-256 `94259d554d02f43c4d5fa116f0e9e647be4be5c7ed00fb7555b141a9e9f2937b`. The CPU reference check compares two float32 output channels and establishes technical runtime compatibility only, not biological or clinical accuracy. [Zenodo weights and model documentation](https://zenodo.org/records/6647674) · [Ronneberger et al., U-Net architecture](https://doi.org/10.1007/978-3-319-24574-4_28) · [Local package format and qualification](MODEL_PACKAGE_FORMAT.md#shared-research-workflow-evidence)

The gallery example was generated with the same upstream ONNX weights in the `0.1.0-publication-20261015-r2` adapter. Its credit records the full package identity, foreground threshold and source image. [Example execution record](../desktop/src/renderer/model-zoo/examples/bioimageio-nuclei-boundary-onnx/credit.json)

Touching nuclei can merge when the foreground channel is thresholded into connected components. On one annotated BBBC039 field, this setting produced 66 objects and matched 62 of 71 manually outlined nuclei at an intersection-over-union threshold of 0.50. On five further fields, object-level F1 ranged from 0.77 to 0.91. These values describe the tested fields and settings. Check representative images from your own acquisition before comparing object counts. [BBBC039 images and manual outlines](https://bbbc.broadinstitute.org/BBBC039)

### PUMA tissue nnU-Net

PUMA is a melanoma dataset and challenge. Loci's `puma-tissue-cpu` version `0.1.0` implements the **fold-4 nnU-Net PlainConvUNet tissue baseline**. It normalizes a complete native H&E RGB plane and retains the original tissue classes. Epidermis is class 4. The study workflow takes two local files, converted network weights and their matching conversion receipt. The publisher's `checkpoints.zip` supplies the upstream checkpoint. Loci's importer requires the converted pair. [Pinned baseline implementation](https://github.com/tueimage/PUMA-challenge-baseline-track1/tree/211782054387f0d28e170ed565cdfb6e8b53d1a7) · [Zenodo upstream weights](https://zenodo.org/records/14651631) · [Schuiveling et al., GigaScience](https://doi.org/10.1093/gigascience/giaf011) · [Loci provisioning and review](TISSUE_MODELS.md)

The displayed PUMA example uses a full 1024 × 1024 training tile from the authors' public dataset. Loci ran the registered weights on all nine overlapping windows with four mirror evaluations each. The overlay highlights the model's epidermis class. It illustrates the inference on this field and supplies no independent test of accuracy. [Source image and CC0 dedication](https://zenodo.org/records/15050523)

## Reviewing study results

Review a proposed result against the original image at the scale relevant to the research question. Author annotations, predicted labels, and a researcher's corrected revision have different provenance. Loci keeps the model and runtime identities and the review decision with the result. Weights, images and software each have their own licence. The example credit identifies the image terms. The model record gives the publisher's terms for the weights.
