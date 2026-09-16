# Loci third-party notices

Loci-authored source is licensed under Apache-2.0. This file identifies
important third-party components and model-provenance boundaries; it does not
relicense those works. Repository lock files control the exact software versions
included in a build.

The optional CZI/ND2/LIF conversion route executes an explicitly selected,
hash-pinned Bio-Formats 8.5.0 package JAR and a user-installed Java runtime.
Neither is bundled or downloaded by Loci. The full Bio-Formats package includes
copyleft readers and retains its own licence obligations; Apache-2.0 does not
relicense it. See [the conversion boundary](docs/VENDOR_CONVERSION.md) for exact
artifact identity, upstream source and qualification scope.

## Desktop runtime

| Component | Licence |
| --- | --- |
| Electron and Electron Forge | MIT |
| Chromium and bundled Electron components | See `LICENSES.chromium.html` in the packaged notices directory |
| electron-squirrel-startup | Apache-2.0 |
| Electron Forge Squirrel.Windows maker and electron-winstaller | MIT; used to create the unsigned Windows qualification installer |
| Lucide React | ISC |
| React and React DOM | MIT |

## Analysis runtime

| Component | Licence summary |
| --- | --- |
| NumPy | BSD-3-Clause plus licences for bundled/vendored components |
| Pillow | MIT-CMU |
| SciPy | BSD-3-Clause plus licences and exceptions for bundled numerical runtimes |
| scikit-image | BSD-3-Clause plus licences for bundled/vendored components |
| vtk.js 36.12.0 | BSD-3-Clause; hardware rendering of raw volume and orthogonal display copies |
| tifffile | BSD-3-Clause |
| h5py | BSD-3-Clause |
| HDF5 libraries distributed with h5py | HDF5 licence |
| SimpleITK 2.5.6 | Apache-2.0; the distribution `LICENSE` and `NOTICE` are retained in the frozen worker |
| OpenSlide Python 1.4.6 | LGPL-2.1-only with BSD, MIT, and public-domain example assets; see its exact distribution licence files |
| OpenSlide binary bundle 4.0.1.2 | LGPL-2.1 and the per-library terms shipped in its `licenses` directory; see the distribution boundary below |
| Zarr 3.1.6 | MIT |
| numcodecs 0.16.5 and its bundled codecs | MIT plus the codec licence files shipped by the distribution |
| Model Context Protocol Python SDK 2.1.1 | MIT |
| ONNX 1.22.0 | Apache-2.0 and its distribution `NOTICE` |
| ONNX Runtime 1.29.0 | MIT plus `ThirdPartyNotices.txt` |
| PyYAML 6.0.3 | MIT |
| PyTorch | Apache-2.0 plus notices for bundled LLVM, BSD, Boost, and MIT components |
| torchvision | BSD-3-Clause |
| OpenCV Python headless | Apache-2.0 |
| fastremap | LGPL-3.0 |
| imagecodecs and roifile 2026.2.10 | BSD-3-Clause; imagecodecs also carries its codec-specific licence inventory |
| natsort | MIT |
| tqdm | MPL-2.0 and MIT |
| PyInstaller bootloader | GPL-2.0-or-later with the PyInstaller exception permitting distribution of non-free programs |

## Cellpose integration

| Component | Version or artifact | Declaration and boundary |
| --- | --- | --- |
| Cellpose source/runtime | `cellpose==4.2.1.1` | MouseLand declares BSD-3-Clause. The current macOS and Windows qualification package profiles include this runtime; a future explicitly labelled Lite build may omit it. |
| Original Cellpose-SAM checkpoint | `cpsam` | The official Hugging Face repository currently declares BSD-3-Clause for its files. Loci uses this artifact in the website-compatible default profile; that compatibility default is not an accuracy recommendation. Loci does not bundle or download it. |
| Cellpose-SAM v2 checkpoint | `cpsam_v2` | The official Hugging Face repository currently declares BSD-3-Clause for its files. Loci exposes it as a separate updated, unvalidated profile and does not bundle or download it. |

Loci accepts only the pinned official artifact for the selected profile and
verifies its size and SHA-256 digest before installation. The original `cpsam`
identity is 1,233,587,898 bytes with SHA-256
`e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2`;
the `cpsam_v2` identity is 1,233,586,851 bytes with SHA-256
`0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667`.
A valid artifact for one profile is rejected by the other. Users obtain each
artifact from MouseLand; doing so is subject to the terms and provenance of
that external work.

PyTorch dominates the frozen macOS analysis-engine footprint. The dated QA
checkpoint records the measured size; no Cellpose checkpoint is bundled. The
smaller default source-development environment does not
install Cellpose unless the developer selects the `cellpose` extra.

The [Cellpose source licence](https://github.com/MouseLand/cellpose/blob/main/LICENSE)
is BSD-3-Clause, and the
[official model repository](https://huggingface.co/mouseland/cellpose-sam)
currently declares BSD-3-Clause. The
[Cellpose repository](https://github.com/MouseLand/cellpose) also states that
official models were trained on CC-BY-NC data. Because this training-lineage
statement leaves commercial-weight use unresolved, Loci does not represent
either official checkpoint as cleared for paid inference, commercial
fine-tuning, or bundling. Those uses require written clarification from the
relevant rights holders. A user-supplied checkpoint does not become Apache-2.0
merely because Loci can load it.

If a Cellpose profile is used in research, cite the Cellpose authors and the
specific Cellpose-SAM work as requested by the upstream project. Preserve the
exact package version, model identifier, artifact digest, and compute device in
the analysis record.

The full licence texts distributed by Electron are copied into both packaged
applications. The frozen worker retains the exact distribution metadata and
notice files named above, including the complete OpenSlide binary licence
directory and ONNX Runtime third-party notices.

OpenSlide and its official Python binding are LGPL-2.1. The separately packaged
OpenSlide shared library remains replaceable, but notices alone do not satisfy
every distribution obligation. OpenSlide's official Windows guidance requires
distributors of its binary builds to provide the corresponding source for
OpenSlide and applicable dependencies; the exact 4.0.1.2 `-winbuild` source
bundle is the upstream source counterpart. The local and CI Windows artifacts
are explicitly unsigned qualification builds and are not approved for public
distribution. A public release must add and verify that corresponding-source
delivery, preserve relinking, and complete human licence review.

A public release must also carry an audited dependency SBOM and the full
licence files from the exact locked Python and JavaScript runtime. A build
containing the Cellpose runtime, including both current qualification profiles,
must include its dependency licences as well. This summary is not a substitute
for that release audit. No model checkpoint is included or downloaded by either
platform build.
