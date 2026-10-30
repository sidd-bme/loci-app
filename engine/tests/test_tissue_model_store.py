"""Exact local import/filesystem contracts using tiny code-pinned test bytes.

No real model import or inference, dependency provisioning, source grant or
scientific qualification is exercised by these fixtures.
"""

from __future__ import annotations

import builtins
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from loci_engine import tissue_model_store as store


def no_op():
    pass


class Cancelled(RuntimeError):
    pass


@pytest.fixture
def case(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    selected = root / "selected"
    selected.mkdir(mode=0o700)
    weights, receipt = selected / "selected.pth", selected / "receipt.json"
    # Receipt is intentionally opaque non-JSON: only exact bytes may be trusted.
    payload = bytes(range(256)) * 3
    receipt_bytes = b"Exact conversion receipt fixture; not permission or executable code."
    weights.write_bytes(payload)
    receipt.write_bytes(receipt_bytes)
    monkeypatch.setattr(store, "PUMA_WEIGHTS_BYTES", len(payload))
    monkeypatch.setattr(store, "PUMA_WEIGHTS_SHA256", hashlib.sha256(payload).hexdigest())
    monkeypatch.setattr(store, "CONVERSION_RECEIPT_BYTES", len(receipt_bytes))
    monkeypatch.setattr(
        store, "PUMA_CONVERSION_RECEIPT_SHA256", hashlib.sha256(receipt_bytes).hexdigest()
    )
    monkeypatch.setattr(store, "CHUNK_BYTES", 31)
    original_import = builtins.__import__

    def no_torch(name, *args, **kwargs):
        if name == "torch" or name.startswith("torch."):
            raise AssertionError("The import store must never import Torch")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_torch)
    return SimpleNamespace(
        root=root,
        selected=selected,
        weights=weights,
        receipt=receipt,
        payload=payload,
        receipt_bytes=receipt_bytes,
        cache=root / "models",
    )


def imported(case, *, check=no_op):
    return store.import_puma_weights(case.weights, case.receipt, cache_root=case.cache, check=check)


def namespace(case):
    return case.cache / store.NAMESPACE


def marker(case):
    return namespace(case) / store._marker_name()


def entry(case):
    return namespace(case) / json.loads(marker(case).read_text())["entry"]


def entries(case):
    return list(namespace(case).glob("entry-*")) if namespace(case).exists() else []


def assert_unpublished(case):
    assert not marker(case).exists()
    assert not entries(case)


def test_missing_status_is_read_only_and_path_free(case):
    status = store.inspect_store(case.cache, check=no_op)
    assert status["state"] == "missing" and status["provisioned"] is False
    assert status["files_verified"] is False
    assert not case.cache.exists()
    assert str(case.root) not in json.dumps(status)


def test_import_exact_pair_preserves_sources_unrelated_cache_and_claim_limits(case):
    case.cache.mkdir(mode=0o700)
    unrelated = case.cache / "cellpose" / "old-version" / "retained"
    unrelated.parent.mkdir(parents=True)
    unrelated.write_bytes(b"keep existing Cellpose bytes")
    before = (store._identity(case.weights.stat()), store._identity(case.receipt.stat()))
    status = imported(case)
    assert status["state"] == "verified" and status["files_verified"] is True
    assert status["execution_authority"] is False
    assert status["model_execution_performed"] is False
    assert (
        status["runtime_compatibility"] == status["scientific_qualification"] == "not-established"
    )
    assert str(case.root) not in json.dumps(status)
    assert unrelated.read_bytes() == b"keep existing Cellpose bytes"
    assert (
        case.weights.read_bytes() == case.payload
        and case.receipt.read_bytes() == case.receipt_bytes
    )
    assert store._identity(case.weights.stat()) == before[0]
    assert store._identity(case.receipt.stat()) == before[1]
    assert len(entries(case)) == 1
    assert (entry(case) / store.WEIGHTS_NAME).read_bytes() == case.payload
    assert (entry(case) / store.RECEIPT_NAME).read_bytes() == case.receipt_bytes
    assert (entry(case) / store.WEIGHTS_NAME).stat().st_mode & 0o777 == 0o400
    assert marker(case).stat().st_nlink == 2
    metadata = store.inspect_store(case.cache, check=no_op)
    assert metadata["state"] == "provisioned-unverified" and metadata["files_verified"] is False
    approved = store.resolve_approved_weights(case.cache, check=no_op)
    assert approved.path == entry(case) / store.WEIGHTS_NAME
    assert approved.sha256 == store.PUMA_WEIGHTS_SHA256 and approved.size_bytes == len(case.payload)


@pytest.mark.parametrize(
    "which,kind",
    [("weights", "size"), ("weights", "hash"), ("receipt", "size"), ("receipt", "hash")],
)
def test_exact_size_and_digest_refuse_arbitrary_weights_or_receipts(case, which, kind):
    path = getattr(case, which)
    data = path.read_bytes()
    path.write_bytes(data + b"x" if kind == "size" else bytes([data[0] ^ 1]) + data[1:])
    with pytest.raises(store.TissueModelStoreError):
        imported(case)
    assert_unpublished(case)


@pytest.mark.parametrize("bad", ["relative.pth", "", "../selected.pth", Path("relative.pth")])
def test_relative_or_empty_picker_path_refused(case, bad):
    with pytest.raises(store.TissueModelStoreError):
        store.import_puma_weights(bad, case.receipt, cache_root=case.cache, check=no_op)
    assert not case.cache.exists()


def test_parent_traversal_refused_even_if_it_resolves_to_selected_file(case):
    bad = case.selected / ".." / "selected" / case.weights.name
    with pytest.raises(store.TissueModelStoreError, match="traversal"):
        store.import_puma_weights(bad, case.receipt, cache_root=case.cache, check=no_op)
    assert not case.cache.exists()


@pytest.mark.parametrize("which", ["weights", "receipt", "parent", "cache", "namespace"])
def test_symlink_components_never_followed(case, which):
    source, receipt, cache = case.weights, case.receipt, case.cache
    if which in {"weights", "receipt"}:
        link = case.root / "selected-link"
        link.symlink_to(getattr(case, which))
        if which == "weights":
            source = link
        else:
            receipt = link
    elif which == "parent":
        link = case.root / "selected-directory-link"
        link.symlink_to(case.selected, target_is_directory=True)
        source = link / case.weights.name
    elif which == "cache":
        target = case.root / "other-cache"
        target.mkdir(mode=0o700)
        cache.symlink_to(target, target_is_directory=True)
    else:
        cache.mkdir(mode=0o700)
        target = case.root / "other-cache"
        target.mkdir(mode=0o700)
        namespace(case).symlink_to(target, target_is_directory=True)
    with pytest.raises(store.TissueModelStoreError):
        store.import_puma_weights(source, receipt, cache_root=cache, check=no_op)
    assert not marker(case).exists()
    assert case.weights.read_bytes() == case.payload
    if which in {"cache", "namespace"}:
        assert not list(target.iterdir())


def test_existing_valid_entry_is_reused_without_replacing_or_leaving_second_entry(case):
    imported(case)
    before = {path.name: store._identity(path.stat()) for path in entry(case).iterdir()}
    marker_before = store._identity(marker(case).stat())
    assert imported(case)["files_verified"] is True
    assert store._identity(marker(case).stat()) == marker_before
    assert {path.name: store._identity(path.stat()) for path in entry(case).iterdir()} == before
    assert len(entries(case)) == 1
    # A bad newly selected source must not silently reuse a good existing model.
    case.receipt.write_bytes(b"x" * len(case.receipt_bytes))
    with pytest.raises(store.TissueModelStoreError):
        imported(case)
    assert store._identity(marker(case).stat()) == marker_before
    assert store.inspect_store(case.cache, check=no_op, verify=True)["files_verified"] is True


def test_existing_invalid_publication_and_other_owned_names_are_preserved(case):
    namespace(case).mkdir(mode=0o700, parents=True)
    marker(case).write_bytes(b"invalid existing marker")
    abandoned = namespace(case) / "retained-other-run"
    abandoned.mkdir(mode=0o700)
    sentinel = abandoned / "original"
    sentinel.write_bytes(b"do not delete")
    with pytest.raises(store.TissueModelStoreError, match="Existing"):
        imported(case)
    assert marker(case).read_bytes() == b"invalid existing marker"
    assert sentinel.read_bytes() == b"do not delete"
    assert not entries(case)


def test_cancellation_during_copy_removes_only_this_import(case):
    def check():
        if any(
            (path / store.WEIGHTS_NAME).exists() and (path / store.WEIGHTS_NAME).stat().st_size > 0
            for path in entries(case)
        ):
            raise Cancelled("cancelled during streaming copy")

    with pytest.raises(Cancelled, match="streaming"):
        imported(case, check=check)
    assert_unpublished(case)
    assert case.weights.read_bytes() == case.payload


def test_permission_revocation_after_atomic_link_rolls_back_our_entry(case):
    error = PermissionError("exact live grant revoked")

    def check():
        if marker(case).exists():
            raise error

    with pytest.raises(PermissionError) as caught:
        imported(case, check=check)
    assert caught.value is error
    assert_unpublished(case)


@pytest.mark.parametrize("api", ["inspect", "resolve"])
def test_guard_exceptions_inside_verification_are_not_swallowed_as_cache_status(case, api):
    imported(case)
    calls = 0
    error = PermissionError("authority expired")

    def check():
        nonlocal calls
        calls += 1
        if calls == 3:
            raise error

    with pytest.raises(PermissionError) as caught:
        if api == "inspect":
            store.inspect_store(case.cache, check=check, verify=True)
        else:
            store.resolve_approved_weights(case.cache, check=check)
    assert caught.value is error
    assert marker(case).exists()


def test_full_verification_rehashes_even_when_size_and_mtime_are_restored(case):
    imported(case)
    path = entry(case) / store.WEIGHTS_NAME
    original = path.stat()
    path.chmod(0o600)
    path.write_bytes(b"x" * len(case.payload))
    os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))
    path.chmod(0o400)
    assert store.inspect_store(case.cache, check=no_op)["files_verified"] is False
    assert store.inspect_store(case.cache, check=no_op, verify=True)["state"] == "invalid"
    with pytest.raises(store.TissueModelStoreError):
        store.resolve_approved_weights(case.cache, check=no_op)


@pytest.mark.parametrize("which", ["weights", "receipt", "entry", "marker"])
def test_managed_symlinks_and_partial_pairs_are_not_approved(case, which):
    imported(case)
    current = entry(case)
    if which in {"weights", "receipt"}:
        current.chmod(0o700)
        path = current / (store.WEIGHTS_NAME if which == "weights" else store.RECEIPT_NAME)
        path.unlink()
        assert store.inspect_store(case.cache, check=no_op)["state"] == "invalid"
        path.symlink_to(getattr(case, which))
    elif which == "entry":
        moved = namespace(case) / "retained-entry"
        current.rename(moved)
        current.symlink_to(moved, target_is_directory=True)
    else:
        marker(case).unlink()
        marker(case).symlink_to(current / store.PUBLICATION_NAME)
    assert store.inspect_store(case.cache, check=no_op, verify=True)["state"] == "invalid"
    with pytest.raises(store.TissueModelStoreError):
        store.resolve_approved_weights(case.cache, check=no_op)


def test_manifest_cannot_redirect_to_external_or_unrecognized_storage(case):
    imported(case)
    original = json.loads(marker(case).read_text())
    marker(case).chmod(0o600)
    for replacement in ("../outside", str(case.selected), "entry-bad"):
        original["entry"] = replacement
        marker(case).write_bytes(store._encoded(original))
        assert store.inspect_store(case.cache, check=no_op, verify=True)["state"] == "invalid"
    assert case.weights.read_bytes() == case.payload


@pytest.mark.parametrize("kind", ["replace", "in-place"])
def test_selected_file_changes_during_stream_are_refused(case, monkeypatch, kind):
    original_read = store.os.read
    source_inode = case.weights.stat().st_ino
    changed = False

    def read(descriptor, count):
        nonlocal changed
        data = original_read(descriptor, count)
        if not changed and data and os.fstat(descriptor).st_ino == source_inode:
            changed = True
            if kind == "replace":
                replacement = case.selected / "replacement.pth"
                replacement.write_bytes(case.payload)
                os.replace(replacement, case.weights)
            else:
                before = case.weights.stat()
                with case.weights.open("r+b") as stream:
                    stream.write(b"x")
                os.utime(case.weights, ns=(before.st_atime_ns, before.st_mtime_ns))
        return data

    monkeypatch.setattr(store.os, "read", read)
    with pytest.raises(store.TissueModelStoreError, match="identity changed"):
        imported(case)
    assert changed
    assert_unpublished(case)


def test_cache_root_replacement_never_writes_into_replacement(case):
    moved = case.root / "original-models"
    changed = False

    def check():
        nonlocal changed
        if not changed and any((p / store.RECEIPT_NAME).exists() for p in entries(case)):
            changed = True
            case.cache.rename(moved)
            case.cache.mkdir(mode=0o700)
            (case.cache / "foreign-sentinel").write_bytes(b"preserve replacement")

    with pytest.raises(store.TissueModelStoreError, match="identity changed"):
        imported(case, check=check)
    assert changed
    assert list(case.cache.iterdir()) == [case.cache / "foreign-sentinel"]
    assert (case.cache / "foreign-sentinel").read_bytes() == b"preserve replacement"
    assert not list((moved / store.NAMESPACE).iterdir())


def test_replaced_staging_path_does_not_cause_cleanup_of_foreign_files(case):
    changed = False
    foreign = None

    def check():
        nonlocal changed, foreign
        active = entries(case)
        if not changed and active and (active[0] / store.WEIGHTS_NAME).exists():
            changed = True
            foreign = active[0]
            foreign.rename(namespace(case) / "moved-owned-stage")
            foreign.mkdir(mode=0o700)
            (foreign / "foreign-sentinel").write_bytes(b"do not touch")

    with pytest.raises(store.TissueModelStoreError, match="staging directory was replaced"):
        imported(case, check=check)
    assert changed and foreign is not None
    assert (foreign / "foreign-sentinel").read_bytes() == b"do not touch"
    assert not marker(case).exists()


def test_concurrent_exact_imports_publish_once_without_overwrite(case):
    case.cache.mkdir(mode=0o700)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: imported(case), range(2)))
    assert all(result["files_verified"] for result in results)
    assert len(entries(case)) == 1
    assert store.inspect_store(case.cache, check=no_op, verify=True)["state"] == "verified"


def test_live_guard_required_for_every_public_operation(case):
    with pytest.raises(store.TissueModelStoreError, match="guard"):
        imported(case, check=None)
    with pytest.raises(store.TissueModelStoreError, match="guard"):
        store.inspect_store(case.cache, check=None)
    with pytest.raises(store.TissueModelStoreError, match="guard"):
        store.resolve_approved_weights(case.cache, check=None)
    assert not case.cache.exists()


def test_pair_verification_detects_weights_replaced_while_receipt_is_read(case, monkeypatch):
    imported(case)
    current = entry(case)
    weights = current / store.WEIGHTS_NAME
    receipt_inode = (current / store.RECEIPT_NAME).stat().st_ino
    original_read = store.os.read
    changed = False

    def read(descriptor, count):
        nonlocal changed
        data = original_read(descriptor, count)
        if not changed and data and os.fstat(descriptor).st_ino == receipt_inode:
            changed = True
            current.chmod(0o700)
            replacement = current / "replacement.pth"
            replacement.write_bytes(case.payload)
            os.replace(replacement, weights)
        return data

    monkeypatch.setattr(store.os, "read", read)
    assert store.inspect_store(case.cache, check=no_op, verify=True)["state"] == "invalid"
    assert changed


def test_group_writable_cache_is_refused_without_chmod_or_content_changes(case):
    case.cache.mkdir(mode=0o700)
    case.cache.chmod(0o770)
    sentinel = case.cache / "keep"
    sentinel.write_bytes(b"keep")
    with pytest.raises(store.TissueModelStoreError, match="privately writable"):
        imported(case)
    assert case.cache.stat().st_mode & 0o777 == 0o770
    assert sentinel.read_bytes() == b"keep"
    assert not namespace(case).exists()
