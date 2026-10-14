# Reproduce a bounded analysis workflow

Two portable harnesses check declared computations and retained analysis context.
They generate their own regression fixtures and require explicit selection of
any external image, runtime or model. They do not start remote jobs or install
software. Their receipts describe the exact source and inputs tested.

## Setup

Use macOS or Linux, a Git checkout and Python 3.12 for the four-interface harness.
Its subprocess-pipe transport is not supported on Windows. Follow
[Building Loci](BUILDING.md) to prepare the locked development environment:

```console
cd engine
uv sync --frozen --extra dev
cd ..
```

This explicit setup installs dependencies. If an existing environment contains
optional model or bundling extras, preserve its full profile and use its existing
interpreter instead of resynchronizing with fewer extras.

## Compare four production interfaces

From the repository root, choose an output directory that does not exist:

```console
engine/.venv/bin/python scripts/publication_workflow.py --output .loci/reproduction/offline
```

The harness creates a deterministic, calibrated 48 × 64 pixel OME-TIFF and runs
one raw-intensity, four-connected component recipe through the direct engine,
operator CLI, desktop worker RPC and MCP. An independent queue-based flood-fill
oracle checks labels, raw measurements, physical calibration and coordinates.
The fixture includes diagonal contacts, a hole, threshold equality, a border
component and a subminimum component; the declared recipe retains five objects.

Each interface must preserve the scientific settings and its exact result
revision through a fresh process or session. The harness also checks export
denial before review, rejection of an unapproved MCP recipe, and policy
revocation. The worker RPC check exercises the desktop-to-engine boundary; it
does not interact with the Electron GUI.

To test the local review/export transition, use another absent output directory
and append `--simulate-operator-review`. The receipt explicitly labels this
automated operator transition. It is not a scientist's approval of the image or
analysis, and it does not grant MCP authority to perform review.

To use an already built worker for the CLI, RPC and MCP routes, append
`--frozen-worker /absolute/path/to/loci-engine`. The direct-engine route and
independent oracle continue to use the source environment. The receipt records
and rechecks the supplied worker's byte identity.

## Add the pinned public image

The optional public input is the CC0 quantitative phase image documented as
[`skimage.data.cell`](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.cell).
Credit: Paul Müller and colleagues, [Optics Express (2018)](https://doi.org/10.1364/OE.26.010729).
The admitted PNG is 74,183 bytes, with SHA-256
`8d23a7fb81f7cc877cd09f330357fc7f595651306e84e17252f6e0a1b3f61515`.
Its decoded grid is 660 × 550 scalar `uint8` pixels. The harness preserves these
encoded samples and authors the documented 0.107 µm/pixel spacing into a derived
OME-TIFF; it does not reconstruct physical phase values from PNG intensities.

Supply a previously acquired exact file:

```console
engine/.venv/bin/python scripts/publication_workflow.py --output .loci/reproduction/public --public-cell /absolute/path/to/cell.png
```

Alternatively, explicitly request the single revision-pinned, size- and
hash-checked download:

```console
engine/.venv/bin/python scripts/publication_workflow.py --output .loci/reproduction/public-download --fetch-public-cell
```

Both commands run the authored fixture first, then the public image. The public
recipe uses raw samples greater than 120, four-connected components, a minimum
area of 10 µm² and retained border objects. This declared demonstration is not an
accuracy estimate for cell segmentation.

## Check the same arithmetic with ImageJ

Provide an installed JDK with the Java 11-or-newer source-file launcher and an
installed ImageJ JAR. The comparator does not acquire either runtime. It records
their identities and runs the Java API headlessly:

```console
engine/.venv/bin/python scripts/publication_imagej.py --output .loci/reproduction/imagej --java /absolute/path/to/jdk/bin/java --ij-jar /absolute/path/to/ij.jar
```

Append `--public-cell /absolute/path/to/cell.png` to include the same pinned
public image. The comparator checks authored topology and arithmetic cases,
exact label grids, raw-intensity preservation and numerical fields. It also
checks that invalid inputs and conflicting output destinations are rejected.
This is a bounded ImageJ API comparison, not a comparison of complete GUI
workflows, speed or biological accuracy.

## Read the result

Both harnesses require an absent output directory and retain partial evidence
on failure. Exit code 0 and a `receipt.json` status of `passed` require the
declared checks to pass; missing inputs are not counted as skipped success.
Results include source and runtime identities, independent expectations,
persisted measurements and arrays, and retained execution diagnostics.

The focused regression checks are:

```console
engine/.venv/bin/python -m pytest -q scripts/tests/test_publication_workflow.py scripts/tests/test_publication_imagej.py
```

These reproductions cover their stated two-dimensional recipes and transitions.
They do not reproduce every feature test, qualify another packaged build, or
establish independent researcher usability, model accuracy or biological validity.
The [release record](RELEASE_STATUS.md) identifies published artifacts and their
separate checks. Receipts can contain local operator paths and policies; inspect
them before sharing and keep generated studies and diagnostics out of source Git.
