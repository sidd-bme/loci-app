from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "vanda_real_data_smoke.pbs"
TRAIN_SCRIPT = Path(__file__).parents[1] / "scripts" / "vanda_train.pbs"


def test_real_data_smoke_is_fixed_fail_closed_and_keeps_test_locked() -> None:
    script = SCRIPT.read_text(encoding="utf-8")

    assert "#PBS -q auto_free" in script
    for variable in (
        "LOCI_MODEL_MANIFEST",
        "LOCI_RAW_ROOT",
        "LOCI_MASK_ROOT",
        "LOCI_MODEL_OUTPUT",
        "LOCI_PROFILE_ID",
        "LOCI_PROFILE_VERSION",
        "LOCI_PROFILE_DISPLAY_NAME",
        "LOCI_CODE_REVISION",
    ):
        assert f"${{{variable}:?" in script
    assert '[[ -e "${LOCI_MODEL_OUTPUT}" || -L "${LOCI_MODEL_OUTPUT}" ]]' in script
    assert 'mkdir -- "${LOCI_MODEL_OUTPUT}"' in script
    assert '"${LOCI_EVALUATE_TEST+x}"' in script
    assert "--evaluate-test" not in script
    assert "--skip-onnx-export" not in script
    assert "--no-onnx-runtime-check" not in script
    assert "--epochs 1" in script
    assert "--steps-per-epoch 2" in script
    assert "--validation-steps 1" in script
    assert "--batch-size 1" in script
    assert "--patch-size 128" in script


def test_real_data_smoke_uses_reviewed_vanda_runtime_preflight() -> None:
    script = SCRIPT.read_text(encoding="utf-8")

    assert "unset PYTHONHOME PYTHONPATH" in script
    assert 'module load "${LOCI_PYTORCH_MODULE}"' in script
    assert 'source "${LOCI_MODEL_ENV}/bin/activate"' in script
    assert 'export PYTHONPATH="${model_site}${PYTHONPATH:+:${PYTHONPATH}}"' in script
    assert "export PYTHONNOUSERSITE=1" in script
    assert 'actual != "2.1.2"' in script
    assert 'platform.python_version() != "3.11.3"' in script
    assert 'torch.version.cuda != "12.1"' in script
    assert "torch.backends.cudnn.version() != 8902" in script
    assert 'environment_site / "torch"' in script
    assert "torch.cuda.is_available()" in script
    assert '"onnxruntime": (onnxruntime.__version__, "1.29.0")' in script
    assert "export_onnx(" in script
    assert "verify_runtime=True" in script
    assert "ensure_output_isolated" in script


def test_full_vanda_launcher_requires_release_identity() -> None:
    script = TRAIN_SCRIPT.read_text(encoding="utf-8")

    for variable in (
        "LOCI_PROFILE_VERSION",
        "LOCI_CODE_REVISION",
    ):
        assert f"${{{variable}:?" in script
    assert '--profile-version "${LOCI_PROFILE_VERSION}"' in script
    assert '--code-revision "${LOCI_CODE_REVISION}"' in script
