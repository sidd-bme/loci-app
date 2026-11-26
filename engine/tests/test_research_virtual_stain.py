from __future__ import annotations

import copy
import errno
import hashlib
import json
import os
from pathlib import PureWindowsPath

import numpy as np
import pytest
import tifffile

from loci_engine import research_virtual_stain as stain
from loci_engine.native_image import NativeSourceChangedError
from loci_engine.research_interchange import (
    export_project,
    import_project,
    relink_interchanged_source,
)
from loci_engine.research_project import ResearchProject, canonical_json
from loci_engine.research_rpc import dispatch_research
from loci_engine.research_session import clone_study
from loci_engine.research_vendor import validate_derivation
from loci_engine.virtual_stain_bundle import publication, validate_windows_path
from loci_engine.workbench import Workbench


def _metadata(axes, names):
    return {
        "axes": axes,
        "PhysicalSizeZ": 0.29,
        "PhysicalSizeY": 0.108,
        "PhysicalSizeX": 0.108,
        "Channel": {"Name": names},
    }


@pytest.fixture(scope="module")
def source_file(tmp_path_factory):
    root = tmp_path_factory.mktemp("phase").resolve()
    path = root / "timelapse.ome.tif"
    shape = (2, 15, 2, 512, 512)
    # T and C both vary, with Z before C. Target is deliberately non-finite.
    data = np.empty(shape, dtype=np.float32)
    data[:, :, 0] = np.nan
    ramp = np.arange(512 * 512, dtype=np.float32).reshape(512, 512)
    for t in range(shape[0]):
        for z in range(shape[1]):
            data[t, z, 1] = (ramp + 123 * z) * (t + 1)
    tifffile.imwrite(
        path,
        data,
        ome=True,
        photometric="minisblack",
        metadata=_metadata("TZCYX", ["Nuclei", "Phase3D"]),
    )
    return path


@pytest.fixture
def setup(tmp_path, source_file, monkeypatch):
    root = tmp_path.resolve()
    wb = Workbench(ResearchProject.create(root / "test.loci-study", "virtual stain"))
    source = wb.import_native(str(source_file))
    weights = root / "test-checkpoint"
    weights.write_bytes(b"stub")
    monkeypatch.setattr(stain, "WEIGHTS_BYTES", 4)
    req = dict(
        source_id=source["id"],
        source_sha256=source["sha256"],
        channel=1,
        timepoint=1,
        phase_confirmed=True,
    )
    yield wb, req, root / "derived", weights
    wb.close()


def test_rpc_publication_native_readback_and_offline_identity(setup, source_file, monkeypatch):
    wb, req, target, weights = setup
    native = tifffile.memmap(source_file, mode="r")[1, :, 1]

    def predict(phase, path, mean, std):
        assert path == weights
        np.testing.assert_array_equal(phase, native)
        assert mean == float(np.float32(native.copy().mean(dtype=np.float64)))
        assert std == float(np.float32(native.copy().std(dtype=np.float64)))
        return phase / np.float32(16), "2.13.0"

    monkeypatch.setattr(stain, "_predict", predict)
    reply = dispatch_research(
        "research_virtual_stain",
        dict(
            project=str(wb.project.root),
            request=req,
            destination=str(target),
            checkpoint=str(weights),
        ),
    )
    src = reply["source"]
    assert json.loads(canonical_json(src)) in reply["snapshot"]["sources"]
    assert str(target.parent) not in canonical_json(src)
    assert src["metadata"]["channel_names"] == stain.CHANNELS
    disk = tifffile.imread(target / stain.IMAGE)
    np.testing.assert_array_equal(disk[1], native)
    np.testing.assert_array_equal(disk[0], native / 16)
    deriv = src["derivation"]
    assert json.loads((target / stain.SIDECAR).read_bytes()) == deriv["record"]
    assert deriv["record"]["phase_pixels_sha256"] == hashlib.sha256(native.tobytes()).hexdigest()
    assert disk[1].tobytes() == native.tobytes()
    assert (
        hashlib.sha256(disk[0].tobytes()).hexdigest() == deriv["record"]["prediction_pixels_sha256"]
    )
    assert deriv["record"]["population_voxels"] == native.size
    assert deriv["record"]["mean"] == native.copy().mean(dtype=np.float64)
    assert deriv["record"]["std"] == native.copy().std(dtype=np.float64)
    for field, invalid in (("channel", 0), ("timepoint", 2), ("source_sha256", "0" * 64)):
        with pytest.raises(ValueError, match="parent"):
            stain.validate_origin(
                {**deriv["record"], field: invalid}, wb.project.source(req["source_id"])
            )
    weights.unlink()
    for restored in (
        ResearchProject(wb.project.root),
        clone_study(wb.project, target.parent / "copy.loci-study"),
    ):
        assert restored.source(src["id"], verify=True)["derivation"] == deriv
    archive = target.parent / "study.zip"
    export_project(wb.project, archive)
    portable = import_project(archive, target.parent / "restored.loci-study")
    assert (
        relink_interchanged_source(portable, src["id"], target / stain.IMAGE)["derivation"] == deriv
    )

    for key, value in (
        ("source_sha256", "x" * 64),
        ("population_voxels", 1),
        ("mean", True),
        ("artifact_sha256", "0" * 64),
        ("level", 1),
        ("source_id", "/private/file"),
    ):
        changed = copy.deepcopy(deriv)
        changed["record"][key] = value
        changed["provenance_sha256"] = hashlib.sha256(stain._bytes(changed["record"])).hexdigest()
        with pytest.raises(ValueError):
            validate_derivation(changed, src["sha256"], src["metadata"])
    for key, value in (
        ("channel_names", ["Nuclei", "Measured"]),
        ("source_axes", "ZCYX"),
        ("dimensions", {"t": 1, "c": 1}),
        ("physical_calibration", None),
    ):
        with pytest.raises(ValueError, match="metadata"):
            validate_derivation(deriv, src["sha256"], {**src["metadata"], key: value})

    # Rehashing a forged receipt cannot change the record embedded in the TIFF.
    changed = copy.deepcopy(deriv)
    changed["record"]["mean"] += 1
    changed["record"]["kernel_mean_float32"] = float(np.float32(changed["record"]["mean"]))
    changed["provenance_sha256"] = hashlib.sha256(stain._bytes(changed["record"])).hexdigest()
    with pytest.raises(ValueError, match="embedded"):
        wb.project.register_source(
            target / stain.IMAGE, src["sha256"], src["metadata"], derivation=changed
        )


@pytest.mark.parametrize(
    "fields",
    [
        {"channel": 0},
        {"channel": True},
        {"timepoint": 2},
        {"timepoint": False},
        {"phase_confirmed": 1},
        {"source_sha256": "0" * 64},
        {"level": 1},
        {"checkpoint": "/forbidden"},
        {"source_id": "0" * 32},
    ],
)
def test_refuses_invalid_binding_before_inference(setup, fields):
    wb, req, target, weights = setup
    with pytest.raises(ValueError):
        stain.run(wb, {**req, **fields}, target, weights)
    assert not target.exists()


@pytest.mark.parametrize(
    "failure",
    [
        "existing",
        "link",
        "parent-link",
        "cancel",
        "changed",
        "shape",
        "dtype",
        "nonfinite",
        "registration",
        "sidecar",
    ],
)
def test_publication_refusal_and_cleanup(setup, failure, monkeypatch, tmp_path):
    wb, req, target, weights = setup

    # An earlier source-read failure must not satisfy a later fault injection.
    reached_fault = False

    def predict(phase, *_):
        nonlocal reached_fault
        reached_fault = failure in {"shape", "dtype", "nonfinite"}
        if failure == "shape":
            return phase[0], "2.13.0"
        if failure == "dtype":
            return phase.astype(np.int32), "2.13.0"
        if failure == "nonfinite":
            return np.full_like(phase, np.nan), "2.13.0"
        return phase.copy(), "2.13.0"

    monkeypatch.setattr(stain, "_predict", predict)
    if failure == "existing":
        target.mkdir()
        (target / "keep").write_text("original")
    elif failure == "link":
        target.symlink_to(tmp_path / "elsewhere")
    elif failure == "parent-link":
        link = tmp_path / "link"
        link.symlink_to(tmp_path.resolve(), target_is_directory=True)
        target = link / "derived"
    elif failure in {"cancel", "changed"}:

        def interrupt(*_):
            nonlocal reached_fault
            reached_fault = True
            raise (
                KeyboardInterrupt() if failure == "cancel" else NativeSourceChangedError("changed")
            )

        monkeypatch.setattr(stain.NativeImageSession, "verify_strict", interrupt)
    elif failure == "sidecar":
        register = wb.project.register_source

        def tamper(*args, **kwargs):
            guard = kwargs["publication_guard"]

            def change_before_commit():
                nonlocal reached_fault
                reached_fault = True
                (target / stain.SIDECAR).write_text("changed")
                guard()

            return register(*args, **{**kwargs, "publication_guard": change_before_commit})

        monkeypatch.setattr(wb.project, "register_source", tamper)
    elif failure == "registration":

        def reject(*_, **__):
            nonlocal reached_fault
            reached_fault = True
            raise ValueError("register failed")

        monkeypatch.setattr(wb.project, "register_source", reject)
    with pytest.raises((ValueError, OSError, KeyboardInterrupt, NativeSourceChangedError)):
        stain.run(wb, req, target, weights)
    if failure not in {"existing", "link", "parent-link"}:
        assert reached_fault
    if failure == "existing":
        assert (target / "keep").read_text() == "original"
    elif failure == "link":
        assert target.is_symlink()
    else:
        assert not target.exists()
    assert not list(tmp_path.glob(".loci-virtual-stain-*"))
    assert len(wb.project.list_sources()) == 1


@pytest.mark.parametrize(
    ("shape", "dtype", "option"),
    [
        ((14, 512, 512), "float32", None),
        ((41, 12, 12), "float32", None),
        ((15, 511, 512), "float32", None),
        ((15, 512, 512), "uint16", None),
        ((15, 512, 512), "float32", "spacing"),
        ((15, 512, 512), "float32", "translated"),
        ((15, 512, 512), "float32", "uncalibrated"),
        ((15, 512, 512), "float32", "constant"),
        ((15, 512, 512), "float32", "nan"),
        ((15, 48, 48, 3), "uint8", "rgb"),
    ],
)
def test_native_profile_refusals(setup, tmp_path, shape, dtype, option, monkeypatch):
    wb, req, target, weights = setup
    data = np.zeros(shape, dtype=dtype)
    meta = _metadata("ZYXS" if option == "rgb" else "ZYX", ["Phase3D"])
    if option == "spacing":
        meta["PhysicalSizeZ"] = 0.3
    elif option == "translated":
        meta["Plane"] = {"PositionX": [1.0] * shape[0], "PositionXUnit": ["µm"] * shape[0]}
    elif option == "uncalibrated":
        del meta["PhysicalSizeZ"]
    elif option == "nan":
        data[0, 0, 0] = np.nan
    image = tmp_path.resolve() / "wrong.ome.tif"
    tifffile.imwrite(
        image, data, ome=True, metadata=meta, photometric="rgb" if option == "rgb" else "minisblack"
    )
    src = wb.import_native(str(image))
    req.update(source_id=src["id"], source_sha256=src["sha256"], channel=0, timepoint=0)
    monkeypatch.setattr(stain, "_predict", lambda *_: pytest.fail("kernel invoked"))
    with pytest.raises(ValueError):
        stain.run(wb, req, target, weights)


def test_modified_registered_bytes_are_rejected(setup, tmp_path, source_file):
    wb, req, target, weights = setup
    copied = tmp_path.resolve() / "edited.ome.tif"
    import shutil

    shutil.copyfile(source_file, copied)
    src = wb.import_native(str(copied))
    req.update(source_id=src["id"], source_sha256=src["sha256"])
    with copied.open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises((ValueError, NativeSourceChangedError)):
        stain.run(wb, req, target, weights)


@pytest.mark.parametrize(
    "name",
    [
        r"\\server\share\out",
        r"\\?\C:\out",
        r"\\.\C:\out",
        r"C:relative",
        r"C:\parent\..\out",
        r"C:\data:stream\out",
        r"C:\CON.txt\out",
        "C:\\space \\out",
        "C:\\trailing.\\out",
    ],
)
def test_windows_namespace_rejected_before_io(name):
    with pytest.raises(ValueError, match="drive-letter"):
        validate_windows_path(PureWindowsPath(name))


def test_windows_unicode_drive_path():
    validate_windows_path(PureWindowsPath(r"C:\Study Results\μm nuclei"))


@pytest.mark.parametrize("populated", [False, True], ids=["empty", "populated"])
def test_bundle_publish_refuses_intervening_directory(tmp_path, populated):
    root = tmp_path.resolve()
    project = ResearchProject.create(root / "test.loci-study", "virtual stain")
    target = root / "derived"
    with publication(project, target, ()) as bundle:
        bundle.start()
        with bundle.file(stain.IMAGE) as stream:
            stream.write(b"staged")
        # The picker destination was absent when the parent was pinned.
        # Introduce the competing directory immediately before the real rename.
        target.mkdir()
        original = target.stat()
        if populated:
            (target / "keep").write_bytes(b"independent")
        with pytest.raises(OSError) as refused:
            bundle.publish()
        assert refused.value.errno in {errno.EEXIST, errno.ENOTEMPTY}
    assert os.path.samestat(original, target.stat())
    assert {item.name for item in target.iterdir()} == ({"keep"} if populated else set())
    if populated:
        assert (target / "keep").read_bytes() == b"independent"
    assert not list(root.glob(".loci-virtual-stain-*"))


def test_rollback_preserves_unowned_artifacts(setup):
    wb, _, target, _ = setup
    with publication(wb.project, target, ()) as bundle:
        bundle.start()
        with bundle.file(stain.IMAGE) as stream:
            stream.write(b"owned")
        with bundle.file(stain.SIDECAR) as stream:
            stream.write(b"owned")
        stage = next(target.parent.glob(".loci-virtual-stain-*"))
        if os.name == "nt":
            with pytest.raises(PermissionError) as denied:
                (stage / stain.SIDECAR).rename(stage / "moved")
            assert denied.value.winerror == 32  # ERROR_SHARING_VIOLATION
            assert (stage / stain.SIDECAR).read_bytes() == b"owned"
            independent = stage / "keep"
        else:
            (stage / stain.SIDECAR).rename(stage / "moved")
            independent = stage / stain.SIDECAR
        independent.write_bytes(b"independent")
        with pytest.raises(ValueError):
            bundle.verify({})
    assert not target.exists()
    assert not (stage / stain.IMAGE).exists()
    assert independent.read_bytes() == b"independent"
    if os.name == "nt":
        assert list(stage.iterdir()) == [independent]
    else:
        assert (stage / "moved").read_bytes() == b"owned"


@pytest.mark.skipif(os.name != "nt", reason="Windows native junction and sharing semantics")
def test_windows_native_parent_input_and_publication_handles(setup):
    import _winapi

    wb, _, target, weights = setup
    parent = target.parent / "dest"
    parent.mkdir()
    target = parent / "derived"
    link = parent.with_name("junction")
    _winapi.CreateJunction(str(parent), str(link))
    with pytest.raises((ValueError, OSError)), publication(wb.project, link / target.name, ()):
        pytest.fail("accepted a junction")

    with publication(wb.project, target, (weights,)) as bundle:
        with pytest.raises(PermissionError):
            parent.rename(parent.with_name("other"))
        with pytest.raises(PermissionError):
            weights.open("r+b").close()
        bundle.start()
        with bundle.file(stain.IMAGE) as stream:
            stream.write(b"owned")
        bundle.publish()
        with pytest.raises(PermissionError):
            (target / stain.IMAGE).unlink()
        with pytest.raises(PermissionError):
            target.rename(parent / "elsewhere")
    assert not target.exists()
    assert not list(parent.iterdir())


@pytest.mark.skipif(os.name != "nt", reason="Windows native volume queries")
@pytest.mark.parametrize("unsupported", ["remote", "non-NTFS"])
def test_windows_volume_refusal_before_staging(setup, monkeypatch, unsupported):
    from loci_engine import virtual_stain_windows as windows

    wb, _, target, _ = setup
    if unsupported == "remote":
        monkeypatch.setattr(windows, "_drive_type", lambda _: 4)  # DRIVE_REMOTE
    else:

        def other_filesystem(_handle, _label, _size, _serial, _maximum, _flags, filesystem, _count):
            filesystem.value = "exFAT"
            return True

        monkeypatch.setattr(windows, "_volume", other_filesystem)
    with pytest.raises(ValueError, match="local NTFS"), publication(wb.project, target, ()):
        pytest.fail("accepted an unsupported volume")
    assert not list(target.parent.glob(".loci-virtual-stain-*"))
