"""Inspect one already adopted, generated-phantom Cellpose result through frozen CLI/MCP.

This never submits an analysis, executes a model, installs a runtime or downloads.
Its broad adopted-data policy deliberately does not claim exact learned-runtime grants.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import re
import sqlite3
import subprocess
import traceback
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

SHAPE = (2076, 3088)
SOURCE_NAME = "synthetic-3088x2076.ome.tif"
STUDY_NAME = "segmentation-resource-study.loci-study"
CHECKPOINT_SHA = "e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2"
RUNTIME_KEYS = (
    "engine",
    "numpy",
    "scipy",
    "scikit_image",
    "backend",
    "resolved_device",
)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024**2), b""):
            checksum.update(block)
    return checksum.hexdigest()


def plain(path, *, directory=False):
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("QA paths must be absolute and must not be symbolic links")
    if not (path.is_dir() if directory else path.is_file()):
        raise ValueError("QA input is not the expected plain file/directory")
    return path.resolve(strict=True)


def phantom():
    import numpy as np

    image = np.full(SHAPE, 225, np.uint8)
    image[100:200, 100:200] = 55
    image[500:600, 500:600] = 55
    return image


def verify_pixels(image):
    import numpy as np

    if image.shape != SHAPE or image.dtype != np.uint8:
        raise ValueError("Only the named uint8 synthetic phantom is authorized")
    np.testing.assert_array_equal(image, phantom())


def database_records(study):
    with sqlite3.connect(
        f"file:{study / 'study.sqlite3'}?mode=ro", uri=True
    ) as connection:
        records = {}
        for table in ("sources", "results", "jobs"):
            records[table] = {
                identity: json.loads(raw)
                for identity, raw in connection.execute(
                    f"SELECT id,record FROM {table}"
                )
            }
        records["project"] = json.loads(
            connection.execute(
                "SELECT value FROM metadata WHERE key='project'"
            ).fetchone()[0]
        )
    return records


def validate_inputs(worker, report_file):
    import numpy as np
    import tifffile

    report_file = plain(report_file)
    if report_file.name != "report.json" or report_file.stat().st_size > 4 * 1024**2:
        raise ValueError("Choose the bounded packaged segmentation report.json")
    report = json.loads(report_file.read_text())
    model = report.get("cellpose_inference")
    if (
        report.get("status") != "passed"
        or report.get("errors") != []
        or not isinstance(model, dict)
        or model.get("status") != "passed"
        or model.get("profile") != "cellpose-sam"
        or model.get("biological_validation") is not False
    ):
        raise ValueError("A passed packaged synthetic Cellpose report is required")
    source = plain(Path(model["source"]))
    study = plain(Path(model["study"]), directory=True)
    if (
        source.name != SOURCE_NAME
        or source.parent != report_file.parent
        or study.name != STUDY_NAME
        or study.parent != report_file.parent
        or source.stat().st_size > 32 * 1024**2
    ):
        raise ValueError(
            "Report must name only its adjacent generated phantom and QA study"
        )
    if not re.fullmatch(r"[a-f0-9]{64}", report.get("fixture_sha256", "")):
        raise ValueError("Missing exact source fingerprint")
    if digest(source) != report["fixture_sha256"]:
        raise ValueError("Generated fixture fingerprint changed")
    with tifffile.TiffFile(source) as image:
        if (
            len(image.series) != 1
            or image.series[0].shape != SHAPE
            or image.series[0].dtype != np.uint8
        ):
            raise ValueError("Unexpected synthetic TIFF dimensions/type")
        verify_pixels(image.series[0].asarray())
    if digest(source) != report["fixture_sha256"]:
        raise ValueError("Generated fixture changed during inspection")
    # No worker operation or filesystem mutation occurs before the source checks above.
    worker = plain(worker)
    if worker.name != "loci-engine" or digest(worker) != report["identity"]["worker"]:
        raise ValueError("Frozen worker differs from the packaged report")
    plain(study / "study.sqlite3")
    plain(study / "artifacts", directory=True)
    records = database_records(study)
    identity, revision, source_id = (
        model[key] for key in ("result_id", "revision_hash", "source_id")
    )
    if not re.fullmatch(r"[a-f0-9]{32}", identity) or not re.fullmatch(
        r"[a-f0-9]{64}", revision
    ):
        raise ValueError("Report requires an exact adopted result identity")
    result = records["results"][identity]
    provenance = result["provenance"]
    registered = records["sources"][source_id]
    if (
        result["kind"] != "cellpose-segmentation"
        or result["revision_hash"] != revision
        or result["source_id"] != source_id
        or result["source_sha256"] != report["fixture_sha256"]
        or registered["sha256"] != report["fixture_sha256"]
        or Path(registered["private_path"]).resolve(strict=True) != source
        or provenance["accepted_request"]["profile_id"] != "cellpose-sam"
        or provenance["runtime"]["cellpose"] != model["runtime"]
        or provenance["runtime"]["cellpose"]["model"]
        != {"artifact_id": "cpsam", "sha256": CHECKPOINT_SHA}
        or provenance["runtime"]["cellpose"]["package"]
        != {"name": "cellpose", "version": "4.2.1.1"}
    ):
        raise ValueError(
            "Native result does not match the exact reported profile/source/runtime"
        )
    if (
        hashlib.sha256(
            canonical(
                {k: v for k, v in result.items() if k != "revision_hash"}
            ).encode()
        ).hexdigest()
        != revision
    ):
        raise ValueError("Adopted native result fingerprint is invalid")
    selection = provenance["selection"]
    expected_selection = {
        "x": 0,
        "y": 0,
        "width": SHAPE[1],
        "height": SHAPE[0],
        "t": 0,
        "c": 0,
        "z": 0,
        "level": 0,
    }
    if selection != expected_selection or provenance["measurement_channels"] != [0]:
        raise ValueError("Expected the complete single-channel synthetic XY plane")
    if any(job["state"] in {"queued", "running"} for job in records["jobs"].values()):
        raise ValueError(
            "Finish existing QA jobs before the read/review/export journey"
        )
    return worker, report_file, report, model, source, study, records, result


def verify_arrays(study, result, reported_count):
    import numpy as np

    if type(reported_count) is not int or not 0 <= reported_count <= 10000:
        raise ValueError(
            "Reported inference count must be a bounded non-negative integer"
        )
    arrays, receipts = {}, {}
    for name in ("image", "labels"):
        descriptor = result["arrays"][name]
        sha = descriptor["sha256"]
        if not re.fullmatch(r"[a-f0-9]{64}", sha):
            raise ValueError("Invalid native array fingerprint")
        path = plain(study / "artifacts" / (sha + ".npy"))
        if path.stat().st_size != descriptor["bytes"] or digest(path) != sha:
            raise ValueError("Native adopted array changed")
        array = np.load(path, allow_pickle=False, mmap_mode="r")
        if (
            array.shape != SHAPE
            or list(array.shape) != descriptor["shape"]
            or array.dtype != np.dtype(descriptor["dtype"])
        ):
            raise ValueError("Native array shape/type differs from its descriptor")
        arrays[name], receipts[name] = (
            array,
            {"sha256": sha, "shape": list(array.shape), "dtype": str(array.dtype)},
        )
    labels = arrays["labels"]
    if labels.dtype.kind not in "ui" or not np.isfinite(arrays["image"]).all():
        raise ValueError("Invalid adopted model array values")
    ids = np.unique(labels)
    positive = ids[ids > 0]
    if (
        not np.array_equal(positive, np.arange(1, len(positive) + 1))
        or len(positive) != reported_count
    ):
        raise ValueError("Native label count differs from the actual inference report")
    rows = result["provenance"]["measurements"]
    if len(rows) != reported_count or reported_count > 10000:
        raise ValueError(
            "Native measurement count is inconsistent or outside QA bounds"
        )
    raw = phantom()
    for row in rows:
        values = raw[labels == row["label"]].astype(np.float64)
        assert (
            row["voxel_count"] == len(values) and row["measure"] == len(values) * 0.25
        )
        statistics = row["intensity"]["source_channel_0"]
        for key, expected in (
            ("mean", values.mean()),
            ("sum", values.sum()),
            ("min", values.min()),
            ("max", values.max()),
            ("std_population", values.std()),
        ):
            assert np.isclose(statistics[key], expected, rtol=1e-12, atol=1e-12), key
    return receipts


async def journey(args):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.types import Implementation

    worker, report_file, report, model, source, study, before, result = validate_inputs(
        args.worker, args.report
    )
    arrays = verify_arrays(study, result, model["count"])
    if args.validate_only:
        print(
            json.dumps(
                {
                    "status": "validated-only",
                    "worker_sha256": report["identity"]["worker"],
                    "result_id": result["id"],
                    "arrays": arrays,
                    "operations_performed": [],
                }
            )
        )
        return
    output = report_file.parent / (
        "shared-model-result-"
        + datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ-")
        + uuid4().hex[:8]
    )
    output.mkdir(mode=0o700)
    exports = output / "exports"
    exports.mkdir(mode=0o700)
    receipt = {
        "schema": "loci.shared-model-result-qa/v1",
        "status": "running",
        "scope": "GUI adopted Cellpose result; legacy granted-sources inspection/review/export; no MCP inference",
        "biological_validation": False,
        "worker_sha256": report["identity"]["worker"],
        "parent_report": str(report_file),
        "parent_report_sha256": digest(report_file),
        "source_sha256": report["fixture_sha256"],
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "profile": model["profile"],
        "runtime": result["provenance"]["runtime"],
        "profile_provenance": result["provenance"]["profile"],
        "model_provenance": result["provenance"]["model"],
        "accepted_request": result["provenance"]["accepted_request"],
        "arrays": arrays,
        "checks": [],
    }

    def save():
        (output / "receipt.json").write_text(
            json.dumps(receipt, indent=2, allow_nan=False) + "\n"
        )

    def cli(*arguments):
        if arguments[0] not in {"execute", "policy", "snapshot"} or (
            arguments[0] == "execute" and arguments[3] not in {"result", "result_view"}
        ):
            raise ValueError("This helper cannot submit or execute an analysis")
        response = subprocess.run(
            [str(worker), "--loci", "--json", *arguments],
            check=True,
            capture_output=True,
            text=True,
            timeout=180,
        )
        if len(response.stdout.encode()) > 32 * 1024**2:
            raise ValueError("Frozen CLI response exceeds QA bound")
        return json.loads(response.stdout)

    async def call(session, name, arguments, *, expect_error=False):
        response = await session.call_tool(name, arguments)
        if bool(response.is_error) != expect_error:
            raise AssertionError(f"Unexpected MCP outcome for {name}: {response}")
        if expect_error:
            return response
        value = response.structured_content
        if not isinstance(value, dict):
            value = json.loads(
                next(block.text for block in response.content if block.type == "text")
            )
        return value, response

    save()
    try:
        native = cli(
            "execute",
            "--project",
            str(study),
            "result",
            "--request",
            canonical({"result_id": result["id"], "limit": 1000}),
        )
        native_provenance = {
            k: v for k, v in result["provenance"].items() if k != "measurements"
        }
        assert native["provenance"] == native_provenance
        assert native["result"]["arrays"] == result["arrays"]
        assert native["result"]["object_count"] == model["count"]
        core_runtime = result["provenance"]["runtime"]["engine"]
        specification = {
            "sources": [
                {
                    "id": result["source_id"],
                    "sha256": report["fixture_sha256"],
                    "crop": {"x": 0, "y": 0, "width": SHAPE[1], "height": SHAPE[0]},
                    "t": [0],
                    "c": [0],
                    "z": [0],
                    "level": [0],
                    "measurement_channels": [0],
                }
            ],
            "recipes": [],
            "operations": [
                "result",
                "result_view",
                "review_history",
                "review_result",
                "export_result",
                "inspect_action",
            ],
            "model_packages": [],
            "runtimes": [{key: core_runtime[key] for key in RUNTIME_KEYS}],
            "export": {"root": str(exports), "filenames": ["model-result-export"]},
            "limits": {
                "cpu_seconds": 120,
                "memory_bytes": 2 * 1024**3,
                "concurrency": 1,
            },
            "disclosures": [
                "geometry",
                "source_names",
                "previews",
                "measurements",
                "provenance",
                "agent_metadata",
            ],
            "remote_grants": [],
            "experimental_recipes": [],
            "actions": ["study_summary"],
            "delegation": {
                "id": uuid4().hex,
                "client_id": "Loci shared model result QA",
                "expires_at": None,
                "result_scope": "granted-sources",
            },
            "permission_mode": "full_access",
        }
        specification_file, policy = (
            output / "specification.json",
            output / "agent-policy.json",
        )
        specification_file.write_text(canonical(specification) + "\n")
        specification_file.chmod(0o600)
        cli(
            "policy",
            "--project",
            str(study),
            "--destination",
            str(policy),
            "--specification",
            "@" + str(specification_file),
        )
        assert json.loads(policy.read_text())["schema"] == "loci.agent-policy/v5"
        with (output / "mcp-stderr.log").open("w") as errlog:
            async with (
                stdio_client(
                    StdioServerParameters(
                        command=str(worker),
                        args=["--cli", "mcp", "--policy", str(policy)],
                    ),
                    errlog=errlog,
                ) as streams,
                ClientSession(
                    *streams,
                    client_info=Implementation(
                        name="Loci shared model result QA", version="1.0"
                    ),
                ) as session,
            ):
                await session.initialize()
                rows, offset = [], 0
                while True:
                    read, _ = await call(
                        session,
                        "result",
                        {"result_id": result["id"], "offset": offset, "limit": 100},
                    )
                    assert read["result"]["revision_hash"] == result["revision_hash"]
                    assert read["provenance"] == native_provenance
                    assert read["total_rows"] == model["count"]
                    rows.extend(read["measurements"])
                    offset += len(read["measurements"])
                    if offset >= read["total_rows"]:
                        break
                    assert read["measurements"] and offset < 10000
                assert rows == result["provenance"]["measurements"]
                receipt["checks"].append(
                    "MCP exact result/provenance/raw measurements equal native CLI and arrays"
                )
                view_request = {
                    "result_id": result["id"],
                    "axis": "z",
                    "index": 0,
                    "labels": True,
                }
                native_view = cli(
                    "execute",
                    "--project",
                    str(study),
                    "result_view",
                    "--request",
                    canonical(view_request),
                )
                view, response = await call(session, "result_view", view_request)
                images = [block for block in response.content if block.type == "image"]
                assert (
                    len(images) == 1
                    and view["revision_hash"] == result["revision_hash"]
                )
                png = base64.b64decode(images[0].data, validate=True)
                assert png == base64.b64decode(
                    native_view["image"].split(",", 1)[1], validate=True
                )
                (output / "model-result-view.png").write_bytes(png)
                receipt["result_view_png_sha256"] = hashlib.sha256(png).hexdigest()
                history, _ = await call(
                    session, "review_history", {"result_id": result["id"]}
                )
                review, _ = await call(
                    session,
                    "review_result",
                    {
                        "request": {
                            "result_id": result["id"],
                            "revision_hash": result["revision_hash"],
                            "disposition": "reviewed",
                            "reason": "Automated engineering review of the generated synthetic phantom and exact adopted result",
                            "coverage": "Source identity, label/raw-array arithmetic, CLI/MCP equality and image transport; no biological validation",
                            "expected_review_sha256": history["current_review_sha256"],
                        }
                    },
                )
                assert (
                    review["review"]["actor"] == "agent"
                    and review["review"]["revision_hash"] == result["revision_hash"]
                )
                receipt["review"] = review["review"]
                refused = await call(
                    session,
                    "inspect_action",
                    {
                        "operation": "study_summary",
                        "request": {"result_ids": [result["id"]]},
                    },
                    expect_error=True,
                )
                assert not any(block.type == "image" for block in refused.content)
                receipt["learned_shared_summary"] = {
                    "status": "unsupported-fail-closed",
                    "scope": "New strict shared runtime/model grants cannot express this native learned provenance; legacy adopted-data access succeeded",
                    "response": [
                        block.text for block in refused.content if block.type == "text"
                    ],
                }
                exported, _ = await call(
                    session,
                    "export_result",
                    {
                        "result_id": result["id"],
                        "revision_hash": result["revision_hash"],
                        "filename": "model-result-export",
                    },
                )
                receipt["export"] = exported
        bundle = plain(exports / "model-result-export", directory=True)
        manifest = plain(bundle / "manifest.json")
        assert digest(manifest) == exported["manifest_sha256"]
        manifest_record = json.loads(manifest.read_text())
        assert (
            manifest_record["result_id"] == result["id"]
            and manifest_record["revision_hash"] == result["revision_hash"]
        )
        assert manifest_record["files"] == exported["files"]
        for item in exported["files"]:
            assert Path(item["name"]).name == item["name"]
            artifact = plain(bundle / item["name"])
            assert (
                artifact.stat().st_size == item["size_bytes"]
                and digest(artifact) == item["sha256"]
            )
        exported_result = json.loads((bundle / "result.json").read_text())
        assert (
            exported_result["result"] == result
            and exported_result["review"] == receipt["review"]
        )
        for name, descriptor in result["arrays"].items():
            assert digest(bundle / (name + ".npy")) == descriptor["sha256"]
        after = database_records(study)
        assert after["results"] == before["results"] and after["jobs"] == before["jobs"]
        assert (
            after["sources"] == before["sources"]
            and digest(source) == report["fixture_sha256"]
        )
        receipt["checks"].extend(
            [
                "Agent review and atomic exported manifest/files match exact adopted revision",
                "No new result, analysis job, model execution or source mutation",
            ]
        )
        receipt["status"] = "passed"
    except BaseException:
        receipt["status"] = "failed"
        receipt["failure"] = traceback.format_exc()
        raise
    finally:
        save()
        print(
            json.dumps(
                {"status": receipt["status"], "receipt": str(output / "receipt.json")}
            )
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Only exercise the in-memory phantom guard",
    )
    args = parser.parse_args()
    if args.self_test:
        import numpy as np

        verify_pixels(phantom())
        for invalid in (
            np.zeros(SHAPE, np.uint8),
            np.zeros((4, 4), np.uint8),
            phantom().astype(np.uint16),
        ):
            try:
                verify_pixels(invalid)
            except (ValueError, AssertionError):
                continue
            raise AssertionError("Non-phantom input was accepted")
        print(
            json.dumps(
                {
                    "status": "passed",
                    "scope": "in-memory phantom authorization guard only; no worker operation",
                }
            )
        )
        return
    if args.worker is None or args.report is None:
        parser.error("Provide --worker and --report, or use --self-test")
    asyncio.run(journey(args))


if __name__ == "__main__":
    main()
