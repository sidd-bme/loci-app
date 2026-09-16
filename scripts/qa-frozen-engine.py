#!/usr/bin/env python3
"""Smoke-test the frozen engine, including its optional Cellpose runtime."""

from __future__ import annotations

import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import zlib
from base64 import b64decode
from pathlib import Path

CELLPOSE_VERSION = "4.2.1.1"

# Deterministic 20 x 16 uint8 RGB TIFF compressed with LZW. Keeping the fixture inline
# lets the frozen-runtime QA remain stdlib-only while exercising imagecodecs' lazy
# _imcd extension, which PyInstaller cannot discover through static imports.
LZW_RGB_TIFF = b64decode(
    "SUkqAAgAAAAOAAABBAABAAAAFAAAAAEBBAABAAAAEAAAAAIBAwADAAAAtgAAAAMBAwABAAAABQAAAAYBAwABAAAA"
    "AgAAABEBBAABAAAA4AAAABUBAwABAAAAAwAAABYBBAABAAAAEAAAABcBBAABAAAAVwAAABoBBQABAAAAvAAAABsB"
    "BQABAAAAxAAAABwBAwABAAAAAQAAACgBAwABAAAAAQAAADEBAgAMAAAAzAAAAAAAAAAIAAgACAABAAAAAQAAAAEA"
    "AAABAAAAdGlmZmZpbGUucHkAAAAAAAAAAACABEus+BQSBwWEQeFQaGQmGwuHRGIROHxWJRaKReNRmORiPRuPx2QS"
    "ORSWQyeSSiTSmWSuXSqYS2Yy+ZTWaTeZzmbTqcTufT2gTyhT+h0GiUejUmix6Ag="
)

# A deterministic 1 x 1 x 8 x 8 ONNX Identity graph and matching float32 NPY
# reference tensor. Keeping both inline preserves this harness's stdlib-only
# host dependencies while proving that the frozen ONNX checker, shape inference,
# CPU execution provider and reference comparison work together.
ONNX_IDENTITY_MODEL = b64decode(
    "CA06cgoeCgNyYXcSC3Byb2JhYmlsaXR5IghJZGVudGl0eToAEgp0ZXN0LW1vZGVsWh0KA3JhdxIW"
    "ChQIARIQCgIIAQoCCAEKAggICgIICGIlCgtwcm9iYWJpbGl0eRIWChQIARIQCgIIAQoCCAEKAggI"
    "CgIICEIECgAQEg=="
)
ONNX_IDENTITY_REFERENCE = b64decode(
    "k05VTVBZAQB2AHsnZGVzY3InOiAnPGY0JywgJ2ZvcnRyYW5fb3JkZXInOiBGYWxzZSwgJ3NoYXBl"
    "JzogKDEsIDEsIDgsIDgpLCB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg"
    "ICAgICAgICAgICAgIAoAAAAACtcjPArXozyPwvU8CtcjPc3MTD2PwnU9KVyPPQrXoz3sUbg9zczM"
    "Pa5H4T2PwvU9uB4FPilcDz6amRk+CtcjPnsULj7sUTg+XI9CPs3MTD49Clc+rkdhPh+Faz6PwnU+"
    "AACAPrgehT5xPYo+KVyPPuF6lD6amZk+UriePgrXoz7D9ag+exSuPjMzsz7sUbg+pHC9PlyPwj4U"
    "rsc+zczMPoXr0T49Ctc+9ijcPq5H4T5mZuY+H4XrPtej8D6PwvU+SOH6PgAAAD9cjwI/uB4FPxSu"
    "Bz9xPQo/zcwMPylcDz+F6xE/4XoUPz0KFz+amRk/9igcP1K4Hj+uRyE/"
)


def _write_synthetic_png(path: Path) -> None:
    width = 128
    height = 96
    cells = ((28, 25, 11), (68, 25, 12), (105, 28, 10), (48, 68, 11), (92, 67, 12))
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # PNG filter type: none
        for x in range(width):
            foreground = any((x - cx) ** 2 + (y - cy) ** 2 <= radius**2 for cx, cy, radius in cells)
            rows.append(236 if foreground else 18)

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    png = bytearray(b"\x89PNG\r\n\x1a\n")
    png.extend(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)))
    png.extend(chunk(b"IDAT", zlib.compress(bytes(rows), level=9)))
    png.extend(chunk(b"IEND", b""))
    path.write_bytes(png)


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _write_onnx_package(root: Path) -> Path:
    package = root / "onnx-package"
    package.mkdir()
    (package / "model.onnx").write_bytes(ONNX_IDENTITY_MODEL)
    (package / "reference-input.npy").write_bytes(ONNX_IDENTITY_REFERENCE)
    (package / "reference-output.npy").write_bytes(ONNX_IDENTITY_REFERENCE)
    manifest = {
        "schema_version": "loci.model-package/1",
        "id": "frozen-identity-fixture",
        "version": "1.0.0",
        "task": "semantic-segmentation",
        "model": {
            "source": "model.onnx",
            "sha256": _sha256(ONNX_IDENTITY_MODEL),
            "opset_version": 18,
        },
        "input": {
            "id": "raw",
            "axes": "BCYX",
            "dtype": "float32",
            "shape": [1, 1, 8, 8],
            "channels": [{"name": "input-0", "source_index": 0}],
            "scale_yx": [0.5, 0.5],
            "scale_unit": "um",
        },
        "output": {
            "id": "probability",
            "axes": "BCYX",
            "dtype": "float32",
            "shape": [1, 1, 8, 8],
            "channels": [{"name": "probability-0", "source_index": 0}],
            "scale_yx": [0.5, 0.5],
            "scale_unit": "um",
            "semantics": "probabilities",
        },
        "preprocessing": [{"id": "ensure_dtype", "kwargs": {"dtype": "float32"}}],
        "tiling": {"input_yx": [8, 8], "halo_yx": [2, 2], "padding": "edge"},
        "postprocessing": [{"id": "ensure_dtype", "kwargs": {"dtype": "float32"}}],
        "labels": {"threshold": 0.5, "channel": 0},
        "reference": {
            "input": {
                "source": "reference-input.npy",
                "sha256": _sha256(ONNX_IDENTITY_REFERENCE),
            },
            "output": {
                "source": "reference-output.npy",
                "sha256": _sha256(ONNX_IDENTITY_REFERENCE),
            },
            "rtol": 0.0,
            "atol": 0.0,
            "mismatched_elements_per_million": 0,
        },
        "citations": [{"text": "Synthetic identity graph", "url": "https://example.test/model"}],
        "rights": {
            "license": "CC0-1.0",
            "redistribution": "allowed",
            "commercial_use": "allowed",
            "training_data": "synthetic values only",
        },
        "validation": {
            "status": "unvalidated",
            "summary": "Structural test fixture; no biological validation.",
        },
    }
    (package / "loci-model.json").write_text(json.dumps(manifest), encoding="utf-8")
    return package


def _run_cli(executable: Path, arguments: list[str]) -> dict[str, object]:
    completed = subprocess.run(
        [os.fspath(executable), "--cli", *arguments],
        text=True,
        capture_output=True,
        timeout=180,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"Frozen engine CLI exited {completed.returncode}. stderr:\n{completed.stderr.strip()}"
        )
    value = json.loads(completed.stdout)
    _require(isinstance(value, dict), "Frozen engine CLI returned a non-object receipt")
    return value


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: qa-frozen-engine.py /absolute/path/to/loci-engine "
            "/absolute/path/to/modern-overview.ims",
            file=sys.stderr,
        )
        return 2

    executable = Path(sys.argv[1]).resolve()
    ims_fixture = Path(sys.argv[2]).resolve()
    _require(executable.is_file(), f"Frozen engine does not exist: {executable}")
    _require(ims_fixture.is_file(), f"Frozen IMS fixture does not exist: {ims_fixture}")
    h5py_metadata = list(
        (executable.parent / "_internal").glob("h5py-*.dist-info")
    )
    _require(
        len(h5py_metadata) == 1,
        "Frozen engine must contain exactly one h5py distribution metadata directory",
    )
    _require(
        (h5py_metadata[0] / "licenses" / "LICENSE").is_file(),
        "Frozen engine is missing the h5py BSD licence",
    )
    _require(
        (h5py_metadata[0] / "licenses" / "licenses" / "hdf5.txt").is_file(),
        "Frozen engine is missing the HDF5 licence",
    )

    with tempfile.TemporaryDirectory(prefix="loci-frozen-engine-qa-") as temporary:
        root = Path(temporary)
        image_path = root / "synthetic-cells.png"
        lzw_tiff_path = root / "lzw-rgb.tif"
        _write_synthetic_png(image_path)
        lzw_tiff_path.write_bytes(LZW_RGB_TIFF)
        requests = (
            {"id": "health", "method": "health", "params": {}},
            {
                "id": "lzw-tiff",
                "method": "inspect",
                "params": {"path": os.fspath(lzw_tiff_path), "max_edge": 64},
            },
            {
                "id": "modern-ims",
                "method": "inspect",
                "params": {"path": os.fspath(ims_fixture), "max_edge": 64},
            },
            {
                "id": "cellpose-cpsam",
                "method": "cellpose_status",
                "params": {"profile_id": "cellpose-sam"},
            },
            {
                "id": "cellpose-cpsam-v2",
                "method": "cellpose_status",
                "params": {"profile_id": "cellpose-sam-v2"},
            },
            {
                "id": "classical",
                "method": "segment",
                "params": {
                    "path": os.fspath(image_path),
                    "profile_id": "loci-classical",
                    "settings": {
                        "image_mode": "fluorescence",
                        "polarity": "bright",
                        "expected_diameter_px": 22,
                        "min_area_px": 60,
                        "split_touching": False,
                    },
                },
            },
        )
        request_stream = "".join(json.dumps(request) + "\n" for request in requests)
        environment = os.environ.copy()
        environment["LOCI_MODEL_HOME"] = os.fspath(root / "empty-model-home")
        completed = subprocess.run(
            [os.fspath(executable)],
            input=request_stream,
            text=True,
            capture_output=True,
            env=environment,
            timeout=180,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"Frozen engine exited {completed.returncode}. stderr:\n{completed.stderr.strip()}"
            )
        responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
        by_id = {response.get("id"): response for response in responses}
        _require(
            set(by_id) == {
                "health",
                "lzw-tiff",
                "modern-ims",
                "cellpose-cpsam",
                "cellpose-cpsam-v2",
                "classical",
            },
            "Missing QA responses",
        )
        for response_id, response in by_id.items():
            _require("error" not in response, f"{response_id} failed: {response.get('error')}")

        health = by_id["health"]["result"]
        _require(health.get("status") == "ready", "Frozen engine health check did not pass")

        lzw_tiff = by_id["lzw-tiff"]["result"]
        lzw_source = lzw_tiff.get("source", {})
        _require(
            (
                lzw_source.get("width"),
                lzw_source.get("height"),
                lzw_source.get("channels"),
                lzw_source.get("dtype"),
                lzw_source.get("format"),
            )
            == (20, 16, 3, "uint8", "TIFF"),
            "Frozen engine did not decode the LZW RGB TIFF correctly",
        )
        _require(
            str(lzw_tiff.get("preview_data_url", "")).startswith("data:image/png;base64,"),
            "Frozen engine did not render the LZW TIFF preview",
        )

        modern_ims = by_id["modern-ims"]["result"]
        ims_source = modern_ims.get("source", {})
        ims_details = ims_source.get("source_details", {})
        _require(ims_source.get("format") == "IMS", "Frozen engine did not identify IMS")
        _require(
            ims_source.get("access_mode") == "overview",
            "Frozen engine did not preserve the IMS overview-only boundary",
        )
        _require(
            ims_details.get("kind") == "ims-volume"
            and ims_details.get("selected_resolution_level") == 0
            and ims_details.get("selected_z") == 0
            and ims_details.get("composite_mode") == "loci-overview-composite"
            and ims_details.get("channel_color_sources")
            == ["declared-base-colour", "declared-base-colour"]
            and ims_details.get("channel_range_sources")
            == ["stored-histogram-range", "stored-histogram-range"],
            "Frozen engine returned invalid IMS overview provenance",
        )
        _require(
            str(modern_ims.get("preview_data_url", "")).startswith("data:image/png;base64,"),
            "Frozen engine did not render the IMS overview",
        )

        cellpose_results = {
            "cellpose-sam": by_id["cellpose-cpsam"]["result"],
            "cellpose-sam-v2": by_id["cellpose-cpsam-v2"]["result"],
        }
        expected_artifacts = {
            "cellpose-sam": "cpsam",
            "cellpose-sam-v2": "cpsam_v2",
        }
        for profile_id, cellpose in cellpose_results.items():
            package = cellpose.get("package", {})
            model = cellpose.get("model", {})
            _require(cellpose.get("profile_id") == profile_id, "Wrong Cellpose profile status")
            _require(
                package.get("required_version") == CELLPOSE_VERSION,
                "Wrong required Cellpose version",
            )
            _require(
                package.get("installed_version") == CELLPOSE_VERSION,
                "Cellpose is not frozen",
            )
            _require(package.get("exact") is True, "Frozen Cellpose version is not exact")
            _require(
                cellpose.get("code") == "model-missing",
                "QA model home should be unprovisioned",
            )
            _require(
                model.get("artifact_id") == expected_artifacts[profile_id],
                "Wrong Cellpose checkpoint identity",
            )
            _require(
                model.get("present") is False,
                "The intentionally empty managed model home unexpectedly contains a checkpoint",
            )
            _require(
                cellpose.get("devices", {}).get("cpu") is True,
                "Cellpose/Torch did not import",
            )

        classical = by_id["classical"]["result"]
        _require(
            classical.get("profile", {}).get("id") == "loci-classical",
            "Wrong classical profile",
        )
        _require(classical.get("cell_count", 0) > 0, "Frozen classical segmentation found no cells")

        onnx_package = _write_onnx_package(root)
        onnx_study = root / "onnx-qa.loci-study"
        _run_cli(
            executable,
            ["create", "--project", os.fspath(onnx_study), "--title", "Frozen ONNX QA"],
        )
        onnx_model = _run_cli(
            executable,
            [
                "import-model",
                "--project",
                os.fspath(onnx_study),
                "--path",
                os.fspath(onnx_package),
                "--working-bytes",
                str(256 * 1024**2),
            ],
        )
        qualification = onnx_model.get("reference_qualification", {})
        comparison = qualification.get("comparison", {}) if isinstance(qualification, dict) else {}
        runtime = qualification.get("runtime", {}) if isinstance(qualification, dict) else {}
        _require(
            qualification.get("compatible") is True
            and comparison.get("maximum_absolute_error") == 0.0
            and comparison.get("mismatched_elements") == 0,
            "Frozen ONNX reference inference did not reproduce the exact expected output",
        )
        _require(
            runtime.get("backend") == "onnxruntime"
            and runtime.get("requested_providers") == ["CPUExecutionProvider"]
            and runtime.get("session_providers") == ["CPUExecutionProvider"],
            "Frozen ONNX inference did not use the bounded CPU execution provider",
        )

        print(
            json.dumps(
                {
                    "status": "passed",
                    "engine_version": health.get("engine_version"),
                    "cellpose_version": CELLPOSE_VERSION,
                    "cellpose_status": {
                        profile_id: result.get("code")
                        for profile_id, result in cellpose_results.items()
                    },
                    "cellpose_cpu": {
                        profile_id: result.get("devices", {}).get("cpu")
                        for profile_id, result in cellpose_results.items()
                    },
                    "managed_checkpoint_present": {
                        profile_id: result.get("model", {}).get("present")
                        for profile_id, result in cellpose_results.items()
                    },
                    "classical_cell_count": classical.get("cell_count"),
                    "onnx_reference_inference": "exact-cpu",
                    "lzw_tiff": "decoded",
                    "modern_ims": "overview-decoded",
                },
                sort_keys=True,
            )
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.SubprocessError, ValueError) as exc:
        print(f"Frozen engine QA failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
