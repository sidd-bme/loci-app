# ADR 0001: desktop architecture

- **Status:** accepted for the first product vertical slice
- **Date:** 2026-08-29

## Decision

Loci will use an Electron desktop shell, a React/TypeScript renderer, a narrow
context-isolated preload API, and a separately packaged Python analysis worker.

```text
React renderer -> preload IPC -> Electron main process / job manager
                                      |
                                      +-> versioned Python worker
                                          -> images, masks, models, projects
```

The UI never imports Python or ML libraries. The renderer cannot access Node.js
directly. Long analysis and future training jobs run outside the renderer and
must expose progress, cancellation, timeout, and structured failure states.

## Why

- Electron provides consistent Chromium rendering on macOS and Windows, mature
  window lifecycle behavior, and established packaging/signing tooling.
- Python retains direct access to the scientific imaging and model-training
  ecosystem.
- Process separation lets a failed or memory-heavy analysis restart without
  taking the working interface down with it.
- The Electron overhead is small relative to the eventual scientific runtime
  and model weights.

Tauri remains a viable future shell optimization, but its platform webview split
adds visual QA cost and Rust is not part of the current workstation toolchain.
PySide6/QML would simplify Python calls but adds QML specialization and LGPL
distribution obligations that are unnecessary for the first product.

## Security and filesystem boundary

- Native dialogs grant file access. Canonical paths and source fingerprints stay
  in a main-process registry; the renderer receives opaque source IDs, relative
  display paths, bounded previews, and the metadata needed for review.
- Source files remain read-only.
- The worker communicates over a private JSON-lines subprocess channel, not an
  externally reachable HTTP port.
- Path validation and export destinations are enforced in the main process and
  worker.
- Recursive folder discovery does not decode every image. The source list
  renders in explicit 200-item pages; full previews are loaded only for a
  selected source, and batch analysis exports each result before continuing.
- Worker generations invalidate all cached result IDs on timeout, cancellation,
  protocol failure, or crash, so stale exports cannot look usable.
- Context isolation and sandboxing stay enabled in packaged builds.

## Packaging boundary

Development launches the worker with the project-managed Python environment.
Release builds include a frozen, versioned worker as an application resource.
Packaging fails if that resource is missing. Per-image exports are atomically
published `_loci` directories, and recursive batch exports mirror relative
subfolders plus a relative-path-only manifest. The packaged app must be tested,
Developer-ID signed, and notarized before public release.

## Learned-model licensing gate

Loci will not bundle a pretrained weight simply because its surrounding source
code is permissively licensed. As of this decision, Cellpose source is
BSD-3-Clause, but its maintainers state that current models were trained on
CC-BY-NC data; newer cpdino models also depend on a custom DINOv3 licence.
StarDist source is also permissive, but each pretrained weight and source dataset
requires a separate rights audit.

A monetizable Loci-native model therefore requires documented commercial rights
to its training annotations and upstream weights, or explicit legal clearance.
User-supplied models can later be supported without presenting them as bundled
Loci assets.
