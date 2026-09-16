#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
engine_root="$project_root/engine"

cd "$engine_root"
# Keep the developer verification tools available after a local bundle build.
# PyInstaller traces only runtime imports, so these tools do not enter the app.
uv sync --python 3.12 --frozen --extra dev --extra bundle --extra cellpose --extra onnx
uv_run=(uv run --frozen --extra dev --extra bundle --extra cellpose --extra onnx)
"${uv_run[@]}" python -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'
"${uv_run[@]}" python -c 'import SimpleITK, mcp, numcodecs, onnx, onnxruntime, openslide, roifile, yaml, zarr'
onnxruntime_root="$("${uv_run[@]}" python -c 'from importlib.util import find_spec; spec = find_spec("onnxruntime"); assert spec and spec.submodule_search_locations; print(next(iter(spec.submodule_search_locations)))')"
# imagecodecs discovers codec extension modules lazily at decode time. PyInstaller's
# static import analysis otherwise keeps only _shared, which makes compressed TIFFs
# fail in the packaged app (for example, LZW requires imagecodecs._imcd).
# ONNX and ONNX Runtime are statically imported by the bounded model-package
# path. Their normal PyInstaller analysis (plus the contributed ONNX Runtime
# binary hook) keeps the runtime modules and provider libraries. Avoid
# `--collect-all` here: it treats thousands of upstream backend conformance
# fixtures and unrelated conversion tools as runtime data, bloating the signed
# macOS bundle without supporting Loci inference.
"${uv_run[@]}" pyinstaller \
  --noconfirm \
  --clean \
  --onedir \
  --name loci-engine \
  --distpath "$engine_root/dist" \
  --workpath "$engine_root/build/pyinstaller" \
  --specpath "$engine_root/build/pyinstaller" \
  --additional-hooks-dir "$script_dir/pyinstaller_hooks" \
  --collect-all imagecodecs \
  --collect-all SimpleITK \
  --collect-all openslide \
  --collect-all openslide_bin \
  --collect-all zarr \
  --collect-all numcodecs \
  --hidden-import onnx \
  --hidden-import onnxruntime \
  --add-data "$onnxruntime_root/LICENSE:onnxruntime" \
  --add-data "$onnxruntime_root/ThirdPartyNotices.txt:onnxruntime" \
  --collect-all yaml \
  --collect-all roifile \
  --copy-metadata cellpose \
  --copy-metadata h5py \
  --copy-metadata SimpleITK \
  --copy-metadata openslide-python \
  --copy-metadata openslide-bin \
  --copy-metadata zarr \
  --copy-metadata numcodecs \
  --copy-metadata roifile \
  --copy-metadata onnx \
  --copy-metadata onnxruntime \
  --copy-metadata PyYAML \
  --copy-metadata mcp \
  --exclude-module matplotlib \
  --exclude-module pandas \
  --exclude-module tkinter \
  "$engine_root/loci_engine_entry.py"

# Finder can create metadata files anywhere it browses, including inside the
# virtual environment that PyInstaller collects. They are not runtime inputs and
# must never become part of the frozen worker or the signed application bundle.
find "$engine_root/dist/loci-engine" -type f -name .DS_Store -delete

qa_root="$(mktemp -d "${TMPDIR:-/tmp}/loci-frozen-qa.XXXXXX")"
trap 'rm -rf -- "$qa_root"' EXIT
ims_fixture="$qa_root/modern-overview.ims"
"${uv_run[@]}" python "$script_dir/create-ims-qa-fixture.py" "$ims_fixture"
"${uv_run[@]}" python "$script_dir/verify_frozen_engine_bundle.py" \
  --bundle "$engine_root/dist/loci-engine" \
  --lock "$engine_root/uv.lock" \
  --platform darwin \
  --arch arm64
"${uv_run[@]}" python "$script_dir/qa-frozen-engine.py" \
  "$engine_root/dist/loci-engine/loci-engine" \
  "$ims_fixture"

# QA may cause Finder to revisit an open build directory. Sanitize once more at
# the handoff boundary; the desktop packager performs the same check on its copy.
find "$engine_root/dist/loci-engine" -type f -name .DS_Store -delete
