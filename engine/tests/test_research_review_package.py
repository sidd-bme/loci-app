import csv
import errno
import hashlib
import json

import numpy as np
import pytest
import tifffile
from PIL import Image
from skimage.segmentation import find_boundaries

import loci_engine.research_review_package as package
from loci_engine.quantitative import measure_objects
from loci_engine.research_export import export_research_result
from loci_engine.research_project import ResearchProject
from loci_engine.research_rpc import dispatch_research
from loci_engine.workbench import Workbench


@pytest.fixture
def sample(tmp_path):
    workbench = Workbench(ResearchProject.create(tmp_path / "study.loci-study", "Review"))
    bindings, originals = [], []
    for group in ("FBS", "SFM"):
        source_path = tmp_path / group / "Preview_12.tif"
        source_path.parent.mkdir()
        pixels = np.random.default_rng(len(bindings)).integers(0, 256, (40, 64, 3), dtype=np.uint8)
        tifffile.imwrite(source_path, pixels, photometric="rgb")
        source = workbench.import_native(str(source_path), relative_path=f"{group}/Preview_12.tif")
        selection = {"x": 0, "y": 0, "width": 64, "height": 40, "t": 0, "c": 0, "z": 0, "level": 0}
        _, geometry, _ = workbench.load_scalar(source["id"], selection, allow_rgb=True)
        labels = np.zeros((40, 64), dtype=np.uint32)
        labels[5:14, 7:18] = 1
        labels[23:31, 37:49] = 3  # Corrected labels need not remain consecutive.
        result = workbench.project.save_result(
            source_id=source["id"],
            kind="segmentation",
            arrays={"image": pixels.mean(axis=-1) / 255, "labels": labels},
            provenance={
                "selection": selection,
                "geometry": geometry.to_dict(),
                "segmentation": {"method": "synthetic", "count": 2},
                "measurements": measure_objects(labels, geometry),
                "runtime": {"engine": "synthetic-test"},
                "profile": {"id": "synthetic-profile", "version": "1.0.0"},
                "model": {"rights": {"commercial_use": "unknown"}},
            },
        )
        bindings.append(
            {
                "source_id": source["id"],
                "source_sha256": source["sha256"],
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
            }
        )
        originals.append((source_path, pixels, labels))
    yield workbench, {"bindings": bindings, "root_label": "Synthetic RGB collection"}, originals
    workbench.close()


def test_pending_package_exact_counts_original_rgb_paths_hashes_and_review_state(sample, tmp_path):
    workbench, request, originals = sample
    target = tmp_path / request["root_label"]
    before = [workbench.project.review_history(b["result_id"]) for b in request["bindings"]]
    receipt = dispatch_research(
        "research_review_package_export",
        {
            "project": str(workbench.project.root),
            "request": request,
            "destination": str(target),
        },
    )
    assert receipt["image_count"] == 2
    manifest_bytes = (target / "manifest.json").read_bytes()
    assert hashlib.sha256(manifest_bytes).hexdigest() == receipt["manifest_sha256"]
    manifest = json.loads(manifest_bytes)
    assert manifest["status"] == "provisional-review-material"
    assert str(tmp_path) not in manifest_bytes.decode()
    with (target / "counts.csv").open(newline="") as stream:
        rows = list(csv.DictReader(stream))
    assert rows == [
        {
            "image_name": f"/Synthetic RGB collection/{group}/Preview_12.tif",
            "cell_count": "2",
            "review_status": "pending",
        }
        for group in ("FBS", "SFM")
    ]
    for item, (_, pixels, labels), binding in zip(
        manifest["images"], originals, request["bindings"], strict=True
    ):
        output = target / item["outline"]["path"]
        assert hashlib.sha256(output.read_bytes()).hexdigest() == item["outline"]["sha256"]
        boundary = find_boundaries(labels, mode="outer")
        with Image.open(output) as image:
            actual = np.asarray(image)
            assert image.size == (64, 40)
            np.testing.assert_array_equal(actual[~boundary], pixels[~boundary])
            assert np.all(actual[boundary] == package.OUTLINE_RGB)
            context = json.loads(image.info["Loci review provenance"])
            assert context["review_status"] == "pending"
            assert context["revision_hash"] == binding["revision_hash"]
            assert context["profile"]["id"] == "synthetic-profile"
            assert context["model"]["rights"]["commercial_use"] == "unknown"
        assert item["profile"]["id"] == "synthetic-profile"
        assert item["model"]["rights"]["commercial_use"] == "unknown"
    assert before == [workbench.project.review_history(b["result_id"]) for b in request["bindings"]]
    # A provisional package must not unlock the existing reviewed-export route.
    with pytest.raises(ValueError, match="Review this exact"):
        export_research_result(
            workbench.project,
            request["bindings"][0]["result_id"],
            request["bindings"][0]["revision_hash"],
            tmp_path / "reviewed",
        )


@pytest.mark.parametrize("field", ["source_sha256", "revision_hash"])
def test_stale_identity_never_publishes(sample, tmp_path, field):
    workbench, request, _ = sample
    request["bindings"][0][field] = "0" * 64
    with pytest.raises(ValueError, match="stale"):
        package.export_review_package(workbench, request, tmp_path / request["root_label"])
    assert not (tmp_path / request["root_label"]).exists()


def test_zero_object_result_exports_zero_without_creating_review(sample, tmp_path):
    workbench, request, _ = sample
    binding = request["bindings"][0]
    previous = workbench.project.result(binding["result_id"])
    provenance = previous["provenance"]
    provenance["measurements"] = []
    result = workbench.project.save_result(
        source_id=binding["source_id"],
        kind="segmentation",
        arrays={"image": np.zeros((40, 64)), "labels": np.zeros((40, 64), dtype=np.uint32)},
        provenance=provenance,
    )
    binding.update(result_id=result["id"], revision_hash=result["revision_hash"])
    request["bindings"] = [binding]
    target = tmp_path / request["root_label"]
    package.export_review_package(workbench, request, target)
    with (target / "counts.csv").open(newline="") as stream:
        assert list(csv.DictReader(stream))[0]["cell_count"] == "0"
    assert workbench.project.review_state(result["id"]) is None


@pytest.mark.parametrize("invalid", ["crop", "measurements"])
def test_mismatched_scope_or_measurements_fail_closed(sample, tmp_path, invalid):
    workbench, request, _ = sample
    binding = request["bindings"][0]
    previous = workbench.project.result(binding["result_id"])
    provenance = previous["provenance"]
    if invalid == "crop":
        provenance["selection"]["x"] = 1
    else:
        provenance["measurements"] = []
    result = workbench.project.save_result(
        source_id=binding["source_id"],
        kind="segmentation",
        arrays={
            key: workbench.project.load_array(value) for key, value in previous["arrays"].items()
        },
        provenance=provenance,
    )
    binding.update(result_id=result["id"], revision_hash=result["revision_hash"])
    with pytest.raises(ValueError, match="whole native|count disagrees"):
        package.export_review_package(workbench, request, tmp_path / request["root_label"])
    assert not (tmp_path / request["root_label"]).exists()
    assert not list(tmp_path.glob(".loci-review-*"))


@pytest.mark.parametrize(
    "label", ["../outside", "a/b", "a\\b", ".hidden", "CON", " space", "trailing."]
)
def test_unsafe_root_labels_rejected(sample, tmp_path, label):
    workbench, request, _ = sample
    request["root_label"] = label
    with pytest.raises(ValueError, match="portable"):
        package.export_review_package(workbench, request, tmp_path / "unused")


def test_existing_destination_and_linked_parent_rejected(sample, tmp_path):
    workbench, request, _ = sample
    target = tmp_path / request["root_label"]
    target.mkdir()
    (target / "keep").write_text("original")
    with pytest.raises(ValueError, match="absent"):
        package.export_review_package(workbench, request, target)
    assert (target / "keep").read_text() == "original"
    linked = tmp_path / "linked"
    linked.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match="canonical plain"):
        package.export_review_package(workbench, request, linked / request["root_label"])


def test_duplicate_and_casefold_collision_rejected(sample, tmp_path):
    workbench, request, _ = sample
    source = workbench.project.source(request["bindings"][1]["source_id"])
    source["private_relative_path"] = "fbs/preview_12.TIF"
    with workbench.project.connection() as connection:
        connection.execute(
            "UPDATE sources SET record=? WHERE id=?", (json.dumps(source), source["id"])
        )
    with pytest.raises(ValueError, match="conflicting or duplicate"):
        package.export_review_package(workbench, request, tmp_path / request["root_label"])
    request["bindings"][1] = request["bindings"][0].copy()
    with pytest.raises(ValueError, match="conflicting or duplicate"):
        package.export_review_package(workbench, request, tmp_path / request["root_label"])


@pytest.mark.parametrize("change", ["source", "review", "labels"])
def test_change_during_export_never_publishes(sample, tmp_path, monkeypatch, change):
    workbench, request, originals = sample
    original_write = package._write

    def changed_write(path, data):
        result = original_write(path, data)
        if path.name == "manifest.json":
            binding = request["bindings"][0]
            if change == "source":
                with originals[0][0].open("ab") as stream:
                    stream.write(b"changed")
            elif change == "review":
                workbench.project.review(binding["result_id"], binding["revision_hash"], "reviewed")
            else:
                result_record = workbench.project.result(binding["result_id"])
                artifact = workbench.project.arrays / (
                    result_record["arrays"]["labels"]["sha256"] + ".npy"
                )
                with artifact.open("ab") as stream:
                    stream.write(b"changed")
        return result

    monkeypatch.setattr(package, "_write", changed_write)
    with pytest.raises(ValueError):
        package.export_review_package(workbench, request, tmp_path / request["root_label"])
    assert not (tmp_path / request["root_label"]).exists()
    assert not list(tmp_path.glob(".loci-review-*"))


def test_staged_outline_symlink_never_publishes(sample, tmp_path, monkeypatch):
    workbench, request, _ = sample
    original_write = package._write
    outside = tmp_path / "untouched.png"
    outside.write_bytes(b"preserve")

    def linked_write(path, data):
        result = original_write(path, data)
        if path.name == "manifest.json":
            outline = next(path.parent.rglob("*.outlines.png"))
            outline.unlink()
            outline.symlink_to(outside)
        return result

    monkeypatch.setattr(package, "_write", linked_write)
    with pytest.raises(ValueError):
        package.export_review_package(workbench, request, tmp_path / request["root_label"])
    assert outside.read_bytes() == b"preserve"
    assert not (tmp_path / request["root_label"]).exists()
    assert not list(tmp_path.glob(".loci-review-*"))


def test_destination_created_during_publication_is_preserved(sample, tmp_path, monkeypatch):
    workbench, request, _ = sample
    original_rename = package._rename_noreplace

    def raced_rename(stage, destination):
        destination.mkdir()
        (destination / "keep").write_text("external")
        original_rename(stage, destination)

    monkeypatch.setattr(package, "_rename_noreplace", raced_rename)
    target = tmp_path / request["root_label"]
    with pytest.raises(OSError):
        package.export_review_package(workbench, request, target)
    assert (target / "keep").read_text() == "external"
    assert not list(tmp_path.glob(".loci-review-*"))


def test_unsupported_atomic_filesystem_has_actionable_error_and_cleans_stage(
    sample, tmp_path, monkeypatch
):
    workbench, request, _ = sample

    def unsupported(*args, **kwargs):
        raise OSError(errno.ENOTSUP, "Operation not supported")

    monkeypatch.setattr(package, "_rename_noreplace", unsupported)
    with pytest.raises(ValueError, match="APFS.*atomic no-replace") as raised:
        package.export_review_package(workbench, request, tmp_path / request["root_label"])
    assert raised.value.__cause__.errno == errno.ENOTSUP
    assert not (tmp_path / request["root_label"]).exists()
    assert not list(tmp_path.glob(".loci-review-*"))


def test_cleanup_failure_never_masks_publication_failure(sample, tmp_path, monkeypatch):
    workbench, request, _ = sample

    def unsupported(*args, **kwargs):
        raise OSError(errno.ENOTSUP, "Operation not supported")

    def cleanup_failure(*args, **kwargs):
        raise PermissionError("synthetic cleanup refusal")

    monkeypatch.setattr(package, "_rename_noreplace", unsupported)
    monkeypatch.setattr(package.shutil, "rmtree", cleanup_failure)
    with pytest.raises(ValueError, match="atomic review package") as raised:
        package.export_review_package(workbench, request, tmp_path / request["root_label"])
    assert "synthetic cleanup refusal" in raised.value.__notes__[0]
    assert not (tmp_path / request["root_label"]).exists()


def test_midway_png_failure_removes_only_owned_stage(sample, tmp_path, monkeypatch):
    workbench, request, _ = sample
    original_save = Image.Image.save
    calls = 0

    def failed_save(self, *args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("synthetic disk failure")
        return original_save(self, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "save", failed_save)
    with pytest.raises(OSError, match="disk failure"):
        package.export_review_package(workbench, request, tmp_path / request["root_label"])
    assert not (tmp_path / request["root_label"]).exists()
    assert not list(tmp_path.glob(".loci-review-*"))
