"""Transactional research records and immutable array artifacts.

The database contains private source locators. Only explicit public receipts
may cross a renderer/agent boundary. No SQL, filesystem path, or executable
operation is accepted from untrusted clients by this storage layer's consumers.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import stat
import tempfile
import uuid
from collections.abc import Callable
from contextlib import closing, contextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from .export import _fsync_directory, _rename_noreplace
from .models import ENGINE_VERSION
from .working_result import _sha256_file_stable

SCHEMA = 1
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
ARRAY_VERIFY_CHUNK_BYTES = 4 * 1024 * 1024
DEFAULT_DISK_BUDGET = 20 * 1024**3
ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
SHA_PATTERN = re.compile(r"^[a-f0-9]{64}$")
ARRAY_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


def canonical_json(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode()) > MAX_JSON_BYTES:
        raise ValueError("Record exceeds the bounded JSON size; use an artifact for dense results")
    return encoded


def parse_json(value: str) -> Any:
    if len(value.encode()) > MAX_JSON_BYTES:
        raise ValueError("Stored record exceeds the permitted size")

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, item in items:
            if key in result:
                raise ValueError("Duplicate record keys are invalid")
            result[key] = item
        return result

    def invalid_constant(_value: str) -> None:
        raise ValueError("Non-finite JSON values are invalid")

    return json.loads(value, object_pairs_hook=pairs, parse_constant=invalid_constant)


def checked_id(value: Any) -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise ValueError("Invalid record identity")
    return value


def checked_text(value: Any, name: str, maximum: int = 256, *, empty: bool = False) -> str:
    if not isinstance(value, str) or len(value) > maximum or (not value.strip() and not empty):
        raise ValueError(f"{name} must be text of at most {maximum} characters")
    if any(ord(c) < 32 and c not in "\n\t" for c in value):
        raise ValueError(f"{name} contains control characters")
    return value


class ResearchProject:
    """A versioned .loci-study directory; all database writes are transactions."""

    def __init__(self, directory: str | Path):
        requested = Path(directory).expanduser()
        if not requested.is_absolute():
            raise ValueError("Research project location must be absolute")
        if requested.is_symlink() or not requested.is_dir():
            raise ValueError("Research project must be an existing plain directory")
        self.root = requested.resolve(strict=True)
        self._identity = self._directory_identity(self.root)
        self.database = self.root / "study.sqlite3"
        self.arrays = self.root / "artifacts"
        self._check_layout()
        with self.connection() as connection:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version != SCHEMA:
                raise ValueError(
                    "Unsupported study schema; use its matching Loci version or a backup"
                )
            meta = connection.execute("SELECT value FROM metadata WHERE key='project'").fetchone()
            if meta is None:
                raise ValueError("Study project identity is missing")
            self.meta = parse_json(meta[0])
            checked_id(self.meta["project_id"])
            if self.meta.get("schema") != "loci.study/v1":
                raise ValueError("Study project schema identity is invalid")

    @classmethod
    def create(cls, directory: str | Path, title: str) -> ResearchProject:
        requested = Path(directory).expanduser()
        if not requested.is_absolute():
            raise ValueError("Study destination must be absolute")
        checked_text(title, "Study title")
        parent = requested.parent.resolve(strict=True)
        destination = parent / requested.name
        if destination.exists() or destination.is_symlink():
            raise ValueError(
                "Choose an absent study destination; existing work is never overwritten"
            )
        staging = Path(tempfile.mkdtemp(prefix=".loci-study-", dir=parent))
        try:
            (staging / "artifacts").mkdir(mode=0o700)
            with closing(sqlite3.connect(staging / "study.sqlite3")) as connection, connection:
                connection.executescript("""
                    PRAGMA user_version=1;
                    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE sources(id TEXT PRIMARY KEY, record TEXT NOT NULL);
                    CREATE TABLE documents(
                        kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
                        record TEXT NOT NULL, PRIMARY KEY(kind,id));
                    CREATE TABLE results(id TEXT PRIMARY KEY, record TEXT NOT NULL);
                    CREATE TABLE jobs(
                        id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL,
                        request_hash TEXT NOT NULL, record TEXT NOT NULL);
                """)
                now = timestamp()
                meta = {
                    "schema": "loci.study/v1",
                    "project_id": uuid.uuid4().hex,
                    "title": title,
                    "created_at": now,
                    "engine_version": ENGINE_VERSION,
                    "disk_budget_bytes": DEFAULT_DISK_BUDGET,
                }
                connection.execute(
                    "INSERT INTO metadata VALUES('project',?)", (canonical_json(meta),)
                )
            os.chmod(staging / "study.sqlite3", 0o600)
            # Windows rejects fsync on a read-only CRT descriptor. Open the
            # database read/write after its transaction connection is closed.
            with (staging / "study.sqlite3").open("rb+") as stream:
                os.fsync(stream.fileno())
            _fsync_directory(staging)
            _rename_noreplace(staging, destination)
            _fsync_directory(parent)
        except BaseException:
            # Only the positively created staging directory is cleanup-owned.
            for entry in (staging / "study.sqlite3", staging / "artifacts"):
                with suppress(OSError):
                    entry.rmdir() if entry.is_dir() else entry.unlink()
            with suppress(OSError):
                staging.rmdir()
            raise
        return cls(destination)

    @staticmethod
    def _directory_identity(directory: Path) -> tuple[int, int]:
        value = directory.lstat()
        if not stat.S_ISDIR(value.st_mode):
            raise ValueError("Study directory was replaced or linked")
        return value.st_dev, value.st_ino

    def _check_layout(self) -> None:
        if self._directory_identity(self.root) != self._identity:
            raise ValueError("Study directory identity changed")
        if self.arrays.is_symlink() or not self.arrays.is_dir():
            raise ValueError("Study artifact directory is missing or linked")
        for suffix in ("", "-wal", "-shm", "-journal"):
            file = Path(str(self.database) + suffix)
            try:
                st = file.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
                raise ValueError("Study database or journal is not a plain file")
        if not self.database.is_file():
            raise ValueError("Study database is missing")

    @contextmanager
    def connection(self):
        self._check_layout()
        connection = sqlite3.connect(self.database, timeout=10)
        try:
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA synchronous=FULL")
            yield connection
            self._check_layout()
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def summary(self) -> dict[str, Any]:
        with self.connection() as connection:
            counts = {
                table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                for table in ("sources", "results", "jobs")
            }
        return {**self.meta, "counts": counts}

    def register_source(
        self,
        path: str | Path,
        fingerprint: str,
        metadata: dict[str, Any],
        *,
        name: str | None = None,
        source_kind: str = "native",
        derivation: dict[str, Any] | None = None,
        relative_path: str | None = None,
    ) -> dict[str, Any]:
        """Caller inspected pixels; registration independently verifies the source."""
        source = Path(path)
        if source_kind not in {"native", "whole_slide"}:
            raise ValueError("Unknown plain-file source reader")
        if not source.is_absolute() or source.is_symlink() or not source.is_file():
            raise ValueError("Source must be an explicitly selected plain local file")
        source = source.resolve(strict=True)
        if source.is_relative_to(self.root):
            raise ValueError("Raw sources must remain outside the derived study directory")
        if not isinstance(fingerprint, str) or not SHA_PATTERN.fullmatch(fingerprint):
            raise ValueError("Source requires an exact SHA-256 fingerprint")
        actual, size = _sha256_file_stable(source, reject_symlink=True)
        if actual != fingerprint:
            raise ValueError("Source changed after inspection; import it again")
        if derivation is not None:
            from .research_vendor import validate_derivation

            derivation = validate_derivation(derivation, fingerprint)
        display_name = checked_text(name or source.name, "Source name")
        with self.connection() as connection:
            for row in connection.execute("SELECT record FROM sources"):
                existing = parse_json(row[0])
                if existing.get("private_path") == str(source):
                    if existing["sha256"] != fingerprint:
                        raise ValueError(
                            "This registered source changed; preserve the previous study"
                        )
                    if existing.get("derivation") != derivation:
                        raise ValueError("Registered source has a different conversion derivation")
                    return self.public_source(existing)
            record = {
                "id": uuid.uuid4().hex,
                "name": display_name,
                "sha256": fingerprint,
                "size_bytes": size,
                "private_path": str(source),
                "private_relative_path": relative_path or source.name,
                "metadata": metadata,
                "created_at": timestamp(),
                "annotations": {},
                "source_kind": source_kind,
                "identity_kind": "full-file-sha256",
            }
            if derivation is not None:
                record["derivation"] = derivation
            connection.execute(
                "INSERT INTO sources VALUES(?,?)", (record["id"], canonical_json(record))
            )
        return self.public_source(record)

    @staticmethod
    def public_source(record: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in record.items() if not key.startswith("private_")}

    def register_zarr_source(
        self,
        path: str,
        *,
        name: str | None = None,
        image_group: str = "",
        multiscale_index: int | None = None,
    ) -> dict[str, Any]:
        from .zarr_adapter import ZarrAdapter

        source = Path(path)
        if not source.is_absolute() or source.is_symlink() or not source.is_dir():
            raise ValueError("Select an explicit plain local OME-Zarr directory")
        source = source.resolve(strict=True)
        if source.is_relative_to(self.root) or self.root.is_relative_to(source):
            raise ValueError("Raw OME-Zarr and derived study directories must be independent")
        adapter = ZarrAdapter(
            str(source), image_group=image_group, multiscale_index=multiscale_index
        )
        try:
            receipt = adapter.verify_strict()
            metadata = adapter.public_metadata()
        finally:
            adapter.close()
        locator = {
            "path": str(source),
            "image_group": image_group,
            "multiscale_index": multiscale_index,
        }
        with self.connection() as connection:
            for row in connection.execute("SELECT record FROM sources"):
                existing = parse_json(row[0])
                if existing.get("private_zarr_selection") == locator:
                    if existing["sha256"] != receipt.content_manifest_sha256:
                        raise ValueError("This registered OME-Zarr source changed")
                    return self.public_source(existing)
            record = {
                "id": uuid.uuid4().hex,
                "name": checked_text(name or source.name, "Source name"),
                "sha256": receipt.content_manifest_sha256,
                "size_bytes": receipt.source_size_bytes,
                "private_zarr_selection": locator,
                "metadata": metadata,
                "created_at": timestamp(),
                "annotations": {},
                "source_kind": "ome_zarr",
                "identity_kind": "tree-content-manifest-sha256",
            }
            connection.execute(
                "INSERT INTO sources VALUES(?,?)", (record["id"], canonical_json(record))
            )
        return self.public_source(record)

    def register_medical_source(
        self,
        selected: str | Path | list[str],
        *,
        name: str | None = None,
    ) -> dict[str, Any]:
        from .medical_image import inspect_medical

        paths = selected if isinstance(selected, list) else [str(selected)]
        if not paths or len(paths) > 10_000:
            raise ValueError("Medical import requires a bounded explicit file selection")
        canonical = []
        for item in paths:
            candidate = Path(item)
            if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_file():
                raise ValueError("Medical sources must be explicitly selected plain files")
            path = candidate.resolve(strict=True)
            if path.is_relative_to(self.root):
                raise ValueError("Raw medical sources must remain outside the derived study")
            canonical.append(str(path))
        selected_value = canonical if isinstance(selected, list) else canonical[0]
        inspection = inspect_medical(selected_value)
        metadata = inspection.to_dict()
        fingerprint = inspection.source_identity.removeprefix("sha256:")
        if not SHA_PATTERN.fullmatch(fingerprint):
            raise ValueError("Medical reader did not provide a verified SHA-256 source identity")
        with self.connection() as connection:
            for row in connection.execute("SELECT record FROM sources"):
                existing = parse_json(row[0])
                if existing.get("private_medical_selection") == selected_value:
                    if existing["sha256"] != fingerprint:
                        raise ValueError("Registered medical source changed")
                    return self.public_source(existing)
            record = {
                "id": uuid.uuid4().hex,
                "name": checked_text(
                    name
                    or ("DICOM series" if isinstance(selected, list) else Path(canonical[0]).name),
                    "Source name",
                ),
                "sha256": fingerprint,
                "size_bytes": inspection.encoded_bytes,
                "private_medical_selection": selected_value,
                "metadata": metadata,
                "created_at": timestamp(),
                "annotations": {},
                "source_kind": "medical",
                "identity_kind": "ordered-medical-source-manifest-sha256",
            }
            connection.execute(
                "INSERT INTO sources VALUES(?,?)", (record["id"], canonical_json(record))
            )
        return self.public_source(record)

    def source(self, source_id: str, *, verify: bool = False) -> dict[str, Any]:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT record FROM sources WHERE id=?", (checked_id(source_id),)
            ).fetchone()
        if row is None:
            raise ValueError("Source is not registered in this study")
        record = parse_json(row[0])
        if verify:
            if record.get("locator_state") == "relink-required":
                raise ValueError(
                    "Source locator is unavailable after interchange; relink an exact local copy"
                )
            if record.get("source_kind") == "medical":
                from .medical_image import inspect_medical

                inspection = inspect_medical(record["private_medical_selection"])
                actual = inspection.source_identity.removeprefix("sha256:")
                size = inspection.encoded_bytes
            elif record.get("source_kind") == "ome_zarr":
                from .ome_zarr import OMEZarrSession

                locator = record["private_zarr_selection"]
                with OMEZarrSession(
                    locator["path"],
                    image_group=locator["image_group"],
                    multiscale_index=locator["multiscale_index"],
                ) as session:
                    receipt = session.verify_strict()
                actual, size = receipt.content_manifest_sha256, receipt.source_size_bytes
            else:
                actual, size = _sha256_file_stable(
                    Path(record["private_path"]), reject_symlink=True
                )
            if actual != record["sha256"] or size != record["size_bytes"]:
                raise ValueError(
                    "Registered source changed or is unavailable; relink an exact copy"
                )
        return record

    def list_sources(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            return [
                self.public_source(parse_json(row[0]))
                for row in connection.execute("SELECT record FROM sources ORDER BY rowid")
            ]

    def relink(self, source_id: str, candidate: str | Path) -> dict[str, Any]:
        source = self.source(source_id)
        path = Path(candidate)
        if source.get("source_kind") == "ome_zarr":
            from .ome_zarr import OMEZarrSession

            locator = source["private_zarr_selection"]
            with OMEZarrSession(
                path,
                image_group=locator["image_group"],
                multiscale_index=locator["multiscale_index"],
            ) as session:
                receipt = session.verify_strict()
            actual, size = receipt.content_manifest_sha256, receipt.source_size_bytes
            updated = {
                "private_zarr_selection": {**locator, "path": str(path.resolve(strict=True))}
            }
        elif source.get("source_kind") == "medical":
            from .medical_image import inspect_medical

            if isinstance(source["private_medical_selection"], list):
                raise ValueError("DICOM relinking requires explicit replacement series selection")
            inspection = inspect_medical(str(path))
            actual, size = (
                inspection.source_identity.removeprefix("sha256:"),
                inspection.encoded_bytes,
            )
            updated = {"private_medical_selection": str(path.resolve(strict=True))}
        else:
            if not path.is_absolute() or path.is_symlink() or not path.is_file():
                raise ValueError("Relink requires an explicitly selected plain file")
            actual, size = _sha256_file_stable(path, reject_symlink=True)
            updated = {"private_path": str(path.resolve(strict=True))}
        if actual != source["sha256"] or size != source["size_bytes"]:
            raise ValueError("Relink rejected: selected bytes do not exactly match the source")
        source.update(updated)
        source["relinked_at"] = timestamp()
        with self.connection() as connection:
            connection.execute(
                "UPDATE sources SET record=? WHERE id=?", (canonical_json(source), source_id)
            )
        return self.public_source(source)

    def put_document(
        self,
        kind: str,
        document_id: str,
        record: dict[str, Any],
        *,
        expected_revision: int,
    ) -> dict[str, Any]:
        if kind not in {
            "sample",
            "recipe",
            "display",
            "channels",
            "annotations",
            "tracks",
            "selection",
            "policy",
            "model",
            "model_preview",
            "comparison",
            "workspace",
        }:
            raise ValueError("Unsupported study document kind")
        checked_id(document_id)
        if (
            isinstance(expected_revision, bool)
            or not isinstance(expected_revision, int)
            or expected_revision < 0
        ):
            raise ValueError("Expected document revision must be a non-negative integer")
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT revision FROM documents WHERE kind=? AND id=?", (kind, document_id)
            ).fetchone()
            revision = existing[0] if existing else 0
            if revision != expected_revision:
                raise ValueError("Study document changed; reload before editing")
            envelope = {
                "id": document_id,
                "kind": kind,
                "revision": revision + 1,
                "updated_at": timestamp(),
                "data": record,
            }
            connection.execute(
                "INSERT OR REPLACE INTO documents VALUES(?,?,?,?)",
                (kind, document_id, revision + 1, canonical_json(envelope)),
            )
        return envelope

    def documents(self, kind: str) -> list[dict[str, Any]]:
        with self.connection() as connection:
            return [
                parse_json(row[0])
                for row in connection.execute(
                    "SELECT record FROM documents WHERE kind=? ORDER BY rowid", (kind,)
                )
            ]

    def store_array(self, array: np.ndarray) -> dict[str, Any]:
        array = np.asarray(array)
        if (
            array.dtype.kind not in "buif"
            or not 1 <= array.ndim <= 5
            or not np.isfinite(array).all()
        ):
            raise ValueError("Artifacts require bounded real finite numeric arrays")
        if array.nbytes > MAX_ARTIFACT_BYTES:
            raise ValueError("Array exceeds the per-artifact byte budget")
        self._check_layout()
        used = sum(
            p.stat().st_size for p in self.arrays.iterdir() if p.is_file() and not p.is_symlink()
        )
        if used + array.nbytes + 4096 > self.meta["disk_budget_bytes"]:
            raise ValueError("Study artifact budget reached; export/archive a completed study")
        descriptor, temporary = tempfile.mkstemp(prefix=".array-", dir=self.arrays)
        temporary_path = Path(temporary)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                np.save(stream, array, allow_pickle=False)
                stream.flush()
                os.fsync(stream.fileno())
            digest, size = _sha256_file_stable(temporary_path, reject_symlink=True)
            target = self.arrays / (digest + ".npy")
            self._check_layout()
            try:
                _rename_noreplace(temporary_path, target)
            except FileExistsError:
                actual, existing_size = _sha256_file_stable(target, reject_symlink=True)
                if actual != digest or existing_size != size:
                    raise ValueError(
                        "Existing content-addressed artifact failed integrity verification"
                    ) from None
            _fsync_directory(self.arrays)
        finally:
            with suppress(FileNotFoundError):
                temporary_path.unlink()
        return {
            "sha256": digest,
            "bytes": size,
            "shape": list(array.shape),
            "dtype": str(array.dtype),
        }

    def _open_array_artifact(self, artifact: dict[str, Any]) -> tuple[Path, str, int, np.memmap]:
        if not isinstance(artifact, dict) or set(artifact) != {
            "sha256",
            "bytes",
            "shape",
            "dtype",
        }:
            raise ValueError("Invalid array artifact descriptor")
        digest = artifact["sha256"]
        if not isinstance(digest, str) or not SHA_PATTERN.fullmatch(digest):
            raise ValueError("Invalid array artifact identity")
        if (
            isinstance(artifact["bytes"], bool)
            or not isinstance(artifact["bytes"], int)
            or not 1 <= artifact["bytes"] <= MAX_ARTIFACT_BYTES + 4096
        ):
            raise ValueError("Array artifact exceeds the read budget")
        shape = artifact["shape"]
        dtype = artifact["dtype"]
        if (
            not isinstance(shape, list)
            or not 1 <= len(shape) <= 5
            or any(
                isinstance(length, bool) or not isinstance(length, int) or length < 0
                for length in shape
            )
            or not isinstance(dtype, str)
            or not dtype
            or len(dtype) > 128
        ):
            raise ValueError("Invalid array artifact descriptor")
        self._check_layout()
        file = self.arrays / (digest + ".npy")
        actual, size = _sha256_file_stable(file, reject_symlink=True)
        if actual != digest or size != artifact["bytes"]:
            raise ValueError("Array artifact hash/size verification failed")
        # mmap checks the actual NPY header without an allocation from an
        # untrusted claimed shape. Object/pickle data is always forbidden.
        array = np.load(file, allow_pickle=False, mmap_mode="r", max_header_size=16384)
        if (
            not isinstance(array, np.memmap)
            or not 1 <= array.ndim <= 5
            or array.nbytes > MAX_ARTIFACT_BYTES
            or array.dtype.kind not in "buif"
            or array.offset + array.nbytes != size
        ):
            raise ValueError("Array artifact header exceeds its dtype or memory contract")
        if list(array.shape) != artifact["shape"] or str(array.dtype) != artifact["dtype"]:
            raise ValueError("Array artifact geometry/dtype disagrees with its manifest")
        return file, digest, size, array

    @staticmethod
    def _array_is_finite_bounded(array: np.memmap) -> bool:
        elements = max(1, ARRAY_VERIFY_CHUNK_BYTES // max(1, array.dtype.itemsize))
        iterator = np.nditer(
            array,
            flags=["external_loop", "buffered", "zerosize_ok"],
            op_flags=["readonly"],
            order="K",
            buffersize=elements,
        )
        return all(bool(np.isfinite(chunk).all()) for chunk in iterator)

    def verify_array(self, artifact: dict[str, Any]) -> None:
        """Verify an array artifact without materializing its numeric payload."""

        file, digest, size, array = self._open_array_artifact(artifact)
        finite = self._array_is_finite_bounded(array)
        after, after_size = _sha256_file_stable(file, reject_symlink=True)
        if after != digest or after_size != size or not finite:
            raise ValueError("Array artifact changed or contains invalid numerical values")

    def load_array(self, artifact: dict[str, Any]) -> np.ndarray:
        file, digest, size, array = self._open_array_artifact(artifact)
        output = np.array(array)
        after, after_size = _sha256_file_stable(file, reject_symlink=True)
        if after != digest or after_size != size or not np.isfinite(output).all():
            raise ValueError("Array artifact changed or contains invalid numerical values")
        output.flags.writeable = False
        return output

    def save_result(
        self,
        *,
        source_id: str,
        kind: str,
        arrays: dict[str, np.ndarray],
        provenance: dict[str, Any],
        parent_id: str | None = None,
        job_id: str | None = None,
        publication_guard: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        source = self.source(source_id, verify=True)
        if source.get("derivation") is not None:
            from .research_vendor import validate_derivation

            derivation = validate_derivation(source["derivation"], source["sha256"])
            if "source_derivation" in provenance and provenance["source_derivation"] != derivation:
                raise ValueError("Result origin differs from its immutable derived source")
            provenance = {**provenance, "source_derivation": derivation}
        elif "source_derivation" in provenance:
            raise ValueError("Result claims a derivation absent from its registered source")
        if parent_id is not None:
            parent = self.result(parent_id)
            if parent["source_id"] != source_id:
                raise ValueError("Correction parent belongs to another source")
        checked_text(kind, "Result kind", 64)
        if (
            not arrays
            or len(arrays) > 16
            or any(not ARRAY_NAME_PATTERN.fullmatch(k) for k in arrays)
        ):
            raise ValueError("Result requires 1-16 named numeric artifacts")
        artifacts = {key: self.store_array(array) for key, array in arrays.items()}
        # Artifact staging may take seconds. Recheck all scientific inputs at
        # publication, including explicitly bound flat/dark-field references.
        if self.source(source_id, verify=True)["sha256"] != source["sha256"]:
            raise ValueError("Source identity changed during result staging")
        references = provenance.get("references", {})
        if not isinstance(references, dict) or len(references) > 16:
            raise ValueError("Result reference bindings are invalid")
        for reference in references.values():
            if (
                self.source(reference["source_id"], verify=True)["sha256"]
                != reference["source_sha256"]
            ):
                raise ValueError("A bound reference changed during result staging")
        record = {
            "id": uuid.uuid4().hex,
            "schema": "loci.research-result/v1",
            "source_id": source_id,
            "source_sha256": source["sha256"],
            "kind": kind,
            "parent_id": parent_id,
            "created_at": timestamp(),
            "engine_version": ENGINE_VERSION,
            "arrays": artifacts,
            "provenance": provenance,
        }
        record["revision_hash"] = hashlib.sha256(canonical_json(record).encode()).hexdigest()
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if publication_guard is not None:
                publication_guard()
            if job_id is not None:
                job_row = connection.execute(
                    "SELECT record FROM jobs WHERE id=?", (checked_id(job_id),)
                ).fetchone()
                if job_row is None:
                    raise ValueError("Publication job is not part of this study")
                job = parse_json(job_row[0])
                if job["state"] != "running" or job["cancel_requested"]:
                    raise ValueError("Job was cancelled or stopped before publication")
                if job["request"].get("source_id") != source_id:
                    raise ValueError("Publication job belongs to a different source")
                job.update(
                    state="succeeded",
                    progress=1.0,
                    result_ids=[record["id"]],
                    finished_at=timestamp(),
                    updated_at=timestamp(),
                )
                connection.execute(
                    "UPDATE jobs SET record=? WHERE id=?", (canonical_json(job), job_id)
                )
            connection.execute(
                "INSERT INTO results VALUES(?,?)", (record["id"], canonical_json(record))
            )
        return record

    def result(self, result_id: str) -> dict[str, Any]:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT record FROM results WHERE id=?", (checked_id(result_id),)
            ).fetchone()
        if row is None:
            raise ValueError("Result is not part of this study")
        record = parse_json(row[0])
        unhashed = {k: v for k, v in record.items() if k != "revision_hash"}
        if hashlib.sha256(canonical_json(unhashed).encode()).hexdigest() != record.get(
            "revision_hash"
        ):
            raise ValueError("Result revision record failed integrity verification")
        return record

    def list_results(self, source_id: str | None = None) -> list[dict[str, Any]]:
        if source_id is not None:
            self.source(source_id)
        with self.connection() as connection:
            ids = [row[0] for row in connection.execute("SELECT id FROM results ORDER BY rowid")]
        records = [self.result(record_id) for record_id in ids]
        return [r for r in records if source_id is None or r["source_id"] == source_id]

    def review(self, result_id: str, revision_hash: str, disposition: str) -> dict[str, Any]:
        if disposition not in {"reviewed", "excluded", "pending"}:
            raise ValueError("Review disposition must be reviewed, excluded or pending")
        result = self.result(result_id)
        if result["revision_hash"] != revision_hash:
            raise ValueError("Review must bind to the exact selected result revision")
        key = "review:" + result_id
        receipt = {
            "result_id": result_id,
            "revision_hash": revision_hash,
            "disposition": disposition,
            "reviewed_at": timestamp(),
            "actor": "human",
        }
        with self.connection() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO metadata VALUES(?,?)", (key, canonical_json(receipt))
            )
        return receipt

    def review_state(self, result_id: str) -> dict[str, Any] | None:
        result = self.result(result_id)
        with self.connection() as connection:
            row = connection.execute(
                "SELECT value FROM metadata WHERE key=?", ("review:" + result_id,)
            ).fetchone()
        if row is None:
            return None
        receipt = parse_json(row[0])
        if receipt["revision_hash"] != result["revision_hash"]:
            raise ValueError("Stored review is stale for this result revision")
        return receipt

    def submit(self, operation: str, request: dict[str, Any], request_key: str) -> dict[str, Any]:
        checked_text(request_key, "Submission key", 160)
        checked_text(operation, "Operation", 64)
        fingerprint = hashlib.sha256(
            canonical_json({"operation": operation, "request": request}).encode()
        ).hexdigest()
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT request_hash,record FROM jobs WHERE request_key=?", (request_key,)
            ).fetchone()
            if existing:
                if existing[0] != fingerprint:
                    raise ValueError("Repeated submission key has different parameters")
                return parse_json(existing[1])
            record = {
                "id": uuid.uuid4().hex,
                "operation": operation,
                "request": request,
                "request_key": request_key,
                "request_hash": fingerprint,
                "state": "queued",
                "created_at": timestamp(),
                "updated_at": timestamp(),
                "progress": 0,
                "cancel_requested": False,
                "result_ids": [],
                "error": None,
            }
            connection.execute(
                "INSERT INTO jobs VALUES(?,?,?,?)",
                (record["id"], request_key, fingerprint, canonical_json(record)),
            )
        return record

    def job(self, job_id: str) -> dict[str, Any]:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT record FROM jobs WHERE id=?", (checked_id(job_id),)
            ).fetchone()
        if row is None:
            raise ValueError("Job is not part of this study")
        return parse_json(row[0])

    def list_jobs(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            return [
                parse_json(row[0])
                for row in connection.execute("SELECT record FROM jobs ORDER BY rowid")
            ]

    def update_job(
        self, job_id: str, *, expected_state: str, max_running: int | None = None, **changes: Any
    ) -> dict[str, Any]:
        if max_running is not None and (
            isinstance(max_running, bool)
            or not isinstance(max_running, int)
            or not 1 <= max_running <= 64
        ):
            raise ValueError("Concurrent execution limit must be 1-64")
        allowed = {
            "state",
            "progress",
            "cancel_requested",
            "result_ids",
            "error",
            "pid",
            "started_at",
            "finished_at",
        }
        if set(changes) - allowed:
            raise ValueError("Unsupported job update")
        if "progress" in changes and (
            isinstance(changes["progress"], bool)
            or not isinstance(changes["progress"], (int, float))
            or not 0 <= changes["progress"] <= 1
        ):
            raise ValueError("Job progress must be a finite fraction")
        if "cancel_requested" in changes and not isinstance(changes["cancel_requested"], bool):
            raise ValueError("Cancellation state must be boolean")
        if "pid" in changes and (
            isinstance(changes["pid"], bool)
            or not isinstance(changes["pid"], int)
            or changes["pid"] <= 0
        ):
            raise ValueError("Job process identity must be positive")
        if "result_ids" in changes:
            if not isinstance(changes["result_ids"], list):
                raise ValueError("Job result identities must be a list")
            for result_id in changes["result_ids"]:
                self.result(checked_id(result_id))
        if changes.get("error") is not None:
            checked_text(changes["error"], "Job error", 1000)
        transitions = {
            "queued": {"running", "cancelled", "failed"},
            "running": {"running", "succeeded", "failed", "cancelled", "interrupted"},
            "succeeded": set(),
            "failed": set(),
            "cancelled": set(),
            "interrupted": set(),
        }
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT record FROM jobs WHERE id=?", (checked_id(job_id),)
            ).fetchone()
            if row is None:
                raise ValueError("Job is not part of this study")
            record = parse_json(row[0])
            if record["state"] != expected_state:
                raise ValueError("Job state changed; reload its status")
            state = changes.get("state", expected_state)
            if expected_state == "queued" and state == "running" and max_running is not None:
                running = sum(
                    parse_json(row[0])["state"] == "running"
                    for row in connection.execute("SELECT record FROM jobs")
                )
                if running >= max_running:
                    raise PermissionError("The project execution limit is in use")
            if expected_state not in transitions or state not in transitions[expected_state]:
                raise ValueError("Invalid or terminal job transition")
            record.update(changes, updated_at=timestamp())
            canonical_json(record)
            connection.execute(
                "UPDATE jobs SET record=? WHERE id=?", (canonical_json(record), job_id)
            )
        return record
