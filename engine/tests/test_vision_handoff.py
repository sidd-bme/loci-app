from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import os

import pytest
from PIL import Image

from loci_engine.vision_handoff import write_vision_handoff

pytestmark = pytest.mark.skipif(
    os.open not in os.supports_dir_fd, reason="Native directory publisher"
)


@pytest.fixture
def payload():
    output = io.BytesIO()
    Image.new("RGB", (32, 24), (12, 35, 89)).save(output, format="PNG")
    frame = {
        "image": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode(),
        "source_id": "a" * 32,
        "source_sha256": "b" * 64,
        "rendering": {"output_size": [32, 24], "display_only": True},
    }
    context = {
        "schema": "loci.vision-context/v1",
        "status": "provisional-visualization",
        "scientific_validation": "not established",
        "source_id": frame["source_id"],
        "source_sha256": frame["source_sha256"],
        "rendering": copy.deepcopy(frame["rendering"]),
    }
    return frame, context


def test_bundle_is_provisional_hash_bound_and_non_overwriting(tmp_path, payload):
    frame, context = payload
    target = tmp_path / "experiment.loci-vision"
    receipt = write_vision_handoff(target, frame=frame, context=context)
    assert set(p.name for p in target.iterdir()) == {
        "image.png",
        "context.json",
        "README.md",
        "manifest.json",
    }
    manifest = json.loads((target / "manifest.json").read_text())
    assert manifest["status"] == receipt["status"] == "provisional-visualization"
    assert json.loads((target / "context.json").read_text()) == context
    for name, meta in receipt["artifacts"].items():
        data = (target / name).read_bytes()
        assert len(data) == meta["size_bytes"]
        assert hashlib.sha256(data).hexdigest() == meta["sha256"]
        if name != "manifest.json":
            assert meta == manifest["artifacts"][name]
    with pytest.raises(FileExistsError):
        write_vision_handoff(target, frame=frame, context=context)
    assert not list(tmp_path.glob(".loci-vision-*"))


@pytest.mark.parametrize(
    "change",
    [
        {"source_id": "c" * 32},
        {"source_sha256": "c" * 64},
        {"status": "reviewed"},
        {"rendering": {"display_only": False}},
        {"source_path": "/private/source.tif"},
        {"scientific_validation": "validated"},
    ],
)
def test_mismatched_or_false_context_never_publishes(tmp_path, payload, change):
    frame, context = payload
    with pytest.raises(ValueError):
        write_vision_handoff(
            tmp_path / "bad.loci-vision", frame=frame, context={**context, **change}
        )
    assert not list(tmp_path.iterdir())


def test_invalid_or_oversized_png_is_rejected_before_staging(tmp_path, payload):
    frame, context = payload
    for encoded in ("data:image/png;base64,notbase64!", "data:image/svg+xml;base64,YQ=="):
        with pytest.raises(ValueError):
            write_vision_handoff(
                tmp_path / "bad.loci-vision", frame={**frame, "image": encoded}, context=context
            )
    output = io.BytesIO()
    Image.new("L", (2049, 2)).save(output, format="PNG")
    frame["image"] = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
    with pytest.raises(ValueError, match="dimensions"):
        write_vision_handoff(tmp_path / "bad.loci-vision", frame=frame, context=context)
    assert not list(tmp_path.iterdir())


def test_revocation_after_staging_removes_private_files(tmp_path, payload):
    frame, context = payload
    calls = 0

    def guard():
        nonlocal calls
        calls += 1
        if calls == 2:
            raise PermissionError("Revoked")

    with pytest.raises(PermissionError, match="Revoked"):
        write_vision_handoff(
            tmp_path / "denied.loci-vision", frame=frame, context=context, guard=guard
        )
    assert calls == 2
    assert not list(tmp_path.iterdir())


def test_staged_image_tampering_is_rejected(tmp_path, payload):
    frame, context = payload

    def guard():
        for stage in tmp_path.glob(".loci-vision-*"):
            image = stage / "image.png"
            data = bytearray(image.read_bytes())
            data[-1] ^= 1
            image.write_bytes(data)

    with pytest.raises(ValueError, match="changed"):
        write_vision_handoff(
            tmp_path / "bad.loci-vision", frame=frame, context=context, guard=guard
        )
    assert not list(tmp_path.iterdir())


def test_symlink_parent_and_existing_destination_are_rejected(tmp_path, payload):
    frame, context = payload
    actual = tmp_path / "actual"
    actual.mkdir()
    link = tmp_path / "link"
    link.symlink_to(actual, target_is_directory=True)
    with pytest.raises(ValueError, match="canonical"):
        write_vision_handoff(link / "bad.loci-vision", frame=frame, context=context)
    target = tmp_path / "exists.loci-vision"
    target.symlink_to(actual, target_is_directory=True)
    with pytest.raises(FileExistsError):
        write_vision_handoff(target, frame=frame, context=context)
    assert not list(actual.iterdir())


def test_parent_swap_cannot_redirect_publication(tmp_path, payload):
    frame, context = payload
    parent = tmp_path / "chosen"
    parent.mkdir()
    archived = tmp_path / "original"
    other = tmp_path / "other"
    other.mkdir()

    def guard():
        if list(parent.glob(".loci-vision-*")):
            parent.rename(archived)
            parent.symlink_to(other, target_is_directory=True)

    with pytest.raises(ValueError, match="identity"):
        write_vision_handoff(parent / "bad.loci-vision", frame=frame, context=context, guard=guard)
    assert not list(other.iterdir())
    assert not list(archived.iterdir())


@pytest.mark.parametrize("reason", ["Policy revoked", "Source changed"])
def test_authority_change_during_artifact_verification_never_publishes(
    tmp_path, payload, monkeypatch, reason
):
    frame, context = payload
    original_read = os.read
    revoked = False

    def read(descriptor, count):
        nonlocal revoked
        data = original_read(descriptor, count)
        revoked = True
        return data

    def guard():
        if revoked:
            raise PermissionError(reason)

    monkeypatch.setattr(os, "read", read)
    with pytest.raises(PermissionError, match=reason):
        write_vision_handoff(
            tmp_path / "denied.loci-vision", frame=frame, context=context, guard=guard
        )
    assert revoked
    assert not list(tmp_path.iterdir())
