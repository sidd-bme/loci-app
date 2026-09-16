# Product media and image credits

These screenshots and the silent, captioned product video show the packaged
macOS application with runtime `8d2b009`. They demonstrate actual viewing,
annotation, illustrative analysis, review and display controls. They do not
establish biological accuracy, clinical suitability or completed release
qualification. See the [current verification record](../PROJECT_STATE.md).

All scientific content comes from three public **CC0-1.0** fixtures. The source
arrays were not retouched. Display colours, ranges, camera and selected planes
were set through Loci's real controls. The volume has independent display
transfers. The 2D scene displays all three components; the raw-volume scene
shows the explicitly labelled 450 nm component in cyan at opacity 0.2, with
the other volume components hidden. Cyan, magenta and yellow are display
choices, not inferred stains.

| Fixture | Credit and source | Preparation |
| --- | --- | --- |
| `Phase cell.ome.tiff` | Paul Müller, Mirjam Schürmann, Salvatore Girardo, Gheorghe Cojoc and Jochen Guck, [Optics Express (2018)](https://doi.org/10.1364/OE.26.010729); [scikit-image cell documentation and CC0 statement](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.cell) | Exact uint8 pixels from `cell.png` written as tiled OME-TIFF, with the documented 0.107 µm XY spacing. This is a quantitative phase image. |
| `Kidney fluorescence.ome.tiff` | Genevieve Buckley, Monash Micro Imaging (2018); [scikit-image kidney documentation and CC0 statement](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.kidney) | Exact TIFF pixels reordered from ZCYX to explicit TCZYX OME axes, with documented calibration. No intensity rescaling was applied to the source. |
| `CMU-1-Small-Region.svs` | [OpenSlide Aperio test data](https://openslide.cs.cmu.edu/download/openslide-testdata/Aperio/), item licence CC0-1.0 | Original downloaded SVS bytes. This small exported region has one stored level; it demonstrates the SVS reader and native detail. |

The phase image's adaptive watershed result is illustrative. Its displayed
object count is not a ground-truth count or an accuracy result. Multiple scenes
use the same underlying fixtures; they are not independent datasets.

[Public provenance](provenance.json) binds each delivered media file to its
SHA-256, the exact app components, and the original and converted fixture
identities. Full qualification and capture receipts remain outside Git. No
protected laboratory image, local source locator or private study is included.

The video uses real renderer frames at 30 fps, 450 ms transitions and short
captions below the uncropped application frame. It contains no soundtrack,
generated imagery or simulated interface. Volume preparation happens before
that scene begins; the film is an edited tour, not a loading-speed measurement.
The [manifest](../../scripts/demo/demo-manifest.json) describes reproducible
capture and editing.

The underlying scientific fixtures retain CC0-1.0. Loci-authored interface and
production code are covered by the repository's [Apache-2.0 licence](../../LICENSE).
