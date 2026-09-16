from __future__ import annotations

import hashlib
import importlib.metadata
import json
from pathlib import Path

import numpy as np
import onnx
import pytest
import yaml
from onnx import TensorProto, helper, numpy_helper

import loci_engine.model_packages as packages


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_model(
    path: Path,
    *,
    shape: tuple[int, int, int, int] = (1, 1, 8, 8),
    output_channels: int = 1,
    custom_domain: bool = False,
) -> None:
    input_value = helper.make_tensor_value_info("raw", TensorProto.FLOAT, shape)
    output_shape = (shape[0], output_channels, shape[2], shape[3])
    output_value = helper.make_tensor_value_info("probability", TensorProto.FLOAT, output_shape)
    if output_channels == shape[1]:
        node = helper.make_node(
            "Identity", ["raw"], ["probability"], domain="unsafe.example" if custom_domain else ""
        )
    else:
        assert output_channels == 2 and shape[1] == 1
        node = helper.make_node("Concat", ["raw", "raw"], ["probability"], axis=1)
        graph = helper.make_graph([node], "test-model", [input_value], [output_value])
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
        onnx.save_model(model, path)
        return
    graph = helper.make_graph([node], "test-model", [input_value], [output_value])
    imports = [helper.make_opsetid("", 18)]
    if custom_domain:
        imports.append(helper.make_opsetid("unsafe.example", 1))
    model = helper.make_model(graph, opset_imports=imports)
    onnx.save_model(model, path)


def _write_npy(path: Path, value: np.ndarray) -> dict[str, str]:
    np.save(path, value)
    return {"source": path.name, "sha256": _sha(path)}


def _native_package(
    root: Path,
    *,
    shape: tuple[int, int, int, int] = (1, 1, 8, 8),
    halo: tuple[int, int] = (2, 2),
    output_channels: int = 1,
    channel_sources: tuple[int, ...] | None = None,
    custom_domain: bool = False,
) -> tuple[Path, np.ndarray]:
    root.mkdir()
    model_path = root / "model.onnx"
    _write_model(
        model_path,
        shape=shape,
        output_channels=output_channels,
        custom_domain=custom_domain,
    )
    reference = np.arange(np.prod(shape), dtype=np.float32).reshape(shape) / np.float32(
        max(100, np.prod(shape))
    )
    output = (
        reference
        if output_channels == shape[1]
        else np.repeat(reference, output_channels // shape[1], axis=1)
    )
    input_reference = _write_npy(root / "reference-input.npy", reference)
    output_reference = _write_npy(root / "reference-output.npy", output)
    manifest = {
        "schema_version": packages.PACKAGE_SCHEMA,
        "id": "fixture-model",
        "version": "1.2.3",
        "task": "semantic-segmentation",
        "model": {
            "source": "model.onnx",
            "sha256": _sha(model_path),
            "opset_version": 18,
        },
        "input": {
            "id": "raw",
            "axes": "BCYX",
            "dtype": "float32",
            "shape": list(shape),
            "channels": [
                {
                    "name": f"input-{index}",
                    "source_index": source_index,
                }
                for index, source_index in enumerate(
                    channel_sources if channel_sources is not None else range(shape[1])
                )
            ],
            "scale_yx": [0.5, 0.5],
            "scale_unit": "um",
        },
        "output": {
            "id": "probability",
            "axes": "BCYX",
            "dtype": "float32",
            "shape": [shape[0], output_channels, shape[2], shape[3]],
            "channels": [
                {"name": f"probability-{index}", "source_index": index}
                for index in range(output_channels)
            ],
            "scale_yx": [0.5, 0.5],
            "scale_unit": "um",
            "semantics": "probabilities",
        },
        "preprocessing": [{"id": "ensure_dtype", "kwargs": {"dtype": "float32"}}],
        "tiling": {
            "input_yx": list(shape[-2:]),
            "halo_yx": list(halo),
            "padding": "edge",
        },
        "postprocessing": [{"id": "ensure_dtype", "kwargs": {"dtype": "float32"}}],
        "labels": {"threshold": 0.5, "channel": 0},
        "reference": {
            "input": input_reference,
            "output": output_reference,
            "rtol": 0.0,
            "atol": 0.0,
            "mismatched_elements_per_million": 0,
        },
        "citations": [{"text": "Synthetic test architecture", "url": "https://example.test/model"}],
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
    (root / "loci-model.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root, reference


def _bioimage_package(root: Path) -> Path:
    root.mkdir()
    model_path = root / "unseen.onnx"
    _write_model(model_path)
    reference = np.linspace(0, 1, 64, dtype=np.float32).reshape(1, 1, 8, 8)
    input_ref = _write_npy(root / "unseen-input.npy", reference)
    output_ref = _write_npy(root / "unseen-output.npy", reference)
    rdf = {
        "format_version": "0.5.11",
        "type": "model",
        "id": "unseen-conforming-model",
        "version": "0.9.0",
        "name": "Unseen conforming ONNX model",
        "description": "Source-independent adapter fixture",
        "license": "MIT",
        "cite": [{"text": "Fixture method", "doi": "10.0000/example"}],
        "training_data": {"id": "synthetic/unseen"},
        "inputs": [
            {
                "id": "raw",
                "axes": [
                    {"type": "batch", "size": 1},
                    {"type": "channel", "channel_names": ["raw"]},
                    {"type": "space", "id": "y", "size": 8, "scale": 0.5, "unit": "um"},
                    {"type": "space", "id": "x", "size": 8, "scale": 0.5, "unit": "um"},
                ],
                "data": {"type": "float32"},
                "test_tensor": input_ref,
                "preprocessing": [{"id": "ensure_dtype", "kwargs": {"dtype": "float32"}}],
            }
        ],
        "outputs": [
            {
                "id": "probability",
                "axes": [
                    {"type": "batch", "size": 1},
                    {"type": "channel", "channel_names": ["foreground"]},
                    {
                        "type": "space",
                        "id": "y",
                        "size": {"tensor_id": "raw", "axis_id": "y"},
                        "scale": 0.5,
                        "unit": "um",
                    },
                    {
                        "type": "space",
                        "id": "x",
                        "size": {"tensor_id": "raw", "axis_id": "x"},
                        "scale": 0.5,
                        "unit": "um",
                    },
                ],
                "data": {"type": "float32", "range": [0.0, 1.0]},
                "test_tensor": output_ref,
                "postprocessing": [{"id": "ensure_dtype", "kwargs": {"dtype": "float32"}}],
            }
        ],
        "weights": {
            "onnx": {
                "source": "unseen.onnx",
                "sha256": _sha(model_path),
                "opset_version": 18,
            }
        },
        "config": {
            "bioimageio": {
                "reproducibility_tolerance": {
                    "relative_tolerance": 0.0,
                    "absolute_tolerance": 0.0,
                    "mismatched_elements_per_million": 0,
                    "output_ids": ["probability"],
                    "weights_formats": ["onnx"],
                }
            }
        },
    }
    (root / "rdf.yaml").write_text(yaml.safe_dump(rdf, sort_keys=False), encoding="utf-8")
    return root


def test_optional_runtime_status_is_absent_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    original = importlib.metadata.version

    def version(name: str) -> str:
        if name in {packages.ONNX_DISTRIBUTION, packages.ORT_DISTRIBUTION}:
            raise importlib.metadata.PackageNotFoundError(name)
        return original(name)

    monkeypatch.setattr(importlib.metadata, "version", version)

    status = packages.runtime_status()

    assert status["ready"] is False
    assert status["code"] == "optional-runtime-missing"
    assert status["versions"]["onnx"] is None
    assert status["supported_providers"] == ["CPUExecutionProvider"]


def test_native_package_reference_preview_and_tiled_run(tmp_path: Path) -> None:
    root, reference = _native_package(tmp_path / "native")

    package = packages.inspect_model_package(root)
    qualified = packages.run_reference_test(package)
    source = np.arange(11 * 13, dtype=np.uint16).reshape(11, 13) / np.float32(255)
    preview = packages.preview_inference(
        package,
        source,
        source_axes="YX",
        source_scale_yx=(0.5, 0.5),
        source_scale_unit="um",
    )
    run = packages.run_inference(
        package,
        source,
        source_axes="YX",
        source_scale_yx=(0.5, 0.5),
        source_scale_unit="um",
    )

    assert qualified.compatible is True
    assert qualified.comparison["maximum_absolute_error"] == 0.0
    assert qualified.runtime["requested_providers"] == ["CPUExecutionProvider"]
    assert qualified.runtime["session_providers"] == ["CPUExecutionProvider"]
    assert json.loads(json.dumps(package.public_record())) == package.public_record()
    with pytest.raises(TypeError):
        package.preprocessing[0]["kwargs"]["dtype"] = "float64"  # type: ignore[index]
    assert package.public_record()["rights"]["license"] == "CC0-1.0"
    assert package.public_record()["validation"]["status"] == "unvalidated"
    np.testing.assert_array_equal(preview.probabilities[0], source.astype(np.float32))
    np.testing.assert_array_equal(run.probabilities, preview.probabilities)
    np.testing.assert_array_equal(run.labels, source >= 0.5)
    assert preview.record["adopted"] is False
    assert run.record["adopted"] is True
    assert run.record["source"]["channel_mapping"] == [
        {"model_channel": "input-0", "source_index": 0}
    ]
    assert run.record["output"]["probabilities_axes"] == "CYX"
    assert reference.dtype == np.float32


def test_unseen_bioimageio_05_onnx_package_is_adapted_without_source_changes(
    tmp_path: Path,
) -> None:
    root = _bioimage_package(tmp_path / "bioimage")

    package = packages.inspect_model_package(root)
    result = packages.run_reference_test(package)

    assert package.source_format == "bioimage.io-0.5"
    assert package.id == "unseen-conforming-model"
    assert package.input.axes == "BCYX"
    assert package.input.channels == (("raw", 0),)
    assert package.input.scale_yx == (0.5, 0.5)
    assert package.rights == {
        "license": "MIT",
        "redistribution": "per declared model license; independent review required",
        "commercial_use": "per declared model license; independent review required",
        "training_data": "synthetic/unseen",
    }
    assert package.validation["status"] == "unvalidated"
    assert result.comparison["mismatched_elements"] == 0


def test_channel_order_is_explicit_and_preserved(tmp_path: Path) -> None:
    root, _ = _native_package(
        tmp_path / "channels",
        shape=(1, 2, 8, 8),
        halo=(0, 0),
        output_channels=2,
        channel_sources=(1, 0),
    )
    source = np.stack(
        [np.full((9, 7), 0.3, dtype=np.float32), np.full((9, 7), 0.7, dtype=np.float32)]
    )

    result = packages.run_inference(
        root,
        source,
        source_axes="CYX",
        source_scale_yx=(0.5, 0.5),
        source_scale_unit="um",
    )

    np.testing.assert_array_equal(result.probabilities[0], source[1])
    np.testing.assert_array_equal(result.probabilities[1], source[0])
    assert result.record["source"]["channel_mapping"] == [
        {"model_channel": "input-0", "source_index": 1},
        {"model_channel": "input-1", "source_index": 0},
    ]


def test_import_requalifies_copy_and_atomically_adopts_it(tmp_path: Path) -> None:
    source, _ = _native_package(tmp_path / "source")
    managed = tmp_path / "managed"
    managed.mkdir()

    adopted, qualification = packages.import_model_package(source, managed)

    assert adopted.root == managed / "fixture-model-1.2.3"
    assert qualification.compatible is True
    assert adopted.package_sha256 == packages.inspect_model_package(source).package_sha256
    assert not any(path.name.startswith(".loci-model-import-") for path in managed.iterdir())
    with pytest.raises(FileExistsError):
        packages.import_model_package(source, managed)


def test_hash_reference_and_runtime_outputs_fail_closed(tmp_path: Path) -> None:
    root, _ = _native_package(tmp_path / "native")
    manifest_path = root / "loci-model.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["model"]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(packages.ModelPackageError, match="SHA-256 mismatch"):
        packages.inspect_model_package(root)

    other, _ = _native_package(tmp_path / "mismatch")
    expected = np.load(other / "reference-output.npy", allow_pickle=False)
    np.save(other / "reference-output.npy", expected + np.float32(0.1))
    manifest_path = other / "loci-model.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["reference"]["output"]["sha256"] = _sha(other / "reference-output.npy")
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(packages.ModelPackageError, match="reference test failed"):
        packages.run_reference_test(other)
    with pytest.raises(packages.ModelPackageError, match="reference test failed"):
        packages.run_inference(
            other,
            np.ones((8, 8), dtype=np.float32),
            source_axes="YX",
            source_scale_yx=(0.5, 0.5),
            source_scale_unit="um",
        )

    changed, _ = _native_package(tmp_path / "changed")
    inspected = packages.inspect_model_package(changed)
    manifest_path = changed / "loci-model.json"
    manifest_path.write_text(manifest_path.read_text() + "\n")
    with pytest.raises(packages.ModelPackageError, match="changed after inspection"):
        packages.run_reference_test(inspected)


def test_custom_operators_non_finite_inputs_and_scale_mismatch_are_rejected(
    tmp_path: Path,
) -> None:
    root, _ = _native_package(tmp_path / "custom", custom_domain=True)
    package = packages.inspect_model_package(root)
    with pytest.raises(packages.ModelPackageError, match="custom operator"):
        packages.run_reference_test(package)

    valid, _ = _native_package(tmp_path / "valid")
    package = packages.inspect_model_package(valid)
    with pytest.raises(packages.ModelPackageError, match="NaN/Inf"):
        packages.run_inference(
            package,
            np.array([[np.nan]], dtype=np.float32),
            source_axes="YX",
            source_scale_yx=(0.5, 0.5),
            source_scale_unit="um",
        )
    with pytest.raises(packages.ModelPackageError, match="implicit resampling"):
        packages.run_inference(
            package,
            np.ones((8, 8), dtype=np.float32),
            source_axes="YX",
            source_scale_yx=(1.0, 1.0),
            source_scale_unit="um",
        )


def test_package_files_yaml_and_weight_formats_are_strict(tmp_path: Path) -> None:
    root, _ = _native_package(tmp_path / "native")
    (root / "loader.py").write_text("raise RuntimeError('must never execute')")
    with pytest.raises(packages.ModelPackageError, match="Unsupported package member"):
        packages.inspect_model_package(root)

    bio = _bioimage_package(tmp_path / "bio")
    rdf_path = bio / "rdf.yaml"
    rdf = yaml.safe_load(rdf_path.read_text())
    rdf["weights"]["pytorch_state_dict"] = {
        "source": "remote-state.pt",
        "sha256": "0" * 64,
    }
    rdf_path.write_text(yaml.safe_dump(rdf, sort_keys=False))
    with pytest.raises(packages.ModelPackageError, match="ONNX-only"):
        packages.inspect_model_package(bio)

    duplicate = tmp_path / "duplicate"
    duplicate.mkdir()
    (duplicate / "rdf.yaml").write_text(
        "format_version: 0.5.11\nformat_version: 0.5.10\ntype: model\n",
        encoding="utf-8",
    )
    with pytest.raises(packages.ModelPackageError, match="Duplicate YAML key"):
        packages.inspect_model_package(duplicate)

    aliases = tmp_path / "aliases"
    aliases.mkdir()
    (aliases / "rdf.yaml").write_text("shared: &value [1, 2]\ncopy: *value\n", encoding="utf-8")
    with pytest.raises(packages.ModelPackageError, match="aliases"):
        packages.inspect_model_package(aliases)


def test_onnx_external_data_is_rejected_before_runtime(tmp_path: Path) -> None:
    root, reference = _native_package(tmp_path / "external")
    shape = (1, 1, 8, 8)
    input_value = helper.make_tensor_value_info("raw", TensorProto.FLOAT, shape)
    output_value = helper.make_tensor_value_info("probability", TensorProto.FLOAT, shape)
    weight = numpy_helper.from_array(np.full(shape, 0.1, dtype=np.float32), name="weight")
    graph = helper.make_graph(
        [helper.make_node("Add", ["raw", "weight"], ["probability"])],
        "external-data-model",
        [input_value],
        [output_value],
        [weight],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
    onnx.save_model(
        model,
        root / "model.onnx",
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location="model-sidecar.onnx",
        size_threshold=0,
    )
    np.save(root / "reference-output.npy", reference + np.float32(0.1))
    manifest_path = root / "loci-model.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["model"]["sha256"] = _sha(root / "model.onnx")
    manifest["reference"]["output"]["sha256"] = _sha(root / "reference-output.npy")
    manifest_path.write_text(json.dumps(manifest))

    package = packages.inspect_model_package(root)
    with pytest.raises(packages.ModelPackageError, match="external data"):
        packages.run_reference_test(package)


def test_reference_npy_never_loads_pickled_objects(tmp_path: Path) -> None:
    root, _ = _native_package(tmp_path / "native")
    np.save(root / "reference-input.npy", np.array([{"unsafe": True}], dtype=object))
    manifest_path = root / "loci-model.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["reference"]["input"]["sha256"] = _sha(root / "reference-input.npy")
    manifest_path.write_text(json.dumps(manifest))

    package = packages.inspect_model_package(root)
    with pytest.raises(packages.ModelPackageError, match="Invalid NumPy reference"):
        packages.run_reference_test(package)


def test_reference_shape_bomb_is_rejected_before_numpy_allocation(tmp_path, monkeypatch):
    root, _ = _native_package(tmp_path / "bomb")
    with (root / "reference-input.npy").open("wb") as stream:
        np.lib.format.write_array_header_1_0(
            stream,
            {
                "descr": "<f4",
                "fortran_order": False,
                "shape": (1, 1, 2**30, 2**30),
            },
        )
    manifest_path = root / "loci-model.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["reference"]["input"]["sha256"] = _sha(root / "reference-input.npy")
    manifest_path.write_text(json.dumps(manifest))
    package = packages.inspect_model_package(root)

    def forbidden_allocation(*_args, **_kwargs):
        raise AssertionError("NumPy must not allocate from an unchecked header")

    monkeypatch.setattr(np, "load", forbidden_allocation)
    with pytest.raises(packages.ModelPackageError, match="Invalid NumPy reference"):
        packages.run_reference_test(package)


def test_resize_allocations_cannot_depend_on_image_values_or_declared_output_shape():
    image = helper.make_tensor_value_info("image", TensorProto.FLOAT, [1, 1, 8, 8])
    # This separate malicious control input is small; the danger is using its
    # values as an allocation size despite the bounded output annotation.
    sizes = helper.make_tensor_value_info("sizes", TensorProto.INT64, [4])
    output = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 1, 8, 8])
    resize = helper.make_node("Resize", ["image", "", "", "sizes"], ["output"])
    model = helper.make_model(helper.make_graph([resize], "unproven", [image, sizes], [output]))
    with pytest.raises(packages.ModelPackageError, match="Image-dependent"):
        packages._bounded_graph_shapes(model, onnx, 1024**3)
