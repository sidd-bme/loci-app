# Contributing to Loci

Thank you for your interest in contributing to Loci! Loci is an open-source, local-first biomedical imaging workbench built under the Apache-2.0 licence.

## Guiding Principles

1. **Scientific Integrity First:** Numerical invariants, coordinate systems, array axes, and calibration units must be maintained intentionally. Never silently repair or clamp scientific values without explicit, tested, and documented rationale.
2. **Local-First & Immutable Sources:** Source images are treated as strictly read-only. Derived measurements and annotations belong in explicit export or study files.
3. **Model & Runtime Safety:** Never add automated network downloads of models or external runtimes. Keep renderer isolation, path containment, and overview bounds intact.
4. **Reproducibility:** Code changes that affect analysis calculations, persistence, or exports must include test coverage proving reproducibility.

## Getting Started

### Prerequisites

- Node.js >= 24
- Python 3.11–3.13 (Python 3.12 recommended)
- `uv` package manager

### Local Environment Setup

```bash
# Clone the repository
git clone https://github.com/sidd-bme/loci-app.git
cd loci-app

# Setup Python analysis engine
cd engine
uv sync --extra dev --extra onnx
uv run ruff check .
uv run pytest

# Setup Electron desktop application
cd ../desktop
npm ci
npm run check
npm start
```

## Pull Request Guidelines

- Create a feature branch from `main`.
- Write small, focused commits with descriptive messages following Conventional Commits (e.g., `feat: ...`, `fix: ...`, `test: ...`, `docs: ...`).
- For changes spanning the desktop and engine, run the combined source regression runner. It checks those two suites; it does not build or test the packaged app:
  ```bash
  node scripts/run-core-regressions.mjs --mode=source
  ```
- For a focused change, run the checks for the affected layer described in the [extension guide](docs/EXTENDING_LOCI.md). Packaging and changed desktop-to-engine journeys need the matching packaged check in [Building Loci](docs/BUILDING.md).
- Ensure documentation is updated alongside code changes.
- Avoid introducing binary assets, model weights, or private test images into the Git history. Use synthetic numpy/fixture generators in tests.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `desktop/` | Electron application, React interface and desktop tests |
| `engine/` | Python image processing, measurements and scientific tests |
| `modeling/` | Model packaging, evaluation and supporting tools |
| `docs/` | User guides, format references and architecture decisions |
| `scripts/` | Build, verification and maintenance utilities |

## Feedback and documentation

A useful issue describes the workflow, Loci version, operating system, expected
result and what happened. Prefer a small public or synthetic example when reporting
an image-related problem. Do not upload confidential research or patient data.
Report security concerns through [SECURITY.md](SECURITY.md).

Documentation improvements are welcome. For documentation-only changes, check
links, anchors and examples; application tests are needed when behaviour changes.
See the [extension guide](docs/EXTENDING_LOCI.md) before choosing where a new
analysis workflow or desktop action belongs.
