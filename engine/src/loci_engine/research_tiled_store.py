"""Bounded, immutable two-dimensional research result artifacts.

Tile coordinates are YX pixel offsets. A manifest is a geometry declaration,
not evidence that its referenced files are intact; callers choose full validation
at adoption, while region reads verify every shard they actually decode.
"""

from __future__ import annotations

import hashlib
import math
import os
import sqlite3
import tempfile
from collections.abc import Callable, Iterator
from contextlib import closing, suppress
from pathlib import Path
from typing import Any

import numpy as np

from .export import _fsync_directory, _rename_noreplace
from .research_project import (
    SHA_PATTERN,
    ResearchProject,
    canonical_json,
    parse_json,
)
from .working_result import _sha256_file_stable

MAX_REGION_BYTES = 16 * 1024 * 1024
MAX_TILE_SIZE = 512
MAX_OBJECT_ROWS = 100_000
MAX_OBJECT_ROW_BYTES = 16_384
MAX_TABLE_BYTES = 2 * 1024**3
_ARRAY_DTYPES = {"uint8", "uint16", "uint32"}
_GRID_KEYS = {"schema", "shape", "dtype", "tile_size", "tiles"}
_ARTIFACT_KEYS = {"sha256", "bytes", "shape", "dtype"}
_TABLE_KEYS = {"schema", "sha256", "bytes", "count"}


def _positive(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _dtype(value: Any) -> np.dtype:
    if not isinstance(value, str) or value not in _ARRAY_DTYPES:
        raise ValueError("Tiled arrays require uint8, uint16 or uint32 pixels")
    return np.dtype(value)


class TiledArrayWriter:
    def __init__(
        self,
        project: ResearchProject,
        shape: tuple[int, int] | list[int],
        dtype: str | np.dtype,
        tile_size: int = MAX_TILE_SIZE,
    ):
        if not isinstance(project, ResearchProject):
            raise TypeError("A research project is required")
        if not isinstance(shape, (tuple, list)) or len(shape) != 2:
            raise ValueError("Tiled arrays require a two-dimensional YX shape")
        self.shape = (_positive(shape[0], "height"), _positive(shape[1], "width"))
        self.dtype = _dtype(str(np.dtype(dtype)))
        self.tile_size = _positive(tile_size, "tile size")
        if self.tile_size > MAX_TILE_SIZE:
            raise ValueError("Tile core exceeds 512 pixels")
        self.project = project
        self._tiles: dict[tuple[int, int], dict[str, Any]] = {}
        self._finished = False

    def write(self, y: int, x: int, array: np.ndarray) -> None:
        if self._finished:
            raise ValueError("Tiled writer is already finished")
        if (
            isinstance(y, bool)
            or not isinstance(y, int)
            or y < 0
            or isinstance(x, bool)
            or not isinstance(x, int)
            or x < 0
            or y % self.tile_size
            or x % self.tile_size
            or y >= self.shape[0]
            or x >= self.shape[1]
        ):
            raise ValueError("Tile offset is outside the aligned YX grid")
        key = (y, x)
        if key in self._tiles:
            raise ValueError("Duplicate tile offset")
        values = np.asarray(array)
        expected = (
            min(self.tile_size, self.shape[0] - y),
            min(self.tile_size, self.shape[1] - x),
        )
        if values.ndim != 2 or values.shape != expected or values.dtype != self.dtype:
            raise ValueError("Tile shape or dtype disagrees with its grid")
        self._tiles[key] = self.project.store_array(values)

    def finish(self) -> dict[str, Any]:
        if self._finished:
            raise ValueError("Tiled writer is already finished")
        expected = ((self.shape[0] - 1) // self.tile_size + 1) * (
            (self.shape[1] - 1) // self.tile_size + 1
        )
        if len(self._tiles) != expected:
            raise ValueError("Tiled grid has missing cores")
        descriptor = {
            "schema": "loci.tiled-array/v1",
            "shape": list(self.shape),
            "dtype": str(self.dtype),
            "tile_size": self.tile_size,
            "tiles": [
                {"y": y, "x": x, "artifact": artifact}
                for (y, x), artifact in sorted(self._tiles.items())
            ],
        }
        validate_grid(self.project, descriptor)
        self._finished = True
        return descriptor


def validate_grid(
    project: ResearchProject, descriptor: dict[str, Any], verify: bool = False,
    check: Callable[[], None] | None = None,
) -> None:
    if not isinstance(descriptor, dict) or set(descriptor) != _GRID_KEYS:
        raise ValueError("Invalid tiled grid descriptor")
    if descriptor["schema"] != "loci.tiled-array/v1":
        raise ValueError("Unknown tiled grid schema")
    shape = descriptor["shape"]
    if not isinstance(shape, list) or len(shape) != 2:
        raise ValueError("Invalid tiled grid shape")
    height, width = (_positive(value, "grid dimension") for value in shape)
    if max(height, width) > 65536 or height * width >= 2**32:
        raise ValueError("Tiled grid exceeds its dimension envelope")
    dtype = _dtype(descriptor["dtype"])
    tile_size = _positive(descriptor["tile_size"], "tile size")
    if tile_size > MAX_TILE_SIZE:
        raise ValueError("Tile core exceeds 512 pixels")
    tiles = descriptor["tiles"]
    rows = (height - 1) // tile_size + 1
    columns = (width - 1) // tile_size + 1
    # A bounded result record holds this manifest. Check count before walking it.
    if rows * columns > 16384 or not isinstance(tiles, list) or len(tiles) != rows * columns:
        raise ValueError("Tiled grid has missing or extra cores")
    for index, tile in enumerate(tiles):
        y, x = divmod(index, columns)
        y *= tile_size
        x *= tile_size
        if not isinstance(tile, dict) or set(tile) != {"y", "x", "artifact"}:
            raise ValueError("Invalid tile entry")
        if (
            type(tile["y"]) is not int
            or type(tile["x"]) is not int
            or (tile["y"], tile["x"]) != (y, x)
        ):
            raise ValueError("Tile offsets must be complete and row-major")
        artifact = tile["artifact"]
        expected_shape = [min(tile_size, height - y), min(tile_size, width - x)]
        if (
            not isinstance(artifact, dict)
            or set(artifact) != _ARTIFACT_KEYS
            or artifact["shape"] != expected_shape
            or artifact["dtype"] != str(dtype)
            or not isinstance(artifact["sha256"], str)
            or not SHA_PATTERN.fullmatch(artifact["sha256"])
            or type(artifact["bytes"]) is not int
            or not 1
            <= artifact["bytes"]
            <= expected_shape[0] * expected_shape[1] * dtype.itemsize + 4096
        ):
            raise ValueError("Tile artifact disagrees with grid geometry or identity")
        if verify:
            if check is not None:
                check()
            project.verify_array(artifact)


def read_region(
    project: ResearchProject,
    descriptor: dict[str, Any],
    y: int,
    x: int,
    height: int,
    width: int,
) -> np.ndarray:
    validate_grid(project, descriptor)
    dimensions = descriptor["shape"]
    if (
        type(y) is not int
        or type(x) is not int
        or y < 0
        or x < 0
        or type(height) is not int
        or type(width) is not int
        or height < 1
        or width < 1
        or y + height > dimensions[0]
        or x + width > dimensions[1]
    ):
        raise ValueError("Region is outside the YX grid")
    dtype = _dtype(descriptor["dtype"])
    if height * width * dtype.itemsize > MAX_REGION_BYTES:
        raise ValueError("Region exceeds the decoded byte budget")
    output = np.empty((height, width), dtype=dtype)
    core = descriptor["tile_size"]
    columns = (dimensions[1] - 1) // core + 1
    for ty in range(y // core, (y + height - 1) // core + 1):
        for tx in range(x // core, (x + width - 1) // core + 1):
            tile = descriptor["tiles"][ty * columns + tx]
            values = project.load_array(tile["artifact"])
            tile_y, tile_x = tile["y"], tile["x"]
            top, left = max(y, tile_y), max(x, tile_x)
            bottom = min(y + height, tile_y + values.shape[0])
            right = min(x + width, tile_x + values.shape[1])
            output[top - y : bottom - y, left - x : right - x] = values[
                top - tile_y : bottom - tile_y, left - tile_x : right - tile_x
            ]
    output.flags.writeable = False
    return output


def iter_tiles(
    project: ResearchProject,
    descriptor: dict[str, Any],
    check: Callable[[], None] | None = None,
) -> Iterator[tuple[int, int, np.ndarray]]:
    validate_grid(project, descriptor)
    for tile in descriptor["tiles"]:
        if check is not None:
            check()
        yield tile["y"], tile["x"], project.load_array(tile["artifact"])


def label_value_hash(project: ResearchProject, descriptor: dict[str, Any], check=None) -> str:
    validate_grid(project, descriptor)
    if descriptor["dtype"] != "uint32":
        raise ValueError("Label value hashing requires uint32 tiles")
    height, width = descriptor["shape"]
    digest = hashlib.sha256()
    digest.update(b"loci-label-array-v1\0")
    digest.update(canonical_json({"dtype": "<u4", "shape": [height, width]}).encode())
    digest.update(b"\0")
    # The canonical label stream is global C order, never concatenated tile order.
    stripe_width = min(width, MAX_REGION_BYTES // 4)
    stripe_height = max(1, MAX_REGION_BYTES // (stripe_width * 4)) if stripe_width == width else 1
    for y in range(0, height, stripe_height):
        if check:
            check()
        block_height = min(stripe_height, height - y)
        if stripe_width == width:
            values = read_region(project, descriptor, y, 0, block_height, width)
            digest.update(values.astype("<u4", copy=False).tobytes(order="C"))
        else:
            for row in range(block_height):
                for x in range(0, width, stripe_width):
                    if check:
                        check()
                    values = read_region(
                        project, descriptor, y + row, x, 1, min(stripe_width, width - x)
                    )
                    digest.update(values.astype("<u4", copy=False).tobytes(order="C"))
    return digest.hexdigest()


def _checked_row(row: Any) -> tuple[int, str]:
    if (
        not isinstance(row, dict)
        or type(row.get("label")) is not int
        or not 1 <= row["label"] <= 0xFFFFFFFF
    ):
        raise ValueError("Object row requires a nonzero uint32 label")
    required = {
        "label",
        "voxel_count",
        "measure",
        "measure_kind",
        "measure_unit",
        "centroid_index",
        "index_axes",
        "centroid_world_xyz",
        "world_frame",
        "distance_unit",
        "bbox_start",
        "bbox_stop_exclusive",
        "principal_rms_radii",
        "touches_crop_border",
        "intensity",
        "nearest_centroid_distance",
    }
    if set(row) != required:
        raise ValueError("Object row is missing canonical measurement fields")
    if type(row["voxel_count"]) is not int or row["voxel_count"] < 1:
        raise ValueError("Object voxel count is invalid")
    if (
        not isinstance(row["measure_kind"], str)
        or row["measure_kind"] not in {"area", "volume"}
        or not isinstance(row["intensity"], dict)
    ):
        raise ValueError("Object measurement structure is invalid")
    dims = 2 if row["measure_kind"] == "area" else 3
    if row["index_axes"] != ("YX" if dims == 2 else "ZYX"):
        raise ValueError("Object row index axes disagree with its measure")
    for name, length in (
        ("centroid_index", dims),
        ("bbox_start", dims),
        ("bbox_stop_exclusive", dims),
        ("centroid_world_xyz", 3),
        ("principal_rms_radii", 3),
    ):
        values = row[name]
        if not isinstance(values, list) or len(values) != length:
            raise ValueError("Object row coordinate length is invalid")
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in values):
            raise ValueError("Object row coordinate is non-finite")
    if any(
        type(start) is not int or type(stop) is not int or start < 0 or stop <= start
        for start, stop in zip(row["bbox_start"], row["bbox_stop_exclusive"], strict=True)
    ):
        raise ValueError("Object row bounds are invalid")
    if row["voxel_count"] > math.prod(
        stop - start
        for start, stop in zip(row["bbox_start"], row["bbox_stop_exclusive"], strict=True)
    ):
        raise ValueError("Object count exceeds its bounding box")
    if (
        type(row["measure"]) not in (int, float)
        or not math.isfinite(row["measure"])
        or row["measure"] <= 0
        or type(row["touches_crop_border"]) is not bool
        or any(
            not isinstance(row[name], str) or not row[name]
            for name in ("measure_unit", "world_frame", "distance_unit")
        )
    ):
        raise ValueError("Object scalar measurement is invalid")
    distance = row["nearest_centroid_distance"]
    if distance is not None and (
        type(distance) not in (int, float) or not math.isfinite(distance) or distance < 0
    ):
        raise ValueError("Object nearest-centroid distance is invalid")
    for channel, values in row["intensity"].items():
        if (
            not isinstance(channel, str)
            or not channel
            or not isinstance(values, dict)
            or set(values) != {"mean", "sum", "min", "max", "std_population"}
        ):
            raise ValueError("Object intensity record is invalid")
        if any(
            type(value) not in (int, float) or not math.isfinite(value) for value in values.values()
        ):
            raise ValueError("Object intensity is non-finite")
    encoded = canonical_json(row)
    if len(encoded.encode()) > MAX_OBJECT_ROW_BYTES:
        raise ValueError("Object measurement row exceeds 16384 bytes")
    return row["label"], encoded


def _table_path(
    project: ResearchProject, descriptor: dict[str, Any], check=None
) -> Path:
    if (
        not isinstance(descriptor, dict)
        or set(descriptor) != _TABLE_KEYS
        or descriptor["schema"] != "loci.object-table/v1"
    ):
        raise ValueError("Invalid object-table descriptor")
    digest = descriptor["sha256"]
    if not isinstance(digest, str) or not SHA_PATTERN.fullmatch(digest):
        raise ValueError("Invalid object-table identity")
    if type(descriptor["bytes"]) is not int or not 1 <= descriptor["bytes"] <= MAX_TABLE_BYTES:
        raise ValueError("Object table exceeds its byte budget")
    if type(descriptor["count"]) is not int or not 0 <= descriptor["count"] <= MAX_OBJECT_ROWS:
        raise ValueError("Object table exceeds its row budget")
    project._check_layout()
    path = project.arrays / (digest + ".sqlite3")
    for suffix in ("-wal", "-shm", "-journal"):
        if Path(str(path) + suffix).exists() or Path(str(path) + suffix).is_symlink():
            raise ValueError("Immutable object table has a mutable sidecar")
    actual, size = _sha256_file_stable(path, reject_symlink=True, check=check)
    if actual != digest or size != descriptor["bytes"]:
        raise ValueError("Object-table hash/size verification failed")
    with path.open("rb") as stream:
        header = stream.read(100)
    if (
        len(header) != 100
        or header[:16] != b"SQLite format 3\0"
        or header[18:20] != b"\x01\x01"
        or header[20] != 0
    ):
        raise ValueError("Object-table SQLite header is invalid")
    return path


def _open_table(
    project: ResearchProject, descriptor: dict[str, Any], check=None
) -> sqlite3.Connection:
    path = _table_path(project, descriptor, check=check)
    connection = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        if check is not None:
            def progress():
                check()
                return 0
            connection.set_progress_handler(progress, 10000)
        # Enforce byte limits before SQLite materialises even a hash-consistent
        # hostile record/schema into Python. Producer checks alone are insufficient.
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_OBJECT_ROW_BYTES + 1024)
        connection.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 4096)
        connection.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA cache_size=-4096")
        objects = connection.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name LIMIT 2"
        ).fetchall()
        if len(objects) != 1 or objects[0][:3] != ("table", "objects", "objects"):
            raise ValueError("Object table has an unexpected database schema")
        columns = connection.execute("PRAGMA table_info(objects)").fetchall()
        if (
            [(row[1], row[2], row[3], row[5]) for row in columns]
            != [("label", "INTEGER", 0, 1), ("record", "TEXT", 1, 0)]
            or not isinstance(objects[0][3], str)
            or objects[0][3].strip()
            != "CREATE TABLE objects(label INTEGER PRIMARY KEY,record TEXT NOT NULL)"
        ):
            raise ValueError("Object table has an unexpected column schema")
        return connection
    except BaseException:
        connection.close()
        raise


class ObjectTableWriter:
    def __init__(self, project: ResearchProject):
        self.project = project
        project._check_layout()
        used = sum(
            entry.stat().st_size
            for entry in project.arrays.iterdir()
            if entry.is_file() and not entry.is_symlink()
        )
        remaining = min(MAX_TABLE_BYTES, project.meta["disk_budget_bytes"] - used)
        if remaining < 8192:
            raise ValueError("Study artifact budget cannot hold an object table")
        fd, name = tempfile.mkstemp(prefix=".objects-", suffix=".sqlite3", dir=project.root)
        os.close(fd)
        self._temporary = Path(name)
        try:
            self._connection = sqlite3.connect(self._temporary)
            self._connection.execute("PRAGMA journal_mode=DELETE")
            self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.execute("PRAGMA cache_size=-4096")
            self._connection.execute("PRAGMA temp_store=FILE")
            page_size = self._connection.execute("PRAGMA page_size").fetchone()[0]
            max_pages = remaining // page_size
            self._connection.execute(f"PRAGMA max_page_count={max_pages}")
            self._connection.execute(
                "CREATE TABLE objects(label INTEGER PRIMARY KEY,record TEXT NOT NULL)"
            )
        except BaseException:
            if hasattr(self, "_connection"):
                self._connection.close()
            with suppress(FileNotFoundError):
                self._temporary.unlink()
            raise
        self._count = 0
        self._closed = False

    def __enter__(self) -> ObjectTableWriter:
        return self

    def __exit__(self, _kind: Any, _error: Any, _traceback: Any) -> None:
        self.close()

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._connection.close()
            with suppress(FileNotFoundError):
                self._temporary.unlink()

    def append(self, row: dict[str, Any]) -> None:
        if self._closed:
            raise ValueError("Object-table writer is closed")
        if self._count >= MAX_OBJECT_ROWS:
            raise ValueError("Object table exceeds 100000 rows")
        label, encoded = _checked_row(row)
        try:
            self._connection.execute("INSERT INTO objects VALUES(?,?)", (label, encoded))
        except sqlite3.IntegrityError as exc:
            raise ValueError("Duplicate object label") from exc
        except sqlite3.OperationalError as exc:
            if "full" in str(exc).lower():
                raise ValueError(
                    "Study artifact budget reached while writing object table"
                ) from exc
            raise
        self._count += 1

    def finalize(self) -> dict[str, Any]:
        if self._closed:
            raise ValueError("Object-table writer is closed")
        self._closed = True
        try:
            self._connection.commit()
            self._connection.close()
            with self._temporary.open("rb+") as stream:
                os.fsync(stream.fileno())
            os.chmod(self._temporary, 0o400)
            digest, size = _sha256_file_stable(self._temporary, reject_symlink=True)
            if size > MAX_TABLE_BYTES:
                raise ValueError("Object table exceeds its byte budget")
            self.project._check_layout()
            used = sum(
                p.stat().st_size
                for p in self.project.arrays.iterdir()
                if p.is_file() and not p.is_symlink() and p != self._temporary
            )
            if used + size > self.project.meta["disk_budget_bytes"]:
                raise ValueError("Study artifact budget reached")
            target = self.project.arrays / (digest + ".sqlite3")
            try:
                _rename_noreplace(self._temporary, target)
            except FileExistsError:
                actual, existing_size = _sha256_file_stable(target, reject_symlink=True)
                if actual != digest or existing_size != size:
                    raise ValueError(
                        "Existing object-table artifact failed integrity verification"
                    ) from None
            _fsync_directory(self.project.arrays)
            result = {
                "schema": "loci.object-table/v1",
                "sha256": digest,
                "bytes": size,
                "count": self._count,
            }
            validate_object_table(self.project, result)
            return result
        finally:
            self._connection.close()
            with suppress(FileNotFoundError):
                self._temporary.unlink()


def validate_object_table(
    project: ResearchProject,
    descriptor: dict[str, Any],
    check: Callable[[], None] | None = None,
) -> None:
    # Cache semantic validation only after fresh byte identity verification. A
    # changed file still fails its hash; no rows or database handles are cached.
    _table_path(project, descriptor, check=check)
    key = (descriptor["sha256"], descriptor["bytes"], descriptor["count"])
    verified = getattr(project, "_validated_object_tables", set())
    if key in verified:
        return
    with closing(_open_table(project, descriptor, check=check)) as connection:
        if connection.execute("PRAGMA integrity_check(1)").fetchone() != ("ok",):
            raise ValueError("Object table failed SQLite integrity verification")
        count = 0
        for label, record in connection.execute("SELECT label,record FROM objects ORDER BY label"):
            if check is not None and count % 200 == 0:
                check()
            if not isinstance(record, str) or len(record.encode()) > MAX_OBJECT_ROW_BYTES:
                raise ValueError("Object row is oversized or invalid")
            row = parse_json(record)
            checked, encoded = _checked_row(row)
            if label != checked or record != encoded:
                raise ValueError("Object row identity or canonical encoding is invalid")
            count += 1
            if count > MAX_OBJECT_ROWS:
                raise ValueError("Object table exceeds 100000 rows")
        if count != descriptor["count"]:
            raise ValueError("Object table count disagrees with descriptor")
    _table_path(project, descriptor, check=check)
    if len(verified) >= 32:
        verified.clear()
    verified.add(key)
    project._validated_object_tables = verified


def object_rows(
    project: ResearchProject, descriptor: dict[str, Any], offset: int = 0, limit: int = 200
) -> list[dict[str, Any]]:
    if (
        type(offset) is not int
        or not 0 <= offset <= MAX_OBJECT_ROWS
        or type(limit) is not int
        or not 1 <= limit <= 1000
    ):
        raise ValueError("Object page is outside bounded query limits")
    with closing(_open_table(project, descriptor)) as connection:
        rows = connection.execute(
            "SELECT label,record FROM objects ORDER BY label LIMIT ? OFFSET ?", (limit, offset)
        ).fetchall()
    _table_path(project, descriptor)
    output = []
    for label, record in rows:
        if not isinstance(record, str) or len(record.encode()) > MAX_OBJECT_ROW_BYTES:
            raise ValueError("Object row is oversized or invalid")
        value = parse_json(record)
        checked, encoded = _checked_row(value)
        if label != checked or record != encoded:
            raise ValueError("Object row is invalid")
        output.append(value)
    return output


def object_row(
    project: ResearchProject, descriptor: dict[str, Any], label: int
) -> dict[str, Any] | None:
    if type(label) is not int or not 1 <= label <= 0xFFFFFFFF:
        raise ValueError("Object label must be nonzero uint32")
    with closing(_open_table(project, descriptor)) as connection:
        found = connection.execute("SELECT record FROM objects WHERE label=?", (label,)).fetchone()
    _table_path(project, descriptor)
    if found is None:
        return None
    value = parse_json(found[0])
    checked, encoded = _checked_row(value)
    if checked != label or encoded != found[0]:
        raise ValueError("Object row is invalid")
    return value


def iter_object_rows(
    project: ResearchProject,
    descriptor: dict[str, Any],
    check: Callable[[], None] | None = None,
) -> Iterator[dict[str, Any]]:
    with closing(_open_table(project, descriptor, check=check)) as connection:
        cursor = connection.execute("SELECT label,record FROM objects ORDER BY label")
        count = 0
        while page := cursor.fetchmany(200):
            if check is not None:
                check()
            for label, record in page:
                if not isinstance(record, str) or len(record.encode()) > MAX_OBJECT_ROW_BYTES:
                    raise ValueError("Object row is oversized or invalid")
                value = parse_json(record)
                checked, encoded = _checked_row(value)
                if label != checked or record != encoded:
                    raise ValueError("Object row is invalid")
                yield value
                count += 1
                if count > MAX_OBJECT_ROWS:
                    raise ValueError("Object table exceeds 100000 rows")
        if count != descriptor["count"]:
            raise ValueError("Object table count disagrees with descriptor")
    _table_path(project, descriptor, check=check)
